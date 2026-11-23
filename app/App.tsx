import { Feather } from '@expo/vector-icons';
import { IBMPlexMono_400Regular, IBMPlexMono_500Medium } from '@expo-google-fonts/ibm-plex-mono';
import { IBMPlexSans_400Regular, IBMPlexSans_500Medium, IBMPlexSans_600SemiBold } from '@expo-google-fonts/ibm-plex-sans';
import { useFonts } from 'expo-font';
import * as Haptics from 'expo-haptics';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  Easing,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ScrollViewInstance,
} from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { runLocal, type Locale } from './src/actions';
import { getCached, putCached } from './src/answerCache';
import { askCloud, CloudError } from './src/api';
import { route } from './src/intents';
import { getDeviceId, HISTORY_MAX, loadHistory, saveClearedAt, saveHistory, type Route, type Turn } from './src/storage';
import { font, useTheme, type Palette, type ThemePref } from './src/theme';
import { useVoice, type Phase } from './src/useVoice';

const SUGGESTIONS: { text: string; route: Route; note: string }[] = [
  { text: 'Set a timer for 10 minutes', route: 'device', note: 'on-device' },
  { text: "What's 18% of 2,450", route: 'device', note: 'on-device' },
  { text: 'Explain UPI in one line', route: 'cloud', note: 'cloud' },
  { text: 'Open YouTube', route: 'device', note: 'on-device' },
];

// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;
const cleanInput = (t: string) => t.normalize('NFKC').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim().slice(0, 500);

const FOLLOW_UP_WINDOW_MS = 2 * 60_000;

export default function App() {
  const [loaded] = useFonts({
    IBMPlexSans_400Regular,
    IBMPlexSans_500Medium,
    IBMPlexSans_600SemiBold,
    IBMPlexMono_400Regular,
    IBMPlexMono_500Medium,
  });
  if (!loaded) return null;
  return (
    <SafeAreaProvider>
      <Screen />
    </SafeAreaProvider>
  );
}

function Screen() {
  const { c, scheme, pref: themePref, cycle: cycleTheme } = useTheme();
  const s = useMemo(() => styles(c), [c]);
  const insets = useSafeAreaInsets();
  const [locale, setLocale] = useState<Locale>('en-IN');
  // Everything ever said (History pane); the screen shows what came after the last clear.
  const [history, setHistory] = useState<Turn[]>([]);
  const [clearedAt, setClearedAt] = useState(0);
  const [showHistory, setShowHistory] = useState(false);
  const turns = useMemo(() => history.filter((t) => t.at > clearedAt).slice(-40), [history, clearedAt]);
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState('');
  // Resolved once; awaited by cloud calls so an early question never goes out without it.
  const [deviceId] = useState(() => getDeviceId());
  const historyLoaded = useRef(false);
  const scroll = useRef<ScrollViewInstance>(null);
  const turnsRef = useRef<Turn[]>([]);
  useEffect(() => {
    turnsRef.current = turns;
  }, [turns]);

  useEffect(() => {
    // Merge rather than replace: a command run before storage answers must not be lost,
    // and must not overwrite the stored history either (push skips saving until now).
    // Idempotent: dev builds run mount effects twice, so merge once and de-duplicate by id
    // (which also repairs any duplicates already saved).
    let cancelled = false;
    loadHistory().then(({ turns: stored, clearedAt: storedClear }) => {
      if (cancelled || historyLoaded.current) return;
      historyLoaded.current = true;
      setClearedAt((prev) => Math.max(prev, storedClear));
      setHistory((prev) => {
        const seen = new Set<string>();
        const merged = [...stored, ...prev].filter((t) => !seen.has(t.id) && (seen.add(t.id), true)).slice(-HISTORY_MAX);
        if (merged.length !== stored.length || prev.length) saveHistory(merged);
        return merged;
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const push = useCallback((t: Turn) => {
    setHistory((prev) => {
      const next = [...prev, t].slice(-HISTORY_MAX);
      if (historyLoaded.current) saveHistory(next);
      return next;
    });
  }, []);

  // A fresh screen; history keeps every turn.
  const clearScreen = useCallback(() => {
    const at = Date.now();
    setClearedAt(at);
    saveClearedAt(at);
  }, []);

  const clearHistory = useCallback(() => {
    const title = locale === 'hi-IN' ? 'इतिहास मिटाएँ?' : 'Clear history?';
    const body = locale === 'hi-IN' ? 'इस फ़ोन से सारी पिछली बातचीत हट जाएगी।' : 'This removes every past conversation from this phone.';
    const wipe = () => {
      setHistory([]);
      saveHistory([]);
    };
    // react-native-web's Alert is a no-op, so the browser build uses the browser's dialog.
    if (Platform.OS === 'web') {
      if (globalThis.confirm?.(`${title}\n\n${body}`)) wipe();
      return;
    }
    Alert.alert(
      title,
      body,
      [
        { text: locale === 'hi-IN' ? 'रद्द करें' : 'Cancel', style: 'cancel' },
        {
          text: locale === 'hi-IN' ? 'मिटाएँ' : 'Clear',
          style: 'destructive',
          onPress: wipe,
        },
      ],
    );
  }, [locale]);

  // `handle` needs voice.speak and voice needs `handle`; break the cycle with a ref.
  const handleRef = useRef<(text: string) => void>(() => {});
  const voice = useVoice((text) => handleRef.current(text));

  const handle = useCallback(
    async (input: string) => {
      // Input guardrail on the phone too: invisible/control characters stripped and length
      // capped before anything is routed, so on-device commands get the same hygiene as the
      // server (which repeats these checks; never trust the client).
      const said = cleanInput(input);
      if (!said) return;
      const intent = route(said);
      voice.setInterim('');
      voice.silence(); // a new command interrupts whatever is still being spoken
      voice.setHint(null); // and clears a stale "didn't catch that"

      if (intent.kind === 'stop') return voice.hush();
      if (intent.kind === 'clear') {
        clearScreen();
        return voice.speak(locale === 'hi-IN' ? 'साफ़ कर दिया।' : 'Cleared.', locale);
      }

      const base = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, at: Date.now(), said };
      voice.setPhase('thinking');

      if (intent.kind === 'cloud') {
        // Tier 0: this phone already has the answer. Only server-approved
        // (stand-alone, evergreen) answers are ever stored, so follow-ups never hit.
        const t0 = Date.now();
        const local = await getCached(said, locale);
        if (local) {
          push({ ...base, reply: local.answer, route: 'cache', detail: 'phone', ms: Date.now() - t0 });
          voice.speak(local.answer, locale);
          return;
        }
        // Send recent turns; the server keeps them only if this is a real follow-up.
        const recent = turnsRef.current.filter((t) => (t.route === 'cloud' || t.route === 'cache') && Date.now() - t.at < FOLLOW_UP_WINDOW_MS).slice(-2);
        const history = recent.flatMap((t) => [
          { role: 'user' as const, content: t.said },
          { role: 'assistant' as const, content: t.reply },
        ]);
        try {
          const r = await askCloud({ query: said, locale, deviceId: await deviceId, history });
          putCached(said, locale, r.answer, r.cacheTtlSec, r.provider, r.cacheVersion);
          const fromCache = r.source === 'cache';
          push({ ...base, reply: r.answer, route: fromCache ? 'cache' : 'cloud', detail: fromCache ? 'edge' : (r.provider ?? 'llm'), ms: r.roundTripMs });
          voice.speak(r.answer, locale);
        } catch (e) {
          const msg = e instanceof CloudError ? e.spoken : 'Something went wrong.';
          push({ ...base, reply: msg, route: 'error', detail: 'cloud' });
          voice.speak(msg, locale);
        }
        return;
      }

      const t0 = Date.now();
      try {
        const r = await runLocal(intent, locale);
        push({ ...base, reply: r.reply, route: 'device', detail: r.tag, ms: Date.now() - t0 });
        voice.speak(r.reply, locale);
      } catch {
        const msg = "This phone couldn't do that.";
        push({ ...base, reply: msg, route: 'error', detail: intent.kind });
        voice.speak(msg, locale);
      }
    },
    [locale, push, voice, clearScreen],
  );
  useEffect(() => {
    handleRef.current = handle;
  }, [handle]);

  const onMic = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    if (voice.phase === 'idle') voice.listen(locale);
    else if (voice.phase === 'listening') voice.stopListening();
    else if (voice.phase === 'speaking') voice.hush();
  };

  const submitDraft = () => {
    const text = draft.trim();
    if (!text || voice.phase === 'thinking' || voice.phase === 'listening') return;
    setDraft('');
    handle(text);
  };

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <KeyboardAvoidingView style={s.column} behavior="padding">
        <View style={s.header}>
          <Text style={s.wordmark}>vaani</Text>
          <View style={s.headerRight}>
            <Pressable
              onPress={() => setShowHistory(true)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="History"
              style={({ pressed }) => [s.headerBtn, pressed && { opacity: 0.6 }]}
            >
              <Feather name="clock" size={15} color={c.ink} />
            </Pressable>
            <ThemeButton pref={themePref} onPress={cycleTheme} c={c} s={s} />
            <LocaleToggle value={locale} onChange={setLocale} c={c} s={s} />
          </View>
        </View>

        <ScrollView
          ref={scroll}
          style={s.flex}
          contentContainerStyle={s.feed}
          onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}
          keyboardShouldPersistTaps="handled"
        >
          {turns.length === 0 ? (
            <Empty s={s} c={c} onPick={(t) => voice.phase !== 'thinking' && handle(t)} />
          ) : (
            turns.map((t, i) => <TurnView key={t.id} t={t} s={s} c={c} last={i === turns.length - 1} />)
          )}
        </ScrollView>

        <View style={[s.dock, { paddingBottom: insets.bottom + 16 }]}>
          {typing ? (
            <View style={s.inputRow}>
              <TextInput
                value={draft}
                onChangeText={setDraft}
                onSubmitEditing={submitDraft}
                placeholder="Type a command"
                placeholderTextColor={c.faint}
                style={s.input}
                autoFocus
                maxLength={500}
                returnKeyType="send"
              />
              <Pressable onPress={submitDraft} hitSlop={8} accessibilityLabel="Send" style={s.send}>
                <Feather name="arrow-up" size={18} color={c.onAccent} />
              </Pressable>
            </View>
          ) : (
            <Text style={[s.live, voice.interim ? s.liveActive : null]} numberOfLines={2}>
              {statusLine(voice.phase, voice.interim, voice.hint, locale)}
            </Text>
          )}

          <View style={s.controls}>
            <IconButton
              name={typing ? 'mic' : 'type'}
              label={typing ? 'Use voice' : 'Type instead'}
              onPress={() => setTyping((v) => !v)}
              c={c}
              s={s}
            />
            <MicButton phase={voice.phase} level={voice.level} onPress={onMic} c={c} />
            <IconButton
              name="rotate-ccw"
              label="Clear conversation"
              onPress={clearScreen}
              disabled={turns.length === 0}
              c={c}
              s={s}
            />
          </View>
        </View>
      </KeyboardAvoidingView>

      <HistoryPane
        visible={showHistory}
        history={history}
        locale={locale}
        onClose={() => setShowHistory(false)}
        onAskAgain={(said) => {
          setShowHistory(false);
          handle(said);
        }}
        onClearHistory={clearHistory}
        c={c}
        s={s}
      />
    </View>
  );
}

function statusLine(phase: Phase, interim: string, hint: string | null, locale: Locale) {
  if (phase === 'listening') return interim || (locale === 'hi-IN' ? 'सुन रही हूँ…' : 'Listening…');
  if (phase === 'thinking') return interim || 'Working on it…';
  if (phase === 'speaking') return 'Tap to stop';
  return hint || (locale === 'hi-IN' ? 'बोलने के लिए टैप करें' : 'Tap to talk');
}

// ---- pieces ---------------------------------------------------------------

type SP = { s: ReturnType<typeof styles>; c: Palette };

function dayLabel(at: number, locale: Locale) {
  const d = new Date(at);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return locale === 'hi-IN' ? 'आज' : 'TODAY';
  if (same(d, yesterday)) return locale === 'hi-IN' ? 'कल' : 'YESTERDAY';
  return d.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' }).toUpperCase();
}

// Everything asked on this phone, newest first, grouped by day. An overlay, so the app
// stays a single screen. Tap a row to ask it again.
function HistoryPane({
  visible,
  history,
  locale,
  onClose,
  onAskAgain,
  onClearHistory,
  s,
  c,
}: SP & {
  visible: boolean;
  history: Turn[];
  locale: Locale;
  onClose: () => void;
  onAskAgain: (said: string) => void;
  onClearHistory: () => void;
}) {
  const insets = useSafeAreaInsets();
  const sections = useMemo(() => {
    const out: { title: string; data: Turn[] }[] = [];
    for (const t of [...history].reverse()) {
      const title = dayLabel(t.at, locale);
      if (out.at(-1)?.title !== title) out.push({ title, data: [] });
      out.at(-1)!.data.push(t);
    }
    return out;
  }, [history, locale]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={s.root}>
        <View style={[s.sheet, { paddingTop: insets.top }]}>
          <View style={s.sheetHeader}>
            <Text style={s.sheetTitle}>{locale === 'hi-IN' ? 'इतिहास' : 'History'}</Text>
            <Pressable onPress={onClose} hitSlop={8} accessibilityRole="button" accessibilityLabel="Close history" style={s.headerBtn}>
              <Feather name="x" size={16} color={c.ink} />
            </Pressable>
          </View>
          <SectionList
            sections={sections}
            keyExtractor={(t) => t.id}
            contentContainerStyle={s.sheetList}
            stickySectionHeadersEnabled
            renderSectionHeader={({ section }) => <Text style={s.dayLabel}>{section.title}</Text>}
            ListEmptyComponent={<Text style={s.sheetEmpty}>{locale === 'hi-IN' ? 'अभी कोई इतिहास नहीं।' : 'Nothing here yet.'}</Text>}
            renderItem={({ item: t }) => (
              <Pressable
                onPress={() => onAskAgain(t.said)}
                accessibilityRole="button"
                accessibilityHint="Asks this again"
                style={({ pressed }) => [s.historyRow, pressed && { opacity: 0.6 }]}
              >
                <Text style={s.historySaid} numberOfLines={2}>
                  {t.said}
                </Text>
                <Text style={s.historyReply} numberOfLines={2}>
                  {t.reply}
                </Text>
                <View style={[s.metaRow, { marginTop: 0 }]}>
                  <RouteTag route={t.route} label={routeLabel(t)} c={c} s={s} />
                  <Text style={s.time}>{new Date(t.at).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}</Text>
                </View>
              </Pressable>
            )}
          />
          {history.length > 0 && (
            <View style={[s.sheetFooter, { paddingBottom: insets.bottom + 12 }]}>
              <Pressable onPress={onClearHistory} hitSlop={8} accessibilityRole="button">
                <Text style={s.clearHistory}>{locale === 'hi-IN' ? 'इतिहास मिटाएँ' : 'Clear history'}</Text>
              </Pressable>
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

const THEME_ICON: Record<ThemePref, keyof typeof Feather.glyphMap> = { system: 'smartphone', light: 'sun', dark: 'moon' };
const THEME_NAME: Record<ThemePref, string> = { system: 'System', light: 'Light', dark: 'Dark' };

function ThemeButton({ pref, onPress, s, c }: SP & { pref: ThemePref; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={`Theme: ${THEME_NAME[pref]}. Tap to change.`}
      style={({ pressed }) => [s.headerBtn, pressed && { opacity: 0.6 }]}
    >
      <Feather name={THEME_ICON[pref]} size={15} color={c.ink} />
    </Pressable>
  );
}

function LocaleToggle({ value, onChange, s }: SP & { value: Locale; onChange: (l: Locale) => void }) {
  const opts: [Locale, string][] = [
    ['en-IN', 'EN'],
    ['hi-IN', 'हिं'],
  ];
  return (
    <View style={s.toggle} accessibilityRole="radiogroup">
      {opts.map(([l, label]) => {
        const on = value === l;
        return (
          <Pressable key={l} onPress={() => onChange(l)} style={[s.toggleItem, on && s.toggleOn]} accessibilityRole="radio" accessibilityState={{ selected: on }}>
            <Text style={[s.toggleText, on && s.toggleTextOn]}>{label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function Empty({ s, c, onPick }: SP & { onPick: (t: string) => void }) {
  return (
    <View style={s.empty}>
      <Text style={s.hero}>Ask a question,{'\n'}or tell your phone{'\n'}what to do.</Text>
      <Text style={s.kicker}>TRY SAYING</Text>
      {SUGGESTIONS.map((g) => (
        <Pressable key={g.text} onPress={() => onPick(g.text)} style={({ pressed }) => [s.suggestion, pressed && { opacity: 0.6 }]}>
          <Text style={s.suggestionText}>{g.text}</Text>
          <RouteTag route={g.route} label={g.note} c={c} s={s} />
        </Pressable>
      ))}
      <Text style={s.footnote}>
        Timers, alarms, maths, calls and app launches run on the phone and work offline. Questions go to the cloud once, then
        answers are cached on the phone and at the edge.
      </Text>
    </View>
  );
}

function RouteTag({ route: r, label, c, s }: SP & { route: Route; label: string }) {
  const color = { device: c.device, cache: c.cache, cloud: c.cloud, error: c.error }[r];
  return (
    <View style={s.tag}>
      <View style={[s.tagDot, { backgroundColor: color }]} />
      <Text style={s.tagText}>{label.toUpperCase()}</Text>
    </View>
  );
}

// Where an answer was computed, as shown under it: "on-device · alarm", "cache · edge"…
function routeLabel(t: Turn) {
  if (t.route === 'device') return `on-device · ${t.detail}`;
  if (t.route === 'cache') return `cache · ${t.detail === 'phone' ? 'phone' : 'edge'}`;
  if (t.route === 'cloud') return `cloud · ${t.detail}`;
  return 'not answered';
}

function TurnView({ t, s, c, last }: SP & { t: Turn; last: boolean }) {
  const [fade] = useState(() => new Animated.Value(last ? 0 : 1));
  useEffect(() => {
    Animated.timing(fade, { toValue: 1, duration: 220, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
  }, [fade]);
  const where = routeLabel(t);
  const time = new Date(t.at).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  return (
    <Animated.View
      style={[s.turn, { opacity: fade, transform: [{ translateY: fade.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }] }]}
    >
      <Text style={s.said}>{t.said}</Text>
      <Text style={[s.reply, t.route === 'error' && { color: c.muted }]}>{t.reply}</Text>
      <View style={s.metaRow}>
        <RouteTag route={t.route} label={t.ms !== undefined ? `${where} · ${t.ms} ms` : where} c={c} s={s} />
        <Text style={s.time}>{time}</Text>
      </View>
    </Animated.View>
  );
}

function IconButton({ name, label, onPress, disabled, s, c }: SP & { name: keyof typeof Feather.glyphMap; label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      hitSlop={8}
      style={({ pressed }) => [s.iconBtn, { opacity: disabled ? 0.35 : pressed ? 0.6 : 1 }]}
    >
      <Feather name={name} size={20} color={c.ink} />
    </Pressable>
  );
}

function MicButton({ phase, level, onPress, c }: { phase: Phase; level: Animated.Value; onPress: () => void; c: Palette }) {
  const [spin] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (phase !== 'thinking') return;
    spin.setValue(0);
    const loop = Animated.loop(Animated.timing(spin, { toValue: 1, duration: 900, easing: Easing.linear, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [phase, spin]);

  const icon: keyof typeof Feather.glyphMap = phase === 'listening' ? 'square' : phase === 'speaking' ? 'volume-2' : 'mic';
  const label = { idle: 'Start listening', listening: 'Stop listening', thinking: 'Working', speaking: 'Stop speaking' }[phase];
  const SIZE = 76;

  return (
    <Pressable onPress={onPress} disabled={phase === 'thinking'} accessibilityRole="button" accessibilityLabel={label} style={{ width: SIZE + 40, height: SIZE + 40, alignItems: 'center', justifyContent: 'center' }}>
      {phase === 'listening' && (
        <Animated.View
          pointerEvents="none"
          style={{
            position: 'absolute',
            width: SIZE,
            height: SIZE,
            borderRadius: SIZE / 2,
            backgroundColor: c.accent,
            opacity: 0.18,
            transform: [{ scale: level.interpolate({ inputRange: [0, 1], outputRange: [1.08, 1.5] }) }],
          }}
        />
      )}
      {phase === 'thinking' && (
        <Animated.View
          pointerEvents="none"
          style={{
            position: 'absolute',
            width: SIZE + 14,
            height: SIZE + 14,
            borderRadius: (SIZE + 14) / 2,
            borderWidth: 2,
            borderColor: 'transparent',
            borderTopColor: c.accent,
            transform: [{ rotate: spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) }],
          }}
        />
      )}
      <View
        style={{
          width: SIZE,
          height: SIZE,
          borderRadius: SIZE / 2,
          backgroundColor: phase === 'thinking' ? c.surface : c.accent,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Feather name={icon} size={phase === 'listening' ? 22 : 28} color={phase === 'thinking' ? c.muted : c.onAccent} />
      </View>
    </Pressable>
  );
}

// ---- styles ---------------------------------------------------------------

const styles = (c: Palette) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: c.bg },
    flex: { flex: 1 },
    // Phone-width column. On a phone this is the whole screen; in a desktop browser
    // (the web demo) it stays centred instead of stretching across the window.
    column: { flex: 1, width: '100%', maxWidth: Platform.OS === 'web' ? 520 : undefined, alignSelf: 'center' },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 24,
      paddingTop: 12,
      paddingBottom: 12,
    },
    wordmark: { fontFamily: font.semibold, fontSize: 22, color: c.ink, letterSpacing: -0.6 },
    headerRight: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    headerBtn: { width: 35, height: 35, borderRadius: 18, borderWidth: 1, borderColor: c.line, alignItems: 'center', justifyContent: 'center' },

    sheet: { flex: 1, backgroundColor: c.bg, width: '100%', maxWidth: Platform.OS === 'web' ? 520 : undefined, alignSelf: 'center' },
    sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 24, paddingTop: 16, paddingBottom: 12 },
    sheetTitle: { fontFamily: font.semibold, fontSize: 22, color: c.ink, letterSpacing: -0.6 },
    sheetList: { paddingHorizontal: 24, paddingBottom: 24 },
    dayLabel: { fontFamily: font.monoMedium, fontSize: 11, letterSpacing: 1.2, color: c.faint, paddingTop: 20, paddingBottom: 4, backgroundColor: c.bg },
    historyRow: { paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.line },
    historySaid: { fontFamily: font.medium, fontSize: 16, color: c.ink, marginBottom: 4 },
    historyReply: { fontFamily: font.regular, fontSize: 14, lineHeight: 20, color: c.muted, marginBottom: 8 },
    sheetFooter: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line, paddingHorizontal: 24, paddingTop: 12, alignItems: 'center' },
    clearHistory: { fontFamily: font.medium, fontSize: 14, color: c.error, paddingVertical: 10 },
    sheetEmpty: { fontFamily: font.regular, fontSize: 15, color: c.muted, textAlign: 'center', marginTop: 80 },
    toggle: { flexDirection: 'row', borderWidth: 1, borderColor: c.line, borderRadius: 999, padding: 3 },
    toggleItem: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 999 },
    toggleOn: { backgroundColor: c.ink },
    toggleText: { fontFamily: font.medium, fontSize: 13, color: c.muted },
    toggleTextOn: { color: c.bg },

    feed: { paddingHorizontal: 24, paddingBottom: 24, flexGrow: 1 },
    empty: { flex: 1, justifyContent: 'flex-end', paddingTop: 24 },
    hero: { fontFamily: font.medium, fontSize: 32, lineHeight: 38, letterSpacing: -0.9, color: c.ink, marginBottom: 36 },
    kicker: { fontFamily: font.monoMedium, fontSize: 11, letterSpacing: 1.2, color: c.faint, marginBottom: 6 },
    suggestion: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 15,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.line,
    },
    suggestionText: { fontFamily: font.regular, fontSize: 16, color: c.ink, flexShrink: 1, marginRight: 12 },
    footnote: { fontFamily: font.regular, fontSize: 13, lineHeight: 19, color: c.muted, marginTop: 18 },

    turn: { paddingVertical: 20, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.line },
    said: { fontFamily: font.regular, fontSize: 15, color: c.muted, marginBottom: 8 },
    reply: { fontFamily: font.regular, fontSize: 21, lineHeight: 29, letterSpacing: -0.3, color: c.ink },
    metaRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 },
    tag: { flexDirection: 'row', alignItems: 'center' },
    tagDot: { width: 6, height: 6, borderRadius: 1, marginRight: 7 },
    tagText: { fontFamily: font.mono, fontSize: 11, letterSpacing: 0.6, color: c.muted },
    time: { fontFamily: font.mono, fontSize: 11, color: c.faint },

    dock: { paddingHorizontal: 24, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line, backgroundColor: c.bg },
    live: { fontFamily: font.regular, fontSize: 15, color: c.muted, textAlign: 'center', minHeight: 44, textAlignVertical: 'center' },
    liveActive: { color: c.ink, fontSize: 17 },
    inputRow: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: c.surface,
      borderRadius: 14,
      paddingLeft: 16,
      paddingRight: 6,
      minHeight: 48,
    },
    input: { flex: 1, fontFamily: font.regular, fontSize: 16, color: c.ink, paddingVertical: 10 },
    send: { width: 36, height: 36, borderRadius: 10, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center' },
    controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 },
    iconBtn: { width: 48, height: 48, borderRadius: 24, borderWidth: 1, borderColor: c.line, alignItems: 'center', justifyContent: 'center' },
  });
