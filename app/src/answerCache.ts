// Tier 0 of the answer cache: the phone itself. A question this phone has asked
// before is answered in ~1 ms, works offline, and never touches the network or an
// LLM quota. The server decides what is safe to keep (it returns cacheTtlSec > 0
// only for stand-alone, evergreen questions), so this file holds no policy.
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Locale } from './actions';
import { cacheKey } from './cacheKey';

const STORE_KEY = 'vaani.answers.v1';
const MAX_ENTRIES = 300; // ~300 short answers ≈ 60 KB of AsyncStorage

type Entry = { a: string; p?: string; exp: number };
let mem: Map<string, Entry> | null = null;
// The server's cache version. When it changes (new prompt or normaliser), every answer
// kept on the phone is from the old version and is dropped.
const VERSION_KEY = 'vaani.answers.version';
let version: string | null | undefined;

async function load(): Promise<Map<string, Entry>> {
  if (mem) return mem;
  try {
    const raw = await AsyncStorage.getItem(STORE_KEY);
    mem = new Map(raw ? (JSON.parse(raw) as [string, Entry][]) : []);
  } catch {
    mem = new Map();
  }
  return mem;
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function persist(m: Map<string, Entry>) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    AsyncStorage.setItem(STORE_KEY, JSON.stringify([...m])).catch(() => {});
  }, 500);
}

export async function getCached(query: string, locale: Locale): Promise<{ answer: string; provider?: string } | null> {
  const m = await load();
  const k = cacheKey(query, locale);
  const e = m.get(k);
  if (!e) return null;
  if (e.exp <= Date.now()) {
    m.delete(k);
    persist(m);
    return null;
  }
  m.delete(k); // mark as most recently used
  m.set(k, e);
  return { answer: e.a, provider: e.p };
}

export async function putCached(query: string, locale: Locale, answer: string, ttlSec: number, provider?: string, serverVersion?: string) {
  const m = await load();
  if (serverVersion) {
    if (version === undefined) version = await AsyncStorage.getItem(VERSION_KEY).catch(() => null);
    if (version !== serverVersion) {
      m.clear();
      version = serverVersion;
      AsyncStorage.setItem(VERSION_KEY, serverVersion).catch(() => {});
      persist(m);
    }
  }
  if (!(ttlSec > 0) || !answer) return;
  const k = cacheKey(query, locale);
  m.delete(k);
  m.set(k, { a: answer, p: provider, exp: Date.now() + ttlSec * 1000 });
  while (m.size > MAX_ENTRIES) m.delete(m.keys().next().value as string);
  persist(m);
}
