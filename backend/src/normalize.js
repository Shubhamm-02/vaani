// Query normalisation decides how often two spoken commands share one cache entry.
// "Hey Vaani, can you tell me what's the GST?" and "what is gst" should be the same key.
// Every rule here must be meaning-preserving: a wrong merge serves a wrong answer,
// which is worse than a cache miss. (That is also why there is no embedding-based
// "semantic" cache: "capital of Austria" and "capital of Australia" are neighbours.)

const LEADING_FILLER =
  /^(?:(?:hey|hi|hello|ok|okay|so|um|uh)\s+)*(?:(?:vaani|vani|assistant)\s+)?(?:(?:please|can you|could you|would you|will you|tell me|explain|say|batao|bataiye|mujhe)\s+)*/u;
const TRAILING_FILLER = /\s+(?:please|thanks|thank you|batao|bataiye|na)$/u;

const CONTRACTIONS = [
  [/\b(what|who|where|how|when|why|that|it|there)'s\b/g, '$1 is'],
  [/\b(what|who|where|how|when|why)'re\b/g, '$1 are'],
];

export function normalize(query) {
  let s = String(query).normalize('NFKC').toLowerCase().replace(/[’‘]/g, "'");
  for (const [re, to] of CONTRACTIONS) s = s.replace(re, to);
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
const TIME_SENSITIVE =
  /\b(?:today|tonight|now|current|currently|latest|recent|news|weather|temperature|score|live|price|stock|rate|tomorrow|yesterday|this week|this year|aaj|abhi|kal)\b|आज|अभी|कल/u;

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
  /^(?:why|why not|how|really|what|who|when|where|kyun|kaise|kab|more|again|repeat|elaborate|tell me more|explain more|in (?:hindi|english|short|detail)|translate|simpler|shorter|example|for example)$/u;

export function isFollowUp(normalized) {
  return ANAPHORA.test(normalized) || FOLLOW_UP_START.test(normalized) || FOLLOW_UP_WHOLE.test(normalized);
}

export async function hashKey(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
