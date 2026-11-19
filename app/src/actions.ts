// Executes on-device intents with Android system intents. No network, no backend.
import * as Battery from 'expo-battery';
import * as IntentLauncher from 'expo-intent-launcher';
import { Linking } from 'react-native';
import type { AppKey, Intent } from './intents';

export type Locale = 'en-IN' | 'hi-IN';
const hi = (locale: Locale, en: string, hindi: string) => (locale === 'hi-IN' ? hindi : en);

// startActivityAsync resolves only when the user returns from the other app,
// so we wait briefly for a quick failure (no app can handle it) and otherwise move on.
async function launch(action: string, params: IntentLauncher.IntentLauncherParams = {}) {
  const attempt = IntentLauncher.startActivityAsync(action, params);
  await Promise.race([attempt, new Promise((r) => setTimeout(r, 1200))]);
}

async function openUrl(primary: string, fallback?: string) {
  try {
    await Linking.openURL(primary);
  } catch (e) {
    if (!fallback) throw e;
    await Linking.openURL(fallback);
  }
}

function spokenDuration(seconds: number, locale: Locale) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts: string[] = [];
  if (h) parts.push(hi(locale, `${h} hour${h > 1 ? 's' : ''}`, `${h} घंटे`));
  if (m) parts.push(hi(locale, `${m} minute${m > 1 ? 's' : ''}`, `${m} मिनट`));
  if (s) parts.push(hi(locale, `${s} second${s > 1 ? 's' : ''}`, `${s} सेकंड`));
  return parts.join(' ');
}

const APP_TARGETS: Record<AppKey, () => Promise<void>> = {
  youtube: () => openUrl('vnd.youtube://', 'https://www.youtube.com'),
  maps: () => openUrl('geo:0,0', 'https://maps.google.com'),
  camera: () => launch('android.media.action.STILL_IMAGE_CAMERA'),
  settings: () => launch(IntentLauncher.ActivityAction.SETTINGS),
  whatsapp: () => openUrl('whatsapp://send', 'https://wa.me'),
  gmail: () => openUrl('googlegmail://', 'mailto:'),
  browser: () => openUrl('https://www.google.com'),
  playstore: () => openUrl('market://search?q=', 'https://play.google.com/store'),
  calendar: () => launch('android.intent.action.VIEW', { data: 'content://com.android.calendar/time/' }),
  clock: () => launch('android.intent.action.SHOW_ALARMS'),
};

export type LocalResult = { reply: string; tag: string };

export async function runLocal(intent: Exclude<Intent, { kind: 'cloud' | 'stop' | 'clear' }>, locale: Locale): Promise<LocalResult> {
  switch (intent.kind) {
    case 'timer': {
      await launch('android.intent.action.SET_TIMER', {
        extra: {
          'android.intent.extra.alarm.LENGTH': intent.seconds,
          'android.intent.extra.alarm.MESSAGE': 'Vaani',
          'android.intent.extra.alarm.SKIP_UI': true,
        },
      });
      const d = spokenDuration(intent.seconds, locale);
      return { reply: hi(locale, `Timer set for ${d}.`, `${d} का टाइमर लगा दिया है।`), tag: 'timer' };
    }
    case 'alarm': {
      await launch('android.intent.action.SET_ALARM', {
        extra: {
          'android.intent.extra.alarm.HOUR': intent.hour,
          'android.intent.extra.alarm.MINUTES': intent.minute,
          'android.intent.extra.alarm.MESSAGE': 'Vaani',
          'android.intent.extra.alarm.SKIP_UI': true,
        },
      });
      const when = new Date(2000, 0, 1, intent.hour, intent.minute).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
      return { reply: hi(locale, `Alarm set for ${when}.`, `${when} का अलार्म लगा दिया है।`), tag: 'alarm' };
    }
    case 'call':
      await Linking.openURL(`tel:${intent.number}`);
      return { reply: hi(locale, `Opening the dialer for ${intent.number.split('').join(' ')}.`, `${intent.number} डायल कर रही हूँ।`), tag: 'call' };
    case 'open': {
      if (!intent.app) {
        return { reply: hi(locale, `I can't open ${intent.name} yet.`, `${intent.name} अभी नहीं खोल सकती।`), tag: 'open' };
      }
      await APP_TARGETS[intent.app]();
      return { reply: hi(locale, `Opening ${intent.name}.`, `${intent.name} खोल रही हूँ।`), tag: 'open' };
    }
    case 'search':
      await Linking.openURL(`https://www.google.com/search?q=${encodeURIComponent(intent.q)}`);
      return { reply: hi(locale, `Searching for ${intent.q}.`, `${intent.q} खोज रही हूँ।`), tag: 'search' };
    case 'navigate': {
      const q = encodeURIComponent(intent.place);
      await openUrl(`google.navigation:q=${q}`, `https://www.google.com/maps/dir/?api=1&destination=${q}`);
      return { reply: hi(locale, `Starting directions to ${intent.place}.`, `${intent.place} का रास्ता खोल रही हूँ।`), tag: 'maps' };
    }
    case 'time': {
      const now = new Date().toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
      return { reply: hi(locale, `It's ${now}.`, `अभी ${now} बजे हैं।`), tag: 'clock' };
    }
    case 'date': {
      const today = new Date().toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      return { reply: hi(locale, `Today is ${today}.`, `आज ${today} है।`), tag: 'clock' };
    }
    case 'battery': {
      const [level, state] = await Promise.all([Battery.getBatteryLevelAsync(), Battery.getBatteryStateAsync()]);
      if (level < 0) return { reply: hi(locale, "I can't read the battery on this device.", 'इस डिवाइस पर बैटरी नहीं पढ़ पा रही।'), tag: 'battery' };
      const pct = Math.round(level * 100);
      const charging = state === Battery.BatteryState.CHARGING;
      return {
        reply: hi(locale, `Battery is at ${pct} percent${charging ? ' and charging' : ''}.`, `बैटरी ${pct} प्रतिशत है${charging ? ', चार्ज हो रही है' : ''}।`),
        tag: 'battery',
      };
    }
    case 'math': {
      const v = Math.round(intent.value * 1e6) / 1e6;
      return { reply: hi(locale, `That's ${v.toLocaleString('en-IN')}.`, `जवाब है ${v.toLocaleString('en-IN')}।`), tag: 'math' };
    }
  }
}
