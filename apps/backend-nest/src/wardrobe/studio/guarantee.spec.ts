import { runStudioOrchestrator } from './orchestrator';
import type { StudioItem, StudioBuildContext } from './types';

function make(partial: Partial<StudioItem>): StudioItem {
  return {
    id: partial.id!,
    label: partial.label ?? 'Item',
    main_category: partial.main_category,
    subcategory: partial.subcategory,
    color: partial.color ?? 'navy',
    color_family: partial.color_family ?? 'navy',
    formality_score: partial.formality_score ?? 5,
    ...partial,
  };
}

const baseCtx: StudioBuildContext = {
  effectiveQuery: 'casual day',
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
    environment: 'everyday',
    isBeachContext: false,
    isGymContext: false,
    isFormalContext: false,
    neutralizeProfileDressBias: false,
  },
  userPresentation: 'mixed',
  styleProfile: null,
};

describe('AI Studio — Guaranteed 3-outfit emission', () => {
  it('emits 3 outfits when tops=3, bottoms=2, shoes=1 (the documented failure case)', () => {
    const catalog: StudioItem[] = [
      make({ id: 't1', label: 'Shirt 1', main_category: 'Tops', subcategory: 'Shirt' }),
      make({ id: 't2', label: 'Shirt 2', main_category: 'Tops', subcategory: 'Shirt' }),
      make({ id: 't3', label: 'Shirt 3', main_category: 'Tops', subcategory: 'Shirt' }),
      make({ id: 'b1', label: 'Chino 1', main_category: 'Bottoms', subcategory: 'Chino' }),
      make({ id: 'b2', label: 'Chino 2', main_category: 'Bottoms', subcategory: 'Chino' }),
      make({ id: 's1', label: 'Sneaker', main_category: 'Shoes', subcategory: 'Sneakers' }),
    ];
    const result = runStudioOrchestrator(catalog, baseCtx, {
      requestId: 'r1',
      userId: 'u1',
    });
    expect(result).toHaveLength(3);
    result.forEach((o) => {
      expect(o.slots.top).toBeTruthy();
      expect(o.slots.bottom).toBeTruthy();
      expect(o.slots.shoes).toBeTruthy();
    });
  });

  it('emits 3 outfits when tops=1, bottoms=1, shoes=1 (minimum wardrobe)', () => {
    const catalog: StudioItem[] = [
      make({ id: 't1', label: 'Shirt', main_category: 'Tops', subcategory: 'Shirt' }),
      make({ id: 'b1', label: 'Chino', main_category: 'Bottoms', subcategory: 'Chino' }),
      make({ id: 's1', label: 'Sneaker', main_category: 'Shoes', subcategory: 'Sneakers' }),
    ];
    const result = runStudioOrchestrator(catalog, baseCtx, {
      requestId: 'r2',
      userId: 'u2',
    });
    expect(result).toHaveLength(3);
  });

  it('produces deterministic content across repeat runs (slot signatures identical)', () => {
    const catalog: StudioItem[] = [
      make({ id: 't1', label: 'A', main_category: 'Tops', subcategory: 'Shirt' }),
      make({ id: 't2', label: 'B', main_category: 'Tops', subcategory: 'Shirt' }),
      make({ id: 't3', label: 'C', main_category: 'Tops', subcategory: 'Shirt' }),
      make({ id: 'b1', label: 'D', main_category: 'Bottoms', subcategory: 'Chino' }),
      make({ id: 'b2', label: 'E', main_category: 'Bottoms', subcategory: 'Chino' }),
      make({ id: 's1', label: 'F', main_category: 'Shoes', subcategory: 'Sneakers' }),
    ];
    const sig = (r: ReturnType<typeof runStudioOrchestrator>) =>
      r.map((o) => [o.slots.top.id, o.slots.bottom.id, o.slots.shoes.id].join(','));
    const r1 = runStudioOrchestrator(catalog, baseCtx, { requestId: 'x', userId: 'y' });
    const r2 = runStudioOrchestrator(catalog, baseCtx, { requestId: 'x', userId: 'y' });
    expect(sig(r1)).toEqual(sig(r2));
  });

  it('does not throw WARDROBE_INSUFFICIENT_COMPATIBLE on sparse wardrobes', () => {
    const catalog: StudioItem[] = [
      make({ id: 't1', main_category: 'Tops', subcategory: 'Shirt' }),
      make({ id: 'b1', main_category: 'Bottoms', subcategory: 'Chino' }),
      make({ id: 'b2', main_category: 'Bottoms', subcategory: 'Chino' }),
      make({ id: 's1', main_category: 'Shoes', subcategory: 'Sneakers' }),
    ];
    expect(() =>
      runStudioOrchestrator(catalog, baseCtx, { requestId: 'z', userId: 'z' }),
    ).not.toThrow();
  });
});
