import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { LRU, TieredCache } from '../src/cache.js';
import { loadConfig } from '../src/config.js';
import { SingleFlight, TokenBucket } from '../src/guards.js';
import { ProviderChain, cleanForSpeech } from '../src/llm.js';
import { isFollowUp, isTimeSensitive, normalize } from '../src/normalize.js';

const DEVICE = 'test-device-0001';

// In-memory stand-in for a Workers KV namespace binding.
function fakeKv({ failPuts = false } = {}) {
  const data = new Map();
  return {
    data,
    gets: 0,
    puts: 0,
    async get(k) {
      this.gets++;
      return data.get(k) ?? null;
    },
    async put(k, v, opts) {
      this.puts++;
      if (failPuts) throw new Error('KV put() limit exceeded for the day');
      data.set(k, v);
      this.lastTtl = opts?.expirationTtl;
    },
  };
}

function makeApp(env = {}, fetchImpl) {
  const cfg = loadConfig({ MOCK_LLM: '1', MOCK_LATENCY_MS: '20', ...env });
  return createApp(() => cfg, { fetchImpl });
}

const ask = (app, body, headers = {}) =>
  app.request('/v1/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-device-id': DEVICE, ...headers },
    body: JSON.stringify(body),
  });

const flush = () => new Promise((r) => setTimeout(r, 0)); // let background cache writes land

describe('normalize', () => {
  it('collapses fillers, punctuation, contractions and "the" into one cache key', () => {
    assert.equal(normalize('Hey Vaani, can you tell me what is GST?'), 'what is gst');
    assert.equal(normalize('what is gst please'), 'what is gst');
    assert.equal(normalize('  WHAT   is GST!! '), 'what is gst');
    assert.equal(normalize("What's the capital of France?"), normalize('what is capital of france'));
    assert.equal(normalize('UPI kya hota hai'), normalize('upi kya hai'));
  });
  it('keeps meaning-bearing words (no risky merges)', () => {
    assert.equal(normalize('what is vitamin a'), 'what is vitamin a');
    assert.notEqual(normalize('capital of austria'), normalize('capital of australia'));
  });
  it('keeps Devanagari intact', () => {
    assert.equal(normalize('यूपीआई क्या है?'), 'यूपीआई क्या है');
  });
  it('flags time-sensitive questions', () => {
    assert.ok(isTimeSensitive(normalize('What is the weather in Pune')));
    assert.ok(isTimeSensitive(normalize('aaj ka match score')));
    assert.ok(!isTimeSensitive(normalize('Who wrote the Gita')));
  });
  it('tells follow-ups from stand-alone questions', () => {
    for (const q of ['who runs it', 'And in Hindi?', 'why?', 'tell me more', 'uska founder kaun hai', 'इसका मतलब क्या है', 'what about Japan', 'और दिल्ली?', 'ये कौन है']) {
      assert.ok(isFollowUp(normalize(q)), q);
    }
    for (const q of ['What is UPI?', 'Who wrote the Ramayana', 'why is the sky blue', 'upi kya hai', 'capital of japan', 'paris kahan hai', 'तोता क्या खाता है', 'स्वस्थ रहने के लिए क्या खाना चाहिये']) {
      assert.ok(!isFollowUp(normalize(q)), q);
    }
  });
});

describe('cleanForSpeech', () => {
  it('strips markdown and links so TTS does not read symbols', () => {
    assert.equal(cleanForSpeech('**UPI** is fast. See https://npci.org.in'), 'UPI is fast. See');
  });
});

describe('LRU', () => {
  it('evicts least recently used and honours TTL', () => {
    let t = 0;
    const lru = new LRU(2, () => t);
    lru.set('a', 1, 1000);
    lru.set('b', 2, 1000);
    lru.get('a');
    lru.set('c', 3, 1000);
    assert.equal(lru.get('b'), undefined);
    assert.equal(lru.get('a'), 1);
    t = 2000;
    assert.equal(lru.get('a'), undefined);
  });
});

describe('TieredCache', () => {
  it('pauses L2 writes after a failure instead of retrying every miss', async () => {
    let t = 0;
    const kv = fakeKv({ failPuts: true });
    const { KvStore } = await import('../src/cache.js');
    const cache = new TieredCache({ maxEntries: 10, l2: new KvStore(kv), now: () => t });
    await cache.set('a', { text: 'x' }, 60);
    await cache.set('b', { text: 'y' }, 60);
    assert.equal(kv.puts, 1, 'second write skipped while paused');
    assert.deepEqual((await cache.get('b')).value, { text: 'y' }, 'L1 still works');
    t = 11 * 60_000;
    await cache.set('c', { text: 'z' }, 60);
    assert.equal(kv.puts, 2, 'retries after the pause');
  });
});

describe('TokenBucket', () => {
  it('allows the burst then refuses with a retry hint', () => {
    let t = 0;
    const b = new TokenBucket({ perMinute: 3, now: () => t });
    assert.ok(b.take('x').ok && b.take('x').ok && b.take('x').ok);
    const r = b.take('x');
    assert.equal(r.ok, false);
    assert.equal(r.retryAfterSec, 20);
    t = 20_000;
    assert.ok(b.take('x').ok);
  });
});

describe('SingleFlight', () => {
  it('runs one call for concurrent identical keys', async () => {
    const sf = new SingleFlight();
    let calls = 0;
    const fn = () => new Promise((r) => setTimeout(() => r(++calls), 10));
    const out = await Promise.all([sf.run('k', fn), sf.run('k', fn), sf.run('k', fn)]);
    assert.deepEqual(out, [1, 1, 1]);
  });
});

describe('ProviderChain', () => {
  const providers = [
    { name: 'a', baseUrl: 'https://a', model: 'm', key: 'k', extra: {}, maxTokens: 10 },
    { name: 'b', baseUrl: 'https://b', model: 'm', key: 'k', extra: {}, maxTokens: 10 },
  ];
  const ok = (text) => new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200 });

  it('fails over on 429 and benches the limited provider', async () => {
    const hits = [];
    const fetchImpl = async (url) => {
      hits.push(url);
      return url.startsWith('https://a') ? new Response('{}', { status: 429, headers: { 'retry-after': '30' } }) : ok('from b');
    };
    const chain = new ProviderChain(providers, { fetchImpl });
    assert.equal((await chain.complete([])).provider, 'b');
    assert.equal((await chain.complete([])).provider, 'b');
    assert.equal(hits.filter((h) => h.startsWith('https://a')).length, 1, 'a is skipped while cooling down');
  });

  it('reports a retry window when every provider is down', async () => {
    const chain = new ProviderChain(providers, { fetchImpl: async () => new Response('{}', { status: 429, headers: { 'retry-after': '12' } }) });
    await assert.rejects(chain.complete([]), (e) => e.retryAfterSec === 12);
  });
});

describe('loadConfig', () => {
  it('chains Groq (two models, two quotas) then OpenRouter; no Gemini', () => {
    const { providers } = loadConfig({ GROQ_API_KEY: 'k', OPENROUTER_API_KEY: 'o', GEMINI_API_KEY: 'g' });
    assert.deepEqual(
      providers.map((p) => [p.name, p.model]),
      [
        ['groq', 'openai/gpt-oss-20b'],
        ['groq-120b', 'openai/gpt-oss-120b'],
        ['openrouter', 'google/gemma-4-26b-a4b-it:free'],
      ],
    );
  });
  it('picks up a KV binding as the shared cache', () => {
    assert.ok(loadConfig({ ANSWERS: fakeKv() }).kv);
    assert.equal(loadConfig({ ANSWERS: 'not a binding' }).kv, null);
  });
});

describe('POST /v1/ask', () => {
  it('answers, then serves the same normalised question from cache', async () => {
    const app = makeApp();
    const first = await (await ask(app, { query: 'What is UPI?' })).json();
    assert.equal(first.source, 'llm');
    assert.ok(first.cacheTtlSec > 0, 'phone may keep it');
    const second = await (await ask(app, { query: 'hey vaani what is upi' })).json();
    assert.equal(second.source, 'cache');
    assert.equal(second.tier, 'l1');
    assert.equal(second.answer, first.answer);
  });

  it('shares answers across instances through KV (two Worker isolates)', async () => {
    const kv = fakeKv();
    const isolateA = makeApp({ ANSWERS: kv });
    const isolateB = makeApp({ ANSWERS: kv });
    const first = await (await ask(isolateA, { query: 'Who wrote the Ramayana?' })).json();
    assert.equal(first.source, 'llm');
    await flush();
    assert.equal(kv.puts, 1);
    assert.equal(kv.lastTtl, 7 * 86400);
    const second = await (await ask(isolateB, { query: 'who wrote ramayana' })).json();
    assert.equal(second.source, 'cache');
    assert.equal(second.tier, 'l2');
    const third = await (await ask(isolateB, { query: 'who wrote ramayana' })).json();
    assert.equal(third.tier, 'l1', 'promoted into the local tier');
    assert.equal(kv.gets, 2, 'one miss on A, one hit on B, none after promotion');
  });

  it('caches a stand-alone question even when the app sent history, and drops that history', async () => {
    const seen = [];
    const fetchImpl = async (url, init) => {
      seen.push(JSON.parse(init.body).messages.length);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Paris.' } }] }), { status: 200 });
    };
    const app = createApp(() => loadConfig({ GROQ_API_KEY: 'k' }), { fetchImpl });
    const history = [
      { role: 'user', content: 'what is upi' },
      { role: 'assistant', content: 'A payment system.' },
    ];
    await ask(app, { query: 'capital of france', history });
    assert.equal(seen[0], 2, 'system + user only');
    assert.equal((await (await ask(app, { query: 'capital of france', history })).json()).source, 'cache');
  });

  it('does not cache follow-ups or time-sensitive questions', async () => {
    const app = makeApp();
    const history = [
      { role: 'user', content: 'what is upi' },
      { role: 'assistant', content: 'A payment system.' },
    ];
    await ask(app, { query: 'who runs it', history });
    const again = await (await ask(app, { query: 'who runs it', history })).json();
    assert.equal(again.source, 'llm');
    assert.equal(again.cacheTtlSec, 0, 'phone must not keep it');
    await ask(app, { query: 'weather today' });
    assert.equal((await (await ask(app, { query: 'weather today' })).json()).source, 'llm');
  });

  it('coalesces concurrent identical questions into one LLM call and one KV write', async () => {
    const kv = fakeKv();
    const app = makeApp({ ANSWERS: kv });
    const results = await Promise.all(Array.from({ length: 20 }, () => ask(app, { query: 'explain gst' }, { 'x-forwarded-for': `10.0.0.${Math.random() * 250}` })));
    assert.ok(results.every((r) => r.status === 200));
    await flush();
    const m = await (await app.request('/metrics')).json();
    assert.equal(m.llmCalls, 1);
    assert.equal(m.coalesced, 19);
    assert.equal(kv.puts, 1);
  });

  it('rate limits a single device', async () => {
    const app = makeApp({ RATE_DEVICE_PER_MIN: '2' });
    await ask(app, { query: 'a' });
    await ask(app, { query: 'b' });
    const res = await ask(app, { query: 'c' });
    assert.equal(res.status, 429);
    assert.ok(Number(res.headers.get('retry-after')) > 0);
  });

  it('rejects bad input', async () => {
    const app = makeApp();
    assert.equal((await ask(app, { query: '' })).status, 400);
    assert.equal((await ask(app, { query: 'x'.repeat(501) })).status, 400);
    assert.equal((await ask(app, { query: 'hi', locale: 'fr-FR' })).status, 400);
    assert.equal((await ask(app, { query: 'hi' }, { 'x-device-id': 'bad' })).status, 400);
  });

  it('returns 503 with Retry-After when all providers are rate limited', async () => {
    const fetchImpl = async () => new Response('{}', { status: 429, headers: { 'retry-after': '9' } });
    const cfg = loadConfig({ GROQ_API_KEY: 'x' });
    const app = createApp(() => cfg, { fetchImpl });
    const res = await ask(app, { query: 'hello there' });
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('retry-after'), '9');
  });
});
