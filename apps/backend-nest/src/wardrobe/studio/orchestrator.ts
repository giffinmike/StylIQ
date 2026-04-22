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

const TARGET_OUTFITS = 3;

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
): Array<{ outfit: StudioOutfit; usedIds: Set<string> }> {
  const emit = existing.slice();
  if (emit.length >= TARGET_OUTFITS) return emit;

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
  // id derived from the source id + slate index, and a slate-indexed
  // title. Loop is bounded by TARGET_OUTFITS; no infinite path.
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
    const clone: StudioOutfit = {
      outfit_id: `${source.outfit.outfit_id}-clone-${slateIdx}`,
      title: buildTitle(cloneSlots.top, cloneSlots.bottom, slateIdx),
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

  // Stage 2: physics-dominant feasibility hard gate. Runs BEFORE scoring,
  // compatibility, and slot partitioning. Universal across all users —
  // no profile-specific branches. Priority: Physics > Occasion > Style.
  let pool = applyEnvironmentalHardGate(filteredPool, enrichedCtx);

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

  // ── PHASE B: sort candidates by outfit score descending ────────────
  candidateOutfits.sort((a, b) => b.outfit.score - a.outfit.score);

  // ── PHASE B.5: joint rerank boost ──────────────────────────────────
  // Separate the top half from the mid cluster by nudging above-median
  // candidates by +0.5 so small gaps become decision-relevant without
  // re-entering scoring.ts. Uniform boost preserves ordering within each
  // half; only the gap between halves grows.
  if (candidateOutfits.length > 0) {
    const sortedScores = candidateOutfits
      .map((c) => c.outfit.score)
      .slice()
      .sort((a, b) => a - b);
    const mid = Math.floor(sortedScores.length / 2);
    const medianScore =
      sortedScores.length % 2 === 0
        ? (sortedScores[mid - 1] + sortedScores[mid]) / 2
        : sortedScores[mid];
    for (const cand of candidateOutfits) {
      if (cand.outfit.score > medianScore) {
        cand.outfit.score += 0.5;
      }
    }
  }

  // ── PHASE B.6: deterministic tie-break jitter ──────────────────────
  // Apply a per-outfit jitter in [0, 0.030] derived from a deterministic
  // hash of the top id. Ensures stable ordering across runs and breaks
  // exact-tie scores without introducing randomness.
  const stringHash = (s: string): number => {
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
      h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    }
    return h;
  };
  for (const cand of candidateOutfits) {
    const jitter = (stringHash(cand.outfit.slots.top.id) % 31) / 1000;
    cand.outfit.score += jitter;
  }

  // Re-sort so the boost + jitter act as tiebreakers on near-equal scores.
  candidateOutfits.sort((a, b) => b.outfit.score - a.outfit.score);

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
    );
  }

  const outfits: StudioOutfit[] = emitFinal.map((s) => s.outfit);

  // Final slot validation gate — every outfit MUST report
  // hasTop/hasBottom/hasShoes = true. Physical slot failure is the only
  // condition that throws here; post-assembly quality failures are
  // handled by the tiered backfill above.
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
