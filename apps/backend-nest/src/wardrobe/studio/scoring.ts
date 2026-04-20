// apps/backend-nest/src/wardrobe/studio/scoring.ts
//
// Studio-local item + outfit scoring. Read-only. No mutation.
// Reuses the (already Studio-only) wardrobe/logic/scoring.ts module for
// constraints/style/weather item scoring — that module is consumed
// exclusively by wardrobe.service.ts, so it is safe to call.

import { scoreItemForConstraints } from '../logic/scoring';
import { mapMainCategoryToSlot } from '../logic/categoryMapping';
import type { StudioItem, StudioBuildContext, StudioSlots } from './types';

/**
 * Item-level preference score. Larger is better. Pure function of the
 * item + context. Used to rank candidates within a slot.
 */
export function scoreStudioItem(
  item: StudioItem,
  ctx: StudioBuildContext,
): number {
  // Constraints layer (loafer/sneaker/brown/dress-code intent).
  let constraints = scoreItemForConstraints(
    {
      index: 0,
      id: item.id,
      label: item.label,
      main_category: item.main_category,
      subcategory: item.subcategory,
      color: item.color,
      color_family: item.color_family,
      shoe_style: item.shoe_style,
      dress_code: item.dress_code,
      formality_score: item.formality_score,
    },
    ctx.parsedConstraints,
    0,
  );

  // EXTREME_HEAT shoe-scoring floor. Formal leather shoes are already
  // removed by the environmental hard gate; here we prevent ultra-casual
  // footwear (sneakers/sandals) from collapsing below -0.5 under
  // constraint scoring so at least some shoes survive into assembly.
  // Scoped strictly to tier === 'EXTREME_HEAT' and slot === 'shoes' —
  // no effect on other tiers or slots, no change to styleScore/weights.
  if (
    ctx.environmentTier === 'EXTREME_HEAT' &&
    mapMainCategoryToSlot(item.main_category) === 'shoes' &&
    constraints < -0.5
  ) {
    constraints = -0.5;
  }

  // Style-profile color preferences: additive small nudge.
  let styleNudge = 0;
  const favoriteColors = ctx.styleProfile?.favorite_colors ?? [];
  if (favoriteColors.length) {
    const haystack =
      (item.color ?? item.color_family ?? item.label ?? '').toLowerCase();
    for (const fc of favoriteColors) {
      const needle = (fc || '').toLowerCase().trim();
      if (needle && haystack.includes(needle)) {
        styleNudge += 0.15;
        break;
      }
    }
  }

  const preferredBrands = ctx.styleProfile?.preferred_brands ?? [];
  if (preferredBrands.length && item.brand) {
    const brand = item.brand.toLowerCase();
    for (const pb of preferredBrands) {
      if (brand.includes((pb || '').toLowerCase())) {
        styleNudge += 0.1;
        break;
      }
    }
  }

  // Weather temperature alignment (simple delta).
  let weatherNudge = 0;
  const tempF = ctx.weather?.tempF;
  if (typeof tempF === 'number') {
    const layering = (item.layering ?? '').toLowerCase();
    if (tempF >= 78 && layering === 'outer') weatherNudge -= 0.4;
    if (tempF <= 45 && layering === 'outer') weatherNudge += 0.2;
  }

  return constraints + styleNudge + weatherNudge;
}

/**
 * Outfit-level score. Combines per-slot item scores with slot-presence
 * bonuses. Used for final ranking of the 3 outfits. Read-only.
 */
export function scoreStudioOutfit(
  slots: StudioSlots,
  ctx: StudioBuildContext,
): number {
  const items = [
    slots.top,
    slots.bottom,
    slots.shoes,
    slots.layer,
    slots.accessory,
  ].filter((i): i is StudioItem => !!i);

  let total = 0;
  for (const item of items) {
    total += scoreStudioItem(item, ctx);
  }

  // Slot-completeness bonus (layer / accessory present when appropriate).
  if (slots.layer) total += 0.2;
  if (slots.accessory) total += 0.1;

  // Clamp to keep scores interpretable.
  return Math.round(total * 100) / 100;
}
