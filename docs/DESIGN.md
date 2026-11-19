# Vaani: design report

**Goal:** a single-screen Android voice assistant that can serve **10 lakh (1 million) concurrent users**, built and demonstrated entirely on **free tiers**.

**Status:** working end to end. The backend runs on Cloudflare Workers with a shared KV cache. The Android app is built with EAS. 47 automated tests pass (22 backend, 25 app).

---

## 1. The problem, restated as constraints

| Constraint | What it forces |
|---|---|
| 1M concurrent users | No per-user server state and no server work that grows with audio. Every server component must scale horizontally. |
| Free tiers only | The scarcest resource is LLM quota: Groq's free tier allows **1,000 requests/day and 8,000 tokens/min per model**, read from its `x-ratelimit-*` response headers. That is 6 to 9 orders of magnitude below the target. The design has to make most requests never reach an LLM. |
| Voice UX | The user feels latency between the end of speech and the start of the spoken answer. Anything above ~1 s feels broken. |
| India | English, Hindi and Hinglish in the same product, patchy networks, and a wide range of Android hardware. |

The central idea follows from row two. **You don't scale an LLM to a million users on a free tier. You scale everything around it, so the LLM sees as few requests as possible.**

## 2. Decisions at a glance

| # | Decision | Why | Alternative rejected |
|---|---|---|---|
| D1 | Speech-to-text and text-to-speech run on the phone (Android `SpeechRecognizer` with `EXTRA_PREFER_OFFLINE`, system TTS) | Zero server cost per second of audio, no audio leaves the device, works offline | Cloud ASR (Whisper or similar): per-minute cost and ~50 KB/s of upstream per user |
| D2 | An on-device intent router handles device commands (timers, alarms, calls, apps, maths, time, date, battery, navigation, search) | These are a large share of assistant traffic, need no LLM, and answer in ~1 ms offline | Sending everything to an LLM with tool calls: every timer would cost quota and ~500 ms |
| D3 | Three-tier answer cache: **phone → Worker memory (L1) → Workers KV (L2)** | Popular questions are answered once, then served from the edge for days | Embedding-based semantic cache (see §6.6) |
| D4 | **The server decides what is cacheable** and tells the phone via `cacheTtlSec` | One source of truth, and the policy can change without shipping an APK | Duplicating the rules in the app |
| D5 | Follow-up detection: only real follow-ups keep conversation history | Before this, any question asked within 2 minutes of another carried history and was never cached, so most questions in a session missed | Never sending history (breaks "who runs it?") |
| D6 | Request coalescing (single-flight) per cache key | A thundering herd on a cold key costs one LLM call, not N | None; this is cheap and strictly better |
| D7 | Provider chain: **Groq gpt-oss-20b → Groq gpt-oss-120b → OpenRouter (free)**, with circuit breakers | Two Groq models give two independent free quotas from one key. OpenRouter adds vendor diversity. | Gemini (removed, §7.3) |
| D8 | Stateless API on **Cloudflare Workers**. The same code runs on Node (Docker, Render, Kubernetes). | 100k requests/day free, no cold-start sleep, an edge presence in every major Indian city, and no fleet to operate | A Node VM on a free host: sleeps when idle, single region |
| D9 | Only text crosses the network (~100 B up, ~300 B down) | Cheap on 2G/3G and fast to serialise | Streaming audio |

## 3. Architecture

```mermaid
flowchart LR
  subgraph Phone["Android phone (Expo / React Native)"]
    MIC[Mic] --> STT[On-device STT]
    STT --> R{Intent router}
    R -- "timer, alarm, call,<br/>app, maths, time…" --> ACT[Android intents]
    R -- "open question" --> PC[(Phone cache<br/>300 answers)]
    PC -- miss --> NET((HTTPS))
    ACT --> TTS[System TTS]
    PC -- hit --> TTS
  end
  NET --> W
  subgraph Edge["Cloudflare Workers (stateless, every PoP)"]
    W[POST /v1/ask<br/>validate · rate limit] --> FU{Follow-up?}
    FU -- no --> L1[(L1: isolate LRU)]
    L1 -- miss --> L2[(L2: Workers KV<br/>global)]
    L2 -- miss --> SF[Single-flight]
    FU -- yes --> SF
    SF --> CH[Provider chain +<br/>circuit breakers]
  end
  CH --> G1[Groq gpt-oss-20b]
  CH -. 429/5xx .-> G2[Groq gpt-oss-120b]
  CH -. 429/5xx .-> OR[OpenRouter free]
```

### One request, step by step

1. The user taps the mic. Android's recogniser transcribes on-device (offline when the language pack is installed). Silence end-pointing is set to 1.2 s.
2. `intents.ts` classifies the text. Device intents go straight to Android intents (`SET_TIMER`, `SET_ALARM`, `tel:`, `geo:`…), and the reply is spoken. **No network.**
3. Open questions check the **phone cache** first. A hit is spoken immediately (~1 ms, also offline).
4. On a miss, the phone sends `{query, locale, history}` to `POST /v1/ask` with an anonymous per-install device ID.
5. The Worker validates the input, applies per-device and per-IP token buckets, normalises the query, and decides whether it is a follow-up.
6. Stand-alone, evergreen questions are looked up in L1, then L2, under the key `a2:sha256(locale|normalised query)`.
7. On a miss, single-flight makes sure one LLM call serves every concurrent identical question. The provider chain tries Groq, fails over on 429/5xx, and benches a limited provider for its `Retry-After` window.
8. The answer is cleaned for speech (markdown, URLs and emoji stripped). The cache write to L1 and KV happens after the response is sent (`waitUntil`). The response carries `cacheTtlSec`, so the phone knows whether it may keep the answer.
9. The UI tags each answer with where it was computed (`ON-DEVICE`, `CACHE · PHONE`, `CACHE · EDGE`, `CLOUD · groq`) and how long it took. Every claim in this report is visible in the product.

## 4. Tier 0: the phone

**Speech.** STT and TTS are the system engines. This is the single biggest scaling decision: audio is the heaviest payload in a voice product, and it never reaches our servers. The trade-off is quality variance across devices and missing Hindi offline packs on some phones. The app detects `network` and `language-not-supported` errors and tells the user how to install the pack.

**Intent router** (`app/src/intents.ts`). A pure-TypeScript, rule-based router for English, Hinglish and Hindi:
- Timers ("10 minute ka timer lagao", "5 मिनट का टाइमर"), alarms ("wake me up at 6 pm"), calls, opening ten common apps, web search, navigation, time, date and battery.
- Spoken maths ("18% of 2,450", "25 into 4", "2 to the power of 10"). It uses a recursive-descent parser, **not `eval`**, because voice text is untrusted input.
- Anything it doesn't recognise falls through to the cloud. A false negative costs one cloud call; a false positive would run the wrong action, so the rules are deliberately strict.

Rules beat a small on-device model here. They are deterministic, ~1 ms on any phone, testable (25 tests), and easy for a reviewer to audit. A learned classifier becomes worth it once real traffic shows which phrasings the rules miss. The route tag on every answer is the telemetry hook for that.

**Phone cache** (`app/src/answerCache.ts`). An LRU of 300 answers in AsyncStorage (~60 KB). It stores an answer only when the server returned `cacheTtlSec > 0`, so time-sensitive answers and follow-ups never land on the phone. A repeated question costs no network, no quota and no server request, and works offline.

## 5. The cloud path

`backend/src/app.js` is a ~170-line Hono app. `worker.js` and `node.js` are thin adapters around it, so the same code runs on Workers, in Docker, on Render and on Kubernetes (`deploy/`). It keeps no per-user state. Rate-limit buckets and L1 are deliberately local to each instance (§9).

Input is bounded at every layer:
- an 8 KB body limit
- a 500-character query
- at most 6 history turns of 800 characters each
- an allow-list of locales
- a regex-checked device ID

LLM output is capped at 2 sentences / 45 words by the system prompt and then sanitised for TTS.

## 6. Caching (the core of the design)

### 6.1 What we measured before changing anything

On the live Worker, the same question sent twice in a row **missed both times**. The second request landed on a different V8 isolate, and each isolate had its own private in-memory cache. On Workers, an isolate-local cache alone gives a near-zero hit rate across real users. A second bug compounded this: the app attaches recent history to any question asked within 2 minutes of the last one, and the server refused to cache anything that carried history.

### 6.2 Tiers

| Tier | Where | Latency (measured) | Scope | Cost |
|---|---|---|---|---|
| 0 | Phone (AsyncStorage) | ~1 ms | one user | free |
| L1 | Worker isolate LRU (20k entries) | 0 ms server time | one isolate | free |
| L2 | **Workers KV** | 1–4 ms server time (local Workers runtime) | global, all PoPs | free: 100k reads + 1k writes/day. Paid: $0.50/M reads, $5/M writes |
| (Node) | Upstash Redis over REST | network RTT | global | free: 500k commands/month |

An L2 hit is promoted into L1 for 5 minutes, so a hot key costs at most one KV read per isolate per 5 minutes.

**Why KV for L2:**
- It is a native Workers binding, so there is no extra vendor, secret or TLS hop.
- It is read-optimised and eventually consistent, which is exactly the profile of an answer cache: written once, read many times, and harmless if a new entry takes up to 60 s to appear in other PoPs.
- Hot keys are served from the PoP's local cache.

Alternatives considered:
- The Cache API (`caches.default`) is a no-op on `*.workers.dev`. It becomes a useful per-PoP tier once the API is on a custom domain (§11).
- Upstash's free tier (500k commands/month) is smaller than KV's (3M reads/month).
- D1 and Durable Objects are databases, not caches. They add a hop to a single region.

### 6.3 What is cacheable

An answer is shared only if it is **stand-alone** and **evergreen**:

- **Time-sensitive** questions are never cached: "today", "now", "latest", "weather", "score", "price", "aaj", "abhi", "आज" and similar.
- **Follow-ups** are never cached and keep their history:
  - pronouns that point back ("it", "they", "uska", "इसका")
  - continuation starters ("and…", "what about…", "aur…", "और…")
  - bare follow-up phrases ("why?", "tell me more", "in Hindi")
- **Everything else is treated as stand-alone.** History is dropped before the LLM call and the answer is cached. The phone can keep sending history and the server decides, so this policy ships without an app update.

Errors on each side cost different amounts:
- Wrongly calling something a follow-up costs **one cache miss**.
- Wrongly calling a follow-up stand-alone costs **a context-free answer**: the model asks "which one?", and the user rephrases.

The rules therefore lean towards "follow-up". Dropping history for stand-alone questions also cuts prompt tokens, which matters because Groq's 8k tokens/min is reached at about the same point as its 30 requests/min.

### 6.4 Key derivation

`key = "a2:" + sha256(locale + "|" + normalise(query))`

Normalisation only merges phrasings that mean the same thing:
- Unicode NFKC and lower-case.
- Punctuation dropped, Devanagari combining marks kept.
- Wake words and politeness removed ("hey vaani", "can you tell me", "please", "batao").
- Contractions expanded ("what's" → "what is").
- "the" dropped.
- "kya hota hai" treated as "kya hai".

Tests pin the dangerous cases: "vitamin a" keeps its "a", and "capital of Austria" ≠ "capital of Australia". The locale is part of the key because a Hindi answer is a different answer. The `a2` prefix is a cache version: changing the system prompt or the normaliser makes every old entry unreachable, with no flush needed.

### 6.5 TTL and write budget

- **TTL is 7 days.** Only evergreen questions get in, so a long TTL is safe, and the hit rate grows with it.
- **Only the request that actually calls the LLM writes the cache.** Coalesced waiters don't, so 20 simultaneous identical questions produce 1 LLM call and 1 KV write. A test checks this.
- **Writes pause after a failure.** KV's free plan allows 1,000 writes/day. After the first failed write (quota or outage) the Worker stops attempting KV writes for 10 minutes instead of spending a subrequest on every miss. L1 keeps working.

### 6.6 Why not a semantic (embedding) cache

A semantic cache would raise the hit rate, but it trades correctness for it in the worst possible way:
- The nearest neighbour of "capital of Austria" is "capital of Australia".
- The nearest neighbour of "side effects of paracetamol" is "side effects of ibuprofen".
- Each one is a **confidently wrong spoken answer**, and in a voice product the user can't see a source to doubt it.

An exact-match cache over a careful normaliser has no false hits by construction. It also costs no embedding call (latency and quota) on every request.

## 7. LLM providers

### 7.1 Groq, primary (two models, one key)

Groq serves `openai/gpt-oss-20b` in ~170 ms for a short answer (measured with `reasoning_effort: low`). Free limits apply **per model**, so `gpt-oss-120b` on the same key is a second, independent 1,000/day bucket. That doubles free capacity with no extra account. Both run with `reasoning_effort: low` and `include_reasoning: false`, so we don't pay latency or bandwidth for reasoning text we would discard.

### 7.2 OpenRouter: what it is for

OpenRouter is a single API in front of hundreds of models hosted by many companies. In Vaani it is the **last-resort fallback, and the only provider that isn't on Groq's infrastructure.** It covers three failure modes Groq's second model can't:

1. a Groq outage or regional incident
2. a revoked or rate-banned Groq key
3. both Groq daily quotas exhausted late in the day

It is **not** a capacity tier. Free (`:free`) models are capped at **20 requests/min and 50 requests/day** per account (1,000/day once $10 of credit has ever been bought).

**Model choice was measured, not guessed.** I tested all 14 free models currently listed, then retested the working ones in Hindi:
- Individual free models are often at capacity. Gemma 4 returned 429 throughout testing.
- Free reasoning models can spend the entire token budget "thinking" and return an empty answer.

So the request:
- sends OpenRouter an ordered list (`models`), and OpenRouter falls through it inside one request
- switches reasoning off

The list is `nvidia/nemotron-3.5-super-vl:free` → `baidu/ernie-5.5-flash-preview:free` → `google/gemma-4-26b-a4b-it:free`. Measured end to end through this code, the fallback answers in **0.4–0.95 s** in clean Devanagari and English, close to Groq. The list can be changed with `OPENROUTER_MODELS`, with no code change, and the response reports which model actually answered.

In a paid deployment, OpenRouter (or a second direct provider) would become a real secondary with its own capacity.

### 7.3 Why Gemini was removed

The on-device tier already covers what a cheap, fast cloud model would have added: instant answers for common commands and offline behaviour. A third commercial API adds a key to rotate, another data-processing agreement and another failure surface, without capacity that changes the outcome. Removing it is a one-line config change, and the chain is just `PROVIDER_ORDER`.

### 7.4 Failure handling

Each provider has a circuit breaker:
- **429:** bench the provider for its `Retry-After` window (default 30 s), then try the next one immediately. On free tiers a 429 is normal traffic, not an incident.
- **401 / 403 / 404:** bench for 5 minutes. A bad key or model ID won't fix itself.
- **5xx, timeout (8 s) or network error:** bench for 15 s after 3 consecutive failures.
- **Every provider down:** return 503 with a `Retry-After` header. The app speaks "The assistant is busy, try again in N seconds", and device commands keep working.

## 8. Capacity model for 10 lakh concurrent users

**Assumptions** (labelled as such; each can be checked against the route tags once real traffic exists):

| Parameter | Value | Note |
|---|---|---|
| Concurrent active users at peak | 1,000,000 | the brief |
| Commands per active user | 1 every 30 s | conservative; voice sessions are bursty |
| Share handled on-device | 50% | timers, alarms, calls, apps, maths, time |
| Phone cache + edge cache hit rate on open questions | 50% | head-heavy query distribution, 7-day TTL |

**Resulting load at peak:**

| Stage | Rate |
|---|---|
| Commands | 33,300 /s |
| Reach the server (50% on-device) | **16,700 /s** |
| Reach an LLM (50% cache hit) | **~8,300 /s** |
| LLM calls in flight (Little's law, ~0.6 s each) | ~5,000 |

**API tier.** On Workers there is nothing to size; the platform scales out. For the Node / Kubernetes path, see the benchmark below (one Node 22 process on an Apple M4 core, mock LLM so it measures only our code):

| Scenario | Throughput | p50 | p99 | Memory |
|---|---|---|---|---|
| Cache hit, 100 connections | **31,600 req/s** | 3 ms | 5 ms | 480 MB |
| Cache miss, 350 ms LLM, 2,000 connections | **5,200 req/s** | 372 ms | 490 ms | 737 MB |

Derating 2× for a cloud vCPU, 8,300 hits/s plus 8,300 misses/s needs about **4 vCPUs**. `deploy/k8s.yaml` runs a minimum of 6 single-vCPU pods across zones, with a horizontal pod autoscaler up to 120 for headroom. The API is not the bottleneck.

**LLM tier (the real bottleneck).** About 8,300 LLM calls/s is far beyond any free tier. The free deployment sustains roughly 1 LLM call/s (2 Groq models × ~30 requests/min) and 2,000 unique answers/day, while cache hits stay unlimited up to Workers' 100k requests/day. That is enough to demonstrate the architecture at a few thousand daily users. **Reaching 10 lakh concurrent users needs no code change, only paid LLM capacity**: Groq Developer tier or provisioned throughput, plus a second direct provider in the chain.

## 9. Cost model

Per **1 million server requests** at a 50% cache hit rate, at paid list prices. All prices are USD and should be checked against the current pricing pages:

| Item | Usage | Cost |
|---|---|---|
| LLM: Groq gpt-oss-20b ($0.075/M input, $0.30/M output) | 500k calls × ~200 input / ~80 output tokens | **~$19.50** |
| Workers KV writes ($5/M) | ≤400k (stand-alone misses only) | ≤$2.00 |
| Workers KV reads ($0.50/M) | ≤1M (L1 absorbs most) | ≤$0.50 |
| Workers requests ($0.30/M beyond the 10M included in $5/month) | 1M | $0.30 |
| STT, TTS, intent routing | on the phone | **$0** |
| **Total** | | **≈ $22 per million server requests ≈ $11 per million voice commands** |

What the table shows:
1. **The LLM is ~87% of cost.** Every point of cache hit rate is a point off the bill, which is why caching got the most design attention.
2. **On-device processing halves the bill before the cache does anything,** and removes audio costs entirely. Cloud speech recognition alone would cost more than the whole table.
3. **KV writes are the second line item.** At paid scale, a TinyLFU-style admission policy (write to L2 only on a key's second miss) would cut most of them, because most distinct questions are asked only once.

## 10. Measured performance

| Path | Server time | Felt by the user |
|---|---|---|
| On-device command | n/a | ~1 ms + TTS start |
| Phone cache hit | n/a | ~1 ms |
| Edge L1 hit (live Worker) | 0 ms | ~190 ms network round trip, measured from a dev laptop |
| Edge L2 hit (KV, local Workers runtime) | 1–4 ms | network round trip + ~4 ms |
| LLM miss (live Worker → Groq 20b) | 430–850 ms warm, 2.3 s on a cold first request | + network round trip |

**Biggest remaining latency lever:** the recogniser waits 1.2 s of silence before finishing. Lowering it to ~0.8 s saves more than any server change, but it cuts off Hindi speakers who pause mid-sentence. That should be tuned against real users, not guessed.

## 11. Failure modes

| Failure | Behaviour |
|---|---|
| No network on the phone | Device commands and phone-cached answers still work. Other questions get a spoken "I can't reach the server; timers, alarms, maths and app commands still work offline". |
| Groq rate-limited | Fails over to Groq 120b, then OpenRouter, within the same request |
| Every LLM provider down | 503 + `Retry-After`, spoken to the user. Cached answers keep being served. |
| KV down or over quota | Reads fall back to L1 or a miss. Writes pause for 10 minutes. Requests never fail because of the cache. |
| Thundering herd on a new popular question | Single-flight: one LLM call per isolate per key |
| One device spamming | Per-device token bucket (20/min) and per-IP (120/min) → 429 + `Retry-After` |
| Bad input or abuse | Size, shape and locale validation. No `eval` anywhere. Model output stripped of markup before TTS. |

**Known limit.** Rate-limit buckets live in each isolate, so one abusive client spread across many PoPs gets more than 20/min in total. At production scale, the coarse global limit belongs at the edge: Cloudflare WAF rate-limiting rules or the Workers Rate Limiting binding. The per-isolate bucket still stops a single device from hammering one instance.

## 12. Security and privacy

- **No audio leaves the phone.** The server receives only the transcribed text of open questions.
- **No accounts and no PII.** The device ID is a random UUID per install, used only for rate limiting. Logs never contain question text, only provider error codes.
- **Provider keys exist only as Worker secrets.** The APK contains no secret, and an optional `APP_TOKEN` header adds a shared-secret gate.
- **The cache stores answers only, keyed by a hash of the normalised question.** No device ID or history ever enters a cache entry.

## 13. What I would do next, in priority order

1. **Custom domain → add the Cache API as a per-PoP tier** between L1 and KV. It is free and unmetered, and it takes most KV reads off the bill.
2. **Global rate limiting** with the Workers Rate Limiting binding or WAF rules (§11).
3. **Collect real hit-rate and route-share data** (Workers Analytics Engine), then tune the follow-up rules, TTL and on-device intents against it instead of assumptions.
4. **KV admission policy** (write on second miss) at paid scale (§9).
5. **Stream the LLM answer and start TTS on the first sentence.** It matters less here because answers are capped at 2 sentences and Groq produces them in ~200 ms, but it would hide tail latency.
6. **A pre-warmed answer pack:** ship the top ~1,000 evergreen Q&As inside the APK, so a new install has cache hits on day one.

## 14. How to verify

```bash
cd backend && npm test   # 22 tests: normaliser, follow-up rules, LRU, KV tier shared across two
                         # isolates, write-pause, coalescing (1 LLM call + 1 KV write for 20 requests),
                         # failover, rate limits, validation
npm run bench            # the table in §8
cd ../app && npm test    # 25 tests: intent router in 3 languages, maths parser, phone cache keys
```

The same question asked from two places shows the tiers directly: `CLOUD · groq` → `CACHE · EDGE` → `CACHE · PHONE`.
