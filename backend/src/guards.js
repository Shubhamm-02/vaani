// Small, dependency-free building blocks: rate limiter and request coalescing.

// Token bucket per key. Local to one instance on purpose: a shared Redis
// counter would add a network hop to every request. At fleet scale the coarse
// global limit lives at the edge (WAF / gateway); this one stops a single
// device from hammering one instance.
export class TokenBucket {
  constructor({ perMinute, maxKeys = 100_000, now = Date.now }) {
    this.capacity = perMinute;
    this.refillPerMs = perMinute / 60_000;
    this.maxKeys = maxKeys;
    this.now = now;
    this.buckets = new Map();
  }

  take(key) {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.#evict();
      b = { tokens: this.capacity, at: t };
      this.buckets.set(key, b);
    }
    b.tokens = Math.min(this.capacity, b.tokens + (t - b.at) * this.refillPerMs);
    b.at = t;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true };
    }
    return { ok: false, retryAfterSec: Math.ceil((1 - b.tokens) / this.refillPerMs / 1000) };
  }

  #evict() {
    // Drop the oldest tenth. Map preserves insertion order, which is a fair proxy for age.
    let n = Math.ceil(this.maxKeys / 10);
    for (const k of this.buckets.keys()) {
      this.buckets.delete(k);
      if (--n === 0) break;
    }
  }
}

// If 500 people ask "what is UPI" in the same second and the cache is cold,
// only one LLM call goes out; the other 499 await the same promise.
export class SingleFlight {
  constructor() {
    this.inflight = new Map();
  }

  run(key, fn, onShared) {
    const existing = this.inflight.get(key);
    if (existing) {
      onShared?.();
      return existing;
    }
    const p = Promise.resolve()
      .then(fn)
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }
}
