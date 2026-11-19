// Two-tier answer cache.
//   L1: in-process LRU. ~0.01 ms, free, but private to one process / Worker isolate.
//   L2: shared across every instance. Workers KV on Cloudflare (a native binding, no
//       extra vendor, hot keys served from the edge PoP), or Upstash Redis over REST
//       when running as Node containers. Either is optional.
// The cache is best-effort: an L2 failure never fails or slows a user request.

export class LRU {
  constructor(max = 20000, now = Date.now) {
    this.max = max;
    this.now = now;
    this.map = new Map();
  }

  get(key) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    // Re-insert to mark as most recently used.
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key, value, ttlMs) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expiresAt: this.now() + ttlMs });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }

  get size() {
    return this.map.size;
  }
}

// ---- L2 stores: get(key) -> string|null, put(key, string, ttlSec) ----------

export class KvStore {
  name = 'kv';
  constructor(namespace) {
    this.ns = namespace;
  }
  get(key) {
    return this.ns.get(key);
  }
  put(key, value, ttlSec) {
    return this.ns.put(key, value, { expirationTtl: Math.max(60, ttlSec) }); // KV minimum is 60 s
  }
}

export class UpstashStore {
  name = 'redis';
  constructor({ url, token }, fetchImpl) {
    this.url = url;
    this.token = token;
    this.fetch = fetchImpl;
  }
  async #cmd(command) {
    const res = await this.fetch(this.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(300),
    });
    if (!res.ok) throw new Error(`upstash ${res.status}`);
    return (await res.json()).result;
  }
  get(key) {
    return this.#cmd(['GET', key]);
  }
  put(key, value, ttlSec) {
    return this.#cmd(['SET', key, value, 'EX', String(ttlSec)]);
  }
}

const L1_TTL_FOR_L2_HITS_MS = 5 * 60_000; // L2 owns the real expiry
const WRITE_PAUSE_MS = 10 * 60_000;

export class TieredCache {
  constructor({ maxEntries, l2 = null, now = Date.now }) {
    this.l1 = new LRU(maxEntries, now);
    this.l2 = l2;
    this.now = now;
    this.writesPausedUntil = 0;
    this.stats = { l1Hits: 0, l2Hits: 0, misses: 0, l2Writes: 0, l2Errors: 0 };
  }

  async get(key) {
    const local = this.l1.get(key);
    if (local) {
      this.stats.l1Hits++;
      return { value: local, tier: 'l1' };
    }
    if (this.l2) {
      try {
        const raw = await this.l2.get(key);
        if (raw) {
          const value = JSON.parse(raw);
          this.l1.set(key, value, L1_TTL_FOR_L2_HITS_MS);
          this.stats.l2Hits++;
          return { value, tier: 'l2' };
        }
      } catch {
        this.stats.l2Errors++;
      }
    }
    this.stats.misses++;
    return null;
  }

  async set(key, value, ttlSec) {
    this.l1.set(key, value, ttlSec * 1000);
    // KV's free plan allows 1,000 writes/day. Once a write fails (quota or outage),
    // stop trying for a while instead of burning a subrequest on every miss.
    if (!this.l2 || this.now() < this.writesPausedUntil) return;
    try {
      await this.l2.put(key, JSON.stringify(value), ttlSec);
      this.stats.l2Writes++;
    } catch {
      this.stats.l2Errors++;
      this.writesPausedUntil = this.now() + WRITE_PAUSE_MS;
    }
  }
}
