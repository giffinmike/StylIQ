import { scoreOutfit, selectTopOutfits, type JudgeOutfit } from './styleJudge';

// ── Helpers ─────────────────────────────────────────────────────────────

function makeOutfit(
  id: string,
  items: Array<{
    id?: string;
    name?: string;
    category?: string;
    subcategory?: string;
    color?: string;
    material?: string;
    formality_score?: number;
    dress_code?: string;
    shoe_style?: string;
  }>,
): JudgeOutfit {
  return {
    id,
    items: items.map((it, i) => ({ id: it.id ?? `item-${i}`, ...it })),
  };
}

// ── Test 1: Blazer + joggers loses to blazer + trousers ─────────────────

describe('Style Judge', () => {
  it('blazer + joggers loses to blazer + trousers', () => {
    const bad = makeOutfit('bad', [
      {
        name: 'Navy Blazer',
        category: 'top',
        subcategory: 'Blazer',
        material: 'wool',
        formality_score: 70,
        dress_code: 'Business',
        color: 'navy',
      },
      {
        name: 'Grey Joggers',
        category: 'bottom',
        subcategory: 'Joggers',
        material: 'fleece',
        formality_score: 15,
        dress_code: 'Casual',
        color: 'grey',
      },
      {
        name: 'Running Sneakers',
        category: 'shoes',
        subcategory: 'Athletic Sneakers',
        material: 'mesh',
        formality_score: 10,
        color: 'white',
      },
    ]);

    const good = makeOutfit('good', [
      {
        name: 'Navy Blazer',
        category: 'top',
        subcategory: 'Blazer',
        material: 'wool',
        formality_score: 70,
        dress_code: 'Business',
        color: 'navy',
      },
      {
        name: 'Charcoal Trousers',
        category: 'bottom',
        subcategory: 'Trousers',
        material: 'wool',
        formality_score: 70,
        dress_code: 'Business',
        color: 'charcoal',
      },
      {
        name: 'Brown Oxford Shoes',
        category: 'shoes',
        subcategory: 'Oxford',
        material: 'leather',
        formality_score: 80,
        dress_code: 'Business',
        color: 'brown',
      },
    ]);

    const badScore = scoreOutfit(bad);
    const goodScore = scoreOutfit(good);

    expect(goodScore.total).toBeGreaterThan(badScore.total);
    expect(badScore.penalties.length).toBeGreaterThan(0);
  });

  // ── Test 2: Dress shirt + sneakers loses to dress shirt + loafers ───────

  it('dress shirt + sneakers loses to dress shirt + loafers', () => {
    const bad = makeOutfit('bad', [
      {
        name: 'White Dress Shirt',
        category: 'top',
        subcategory: 'Dress Shirt',
        material: 'oxford',
        formality_score: 70,
        color: 'white',
      },
      {
        name: 'Navy Chinos',
        category: 'bottom',
        subcategory: 'Chinos',
        material: 'twill',
        formality_score: 55,
        color: 'navy',
      },
      {
        name: 'White Sneakers',
        category: 'shoes',
        subcategory: 'Sneakers',
        material: 'leather',
        formality_score: 30,
        color: 'white',
      },
    ]);

    const good = makeOutfit('good', [
      {
        name: 'White Dress Shirt',
        category: 'top',
        subcategory: 'Dress Shirt',
        material: 'oxford',
        formality_score: 70,
        color: 'white',
      },
      {
        name: 'Navy Chinos',
        category: 'bottom',
        subcategory: 'Chinos',
        material: 'twill',
        formality_score: 55,
        color: 'navy',
      },
      {
        name: 'Brown Loafers',
        category: 'shoes',
        subcategory: 'Loafers',
        material: 'leather',
        formality_score: 65,
        color: 'brown',
      },
    ]);

    const badScore = scoreOutfit(bad);
    const goodScore = scoreOutfit(good);

    expect(goodScore.total).toBeGreaterThan(badScore.total);
  });

  // ── Test 3: Coherent neutral palette beats 5-color outfit ───────────────

  it('coherent neutral palette beats 5-color outfit', () => {
    const fiveColor = makeOutfit('clash', [
      {
        name: 'Red Top',
        category: 'top',
        color: 'red',
        formality_score: 50,
      },
      {
        name: 'Neon Green Pants',
        category: 'bottom',
        color: 'neon green',
        formality_score: 50,
      },
      {
        name: 'Pink Shoes',
        category: 'shoes',
        color: 'pink',
        formality_score: 50,
      },
      {
        name: 'Olive Scarf',
        category: 'accessory',
        color: 'olive',
        formality_score: 50,
      },
      {
        name: 'Teal Jacket',
        category: 'outerwear',
        color: 'teal',
        formality_score: 50,
      },
    ]);

    const neutral = makeOutfit('neutral', [
      {
        name: 'White Shirt',
        category: 'top',
        color: 'white',
        formality_score: 50,
      },
      {
        name: 'Black Trousers',
        category: 'bottom',
        color: 'black',
        formality_score: 50,
      },
      {
        name: 'Navy Shoes',
        category: 'shoes',
        color: 'navy',
        formality_score: 50,
      },
    ]);

    const clashScore = scoreOutfit(fiveColor);
    const neutralScore = scoreOutfit(neutral);

    expect(neutralScore.total).toBeGreaterThan(clashScore.total);
    // Neutral + 1 accent should get a bonus
    expect(neutralScore.bonuses.length).toBeGreaterThan(0);
  });

  // ── Test 4: Athletic mixed into formal is heavily penalized ─────────────

  it('athletic mixed into formal is heavily penalized', () => {
    const mixed = makeOutfit('mixed', [
      {
        name: 'Formal Suit Jacket',
        category: 'top',
        subcategory: 'Suit Jacket',
        material: 'wool',
        formality_score: 85,
        dress_code: 'Business',
        color: 'charcoal',
      },
      {
        name: 'Track Pants',
        category: 'bottom',
        subcategory: 'Track Pants',
        material: 'polyester',
        formality_score: 10,
        dress_code: 'Casual',
        color: 'black',
      },
      {
        name: 'Running Shoes',
        category: 'shoes',
        subcategory: 'Athletic Sneakers',
        material: 'mesh',
        formality_score: 10,
        color: 'neon green',
      },
    ]);

    const result = scoreOutfit(mixed);

    // Should have multiple penalties firing
    expect(result.total).toBeLessThan(60);
    expect(result.penalties.length).toBeGreaterThanOrEqual(2);

    // Verify specific penalty rules fired
    const rules = result.penalties.map((p) => p.rule);
    expect(rules).toContain('formality_coherence');
    expect(rules).toContain('intent_clarity');
  });

  // ── selectTopOutfits picks best 3 ──────────────────────────────────────

  it('selectTopOutfits returns the 3 best-scoring outfits', () => {
    const outfits: JudgeOutfit[] = [
      // Bad: athletic + formal mix
      makeOutfit('o1', [
        {
          name: 'Suit Jacket',
          category: 'top',
          subcategory: 'Suit Jacket',
          material: 'wool',
          formality_score: 85,
          color: 'charcoal',
        },
        {
          name: 'Joggers',
          category: 'bottom',
          subcategory: 'Joggers',
          material: 'fleece',
          formality_score: 10,
          color: 'grey',
        },
        {
          name: 'Athletic Sneakers',
          category: 'shoes',
          material: 'mesh',
          formality_score: 10,
          color: 'white',
        },
      ]),
      // Good: coherent smart casual
      makeOutfit('o2', [
        {
          name: 'Navy Polo',
          category: 'top',
          subcategory: 'Polo',
          material: 'cotton',
          formality_score: 50,
          color: 'navy',
        },
        {
          name: 'Tan Chinos',
          category: 'bottom',
          subcategory: 'Chinos',
          material: 'twill',
          formality_score: 55,
          color: 'tan',
        },
        {
          name: 'Brown Loafers',
          category: 'shoes',
          subcategory: 'Loafers',
          material: 'leather',
          formality_score: 65,
          color: 'brown',
        },
      ]),
      // Good: coherent casual
      makeOutfit('o3', [
        {
          name: 'White T-Shirt',
          category: 'top',
          material: 'cotton',
          formality_score: 30,
          color: 'white',
        },
        {
          name: 'Blue Jeans',
          category: 'bottom',
          material: 'denim',
          formality_score: 30,
          color: 'blue',
        },
        {
          name: 'White Sneakers',
          category: 'shoes',
          material: 'leather',
          formality_score: 30,
          color: 'white',
        },
      ]),
      // Good: coherent formal
      makeOutfit('o4', [
        {
          name: 'White Dress Shirt',
          category: 'top',
          subcategory: 'Dress Shirt',
          material: 'oxford',
          formality_score: 70,
          color: 'white',
        },
        {
          name: 'Charcoal Trousers',
          category: 'bottom',
          subcategory: 'Trousers',
          material: 'wool',
          formality_score: 70,
          color: 'charcoal',
        },
        {
          name: 'Black Oxford Shoes',
          category: 'shoes',
          subcategory: 'Oxford',
          material: 'leather',
          formality_score: 80,
          color: 'black',
        },
      ]),
    ];

    const top3 = selectTopOutfits(outfits, {}, 3);

    expect(top3).toHaveLength(3);
    // The bad mix (o1) should be excluded
    const ids = top3.map((o) => o.id);
    expect(ids).not.toContain('o1');
    expect(ids).toContain('o2');
    expect(ids).toContain('o3');
    expect(ids).toContain('o4');
  });

  // ── Fail-open: missing metadata doesn't penalize ──────────────────────

  it('does not penalize outfits with missing metadata', () => {
    const sparse = makeOutfit('sparse', [
      { name: 'Item A', category: 'top' },
      { name: 'Item B', category: 'bottom' },
      { name: 'Item C', category: 'shoes' },
    ]);

    const result = scoreOutfit(sparse);
    expect(result.total).toBe(100);
    expect(result.penalties).toHaveLength(0);
  });

  // ── Passthrough: <=3 outfits returned unchanged ───────────────────────

  it('returns outfits unchanged when count <= 3', () => {
    const outfits: JudgeOutfit[] = [
      makeOutfit('a', [{ name: 'X', category: 'top' }]),
      makeOutfit('b', [{ name: 'Y', category: 'bottom' }]),
    ];

    const result = selectTopOutfits(outfits);
    expect(result).toEqual(outfits);
  });

  // ── Church: jeans + Hawaiian combo rejected vs dress shirt + trousers ──

  it('church request: jeans + Hawaiian loses to dress shirt + trousers', () => {
    const ctx = { query: 'church outfit for Sunday' };

    const bad = makeOutfit('bad', [
      {
        name: 'Hawaiian Floral Shirt',
        category: 'top',
        subcategory: 'Camp Collar Floral',
        material: 'cotton',
        formality_score: 25,
        color: 'blue',
      },
      {
        name: 'Blue Jeans',
        category: 'bottom',
        subcategory: 'Jeans',
        material: 'denim',
        formality_score: 30,
        color: 'blue',
      },
      {
        name: 'White Sneakers',
        category: 'shoes',
        subcategory: 'Sneakers',
        material: 'leather',
        formality_score: 30,
        color: 'white',
      },
    ]);

    const good = makeOutfit('good', [
      {
        name: 'White Dress Shirt',
        category: 'top',
        subcategory: 'Dress Shirt',
        material: 'oxford',
        formality_score: 70,
        color: 'white',
      },
      {
        name: 'Navy Trousers',
        category: 'bottom',
        subcategory: 'Trousers',
        material: 'wool',
        formality_score: 70,
        color: 'navy',
      },
      {
        name: 'Brown Loafers',
        category: 'shoes',
        subcategory: 'Loafers',
        material: 'leather',
        formality_score: 65,
        color: 'brown',
      },
    ]);

    const badScore = scoreOutfit(bad, ctx);
    const goodScore = scoreOutfit(good, ctx);

    expect(goodScore.total).toBeGreaterThan(badScore.total);
    // Occasion penalty should fire on the bad outfit
    const badRules = badScore.penalties.map((p) => p.rule);
    expect(badRules).toContain('occasion_appropriateness');
  });

  // ── Church: magenta blazer penalized vs navy blazer ────────────────────

  it('church request: magenta blazer loses to navy blazer', () => {
    const ctx = { query: 'outfit for church service' };

    const loud = makeOutfit('loud', [
      {
        name: 'Magenta Blazer',
        category: 'top',
        subcategory: 'Blazer',
        material: 'wool',
        formality_score: 70,
        dress_code: 'Business',
        color: 'magenta',
      },
      {
        name: 'Black Trousers',
        category: 'bottom',
        subcategory: 'Trousers',
        material: 'wool',
        formality_score: 70,
        color: 'black',
      },
      {
        name: 'Black Oxford',
        category: 'shoes',
        subcategory: 'Oxford',
        material: 'leather',
        formality_score: 80,
        color: 'black',
      },
    ]);

    const subdued = makeOutfit('subdued', [
      {
        name: 'Navy Blazer',
        category: 'top',
        subcategory: 'Blazer',
        material: 'wool',
        formality_score: 70,
        dress_code: 'Business',
        color: 'navy',
      },
      {
        name: 'Charcoal Trousers',
        category: 'bottom',
        subcategory: 'Trousers',
        material: 'wool',
        formality_score: 70,
        color: 'charcoal',
      },
      {
        name: 'Brown Oxford',
        category: 'shoes',
        subcategory: 'Oxford',
        material: 'leather',
        formality_score: 80,
        color: 'brown',
      },
    ]);

    const loudScore = scoreOutfit(loud, ctx);
    const subduedScore = scoreOutfit(subdued, ctx);

    expect(subduedScore.total).toBeGreaterThan(loudScore.total);
    const loudRules = loudScore.penalties.map((p) => p.rule);
    expect(loudRules).toContain('occasion_appropriateness');
  });

  // ── Church: selectTopOutfits keeps exactly 3, excludes worst ───────────

  it('church request: selectTopOutfits returns exactly 3 from 5 candidates', () => {
    const ctx = { query: 'what to wear to church' };

    const outfits: JudgeOutfit[] = [
      // Bad: jeans + Hawaiian
      makeOutfit('o1', [
        {
          name: 'Hawaiian Shirt',
          category: 'top',
          subcategory: 'Hawaiian',
          formality_score: 20,
          color: 'red',
        },
        {
          name: 'Jeans',
          category: 'bottom',
          subcategory: 'Jeans',
          formality_score: 30,
          color: 'blue',
        },
        {
          name: 'Sneakers',
          category: 'shoes',
          formality_score: 25,
          color: 'white',
        },
      ]),
      // Bad: magenta blazer
      makeOutfit('o2', [
        {
          name: 'Magenta Blazer',
          category: 'top',
          subcategory: 'Blazer',
          formality_score: 70,
          color: 'magenta',
        },
        {
          name: 'Black Jeans',
          category: 'bottom',
          subcategory: 'Jeans',
          formality_score: 30,
          color: 'black',
        },
        {
          name: 'Black Loafers',
          category: 'shoes',
          subcategory: 'Loafers',
          formality_score: 65,
          color: 'black',
        },
      ]),
      // Good: classic formal
      makeOutfit('o3', [
        {
          name: 'White Dress Shirt',
          category: 'top',
          subcategory: 'Dress Shirt',
          formality_score: 70,
          color: 'white',
        },
        {
          name: 'Navy Trousers',
          category: 'bottom',
          subcategory: 'Trousers',
          formality_score: 70,
          color: 'navy',
        },
        {
          name: 'Brown Oxford',
          category: 'shoes',
          subcategory: 'Oxford',
          formality_score: 80,
          color: 'brown',
        },
      ]),
      // Good: smart casual
      makeOutfit('o4', [
        {
          name: 'Light Blue Shirt',
          category: 'top',
          subcategory: 'Button Down',
          formality_score: 65,
          color: 'light blue',
        },
        {
          name: 'Khaki Chinos',
          category: 'bottom',
          subcategory: 'Chinos',
          formality_score: 55,
          color: 'khaki',
        },
        {
          name: 'Tan Loafers',
          category: 'shoes',
          subcategory: 'Loafers',
          formality_score: 65,
          color: 'tan',
        },
      ]),
      // Good: neutral formal
      makeOutfit('o5', [
        {
          name: 'Navy Blazer',
          category: 'top',
          subcategory: 'Blazer',
          formality_score: 70,
          color: 'navy',
        },
        {
          name: 'Grey Trousers',
          category: 'bottom',
          subcategory: 'Trousers',
          formality_score: 70,
          color: 'grey',
        },
        {
          name: 'Black Loafers',
          category: 'shoes',
          subcategory: 'Loafers',
          formality_score: 70,
          color: 'black',
        },
      ]),
    ];

    const top3 = selectTopOutfits(outfits, ctx, 3);
    expect(top3).toHaveLength(3);

    const ids = top3.map((o) => o.id);
    // The two bad outfits should be excluded
    expect(ids).not.toContain('o1');
    expect(ids).not.toContain('o2');
    // The three good ones should be kept
    expect(ids).toContain('o3');
    expect(ids).toContain('o4');
    expect(ids).toContain('o5');
  });

  // ── Non-church query: jeans are NOT penalized ─────────────────────────

  it('non-church query does not penalize jeans via occasion rule', () => {
    const ctx = { query: 'casual weekend outfit' };

    const jeansOutfit = makeOutfit('jeans', [
      {
        name: 'White T-Shirt',
        category: 'top',
        formality_score: 30,
        color: 'white',
      },
      {
        name: 'Blue Jeans',
        category: 'bottom',
        subcategory: 'Jeans',
        formality_score: 30,
        color: 'blue',
      },
      {
        name: 'White Sneakers',
        category: 'shoes',
        formality_score: 30,
        color: 'white',
      },
    ]);

    const result = scoreOutfit(jeansOutfit, ctx);
    const rules = result.penalties.map((p) => p.rule);
    expect(rules).not.toContain('occasion_appropriateness');
  });
});
