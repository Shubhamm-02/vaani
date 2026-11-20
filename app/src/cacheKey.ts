// Pure (no React Native imports) so it is unit-testable with plain Node.
import type { Locale } from './actions';

// Same idea as backend/src/normalize.js, kept deliberately smaller: a miss here
// only costs a network round trip, never a wrong answer.
export function cacheKey(query: string, locale: Locale): string {
  const norm = query
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\b(what|who|where|how|when|why)'?s\b/g, '$1 is') // "what's" and typed "whats\"
    .replace(/[^\p{L}\p{N}\p{M}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:(?:hey|hi|ok|okay)\s+)?(?:vaani|vani)\s+/, '')
    .replace(/^(?:please|can you|could you|tell me)\s+/, '')
    .replace(/\s+please$/, '')
    .replace(/\bthe\s+/g, '');
  return `${locale}|${norm}`;
}
