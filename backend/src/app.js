// Platform-agnostic API. node.js and worker.js are thin adapters around this.
// The service keeps no per-user state, so any instance can serve any request
// and the fleet scales by adding copies behind a load balancer.

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { KvStore, TieredCache, UpstashStore } from './cache.js';
import { CACHE_VERSION } from './config.js';
import { SingleFlight, TokenBucket } from './guards.js';
import { AllProvidersFailed, ProviderChain, buildMessages } from './llm.js';
import { hashKey, isFollowUp, isTimeSensitive, normalize } from './normalize.js';

const LOCALES = new Set(['en-IN', 'hi-IN']);
const DEVICE_ID = /^[A-Za-z0-9-]{8,64}$/;

function validate(body) {
  if (!body || typeof body !== 'object') return 'body must be a JSON object';
  const { query, history = [], locale = 'en-IN' } = body;
  if (typeof query !== 'string' || !query.trim() || query.length > 500) return 'query must be 1-500 chars';
  if (!LOCALES.has(locale)) return 'unsupported locale';
  if (!Array.isArray(history) || history.length > 6) return 'history must be an array of at most 6 turns';
  for (const h of history) {
    if (!h || !['user', 'assistant'].includes(h.role) || typeof h.content !== 'string' || h.content.length > 800) {
      return 'bad history item';
    }
  }
  return null;
}

function clientIp(c) {
  const xff = c.req.header('x-forwarded-for');
  return (
    c.req.header('cf-connecting-ip') ||
    (xff && xff.split(',')[0].trim()) ||
    c.env?.incoming?.socket?.remoteAddress ||
    'unknown'
  );
}

// Workers: finish the promise after the response is sent. Node: fire and forget.
function background(c, promise) {
  try {
    c.executionCtx.waitUntil(promise);
  } catch {
    promise.catch(() => {});
  }
}

export function createApp(resolveConfig, { fetchImpl } = {}) {
  let state;
  const init = (c) => {
    if (state) return state;
    const cfg = resolveConfig(c);
    // Wrap global fetch: Workers throws "Illegal invocation" if fetch is called with another `this`.
    const f = fetchImpl || ((...a) => fetch(...a));
    const l2 = cfg.kv ? new KvStore(cfg.kv) : cfg.upstash ? new UpstashStore(cfg.upstash, f) : null;
    state = {
      cfg,
      chain: new ProviderChain(cfg.providers, { timeoutMs: cfg.llmTimeoutMs, fetchImpl: f }),
      cache: new TieredCache({ maxEntries: cfg.cacheMaxEntries, l2 }),
      perDevice: new TokenBucket({ perMinute: cfg.rate.perDevicePerMin }),
      perIp: new TokenBucket({ perMinute: cfg.rate.perIpPerMin }),
      flights: new SingleFlight(),
      m: { requests: 0, followUps: 0, llmCalls: 0, coalesced: 0, rateLimited: 0, upstreamFailures: 0, startedAt: Date.now() },
    };
    return state;
  };

  const app = new Hono();

  app.get('/healthz', (c) => {
    const s = init(c);
    return c.json({ ok: true, cache: s.cache.l2 ? s.cache.l2.name : 'l1-only', providers: s.chain.status() });
  });

  // Per instance (per isolate on Workers). Fleet-wide numbers come from the platform's analytics.
  app.get('/metrics', (c) => {
    const s = init(c);
    const cs = s.cache.stats;
    const answered = cs.l1Hits + cs.l2Hits + s.m.coalesced + s.m.llmCalls;
    return c.json({
      ...s.m,
      cache: { ...cs, l2: s.cache.l2?.name ?? null, l1Entries: s.cache.l1.size },
      cacheHitRate: answered ? +((cs.l1Hits + cs.l2Hits + s.m.coalesced) / answered).toFixed(3) : 0,
      uptimeSec: Math.round((Date.now() - s.m.startedAt) / 1000),
    });
  });

  app.post(
    '/v1/ask',
    bodyLimit({ maxSize: 8 * 1024, onError: (c) => c.json({ error: 'payload_too_large' }, 413) }),
    async (c) => {
      const t0 = Date.now();
      const s = init(c);
      s.m.requests++;

      if (s.cfg.appToken && c.req.header('x-app-token') !== s.cfg.appToken) {
        return c.json({ error: 'unauthorized' }, 401);
      }
      const deviceId = c.req.header('x-device-id') || '';
      if (!DEVICE_ID.test(deviceId)) return c.json({ error: 'missing or bad x-device-id' }, 400);

      for (const [bucket, key] of [
        [s.perDevice, deviceId],
        [s.perIp, clientIp(c)],
      ]) {
        const r = bucket.take(key);
        if (!r.ok) {
          s.m.rateLimited++;
          c.header('retry-after', String(r.retryAfterSec));
          return c.json({ error: 'rate_limited', retryAfterSec: r.retryAfterSec }, 429);
        }
      }

      let body;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'invalid JSON' }, 400);
      }
      const problem = validate(body);
      if (problem) return c.json({ error: problem }, 400);

      const query = body.query.trim();
      const locale = body.locale || 'en-IN';
      const norm = normalize(query);

      // The app sends recent turns with every question. Only a real follow-up
      // ("who runs it", "in hindi") needs them; for anything else history would just
      // cost tokens and make a shareable answer uncacheable. Decided here, not on the
      // phone, so the policy can change without shipping a new APK.
      const followUp = isFollowUp(norm);
      if (followUp) s.m.followUps++;
      const history = followUp ? body.history || [] : [];
      const cacheable = !followUp && norm.length > 0 && !isTimeSensitive(norm);
      const ttl = s.cfg.cacheTtlSec;
      const key = cacheable ? `${CACHE_VERSION}:${await hashKey(`${locale}|${norm}`)}` : null;

      if (key) {
        const hit = await s.cache.get(key);
        if (hit) {
          return c.json({
            answer: hit.value.text,
            source: 'cache',
            tier: hit.tier,
            provider: hit.value.provider,
            cacheTtlSec: ttl,
            latencyMs: Date.now() - t0,
          });
        }
      }

      try {
        // Only the request that actually calls the LLM writes the cache; coalesced
        // waiters share its result (KV free tier: 1,000 writes/day, so no duplicates).
        const ask = async () => {
          s.m.llmCalls++;
          const out = await s.chain.complete(buildMessages(query, history, locale));
          if (key) background(c, s.cache.set(key, { text: out.text, provider: out.provider }, ttl));
          return out;
        };
        const out = key ? await s.flights.run(key, ask, () => s.m.coalesced++) : await ask();
        return c.json({
          answer: out.text,
          source: 'llm',
          provider: out.provider,
          model: out.model,
          cacheTtlSec: key ? ttl : 0, // tells the phone whether it may keep this answer
          latencyMs: Date.now() - t0,
        });
      } catch (err) {
        if (err instanceof AllProvidersFailed) {
          s.m.upstreamFailures++;
          console.warn('[llm] all providers failed:', err.causes.join(' | '));
          c.header('retry-after', String(err.retryAfterSec));
          return c.json(
            { error: 'upstream_unavailable', message: 'The assistant is busy right now. Try again in a few seconds.', retryAfterSec: err.retryAfterSec },
            503,
          );
        }
        throw err;
      }
    },
  );

  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: 'internal' }, 500);
  });

  return app;
}
