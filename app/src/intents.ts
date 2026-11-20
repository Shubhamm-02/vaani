// On-device intent router. Pure TypeScript, no React Native imports, so it is
// unit-testable with plain Node. Anything it recognises never touches the network:
// zero latency, zero server cost, and it keeps working offline.
// Everything else is classified as `cloud` and goes to the LLM.

export type AppKey =
  | 'youtube' | 'maps' | 'camera' | 'settings' | 'whatsapp' | 'gmail' | 'browser' | 'chrome'
  | 'playstore' | 'calendar' | 'clock' | 'telegram' | 'instagram' | 'facebook' | 'twitter'
  | 'linkedin' | 'snapchat' | 'spotify' | 'jiosaavn' | 'netflix' | 'hotstar' | 'primevideo'
  | 'amazon' | 'flipkart' | 'myntra' | 'meesho' | 'ajio' | 'zomato' | 'swiggy' | 'zepto'
  | 'blinkit' | 'bigbasket' | 'jiomart' | 'gpay' | 'phonepe' | 'paytm' | 'cred' | 'uber' | 'ola'
  | 'irctc' | 'truecaller' | 'discord' | 'myjio' | 'photos' | 'messages' | 'contacts' | 'files';

export type Intent =
  | { kind: 'timer'; seconds: number }
  | { kind: 'alarm'; hour: number; minute: number; tomorrow?: true }
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

// ---- spoken numbers -------------------------------------------------------
// Speech recognisers return digits most of the time, but Hinglish and Hindi often come
// back as words ("barah baje", "पाँच मिनट") or as fractions that have no English
// equivalent: saade 10 = 10:30, sava 8 = 8:15, paune 7 = 6:45, dedh = 1.5, dhai = 2.5.

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, 'forty five': 45,
  fifty: 50, sixty: 60, ninety: 90,
  ek: 1, do: 2, teen: 3, char: 4, chaar: 4, paanch: 5, panch: 5, chhe: 6, che: 6, chah: 6, chheh: 6,
  saat: 7, aath: 8, nau: 9, das: 10, dus: 10, gyarah: 11, gyara: 11, gyaarah: 11, barah: 12, bara: 12,
  baarah: 12, baara: 12, pandrah: 15, pandra: 15, bees: 20, pachees: 25, pachchis: 25, tees: 30,
  chalees: 40, chalis: 40, paintalis: 45, pachaas: 50, pachas: 50, saath: 60,
  'एक': 1, 'दो': 2, 'तीन': 3, 'चार': 4, 'पांच': 5, 'पाँच': 5, 'छह': 6, 'छः': 6, 'छे': 6, 'सात': 7,
  'आठ': 8, 'नौ': 9, 'दस': 10, 'ग्यारह': 11, 'बारह': 12, 'पंद्रह': 15, 'पन्द्रह': 15, 'बीस': 20,
  'पच्चीस': 25, 'तीस': 30, 'चालीस': 40, 'पैंतालीस': 45, 'पचास': 50, 'साठ': 60,
};
for (const [tens, tv] of [['twenty', 20], ['thirty', 30], ['forty', 40], ['fifty', 50]] as const) {
  for (const [unit, uv] of [['one', 1], ['two', 2], ['three', 3], ['four', 4], ['five', 5], ['six', 6], ['seven', 7], ['eight', 8], ['nine', 9]] as const) {
    NUMBER_WORDS[`${tens} ${unit}`] = tv + uv;
    NUMBER_WORDS[`${tens}-${unit}`] = tv + uv;
  }
}
const FRACTION_PREFIX: Record<string, number> = {
  saade: 0.5, sade: 0.5, saadhe: 0.5, 'साढ़े': 0.5, sava: 0.25, sawa: 0.25, 'सवा': 0.25, paune: -0.25, pone: -0.25, 'पौने': -0.25,
};
const FRACTION_ALONE: Record<string, number> = {
  dedh: 1.5, dhai: 2.5, dhaai: 2.5, aadha: 0.5, aadhe: 0.5, aadhi: 0.5, half: 0.5,
  'डेढ़': 1.5, 'ढाई': 2.5, 'आधा': 0.5, 'आधे': 0.5, 'आधी': 0.5,
};

const nfkc = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.normalize('NFKC'), v]));
const NUM_W = nfkc(NUMBER_WORDS);
const PRE_W = nfkc(FRACTION_PREFIX);
const ALONE_W = nfkc(FRACTION_ALONE);
const alt = (o: Record<string, number>) => Object.keys(o).sort((a, b) => b.length - a.length).join('|');
// Letters, marks and digits count as "inside a word" (\b is ASCII-only in JS).
const L = '(?<![\\p{L}\\p{M}\\p{N}])';
const R = '(?![\\p{L}\\p{M}\\p{N}])';
// One spoken quantity: "10", "2.5", "barah", "saade das", "dedh". Groups: prefix, number, alone.
const QTY = `${L}(?:(?:(${alt(PRE_W)})\\s+)?(\\d+(?:\\.\\d+)?|${alt(NUM_W)})|(${alt(ALONE_W)}))${R}`;

function qty(prefix: string | undefined, n: string | undefined, alone: string | undefined): number {
  if (alone) return ALONE_W[alone];
  const base = /^\d/.test(n!) ? Number(n) : NUM_W[n!];
  return prefix ? base + PRE_W[prefix] : base;
}

const UNIT_SECONDS: [RegExp, number][] = [
  [/^(?:hours?|hrs?|h|ghante?|ghanta|घंटे?|घंटा)$/u, 3600],
  [/^(?:minutes?|mins?|m|minat|mint|मिनट)$/u, 60],
  [/^(?:seconds?|secs?|s|second|सेकंड|सेकेंड)$/u, 1],
];
const UNIT_WORD = '([a-z\\u0900-\\u097F]+)';

export function parseDuration(text: string): number {
  if (/half an hour|aadha ghanta|आधा घंटा/u.test(text)) return 1800;
  let total = 0;
  for (const m of text.matchAll(new RegExp(`${QTY}\\s*${UNIT_WORD}`, 'gu'))) {
    const unit = UNIT_SECONDS.find(([r]) => r.test(m[4]));
    if (!unit) continue;
    total += qty(m[1], m[2], m[3]) * unit[1];
    // "an hour and a half", "2 minutes and a half"
    if (/^\s+and a half\b/.test(text.slice(m.index! + m[0].length))) total += unit[1] / 2;
  }
  // "1 hour 30": a bare number after hours means minutes
  const bare = text.match(/(?:hours?|hrs?|ghante?|ghanta|घंटे?|घंटा)\s+(?:and\s+)?(\d{1,2})\s*$/u);
  if (bare) total += Number(bare[1]) * 60;
  return Math.round(total);
}

// ---- alarms ---------------------------------------------------------------

type Period = 'am' | 'pm' | 'morning' | 'afternoon' | 'evening' | 'night' | null;

function period(text: string): Period {
  if (/(?:^|[\s\d])a\.?\s?m\b\.?/.test(text)) return 'am';
  if (/(?:^|[\s\d])p\.?\s?m\b\.?/.test(text)) return 'pm';
  if (/\b(?:morning|subah|subha|savere|sawere|bhor)\b|सुबह|सवेरे|भोर/u.test(text)) return 'morning';
  if (/\b(?:afternoon|noon|dopahar|dopehar|dophar)\b|दोपहर/u.test(text)) return 'afternoon';
  if (/\b(?:evening|shaam|sham|sandhya)\b|शाम/u.test(text)) return 'evening';
  if (/\b(?:night|tonight|raat|rat)\b|रात/u.test(text)) return 'night';
  return null;
}

function to24h(h: number, p: Period, now: Date): number {
  switch (p) {
    case 'pm':
    case 'evening':
      return h < 12 ? h + 12 : h;
    case 'am':
      return h === 12 ? 0 : h;
    case 'morning':
      return h; // "subah 12" is not idiomatic; noon is the least surprising reading
    case 'afternoon':
      return h >= 1 && h <= 6 ? h + 12 : h;
    case 'night':
      return h === 12 ? 0 : h >= 6 && h < 12 ? h + 12 : h; // raat 8 = 20:00, raat 2 = 02:00
    default: {
      if (h === 0 || h > 12) return h;
      // "alarm for 7" with no am/pm: the next 7 o'clock, as Google's assistant does.
      const nowMin = now.getHours() * 60 + now.getMinutes();
      const am = (h % 12) * 60;
      return am > nowMin || am + 720 <= nowMin ? h % 12 : (h % 12) + 12;
    }
  }
}

export function parseAlarm(text: string, now: Date = new Date()): { hour: number; minute: number; tomorrow?: true } | null {
  const tomorrow = /\b(?:tomorrow|kal|cal|kaal)\b|(?:^|\s)कल(?:\s|$)/u.test(text) ? ({ tomorrow: true } as const) : {};

  // Relative: "alarm in 10 minutes", "20 minute baad alarm", "आधे घंटे बाद"
  const rel =
    text.match(new RegExp(`\\b(?:in|after|for)\\s+${QTY}\\s*(?:an?\\s+)?${UNIT_WORD}`, 'u')) ||
    text.match(new RegExp(`${QTY}\\s*${UNIT_WORD}\\s*(?:baad|bad|mein|me|later|from now|बाद|में)${R}`, 'u'));
  if (rel) {
    const unit = UNIT_SECONDS.find(([r]) => r.test(rel[4]));
    if (unit) {
      const at = new Date(now.getTime() + qty(rel[1], rel[2], rel[3]) * unit[1] * 1000);
      return { hour: at.getHours(), minute: at.getMinutes() };
    }
  }

  if (/\bnoon\b|\bmidday\b/.test(text) && !/\d/.test(text)) return { hour: 12, minute: 0, ...tomorrow };
  if (/\bmidnight\b/.test(text) && !/\d/.test(text)) return { hour: 0, minute: 0, ...tomorrow };

  let h: number;
  let minute = 0;
  const pastTo = text.match(new RegExp(`\\b(half|quarter) (past|to) ${QTY}`, 'u'));
  if (pastTo) {
    const base = qty(pastTo[3], pastTo[4], pastTo[5]);
    const delta = pastTo[1] === 'half' ? 30 : pastTo[2] === 'past' ? 15 : -15;
    const total = (base * 60 + delta + 24 * 60) % (24 * 60);
    const hour = to24h(Math.floor(total / 60) || 12, period(text), now); // 12-hour clock: 0 reads as 12
    return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? { hour, minute: total % 60, ...tomorrow } : null;
  }
  const clock = text.match(/(?<!\d)(\d{1,2})\s*[:.]\s*(\d{2})(?!\d)/);
  const spokenClock = text.match(new RegExp(`${L}(\\d{1,2}|${alt(NUM_W)})\\s+(o\\s?five|fifteen|twenty five|twenty|thirty five|thirty|forty five|forty|fifty five|fifty)${R}(?!\\s*(?:minutes?|mins?|seconds?))`, 'u'));
  if (spokenClock) {
    h = /^\d/.test(spokenClock[1]) ? Number(spokenClock[1]) : NUM_W[spokenClock[1]];
    minute = spokenClock[2].startsWith('o') ? 5 : (NUM_W[spokenClock[2]] ?? { 'twenty five': 25, 'thirty five': 35, 'fifty five': 55 }[spokenClock[2]] ?? 0);
  } else if (clock) {
    h = Number(clock[1]);
    minute = Number(clock[2]);
  } else {
    // Prefer a number that is clearly a time ("10 baje", "7 am", "at 6"), else the first number.
    const re = new RegExp(QTY, 'gu');
    const all = [...text.matchAll(re)].filter((m) => {
      const after = text.slice(m.index! + m[0].length, m.index! + m[0].length + 8);
      if (/^\s*alarms?\b/.test(after)) return false; // "set 2 alarms" is a count, not a time
      return !(m[2] && /^(?:a|an|do)$/.test(m[2]) && !/^\s*(?:baje|बजे)/u.test(after));
    });
    const isTime = (m: RegExpMatchArray) => {
      const after = text.slice(m.index! + m[0].length, m.index! + m[0].length + 10);
      const before = text.slice(Math.max(0, m.index! - 4), m.index!);
      return /^\s*(?:baje|बजे|o'?\s?clock|a\.?\s?m|p\.?\s?m)/u.test(after) || /(?:at|for|by)\s$/.test(before);
    };
    const m = all.find(isTime) ?? all[0];
    if (!m) return null;
    const v = qty(m[1], m[2], m[3]);
    h = Math.floor(v);
    minute = Math.round((v - h) * 60);
  }
  const hour = to24h(h, period(text), now);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute, ...tomorrow };
}

// Spoken names (English, Hinglish, Devanagari) -> app. How each one is launched lives
// in actions.ts; anything not listed here is searched for on the Play Store.
const APPS: [RegExp, AppKey][] = [
  [/^(?:you ?tube|यूट्यूब)/u, 'youtube'],
  [/^(?:google )?maps?$|^मैप्स?$/u, 'maps'],
  [/^(?:camera|कैमरा)/u, 'camera'],
  [/^(?:(?:wi-?fi|bluetooth|phone|mobile) )?(?:settings?|सेटिंग्स?)|^(?:wi-?fi|bluetooth)$/u, 'settings'],
  [/^(?:whats ?app|व्हाट्सएप|व्हाट्सऐप)/u, 'whatsapp'],
  [/^(?:g ?mail|email|mail|जीमेल)/u, 'gmail'],
  [/^(?:browser|google)$/u, 'browser'],
  [/^(?:google )?chrome$/u, 'chrome'],
  [/^(?:play ?store|google play)/u, 'playstore'],
  [/^(?:calendar|कैलेंडर)/u, 'calendar'],
  [/^(?:clock|alarms?|घड़ी)$/u, 'clock'],
  [/^(?:telegram|टेलीग्राम)/u, 'telegram'],
  [/^(?:insta(?:gram)?|इंस्टाग्राम|इंस्टा)/u, 'instagram'],
  [/^(?:facebook|fb|फेसबुक)$/u, 'facebook'],
  [/^(?:twitter|x|ट्विटर)$/u, 'twitter'],
  [/^linked ?in/u, 'linkedin'],
  [/^snap ?chat/u, 'snapchat'],
  [/^(?:spotify|स्पॉटिफाई)/u, 'spotify'],
  [/^(?:jio ?saavn|saavn)/u, 'jiosaavn'],
  [/^(?:netflix|नेटफ्लिक्स)/u, 'netflix'],
  [/^(?:(?:disney )?(?:plus )?hot ?star|jio ?hotstar)/u, 'hotstar'],
  [/^(?:prime video|amazon prime)/u, 'primevideo'],
  [/^(?:amazon|अमेज़न|अमेज़ॅन)$/u, 'amazon'],
  [/^(?:flipkart|फ्लिपकार्ट)/u, 'flipkart'],
  [/^myntra/u, 'myntra'],
  [/^meesho/u, 'meesho'],
  [/^ajio/u, 'ajio'],
  [/^(?:zomato|ज़ोमैटो|जोमैटो)/u, 'zomato'],
  [/^(?:swiggy|स्विगी)/u, 'swiggy'],
  [/^zepto/u, 'zepto'],
  [/^blinkit/u, 'blinkit'],
  [/^big ?basket/u, 'bigbasket'],
  [/^jio ?mart/u, 'jiomart'],
  [/^(?:g ?pay|google pay|गूगल पे)/u, 'gpay'],
  [/^(?:phone ?pe|फोनपे|फ़ोनपे)/u, 'phonepe'],
  [/^(?:paytm|पेटीएम)/u, 'paytm'],
  [/^cred$/u, 'cred'],
  [/^uber/u, 'uber'],
  [/^ola(?: cabs)?$/u, 'ola'],
  [/^irctc/u, 'irctc'],
  [/^true ?caller/u, 'truecaller'],
  [/^discord/u, 'discord'],
  [/^my ?jio/u, 'myjio'],
  [/^(?:google )?photos|^gallery$/u, 'photos'],
  [/^messages?$|^sms$/u, 'messages'],
  [/^contacts?$/u, 'contacts'],
  [/^(?:files|file manager)$/u, 'files'],
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
    return t !== undefined && /^\d/.test(t) ? Number(t) : NaN;
  };
  const power = (): number => {
    if (peek() === '-') {
      next();
      return -power();
    }
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

// Numbers written with valid Indian (1,00,000) or international (100,000) grouping lose
// their commas; anything else ("10,20 and 30") keeps them and is not treated as maths.
const GROUPED = /(?<![\d,])\d{1,3}(?:(?:,\d{2})*,\d{3}|(?:,\d{3})+)(?![\d,])/g;
const MATH_CUE = /\b(?:calculate|compute|solve|how much is|kitna|kitne)\b|=|कितना|बराबर/u;
const MATH_WORDS: [RegExp, string][] = [
  [/(\d)\s*(?:%|percent|pratishat|प्रतिशत)\s*(?:of|ka|का)\s*/gu, '$1/100*'],
  [/\bsquared\b/g, '^2'],
  [/\bcubed\b/g, '^3'],
  [/\b(?:to the power of|raised to|power)\b/g, '^'],
  [/\b(?:plus|and|jama|aur)\b|प्लस|जमा|और/gu, '+'],
  [/\b(?:minus|less|ghata)\b|माइनस|घटा/gu, '-'],
  [/\b(?:times|into|multiplied by|guna|gunaa)\b|गुना|गुणा|×/gu, '*'],
  [/(\d)\s*x\s*(?=\d)/g, '$1*'],
  [/\b(?:divided by|over|bhag|bhaag)\b|भाग|÷/gu, '/'],
];

function parseMath(text: string): { expr: string; value: number } | null {
  let s = text
    .replace(/^(?:what(?:'s| is)|calculate|compute|how much is|solve|kitna hai|kya hai)\s+/, '')
    .replace(/\s*(?:kitna hota hai|kitna hai|kitne hote hain|kitna hoga|kya hai|kya hoga|equals?|equal to|=|कितना होता है|कितना है|क्या है|बराबर)$/u, '')
    .replace(GROUPED, (m) => m.replace(/,/g, ''));
  if (!/\d/.test(s.replace(new RegExp(`${L}(?:${alt(NUM_W)})${R}`, 'gu'), '1'))) return null;
  // "9/11", "24x7", "20-20", "4-4-2" are names, dates and scores, not sums, unless asked as one.
  if (/^\d+(?:[-/x]\d+)+$/.test(s.trim()) && !MATH_CUE.test(text)) return null;
  for (const [re, to] of MATH_WORDS) s = s.replace(re, to);
  s = s.replace(new RegExp(`${L}(${alt(NUM_W)})${R}`, 'gu'), (w) => (/^(?:a|an)$/.test(w) ? w : String(NUM_W[w])));
  if (!/^[\d\s.+\-*/^()]+$/.test(s) || !/\d\s*[-+*/^]\s*[\d(-]/.test(s)) return null;
  const value = evaluate(s);
  return Number.isFinite(value) ? { expr: s.replace(/\s+/g, ' ').trim(), value } : null;
}

// ---- router ---------------------------------------------------------------

const STOP = /^(?:stop|cancel|quiet|be quiet|shut up|bas|bas karo|ruko|ruk jao|chup|chup karo|रुको|बस|बस करो|चुप)$/u;
const TIME_Q =
  /^(?:(?:what(?:'s| is) the time|what time is it|tell me the time|current time|time|time (?:kya hai|kya hua hai|kya ho raha hai|batao|bata do)|(?:abhi )?(?:kya|kitna) time (?:hua hai|ho gaya|hai)|kitne baje(?: hain| hai)?|kitna baj (?:raha hai|rahe hain)|kitna baja hai)(?: (?:now|right now|abhi))?|(?:अभी )?(?:कितने बजे(?: हैं| है)?|क्या टाइम हुआ है|समय क्या है|टाइम क्या है|कितना बजा है))$/u;
const DATE_Q =
  /^(?:what(?:'s| is) (?:the )?date(?: today)?|what(?:'s| is) today'?s date|today'?s date|what day is (?:it|today)|date (?:batao|bata do|kya hai)|aaj (?:ki |ka )?(?:date|tarikh|din)(?: kya hai| hai| batao)?|aaj (?:kaun sa|kya) din hai|आज (?:की )?तारीख(?: क्या है)?|आज कौन सा दिन है|आज क्या तारीख है)$/u;
const BATTERY_Q =
  /^(?:battery|how much battery(?: is)?(?: left| remaining)?|(?:what(?:'s| is) (?:the |my )?)?battery(?: level| percentage| status| left)?|battery (?:kitni|kitna) (?:hai|bachi hai)(?: abhi)?|kitni battery (?:hai|bachi hai)|बैटरी(?: कितनी है| कितनी बची है)?)$/u;

// A question is answered, never turned into an action: "how do I get a passport" must
// not start navigation, "how to set alarm on iphone 15" must not set a 3 pm alarm.
const COMMAND_START = /^(?:set|start|open|launch|call|dial|navigate|directions to|get directions to|take me to|how do i get to|route to|search|google|look up|wake me|remind me)\b/;
const EN_QUESTION = /^(?:how|why|what|who|whom|when|where|which|is|are|was|were|does|did|do i|do you|can i|should|my|tell me about)\b/;
const HI_QUESTION = /(?:\b(?:kya hai|kya hota hai|kaun hai|kaise kare|kaise karein|kaise karte hain|kaise hota hai|matlab)$)|\b(?:kaise|kyun|kyon)\b|क्या है$|क्या होता है$|कौन है$|कैसे|क्यों/u;
const NEGATED = /\b(?:didn'?t|did not|doesn'?t|does not|isn'?t|not working|nahi|nahin|mat)\b|नहीं|मत/u;

const OPEN_EN = /^(open|launch|start)\s+(?:the\s+)?(.+?)(?:\s+app)?$/;
const OPEN_HI = /^(.+?)(?:\s+app)?\s+(kholo|khol do|khol de|kholiye|kholna|open karo|open kar do|open kar|chalao|chala do|chalu karo|खोलो|खोल दो|खोलिए|ओपन करो|चलाओ)$/u;

export function route(raw: string, now: Date = new Date()): Intent {
  const t = raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .trim()
    .replace(/[?!।]+$/gu, '')
    .replace(/\.$/, '')
    .replace(/^(?:(?:hey|hi|ok|okay)\s+)?(?:vaani|vani)[,\s]+/, '')
    .replace(/^(?:(?:can|could|would|will) you (?:please )?|please\s+|kya aap\s+|zara\s+)/, '')
    .replace(/\s+please$/, '')
    .trim();

  if (STOP.test(t)) return { kind: 'stop' };
  if (/^(?:clear|clear (?:history|chat|screen|all)|start over|reset)$/.test(t)) return { kind: 'clear' };

  // Questions the phone can answer itself. Whole-sentence matches only:
  // "what time is it in london" and "how does a battery work" go to the cloud.
  if (TIME_Q.test(t)) return { kind: 'time' };
  if (DATE_Q.test(t)) return { kind: 'date' };
  if (BATTERY_Q.test(t)) return { kind: 'battery' };
  const math = parseMath(t);
  if (math) return { kind: 'math', ...math };

  const asking = HI_QUESTION.test(t) || NEGATED.test(t) || (EN_QUESTION.test(t) && !COMMAND_START.test(t));
  if (asking) return { kind: 'cloud' };

  const isTimer = /\btimer\b|टाइमर|remind me in/u.test(t);
  if (isTimer) {
    const seconds = parseDuration(t);
    if (seconds > 0 && seconds <= 24 * 3600) return { kind: 'timer', seconds };
  }

  // The time can come before the keyword ("kal subah 10 baje ka alarm lagao") or after it
  // ("set an alarm for 10 am"), so the whole utterance is parsed.
  const isAlarm = /\balarms?\b|wake me|अलार्म|\b(?:utha|jaga) (?:dena|do)\b|उठा देना|जगा देना/u.test(t);
  // Turning an alarm or timer off must never set one: Android has no reliable
  // "delete this alarm" intent, so open the alarms screen and let the user do it.
  if ((isAlarm || isTimer) && /\b(?:cancel|delete|remove|turn off|switch off|disable|stop|snooze|dismiss|band|hatao|hata do|mita do|off)\b|बंद|हटाओ|हटा दो|रद्द/u.test(t)) {
    return { kind: 'open', app: 'clock', name: 'alarms' };
  }
  if (isAlarm) {
    const a = parseAlarm(t, now);
    if (a) return { kind: 'alarm', ...a };
  }

  // "set an alarm" / "timer lagao" with no time: open the clock app instead of
  // sending a command to the cloud, where it would only get a chatty answer.
  if ((isAlarm || isTimer) && /\b(?:set|start|create|lagao|laga do|lagado|laga|chalu)\b|लगाओ|लगा दो|लगा/u.test(t)) {
    return { kind: 'open', app: 'clock', name: 'clock' };
  }

  const call = t.match(/^(?:call|dial|phone)\s+([+\d][\d\s-]{1,})$/);
  if (call) return { kind: 'call', number: call[1].replace(/[\s-]/g, '') };

  const en = t.match(OPEN_EN);
  const hiOpen = t.match(OPEN_HI);
  const open = en ? { verb: en[1], name: en[2] } : hiOpen ? { verb: hiOpen[2], name: hiOpen[1] } : null;
  if (open) {
    const hit = APPS.find(([r]) => r.test(open.name));
    if (hit) return { kind: 'open', app: hit[1], name: open.name };
    // Unknown names only for an explicit "open X" with a short, name-like X;
    // "start a business", "launch date of chandrayaan 3" are not apps.
    const nameLike = open.name.split(/\s+/).length <= 3 && !/\b(?:of|for|a|an|to|in|on|is|my|your)\b/.test(open.name);
    if (nameLike && !/^(?:start|chalao|chala do|chalu karo|चलाओ)$/u.test(open.verb)) return { kind: 'open', app: null, name: open.name };
  }

  const nav =
    t.match(/^(?:navigate(?: me)?(?: to)?|(?:get )?directions to|take me to|how do i get to|route to)\s+(.+)$/) ||
    t.match(/^(.+?) (?:ka|ki|ke) rasta (?:batao|dikhao|bata do)$/);
  if (nav) return { kind: 'navigate', place: nav[1] };
  if (/^take me home$/.test(t)) return { kind: 'navigate', place: 'home' };

  const search = t.match(/^(?:search(?: for)?|google|look up)\s+(.+)$/) || t.match(/^(.+?)\s+(?:search karo|google karo|search kar do|google kar do|खोजो|सर्च करो)$/u);
  if (search && !/^(?:for|about|on|ka|ki|ke)$/.test(search[1])) return { kind: 'search', q: search[1] };

  return { kind: 'cloud' };
}
