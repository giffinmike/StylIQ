// apps/backend-nest/src/wardrobe/studio/colorHarmony.ts
//
// Studio-local color harmony model. Replaces the narrow four-value
// colorClashScore for top-bottom, bottom-shoes, and accessory pairings.
// Range: [-1.5, +0.8]. Neutral-anchored pairings score 0 (not masked).

import type { StudioItem } from './types';

const NEUTRAL_FAMILIES = [
  'black',
  'white',
  'gray',
  'grey',
  'beige',
  'cream',
  'ivory',
  'navy',
  'charcoal',
  'khaki',
  'tan',
];

const WARM_FAMILIES = [
  'red',
  'orange',
  'yellow',
  'brown',
  'cognac',
  'burgundy',
  'maroon',
  'coral',
  'peach',
  'rust',
  'gold',
];

const COOL_FAMILIES = [
  'blue',
  'green',
  'purple',
  'teal',
  'olive',
  'mint',
  'cyan',
  'lavender',
  'magenta',
  'pink',
];

type Tone = 'neutral' | 'warm' | 'cool' | 'unknown';

function colorFamilyOf(item: StudioItem): string {
  return (item.color_family ?? item.color ?? '').toLowerCase().trim();
}

function toneOf(fam: string): Tone {
  if (!fam) return 'unknown';
  for (const n of NEUTRAL_FAMILIES) {
    if (fam.includes(n)) return 'neutral';
  }
  for (const w of WARM_FAMILIES) {
    if (fam.includes(w)) return 'warm';
  }
  for (const c of COOL_FAMILIES) {
    if (fam.includes(c)) return 'cool';
  }
  return 'unknown';
}

function sharesBaseFamily(a: string, b: string): boolean {
  const bases = [...WARM_FAMILIES, ...COOL_FAMILIES, ...NEUTRAL_FAMILIES];
  for (const base of bases) {
    if (a.includes(base) && b.includes(base)) return true;
  }
  return false;
}

/**
 * Harmonic compatibility between two items. Positive rewards analogous
 * pairings; zero is a neutral anchor (does not force a clash signal);
 * negative penalties reflect cross-temperature or same-temperature hue
 * mismatches. Pure function of existing item fields.
 */
export function harmonyScore(a: StudioItem, b: StudioItem): number {
  const famA = colorFamilyOf(a);
  const famB = colorFamilyOf(b);
  if (!famA || !famB) return 0;

  // Analogous (shared base family): +0.8
  if (sharesBaseFamily(famA, famB)) return 0.8;

  const toneA = toneOf(famA);
  const toneB = toneOf(famB);

  // Neutral anchor: neither rewards nor penalizes
  if (toneA === 'neutral' || toneB === 'neutral') return 0;

  // Warm + cool saturated clash
  if (
    (toneA === 'warm' && toneB === 'cool') ||
    (toneA === 'cool' && toneB === 'warm')
  ) {
    return -1.5;
  }

  // Both warm but different families
  if (toneA === 'warm' && toneB === 'warm') return -1.0;

  // Both cool but different families
  if (toneA === 'cool' && toneB === 'cool') return -1.0;

  return 0;
}
