import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';

export type Route = 'device' | 'cache' | 'cloud' | 'error';

export type Turn = {
  id: string;
  at: number;
  said: string;
  reply: string;
  route: Route;
  detail: string; // e.g. "timer", "groq", "offline"
  ms?: number;
};

const DEVICE_KEY = 'vaani.deviceId';
const HISTORY_KEY = 'vaani.history.v1';
const CLEARED_KEY = 'vaani.clearedAt';
const LEGACY_TURNS_KEY = 'vaani.turns.v1';
export const HISTORY_MAX = 200;

// Anonymous, random, per-install. Used only for rate limiting; no account needed.
export async function getDeviceId(): Promise<string> {
  const existing = await AsyncStorage.getItem(DEVICE_KEY);
  if (existing) return existing;
  const id = Crypto.randomUUID();
  await AsyncStorage.setItem(DEVICE_KEY, id);
  return id;
}

// One list holds everything (the History pane). The conversation on screen is the part
// after `clearedAt`, so "clear" gives a fresh screen without deleting history.
export async function loadHistory(): Promise<{ turns: Turn[]; clearedAt: number }> {
  try {
    const [[, h], [, c], [, legacy]] = await AsyncStorage.multiGet([HISTORY_KEY, CLEARED_KEY, LEGACY_TURNS_KEY]);
    const turns: Turn[] = JSON.parse(h ?? legacy ?? '[]'); // first run after upgrade: migrate
    return { turns: Array.isArray(turns) ? turns : [], clearedAt: Number(c) || 0 };
  } catch {
    return { turns: [], clearedAt: 0 };
  }
}

export function saveHistory(turns: Turn[]) {
  AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(turns.slice(-HISTORY_MAX))).catch(() => {});
}

export function saveClearedAt(at: number) {
  AsyncStorage.setItem(CLEARED_KEY, String(at)).catch(() => {});
}
