// apps/backend-nest/src/wardrobe/studio/context.ts
//
// Studio-local intent detectors. Structured signals replace substring
// regex across the pipeline so proper nouns (city names, restaurant
// names, etc.) never collide with occasion classification.

const BEACH_INTENT_RE = /\b(beach|sandy|ocean|pool|tropical|coastal)\b/i;

/**
 * True when the query explicitly references a beach / pool / coastal
 * occasion. Matches only standalone words with regex word boundaries —
 * proper nouns like "Miami", "Hawaii", or a restaurant named "Coastline"
 * do NOT trigger beach intent.
 */
export function isExplicitBeachIntent(query: string): boolean {
  if (!query) return false;
  return BEACH_INTENT_RE.test(query);
}
