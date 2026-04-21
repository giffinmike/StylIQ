// apps/backend-nest/src/wardrobe/studio/studio.spec.ts
//
// Unit tests for AI Outfit Studio deterministic lockdown.

import { runStudioOrchestrator } from './orchestrator';
import { StudioInvariantError } from './types';
import type { StudioBuildContext, StudioItem } from './types';
import {
  applyEnvironmentalHardGate,
  deriveEnvironmentTier,
} from './filters';

function item(
  id: string,
  main_category: string,
  subcategory: string,
  extra: Partial<StudioItem> = {},
): StudioItem {
  return {
    id,
    label: `${id} ${subcategory}`,
    main_category,
    subcategory,
    color: 'navy',
    color_family: 'navy',
    formality_score: 5,
    ...extra,
  };
}

function baseCtx(
  environment:
    | 'beach'
    | 'gym'
    | 'black-tie'
    | 'wedding'
    | 'upscale'
    | 'everyday' = 'everyday',
  overrides: Partial<StudioBuildContext> = {},
): StudioBuildContext {
  return {
    effectiveQuery: 'test prompt',
    parsedConstraints: {
      wantsLoafers: false,
      wantsSneakers: false,
      wantsBoots: false,
      wantsBlazer: false,
      excludeLoafers: false,
      excludeSneakers: false,
      excludeBoots: false,
      excludeBrown: false,
      wantsBrown: false,
    },
    studio: {
      environment,
      isBeachContext: environment === 'beach',
      isGymContext: environment === 'gym',
      isFormalContext:
        environment === 'black-tie' ||
        environment === 'wedding' ||
        environment === 'upscale',
      neutralizeProfileDressBias:
        environment === 'beach' ||
        environment === 'gym' ||
        environment === 'black-tie',
    },
    userPresentation: 'mixed',
    styleProfile: null,
    ...overrides,
  };
}

describe('AI Outfit Studio — deterministic lockdown', () => {
  it('happy path: 3 outfits with mandatory top/bottom/shoes and slot field', () => {
    const pool: StudioItem[] = [
      item('t1', 'Tops', 'polo', { formality_score: 5 }),
      item('t2', 'Tops', 'shirt', { formality_score: 6 }),
      item('t3', 'Tops', 'tee', { formality_score: 4 }),
      item('t4', 'Tops', 'sweater', { formality_score: 5 }),
      item('b1', 'Bottoms', 'chinos', { formality_score: 5 }),
      item('b2', 'Bottoms', 'jeans', { formality_score: 4 }),
      item('b3', 'Bottoms', 'trousers', { formality_score: 6 }),
      item('s1', 'Shoes', 'loafers', { formality_score: 6 }),
      item('s2', 'Shoes', 'sneakers', { formality_score: 4 }),
      item('s3', 'Shoes', 'boots', { formality_score: 5 }),
      item('o1', 'Outerwear', 'blazer', { formality_score: 7 }),
      item('a1', 'Accessories', 'belt', { formality_score: 5 }),
    ];

    const outfits = runStudioOrchestrator(pool, baseCtx(), {
      requestId: 'req1',
      userId: 'user1',
    });

    expect(outfits.length).toBeGreaterThanOrEqual(1);
    for (const o of outfits) {
      expect(o.slots.top).toBeTruthy();
      expect(o.slots.bottom).toBeTruthy();
      expect(o.slots.shoes).toBeTruthy();
      expect(o.items.length).toBeGreaterThanOrEqual(3);
      expect(o.items.length).toBeLessThanOrEqual(5);
      expect(o.outfit_id).toBeTruthy();
    }
    // Tops should not repeat across the slate (size equals slate length).
    const topIds = outfits.map((o) => o.slots.top.id);
    expect(new Set(topIds).size).toBe(outfits.length);
  });

  it('beach context suppresses layer slot', () => {
    const pool: StudioItem[] = [
      item('t1', 'Tops', 'polo'),
      item('t2', 'Tops', 'tee'),
      item('t3', 'Tops', 'tank'),
      item('b1', 'Bottoms', 'shorts'),
      item('b2', 'Bottoms', 'shorts', { id: 'b2' }),
      item('b3', 'Bottoms', 'shorts', { id: 'b3' }),
      item('s1', 'Shoes', 'sandal'),
      item('s2', 'Shoes', 'sandal', { id: 's2' }),
      item('s3', 'Shoes', 'sandal', { id: 's3' }),
      item('o1', 'Outerwear', 'blazer'),
    ];

    const outfits = runStudioOrchestrator(pool, baseCtx('beach'), {
      requestId: 'req2',
      userId: 'user2',
    });
    expect(outfits.length).toBeGreaterThanOrEqual(1);
    for (const o of outfits) {
      expect(o.slots.layer).toBeNull();
    }
  });

  it('missing shoes throws WARDROBE_INSUFFICIENT_SHOES', () => {
    const pool: StudioItem[] = [
      item('t1', 'Tops', 'polo'),
      item('b1', 'Bottoms', 'chinos'),
      item('b2', 'Bottoms', 'jeans'),
    ];
    expect.assertions(2);
    try {
      runStudioOrchestrator(pool, baseCtx(), {
        requestId: 'r3',
        userId: 'u3',
      });
    } catch (err) {
      expect(err).toBeInstanceOf(StudioInvariantError);
      expect((err as StudioInvariantError).code).toBe(
        'WARDROBE_INSUFFICIENT_SHOES',
      );
    }
  });

  it('tight wardrobe: reuses mandatory items across outfits', () => {
    const pool: StudioItem[] = [
      item('t1', 'Tops', 'polo'), // single top must be reused
      item('b1', 'Bottoms', 'chinos'),
      item('b2', 'Bottoms', 'jeans'),
      item('b3', 'Bottoms', 'trousers'),
      item('s1', 'Shoes', 'loafers'),
      item('s2', 'Shoes', 'sneakers'),
      item('s3', 'Shoes', 'boots'),
    ];
    const outfits = runStudioOrchestrator(pool, baseCtx(), {
      requestId: 'r4',
      userId: 'u4',
    });
    expect(outfits.length).toBeGreaterThanOrEqual(1);
    // Every emitted outfit must use the single available top.
    const tops = outfits.map((o) => o.slots.top.id);
    expect(new Set(tops).size).toBe(1);
  });

  it('masculine presentation filters feminine items before assembly', () => {
    const pool: StudioItem[] = [
      item('t1', 'Tops', 'polo'),
      item('t2', 'Tops', 'blouse'), // feminine — must be dropped
      item('t3', 'Tops', 'shirt'),
      item('t4', 'Tops', 'tee'),
      item('b1', 'Bottoms', 'chinos'),
      item('b2', 'Bottoms', 'jeans'),
      item('b3', 'Bottoms', 'trousers'),
      item('d1', 'Dresses', 'dress'), // feminine main_category — must be dropped
      item('s1', 'Shoes', 'loafers'),
      item('s2', 'Shoes', 'sneakers'),
      item('s3', 'Shoes', 'boots'),
    ];
    const ctx = baseCtx('everyday', { userPresentation: 'masculine' });
    const outfits = runStudioOrchestrator(pool, ctx, {
      requestId: 'r5',
      userId: 'u5',
    });
    expect(outfits.length).toBeGreaterThanOrEqual(1);
    for (const o of outfits) {
      // None of the assembled items should be the feminine blouse.
      const ids = o.items.map((i) => i.id);
      expect(ids).not.toContain('t2');
      expect(ids).not.toContain('d1');
    }
  });

  describe('environmental hard gate', () => {
    const heatCtx = baseCtx('beach', {
      weather: { tempF: 92, precipitation: 'none' },
    });
    const coldCtx = baseCtx('everyday', {
      weather: { tempF: 20, precipitation: 'snow' },
    });
    const athleticCtx = baseCtx('gym');
    const formalCtx = baseCtx('wedding');

    it('derives tiers correctly across contexts', () => {
      expect(deriveEnvironmentTier(heatCtx)).toBe('EXTREME_HEAT');
      expect(deriveEnvironmentTier(coldCtx)).toBe('EXTREME_COLD');
      expect(deriveEnvironmentTier(athleticCtx)).toBe('ATHLETIC');
      expect(deriveEnvironmentTier(formalCtx)).toBe('FORMAL_EVENT');
      expect(deriveEnvironmentTier(baseCtx())).toBe('NORMAL');
    });

    it('EXTREME_HEAT removes wool, sweaters, sport coats, leather dress shoes, structured trousers', () => {
      const pool: StudioItem[] = [
        item('t_wool', 'Tops', 'sweater', { material: 'wool' }),
        item('t_cashmere', 'Tops', 'sweater', { material: 'cashmere' }),
        item('t_tee', 'Tops', 'tee', { material: 'cotton' }),
        item('o_blazer', 'Outerwear', 'blazer', { material: 'wool' }),
        item('o_sportcoat', 'Outerwear', 'sport coat', { material: 'wool' }),
        item('b_trousers', 'Bottoms', 'trousers', { material: 'wool' }),
        item('b_shorts', 'Bottoms', 'shorts', { material: 'cotton' }),
        item('s_oxford', 'Shoes', 'oxfords', { material: 'leather' }),
        item('s_sandal', 'Shoes', 'sandals', { material: 'leather' }),
        item('f_formal', 'Formalwear', 'suit', { formality_score: 9 }),
      ];
      const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const kept = applyEnvironmentalHardGate(pool, heatCtx);
        const keptIds = kept.map((k) => k.id);
        expect(keptIds).not.toContain('t_wool');
        expect(keptIds).not.toContain('t_cashmere');
        expect(keptIds).not.toContain('o_blazer');
        expect(keptIds).not.toContain('o_sportcoat');
        expect(keptIds).not.toContain('b_trousers');
        expect(keptIds).not.toContain('s_oxford');
        expect(keptIds).not.toContain('f_formal');
        expect(keptIds).toContain('t_tee');
        expect(keptIds).toContain('b_shorts');
        expect(keptIds).toContain('s_sandal');
      } finally {
        spy.mockRestore();
      }
    });

    it('EXTREME_COLD removes shorts, linen, open-weave, sandals', () => {
      const pool: StudioItem[] = [
        item('b_shorts', 'Bottoms', 'shorts', { material: 'cotton' }),
        item('t_linen', 'Tops', 'shirt', { material: 'linen' }),
        item('t_mesh', 'Tops', 'tee', { material: 'mesh' }),
        item('s_sandal', 'Shoes', 'sandals'),
        item('s_flipflop', 'Shoes', 'flip flops'),
        item('b_jeans', 'Bottoms', 'jeans', { material: 'denim' }),
        item('t_sweater', 'Tops', 'sweater', { material: 'wool' }),
        item('s_boot', 'Shoes', 'boots'),
      ];
      const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const kept = applyEnvironmentalHardGate(pool, coldCtx);
        const keptIds = kept.map((k) => k.id);
        expect(keptIds).not.toContain('b_shorts');
        expect(keptIds).not.toContain('t_linen');
        expect(keptIds).not.toContain('t_mesh');
        expect(keptIds).not.toContain('s_sandal');
        expect(keptIds).not.toContain('s_flipflop');
        expect(keptIds).toContain('b_jeans');
        expect(keptIds).toContain('t_sweater');
        expect(keptIds).toContain('s_boot');
      } finally {
        spy.mockRestore();
      }
    });

    it('ATHLETIC removes tailoring, leather dress shoes, business formal', () => {
      const pool: StudioItem[] = [
        item('o_blazer', 'Outerwear', 'blazer'),
        item('o_suit', 'Outerwear', 'suit'),
        item('s_oxford', 'Shoes', 'oxfords'),
        item('s_loafer', 'Shoes', 'loafers'),
        item('f_biz', 'Tops', 'dress shirt', {
          dress_code: 'BusinessFormal',
          formality_score: 9,
        }),
        item('t_tank', 'Activewear', 'tank top'),
        item('s_sneaker', 'Shoes', 'sneakers'),
        item('b_shorts', 'Activewear', 'shorts'),
      ];
      const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const kept = applyEnvironmentalHardGate(pool, athleticCtx);
        const keptIds = kept.map((k) => k.id);
        expect(keptIds).not.toContain('o_blazer');
        expect(keptIds).not.toContain('o_suit');
        expect(keptIds).not.toContain('s_oxford');
        expect(keptIds).not.toContain('s_loafer');
        expect(keptIds).not.toContain('f_biz');
        expect(keptIds).toContain('t_tank');
        expect(keptIds).toContain('s_sneaker');
        expect(keptIds).toContain('b_shorts');
      } finally {
        spy.mockRestore();
      }
    });

    it('FORMAL_EVENT removes ultracasual, gymwear, shorts, sandals', () => {
      const pool: StudioItem[] = [
        item('u_casual', 'Tops', 'tee', { dress_code: 'UltraCasual' }),
        item('g_jersey', 'Tops', 'jersey'),
        item('b_shorts', 'Bottoms', 'shorts'),
        item('s_sandal', 'Shoes', 'sandals'),
        item('t_shirt', 'Tops', 'dress shirt'),
        item('b_trousers', 'Bottoms', 'trousers'),
        item('s_oxford', 'Shoes', 'oxfords'),
      ];
      const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const kept = applyEnvironmentalHardGate(pool, formalCtx);
        const keptIds = kept.map((k) => k.id);
        expect(keptIds).not.toContain('u_casual');
        expect(keptIds).not.toContain('g_jersey');
        expect(keptIds).not.toContain('b_shorts');
        expect(keptIds).not.toContain('s_sandal');
        expect(keptIds).toContain('t_shirt');
        expect(keptIds).toContain('b_trousers');
        expect(keptIds).toContain('s_oxford');
      } finally {
        spy.mockRestore();
      }
    });

    it('NORMAL tier returns pool unchanged', () => {
      const pool: StudioItem[] = [
        item('t_wool', 'Tops', 'sweater', { material: 'wool' }),
        item('b_shorts', 'Bottoms', 'shorts'),
        item('s_sandal', 'Shoes', 'sandals'),
      ];
      const ctx = baseCtx('everyday', {
        weather: { tempF: 68, precipitation: 'none' },
      });
      expect(deriveEnvironmentTier(ctx)).toBe('NORMAL');
      const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const kept = applyEnvironmentalHardGate(pool, ctx);
        expect(kept).toEqual(pool);
      } finally {
        spy.mockRestore();
      }
    });
  });

  it('logs AI_OUTFIT_STUDIO_SLOT_VALIDATION with hasTop/hasBottom/hasShoes', () => {
    const pool: StudioItem[] = [
      item('t1', 'Tops', 'polo'),
      item('t2', 'Tops', 'shirt'),
      item('t3', 'Tops', 'tee'),
      item('b1', 'Bottoms', 'chinos'),
      item('b2', 'Bottoms', 'jeans'),
      item('b3', 'Bottoms', 'trousers'),
      item('s1', 'Shoes', 'loafers'),
      item('s2', 'Shoes', 'sneakers'),
      item('s3', 'Shoes', 'boots'),
    ];
    const calls: unknown[][] = [];
    const spy = jest
      .spyOn(console, 'log')
      .mockImplementation((...args: unknown[]) => {
        calls.push(args);
      });
    try {
      runStudioOrchestrator(pool, baseCtx(), {
        requestId: 'r6',
        userId: 'u6',
      });
    } finally {
      spy.mockRestore();
    }
    const call = calls.find(
      (args) => args[0] === 'AI_OUTFIT_STUDIO_SLOT_VALIDATION:',
    );
    expect(call).toBeTruthy();
    const payload = call![1] as Array<{
      hasTop: boolean;
      hasBottom: boolean;
      hasShoes: boolean;
    }>;
    expect(payload.length).toBeGreaterThanOrEqual(1);
    for (const entry of payload) {
      expect(entry.hasTop).toBe(true);
      expect(entry.hasBottom).toBe(true);
      expect(entry.hasShoes).toBe(true);
    }
  });
});
