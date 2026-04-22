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

  // Composite aesthetic score: deterministic stylist-level signals on top
  // of per-item ranking. Generalized — no occasion / brand / gender
  // branches. Applied post-amplification at face value so the calibrated
  // deltas below are not scaled by OUTFIT_AMP.
  let aestheticScore = 0;
  const core: StudioItem[] = [slots.top, slots.bottom, slots.shoes];

  // Full-look evaluation set for color harmony, formality cohesion,
  // texture variation, and dress-code coherence. Hero / proportion /
  // athletic / heat signals stay core-only (slot-specific semantics).
  const evalSet: StudioItem[] = [
    slots.top,
    slots.bottom,
    slots.shoes,
    ...(slots.layer ? [slots.layer] : []),
    ...(slots.accessory ? [slots.accessory] : []),
  ];

  // HERO PIECE STRUCTURE
  // A "hero" piece is any item with formality_score >= 7 — matches the
  // definition already used in buildStrictOutfit's triple metadata.
  const heroCount = core.reduce((n, it) => {
    return n + (Number(it.formality_score ?? 0) >= 7 ? 1 : 0);
  }, 0);
  if (ctx.environmentTier === 'FORMAL_EVENT') {
    if (heroCount >= 2) aestheticScore += 1.2;
    else aestheticScore -= 0.8;
  } else {
    if (heroCount === 1) aestheticScore += 1.2;
    else if (heroCount > 1) aestheticScore -= 0.6;
    else aestheticScore -= 0.4;
  }

  // COLOR HARMONY BALANCE
  const NEUTRAL_FAMILIES = new Set([
    'black',
    'white',
    'gray',
    'grey',
    'beige',
    'tan',
    'brown',
    'cream',
    'ivory',
    'khaki',
    'navy',
  ]);
  const evalColors = evalSet.map((it) => {
    const fam = (it.color_family ?? it.color ?? '').toLowerCase().trim();
    return { fam, isNeutral: NEUTRAL_FAMILIES.has(fam) };
  });
  const neutralCount = evalColors.filter((c) => c.isNeutral).length;
  const loudCount = evalColors.filter((c) => c.fam && !c.isNeutral).length;
  if (neutralCount === evalSet.length) {
    aestheticScore -= 0.5;
  } else if (loudCount === 1 && neutralCount === evalSet.length - 1) {
    aestheticScore += 1.0;
  } else if (loudCount >= 2) {
    aestheticScore -= 0.7;
  }

  // FORMALITY COHESION
  const formalities = evalSet.map((it) => Number(it.formality_score ?? 5));
  const formalityDiff =
    Math.max(...formalities) - Math.min(...formalities);
  if (formalityDiff <= 2) aestheticScore += 1.0;
  else if (formalityDiff >= 5) aestheticScore -= 1.2;

  // TEXTURE VARIATION BONUS
  const materials = evalSet.map((it) =>
    (it.material ?? '').toLowerCase().trim(),
  );
  const uniqueMaterials = new Set(materials.filter(Boolean));
  const allCotton =
    materials.length > 0 && materials.every((m) => m === 'cotton');
  if (uniqueMaterials.size > 1 && !allCotton) aestheticScore += 0.6;

  // DRESS-CODE COHERENCE
  // More than two distinct dress codes across the look reads as
  // chaotic (e.g. UltraCasual + Formal + SmartCasual in one outfit).
  const distinctDressCodes = new Set(
    evalSet
      .map((it) => (it.dress_code ?? '').toLowerCase().trim())
      .filter((d) => d.length > 0),
  );
  if (distinctDressCodes.size > 2) {
    aestheticScore -= 1.5;
  }

  // PROPORTION LOGIC
  const topSub = (slots.top.subcategory ?? '').toLowerCase();
  const bottomSub = (slots.bottom.subcategory ?? '').toLowerCase();
  const bottomIsShorts = bottomSub.includes('shorts');
  const topIsOversizedLayer = /hoodie|sweater/.test(topSub);
  const topIsTeeOrTank = /tee|t[-\s]?shirt|tank/.test(topSub);
  if (bottomIsShorts && topIsOversizedLayer) aestheticScore -= 0.6;
  if (bottomIsShorts && topIsTeeOrTank) aestheticScore += 0.6;

  // ATHLETIC FUNCTION BONUS
  const shoesSub = (slots.shoes.subcategory ?? '').toLowerCase();
  if (
    ctx.environmentTier === 'ATHLETIC' &&
    shoesSub.includes('sneakers') &&
    (bottomSub.includes('shorts') || bottomSub.includes('joggers'))
  ) {
    aestheticScore += 1.0;
  }

  // EXTREME_HEAT LIGHTNESS BONUS
  if (ctx.environmentTier === 'EXTREME_HEAT') {
    const hasHeavy = core.some((it) => {
      const m = (it.material ?? '').toLowerCase();
      return m.includes('wool') || m.includes('cashmere');
    });
    if (!hasHeavy && bottomIsShorts) aestheticScore += 0.8;
  }

  // ACCESSORY RESTRAINT BIAS
  // A metal accessory layered onto an already-loud core (more than one
  // non-neutral core item) reads as flashy overload. Penalize.
  if (
    slots.accessory &&
    (slots.accessory.material ?? '').toLowerCase() === 'metal'
  ) {
    let coreLoudCount = 0;
    for (const it of core) {
      const fam = (it.color_family ?? it.color ?? '').toLowerCase().trim();
      if (fam && !NEUTRAL_FAMILIES.has(fam)) coreLoudCount++;
    }
    if (coreLoudCount > 1) {
      aestheticScore -= 0.5;
    }
  }

  // BREAK ASYMMETRY PENALTY
  // Items are individually strong but the composite is negative —
  // "good pieces, bad composition". Amplify the aesthetic penalty so
  // composition failure is not masked by item-level quality.
  if (aestheticScore < 0 && total > 0) {
    aestheticScore *= 1.4;
  }

  const AESTHETIC_AMP = 8;
  amplified += aestheticScore * AESTHETIC_AMP;

  if (process.env.STUDIO_ELITE_AUDIT === 'true') {
    const requestId =
      (ctx as unknown as { requestId?: string }).requestId ?? null;
    console.log('STUDIO_OUTFIT_SCORE_BREAKDOWN', {
      outfitId: requestId,
      tier: ctx.environmentTier,
      topId: slots.top?.id,
      bottomId: slots.bottom?.id,
      shoesId: slots.shoes?.id,
      finalScore: amplified,
    });
    console.log('STUDIO_FOOTWEAR_REALISM', {
      tier: ctx.environmentTier,
      shoeSubcategory: slots.shoes?.subcategory,
      shoeMaterial: slots.shoes?.material,
      shoeFormality: slots.shoes?.formality_score,
    });
  }

  // Clamp to keep scores interpretable.
  return Math.round(amplified * 100) / 100;
}
