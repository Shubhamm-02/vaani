// Provider chain with per-provider circuit breakers.
// Free tiers rate-limit hard (Groq ~30 RPM, OpenRouter 20 RPM), so a 429 is
// normal traffic, not an incident: we bench that provider for its Retry-After
// window and move to the next one instead of retrying into the wall.

export const SYSTEM_PROMPT = `You are Vaani, a voice assistant on an Android phone. Your reply is read aloud by text-to-speech.
Rules:
- At most 2 short sentences, under 45 words.
- Plain spoken language. No markdown, lists, emojis, URLs or code.
- Reply in the user's language and script (English, Hindi, or Hinglish).
- If the question needs live data you do not have (weather, news, prices, scores), say so in one sentence and suggest saying "search for" followed by the topic.
- Never invent facts. If unsure, say so.`;

export class AllProvidersFailed extends Error {
  constructor(retryAfterSec, causes) {
    super('all LLM providers unavailable');
    this.retryAfterSec = retryAfterSec;
    this.causes = causes;
  }
}

class HttpError extends Error {
  constructor(status, retryAfterSec) {
    super(`upstream ${status}`);
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
}

export function buildMessages(query, history, locale) {
  const lang = locale === 'hi-IN' ? 'The user is speaking Hindi.' : 'The user is speaking Indian English.';
  return [
    { role: 'system', content: `${SYSTEM_PROMPT}\n${lang}` },
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: query },
  ];
}

// TTS reads symbols aloud ("asterisk asterisk"), so strip anything that isn't speech.
export function cleanForSpeech(text) {
  return String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[*_#`>|~]+/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class ProviderChain {
  constructor(providers, { timeoutMs = 8000, fetchImpl = (...a) => fetch(...a), now = Date.now } = {}) {
    this.providers = providers;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
    this.now = now;
    this.health = new Map(providers.map((p) => [p.name, { openUntil: 0, failures: 0 }]));
  }

  status() {
    const t = this.now();
    return this.providers.map((p) => {
      const h = this.health.get(p.name);
      return { name: p.name, model: p.model, available: h.openUntil <= t, lastError: h.lastError || null };
    });
  }

  async complete(messages) {
    const causes = [];
    let soonest = Infinity;
    for (const p of this.providers) {
      const h = this.health.get(p.name);
      if (h.openUntil > this.now()) {
        soonest = Math.min(soonest, h.openUntil);
        causes.push(`${p.name}: cooling down`);
        continue;
      }
      try {
        const out = await this.#call(p, messages);
        h.failures = 0;
        h.lastError = null;
        return out;
      } catch (err) {
        causes.push(`${p.name}: ${err.message}`);
        h.lastError = err.message.slice(0, 160);
        this.#trip(h, err);
        soonest = Math.min(soonest, h.openUntil);
      }
    }
    const retryAfterSec = Number.isFinite(soonest) ? Math.max(1, Math.ceil((soonest - this.now()) / 1000)) : 5;
    throw new AllProvidersFailed(retryAfterSec, causes);
  }

  #trip(h, err) {
    const t = this.now();
    if (err.status === 429) {
      h.openUntil = t + (err.retryAfterSec || 30) * 1000;
    } else if (err.status === 401 || err.status === 403 || err.status === 404) {
      h.openUntil = t + 5 * 60_000; // bad key or model id: no point retrying soon
    } else {
      h.failures += 1; // 5xx, timeout, network
      if (h.failures >= 3) {
        h.openUntil = t + 15_000;
        h.failures = 0;
      }
    }
  }

  async #call(p, messages) {
    const started = this.now();
    if (p.mock) {
      await sleep(p.latencyMs);
      const q = messages.at(-1).content;
      return {
        text: `Demo mode: I heard "${q}". Add a free Groq key on the server for real answers.`,
        provider: 'mock',
        model: p.model,
        upstreamMs: this.now() - started,
      };
    }

    const res = await this.fetch(`${p.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${p.key}`,
        'content-type': 'application/json',
        ...(p.name === 'openrouter' ? { 'x-title': 'Vaani' } : {}),
      },
      body: JSON.stringify({
        model: p.model,
        messages,
        max_tokens: p.maxTokens,
        temperature: 0.3,
        ...p.extra,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      const ra = Number(res.headers.get('retry-after'));
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      console.warn(`[llm] ${p.name} ${res.status} ${detail}`);
      throw new HttpError(res.status, Number.isFinite(ra) && ra > 0 ? ra : undefined);
    }
    const data = await res.json();
    const text = cleanForSpeech(data?.choices?.[0]?.message?.content);
    if (!text) {
      // Log shape only, never content: completions can quote the user's question.
      console.warn(`[llm] ${p.name} empty completion: finish=${data?.choices?.[0]?.finish_reason} usage=${JSON.stringify(data?.usage ?? null)}`);
      throw new Error('empty completion');
    }
    return {
      text,
      provider: p.name,
      model: data.model || p.model, // OpenRouter may have served a fallback model
      upstreamMs: this.now() - started,
      tokens: data.usage?.total_tokens,
    };
  }
}
