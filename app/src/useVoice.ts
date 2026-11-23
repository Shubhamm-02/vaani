// Speech in and speech out, both on the phone.
// STT: Android SpeechRecognizer. We ask for offline recognition first (private, free,
// works without data). Many phones ship the recogniser without the offline model for
// en-IN / hi-IN, and Android then fails with "language not downloaded" instead of
// falling back by itself, so we retry online once and remember that for the session.
// TTS: the system engine via expo-speech. Neither costs us a rupee per request.
import * as Speech from 'expo-speech';
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from 'expo-speech-recognition';
import { useCallback, useRef, useState } from 'react';
import { Animated, Platform } from 'react-native';
import type { Locale } from './actions';

export type Phase = 'idle' | 'listening' | 'thinking' | 'speaking';

// Locales whose offline model is missing on this phone (per app session).
const onlineOnly = new Set<Locale>();

function startRecognizer(locale: Locale) {
  ExpoSpeechRecognitionModule.start({
    lang: locale,
    interimResults: true,
    continuous: false,
    maxAlternatives: 1,
    contextualStrings: ['Vaani', 'timer', 'alarm', 'WhatsApp', 'YouTube'],
    volumeChangeEventOptions: { enabled: true, intervalMillis: 80 },
    androidIntentOptions: {
      EXTRA_PREFER_OFFLINE: !onlineOnly.has(locale),
      EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS: 1200,
    },
  });
}

export function useVoice(onFinal: (text: string) => void) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [interim, setInterim] = useState('');
  const [hint, setHint] = useState<string | null>(null);
  const [level] = useState(() => new Animated.Value(0));
  const delivered = useRef(false);
  const latest = useRef('');
  const locale = useRef<Locale>('en-IN');
  const retrying = useRef(false);

  useSpeechRecognitionEvent('start', () => {
    delivered.current = false;
    latest.current = '';
    setInterim('');
    setHint(null);
    setPhase('listening');
  });

  useSpeechRecognitionEvent('result', (e) => {
    const text = e.results[0]?.transcript?.trim() ?? '';
    latest.current = text;
    setInterim(text);
    if (e.isFinal && text && !delivered.current) {
      delivered.current = true;
      onFinal(text);
    }
  });

  useSpeechRecognitionEvent('end', () => {
    level.setValue(0);
    if (retrying.current) return; // an online retry is about to start
    // Some recognisers end without flagging a final result; use the last partial.
    if (!delivered.current && latest.current) {
      delivered.current = true;
      onFinal(latest.current);
      return;
    }
    setPhase((p) => (p === 'listening' ? 'idle' : p));
  });

  useSpeechRecognitionEvent('error', (e) => {
    level.setValue(0);
    const loc = locale.current;
    // Offline model not downloaded (or offline not offered): retry online, once.
    if (e.error === 'language-not-supported' && !onlineOnly.has(loc)) {
      onlineOnly.add(loc);
      retrying.current = true;
      setTimeout(() => {
        retrying.current = false;
        startRecognizer(loc);
      }, 250); // let the failed session tear down first
      return;
    }
    setPhase('idle');
    // In a browser (the web demo) the causes and fixes are different from a phone's.
    if (Platform.OS === 'web' && e.error !== 'no-speech' && e.error !== 'speech-timeout' && e.error !== 'aborted') {
      setHint(
        e.error === 'not-allowed' || e.error === 'service-not-allowed'
          ? 'Allow the microphone for this site (the icon in the address bar), then try again. Typing still works.'
          : // Brave and some other browsers ship the speech API but block the service behind it.
            "This browser can't do speech recognition. Use Chrome or Edge, or type with the T button.",
      );
      return;
    }
    if (e.error === 'no-speech' || e.error === 'speech-timeout' || e.error === 'aborted') {
      setHint("Didn't catch that. Tap and try again.");
    } else if (e.error === 'not-allowed') {
      setHint('Microphone permission is off. Enable it in Settings.');
    } else if (e.error === 'language-not-supported') {
      setHint(
        loc === 'hi-IN'
          ? 'Hindi speech is not available on this phone. Update "Speech Recognition & Synthesis by Google" from the Play Store.'
          : 'Speech recognition is not available on this phone. Update "Speech Recognition & Synthesis by Google" from the Play Store.',
      );
    } else if (e.error === 'network') {
      setHint('No internet, and the offline speech pack is not downloaded. Typing still works.');
    } else {
      setHint(e.message || 'Speech recognition failed.');
    }
  });

  useSpeechRecognitionEvent('volumechange', (e) => {
    // value ranges about -2..10; map to 0..1 for the ring.
    level.setValue(Math.max(0, Math.min(1, (e.value + 2) / 12)));
  });

  const listen = useCallback(async (lang: Locale) => {
    Speech.stop();
    if (Platform.OS === 'web' && !('SpeechRecognition' in globalThis || 'webkitSpeechRecognition' in globalThis)) {
      setHint("This browser can't do speech recognition. Use Chrome or Edge, or type with the T button.");
      return;
    }
    const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!perm.granted) {
      setHint('Vaani needs the microphone to hear you.');
      return;
    }
    locale.current = lang;
    startRecognizer(lang);
  }, []);

  const stopListening = useCallback(() => ExpoSpeechRecognitionModule.stop(), []);

  // Each utterance gets an id. expo-speech fires onStopped/onDone asynchronously, so a
  // late callback from an older utterance must not flip a newer request back to idle.
  const utterance = useRef(0);

  const speak = useCallback((text: string, lang: Locale) => {
    Speech.stop();
    const id = ++utterance.current;
    if (!text) {
      setPhase('idle');
      return;
    }
    setPhase('speaking');
    const done = () => {
      if (utterance.current === id) setPhase('idle');
    };
    // Read Devanagari with the Hindi voice even in EN mode (typed Hindi, Hindi answers).
    const language = /[ऀ-ॿ]/.test(text) ? 'hi-IN' : lang;
    Speech.speak(text, { language, rate: 1.02, onDone: done, onStopped: done, onError: done });
  }, []);

  /** Stop talking without changing phase (the caller is about to set its own). */
  const silence = useCallback(() => {
    utterance.current++;
    Speech.stop();
  }, []);

  const hush = useCallback(() => {
    silence();
    setPhase('idle');
  }, [silence]);

  return { phase, setPhase, interim, setInterim, hint, setHint, level, listen, stopListening, speak, silence, hush };
}
