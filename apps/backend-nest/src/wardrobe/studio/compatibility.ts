// apps/backend-nest/src/wardrobe/studio/compatibility.ts
//
// Deterministic pairwise compatibility rules for AI Outfit Studio.
// No shared scoring logic is imported. Output is a simple score + reason.

import { mapMainCategoryToSlot } from '../logic/categoryMapping';
import { harmonyScore } from './colorHarmony';
import type { StudioItem, StudioBuildContext } from './types';

const lc = (s?: string) => (s ?? '').toLowerCase();

/** Neutral colors pair with anything. */
const NEUTRALS = new Set([
  'black',
  'white',
  'gray',
  'grey',
  'navy',
  'beige',
  'cream',
  'ivory',
  'charcoal',
  'khaki',
  'tan',
]);

function colorOf(item: StudioItem): string {
  return lc(item.color) || lc(item.color_family) || '';
}

function isNeutralColor(c: string): boolean {
  if (!c) return true; // unknown → treat as neutral (don't penalize)
  for (const n of NEUTRALS) {
    if (c.includes(n)) return true;
  }
  return false;
}

function colorClashScore(a: string, b: string): number {
  if (!a || !b) return 0;
  if (isNeutralColor(a) || isNeutralColor(b)) return 0;
  if (a === b) return 0;
  // Warm pair
  const WARM = ['brown', 'tan', 'cognac', 'beige', 'burgundy', 'maroon'];
  const COOL = ['blue', 'navy', 'green', 'olive', 'purple'];
  const aW = WARM.some((c) => a.includes(c));
  const bW = WARM.some((c) => b.includes(c));
  const aC = COOL.some((c) => a.includes(c));
  const bC = COOL.some((c) => b.includes(c));
  if ((aW && bW) || (aC && bC)) return 0;
  // Soft clash — mixed warm/cool saturated colors.
  if ((aW && bC) || (aC && bW)) return -0.4;
  return 0;
}

function formalityDelta(a: StudioItem, b: StudioItem): number {
  const fa = Number(a.formality_score ?? NaN);
  const fb = Number(b.formality_score ?? NaN);
  if (!Number.isFinite(fa) || !Number.isFinite(fb)) return 0;
  return Math.abs(fa - fb);
}

function formalityScore(a: StudioItem, b: StudioItem): number {
  const delta = formalityDelta(a, b);
  if (delta === 0) return 0;
  if (delta <= 1) return 0;
  if (delta <= 2) return -0.2;
  if (delta <= 3) return -0.6;
  return -1.0; // 4+ apart: hard penalty
}

function dressCodeScore(a: StudioItem, b: StudioItem): number {
  const da = lc(a.dress_code);
  const db = lc(b.dress_code);
  if (!da || !db) return 0;
  if (da === db) return 0.2;
  // UltraCasual + formal pairings are the only hard clash we flag.
  const ultra = (s: string) => s.includes('ultracasual');
  const formal = (s: string) =>
    s.includes('business') || s.includes('formal');
  if ((ultra(da) && formal(db)) || (ultra(db) && formal(da))) return -1.0;
  return 0;
}

function isSneaker(item: StudioItem): boolean {
  const sub = lc(item.subcategory);
  const style = lc(item.shoe_style);
  return /(sneaker|trainer|running|athletic)/.test(sub + ' ' + style);
}

function isDressShoe(item: StudioItem): boolean {
  const sub = lc(item.subcategory);
  const style = lc(item.shoe_style);
  return /(oxford|derby|loafer|dress\s*shoe|monk)/.test(sub + ' ' + style);
}

function isFormalBottom(item: StudioItem): boolean {
  const sub = lc(item.subcategory);
  return /(trouser|dress\s*pant|suit\s*pant|slack)/.test(sub);
}

function isShort(item: StudioItem): boolean {
  return /\bshorts?\b/.test(lc(item.subcategory) + ' ' + lc(item.label));
}

function isJeans(item: StudioItem): boolean {
  return /\bjeans?\b/.test(lc(item.subcategory) + ' ' + lc(item.label));
}

function isHoodie(item: StudioItem): boolean {
  return /\bhoodie\b/.test(lc(item.subcategory));
}

function isTee(item: StudioItem): boolean {
  return /\bt-?shirt|tee\b/.test(lc(item.subcategory) + ' ' + lc(item.label));
}

export interface CompatibilityResult {
  compatible: boolean;
  score: number;
  reason?: string;
}

function result(
  compatible: boolean,
  score: number,
  reason?: string,
): CompatibilityResult {
  return { compatible, score, reason };
}

/** Top ↔ Bottom compatibility. */
export function topBottomCompatibility(
  top: StudioItem,
  bottom: StudioItem,
  ctx: StudioBuildContext,
): CompatibilityResult {
  const isBeachHeat =
    ctx.environmentTier === 'EXTREME_HEAT' &&
    /beach|sand|ocean|miami|resort|tropical|coastal/i.test(
      ctx.effectiveQuery ?? '',
    );

  let score = 0;
  score += harmonyScore(top, bottom);
  score += formalityScore(top, bottom);
  score += dressCodeScore(top, bottom);

  // Silhouette guardrail: hoodie + formal trousers is a structural clash.
  // Beach-heat does NOT relax structural clashes.
  if (isHoodie(top) && isFormalBottom(bottom)) {
    return result(false, -2, 'HOODIE_WITH_FORMAL_BOTTOM');
  }

  // Beach context prefers shorts bottoms.
  if (ctx.studio.isBeachContext && !isShort(bottom)) {
    score -= 0.2;
  }

  // Gym context prefers athletic / jersey bottoms.
  if (ctx.studio.isGymContext && isFormalBottom(bottom)) {
    return result(false, -2, 'FORMAL_BOTTOM_IN_GYM');
  }

  // Formal context must not pair with shorts.
  // Beach-heat does NOT relax structural clashes.
  if (ctx.studio.isFormalContext && isShort(bottom)) {
    return result(false, -2, 'SHORTS_IN_FORMAL');
  }

  // Formality delta hard-drop. Beach-heat relaxes threshold 4 → 5.
  const formalityDeltaThreshold = isBeachHeat ? 5 : 4;
  if (formalityDelta(top, bottom) >= formalityDeltaThreshold) {
    return result(false, score, 'FORMALITY_GAP_TOP_BOTTOM');
  }

  return result(true, score);
}

/** Shoes ↔ (Top, Bottom) compatibility. */
export function shoesCompatibility(
  top: StudioItem,
  bottom: StudioItem,
  shoes: StudioItem,
  ctx: StudioBuildContext,
): CompatibilityResult {
  const isBeachHeat =
    ctx.environmentTier === 'EXTREME_HEAT' &&
    /beach|sand|ocean|miami|resort|tropical|coastal/i.test(
      ctx.effectiveQuery ?? '',
    );

  let score = 0;
  score += harmonyScore(shoes, bottom);
  score += formalityScore(bottom, shoes);

  // Formal bottom demands a dress shoe. Structural; no beach override.
  if (isFormalBottom(bottom) && isSneaker(shoes)) {
    return result(false, -2, 'SNEAKERS_WITH_FORMAL_BOTTOM');
  }

  // Shorts + dress shoes look off.
  if (isShort(bottom) && isDressShoe(shoes)) {
    score -= 0.5;
  }

  // Formal context requires dress shoes. Structural; no beach override.
  if (ctx.studio.isFormalContext && !isDressShoe(shoes)) {
    return result(false, -2, 'NON_DRESS_SHOE_IN_FORMAL');
  }

  // Gym context requires athletic footwear.
  if (ctx.studio.isGymContext && !isSneaker(shoes)) {
    return result(false, -2, 'NON_ATHLETIC_SHOE_IN_GYM');
  }

  // Hard-drop when top is hoodie AND bottom is formal trouser.
  // Structural; no beach override.
  if (isHoodie(top) && isFormalBottom(bottom)) {
    return result(false, -2, 'HOODIE_WITH_FORMAL_BOTTOM');
  }

  // Explicit user constraint: excludeBrown.
  if (
    ctx.parsedConstraints.excludeBrown &&
    colorOf(shoes).includes('brown')
  ) {
    return result(false, -1, 'EXCLUDED_BROWN');
  }
  if (
    ctx.parsedConstraints.excludeSneakers &&
    isSneaker(shoes)
  ) {
    return result(false, -1, 'EXCLUDED_SNEAKERS');
  }
  if (
    ctx.parsedConstraints.excludeLoafers &&
    /loafer/.test(lc(shoes.subcategory) + ' ' + lc(shoes.shoe_style))
  ) {
    return result(false, -1, 'EXCLUDED_LOAFERS');
  }
  if (
    ctx.parsedConstraints.excludeBoots &&
    /\bboot\b/.test(lc(shoes.subcategory) + ' ' + lc(shoes.shoe_style))
  ) {
    return result(false, -1, 'EXCLUDED_BOOTS');
  }

  // Formality delta bottom↔shoes hard-drop. Beach-heat relaxes 4 → 5.
  const formalityDeltaThreshold = isBeachHeat ? 5 : 4;
  if (formalityDelta(bottom, shoes) >= formalityDeltaThreshold) {
    return result(false, score, 'FORMALITY_GAP_BOTTOM_SHOES');
  }

  return result(true, score);
}

/** Pick the best compatible layer (outerwear) from the pool, or null. */
export function selectLayer(
  top: StudioItem,
  bottom: StudioItem,
  shoes: StudioItem,
  pool: StudioItem[],
  ctx: StudioBuildContext,
  excludeIds: Set<string>,
): StudioItem | null {
  if (!pool.length) return null;

  const candidates = pool.filter((item) => !excludeIds.has(item.id));
  if (!candidates.length) return null;

  // Full-core average formality for the proximity gate. Missing values
  // default to 5 so a single unknown item does not skew the gate.
  const avgCoreFormality =
    (Number(top.formality_score ?? 5) +
      Number(bottom.formality_score ?? 5) +
      Number(shoes.formality_score ?? 5)) /
    3;

  let best: { item: StudioItem; score: number } | null = null;
  for (const layer of candidates) {
    // Tier gates — reject categorically inappropriate layers before scoring.
    if (
      ctx.environmentTier === 'ATHLETIC' &&
      /blazer|sport\s*coat|overcoat|suit/i.test(layer.subcategory ?? '')
    ) {
      continue;
    }
    if (
      ctx.environmentTier === 'EXTREME_HEAT' &&
      /wool|cashmere|leather|down|fleece/i.test(layer.material ?? '')
    ) {
      continue;
    }
    // Formality proximity: layer must sit within ±2 of core average.
    // Skip the check when the layer has no formality_score so unlabeled
    // items are not silently dropped.
    const layerFormality = Number(layer.formality_score ?? NaN);
    if (
      Number.isFinite(layerFormality) &&
      Math.abs(layerFormality - avgCoreFormality) > 2
    ) {
      continue;
    }

    let score = 1;
    score += colorClashScore(colorOf(layer), colorOf(top));
    score += colorClashScore(colorOf(layer), colorOf(bottom));
    score += formalityScore(layer, top);
    if (ctx.studio.isFormalContext) {
      const sub = lc(layer.subcategory);
      if (/blazer|sport\s*coat|overcoat/.test(sub)) score += 0.5;
    }
    if (!best || score > best.score) best = { item: layer, score };
  }
  // Only return a layer if the best candidate is at least neutral.
  if (!best || best.score < 0.2) return null;
  return best.item;
}

/** Pick the best compatible accessory from the pool, or null. */
export function selectAccessory(
  top: StudioItem,
  bottom: StudioItem,
  shoes: StudioItem,
  pool: StudioItem[],
  ctx: StudioBuildContext,
  excludeIds: Set<string>,
): StudioItem | null {
  if (!pool.length) return null;
  const candidates = pool.filter((item) => !excludeIds.has(item.id));
  if (!candidates.length) return null;

  // Full-core average formality and ultracasual sniff drive the gates
  // below. Missing formalities default to 5 per the proximity convention.
  const avgCoreFormality =
    (Number(top.formality_score ?? 5) +
      Number(bottom.formality_score ?? 5) +
      Number(shoes.formality_score ?? 5)) /
    3;
  const coreIsUltraCasual =
    /ultracasual/i.test(top.dress_code ?? '') ||
    /ultracasual/i.test(bottom.dress_code ?? '') ||
    /ultracasual/i.test(shoes.dress_code ?? '');

  let best: { item: StudioItem; score: number } | null = null;
  for (const acc of candidates) {
    // Formality gate — never pair a hero-tier accessory on a low-formality look.
    const accFormality = Number(acc.formality_score ?? NaN);
    if (
      avgCoreFormality < 5 &&
      Number.isFinite(accFormality) &&
      accFormality >= 7
    ) {
      continue;
    }
    // Dress-code gate — a tie or pocket square is wrong on an ultracasual core.
    if (
      coreIsUltraCasual &&
      /tie|pocket\s*square/i.test(acc.subcategory ?? '')
    ) {
      continue;
    }

    let score = 1;
    score += harmonyScore(acc, top);
    score += harmonyScore(acc, bottom);
    // Formal context prefers structured accessories.
    if (ctx.studio.isFormalContext) {
      const sub = lc(acc.subcategory);
      if (/tie|pocket\s*square|watch|belt/.test(sub)) score += 0.3;
    }
    if (!best || score > best.score) best = { item: acc, score };
  }
  if (!best || best.score < 0.2) return null;
  return best.item;
}

/** Lightweight helper: true if the item is a tee (used by scoring for gym). */
export function isAthleticTop(item: StudioItem): boolean {
  const sub = lc(item.subcategory);
  return /(tank|jersey|athletic|performance)/.test(sub) || isTee(item);
}

/** Canonical slot of an item (re-exported for builders/tests). */
export function slotOf(item: StudioItem) {
  return mapMainCategoryToSlot(item.main_category ?? '');
}

/** Predicate used during layering decisions. */
export function isShortBottom(item: StudioItem) {
  return isShort(item);
}
