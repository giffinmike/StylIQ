import { validateSlotMatch } from './slotCompatibilityValidator';

// Helper to build a minimal candidate
const candidate = (
  overrides: Partial<{
    id: string;
    name: string;
    subcategory: string;
    main_category: string;
    dress_code: string;
    formality_score: number;
  }> = {},
) => ({
  id: overrides.id ?? 'item-1',
  name: overrides.name ?? '',
  subcategory: overrides.subcategory ?? '',
  main_category: overrides.main_category ?? '',
  dress_code: overrides.dress_code ?? '',
  formality_score: overrides.formality_score,
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. BOTTOMS: Trousers rules
// ─────────────────────────────────────────────────────────────────────────────
describe('validateSlotMatch — Bottoms (trousers vs shorts)', () => {
  it('REJECTS shorts for "tailored dark trousers"', () => {
    const result = validateSlotMatch(
      { category: 'bottoms', description: 'tailored dark trousers' },
      candidate({
        name: 'Grey Fleece Drawstring Shorts',
        subcategory: 'Shorts',
      }),
      'smart casual outfit',
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('CATEGORY_MISMATCH');
  });

  it('REJECTS athletic shorts for "dress pants"', () => {
    const result = validateSlotMatch(
      { category: 'bottoms', description: 'navy dress pants' },
      candidate({
        name: 'Nike Running Shorts',
        subcategory: 'Athletic Shorts',
      }),
      'office outfit',
    );
    expect(result.valid).toBe(false);
  });

  it('REJECTS joggers for "formal trousers"', () => {
    const result = validateSlotMatch(
      { category: 'bottoms', description: 'charcoal formal trousers' },
      candidate({ name: 'Black Joggers', subcategory: 'Joggers' }),
      'meeting outfit',
    );
    expect(result.valid).toBe(false);
  });

  it('REJECTS sweatpants for "slacks"', () => {
    const result = validateSlotMatch(
      { category: 'bottoms', description: 'grey slacks' },
      candidate({ name: 'Cozy Sweatpants', subcategory: 'Sweatpants' }),
      'office outfit',
    );
    expect(result.valid).toBe(false);
  });

  it('ACCEPTS chinos for "tailored trousers"', () => {
    const result = validateSlotMatch(
      { category: 'bottoms', description: 'tailored dark trousers' },
      candidate({ name: 'Navy Chino Pants', subcategory: 'Chinos' }),
      'smart casual outfit',
    );
    expect(result.valid).toBe(true);
  });

  it('ACCEPTS dress pants for "dress pants"', () => {
    const result = validateSlotMatch(
      { category: 'bottoms', description: 'navy dress pants' },
      candidate({ name: 'Slim Fit Dress Pants', subcategory: 'Dress Pants' }),
      'office outfit',
    );
    expect(result.valid).toBe(true);
  });

  it('ACCEPTS trousers for "trousers"', () => {
    const result = validateSlotMatch(
      { category: 'bottoms', description: 'dark trousers' },
      candidate({ name: 'Wool Trousers', subcategory: 'Trousers' }),
      'evening outfit',
    );
    expect(result.valid).toBe(true);
  });

  it('ACCEPTS jeans for "jeans"', () => {
    const result = validateSlotMatch(
      { category: 'bottoms', description: 'dark wash jeans' },
      candidate({ name: 'Levi 501 Jeans', subcategory: 'Jeans' }),
      'casual outfit',
    );
    expect(result.valid).toBe(true);
  });

  it('REJECTS shorts for "jeans"', () => {
    const result = validateSlotMatch(
      { category: 'bottoms', description: 'dark wash jeans' },
      candidate({ name: 'Denim Shorts', subcategory: 'Shorts' }),
      'casual outfit',
    );
    expect(result.valid).toBe(false);
  });

  it('passes through items with no matching rule (e.g., generic "bottoms")', () => {
    const result = validateSlotMatch(
      { category: 'bottoms', description: 'casual bottoms' },
      candidate({ name: 'Cargo Shorts', subcategory: 'Shorts' }),
      'beach outfit',
    );
    expect(result.valid).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. SHOES: Dress shoes vs sneakers
// ─────────────────────────────────────────────────────────────────────────────
describe('validateSlotMatch — Shoes (dress shoes vs sneakers)', () => {
  it('REJECTS sneakers for "leather loafers"', () => {
    const result = validateSlotMatch(
      { category: 'shoes', description: 'brown leather loafers' },
      candidate({ name: 'White Nike Sneakers', subcategory: 'Sneakers' }),
      'smart casual outfit',
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('CATEGORY_MISMATCH');
  });

  it('REJECTS athletic sneakers for "oxfords"', () => {
    const result = validateSlotMatch(
      { category: 'shoes', description: 'black oxford shoes' },
      candidate({ name: 'Running Shoes', subcategory: 'Athletic Sneakers' }),
      'formal outfit',
    );
    expect(result.valid).toBe(false);
  });

  it('REJECTS sandals for "dress shoes"', () => {
    const result = validateSlotMatch(
      { category: 'shoes', description: 'polished dress shoes' },
      candidate({ name: 'Birkenstock Sandals', subcategory: 'Sandals' }),
      'business formal',
    );
    expect(result.valid).toBe(false);
  });

  it('ACCEPTS loafers for "loafers"', () => {
    const result = validateSlotMatch(
      { category: 'shoes', description: 'brown leather loafers' },
      candidate({ name: 'Penny Loafers', subcategory: 'Loafers' }),
      'smart casual outfit',
    );
    expect(result.valid).toBe(true);
  });

  it('ACCEPTS oxfords for "dress shoes"', () => {
    const result = validateSlotMatch(
      { category: 'shoes', description: 'classic dress shoes' },
      candidate({ name: 'Black Oxfords', subcategory: 'Oxford' }),
      'formal outfit',
    );
    expect(result.valid).toBe(true);
  });

  it('REJECTS loafers for "sneakers"', () => {
    const result = validateSlotMatch(
      { category: 'shoes', description: 'white sneakers' },
      candidate({ name: 'Brown Loafers', subcategory: 'Loafers' }),
      'casual outfit',
    );
    expect(result.valid).toBe(false);
  });

  it('ACCEPTS sneakers for "sneakers"', () => {
    const result = validateSlotMatch(
      { category: 'shoes', description: 'white sneakers' },
      candidate({ name: 'White Adidas Sneakers', subcategory: 'Sneakers' }),
      'casual outfit',
    );
    expect(result.valid).toBe(true);
  });

  it('ACCEPTS boots for "boots"', () => {
    const result = validateSlotMatch(
      { category: 'shoes', description: 'brown leather boots' },
      candidate({ name: 'Chelsea Boots', subcategory: 'Boots' }),
      'winter outfit',
    );
    expect(result.valid).toBe(true);
  });

  it('REJECTS sandals for "boots"', () => {
    const result = validateSlotMatch(
      { category: 'shoes', description: 'brown leather boots' },
      candidate({ name: 'Leather Sandals', subcategory: 'Sandals' }),
      'winter outfit',
    );
    expect(result.valid).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. OUTERWEAR: Blazer vs hoodie
// ─────────────────────────────────────────────────────────────────────────────
describe('validateSlotMatch — Outerwear (blazer vs hoodie)', () => {
  it('REJECTS hoodie for "navy blazer"', () => {
    const result = validateSlotMatch(
      { category: 'outerwear', description: 'navy blazer' },
      candidate({ name: 'Grey Zip-Up Hoodie', subcategory: 'Hoodie' }),
      'business casual outfit',
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('CATEGORY_MISMATCH');
  });

  it('REJECTS puffer jacket for "sport coat"', () => {
    const result = validateSlotMatch(
      { category: 'outerwear', description: 'charcoal sport coat' },
      candidate({ name: 'North Face Puffer', subcategory: 'Puffer Jacket' }),
      'dinner outfit',
    );
    expect(result.valid).toBe(false);
  });

  it('REJECTS windbreaker for "tailored jacket"', () => {
    const result = validateSlotMatch(
      { category: 'outerwear', description: 'tailored jacket' },
      candidate({
        name: 'Lightweight Windbreaker',
        subcategory: 'Windbreaker',
      }),
      'date night outfit',
    );
    expect(result.valid).toBe(false);
  });

  it('ACCEPTS blazer for "blazer"', () => {
    const result = validateSlotMatch(
      { category: 'outerwear', description: 'navy blazer' },
      candidate({ name: 'Slim Fit Blazer', subcategory: 'Blazer' }),
      'business casual outfit',
    );
    expect(result.valid).toBe(true);
  });

  it('ACCEPTS structured jacket for "blazer"', () => {
    const result = validateSlotMatch(
      { category: 'outerwear', description: 'navy blazer' },
      candidate({
        name: 'Structured Wool Jacket',
        subcategory: 'Structured Jacket',
      }),
      'business casual outfit',
    );
    expect(result.valid).toBe(true);
  });

  it('passes through for generic "jacket" description (no blazer keyword)', () => {
    const result = validateSlotMatch(
      { category: 'outerwear', description: 'warm winter jacket' },
      candidate({ name: 'Puffer Jacket', subcategory: 'Puffer' }),
      'cold weather outfit',
    );
    expect(result.valid).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. TOPS: Dress shirt vs t-shirt
// ─────────────────────────────────────────────────────────────────────────────
describe('validateSlotMatch — Tops (dress shirt vs t-shirt)', () => {
  it('REJECTS t-shirt for "white dress shirt"', () => {
    const result = validateSlotMatch(
      { category: 'tops', description: 'crisp white dress shirt' },
      candidate({ name: 'Plain White T-Shirt', subcategory: 'T-Shirt' }),
      'formal outfit',
    );
    expect(result.valid).toBe(false);
  });

  it('REJECTS hoodie for "button-up shirt"', () => {
    const result = validateSlotMatch(
      { category: 'tops', description: 'light blue button-up shirt' },
      candidate({ name: 'Grey Hoodie', subcategory: 'Hoodie' }),
      'office outfit',
    );
    expect(result.valid).toBe(false);
  });

  it('ACCEPTS button-down for "dress shirt"', () => {
    const result = validateSlotMatch(
      { category: 'tops', description: 'white dress shirt' },
      candidate({
        name: 'Oxford Button-Down',
        subcategory: 'Button-Down Shirt',
      }),
      'formal outfit',
    );
    expect(result.valid).toBe(true);
  });

  it('passes through for generic "top" description', () => {
    const result = validateSlotMatch(
      { category: 'tops', description: 'casual top' },
      candidate({ name: 'Graphic Tee', subcategory: 'T-Shirt' }),
      'weekend outfit',
    );
    expect(result.valid).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Formality Gate
// ─────────────────────────────────────────────────────────────────────────────
describe('validateSlotMatch — Formality Gate', () => {
  it('REJECTS athletic items when slot formality >= 7', () => {
    const result = validateSlotMatch(
      { category: 'tops', description: 'elegant top', formality: 8 },
      candidate({
        name: 'Gym Tank',
        subcategory: 'Athletic Tank',
        dress_code: 'athletic',
      }),
      'evening outfit',
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('FORMALITY_MISMATCH');
  });

  it('ACCEPTS athletic items when slot formality < 7', () => {
    const result = validateSlotMatch(
      { category: 'tops', description: 'workout top', formality: 3 },
      candidate({
        name: 'Gym Tank',
        subcategory: 'Athletic Tank',
        dress_code: 'athletic',
      }),
      'gym outfit',
    );
    expect(result.valid).toBe(true);
  });

  it('ACCEPTS formal items when formality is high', () => {
    const result = validateSlotMatch(
      { category: 'tops', description: 'elegant blouse', formality: 9 },
      candidate({
        name: 'Silk Blouse',
        subcategory: 'Blouse',
        dress_code: 'business formal',
      }),
      'gala outfit',
    );
    expect(result.valid).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Occasion Gate
// ─────────────────────────────────────────────────────────────────────────────
describe('validateSlotMatch — Occasion Gate', () => {
  it('REJECTS shorts for wedding query', () => {
    const result = validateSlotMatch(
      { category: 'bottoms', description: 'elegant pants' },
      candidate({ name: 'Cargo Shorts', subcategory: 'Shorts' }),
      'what to wear to a wedding',
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('OCCASION_MISMATCH');
  });

  it('REJECTS hoodie for church query', () => {
    const result = validateSlotMatch(
      { category: 'tops', description: 'nice top' },
      candidate({ name: 'Zip-Up Hoodie', subcategory: 'Hoodie' }),
      'outfit for church on Sunday',
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('OCCASION_MISMATCH');
  });

  it('REJECTS slides for formal event', () => {
    const result = validateSlotMatch(
      { category: 'shoes', description: 'dressy shoes' },
      candidate({ name: 'Adidas Slides', subcategory: 'Slide Sandals' }),
      'formal dinner outfit',
    );
    expect(result.valid).toBe(false);
  });

  it('ACCEPTS dressy items for formal events', () => {
    const result = validateSlotMatch(
      { category: 'shoes', description: 'dressy shoes' },
      candidate({ name: 'Patent Leather Oxfords', subcategory: 'Oxford' }),
      'formal dinner outfit',
    );
    expect(result.valid).toBe(true);
  });

  it('does not reject casual items for casual queries', () => {
    const result = validateSlotMatch(
      { category: 'bottoms', description: 'comfortable shorts' },
      candidate({ name: 'Khaki Shorts', subcategory: 'Shorts' }),
      'beach day outfit',
    );
    expect(result.valid).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Cross-demographic: no gender/age/culture assumptions
// ─────────────────────────────────────────────────────────────────────────────
describe('validateSlotMatch — Cross-demographic safety', () => {
  it('works for feminine presentation (heels for dress shoes)', () => {
    const result = validateSlotMatch(
      { category: 'shoes', description: 'elegant dress shoes' },
      candidate({ name: 'Black Stiletto Heels', subcategory: 'Heels' }),
      'cocktail party',
    );
    expect(result.valid).toBe(true);
  });

  it('works for masculine presentation (oxfords for dress shoes)', () => {
    const result = validateSlotMatch(
      { category: 'shoes', description: 'classic dress shoes' },
      candidate({ name: 'Cap-Toe Oxfords', subcategory: 'Oxfords' }),
      'business meeting',
    );
    expect(result.valid).toBe(true);
  });

  it('does not assume category for non-matching descriptions', () => {
    const result = validateSlotMatch(
      { category: 'accessories', description: 'statement necklace' },
      candidate({ name: 'Gold Chain Necklace', subcategory: 'Necklace' }),
      'evening outfit',
    );
    expect(result.valid).toBe(true);
  });
});
