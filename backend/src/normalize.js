// Query normalisation decides how often two spoken commands share one cache entry.
// "Hey Vaani, can you tell me what's the GST?" and "what is gst" should be the same key.
// Every rule here must be meaning-preserving: a wrong merge serves a wrong answer,
// which is worse than a cache miss. (That is also why there is no embedding-based
// "semantic" cache: "capital of Austria" and "capital of Australia" are neighbours.)

const LEADING_FILLER =
  /^(?:(?:hey|hi|hello|ok|okay|so|um|uh)\s+)*(?:(?:vaani|vani|assistant)\s+)?(?:(?:please|can you|could you|would you|will you|tell me|explain|say|batao|bataiye|mujhe)\s+)*/u;
const TRAILING_FILLER = /\s+(?:please|thanks|thank you|batao|bataiye|bata do|na|बताओ|बताइए|बता दो|बताना)$/u;

const CONTRACTIONS = [
  [/\b(what|who|where|how|when|why|that|it|there)'s\b/g, '$1 is'],
  [/\b(what|who|where|when|why)s\b/g, '$1 is'], // typed without the apostrophe: "whats\"
  [/\b(what|who|where|how|when|why)'re\b/g, '$1 are'],
];

// Symbols that change meaning must survive punctuation stripping as words:
// "c++" vs "c", "o+" vs "o-" blood, "-40" vs "40".
const SYMBOLS = [
  [/\+/g, ' plus '],
  [/#/g, ' sharp '],
  [/(^|[\s(])-(?=\d)/g, '$1 minus '],
  [/(\p{L})-(?=\s|$)/gu, '$1 minus '],
  [/\^/g, ' power '],
  [/\*/g, ' times '],
  [/(\d)\s*\/\s*(?=\d)/g, '$1 by '],
  [/%/g, ' percent '],
];

export function normalize(query) {
  let s = String(query).normalize('NFKC').toLowerCase().replace(/[’‘]/g, "'");
  for (const [re, to] of CONTRACTIONS) s = s.replace(re, to);
  for (const [re, to] of SYMBOLS) s = s.replace(re, to);
  return s
    .replace(/[^\p{L}\p{N}\p{M}\s]/gu, ' ') // drop punctuation, keep Devanagari marks
    .replace(/\s+/g, ' ')
    .trim()
    .replace(LEADING_FILLER, '')
    .replace(TRAILING_FILLER, '')
    .replace(/\bthe\s+/g, '') // "what is the capital of x" == "what is capital of x"
    .replace(/\bkya hota hai$/u, 'kya hai')
    .replace(/क्या होता है$/u, 'क्या है')
    .trim();
}

// Answers that depend on "now" must not be served from a cache.
// Generous on purpose: a false positive costs one cache miss, a false negative serves
// a stale "now" answer for days. Devanagari words get explicit word boundaries (\b is
// ASCII-only), so "कला" and "आज़ादी" are not mistaken for "कल" and "आज".
const TIME_SENSITIVE =
  /\b(?:today|tonight|now|current|currently|latest|recent|news|weather|temperature|forecast|rain|hot|cold|score|scores|match|won|win|winner|result|results|election|live|price|prices|stock|stocks|share price|market|sensex|nifty|rate|rates|dollar|rupee|exchange|bhav|bhaav|mausam|time|date|day|tomorrow|yesterday|this week|this month|this year|aaj|abhi|kal|baj|baje)\b|(?:^|\s)(?:आज|अभी|कल|मौसम|टाइम|समय|तारीख|बजे|भाव|दाम|स्कोर|मैच)(?=\s|$)/u;

export function isTimeSensitive(normalized) {
  return TIME_SENSITIVE.test(normalized);
}

// A follow-up only makes sense with the previous turn ("who runs it", "in hindi").
// Those are answered with history and never cached. Everything else is treated as
// stand-alone: history is dropped (fewer tokens) and the answer is shareable.
// Erring towards "follow-up" only costs a cache miss, so the list is generous.
const ANAPHORA =
  /\b(?:it|its|that|this|those|these|they|them|their|he|she|him|her|his|hers|there|uska|uski|uske|iska|iski|iske|unka|unki|inka|usse|isse|wo|woh|vo|ye|yeh|wahan|yahan)\b|उसक|इसक|उनक|इनक|(?:^|\s)(?:उसे|इसे|वह|वो|ये|यह|वहाँ|वहां)(?:\s|$)/u;
// (\b is ASCII-only in JS regexes, so Devanagari words need an explicit space/end check.)
const FOLLOW_UP_START = /^(?:what about|how about|and|but|so|also|then|aur|toh|to|phir|lekin|par)\b|^(?:और|तो|फिर|लेकिन)(?:\s|$)/u;
const FOLLOW_UP_WHOLE =
  /^(?:why|why not|why so|how|how so|really|what|who|when|where|kyun|kyon|kaise|kab|kahan|more|again|repeat|elaborate|tell me more|explain more|in (?:hindi|english|short|detail|simple words)|(?:hindi|english|short|detail|simple|simple words) (?:mein|me|में)|translate|simpler|shorter|example|for example|क्यों|कैसे|कब|कहाँ|और|फिर|मतलब|हिंदी में|अंग्रेज़ी में|और बताओ)$/u;

const REFERENTIAL =
  /^(?:who|when|where|which) (?:is|are|was|were) \S+$|^how (?:much|many|old|big|tall|far|long)(?: \S+)?$|^\S+ (?:kitni|kitna|kitne|kaun|kab|kahan) (?:hai|hain|tha|thi|the)$|^\S+ (?:कितनी|कितना|कितने|कौन|कब|कहाँ) (?:है|हैं|था|थी)$/u;

/**
 * @param {string} normalized
 * @param {boolean} [inConversation] the app sent recent turns: very short questions
 *   then usually lean on them ("population kitni hai", "who is the CEO").
 * @param {string} [raw] the query as transcribed. Recognisers capitalise proper nouns, so
 *   a Titlecase word after the first ("who wrote Gitanjali") names its own subject.
 *   All-caps acronyms ("CEO") do not count.
 */
export function isFollowUp(normalized, inConversation = false, raw = '') {
  if (ANAPHORA.test(normalized) || FOLLOW_UP_START.test(normalized) || FOLLOW_UP_WHOLE.test(normalized)) return true;
  if (!inConversation || normalized.split(' ').length > 3) return false;
  if (raw.trim().split(/\s+/).slice(1).some((w) => /^[A-Z][a-z]/.test(w))) return false;
  // Only short questions that point at something already on the table: "who is the CEO",
  // "population kitni hai", "ceo kaun hai". "who discovered gravity" names its own subject.
  return REFERENTIAL.test(normalized);
}

export async function hashKey(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// A command for the phone ("10 baje ka alarm lagao", "mummy ko message bhejo") that the
// on-device router could not handle. The LLM cannot act, and small models will happily
// say "Sure, setting an alarm" anyway, so these never reach it.
const COMMAND_OBJECT =
  /\b(?:alarm|timer|reminder|remind me|message|sms|text|call|dial|whatsapp)\b|अलार्म|टाइमर|रिमाइंडर|मैसेज|संदेश|कॉल|फोन/u;
const COMMAND_VERB =
  /^(?:set|start|send|call|dial|text|remind me)\b|\b(?:lagao|laga do|lagado|set karo|set kar do|bhejo|bhej do|karo|kar do|remind me)$|लगाओ|लगा दो|भेजो|भेज दो|करो$|कर दो$/u;

export function isDeviceCommand(normalized) {
  return COMMAND_OBJECT.test(normalized) && COMMAND_VERB.test(normalized);
}
