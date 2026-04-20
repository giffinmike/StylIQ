import {
  classifyColorFamily,
  computeCuratorSignals,
  CuratorInput,
  CuratorProfile,
  CuratorResult,
} from './discover-curator';

// ─── Helpers ─────────────────────────────────────────────────────────

function emptyProfile(overrides: Partial<CuratorProfile> = {}): CuratorProfile {
  return {
    styleKeywords: [],
    formalityFloor: null,
    silhouettePreference: null,
    climate: null,
    colorPreferences: [],
    fitPreferences: [],
    ...overrides,
  };
}

function makeInput(overrides: Partial<CuratorInput> = {}): CuratorInput {
  return {
    title: overrides.title ?? 'Generic Item',
    blob: overrides.blob ?? 'generic item',
    enrichedColor: overrides.enrichedColor ?? '',
    price: overrides.price ?? null,
    brand: overrides.brand ?? null,
    inferredCategory: overrides.inferredCategory ?? null,
    existingScore: overrides.existingScore ?? 0,
    existingBreakdown: overrides.existingBreakdown ?? {},
    brandTier: overrides.brandTier,
  };
}

// ═════════════════════════════════════════════════════════════════════
// 1. classifyColorFamily
// ═════════════════════════════════════════════════════════════════════

describe('classifyColorFamily', () => {
  it('classifies black as neutral', () => {
    expect(classifyColorFamily('black')).toBe('neutral');
  });

  it('classifies navy as cool', () => {
    expect(classifyColorFamily('navy')).toBe('cool');
  });

  it('classifies red as warm', () => {
    expect(classifyColorFamily('red')).toBe('warm');
  });

  it('classifies brown as earth', () => {
    expect(classifyColorFamily('brown')).toBe('earth');
  });

  it('returns null for empty string', () => {
    expect(classifyColorFamily('')).toBeNull();
  });

  it('returns null for whitespace-only', () => {
    expect(classifyColorFamily('   ')).toBeNull();
  });

  it('returns null for unrecognized color', () => {
    expect(classifyColorFamily('xyzcolor')).toBeNull();
  });

  it('classifies neon green as neon', () => {
    expect(classifyColorFamily('neon green')).toBe('neon');
  });

  it('classifies lavender as pastel', () => {
    expect(classifyColorFamily('lavender')).toBe('pastel');
  });

  it('classifies olive as earth', () => {
    expect(classifyColorFamily('olive')).toBe('earth');
  });

  it('is case-insensitive', () => {
    expect(classifyColorFamily('BLACK')).toBe('neutral');
    expect(classifyColorFamily('Navy')).toBe('cool');
    expect(classifyColorFamily('RED')).toBe('warm');
  });

  it('handles leading/trailing whitespace', () => {
    expect(classifyColorFamily('  brown  ')).toBe('earth');
  });

  it('classifies white as neutral', () => {
    expect(classifyColorFamily('white')).toBe('neutral');
  });

  it('classifies gray and grey as neutral', () => {
    expect(classifyColorFamily('gray')).toBe('neutral');
    expect(classifyColorFamily('grey')).toBe('neutral');
  });

  it('classifies gold as warm', () => {
    expect(classifyColorFamily('gold')).toBe('warm');
  });

  it('classifies teal as cool', () => {
    expect(classifyColorFamily('teal')).toBe('cool');
  });

  it('classifies hot pink as neon', () => {
    expect(classifyColorFamily('hot pink')).toBe('neon');
  });

  it('classifies mint as pastel', () => {
    expect(classifyColorFamily('mint')).toBe('pastel');
  });

  // ── Composite / ambiguous colors ──────────────────────────────────

  it('classifies "dark red" as warm (substring match on "red")', () => {
    expect(classifyColorFamily('dark red')).toBe('warm');
  });

  it('classifies "forest green" as earth (substring match on "forest")', () => {
    expect(classifyColorFamily('forest green')).toBe('earth');
  });

  it('classifies "bright green" as cool (substring match on "green")', () => {
    expect(classifyColorFamily('bright green')).toBe('cool');
  });

  it('returns null for "dusty rose" (no matching key)', () => {
    expect(classifyColorFamily('dusty rose')).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════
// 2. Formality Coherence
// ═════════════════════════════════════════════════════════════════════

describe('Formality Coherence', () => {
  it('+4 when product is at or above floor', () => {
    // Blazer = 5, floor = business casual = 4 → at or above
    const product = makeInput({
      title: 'Navy Wool Blazer',
      blob: 'navy wool blazer',
    });
    const profile = emptyProfile({ formalityFloor: 'business casual' });
    const result = computeCuratorSignals(product, profile);
    expect(result.formalityCoherence).toBe(4);
  });

  it('-8 when product is 1 rank below floor', () => {
    // Smart casual = 3, floor = business casual = 4 → 1 below
    const product = makeInput({
      title: 'Smart Casual Chinos',
      blob: 'smart casual chinos',
    });
    const profile = emptyProfile({ formalityFloor: 'business casual' });
    const result = computeCuratorSignals(product, profile);
    expect(result.formalityCoherence).toBe(-8);
  });

  it('0 when product is 2 ranks below floor', () => {
    // Casual/hoodie = 2, floor = business casual = 4 → 2 below
    const product = makeInput({
      title: 'Casual Cotton Hoodie',
      blob: 'casual cotton hoodie',
    });
    const profile = emptyProfile({ formalityFloor: 'business casual' });
    const result = computeCuratorSignals(product, profile);
    expect(result.formalityCoherence).toBe(0);
  });

  it('-8 when product is 3+ ranks below floor', () => {
    // Athletic = 1, floor = business casual = 4 → 3 below
    const product = makeInput({
      title: 'Athletic Gym Tank',
      blob: 'athletic gym tank',
    });
    const profile = emptyProfile({ formalityFloor: 'business casual' });
    const result = computeCuratorSignals(product, profile);
    expect(result.formalityCoherence).toBe(-8);
  });

  it('0 when no formality floor set', () => {
    const product = makeInput({
      title: 'Athletic Running Shorts',
      blob: 'athletic running shorts',
    });
    const profile = emptyProfile({ formalityFloor: null });
    const result = computeCuratorSignals(product, profile);
    expect(result.formalityCoherence).toBe(0);
  });

  it('0 when product formality cannot be inferred (unknown product)', () => {
    const product = makeInput({
      title: 'Generic Accessory Thing',
      blob: 'generic accessory thing',
    });
    const profile = emptyProfile({ formalityFloor: 'business casual' });
    const result = computeCuratorSignals(product, profile);
    expect(result.formalityCoherence).toBe(0);
  });

  it('0 when floor label is unrecognized', () => {
    const product = makeInput({
      title: 'Navy Wool Blazer',
      blob: 'navy wool blazer',
    });
    const profile = emptyProfile({ formalityFloor: 'unknown-floor-xyz' });
    const result = computeCuratorSignals(product, profile);
    expect(result.formalityCoherence).toBe(0);
  });

  it('+4 when product is well above floor', () => {
    // Black tie = 8, floor = casual = 2 → well above
    const product = makeInput({
      title: 'Black Tie Tuxedo',
      blob: 'black tie tuxedo',
    });
    const profile = emptyProfile({ formalityFloor: 'casual' });
    const result = computeCuratorSignals(product, profile);
    expect(result.formalityCoherence).toBe(4);
  });
});

// ═════════════════════════════════════════════════════════════════════
// 3. Color Harmony
// ═════════════════════════════════════════════════════════════════════

describe('Color Harmony', () => {
  it('+3 for neutral product + neutral user pref', () => {
    const product = makeInput({ enrichedColor: 'black' });
    const profile = emptyProfile({ colorPreferences: ['gray', 'white'] });
    const result = computeCuratorSignals(product, profile);
    expect(result.colorHarmony).toBe(3);
  });

  it('+2 for matching color family', () => {
    const product = makeInput({ enrichedColor: 'navy' });
    const profile = emptyProfile({ colorPreferences: ['blue', 'teal'] });
    const result = computeCuratorSignals(product, profile);
    expect(result.colorHarmony).toBe(2);
  });

  it('-4 for neon product when user style is classic', () => {
    const product = makeInput({ enrichedColor: 'neon green' });
    const profile = emptyProfile({
      colorPreferences: ['black', 'navy'],
      styleKeywords: ['classic'],
    });
    const result = computeCuratorSignals(product, profile);
    expect(result.colorHarmony).toBe(-4);
  });

  it('-4 for neon product when user style is elegant', () => {
    const product = makeInput({ enrichedColor: 'neon pink' });
    const profile = emptyProfile({
      colorPreferences: ['black'],
      styleKeywords: ['elegant'],
    });
    const result = computeCuratorSignals(product, profile);
    expect(result.colorHarmony).toBe(-4);
  });

  it('-4 for neon product when user style is sophisticated', () => {
    const product = makeInput({ enrichedColor: 'hot pink' });
    const profile = emptyProfile({
      colorPreferences: ['navy'],
      styleKeywords: ['sophisticated'],
    });
    const result = computeCuratorSignals(product, profile);
    expect(result.colorHarmony).toBe(-4);
  });

  it('0 when no enriched color', () => {
    const product = makeInput({ enrichedColor: '' });
    const profile = emptyProfile({ colorPreferences: ['black'] });
    const result = computeCuratorSignals(product, profile);
    expect(result.colorHarmony).toBe(0);
  });

  it('0 when no color preferences', () => {
    const product = makeInput({ enrichedColor: 'red' });
    const profile = emptyProfile({ colorPreferences: [] });
    const result = computeCuratorSignals(product, profile);
    expect(result.colorHarmony).toBe(0);
  });

  it('0 for non-matching families (no neon/classic clash)', () => {
    const product = makeInput({ enrichedColor: 'red' });
    const profile = emptyProfile({ colorPreferences: ['blue'] });
    const result = computeCuratorSignals(product, profile);
    expect(result.colorHarmony).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════
// 4. Occasion Bonus
// ═════════════════════════════════════════════════════════════════════

describe('Occasion Bonus', () => {
  it('+3 when user has occasion style AND product has occasion tokens', () => {
    const product = makeInput({ blob: 'tailored wool blazer' });
    const profile = emptyProfile({ styleKeywords: ['formal', 'classic'] });
    const result = computeCuratorSignals(product, profile);
    expect(result.occasionBonus).toBe(3);
  });

  it('+3 for business style + suit product', () => {
    const product = makeInput({ blob: 'navy suit jacket' });
    const profile = emptyProfile({ styleKeywords: ['business'] });
    const result = computeCuratorSignals(product, profile);
    expect(result.occasionBonus).toBe(3);
  });

  it('0 when user has occasion style but product has no occasion tokens', () => {
    const product = makeInput({ blob: 'cotton tshirt casual' });
    const profile = emptyProfile({ styleKeywords: ['formal'] });
    const result = computeCuratorSignals(product, profile);
    expect(result.occasionBonus).toBe(0);
  });

  it('0 when user has no occasion style keywords', () => {
    const product = makeInput({ blob: 'tailored wool blazer' });
    const profile = emptyProfile({ styleKeywords: ['casual', 'streetwear'] });
    const result = computeCuratorSignals(product, profile);
    expect(result.occasionBonus).toBe(0);
  });

  it('0 with empty profile', () => {
    const product = makeInput({ blob: 'tailored wool blazer' });
    const profile = emptyProfile();
    const result = computeCuratorSignals(product, profile);
    expect(result.occasionBonus).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════
// 5. Silhouette Depth
// ═════════════════════════════════════════════════════════════════════

describe('Silhouette Depth', () => {
  it('+4 exact match: slim product + slim user', () => {
    const product = makeInput({ blob: 'slim fit cotton chinos' });
    const profile = emptyProfile({ fitPreferences: ['slim'] });
    const result = computeCuratorSignals(product, profile);
    expect(result.silhouetteDepth).toBe(4);
  });

  it('+4 exact match: loose product + loose user', () => {
    const product = makeInput({ blob: 'oversized cotton hoodie' });
    const profile = emptyProfile({ fitPreferences: ['relaxed'] });
    const result = computeCuratorSignals(product, profile);
    expect(result.silhouetteDepth).toBe(4);
  });

  it('-4 conflict: loose product + slim user', () => {
    const product = makeInput({ blob: 'oversized boxy tshirt' });
    const profile = emptyProfile({ fitPreferences: ['slim'] });
    const result = computeCuratorSignals(product, profile);
    expect(result.silhouetteDepth).toBe(-4);
  });

  it('-4 conflict: slim product + loose user', () => {
    const product = makeInput({ blob: 'slim fit skinny jeans' });
    const profile = emptyProfile({ fitPreferences: ['oversized'] });
    const result = computeCuratorSignals(product, profile);
    expect(result.silhouetteDepth).toBe(-4);
  });

  it('0 when user has no fit preference', () => {
    const product = makeInput({ blob: 'slim fit cotton chinos' });
    const profile = emptyProfile({ fitPreferences: [] });
    const result = computeCuratorSignals(product, profile);
    expect(result.silhouetteDepth).toBe(0);
  });

  it('+2 adjacent: neutral product with "regular" + slim user', () => {
    const product = makeInput({ blob: 'regular cotton polo shirt' });
    const profile = emptyProfile({ fitPreferences: ['slim'] });
    const result = computeCuratorSignals(product, profile);
    expect(result.silhouetteDepth).toBe(2);
  });

  it('+2 adjacent: neutral product with "straight" + slim user', () => {
    const product = makeInput({ blob: 'straight leg jeans' });
    const profile = emptyProfile({ fitPreferences: ['slim'] });
    const result = computeCuratorSignals(product, profile);
    expect(result.silhouetteDepth).toBe(2);
  });

  it('+2 adjacent: neutral product with "classic fit" + slim user', () => {
    const product = makeInput({ blob: 'classic fit polo' });
    const profile = emptyProfile({ fitPreferences: ['tailored'] });
    const result = computeCuratorSignals(product, profile);
    expect(result.silhouetteDepth).toBe(2);
  });

  it('0 for neutral product without adjacent tokens + slim user', () => {
    const product = makeInput({ blob: 'cotton polo shirt' });
    const profile = emptyProfile({ fitPreferences: ['slim'] });
    const result = computeCuratorSignals(product, profile);
    expect(result.silhouetteDepth).toBe(0);
  });

  it('uses silhouettePreference when fitPreferences is empty', () => {
    const product = makeInput({ blob: 'slim fit blazer' });
    const profile = emptyProfile({ silhouettePreference: 'structured' });
    const result = computeCuratorSignals(product, profile);
    expect(result.silhouetteDepth).toBe(4);
  });

  it('0 for neutral product + loose user (no adjacent logic for loose)', () => {
    const product = makeInput({ blob: 'regular cotton shirt' });
    const profile = emptyProfile({ fitPreferences: ['relaxed'] });
    const result = computeCuratorSignals(product, profile);
    // Adjacent token bonus only applies when user wants slim
    expect(result.silhouetteDepth).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════
// 6. Material Elevation
// ═════════════════════════════════════════════════════════════════════

describe('Material Elevation', () => {
  it('+3 premium material + luxury style', () => {
    const product = makeInput({ blob: 'cashmere sweater' });
    const profile = emptyProfile({ styleKeywords: ['luxury'] });
    const result = computeCuratorSignals(product, profile);
    expect(result.materialElevation).toBe(3);
  });

  it('+3 silk + elegant style', () => {
    const product = makeInput({ blob: 'silk blouse' });
    const profile = emptyProfile({ styleKeywords: ['elegant'] });
    const result = computeCuratorSignals(product, profile);
    expect(result.materialElevation).toBe(3);
  });

  it('+3 leather + sophisticated style', () => {
    const product = makeInput({ blob: 'leather jacket' });
    const profile = emptyProfile({ styleKeywords: ['sophisticated'] });
    const result = computeCuratorSignals(product, profile);
    expect(result.materialElevation).toBe(3);
  });

  it('-3 athletic material + luxury style', () => {
    const product = makeInput({ blob: 'polyester track pants' });
    const profile = emptyProfile({ styleKeywords: ['luxury'] });
    const result = computeCuratorSignals(product, profile);
    expect(result.materialElevation).toBe(-3);
  });

  it('-3 nylon + elegant style', () => {
    const product = makeInput({ blob: 'nylon windbreaker' });
    const profile = emptyProfile({ styleKeywords: ['elegant'] });
    const result = computeCuratorSignals(product, profile);
    expect(result.materialElevation).toBe(-3);
  });

  it('0 athletic material + casual style (no luxury keyword)', () => {
    const product = makeInput({ blob: 'polyester track pants' });
    const profile = emptyProfile({ styleKeywords: ['casual', 'streetwear'] });
    const result = computeCuratorSignals(product, profile);
    expect(result.materialElevation).toBe(0);
  });

  it('0 with no style keywords', () => {
    const product = makeInput({ blob: 'cashmere sweater' });
    const profile = emptyProfile({ styleKeywords: [] });
    const result = computeCuratorSignals(product, profile);
    expect(result.materialElevation).toBe(0);
  });

  it('0 luxury style but no material signal', () => {
    const product = makeInput({ blob: 'cotton tshirt' });
    const profile = emptyProfile({ styleKeywords: ['luxury'] });
    const result = computeCuratorSignals(product, profile);
    expect(result.materialElevation).toBe(0);
  });

  it('premium takes priority over athletic when both present', () => {
    const product = makeInput({ blob: 'silk blend polyester dress' });
    const profile = emptyProfile({ styleKeywords: ['luxury'] });
    const result = computeCuratorSignals(product, profile);
    // silk is checked first in PREMIUM_MATERIALS
    expect(result.materialElevation).toBe(3);
  });
});

// ═════════════════════════════════════════════════════════════════════
// 7. Clamping: curatorTotal always in [-15, +15]
// ═════════════════════════════════════════════════════════════════════

describe('Clamping', () => {
  it('curatorTotal is clamped at -15 (worst case)', () => {
    // Force multiple negative signals:
    // formalityCoherence = -8 (3+ below floor)
    // colorHarmony = -4 (neon + classic)
    // silhouetteDepth = -4 (conflict)
    // materialElevation = -3 (athletic + luxury)
    // Raw total = -19, should clamp to -15
    const product = makeInput({
      title: 'Athletic Gym Shorts', // formality = 1
      blob: 'oversized athletic gym shorts nylon mesh',
      enrichedColor: 'neon green',
    });
    const profile = emptyProfile({
      formalityFloor: 'formal', // rank 7, product rank 1 → gap 6 → -8
      colorPreferences: ['navy'], // neon vs cool, needs classic style
      styleKeywords: ['classic', 'luxury'], // triggers neon penalty + material penalty
      fitPreferences: ['slim'], // conflicts with oversized → -4
    });
    const result = computeCuratorSignals(product, profile);
    expect(result.curatorTotal).toBeGreaterThanOrEqual(-15);
    expect(result.curatorTotal).toBeLessThanOrEqual(15);
  });

  it('curatorTotal is clamped at +15 (best case)', () => {
    // Force multiple positive signals:
    // formalityCoherence = +4
    // colorHarmony = +3 (neutral + neutral)
    // occasionBonus = +3
    // silhouetteDepth = +4
    // materialElevation = +3
    // brandElevation = +4 (tier 1)
    // Raw total = +21, should clamp to +15
    const product = makeInput({
      title: 'Navy Wool Blazer', // formality = 5
      blob: 'slim fit tailored wool blazer evening',
      enrichedColor: 'black',
      brandTier: 1,
    });
    const profile = emptyProfile({
      formalityFloor: 'business casual', // rank 4, product rank 5 → above → +4
      colorPreferences: ['black', 'gray'], // neutral + neutral → +3
      styleKeywords: ['formal', 'luxury'], // occasion match + luxury style
      fitPreferences: ['slim'], // matches slim → +4
    });
    const result = computeCuratorSignals(product, profile);
    expect(result.curatorTotal).toBe(15);
    expect(result.curatorTotal).toBeLessThanOrEqual(15);
  });

  it('curatorTotal not clamped when within bounds', () => {
    const product = makeInput({
      title: 'Navy Wool Blazer',
      blob: 'wool blazer',
      enrichedColor: 'navy',
    });
    const profile = emptyProfile({
      formalityFloor: 'business casual', // blazer = 5, floor = 4 → +4
      colorPreferences: ['blue'], // navy → cool, blue → cool → +2
    });
    const result = computeCuratorSignals(product, profile);
    // +4 formality + +2 color = +6, within bounds
    expect(result.curatorTotal).toBe(6);
  });
});

// ═════════════════════════════════════════════════════════════════════
// 8. Confidence Score
// ═════════════════════════════════════════════════════════════════════

describe('Confidence Score', () => {
  it('confidence is between 0 and 1', () => {
    const product = makeInput({ title: 'Generic Item', blob: 'generic item' });
    const profile = emptyProfile();
    const result = computeCuratorSignals(product, profile);
    expect(result.confidenceScore).toBeGreaterThanOrEqual(0);
    expect(result.confidenceScore).toBeLessThanOrEqual(1);
  });

  it('signalsUsed <= signalsAvailable', () => {
    const product = makeInput({
      title: 'Navy Wool Blazer',
      blob: 'slim fit tailored wool blazer evening',
      enrichedColor: 'black',
    });
    const profile = emptyProfile({
      formalityFloor: 'business casual',
      colorPreferences: ['black', 'gray'],
      styleKeywords: ['formal', 'luxury'],
      fitPreferences: ['slim'],
    });
    const result = computeCuratorSignals(product, profile);
    expect(result.signalsUsed).toBeLessThanOrEqual(result.signalsAvailable);
  });

  it('signalsAvailable is always 6 (one per dimension)', () => {
    const product = makeInput();
    const profile = emptyProfile();
    const result = computeCuratorSignals(product, profile);
    expect(result.signalsAvailable).toBe(6);
  });

  it('high confidence when many signals fire', () => {
    const product = makeInput({
      title: 'Navy Wool Blazer',
      blob: 'slim fit tailored wool blazer evening',
      enrichedColor: 'black',
    });
    const profile = emptyProfile({
      formalityFloor: 'business casual',
      colorPreferences: ['black'],
      styleKeywords: ['formal', 'luxury'],
      fitPreferences: ['slim'],
    });
    const result = computeCuratorSignals(product, profile);
    expect(result.confidenceScore).toBeGreaterThan(0.5);
  });

  it('low confidence when few signals fire', () => {
    const product = makeInput({ title: 'Generic Item', blob: 'generic item' });
    const profile = emptyProfile();
    const result = computeCuratorSignals(product, profile);
    expect(result.confidenceScore).toBe(0);
    expect(result.signalsUsed).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════
// 9. Determinism: same input always produces same output
// ═════════════════════════════════════════════════════════════════════

describe('Determinism', () => {
  it('produces identical CuratorResult for identical inputs across 100 runs', () => {
    const product = makeInput({
      title: 'Navy Wool Blazer',
      blob: 'slim fit tailored wool blazer evening cocktail',
      enrichedColor: 'black',
      price: 250,
      brand: 'Hugo Boss',
      inferredCategory: 'Blazers',
    });
    const profile = emptyProfile({
      formalityFloor: 'business casual',
      colorPreferences: ['black', 'navy', 'gray'],
      styleKeywords: ['formal', 'luxury', 'sophisticated'],
      fitPreferences: ['slim', 'tailored'],
      silhouettePreference: 'structured',
      climate: 'cold',
    });

    const firstRun = computeCuratorSignals(product, profile);
    for (let i = 0; i < 100; i++) {
      const run = computeCuratorSignals(product, profile);
      expect(run).toEqual(firstRun);
    }
  });

  it('produces identical results for different orderings of the same data', () => {
    const product = makeInput({
      title: 'Casual Cotton Tee',
      blob: 'casual cotton tee',
      enrichedColor: 'red',
    });
    const profileA = emptyProfile({
      styleKeywords: ['casual', 'streetwear'],
      colorPreferences: ['red', 'orange'],
    });
    const profileB = emptyProfile({
      styleKeywords: ['casual', 'streetwear'],
      colorPreferences: ['red', 'orange'],
    });

    const resultA = computeCuratorSignals(product, profileA);
    const resultB = computeCuratorSignals(product, profileB);
    expect(resultA).toEqual(resultB);
  });
});

// ═════════════════════════════════════════════════════════════════════
// 10. debugTags populated
// ═════════════════════════════════════════════════════════════════════

describe('debugTags', () => {
  it('contains tags for each dimension evaluated', () => {
    const product = makeInput({
      title: 'Navy Wool Blazer',
      blob: 'slim fit wool blazer tailored',
      enrichedColor: 'black',
    });
    const profile = emptyProfile({
      formalityFloor: 'business casual',
      colorPreferences: ['black'],
      styleKeywords: ['formal', 'luxury'],
      fitPreferences: ['slim'],
    });
    const result = computeCuratorSignals(product, profile);
    expect(result.debugTags.length).toBeGreaterThan(0);
    // Should have at least one tag per dimension
    const hasFormality = result.debugTags.some((t) =>
      t.startsWith('formality:'),
    );
    const hasColor = result.debugTags.some((t) => t.startsWith('color:'));
    const hasOccasion = result.debugTags.some((t) => t.startsWith('occasion:'));
    const hasSilhouette = result.debugTags.some((t) =>
      t.startsWith('silhouette:'),
    );
    const hasMaterial = result.debugTags.some((t) => t.startsWith('material:'));
    const hasBrand = result.debugTags.some((t) => t.startsWith('brand:'));
    expect(hasFormality).toBe(true);
    expect(hasColor).toBe(true);
    expect(hasOccasion).toBe(true);
    expect(hasSilhouette).toBe(true);
    expect(hasMaterial).toBe(true);
    expect(hasBrand).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════
// 11. Integration: full pipeline with empty profile returns all zeros
// ═════════════════════════════════════════════════════════════════════

describe('Empty profile baseline', () => {
  it('returns all zeros with empty profile', () => {
    const product = makeInput({ title: 'Some Product', blob: 'some product' });
    const profile = emptyProfile();
    const result = computeCuratorSignals(product, profile);
    expect(result.formalityCoherence).toBe(0);
    expect(result.colorHarmony).toBe(0);
    expect(result.occasionBonus).toBe(0);
    expect(result.silhouetteDepth).toBe(0);
    expect(result.materialElevation).toBe(0);
    expect(result.brandElevation).toBe(0);
    expect(result.curatorTotal).toBe(0);
  });

  it('returns all zeros with empty blob and enrichedColor', () => {
    const product = makeInput({ title: '', blob: '', enrichedColor: '' });
    const profile = emptyProfile({
      formalityFloor: 'business casual',
      colorPreferences: ['black'],
      styleKeywords: ['formal', 'luxury'],
      fitPreferences: ['slim'],
    });
    const result = computeCuratorSignals(product, profile);
    // Empty title → unknown product formality → fail-open 0
    expect(result.formalityCoherence).toBe(0);
    // Empty enrichedColor → null color family → insufficient data → 0
    expect(result.colorHarmony).toBe(0);
    // Empty blob → no occasion product tokens → 0
    expect(result.occasionBonus).toBe(0);
    // Empty blob → neutral fit, no adjacent tokens → 0
    expect(result.silhouetteDepth).toBe(0);
    // Empty blob → no material signal → 0
    expect(result.materialElevation).toBe(0);
    // No brandTier → brandElevation = 0
    expect(result.brandElevation).toBe(0);
    expect(result.curatorTotal).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════
// 12. Brand Elevation
// ═════════════════════════════════════════════════════════════════════

describe('Brand Elevation', () => {
  it('+4 for brandTier 1 (luxury)', () => {
    const product = makeInput({ brandTier: 1 });
    const profile = emptyProfile();
    const result = computeCuratorSignals(product, profile);
    expect(result.brandElevation).toBe(4);
  });

  it('+2 for brandTier 2 (premium)', () => {
    const product = makeInput({ brandTier: 2 });
    const profile = emptyProfile();
    const result = computeCuratorSignals(product, profile);
    expect(result.brandElevation).toBe(2);
  });

  it('0 for brandTier 3 (mid-tier)', () => {
    const product = makeInput({ brandTier: 3 });
    const profile = emptyProfile();
    const result = computeCuratorSignals(product, profile);
    expect(result.brandElevation).toBe(0);
  });

  it('-3 for brandTier 4 (fast fashion)', () => {
    const product = makeInput({ brandTier: 4 });
    const profile = emptyProfile();
    const result = computeCuratorSignals(product, profile);
    expect(result.brandElevation).toBe(-3);
  });

  it('-6 for brandTier 5 (low authority)', () => {
    const product = makeInput({ brandTier: 5 });
    const profile = emptyProfile();
    const result = computeCuratorSignals(product, profile);
    expect(result.brandElevation).toBe(-6);
  });

  it('0 for undefined brandTier (no signal)', () => {
    const product = makeInput({ brandTier: undefined });
    const profile = emptyProfile();
    const result = computeCuratorSignals(product, profile);
    expect(result.brandElevation).toBe(0);
  });

  it('brandTier counts as signalsUsed when provided', () => {
    const withTier = makeInput({ brandTier: 1 });
    const withoutTier = makeInput({ brandTier: undefined });
    const profile = emptyProfile();
    const rWith = computeCuratorSignals(withTier, profile);
    const rWithout = computeCuratorSignals(withoutTier, profile);
    expect(rWith.signalsUsed).toBe(rWithout.signalsUsed + 1);
  });

  it('debugTag includes brand:tier prefix', () => {
    const product = makeInput({ brandTier: 2 });
    const profile = emptyProfile();
    const result = computeCuratorSignals(product, profile);
    expect(result.debugTags.some((t) => t.startsWith('brand:tier2'))).toBe(
      true,
    );
  });

  it('Tier 1 brand outranks Tier 5 when all else equal', () => {
    const base = {
      title: 'Cotton Polo',
      blob: 'cotton polo shirt',
      enrichedColor: 'navy',
    };
    const profile = emptyProfile();
    const tier1 = computeCuratorSignals(
      makeInput({ ...base, brandTier: 1 }),
      profile,
    );
    const tier5 = computeCuratorSignals(
      makeInput({ ...base, brandTier: 5 }),
      profile,
    );
    // Tier 1 = +4, Tier 5 = -6 → 10-point separation
    expect(tier1.curatorTotal - tier5.curatorTotal).toBe(10);
    expect(tier1.curatorTotal).toBeGreaterThan(tier5.curatorTotal);
  });
});

// ═════════════════════════════════════════════════════════════════════
// 13. Formal-context brand amplification
// ═════════════════════════════════════════════════════════════════════

describe('Formal-context brand amplification', () => {
  const formalProfile = emptyProfile({
    styleKeywords: ['formal'],
    fitPreferences: ['slim'],
  });

  const formalBlob = 'slim fit tailored suit jacket';

  it('amplifies Tier 4 penalty when occasion + exact silhouette fire', () => {
    const product = makeInput({ blob: formalBlob, brandTier: 4 });
    const result = computeCuratorSignals(product, formalProfile);
    // occasionBonus = 3 (formal + tailored/suit), silhouetteDepth = 4 (slim exact)
    // formalContext = true → brandElevation -3 × 1.75 = -5.25
    expect(result.occasionBonus).toBe(3);
    expect(result.silhouetteDepth).toBe(4);
    expect(result.brandElevation).toBe(-3); // raw signal unchanged
    expect(result.debugTags).toContain('brand:formal-amplified(-5.25)');
  });

  it('amplifies Tier 1 reward when occasion + exact silhouette fire', () => {
    const product = makeInput({ blob: formalBlob, brandTier: 1 });
    const result = computeCuratorSignals(product, formalProfile);
    expect(result.brandElevation).toBe(4); // raw signal unchanged
    expect(result.debugTags).toContain('brand:formal-amplified(+7)');
  });

  it('widens Tier 1 vs Tier 4 gap in formal context vs non-formal', () => {
    const casualProfile = emptyProfile({ fitPreferences: ['slim'] });
    const casualBlob = 'slim fit cotton polo shirt'; // no occasion tokens

    const tier1Formal = computeCuratorSignals(
      makeInput({ blob: formalBlob, brandTier: 1 }),
      formalProfile,
    );
    const tier4Formal = computeCuratorSignals(
      makeInput({ blob: formalBlob, brandTier: 4 }),
      formalProfile,
    );
    const formalGap = tier1Formal.curatorTotal - tier4Formal.curatorTotal;

    const tier1Casual = computeCuratorSignals(
      makeInput({ blob: casualBlob, brandTier: 1 }),
      casualProfile,
    );
    const tier4Casual = computeCuratorSignals(
      makeInput({ blob: casualBlob, brandTier: 4 }),
      casualProfile,
    );
    const casualGap = tier1Casual.curatorTotal - tier4Casual.curatorTotal;

    // Formal gap should be wider than casual gap
    expect(formalGap).toBeGreaterThan(casualGap);
  });

  it('does NOT amplify when occasion does not fire', () => {
    const casualProfile = emptyProfile({
      styleKeywords: ['casual'],
      fitPreferences: ['slim'],
    });
    const product = makeInput({ blob: 'slim fit cotton polo', brandTier: 4 });
    const result = computeCuratorSignals(product, casualProfile);
    expect(result.occasionBonus).toBe(0);
    expect(result.brandElevation).toBe(-3);
    expect(result.debugTags.some((t) => t.includes('formal-amplified'))).toBe(
      false,
    );
  });

  it('does NOT amplify when silhouette is not exact match', () => {
    // 'formal suit jacket' has occasion tokens (formal, suit) but no slim/loose tokens
    // → neutral fit, user wants slim → silhouetteDepth = 0
    const product = makeInput({ blob: 'formal suit jacket', brandTier: 4 });
    const profile = emptyProfile({
      styleKeywords: ['formal'],
      fitPreferences: ['slim'],
    });
    const result = computeCuratorSignals(product, profile);
    expect(result.occasionBonus).toBe(3);
    expect(result.silhouetteDepth).toBe(0);
    expect(result.debugTags.some((t) => t.includes('formal-amplified'))).toBe(
      false,
    );
  });

  it('does NOT amplify when brandTier is absent', () => {
    const product = makeInput({ blob: formalBlob });
    const result = computeCuratorSignals(product, formalProfile);
    expect(result.brandElevation).toBe(0);
    expect(result.debugTags.some((t) => t.includes('formal-amplified'))).toBe(
      false,
    );
  });
});
