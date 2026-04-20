// apps/backend-nest/src/wardrobe/studio/orchestrator.ts
//
// Drives the strict deterministic builder to produce EXACTLY 3 outfits.
// No padding, no silent degradation. Final validation log is printed
// before returning; any slot invariant failure throws.

import {
  StudioInvariantError,
  type StudioBuildContext,
  type StudioItem,
  type StudioOutfit,
} from './types';
import { buildStrictOutfit } from './buildStrictOutfit';
import {
  applyEnvironmentalHardGate,
  deriveEnvironmentTier,
  filterCandidatePool,
  partitionBySlot,
} from './filters';
import { scoreStudioItem } from './scoring';

const TARGET_OUTFITS = 3;

export interface OrchestratorMeta {
  requestId: string;
  userId: string;
}

/**
 * Run the Studio orchestrator over a (reranked, retrieval-layer) catalog.
 * Returns exactly 3 outfits or throws `StudioInvariantError`.
 */
export function runStudioOrchestrator(
  catalog: StudioItem[],
  ctx: StudioBuildContext,
  meta: OrchestratorMeta,
): StudioOutfit[] {
  // Stage 1: aesthetic / presentation / style-profile hard filters.
  const filteredPool = filterCandidatePool(catalog, ctx);

  // Derive the environment tier ONCE and enrich the context so downstream
  // scoring can adjust behavior (e.g. cap negative shoe scoring in
  // EXTREME_HEAT) without re-deriving the tier per item.
  const environmentTier = deriveEnvironmentTier(ctx);
  const enrichedCtx: StudioBuildContext = { ...ctx, environmentTier };

  // Stage 2: physics-dominant feasibility hard gate. Runs BEFORE scoring,
  // compatibility, and slot partitioning. Universal across all users —
  // no profile-specific branches. Priority: Physics > Occasion > Style.
  let pool = applyEnvironmentalHardGate(filteredPool, enrichedCtx);

  // First partition the gated pool
  let partitioned = partitionBySlot(pool);

  // Scoped shoe restoration: only in EXTREME_HEAT or NORMAL tiers. In
  // HEAT, the hard gate can legitimately strip every leather/formal
  // shoe; NORMAL should never empty the slot in practice but we keep
  // the safety net. Restoration is deliberately skipped in EXTREME_COLD
  // / ATHLETIC / FORMAL_EVENT — those tiers strip shoes for physics
  // reasons (sandals in snow, dress shoes in the gym, sneakers in black
  // tie) and re-introducing them would undermine stylist quality.
  //
  // Restoration draws from the ORIGINAL catalog (not filteredPool),
  // because aesthetic filters can themselves strip the last surviving
  // pair — the invariant here is "the user owns at least one shoe",
  // and the original catalog is the only authoritative answer.
  if (
    partitioned.shoes.length === 0 &&
    (environmentTier === 'EXTREME_HEAT' || environmentTier === 'NORMAL')
  ) {
    console.warn(
      '[STUDIO] No shoes after gating — restoring from original catalog',
      { tier: environmentTier },
    );

    const originalPartitioned = partitionBySlot(catalog);

    if (originalPartitioned.shoes.length > 0) {
      pool = [...pool, ...originalPartitioned.shoes];
      partitioned = partitionBySlot(pool);
    }

    // Final safety fallback: if partitioning still reports zero shoes
    // (e.g. the original catalog contains a shoe that the strict
    // partition missed due to taxonomy drift), forcibly inject the
    // highest-ranked shoe-like item from the original catalog. This
    // keeps the invariant unreachable unless the user truly owns zero
    // shoes. Uses scoreStudioItem so the injected pair is the best
    // available, not arbitrary.
    if (partitioned.shoes.length === 0 && originalPartitioned.shoes.length > 0) {
      const ranked = [...originalPartitioned.shoes].sort(
        (a, b) => scoreStudioItem(b, enrichedCtx) - scoreStudioItem(a, enrichedCtx),
      );
      const forced = ranked[0];
      console.warn('[STUDIO] Forcing shoe injection', {
        tier: environmentTier,
        id: forced.id,
        label: forced.label,
      });
      pool = [...pool, forced];
      partitioned = partitionBySlot(pool);
    }
  }

  // Fast-fail diagnostics: detect the most common wardrobe gaps upfront
  // with actionable error codes so the controller can surface them.
  if (partitioned.tops.length === 0) {
    throw new StudioInvariantError(
      'WARDROBE_INSUFFICIENT_TOPS',
      'AI Outfit Studio requires at least one top in your wardrobe',
    );
  }
  if (partitioned.bottoms.length === 0) {
    throw new StudioInvariantError(
      'WARDROBE_INSUFFICIENT_BOTTOMS',
      'AI Outfit Studio requires at least one bottom in your wardrobe',
    );
  }
  if (partitioned.shoes.length === 0) {
    throw new StudioInvariantError(
      'WARDROBE_INSUFFICIENT_SHOES',
      'AI Outfit Studio requires at least one pair of shoes in your wardrobe',
    );
  }

  const outfits: StudioOutfit[] = [];
  const excludeTops = new Set<string>();
  const excludeBottoms = new Set<string>();
  const excludeShoes = new Set<string>();
  const excludeLayer = new Set<string>();
  const excludeAccessory = new Set<string>();

  // Reuse thresholds: if the wardrobe is smaller than the target slate,
  // allow reusing a mandatory slot — but record it for diagnostics.
  const needsTopReuse = partitioned.tops.length < TARGET_OUTFITS;
  const needsBottomReuse = partitioned.bottoms.length < TARGET_OUTFITS;
  const needsShoesReuse = partitioned.shoes.length < TARGET_OUTFITS;
  const allowMandatoryReuse =
    needsTopReuse || needsBottomReuse || needsShoesReuse;

  for (let i = 0; i < TARGET_OUTFITS; i++) {
    const { outfit, usedIds } = buildStrictOutfit(pool, enrichedCtx, {
      excludeTopIds: excludeTops,
      excludeBottomIds: excludeBottoms,
      excludeShoesIds: excludeShoes,
      excludeLayerIds: excludeLayer,
      excludeAccessoryIds: excludeAccessory,
      allowMandatoryReuse,
      slateIndex: i + 1,
    });

    // Track diversity: never reuse a top across outfits unless wardrobe
    // literally cannot support it.
    excludeTops.add(outfit.slots.top.id);
    excludeBottoms.add(outfit.slots.bottom.id);
    excludeShoes.add(outfit.slots.shoes.id);
    if (outfit.slots.layer) excludeLayer.add(outfit.slots.layer.id);
    if (outfit.slots.accessory) excludeAccessory.add(outfit.slots.accessory.id);

    // Also record every other item in the used set so diversity signals
    // get the full picture even for optional slots.
    for (const id of usedIds) {
      // no-op; kept for future soft-penalty hooks
    }

    outfits.push(outfit);
  }

  // Final slot validation gate — this is the user-requested critical debug
  // step. Every outfit MUST report hasTop/hasBottom/hasShoes = true.
  const validation = outfits.map((o) => ({
    hasTop: !!o.slots.top,
    hasBottom: !!o.slots.bottom,
    hasShoes: !!o.slots.shoes,
  }));
  console.log('AI_OUTFIT_STUDIO_SLOT_VALIDATION:', validation);

  for (let i = 0; i < outfits.length; i++) {
    const v = validation[i];
    if (!v.hasTop || !v.hasBottom || !v.hasShoes) {
      throw new StudioInvariantError(
        'STUDIO_SLOT_INVARIANT_FAILED',
        `Studio outfit ${i} missing mandatory slot after assembly`,
        { validation, requestId: meta.requestId, userId: meta.userId },
      );
    }
  }

  if (outfits.length !== TARGET_OUTFITS) {
    throw new StudioInvariantError(
      'STUDIO_SLOT_INVARIANT_FAILED',
      `Studio produced ${outfits.length} outfits; expected ${TARGET_OUTFITS}`,
      { requestId: meta.requestId, userId: meta.userId },
    );
  }

  // Single-line diagnostic summary: enough to reproduce any future
  // quality regression (tier, pool counts, chosen item IDs, scores)
  // without flooding logs. Safe for production — one log per request.
  console.log('AI_OUTFIT_STUDIO_RESULT:', {
    requestId: meta.requestId,
    userId: meta.userId,
    tier: environmentTier,
    counts: {
      catalog: catalog.length,
      filtered: filteredPool.length,
      gated: pool.length,
      tops: partitioned.tops.length,
      bottoms: partitioned.bottoms.length,
      shoes: partitioned.shoes.length,
      outerwear: partitioned.outerwear.length,
      accessories: partitioned.accessories.length,
    },
    outfits: outfits.map((o) => ({
      id: o.outfit_id,
      score: o.score,
      slots: {
        top: o.slots.top.id,
        bottom: o.slots.bottom.id,
        shoes: o.slots.shoes.id,
        layer: o.slots.layer?.id ?? null,
        accessory: o.slots.accessory?.id ?? null,
      },
    })),
  });

  return outfits;
}
