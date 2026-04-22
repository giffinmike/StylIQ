// apps/backend-nest/src/wardrobe/studio/postAssemblyValidation.ts
//
// Studio-local post-assembly validation. Applied AFTER candidate
// assembly to reject outfits with structural or harmonic issues that
// survived compatibility gates. Physical slot presence is enforced
// elsewhere; this module only gates stylist-quality clashes.

import { harmonyScore } from './colorHarmony';
import type { StudioItem, StudioOutfit } from './types';

const lc = (s?: string): string => (s ?? '').toLowerCase();

function isSneakerItem(item: StudioItem): boolean {
  const s = lc(item.subcategory) + ' ' + lc(item.shoe_style);
  return /(sneaker|trainer|running|athletic)/.test(s);
}

function isDressShoeItem(item: StudioItem): boolean {
  const s = lc(item.subcategory) + ' ' + lc(item.shoe_style);
  return /(oxford|derby|loafer|dress\s*shoe|monk|brogue)/.test(s);
}

function isFormalTrouserItem(item: StudioItem): boolean {
  return /(trouser|dress\s*pant|suit\s*pant|slack)/.test(lc(item.subcategory));
}

function isGymShortItem(item: StudioItem): boolean {
  const s = lc(item.subcategory) + ' ' + lc(item.label);
  if (!/\bshorts?\b/.test(s)) return false;
  return /\b(athletic|gym|basketball|running|training|performance|mesh)\b/.test(
    s,
  );
}

function hasPatternClash(outfit: StudioOutfit): boolean {
  const items: StudioItem[] = [
    outfit.slots.top,
    outfit.slots.bottom,
    outfit.slots.shoes,
    ...(outfit.slots.layer ? [outfit.slots.layer] : []),
    ...(outfit.slots.accessory ? [outfit.slots.accessory] : []),
  ];
  const nonSolid = items
    .map((it) => it.pattern)
    .filter((p): p is NonNullable<StudioItem['pattern']> => !!p && p !== 'solid');
  if (nonSolid.length < 2) return false;
  return new Set<string>(nonSolid).size >= 2;
}

export function validateOutfitPostAssembly(outfit: StudioOutfit): boolean {
  const { top, bottom, shoes, accessory } = outfit.slots;

  // All three pairwise harmonies must stay above -1.2.
  if (harmonyScore(top, bottom) < -1.2) return false;
  if (harmonyScore(bottom, shoes) < -1.2) return false;
  if (harmonyScore(top, shoes) < -1.2) return false;

  if (isSneakerItem(shoes) && isFormalTrouserItem(bottom)) return false;
  if (isDressShoeItem(shoes) && isGymShortItem(bottom)) return false;

  if (hasPatternClash(outfit)) return false;

  // Accessory–core coherence. An accessory that overdresses a casual
  // core or clashes with a core piece is worse than no accessory.
  if (accessory) {
    const tF = Number(top.formality_score ?? 5);
    const bF = Number(bottom.formality_score ?? 5);
    const sF = Number(shoes.formality_score ?? 5);
    const avgCoreFormality = (tF + bF + sF) / 3;
    const accF = Number(accessory.formality_score ?? NaN);
    if (
      avgCoreFormality < 4 &&
      Number.isFinite(accF) &&
      accF >= 6
    ) {
      return false;
    }
    if (harmonyScore(accessory, top) < -1.2) return false;
    if (harmonyScore(accessory, bottom) < -1.2) return false;
  }

  return true;
}

/**
 * Structural-only validator. Looser than the full post-assembly pass —
 * accepts soft quality issues (pattern clashes, accessory-core over-
 * dressing, -1.2 harmony threshold) but still rejects structural
 * absurdities. Used by the Tier 4 backfill so "emit 3 at all costs"
 * does not ship catastrophically broken outfits.
 */
export function validateOutfitStructural(outfit: StudioOutfit): boolean {
  const { top, bottom, shoes } = outfit.slots;

  if (isSneakerItem(shoes) && isFormalTrouserItem(bottom)) return false;
  if (isDressShoeItem(shoes) && isGymShortItem(bottom)) return false;

  if (harmonyScore(top, bottom) < -1.5) return false;
  if (harmonyScore(bottom, shoes) < -1.5) return false;
  if (harmonyScore(top, shoes) < -1.5) return false;

  return true;
}
