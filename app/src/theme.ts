import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SystemUI from 'expo-system-ui';
import { useCallback, useEffect, useState } from 'react';
import { useColorScheme } from 'react-native';

// Warm paper and ink with one vermilion accent. Colour carries meaning only in
// the route tags: where an answer was computed (device, cache, cloud).
const light = {
  bg: '#F3EFE6',
  surface: '#EBE5D8',
  ink: '#1A1714',
  muted: '#6E675D',
  faint: '#A39C90',
  line: '#DCD4C4',
  accent: '#E0482A',
  onAccent: '#FFF8F0',
  device: '#2F7A4D',
  cache: '#2B5C8A',
  cloud: '#E0482A',
  error: '#B3261E',
};

const dark: typeof light = {
  bg: '#141210',
  surface: '#1E1B18',
  ink: '#F1ECE3',
  muted: '#A0988C',
  faint: '#6B645A',
  line: '#2B2723',
  accent: '#FF6A45',
  onAccent: '#1A0E08',
  device: '#5BB585',
  cache: '#6FA3D6',
  cloud: '#FF6A45',
  error: '#F2B8B5',
};

export type Palette = typeof light;

// System by default; the header button cycles System -> Light -> Dark and remembers it.
export type ThemePref = 'system' | 'light' | 'dark';
const THEME_KEY = 'vaani.theme';
const NEXT: Record<ThemePref, ThemePref> = { system: 'light', light: 'dark', dark: 'system' };

export function useTheme() {
  const system = useColorScheme();
  const [pref, setPref] = useState<ThemePref>('system');

  useEffect(() => {
    AsyncStorage.getItem(THEME_KEY)
      .then((v) => {
        if (v === 'light' || v === 'dark' || v === 'system') setPref(v);
      })
      .catch(() => {});
  }, []);

  const cycle = useCallback(() => {
    setPref((p) => {
      const next = NEXT[p];
      AsyncStorage.setItem(THEME_KEY, next).catch(() => {});
      return next;
    });
  }, []);

  const scheme: 'light' | 'dark' = pref === 'system' ? (system === 'dark' ? 'dark' : 'light') : pref;
  const c = scheme === 'dark' ? dark : light;

  // The window behind the app (seen during keyboard and rotation animations) matches too.
  useEffect(() => {
    SystemUI.setBackgroundColorAsync(c.bg).catch(() => {});
  }, [c.bg]);

  return { c, scheme, pref, cycle };
}

export const font = {
  regular: 'IBMPlexSans_400Regular',
  medium: 'IBMPlexSans_500Medium',
  semibold: 'IBMPlexSans_600SemiBold',
  mono: 'IBMPlexMono_400Regular',
  monoMedium: 'IBMPlexMono_500Medium',
};
