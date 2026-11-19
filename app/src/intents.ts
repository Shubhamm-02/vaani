// On-device intent router. Pure TypeScript, no React Native imports, so it is
// unit-testable with plain Node. Anything it recognises never touches the network:
// zero latency, zero server cost, and it keeps working offline.
// Everything else is classified as `cloud` and goes to the LLM.

export type AppKey =
  | 'youtube' | 'maps' | 'camera' | 'settings' | 'whatsapp'
  | 'gmail' | 'browser' | 'playstore' | 'calendar' | 'clock';

export type Intent =
  | { kind: 'timer'; seconds: number }
  | { kind: 'alarm'; hour: number; minute: number }
  | { kind: 'call'; number: string }
  | { kind: 'open'; app: AppKey | null; name: string }
  | { kind: 'search'; q: string }
  | { kind: 'navigate'; place: string }
  | { kind: 'time' }
  | { kind: 'date' }
  | { kind: 'battery' }
  | { kind: 'math'; expr: string; value: number }
  | { kind: 'stop' }
  | { kind: 'clear' }
  | { kind: 'cloud' };

const WORD_NUM: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30,
  forty: 40, 'forty five': 45, fifty: 50, sixty: 60, ek: 1, do: 2, teen: 3, char: 4, paanch: 5, das: 10,
};
const NUM = `(\\d+(?:\\.\\d+)?|${Object.keys(WORD_NUM).sort((a, b) => b.length - a.length).join('|')})`;
const toNum = (s: string) => (/^\d/.test(s) ? Number(s) : WORD_NUM[s] ?? NaN);

const UNIT_SECONDS: [RegExp, number][] = [
  [/^(?:hours?|hrs?|h|ghante?|घंटे?|घंटा)$/u, 3600],
  [/^(?:minutes?|mins?|m|minat|मिनट)$/u, 60],
  [/^(?:seconds?|secs?|s|second|सेकंड)$/u, 1],
];

export function parseDuration(text: string): number {
  if (/half an hour|aadha ghanta/.test(text)) return 1800;
  const re = new RegExp(`${NUM}\\s*([a-z\\u0900-\\u097F]+)`, 'gu');
  let total = 0;
  for (const m of text.matchAll(re)) {
    const unit = UNIT_SECONDS.find(([r]) => r.test(m[2]));
    if (unit) total += toNum(m[1]) * unit[1];
  }
  return Math.round(total);
}

function parseAlarm(text: string): { hour: number; minute: number } | null {
  const m = text.match(/(\d{1,2})(?:[:.\s](\d{2}))?\s*(a\.?\s?m\.?|p\.?\s?m\.?|in the morning|in the evening|at night|baje)?/);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const mer = (m[3] || '').replace(/[.\s]/g, '');
  if (mer === 'pm' || mer === 'intheevening' || (mer === 'atnight' && hour < 12)) hour = hour === 12 ? 12 : hour + 12;
  if (mer === 'am' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

const APPS: [RegExp, AppKey][] = [
  [/^you ?tube/, 'youtube'],
  [/^(?:google )?maps?$/, 'maps'],
  [/^camera/, 'camera'],
  [/^settings?/, 'settings'],
  [/^whats ?app/, 'whatsapp'],
  [/^(?:g ?mail|email|mail)/, 'gmail'],
  [/^(?:chrome|browser|google)$/, 'browser'],
  [/^(?:play ?store|google play)/, 'playstore'],
  [/^calendar/, 'calendar'],
  [/^(?:clock|alarms?)$/, 'clock'],
];

// ---- arithmetic -----------------------------------------------------------
// A tiny recursive-descent parser. No eval(): voice text is untrusted input.

export function evaluate(expr: string): number {
  const tokens = expr.match(/\d+(?:\.\d+)?|[-+*/^()]/g) ?? [];
  if (tokens.join('') !== expr.replace(/\s+/g, '')) return NaN;
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  const primary = (): number => {
    const t = next();
    if (t === '(') {
      const v = sum();
      return next() === ')' ? v : NaN;
    }
    if (t === '-') return -primary();
    return t !== undefined && /^\d/.test(t) ? Number(t) : NaN;
  };
  const power = (): number => {
    const base = primary();
    if (peek() === '^') {
      next();
      return base ** power();
    }
    return base;
  };
  const product = (): number => {
    let v = power();
    while (peek() === '*' || peek() === '/') v = next() === '*' ? v * power() : v / power();
    return v;
  };
  const sum = (): number => {
    let v = product();
    while (peek() === '+' || peek() === '-') v = next() === '+' ? v + product() : v - product();
    return v;
  };
  const v = sum();
  return i === tokens.length ? v : NaN;
}

function parseMath(text: string): { expr: string; value: number } | null {
  let s = text
    .replace(/^(?:what(?:'s| is)|calculate|compute|how much is|solve|kitna hai|kya hai)\s+/, '')
    .replace(/\s+(?:kitna hai|kya hai|equals?|equal to)$/, '')
    .replace(/(\d),(?=\d{2,3}\b)/g, '$1');
  if (!/\d/.test(s)) return null;
  s = s
    .replace(/(\d)\s*(?:%|percent)\s*of\s*/g, '$1/100*')
    .replace(/\bsquared\b/g, '^2')
    .replace(/\bcubed\b/g, '^3')
    .replace(/\b(?:to the power of|raised to|power)\b/g, '^')
    .replace(/\b(?:plus|and|jama)\b/g, '+')
    .replace(/\b(?:minus|less|ghata)\b/g, '-')
    .replace(/\b(?:times|into|multiplied by|guna)\b|×/g, '*')
    .replace(/(\d)\s*x\s*(\d)/g, '$1*$2')
    .replace(/\b(?:divided by|over|bhag)\b|÷/g, '/');
  if (!/^[\d\s.+\-*/^()]+$/.test(s) || !/\d\s*[-+*/^]\s*[\d(-]/.test(s)) return null;
  const value = evaluate(s);
  return Number.isFinite(value) ? { expr: s.replace(/\s+/g, ' ').trim(), value } : null;
}

// ---- router ---------------------------------------------------------------

export function route(raw: string): Intent {
  const t = raw
    .toLowerCase()
    .normalize('NFKC')
    .trim()
    .replace(/[?!]+$/g, '')
    .replace(/\.$/, '')
    .replace(/^(?:(?:hey|hi|ok|okay)\s+)?(?:vaani|vani)[,\s]+/, '')
    .replace(/^please\s+|\s+please$/g, '')
    .trim();

  if (/^(?:stop|cancel|quiet|be quiet|shut up|bas|ruko|chup|रुको|बस)$/u.test(t)) return { kind: 'stop' };
  if (/^(?:clear|clear (?:history|chat|screen|all)|start over|reset)$/.test(t)) return { kind: 'clear' };

  if (/\btimer\b|टाइमर|remind me in/u.test(t)) {
    const seconds = parseDuration(t);
    if (seconds > 0 && seconds <= 24 * 3600) return { kind: 'timer', seconds };
  }

  if (/\balarm\b|wake me|अलार्म/u.test(t)) {
    const a = parseAlarm(t.replace(/^.*?(?:alarm|wake me(?: up)?|अलार्म)\s*(?:for|at|on)?\s*/u, ''));
    if (a) return { kind: 'alarm', ...a };
  }

  const call = t.match(/^(?:call|dial|phone)\s+([+\d][\d\s-]{1,})$/);
  if (call) return { kind: 'call', number: call[1].replace(/[\s-]/g, '') };

  const open = t.match(/^(?:open|launch|start)\s+(?:the\s+)?(.+?)(?:\s+app)?$/) || t.match(/^(.+?)\s+(?:kholo|khol do|open karo)$/);
  if (open) {
    const name = open[1];
    const hit = APPS.find(([r]) => r.test(name));
    return { kind: 'open', app: hit ? hit[1] : null, name };
  }

  const nav = t.match(/^(?:navigate|directions|take me|route|how do i get)\s+(?:me\s+)?(?:to\s+)?(.+)/);
  if (nav) return { kind: 'navigate', place: nav[1] };

  const search = t.match(/^(?:search(?: for)?|google|look up)\s+(.+)/) || t.match(/^(.+?)\s+(?:search karo|google karo)$/);
  if (search) return { kind: 'search', q: search[1] };

  if (/\b(?:what(?:'s| is) the time|what time is it|current time|time kya hai|kitne baje)\b|कितने बजे|समय क्या/u.test(t)) {
    return { kind: 'time' };
  }
  if (/\b(?:what(?:'s| is) (?:the )?date|today'?s date|what day is (?:it|today)|aaj (?:kya )?(?:date|tarikh))\b|तारीख/u.test(t)) {
    return { kind: 'date' };
  }
  if (/\bbattery\b|बैटरी/u.test(t)) return { kind: 'battery' };

  const math = parseMath(t);
  if (math) return { kind: 'math', ...math };

  return { kind: 'cloud' };
}
