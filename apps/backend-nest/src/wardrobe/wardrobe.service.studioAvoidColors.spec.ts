/**
 * Regression test: Studio avoid_colors enforcement.
 *
 * Tests two layers:
 * 1) RETURN_GUARD — guardFilter() mirrors the inline RETURN_GUARD in
 *    wardrobe.service.ts that strips outfits with avoided colors.
 * 2) selectTopValid — mirrors the scored.filter(valid).slice(0, N) gate
 *    that ensures hard-failed outfits never enter the return pipeline.
 */
import {
  extractItemColors,
  expandAvoidColors,
  colorMatchesSafe,
} from '../ai/elite/tasteValidator';

// ── Helpers (mirror the inline guard in wardrobe.service.ts) ──

function guardFilter(outfits: any[], avoidColors: string[]): any[] {
  if (!avoidColors.length) return outfits;
  const expanded = expandAvoidColors(avoidColors);
  const hasAvoided = (outfit: any): boolean => {
    for (const it of outfit.items ?? []) {
      for (const ic of extractItemColors(it)) {
        for (const ac of expanded) {
          if (colorMatchesSafe(ic, ac)) return true;
        }
      }
    }
    return false;
  };
  return outfits.filter((o) => !hasAvoided(o));
}

/**
 * Mirrors the inline gate: scored.filter(s => s.valid).slice(0, n).map(s => s.o)
 * Used in both SLOW and FAST paths of wardrobe.service.ts.
 */
function selectTopValid(
  scored: { o: any; valid: boolean; cs: number }[],
  n: number,
): any[] {
  return scored
    .filter((s) => s.valid)
    .slice(0, n)
    .map((s) => s.o);
}

const mkOutfit = (id: string, items: any[]) => ({
  outfit_id: id,
  title: `Outfit ${id}`,
  items,
});

const mkItem = (color: string) => ({
  id: `item-${color}`,
  name: `Test ${color}`,
  color,
  main_category: 'Tops',
});

const mkScored = (id: string, valid: boolean, cs = 80) => ({
  o: mkOutfit(id, [mkItem('black')]),
  valid,
  cs,
});

// ── Tests: RETURN_GUARD ──

describe('Studio RETURN_GUARD — avoid_colors', () => {
  it('filters outfit containing avoided color "navy"', () => {
    const outfits = [
      mkOutfit('1', [mkItem('navy'), mkItem('white')]),
      mkOutfit('2', [mkItem('black'), mkItem('grey')]),
      mkOutfit('3', [mkItem('beige'), mkItem('navy blue')]),
    ];
    const result = guardFilter(outfits, ['navy']);
    expect(result).toHaveLength(1);
    expect(result[0].outfit_id).toBe('2');
  });

  it('does NOT filter when avoid_colors is empty', () => {
    const outfits = [
      mkOutfit('1', [mkItem('navy')]),
      mkOutfit('2', [mkItem('blue')]),
    ];
    const result = guardFilter(outfits, []);
    expect(result).toHaveLength(2);
  });

  it('does NOT ban "blue" when only "navy" is avoided (no navy-bans-blue bug)', () => {
    const outfits = [
      mkOutfit('1', [mkItem('blue')]),
      mkOutfit('2', [mkItem('light blue')]),
      mkOutfit('3', [mkItem('royal blue')]),
    ];
    const result = guardFilter(outfits, ['navy']);
    expect(result).toHaveLength(3);
  });

  it('filters multiple avoided colors', () => {
    const outfits = [
      mkOutfit('1', [mkItem('red'), mkItem('white')]),
      mkOutfit('2', [mkItem('black'), mkItem('grey')]),
      mkOutfit('3', [mkItem('neon green'), mkItem('beige')]),
    ];
    const result = guardFilter(outfits, ['red', 'neon']);
    // outfit 1 has "red", outfit 3 has "neon green" (matches "neon")
    expect(result).toHaveLength(1);
    expect(result[0].outfit_id).toBe('2');
  });

  it('returns empty array when ALL outfits contain avoided colors', () => {
    const outfits = [
      mkOutfit('1', [mkItem('navy')]),
      mkOutfit('2', [mkItem('navy blue')]),
      mkOutfit('3', [mkItem('dark navy')]),
    ];
    const result = guardFilter(outfits, ['navy']);
    expect(result).toHaveLength(0);
  });

  it('handles case-insensitive matching', () => {
    const outfits = [
      mkOutfit('1', [mkItem('Navy')]),
      mkOutfit('2', [mkItem('NAVY')]),
      mkOutfit('3', [mkItem('black')]),
    ];
    const result = guardFilter(outfits, ['navy']);
    expect(result).toHaveLength(1);
    expect(result[0].outfit_id).toBe('3');
  });
});

// ── Tests: selectTopValid gate (scored.filter(valid).slice(0,3)) ──

describe('Studio selectTopValid — enforcement gate', () => {
  it('returns 3 valid from 9 candidates when 6 are invalid', () => {
    const scored = [
      mkScored('1', true, 95),
      mkScored('2', false, 92),
      mkScored('3', true, 88),
      mkScored('4', false, 85),
      mkScored('5', true, 82),
      mkScored('6', false, 80),
      mkScored('7', true, 78),
      mkScored('8', false, 75),
      mkScored('9', false, 70),
    ];
    const result = selectTopValid(scored, 3);
    expect(result).toHaveLength(3);
    expect(result.map((o: any) => o.outfit_id)).toEqual(['1', '3', '5']);
  });

  it('returns <3 when fewer than 3 valid candidates exist among 9', () => {
    const scored = [
      mkScored('1', false, 95),
      mkScored('2', true, 90),
      mkScored('3', false, 85),
      mkScored('4', false, 82),
      mkScored('5', true, 78),
      mkScored('6', false, 75),
      mkScored('7', false, 72),
      mkScored('8', false, 68),
      mkScored('9', false, 65),
    ];
    const result = selectTopValid(scored, 3);
    expect(result).toHaveLength(2);
    expect(result.map((o: any) => o.outfit_id)).toEqual(['2', '5']);
  });

  it('returns 0 when all 9 candidates are invalid', () => {
    const scored = Array.from({ length: 9 }, (_, i) =>
      mkScored(String(i + 1), false, 90 - i * 3),
    );
    const result = selectTopValid(scored, 3);
    expect(result).toHaveLength(0);
  });

  it('returns 3 when all 9 candidates are valid (takes top 3)', () => {
    const scored = Array.from({ length: 9 }, (_, i) =>
      mkScored(String(i + 1), true, 95 - i * 5),
    );
    const result = selectTopValid(scored, 3);
    expect(result).toHaveLength(3);
    expect(result.map((o: any) => o.outfit_id)).toEqual(['1', '2', '3']);
  });

  it('preserves input order (pre-sorted by valid-first, then cs desc)', () => {
    // Simulates the sort in wardrobe.service.ts:
    // scored.sort((a,b) => a.valid === b.valid ? b.cs - a.cs : a.valid ? -1 : 1)
    const scored = [
      mkScored('A', true, 90),
      mkScored('B', true, 70),
      mkScored('C', true, 60),
      mkScored('D', false, 95), // highest cs but invalid
      mkScored('E', false, 80),
    ];
    const result = selectTopValid(scored, 3);
    expect(result).toHaveLength(3);
    expect(result.map((o: any) => o.outfit_id)).toEqual(['A', 'B', 'C']);
  });
});

// ── Tests: Full pipeline (guardFilter + selectTopValid combined) ──

describe('Studio full pipeline — oversized pool + avoid_colors', () => {
  it('9 candidates, 3 have avoided colors → returns 3 valid, none contain avoided', () => {
    // Simulate: 9 scored candidates, 3 contain magenta (avoided)
    const scored = [
      {
        o: mkOutfit('1', [mkItem('white'), mkItem('black')]),
        valid: true,
        cs: 95,
      },
      {
        o: mkOutfit('2', [mkItem('magenta'), mkItem('grey')]),
        valid: false,
        cs: 92,
      },
      {
        o: mkOutfit('3', [mkItem('blue'), mkItem('tan')]),
        valid: true,
        cs: 88,
      },
      {
        o: mkOutfit('4', [mkItem('magenta'), mkItem('white')]),
        valid: false,
        cs: 85,
      },
      {
        o: mkOutfit('5', [mkItem('grey'), mkItem('black')]),
        valid: true,
        cs: 82,
      },
      {
        o: mkOutfit('6', [mkItem('magenta'), mkItem('beige')]),
        valid: false,
        cs: 78,
      },
      {
        o: mkOutfit('7', [mkItem('olive'), mkItem('cream')]),
        valid: true,
        cs: 75,
      },
      {
        o: mkOutfit('8', [mkItem('charcoal'), mkItem('white')]),
        valid: true,
        cs: 72,
      },
      {
        o: mkOutfit('9', [mkItem('navy'), mkItem('tan')]),
        valid: true,
        cs: 68,
      },
    ];

    // Layer 1: selectTopValid gate
    const gated = selectTopValid(scored, 3);
    expect(gated).toHaveLength(3);

    // Layer 2: RETURN_GUARD (defense-in-depth)
    const final = guardFilter(gated, ['magenta']);
    expect(final).toHaveLength(3);
    for (const o of final) {
      for (const it of o.items) {
        expect(it.color.toLowerCase()).not.toContain('magenta');
      }
    }
  });

  it('9 candidates, 7 invalid → returns 2 (fewer than 3 is acceptable)', () => {
    const scored = [
      { o: mkOutfit('1', [mkItem('pink')]), valid: false, cs: 95 },
      { o: mkOutfit('2', [mkItem('black')]), valid: true, cs: 92 },
      { o: mkOutfit('3', [mkItem('purple')]), valid: false, cs: 88 },
      { o: mkOutfit('4', [mkItem('pink')]), valid: false, cs: 85 },
      { o: mkOutfit('5', [mkItem('white')]), valid: true, cs: 82 },
      { o: mkOutfit('6', [mkItem('magenta')]), valid: false, cs: 78 },
      { o: mkOutfit('7', [mkItem('pink')]), valid: false, cs: 75 },
      { o: mkOutfit('8', [mkItem('purple')]), valid: false, cs: 72 },
      { o: mkOutfit('9', [mkItem('magenta')]), valid: false, cs: 68 },
    ];
    const gated = selectTopValid(scored, 3);
    expect(gated).toHaveLength(2);
    expect(gated.map((o: any) => o.outfit_id)).toEqual(['2', '5']);
  });
});

// ── Tests: Slot-pick pre-filter (skip P0 violators at selection time) ──

describe('Studio slot-pick — skip avoid_color violators in Pinecone matches', () => {
  /**
   * Mirrors the new _itemViolatesAvoidColors() logic in the FAST path:
   * iterate Pinecone matches in order, skip items whose colors match
   * expandedAvoidColors, pick the first safe one.
   */
  function pickFirstSafe(
    matches: { id: string; color: string }[],
    avoidColors: string[],
  ): { id: string; color: string } | null {
    if (!avoidColors.length) return matches[0] ?? null;
    const expanded = expandAvoidColors(avoidColors);
    let fallback: { id: string; color: string } | null = null;
    for (const m of matches) {
      const colors = extractItemColors(m as any);
      let violated = false;
      for (const ic of colors) {
        for (const ac of expanded) {
          if (colorMatchesSafe(ic, ac)) {
            violated = true;
            break;
          }
        }
        if (violated) break;
      }
      if (violated) {
        if (!fallback) fallback = m;
        continue;
      }
      return m;
    }
    return fallback; // all violated → fall back to first
  }

  it('skips magenta #1, picks non-magenta #2', () => {
    const matches = [
      { id: '1', color: 'Magenta' },
      { id: '2', color: 'Navy' },
      { id: '3', color: 'Black' },
    ];
    const picked = pickFirstSafe(matches, ['pink', 'magenta']);
    expect(picked?.id).toBe('2');
  });

  it('skips rust #1, picks non-rust #2', () => {
    const matches = [
      { id: '1', color: 'Rust' },
      { id: '2', color: 'Grey' },
      { id: '3', color: 'Black' },
    ];
    const picked = pickFirstSafe(matches, ['rust']);
    expect(picked?.id).toBe('2');
  });

  it('returns #1 when no avoid_colors set', () => {
    const matches = [
      { id: '1', color: 'Magenta' },
      { id: '2', color: 'Black' },
    ];
    const picked = pickFirstSafe(matches, []);
    expect(picked?.id).toBe('1');
  });

  it('falls back to #1 if ALL matches violate avoid_colors', () => {
    const matches = [
      { id: '1', color: 'Magenta' },
      { id: '2', color: 'Hot Pink' },
      { id: '3', color: 'Pink' },
    ];
    const picked = pickFirstSafe(matches, ['pink', 'magenta']);
    expect(picked?.id).toBe('1');
  });
});
