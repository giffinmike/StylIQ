/**
 * Regression test: Stylist avoid_color guards must NEVER return avoided colors.
 *
 * Mirrors the two guard paths in ai.service.ts:
 * 1) AVOID_COLOR_FINAL_GUARD — uses extractItemColors + expandAvoidColors
 * 2) AVOID_COLOR_RETURN_GUARD — uses __canonicalColors
 *
 * Both guards regenerate new valid outfits instead of restoring invalid ones.
 */
import {
  extractItemColors,
  expandAvoidColors,
  colorMatchesSafe,
} from './elite/tasteValidator';

// ── Helpers mirroring ai.service.ts guard logic ──

const mkOutfit = (id: string, items: any[]) => ({
  id,
  title: `Outfit ${id}`,
  items,
});

const mkItem = (id: string, color: string, category = 'top') => ({
  id,
  name: `Item ${id}`,
  color,
  main_category:
    category === 'top'
      ? 'Tops'
      : category === 'bottom'
        ? 'Pants'
        : category === 'shoes'
          ? 'Shoes'
          : 'Tops',
  __canonicalColors: [color.toLowerCase()],
});

const mkItemWithCanonical = (id: string, canonicalColors: string[]) => ({
  id,
  name: `Item ${id}`,
  __canonicalColors: canonicalColors,
});

/**
 * Simplified regeneration logic mirroring _regenerateAvoidSafe in ai.service.ts.
 * Generates synthetic outfits from safe wardrobe items.
 */
function regenerateAvoidSafe(
  wardrobeItems: any[],
  avoidColors: string[],
  existingIds: Set<string>,
): any[] {
  const expanded = expandAvoidColors(avoidColors);

  const itemHasAvoidColor = (item: any): boolean => {
    const colors: string[] = [];
    if (item.color) colors.push(item.color);
    if (Array.isArray(item.colors)) colors.push(...item.colors);
    for (const raw of colors) {
      if (typeof raw !== 'string') continue;
      const ic = raw.trim().toLowerCase();
      for (const ac of expanded) {
        if (colorMatchesSafe(ic, ac)) return true;
      }
    }
    return false;
  };

  const bySlot: Record<string, any[]> = {};
  for (const item of wardrobeItems) {
    if (itemHasAvoidColor(item)) continue;
    const cat = item.slot || 'top';
    if (!bySlot[cat]) bySlot[cat] = [];
    bySlot[cat].push(item);
  }

  const tops = bySlot['top'] ?? [];
  const bottoms = bySlot['bottom'] ?? [];
  const shoes = bySlot['shoes'] ?? [];

  const generated: any[] = [];
  let synId = 0;
  const usedCombos = new Set<string>();

  for (let attempt = 1; attempt <= 3; attempt++) {
    for (let ti = 0; ti < tops.length && generated.length < 3; ti++) {
      for (let bi = 0; bi < bottoms.length && generated.length < 3; bi++) {
        for (let si = 0; si < shoes.length && generated.length < 3; si++) {
          const items = [tops[ti], bottoms[bi], shoes[si]];
          const combo = items
            .map((i) => i.id)
            .sort()
            .join(',');
          if (usedCombos.has(combo) || existingIds.has(combo)) continue;
          usedCombos.add(combo);
          generated.push(mkOutfit(`regen-${synId++}`, items));
        }
      }
    }
    if (generated.length >= 1) break;
  }

  return generated;
}

/**
 * Mirrors AVOID_COLOR_FINAL_GUARD logic with regeneration fallback.
 */
function finalGuardWithRegeneration(
  eliteOutfits: any[],
  candidatePool: any[],
  avoidColors: string[],
  wardrobeItems: any[],
): { outfits: any[]; regenerated: boolean } {
  if (!avoidColors || avoidColors.length === 0) {
    return { outfits: eliteOutfits, regenerated: false };
  }

  const expanded = expandAvoidColors(avoidColors);

  const outfitHasAvoidedColor = (outfit: any): boolean => {
    for (const it of outfit.items ?? []) {
      const colors = extractItemColors(it);
      for (const ic of colors) {
        for (const ac of expanded) {
          if (colorMatchesSafe(ic, ac)) return true;
        }
      }
    }
    return false;
  };

  const beforeCount = eliteOutfits.length;
  let clean = eliteOutfits.filter((o) => !outfitHasAvoidedColor(o));
  if (clean.length < 3) {
    const backfill = candidatePool
      .filter((o) => !outfitHasAvoidedColor(o))
      .filter((o) => !clean.some((c) => (c.id ?? '') === (o.id ?? '')));
    clean = [...clean, ...backfill].slice(0, 3);
  }

  // REGENERATION: generate new valid outfits instead of restoring invalid ones
  if (clean.length === 0 && beforeCount > 0) {
    const existingIds = new Set(
      candidatePool.map((o) =>
        (o.items || [])
          .map((i: any) => i?.id)
          .filter(Boolean)
          .sort()
          .join(','),
      ),
    );
    const regenerated = regenerateAvoidSafe(
      wardrobeItems,
      avoidColors,
      existingIds,
    );
    if (regenerated.length > 0) {
      return { outfits: regenerated.slice(0, 3), regenerated: true };
    }
    return { outfits: [], regenerated: false }; // truly insufficient
  }

  return { outfits: clean, regenerated: false };
}

/**
 * Mirrors AVOID_COLOR_RETURN_GUARD logic with regeneration fallback.
 */
function returnGuardWithRegeneration(
  eliteOutfits: any[],
  candidatePool: any[],
  avoidColors: string[],
  wardrobeItems: any[],
): { outfits: any[]; regenerated: boolean } {
  if (!avoidColors || avoidColors.length === 0) {
    return { outfits: eliteOutfits, regenerated: false };
  }

  const expanded = expandAvoidColors(avoidColors);

  const rtHasAvoid = (outfit: any): boolean => {
    const items = Array.isArray(outfit?.items) ? outfit.items : [];
    for (const it of items) {
      const colors: string[] = Array.isArray(it.__canonicalColors)
        ? it.__canonicalColors
        : [];
      for (const c of colors) {
        for (const a of expanded) {
          if (colorMatchesSafe(c, a)) return true;
        }
      }
    }
    return false;
  };

  const rtBefore = eliteOutfits.length;
  let result = eliteOutfits.filter((o) => !rtHasAvoid(o));
  if (result.length < 3) {
    const backfill = candidatePool
      .filter((o) => !rtHasAvoid(o))
      .filter((o) => !result.some((x) => (x.id ?? '') === (o.id ?? '')));
    result = [...result, ...backfill].slice(0, 3);
  }

  // REGENERATION: generate new valid outfits instead of restoring invalid ones
  if (result.length === 0 && rtBefore > 0) {
    const existingIds = new Set(
      candidatePool.map((o) =>
        (o.items || [])
          .map((i: any) => i?.id)
          .filter(Boolean)
          .sort()
          .join(','),
      ),
    );
    const regenerated = regenerateAvoidSafe(
      wardrobeItems,
      avoidColors,
      existingIds,
    );
    if (regenerated.length > 0) {
      return { outfits: regenerated.slice(0, 3), regenerated: true };
    }
    return { outfits: [], regenerated: false }; // truly insufficient
  }

  return { outfits: result, regenerated: false };
}

// ── Tests ──

describe('Stylist AVOID_COLOR_FINAL_GUARD with regeneration', () => {
  it('regenerates outfits when avoid list zeroes out all elite outfits', () => {
    const outfits = [
      mkOutfit('1', [mkItem('a', 'black'), mkItem('b', 'white')]),
      mkOutfit('2', [mkItem('c', 'brown'), mkItem('d', 'beige')]),
      mkOutfit('3', [mkItem('e', 'tan'), mkItem('f', 'rust')]),
    ];
    const pool = [...outfits];
    const avoid = ['black', 'white', 'brown', 'beige', 'tan', 'rust'];

    // Wardrobe has safe items that can form new outfits
    const wardrobe = [
      { id: 'w1', color: 'navy', slot: 'top' },
      { id: 'w2', color: 'olive', slot: 'bottom' },
      { id: 'w3', color: 'grey', slot: 'shoes' },
    ];

    const { outfits: result, regenerated } = finalGuardWithRegeneration(
      outfits,
      pool,
      avoid,
      wardrobe,
    );

    expect(regenerated).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    // Verify no returned outfit contains avoided colors
    const expanded = expandAvoidColors(avoid);
    for (const o of result) {
      for (const it of o.items) {
        for (const ac of expanded) {
          expect(colorMatchesSafe(it.color?.toLowerCase() ?? '', ac)).toBe(
            false,
          );
        }
      }
    }
  });

  it('returns empty when wardrobe is truly insufficient', () => {
    const outfits = [
      mkOutfit('1', [mkItem('a', 'black')]),
      mkOutfit('2', [mkItem('b', 'navy')]),
    ];
    const avoid = [
      'black',
      'navy',
      'white',
      'brown',
      'beige',
      'tan',
      'rust',
      'olive',
      'grey',
    ];

    // Wardrobe only has avoided colors
    const wardrobe = [
      { id: 'w1', color: 'black', slot: 'top' },
      { id: 'w2', color: 'navy', slot: 'bottom' },
      { id: 'w3', color: 'brown', slot: 'shoes' },
    ];

    const { outfits: result, regenerated } = finalGuardWithRegeneration(
      outfits,
      [...outfits],
      avoid,
      wardrobe,
    );

    expect(regenerated).toBe(false);
    expect(result.length).toBe(0);
  });

  it('filters normally when some outfits survive (no regeneration needed)', () => {
    const outfits = [
      mkOutfit('1', [mkItem('a', 'navy'), mkItem('b', 'grey')]),
      mkOutfit('2', [mkItem('c', 'black'), mkItem('d', 'white')]),
      mkOutfit('3', [mkItem('e', 'olive'), mkItem('f', 'cream')]),
    ];
    const avoid = ['black', 'white'];

    const { outfits: result, regenerated } = finalGuardWithRegeneration(
      outfits,
      [],
      avoid,
      [],
    );

    expect(result.length).toBe(2);
    expect(regenerated).toBe(false);
    expect(result.map((o: any) => o.id)).toEqual(['1', '3']);
  });

  it('no-op when avoid list is empty', () => {
    const outfits = [
      mkOutfit('1', [mkItem('a', 'black')]),
      mkOutfit('2', [mkItem('b', 'white')]),
      mkOutfit('3', [mkItem('c', 'red')]),
    ];

    const { outfits: result, regenerated } = finalGuardWithRegeneration(
      outfits,
      [],
      [],
      [],
    );

    expect(result.length).toBe(3);
    expect(regenerated).toBe(false);
  });
});

describe('Stylist AVOID_COLOR_RETURN_GUARD with regeneration', () => {
  it('regenerates outfits when __canonicalColors all match avoid list', () => {
    const outfits = [
      mkOutfit('1', [
        mkItemWithCanonical('a', ['black']),
        mkItemWithCanonical('b', ['white']),
      ]),
      mkOutfit('2', [
        mkItemWithCanonical('c', ['brown']),
        mkItemWithCanonical('d', ['beige']),
      ]),
      mkOutfit('3', [
        mkItemWithCanonical('e', ['tan']),
        mkItemWithCanonical('f', ['rust']),
      ]),
    ];
    const pool = [...outfits];
    const avoid = ['black', 'white', 'brown', 'beige', 'tan', 'rust'];

    const wardrobe = [
      { id: 'w1', color: 'navy', slot: 'top' },
      { id: 'w2', color: 'olive', slot: 'bottom' },
      { id: 'w3', color: 'grey', slot: 'shoes' },
    ];

    const { outfits: result, regenerated } = returnGuardWithRegeneration(
      outfits,
      pool,
      avoid,
      wardrobe,
    );

    expect(regenerated).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });

  it('returns empty when wardrobe truly insufficient', () => {
    const outfits = [mkOutfit('1', [mkItemWithCanonical('a', ['black'])])];
    const avoid = ['black', 'navy', 'olive', 'grey', 'brown', 'beige'];

    const wardrobe = [
      { id: 'w1', color: 'black', slot: 'top' },
      { id: 'w2', color: 'navy', slot: 'bottom' },
      { id: 'w3', color: 'olive', slot: 'shoes' },
    ];

    const { outfits: result, regenerated } = returnGuardWithRegeneration(
      outfits,
      [...outfits],
      avoid,
      wardrobe,
    );

    expect(regenerated).toBe(false);
    expect(result.length).toBe(0);
  });

  it('filters normally when some survive via __canonicalColors', () => {
    const outfits = [
      mkOutfit('1', [mkItemWithCanonical('a', ['navy'])]),
      mkOutfit('2', [mkItemWithCanonical('b', ['magenta'])]),
      mkOutfit('3', [mkItemWithCanonical('c', ['olive'])]),
    ];
    const avoid = ['magenta'];

    const { outfits: result, regenerated } = returnGuardWithRegeneration(
      outfits,
      [],
      avoid,
      [],
    );

    expect(result.length).toBe(2);
    expect(regenerated).toBe(false);
    expect(result.map((o: any) => o.id)).toEqual(['1', '3']);
  });
});

describe('Regenerated outfits never contain avoided colors', () => {
  it('every item in regenerated output is avoid-safe', () => {
    const avoid = ['navy', 'black'];
    const expanded = expandAvoidColors(avoid);
    const wardrobe = [
      { id: 't1', color: 'red', slot: 'top' },
      { id: 't2', color: 'navy', slot: 'top' },
      { id: 'b1', color: 'khaki', slot: 'bottom' },
      { id: 's1', color: 'white', slot: 'shoes' },
      { id: 's2', color: 'black', slot: 'shoes' },
    ];

    const regenerated = regenerateAvoidSafe(wardrobe, avoid, new Set());

    expect(regenerated.length).toBeGreaterThan(0);
    for (const outfit of regenerated) {
      for (const item of outfit.items) {
        const ic = (item.color ?? '').toLowerCase();
        for (const ac of expanded) {
          expect(colorMatchesSafe(ic, ac)).toBe(false);
        }
      }
    }
  });
});
