/**
 * discover-veto.ts
 *
 * Hard elimination gate for Recommended Buys.
 * Pure function module: NO DB, NO LLM, NO async, NO state, NO randomness, NO Date.now().
 *
 * Every product candidate passes through applyDiscoverVeto() before scoring.
 * If vetoed the product is dropped with a machine-readable rule + human reason.
 */

// ─── Types ───────────────────────────────────────────────────────────

export interface VetoInput {
  title: string;
  blob: string; // pre-normalized text blob
  enrichedColor: string; // pre-normalized
  price: number | null;
  brand: string | null;
}

export interface VetoProfile {
  avoidColors: Set<string>;
  avoidMaterials: Set<string>;
  avoidPatterns: Set<string>;
  dislikedStyles: Set<string>;
  fitPreferences: string[];
  coverageNoGo: string[];
  walkabilityRequirement: string | null;
  formalityFloor: string | null;
  climate: string | null;
}

export interface VetoResult {
  vetoed: boolean;
  reason: string | null;
  rule: string | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────

/** Lowercase, strip non-alphanumeric (keep spaces), collapse whitespace, trim. */
export function normalizeForVeto(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Escape special regex characters in a string */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Word-boundary-safe token match: prevents "red" matching inside "tired" */
function wordBoundaryMatch(blob: string, token: string): boolean {
  return new RegExp(`\\b${escapeRegex(token)}\\b`).test(blob);
}

// ─── Formality ───────────────────────────────────────────────────────

/**
 * Maps formality-floor label strings to numeric ranks 1-9.
 * Used to compare user's floor preference against inferred product formality.
 */
export const FORMALITY_RANK_MAP: Record<string, number> = {
  athletic: 1,
  gym: 1,
  activewear: 1,
  casual: 2,
  streetwear: 2,
  lounge: 2,
  'smart casual': 3,
  weekend: 3,
  'business casual': 4,
  'office casual': 4,
  business: 5,
  professional: 5,
  'business formal': 6,
  cocktail: 6,
  formal: 7,
  evening: 7,
  gala: 7,
  'black tie': 8,
  'white tie': 9,
};

/**
 * Keyword list for inferring product formality from title text.
 * Ordered MOST-SPECIFIC-FIRST so multi-word phrases match before their
 * individual words (e.g. "business casual" before "business" or "casual").
 */
const FORMALITY_KEYWORDS: [string, number][] = [
  // ── Multi-word phrases first (most-specific-first) ──
  ['white tie', 9],
  ['black tie', 8],
  ['evening gown', 7],
  ['cocktail dress', 6],
  ['business formal', 6],
  ['dress pants', 5],
  ['dress shoes', 5],
  ['dress boots', 5],
  ['dress coat', 6],
  ['business casual', 4],
  ['smart casual', 3],
  ['dress shirt', 5],
  ['flip flops', 1],
  ['t shirt', 2],
  // ── Single-word keywords (highest rank first) ──
  ['tuxedo', 8],
  ['tux', 8],
  ['gala', 7],
  ['formal', 7],
  ['cocktail', 6],
  ['overcoat', 5],
  ['professional', 5],
  ['suit', 5],
  ['blazer', 5],
  ['business', 5],
  ['slacks', 4],
  ['blouse', 4],
  ['heels', 4],
  ['vest', 4],
  ['trousers', 4],
  ['office', 4],
  ['oxford', 4],
  ['boots', 3],
  ['flats', 3],
  ['cardigan', 3],
  ['khakis', 3],
  ['chino', 3],
  ['polo', 3],
  ['loafer', 3],
  ['pants', 3],
  ['pullover', 2],
  ['casual', 2],
  ['street', 2],
  ['hoodie', 2],
  ['jogger', 2],
  ['sneaker', 2],
  ['tee', 2],
  ['jeans', 2],
  ['shorts', 2],
  ['sweatshirt', 2],
  ['sandals', 2],
  ['athletic', 1],
  ['gym', 1],
  ['workout', 1],
  ['activewear', 1],
  ['training', 1],
  ['yoga', 1],
  ['sweatpants', 1],
];

/**
 * Infer product formality (1-9) from title keywords.
 * Returns null when no keyword matches (fail-open).
 */
export function inferProductFormality(title: string): number | null {
  const norm = normalizeForVeto(title);
  for (const [keyword, rank] of FORMALITY_KEYWORDS) {
    if (wordBoundaryMatch(norm, keyword)) return rank;
  }
  return null;
}

// ─── Loose-fit tokens ────────────────────────────────────────────────

const LOOSE_FIT_TOKENS = new Set([
  'oversized',
  'boxy',
  'baggy',
  'wide',
  'loose fit',
  'dropped shoulder',
  'relaxed',
  'relaxed fit',
  'wide leg',
  'wide fit',
]);

// ─── Coverage keyword mapping ────────────────────────────────────────

const COVERAGE_MAP: Record<string, string[]> = {
  midriff: ['crop top', 'cropped', 'midriff', 'belly'],
  leg: [
    'mini skirt',
    'micro',
    'thigh-high',
    'thigh high',
    'hot pants',
    'short shorts',
  ],
  shoulder: [
    'strapless',
    'off-shoulder',
    'off shoulder',
    'one-shoulder',
    'one shoulder',
  ],
  cleavage: ['plunging', 'low-cut', 'low cut', 'deep-v', 'deep v'],
  back: ['backless', 'open-back', 'open back'],
  sheer: ['sheer', 'transparent', 'see-through', 'see through'],
  spaghetti: ['spaghetti', 'thin-strap', 'thin strap'],
  halter: ['halter'],
};

// ─── Climate tokens ──────────────────────────────────────────────────

const HOT_CLIMATES = new Set(['hot', 'tropical', 'warm']);
const COLD_CLIMATES = new Set(['cold', 'freezing', 'winter']);

const HOT_VETO_TOKENS = [
  'wool',
  'fleece',
  'down',
  'heavy',
  'thermal',
  'insulated',
  'puffer',
  'sherpa',
  'fur',
];
const COLD_VETO_TOKENS = [
  'mesh',
  'sheer',
  'open-toe',
  'open toe',
  'sandal',
  'tank top',
  'sleeveless',
];

// ─── Non-apparel tokens (hard veto) ─────────────────────────────────

const NON_APPAREL_TOKENS = [
  'phone case',
  'iphone',
  'samsung case',
  'tablet',
  'laptop',
  'air freshener',
  'candle',
  'diffuser',
  'dog collar',
  'pet bed',
  'cat toy',
  'pet harness',
  'car seat',
  'floor mat',
  'car cover',
  'pillow',
  'pillowcase',
  'duvet',
  'comforter',
  'bed sheet',
  'curtain',
  'wall art',
  'poster',
  'sticker',
  'decal',
  'magnet',
  'mug',
  'tumbler',
  'water bottle',
  'lunch box',
  'notebook',
  'planner',
  'pen set',
  'action figure',
  'toy',
  'board game',
  'puzzle',
  'supplement',
  'vitamin',
  'protein powder',
  'gift card',
  'e gift',
];

// ─── Athletic material mix tokens ────────────────────────────────────

const ATHLETIC_MATERIALS = ['nylon', 'polyester', 'spandex'];
const FORMAL_TITLE_TOKENS = [
  'formal',
  'dress shirt',
  'blazer',
  'suit',
  'tuxedo',
];

// ─── Main veto function ──────────────────────────────────────────────

function pass(): VetoResult {
  return { vetoed: false, reason: null, rule: null };
}

function veto(rule: string, reason: string): VetoResult {
  return { vetoed: true, reason, rule };
}

/**
 * Apply all 11 hard-veto rules in priority order.
 * Returns on first match (short-circuit).
 *
 * Input blob and enrichedColor are expected to be pre-normalized.
 */
export function applyDiscoverVeto(
  product: VetoInput,
  profile: VetoProfile,
): VetoResult {
  const blob = product.blob;
  const normTitle = normalizeForVeto(product.title);

  // ── 0. VETO_NON_APPAREL ──────────────────────────────────────────
  for (const token of NON_APPAREL_TOKENS) {
    if (wordBoundaryMatch(blob, normalizeForVeto(token))) {
      return veto('VETO_NON_APPAREL', `Non-apparel item detected: "${token}"`);
    }
  }

  // ── 1. VETO_FIT ──────────────────────────────────────────────────
  const hasSlimPref = profile.fitPreferences.some((f) => {
    const n = normalizeForVeto(f);
    return n === 'slim' || n === 'tailored' || n === 'fitted';
  });
  if (hasSlimPref) {
    for (const token of LOOSE_FIT_TOKENS) {
      if (blob.includes(token)) {
        return veto(
          'VETO_FIT',
          `Loose-fit token "${token}" conflicts with slim/tailored preference`,
        );
      }
    }
  }

  // ── 2. VETO_COLOR ────────────────────────────────────────────────
  for (const color of profile.avoidColors) {
    if (product.enrichedColor === color || wordBoundaryMatch(blob, color)) {
      return veto('VETO_COLOR', `Avoided color "${color}" detected`);
    }
  }

  // ── 3. VETO_MATERIAL ─────────────────────────────────────────────
  for (const material of profile.avoidMaterials) {
    if (wordBoundaryMatch(blob, material)) {
      return veto('VETO_MATERIAL', `Avoided material "${material}" detected`);
    }
  }

  // ── 4. VETO_PATTERN ──────────────────────────────────────────────
  for (const pattern of profile.avoidPatterns) {
    if (wordBoundaryMatch(blob, pattern)) {
      return veto('VETO_PATTERN', `Avoided pattern "${pattern}" detected`);
    }
  }

  // ── 5. VETO_DISLIKED ─────────────────────────────────────────────
  for (const style of profile.dislikedStyles) {
    if (wordBoundaryMatch(blob, style)) {
      return veto('VETO_DISLIKED', `Disliked style "${style}" detected`);
    }
  }

  // ── 6. VETO_COVERAGE ─────────────────────────────────────────────
  for (const noGo of profile.coverageNoGo) {
    const normNoGo = normalizeForVeto(noGo);
    const mapped = COVERAGE_MAP[normNoGo];
    if (mapped) {
      for (const kw of mapped) {
        if (wordBoundaryMatch(blob, normalizeForVeto(kw))) {
          return veto(
            'VETO_COVERAGE',
            `Coverage no-go "${noGo}" triggered by "${kw}"`,
          );
        }
      }
    }
    // Fallback: direct word-boundary match on the no-go term itself
    if (wordBoundaryMatch(blob, normNoGo)) {
      return veto('VETO_COVERAGE', `Coverage no-go "${noGo}" directly matched`);
    }
  }

  // ── 7. VETO_WALKABILITY ──────────────────────────────────────────
  if (profile.walkabilityRequirement) {
    const walk = normalizeForVeto(profile.walkabilityRequirement);
    if (walk === 'high') {
      if (
        wordBoundaryMatch(blob, 'stiletto') ||
        wordBoundaryMatch(blob, 'platform') ||
        wordBoundaryMatch(blob, 'high heel') ||
        wordBoundaryMatch(blob, '5 inch') ||
        wordBoundaryMatch(blob, '5inch') ||
        wordBoundaryMatch(blob, '6 inch') ||
        wordBoundaryMatch(blob, '6inch')
      ) {
        return veto(
          'VETO_WALKABILITY',
          'Non-walkable shoe detected (high walkability required)',
        );
      }
    } else if (walk === 'medium') {
      if (wordBoundaryMatch(blob, 'stiletto')) {
        return veto(
          'VETO_WALKABILITY',
          'Stiletto detected (medium walkability required)',
        );
      }
    }
  }

  // ── 8. VETO_FORMALITY ────────────────────────────────────────────
  if (profile.formalityFloor) {
    const floorKey = normalizeForVeto(profile.formalityFloor);
    const floorRank = FORMALITY_RANK_MAP[floorKey];
    if (floorRank != null) {
      const productRank = inferProductFormality(product.title);
      // Fail-open: skip if no keywords matched
      if (productRank != null) {
        // 1-rank tolerance: only veto if 2+ ranks below
        if (productRank < floorRank - 1) {
          return veto(
            'VETO_FORMALITY',
            `Product formality ${productRank} is ${floorRank - productRank} ranks below floor "${profile.formalityFloor}" (${floorRank})`,
          );
        }
      }
    }
  }

  // ── 9. VETO_CLIMATE ──────────────────────────────────────────────
  if (profile.climate) {
    const clim = normalizeForVeto(profile.climate);
    if (HOT_CLIMATES.has(clim)) {
      for (const token of HOT_VETO_TOKENS) {
        if (wordBoundaryMatch(blob, normalizeForVeto(token))) {
          return veto(
            'VETO_CLIMATE',
            `Material/weight "${token}" unsuitable for hot climate`,
          );
        }
      }
    }
    if (COLD_CLIMATES.has(clim)) {
      for (const token of COLD_VETO_TOKENS) {
        if (wordBoundaryMatch(blob, normalizeForVeto(token))) {
          return veto(
            'VETO_CLIMATE',
            `Item "${token}" unsuitable for cold climate`,
          );
        }
      }
    }
  }

  // ── 10. VETO_MATERIAL_MIX ────────────────────────────────────────
  {
    const hasFormalTitle = FORMAL_TITLE_TOKENS.some((t) =>
      wordBoundaryMatch(normTitle, t),
    );
    if (hasFormalTitle) {
      const hasAthleticMaterial = ATHLETIC_MATERIALS.some((m) =>
        wordBoundaryMatch(blob, m),
      );
      if (hasAthleticMaterial) {
        return veto(
          'VETO_MATERIAL_MIX',
          'Athletic material in formal item title',
        );
      }
    }
  }

  return pass();
}
