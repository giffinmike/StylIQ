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
): StrictBuildResult {
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
  const K_TOPS = Math.min(rankedTops.length, 6);
  const K_BOTTOMS = Math.min(rankedBottoms.length, 6);
  const K_SHOES = Math.min(rankedShoes.length, 8);

  let chosenTop: StudioItem | null = null;
  let chosenBottom: StudioItem | null = null;
  let chosenShoes: StudioItem | null = null;
  let chosenScore = -Infinity;

  const reuseAllowed = opts.allowMandatoryReuse === true;

  const eligible = (item: StudioItem, exclude: Set<string>): boolean =>
    !exclude.has(item.id) || reuseAllowed;

  for (let ti = 0; ti < K_TOPS; ti++) {
    const top = rankedTops[ti];
    if (!eligible(top, excludeTop)) continue;
    const topNudge = scoreStudioItem(top, ctx) * 0.1;

    for (let bi = 0; bi < K_BOTTOMS; bi++) {
      const bottom = rankedBottoms[bi];
      if (!eligible(bottom, excludeBottom)) continue;
      const tb = topBottomCompatibility(top, bottom, ctx);
      if (!tb.compatible) continue;
      const bottomNudge = scoreStudioItem(bottom, ctx) * 0.1;

      for (let si = 0; si < K_SHOES; si++) {
        const shoes = rankedShoes[si];
        if (!eligible(shoes, excludeShoes)) continue;
        const sh = shoesCompatibility(top, bottom, shoes, ctx);
        if (!sh.compatible) continue;

        const shoesNudge = scoreStudioItem(shoes, ctx) * 0.1;
        const triple =
          tb.score + sh.score + topNudge + bottomNudge + shoesNudge;

        if (triple > chosenScore) {
          chosenTop = top;
          chosenBottom = bottom;
          chosenShoes = shoes;
          chosenScore = triple;
        }
      }
    }
  }

  if (!chosenTop || !chosenBottom || !chosenShoes) {
    throw new StudioInvariantError(
      'WARDROBE_INSUFFICIENT_COMPATIBLE',
      'No mutually compatible top/bottom/shoes triple could be assembled',
      {
        topsPoolSize: rankedTops.length,
        bottomsPoolSize: rankedBottoms.length,
        shoesPoolSize: rankedShoes.length,
      },
    );
  }

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
}
