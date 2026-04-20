/**
 * Stylist Quality Gate — Feature-scoped quality enforcement for AI Stylist Suggestions.
 *
 * Four exports:
 *   1. selectTopOutfitsWithQualityFloor — quality floor wrapper (replaces selectTopOutfits for Stylist only)
 *   2. applyStylistProfileEnhancements  — returns numeric scoreDelta from profile signals
 *   3. filterWardrobeForStylist         — hard-exclude / guaranteed-include learning filter
 *   4. expandStylistAvoidColors         — color family expansion for Stylist avoid-color guard
 *
 * ISOLATION: These functions are called ONLY from the AI Stylist Suggestions path
 * in ai.service.ts. They do NOT modify any shared scoring utilities, styleJudge,
 * eliteScoring, or any other feature's pipeline.
 */

import { scoreOutfit, type JudgeOutfit, type JudgeContext } from './styleJudge';
import type { StyleProfileFields } from './elite/stylistBrain';

// ── Constants ────────────────────────────────────────────────────────────────

const MIN_OK = 60; // high-confidence threshold
const MIN_SHIP = 40; // minimum shippable threshold

// ── Deterministic Hash (Stylist-only) ────────────────────────────────────────

/** Lightweight stable string hash (djb2). Returns non-negative integer. */
function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

// ── Color Family Map (Stylist-only) ─────────────────────────────────────────

const COLOR_FAMILIES: Record<string, string[]> = {
  pink: [
    'pink',
    'fuchsia',
    'magenta',
    'rose',
    'blush',
    'salmon',
    'coral pink',
    'hot pink',
    'dusty pink',
    'mauve',
  ],
  white: [
    'white',
    'ivory',
    'cream',
    'off-white',
    'off white',
    'eggshell',
    'pearl',
    'snow',
  ],
  blue: [
    'blue',
    'navy',
    'cobalt',
    'royal blue',
    'sky blue',
    'light blue',
    'powder blue',
    'steel blue',
    'cornflower',
  ],
  red: [
    'red',
    'crimson',
    'scarlet',
    'cherry',
    'burgundy',
    'maroon',
    'wine',
    'ruby',
    'vermillion',
    'brick red',
  ],
  green: [
    'green',
    'olive',
    'sage',
    'emerald',
    'forest green',
    'hunter green',
    'mint',
    'lime',
    'jade',
    'moss',
    'army green',
    'khaki green',
  ],
  yellow: [
    'yellow',
    'mustard',
    'gold',
    'lemon',
    'canary',
    'marigold',
    'saffron',
    'amber',
  ],
  orange: [
    'orange',
    'tangerine',
    'peach',
    'apricot',
    'rust',
    'burnt orange',
    'terracotta',
    'copper',
  ],
  purple: [
    'purple',
    'violet',
    'plum',
    'lavender',
    'lilac',
    'amethyst',
    'eggplant',
    'aubergine',
    'grape',
    'orchid',
  ],
  brown: [
    'brown',
    'tan',
    'camel',
    'chocolate',
    'espresso',
    'mocha',
    'taupe',
    'cognac',
    'chestnut',
    'walnut',
    'sienna',
  ],
  black: ['black', 'onyx', 'jet black', 'charcoal black'],
  grey: [
    'grey',
    'gray',
    'charcoal',
    'slate',
    'silver',
    'ash',
    'heather grey',
    'heather gray',
    'steel',
  ],
  beige: [
    'beige',
    'nude',
    'sand',
    'oatmeal',
    'khaki',
    'wheat',
    'caramel',
    'buff',
  ],
};

/**
 * Expand avoid_colors using COLOR_FAMILIES for Stylist-only avoid-color matching.
 * Case-insensitive. Does NOT alter canonical color extraction or shared logic.
 */
export function expandStylistAvoidColors(avoidColors: string[]): string[] {
  const expanded = new Set<string>();
  for (const raw of avoidColors) {
    const norm = raw.trim().toLowerCase();
    if (!norm) continue;
    expanded.add(norm);
    for (const members of Object.values(COLOR_FAMILIES)) {
      if (members.includes(norm)) {
        for (const m of members) expanded.add(m);
      }
    }
  }
  const result = [...expanded];
  if (result.length > avoidColors.length) {
    // console.log(
    //   JSON.stringify({
    //     _tag: 'STYLIST_COLOR_FAMILY_EXPANSION',
    //     expandedCount: result.length - avoidColors.length,
    //   }),
    // );
  }
  return result;
}

// ── Types ────────────────────────────────────────────────────────────────────

type Confidence = 'high' | 'medium' | 'low';

interface QualityMetadata {
  qualityScore: number;
  confidence: Confidence;
}

// ── 1. Quality Floor Wrapper ─────────────────────────────────────────────────

/**
 * Scores outfits via styleJudge.scoreOutfit (read-only), applies optional
 * scoreDeltaFn, then enforces a quality floor.
 *
 * Returns 0-3 outfits. If the best candidate is below MIN_SHIP, returns [].
 * Each returned outfit is annotated with qualityScore and confidence metadata.
 */
export function selectTopOutfitsWithQualityFloor<T extends JudgeOutfit>(
  outfits: T[],
  context: JudgeContext = {},
  scoreDeltaFn?: (outfit: T) => number,
): (T & QualityMetadata)[] {
  if (outfits.length === 0) return [];

  // Score every candidate — no upper clamp to preserve ranking resolution
  let epsilonApplied = false;
  const scored = outfits.map((outfit, index) => {
    const baseScore = scoreOutfit(outfit, context).total;
    const delta = scoreDeltaFn ? scoreDeltaFn(outfit) : 0;
    const finalScore = Math.max(0, baseScore + delta);

    // Deterministic micro-tiebreak: stable hash of outfit identity → tiny epsilon
    const outfitKey =
      outfit.id ??
      ((outfit.items ?? []).map((i) => (i as any).id || '').join('|') ||
        `idx-${index}`);
    const idHash = hashString(outfitKey);
    const epsilon = (idHash % 1000) / 100000; // max 0.00999
    const adjustedScore = finalScore + epsilon;
    if (epsilon > 0) epsilonApplied = true;

    return { outfit, index, finalScore, adjustedScore };
  });

  if (epsilonApplied) {
    // console.log(
    //   JSON.stringify({
    //     _tag: 'STYLIST_SCORE_TIE_BREAK_APPLIED',
    //     epsilonApplied: true,
    //   }),
    // );
  }

  // Sort descending by adjustedScore, stable by original index
  scored.sort((a, b) => {
    if (a.adjustedScore !== b.adjustedScore)
      return b.adjustedScore - a.adjustedScore;
    return a.index - b.index;
  });

  // If best candidate is below MIN_SHIP → ship nothing (use finalScore for threshold)
  if (scored[0].finalScore < MIN_SHIP) {
    // console.log(
    //   JSON.stringify({
    //     _tag: 'STYLIST_QUALITY_FLOOR',
    //     candidateCount: outfits.length,
    //     shippedCount: 0,
    //     bestScore: scored[0].finalScore,
    //     reason: 'best_below_min_ship',
    //   }),
    // );
    return [];
  }

  // Filter out candidates below MIN_SHIP (threshold uses finalScore, not epsilon-adjusted)
  const shippable = scored.filter((s) => s.finalScore >= MIN_SHIP);

  // Prefer outfits >= MIN_OK, but include medium-confidence if needed to fill 3
  const highConfidence = shippable.filter((s) => s.finalScore >= MIN_OK);
  const selected =
    highConfidence.length >= 3
      ? highConfidence.slice(0, 3)
      : shippable.slice(0, 3);

  // Percentile-based confidence: uses adjustedScore to reflect tie-broken ranking
  const maxScore = selected[0].adjustedScore;
  const toConfidence = (score: number): Confidence => {
    if (maxScore <= 0) return 'low';
    const ratio = score / maxScore;
    if (ratio >= 0.95) return 'high'; // within 5% of max
    if (ratio >= 0.85) return 'medium'; // within 15% of max
    return 'low';
  };

  const result = selected.map((s) => ({
    ...s.outfit,
    qualityScore: s.adjustedScore,
    confidence: toConfidence(s.adjustedScore),
  }));

  // console.log(
  //   JSON.stringify({
  //     _tag: 'STYLIST_QUALITY_FLOOR',
  //     candidateCount: outfits.length,
  //     shippedCount: result.length,
  //     scores: selected.map((s) => s.adjustedScore),
  //     maxScore,
  //     confidences: result.map((r) => r.confidence),
  //   }),
  // );

  return result;
}

// ── 2. Profile Enhancement Signals ───────────────────────────────────────────

/**
 * Returns a numeric delta based on style profile signals.
 * Fail-open: missing profile field or missing item metadata → 0 adjustment.
 * MUST NOT mutate the outfit object or any scoring attributes.
 */
export function applyStylistProfileEnhancements(
  outfit: JudgeOutfit,
  profile: StyleProfileFields | null | undefined,
): number {
  if (!profile) return 0;

  let delta = 0;
  let footwearComfortHits = 0;
  let footWidthHits = 0;
  let careToleranceHits = 0;
  let metalPreferenceHits = 0;

  for (const item of outfit.items ?? []) {
    const name = (item.name ?? '').toLowerCase();
    const subcategory = (item.subcategory ?? '').toLowerCase();
    const material = (item.material ?? '').toLowerCase();
    const category = (item.category ?? item.main_category ?? '').toLowerCase();

    // Signal: footwear_comfort — "Comfort first" + heel/stiletto shoe
    if (
      profile.footwear_comfort?.toLowerCase() === 'comfort first' &&
      (category === 'shoes' || category === 'footwear')
    ) {
      const heelKeywords = ['heel', 'stiletto', 'pump', 'platform'];
      if (
        heelKeywords.some((kw) => name.includes(kw) || subcategory.includes(kw))
      ) {
        delta -= 5;
        footwearComfortHits++;
      }
    }

    // Signal: foot_width — "Wide" + narrow-cut shoe (pointed toe keywords)
    if (
      profile.foot_width?.toLowerCase() === 'wide' &&
      (category === 'shoes' || category === 'footwear')
    ) {
      const narrowKeywords = ['pointed', 'pointy', 'narrow', 'stiletto'];
      if (
        narrowKeywords.some(
          (kw) => name.includes(kw) || subcategory.includes(kw),
        )
      ) {
        delta -= 3;
        footWidthHits++;
      }
    }

    // Signal: care_tolerance — "Easy care only" + dry-clean-only material
    if (profile.care_tolerance?.toLowerCase() === 'easy care only') {
      const dryCleanKeywords = [
        'silk',
        'cashmere',
        'suede',
        'velvet',
        'dry clean',
        'dry-clean',
      ];
      if (
        dryCleanKeywords.some(
          (kw) => material.includes(kw) || name.includes(kw),
        )
      ) {
        delta -= 3;
        careToleranceHits++;
      }
    }

    // Signal: metal_preference — preference set + accessory metal mismatch
    if (
      profile.metal_preference &&
      profile.metal_preference.toLowerCase() !== 'no preference'
    ) {
      const isAccessory =
        category === 'accessories' ||
        subcategory.includes('jewelry') ||
        subcategory.includes('bracelet') ||
        subcategory.includes('necklace') ||
        subcategory.includes('earring') ||
        subcategory.includes('ring') ||
        subcategory.includes('watch');

      if (isAccessory) {
        const preferredMetal = profile.metal_preference.toLowerCase();
        const itemText = `${name} ${material} ${subcategory}`;
        // Only penalize if we can detect a specific metal that doesn't match
        const metalKeywords = [
          'gold',
          'silver',
          'rose gold',
          'platinum',
          'bronze',
          'copper',
        ];
        const detectedMetal = metalKeywords.find((m) => itemText.includes(m));
        if (detectedMetal && !preferredMetal.includes(detectedMetal)) {
          delta -= 2;
          metalPreferenceHits++;
        }
      }
    }
  }

  if (
    footwearComfortHits +
      footWidthHits +
      careToleranceHits +
      metalPreferenceHits >
    0
  ) {
    console.log(
      JSON.stringify({
        _tag: 'STYLIST_PROFILE_SIGNAL_COUNTS',
        footwearComfortHits,
        footWidthHits,
        careToleranceHits,
        metalPreferenceHits,
        totalDelta: delta,
      }),
    );
  }

  return delta;
}

// ── 3. Learning Filter for LLM Input ─────────────────────────────────────────

/**
 * Filters wardrobe items for the Stylist LLM input:
 *   - Hard-excludes items with feedbackScore <= -2 (strongly disliked)
 *   - Guaranteed-includes items with feedbackScore >= 3 (always in top-50 pool)
 *   - Deterministic, deduped, stable ordering, capped at 50
 *
 * Must be called AFTER weather hard filter and blended score computation,
 * but BEFORE .slice(0, 50).
 *
 * @param items - Array of wardrobe items with __blendedScore and feedbackScore attached
 * @param feedbackScores - Map of itemId → feedbackScore
 * @returns Filtered and capped array of items (max 50)
 */
export function filterWardrobeForStylist<
  T extends { id: string; __blendedScore: number; __weatherScore?: number },
>(
  items: T[],
  feedbackScores: Map<string, number>,
): { filtered: T[]; vetoIds: Set<string> } {
  // Build veto set: items with feedbackScore <= -2
  const vetoIds = new Set<string>();
  for (const [id, score] of feedbackScores) {
    if (score <= -2) vetoIds.add(id);
  }

  // Hard-exclude vetoed items
  const afterExclusion = items.filter((item) => !vetoIds.has(item.id));

  // Items are already sorted by __blendedScore descending (caller handles this)
  // Take the normal top-50
  const top50 = afterExclusion.slice(0, 50);

  // Identify guaranteed items: feedbackScore >= 3 AND passed weather hard filter
  // (items already passed weather filter since they're in the input array)
  const guaranteedItems = afterExclusion.filter(
    (item) => (feedbackScores.get(item.id) ?? 0) >= 3,
  );

  // Find guaranteed items NOT already in top-50
  const top50Ids = new Set(top50.map((item) => item.id));
  const missingGuaranteed = guaranteedItems.filter(
    (item) => !top50Ids.has(item.id),
  );

  // Backfill: evict lowest-ranked non-guaranteed items from tail
  const result = [...top50];
  for (const gItem of missingGuaranteed) {
    if (result.length < 50) {
      // Room available — just append
      result.push(gItem);
      continue;
    }
    // Find the lowest-ranked non-guaranteed item to evict (from the tail)
    for (let i = result.length - 1; i >= 0; i--) {
      const evictScore = feedbackScores.get(result[i].id) ?? 0;
      if (evictScore < 3) {
        // Evict this non-guaranteed item
        result[i] = gItem;
        break;
      }
    }
  }

  const hardExcludedCount = items.length - afterExclusion.length;
  const guaranteedIncludedCount = missingGuaranteed.length;

  // console.log(
  //   JSON.stringify({
  //     _tag: 'STYLIST_LLM_INPUT_PROOF',
  //     total: items.length,
  //     hardExcludedCount,
  //     guaranteedIncludedCount,
  //     resultCount: result.length,
  //   }),
  // );

  return { filtered: result, vetoIds };
}
