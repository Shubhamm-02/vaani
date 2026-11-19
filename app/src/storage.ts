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
const TURNS_KEY = 'vaani.turns.v1';

// Anonymous, random, per-install. Used only for rate limiting; no account needed.
export async function getDeviceId(): Promise<string> {
  const existing = await AsyncStorage.getItem(DEVICE_KEY);
  if (existing) return existing;
  const id = Crypto.randomUUID();
  await AsyncStorage.setItem(DEVICE_KEY, id);
  return id;
}

export async function loadTurns(): Promise<Turn[]> {
  try {
    return JSON.parse((await AsyncStorage.getItem(TURNS_KEY)) || '[]');
  } catch {
    return [];
  }
}

export function saveTurns(turns: Turn[]) {
  AsyncStorage.setItem(TURNS_KEY, JSON.stringify(turns.slice(-40))).catch(() => {});
}
