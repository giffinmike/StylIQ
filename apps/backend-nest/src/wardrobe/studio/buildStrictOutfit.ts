// apps/backend-nest/src/wardrobe/studio/buildStrictOutfit.ts
//
// Deterministic, strict single-outfit builder for AI Outfit Studio.
// Invariants are validated BEFORE any post-scoring step. Throws a
// StudioInvariantError on any mandatory-slot failure — no silent
// degradation, no relaxed retry, no slot dropping.

import { randomUUID } from 'crypto';
import {
  StudioInvariantError,
  type StudioBuildContext,
  type StudioItem,
  type StudioOutfit,
  type StudioSlots,
} from './types';
import {
  selectAccessory,
  selectLayer,
  shoesCompatibility,
  topBottomCompatibility,
} from './compatibility';
import {
  partitionBySlot,
  shouldSuppressAccessory,
  shouldSuppressLayer,
} from './filters';
import { scoreStudioItem, scoreStudioOutfit } from './scoring';

export interface StrictBuildOptions {
  /** IDs previously used in earlier outfits of the same slate. */
  excludeTopIds?: Set<string>;
  excludeBottomIds?: Set<string>;
  excludeShoesIds?: Set<string>;
  excludeLayerIds?: Set<string>;
  excludeAccessoryIds?: Set<string>;
  /** Allow reusing a mandatory item when the wardrobe is too small. */
  allowMandatoryReuse?: boolean;
  /** Outfit index in the slate (1-based); used for title generation. */
  slateIndex?: number;
}

export interface StrictBuildResult {
  outfit: StudioOutfit;
  usedIds: Set<string>;
}

function rankBy<T>(arr: T[], score: (item: T) => number): T[] {
  return arr
    .map((item, i) => ({ item, s: score(item), i }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.item);
}

function pickRankedBy(
  pool: StudioItem[],
  ctx: StudioBuildContext,
): StudioItem[] {
  return rankBy(pool, (it) => scoreStudioItem(it, ctx));
}

function composeTitle(slots: StudioSlots, slateIndex: number): string {
  const top = (slots.top.label || slots.top.name || 'Top').toString();
  const bottom = (slots.bottom.label || slots.bottom.name || 'Bottom')
    .toString()
    .split(' ')
    .slice(-2)
    .join(' ');
  const idx = Math.max(1, slateIndex);
  return `Look ${idx}: ${top} with ${bottom}`.replace(/\s+/g, ' ').trim();
}

function composeReasoning(slots: StudioSlots, ctx: StudioBuildContext): string {
  const parts: string[] = [];
  const topDesc = slots.top.label || slots.top.name || 'top';
  const bottomDesc = slots.bottom.label || slots.bottom.name || 'bottom';
  const shoeDesc = slots.shoes.label || slots.shoes.name || 'shoes';
  parts.push(`${topDesc} paired with ${bottomDesc} and ${shoeDesc}`);
  if (slots.layer) {
    parts.push(`layered with ${slots.layer.label ?? slots.layer.name ?? 'a jacket'}`);
  }
  if (slots.accessory) {
    parts.push(`finished with ${slots.accessory.label ?? slots.accessory.name ?? 'an accessory'}`);
  }
  const env = ctx.studio.environment;
  if (env && env !== 'everyday') {
    parts.push(`tuned for a ${env.replace('-', ' ')} setting`);
  }
  const dress = ctx.parsedConstraints.dressWanted;
  if (dress) parts.push(`${dress.toLowerCase()} tone`);
  return parts.join('; ') + '.';
}

function validateSlots(slots: Partial<StudioSlots>): StudioSlots {
  if (!slots.top) {
    throw new StudioInvariantError(
      'STUDIO_SLOT_INVARIANT_FAILED',
      'Studio outfit missing mandatory top slot',
    );
  }
  if (!slots.bottom) {
    throw new StudioInvariantError(
      'STUDIO_SLOT_INVARIANT_FAILED',
      'Studio outfit missing mandatory bottom slot',
    );
  }
  if (!slots.shoes) {
    throw new StudioInvariantError(
      'STUDIO_SLOT_INVARIANT_FAILED',
      'Studio outfit missing mandatory shoes slot',
    );
  }
  return {
    top: slots.top,
    bottom: slots.bottom,
    shoes: slots.shoes,
    layer: slots.layer ?? null,
    accessory: slots.accessory ?? null,
  };
}

/**
 * Build one deterministic, strictly structured outfit.
 *
 * Steps:
 *   1. Partition the filtered pool by slot.
 *   2. Rank each slot by item score; iterate candidates in order.
 *   3. Pick the highest-scored compatible (top → bottom → shoes) triple.
 *   4. Optionally add the best compatible layer + accessory.
 *   5. Validate invariants — throw on any mandatory-slot failure.
 *   6. Score the outfit and return.
 *
 * No mutation of inputs. No silent fallback. Diversity is managed by the
 * caller (orchestrator) via the `exclude*Ids` sets.
 */
export function buildStrictOutfit(
  pool: StudioItem[],
  ctx: StudioBuildContext,
  opts: StrictBuildOptions = {},
): StrictBuildResult | null {
  const partitioned = partitionBySlot(pool);

  const excludeTop = opts.excludeTopIds ?? new Set<string>();
  const excludeBottom = opts.excludeBottomIds ?? new Set<string>();
  const excludeShoes = opts.excludeShoesIds ?? new Set<string>();
  const excludeLayer = opts.excludeLayerIds ?? new Set<string>();
  const excludeAccessory = opts.excludeAccessoryIds ?? new Set<string>();

  // Ranked candidate pools (highest score first). These are stable within a
  // single request so the builder is deterministic for a given input.
  const rankedTops = pickRankedBy(partitioned.tops, ctx);
  const rankedBottoms = pickRankedBy(partitioned.bottoms, ctx);
  const rankedShoes = pickRankedBy(partitioned.shoes, ctx);

  // Guard against completely empty slot pools — no amount of compatibility
  // iteration will rescue a missing slot.
  if (rankedTops.length === 0) {
    throw new StudioInvariantError(
      'WARDROBE_INSUFFICIENT_TOPS',
      'No tops available in wardrobe for AI Outfit Studio',
    );
  }
  if (rankedBottoms.length === 0) {
    throw new StudioInvariantError(
      'WARDROBE_INSUFFICIENT_BOTTOMS',
      'No bottoms available in wardrobe for AI Outfit Studio',
    );
  }
  if (rankedShoes.length === 0) {
    throw new StudioInvariantError(
      'WARDROBE_INSUFFICIENT_SHOES',
      'No shoes available in wardrobe for AI Outfit Studio',
    );
  }

  // Bounded exhaustive search for the best compatible (top, bottom,
  // shoes) triple. Scanning the top-K of each slot gives the stylist
  // a real chance at a globally better combination than the greedy
  // early-break approach, while capping worst-case cost at K_T*K_B*K_S
  // compatibility checks per outfit (≈ a few hundred).
  //
  // Triple score combines pairwise compatibility (the authoritative
  // signal) with a small item-preference nudge so ties break toward
  // the stylist's higher-ranked pieces. Item nudges are weighted low
  // to keep compatibility dominant.
  const reuseAllowed = opts.allowMandatoryReuse === true;

  // Filter excluded items BEFORE the K-slice so the search window is
  // never wasted on items that can't be picked. When reuse is allowed
  // (wardrobe too small for the 3-outfit slate) the exclude set is
  // retained as a soft diversity signal instead of a hard filter.
  const eligibleTops = reuseAllowed
    ? rankedTops
    : rankedTops.filter((t) => !excludeTop.has(t.id));
  const eligibleBottoms = reuseAllowed
    ? rankedBottoms
    : rankedBottoms.filter((b) => !excludeBottom.has(b.id));
  const eligibleShoes = reuseAllowed
    ? rankedShoes
    : rankedShoes.filter((s) => !excludeShoes.has(s.id));

  // FIX 3 — slot depth safety: when any mandatory pool is shallow, widen
  // the K-slice for every slot to the full eligible pool so combinatorics
  // are never artificially starved. Global K constants stay untouched.
  const depthShallow =
    eligibleBottoms.length < 3 || eligibleShoes.length < 2;
  const K_TOPS = depthShallow
    ? eligibleTops.length
    : Math.min(eligibleTops.length, 6);
  const K_BOTTOMS = depthShallow
    ? eligibleBottoms.length
    : Math.min(eligibleBottoms.length, 6);
  const K_SHOES = depthShallow
    ? eligibleShoes.length
    : Math.min(eligibleShoes.length, 8);

  interface TripleCandidate {
    top: StudioItem;
    bottom: StudioItem;
    shoes: StudioItem;
    score: number;
    patternCount: number;
    heroCount: number;
    order: number;
  }

  const usedSignatures = new Set<string>();
  const candidates: TripleCandidate[] = [];

  // Diversity penalties encode a preference for fresh items over reused
  // ones, but they're only meaningful when a slot has at least one fresh
  // alternative. When the entire slot has been exhausted (e.g. wardrobe
  // has a single top that must be reused across the slate) the penalty
  // becomes a universal drag that collapses every neutral-compatible
  // triple below zero and gets rejected by FIX 1. Suppress per-slot.
  const topFreshAvailable = eligibleTops.some((t) => !excludeTop.has(t.id));
  const bottomFreshAvailable = eligibleBottoms.some(
    (b) => !excludeBottom.has(b.id),
  );
  const shoesFreshAvailable = eligibleShoes.some(
    (s) => !excludeShoes.has(s.id),
  );

  for (let ti = 0; ti < K_TOPS; ti++) {
    const top = eligibleTops[ti];
    const topNudge = scoreStudioItem(top, ctx) * 0.1;
    // Diversity penalty: when reuse is allowed (small wardrobe), still
    // prefer a non-reused option if compatibility is comparable. Scale
    // chosen so the penalty is decisive against flat ties but never
    // overrides a meaningful compatibility difference.
    const topDiv =
      reuseAllowed && topFreshAvailable && excludeTop.has(top.id) ? -0.5 : 0;

    for (let bi = 0; bi < K_BOTTOMS; bi++) {
      const bottom = eligibleBottoms[bi];
      const tb = topBottomCompatibility(top, bottom, ctx);
      if (!tb.compatible) continue;
      const bottomNudge = scoreStudioItem(bottom, ctx) * 0.1;
      const bottomDiv =
        reuseAllowed && bottomFreshAvailable && excludeBottom.has(bottom.id)
          ? -0.5
          : 0;

      for (let si = 0; si < K_SHOES; si++) {
        const shoes = eligibleShoes[si];

        // Hard exclusion for iteration 2+: no core-slot item reuse,
        // but only when the slot has a fresh alternative available.
        if ((opts.slateIndex ?? 1) > 1) {
          if (eligibleTops.length > 1 && opts.excludeTopIds?.has(top.id))
            continue;
          if (
            eligibleBottoms.length > 1 &&
            opts.excludeBottomIds?.has(bottom.id)
          )
            continue;
          if (eligibleShoes.length > 1 && opts.excludeShoesIds?.has(shoes.id))
            continue;
        }

        const sh = shoesCompatibility(top, bottom, shoes, ctx);
        if (!sh.compatible) continue;

        const shoesNudge = scoreStudioItem(shoes, ctx) * 0.1;
        const shoesDiv =
          reuseAllowed && shoesFreshAvailable && excludeShoes.has(shoes.id)
            ? -0.3
            : 0;

        // BASE COMPATIBILITY LIFT:
        // Applied to the FINAL triple so diversity penalties
        // cannot erase structural validity.
        const BASE_COMPAT_SCORE = 0.2;

        const qualityScore =
          tb.score +
          sh.score +
          topNudge +
          bottomNudge +
          shoesNudge;

        // Reject only if penalties would overpower even the baseline.
        if (qualityScore < -BASE_COMPAT_SCORE) continue;

        const triple =
          BASE_COMPAT_SCORE +
          qualityScore +
          topDiv +
          bottomDiv +
          shoesDiv;

        // FIX 2 — strict unique core signature: no duplicate top/bottom/
        // shoe trio can enter the candidate set.
        const signature = `${top.id}-${bottom.id}-${shoes.id}`;
        if (usedSignatures.has(signature)) continue;
        usedSignatures.add(signature);

        // FIX 4 metadata — distinct color proxy for pattern variety +
        // hero-role presence (formality_score >= 7). Used deterministically
        // in the tie-break below; scoring.ts is not mutated.
        const colors = new Set(
          [top, bottom, shoes]
            .map((i) =>
              ((i.color_family ?? i.color ?? '') + '').toLowerCase().trim(),
            )
            .filter((c) => c.length > 0),
        );
        const heroCount = [top, bottom, shoes].filter(
          (i) => Number(i.formality_score ?? 0) >= 7,
        ).length;

        candidates.push({
          top,
          bottom,
          shoes,
          score: triple,
          patternCount: colors.size,
          heroCount,
          order: candidates.length,
        });
      }
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  // FIX 4 — deterministic tie-break: sort by score desc. When two scores
  // are within 0.01 of each other, prefer the triple with more distinct
  // colors, then more hero-role items, then the earlier insertion order
  // (ranked-pool order). No randomness, no mutation of scoring.
  candidates.sort((a, b) => {
    const d = b.score - a.score;
    if (Math.abs(d) < 0.01) {
      if (b.patternCount !== a.patternCount)
        return b.patternCount - a.patternCount;
      if (b.heroCount !== a.heroCount) return b.heroCount - a.heroCount;
      return a.order - b.order;
    }
    return d;
  });

  // Strict viability filter. A zero-score triple carries no compatibility,
  // style, weather, tier, or diversity signal and is not a meaningful
  // outfit. For iteration 1 we preserve the invariant that a slate must
  // begin with at least one outfit whenever compatible candidates exist;
  // neutral-signal pools legitimately produce exactly-zero triples and
  // the best zero-score candidate is accepted so the slate can start.
  // For iteration 2+ an empty viable set returns null to signal the
  // orchestrator that no more meaningful combinations remain and the
  // slate should stop early rather than emit zero-score filler.
  const finalizeStrictOutfit = (best: TripleCandidate): StrictBuildResult => {
    const chosenTop: StudioItem = best.top;
    const chosenBottom: StudioItem = best.bottom;
    const chosenShoes: StudioItem = best.shoes;

    const alreadyUsed = new Set<string>([
      chosenTop.id,
      chosenBottom.id,
      chosenShoes.id,
    ]);

    // Optional layer.
    let layer: StudioItem | null = null;
    if (!shouldSuppressLayer(ctx)) {
      layer = selectLayer(
        chosenTop,
        chosenBottom,
        partitioned.outerwear,
        ctx,
        new Set<string>([...excludeLayer, ...alreadyUsed]),
      );
      if (layer) alreadyUsed.add(layer.id);
    }

    // Optional accessory.
    let accessory: StudioItem | null = null;
    if (!shouldSuppressAccessory(ctx)) {
      accessory = selectAccessory(
        chosenTop,
        chosenBottom,
        partitioned.accessories,
        ctx,
        new Set<string>([...excludeAccessory, ...alreadyUsed]),
      );
      if (accessory) alreadyUsed.add(accessory.id);
    }

    const slots = validateSlots({
      top: chosenTop,
      bottom: chosenBottom,
      shoes: chosenShoes,
      layer,
      accessory,
    });

    const items: StudioItem[] = [slots.top, slots.bottom, slots.shoes];
    if (slots.layer) items.push(slots.layer);
    if (slots.accessory) items.push(slots.accessory);

    const score = scoreStudioOutfit(slots, ctx);
    const title = composeTitle(slots, opts.slateIndex ?? 1);
    const reasoning = composeReasoning(slots, ctx);

    const outfit: StudioOutfit = {
      outfit_id: randomUUID(),
      title,
      why: reasoning,
      reasoning,
      score,
      items,
      slots,
    };

    return { outfit, usedIds: alreadyUsed };
  };

  const viable = candidates.filter((c) => c.score > 0);
  const slateIndex = opts.slateIndex ?? 1;

  if (viable.length === 0) {
    if (slateIndex === 1 && candidates.length > 0) {
      // Allow neutral baseline for first outfit only
      const best = candidates[0];
      return finalizeStrictOutfit(best);
    }

    // Iteration 2+ with no strictly positive candidates
    return null;
  }

  const best = viable[0];
  return finalizeStrictOutfit(best);
}
