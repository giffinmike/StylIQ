/**
 * FAST-scoped Learning Signal Loader + Boost Layer
 *
 * Bypasses LEARNING_FLAGS.STATE_ENABLED to load user_fashion_state
 * directly for the Outfit Studio FAST path only.
 *
 * Locked modules are NOT modified:
 *   eliteScoring, styleJudge, tasteValidator, styleVeto,
 *   stylistQualityGate, composition, discover-veto, discover-curator,
 *   learning-events.service.
 */

import { pool } from '../db/pool';
import {
  type FashionStateSummary,
  type UserFashionState,
  type ScoreMap,
  createStateSummary,
  getTopN,
} from '../learning/dto/fashion-state.dto';

// ── Types ───────────────────────────────────────────────────────────────────

export interface FastLearningSignals {
  /** Lightweight summary for injection into elitePostProcessOutfits context */
  summary: FashionStateSummary;

  /** Top/bottom 2 materials from learning-derived materialScores */
  materialAffinity: { top: string[]; bottom: string[] };

  /** Most frequent occasion from learning-derived occasionFrequency */
  dominantOccasion: string | null;

  /** Count of non-zero score entries across all score maps */
  signalCount: number;
}

export interface BoostEntry {
  outfitIndex: number;
  reason: string;
  delta: number;
}

export interface FastBoostResult<T> {
  outfits: T[];
  boostLog: BoostEntry[];
}

// ── Occasion → Formality Tier Map ───────────────────────────────────────────

const OCCASION_FORMALITY: Record<string, number> = {
  athletic: 0,
  casual: 1,
  'smart-casual': 2,
  'smart casual': 2,
  business: 3,
  'business casual': 2,
  formal: 4,
  evening: 4,
  cocktail: 3,
  weekend: 1,
  date: 3,
  work: 3,
  lounge: 0,
};

// ── Loader ──────────────────────────────────────────────────────────────────

const FAST_LOADER_TIMEOUT_MS = 100;

/**
 * Load learning signals directly from user_fashion_state, bypassing
 * the STATE_ENABLED feature flag. FAST-path only.
 *
 * Returns null if:
 * - No row exists for the user
 * - User is in cold start (< 10 explicit events)
 * - DB query fails or times out
 */
export async function loadFastLearningSignals(
  userId: string,
): Promise<FastLearningSignals | null> {
  try {
    const fetchPromise = pool.query(
      `SELECT
        user_id, brand_scores, color_scores, category_scores,
        style_scores, material_scores, tag_scores, fit_issues,
        avg_purchase_price, price_bracket, occasion_frequency,
        events_processed_count, is_cold_start, last_computed_at,
        state_version
      FROM user_fashion_state
      WHERE user_id = $1`,
      [userId],
    );

    const timeoutPromise = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), FAST_LOADER_TIMEOUT_MS),
    );

    const result = await Promise.race([fetchPromise, timeoutPromise]);

    if (!result || !('rows' in result) || result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];

    // Cold start: skip — existing styleProfile scoring handles these users
    if (row.is_cold_start === true) {
      return null;
    }

    // Build UserFashionState for createStateSummary()
    const state: UserFashionState = {
      userId: row.user_id,
      brandScores: row.brand_scores || {},
      colorScores: row.color_scores || {},
      categoryScores: row.category_scores || {},
      styleScores: row.style_scores || {},
      materialScores: row.material_scores || {},
      tagScores: row.tag_scores || {},
      fitIssues: row.fit_issues || {},
      avgPurchasePrice: row.avg_purchase_price
        ? parseFloat(row.avg_purchase_price)
        : null,
      priceBracket: row.price_bracket,
      occasionFrequency: row.occasion_frequency || {},
      eventsProcessedCount: row.events_processed_count || 0,
      isColdStart: false, // Already checked above
      lastComputedAt: new Date(row.last_computed_at),
      stateVersion: row.state_version || 1,
    };

    const summary = createStateSummary(state);

    // Material affinity: top 2 positive + bottom 2 negative
    const materialTop = getTopN(state.materialScores, 2, 'positive');
    const materialBottom = getTopN(state.materialScores, 2, 'negative');

    // Dominant occasion: highest frequency
    const dominantOccasion = pickDominantOccasion(state.occasionFrequency);

    // Signal count: all non-zero entries across score maps
    const signalCount = countNonZeroScores([
      state.brandScores,
      state.colorScores,
      state.categoryScores,
      state.styleScores,
      state.materialScores,
    ]);

    return {
      summary,
      materialAffinity: { top: materialTop, bottom: materialBottom },
      dominantOccasion,
      signalCount,
    };
  } catch {
    // Fail-open: no signals on any error
    return null;
  }
}

// ── Boost Layer ─────────────────────────────────────────────────────────────

const MATERIAL_TOP_BOOST = 4;
const MATERIAL_BOTTOM_PENALTY = -6;
const OCCASION_ALIGNMENT_BOOST = 3;
const BOOST_FLOOR = -15;
const BOOST_CEILING = 15;

/**
 * Apply FAST-local learning boost to outfit candidates.
 * Called AFTER elitePostProcessOutfits reranking, BEFORE final return.
 *
 * Boost rules:
 *   Material affinity:  +4 if any outfit item material in top 2
 *                       -6 if any outfit item material in bottom 2
 *   Occasion alignment: +3 if outfit avg formality matches dominant occasion tier
 *
 * Total boost clamped to [-15, +15]. Deterministic stable sort.
 */
export function applyFastLearningBoost<T extends { items?: any[] }>(
  outfits: T[],
  signals: FastLearningSignals,
): FastBoostResult<T> {
  if (outfits.length <= 1) {
    return { outfits, boostLog: [] };
  }

  const boostLog: BoostEntry[] = [];
  const topMaterials = new Set(
    signals.materialAffinity.top.map((m) => m.toLowerCase()),
  );
  const bottomMaterials = new Set(
    signals.materialAffinity.bottom.map((m) => m.toLowerCase()),
  );
  const dominantFormalityTier =
    signals.dominantOccasion !== null
      ? (OCCASION_FORMALITY[signals.dominantOccasion.toLowerCase()] ?? null)
      : null;

  const scored = outfits.map((outfit, idx) => {
    let totalBoost = 0;
    const items: any[] = outfit.items ?? [];

    // Material affinity (per outfit, not stacking per item)
    let materialMatched = false;
    let materialPenalized = false;
    for (const item of items) {
      const mat = normalizeString(item.material);
      if (!mat) continue;
      if (!materialMatched && topMaterials.has(mat)) {
        totalBoost += MATERIAL_TOP_BOOST;
        materialMatched = true;
        boostLog.push({
          outfitIndex: idx,
          reason: `material_affinity_top:${mat}`,
          delta: MATERIAL_TOP_BOOST,
        });
      }
      if (!materialPenalized && bottomMaterials.has(mat)) {
        totalBoost += MATERIAL_BOTTOM_PENALTY;
        materialPenalized = true;
        boostLog.push({
          outfitIndex: idx,
          reason: `material_affinity_bottom:${mat}`,
          delta: MATERIAL_BOTTOM_PENALTY,
        });
      }
    }

    // Occasion alignment
    if (dominantFormalityTier !== null && items.length > 0) {
      const avgFormality = computeAvgFormality(items);
      if (avgFormality !== null) {
        const distance = Math.abs(avgFormality - dominantFormalityTier);
        if (distance <= 1) {
          totalBoost += OCCASION_ALIGNMENT_BOOST;
          boostLog.push({
            outfitIndex: idx,
            reason: `occasion_alignment:${signals.dominantOccasion}`,
            delta: OCCASION_ALIGNMENT_BOOST,
          });
        }
      }
    }

    // Clamp
    totalBoost = Math.max(BOOST_FLOOR, Math.min(BOOST_CEILING, totalBoost));

    return { outfit, idx, totalBoost };
  });

  // Stable sort: higher boost first, original index as tiebreaker
  scored.sort((a, b) =>
    a.totalBoost !== b.totalBoost ? b.totalBoost - a.totalBoost : a.idx - b.idx,
  );

  return {
    outfits: scored.map((s) => s.outfit),
    boostLog,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function normalizeString(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  return v.trim().toLowerCase();
}

function computeAvgFormality(items: any[]): number | null {
  let sum = 0;
  let count = 0;
  for (const item of items) {
    const fs = item.formality_score;
    if (typeof fs === 'number' && isFinite(fs)) {
      sum += fs;
      count++;
    }
  }
  return count > 0 ? sum / count : null;
}

function pickDominantOccasion(freq: ScoreMap): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [occasion, count] of Object.entries(freq)) {
    if (count > bestCount) {
      bestCount = count;
      best = occasion;
    }
  }
  return best;
}

function countNonZeroScores(maps: ScoreMap[]): number {
  let count = 0;
  for (const map of maps) {
    for (const val of Object.values(map)) {
      if (val !== 0) count++;
    }
  }
  return count;
}
