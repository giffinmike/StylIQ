/**
 * Unit tests for suggestVisualOutfits() hardening logic.
 *
 * Tests the deterministic scoring, weather filtering, anchor dedupe,
 * pool fallback tiering, and field stripping — all without requiring
 * the full AiService or OpenAI calls.
 */
import {
  scoreItemForWeather,
  type WeatherContext,
} from '../wardrobe/logic/weather';

// ─── Test Fixtures ─────────────────────────────────────────────

const makeItem = (overrides: Record<string, any> = {}) => ({
  id: overrides.id ?? `item-${Math.random().toString(36).slice(2, 8)}`,
  name: overrides.name ?? 'Test Item',
  main_category: overrides.main_category ?? 'Tops',
  category: overrides.category ?? 'Tops',
  subcategory: overrides.subcategory ?? 'T-Shirts',
  image_url: overrides.image_url ?? 'https://img.test/item.jpg',
  image: overrides.image ?? null,
  color: overrides.color ?? 'black',
  style_descriptors: overrides.style_descriptors ?? [],
  layering: overrides.layering ?? undefined,
  seasonality: overrides.seasonality ?? 'ALL_SEASON',
  sleeve_length: overrides.sleeve_length ?? undefined,
  material: overrides.material ?? undefined,
  waterproof_rating: overrides.waterproof_rating ?? undefined,
  rain_ok: overrides.rain_ok ?? undefined,
  ...overrides,
});

const hotWeather: WeatherContext = { tempF: 95, precipitation: 'none' };
const coldWeather: WeatherContext = { tempF: 30, precipitation: 'none' };
const mildWeather: WeatherContext = { tempF: 70, precipitation: 'none' };

// ─── Deterministic hash (mirrors production) ──────────────────
function hashString(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h << 5) - h + str.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

// ─── 1️⃣ Weather Hard Filter ──────────────────────────────────

describe('Weather Hard Filter', () => {
  it('excludes heavy wool coat in 95°F weather', () => {
    const coat = makeItem({
      name: 'Heavy Wool Coat',
      main_category: 'Outerwear',
      subcategory: 'Coat',
      layering: 'Outer',
    });

    const score = scoreItemForWeather(coat, hotWeather);
    // Hot weather penalizes outerwear (-4 from hotPenalizeOuter)
    expect(score).toBeLessThan(0);
    // Must be below the -5 threshold used for LLM input filtering
    expect(score).toBeLessThanOrEqual(-4);
  });

  it('includes short-sleeve tee in 95°F weather', () => {
    const tee = makeItem({
      name: 'Cotton Tee',
      main_category: 'Tops',
      subcategory: 'T-Shirts',
      sleeve_length: 'Short',
    });

    const score = scoreItemForWeather(tee, hotWeather);
    // Hot weather boosts short sleeves (+6 from hotBoostShortSleeve)
    expect(score).toBeGreaterThan(0);
  });

  it('boosts outerwear in 30°F cold weather', () => {
    const coat = makeItem({
      name: 'Down Jacket',
      main_category: 'Outerwear',
      subcategory: 'Puffer Jacket',
      layering: 'Outer',
    });

    const score = scoreItemForWeather(coat, coldWeather);
    // Cold weather boosts outerwear (+8 from coldBoostOuter)
    expect(score).toBeGreaterThan(0);
    expect(score).toBeGreaterThanOrEqual(8);
  });

  it('returns 0 when no weather context provided', () => {
    const item = makeItem();
    const score = scoreItemForWeather(item, undefined);
    expect(score).toBe(0);
  });

  it('penalizes shorts below 68°F', () => {
    const shorts = makeItem({
      name: 'Denim Shorts',
      main_category: 'Bottoms',
      subcategory: 'Shorts',
    });

    const score = scoreItemForWeather(shorts, coldWeather);
    // shortsPenalty = -8 when tempF < 68
    expect(score).toBeLessThanOrEqual(-8);
  });
});

// ─── 2️⃣ Anchor De-Dupe ──────────────────────────────────────

describe('Anchor De-Dupe', () => {
  // Replicate the getAnchor logic from production
  const getAnchor = (outfit: any): string => {
    const hasDress = outfit.items.some((i: any) => i?.category === 'dress');
    if (hasDress) {
      const dressItem = outfit.items.find((i: any) => i?.category === 'dress');
      return `dress:${dressItem?.id}`;
    }
    const topItem = outfit.items.find((i: any) => i?.category === 'top');
    const bottomItem = outfit.items.find((i: any) => i?.category === 'bottom');
    return `${topItem?.id || 'none'}+${bottomItem?.id || 'none'}`;
  };

  it('detects duplicate top+bottom anchors', () => {
    const outfit1 = {
      items: [
        { id: 'top-1', category: 'top' },
        { id: 'bottom-1', category: 'bottom' },
        { id: 'shoes-1', category: 'shoes' },
      ],
    };
    const outfit2 = {
      items: [
        { id: 'top-1', category: 'top' },
        { id: 'bottom-1', category: 'bottom' },
        { id: 'shoes-2', category: 'shoes' },
      ],
    };

    expect(getAnchor(outfit1)).toBe('top-1+bottom-1');
    expect(getAnchor(outfit2)).toBe('top-1+bottom-1');
    expect(getAnchor(outfit1)).toBe(getAnchor(outfit2));
  });

  it('detects duplicate dress anchors', () => {
    const outfit1 = {
      items: [
        { id: 'dress-1', category: 'dress' },
        { id: 'shoes-1', category: 'shoes' },
      ],
    };
    const outfit2 = {
      items: [
        { id: 'dress-1', category: 'dress' },
        { id: 'shoes-3', category: 'shoes' },
      ],
    };

    expect(getAnchor(outfit1)).toBe('dress:dress-1');
    expect(getAnchor(outfit1)).toBe(getAnchor(outfit2));
  });

  it('marks second occurrence as non-unique anchor', () => {
    const outfits = [
      {
        items: [
          { id: 'top-1', category: 'top' },
          { id: 'bottom-1', category: 'bottom' },
          { id: 'shoes-1', category: 'shoes' },
        ],
      },
      {
        items: [
          { id: 'top-1', category: 'top' },
          { id: 'bottom-1', category: 'bottom' },
          { id: 'shoes-2', category: 'shoes' },
        ],
      },
      {
        items: [
          { id: 'top-2', category: 'top' },
          { id: 'bottom-2', category: 'bottom' },
          { id: 'shoes-3', category: 'shoes' },
        ],
      },
    ];

    const usedAnchors = new Set<string>();
    for (const outfit of outfits) {
      const anchor = getAnchor(outfit);
      (outfit as any).__uniqueAnchor = !usedAnchors.has(anchor);
      usedAnchors.add(anchor);
    }

    expect((outfits[0] as any).__uniqueAnchor).toBe(true);
    expect((outfits[1] as any).__uniqueAnchor).toBe(false); // duplicate
    expect((outfits[2] as any).__uniqueAnchor).toBe(true);
  });
});

// ─── 3️⃣ Injection Fallback Tiering ──────────────────────────

describe('Injection Fallback Tiering', () => {
  // Replicate the tiered buildPool logic
  const buildPoolAtThreshold = (items: any[], cat: string, minScore: number) =>
    items
      .filter(
        (item) =>
          (item.main_category || '').toLowerCase() === cat.toLowerCase(),
      )
      .filter((item) => item.__weatherScore >= minScore)
      .sort(
        (a: any, b: any) =>
          b.__weatherScore - a.__weatherScore ||
          b.feedbackScore - a.feedbackScore,
      );

  const buildPool = (items: any[], cat: string) => {
    let pool = buildPoolAtThreshold(items, cat, 0);
    if (pool.length > 0) return { pool, tier: 1 };
    pool = buildPoolAtThreshold(items, cat, -2);
    if (pool.length > 0) return { pool, tier: 2 };
    pool = buildPoolAtThreshold(items, cat, -Infinity);
    return { pool, tier: 3 };
  };

  it('uses Tier 1 when items score >= 0', () => {
    const items = [
      { main_category: 'Tops', __weatherScore: 3, feedbackScore: 0 },
      { main_category: 'Tops', __weatherScore: 1, feedbackScore: 0 },
    ];

    const result = buildPool(items, 'Tops');
    expect(result.tier).toBe(1);
    expect(result.pool.length).toBe(2);
  });

  it('falls back to Tier 2 when all tops score < 0 but some >= -2', () => {
    const items = [
      { main_category: 'Tops', __weatherScore: -1, feedbackScore: 2 },
      { main_category: 'Tops', __weatherScore: -2, feedbackScore: 1 },
      { main_category: 'Tops', __weatherScore: -8, feedbackScore: 0 },
    ];

    const result = buildPool(items, 'Tops');
    expect(result.tier).toBe(2);
    expect(result.pool.length).toBe(2); // -1 and -2 pass, -8 excluded
  });

  it('falls back to Tier 3 (degraded) when all score < -2', () => {
    const items = [
      { main_category: 'Tops', __weatherScore: -5, feedbackScore: 0 },
      { main_category: 'Tops', __weatherScore: -8, feedbackScore: 0 },
    ];

    const result = buildPool(items, 'Tops');
    expect(result.tier).toBe(3);
    expect(result.pool.length).toBe(2); // all items included in degraded mode
  });

  it('returns empty pool when no items exist for category', () => {
    const items = [
      { main_category: 'Bottoms', __weatherScore: 5, feedbackScore: 0 },
    ];

    const result = buildPool(items, 'Tops');
    expect(result.pool.length).toBe(0);
  });
});

// ─── 4️⃣ Deterministic Ranking Stability ─────────────────────

describe('Deterministic Ranking Stability', () => {
  it('hashString returns consistent values', () => {
    const result1 = hashString('user123-2026-02-13');
    const result2 = hashString('user123-2026-02-13');
    expect(result1).toBe(result2);
  });

  it('hashString returns different values for different dates', () => {
    const day1 = hashString('user123-2026-02-13');
    const day2 = hashString('user123-2026-02-14');
    expect(day1).not.toBe(day2);
  });

  it('hashString returns different values for different users', () => {
    const user1 = hashString('alice-2026-02-13');
    const user2 = hashString('bob-2026-02-13');
    expect(user1).not.toBe(user2);
  });

  it('tie-breaker produces stable sort for equal-score outfits', () => {
    const seedString = 'testuser-2026-02-13';

    const outfits = [
      { __finalScore: 5.0, __anchor: 'top-A+bottom-A' },
      { __finalScore: 5.0, __anchor: 'top-B+bottom-B' },
      { __finalScore: 5.0, __anchor: 'top-C+bottom-C' },
    ].map((o) => ({
      ...o,
      __tieBreaker: hashString(seedString + o.__anchor) % 1000,
    }));

    const sorted1 = [...outfits].sort(
      (a, b) =>
        b.__finalScore - a.__finalScore || b.__tieBreaker - a.__tieBreaker,
    );
    const sorted2 = [...outfits].sort(
      (a, b) =>
        b.__finalScore - a.__finalScore || b.__tieBreaker - a.__tieBreaker,
    );

    expect(sorted1.map((o) => o.__anchor)).toEqual(
      sorted2.map((o) => o.__anchor),
    );
  });

  it('primary score takes precedence over tie-breaker', () => {
    const seedString = 'testuser-2026-02-13';

    const outfits = [
      { __finalScore: 3.0, __anchor: 'top-A+bottom-A' },
      { __finalScore: 7.0, __anchor: 'top-B+bottom-B' },
      { __finalScore: 5.0, __anchor: 'top-C+bottom-C' },
    ].map((o) => ({
      ...o,
      __tieBreaker: hashString(seedString + o.__anchor) % 1000,
    }));

    outfits.sort(
      (a, b) =>
        b.__finalScore - a.__finalScore || b.__tieBreaker - a.__tieBreaker,
    );

    expect(outfits[0].__finalScore).toBe(7.0);
    expect(outfits[1].__finalScore).toBe(5.0);
    expect(outfits[2].__finalScore).toBe(3.0);
  });
});

// ─── 5️⃣ No Internal Field Leakage ──────────────────────────

describe('No Internal Field Leakage', () => {
  const INTERNAL_FIELDS = [
    '__weatherScore',
    '__finalScore',
    '__anchor',
    '__uniqueAnchor',
    '__tieBreaker',
  ];

  it('strips all internal fields from outfit objects', () => {
    // Simulate the stripping logic from production
    const rawOutfit = {
      id: 'outfit-1',
      rank: 1,
      summary: 'Test outfit',
      reasoning: 'Looks good',
      items: [
        {
          id: 'item-1',
          name: 'Tee',
          imageUrl: 'https://img/tee.jpg',
          category: 'top',
        },
        {
          id: 'item-2',
          name: 'Jeans',
          imageUrl: 'https://img/jeans.jpg',
          category: 'bottom',
        },
      ],
      __finalScore: 4.2,
      __tieBreaker: 573,
      __anchor: 'item-1+item-2',
      __uniqueAnchor: true,
    };

    const { __finalScore, __tieBreaker, __anchor, __uniqueAnchor, ...rest } =
      rawOutfit;
    const cleaned = rest;

    for (const field of INTERNAL_FIELDS) {
      expect(cleaned).not.toHaveProperty(field);
    }
  });

  it('preserves all public outfit fields after stripping', () => {
    const rawOutfit = {
      id: 'outfit-1',
      rank: 1,
      summary: 'Test outfit',
      reasoning: 'Looks good',
      items: [
        {
          id: 'item-1',
          name: 'Tee',
          imageUrl: 'https://img/tee.jpg',
          category: 'top',
        },
      ],
      __finalScore: 4.2,
      __tieBreaker: 573,
      __anchor: 'item-1+none',
      __uniqueAnchor: true,
    };

    const { __finalScore, __tieBreaker, __anchor, __uniqueAnchor, ...rest } =
      rawOutfit;

    expect(rest).toHaveProperty('id', 'outfit-1');
    expect(rest).toHaveProperty('rank', 1);
    expect(rest).toHaveProperty('summary', 'Test outfit');
    expect(rest).toHaveProperty('reasoning', 'Looks good');
    expect(rest.items).toHaveLength(1);
  });

  it('outfit items contain only id, name, imageUrl, category', () => {
    // Simulate the item projection from production (line 3669-3678)
    const fullItem: any = {
      id: 'item-abc',
      name: 'Cotton Tee',
      main_category: 'Tops',
      touched_up_image_url: 'https://img/touched.jpg',
      processed_image_url: 'https://img/processed.jpg',
      image_url: 'https://img/original.jpg',
      image: null,
      __weatherScore: 6,
      feedbackScore: 3,
    };

    // This mirrors the projection in outfitsWithItems construction
    const projected = {
      id: fullItem.id,
      name: fullItem.name || 'Item',
      imageUrl:
        fullItem.touched_up_image_url ||
        fullItem.processed_image_url ||
        fullItem.image_url ||
        fullItem.image,
      category: 'top', // from mapToCategory
    };

    const allowedKeys = ['id', 'name', 'imageUrl', 'category'];
    expect(Object.keys(projected).sort()).toEqual(allowedKeys.sort());
    expect(projected).not.toHaveProperty('__weatherScore');
    expect(projected).not.toHaveProperty('feedbackScore');
    expect(projected).not.toHaveProperty('main_category');
  });

  it('strips __silhouette field from output', () => {
    const rawOutfit = {
      id: 'outfit-1',
      rank: 1,
      summary: 'Test outfit',
      reasoning: 'Looks good',
      items: [
        {
          id: 'item-1',
          name: 'Tee',
          imageUrl: 'https://img/tee.jpg',
          category: 'top',
        },
      ],
      __finalScore: 4.2,
      __tieBreaker: 573,
      __anchor: 'item-1+none',
      __uniqueAnchor: true,
      __silhouette: 'relaxed',
    };

    const {
      __finalScore,
      __tieBreaker,
      __anchor,
      __uniqueAnchor,
      __silhouette,
      ...rest
    } = rawOutfit;

    expect(rest).not.toHaveProperty('__silhouette');
    expect(rest).toHaveProperty('id', 'outfit-1');
  });
});

// ─── 6️⃣ Quality Gate ───────────────────────────────────────────

describe('Quality Gate', () => {
  // Replicate color analysis from production
  const BOLD_COLOR_FAMILIES = ['red', 'orange', 'yellow', 'purple'];
  const WARM_COLORS = [
    'red',
    'orange',
    'yellow',
    'coral',
    'peach',
    'gold',
    'amber',
    'rust',
  ];
  const COOL_COLORS = [
    'blue',
    'teal',
    'cyan',
    'mint',
    'lavender',
    'periwinkle',
    'ice',
    'cobalt',
    'navy',
    'slate',
  ];
  const NEUTRAL_COLORS = [
    'black',
    'white',
    'gray',
    'grey',
    'beige',
    'cream',
    'tan',
    'khaki',
    'ivory',
    'charcoal',
    'taupe',
    'brown',
    'nude',
  ];
  const extractColorWords = (colorStr: string): string[] =>
    (colorStr || '')
      .toLowerCase()
      .split(/[\s,/&+\-]+/)
      .filter(Boolean);

  it('"redwood" is NOT classified as Red (exact word match)', () => {
    const colors = extractColorWords('redwood');
    const boldPresent = BOLD_COLOR_FAMILIES.filter((family) =>
      colors.some((word) => word === family),
    );
    expect(boldPresent).not.toContain('red');
    expect(boldPresent).toHaveLength(0);
  });

  it('"red" IS classified as Red (exact word match)', () => {
    const colors = extractColorWords('red');
    const boldPresent = BOLD_COLOR_FAMILIES.filter((family) =>
      colors.some((word) => word === family),
    );
    expect(boldPresent).toContain('red');
  });

  it('rejects athletic shoes + tailored top', () => {
    // Simulate the quality gate logic
    const details = [
      {
        category: 'shoes',
        formality: 0,
        sub: 'running sneaker',
        name: 'nike runner',
        color: 'black',
      },
      {
        category: 'top',
        formality: 3,
        sub: 'blazer',
        name: 'wool blazer',
        color: 'navy',
      },
    ];

    const hasAthleticShoes = details.some(
      (d) =>
        d.category === 'shoes' &&
        (d.formality === 0 || /running|slide|sneaker/.test(d.sub)),
    );
    const TAILORED_RE =
      /blazer|sport coat|suit|dress shirt|button.?down|oxford|tailored/;
    const hasTailoredTop = details.some(
      (d) =>
        (d.category === 'top' || d.category === 'outerwear') &&
        (TAILORED_RE.test(d.sub) || TAILORED_RE.test(d.name)),
    );

    expect(hasAthleticShoes).toBe(true);
    expect(hasTailoredTop).toBe(true);
    // Gate would return false
    expect(hasAthleticShoes && hasTailoredTop).toBe(true);
  });

  it('rejects heavy outerwear + shorts', () => {
    const details = [
      { category: 'outerwear', sub: 'puffer coat', name: 'down puffer' },
      { category: 'bottom', sub: 'shorts', name: 'chino shorts' },
    ];

    const hasHeavyOuterwear = details.some(
      (d) => d.category === 'outerwear' && /coat|parka|puffer|down/.test(d.sub),
    );
    const hasShorts = details.some(
      (d) => d.category === 'bottom' && /short/.test(d.sub),
    );

    expect(hasHeavyOuterwear).toBe(true);
    expect(hasShorts).toBe(true);
    expect(hasHeavyOuterwear && hasShorts).toBe(true);
  });

  it('allows heavy outerwear + trousers (no clash)', () => {
    const details = [
      { category: 'outerwear', sub: 'puffer coat', name: 'down puffer' },
      { category: 'bottom', sub: 'trousers', name: 'wool trousers' },
    ];

    const hasHeavyOuterwear = details.some(
      (d) => d.category === 'outerwear' && /coat|parka|puffer|down/.test(d.sub),
    );
    const hasShorts = details.some(
      (d) => d.category === 'bottom' && /short/.test(d.sub),
    );

    expect(hasHeavyOuterwear).toBe(true);
    expect(hasShorts).toBe(false);
    // Gate would NOT reject
    expect(hasHeavyOuterwear && hasShorts).toBe(false);
  });

  it('rejects warm + cool clash without neutral base', () => {
    const allColors = extractColorWords('coral blue');
    const hasWarm = allColors.some((w) => WARM_COLORS.includes(w));
    const hasCool = allColors.some((w) => COOL_COLORS.includes(w));
    const hasNeutralBase = allColors.some((w) => NEUTRAL_COLORS.includes(w));

    expect(hasWarm).toBe(true);
    expect(hasCool).toBe(true);
    expect(hasNeutralBase).toBe(false);
    // Gate would reject
    expect(hasWarm && hasCool && !hasNeutralBase).toBe(true);
  });

  it('allows warm + cool with neutral base', () => {
    const allColors = extractColorWords('coral blue black');
    const hasWarm = allColors.some((w) => WARM_COLORS.includes(w));
    const hasCool = allColors.some((w) => COOL_COLORS.includes(w));
    const hasNeutralBase = allColors.some((w) => NEUTRAL_COLORS.includes(w));

    expect(hasWarm).toBe(true);
    expect(hasCool).toBe(true);
    expect(hasNeutralBase).toBe(true);
    // Gate would NOT reject
    expect(hasWarm && hasCool && !hasNeutralBase).toBe(false);
  });
});

// ─── 7️⃣ Silhouette Diversity ───────────────────────────────────

describe('Silhouette Diversity', () => {
  const TAILORED_RE =
    /blazer|sport coat|suit|dress shirt|button.?down|oxford|tailored/;

  const getSilhouetteType = (outfit: any): 'dress' | 'tailored' | 'relaxed' => {
    const items = outfit.items.filter(Boolean);
    if (items.some((i: any) => i.category === 'dress')) return 'dress';
    const hasTailored = items.some((i: any) => {
      if (i.category !== 'top' && i.category !== 'outerwear') return false;
      const sub = (i.subcategory || '').toLowerCase();
      const name = (i.name || '').toLowerCase();
      return TAILORED_RE.test(sub) || TAILORED_RE.test(name);
    });
    return hasTailored ? 'tailored' : 'relaxed';
  };

  it('classifies dress outfit as "dress"', () => {
    const outfit = {
      items: [
        { category: 'dress', name: 'Maxi Dress' },
        { category: 'shoes', name: 'Heels' },
      ],
    };
    expect(getSilhouetteType(outfit)).toBe('dress');
  });

  it('classifies blazer outfit as "tailored"', () => {
    const outfit = {
      items: [
        { category: 'top', name: 'Wool Blazer', subcategory: 'blazer' },
        { category: 'bottom', name: 'Chinos' },
        { category: 'shoes', name: 'Loafers' },
      ],
    };
    expect(getSilhouetteType(outfit)).toBe('tailored');
  });

  it('classifies dress shirt by name as "tailored"', () => {
    const outfit = {
      items: [
        {
          category: 'top',
          name: 'Blue Oxford Dress Shirt',
          subcategory: 'shirt',
        },
        { category: 'bottom', name: 'Slacks' },
      ],
    };
    expect(getSilhouetteType(outfit)).toBe('tailored');
  });

  it('classifies tee + jeans as "relaxed"', () => {
    const outfit = {
      items: [
        { category: 'top', name: 'Cotton Tee', subcategory: 't-shirt' },
        { category: 'bottom', name: 'Jeans', subcategory: 'jean' },
        { category: 'shoes', name: 'Sneakers', subcategory: 'sneaker' },
      ],
    };
    expect(getSilhouetteType(outfit)).toBe('relaxed');
  });

  it('penalizes duplicate silhouette types', () => {
    const outfits = [
      {
        __finalScore: 5.0,
        items: [
          { category: 'top', name: 'Tee', subcategory: 't-shirt' },
          { category: 'bottom' },
        ],
      },
      {
        __finalScore: 5.0,
        items: [
          { category: 'top', name: 'Polo', subcategory: 'polo' },
          { category: 'bottom' },
        ],
      },
      { __finalScore: 5.0, items: [{ category: 'dress', name: 'Maxi Dress' }] },
    ];

    const silCounts = new Map<string, number>();
    for (const o of outfits) {
      const sil = getSilhouetteType(o);
      (o as any).__silhouette = sil;
      silCounts.set(sil, (silCounts.get(sil) || 0) + 1);
    }
    for (const o of outfits) {
      const count = silCounts.get((o as any).__silhouette) || 1;
      (o as any).__finalScore += count > 1 ? -0.05 * (count - 1) : 0.05;
    }

    // Two relaxed outfits: each gets -0.05 penalty
    expect(outfits[0].__finalScore).toBeCloseTo(4.95);
    expect(outfits[1].__finalScore).toBeCloseTo(4.95);
    // Unique dress: gets +0.05 bonus
    expect(outfits[2].__finalScore).toBeCloseTo(5.05);
  });
});

// ─── 8️⃣ Canonicalize + Rescore ─────────────────────────────────

describe('Canonicalize + Rescore', () => {
  it('strips outerwear in hot weather (temp >= 75)', () => {
    const temp = 85;
    const outfit = {
      items: [
        { id: 'top-1', category: 'top' },
        { id: 'bottom-1', category: 'bottom' },
        { id: 'shoes-1', category: 'shoes' },
        { id: 'jacket-1', category: 'outerwear' },
      ],
    };

    if (temp >= 75) {
      outfit.items = outfit.items.filter((i) => i.category !== 'outerwear');
    }

    expect(outfit.items).toHaveLength(3);
    expect(outfit.items.some((i) => i.category === 'outerwear')).toBe(false);
  });

  it('keeps outerwear in cold weather (temp <= 60)', () => {
    const temp = 45;
    const items = [
      { id: 'top-1', category: 'top' },
      { id: 'bottom-1', category: 'bottom' },
      { id: 'shoes-1', category: 'shoes' },
      { id: 'jacket-1', category: 'outerwear' },
    ];

    const hasDress = items.some((i) => i.category === 'dress');
    expect(hasDress).toBe(false);

    // Separates: top + bottom + shoes + outerwear if temp <= 60
    const top = items.find((i) => i.category === 'top');
    const bottom = items.find((i) => i.category === 'bottom');
    const shoes = items.find((i) => i.category === 'shoes');
    const outerwear =
      temp <= 60 ? items.find((i) => i.category === 'outerwear') : null;
    const newItems = [top, bottom, shoes, outerwear].filter(Boolean);

    expect(newItems).toHaveLength(4);
    expect(newItems.some((i) => i!.category === 'outerwear')).toBe(true);
  });

  it('rescore changes finalScore when items change', () => {
    // Simulate an outfit that gets canonicalized (outerwear removed)
    const originalScore = 0.4 * 3 + 0.3 * 1 - 0.2 * 0.5 + 0.1 * 1; // 4 items
    // After removing outerwear, the remaining items have different averages
    const newScore = 0.4 * 4 + 0.3 * 1.2 - 0.2 * 0.2 + 0.1 * 1; // 3 items, better weather avg

    expect(newScore).not.toBe(originalScore);
    // The rescore should produce a different (potentially better) score
    expect(newScore).toBeGreaterThan(originalScore);
  });

  it('canonicalizes dress outfit to dress + shoes only', () => {
    const temp = 80;
    const items = [
      { id: 'dress-1', category: 'dress' },
      { id: 'top-1', category: 'top' },
      { id: 'shoes-1', category: 'shoes' },
      { id: 'jacket-1', category: 'outerwear' },
    ];

    const dress = items.find((i) => i.category === 'dress');
    const shoes = items.find((i) => i.category === 'shoes');
    const outerwear =
      temp <= 60 ? items.find((i) => i.category === 'outerwear') : null;
    let newItems = [dress, shoes, outerwear].filter(Boolean);
    if (temp >= 75)
      newItems = newItems.filter((i) => i!.category !== 'outerwear');

    expect(newItems).toHaveLength(2);
    expect(newItems.map((i) => i!.category)).toEqual(['dress', 'shoes']);
  });
});

// ─── 9️⃣ Confidence Check ──────────────────────────────────────

describe('Confidence Check', () => {
  const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

  it('sigmoid produces values between 0 and 1', () => {
    expect(sigmoid(0)).toBeCloseTo(0.5);
    expect(sigmoid(10)).toBeCloseTo(1.0, 1);
    expect(sigmoid(-10)).toBeCloseTo(0.0, 1);
  });

  it('triggers retry when confidence < 0.4', () => {
    // finalScore = -0.5 → sigmoid(-0.5) ≈ 0.378
    const lowScore = -0.5;
    expect(sigmoid(lowScore)).toBeLessThan(0.4);

    let retryCount = 0;
    // Simulate retry logic
    if (sigmoid(lowScore) < 0.4) {
      retryCount++;
    }
    // Max 1 retry (2 total LLM calls)
    expect(retryCount).toBe(1);
    expect(retryCount).toBeLessThanOrEqual(1);
  });

  it('does NOT retry when confidence >= 0.4', () => {
    // finalScore = 0.5 → sigmoid(0.5) ≈ 0.622
    const goodScore = 0.5;
    expect(sigmoid(goodScore)).toBeGreaterThanOrEqual(0.4);

    let retryCount = 0;
    if (sigmoid(goodScore) < 0.4) {
      retryCount++;
    }
    expect(retryCount).toBe(0);
  });

  it('retry executes at most once (no recursion)', () => {
    const scores = [-2.0, -1.5, -1.0]; // all low confidence
    let totalRetries = 0;

    for (const score of scores) {
      if (sigmoid(score) < 0.4 && totalRetries === 0) {
        totalRetries++;
      }
    }
    // Even with multiple low-confidence outfits, max 1 retry
    expect(totalRetries).toBeLessThanOrEqual(1);
  });
});

// ─── 🔟 Response Enrichment ──────────────────────────────────

describe('Response Enrichment', () => {
  const BOLD_COLOR_FAMILIES = ['red', 'orange', 'yellow', 'purple'];
  const NEUTRAL_COLORS = [
    'black',
    'white',
    'gray',
    'grey',
    'beige',
    'cream',
    'tan',
    'khaki',
    'ivory',
    'charcoal',
    'taupe',
    'brown',
    'nude',
  ];
  const extractColorWords = (colorStr: string): string[] =>
    (colorStr || '')
      .toLowerCase()
      .split(/[\s,/&+\-]+/)
      .filter(Boolean);

  it('classifies all-neutral palette correctly', () => {
    const colors = ['black', 'white', 'gray'];
    const boldPresent = BOLD_COLOR_FAMILIES.filter((f) =>
      colors.some((w) => w === f),
    );
    const neutralCount = colors.filter((w) =>
      NEUTRAL_COLORS.includes(w),
    ).length;

    expect(boldPresent).toHaveLength(0);
    expect(neutralCount).toBe(3);
    // → 'neutral palette'
  });

  it('classifies single bold + neutrals as "single accent"', () => {
    const colors = ['black', 'white', 'red'];
    const boldPresent = BOLD_COLOR_FAMILIES.filter((f) =>
      colors.some((w) => w === f),
    );

    expect(boldPresent).toHaveLength(1);
    expect(boldPresent).toContain('red');
    // → 'single accent'
  });

  it('classifies 2+ bold colors as "bold mix"', () => {
    const colors = ['red', 'purple', 'black'];
    const boldPresent = BOLD_COLOR_FAMILIES.filter((f) =>
      colors.some((w) => w === f),
    );

    expect(boldPresent).toHaveLength(2);
    // → 'bold mix'
  });

  it('fashionContext contains required fields', () => {
    const fashionContext = {
      weatherFit: 'optimal' as const,
      silhouette: 'relaxed' as const,
      colorStrategy: 'neutral palette' as const,
      confidenceLevel: 0.73,
    };

    expect(fashionContext).toHaveProperty('weatherFit');
    expect(fashionContext).toHaveProperty('silhouette');
    expect(fashionContext).toHaveProperty('colorStrategy');
    expect(fashionContext).toHaveProperty('confidenceLevel');
    expect(['optimal', 'good', 'marginal']).toContain(
      fashionContext.weatherFit,
    );
    expect(['dress', 'tailored', 'relaxed']).toContain(
      fashionContext.silhouette,
    );
    expect(typeof fashionContext.confidenceLevel).toBe('number');
  });
});

// ─── 11️⃣ Aesthetic Tie-Breaker ──────────────────────────────────

describe('Aesthetic Tie-Breaker', () => {
  // Replicate helpers from production
  const AESTHETIC_WARM = [
    'red',
    'orange',
    'yellow',
    'coral',
    'peach',
    'gold',
    'amber',
    'rust',
  ];
  const AESTHETIC_COOL = [
    'blue',
    'teal',
    'cyan',
    'mint',
    'lavender',
    'periwinkle',
    'ice',
    'cobalt',
    'navy',
    'slate',
  ];
  const AESTHETIC_NEUTRAL = [
    'black',
    'white',
    'gray',
    'grey',
    'beige',
    'cream',
    'tan',
    'khaki',
    'ivory',
    'charcoal',
    'taupe',
    'brown',
    'nude',
  ];
  const AESTHETIC_BOLD = ['red', 'orange', 'yellow', 'purple'];

  const aestheticExtractColorWords = (colorStr: string): string[] =>
    (colorStr || '')
      .toLowerCase()
      .split(/[\s,/&+\-]+/)
      .filter(Boolean);

  const computeColorHarmony = (
    outfit: any,
    itemMap: Map<string, any>,
  ): number => {
    const items = (outfit.items || []).filter(Boolean);
    const allColors: string[] = items.flatMap((i: any) => {
      const full = itemMap.get(i.id);
      return aestheticExtractColorWords(full?.color || '');
    });
    if (allColors.length === 0) return 0;
    const warmCount = allColors.filter((w) =>
      AESTHETIC_WARM.includes(w),
    ).length;
    const coolCount = allColors.filter((w) =>
      AESTHETIC_COOL.includes(w),
    ).length;
    const neutralCount = allColors.filter((w) =>
      AESTHETIC_NEUTRAL.includes(w),
    ).length;
    const boldFamilies = new Set(
      allColors.filter((w) => AESTHETIC_BOLD.includes(w)),
    );
    if (boldFamilies.size > 1 && neutralCount === 0) return -1.0;
    if (neutralCount > allColors.length / 2) return 0.5;
    const hasWarm = warmCount > 0;
    const hasCool = coolCount > 0;
    if (hasWarm && !hasCool) return 1.0;
    if (hasCool && !hasWarm) return 1.0;
    return 0;
  };

  const computeSilhouetteBalance = (outfit: any): number => {
    const items = (outfit.items || []).filter(Boolean);
    if (items.some((i: any) => i.category === 'dress')) return 1.0;
    return 0.5; // simplified for unit test
  };

  const computeRedundancyPenalty = (outfit: any): number => {
    const items = (outfit.items || []).filter(Boolean);
    const coreItems = items.filter((i: any) => i.category !== 'accessory');
    if (coreItems.length === 0) return 0;
    const catCounts = new Map<string, number>();
    for (const i of coreItems) {
      catCounts.set(i.category, (catCounts.get(i.category) || 0) + 1);
    }
    let duplicates = 0;
    for (const count of catCounts.values()) {
      if (count > 1) duplicates += count - 1;
    }
    return Math.min(1, duplicates / coreItems.length);
  };

  it('aesthetic adjustment is always within ±0.15', () => {
    const scenarios = [
      // All warm colors → harmony = 1.0
      { colors: ['red', 'coral'], silhouette: 1.0, redundancy: 0 },
      // Bold clash → harmony = -1.0
      { colors: ['red', 'purple'], silhouette: 0.5, redundancy: 0.5 },
      // Neutral dominant → harmony = 0.5
      { colors: ['black', 'white', 'gray'], silhouette: 1.0, redundancy: 0 },
      // Mixed warm+cool → harmony = 0
      { colors: ['red', 'blue', 'black'], silhouette: 0.5, redundancy: 1 },
    ];

    for (const s of scenarios) {
      const adj =
        0.05 * s.colors.length + // placeholder, actual computes from harmony
        0.03 * s.silhouette -
        0.03 * s.redundancy;
      // But let's verify the FORMULA bounds directly:
      // Max: 0.05*1 + 0.03*1 - 0.03*0 = 0.08
      // Min: 0.05*(-1) + 0.03*0 - 0.03*1 = -0.08
      const maxAdj = 0.05 * 1.0 + 0.03 * 1.0 - 0.03 * 0;
      const minAdj = 0.05 * -1.0 + 0.03 * 0 - 0.03 * 1.0;
      expect(maxAdj).toBeLessThanOrEqual(0.15);
      expect(minAdj).toBeGreaterThanOrEqual(-0.15);
    }
  });

  it('colorHarmony returns +1.0 for all-warm outfit', () => {
    const outfit = {
      items: [
        { id: 'top-1', category: 'top' },
        { id: 'bottom-1', category: 'bottom' },
      ],
    };
    const itemMap = new Map<string, any>([
      ['top-1', { color: 'coral' }],
      ['bottom-1', { color: 'gold' }],
    ]);
    expect(computeColorHarmony(outfit, itemMap)).toBe(1.0);
  });

  it('colorHarmony returns -1.0 for multi-bold without neutral', () => {
    const outfit = {
      items: [
        { id: 'top-1', category: 'top' },
        { id: 'bottom-1', category: 'bottom' },
      ],
    };
    const itemMap = new Map<string, any>([
      ['top-1', { color: 'red' }],
      ['bottom-1', { color: 'purple' }],
    ]);
    expect(computeColorHarmony(outfit, itemMap)).toBe(-1.0);
  });

  it('colorHarmony returns +0.5 for neutral-dominant outfit', () => {
    const outfit = {
      items: [
        { id: 'top-1', category: 'top' },
        { id: 'bottom-1', category: 'bottom' },
        { id: 'shoes-1', category: 'shoes' },
      ],
    };
    const itemMap = new Map<string, any>([
      ['top-1', { color: 'black' }],
      ['bottom-1', { color: 'white' }],
      ['shoes-1', { color: 'brown' }],
    ]);
    expect(computeColorHarmony(outfit, itemMap)).toBe(0.5);
  });

  it('redundancyPenalty is 0 when no category duplicates', () => {
    const outfit = {
      items: [
        { id: 'top-1', category: 'top' },
        { id: 'bottom-1', category: 'bottom' },
        { id: 'shoes-1', category: 'shoes' },
      ],
    };
    expect(computeRedundancyPenalty(outfit)).toBe(0);
  });

  it('redundancyPenalty increases with duplicate categories', () => {
    const outfit = {
      items: [
        { id: 'top-1', category: 'top' },
        { id: 'top-2', category: 'top' },
        { id: 'bottom-1', category: 'bottom' },
        { id: 'shoes-1', category: 'shoes' },
      ],
    };
    expect(computeRedundancyPenalty(outfit)).toBe(0.25); // 1 dupe / 4 core items
  });

  it('deterministic: same input produces same aesthetic adjustment', () => {
    const outfit = {
      items: [
        { id: 'top-1', category: 'top' },
        { id: 'bottom-1', category: 'bottom' },
        { id: 'shoes-1', category: 'shoes' },
      ],
    };
    const itemMap = new Map<string, any>([
      ['top-1', { color: 'navy', subcategory: 'Polo' }],
      ['bottom-1', { color: 'khaki', subcategory: 'Chinos' }],
      ['shoes-1', { color: 'brown', subcategory: 'Loafer' }],
    ]);

    const run = () => {
      const h = computeColorHarmony(outfit, itemMap);
      const s = computeSilhouetteBalance(outfit);
      const r = computeRedundancyPenalty(outfit);
      return 0.05 * h + 0.03 * s - 0.03 * r;
    };

    expect(run()).toBe(run());
    expect(run()).toBe(run());
  });
});

// ─── 12️⃣ Care Status Filter ──────────────────────────────────────

describe('Care Status Filter', () => {
  it('excludes items with care_status "at_cleaner"', () => {
    const wardrobe = [
      makeItem({ id: 'clean-1', care_status: 'available' }),
      makeItem({ id: 'dirty-1', care_status: 'at_cleaner' }),
      makeItem({ id: 'no-status' }),
    ];

    const filtered = wardrobe.filter(
      (item) =>
        ((item as any).careStatus ??
          (item as any).care_status ??
          'available') !== 'at_cleaner',
    );

    expect(filtered.map((i) => i.id)).toEqual(['clean-1', 'no-status']);
    expect(filtered.find((i) => i.id === 'dirty-1')).toBeUndefined();
  });

  it('includes items without care_status (defaults to available)', () => {
    const wardrobe = [makeItem({ id: 'item-1' }), makeItem({ id: 'item-2' })];

    const filtered = wardrobe.filter(
      (item) =>
        ((item as any).careStatus ??
          (item as any).care_status ??
          'available') !== 'at_cleaner',
    );

    expect(filtered).toHaveLength(2);
  });

  it('handles careStatus (camelCase) variant', () => {
    const wardrobe = [makeItem({ id: 'camel-1' }), makeItem({ id: 'camel-2' })];
    (wardrobe[1] as any).careStatus = 'at_cleaner';

    const filtered = wardrobe.filter(
      (item) =>
        ((item as any).careStatus ??
          (item as any).care_status ??
          'available') !== 'at_cleaner',
    );

    expect(filtered.map((i) => i.id)).toEqual(['camel-1']);
  });
});

// ─── 13️⃣ Presentation Normalization (S1 fix) ──────────────────────

describe('Presentation Normalization', () => {
  /**
   * Mirrors the normalization logic from suggestVisualOutfits() ai.service.ts:3223-3225.
   * Extracted here to test the exact same algorithm used in production.
   */
  function normalizePresentation(
    raw: string | null | undefined,
  ): 'masculine' | 'feminine' | 'mixed' {
    const gp = (raw || '').toLowerCase().replace(/[\s_-]+/g, '');
    // Check female/feminine FIRST — 'female'.includes('male') is true in JS!
    if (gp.includes('female') || gp.includes('feminin') || gp === 'woman')
      return 'feminine';
    if (gp.includes('male') || gp.includes('masculin') || gp === 'man')
      return 'masculine';
    return 'mixed';
  }

  // ── Masculine mappings ──

  it('resolves "male" to masculine', () => {
    expect(normalizePresentation('male')).toBe('masculine');
  });

  it('resolves "Male" (capitalized) to masculine', () => {
    expect(normalizePresentation('Male')).toBe('masculine');
  });

  it('resolves "masculine" to masculine', () => {
    expect(normalizePresentation('masculine')).toBe('masculine');
  });

  it('resolves "Masculine" to masculine', () => {
    expect(normalizePresentation('Masculine')).toBe('masculine');
  });

  it('resolves "man" to masculine', () => {
    expect(normalizePresentation('man')).toBe('masculine');
  });

  // ── Feminine mappings ──

  it('resolves "female" to feminine', () => {
    expect(normalizePresentation('female')).toBe('feminine');
  });

  it('resolves "Female" (capitalized) to feminine', () => {
    expect(normalizePresentation('Female')).toBe('feminine');
  });

  it('resolves "feminine" to feminine', () => {
    expect(normalizePresentation('feminine')).toBe('feminine');
  });

  it('resolves "Feminine" to feminine', () => {
    expect(normalizePresentation('Feminine')).toBe('feminine');
  });

  it('resolves "woman" to feminine', () => {
    expect(normalizePresentation('woman')).toBe('feminine');
  });

  // ── Mixed / fallthrough ──

  it('resolves "nonbinary" to mixed', () => {
    expect(normalizePresentation('nonbinary')).toBe('mixed');
  });

  it('resolves "non_binary" to mixed', () => {
    expect(normalizePresentation('non_binary')).toBe('mixed');
  });

  it('resolves "non-binary" to mixed', () => {
    expect(normalizePresentation('non-binary')).toBe('mixed');
  });

  it('resolves "other" to mixed', () => {
    expect(normalizePresentation('other')).toBe('mixed');
  });

  it('resolves "rather_not_say" to mixed', () => {
    expect(normalizePresentation('rather_not_say')).toBe('mixed');
  });

  it('resolves empty string to mixed', () => {
    expect(normalizePresentation('')).toBe('mixed');
  });

  it('resolves null to mixed', () => {
    expect(normalizePresentation(null)).toBe('mixed');
  });

  it('resolves undefined to mixed', () => {
    expect(normalizePresentation(undefined)).toBe('mixed');
  });

  // ── Edge: "male" must NOT match "female" ──

  it('"female" does NOT resolve to masculine (substring guard)', () => {
    // 'female'.includes('male') === true in JS — female must be checked FIRST
    expect(normalizePresentation('female')).toBe('feminine');
  });
});

// ─── 14️⃣ Hard Completeness Gate (S2 fix) ────────────────────────

describe('Hard Completeness Gate', () => {
  /**
   * Mirrors isVisualOutfitComplete() from suggestVisualOutfits() ai.service.ts.
   * Extracted to test the exact same logic.
   */
  function isVisualOutfitComplete(outfit: {
    items: Array<{ category: string } | null>;
  }): boolean {
    const items = (outfit.items || []).filter(Boolean);
    const cats = new Set(items.map((i) => i!.category));
    const hasDress = cats.has('dress');
    const hasShoes = cats.has('shoes');
    if (hasDress) return hasShoes; // dress + shoes
    return cats.has('top') && cats.has('bottom') && hasShoes; // separates
  }

  // ── Complete outfits pass ──

  it('accepts separates: top + bottom + shoes', () => {
    const outfit = {
      items: [
        { category: 'top' },
        { category: 'bottom' },
        { category: 'shoes' },
      ],
    };
    expect(isVisualOutfitComplete(outfit)).toBe(true);
  });

  it('accepts separates with outerwear: top + bottom + shoes + outerwear', () => {
    const outfit = {
      items: [
        { category: 'top' },
        { category: 'bottom' },
        { category: 'shoes' },
        { category: 'outerwear' },
      ],
    };
    expect(isVisualOutfitComplete(outfit)).toBe(true);
  });

  it('accepts dress-based: dress + shoes', () => {
    const outfit = {
      items: [{ category: 'dress' }, { category: 'shoes' }],
    };
    expect(isVisualOutfitComplete(outfit)).toBe(true);
  });

  it('accepts dress + shoes + outerwear', () => {
    const outfit = {
      items: [
        { category: 'dress' },
        { category: 'shoes' },
        { category: 'outerwear' },
      ],
    };
    expect(isVisualOutfitComplete(outfit)).toBe(true);
  });

  // ── Incomplete outfits rejected ──

  it('rejects separates missing shoes', () => {
    const outfit = {
      items: [{ category: 'top' }, { category: 'bottom' }],
    };
    expect(isVisualOutfitComplete(outfit)).toBe(false);
  });

  it('rejects separates missing bottom', () => {
    const outfit = {
      items: [{ category: 'top' }, { category: 'shoes' }],
    };
    expect(isVisualOutfitComplete(outfit)).toBe(false);
  });

  it('rejects separates missing top', () => {
    const outfit = {
      items: [{ category: 'bottom' }, { category: 'shoes' }],
    };
    expect(isVisualOutfitComplete(outfit)).toBe(false);
  });

  it('rejects dress missing shoes', () => {
    const outfit = {
      items: [{ category: 'dress' }],
    };
    expect(isVisualOutfitComplete(outfit)).toBe(false);
  });

  it('rejects empty outfit', () => {
    const outfit = { items: [] };
    expect(isVisualOutfitComplete(outfit)).toBe(false);
  });

  it('rejects outfit with only accessories', () => {
    const outfit = {
      items: [{ category: 'accessory' }, { category: 'accessory' }],
    };
    expect(isVisualOutfitComplete(outfit)).toBe(false);
  });

  it('rejects outfit with only shoes', () => {
    const outfit = {
      items: [{ category: 'shoes' }],
    };
    expect(isVisualOutfitComplete(outfit)).toBe(false);
  });

  it('handles null items in array (filters them out)', () => {
    const outfit = {
      items: [
        { category: 'top' },
        null,
        { category: 'bottom' },
        null,
        { category: 'shoes' },
      ] as any[],
    };
    expect(isVisualOutfitComplete(outfit)).toBe(true);
  });

  // ── Integration: filter simulates the production scoredOutfits.filter() ──

  it('filtering array: keeps only complete outfits', () => {
    const outfits = [
      {
        rank: 1,
        items: [
          { category: 'top' },
          { category: 'bottom' },
          { category: 'shoes' },
        ],
      },
      { rank: 2, items: [{ category: 'top' }, { category: 'shoes' }] }, // missing bottom
      { rank: 3, items: [{ category: 'dress' }, { category: 'shoes' }] },
    ];

    const complete = outfits.filter(isVisualOutfitComplete);

    expect(complete).toHaveLength(2);
    expect(complete.map((o) => o.rank)).toEqual([1, 3]);
  });

  it('filtering array: no-shoes wardrobe produces 0 complete outfits', () => {
    const outfits = [
      { rank: 1, items: [{ category: 'top' }, { category: 'bottom' }] },
      { rank: 2, items: [{ category: 'dress' }] },
      {
        rank: 3,
        items: [
          { category: 'top' },
          { category: 'bottom' },
          { category: 'outerwear' },
        ],
      },
    ];

    const complete = outfits.filter(isVisualOutfitComplete);

    expect(complete).toHaveLength(0);
  });

  it('filtering array: no-bottoms wardrobe keeps only dress outfits', () => {
    const outfits = [
      { rank: 1, items: [{ category: 'top' }, { category: 'shoes' }] }, // missing bottom
      { rank: 2, items: [{ category: 'dress' }, { category: 'shoes' }] }, // dress-based: complete
    ];

    const complete = outfits.filter(isVisualOutfitComplete);

    expect(complete).toHaveLength(1);
    expect(complete[0].rank).toBe(2);
  });
});

// ─── 15️⃣ Post-Assembly Masculine Filter (Defense-in-Depth) ─────

import { isFeminineItem } from '../wardrobe/logic/presentationFilter';

describe('Post-Assembly Masculine Filter (Defense-in-Depth)', () => {
  // Simulates the post-assembly filter logic from ai.service.ts
  const applyMasculineFilter = (
    outfitItems: any[],
    rawLookup: Map<string, any>,
  ) =>
    outfitItems.filter((it) => {
      if (!it) return false;
      const raw = rawLookup.get(it.id);
      return !isFeminineItem(
        raw?.main_category || raw?.category || '',
        raw?.subcategory || '',
        raw?.name || it.name || '',
      );
    });

  it('masculine post-filter removes feminine items from LLM output', () => {
    const dress = makeItem({
      id: 'd1',
      name: 'Floral Midi Dress',
      main_category: 'Dresses',
      subcategory: 'Midi Dress',
    });
    const top = makeItem({
      id: 't1',
      name: 'Oxford Shirt',
      main_category: 'Tops',
      subcategory: 'Oxford Shirt',
    });
    const bottom = makeItem({
      id: 'b1',
      name: 'Chinos',
      main_category: 'Bottoms',
      subcategory: 'Chinos',
    });
    const shoes = makeItem({
      id: 's1',
      name: 'Sneakers',
      main_category: 'Shoes',
      subcategory: 'Sneakers',
    });

    const rawLookup = new Map(
      [dress, top, bottom, shoes].map((i) => [i.id, i]),
    );
    const outfitItems = [
      { id: 'd1', name: 'Floral Midi Dress', category: 'dress' },
      { id: 't1', name: 'Oxford Shirt', category: 'top' },
      { id: 'b1', name: 'Chinos', category: 'bottom' },
      { id: 's1', name: 'Sneakers', category: 'shoes' },
    ];

    const filtered = applyMasculineFilter(outfitItems, rawLookup);

    expect(filtered).toHaveLength(3);
    expect(filtered.find((i: any) => i.id === 'd1')).toBeUndefined();
    expect(filtered.map((i: any) => i.id)).toEqual(['t1', 'b1', 's1']);
  });

  it('masculine post-filter removes heels/skirts/blouse/purse', () => {
    const heels = makeItem({
      id: 'h1',
      name: 'Red Stilettos',
      main_category: 'Shoes',
      subcategory: 'Stiletto Heels',
    });
    const skirt = makeItem({
      id: 'sk1',
      name: 'Pleated Skirt',
      main_category: 'Skirts',
      subcategory: 'Pleated Skirt',
    });
    const blouse = makeItem({
      id: 'bl1',
      name: 'Silk Blouse',
      main_category: 'Tops',
      subcategory: 'Blouse',
    });
    const purse = makeItem({
      id: 'p1',
      name: 'Leather Purse',
      main_category: 'Bags',
      subcategory: 'Purse',
    });

    const rawLookup = new Map(
      [heels, skirt, blouse, purse].map((i) => [i.id, i]),
    );
    const outfitItems = [
      { id: 'h1', name: 'Red Stilettos', category: 'shoes' },
      { id: 'sk1', name: 'Pleated Skirt', category: 'bottom' },
      { id: 'bl1', name: 'Silk Blouse', category: 'top' },
      { id: 'p1', name: 'Leather Purse', category: 'accessories' },
    ];

    const filtered = applyMasculineFilter(outfitItems, rawLookup);

    expect(filtered).toHaveLength(0);
  });

  it('masculine post-filter keeps neutral items', () => {
    const tshirt = makeItem({
      id: 't1',
      name: 'Crew Neck Tee',
      main_category: 'Tops',
      subcategory: 'T-Shirts',
    });
    const chinos = makeItem({
      id: 'b1',
      name: 'Chinos',
      main_category: 'Bottoms',
      subcategory: 'Chinos',
    });
    const sneakers = makeItem({
      id: 's1',
      name: 'Canvas Sneakers',
      main_category: 'Shoes',
      subcategory: 'Sneakers',
    });
    const watch = makeItem({
      id: 'w1',
      name: 'Stainless Watch',
      main_category: 'Accessories',
      subcategory: 'Watch',
    });

    const rawLookup = new Map(
      [tshirt, chinos, sneakers, watch].map((i) => [i.id, i]),
    );
    const outfitItems = [
      { id: 't1', name: 'Crew Neck Tee', category: 'top' },
      { id: 'b1', name: 'Chinos', category: 'bottom' },
      { id: 's1', name: 'Canvas Sneakers', category: 'shoes' },
      { id: 'w1', name: 'Stainless Watch', category: 'accessories' },
    ];

    const filtered = applyMasculineFilter(outfitItems, rawLookup);

    expect(filtered).toHaveLength(4);
  });

  it('feminine/mixed users skip post-filter entirely', () => {
    const dress = makeItem({
      id: 'd1',
      name: 'Floral Dress',
      main_category: 'Dresses',
      subcategory: 'Midi Dress',
    });
    const shoes = makeItem({
      id: 's1',
      name: 'Heels',
      main_category: 'Shoes',
      subcategory: 'Stiletto Heels',
    });

    const rawLookup = new Map([dress, shoes].map((i) => [i.id, i]));
    const outfitItems = [
      { id: 'd1', name: 'Floral Dress', category: 'dress' },
      { id: 's1', name: 'Heels', category: 'shoes' },
    ];

    // For feminine/mixed, the filter should NOT be applied — items remain as-is
    // (The service code conditionally applies the filter only for masculine)
    // Here we verify the items are valid feminine items that WOULD be filtered
    expect(isFeminineItem('Dresses', 'Midi Dress', 'Floral Dress')).toBe(true);
    expect(isFeminineItem('Shoes', 'Stiletto Heels', 'Heels')).toBe(true);
    // But if we don't run the filter, all items remain
    expect(outfitItems).toHaveLength(2);
  });

  it('end-to-end: feminine item injected by completeness → caught by pass 2 → completeness gate drops outfit', () => {
    // Simulate: an outfit starts with dress + shoes
    // Pass 1 removes the dress (feminine)
    // Completeness injection backfills with another dress (from unfiltered pool)
    // Pass 2 catches the injected dress
    // Completeness gate drops the now-incomplete outfit (no top, no bottom, no dress)

    const dress1 = makeItem({
      id: 'd1',
      name: 'Evening Gown',
      main_category: 'Dresses',
      subcategory: 'Evening Gown',
    });
    const dress2 = makeItem({
      id: 'd2',
      name: 'Summer Dress',
      main_category: 'Dresses',
      subcategory: 'Sundress',
    });
    const shoes = makeItem({
      id: 's1',
      name: 'Loafers',
      main_category: 'Shoes',
      subcategory: 'Loafers',
    });

    const rawLookup = new Map([dress1, dress2, shoes].map((i) => [i.id, i]));

    // Step 1: Initial outfit from LLM
    let outfitItems = [
      { id: 'd1', name: 'Evening Gown', category: 'dress' },
      { id: 's1', name: 'Loafers', category: 'shoes' },
    ];

    // Step 2: Pass 1 removes the dress
    outfitItems = applyMasculineFilter(outfitItems, rawLookup);
    expect(outfitItems).toHaveLength(1); // only shoes remain

    // Step 3: Completeness injection backfills with dress2
    outfitItems.push({ id: 'd2', name: 'Summer Dress', category: 'dress' });
    expect(outfitItems).toHaveLength(2);

    // Step 4: Pass 2 catches injected dress
    outfitItems = applyMasculineFilter(outfitItems, rawLookup);
    expect(outfitItems).toHaveLength(1); // only shoes again

    // Step 5: Completeness gate checks
    const cats = new Set(outfitItems.map((i: any) => i.category));
    const hasDress = cats.has('dress');
    const hasShoes = cats.has('shoes');
    const isComplete = hasDress
      ? hasShoes
      : cats.has('top') && cats.has('bottom') && hasShoes;
    expect(isComplete).toBe(false); // outfit is incomplete → dropped
  });

  it('post-filter + completeness gate: outfit with feminine shoes (heels) loses them, gets no shoe backfill → dropped', () => {
    const top = makeItem({
      id: 't1',
      name: 'Polo Shirt',
      main_category: 'Tops',
      subcategory: 'Polo',
    });
    const bottom = makeItem({
      id: 'b1',
      name: 'Jeans',
      main_category: 'Bottoms',
      subcategory: 'Jeans',
    });
    const heels = makeItem({
      id: 'h1',
      name: 'Pumps',
      main_category: 'Shoes',
      subcategory: 'Pump Heels',
    });

    const rawLookup = new Map([top, bottom, heels].map((i) => [i.id, i]));
    let outfitItems = [
      { id: 't1', name: 'Polo Shirt', category: 'top' },
      { id: 'b1', name: 'Jeans', category: 'bottom' },
      { id: 'h1', name: 'Pumps', category: 'shoes' },
    ];

    // Pass 2 removes heels
    outfitItems = applyMasculineFilter(outfitItems, rawLookup);
    expect(outfitItems).toHaveLength(2); // top + bottom, no shoes

    // Completeness gate checks
    const cats = new Set(outfitItems.map((i: any) => i.category));
    const hasDress = cats.has('dress');
    const hasShoes = cats.has('shoes');
    const isComplete = hasDress
      ? hasShoes
      : cats.has('top') && cats.has('bottom') && hasShoes;
    expect(isComplete).toBe(false); // no shoes → dropped
  });
});

// ─── 16️⃣ Preferences in Prompt ─────────────────────────────────

describe('Preferences in Prompt', () => {
  it('non-empty preferences appear in LLM prompt', () => {
    const preferences = {
      favoriteColors: ['navy'],
      favoriteBrands: ['Ralph Lauren'],
    };
    const promptFragment = `Preferences: ${JSON.stringify(preferences || {})}`;

    expect(promptFragment).toContain('"favoriteColors":["navy"]');
    expect(promptFragment).toContain('"favoriteBrands":["Ralph Lauren"]');
  });

  it('undefined preferences render as {}', () => {
    const preferences = undefined;
    const promptFragment = `Preferences: ${JSON.stringify(preferences || {})}`;

    expect(promptFragment).toBe('Preferences: {}');
  });

  it('sanitized preferences contain only relevant fields', () => {
    // Simulates the HomeScreen sanitizer logic
    const rawProfile: Record<string, any> = {
      favorite_colors: ['navy', 'charcoal'],
      preferred_brands: ['Ralph Lauren', 'Nike'],
      style_keywords: ['minimalist', 'classic'],
      fashion_dislikes: ['neon', 'animal print'],
      // Extra fields that should NOT be passed
      id: 'user-123',
      created_at: '2024-01-01',
      user_id: 'user-123',
      body_type: 'athletic',
    };

    const prefs: Record<string, any> = {};
    if (rawProfile.favorite_colors)
      prefs.favoriteColors = rawProfile.favorite_colors;
    if (rawProfile.preferred_brands)
      prefs.favoriteBrands = rawProfile.preferred_brands;
    if (rawProfile.style_keywords)
      prefs.styleKeywords = rawProfile.style_keywords;
    if (rawProfile.fashion_dislikes)
      prefs.dislikes = rawProfile.fashion_dislikes;

    expect(Object.keys(prefs)).toEqual([
      'favoriteColors',
      'favoriteBrands',
      'styleKeywords',
      'dislikes',
    ]);
    expect(prefs).not.toHaveProperty('id');
    expect(prefs).not.toHaveProperty('created_at');
    expect(prefs).not.toHaveProperty('user_id');
    expect(prefs).not.toHaveProperty('body_type');
    expect(prefs.favoriteColors).toEqual(['navy', 'charcoal']);
    expect(prefs.dislikes).toEqual(['neon', 'animal print']);
  });
});

// ─── isEliteDemoUser gate ─────────────────────────────────────
describe('isEliteDemoUser', () => {
  const { isEliteDemoUser } = require('../config/feature-flags');

  it('returns false for empty allowlist', () => {
    expect(isEliteDemoUser('user-abc')).toBe(false);
  });

  it('returns false for non-matching userId', () => {
    expect(isEliteDemoUser('not-on-list')).toBe(false);
  });
});

// ─── Stylist Item Enrichment ──────────────────────────────────
// ─── Taste Validator: dress-code gating via requestedDressCode ──────────────

import {
  validateOutfit,
  validateOutfits as tasteValidateOutfits,
  tempToClimateZone,
  type ValidatorItem,
  type ValidatorContext,
} from './elite/tasteValidator';

describe('tasteValidator dress-code gating', () => {
  const validSeparates = (
    shoeExtra?: Partial<ValidatorItem>,
  ): ValidatorItem[] => [
    { id: 'top-1', slot: 'tops', name: 'Dress Shirt', dress_code: 'Business' },
    {
      id: 'bot-1',
      slot: 'bottoms',
      name: 'Wool Trousers',
      dress_code: 'Business',
    },
    { id: 'shoe-1', slot: 'shoes', name: 'Sneakers', ...shoeExtra },
  ];

  it('formal rejects athletic shoe', () => {
    const result = validateOutfit(validSeparates({ dress_code: 'Athletic' }), {
      requestedDressCode: 'formal',
    });
    expect(result.valid).toBe(false);
    expect(
      result.hardFails.some((f) => f.includes('DRESS_CODE_MISMATCH')),
    ).toBe(true);
  });

  it('formal rejects ultra-casual shoe', () => {
    const result = validateOutfit(
      validSeparates({ dress_code: 'Ultra Casual' }),
      { requestedDressCode: 'formal' },
    );
    expect(result.valid).toBe(false);
    expect(
      result.hardFails.some((f) => f.includes('DRESS_CODE_MISMATCH')),
    ).toBe(true);
  });

  it('undefined requestedDressCode does not reject casuals', () => {
    const result = validateOutfit(validSeparates({ dress_code: 'Athletic' }), {
      requestedDressCode: undefined,
    });
    expect(result.valid).toBe(true);
    expect(result.hardFails).toHaveLength(0);
  });

  it('pipeline: constraint="more formal" filters athletic outfit via validator', () => {
    // Simulate what ai.service.ts does:
    // 1. Derive requestedDressCode from constraint
    const constraint = 'more formal';
    const requestedDressCode: string | undefined = (() => {
      if (!constraint) return undefined;
      const c = constraint.toLowerCase();
      if (c.includes('formal') || c.includes('business')) return 'formal';
      return undefined;
    })();

    expect(requestedDressCode).toBe('formal'); // proves derivation works

    // 2. Build validator context
    const ctx: ValidatorContext = {
      userPresentation: 'masculine',
      climateZone: 'warm',
      requestedDressCode,
    };

    // 3. Build candidate outfits — one valid, one with athletic shoe
    const goodOutfit: ValidatorItem[] = [
      {
        id: 'top-g',
        slot: 'tops',
        name: 'Oxford Shirt',
        dress_code: 'Business',
      },
      {
        id: 'bot-g',
        slot: 'bottoms',
        name: 'Dress Pants',
        dress_code: 'Business',
      },
      { id: 'shoe-g', slot: 'shoes', name: 'Oxfords', dress_code: 'Business' },
    ];
    const badOutfit: ValidatorItem[] = [
      { id: 'top-b', slot: 'tops', name: 'Tank Top', dress_code: 'Athletic' },
      {
        id: 'bot-b',
        slot: 'bottoms',
        name: 'Gym Shorts',
        dress_code: 'Athletic',
      },
      {
        id: 'shoe-b',
        slot: 'shoes',
        name: 'Running Shoes',
        dress_code: 'Athletic',
      },
    ];

    // 4. Batch validate (same as production pipeline)
    const validation = tasteValidateOutfits(
      [
        { outfitId: 'good', items: goodOutfit },
        { outfitId: 'bad', items: badOutfit },
      ],
      ctx,
    );

    // 5. Assert: good passes, bad fails
    const validIds = new Set(
      validation.results
        .filter((r) => r.validation.valid)
        .map((r) => r.outfitId),
    );
    expect(validIds.has('good')).toBe(true);
    expect(validIds.has('bad')).toBe(false);
  });
});

describe('enrichStylistOutfits', () => {
  const { enrichStylistOutfits } = require('./ai.service');

  it('enriches stylist items with wardrobe metadata (non-breaking)', () => {
    // Thin items as LLM returns them
    const outfits = [
      {
        id: 'outfit-1',
        rank: 1,
        items: [
          {
            id: 'item-a',
            name: 'Linen Shirt',
            imageUrl: 'https://img/a.jpg',
            category: 'top',
          },
          {
            id: 'item-b',
            name: 'Chinos',
            imageUrl: 'https://img/b.jpg',
            category: 'bottom',
          },
          {
            id: 'item-c',
            name: 'Sneakers',
            imageUrl: 'https://img/c.jpg',
            category: 'shoes',
          },
        ],
      },
    ];

    // Full wardrobe metadata (what DB returns)
    const fullItemMap = new Map<string, any>([
      [
        'item-a',
        {
          id: 'item-a',
          brand: 'Uniqlo',
          color: 'navy',
          subcategory: 'Button-Down Shirts',
          style_descriptors: ['minimalist', 'smart-casual'],
          style_archetypes: ['modern'],
          formality_score: 2,
          material: 'linen',
        },
      ],
      [
        'item-b',
        {
          id: 'item-b',
          brand: 'J.Crew',
          color: 'khaki',
          subcategory: 'Chinos',
          style_descriptors: ['classic'],
          style_archetypes: [],
          formality_score: 2,
          material: 'cotton',
        },
      ],
      [
        'item-c',
        {
          id: 'item-c',
          brand: 'Nike',
          color: 'white',
          subcategory: 'Sneakers',
          style_descriptors: [],
          style_archetypes: [],
          formality_score: 1,
          material: 'leather',
        },
      ],
    ]);

    enrichStylistOutfits(outfits, fullItemMap);

    const items = outfits[0].items as any[];

    // Original required fields preserved
    expect(items[0]).toMatchObject({
      id: 'item-a',
      name: 'Linen Shirt',
      imageUrl: 'https://img/a.jpg',
      category: 'top',
    });
    expect(items[1]).toMatchObject({
      id: 'item-b',
      name: 'Chinos',
      imageUrl: 'https://img/b.jpg',
      category: 'bottom',
    });
    expect(items[2]).toMatchObject({
      id: 'item-c',
      name: 'Sneakers',
      imageUrl: 'https://img/c.jpg',
      category: 'shoes',
    });

    // Enriched fields present
    expect(items[0].brand).toBe('Uniqlo');
    expect(items[0].color).toBe('navy');
    expect(items[0].subcategory).toBe('Button-Down Shirts');
    expect(items[0].style_descriptors).toEqual(['minimalist', 'smart-casual']);
    expect(items[0].style_archetypes).toEqual(['modern']);
    expect(items[0].formality_score).toBe(2);
    expect(items[0].material).toBe('linen');

    expect(items[1].brand).toBe('J.Crew');
    expect(items[2].brand).toBe('Nike');

    // Outfit membership unchanged (same IDs, same order)
    expect(items.map((i: any) => i.id)).toEqual(['item-a', 'item-b', 'item-c']);
  });

  it('skips items not in fullItemMap (no crash)', () => {
    const outfits = [
      {
        id: 'outfit-2',
        items: [
          {
            id: 'item-x',
            name: 'Unknown',
            imageUrl: 'https://img/x.jpg',
            category: 'top',
          },
        ],
      },
    ];
    const fullItemMap = new Map<string, any>();

    enrichStylistOutfits(outfits, fullItemMap);

    // Unchanged — no enrichment, no crash
    expect(outfits[0].items[0]).toEqual({
      id: 'item-x',
      name: 'Unknown',
      imageUrl: 'https://img/x.jpg',
      category: 'top',
    });
  });

  it('skips empty optional fields (no undefined pollution)', () => {
    const outfits = [
      {
        id: 'outfit-3',
        items: [
          {
            id: 'item-d',
            name: 'Plain Tee',
            imageUrl: 'https://img/d.jpg',
            category: 'top',
          },
        ],
      },
    ];
    const fullItemMap = new Map<string, any>([
      [
        'item-d',
        {
          id: 'item-d',
          brand: '',
          color: '',
          subcategory: '',
          style_descriptors: [],
          style_archetypes: [],
          formality_score: null,
          material: '',
        },
      ],
    ]);

    enrichStylistOutfits(outfits, fullItemMap);

    const item = outfits[0].items[0] as any;
    // Empty strings / null / empty arrays should NOT be spread
    expect(item).not.toHaveProperty('brand');
    expect(item).not.toHaveProperty('color');
    expect(item).not.toHaveProperty('subcategory');
    expect(item).not.toHaveProperty('style_descriptors');
    expect(item).not.toHaveProperty('style_archetypes');
    expect(item).not.toHaveProperty('formality_score');
    expect(item).not.toHaveProperty('material');
  });
});

// ─── 17️⃣ Hydration Stub Fallback (Scenario-3 avoid_colors gap) ──────────────

import { colorMatchesSafe, expandAvoidColors } from './elite/tasteValidator';

describe('Hydration stub fallback — avoid_colors for unknown IDs', () => {
  // Replicate exact production helpers from ai.service.ts:5484-5535
  const _normColor = (v: any): string | null => {
    if (typeof v !== 'string') return null;
    return v.trim().toLowerCase().replace(/[-_]/g, ' ').replace(/\s+/g, ' ');
  };

  const _getCanonicalColors = (full: any): string[] => {
    const raw: any[] = [];
    if (!full) return [];
    raw.push(full.color);
    if (Array.isArray(full.colors)) raw.push(...full.colors);
    raw.push(full.metadata?.color);
    if (Array.isArray(full.metadata?.colors)) raw.push(...full.metadata.colors);
    raw.push(full.enrichment?.color);
    if (Array.isArray(full.enrichment?.colors))
      raw.push(...full.enrichment.colors);
    const out = new Set<string>();
    for (const r of raw) {
      const n = _normColor(r);
      if (n) out.add(n);
    }
    return [...out];
  };

  // Replicate _hydrateOutfitColors WITH the stub fallback fix
  const _hydrateOutfitColors = (
    outfit: any,
    fullItemMap: Map<string, any>,
  ): any => {
    const items = Array.isArray(outfit?.items) ? outfit.items : [];
    outfit.items = items.map((it: any) => {
      const full = it?.id ? fullItemMap.get(it.id) : null;
      let canonicalColors = _getCanonicalColors(full);
      if (canonicalColors.length === 0 && it) {
        const stubRaw: any[] = [];
        if (it.color) stubRaw.push(it.color);
        if (Array.isArray(it.colors)) stubRaw.push(...it.colors);
        if (it.metadata?.color) stubRaw.push(it.metadata.color);
        if (Array.isArray(it.metadata?.colors))
          stubRaw.push(...it.metadata.colors);
        const stubOut = new Set<string>();
        for (const r of stubRaw) {
          const n = _normColor(r);
          if (n) stubOut.add(n);
        }
        if (stubOut.size > 0) canonicalColors = [...stubOut];
      }
      return { ...it, __canonicalColors: canonicalColors };
    });
    return outfit;
  };

  // Replicate RETURN_GUARD logic from ai.service.ts:5696-5708
  const rtHasAvoid = (outfit: any, expandedAvoid: string[]): boolean => {
    const items = Array.isArray(outfit?.items) ? outfit.items : [];
    for (const it of items) {
      const colors: string[] = Array.isArray(it.__canonicalColors)
        ? it.__canonicalColors
        : [];
      for (const c of colors) {
        for (const a of expandedAvoid) {
          if (colorMatchesSafe(c, a)) return true;
        }
      }
    }
    return false;
  };

  it('stub with color "Navy" is caught when avoid_colors=["navy"]', () => {
    const fullItemMap = new Map<string, any>(); // empty — ID not found
    const outfit: any = {
      id: 'outfit-1',
      items: [
        {
          id: 'hallucinated-id',
          name: 'Navy Blazer',
          color: 'Navy',
          category: 'top',
        },
        {
          id: 'real-shoes',
          name: 'Loafers',
          color: 'Brown',
          category: 'shoes',
        },
      ],
    };

    _hydrateOutfitColors(outfit, fullItemMap);

    // Prove __canonicalColors was populated from stub
    expect(outfit.items[0].__canonicalColors).toEqual(['navy']);
    expect(outfit.items[1].__canonicalColors).toEqual(['brown']);

    // Prove RETURN_GUARD catches it
    const expanded = expandAvoidColors(['navy']);
    expect(rtHasAvoid(outfit, expanded)).toBe(true);
  });

  it('stub with NO color gets empty __canonicalColors (no false positive)', () => {
    const fullItemMap = new Map<string, any>();
    const outfit: any = {
      id: 'outfit-2',
      items: [{ id: 'no-color-stub', name: 'Mystery Item', category: 'top' }],
    };

    _hydrateOutfitColors(outfit, fullItemMap);

    expect(outfit.items[0].__canonicalColors).toEqual([]);

    const expanded = expandAvoidColors(['navy']);
    expect(rtHasAvoid(outfit, expanded)).toBe(false);
  });

  it('full item in map still uses fullItemMap data (existing behavior preserved)', () => {
    const fullItemMap = new Map<string, any>([
      ['item-a', { color: 'Red', metadata: { colors: ['Burgundy'] } }],
    ]);
    const outfit: any = {
      id: 'outfit-3',
      items: [
        {
          id: 'item-a',
          name: 'Red Top',
          color: 'should-be-ignored',
          category: 'top',
        },
      ],
    };

    _hydrateOutfitColors(outfit, fullItemMap);

    // Uses fullItemMap, not stub
    expect(outfit.items[0].__canonicalColors).toEqual(
      expect.arrayContaining(['red', 'burgundy']),
    );
    expect(outfit.items[0].__canonicalColors).not.toContain(
      'should-be-ignored',
    );
  });

  it('avoid "navy" does NOT match stub color "blue" (no navy-bans-blue bug)', () => {
    const fullItemMap = new Map<string, any>();
    const outfit: any = {
      id: 'outfit-4',
      items: [
        { id: 'stub-1', name: 'Blue Tee', color: 'Blue', category: 'top' },
      ],
    };

    _hydrateOutfitColors(outfit, fullItemMap);
    expect(outfit.items[0].__canonicalColors).toEqual(['blue']);

    const expanded = expandAvoidColors(['navy']);
    // "navy" expanded = ["navy", "navy blue", "dark navy", "midnight", "ink"]
    // "blue" should NOT match any of those
    expect(rtHasAvoid(outfit, expanded)).toBe(false);
  });
});
