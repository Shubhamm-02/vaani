// Turns an env object (process.env on Node, c.env on Workers) into typed config.
// Every provider here exposes an OpenAI-compatible /chat/completions endpoint,
// so one client covers all of them and swapping vendors is a config change.

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

// Bump when the system prompt or normalisation changes: old cache entries become unreachable.
export const CACHE_VERSION = 'a3';

const PROVIDERS = {
  // Primary. Groq's free tier is per organisation *per model*:
  // 1,000 requests/day and 8,000 tokens/min each (read from x-ratelimit-* headers).
  groq: (env) => ({
    name: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: env.GROQ_MODEL || 'openai/gpt-oss-20b',
    key: env.GROQ_API_KEY,
    // gpt-oss is a reasoning model: keep reasoning short for voice latency, and don't
    // ship the reasoning text back to us (we would only throw it away).
    extra: { reasoning_effort: 'low', include_reasoning: false },
    maxTokens: 512,
  }),
  // Same key, second model = a second, independent quota bucket. Doubles free capacity.
  groq2: (env) => ({
    name: 'groq-120b',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: env.GROQ_MODEL_2 || 'openai/gpt-oss-120b',
    key: env.GROQ_API_KEY_2 || env.GROQ_API_KEY,
    extra: { reasoning_effort: 'low', include_reasoning: false },
    maxTokens: 512,
  }),
  // Last resort, and the only one on different infrastructure. Free models are capped
  // at 20 RPM and 50 requests/day (1,000/day once $10 of credit has ever been bought),
  // so it cannot carry load. Its job is to keep answering during a Groq outage,
  // a revoked key, or after both Groq daily quotas are spent.
  // Individual free models are often overloaded (429), so OpenRouter is given a list
  // and falls through it server-side within one request. Reasoning is switched off:
  // free reasoning models otherwise spend the whole token budget thinking and return
  // an empty answer (measured), and voice needs the answer, not the thinking.
  openrouter: (env) => {
    const models = (env.OPENROUTER_MODELS || env.OPENROUTER_MODEL || OPENROUTER_DEFAULT_MODELS)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return {
      name: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: models[0],
      key: env.OPENROUTER_API_KEY,
      extra: { ...(models.length > 1 ? { models } : {}), reasoning: { enabled: false } },
      maxTokens: 300, // Devanagari costs ~3x the tokens of English for the same answer
    };
  },
};

// Picked by measurement (Nov 2026), including Hindi: nemotron answered in 0.5-0.8 s
// in clean Devanagari; ernie is slower but reliable; gemma is good but often at capacity.
const OPENROUTER_DEFAULT_MODELS =
  'nvidia/nemotron-3.5-super-vl:free,baidu/ernie-5.5-flash-preview:free,google/gemma-4-26b-a4b-it:free';

export function loadConfig(env = {}) {
  const order = (env.PROVIDER_ORDER || 'groq,groq2,openrouter')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => PROVIDERS[s]);

  let providers = order.map((n) => PROVIDERS[n](env)).filter((p) => p.key);
  const mockLatencyMs = num(env.MOCK_LATENCY_MS, 350);
  if (env.MOCK_LLM === '1' || providers.length === 0) {
    providers = [{ name: 'mock', model: 'echo', mock: true, latencyMs: mockLatencyMs }];
  }

  return {
    providers,
    llmTimeoutMs: num(env.LLM_TIMEOUT_MS, 6000), // per provider attempt
    llmBudgetMs: num(env.LLM_BUDGET_MS, 10_000), // whole chain; keep below the app's 15 s
    // Only evergreen, stand-alone questions are cached, so a long TTL is safe and
    // directly raises the hit rate. Time-sensitive questions never enter the cache.
    cacheTtlSec: num(env.CACHE_TTL_SEC, 7 * 86400),
    cacheMaxEntries: num(env.CACHE_MAX_ENTRIES, 20000),
    rate: {
      perDevicePerMin: num(env.RATE_DEVICE_PER_MIN, 20),
      perIpPerMin: num(env.RATE_IP_PER_MIN, 120),
    },
    kv: env.ANSWERS && typeof env.ANSWERS.get === 'function' ? env.ANSWERS : null,
    upstash:
      env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN
        ? { url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN }
        : null,
    appToken: env.APP_TOKEN || null,
    // Only trust X-Forwarded-For behind a proxy that sets it (Render, a k8s ingress).
    // On Workers the client IP comes from cf-connecting-ip, which clients cannot forge.
    trustProxy: env.TRUST_PROXY === '1',
  };
}
