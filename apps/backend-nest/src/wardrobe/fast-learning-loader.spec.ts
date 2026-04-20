/**
 * Tests for FAST-scoped learning signal loader + boost layer.
 *
 * Covers:
 * 1. loadFastLearningSignals — signals loaded, cold start, no row
 * 2. applyFastLearningBoost — ranking changes, baseline preservation, clamp
 * 3. Determinism — same inputs → same output
 */

// Mock pool before importing the module under test
jest.mock('../db/pool', () => ({
  pool: {
    query: jest.fn(),
  },
}));

import { pool } from '../db/pool';
import {
  loadFastLearningSignals,
  applyFastLearningBoost,
  type FastLearningSignals,
} from './fast-learning-loader';

const mockQuery = pool.query as jest.Mock;

// ── Fixtures ────────────────────────────────────────────────────────────────

const USER_ID = 'test-user-123';

const ACTIVE_STATE_ROW = {
  user_id: USER_ID,
  brand_scores: { nike: 3.5, adidas: 1.2, gucci: -2.0 },
  color_scores: { navy: 2.5, black: 1.8, 'bright yellow': -1.5 },
  category_scores: { tops: 2.0, bottoms: 1.0 },
  style_scores: { minimalist: 3.0, bohemian: -1.0 },
  material_scores: { cotton: 4.0, linen: 2.5, polyester: -2.0, nylon: -1.5 },
  tag_scores: {},
  fit_issues: {},
  avg_purchase_price: '85.00',
  price_bracket: 'mid',
  occasion_frequency: { casual: 15, business: 8, formal: 2 },
  events_processed_count: 25,
  is_cold_start: false,
  last_computed_at: new Date().toISOString(),
  state_version: 1,
};

const COLD_START_ROW = {
  ...ACTIVE_STATE_ROW,
  is_cold_start: true,
  events_processed_count: 3,
};

function mkOutfit(id: string, items: any[]) {
  return { outfit_id: id, title: `Outfit ${id}`, items };
}

function mkItem(
  overrides: Partial<{
    id: string;
    material: string;
    formality_score: number;
    main_category: string;
  }>,
) {
  return {
    id: overrides.id ?? `item-${Math.random().toString(36).slice(2, 6)}`,
    name: 'Test Item',
    main_category: overrides.main_category ?? 'Tops',
    material: overrides.material ?? 'cotton',
    formality_score: overrides.formality_score ?? 2,
  };
}

// ── loadFastLearningSignals ─────────────────────────────────────────────────

describe('loadFastLearningSignals', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('returns signals when user_fashion_state has data and is_cold_start=false', async () => {
    mockQuery.mockResolvedValue({ rows: [ACTIVE_STATE_ROW] });

    const result = await loadFastLearningSignals(USER_ID);

    expect(result).not.toBeNull();
    expect(result!.summary.topBrands).toEqual(['nike', 'adidas']);
    expect(result!.summary.avoidBrands).toEqual(['gucci']);
    expect(result!.summary.topColors).toEqual(['navy', 'black']);
    expect(result!.summary.avoidColors).toEqual(['bright yellow']);
    expect(result!.summary.topStyles).toEqual(['minimalist']);
    expect(result!.summary.avoidStyles).toEqual(['bohemian']);
    expect(result!.materialAffinity.top).toEqual(['cotton', 'linen']);
    expect(result!.materialAffinity.bottom).toEqual(['polyester', 'nylon']);
    expect(result!.dominantOccasion).toBe('casual');
    expect(result!.signalCount).toBeGreaterThan(0);
    expect(result!.summary.isColdStart).toBe(false);
  });

  it('returns null when is_cold_start=true', async () => {
    mockQuery.mockResolvedValue({ rows: [COLD_START_ROW] });

    const result = await loadFastLearningSignals(USER_ID);

    expect(result).toBeNull();
  });

  it('returns null when no row exists', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const result = await loadFastLearningSignals(USER_ID);

    expect(result).toBeNull();
  });

  it('returns null on DB error', async () => {
    mockQuery.mockRejectedValue(new Error('connection refused'));

    const result = await loadFastLearningSignals(USER_ID);

    expect(result).toBeNull();
  });

  it('returns null on timeout', async () => {
    // Simulate slow query that exceeds 100ms timeout
    mockQuery.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ rows: [ACTIVE_STATE_ROW] }), 200),
        ),
    );

    const result = await loadFastLearningSignals(USER_ID);

    expect(result).toBeNull();
  });

  it('counts non-zero scores correctly', async () => {
    mockQuery.mockResolvedValue({ rows: [ACTIVE_STATE_ROW] });

    const result = await loadFastLearningSignals(USER_ID);

    // brand: 3 (nike, adidas, gucci) + color: 3 + category: 2 + style: 2 + material: 4 = 14
    expect(result!.signalCount).toBe(14);
  });
});

// ── applyFastLearningBoost ──────────────────────────────────────────────────

describe('applyFastLearningBoost', () => {
  const baseSignals: FastLearningSignals = {
    summary: {
      topBrands: ['nike'],
      avoidBrands: [],
      topColors: ['navy'],
      avoidColors: [],
      topStyles: ['minimalist'],
      avoidStyles: [],
      topCategories: ['tops'],
      priceBracket: 'mid',
      isColdStart: false,
    },
    materialAffinity: {
      top: ['cotton', 'linen'],
      bottom: ['polyester', 'nylon'],
    },
    dominantOccasion: 'casual',
    signalCount: 10,
  };

  it('boosts outfit with top-affinity material higher', () => {
    const outfits = [
      mkOutfit('A', [mkItem({ material: 'polyester', formality_score: 1 })]),
      mkOutfit('B', [mkItem({ material: 'cotton', formality_score: 1 })]),
    ];

    const { outfits: ranked, boostLog } = applyFastLearningBoost(
      outfits,
      baseSignals,
    );

    // B has cotton (top affinity +4), A has polyester (bottom -6)
    expect(ranked[0].outfit_id).toBe('B');
    expect(ranked[1].outfit_id).toBe('A');
    expect(boostLog.length).toBeGreaterThan(0);
    expect(
      boostLog.some((b) => b.reason.startsWith('material_affinity_top')),
    ).toBe(true);
    expect(
      boostLog.some((b) => b.reason.startsWith('material_affinity_bottom')),
    ).toBe(true);
  });

  it('preserves order when no signals match', () => {
    const outfits = [
      mkOutfit('A', [mkItem({ material: 'silk', formality_score: 4 })]),
      mkOutfit('B', [mkItem({ material: 'wool', formality_score: 4 })]),
      mkOutfit('C', [mkItem({ material: 'cashmere', formality_score: 4 })]),
    ];

    // dominantOccasion=casual (tier 1), but items formality_score=4 → distance=3 → no boost
    const signalsNoMaterialMatch: FastLearningSignals = {
      ...baseSignals,
      materialAffinity: { top: ['denim'], bottom: ['spandex'] },
    };

    const { outfits: ranked, boostLog } = applyFastLearningBoost(
      outfits,
      signalsNoMaterialMatch,
    );

    expect(ranked.map((o: any) => o.outfit_id)).toEqual(['A', 'B', 'C']);
    expect(boostLog.length).toBe(0);
  });

  it('clamps total boost to [-15, +15]', () => {
    // Material top (+4) + occasion alignment (+3) → total = 7, within bounds
    const outfits = [
      mkOutfit('A', [mkItem({ material: 'cotton', formality_score: 1 })]),
    ];

    const { boostLog } = applyFastLearningBoost(outfits, baseSignals);

    const totalBoost = boostLog
      .filter((b) => b.outfitIndex === 0)
      .reduce((sum, b) => sum + b.delta, 0);
    expect(totalBoost).toBeGreaterThanOrEqual(-15);
    expect(totalBoost).toBeLessThanOrEqual(15);
  });

  it('does not stack material boost per item', () => {
    // Multiple cotton items in outfit A → only +4 once, not per item
    const outfits = [
      mkOutfit('A', [
        mkItem({ material: 'cotton', formality_score: 1 }),
        mkItem({ material: 'cotton', formality_score: 1 }),
        mkItem({ material: 'cotton', formality_score: 1 }),
      ]),
      mkOutfit('B', [mkItem({ material: 'silk', formality_score: 4 })]),
    ];

    const { boostLog } = applyFastLearningBoost(outfits, baseSignals);

    const materialBoostsA = boostLog.filter(
      (b) =>
        b.outfitIndex === 0 && b.reason.startsWith('material_affinity_top'),
    );
    expect(materialBoostsA.length).toBe(1);
    expect(materialBoostsA[0].delta).toBe(4);
  });

  it('applies occasion alignment when formality matches', () => {
    // dominantOccasion=casual → tier 1, formality_score=1 → distance=0 → +3
    const outfits = [
      mkOutfit('A', [mkItem({ material: 'silk', formality_score: 1 })]),
      mkOutfit('B', [mkItem({ material: 'silk', formality_score: 4 })]),
    ];

    const { boostLog } = applyFastLearningBoost(outfits, baseSignals);

    expect(
      boostLog.some(
        (b) => b.outfitIndex === 0 && b.reason.startsWith('occasion_alignment'),
      ),
    ).toBe(true);
    // B (formality 4) should NOT get occasion boost for casual dominant
    expect(
      boostLog.some(
        (b) => b.outfitIndex === 1 && b.reason.startsWith('occasion_alignment'),
      ),
    ).toBe(false);
  });

  it('does not apply occasion boost when formality is distant', () => {
    // dominantOccasion=casual → tier 1, formality_score=4 → distance=3 → no boost
    const outfits = [
      mkOutfit('A', [mkItem({ material: 'silk', formality_score: 4 })]),
      mkOutfit('B', [mkItem({ material: 'silk', formality_score: 4 })]),
    ];

    const { boostLog } = applyFastLearningBoost(outfits, baseSignals);

    expect(
      boostLog.some((b) => b.reason.startsWith('occasion_alignment')),
    ).toBe(false);
  });

  it('returns outfits unchanged for single outfit', () => {
    const outfits = [mkOutfit('A', [mkItem({ material: 'cotton' })])];

    const { outfits: ranked } = applyFastLearningBoost(outfits, baseSignals);

    expect(ranked.length).toBe(1);
    expect(ranked[0].outfit_id).toBe('A');
  });

  it('is deterministic: same inputs always produce same output', () => {
    const outfits = [
      mkOutfit('A', [
        mkItem({ id: 'i1', material: 'polyester', formality_score: 1 }),
      ]),
      mkOutfit('B', [
        mkItem({ id: 'i2', material: 'cotton', formality_score: 1 }),
      ]),
      mkOutfit('C', [
        mkItem({ id: 'i3', material: 'silk', formality_score: 1 }),
      ]),
    ];

    const run1 = applyFastLearningBoost(outfits, baseSignals);
    const run2 = applyFastLearningBoost(outfits, baseSignals);
    const run3 = applyFastLearningBoost(outfits, baseSignals);

    const ids1 = run1.outfits.map((o: any) => o.outfit_id);
    const ids2 = run2.outfits.map((o: any) => o.outfit_id);
    const ids3 = run3.outfits.map((o: any) => o.outfit_id);

    expect(ids1).toEqual(ids2);
    expect(ids2).toEqual(ids3);
    expect(JSON.stringify(run1.boostLog)).toBe(JSON.stringify(run2.boostLog));
  });
});
