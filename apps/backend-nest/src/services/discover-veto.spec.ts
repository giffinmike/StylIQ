import {
  normalizeForVeto,
  inferProductFormality,
  FORMALITY_RANK_MAP,
  applyDiscoverVeto,
  VetoInput,
  VetoProfile,
} from './discover-veto';

// ─── Helper: empty profile (no constraints → nothing vetoed) ─────────

function emptyProfile(overrides: Partial<VetoProfile> = {}): VetoProfile {
  return {
    avoidColors: new Set<string>(),
    avoidMaterials: new Set<string>(),
    avoidPatterns: new Set<string>(),
    dislikedStyles: new Set<string>(),
    fitPreferences: [],
    coverageNoGo: [],
    walkabilityRequirement: null,
    formalityFloor: null,
    climate: null,
    ...overrides,
  };
}

function makeInput(overrides: Partial<VetoInput> = {}): VetoInput {
  const title = overrides.title ?? 'Generic Item';
  const blob = overrides.blob ?? normalizeForVeto(title);
  return {
    title,
    blob,
    enrichedColor: overrides.enrichedColor ?? '',
    price: overrides.price ?? null,
    brand: overrides.brand ?? null,
  };
}

// ═════════════════════════════════════════════════════════════════════
// 1. inferProductFormality
// ═════════════════════════════════════════════════════════════════════

describe('inferProductFormality', () => {
  it('returns 1 for athletic titles', () => {
    expect(inferProductFormality('Nike Athletic Workout Gear')).toBe(1);
  });

  it('returns 1 for gym titles', () => {
    expect(inferProductFormality('Gym Workout Tank')).toBe(1);
  });

  it('returns 2 for casual titles', () => {
    expect(inferProductFormality('Casual Cotton Tee')).toBe(2);
  });

  it('returns 2 for hoodie', () => {
    expect(inferProductFormality('Oversized Hoodie Grey')).toBe(2);
  });

  it('returns 4 for business casual', () => {
    expect(inferProductFormality('Business Casual Chinos')).toBe(4);
  });

  it('returns 5 for business titles', () => {
    expect(inferProductFormality('Business Travel Suit Bag')).toBe(5);
  });

  it('returns 5 for blazer', () => {
    expect(inferProductFormality('Navy Wool Blazer')).toBe(5);
  });

  it('returns 7 for formal titles', () => {
    expect(inferProductFormality('Formal Evening Dress')).toBe(7);
  });

  it('returns 8 for black tie', () => {
    expect(inferProductFormality('Black Tie Tuxedo Jacket')).toBe(8);
  });

  it('returns 9 for white tie', () => {
    expect(inferProductFormality('White Tie Dress Shirt')).toBe(9);
  });

  it('returns null for unknown titles', () => {
    expect(inferProductFormality('Generic Accessory Thing')).toBeNull();
  });

  it('multi-word phrases match before single words', () => {
    // "business casual" (4) should match before "business" (5) or "casual" (2)
    expect(inferProductFormality('Business Casual Blazer')).toBe(4);
  });
});

// ═════════════════════════════════════════════════════════════════════
// 2. FORMALITY_RANK_MAP
// ═════════════════════════════════════════════════════════════════════

describe('FORMALITY_RANK_MAP', () => {
  it('maps casual to 2', () => {
    expect(FORMALITY_RANK_MAP['casual']).toBe(2);
  });

  it('maps business casual to 4', () => {
    expect(FORMALITY_RANK_MAP['business casual']).toBe(4);
  });

  it('maps formal to 7', () => {
    expect(FORMALITY_RANK_MAP['formal']).toBe(7);
  });

  it('maps black tie to 8', () => {
    expect(FORMALITY_RANK_MAP['black tie']).toBe(8);
  });

  it('maps white tie to 9', () => {
    expect(FORMALITY_RANK_MAP['white tie']).toBe(9);
  });
});

// ═════════════════════════════════════════════════════════════════════
// 3. normalizeForVeto
// ═════════════════════════════════════════════════════════════════════

describe('normalizeForVeto', () => {
  it('lowercases input', () => {
    expect(normalizeForVeto('HELLO WORLD')).toBe('hello world');
  });

  it('strips special characters', () => {
    expect(normalizeForVeto('Hello! @World#')).toBe('hello world');
  });

  it('collapses whitespace', () => {
    expect(normalizeForVeto('hello   world')).toBe('hello world');
  });

  it('trims leading/trailing spaces', () => {
    expect(normalizeForVeto('  hello  ')).toBe('hello');
  });

  it('handles hyphens by removing them', () => {
    expect(normalizeForVeto('off-shoulder')).toBe('offshoulder');
  });

  it('preserves digits', () => {
    expect(normalizeForVeto('Size 5 Inch Heel')).toBe('size 5 inch heel');
  });
});

// ═════════════════════════════════════════════════════════════════════
// 3b. makeInput helper: blob computed from title
// ═════════════════════════════════════════════════════════════════════

describe('makeInput helper', () => {
  it('computes blob from title via normalizeForVeto when blob not provided', () => {
    const input = makeInput({ title: 'Off-Shoulder Top!' });
    expect(input.blob).toBe(normalizeForVeto('Off-Shoulder Top!'));
    expect(input.blob).toBe('offshoulder top');
  });

  it('uses explicit blob when provided (no title override)', () => {
    const input = makeInput({ title: 'My Title', blob: 'custom blob' });
    expect(input.blob).toBe('custom blob');
  });

  it('does not let spread re-override computed blob', () => {
    // If we only provide title, blob should be derived from title, not from overrides spread
    const input = makeInput({ title: 'Off Shoulder Blouse' });
    expect(input.blob).toBe('off shoulder blouse');
    expect(input.title).toBe('Off Shoulder Blouse');
  });
});

// ═════════════════════════════════════════════════════════════════════
// 4. applyDiscoverVeto — all 10 rules
// ═════════════════════════════════════════════════════════════════════

// ── VETO_FIT ─────────────────────────────────────────────────────────

describe('VETO_FIT', () => {
  const slimProfile = emptyProfile({ fitPreferences: ['slim'] });

  it('blocks oversized when slim pref', () => {
    const input = makeInput({
      title: 'Oversized Cotton Jacket',
      blob: 'oversized cotton jacket',
    });
    const result = applyDiscoverVeto(input, slimProfile);
    expect(result.vetoed).toBe(true);
    expect(result.rule).toBe('VETO_FIT');
  });

  it('blocks baggy when tailored pref', () => {
    const profile = emptyProfile({ fitPreferences: ['tailored'] });
    const input = makeInput({ title: 'Baggy Jeans', blob: 'baggy jeans' });
    const result = applyDiscoverVeto(input, profile);
    expect(result.vetoed).toBe(true);
    expect(result.rule).toBe('VETO_FIT');
  });

  it('blocks relaxed fit when fitted pref', () => {
    const profile = emptyProfile({ fitPreferences: ['fitted'] });
    const input = makeInput({
      title: 'Relaxed Fit Chinos',
      blob: 'relaxed fit chinos',
    });
    const result = applyDiscoverVeto(input, profile);
    expect(result.vetoed).toBe(true);
    expect(result.rule).toBe('VETO_FIT');
  });

  it('blocks wide leg', () => {
    const input = makeInput({
      title: 'Wide Leg Pants',
      blob: 'wide leg pants',
    });
    const result = applyDiscoverVeto(input, slimProfile);
    expect(result.vetoed).toBe(true);
    expect(result.rule).toBe('VETO_FIT');
  });

  it('does NOT block slim items', () => {
    const input = makeInput({
      title: 'Slim Fit Cotton Polo',
      blob: 'slim fit cotton polo',
    });
    const result = applyDiscoverVeto(input, slimProfile);
    expect(result.vetoed).toBe(false);
  });

  it('does NOT block when no slim preference', () => {
    const profile = emptyProfile({ fitPreferences: ['relaxed'] });
    const input = makeInput({
      title: 'Oversized Hoodie',
      blob: 'oversized hoodie',
    });
    const result = applyDiscoverVeto(input, profile);
    expect(result.vetoed).toBe(false);
  });
});

// ── VETO_COLOR ───────────────────────────────────────────────────────

describe('VETO_COLOR', () => {
  it('blocks avoid color in blob', () => {
    const profile = emptyProfile({ avoidColors: new Set(['red']) });
    const input = makeInput({ title: 'Red Jacket', blob: 'red jacket cotton' });
    const result = applyDiscoverVeto(input, profile);
    expect(result.vetoed).toBe(true);
    expect(result.rule).toBe('VETO_COLOR');
  });

  it('blocks via enrichedColor exact match', () => {
    const profile = emptyProfile({ avoidColors: new Set(['red']) });
    const input = makeInput({
      title: 'Jacket',
      blob: 'jacket cotton',
      enrichedColor: 'red',
    });
    const result = applyDiscoverVeto(input, profile);
    expect(result.vetoed).toBe(true);
    expect(result.rule).toBe('VETO_COLOR');
  });

  it('does NOT false-positive "tired" for "red"', () => {
    const profile = emptyProfile({ avoidColors: new Set(['red']) });
    const input = makeInput({
      title: 'Tired Man Sweater',
      blob: 'tired man sweater',
    });
    const result = applyDiscoverVeto(input, profile);
    expect(result.vetoed).toBe(false);
  });

  it('does NOT false-positive "orange" for "range"', () => {
    const profile = emptyProfile({ avoidColors: new Set(['orange']) });
    const input = makeInput({ title: 'Range Finder', blob: 'range finder' });
    const result = applyDiscoverVeto(input, profile);
    expect(result.vetoed).toBe(false);
  });
});

// ── VETO_MATERIAL ────────────────────────────────────────────────────

describe('VETO_MATERIAL', () => {
  it('blocks avoid material', () => {
    const profile = emptyProfile({ avoidMaterials: new Set(['leather']) });
    const input = makeInput({
      title: 'Leather Jacket',
      blob: 'leather jacket',
    });
    const result = applyDiscoverVeto(input, profile);
    expect(result.vetoed).toBe(true);
    expect(result.rule).toBe('VETO_MATERIAL');
  });

  it('does NOT block non-matching material', () => {
    const profile = emptyProfile({ avoidMaterials: new Set(['silk']) });
    const input = makeInput({ title: 'Cotton Shirt', blob: 'cotton shirt' });
    const result = applyDiscoverVeto(input, profile);
    expect(result.vetoed).toBe(false);
  });
});

// ── VETO_PATTERN ─────────────────────────────────────────────────────

describe('VETO_PATTERN', () => {
  it('blocks avoid pattern', () => {
    const profile = emptyProfile({ avoidPatterns: new Set(['plaid']) });
    const input = makeInput({
      title: 'Plaid Flannel Shirt',
      blob: 'plaid flannel shirt',
    });
    const result = applyDiscoverVeto(input, profile);
    expect(result.vetoed).toBe(true);
    expect(result.rule).toBe('VETO_PATTERN');
  });

  it('does NOT block non-matching pattern', () => {
    const profile = emptyProfile({ avoidPatterns: new Set(['polka dot']) });
    const input = makeInput({ title: 'Striped Tee', blob: 'striped tee' });
    const result = applyDiscoverVeto(input, profile);
    expect(result.vetoed).toBe(false);
  });
});

// ── VETO_DISLIKED ────────────────────────────────────────────────────

describe('VETO_DISLIKED', () => {
  it('blocks disliked style', () => {
    const profile = emptyProfile({ dislikedStyles: new Set(['bohemian']) });
    const input = makeInput({
      title: 'Bohemian Maxi Dress',
      blob: 'bohemian maxi dress',
    });
    const result = applyDiscoverVeto(input, profile);
    expect(result.vetoed).toBe(true);
    expect(result.rule).toBe('VETO_DISLIKED');
  });

  it('does NOT block non-matching style', () => {
    const profile = emptyProfile({ dislikedStyles: new Set(['gothic']) });
    const input = makeInput({ title: 'Classic Polo', blob: 'classic polo' });
    const result = applyDiscoverVeto(input, profile);
    expect(result.vetoed).toBe(false);
  });
});

// ── VETO_COVERAGE ────────────────────────────────────────────────────

describe('VETO_COVERAGE', () => {
  it('blocks crop top when midriff is no-go', () => {
    const profile = emptyProfile({ coverageNoGo: ['midriff'] });
    const input = makeInput({ title: 'Crop Top', blob: 'crop top cotton' });
    const result = applyDiscoverVeto(input, profile);
    expect(result.vetoed).toBe(true);
    expect(result.rule).toBe('VETO_COVERAGE');
  });

  it('blocks cropped when midriff is no-go', () => {
    const profile = emptyProfile({ coverageNoGo: ['midriff'] });
    const input = makeInput({
      title: 'Cropped Sweater',
      blob: 'cropped sweater',
    });
    const result = applyDiscoverVeto(input, profile);
    expect(result.vetoed).toBe(true);
    expect(result.rule).toBe('VETO_COVERAGE');
  });

  it('blocks plunging when cleavage is no-go', () => {
    const profile = emptyProfile({ coverageNoGo: ['cleavage'] });
    const input = makeInput({
      title: 'Plunging Neckline Dress',
      blob: 'plunging neckline dress',
    });
    const result = applyDiscoverVeto(input, profile);
    expect(result.vetoed).toBe(true);
    expect(result.rule).toBe('VETO_COVERAGE');
  });

  it('blocks backless when back is no-go', () => {
    const profile = emptyProfile({ coverageNoGo: ['back'] });
    const input = makeInput({
      title: 'Backless Evening Gown',
      blob: 'backless evening gown',
    });
    const result = applyDiscoverVeto(input, profile);
    expect(result.vetoed).toBe(true);
    expect(result.rule).toBe('VETO_COVERAGE');
  });

  it('blocks strapless when shoulder is no-go', () => {
    const profile = emptyProfile({ coverageNoGo: ['shoulder'] });
    const input = makeInput({
      title: 'Strapless Dress',
      blob: 'strapless dress',
    });
    const result = applyDiscoverVeto(input, profile);
    expect(result.vetoed).toBe(true);
    expect(result.rule).toBe('VETO_COVERAGE');
  });

  it('blocks sheer when sheer is no-go', () => {
    const profile = emptyProfile({ coverageNoGo: ['sheer'] });
    const input = makeInput({ title: 'Sheer Blouse', blob: 'sheer blouse' });
    const result = applyDiscoverVeto(input, profile);
    expect(result.vetoed).toBe(true);
    expect(result.rule).toBe('VETO_COVERAGE');
  });

  it('blocks "off shoulder" (space-separated) when shoulder is no-go', () => {
    const profile = emptyProfile({ coverageNoGo: ['shoulder'] });
    const input = makeInput({ title: 'Off Shoulder Blouse' });
    const result = applyDiscoverVeto(input, profile);
    expect(result.vetoed).toBe(true);
    expect(result.rule).toBe('VETO_COVERAGE');
  });

  it('does NOT block regular top when midriff is no-go', () => {
    const profile = emptyProfile({ coverageNoGo: ['midriff'] });
    const input = makeInput({
      title: 'Classic Cotton Shirt',
      blob: 'classic cotton shirt',
    });
    const result = applyDiscoverVeto(input, profile);
    expect(result.vetoed).toBe(false);
  });

  it('fallback: direct match on unmapped no-go term', () => {
    const profile = emptyProfile({ coverageNoGo: ['midriff'] });
    // "midriff" is a mapped keyword under the midriff key, so it matches via map
    const input = makeInput({
      title: 'Midriff Baring Top',
      blob: 'midriff baring top',
    });
    const result = applyDiscoverVeto(input, profile);
    expect(result.vetoed).toBe(true);
    expect(result.rule).toBe('VETO_COVERAGE');
  });
});

// ── VETO_WALKABILITY ─────────────────────────────────────────────────

describe('VETO_WALKABILITY', () => {
  it('blocks stiletto when walkability=high', () => {
    const profile = emptyProfile({ walkabilityRequirement: 'high' });
    const input = makeInput({
      title: 'Stiletto Heels',
      blob: 'stiletto heels',
    });
    const result = applyDiscoverVeto(input, profile);
    expect(result.vetoed).toBe(true);
    expect(result.rule).toBe('VETO_WALKABILITY');
  });

  it('blocks platform when walkability=high', () => {
    const profile = emptyProfile({ walkabilityRequirement: 'high' });
    const input = makeInput({
      title: 'Platform Sandals',
      blob: 'platform sandals',
    });
    const result = applyDiscoverVeto(input, profile);
    expect(result.vetoed).toBe(true);
    expect(result.rule).toBe('VETO_WALKABILITY');
  });

  it('blocks high heel when walkability=high', () => {
    const profile = emptyProfile({ walkabilityRequirement: 'high' });
    const input = makeInput({
      title: 'High Heel Pumps',
      blob: 'high heel pumps',
    });
    const result = applyDiscoverVeto(input, profile);
    expect(result.vetoed).toBe(true);
    expect(result.rule).toBe('VETO_WALKABILITY');
  });

  it('does NOT block flats when walkability=high', () => {
    const profile = emptyProfile({ walkabilityRequirement: 'high' });
    const input = makeInput({ title: 'Ballet Flats', blob: 'ballet flats' });
    const result = applyDiscoverVeto(input, profile);
    expect(result.vetoed).toBe(false);
  });

  it('medium blocks stiletto but NOT platform', () => {
    const profile = emptyProfile({ walkabilityRequirement: 'medium' });
    const stiletto = makeInput({
      title: 'Stiletto Boots',
      blob: 'stiletto boots',
    });
    expect(applyDiscoverVeto(stiletto, profile).vetoed).toBe(true);

    const platform = makeInput({
      title: 'Platform Sneakers',
      blob: 'platform sneakers',
    });
    expect(applyDiscoverVeto(platform, profile).vetoed).toBe(false);
  });

  it('does NOT veto when walkability is null', () => {
    const profile = emptyProfile({ walkabilityRequirement: null });
    const input = makeInput({
      title: 'Stiletto Heels',
      blob: 'stiletto heels',
    });
    const result = applyDiscoverVeto(input, profile);
    expect(result.vetoed).toBe(false);
  });
});

// ── VETO_FORMALITY ───────────────────────────────────────────────────

describe('VETO_FORMALITY', () => {
  it('blocks athletic (1) when floor=business casual (4)', () => {
    const profile = emptyProfile({ formalityFloor: 'business casual' });
    const input = makeInput({
      title: 'Athletic Running Shorts',
      blob: 'athletic running shorts',
    });
    const result = applyDiscoverVeto(input, profile);
    expect(result.vetoed).toBe(true);
    expect(result.rule).toBe('VETO_FORMALITY');
  });

  it('allows business (5) when floor=business casual (4)', () => {
    const profile = emptyProfile({ formalityFloor: 'business casual' });
    const input = makeInput({
      title: 'Business Travel Blazer',
      blob: 'business travel blazer',
    });
    const result = applyDiscoverVeto(input, profile);
    expect(result.vetoed).toBe(false);
  });

  it('allows 1-rank-below (smart casual=3 with floor=business casual=4)', () => {
    const profile = emptyProfile({ formalityFloor: 'business casual' });
    const input = makeInput({
      title: 'Smart Casual Chinos',
      blob: 'smart casual chinos',
    });
    const result = applyDiscoverVeto(input, profile);
    expect(result.vetoed).toBe(false);
  });

  it('blocks 2-ranks-below (casual=2 with floor=business casual=4)', () => {
    const profile = emptyProfile({ formalityFloor: 'business casual' });
    const input = makeInput({ title: 'Casual Hoodie', blob: 'casual hoodie' });
    const result = applyDiscoverVeto(input, profile);
    expect(result.vetoed).toBe(true);
    expect(result.rule).toBe('VETO_FORMALITY');
  });

  it('skips when no keywords match (fail-open)', () => {
    const profile = emptyProfile({ formalityFloor: 'business casual' });
    const input = makeInput({
      title: 'Unknown Generic Accessory',
      blob: 'unknown generic accessory',
    });
    const result = applyDiscoverVeto(input, profile);
    expect(result.vetoed).toBe(false);
  });

  it('skips when formalityFloor is null', () => {
    const profile = emptyProfile({ formalityFloor: null });
    const input = makeInput({
      title: 'Athletic Gym Shorts',
      blob: 'athletic gym shorts',
    });
    const result = applyDiscoverVeto(input, profile);
    expect(result.vetoed).toBe(false);
  });
});

// ── VETO_CLIMATE ─────────────────────────────────────────────────────

describe('VETO_CLIMATE', () => {
  it('blocks wool in hot climate', () => {
    const profile = emptyProfile({ climate: 'hot' });
    const input = makeInput({ title: 'Wool Sweater', blob: 'wool sweater' });
    const result = applyDiscoverVeto(input, profile);
    expect(result.vetoed).toBe(true);
    expect(result.rule).toBe('VETO_CLIMATE');
  });

  it('blocks puffer in tropical climate', () => {
    const profile = emptyProfile({ climate: 'tropical' });
    const input = makeInput({ title: 'Puffer Jacket', blob: 'puffer jacket' });
    const result = applyDiscoverVeto(input, profile);
    expect(result.vetoed).toBe(true);
    expect(result.rule).toBe('VETO_CLIMATE');
  });

  it('blocks fleece in warm climate', () => {
    const profile = emptyProfile({ climate: 'warm' });
    const input = makeInput({
      title: 'Fleece Pullover',
      blob: 'fleece pullover',
    });
    const result = applyDiscoverVeto(input, profile);
    expect(result.vetoed).toBe(true);
    expect(result.rule).toBe('VETO_CLIMATE');
  });

  it('blocks sandals in cold climate', () => {
    const profile = emptyProfile({ climate: 'cold' });
    const input = makeInput({
      title: 'Open Toe Sandals',
      blob: 'open toe sandal',
    });
    const result = applyDiscoverVeto(input, profile);
    expect(result.vetoed).toBe(true);
    expect(result.rule).toBe('VETO_CLIMATE');
  });

  it('blocks sleeveless in freezing climate', () => {
    const profile = emptyProfile({ climate: 'freezing' });
    const input = makeInput({
      title: 'Sleeveless Top',
      blob: 'sleeveless top',
    });
    const result = applyDiscoverVeto(input, profile);
    expect(result.vetoed).toBe(true);
    expect(result.rule).toBe('VETO_CLIMATE');
  });

  it('blocks tank top in winter climate', () => {
    const profile = emptyProfile({ climate: 'winter' });
    const input = makeInput({ title: 'Tank Top', blob: 'tank top' });
    const result = applyDiscoverVeto(input, profile);
    expect(result.vetoed).toBe(true);
    expect(result.rule).toBe('VETO_CLIMATE');
  });

  it('blocks "open toe flip flops" in cold climate (no sandal keyword needed)', () => {
    const profile = emptyProfile({ climate: 'cold' });
    const input = makeInput({ title: 'Open Toe Flip Flops' });
    const result = applyDiscoverVeto(input, profile);
    expect(result.vetoed).toBe(true);
    expect(result.rule).toBe('VETO_CLIMATE');
  });

  it('allows cotton in hot climate', () => {
    const profile = emptyProfile({ climate: 'hot' });
    const input = makeInput({ title: 'Cotton Tee', blob: 'cotton tee' });
    const result = applyDiscoverVeto(input, profile);
    expect(result.vetoed).toBe(false);
  });

  it('allows wool boots in cold climate', () => {
    const profile = emptyProfile({ climate: 'cold' });
    const input = makeInput({ title: 'Wool Boots', blob: 'wool boots' });
    const result = applyDiscoverVeto(input, profile);
    expect(result.vetoed).toBe(false);
  });

  it('does NOT veto when climate is null', () => {
    const profile = emptyProfile({ climate: null });
    const input = makeInput({ title: 'Wool Sweater', blob: 'wool sweater' });
    const result = applyDiscoverVeto(input, profile);
    expect(result.vetoed).toBe(false);
  });
});

// ── VETO_MATERIAL_MIX ────────────────────────────────────────────────

describe('VETO_MATERIAL_MIX', () => {
  it('blocks polyester formal suit', () => {
    const profile = emptyProfile();
    const input = makeInput({
      title: 'Formal Suit Jacket',
      blob: 'formal suit jacket polyester',
    });
    const result = applyDiscoverVeto(input, profile);
    expect(result.vetoed).toBe(true);
    expect(result.rule).toBe('VETO_MATERIAL_MIX');
  });

  it('blocks nylon blazer', () => {
    const profile = emptyProfile();
    const input = makeInput({
      title: 'Classic Blazer',
      blob: 'classic blazer nylon',
    });
    const result = applyDiscoverVeto(input, profile);
    expect(result.vetoed).toBe(true);
    expect(result.rule).toBe('VETO_MATERIAL_MIX');
  });

  it('blocks spandex dress shirt', () => {
    const profile = emptyProfile();
    const input = makeInput({
      title: 'Dress Shirt',
      blob: 'dress shirt spandex',
    });
    const result = applyDiscoverVeto(input, profile);
    expect(result.vetoed).toBe(true);
    expect(result.rule).toBe('VETO_MATERIAL_MIX');
  });

  it('allows polyester athletic shorts (no formal title)', () => {
    const profile = emptyProfile();
    const input = makeInput({
      title: 'Athletic Shorts',
      blob: 'athletic shorts polyester',
    });
    const result = applyDiscoverVeto(input, profile);
    // Athletic shorts with polyester should NOT trigger VETO_MATERIAL_MIX
    // (title has no formal token)
    expect(result.rule).not.toBe('VETO_MATERIAL_MIX');
  });

  it('allows cotton formal suit', () => {
    const profile = emptyProfile();
    const input = makeInput({
      title: 'Formal Suit',
      blob: 'formal suit cotton',
    });
    const result = applyDiscoverVeto(input, profile);
    expect(result.vetoed).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════
// 5. Determinism test
// ═════════════════════════════════════════════════════════════════════

describe('Determinism: same input always produces same output', () => {
  it('produces identical VetoResult for identical inputs across 100 runs', () => {
    const profile = emptyProfile({
      avoidColors: new Set(['red', 'orange']),
      avoidMaterials: new Set(['leather']),
      fitPreferences: ['slim'],
      coverageNoGo: ['midriff'],
      walkabilityRequirement: 'high',
      formalityFloor: 'business casual',
      climate: 'hot',
    });

    const inputs: VetoInput[] = [
      makeInput({
        title: 'Oversized Red Hoodie',
        blob: 'oversized red hoodie cotton',
      }),
      makeInput({
        title: 'Slim Fit Navy Blazer',
        blob: 'slim fit navy blazer wool',
      }),
      makeInput({ title: 'Crop Top', blob: 'crop top cotton' }),
      makeInput({ title: 'Stiletto Heels', blob: 'stiletto heels' }),
      makeInput({
        title: 'Classic Polo Shirt',
        blob: 'classic polo shirt cotton',
      }),
    ];

    const firstRun = inputs.map((i) => applyDiscoverVeto(i, profile));
    for (let run = 0; run < 100; run++) {
      const thisRun = inputs.map((i) => applyDiscoverVeto(i, profile));
      expect(thisRun).toEqual(firstRun);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════
// 6. Expanded formality keywords
// ═════════════════════════════════════════════════════════════════════

describe('inferProductFormality — expanded keywords', () => {
  // Multi-word additions
  it('returns 5 for "dress pants"', () => {
    expect(inferProductFormality('Classic Dress Pants')).toBe(5);
  });

  it('returns 5 for "dress shoes"', () => {
    expect(inferProductFormality('Leather Dress Shoes')).toBe(5);
  });

  it('returns 5 for "dress boots"', () => {
    expect(inferProductFormality('Leather Dress Boots')).toBe(5);
  });

  it('returns 6 for "dress coat"', () => {
    expect(inferProductFormality('Wool Dress Coat')).toBe(6);
  });

  it('returns 1 for "flip flops"', () => {
    expect(inferProductFormality('Beach Flip Flops')).toBe(1);
  });

  // Single-word additions
  it('returns 5 for "overcoat"', () => {
    expect(inferProductFormality('Wool Overcoat')).toBe(5);
  });

  it('returns 4 for "slacks"', () => {
    expect(inferProductFormality('Charcoal Slacks')).toBe(4);
  });

  it('returns 4 for "blouse"', () => {
    expect(inferProductFormality('Silk Blouse')).toBe(4);
  });

  it('returns 4 for "heels"', () => {
    expect(inferProductFormality('Pointed Heels')).toBe(4);
  });

  it('returns 4 for "vest"', () => {
    expect(inferProductFormality('Quilted Vest')).toBe(4);
  });

  it('returns 3 for "boots"', () => {
    expect(inferProductFormality('Chelsea Boots')).toBe(3);
  });

  it('returns 3 for "flats"', () => {
    expect(inferProductFormality('Ballet Flats')).toBe(3);
  });

  it('returns 3 for "cardigan"', () => {
    expect(inferProductFormality('Merino Cardigan')).toBe(3);
  });

  it('returns 3 for "khakis"', () => {
    expect(inferProductFormality('Slim Khakis')).toBe(3);
  });

  it('returns 3 for "pants" (catch-all)', () => {
    expect(inferProductFormality('Linen Pants')).toBe(3);
  });

  it('returns 2 for "pullover"', () => {
    expect(inferProductFormality('Cotton Pullover')).toBe(2);
  });

  it('returns 2 for "shorts"', () => {
    expect(inferProductFormality('Cotton Shorts')).toBe(2);
  });

  it('returns 2 for "sweatshirt"', () => {
    expect(inferProductFormality('Crew Sweatshirt')).toBe(2);
  });

  it('returns 2 for "sandals"', () => {
    expect(inferProductFormality('Leather Sandals')).toBe(2);
  });

  // Multi-word ordering test
  it('"dress pants" matches 5 before catch-all "pants" at 3', () => {
    expect(inferProductFormality('Navy Dress Pants')).toBe(5);
  });

  // False-positive tests
  it('"sandalwood" does NOT match sandals', () => {
    expect(inferProductFormality('Sandalwood Cologne')).toBeNull();
  });

  it('"vestal" does NOT match vest', () => {
    expect(inferProductFormality('Vestal Watch')).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════
// 7. VETO_NON_APPAREL — Rule 0
// ═════════════════════════════════════════════════════════════════════

describe('VETO_NON_APPAREL', () => {
  const anyProfile = emptyProfile();

  it('vetoes "phone case"', () => {
    const input = makeInput({ title: 'iPhone 15 Phone Case Clear' });
    const result = applyDiscoverVeto(input, anyProfile);
    expect(result.vetoed).toBe(true);
    expect(result.rule).toBe('VETO_NON_APPAREL');
  });

  it('vetoes "dog collar"', () => {
    const input = makeInput({ title: 'Leather Dog Collar Large' });
    const result = applyDiscoverVeto(input, anyProfile);
    expect(result.vetoed).toBe(true);
    expect(result.rule).toBe('VETO_NON_APPAREL');
  });

  it('vetoes "wall art"', () => {
    const input = makeInput({ title: 'Abstract Wall Art Canvas' });
    const result = applyDiscoverVeto(input, anyProfile);
    expect(result.vetoed).toBe(true);
    expect(result.rule).toBe('VETO_NON_APPAREL');
  });

  it('vetoes "mug"', () => {
    const input = makeInput({ title: 'Ceramic Coffee Mug 12oz' });
    const result = applyDiscoverVeto(input, anyProfile);
    expect(result.vetoed).toBe(true);
    expect(result.rule).toBe('VETO_NON_APPAREL');
  });

  it('vetoes "pillow"', () => {
    const input = makeInput({ title: 'Throw Pillow Cover 18x18' });
    const result = applyDiscoverVeto(input, anyProfile);
    expect(result.vetoed).toBe(true);
    expect(result.rule).toBe('VETO_NON_APPAREL');
  });

  it('vetoes "gift card"', () => {
    const input = makeInput({ title: '$50 Gift Card' });
    const result = applyDiscoverVeto(input, anyProfile);
    expect(result.vetoed).toBe(true);
    expect(result.rule).toBe('VETO_NON_APPAREL');
  });

  it('vetoes "supplement"', () => {
    const input = makeInput({ title: 'Protein Supplement Powder' });
    const result = applyDiscoverVeto(input, anyProfile);
    expect(result.vetoed).toBe(true);
    expect(result.rule).toBe('VETO_NON_APPAREL');
  });

  it('does NOT veto normal apparel', () => {
    const input = makeInput({ title: 'Slim Fit Cotton Polo Shirt' });
    const result = applyDiscoverVeto(input, anyProfile);
    expect(result.rule).not.toBe('VETO_NON_APPAREL');
  });

  it('does NOT veto leather jacket (not "dog collar")', () => {
    const input = makeInput({ title: 'Leather Moto Jacket' });
    const result = applyDiscoverVeto(input, anyProfile);
    expect(result.rule).not.toBe('VETO_NON_APPAREL');
  });

  it('runs before other rules (Rule 0)', () => {
    // Even with avoid_colors set, non-apparel should veto first
    const profile = emptyProfile({ avoidColors: new Set(['red']) });
    const input = makeInput({ title: 'Red Phone Case' });
    const result = applyDiscoverVeto(input, profile);
    expect(result.vetoed).toBe(true);
    expect(result.rule).toBe('VETO_NON_APPAREL');
  });
});
