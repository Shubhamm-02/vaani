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
- Never invent facts. If unsure, say so.
- You only answer questions. You cannot act on the phone: you cannot set alarms or timers, make calls, send messages, open apps or change settings. Never say or imply that you did. If asked to, say you couldn't do it and suggest a simple phrasing the phone understands, such as "set an alarm for 7 am", "10 minute ka timer lagao", "call" followed by the number, or "open" followed by the app name.`;

// Spoken when a phone action reaches the cloud, or when a model claims it acted.
export const CANT_ACT = {
  'en-IN': "I couldn't do that. I can set alarms and timers, call a number and open apps. Try saying: set an alarm for 7 am.",
  'hi-IN': 'यह मैं नहीं कर पाई। मैं अलार्म, टाइमर, कॉल और ऐप खोल सकती हूँ। ऐसे बोलिए: सुबह 7 बजे का अलार्म लगाओ।',
};

// "Sure, setting an alarm…", "I've set…", "अलार्म लगा दिया" - the model claiming an action.
const CLAIMED_ACTION =
  /\b(?:i(?:'| ha)ve (?:set|sent|called|opened|scheduled|added)|i (?:set|sent|called|opened|scheduled)|(?:setting|sending|calling|opening|scheduling) (?:an? |the |your )?(?:alarm|timer|reminder|message|call|app)|(?:alarm|timer|reminder) (?:is |has been )?set\b)|लगा दिया|लगा दी|भेज दिया|सेट कर दिया|कॉल कर रही/iu;

export function claimsAction(text) {
  return CLAIMED_ACTION.test(text);
}

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
    .replace(/<think>[\s\S]*$/, '') // reasoning cut off by max_tokens: never speak it
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
  constructor(providers, { timeoutMs = 6000, budgetMs = 10_000, fetchImpl = (...a) => fetch(...a), now = Date.now } = {}) {
    this.providers = providers;
    this.timeoutMs = timeoutMs;
    // One deadline for the whole chain, so the server always answers (even if only
    // "busy, try again") before the app's own 15 s timeout fires.
    this.budgetMs = budgetMs;
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
    const deadline = this.now() + this.budgetMs;
    for (const p of this.providers) {
      const h = this.health.get(p.name);
      if (h.openUntil > this.now()) {
        soonest = Math.min(soonest, h.openUntil);
        causes.push(`${p.name}: cooling down`);
        continue;
      }
      const left = deadline - this.now();
      if (left < 500) {
        causes.push(`${p.name}: no time left`);
        break;
      }
      try {
        const out = await this.#call(p, messages, Math.min(this.timeoutMs, left));
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

  async #call(p, messages, timeoutMs = this.timeoutMs) {
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
      signal: AbortSignal.timeout(timeoutMs),
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
      truncated: data?.choices?.[0]?.finish_reason === 'length', // spoken, but never cached
    };
  }
}
