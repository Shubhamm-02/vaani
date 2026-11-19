// Speech in and speech out, both on the phone.
// STT: Android SpeechRecognizer with EXTRA_PREFER_OFFLINE, so it runs on-device
// whenever the language pack is installed and silently falls back otherwise.
// TTS: the system engine via expo-speech. Neither costs us a rupee per request.
import * as Speech from 'expo-speech';
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from 'expo-speech-recognition';
import { useCallback, useRef, useState } from 'react';
import { Animated } from 'react-native';
import type { Locale } from './actions';

export type Phase = 'idle' | 'listening' | 'thinking' | 'speaking';

export function useVoice(onFinal: (text: string) => void) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [interim, setInterim] = useState('');
  const [hint, setHint] = useState<string | null>(null);
  const [level] = useState(() => new Animated.Value(0));
  const delivered = useRef(false);
  const latest = useRef('');

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
    setPhase('idle');
    if (e.error === 'no-speech' || e.error === 'speech-timeout' || e.error === 'aborted') {
      setHint("Didn't catch that. Tap and try again.");
    } else if (e.error === 'not-allowed') {
      setHint('Microphone permission is off. Enable it in Settings.');
    } else if (e.error === 'language-not-supported') {
      setHint('This language pack is not installed on the phone.');
    } else if (e.error === 'network') {
      setHint('Speech needs a network for this language. Download the offline pack in Google settings.');
    } else {
      setHint(e.message || 'Speech recognition failed.');
    }
  });

  useSpeechRecognitionEvent('volumechange', (e) => {
    // value ranges about -2..10; map to 0..1 for the ring.
    level.setValue(Math.max(0, Math.min(1, (e.value + 2) / 12)));
  });

  const listen = useCallback(async (locale: Locale) => {
    Speech.stop();
    const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!perm.granted) {
      setHint('Vaani needs the microphone to hear you.');
      return;
    }
    ExpoSpeechRecognitionModule.start({
      lang: locale,
      interimResults: true,
      continuous: false,
      maxAlternatives: 1,
      contextualStrings: ['Vaani', 'timer', 'alarm', 'WhatsApp', 'YouTube'],
      volumeChangeEventOptions: { enabled: true, intervalMillis: 80 },
      androidIntentOptions: {
        EXTRA_PREFER_OFFLINE: true,
        EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS: 1200,
      },
    });
  }, []);

  const stopListening = useCallback(() => ExpoSpeechRecognitionModule.stop(), []);

  const speak = useCallback((text: string, locale: Locale) => {
    Speech.stop();
    if (!text) {
      setPhase('idle');
      return;
    }
    setPhase('speaking');
    const done = () => setPhase('idle');
    Speech.speak(text, { language: locale, rate: 1.02, onDone: done, onStopped: done, onError: done });
  }, []);

  const hush = useCallback(() => {
    Speech.stop();
    setPhase('idle');
  }, []);

  return { phase, setPhase, interim, setInterim, hint, setHint, level, listen, stopListening, speak, hush };
}
