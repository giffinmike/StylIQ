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
  filterCandidatePool,
  partitionBySlot,
} from './filters';

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

  // Stage 2: physics-dominant feasibility hard gate. Runs BEFORE scoring,
  // compatibility, and slot partitioning. Universal across all users —
  // no profile-specific branches. Priority: Physics > Occasion > Style.
  const gatedPool = applyEnvironmentalHardGate(filteredPool, ctx);

  const pool = gatedPool;

  // Fast-fail diagnostics: detect the most common wardrobe gaps upfront
  // with actionable error codes so the controller can surface them.
  const partitioned = partitionBySlot(pool);
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
    const { outfit, usedIds } = buildStrictOutfit(pool, ctx, {
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

  return outfits;
}
