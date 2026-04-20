/**
 * Elite Scoring Phase 0 — NO-OP invariance tests.
 *
 * Proves:
 * 1. elitePostProcessOutfits returns outfits unchanged
 * 2. Stylist normalize/denormalize round-trips to original
 * 3. Studio normalize/denormalize round-trips to original
 */
import {
  elitePostProcessOutfits,
  buildEliteExposureEvent,
  normalizeStylistOutfit,
  denormalizeStylistOutfit,
  normalizeStudioOutfit,
  denormalizeStudioOutfit,
  colorMatches,
  deterministicHash,
  scoreOutfit,
  stableSortOutfits,
} from './eliteScoring';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const stylistOutfit = {
  id: 'outfit-1',
  rank: 1,
  summary: 'A casual look',
  items: [
    {
      id: 'item-1',
      name: 'White Tee',
      imageUrl: 'https://img/1.jpg',
      category: 'top',
    },
    {
      id: 'item-2',
      name: 'Blue Jeans',
      imageUrl: 'https://img/2.jpg',
      category: 'bottom',
    },
    {
      id: 'item-3',
      name: 'Sneakers',
      imageUrl: 'https://img/3.jpg',
      category: 'shoes',
    },
  ],
  fashionContext: {
    weatherFit: 'optimal',
    silhouette: 'relaxed',
    colorStrategy: 'neutral palette',
    confidenceLevel: 0.82,
  },
};

const studioOutfit = {
  outfit_id: 'studio-1',
  title: 'Business Casual',
  why: 'Smart pairing for the office',
  missing: null,
  items: [
    {
      id: 'w-1',
      label: 'Oxford Shirt',
      main_category: 'Tops',
      subcategory: 'Oxford Shirt',
      color: 'white',
    },
    {
      id: 'w-2',
      label: 'Chinos',
      main_category: 'Bottoms',
      subcategory: 'Chinos',
      color: 'khaki',
    },
    {
      id: 'w-3',
      label: 'Loafers',
      main_category: 'Shoes',
      subcategory: 'Loafers',
      color: 'brown',
    },
  ],
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('elitePostProcessOutfits (Phase 0 NO-OP)', () => {
  it('returns outfits array unchanged', () => {
    const input = [stylistOutfit, { ...stylistOutfit, id: 'outfit-2' }];
    const result = elitePostProcessOutfits(
      input,
      { presentation: 'mixed' },
      { mode: 'stylist', requestId: 'test-1' },
    );
    expect(result.outfits).toBe(input); // same reference
    expect(result.debug).toEqual({});
  });

  it('returns empty array unchanged', () => {
    const result = elitePostProcessOutfits(
      [],
      { presentation: 'masculine' },
      { mode: 'studio' },
    );
    expect(result.outfits).toEqual([]);
    expect(result.debug).toEqual({});
  });
});

describe('Stylist adapter round-trip', () => {
  it('normalize then denormalize produces original shape', () => {
    const normalized = normalizeStylistOutfit(stylistOutfit);

    // Verify canonical slots assigned
    expect(normalized.items[0].slot).toBe('tops');
    expect(normalized.items[1].slot).toBe('bottoms');
    expect(normalized.items[2].slot).toBe('shoes');

    const restored = denormalizeStylistOutfit(normalized);

    // Verify original category values restored
    expect(restored.items[0].category).toBe('top');
    expect(restored.items[1].category).toBe('bottom');
    expect(restored.items[2].category).toBe('shoes');

    // Verify all other fields preserved
    expect(restored.id).toBe(stylistOutfit.id);
    expect(restored.rank).toBe(stylistOutfit.rank);
    expect(restored.summary).toBe(stylistOutfit.summary);
    expect(restored.items[0].id).toBe('item-1');
    expect(restored.items[0].name).toBe('White Tee');
    expect(restored.fashionContext).toEqual(stylistOutfit.fashionContext);
  });

  it('handles dress slot', () => {
    const dressOutfit = {
      id: 'dress-1',
      items: [
        { id: 'd-1', category: 'dress' },
        { id: 'd-2', category: 'shoes' },
        { id: 'd-3', category: 'accessory' },
      ],
    };
    const normalized = normalizeStylistOutfit(dressOutfit);
    expect(normalized.items[0].slot).toBe('dresses');
    expect(normalized.items[2].slot).toBe('accessories');

    const restored = denormalizeStylistOutfit(normalized);
    expect(restored.items[0].category).toBe('dress');
    expect(restored.items[2].category).toBe('accessory');
  });
});

describe('Studio adapter round-trip', () => {
  it('normalize then denormalize preserves outfit structure', () => {
    const normalized = normalizeStudioOutfit(studioOutfit);

    // Verify canonical slots assigned
    expect(normalized.items[0].slot).toBe('tops');
    expect(normalized.items[1].slot).toBe('bottoms');
    expect(normalized.items[2].slot).toBe('shoes');
    expect(normalized.id).toBe('studio-1');

    const restored = denormalizeStudioOutfit(normalized);

    // Verify original main_category values preserved (not stripped)
    expect(restored.items[0].main_category).toBe('Tops');
    expect(restored.items[1].main_category).toBe('Bottoms');
    expect(restored.items[2].main_category).toBe('Shoes');

    // Verify other fields preserved
    expect(restored.outfit_id).toBe('studio-1');
    expect(restored.title).toBe('Business Casual');
    expect(restored.why).toBe('Smart pairing for the office');
  });

  it('handles extended category mappings', () => {
    const formalOutfit = {
      outfit_id: 'formal-1',
      items: [
        { id: 'f-1', main_category: 'Formalwear' },
        { id: 'f-2', main_category: 'Jewelry' },
        { id: 'f-3', main_category: 'Bags' },
      ],
    };
    const normalized = normalizeStudioOutfit(formalOutfit);
    expect(normalized.items[0].slot).toBe('dresses');
    expect(normalized.items[1].slot).toBe('accessories');
    expect(normalized.items[2].slot).toBe('accessories');
  });
});

describe('Full pipeline: normalize → elitePostProcess → denormalize', () => {
  it('Stylist pipeline returns equivalent output', () => {
    const canonical = normalizeStylistOutfit(stylistOutfit);
    const result = elitePostProcessOutfits(
      [canonical],
      { presentation: 'mixed' },
      { mode: 'stylist' },
    );
    const restored = denormalizeStylistOutfit(result.outfits[0]);
    expect(restored.items[0].category).toBe('top');
    expect(restored.items.length).toBe(stylistOutfit.items.length);
  });

  it('Studio pipeline returns equivalent output', () => {
    const canonical = normalizeStudioOutfit(studioOutfit);
    const result = elitePostProcessOutfits(
      [canonical],
      { presentation: 'masculine' },
      { mode: 'studio' },
    );
    const restored = denormalizeStudioOutfit(result.outfits[0]);
    expect(restored.items[0].main_category).toBe('Tops');
    expect(restored.outfit_id).toBe('studio-1');
  });
});

// ── Phase 1 Tests ───────────────────────────────────────────────────────────

describe('buildEliteExposureEvent', () => {
  it('produces correct shape with neutral signal', () => {
    const outfits = [
      {
        id: 'o-1',
        items: [
          { id: 'item-1', slot: 'tops' as const },
          { id: 'item-2', slot: 'bottoms' as const },
          { id: 'item-3', slot: 'shoes' as const },
        ],
      },
    ];
    const event = buildEliteExposureEvent('user-123', outfits, {
      mode: 'stylist',
      requestId: 'req-abc',
    });

    expect(event.eventType).toBe('ELITE_SUGGESTION_SERVED');
    expect(event.entityType).toBe('outfit');
    expect(event.entityId).toBe('req-abc');
    expect(event.signalPolarity).toBe(0);
    expect(event.signalWeight).toBe(0);
    expect(event.sourceFeature).toBe('elite_scoring');
    expect(event.userId).toBe('user-123');
    expect(event.extractedFeatures.item_ids).toEqual([
      'item-1',
      'item-2',
      'item-3',
    ]);
    expect(event.extractedFeatures.categories).toEqual([
      'tops',
      'bottoms',
      'shoes',
    ]);
    expect(event.context?.occasion).toBe('stylist');
    expect(event.context?.schema_version).toBe(1);
    expect(event.context?.pipeline_version).toBe(1);
  });

  it('generates entityId when requestId is missing', () => {
    const event = buildEliteExposureEvent(
      'user-123',
      [{ id: 'o-1', items: [] }],
      { mode: 'studio' },
    );

    expect(event.entityId).toBeDefined();
    expect(event.entityId!.length).toBeGreaterThan(0);
    expect(event.context?.occasion).toBe('studio');
  });

  it('includes temp_f from weather when provided', () => {
    const event = buildEliteExposureEvent(
      'user-123',
      [{ id: 'o-1', items: [] }],
      { mode: 'stylist', weather: { temp: 72 } },
    );

    expect(event.context?.temp_f).toBe(72);
  });

  it('omits temp_f when weather is null', () => {
    const event = buildEliteExposureEvent(
      'user-123',
      [{ id: 'o-1', items: [] }],
      { mode: 'stylist', weather: null },
    );

    expect(event.context?.temp_f).toBeUndefined();
  });
});

describe('Expanded StyleContext acceptance', () => {
  it('elitePostProcessOutfits accepts full StyleContext without error', () => {
    const fullContext = {
      presentation: 'feminine' as const,
      fashionState: {
        topBrands: ['Nike', 'Zara'],
        avoidBrands: ['Gucci'],
        topColors: ['black', 'white'],
        avoidColors: ['neon green'],
        topStyles: ['minimalist', 'streetwear'],
        avoidStyles: ['bohemian'],
        topCategories: ['Tops', 'Dresses'],
        priceBracket: 'mid',
        isColdStart: false,
      },
      wardrobeStats: {
        dominantColors: ['blue', 'black'],
        topCategories: ['Tops', 'Bottoms'],
        topBrands: [] as string[],
        totalItems: 42,
      },
      preferredBrands: ['Nike', 'Adidas'],
    };

    const result = elitePostProcessOutfits([stylistOutfit], fullContext, {
      mode: 'stylist',
    });

    // Phase 1: still returns unchanged
    expect(result.outfits).toEqual([stylistOutfit]);
    expect(result.debug).toEqual({});
  });

  it('accepts null fashionState (cold start / timeout)', () => {
    const result = elitePostProcessOutfits(
      [stylistOutfit],
      { presentation: 'mixed', fashionState: null },
      { mode: 'stylist' },
    );

    expect(result.outfits).toEqual([stylistOutfit]);
  });
});

// ── Phase 2 Tests ───────────────────────────────────────────────────────────

describe('colorMatches', () => {
  it('matches exact (case-insensitive)', () => {
    expect(colorMatches('Navy Blue', 'navy blue')).toBe(true);
  });

  it('matches substring (item includes pref)', () => {
    expect(colorMatches('Navy Blue', 'navy')).toBe(true);
  });

  it('matches substring (pref includes item)', () => {
    expect(colorMatches('blue', 'Navy Blue')).toBe(true);
  });

  it('rejects non-match', () => {
    expect(colorMatches('red', 'blue')).toBe(false);
  });
});

describe('deterministicHash', () => {
  it('returns same value for same input', () => {
    expect(deterministicHash('abc')).toBe(deterministicHash('abc'));
  });

  it('returns different values for different inputs', () => {
    expect(deterministicHash('abc')).not.toBe(deterministicHash('xyz'));
  });
});

describe('scoreOutfit (Phase 2)', () => {
  const makeOutfit = (
    id: string,
    items: Array<{ id: string; slot: any; brand?: string; color?: string }>,
  ): any => ({
    id,
    items: items.map((i) => ({ ...i })),
  });

  it('scores brand affinity in studio mode', () => {
    const outfit = makeOutfit('o1', [
      { id: 'i1', slot: 'tops', brand: 'Nike', color: 'white' },
      { id: 'i2', slot: 'bottoms', brand: 'Zara', color: 'blue' },
      { id: 'i3', slot: 'shoes', brand: 'Gucci', color: 'black' },
    ]);
    const ctx: any = {
      fashionState: {
        topBrands: ['Nike'],
        avoidBrands: ['Gucci'],
        topColors: [],
        avoidColors: [],
        topCategories: [],
        priceBracket: null,
        isColdStart: false,
      },
      preferredBrands: [],
    };
    const result = scoreOutfit(outfit, ctx, { mode: 'studio', rerank: true });
    // Nike: +10, Gucci: -10 (rebalanced), slot complete: +5 = 5
    expect(result.score).toBe(5);
    expect(result.flags).toContain('brand');
    expect(result.flags).toContain('slot_complete');
  });

  it('scores color affinity in studio mode', () => {
    const outfit = makeOutfit('o1', [
      { id: 'i1', slot: 'tops', color: 'Navy Blue' },
      { id: 'i2', slot: 'bottoms', color: 'Black' },
      { id: 'i3', slot: 'shoes', color: 'Brown' },
    ]);
    const ctx: any = {
      fashionState: {
        topBrands: [],
        avoidBrands: [],
        topColors: ['navy', 'black'],
        avoidColors: ['brown'],
        topCategories: [],
        priceBracket: null,
        isColdStart: false,
      },
    };
    const result = scoreOutfit(outfit, ctx, { mode: 'studio', rerank: true });
    // navy blue matches navy: +5, black matches black: +5, brown matches brown: -8, slot: +5 = 7
    expect(result.score).toBe(7);
    expect(result.flags).toContain('color');
  });

  it('returns zero score with empty StyleContext (fail-open)', () => {
    const outfit = makeOutfit('o1', [{ id: 'i1', slot: 'tops' }]);
    const result = scoreOutfit(outfit, {}, { mode: 'studio', rerank: true });
    expect(result.score).toBe(0);
    expect(result.confidence).toBe(0);
  });

  it('formality compression bonus removed: tight range alone no longer scores', () => {
    // The old rule (+4 when range ≤ 1) rewarded monotone formality clusters.
    // It has been replaced by a queryContext-gated high-low contrast bonus.
    // Without queryContext only slot_complete fires.
    const outfit = {
      id: 'o1',
      items: [
        { id: 'i1', slot: 'tops', formality_score: 3 },
        { id: 'i2', slot: 'bottoms', formality_score: 3.5 },
        { id: 'i3', slot: 'shoes', formality_score: 3.8 },
      ],
    } as any;
    const result = scoreOutfit(outfit, {}, { mode: 'studio', rerank: true });
    expect(result.score).toBe(5); // slot_complete only
    expect(result.flags).not.toContain('formality');
    expect(result.flags).not.toContain('formality_contrast');
    expect(result.flags).toContain('slot_complete');
  });

  it('formality compression bonus removed: medium range alone no longer scores', () => {
    const outfit = {
      id: 'o1',
      items: [
        { id: 'i1', slot: 'tops', formality_score: 2 },
        { id: 'i2', slot: 'bottoms', formality_score: 4 },
        { id: 'i3', slot: 'shoes', formality_score: 3 },
      ],
    } as any;
    const result = scoreOutfit(outfit, {}, { mode: 'studio', rerank: true });
    expect(result.score).toBe(5); // slot_complete only
    expect(result.flags).not.toContain('formality');
  });

  it('formality coherence: wide range (>2) gives no bonus', () => {
    const outfit = {
      id: 'o1',
      items: [
        { id: 'i1', slot: 'tops', formality_score: 1 },
        { id: 'i2', slot: 'bottoms', formality_score: 5 },
        { id: 'i3', slot: 'shoes', formality_score: 3 },
      ],
    } as any;
    const result = scoreOutfit(outfit, {}, { mode: 'studio', rerank: true });
    // formality range 4 > 2 → no bonus, slot complete: +5 = 5
    expect(result.score).toBe(5);
    expect(result.flags).not.toContain('formality');
  });

  it('formality coherence: skipped when <2 items have scores', () => {
    const outfit = {
      id: 'o1',
      items: [
        { id: 'i1', slot: 'tops', formality_score: 3 },
        { id: 'i2', slot: 'bottoms' },
      ],
    } as any;
    const result = scoreOutfit(outfit, {}, { mode: 'studio', rerank: true });
    // Only 1 formality score → signal skipped, no slot complete either
    expect(result.flags).not.toContain('formality');
  });

  it('formality coherence: skipped in non-studio modes', () => {
    const outfit = {
      id: 'o1',
      items: [
        { id: 'i1', slot: 'tops', formality_score: 3 },
        { id: 'i2', slot: 'bottoms', formality_score: 3 },
        { id: 'i3', slot: 'shoes', formality_score: 3 },
      ],
    } as any;
    const result = scoreOutfit(outfit, {}, { mode: 'trips', rerank: true });
    // Trips mode → formality not evaluated, slot complete: +5
    expect(result.score).toBe(5);
    expect(result.flags).not.toContain('formality');
    expect(result.flags).toContain('slot_complete');
  });

  it('only uses wardrobeStats for trips mode color', () => {
    const outfit = makeOutfit('o1', [
      { id: 'i1', slot: 'tops', color: 'blue' },
      { id: 'i2', slot: 'bottoms', color: 'red' },
      { id: 'i3', slot: 'shoes', color: 'black' },
    ]);
    const ctx: any = {
      wardrobeStats: {
        dominantColors: ['blue', 'black'],
        topCategories: ['tops'],
        topBrands: [],
        totalItems: 10,
      },
    };
    const result = scoreOutfit(outfit, ctx, { mode: 'trips', rerank: true });
    // blue: +5, black: +5, category tops: +3, slot: +5 = 18
    expect(result.score).toBe(18);
    expect(result.flags).toContain('color');
    expect(result.flags).toContain('category');
    expect(result.flags).toContain('slot_complete');
  });
});

describe('elitePostProcessOutfits (Phase 2 rerank)', () => {
  const makeOutfit = (
    id: string,
    items: Array<{ id: string; slot: any; brand?: string; color?: string }>,
  ): any => ({
    id,
    items: items.map((i) => ({ ...i })),
  });

  it('identity: rerank=false → output order unchanged (same reference)', () => {
    const input = [
      makeOutfit('o1', [{ id: 'i1', slot: 'tops' }]),
      makeOutfit('o2', [{ id: 'i2', slot: 'bottoms' }]),
    ];
    const result = elitePostProcessOutfits(input, {}, { mode: 'studio' });
    expect(result.outfits).toBe(input);
    expect(result.debug).toEqual({});
  });

  it('no mutation: items are byte-identical before/after rerank', () => {
    const o1 = makeOutfit('o1', [
      { id: 'i1', slot: 'tops', brand: 'Nike', color: 'white' },
      { id: 'i2', slot: 'bottoms', color: 'blue' },
      { id: 'i3', slot: 'shoes', color: 'black' },
    ]);
    const o2 = makeOutfit('o2', [
      { id: 'i4', slot: 'tops', brand: 'Gucci', color: 'red' },
      { id: 'i5', slot: 'bottoms', color: 'green' },
    ]);
    const inputCopy = JSON.parse(JSON.stringify([o1, o2]));
    const result = elitePostProcessOutfits(
      [o1, o2],
      {
        fashionState: {
          topBrands: ['Nike'],
          avoidBrands: [],
          topColors: [],
          avoidColors: [],
          topCategories: [],
          priceBracket: null,
          isColdStart: false,
        },
      },
      { mode: 'studio', rerank: true },
    );
    for (const outfit of result.outfits) {
      const original = inputCopy.find((o: any) => o.id === outfit.id);
      expect(outfit.items).toEqual(original.items);
    }
    expect(result.outfits.length).toBe(2);
  });

  it('deterministic: same inputs → same order across multiple runs', () => {
    const outfits = [
      makeOutfit('o1', [
        { id: 'i1', slot: 'tops', brand: 'Nike' },
        { id: 'i2', slot: 'bottoms' },
        { id: 'i3', slot: 'shoes' },
      ]),
      makeOutfit('o2', [
        { id: 'i4', slot: 'tops', brand: 'Zara' },
        { id: 'i5', slot: 'bottoms' },
        { id: 'i6', slot: 'shoes' },
      ]),
    ];
    const ctx: any = {
      fashionState: {
        topBrands: ['Nike'],
        avoidBrands: [],
        topColors: [],
        avoidColors: [],
        topCategories: [],
        priceBracket: null,
        isColdStart: false,
      },
    };
    const env: any = { mode: 'studio', rerank: true };

    const r1 = elitePostProcessOutfits(outfits, ctx, env);
    const r2 = elitePostProcessOutfits(outfits, ctx, env);
    const r3 = elitePostProcessOutfits(outfits, ctx, env);

    const ids1 = r1.outfits.map((o: any) => o.id);
    const ids2 = r2.outfits.map((o: any) => o.id);
    const ids3 = r3.outfits.map((o: any) => o.id);

    expect(ids1).toEqual(ids2);
    expect(ids2).toEqual(ids3);
  });

  it('equal scores → preserves exact input order', () => {
    const outfits = [
      makeOutfit('o-zzz', [{ id: 'i1', slot: 'tops' }]),
      makeOutfit('o-aaa', [{ id: 'i2', slot: 'tops' }]),
    ];
    const env: any = { mode: 'studio', rerank: true };

    const result = elitePostProcessOutfits(outfits, {}, env);
    // Equal scores → original input order preserved exactly
    expect(result.outfits.map((o: any) => o.id)).toEqual(['o-zzz', 'o-aaa']);
  });

  it('rerank: outfit with brand/color hits sorted before outfit without', () => {
    const loser = makeOutfit('loser', [
      { id: 'i1', slot: 'tops', brand: 'Unknown' },
      { id: 'i2', slot: 'bottoms' },
      { id: 'i3', slot: 'shoes' },
    ]);
    const winner = makeOutfit('winner', [
      { id: 'i4', slot: 'tops', brand: 'Nike', color: 'black' },
      { id: 'i5', slot: 'bottoms', color: 'blue' },
      { id: 'i6', slot: 'shoes' },
    ]);
    const ctx: any = {
      fashionState: {
        topBrands: ['Nike'],
        avoidBrands: [],
        topColors: ['black'],
        avoidColors: [],
        topCategories: [],
        priceBracket: null,
        isColdStart: false,
      },
    };

    const result = elitePostProcessOutfits([loser, winner], ctx, {
      mode: 'studio',
      rerank: true,
    });
    expect(result.outfits[0].id).toBe('winner');
  });

  it('fail-open: empty StyleContext → exact input order preserved', () => {
    const outfits = [
      makeOutfit('first', [{ id: 'i1', slot: 'tops' }]),
      makeOutfit('second', [{ id: 'i2', slot: 'bottoms' }]),
    ];
    const result = elitePostProcessOutfits(
      outfits,
      {},
      { mode: 'studio', rerank: true },
    );
    // Exact input order preserved (not just deterministic)
    expect(result.outfits.map((o: any) => o.id)).toEqual(['first', 'second']);
  });

  it('debug output: debug=true → scores/flags/originalOrder in debug map', () => {
    const outfits = [
      makeOutfit('o1', [
        { id: 'i1', slot: 'tops', brand: 'Nike' },
        { id: 'i2', slot: 'bottoms' },
        { id: 'i3', slot: 'shoes' },
      ]),
      makeOutfit('o2', [{ id: 'i4', slot: 'tops' }]),
    ];
    const ctx: any = {
      fashionState: {
        topBrands: ['Nike'],
        avoidBrands: [],
        topColors: [],
        avoidColors: [],
        topCategories: [],
        priceBracket: null,
        isColdStart: false,
      },
    };
    const result = elitePostProcessOutfits(outfits, ctx, {
      mode: 'studio',
      rerank: true,
      debug: true,
    });

    expect(result.debug.scores).toBeDefined();
    expect(result.debug.originalOrder).toEqual(['o1', 'o2']);
    expect(result.debug.rerankedOrder).toBeDefined();
    expect(Array.isArray(result.debug.scores)).toBe(true);
    expect((result.debug.scores as any[]).length).toBe(2);
    expect((result.debug.scores as any[])[0].outfitId).toBeDefined();
    expect((result.debug.scores as any[])[0].flags).toBeDefined();
  });

  it('confidence: single incomplete outfit in stylist mode → confidence=0', () => {
    const outfit = makeOutfit('o1', [{ id: 'i1', slot: 'tops' }]);
    const result = scoreOutfit(outfit, {}, { mode: 'stylist', rerank: true });
    expect(result.confidence).toBe(0);
    expect(result.score).toBe(0);
  });
});

describe('stableSortOutfits', () => {
  it('preserves item identity (no swaps/drops)', () => {
    const o1: any = { id: 'o1', items: [{ id: 'i1', slot: 'tops' }] };
    const o2: any = { id: 'o2', items: [{ id: 'i2', slot: 'bottoms' }] };

    const scores = new Map<string, any>();
    scores.set('o1', { score: 10, confidence: 1, flags: ['brand'] });
    scores.set('o2', { score: 20, confidence: 1, flags: ['color'] });

    const sorted = stableSortOutfits([o1, o2], scores);

    expect(sorted.length).toBe(2);
    expect(sorted[0].id).toBe('o2');
    expect(sorted[1].id).toBe('o1');
    expect(sorted[0].items).toEqual(o2.items);
    expect(sorted[1].items).toEqual(o1.items);
  });
});

// ── Style Profile Scoring Layer Tests ──────────────────────────────────────

describe('Style Profile scoring layer', () => {
  const makeOutfit = (id: string, items: any[]): any => ({
    id,
    items: items.map((i) => ({ ...i })),
  });

  it('fail-open: rerank=true + empty StyleContext → exact input order preserved', () => {
    const outfits = [
      makeOutfit('first', [
        { id: 'i1', slot: 'tops' },
        { id: 'i2', slot: 'bottoms' },
        { id: 'i3', slot: 'shoes' },
      ]),
      makeOutfit('second', [
        { id: 'i4', slot: 'tops' },
        { id: 'i5', slot: 'bottoms' },
        { id: 'i6', slot: 'shoes' },
      ]),
      makeOutfit('third', [
        { id: 'i7', slot: 'tops' },
        { id: 'i8', slot: 'bottoms' },
        { id: 'i9', slot: 'shoes' },
      ]),
    ];
    const result = elitePostProcessOutfits(
      outfits,
      {},
      { mode: 'studio', rerank: true },
    );
    // All scores equal → exact input order preserved (NOT hash-reordered)
    expect(result.outfits.map((o: any) => o.id)).toEqual([
      'first',
      'second',
      'third',
    ]);
    // Multiple runs prove determinism
    const r2 = elitePostProcessOutfits(
      outfits,
      {},
      { mode: 'studio', rerank: true },
    );
    const r3 = elitePostProcessOutfits(
      outfits,
      {},
      { mode: 'studio', rerank: true },
    );
    expect(r2.outfits.map((o: any) => o.id)).toEqual([
      'first',
      'second',
      'third',
    ]);
    expect(r3.outfits.map((o: any) => o.id)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('ties with active scoring: equal-scoring outfits preserve original order', () => {
    // Both outfits have same brand from topBrands → same score → original order preserved
    const o1 = makeOutfit('alpha', [
      { id: 'i1', slot: 'tops', brand: 'Nike' },
      { id: 'i2', slot: 'bottoms' },
      { id: 'i3', slot: 'shoes' },
    ]);
    const o2 = makeOutfit('beta', [
      { id: 'i4', slot: 'tops', brand: 'Nike' },
      { id: 'i5', slot: 'bottoms' },
      { id: 'i6', slot: 'shoes' },
    ]);
    const ctx: any = {
      fashionState: {
        topBrands: ['Nike'],
        avoidBrands: [],
        topColors: [],
        avoidColors: [],
        topCategories: [],
        priceBracket: null,
        isColdStart: false,
      },
    };
    const result = elitePostProcessOutfits([o1, o2], ctx, {
      mode: 'studio',
      rerank: true,
    });
    // Both score: brand +10, slot_complete +5 = 15. Tie → original order
    expect(result.outfits.map((o: any) => o.id)).toEqual(['alpha', 'beta']);
    // Signals DID fire (brand + slot_complete)
    const s = scoreOutfit(o1, ctx, { mode: 'studio', rerank: true });
    expect(s.flags).toContain('brand');
    expect(s.flags).toContain('slot_complete');
    expect(s.score).toBe(15);
  });

  it('Studio brand affinity: outfit with topBrand ranks above outfit without', () => {
    const noMatch = makeOutfit('no-brand', [
      { id: 'i1', slot: 'tops' },
      { id: 'i2', slot: 'bottoms' },
      { id: 'i3', slot: 'shoes' },
    ]);
    const hasMatch = makeOutfit('has-brand', [
      { id: 'i4', slot: 'tops', brand: 'Nike' },
      { id: 'i5', slot: 'bottoms' },
      { id: 'i6', slot: 'shoes' },
    ]);
    const ctx: any = {
      fashionState: {
        topBrands: ['Nike'],
        avoidBrands: [],
        topColors: [],
        avoidColors: [],
        topCategories: [],
        priceBracket: null,
        isColdStart: false,
      },
    };
    const result = elitePostProcessOutfits([noMatch, hasMatch], ctx, {
      mode: 'studio',
      rerank: true,
    });
    expect(result.outfits[0].id).toBe('has-brand');
    const s = scoreOutfit(hasMatch, ctx, { mode: 'studio', rerank: true });
    expect(s.flags).toContain('brand');
  });

  it('Studio avoid brand: outfit with avoidBrand ranks below clean outfit', () => {
    const clean = makeOutfit('clean', [
      { id: 'i1', slot: 'tops' },
      { id: 'i2', slot: 'bottoms' },
      { id: 'i3', slot: 'shoes' },
    ]);
    const avoided = makeOutfit('avoided', [
      { id: 'i4', slot: 'tops', brand: 'BadBrand' },
      { id: 'i5', slot: 'bottoms' },
      { id: 'i6', slot: 'shoes' },
    ]);
    const ctx: any = {
      fashionState: {
        topBrands: [],
        avoidBrands: ['BadBrand'],
        topColors: [],
        avoidColors: [],
        topCategories: [],
        priceBracket: null,
        isColdStart: false,
      },
    };
    const result = elitePostProcessOutfits([avoided, clean], ctx, {
      mode: 'studio',
      rerank: true,
    });
    // Clean outfit (score 5: slot_complete) should rank above avoided (score -10: -15 brand + 5 slot)
    expect(result.outfits[0].id).toBe('clean');
    expect(result.outfits[1].id).toBe('avoided');
  });

  it('Trips dominantColors: color-matching outfit reranked above non-matching', () => {
    const noColor = makeOutfit('no-color', [
      { id: 'i1', slot: 'tops', color: 'purple' },
      { id: 'i2', slot: 'bottoms', color: 'orange' },
      { id: 'i3', slot: 'shoes', color: 'yellow' },
    ]);
    const hasColor = makeOutfit('has-color', [
      { id: 'i4', slot: 'tops', color: 'blue' },
      { id: 'i5', slot: 'bottoms', color: 'black' },
      { id: 'i6', slot: 'shoes', color: 'white' },
    ]);
    const ctx: any = {
      wardrobeStats: {
        dominantColors: ['blue', 'black'],
        topCategories: [],
        topBrands: [],
        totalItems: 20,
      },
    };
    const result = elitePostProcessOutfits([noColor, hasColor], ctx, {
      mode: 'trips',
      rerank: true,
    });
    expect(result.outfits[0].id).toBe('has-color');
    const s = scoreOutfit(hasColor, ctx, { mode: 'trips', rerank: true });
    expect(s.flags).toContain('color');
    expect(s.flags).toContain('slot_complete');
  });

  it('Stylist thin items: no crash, deterministic, only slot_complete fires', () => {
    // Stylist items: {id, name, imageUrl, category → slot}. No brand, color, style, formality.
    const o1 = makeOutfit('sty-1', [
      { id: 's1', slot: 'tops', name: 'White Tee' },
      { id: 's2', slot: 'bottoms', name: 'Jeans' },
      { id: 's3', slot: 'shoes', name: 'Sneakers' },
    ]);
    const o2 = makeOutfit('sty-2', [
      { id: 's4', slot: 'dresses', name: 'Maxi Dress' },
      { id: 's5', slot: 'shoes', name: 'Sandals' },
    ]);
    // Stylist has fashionState but items are thin → brand/color/style/formality cannot fire
    const ctx: any = {
      presentation: 'feminine',
      fashionState: {
        topBrands: ['Zara'],
        avoidBrands: [],
        topColors: ['black'],
        avoidColors: [],
        topStyles: ['minimalist'],
        avoidStyles: [],
        topCategories: [],
        priceBracket: null,
        isColdStart: false,
      },
    };
    const r1 = elitePostProcessOutfits([o1, o2], ctx, {
      mode: 'stylist',
      rerank: true,
    });
    const r2 = elitePostProcessOutfits([o1, o2], ctx, {
      mode: 'stylist',
      rerank: true,
    });
    // No crash
    expect(r1.outfits).toHaveLength(2);
    // Deterministic
    expect(r1.outfits.map((o: any) => o.id)).toEqual(
      r2.outfits.map((o: any) => o.id),
    );
    // Only slot_complete fires (both outfits are slot-complete)
    const s1 = scoreOutfit(o1, ctx, { mode: 'stylist', rerank: true });
    expect(s1.flags).toContain('slot_complete');
    expect(s1.flags).not.toContain('brand');
    expect(s1.flags).not.toContain('color');
    expect(s1.flags).not.toContain('style');
  });

  it('style affinity: items with style_descriptors/style_archetypes scored correctly', () => {
    const outfit = makeOutfit('styled', [
      { id: 'i1', slot: 'tops', style_archetypes: ['Minimal'] },
      { id: 'i2', slot: 'bottoms', style_descriptors: ['bohemian', 'flowy'] },
      { id: 'i3', slot: 'shoes' },
    ]);
    const ctx: any = {
      fashionState: {
        topBrands: [],
        avoidBrands: [],
        topColors: [],
        avoidColors: [],
        topStyles: ['minimal'],
        avoidStyles: ['bohemian'],
        topCategories: [],
        priceBracket: null,
        isColdStart: false,
      },
    };
    const result = scoreOutfit(outfit, ctx, { mode: 'studio', rerank: true });
    // Minimal archetype matches topStyles: +5, bohemian descriptor matches avoidStyles: -8, slot_complete: +5 = 2
    expect(result.score).toBe(2);
    expect(result.flags).toContain('style');
    expect(result.flags).toContain('slot_complete');
  });

  it('style affinity: skipped when items lack style tokens', () => {
    const outfit = makeOutfit('no-style', [
      { id: 'i1', slot: 'tops' },
      { id: 'i2', slot: 'bottoms' },
      { id: 'i3', slot: 'shoes' },
    ]);
    const ctx: any = {
      fashionState: {
        topBrands: [],
        avoidBrands: [],
        topColors: [],
        avoidColors: [],
        topStyles: ['minimalist'],
        avoidStyles: [],
        topCategories: [],
        priceBracket: null,
        isColdStart: false,
      },
    };
    const result = scoreOutfit(outfit, ctx, { mode: 'studio', rerank: true });
    // No style tokens on items → style signal doesn't fire
    expect(result.flags).not.toContain('style');
    expect(result.flags).toContain('slot_complete');
  });

  it('presentation safety: cross-presentation item penalized', () => {
    const outfit = makeOutfit('cross', [
      { id: 'i1', slot: 'tops', presentation_code: 'feminine' },
      { id: 'i2', slot: 'bottoms' },
      { id: 'i3', slot: 'shoes' },
    ]);
    const result = scoreOutfit(
      outfit,
      { presentation: 'masculine' },
      { mode: 'studio', rerank: true },
    );
    // presentation: -8 (rebalanced), slot_complete: +5 = -3
    expect(result.score).toBe(-3);
    expect(result.flags).toContain('presentation');
    expect(result.flags).toContain('slot_complete');
  });

  it('presentation safety: no penalty when items lack presentation_code', () => {
    const outfit = makeOutfit('normal', [
      { id: 'i1', slot: 'tops' },
      { id: 'i2', slot: 'bottoms' },
      { id: 'i3', slot: 'shoes' },
    ]);
    const result = scoreOutfit(
      outfit,
      { presentation: 'masculine' },
      { mode: 'studio', rerank: true },
    );
    // Only slot_complete: +5
    expect(result.score).toBe(5);
    expect(result.flags).not.toContain('presentation');
  });

  // ── FINAL hardening: strict style-signal gate ────────────────────────────

  it('slot_complete alone DOES reorder after fail-open gate removal', () => {
    // The old behavior preserved input order when only slot_complete fired.
    // The fail-open gate has been removed intentionally so Elite always acts
    // on scoring. Higher-scoring outfit now wins regardless of signal type.
    const incomplete = makeOutfit('incomplete', [{ id: 'i1', slot: 'tops' }]);
    const complete = makeOutfit('complete', [
      { id: 'i2', slot: 'tops' },
      { id: 'i3', slot: 'bottoms' },
      { id: 'i4', slot: 'shoes' },
    ]);
    const ctx: any = {};
    const result = elitePostProcessOutfits([incomplete, complete], ctx, {
      mode: 'studio',
      rerank: true,
    });
    expect(result.outfits.map((o: any) => o.id)).toEqual([
      'complete',
      'incomplete',
    ]);
  });

  it('style signal fires → slot_complete may influence final order (allowed)', () => {
    // Outfit A: brand-match (+10), NOT slot-complete → score=10
    // Outfit B: no brand-match, slot-complete (+5) → score=5
    // Brand is a style signal → gate passes → reranking allowed → A ranks first
    const brandMatch = makeOutfit('brand-match', [
      { id: 'i1', slot: 'tops', brand: 'Nike' },
    ]);
    const slotComplete = makeOutfit('slot-complete', [
      { id: 'i2', slot: 'tops' },
      { id: 'i3', slot: 'bottoms' },
      { id: 'i4', slot: 'shoes' },
    ]);
    const ctx: any = {
      fashionState: {
        topBrands: ['Nike'],
        avoidBrands: [],
        topColors: [],
        avoidColors: [],
        topCategories: [],
        priceBracket: null,
        isColdStart: false,
      },
    };
    // Input order: [slot-complete, brand-match] → reranked to [brand-match, slot-complete]
    const result = elitePostProcessOutfits([slotComplete, brandMatch], ctx, {
      mode: 'studio',
      rerank: true,
    });
    expect(result.outfits.map((o: any) => o.id)).toEqual([
      'brand-match',
      'slot-complete',
    ]);
    // Verify brand signal fired
    const s = scoreOutfit(brandMatch, ctx, { mode: 'studio', rerank: true });
    expect(s.flags).toContain('brand');
    expect(s.score).toBe(10);
  });

  it('reranks enriched Stylist items by color preference', () => {
    // Simulates the enrichment pass: thin Stylist items now carry color from fullItemMap
    const preferred = makeOutfit('color-pref', [
      { id: 'c1', slot: 'tops', color: 'navy' },
      { id: 'c2', slot: 'bottoms' },
      { id: 'c3', slot: 'shoes' },
    ]);
    const neutral = makeOutfit('color-neutral', [
      { id: 'c4', slot: 'tops' },
      { id: 'c5', slot: 'bottoms' },
      { id: 'c6', slot: 'shoes' },
    ]);
    const ctx: any = {
      fashionState: {
        topBrands: [],
        avoidBrands: [],
        topColors: ['navy'],
        avoidColors: [],
        topCategories: [],
        priceBracket: null,
        isColdStart: false,
      },
    };
    const result = elitePostProcessOutfits([neutral, preferred], ctx, {
      mode: 'stylist',
      rerank: true,
    });
    expect(result.outfits.map((o: any) => o.id)).toEqual([
      'color-pref',
      'color-neutral',
    ]);
  });

  it('reranks enriched Stylist items by style_descriptors preference', () => {
    const stylish = makeOutfit('style-match', [
      { id: 's1', slot: 'tops', style_descriptors: ['minimalist', 'modern'] },
      { id: 's2', slot: 'bottoms' },
      { id: 's3', slot: 'shoes' },
    ]);
    const plain = makeOutfit('style-plain', [
      { id: 's4', slot: 'tops' },
      { id: 's5', slot: 'bottoms' },
      { id: 's6', slot: 'shoes' },
    ]);
    const ctx: any = {
      fashionState: {
        topBrands: [],
        avoidBrands: [],
        topColors: [],
        avoidColors: [],
        topStyles: ['minimalist'],
        avoidStyles: [],
        topCategories: [],
        priceBracket: null,
        isColdStart: false,
      },
    };
    const result = elitePostProcessOutfits([plain, stylish], ctx, {
      mode: 'stylist',
      rerank: true,
    });
    expect(result.outfits.map((o: any) => o.id)).toEqual([
      'style-match',
      'style-plain',
    ]);
  });

  it('fail-open: enriched stylist items + empty StyleContext preserves exact order', () => {
    // Items carry full wardrobe metadata (post-enrichment), but user has no style profile
    const outfitA = makeOutfit('enriched-a', [
      {
        id: 'e1',
        slot: 'tops',
        brand: 'Uniqlo',
        color: 'navy',
        style_descriptors: ['minimalist'],
      },
      { id: 'e2', slot: 'bottoms', brand: 'J.Crew', color: 'khaki' },
      { id: 'e3', slot: 'shoes', brand: 'Nike', color: 'white' },
    ]);
    const outfitB = makeOutfit('enriched-b', [
      {
        id: 'e4',
        slot: 'tops',
        brand: 'Zara',
        color: 'black',
        style_descriptors: ['edgy'],
      },
      { id: 'e5', slot: 'bottoms', brand: 'Levi', color: 'indigo' },
      { id: 'e6', slot: 'shoes', brand: 'Adidas', color: 'gray' },
    ]);
    const outfitC = makeOutfit('enriched-c', [
      {
        id: 'e7',
        slot: 'dresses',
        brand: 'H&M',
        color: 'red',
        style_archetypes: ['bohemian'],
      },
      { id: 'e8', slot: 'shoes', brand: 'Steve Madden', color: 'tan' },
    ]);

    // Empty StyleContext: no fashionState, no wardrobeStats
    const emptyCtx: any = {
      fashionState: null,
      wardrobeStats: undefined,
      preferredBrands: [],
    };

    const inputOrder = [outfitA, outfitB, outfitC];
    const result = elitePostProcessOutfits(inputOrder, emptyCtx, {
      mode: 'stylist',
      rerank: true,
      debug: true,
    });

    // All three outfits score the same (+5 slot_complete each) with an empty
    // StyleContext. Stable sort preserves input order on score ties.
    expect(result.outfits.map((o: any) => o.id)).toEqual([
      'enriched-a',
      'enriched-b',
      'enriched-c',
    ]);

    // No style signals fired — only slot_complete (structural) may fire
    const STYLE_FLAGS = [
      'brand',
      'color',
      'category',
      'style',
      'formality',
      'presentation',
    ];
    const scores = (result.debug as any).scores ?? [];
    for (const s of scores) {
      for (const flag of s.flags ?? []) {
        expect(STYLE_FLAGS).not.toContain(flag);
      }
    }
  });
});

// ── Stylist Brain Scoring Signals (Phase 2 — fit/fabric/dress_code) ──

describe('Fit preference signal', () => {
  const makeOutfit = (id: string, items: any[]): any => ({
    id,
    items: items.map((i) => ({ ...i })),
  });

  it('fit match gives +4 per item', () => {
    const outfit = makeOutfit('fit-match', [
      { id: 'i1', slot: 'tops', fit: 'slim' },
      { id: 'i2', slot: 'bottoms', fit: 'relaxed' },
      { id: 'i3', slot: 'shoes' },
    ]);
    const ctx: any = {
      styleProfile: {
        fit_preferences: ['slim'],
        fabric_preferences: [],
      },
    };
    const result = scoreOutfit(outfit, ctx, { mode: 'studio', rerank: true });
    // slim matches: +4, slot_complete: +5 = 9
    expect(result.flags).toContain('fit');
    expect(result.flags).toContain('slot_complete');
    expect(result.score).toBe(9);
  });

  it('no fit field on items → fail-open (signal skipped)', () => {
    const outfit = makeOutfit('no-fit', [
      { id: 'i1', slot: 'tops' },
      { id: 'i2', slot: 'bottoms' },
      { id: 'i3', slot: 'shoes' },
    ]);
    const ctx: any = {
      styleProfile: {
        fit_preferences: ['slim'],
        fabric_preferences: [],
      },
    };
    const result = scoreOutfit(outfit, ctx, { mode: 'studio', rerank: true });
    expect(result.flags).not.toContain('fit');
    // Only slot_complete: +5
    expect(result.score).toBe(5);
  });

  it('empty fit_preferences → signal skipped', () => {
    const outfit = makeOutfit('o1', [{ id: 'i1', slot: 'tops', fit: 'slim' }]);
    const ctx: any = {
      styleProfile: {
        fit_preferences: [],
        fabric_preferences: [],
      },
    };
    const result = scoreOutfit(outfit, ctx, { mode: 'studio', rerank: true });
    expect(result.flags).not.toContain('fit');
  });

  it('fit_type field also matches', () => {
    const outfit = makeOutfit('fit-type', [
      { id: 'i1', slot: 'tops', fit_type: 'Regular' },
    ]);
    const ctx: any = {
      styleProfile: {
        fit_preferences: ['regular'],
        fabric_preferences: [],
      },
    };
    const result = scoreOutfit(outfit, ctx, { mode: 'studio', rerank: true });
    expect(result.flags).toContain('fit');
  });
});

describe('Fabric/material preference signal', () => {
  const makeOutfit = (id: string, items: any[]): any => ({
    id,
    items: items.map((i) => ({ ...i })),
  });

  it('fabric match gives +3 per item', () => {
    const outfit = makeOutfit('fabric-match', [
      { id: 'i1', slot: 'tops', material: 'cotton blend' },
      { id: 'i2', slot: 'bottoms', material: 'denim' },
      { id: 'i3', slot: 'shoes' },
    ]);
    const ctx: any = {
      styleProfile: {
        fit_preferences: [],
        fabric_preferences: ['cotton'],
      },
    };
    const result = scoreOutfit(outfit, ctx, { mode: 'studio', rerank: true });
    // cotton matches cotton blend: +3, slot_complete: +5 = 8
    expect(result.flags).toContain('fabric');
    expect(result.score).toBe(8);
  });

  it('no material field → fail-open', () => {
    const outfit = makeOutfit('no-mat', [{ id: 'i1', slot: 'tops' }]);
    const ctx: any = {
      styleProfile: {
        fit_preferences: [],
        fabric_preferences: ['silk'],
      },
    };
    const result = scoreOutfit(outfit, ctx, { mode: 'studio', rerank: true });
    expect(result.flags).not.toContain('fabric');
  });

  it('fabric_blend field also matches', () => {
    const outfit = makeOutfit('blend', [
      { id: 'i1', slot: 'tops', fabric_blend: 'Merino Wool' },
    ]);
    const ctx: any = {
      styleProfile: {
        fit_preferences: [],
        fabric_preferences: ['wool'],
      },
    };
    const result = scoreOutfit(outfit, ctx, { mode: 'studio', rerank: true });
    expect(result.flags).toContain('fabric');
  });
});

describe('Dress-code coherence signal', () => {
  const makeOutfit = (id: string, items: any[]): any => ({
    id,
    items: items.map((i) => ({ ...i })),
  });

  it('all items same dress_code gives +3 in studio', () => {
    const outfit = makeOutfit('coherent', [
      { id: 'i1', slot: 'tops', dress_code: 'business' },
      { id: 'i2', slot: 'bottoms', dress_code: 'business' },
      { id: 'i3', slot: 'shoes', dress_code: 'business' },
    ]);
    const result = scoreOutfit(outfit, {}, { mode: 'studio', rerank: true });
    // dress_code: +3, slot_complete: +5 = 8
    expect(result.flags).toContain('dress_code');
    expect(result.score).toBe(8);
  });

  it('conflicting dress_codes penalized -5 in studio', () => {
    const outfit = makeOutfit('conflict', [
      { id: 'i1', slot: 'tops', dress_code: 'athletic' },
      { id: 'i2', slot: 'bottoms', dress_code: 'business' },
      { id: 'i3', slot: 'shoes', dress_code: 'business' },
    ]);
    const result = scoreOutfit(outfit, {}, { mode: 'studio', rerank: true });
    // dress_code conflict: -5, slot_complete: +5 = 0
    expect(result.flags).toContain('dress_code');
    expect(result.score).toBe(0);
  });

  it('dress_code skipped in non-studio modes', () => {
    const outfit = makeOutfit('trips-dc', [
      { id: 'i1', slot: 'tops', dress_code: 'athletic' },
      { id: 'i2', slot: 'bottoms', dress_code: 'business' },
      { id: 'i3', slot: 'shoes', dress_code: 'business' },
    ]);
    const result = scoreOutfit(outfit, {}, { mode: 'trips', rerank: true });
    expect(result.flags).not.toContain('dress_code');
  });

  it('dress_code skipped when <2 items have it', () => {
    const outfit = makeOutfit('single-dc', [
      { id: 'i1', slot: 'tops', dress_code: 'business' },
      { id: 'i2', slot: 'bottoms' },
      { id: 'i3', slot: 'shoes' },
    ]);
    const result = scoreOutfit(outfit, {}, { mode: 'studio', rerank: true });
    expect(result.flags).not.toContain('dress_code');
  });
});

describe('Budget signal removed (policy: NEVER)', () => {
  const makeOutfit = (id: string, items: any[]): any => ({
    id,
    items: items.map((i) => ({ ...i })),
  });

  it('budget fields on styleProfile do NOT produce a budget flag', () => {
    const outfit = makeOutfit('has-price', [
      { id: 'i1', slot: 'tops', price: 50 },
      { id: 'i2', slot: 'bottoms', price: 80 },
      { id: 'i3', slot: 'shoes', price: 100 },
    ]);
    const ctx: any = {
      styleProfile: {
        fit_preferences: [],
        fabric_preferences: [],
      },
    };
    const result = scoreOutfit(outfit, ctx, { mode: 'studio', rerank: true });
    expect(result.flags).not.toContain('budget');
  });

  it('null styleProfile → all profile signals skipped', () => {
    const outfit = makeOutfit('no-profile', [
      { id: 'i1', slot: 'tops', fit: 'slim', material: 'cotton', price: 50 },
      { id: 'i2', slot: 'bottoms' },
      { id: 'i3', slot: 'shoes' },
    ]);
    const result = scoreOutfit(outfit, {}, { mode: 'studio', rerank: true });
    expect(result.flags).not.toContain('fit');
    expect(result.flags).not.toContain('fabric');
    expect(result.flags).not.toContain('budget');
  });
});

describe('New signals in reranking pipeline', () => {
  const makeOutfit = (id: string, items: any[]): any => ({
    id,
    items: items.map((i) => ({ ...i })),
  });

  it('fit preference changes ranking when data present', () => {
    const fitMatch = makeOutfit('fit-winner', [
      { id: 'i1', slot: 'tops', fit: 'slim' },
      { id: 'i2', slot: 'bottoms' },
      { id: 'i3', slot: 'shoes' },
    ]);
    const noFit = makeOutfit('no-fit', [
      { id: 'i4', slot: 'tops' },
      { id: 'i5', slot: 'bottoms' },
      { id: 'i6', slot: 'shoes' },
    ]);
    const ctx: any = {
      styleProfile: {
        fit_preferences: ['slim'],
        fabric_preferences: [],
      },
    };
    const result = elitePostProcessOutfits([noFit, fitMatch], ctx, {
      mode: 'studio',
      rerank: true,
    });
    expect(result.outfits[0].id).toBe('fit-winner');
  });

  it('deterministic across multiple runs', () => {
    const o1 = makeOutfit('o1', [
      { id: 'i1', slot: 'tops', fit: 'slim', material: 'cotton', price: 50 },
      { id: 'i2', slot: 'bottoms' },
      { id: 'i3', slot: 'shoes' },
    ]);
    const o2 = makeOutfit('o2', [
      { id: 'i4', slot: 'tops' },
      { id: 'i5', slot: 'bottoms' },
      { id: 'i6', slot: 'shoes' },
    ]);
    const ctx: any = {
      styleProfile: {
        fit_preferences: ['slim'],
        fabric_preferences: ['cotton'],
      },
    };
    const env: any = { mode: 'studio', rerank: true };
    const r1 = elitePostProcessOutfits([o1, o2], ctx, env);
    const r2 = elitePostProcessOutfits([o1, o2], ctx, env);
    const r3 = elitePostProcessOutfits([o1, o2], ctx, env);
    expect(r1.outfits.map((o: any) => o.id)).toEqual(
      r2.outfits.map((o: any) => o.id),
    );
    expect(r2.outfits.map((o: any) => o.id)).toEqual(
      r3.outfits.map((o: any) => o.id),
    );
  });
});

// ── P0/P1 Profile Scoring Tests ─────────────────────────────────────────────

describe('Profile avoid_colors scoring', () => {
  const makeOutfit = (id: string, items: any[]): any => ({
    id,
    items: items.map((i) => ({ ...i })),
  });

  it('-10 for matching item color against profile avoid_colors', () => {
    const outfit = makeOutfit('o1', [
      { id: 'i1', slot: 'tops', color: 'Neon Green' },
      { id: 'i2', slot: 'bottoms' },
      { id: 'i3', slot: 'shoes' },
    ]);
    const ctx: any = {
      styleProfile: {
        fit_preferences: [],
        fabric_preferences: [],
        avoid_colors: ['Neon'],
      },
    };
    const result = scoreOutfit(outfit, ctx, { mode: 'studio', rerank: true });
    expect(result.flags).toContain('profile_avoid_colors');
    // -6 for neon match (rebalanced) + 5 slot_complete = -1
    expect(result.score).toBe(-1);
  });

  it('skips gracefully when avoid_colors is empty', () => {
    const outfit = makeOutfit('o1', [
      { id: 'i1', slot: 'tops', color: 'blue' },
    ]);
    const ctx: any = {
      styleProfile: {
        fit_preferences: [],
        fabric_preferences: [],
        avoid_colors: [],
      },
    };
    const result = scoreOutfit(outfit, ctx, { mode: 'studio', rerank: true });
    expect(result.flags).not.toContain('profile_avoid_colors');
  });
});

describe('Profile avoid_materials scoring', () => {
  const makeOutfit = (id: string, items: any[]): any => ({
    id,
    items: items.map((i) => ({ ...i })),
  });

  it('-10 for matching item material against profile avoid_materials', () => {
    const outfit = makeOutfit('o1', [
      { id: 'i1', slot: 'tops', material: 'Genuine Leather' },
      { id: 'i2', slot: 'bottoms' },
      { id: 'i3', slot: 'shoes' },
    ]);
    const ctx: any = {
      styleProfile: {
        fit_preferences: [],
        fabric_preferences: [],
        avoid_materials: ['Leather'],
      },
    };
    const result = scoreOutfit(outfit, ctx, { mode: 'studio', rerank: true });
    expect(result.flags).toContain('profile_avoid_materials');
    expect(result.score).toBe(-1); // -6 (rebalanced) + 5 slot
  });
});

describe('Pattern preferences scoring', () => {
  const makeOutfit = (id: string, items: any[]): any => ({
    id,
    items: items.map((i) => ({ ...i })),
  });

  it('+2 for matching pattern, -5 for avoided pattern', () => {
    const outfit = makeOutfit('o1', [
      { id: 'i1', slot: 'tops', style_descriptors: ['Solid', 'Floral'] },
      { id: 'i2', slot: 'bottoms' },
      { id: 'i3', slot: 'shoes' },
    ]);
    const ctx: any = {
      styleProfile: {
        fit_preferences: [],
        fabric_preferences: [],
        pattern_preferences: ['Solid'],
        avoid_patterns: ['Floral'],
      },
    };
    const result = scoreOutfit(outfit, ctx, { mode: 'studio', rerank: true });
    expect(result.flags).toContain('pattern');
    // +2 solid match, -5 floral avoid, +5 slot = 2
    expect(result.score).toBe(2);
  });
});

describe('Silhouette preference scoring', () => {
  const makeOutfit = (id: string, items: any[]): any => ({
    id,
    items: items.map((i) => ({ ...i })),
  });

  it('+6 for matching fit, -6 for mismatching', () => {
    const outfit = makeOutfit('o1', [
      { id: 'i1', slot: 'tops', fit: 'tailored' },
      { id: 'i2', slot: 'bottoms', fit: 'oversized' },
      { id: 'i3', slot: 'shoes' },
    ]);
    const ctx: any = {
      styleProfile: {
        fit_preferences: [],
        fabric_preferences: [],
        silhouette_preference: 'Structured',
      },
    };
    const result = scoreOutfit(outfit, ctx, { mode: 'studio', rerank: true });
    expect(result.flags).toContain('silhouette');
    // tailored +6, oversized -6, slot +5 = 5
    expect(result.score).toBe(5);
  });
});

describe('Contrast preference scoring', () => {
  const makeOutfit = (id: string, items: any[]): any => ({
    id,
    items: items.map((i) => ({ ...i })),
  });

  it('+3 when outfit contrast matches "High contrast"', () => {
    const outfit = makeOutfit('o1', [
      { id: 'i1', slot: 'tops', color: 'white' },
      { id: 'i2', slot: 'bottoms', color: 'black' },
      { id: 'i3', slot: 'shoes', color: 'brown' },
    ]);
    const ctx: any = {
      styleProfile: {
        fit_preferences: [],
        fabric_preferences: [],
        contrast_preference: 'High contrast',
      },
    };
    const result = scoreOutfit(outfit, ctx, { mode: 'studio', rerank: true });
    expect(result.flags).toContain('contrast');
    // +7 contrast (rebalanced), +5 slot = 12
    expect(result.score).toBe(12);
  });

  it('skips when preference is "No preference"', () => {
    const outfit = makeOutfit('o1', [
      { id: 'i1', slot: 'tops', color: 'white' },
    ]);
    const ctx: any = {
      styleProfile: {
        fit_preferences: [],
        fabric_preferences: [],
        contrast_preference: 'No preference',
      },
    };
    const result = scoreOutfit(outfit, ctx, { mode: 'studio', rerank: true });
    expect(result.flags).not.toContain('contrast');
  });
});
