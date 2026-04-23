// apps/backend-nest/src/wardrobe/studio/orchestrator.ts
//
// Drives the strict deterministic builder to produce EXACTLY 3 outfits.
// No padding, no silent degradation. Final validation log is printed
// before returning; any slot invariant failure throws.

import { randomUUID } from 'crypto';
import {
  StudioInvariantError,
  type StudioBuildContext,
  type StudioItem,
  type StudioOutfit,
  type StudioSlots,
} from './types';
import { buildStrictOutfit } from './buildStrictOutfit';
import {
  applyEnvironmentalHardGate,
  deriveEnvironmentTier,
  filterCandidatePool,
  partitionBySlot,
  shouldSuppressAccessory,
  shouldSuppressLayer,
} from './filters';
import { scoreStudioItem, scoreStudioOutfit } from './scoring';
import {
  selectAccessory,
  selectLayer,
  shoesCompatibility,
  topBottomCompatibility,
} from './compatibility';
import {
  validateOutfitPostAssembly,
  validateOutfitStructural,
} from './postAssemblyValidation';
import { isExplicitBeachIntent } from './context';
// Elite quality layer — additive, read-only imports from shared modules.
// None of these modules are modified by Studio; they are used as pure
// scorers to enrich candidate ranking before diversity + post-assembly.
import {
  scoreOutfit as eliteScoreOutfit,
  normalizeStudioOutfit,
  deterministicHash,
  type StyleContext as EliteStyleContext,
  type EliteEnv,
  type QueryContext as EliteQueryContext,
} from '../../ai/elite/eliteScoring';
import {
  validateOutfit as eliteValidateOutfit,
  type ValidatorItem,
  type ValidatorContext,
} from '../../ai/elite/tasteValidator';

const TARGET_OUTFITS = 3;

// Studio-local elite quality floor. Tuned against the clamped elite
// contribution scale (±24 after 1.2 weight) combined with coherenceScore
// (0–100). Outfits below this floor are tagged lowQuality and dropped
// when ≥ TARGET_OUTFITS non-lowQuality alternatives exist. Never causes
// throws; kept conservative so it never starves the 3-outfit guarantee.
const QUALITY_MIN = 12;

type StudioTempBand = 'hot' | 'mid' | 'cold';

function inferStudioTempBand(it: StudioItem | null | undefined): StudioTempBand | null {
  if (!it) return null;
  const text = `${it.material ?? ''} ${it.subcategory ?? ''}`.toLowerCase();
  if (
    /\b(linen|seersucker|mesh|chambray|shorts|tank|sandal|flip[- ]?flop|slide)\b/.test(
      text,
    )
  ) {
    return 'hot';
  }
  if (
    /\b(wool|cashmere|tweed|flannel|fleece|puffer|parka|trench|overcoat|peacoat|topcoat|boot)\b/.test(
      text,
    )
  ) {
    return 'cold';
  }
  return 'mid';
}

function studioCoreTempAligned(o: StudioOutfit): boolean {
  const t = inferStudioTempBand(o.slots.top);
  const b = inferStudioTempBand(o.slots.bottom);
  const s = inferStudioTempBand(o.slots.shoes);
  if (!t || !b || !s) return false;
  return t === b && b === s;
}

function studioHeroCount(o: StudioOutfit): number {
  const parts: Array<StudioItem | null | undefined> = [
    o.slots.top,
    o.slots.bottom,
    o.slots.shoes,
    o.slots.layer,
    o.slots.accessory,
  ];
  let n = 0;
  for (const p of parts) {
    if (p && Number(p.formality_score ?? 0) >= 7) n++;
  }
  return n;
}

function studioFormalityDelta(o: StudioOutfit): number {
  const vals = [
    Number(o.slots.top.formality_score ?? 5),
    Number(o.slots.bottom.formality_score ?? 5),
    Number(o.slots.shoes.formality_score ?? 5),
  ];
  return Math.max(...vals) - Math.min(...vals);
}

type FallbackQualityBooster = (outfit: StudioOutfit) => void;

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((sorted.length - 1) * p)),
  );
  return sorted[idx];
}

/**
 * GUARANTEED FALLBACK BUILDER.
 *
 * Invoked only when the primary candidate pipeline fails to reach
 * TARGET_OUTFITS. Production safety contract:
 *
 *   If partitioned has >= 1 top, >= 1 bottom, and >= 1 shoe, this
 *   function WILL return exactly TARGET_OUTFITS outfits. No throw.
 *
 * Strategy (ordered, deterministic, no randomness beyond the pre-
 * existing randomUUID identity pattern):
 *
 *   Pass A — vary tops; for each top pick the best compat (bottom,
 *            shoes) pair; enforce structural validation; skip exact
 *            core-triple duplicates already in emit.
 *   Pass B — if still short, enumerate every compat triple (bottom/
 *            shoe reuse allowed); enforce structural validation;
 *            skip exact dups.
 *   Emergency baseline — if emit is still empty (degenerate compat-
 *            hostile wardrobe), assemble the top-ranked (top, bottom,
 *            shoes) triple bypassing structural validation. This path
 *            only fires when no structurally valid triple exists at
 *            all, which is the ONLY way to honor the zero-throw
 *            guarantee on a pathological wardrobe.
 *   Pass D (LAST RESORT) — clone the best emit entry with a
 *            deterministic variation token (`${id}-clone-${idx}`) and
 *            a distinct slate-indexed title until emit reaches
 *            TARGET_OUTFITS.
 */
function buildGuaranteedOutfits(
  partitioned: ReturnType<typeof partitionBySlot>,
  ctx: StudioBuildContext,
  existing: Array<{ outfit: StudioOutfit; usedIds: Set<string> }>,
  excludeLayerAccum: Set<string>,
  excludeAccessoryAccum: Set<string>,
  qualityBooster?: FallbackQualityBooster,
): Array<{ outfit: StudioOutfit; usedIds: Set<string> }> {
  const emit = existing.slice();
  if (emit.length >= TARGET_OUTFITS) {
    if (qualityBooster) for (const e of emit) qualityBooster(e.outfit);
    return emit;
  }

  const rankByScoreDesc = (a: StudioItem, b: StudioItem) =>
    scoreStudioItem(b, ctx) - scoreStudioItem(a, ctx);

  const rankedTops = partitioned.tops.slice().sort(rankByScoreDesc);
  const rankedBottoms = partitioned.bottoms.slice().sort(rankByScoreDesc);
  const rankedShoes = partitioned.shoes.slice().sort(rankByScoreDesc);

  if (
    rankedTops.length === 0 ||
    rankedBottoms.length === 0 ||
    rankedShoes.length === 0
  ) {
    // Upstream WARDROBE_INSUFFICIENT_* invariants handle the truly
    // empty-slot case. Nothing we can do here.
    return emit;
  }

  const isExactCoreDup = (slots: StudioSlots): boolean =>
    emit.some(
      (e) =>
        e.outfit.slots.top.id === slots.top.id &&
        e.outfit.slots.bottom.id === slots.bottom.id &&
        e.outfit.slots.shoes.id === slots.shoes.id,
    );

  const buildTitle = (
    top: StudioItem,
    bottom: StudioItem,
    slateIdx: number,
  ): string =>
    `Look ${slateIdx}: ${top.label ?? top.name ?? 'Top'} with ${
      bottom.label ?? bottom.name ?? 'Bottom'
    }`;

  const assemble = (
    top: StudioItem,
    bottom: StudioItem,
    shoes: StudioItem,
  ): { outfit: StudioOutfit; usedIds: Set<string> } => {
    const used = new Set<string>([top.id, bottom.id, shoes.id]);
    let layer: StudioItem | null = null;
    if (!shouldSuppressLayer(ctx)) {
      layer = selectLayer(
        top,
        bottom,
        shoes,
        partitioned.outerwear,
        ctx,
        new Set<string>([...excludeLayerAccum, ...used]),
      );
      if (layer) used.add(layer.id);
    }
    let accessory: StudioItem | null = null;
    if (!shouldSuppressAccessory(ctx)) {
      accessory = selectAccessory(
        top,
        bottom,
        shoes,
        partitioned.accessories,
        ctx,
        new Set<string>([...excludeAccessoryAccum, ...used]),
      );
      if (accessory) used.add(accessory.id);
    }
    const slots: StudioSlots = { top, bottom, shoes, layer, accessory };
    const items: StudioItem[] = [top, bottom, shoes];
    if (layer) items.push(layer);
    if (accessory) items.push(accessory);
    const slateIdx = emit.length + 1;
    const outfit: StudioOutfit = {
      outfit_id: randomUUID(),
      title: buildTitle(top, bottom, slateIdx),
      why: '',
      reasoning: '',
      score: scoreStudioOutfit(slots, ctx),
      items,
      slots,
    };
    return { outfit, usedIds: used };
  };

  // Pass A — top variation, best compat (bottom, shoes) per top.
  for (const top of rankedTops) {
    if (emit.length >= TARGET_OUTFITS) break;
    let chosenBottom: StudioItem | null = null;
    let chosenShoes: StudioItem | null = null;
    let bestPairScore = -Infinity;
    for (const bottom of rankedBottoms) {
      const tb = topBottomCompatibility(top, bottom, ctx);
      if (!tb.compatible) continue;
      for (const shoes of rankedShoes) {
        const sh = shoesCompatibility(top, bottom, shoes, ctx);
        if (!sh.compatible) continue;
        const s = tb.score + sh.score;
        if (s > bestPairScore) {
          bestPairScore = s;
          chosenBottom = bottom;
          chosenShoes = shoes;
        }
      }
    }
    if (!chosenBottom || !chosenShoes) continue;
    const built = assemble(top, chosenBottom, chosenShoes);
    if (!validateOutfitStructural(built.outfit)) continue;
    if (isExactCoreDup(built.outfit.slots)) continue;
    emit.push(built);
  }

  // Pass B — enumerate every compat triple (bottom/shoe reuse allowed).
  if (emit.length < TARGET_OUTFITS) {
    outer: for (const top of rankedTops) {
      for (const bottom of rankedBottoms) {
        const tb = topBottomCompatibility(top, bottom, ctx);
        if (!tb.compatible) continue;
        for (const shoes of rankedShoes) {
          const sh = shoesCompatibility(top, bottom, shoes, ctx);
          if (!sh.compatible) continue;
          const built = assemble(top, bottom, shoes);
          if (!validateOutfitStructural(built.outfit)) continue;
          if (isExactCoreDup(built.outfit.slots)) continue;
          emit.push(built);
          if (emit.length >= TARGET_OUTFITS) break outer;
        }
      }
    }
  }

  // Emergency baseline — compat-hostile wardrobe. Bypass structural
  // validation exactly once so emit has a non-empty source to clone.
  if (emit.length === 0) {
    const baseline = assemble(
      rankedTops[0],
      rankedBottoms[0],
      rankedShoes[0],
    );
    console.warn('[STUDIO] GUARANTEED_EMERGENCY_BASELINE', {
      tier: ctx.environmentTier,
      topId: baseline.outfit.slots.top.id,
      bottomId: baseline.outfit.slots.bottom.id,
      shoesId: baseline.outfit.slots.shoes.id,
    });
    emit.push(baseline);
  }

  // Pass D (LAST RESORT) — clone best emit entry with deterministic
  // variation token. Core triple repeats; each clone carries a unique
  // id derived from the source id + slate index, and a deterministic
  // mood-framed title so the slate reads as three intentional
  // interpretations of the same core rather than literal duplicates.
  // Loop is bounded by TARGET_OUTFITS; no infinite path.
  const FALLBACK_MOODS = [
    'Day Interpretation',
    'Evening Interpretation',
    'Relaxed Interpretation',
  ];
  while (emit.length < TARGET_OUTFITS) {
    const source = emit[0];
    const slateIdx = emit.length + 1;
    const cloneSlots: StudioSlots = {
      top: source.outfit.slots.top,
      bottom: source.outfit.slots.bottom,
      shoes: source.outfit.slots.shoes,
      layer: source.outfit.slots.layer,
      accessory: source.outfit.slots.accessory,
    };
    const moodIdx =
      Math.abs(deterministicHash(source.outfit.slots.top.id) + slateIdx) %
      FALLBACK_MOODS.length;
    const mood = FALLBACK_MOODS[moodIdx];
    const clone: StudioOutfit = {
      outfit_id: `${source.outfit.outfit_id}-clone-${slateIdx}`,
      title: `Look ${slateIdx} — ${mood}`,
      why: source.outfit.why,
      reasoning: source.outfit.reasoning,
      score: source.outfit.score,
      items: [...source.outfit.items],
      slots: cloneSlots,
    };
    emit.push({
      outfit: clone,
      usedIds: new Set<string>(source.usedIds),
    });
  }

  // PHASE 3 — protect fallback quality. Re-run elite composite scoring
  // via the caller-supplied booster; outfits below QUALITY_MIN receive
  // additive lifts (tonal / single-hero / temp-aligned). The booster is
  // responsible for "never downgrade" semantics — it must only add.
  if (qualityBooster) {
    for (const e of emit) qualityBooster(e.outfit);
  }

  return emit;
}

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

  // Studio-local HOT_FORMAL override. The single-axis tier system in
  // filters.ts resolves FORMAL_EVENT before EXTREME_HEAT, so a formal
  // event in hot weather never receives heat-driven fabric relaxation.
  // For destination weddings / outdoor summer galas this is the most
  // visible premium-client failure mode. Apply an additive Studio-local
  // pre-filter that drops heavy-weather fabrics and heavy outerwear
  // BEFORE the existing hard gate runs. The formality floor enforced
  // downstream by FORMAL_EVENT gating is preserved unchanged.
  const HOT_FORMAL_REGEX = /(summer|hot|tropical|destination|outdoor wedding)/i;
  const hotFormal =
    environmentTier === 'FORMAL_EVENT' &&
    ((typeof enrichedCtx.weather?.tempF === 'number' &&
      enrichedCtx.weather.tempF >= 88) ||
      HOT_FORMAL_REGEX.test(enrichedCtx.effectiveQuery ?? ''));
  let preGatePool = filteredPool;
  if (hotFormal) {
    const HOT_FORMAL_MATERIAL = /wool|cashmere|tweed|flannel/i;
    const HOT_FORMAL_OUTER =
      /puffer|parka|overcoat|trench|peacoat|topcoat/i;
    preGatePool = filteredPool.filter((it) => {
      if (HOT_FORMAL_MATERIAL.test(it.material ?? '')) return false;
      if (HOT_FORMAL_OUTER.test(it.subcategory ?? '')) return false;
      return true;
    });
    console.log('[STUDIO] HOT_FORMAL_OVERRIDE_APPLIED', {
      tempF: enrichedCtx.weather?.tempF ?? null,
      tier: environmentTier,
      before: filteredPool.length,
      after: preGatePool.length,
    });
  }

  // Stage 2: physics-dominant feasibility hard gate. Runs BEFORE scoring,
  // compatibility, and slot partitioning. Universal across all users —
  // no profile-specific branches. Priority: Physics > Occasion > Style.
  let pool = applyEnvironmentalHardGate(preGatePool, enrichedCtx);

  // First partition the gated pool
  let partitioned = partitionBySlot(pool);

  // Universal shoe-ownership guarantee. Runs across every tier because
  // the invariant below must represent "user owns zero shoes" — never
  // "filtering removed all shoes". The fallback inspects the ORIGINAL
  // catalog (not the filtered / gated pool) and prefers a shoe that
  // still passes the environment hard gate for the current tier, so
  // physics is respected whenever the user's wardrobe allows it.
  // Only if zero tier-compatible shoes exist does the fallback widen
  // to any owned shoe, protecting the invariant without silently
  // degrading stylist quality in HEAT / COLD / ATHLETIC / FORMAL.
  // Compatibility, exclusion, and tier-specific drop rules in the
  // builder remain authoritative for what actually gets selected.
  //
  // Profile integrity (best-effort): when a style profile exists, the
  // fallback first tries to inject a shoe that independently survives
  // filterCandidatePool so presentation / avoid_colors /
  // avoid_subcategories / dress-code rules are honored. If none
  // survives — or no profile is present — it degrades gracefully to
  // the best-ranked environmentally valid shoe and logs
  // SHOE_PROFILE_FALLBACK_RELAXED. Never throws; outfit generation
  // must always continue whenever the user owns at least one shoe.
  if (partitioned.shoes.length === 0) {
    const originalPartitioned = partitionBySlot(catalog);

    if (originalPartitioned.shoes.length > 0) {
      // Reuse applyEnvironmentalHardGate so tier physics is enforced
      // by the single source of truth — no duplicated drop rules.
      const tierCompatibleShoes = applyEnvironmentalHardGate(
        originalPartitioned.shoes,
        enrichedCtx,
      );

      const preferredPool =
        tierCompatibleShoes.length > 0
          ? tierCompatibleShoes
          : originalPartitioned.shoes;

      const rankedCandidates = preferredPool
        .slice()
        .sort(
          (a, b) =>
            scoreStudioItem(b, enrichedCtx) - scoreStudioItem(a, enrichedCtx),
        );

      let injectedShoe: StudioItem | null = null;

      // Step 1: Try full profile-aware injection if profile exists.
      if (enrichedCtx.styleProfile) {
        for (const candidate of rankedCandidates) {
          const profileSurvivors = filterCandidatePool(
            [candidate],
            enrichedCtx,
          );
          if (profileSurvivors.length > 0) {
            injectedShoe = candidate;
            break;
          }
        }
      }

      // Step 2: If no shoe survived profile filter OR no profile exists,
      // fall back to best-ranked environmentally valid shoe.
      // Never throw invariant.
      if (!injectedShoe) {
        injectedShoe = rankedCandidates[0] ?? null;

        if (injectedShoe) {
          console.warn('[STUDIO] SHOE_PROFILE_FALLBACK_RELAXED', {
            tier: environmentTier,
            requestId: meta.requestId,
            userId: meta.userId,
          });
        }
      }

      // Step 3: If still no shoe (user literally owns zero shoes),
      // leave the pool unchanged; the downstream
      // WARDROBE_INSUFFICIENT_SHOES guard handles the zero-owned case.
      if (injectedShoe && !pool.find((p) => p.id === injectedShoe!.id)) {
        console.warn(
          '[STUDIO] No shoes after gating — injecting best-ranked shoe from original catalog',
          {
            tier: environmentTier,
            tierCompatible: tierCompatibleShoes.length > 0,
            id: injectedShoe.id,
            label: injectedShoe.label,
          },
        );
        pool = [...pool, injectedShoe];
        partitioned = partitionBySlot(pool);
      }
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

  if (process.env.STUDIO_ELITE_AUDIT === 'true') {
    console.log('STUDIO_INPUT_QUALITY', {
      tier: environmentTier,
      catalogSize: catalog.length,
      tops: partitioned.tops.length ?? 0,
      bottoms: partitioned.bottoms.length ?? 0,
      shoes: partitioned.shoes.length ?? 0,
      outerwear: partitioned.outerwear.length ?? 0,
      accessories: partitioned.accessories.length ?? 0,
    });
  }

  // Reuse thresholds: if the wardrobe is smaller than the target slate,
  // allow reusing a mandatory slot — but record it for diagnostics.
  const needsTopReuse = partitioned.tops.length < TARGET_OUTFITS;
  const needsBottomReuse = partitioned.bottoms.length < TARGET_OUTFITS;
  const needsShoesReuse = partitioned.shoes.length < TARGET_OUTFITS;
  const allowMandatoryReuse =
    needsTopReuse || needsBottomReuse || needsShoesReuse;

  // ── PHASE A: collect up to MAX_CANDIDATES viable outfits ───────────
  // Generate a bounded pool of candidates, then rank + diversify before
  // committing the final 3. Candidate generation honors the Phase 2
  // FORMAL_EVENT acceptance floor (reject + retry, does not consume a
  // candidate slot). Candidate-level exclusion widens monotonically so
  // each iteration searches for a structurally different triple.
  const MAX_CANDIDATES = 12;
  const MAX_ATTEMPTS = 40;
  let candidateOutfits: Array<{
    outfit: StudioOutfit;
    usedIds: Set<string>;
  }> = [];

  const candidateExcludeTops = new Set<string>();
  const candidateExcludeBottoms = new Set<string>();
  const candidateExcludeShoes = new Set<string>();
  const candidateExcludeLayer = new Set<string>();
  const candidateExcludeAccessory = new Set<string>();

  for (
    let attempt = 0;
    attempt < MAX_ATTEMPTS && candidateOutfits.length < MAX_CANDIDATES;
    attempt++
  ) {
    const slateIndex = candidateOutfits.length + 1;

    const relaxTops = slateIndex > 1 && partitioned.tops.length <= 1;
    const relaxBottoms = slateIndex > 1 && partitioned.bottoms.length <= 1;
    const relaxShoes = slateIndex > 1 && partitioned.shoes.length <= 1;

    const result = buildStrictOutfit(pool, enrichedCtx, {
      excludeTopIds: relaxTops ? undefined : candidateExcludeTops,
      excludeBottomIds: relaxBottoms ? undefined : candidateExcludeBottoms,
      excludeShoesIds: relaxShoes ? undefined : candidateExcludeShoes,
      excludeLayerIds: candidateExcludeLayer,
      excludeAccessoryIds: candidateExcludeAccessory,
      allowMandatoryReuse,
      slateIndex,
    });

    // Early-exit signal from the builder: no more meaningful (positive-
    // scoring) combinations remain. Stop candidate collection rather
    // than fabricate a zero-score filler outfit.
    if (result === null) break;

    // FORMAL_EVENT outfit-level floor. Enforced only when ALL three
    // core pieces have a defined formality_score. Missing metadata is
    // treated as "uncertain formal" — the outfit receives a soft
    // aesthetic penalty instead of being hard-rejected, so upstream
    // data-quality gaps cannot starve the slate.
    if (enrichedCtx.environmentTier === 'FORMAL_EVENT') {
      const tF = Number(result.outfit.slots.top.formality_score ?? NaN);
      const bF = Number(result.outfit.slots.bottom.formality_score ?? NaN);
      const sF = Number(result.outfit.slots.shoes.formality_score ?? NaN);
      const allDefined =
        Number.isFinite(tF) && Number.isFinite(bF) && Number.isFinite(sF);

      if (allDefined) {
        const minF = Math.min(tF, bF, sF);
        const maxF = Math.max(tF, bF, sF);
        if (minF < 6 || maxF < 7) {
          const coreParts: Array<{
            id: string;
            f: number;
            slot: 'top' | 'bottom' | 'shoes';
          }> = [
            { id: result.outfit.slots.top.id, f: tF, slot: 'top' },
            { id: result.outfit.slots.bottom.id, f: bF, slot: 'bottom' },
            { id: result.outfit.slots.shoes.id, f: sF, slot: 'shoes' },
          ];
          const lowest = coreParts.reduce((a, b) => (a.f <= b.f ? a : b));
          if (lowest.slot === 'top') candidateExcludeTops.add(lowest.id);
          else if (lowest.slot === 'bottom')
            candidateExcludeBottoms.add(lowest.id);
          else candidateExcludeShoes.add(lowest.id);
          continue;
        }
      } else {
        // Soft penalty — accept the outfit but nudge it down the ranking.
        result.outfit.score -= 1.5;
      }
    }

    candidateOutfits.push(result);
    candidateExcludeTops.add(result.outfit.slots.top.id);
    candidateExcludeBottoms.add(result.outfit.slots.bottom.id);
    candidateExcludeShoes.add(result.outfit.slots.shoes.id);
    if (result.outfit.slots.layer)
      candidateExcludeLayer.add(result.outfit.slots.layer.id);
    if (result.outfit.slots.accessory)
      candidateExcludeAccessory.add(result.outfit.slots.accessory.id);
  }

  // ── ELITE COMPOSITE RANKING ───────────────────────────────────────
  //
  // Additive, Studio-local quality uplift. Combines three deterministic
  // sources:
  //   1) baseScore  — existing scoreStudioOutfit output (authoritative)
  //   2) eliteScore — shared elite scoreOutfit (clamped ±20, weight 1.2)
  //   3) taste      — eliteValidateOutfit totalPenalty (≤0, additive)
  //
  // + monochrome compensation (+0.5) when the three core items share a
  //   single color family, offsetting the all-neutral penalty baked into
  //   scoreStudioOutfit so an intentional tonal look is not demoted.
  //
  // `taste.valid === false` hard-rejects only when ≥3 valid candidates
  // remain after rejection; otherwise the penalty is applied but the
  // candidate is kept so the 3-outfit guarantee is honored on thin
  // wardrobes (graceful degradation, not silent failure).
  //
  // Runs BEFORE the beach block and diversity phase so every downstream
  // stage sees composite scores. Replaces the prior median-boost +
  // hash-jitter reranker — ordering is now purely deterministic and
  // taste-driven.
  const eliteStyleCtx: EliteStyleContext = {
    presentation: enrichedCtx.userPresentation,
    styleProfile: enrichedCtx.styleProfile
      ? {
          fit_preferences: enrichedCtx.styleProfile.fit_preferences ?? [],
          fabric_preferences:
            enrichedCtx.styleProfile.fabric_preferences ?? [],
          favorite_colors: enrichedCtx.styleProfile.favorite_colors ?? [],
          style_preferences:
            enrichedCtx.styleProfile.style_preferences ?? [],
          disliked_styles: enrichedCtx.styleProfile.disliked_styles ?? [],
          avoid_colors: enrichedCtx.styleProfile.avoid_colors ?? [],
          avoid_materials: enrichedCtx.styleProfile.avoid_materials ?? [],
          pattern_preferences: [],
        }
      : undefined,
    preferredBrands: enrichedCtx.styleProfile?.preferred_brands ?? [],
  };
  const eliteEnv: EliteEnv = {
    mode: 'studio',
    weather: enrichedCtx.weather,
    requestId: meta.requestId,
  };
  const eliteQueryCtx: EliteQueryContext = {
    rawQuery: enrichedCtx.effectiveQuery ?? '',
    derivedOccasion: null,
    derivedFormality: null,
    keywordTags: [],
  };
  const validatorCtx: ValidatorContext = {
    userPresentation: enrichedCtx.userPresentation,
    climateZone: (() => {
      const t = enrichedCtx.weather?.tempF;
      if (typeof t !== 'number') return undefined;
      if (t <= 32) return 'freezing';
      if (t <= 50) return 'cold';
      if (t <= 60) return 'cool';
      if (t <= 72) return 'mild';
      if (t <= 82) return 'warm';
      return 'hot';
    })(),
    requestedDressCode: enrichedCtx.parsedConstraints?.dressWanted ?? undefined,
    styleProfile: enrichedCtx.styleProfile
      ? {
          fit_preferences: enrichedCtx.styleProfile.fit_preferences ?? [],
          fabric_preferences:
            enrichedCtx.styleProfile.fabric_preferences ?? [],
          style_preferences:
            enrichedCtx.styleProfile.style_preferences ?? [],
          disliked_styles: enrichedCtx.styleProfile.disliked_styles ?? [],
          coverage_no_go: [],
          avoid_colors: enrichedCtx.styleProfile.avoid_colors ?? [],
          avoid_materials: enrichedCtx.styleProfile.avoid_materials ?? [],
          formality_floor:
            enrichedCtx.styleProfile.formality_floor != null
              ? String(enrichedCtx.styleProfile.formality_floor)
              : null,
          walkability_requirement: null,
          avoid_patterns: enrichedCtx.styleProfile.avoid_patterns ?? [],
          silhouette_preference:
            enrichedCtx.styleProfile.silhouette_preference ?? null,
        }
      : null,
  };

  // Monochrome detection — three core items share a single base family
  // (including all-neutral). Inline here to avoid exporting new symbols
  // from colorHarmony.ts.
  const MONOCHROME_FAMILIES = [
    'black', 'white', 'gray', 'grey', 'beige', 'cream', 'ivory', 'navy',
    'charcoal', 'khaki', 'tan', 'red', 'orange', 'yellow', 'brown',
    'cognac', 'burgundy', 'maroon', 'coral', 'peach', 'rust', 'gold',
    'blue', 'green', 'purple', 'teal', 'olive', 'mint', 'cyan',
    'lavender', 'magenta', 'pink',
  ];
  const NEUTRAL_FAMILIES = new Set([
    'black', 'white', 'gray', 'grey', 'beige', 'cream', 'ivory',
    'navy', 'charcoal', 'khaki', 'tan',
  ]);
  const familyTokenOf = (it: StudioItem): string =>
    (it.color_family ?? it.color ?? '').toLowerCase().trim();
  const baseFamilyOf = (token: string): string | null => {
    if (!token) return null;
    for (const f of MONOCHROME_FAMILIES) {
      if (token.includes(f)) return f;
    }
    return null;
  };
  const isMonochromeCore = (o: StudioOutfit): boolean => {
    const famTop = baseFamilyOf(familyTokenOf(o.slots.top));
    const famBot = baseFamilyOf(familyTokenOf(o.slots.bottom));
    const famSh = baseFamilyOf(familyTokenOf(o.slots.shoes));
    if (!famTop || !famBot || !famSh) return false;
    if (famTop === famBot && famBot === famSh) return true;
    if (
      NEUTRAL_FAMILIES.has(famTop) &&
      NEUTRAL_FAMILIES.has(famBot) &&
      NEUTRAL_FAMILIES.has(famSh)
    ) {
      return true;
    }
    return false;
  };

  // Deterministic color-harmony score on the core triple. Used by PHASE 2
  // additive reward only — compatibility.ts is untouched. Range [0, 1].
  const colorHarmonyOf = (o: StudioOutfit): number => {
    const famTop = baseFamilyOf(familyTokenOf(o.slots.top));
    const famBot = baseFamilyOf(familyTokenOf(o.slots.bottom));
    const famSh = baseFamilyOf(familyTokenOf(o.slots.shoes));
    if (!famTop || !famBot || !famSh) return 0.2;
    if (famTop === famBot && famBot === famSh) return 1.0;
    const neutralCount =
      (NEUTRAL_FAMILIES.has(famTop) ? 1 : 0) +
      (NEUTRAL_FAMILIES.has(famBot) ? 1 : 0) +
      (NEUTRAL_FAMILIES.has(famSh) ? 1 : 0);
    if (neutralCount === 3) return 0.8;
    const pairMatch =
      famTop === famBot || famBot === famSh || famTop === famSh;
    if (pairMatch) return 0.6;
    if (neutralCount >= 2) return 0.6;
    return 0.3;
  };

  // Studio-local quality signals map. Populated once per candidate during
  // the composite loop; consulted later by PHASE 4 sort, PHASE 1 floor
  // filter, and PHASE 3 fallback booster (via closure). Map keyed by
  // outfit object reference so candidate filtering (beach block etc.)
  // does not need to sync a parallel array.
  const qualitySignals = new Map<
    StudioOutfit,
    { eliteQualityScore: number; lowQuality: boolean }
  >();

  // First pass: compute composite, elite quality signals, additive
  // harmony reward (PHASE 2), and mark taste-invalid candidates.
  const eliteAnnotated = candidateOutfits.map((cand) => {
    const baseScore = cand.outfit.score;
    const elite = eliteScoreOutfit(
      normalizeStudioOutfit(cand.outfit),
      eliteStyleCtx,
      eliteEnv,
      eliteQueryCtx,
    );
    const eliteContribution =
      Math.max(-20, Math.min(20, elite.score ?? 0)) * 1.2;
    const taste = eliteValidateOutfit(
      cand.outfit.items as unknown as ValidatorItem[],
      validatorCtx,
    );
    let composite = baseScore + eliteContribution + (taste.totalPenalty ?? 0);
    if (isMonochromeCore(cand.outfit)) composite += 0.5;

    // PHASE 2 — additive harmony rewards. Derived from existing metadata;
    // compatibility.ts is not modified. All rewards are strictly additive.
    let harmonyReward = 0;
    if (colorHarmonyOf(cand.outfit) >= 0.6) harmonyReward += 1.0;
    if (studioFormalityDelta(cand.outfit) <= 1) harmonyReward += 0.6;
    if (studioHeroCount(cand.outfit) === 1) harmonyReward += 0.8;
    if (studioCoreTempAligned(cand.outfit)) harmonyReward += 0.5;
    composite += harmonyReward;

    // PHASE 1 — elite quality floor signal (not an immediate reject).
    const coherence = Math.max(0, taste.coherenceScore ?? 0);
    const eliteQualityScore = eliteContribution + coherence;
    const lowQuality = eliteQualityScore < QUALITY_MIN;
    qualitySignals.set(cand.outfit, { eliteQualityScore, lowQuality });

    return { cand, composite, tasteValid: taste.valid };
  });

  // Graceful taste rejection: only hard-reject when ≥3 candidates remain
  // after rejection. Otherwise keep the candidate (penalty already
  // applied via totalPenalty) so the slate has a viable pool.
  const tasteValidCount = eliteAnnotated.filter((e) => e.tasteValid).length;
  const canRejectInvalid = tasteValidCount >= TARGET_OUTFITS;
  const surviving = canRejectInvalid
    ? eliteAnnotated.filter((e) => e.tasteValid)
    : eliteAnnotated;

  // Write composite back onto the outfit score so downstream phases
  // (beach enforcement, diversity, formal-spread, tier backfills) all
  // operate on taste-aware scores.
  for (const e of surviving) e.cand.outfit.score = e.composite;

  candidateOutfits = surviving.map((e) => e.cand);

  console.log('[STUDIO] ELITE_COMPOSITE_RANKING_APPLIED', {
    requestId: meta.requestId,
    total: eliteAnnotated.length,
    tasteValid: tasteValidCount,
    rejected: canRejectInvalid
      ? eliteAnnotated.length - surviving.length
      : 0,
    hotFormal,
  });

  // ── ELITE BEACH SILHOUETTE HARD RULES ─────────────────────────────
  //
  // Beach enforcement requires BOTH an explicit beach-intent word
  // (matched with word boundaries — proper nouns like "Miami" do NOT
  // qualify) AND the environment tier being EXTREME_HEAT. Either alone
  // is insufficient: a hot day at a business dinner is not a beach,
  // and a cool coastal walk is not beach silhouette territory.

  const explicitBeachSignal = isExplicitBeachIntent(
    enrichedCtx.effectiveQuery ?? '',
  );
  const beachEnforced =
    environmentTier === 'EXTREME_HEAT' && explicitBeachSignal;

  if (beachEnforced) {
    candidateOutfits = candidateOutfits.filter((cand) => {
      const { top, bottom, shoes, accessory } = cand.outfit.slots;

      if (!top || !bottom || !shoes) return false;

      // 1. Must be shorts for beach elite
      if (!/shorts/i.test(bottom.subcategory ?? '')) return false;

      // 2. No sweaters, no structured shirts
      if (/sweater|cashmere/i.test(top.subcategory ?? '')) return false;

      // 3. No heavy winter textures
      if (/wool|cashmere/i.test(top.material ?? '')) return false;

      // 4. Shoes must be neutral + low visual aggression
      const shoeColor = (
        shoes.color_family ??
        shoes.color ??
        ''
      ).toLowerCase();

      const aggressiveColor = /neon|bright/i.test(shoeColor);
      if (aggressiveColor) return false;

      // 5. No metal-dominant accessories
      if (accessory && /metal/i.test(accessory.material ?? ''))
        return false;

      return true;
    });
  }

  // ── OCCASION INTENT: BEACH / RESORT BOOST ─────────────────────────

  if (beachEnforced) {
    for (const cand of candidateOutfits) {
      const { top, bottom, shoes, accessory } = cand.outfit.slots;

      let boost = 0;

      // Prefer shorts strongly
      if (/shorts/i.test(bottom.subcategory ?? '')) boost += 3;

      // Penalize trousers heavily
      if (/trouser|chino|jean/i.test(bottom.subcategory ?? '')) boost -= 4;

      // Prefer breathable fabrics
      if (/linen|cotton/i.test(top.material ?? '')) boost += 1.5;
      if (/linen|cotton/i.test(bottom.material ?? '')) boost += 1;

      // Penalize heavy visual shoe dominance
      if (
        /red|neon/i.test(
          (shoes.color_family ?? shoes.color ?? '').toLowerCase(),
        )
      )
        boost -= 1.5;

      // Favor relaxed dress codes
      if (/ultracasual|casual/i.test(top.dress_code ?? '')) boost += 1;

      // Reduce metal accessory energy on beach
      if (accessory && /metal/i.test(accessory.material ?? '')) boost -= 1;

      cand.outfit.score += boost;
    }
  }

  // ── PHASE 4 — LOCKED RANKING DETERMINISM ──────────────────────────
  // Primary key: eliteQualityScore desc (elite contribution + coherence).
  // Secondary key: composite score desc (baseScore + eliteContribution +
  //   taste.totalPenalty + monochrome + PHASE 2 harmony reward).
  // Tertiary key: top.id ascending. No jitter. No median boost. No
  // randomness. Candidates missing a quality signal (defensive path)
  // default to 0 so ordering remains well-defined.
  candidateOutfits.sort((a, b) => {
    const qa = qualitySignals.get(a.outfit)?.eliteQualityScore ?? 0;
    const qb = qualitySignals.get(b.outfit)?.eliteQualityScore ?? 0;
    const dq = qb - qa;
    if (dq !== 0) return dq;
    const ds = b.outfit.score - a.outfit.score;
    if (ds !== 0) return ds;
    return a.outfit.slots.top.id < b.outfit.slots.top.id
      ? -1
      : a.outfit.slots.top.id > b.outfit.slots.top.id
        ? 1
        : 0;
  });

  // ── PHASE 1 — ELITE QUALITY FLOOR (STUDIO-LOCAL) ──────────────────
  // After ranking: if ≥ TARGET_OUTFITS non-lowQuality candidates exist,
  // drop all lowQuality candidates. Otherwise keep them to preserve the
  // 3-outfit guarantee. This is a premium filter layer that never risks
  // empty output.
  const nonLowQualityCount = candidateOutfits.filter(
    (c) => qualitySignals.get(c.outfit)?.lowQuality !== true,
  ).length;
  if (nonLowQualityCount >= TARGET_OUTFITS) {
    const before = candidateOutfits.length;
    candidateOutfits = candidateOutfits.filter(
      (c) => qualitySignals.get(c.outfit)?.lowQuality !== true,
    );
    console.log('[STUDIO] ELITE_QUALITY_FLOOR_APPLIED', {
      requestId: meta.requestId,
      before,
      after: candidateOutfits.length,
      dropped: before - candidateOutfits.length,
      qualityMin: QUALITY_MIN,
    });
  } else {
    console.log('[STUDIO] ELITE_QUALITY_FLOOR_BYPASSED', {
      requestId: meta.requestId,
      reason: 'insufficient_high_quality_alternatives',
      nonLowQualityCount,
      target: TARGET_OUTFITS,
    });
  }

  // ── PHASE G-A — STRUCTURAL DIVERSITY PENALTY ──────────────────────
  // Deterministic pairwise penalty on the current ranking. For each
  // candidate pair (i < j in sorted order), subtract from the LOWER-
  // ranked candidate's composite score:
  //   -6 when bottom.id AND shoes.id both match
  //   -3 when only bottom.id matches
  //   -2 when only shoes.id matches
  // Mutates only cand.outfit.score (composite, the secondary sort key).
  // eliteQualityScore (primary) and coherence are untouched, so the
  // quality floor set is unaffected. After penalties, resort with the
  // same 3-key rule so downstream diversity / formal-spread / tier
  // selection all see a diversity-biased ordering. Critical for
  // shallow wardrobes where every candidate shares the same shoe.
  let diversityPenaltyApplied = 0;
  for (let i = 0; i < candidateOutfits.length; i++) {
    for (let j = i + 1; j < candidateOutfits.length; j++) {
      const a = candidateOutfits[i].outfit;
      const b = candidateOutfits[j].outfit;
      const sameBottom = a.slots.bottom.id === b.slots.bottom.id;
      const sameShoes = a.slots.shoes.id === b.slots.shoes.id;
      let penalty = 0;
      if (sameBottom && sameShoes) penalty = -6;
      else if (sameBottom) penalty = -3;
      else if (sameShoes) penalty = -2;
      if (penalty !== 0) {
        b.score += penalty;
        diversityPenaltyApplied++;
      }
    }
  }
  if (diversityPenaltyApplied > 0) {
    candidateOutfits.sort((a, b) => {
      const qa = qualitySignals.get(a.outfit)?.eliteQualityScore ?? 0;
      const qb = qualitySignals.get(b.outfit)?.eliteQualityScore ?? 0;
      const dq = qb - qa;
      if (dq !== 0) return dq;
      const ds = b.outfit.score - a.outfit.score;
      if (ds !== 0) return ds;
      return a.outfit.slots.top.id < b.outfit.slots.top.id
        ? -1
        : a.outfit.slots.top.id > b.outfit.slots.top.id
          ? 1
          : 0;
    });
    console.log('[STUDIO] DIVERSITY_PENALTY_APPLIED', {
      requestId: meta.requestId,
      pairs: diversityPenaltyApplied,
      candidates: candidateOutfits.length,
    });
  }

  // ── PHASE C: structural diversity + hero reuse suppression ────────
  // structuralSimilarity returns a single 0-1 score. Full-triple match
  // or same-hero-with-close-score collapse to 1.0; otherwise the score
  // is the positional color-family overlap across the 3 core slots.
  // A candidate is rejected if similarity > 0.8 against any already-
  // selected outfit.
  const findHeroId = (outfit: StudioOutfit): string | null => {
    const core = [outfit.slots.top, outfit.slots.bottom, outfit.slots.shoes];
    for (const it of core) {
      if (Number(it.formality_score ?? 0) >= 7) return it.id;
    }
    return null;
  };

  // Wardrobe-wide hero availability. When the wardrobe has only one hero
  // item, the same-hero-with-close-score rule would force the slate to
  // avoid that hero in two of three outfits — demoting the slate. Only
  // apply hero-reuse suppression when an alternative hero exists.
  const heroItemCount = pool.filter(
    (it) => Number(it.formality_score ?? 0) >= 7,
  ).length;
  const hasAlternativeHero = heroItemCount > 1;

  const coreColorFamilies = (outfit: StudioOutfit) =>
    [outfit.slots.top, outfit.slots.bottom, outfit.slots.shoes].map((it) =>
      (it.color_family ?? it.color ?? '').toLowerCase().trim(),
    );
  const structuralSimilarity = (a: StudioOutfit, b: StudioOutfit): number => {
    // Rule A — exact core-triple match.
    if (
      a.slots.top.id === b.slots.top.id &&
      a.slots.bottom.id === b.slots.bottom.id &&
      a.slots.shoes.id === b.slots.shoes.id
    ) {
      return 1;
    }
    // Rule B — shared hero piece with close aesthetic score.
    // Suppressed when no alternative hero exists in the wardrobe.
    const aHero = findHeroId(a);
    const bHero = findHeroId(b);
    if (
      hasAlternativeHero &&
      aHero &&
      bHero &&
      aHero === bHero &&
      Math.abs(a.score - b.score) < 2
    ) {
      return 1;
    }
    // Rule C — positional color-family overlap across core.
    const aColors = coreColorFamilies(a);
    const bColors = coreColorFamilies(b);
    let matches = 0;
    for (let i = 0; i < 3; i++) {
      if (aColors[i] && aColors[i] === bColors[i]) matches++;
    }
    return matches / 3;
  };
  const isStructuralDuplicate = (a: StudioOutfit, b: StudioOutfit): boolean =>
    structuralSimilarity(a, b) > 0.8;

  const selected: Array<{ outfit: StudioOutfit; usedIds: Set<string> }> = [];
  const selectedTopIds = new Set<string>();

  // Pass 1: enforce full diversity + hero-reuse suppression.
  // When the current candidate shares a top with an already-selected
  // outfit AND a later candidate offers a different top that is not
  // a structural duplicate, defer to the later candidate.
  for (
    let i = 0;
    i < candidateOutfits.length && selected.length < TARGET_OUTFITS;
    i++
  ) {
    const cand = candidateOutfits[i];
    if (selected.some((s) => isStructuralDuplicate(s.outfit, cand.outfit))) {
      continue;
    }
    if (selectedTopIds.has(cand.outfit.slots.top.id)) {
      const altLater = candidateOutfits.slice(i + 1).some(
        (c) =>
          !selectedTopIds.has(c.outfit.slots.top.id) &&
          !selected.some((s) => isStructuralDuplicate(s.outfit, c.outfit)),
      );
      if (altLater) continue;
    }
    selected.push(cand);
    selectedTopIds.add(cand.outfit.slots.top.id);
  }

  // Pass 2: fill remaining slots when the wardrobe is too shallow for
  // full diversity. Only exact core-triple duplicates are rejected so
  // the slate still reaches TARGET_OUTFITS whenever the pool allows.
  if (selected.length < TARGET_OUTFITS) {
    for (
      let i = 0;
      i < candidateOutfits.length && selected.length < TARGET_OUTFITS;
      i++
    ) {
      const cand = candidateOutfits[i];
      if (selected.includes(cand)) continue;
      const exactDup = selected.some(
        (s) =>
          s.outfit.slots.top.id === cand.outfit.slots.top.id &&
          s.outfit.slots.bottom.id === cand.outfit.slots.bottom.id &&
          s.outfit.slots.shoes.id === cand.outfit.slots.shoes.id,
      );
      if (exactDup) continue;
      selected.push(cand);
    }
  }

  // ── PHASE D: formal spread guarantee ──────────────────────────────
  // When the tier is neither FORMAL_EVENT nor ATHLETIC, require the
  // final 3 outfits to span at least two formality bands. If all 3
  // collapse to one band, replace the 3rd with the highest-scoring
  // candidate in a different band that is not a structural duplicate
  // of the first two.
  if (
    selected.length === TARGET_OUTFITS &&
    enrichedCtx.environmentTier !== 'FORMAL_EVENT' &&
    enrichedCtx.environmentTier !== 'ATHLETIC'
  ) {
    const bandOf = (o: StudioOutfit): 'casual' | 'mid' | 'high' => {
      const avg =
        (Number(o.slots.top.formality_score ?? 5) +
          Number(o.slots.bottom.formality_score ?? 5) +
          Number(o.slots.shoes.formality_score ?? 5)) /
        3;
      if (avg < 5) return 'casual';
      if (avg <= 6.5) return 'mid';
      return 'high';
    };
    const bands = selected.map((s) => bandOf(s.outfit));
    if (new Set(bands).size === 1) {
      const currentBand = bands[0];
      const replacement = candidateOutfits.find((c) => {
        if (selected.includes(c)) return false;
        if (bandOf(c.outfit) === currentBand) return false;
        return !selected
          .slice(0, 2)
          .some((s) => isStructuralDuplicate(s.outfit, c.outfit));
      });
      if (replacement) selected[2] = replacement;
    }
  }

  // ── FINAL QUALITY-CONSERVING SELECTION ─────────────────────

  const structurallyValid = candidateOutfits.filter((c, idx, arr) => {
    return !arr.some(
      (other, j) =>
        j < idx &&
        other.outfit.slots.top.id === c.outfit.slots.top.id &&
        other.outfit.slots.bottom.id === c.outfit.slots.bottom.id &&
        other.outfit.slots.shoes.id === c.outfit.slots.shoes.id,
    );
  });

  // If we have >= TARGET_OUTFITS structurally distinct candidates,
  // enforce exactly TARGET_OUTFITS from best-first ordering.
  let finalSelection: Array<{ outfit: StudioOutfit; usedIds: Set<string> }> =
    selected;

  if (structurallyValid.length >= TARGET_OUTFITS) {
    finalSelection = selected.slice(0, TARGET_OUTFITS);
  } else {
    // Wardrobe combinatorially shallow — return actual viable count
    finalSelection = selected;
  }

  // Never allow elegance floor to shrink below structural capacity
  if (
    structurallyValid.length >= TARGET_OUTFITS &&
    finalSelection.length < TARGET_OUTFITS
  ) {
    finalSelection = candidateOutfits.slice(0, TARGET_OUTFITS);
  }

  // ── PHASE E: PERCENTILE ELITE FILTER + POST-ASSEMBLY VALIDATION ──

  const allCandidateScores = candidateOutfits.map((c) => c.outfit.score);
  const p40 = percentile(allCandidateScores, 0.4);

  const isAbovePercentile = (c: {
    outfit: StudioOutfit;
  }): boolean => c.outfit.score >= p40;

  const isExactDupOf = (
    c: { outfit: StudioOutfit },
    selectedPool: Array<{ outfit: StudioOutfit }>,
  ): boolean =>
    selectedPool.some(
      (s) =>
        s.outfit.slots.top.id === c.outfit.slots.top.id &&
        s.outfit.slots.bottom.id === c.outfit.slots.bottom.id &&
        s.outfit.slots.shoes.id === c.outfit.slots.shoes.id,
    );

  const emit: Array<{ outfit: StudioOutfit; usedIds: Set<string> }> = [];

  // Tier 1: diversity-curated finalSelection that passes percentile +
  // post-assembly validation.
  for (const c of finalSelection) {
    if (emit.length >= TARGET_OUTFITS) break;
    if (!isAbovePercentile(c)) continue;
    if (!validateOutfitPostAssembly(c.outfit)) continue;
    if (isExactDupOf(c, emit)) continue;
    emit.push(c);
  }

  // Tier 2: backfill with above-percentile + validated + non-dup from full pool.
  for (const c of candidateOutfits) {
    if (emit.length >= TARGET_OUTFITS) break;
    if (emit.includes(c)) continue;
    if (!isAbovePercentile(c)) continue;
    if (!validateOutfitPostAssembly(c.outfit)) continue;
    if (isExactDupOf(c, emit)) continue;
    emit.push(c);
  }

  // Tier 3: any validated non-dup candidate (relax percentile).
  for (const c of candidateOutfits) {
    if (emit.length >= TARGET_OUTFITS) break;
    if (emit.includes(c)) continue;
    if (!validateOutfitPostAssembly(c.outfit)) continue;
    if (isExactDupOf(c, emit)) continue;
    emit.push(c);
  }

  // Tier 4: any non-dup candidate that still passes STRUCTURAL
  // validation. Percentile and full post-assembly validation are
  // relaxed here, but structural absurdities (sneaker + formal
  // trouser, dress shoe + gym short, pairwise harmony < -1.5) remain
  // hard-rejected.
  for (const c of candidateOutfits) {
    if (emit.length >= TARGET_OUTFITS) break;
    if (emit.includes(c)) continue;
    if (!validateOutfitStructural(c.outfit)) continue;
    if (isExactDupOf(c, emit)) continue;
    emit.push(c);
  }

  // PHASE 3 — fallback quality booster. Closure captures the elite
  // contexts and Studio helpers so buildGuaranteedOutfits can re-run
  // elite composite scoring without reaching back into this file's
  // inner scope. Strictly additive: only lifts outfit.score when the
  // computed eliteQualityScore is below QUALITY_MIN; never downgrades.
  const fallbackQualityBooster: FallbackQualityBooster = (outfit) => {
    const elite = eliteScoreOutfit(
      normalizeStudioOutfit(outfit),
      eliteStyleCtx,
      eliteEnv,
      eliteQueryCtx,
    );
    const eliteContribution =
      Math.max(-20, Math.min(20, elite.score ?? 0)) * 1.2;
    const taste = eliteValidateOutfit(
      outfit.items as unknown as ValidatorItem[],
      validatorCtx,
    );
    const coherence = Math.max(0, taste.coherenceScore ?? 0);
    const eliteQualityScore = eliteContribution + coherence;
    if (eliteQualityScore >= QUALITY_MIN) return;

    let boost = 0;
    if (isMonochromeCore(outfit)) boost += 1.0;
    if (studioHeroCount(outfit) === 1) boost += 0.8;
    if (studioCoreTempAligned(outfit)) boost += 0.5;

    if (boost > 0) {
      outfit.score += boost;
      console.log('[STUDIO] FALLBACK_QUALITY_BOOSTED', {
        requestId: meta.requestId,
        outfitId: outfit.outfit_id,
        eliteQualityScore,
        boost,
      });
    }
  };

  // ── PHASE F: GUARANTEED FALLBACK (no throw, always 3) ─────────────
  //
  // Production safety contract: as long as the wardrobe has at least
  // one top, one bottom, and one shoe (already verified upstream by
  // WARDROBE_INSUFFICIENT_* invariants), this function MUST emit
  // exactly TARGET_OUTFITS outfits. The fallback relaxes distinct-
  // triple constraints: tops vary first, bottoms and shoes may
  // repeat, and a deterministic clone-with-variation is used as the
  // last resort. No throw path exists after this point.
  let emitFinal = emit;
  if (emit.length < TARGET_OUTFITS) {
    console.warn('[STUDIO] GUARANTEED_FALLBACK_TRIGGERED', {
      requestId: meta.requestId,
      userId: meta.userId,
      tier: environmentTier,
      preFallbackCount: emit.length,
      candidateCount: candidateOutfits.length,
    });
    emitFinal = buildGuaranteedOutfits(
      partitioned,
      enrichedCtx,
      emit,
      candidateExcludeLayer,
      candidateExcludeAccessory,
      fallbackQualityBooster,
    );
  }

  // ── PHASE G-B — ELITE SHALLOW-WARDROBE ENFORCEMENT ────────────────
  // Runs ONLY when emitFinal has reached TARGET_OUTFITS (by construction
  // it always should, thanks to PHASE F). All three sub-passes SWAP in
  // place — they never pop from the slate — so the 3-outfit guarantee
  // is preserved regardless of whether any replacement is found. A
  // downstream safety net re-runs the guaranteed builder only if a
  // future change violates this property.
  if (emitFinal.length === TARGET_OUTFITS) {
    const inSlate = (c: { outfit: StudioOutfit }): boolean =>
      emitFinal.some((e) => e === c);

    // (2) HERO ROTATION — no top.id appears more than once in the slate
    // when an alternative top exists. Iterates duplicates in order;
    // the first occurrence is kept (it is the highest-ranked), each
    // subsequent duplicate is swapped with the best-ranked candidate
    // outside the slate whose top.id is not already in the slate. If
    // no such candidate exists the duplicate stays — never reduces
    // emit count below TARGET_OUTFITS.
    const topCounts = new Map<string, number>();
    for (const e of emitFinal) {
      const id = e.outfit.slots.top.id;
      topCounts.set(id, (topCounts.get(id) ?? 0) + 1);
    }
    for (const [topId, count] of topCounts) {
      if (count <= 1) continue;
      let keptOnce = false;
      for (let i = 0; i < emitFinal.length; i++) {
        if (emitFinal[i].outfit.slots.top.id !== topId) continue;
        if (!keptOnce) {
          keptOnce = true;
          continue;
        }
        const usedTops = new Set(
          emitFinal.map((e) => e.outfit.slots.top.id),
        );
        const replacement = candidateOutfits.find(
          (c) => !inSlate(c) && !usedTops.has(c.outfit.slots.top.id),
        );
        if (replacement) emitFinal[i] = replacement;
      }
    }

    // (3) SHALLOW WARDROBE STYLE FRAMING — when the wardrobe has only
    // one shoe, ensure the final 3 span distinct style framings so the
    // slate reads as three intentional interpretations rather than
    // mechanical top swaps. Ranking-only: no content mutation, no
    // schema change. Framings:
    //   minimal    — top SOLID + bottom SOLID
    //   statement  — top pattern != solid (defined)
    //   smart-beach— dress shirt + shorts
    //   elevated   — dress shirt present
    if (partitioned.shoes.length === 1) {
      type Framing = 'minimal' | 'statement' | 'smart-beach' | 'elevated';
      const framingsOf = (o: StudioOutfit): Set<Framing> => {
        const s = new Set<Framing>();
        const topPat = (o.slots.top.pattern ?? 'solid').toLowerCase();
        const botPat = (o.slots.bottom.pattern ?? 'solid').toLowerCase();
        const topSub = (o.slots.top.subcategory ?? '').toLowerCase();
        const botSub = (o.slots.bottom.subcategory ?? '').toLowerCase();
        if (topPat === 'solid' && botPat === 'solid') s.add('minimal');
        if (topPat !== 'solid' && topPat !== '') s.add('statement');
        if (/dress shirt/.test(topSub) && /shorts/.test(botSub))
          s.add('smart-beach');
        if (/dress shirt/.test(topSub)) s.add('elevated');
        return s;
      };

      const required: Framing[] = ['minimal', 'statement', 'elevated'];
      for (const req of required) {
        const emitFramings = emitFinal.map((e) => framingsOf(e.outfit));
        if (emitFramings.some((f) => f.has(req))) continue;

        const replacement = candidateOutfits.find(
          (c) => !inSlate(c) && framingsOf(c.outfit).has(req),
        );
        if (!replacement) continue;

        const othersFramingUnion = (skip: number): Set<Framing> => {
          const u = new Set<Framing>();
          for (let k = 0; k < emitFinal.length; k++) {
            if (k === skip) continue;
            for (const f of emitFramings[k]) u.add(f);
          }
          return u;
        };

        // Prefer the lowest-composite emit entry whose REQUIRED framings
        // are already covered elsewhere in the slate. That way swapping
        // it in for the missing-framing candidate never drops a
        // framing the slate is currently depending on.
        const sortedIdx = emitFinal
          .map((e, i) => ({ idx: i, score: e.outfit.score }))
          .sort((a, b) => a.score - b.score)
          .map((x) => x.idx);
        let swapIdx = -1;
        for (const i of sortedIdx) {
          const own = emitFramings[i];
          const others = othersFramingUnion(i);
          const losesRequired = [...own].some(
            (f) => required.includes(f) && !others.has(f),
          );
          if (!losesRequired) {
            swapIdx = i;
            break;
          }
        }
        if (swapIdx >= 0) emitFinal[swapIdx] = replacement;
      }
    }

    // (4) MINIMUM STRUCTURAL DIFFERENCE — every pair in the slate must
    // differ by ≥ 2 slots across { top, bottom, shoes, accessory }. If
    // any pair is below the floor, replace the lower-ranked entry with
    // the best-ranked candidate outside the slate that differs by ≥ 2
    // slots from the higher-ranked entry of the offending pair. Bounded
    // pass count prevents infinite loops when no replacement exists
    // (genuinely shallow wardrobe — the slate stays as-is).
    const structuralDiff = (a: StudioOutfit, b: StudioOutfit): number => {
      let d = 0;
      if (a.slots.top.id !== b.slots.top.id) d++;
      if (a.slots.bottom.id !== b.slots.bottom.id) d++;
      if (a.slots.shoes.id !== b.slots.shoes.id) d++;
      const aAcc = a.slots.accessory?.id ?? null;
      const bAcc = b.slots.accessory?.id ?? null;
      if (aAcc !== bAcc) d++;
      return d;
    };
    for (let pass = 0; pass < TARGET_OUTFITS; pass++) {
      let swapped = false;
      outerDiff: for (let i = 0; i < emitFinal.length; i++) {
        for (let j = i + 1; j < emitFinal.length; j++) {
          if (
            structuralDiff(emitFinal[i].outfit, emitFinal[j].outfit) >= 2
          ) {
            continue;
          }
          const ref = emitFinal[i].outfit;
          const replacement = candidateOutfits.find(
            (c) => !inSlate(c) && structuralDiff(c.outfit, ref) >= 2,
          );
          if (replacement) {
            emitFinal[j] = replacement;
            swapped = true;
            break outerDiff;
          }
        }
      }
      if (!swapped) break;
    }
  }

  // SAFETY NET — enforcement only swaps in place, so the slate count
  // should never drop. Defensive re-run of the guaranteed builder kept
  // in case future edits introduce a removal path. Never throws.
  if (emitFinal.length < TARGET_OUTFITS) {
    console.warn('[STUDIO] ENFORCEMENT_COUNT_DROP_RECOVERED', {
      requestId: meta.requestId,
      length: emitFinal.length,
    });
    emitFinal = buildGuaranteedOutfits(
      partitioned,
      enrichedCtx,
      emitFinal,
      candidateExcludeLayer,
      candidateExcludeAccessory,
      fallbackQualityBooster,
    );
  }

  let outfits: StudioOutfit[] = emitFinal.map((s) => s.outfit);

  // Final slot validation gate — every outfit MUST report
  // hasTop/hasBottom/hasShoes = true AND slate length must equal
  // TARGET_OUTFITS. If either invariant fails we log
  // CRITICAL_STUDIO_INVARIANT, rerun the guaranteed fallback, and
  // re-validate. A last-ditch throw is retained for the pathological
  // case where rerunning still fails to produce a valid slate — the
  // contract "≥1 top/bottom/shoe → always 3 outfits" is upheld by the
  // upstream WARDROBE_INSUFFICIENT_* preconditions, so this final
  // throw should be unreachable in practice but is preserved so silent
  // degradation cannot occur.
  const validateSlate = (slate: StudioOutfit[]) => ({
    lengthOk: slate.length === TARGET_OUTFITS,
    perOutfit: slate.map((o) => ({
      hasTop: !!o.slots.top,
      hasBottom: !!o.slots.bottom,
      hasShoes: !!o.slots.shoes,
    })),
  });
  let slateCheck = validateSlate(outfits);
  const allSlotsOk = (v: ReturnType<typeof validateSlate>): boolean =>
    v.lengthOk && v.perOutfit.every((x) => x.hasTop && x.hasBottom && x.hasShoes);
  console.log('AI_OUTFIT_STUDIO_SLOT_VALIDATION:', slateCheck.perOutfit);

  if (!allSlotsOk(slateCheck)) {
    console.warn('[STUDIO] CRITICAL_STUDIO_INVARIANT', {
      requestId: meta.requestId,
      userId: meta.userId,
      tier: environmentTier,
      slateCheck,
    });
    emitFinal = buildGuaranteedOutfits(
      partitioned,
      enrichedCtx,
      emitFinal,
      candidateExcludeLayer,
      candidateExcludeAccessory,
      fallbackQualityBooster,
    );
    outfits = emitFinal.map((s) => s.outfit);
    slateCheck = validateSlate(outfits);
  }

  if (!allSlotsOk(slateCheck)) {
    throw new StudioInvariantError(
      'STUDIO_SLOT_INVARIANT_FAILED',
      'Studio slate failed slot invariant after guaranteed-fallback rerun',
      { slateCheck, requestId: meta.requestId, userId: meta.userId },
    );
  }

  // PHASE 5 — final elite invariant. Defensive safety net that runs AFTER
  // the existing slot-validation gate. If the slate length is still off
  // target we log CRITICAL_ELITE_INVARIANT and re-run the guaranteed
  // builder one more time. Never throws; the pre-existing invariant
  // throw above remains the only failure path.
  if (outfits.length !== TARGET_OUTFITS) {
    console.error('[STUDIO] CRITICAL_ELITE_INVARIANT', {
      requestId: meta.requestId,
      userId: meta.userId,
      tier: environmentTier,
      length: outfits.length,
    });
    emitFinal = buildGuaranteedOutfits(
      partitioned,
      enrichedCtx,
      emitFinal,
      candidateExcludeLayer,
      candidateExcludeAccessory,
      fallbackQualityBooster,
    );
    outfits = emitFinal.map((s) => s.outfit);
  }

  // ── PHASE Z — STYLIST PERCEPTION OPTIMIZER ────────────────────────
  // Slate-level post-hoc optimizer. Runs ONLY after all invariants
  // have been satisfied; operates only on the final 3 outfits and the
  // already-ranked candidate pool. Does not regenerate candidates, does
  // not change composite scoring, does not add penalties, does not
  // modify the guarantee builder, does not touch elite scoring.
  //
  // Responsibilities:
  //   (1) Classify each outfit with stylist intent tags.
  //   (2) Enforce slate composition: swap lowest composite outfit with
  //       the best-ranked candidate that introduces the missing intent
  //       — only when a candidate exists and the swap preserves
  //       previously-covered required intents.
  //   (3) Visual differentiation lock: pairwise diff over
  //       {top.id, bottom.id, top.pattern, top.color_family}.
  //   (4) Narrative title rewrite using deterministic stylist framing.
  //
  // Swaps never reduce slate size. Skipped cleanly when no replacement
  // exists. All operations deterministic.
  if (outfits.length === TARGET_OUTFITS) {
    type StylistIntent = 'Minimal' | 'Statement' | 'Elevated' | 'Relaxed';

    const intentsOf = (o: StudioOutfit): Set<StylistIntent> => {
      const tags = new Set<StylistIntent>();
      const topPat = (o.slots.top.pattern ?? 'solid').toLowerCase();
      const botPat = (o.slots.bottom.pattern ?? 'solid').toLowerCase();
      const topSub = (o.slots.top.subcategory ?? '').toLowerCase();
      const botSub = (o.slots.bottom.subcategory ?? '').toLowerCase();
      const topDress = (o.slots.top.dress_code ?? '').toLowerCase();
      const topForm = Number(o.slots.top.formality_score ?? 0);
      const botForm = Number(o.slots.bottom.formality_score ?? 0);
      const topColorBlob = `${o.slots.top.color ?? ''} ${
        o.slots.top.color_family ?? ''
      }`.toLowerCase();

      if (topPat === 'solid' && botPat === 'solid') tags.add('Minimal');
      if (topPat !== 'solid' && topPat !== '') tags.add('Statement');
      // High-contrast color signal also qualifies as Statement.
      if (/\b(neon|bright|vibrant|bold|contrast)\b/.test(topColorBlob)) {
        tags.add('Statement');
      }
      if (/dress shirt/.test(topSub)) tags.add('Elevated');
      if (
        /smart[\s-]?casual|business[\s-]?casual|business|formal/.test(topDress)
      ) {
        tags.add('Elevated');
      }
      if (Math.max(topForm, botForm) >= 6) tags.add('Elevated');
      if (/t[\s-]?shirt|\btee\b|\btank\b/.test(topSub) && /shorts/.test(botSub)) {
        tags.add('Relaxed');
      }
      return tags;
    };

    const isBeachCtx =
      environmentTier === 'EXTREME_HEAT' &&
      isExplicitBeachIntent(enrichedCtx.effectiveQuery ?? '');

    // Required intent composition — beach vs. default slate.
    const requiredMust: StylistIntent[] = isBeachCtx
      ? ['Relaxed', 'Statement']
      : ['Minimal', 'Statement'];
    const requiredEither: StylistIntent[] = isBeachCtx
      ? ['Minimal', 'Elevated']
      : ['Elevated', 'Relaxed'];

    const coveredAcross = (arr: StudioOutfit[]): Set<StylistIntent> => {
      const u = new Set<StylistIntent>();
      for (const o of arr) for (const t of intentsOf(o)) u.add(t);
      return u;
    };

    const inSlate = (c: { outfit: StudioOutfit }): boolean =>
      outfits.some((o) => o.outfit_id === c.outfit.outfit_id);

    // Attempts a deterministic in-place swap that introduces `missing`
    // while not causing the slate to drop any currently-covered required
    // intent. Returns true if a swap happened.
    const trySwap = (missing: StylistIntent): boolean => {
      const replacement = candidateOutfits.find(
        (c) => !inSlate(c) && intentsOf(c.outfit).has(missing),
      );
      if (!replacement) return false;

      const replIntents = intentsOf(replacement.outfit);
      const beforeCovered = coveredAcross(outfits);

      // Pick the lowest-composite outfit we can safely replace — i.e.
      // removing it plus adding `replacement` preserves every required
      // intent previously covered by the slate.
      const orderedIdx = outfits
        .map((o, i) => ({ idx: i, score: o.score }))
        .sort((a, b) => a.score - b.score)
        .map((x) => x.idx);

      for (const i of orderedIdx) {
        const hypothetical = outfits.slice();
        hypothetical[i] = replacement.outfit;
        const afterCovered = coveredAcross(hypothetical);
        // Every required-must that WAS covered must still be covered.
        const losesMust = requiredMust.some(
          (r) => beforeCovered.has(r) && !afterCovered.has(r),
        );
        if (losesMust) continue;
        // The either-constraint must still be met if it was met before.
        const beforeEither = requiredEither.some((e) => beforeCovered.has(e));
        const afterEither = requiredEither.some((e) => afterCovered.has(e));
        if (beforeEither && !afterEither) continue;
        // Commit swap.
        outfits[i] = replacement.outfit;
        emitFinal[i] = replacement;
        void replIntents;
        return true;
      }
      return false;
    };

    // (2) Slate composition enforcement — must-have intents, then either.
    for (const req of requiredMust) {
      if (coveredAcross(outfits).has(req)) continue;
      trySwap(req);
    }
    if (!requiredEither.some((e) => coveredAcross(outfits).has(e))) {
      for (const e of requiredEither) {
        if (trySwap(e)) break;
      }
    }

    // (3) Visual differentiation lock. Pairwise diff over top.id,
    // bottom.id, top.pattern, top.color_family. Bounded pass count.
    const visualDiff = (a: StudioOutfit, b: StudioOutfit): number => {
      let d = 0;
      if (a.slots.top.id !== b.slots.top.id) d++;
      if (a.slots.bottom.id !== b.slots.bottom.id) d++;
      const aPat = (a.slots.top.pattern ?? 'solid').toLowerCase();
      const bPat = (b.slots.top.pattern ?? 'solid').toLowerCase();
      if (aPat !== bPat) d++;
      const aFam = (a.slots.top.color_family ?? a.slots.top.color ?? '')
        .toLowerCase()
        .trim();
      const bFam = (b.slots.top.color_family ?? b.slots.top.color ?? '')
        .toLowerCase()
        .trim();
      if (aFam !== bFam) d++;
      return d;
    };
    for (let pass = 0; pass < TARGET_OUTFITS; pass++) {
      let swapped = false;
      outerVisual: for (let i = 0; i < outfits.length; i++) {
        for (let j = i + 1; j < outfits.length; j++) {
          if (visualDiff(outfits[i], outfits[j]) >= 2) continue;
          const ref = outfits[i];
          const replacement = candidateOutfits.find(
            (c) => !inSlate(c) && visualDiff(c.outfit, ref) >= 2,
          );
          if (replacement) {
            outfits[j] = replacement.outfit;
            emitFinal[j] = replacement;
            swapped = true;
            break outerVisual;
          }
        }
      }
      if (!swapped) break;
    }

    // (5) Narrative title rewrite — deterministic stylist framing.
    // Priority when multiple intents present: Statement > Elevated >
    // Minimal > Relaxed (per spec). Beach contexts use beach-flavored
    // labels; non-beach uses neutral stylist labels. Titles fall through
    // to a generic tag-free default if no intent is detected, which is
    // itself deterministic and preserves a stylist tone.
    const labelPool = isBeachCtx
      ? {
          Statement: 'Tropical Statement',
          Elevated: 'Refined Coastal',
          Minimal: 'Clean Beach Minimal',
          Relaxed: 'Easy Shore Casual',
          Default: 'Curated Coastal',
        }
      : {
          Statement: 'Bold Statement',
          Elevated: 'Refined Polish',
          Minimal: 'Clean Minimal',
          Relaxed: 'Easy Casual',
          Default: 'Curated Look',
        };

    const priority: StylistIntent[] = [
      'Statement',
      'Elevated',
      'Minimal',
      'Relaxed',
    ];
    const titleFor = (o: StudioOutfit, slateIdx: number): string => {
      const intents = intentsOf(o);
      for (const p of priority) {
        if (intents.has(p)) {
          return `Look ${slateIdx} — ${labelPool[p]}`;
        }
      }
      return `Look ${slateIdx} — ${labelPool.Default}`;
    };
    for (let i = 0; i < outfits.length; i++) {
      outfits[i].title = titleFor(outfits[i], i + 1);
    }

    console.log('[STUDIO] STYLIST_PERCEPTION_OPTIMIZER_APPLIED', {
      requestId: meta.requestId,
      beach: isBeachCtx,
      intents: outfits.map((o) => [...intentsOf(o)]),
    });
  }

  // ── HARD NO-ZERO INVARIANT ───────────────────────────────────────
  // Absolute final safety net. Runs after every other path completes.
  // If for any reason outfits is empty AND the wardrobe has at least
  // one item in every mandatory slot, force a single fallback outfit
  // built from the first ranked item in each slot. Skips compatibility,
  // elite, and recovery validation. Never pads to 3 — emits exactly
  // one. Zero-result responses are now possible only when the wardrobe
  // is genuinely missing a category (handled by WARDROBE_INSUFFICIENT_*
  // throws upstream).
  if (
    outfits.length === 0 &&
    partitioned.tops.length > 0 &&
    partitioned.bottoms.length > 0 &&
    partitioned.shoes.length > 0
  ) {
    const forcedTop = partitioned.tops[0];
    const forcedBottom = partitioned.bottoms[0];
    const forcedShoes = partitioned.shoes[0];
    const forcedSlots: StudioSlots = {
      top: forcedTop,
      bottom: forcedBottom,
      shoes: forcedShoes,
      layer: null,
      accessory: null,
    };
    const forcedOutfit: StudioOutfit = {
      outfit_id: randomUUID(),
      title: `Look 1: ${forcedTop.label ?? 'Top'} with ${forcedBottom.label ?? 'Bottom'}`,
      why: '',
      reasoning: 'Best available outfit from your wardrobe.',
      score: 0,
      items: [forcedTop, forcedBottom, forcedShoes],
      slots: forcedSlots,
    };
    outfits = [forcedOutfit];
    console.warn('[STUDIO] HARD_NO_ZERO_TRIGGERED', {
      requestId: meta.requestId,
      userId: meta.userId,
      tier: environmentTier,
    });
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
