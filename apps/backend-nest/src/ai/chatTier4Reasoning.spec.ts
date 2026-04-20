import {
  detectRelevantCategory,
  detectFormalityAnchor,
  buildShortlist,
  formatShortlistForPrompt,
  validateReasoningQuality,
  REASONING_CORRECTION,
  type ShortlistItem,
} from './chatTier4Reasoning';
import type { ChatAvoidLists } from './chatTier4';
import { isSlot } from '../wardrobe/logic/categoryMapping';

// ── Helpers ───────────────────────────────────────────────────────────────

const makeItem = (overrides: Partial<ShortlistItem> = {}): ShortlistItem => ({
  name: 'Test Item',
  main_category: 'Outerwear',
  color: 'black',
  material: 'wool',
  brand: 'Zara',
  fit: 'tailored',
  formality_score: 8,
  pattern: 'solid',
  ...overrides,
});

const emptyAvoids: ChatAvoidLists = {
  avoidColors: [],
  avoidMaterials: [],
  avoidPatterns: [],
  coverageNoGo: [],
};

// ── detectRelevantCategory ────────────────────────────────────────────────

describe('detectRelevantCategory', () => {
  it('detects blazer → Outerwear', () => {
    expect(detectRelevantCategory('Which blazer should I wear?')).toBe(
      'Outerwear',
    );
  });

  it('detects jacket → Outerwear', () => {
    expect(detectRelevantCategory('My favorite jacket')).toBe('Outerwear');
  });

  it('detects dress → Dresses', () => {
    expect(detectRelevantCategory('What dress for the wedding?')).toBe(
      'Dresses',
    );
  });

  it('detects shoes → Footwear', () => {
    expect(detectRelevantCategory('Which shoes go with this?')).toBe(
      'Footwear',
    );
  });

  it('detects pants → Bottoms', () => {
    expect(detectRelevantCategory('Should I wear pants or a skirt?')).toBe(
      'Bottoms',
    );
  });

  it('detects blouse → Tops', () => {
    expect(detectRelevantCategory('Pair a blouse with my skirt')).toBe('Tops');
  });

  it('returns null for non-category queries', () => {
    expect(detectRelevantCategory('How is the weather today?')).toBeNull();
  });

  it('returns null for generic style questions', () => {
    expect(
      detectRelevantCategory('What should I wear to look professional?'),
    ).toBeNull();
  });
});

// ── detectFormalityAnchor ─────────────────────────────────────────────────

describe('detectFormalityAnchor', () => {
  it('detects "powerful"', () => {
    expect(detectFormalityAnchor('I want to look powerful')).toBe(
      'elevated_business',
    );
  });

  it('detects "luxurious"', () => {
    expect(detectFormalityAnchor('Something luxurious please')).toBe(
      'elevated_business',
    );
  });

  it('detects "authoritative"', () => {
    expect(detectFormalityAnchor('I need an authoritative look')).toBe(
      'elevated_business',
    );
  });

  it('detects "commanding"', () => {
    expect(detectFormalityAnchor('A commanding presence')).toBe(
      'elevated_business',
    );
  });

  it('detects "expensive"', () => {
    expect(detectFormalityAnchor('Make me look expensive')).toBe(
      'elevated_business',
    );
  });

  it('detects "sophisticated"', () => {
    expect(detectFormalityAnchor('I want a sophisticated vibe')).toBe(
      'elevated_business',
    );
  });

  it('returns null for casual queries', () => {
    expect(detectFormalityAnchor('What should I wear to brunch?')).toBeNull();
  });

  it('returns null for generic questions', () => {
    expect(detectFormalityAnchor('Show me my wardrobe')).toBeNull();
  });
});

// ── buildShortlist ────────────────────────────────────────────────────────

describe('buildShortlist', () => {
  it('filters by category when detected', () => {
    const items = [
      makeItem({ name: 'Black Blazer', main_category: 'Outerwear' }),
      makeItem({ name: 'White T-Shirt', main_category: 'Tops' }),
      makeItem({ name: 'Navy Coat', main_category: 'Outerwear' }),
    ];
    const result = buildShortlist(items, emptyAvoids, 'Outerwear', null);
    expect(result.every((i) => isSlot(i, 'outerwear'))).toBe(true);
    expect(result.length).toBe(2);
  });

  it('excludes avoid colors (with family expansion)', () => {
    const items = [
      makeItem({ name: 'Navy Blazer', color: 'navy' }),
      makeItem({ name: 'Black Blazer', color: 'black' }),
      makeItem({ name: 'Royal Blue Shirt', color: 'royal blue' }),
    ];
    const avoids: ChatAvoidLists = { ...emptyAvoids, avoidColors: ['blue'] };
    const result = buildShortlist(items, avoids, null, null);
    // navy and royal blue are in the blue family → excluded
    expect(result.map((i) => i.name)).toEqual(['Black Blazer']);
  });

  it('excludes avoid materials', () => {
    const items = [
      makeItem({ name: 'Silk Blouse', material: 'silk' }),
      makeItem({ name: 'Cotton Tee', material: 'cotton' }),
    ];
    const avoids: ChatAvoidLists = { ...emptyAvoids, avoidMaterials: ['Silk'] };
    const result = buildShortlist(items, avoids, null, null);
    expect(result.map((i) => i.name)).toEqual(['Cotton Tee']);
  });

  it('excludes avoid patterns', () => {
    const items = [
      makeItem({ name: 'Plaid Shirt', pattern: 'plaid' }),
      makeItem({ name: 'Solid Blazer', pattern: 'solid' }),
    ];
    const avoids: ChatAvoidLists = { ...emptyAvoids, avoidPatterns: ['Plaid'] };
    const result = buildShortlist(items, avoids, null, null);
    expect(result.map((i) => i.name)).toEqual(['Solid Blazer']);
  });

  it('filters by formality when anchor is set', () => {
    const items = [
      makeItem({ name: 'Casual Hoodie', formality_score: 3 }),
      makeItem({ name: 'Tailored Blazer', formality_score: 8 }),
      makeItem({ name: 'Dress Shirt', formality_score: 7 }),
    ];
    const result = buildShortlist(
      items,
      emptyAvoids,
      null,
      'elevated_business',
    );
    expect(result.map((i) => i.name)).toEqual([
      'Tailored Blazer',
      'Dress Shirt',
    ]);
  });

  it('keeps items without formality_score when anchor is set', () => {
    const items = [
      makeItem({ name: 'Mystery Item', formality_score: undefined }),
      makeItem({ name: 'Low Formality', formality_score: 2 }),
    ];
    const result = buildShortlist(
      items,
      emptyAvoids,
      null,
      'elevated_business',
    );
    expect(result.map((i) => i.name)).toContain('Mystery Item');
    expect(result.map((i) => i.name)).not.toContain('Low Formality');
  });

  it('sorts dark neutrals first', () => {
    const items = [
      makeItem({ name: 'Red Jacket', color: 'red', formality_score: 8 }),
      makeItem({ name: 'Black Blazer', color: 'black', formality_score: 8 }),
      makeItem({ name: 'Navy Coat', color: 'navy', formality_score: 8 }),
    ];
    const result = buildShortlist(items, emptyAvoids, null, null);
    expect(result[0].name).toBe('Black Blazer');
    expect(result[1].name).toBe('Navy Coat');
  });

  it('sorts by formality descending', () => {
    const items = [
      makeItem({ name: 'Low Item', color: 'white', formality_score: 4 }),
      makeItem({ name: 'High Item', color: 'white', formality_score: 9 }),
      makeItem({ name: 'Mid Item', color: 'white', formality_score: 6 }),
    ];
    const result = buildShortlist(items, emptyAvoids, null, null);
    expect(result.map((i) => i.name)).toEqual([
      'High Item',
      'Mid Item',
      'Low Item',
    ]);
  });

  it('limits to max 5 items', () => {
    const items = Array.from({ length: 10 }, (_, i) =>
      makeItem({ name: `Item ${i}`, formality_score: 10 - i }),
    );
    const result = buildShortlist(items, emptyAvoids, null, null);
    expect(result.length).toBe(5);
  });

  it('returns empty array when all items filtered out', () => {
    const items = [makeItem({ name: 'Red Dress', color: 'red' })];
    const avoids: ChatAvoidLists = { ...emptyAvoids, avoidColors: ['red'] };
    const result = buildShortlist(items, avoids, null, null);
    expect(result).toEqual([]);
  });

  it('handles empty items array', () => {
    const result = buildShortlist([], emptyAvoids, null, null);
    expect(result).toEqual([]);
  });

  it('passes all items when no category and no avoids', () => {
    const items = [
      makeItem({ name: 'Item A', main_category: 'Tops' }),
      makeItem({ name: 'Item B', main_category: 'Bottoms' }),
    ];
    const result = buildShortlist(items, emptyAvoids, null, null);
    expect(result.length).toBe(2);
  });
});

// ── formatShortlistForPrompt ──────────────────────────────────────────────

describe('formatShortlistForPrompt', () => {
  it('formats items with numbered list', () => {
    const items = [
      makeItem({ name: 'Black Blazer', color: 'Black', brand: 'Hugo Boss' }),
    ];
    const result = formatShortlistForPrompt(items);
    expect(result).toContain('1.');
    expect(result).toContain('Black');
    expect(result).toContain('Hugo Boss');
  });

  it('includes formality metadata', () => {
    const items = [makeItem({ formality_score: 9 })];
    const result = formatShortlistForPrompt(items);
    expect(result).toContain('formality:9');
  });
});

// ── validateReasoningQuality ──────────────────────────────────────────────

describe('validateReasoningQuality', () => {
  it('passes a clinical structural response with contrast', () => {
    const response =
      'The black blazer widens the shoulder frame, creating vertical proportion and hierarchy. The charcoal saturation controls warmth against your undertone. The navy option lacks this structure compared to the blazer.';
    expect(validateReasoningQuality(response, ['black blazer'])).toBe(true);
  });

  it('fails when no item name referenced', () => {
    const response =
      'This piece widens the shoulder frame with vertical proportion and authority. The other option lacks structure.';
    expect(validateReasoningQuality(response, ['black blazer'])).toBe(false);
  });

  it('fails when fewer than 3 mechanism tokens', () => {
    const response =
      'The black blazer has good structure. The other lacks this quality.';
    expect(validateReasoningQuality(response, ['black blazer'])).toBe(false);
  });

  it('fails a blog-style response', () => {
    const response =
      'The black blazer is a stunning and sophisticated choice that looks gorgeous on you. It pairs beautifully with everything in your wardrobe.';
    expect(validateReasoningQuality(response, ['black blazer'])).toBe(false);
  });

  it('fails when response contains banned words even with mechanism tokens', () => {
    const response =
      'The black blazer creates elegant shoulder proportion and vertical hierarchy with saturation contrast. The other option lacks this authority.';
    expect(validateReasoningQuality(response, ['black blazer'])).toBe(false);
  });

  it('fails when missing contrast clause', () => {
    const response =
      'The black blazer widens the shoulder frame, creating vertical proportion and hierarchy. The charcoal saturation controls warmth and authority.';
    expect(validateReasoningQuality(response, ['black blazer'])).toBe(false);
  });

  it('is case-insensitive for item names and tokens', () => {
    const response =
      'The BLACK BLAZER builds Shoulder width and Vertical proportion with Hierarchy. Saturation anchors Authority. The navy option lacks this Structure.';
    expect(validateReasoningQuality(response, ['black blazer'])).toBe(true);
  });

  it('skips very short item names (<3 chars)', () => {
    const response =
      'The is nice with shoulder vertical waist proportion. Lacks structure.';
    expect(validateReasoningQuality(response, ['is'])).toBe(false);
  });
});

// ── REASONING_CORRECTION constant ─────────────────────────────────────────

describe('REASONING_CORRECTION', () => {
  it('contains structural mechanism reference', () => {
    expect(REASONING_CORRECTION).toContain('structural mechanism');
  });

  it('contains silhouette mechanics reference', () => {
    expect(REASONING_CORRECTION).toContain('silhouette mechanics');
  });

  it('contains contrast instruction', () => {
    expect(REASONING_CORRECTION).toContain('contrast against other shortlist');
  });
});
