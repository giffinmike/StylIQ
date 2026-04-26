import { parseConstraints } from './constraints';
import {
  mapMainCategoryToSlot,
  isSlot,
  filterBySlot,
  type Slot,
} from './categoryMapping';

export type CatalogItemLite = {
  index: number;
  id: string;
  label: string;
  image_url?: string;

  main_category?: string;
  subcategory?: string;
  color?: string;
  color_family?: string;
  shoe_style?: string;
  dress_code?: string;
  formality_score?: number;
};

/**
 * Post-LLM slot enforcement + backfill
 * - De-dupes to one Top/Bottom/Shoes (with sensible prefs)
 * - Honors explicit user excludes (no loafers/sneakers/boots/brown)
 * - Ensures core slots exist; sets `missing` hints when not possible
 */
export function finalizeOutfitSlots(
  outfit: {
    title: string;
    items: CatalogItemLite[];
    why: string;
    missing?: string;
  },
  catalog: CatalogItemLite[],
  q: string,
) {
  const c = parseConstraints(q);
  const items = [...(outfit.items || [])];

  const ql = (q || '').toLowerCase();
  const excludeLoafers = /\b(no|without|exclude|avoid)\s+loafers?\b/.test(ql);
  const excludeSneakers = /\b(no|without|exclude|avoid)\s+sneakers?\b/.test(ql);
  const excludeBoots = /\b(no|without|exclude|avoid)\s+boots?\b/.test(ql);
  const excludeBrown = /\b(no|without|exclude|avoid)\s+brown\b/.test(ql);
  const userExcludedAllShoes =
    excludeLoafers && excludeSneakers && excludeBoots;
  const modelSaysNoFootwear =
    /\b(no suitable .*footwear|no appropriate .*footwear|footwear.*unavailable|no .*shoe)/i.test(
      outfit.missing || '',
    );

  const appendMissing = (msg: string) => {
    outfit.missing = outfit.missing ? `${outfit.missing}; ${msg}` : msg;
  };

  const lc = (s?: string) => (s ?? '').toLowerCase();
  const subOf = (x: CatalogItemLite) => lc(x.subcategory);
  const styleOf = (x: CatalogItemLite) => lc(x.shoe_style);

  const isLoafer = (x: CatalogItemLite) =>
    /loafer/.test(subOf(x)) || /loafer/.test(styleOf(x));
  const isSneaker = (x: CatalogItemLite) =>
    /(sneaker|trainer)/.test(subOf(x)) || /(sneaker|trainer)/.test(styleOf(x));
  const isBoot = (x: CatalogItemLite) =>
    /boot/.test(subOf(x)) || /boot/.test(styleOf(x));
  // Use canonical slot mapping for footwear detection
  const isFootwear = (x: CatalogItemLite) =>
    isSlot(x, 'shoes') ||
    [
      'loafer',
      'sneaker',
      'trainer',
      'boot',
      'heel',
      'pump',
      'oxford',
      'derby',
      'dress shoe',
      'sandal',
    ].some((k) => subOf(x).includes(k));

  const isBrownish = (x: CatalogItemLite) => {
    const a = lc(x.color);
    const b = lc(x.color_family);
    const lbl = lc(x.label);
    return (
      a.includes('brown') ||
      b === 'brown' ||
      a.includes('tan') ||
      a.includes('cognac') ||
      lbl.includes('brown') ||
      lbl.includes('tan') ||
      lbl.includes('cognac')
    );
  };

  // De-dup outerwear (prefer blazer/sport coat)
  // Use canonical slot mapping for outerwear detection
  const outers = items
    .map((it, i) => ({ it, i }))
    .filter(({ it }) => isSlot(it, 'outerwear'));
  if (outers.length > 1) {
    const prefScore = (s?: string) =>
      /\b(blazer|sport\s*coat)\b/i.test(lc(s)) ? 0 : 1;
    outers.sort(
      (a, b) =>
        prefScore(a.it.subcategory) - prefScore(b.it.subcategory) ||
        (a.it.index ?? 999) - (b.it.index ?? 999),
    );
    const keep = outers[0].i;
    const toRemove = outers
      .map((x) => x.i)
      .filter((i) => i !== keep)
      .sort((a, b) => b - a);
    for (const i of toRemove) items.splice(i, 1);
  }

  const pruneToOne = (
    pred: (x: CatalogItemLite) => boolean,
    prefer?: (A: CatalogItemLite, B: CatalogItemLite) => number,
  ) => {
    const matches = items
      .map((it, i) => ({ it, i }))
      .filter(({ it }) => pred(it));
    if (matches.length <= 1) return;

    matches.sort((a, b) =>
      prefer ? prefer(a.it, b.it) : (a.it.index ?? 999) - (b.it.index ?? 999),
    );
    const keep = matches[0].i;
    const toRemove = matches
      .map((m) => m.i)
      .filter((i) => i !== keep)
      .sort((a, b) => b - a);
    for (const i of toRemove) items.splice(i, 1);
  };

  const preferBottoms = (A: CatalogItemLite, B: CatalogItemLite) => {
    const aJeans = subOf(A) === 'jeans';
    const bJeans = subOf(B) === 'jeans';
    if (c.dressWanted === 'BusinessCasual') {
      if (aJeans && !bJeans) return 1;
      if (bJeans && !aJeans) return -1;
    }
    return (A.index ?? 999) - (B.index ?? 999);
  };

  const isExcludedShoe = (x: CatalogItemLite) =>
    (excludeLoafers && isLoafer(x)) ||
    (excludeSneakers && isSneaker(x)) ||
    (excludeBoots && isBoot(x)) ||
    (excludeBrown && isBrownish(x));

  const preferShoes = (A: CatalogItemLite, B: CatalogItemLite) => {
    const aExcluded = isExcludedShoe(A);
    const bExcluded = isExcludedShoe(B);
    if (aExcluded !== bExcluded) return aExcluded ? 1 : -1;

    const aLoafer = isLoafer(A),
      bLoafer = isLoafer(B);
    if (c.wantsLoafers && !excludeLoafers && aLoafer !== bLoafer)
      return aLoafer ? -1 : 1;

    const aBrown = isBrownish(A),
      bBrown = isBrownish(B);
    if (c.wantsBrown && !excludeBrown && aBrown !== bBrown)
      return aBrown ? -1 : 1;

    return (A.index ?? 999) - (B.index ?? 999);
  };

  // Use canonical slot mapping for category detection
  const getSlot = (x: CatalogItemLite): Slot =>
    mapMainCategoryToSlot(x.main_category ?? '');
  const isTop = (x: CatalogItemLite) => getSlot(x) === 'tops';
  const isBottom = (x: CatalogItemLite) => getSlot(x) === 'bottoms';
  const isDress = (x: CatalogItemLite) => getSlot(x) === 'dresses';
  const isActivewear = (x: CatalogItemLite) => getSlot(x) === 'activewear';
  const isSwimwear = (x: CatalogItemLite) => getSlot(x) === 'swimwear';

  pruneToOne(isTop);
  pruneToOne(isBottom, preferBottoms);
  pruneToOne((x) => isFootwear(x), preferShoes);

  const hasTop = items.some(isTop);
  const hasBottom = items.some(isBottom);
  const hasDress = items.some(isDress);
  const hasActivewear = items.some(isActivewear);
  const hasSwimwear = items.some(isSwimwear);
  const hasFootwear = items.some((x) => isFootwear(x));

  // Slot-aware completeness: one-piece items replace top+bottom requirement
  const isOnePieceOutfit = hasDress || hasActivewear || hasSwimwear;

  const pickBest = (
    pred: (x: CatalogItemLite) => boolean,
    prefer?: (A: CatalogItemLite, B: CatalogItemLite) => number,
  ) => {
    const pool = catalog.filter(pred);
    if (!pool.length) return undefined;
    if (!prefer) return pool[0];
    return pool.slice().sort(prefer)[0];
  };

  // Only require top+bottom for separates outfits (not dresses/activewear/swimwear)
  if (!isOnePieceOutfit) {
    if (!hasTop) {
      const top = pickBest((x) => isTop(x));
      if (top) items.push(top);
      else appendMissing('A shirt');
    }

    if (!hasBottom) {
      const isBeach = /\b(beach|pool|swim|resort|tropical|yacht|cruise)\b/i.test(q);
      const bottom = pickBest(
        (x) => isBottom(x) && (isBeach || subOf(x) !== 'shorts'),
        preferBottoms,
      );
      if (bottom) items.push(bottom);
      else appendMissing('Dress trousers');
    }
  }

  const currentlyHasLoafer = items.some(isLoafer);
  if (userExcludedAllShoes || modelSaysNoFootwear) {
    if (!hasFootwear) appendMissing('Footwear');
  } else if (c.wantsLoafers && !excludeLoafers) {
    if (!currentlyHasLoafer) {
      const loafer =
        (c.wantsBrown &&
          !excludeBrown &&
          pickBest((x) => isLoafer(x) && isBrownish(x))) ||
        pickBest((x) => isLoafer(x));
      if (loafer) {
        const idx = items.findIndex((x) => isFootwear(x));
        if (idx >= 0) items[idx] = loafer;
        else items.push(loafer);
        if (c.wantsBrown && !excludeBrown && !isBrownish(loafer))
          appendMissing('Brown loafers');
      } else {
        const alt = pickBest(
          (x) => isFootwear(x) && !isExcludedShoe(x),
          preferShoes,
        );
        if (alt) {
          const idx = items.findIndex((x) => isFootwear(x));
          if (idx >= 0) items[idx] = alt;
          else items.push(alt);
        }
        appendMissing(
          c.wantsBrown && !excludeBrown ? 'Brown loafers' : 'Loafers',
        );
      }
    } else if (c.wantsBrown && !excludeBrown) {
      const idx = items.findIndex(isLoafer);
      if (idx >= 0 && !isBrownish(items[idx])) {
        const brownLoafer = pickBest((x) => isLoafer(x) && isBrownish(x));
        if (brownLoafer) items[idx] = brownLoafer;
        else appendMissing('Brown loafers');
      }
    }
  } else if (!hasFootwear) {
    const shoe = pickBest(
      (x) => isFootwear(x) && !isExcludedShoe(x),
      preferShoes,
    );
    if (shoe) items.push(shoe);
    else appendMissing('Footwear');
  }

  return { ...outfit, items };
}

/**
 * Post-LLM validator + array-level fallback
 * - Applies intent guards (gym/beach/wedding/black-tie)
 * - Drops/repairs items that violate the context
 * - If LLM returned zero/empty outfits, builds a deterministic fallback outfit
 */
export function validateOutfits(
  query: string,
  catalog: CatalogItemLite[],
  outfits: Array<{
    title: string;
    items: CatalogItemLite[];
    why: string;
    missing?: string;
  }>,
) {
  const q = (query || '').toLowerCase();
  const gym =
    /\b(gym|work\s?out|workout|training|exercise|hiit|running)\b/.test(q);
  const beach = /\b(beach|pool|swim|resort|vacation|cruise)\b/.test(q);
  const wedding = /\b(wedding|ceremony|reception)\b/.test(q);
  const blackTie = /\b(black\s*tie|white\s*tie|tux(edo)?)\b/.test(q);

  const lc = (s?: string) => (s ?? '').toLowerCase();
  // Use canonical slot mapping for category detection
  const isBottom = (x?: CatalogItemLite) =>
    !!x &&
    (isSlot(x, 'bottoms') ||
      /\b(shorts|trouser|pants|jeans|chinos|joggers?|sweatpants?|track)\b/i.test(
        lc(x.subcategory),
      ));

  const isShoes = (x?: CatalogItemLite) => !!x && isSlot(x, 'shoes');
  const isSneaker = (x?: CatalogItemLite) =>
    !!x &&
    /\b(sneakers?|trainers?|running|athletic)\b/i.test(lc(x.subcategory));
  const isDressShoe = (x?: CatalogItemLite) =>
    !!x &&
    /\b(oxfords?|derbys?|monks?|dress\s*shoes?|loafers?)\b/i.test(
      lc(x.subcategory),
    );
  const isShort = (x?: CatalogItemLite) =>
    !!x && /\bshorts?\b/i.test(lc(x.subcategory));
  const isHoodie = (x?: CatalogItemLite) =>
    !!x && /\bhoodie\b/i.test(lc(x.subcategory));
  const isOuter = (x?: CatalogItemLite) => !!x && isSlot(x, 'outerwear');

  const orderRank = (c: CatalogItemLite) =>
    isSlot(c, 'tops')
      ? 1
      : isBottom(c)
        ? 2
        : isShoes(c)
          ? 3
          : isOuter(c)
            ? 4
            : 5;

  const pickFirst = (
    pool: CatalogItemLite[],
    pred: (x: CatalogItemLite) => boolean,
  ) => pool.find(pred);

  const applyContextGuards = (itemsIn: CatalogItemLite[]) => {
    let items = [...itemsIn];

    if (gym && !items.some(isSneaker)) {
      const snk = pickFirst(catalog, isSneaker);
      if (snk) items.push(snk);
    }

    if (wedding || blackTie) {
      items = items.filter((x) => !(isShort(x) || isHoodie(x) || isSneaker(x)));
      if (!items.some(isDressShoe)) {
        const ds = pickFirst(catalog, isDressShoe);
        if (ds) {
          const shoeIdx = items.findIndex(isShoes);
          if (shoeIdx >= 0) items[shoeIdx] = ds;
          else items.push(ds);
        }
      }
    }

    if (beach) {
      const heavyOuterIdx = items.findIndex(
        (x) =>
          isOuter(x) &&
          !/\b(linen|lightweight|unstructured)\b/i.test(x.label || ''),
      );
      if (heavyOuterIdx >= 0) items.splice(heavyOuterIdx, 1);
    }

    return items.sort((a, b) => orderRank(a) - orderRank(b)).slice(0, 6);
  };

  let out = outfits.map((o) => ({
    ...o,
    items: applyContextGuards(o.items || []),
  }));

  // Array-level fallback if LLM produced nothing useful
  if (out.length === 0 || out.every((o) => (o.items || []).length === 0)) {
    // Use canonical slot mapping for category filtering
    const tops = filterBySlot(catalog, 'tops');
    const bottoms = catalog.filter(isBottom);
    const sneakers = catalog.filter(isSneaker);
    const dressShoes = catalog.filter(isDressShoe);
    const anyShoes = catalog.filter(isShoes);

    const top = tops[0];
    const bottom =
      (gym &&
        bottoms.find((b) =>
          /\b(shorts|joggers?|track|sweatpants?)\b/i.test(lc(b.subcategory)),
        )) ||
      (beach && bottoms.find((b) => /\bshorts?\b/i.test(lc(b.subcategory)))) ||
      ((wedding || blackTie) &&
        bottoms.find((b) =>
          /\b(trousers?|dress|suit)\b/i.test(lc(b.subcategory)),
        )) ||
      bottoms[0];

    const shoe =
      (gym && (sneakers[0] ?? anyShoes[0])) ||
      ((wedding || blackTie) && (dressShoes[0] ?? anyShoes[0])) ||
      anyShoes[0];

    const items = [top, bottom, shoe].filter(Boolean);
    if (items.length) {
      out = [
        {
          title:
            (beach && 'Beach Fallback') ||
            (wedding && 'Wedding Fallback') ||
            (blackTie && 'Black Tie Fallback') ||
            (gym && 'Gym Fallback') ||
            'Smart Fallback',
          items,
          why: 'Auto-constructed from top-ranked catalog to satisfy context and slot coverage.',
        },
      ];
    }
  }

  return out;
}

/**
 * Hard validation gate — discards any outfit that is not structurally wearable.
 *
 * Valid structures (gender-neutral, slot-based):
 *   1. SEPARATES  → tops + bottoms + shoes
 *   2. ONE-PIECE  → dresses + shoes  (covers Formalwear, TraditionalWear via slot mapping)
 *   3. ACTIVEWEAR → activewear + shoes
 *   4. SWIMWEAR   → swimwear  (shoes NOT required)
 *
 * Accessories / outerwear / undergarments may exist but never satisfy core requirements.
 */
export function validateOutfitCore<
  T extends { title?: string; items: Array<{ main_category?: string | null }> },
>(outfits: T[], query?: string): T[] {
  return outfits.filter((outfit, idx) => {
    const items = outfit.items ?? [];
    if (items.length === 0) {
      // console.log(
      //   `[validateOutfitCore] REJECT outfit ${idx} "${outfit.title ?? ''}": no items`,
      // );
      return false;
    }

    const hasTop = items.some((it) => isSlot(it, 'tops'));
    const hasBottom = items.some((it) => isSlot(it, 'bottoms'));
    const hasShoes = items.some((it) => isSlot(it, 'shoes'));
    const hasDress = items.some((it) => isSlot(it, 'dresses'));
    const hasActivewear = items.some((it) => isSlot(it, 'activewear'));
    const hasSwimwear = items.some((it) => isSlot(it, 'swimwear'));

    // 4. SWIMWEAR — shoes optional
    if (hasSwimwear) return true;

    // 3. ACTIVEWEAR — needs shoes
    if (hasActivewear) {
      if (hasShoes) return true;
      // console.log(
      //   `[validateOutfitCore] REJECT outfit ${idx} "${outfit.title ?? ''}": activewear missing shoes`,
      // );
      return false;
    }

    // 2. ONE-PIECE — dresses (incl. Formalwear, TraditionalWear) + shoes
    if (hasDress) {
      if (hasShoes) return true;
      // console.log(
      //   `[validateOutfitCore] REJECT outfit ${idx} "${outfit.title ?? ''}": dress/one-piece missing shoes`,
      // );
      return false;
    }

    // 1. SEPARATES — tops + bottoms + shoes
    if (hasTop && hasBottom && hasShoes) return true;

    const missing: string[] = [];
    if (!hasTop) missing.push('tops');
    if (!hasBottom) missing.push('bottoms');
    if (!hasShoes) missing.push('shoes');
    // console.log(
    //   `[validateOutfitCore] REJECT outfit ${idx} "${outfit.title ?? ''}": separates missing ${missing.join(', ')}`,
    // );
    return false;
  });
}

/**
 * Pad outfits array to 3 by building deterministic backfill outfits from
 * available items. Avoids repeating exact item combinations already present.
 *
 * @param outfits  Current outfits (0-2 after validation/fallback)
 * @param pool     Available items (already filtered for masculine safety if needed)
 * @param target   Desired outfit count (default 3)
 */
export function padToThreeOutfits<
  T extends {
    outfit_id?: string;
    title?: string;
    items: Array<{ id?: string; main_category?: string | null }>;
    why?: string;
  },
>(
  outfits: T[],
  pool: Array<{
    id: string;
    name?: string;
    main_category?: string;
    subcategory?: string;
    color?: string;
    image_url?: string;
  }>,
  makeOutfit: (items: typeof pool) => T,
  target = 3,
): T[] {
  if (outfits.length >= target) return outfits;

  // Collect item IDs already used per-outfit so we don't duplicate exact combos
  const usedCombos = new Set(
    outfits.map((o) =>
      (o.items || [])
        .map((it) => it.id)
        .filter(Boolean)
        .sort()
        .join(','),
    ),
  );

  // Group pool by slot
  const tops = pool.filter(
    (r) => mapMainCategoryToSlot(r.main_category ?? '') === 'tops',
  );
  const bottoms = pool.filter(
    (r) => mapMainCategoryToSlot(r.main_category ?? '') === 'bottoms',
  );
  const shoes = pool.filter(
    (r) => mapMainCategoryToSlot(r.main_category ?? '') === 'shoes',
  );
  const dresses = pool.filter(
    (r) => mapMainCategoryToSlot(r.main_category ?? '') === 'dresses',
  );

  // Track which items have been used in backfill to prefer variety
  const usedIds = new Set<string>();
  for (const o of outfits) {
    for (const it of o.items || []) {
      if (it.id) usedIds.add(it.id);
    }
  }

  const pickUnused = (arr: typeof pool) =>
    arr.find((r) => !usedIds.has(r.id)) ?? arr[0];

  const result = [...outfits];

  while (result.length < target) {
    // Path A: separates
    const top = pickUnused(tops);
    const bottom = pickUnused(bottoms);
    const shoe = pickUnused(shoes);

    if (top && bottom && shoe) {
      const combo = [top.id, bottom.id, shoe.id].sort().join(',');
      if (!usedCombos.has(combo)) {
        result.push(makeOutfit([top, bottom, shoe]));
        usedCombos.add(combo);
        usedIds.add(top.id);
        usedIds.add(bottom.id);
        usedIds.add(shoe.id);
        continue;
      }
    }

    // Path B: dress + shoes
    const dress = pickUnused(dresses);
    const shoe2 = pickUnused(shoes);
    if (dress && shoe2) {
      const combo = [dress.id, shoe2.id].sort().join(',');
      if (!usedCombos.has(combo)) {
        result.push(makeOutfit([dress, shoe2]));
        usedCombos.add(combo);
        usedIds.add(dress.id);
        usedIds.add(shoe2.id);
        continue;
      }
    }

    // Wardrobe exhausted — can't build more unique outfits
    break;
  }

  return result;
}
