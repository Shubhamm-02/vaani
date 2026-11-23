// Executes on-device intents with Android system intents. No network, no backend.
import * as Battery from 'expo-battery';
import * as IntentLauncher from 'expo-intent-launcher';
import { Linking, Platform } from 'react-native';
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

// How each app is opened, tried in this order:
//   1. a system intent (camera, settings, alarms…)
//   2. the package's launcher activity: works for every installed app once the
//      manifest declares launcher visibility (plugins/withLauncherQueries.js)
//   3. a deep link, each one verified to resolve to the app on a real phone, so it
//      works even on builds without (2)
//   4. the website, for apps that have a useful one
//   5. the app's Play Store page: it is not installed (or could not be seen)
type Target = { pkg?: string; url?: string; web?: string; intent?: [action: string, data?: string] };

const APP_TARGETS: Record<AppKey, Target> = {
  youtube: { pkg: 'com.google.android.youtube', url: 'vnd.youtube://', web: 'https://www.youtube.com' },
  maps: { pkg: 'com.google.android.apps.maps', url: 'geo:0,0', web: 'https://maps.google.com' },
  camera: { intent: ['android.media.action.STILL_IMAGE_CAMERA'] },
  settings: { intent: [IntentLauncher.ActivityAction.SETTINGS] },
  whatsapp: { pkg: 'com.whatsapp', url: 'whatsapp://send', web: 'https://wa.me' },
  gmail: { pkg: 'com.google.android.gm', url: 'googlegmail://', web: 'mailto:' },
  browser: { web: 'https://www.google.com' },
  chrome: { pkg: 'com.android.chrome', web: 'https://www.google.com' },
  playstore: { pkg: 'com.android.vending', url: 'market://search?q=' },
  calendar: { pkg: 'com.google.android.calendar', intent: ['android.intent.action.VIEW', 'content://com.android.calendar/time/'] },
  clock: { intent: ['android.intent.action.SHOW_ALARMS'] },
  telegram: { pkg: 'org.telegram.messenger', url: 'tg://resolve', web: 'https://web.telegram.org' },
  instagram: { pkg: 'com.instagram.android' },
  facebook: { pkg: 'com.facebook.katana', url: 'fb://feed' },
  twitter: { pkg: 'com.twitter.android', url: 'twitter://timeline' },
  linkedin: { pkg: 'com.linkedin.android', url: 'linkedin://' },
  snapchat: { pkg: 'com.snapchat.android', url: 'snapchat://' },
  spotify: { pkg: 'com.spotify.music', url: 'spotify:home' },
  jiosaavn: { pkg: 'com.jio.media.jiobeats' },
  netflix: { pkg: 'com.netflix.mediaclient', url: 'nflx://www.netflix.com/browse' },
  hotstar: { pkg: 'in.startv.hotstar', url: 'hotstar://' },
  primevideo: { pkg: 'com.amazon.avod.thirdpartyclient' },
  amazon: { pkg: 'in.amazon.mShop.android.shopping', url: 'com.amazon.mobile.shopping://www.amazon.in/' },
  flipkart: { pkg: 'com.flipkart.android', url: 'flipkart://' },
  myntra: { pkg: 'com.myntra.android' },
  meesho: { pkg: 'com.meesho.supply' },
  ajio: { pkg: 'com.ril.ajio' },
  zomato: { pkg: 'com.application.zomato', url: 'zomato://' },
  swiggy: { pkg: 'in.swiggy.android', url: 'swiggy://' },
  zepto: { pkg: 'com.zeptoconsumerapp' },
  blinkit: { pkg: 'com.grofers.customerapp' },
  bigbasket: { pkg: 'com.bigbasket.mobileapp' },
  jiomart: { pkg: 'com.jpl.jiomart' },
  gpay: { pkg: 'com.google.android.apps.nbu.paisa.user' },
  phonepe: { pkg: 'com.phonepe.app' },
  paytm: { pkg: 'net.one97.paytm' },
  cred: { pkg: 'com.dreamplug.androidapp' },
  uber: { pkg: 'com.ubercab', url: 'uber://' },
  ola: { pkg: 'com.olacabs.customer' },
  irctc: { pkg: 'cris.org.in.prs.ima' },
  truecaller: { pkg: 'com.truecaller' },
  discord: { pkg: 'com.discord' },
  myjio: { pkg: 'com.jio.myjio' },
  photos: { pkg: 'com.google.android.apps.photos' },
  messages: { pkg: 'com.google.android.apps.messaging', url: 'sms:' },
  contacts: { pkg: 'com.google.android.contacts', intent: ['android.intent.action.VIEW', 'content://contacts/people/'] },
  files: { pkg: 'com.google.android.apps.nbu.files' },
};

/** Returns 'opened', or 'store' when we fell back to the Play Store page. */
async function openApp(t: Target): Promise<'opened' | 'store'> {
  if (t.intent) {
    try {
      await launch(t.intent[0], t.intent[1] ? { data: t.intent[1] } : {});
      return 'opened';
    } catch {
      /* fall through */
    }
  }
  if (t.pkg) {
    try {
      IntentLauncher.openApplication(t.pkg); // throws if not installed or not visible
      return 'opened';
    } catch {
      /* fall through */
    }
  }
  for (const u of [t.url, t.web]) {
    if (!u) continue;
    try {
      await Linking.openURL(u);
      return 'opened';
    } catch {
      /* fall through */
    }
  }
  if (!t.pkg) throw new Error('no way to open this app');
  await openUrl(`market://details?id=${t.pkg}`, `https://play.google.com/store/apps/details?id=${t.pkg}`);
  return 'store';
}

const title = (s: string) => s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());

// Readable aloud: no "-0", no 100-group digit strings, no "Infinity".
export function spokenNumber(value: number): string {
  if (!Number.isFinite(value)) return 'too large to say';
  const v = Object.is(value, -0) ? 0 : value;
  const abs = Math.abs(v);
  if (abs !== 0 && (abs >= 1e15 || abs < 1e-6)) {
    const [mantissa, exp] = v.toExponential(3).split('e');
    return `${Number(mantissa)} times 10 to the power ${Number(exp)}`;
  }
  const rounded = Math.round(v * 1e6) / 1e6;
  return (Object.is(rounded, -0) ? 0 : rounded).toLocaleString('en-IN', { maximumFractionDigits: 6 });
}

// Hindi tells the time by part of day, not am/pm: "दोपहर 2:12", "रात 10:30".
export function hindiClock(hour: number, minute: number): string {
  const part = hour >= 4 && hour < 12 ? 'सुबह' : hour < 16 && hour >= 12 ? 'दोपहर' : hour >= 16 && hour < 20 ? 'शाम' : 'रात';
  const h12 = hour % 12 || 12;
  return `${part} ${h12}:${String(minute).padStart(2, '0')}`;
}

export type LocalResult = { reply: string; tag: string };

// The same app also runs in a browser (react-native-web) for demos. A browser can't set an
// alarm or place a call, so those are simulated and say so, instead of failing silently.
const WEB = Platform.OS === 'web';
const demo = (r: LocalResult, locale: Locale): LocalResult =>
  WEB
    ? {
        reply: r.reply + hi(locale, ' (Browser demo: on a phone this goes to the Clock app.)', ' (ब्राउज़र डेमो: फ़ोन पर यह Clock ऐप में होता है।)'),
        tag: `${r.tag} · web demo`,
      }
    : r;

export async function runLocal(intent: Exclude<Intent, { kind: 'cloud' | 'stop' | 'clear' }>, locale: Locale): Promise<LocalResult> {
  switch (intent.kind) {
    case 'timer': {
      if (!WEB) await launch('android.intent.action.SET_TIMER', {
        extra: {
          'android.intent.extra.alarm.LENGTH': intent.seconds,
          'android.intent.extra.alarm.MESSAGE': 'Vaani',
          'android.intent.extra.alarm.SKIP_UI': true,
        },
      });
      const d = spokenDuration(intent.seconds, locale);
      return demo({ reply: hi(locale, `Timer set for ${d}.`, `${d} का टाइमर लगा दिया है।`), tag: 'timer' }, locale);
    }
    case 'alarm': {
      if (!WEB) await launch('android.intent.action.SET_ALARM', {
        extra: {
          'android.intent.extra.alarm.HOUR': intent.hour,
          'android.intent.extra.alarm.MINUTES': intent.minute,
          'android.intent.extra.alarm.MESSAGE': 'Vaani',
          'android.intent.extra.alarm.SKIP_UI': true,
        },
      });
      const when = new Date(2000, 0, 1, intent.hour, intent.minute).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
      const kab = hindiClock(intent.hour, intent.minute);
      // Android alarms have no date: they ring at the next occurrence of the time.
      const now = new Date();
      const ringsToday = intent.hour * 60 + intent.minute > now.getHours() * 60 + now.getMinutes();
      if (!ringsToday) {
        return demo({ reply: hi(locale, `Alarm set for ${when} tomorrow.`, `कल ${kab} बजे का अलार्म लगा दिया है।`), tag: 'alarm' }, locale);
      }
      if (intent.tomorrow) {
        return demo({
          reply: hi(
            locale,
            `Alarm set for ${when}. Android rings it at the next ${when}, which is today, so turn it off after it rings if you meant tomorrow.`,
            `${kab} बजे का अलार्म लगा दिया है। ध्यान दें, यह आज ${kab} बजे बजेगा, क्योंकि Android अलार्म में तारीख नहीं होती।`,
          ),
          tag: 'alarm',
        }, locale);
      }
      return demo({ reply: hi(locale, `Alarm set for ${when}.`, `${kab} बजे का अलार्म लगा दिया है।`), tag: 'alarm' }, locale);
    }
    case 'call':
      if (WEB) {
        return { reply: hi(locale, `On a phone this opens the dialer for ${intent.number.split('').join(' ')}. (Browser demo.)`, `फ़ोन पर यह ${intent.number} डायल करता है। (ब्राउज़र डेमो)`), tag: 'call · web demo' };
      }
      await Linking.openURL(`tel:${intent.number}`);
      return { reply: hi(locale, `Opening the dialer for ${intent.number.split('').join(' ')}.`, `${intent.number} डायल कर रही हूँ।`), tag: 'call' };
    case 'open': {
      const name = title(intent.name);
      if (WEB) {
        // In a browser, "open YouTube" opens the website when there is one.
        const site = intent.app ? APP_TARGETS[intent.app].web : undefined;
        if (site && /^https?:/.test(site)) {
          await Linking.openURL(site);
          return { reply: hi(locale, `Opening ${name} in a new tab.`, `${name} नए टैब में खोल रही हूँ।`), tag: 'open · web demo' };
        }
        return { reply: hi(locale, `On a phone this opens the ${name} app. (Browser demo.)`, `फ़ोन पर यह ${name} ऐप खोलता है। (ब्राउज़र डेमो)`), tag: 'open · web demo' };
      }
      if (!intent.app) {
        await openUrl(`market://search?q=${encodeURIComponent(intent.name)}&c=apps`, `https://play.google.com/store/search?q=${encodeURIComponent(intent.name)}&c=apps`);
        return { reply: hi(locale, `I don't know ${name} yet. Here it is on the Play Store.`, `${name} अभी नहीं पहचानती, Play Store पर खोल रही हूँ।`), tag: 'open' };
      }
      const how = await openApp(APP_TARGETS[intent.app]);
      if (how === 'store') {
        return { reply: hi(locale, `${name} isn't installed. Opening it on the Play Store.`, `${name} इंस्टॉल नहीं है, Play Store पर खोल रही हूँ।`), tag: 'open' };
      }
      return { reply: hi(locale, `Opening ${name}.`, `${name} खोल रही हूँ।`), tag: 'open' };
    }
    case 'search':
      await Linking.openURL(`https://www.google.com/search?q=${encodeURIComponent(intent.q)}`);
      return { reply: hi(locale, `Searching for ${intent.q}.`, `${intent.q} खोज रही हूँ।`), tag: 'search' };
    case 'navigate': {
      const q = encodeURIComponent(intent.place);
      if (WEB) await Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${q}`);
      else await openUrl(`google.navigation:q=${q}`, `https://www.google.com/maps/dir/?api=1&destination=${q}`);
      return { reply: hi(locale, `Starting directions to ${intent.place}.`, `${intent.place} का रास्ता खोल रही हूँ।`), tag: 'maps' };
    }
    case 'time': {
      const d = new Date();
      const now = d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
      return { reply: hi(locale, `It's ${now}.`, `अभी ${hindiClock(d.getHours(), d.getMinutes())} बजे हैं।`), tag: 'clock' };
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
      const said = spokenNumber(intent.value);
      return { reply: hi(locale, `That's ${said}.`, `जवाब है ${said}।`), tag: 'math' };
    }
  }
}
