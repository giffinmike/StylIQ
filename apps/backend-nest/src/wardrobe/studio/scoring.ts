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

  // Tier-aware item nudges. Bounded, universal, tier-gated only —
  // never per-prompt or per-user. Reinforces the environment-tier
  // physics already applied by the hard gate: pushes appropriate
  // subcategories up and inappropriate ones down so ranking within
  // the surviving pool reflects stylist intent.
  let tierNudge = 0;
  const sub = (item.subcategory ?? '').toLowerCase();
  const dressCode = (item.dress_code ?? '').toLowerCase();

  if (ctx.environmentTier === 'ATHLETIC') {
    const isAthletic =
      /athletic|jersey|tank|tee|t[-\s]?shirt|sweatpant|track|performance|running|sneaker|trainer|\bshorts?\b/.test(
        sub,
      );
    const isTailored =
      /blazer|sport\s*coat|suit|oxford|loafer|derby|trouser|dress\s*pant|slack/.test(
        sub,
      );
    if (isAthletic) tierNudge += 0.6;
    if (isTailored) tierNudge -= 0.6;
  } else if (
    ctx.environmentTier === 'FORMAL_EVENT' ||
    ctx.environmentTier === 'NORMAL'
  ) {
    if (/ultracasual/.test(dressCode)) tierNudge -= 1.0;
  }

  // EXTREME_HEAT environment affinity (generalized, deterministic).
  // Uses only existing StudioItem fields. No name/profile/brand refs.
  let score = 0;
  if (ctx.environmentTier === 'EXTREME_HEAT') {
    const formality = Number(item.formality_score ?? 5);
    const main = item.main_category;
    const subLower = (item.subcategory ?? '').toLowerCase();
    const material = (item.material ?? '').toLowerCase();

    // Reward very casual pieces in extreme heat
    if (formality <= 2) score += 0.8;

    // Reward shorts
    if (main === 'Bottoms' && subLower === 'shorts') {
      score += 1.0;
    }

    // Penalize structured bottoms in extreme heat
    if (main === 'Bottoms' && formality >= 6) {
      score -= 0.6;
    }

    // Penalize heavy fabrics
    if (material.includes('wool') || material.includes('cashmere')) {
      score -= 1.0;
    }
  }

  // Amplify the dominant constraint signal so intent (loafer / sneaker /
  // blazer / brown / dress-code) drives ranking over ambient style
  // noise. Uniform multiplier preserves the original sign + ordering
  // of the shared constraint scorer while widening the spread.
  const CONSTRAINT_AMP = 1.8;
  return (
    constraints * CONSTRAINT_AMP + styleNudge + weatherNudge + tierNudge + score
  );
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

  // Expand the dynamic range so strong outfits separate cleanly from
  // weak ones (typical good score ≈ 5–10, weak ≈ < 2) rather than
  // clustering around ±0.5. Uniform multiplier — signal ordering is
  // preserved, only the spread grows.
  const OUTFIT_AMP = 3;
  let amplified = total * OUTFIT_AMP;

  // Slot-completeness bonus (layer / accessory present when appropriate).
  if (slots.layer) amplified += 0.4;
  if (slots.accessory) amplified += 0.2;

  // Clamp to keep scores interpretable.
  return Math.round(amplified * 100) / 100;
}
