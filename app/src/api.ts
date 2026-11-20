import type { Locale } from './actions';

// Android emulator reaches the host machine at 10.0.2.2. For a real phone or a
// release build, set EXPO_PUBLIC_API_URL to the deployed HTTPS backend.
export const API_URL = (process.env.EXPO_PUBLIC_API_URL || 'http://10.0.2.2:8787').replace(/\/$/, '');
// Optional shared token. It ships inside the APK, so it is a speed bump against casual
// scripts, not a secret; real abuse control is the server's rate limiting.
const APP_TOKEN = process.env.EXPO_PUBLIC_APP_TOKEN;
// The server gives up on providers after 10 s; wait a little longer than that.
const TIMEOUT_MS = 15_000;

export type CloudAnswer = {
  answer: string;
  source: 'cache' | 'llm';
  tier?: 'l1' | 'l2'; // which server cache tier answered
  provider?: string;
  cacheTtlSec: number; // > 0 means the phone may keep this answer
  cacheVersion?: string; // changes when server answers change shape (prompt, normaliser)
  latencyMs: number; // server-side time
  roundTripMs: number; // what the user felt
};

export class CloudError extends Error {
  constructor(public spoken: string) {
    super(spoken);
  }
}

export async function askCloud(args: {
  query: string;
  locale: Locale;
  deviceId: string;
  history: { role: 'user' | 'assistant'; content: string }[];
}): Promise<CloudAnswer> {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${API_URL}/v1/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-device-id': args.deviceId, ...(APP_TOKEN ? { 'x-app-token': APP_TOKEN } : {}) },
      body: JSON.stringify({ query: args.query, locale: args.locale, history: args.history }),
      signal: ctrl.signal,
    });
  } catch {
    if (ctrl.signal.aborted) throw new CloudError('That took too long. Please try again.');
    throw new CloudError("I can't reach the server. Timers, alarms, maths and app commands still work offline.");
  } finally {
    clearTimeout(timer);
  }

  const data = await res.json().catch(() => ({}));
  if (res.status === 429) throw new CloudError(`You're going a bit fast. Try again in ${data.retryAfterSec ?? 'a few'} seconds.`);
  if (res.status === 503) throw new CloudError(data.message || 'The assistant is busy. Try again shortly.');
  if (!res.ok || typeof data.answer !== 'string') throw new CloudError('Something went wrong on the server.');
  return { ...data, cacheTtlSec: Number(data.cacheTtlSec) || 0, roundTripMs: Date.now() - started };
}
