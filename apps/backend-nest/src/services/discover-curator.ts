/**
 * discover-curator.ts
 *
 * Curator scoring signals for Recommended Buys.
 * Pure function module: NO DB, NO LLM, NO async, NO state, NO randomness, NO Date.now().
 *
 * Each product that passes veto gets scored across 6 dimensions (formality,
 * color, occasion, silhouette, material, brand) to surface the best matches
 * for the user's style profile.
 */

import { inferProductFormality, FORMALITY_RANK_MAP } from './discover-veto';

// ─── Helpers ─────────────────────────────────────────────────────────

/** Word-boundary-safe token match: prevents "wide" matching inside "nationwide". */
function wordBoundary(blob: string, token: string): boolean {
  return new RegExp(
    `\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
  ).test(blob);
}

// ─── Types ───────────────────────────────────────────────────────────

export interface CuratorInput {
  title: string;
  blob: string; // pre-normalized text
  enrichedColor: string; // pre-normalized
  price: number | null;
  brand: string | null;
  inferredCategory: string | null;
  existingScore: number;
  existingBreakdown: Record<string, number>;
  brandTier?: number; // 1-5, null/undefined = no signal
}

export interface CuratorProfile {
  styleKeywords: string[];
  formalityFloor: string | null;
  silhouettePreference: string | null;
  climate: string | null;
  colorPreferences: string[];
  fitPreferences: string[];
}

export interface CuratorResult {
  formalityCoherence: number; // -8 to +4 (1-below = -6)
  colorHarmony: number; // -4 to +3
  occasionBonus: number; // 0 to +3
  silhouetteDepth: number; // -4 to +4
  materialElevation: number; // -3 to +3
  brandElevation: number; // -6 to +4
  confidenceScore: number; // 0.0 to 1.0
  signalsUsed: number;
  signalsAvailable: number;
  curatorTotal: number; // sum, clamped [-15, +15]
  debugTags: string[];
}

// ─── Color Family Classification ─────────────────────────────────────

type ColorFamily = 'neutral' | 'warm' | 'cool' | 'earth' | 'neon' | 'pastel';

const COLOR_FAMILY_MAP: Record<string, ColorFamily> = {
  // Neutrals
  black: 'neutral',
  white: 'neutral',
  gray: 'neutral',
  grey: 'neutral',
  charcoal: 'neutral',
  ivory: 'neutral',
  cream: 'neutral',
  beige: 'neutral',
  taupe: 'neutral',
  silver: 'neutral',

  // Warm
  red: 'warm',
  orange: 'warm',
  yellow: 'warm',
  gold: 'warm',
  coral: 'warm',
  rust: 'warm',
  burgundy: 'warm',
  maroon: 'warm',
  scarlet: 'warm',
  crimson: 'warm',
  amber: 'warm',
  copper: 'warm',

  // Cool
  blue: 'cool',
  navy: 'cool',
  teal: 'cool',
  cyan: 'cool',
  indigo: 'cool',
  cobalt: 'cool',
  sapphire: 'cool',
  aqua: 'cool',
  turquoise: 'cool',
  periwinkle: 'cool',

  // Earth
  brown: 'earth',
  tan: 'earth',
  olive: 'earth',
  khaki: 'earth',
  camel: 'earth',
  chocolate: 'earth',
  sienna: 'earth',
  terracotta: 'earth',
  sage: 'earth',
  moss: 'earth',
  forest: 'earth',

  // Neon
  neon: 'neon',
  'neon green': 'neon',
  'neon pink': 'neon',
  'neon yellow': 'neon',
  'neon orange': 'neon',
  'hot pink': 'neon',
  'electric blue': 'neon',
  fluorescent: 'neon',

  // Pastel
  'pastel pink': 'pastel',
  'pastel blue': 'pastel',
  'pastel green': 'pastel',
  'pastel yellow': 'pastel',
  lavender: 'pastel',
  lilac: 'pastel',
  blush: 'pastel',
  'baby blue': 'pastel',
  mauve: 'pastel',
  mint: 'pastel',
  peach: 'pastel',
  'rose gold': 'pastel',

  // Standalone colors that also map
  pink: 'warm',
  green: 'cool',
  purple: 'cool',
  magenta: 'warm',
  plum: 'cool',
  wine: 'warm',
};

/**
 * Classify a color string into a color family.
 * Returns null if the color is empty or unrecognized.
 */
export function classifyColorFamily(color: string): ColorFamily | null {
  if (!color || !color.trim()) return null;
  const norm = color.toLowerCase().trim();

  // Direct lookup first
  if (COLOR_FAMILY_MAP[norm] !== undefined) return COLOR_FAMILY_MAP[norm];

  // Check multi-word keys (e.g. "neon green" inside "bright neon green")
  // and single-word keys as substring tokens
  for (const [key, family] of Object.entries(COLOR_FAMILY_MAP)) {
    if (norm.includes(key)) return family;
  }

  return null;
}

// ─── Silhouette / Fit Classification ─────────────────────────────────

type FitClass = 'slim' | 'loose' | 'neutral';

const SLIM_TOKENS = [
  'slim fit',
  'skinny',
  'fitted',
  'tailored',
  'tapered',
  'form fitting',
  'slim',
];

const LOOSE_TOKENS = [
  'oversized',
  'boxy',
  'baggy',
  'wide leg',
  'loose',
  'relaxed',
  'dropped shoulder',
  'wide',
];

const ADJACENT_TOKENS = ['regular', 'straight', 'classic fit'];

const SLIM_PREF_KEYWORDS = ['slim', 'tailored', 'fitted', 'structured'];
const LOOSE_PREF_KEYWORDS = ['oversized', 'relaxed', 'loose', 'boxy'];

function classifyProductFit(blob: string): FitClass {
  for (const t of SLIM_TOKENS) {
    if (wordBoundary(blob, t)) return 'slim';
  }
  for (const t of LOOSE_TOKENS) {
    if (wordBoundary(blob, t)) return 'loose';
  }
  return 'neutral';
}

function classifyUserFitPref(
  fitPreferences: string[],
  silhouettePreference: string | null,
): 'slim' | 'loose' | null {
  const all = [...fitPreferences];
  if (silhouettePreference) all.push(silhouettePreference);

  const norm = all.map((s) => s.toLowerCase().trim());

  for (const n of norm) {
    if (SLIM_PREF_KEYWORDS.includes(n)) return 'slim';
  }
  for (const n of norm) {
    if (LOOSE_PREF_KEYWORDS.includes(n)) return 'loose';
  }
  return null;
}

function hasAdjacentTokens(blob: string): boolean {
  return ADJACENT_TOKENS.some((t) => wordBoundary(blob, t));
}

// ─── Material Tokens ─────────────────────────────────────────────────

const PREMIUM_MATERIALS = [
  'silk',
  'cashmere',
  'wool',
  'linen',
  'leather',
  'suede',
  'merino',
  'velvet',
  'satin',
];

const ATHLETIC_MATERIALS = [
  'polyester',
  'nylon',
  'spandex',
  'elastane',
  'mesh',
  'lycra',
];

const LUXURY_STYLE_KEYWORDS = [
  'luxury',
  'elegant',
  'sophisticated',
  'elevated',
  'refined',
  'premium',
];

// ─── Occasion Tokens ─────────────────────────────────────────────────

const OCCASION_STYLE_KEYWORDS = [
  'formal',
  'business',
  'elegant',
  'sophisticated',
  'black tie',
  'cocktail',
];

const OCCASION_PRODUCT_TOKENS = [
  'tailored',
  'dress',
  'blazer',
  'oxford',
  'loafer',
  'formal',
  'evening',
  'cocktail',
  'suit',
  'tuxedo',
];

// ─── Main Scoring Function ──────────────────────────────────────────

/**
 * Compute all 6 curator scoring signals for a product+profile pair.
 * Pure, deterministic, no side effects.
 */
export function computeCuratorSignals(
  product: CuratorInput,
  profile: CuratorProfile,
): CuratorResult {
  const debugTags: string[] = [];
  let signalsAvailable = 0;
  let signalsUsed = 0;

  // ── 1. Formality Coherence (-8 to +4) ──────────────────────────
  signalsAvailable++;
  let formalityCoherence = 0;
  if (profile.formalityFloor) {
    const floorKey = profile.formalityFloor.toLowerCase().trim();
    const floorRank = FORMALITY_RANK_MAP[floorKey];
    if (floorRank != null) {
      const productRank = inferProductFormality(product.title);
      if (productRank != null) {
        signalsUsed++;
        const gap = floorRank - productRank;
        if (gap <= 0) {
          // At or above floor
          formalityCoherence = 4;
          debugTags.push(`formality:at-or-above(${productRank}>=${floorRank})`);
        } else if (gap === 1) {
          formalityCoherence = -8;
          debugTags.push(
            `formality:1-below(${productRank},floor=${floorRank})`,
          );
        } else if (gap === 2) {
          formalityCoherence = 0;
          debugTags.push(
            `formality:2-below(${productRank},floor=${floorRank})`,
          );
        } else {
          // 3+ ranks below
          formalityCoherence = -8;
          debugTags.push(
            `formality:3+-below(${productRank},floor=${floorRank})`,
          );
        }
      } else {
        // Can't infer product formality → fail-open
        debugTags.push('formality:unknown-product');
      }
    } else {
      // Unknown floor label → fail-open
      debugTags.push('formality:unknown-floor');
    }
  } else {
    // No floor set → fail-open
    debugTags.push('formality:no-floor');
  }

  // ── 2. Color Harmony (-4 to +3) ────────────────────────────────
  signalsAvailable++;
  let colorHarmony = 0;
  const productColorFamily = classifyColorFamily(product.enrichedColor);
  const userColorFamilies = profile.colorPreferences
    .map((c) => classifyColorFamily(c))
    .filter((f): f is ColorFamily => f !== null);

  if (productColorFamily && userColorFamilies.length > 0) {
    signalsUsed++;
    if (
      productColorFamily === 'neutral' &&
      userColorFamilies.includes('neutral')
    ) {
      colorHarmony = 3;
      debugTags.push('color:neutral-match');
    } else if (userColorFamilies.includes(productColorFamily)) {
      colorHarmony = 2;
      debugTags.push(`color:family-match(${productColorFamily})`);
    } else if (
      productColorFamily === 'neon' &&
      profile.styleKeywords.some((k) => {
        const lk = k.toLowerCase();
        return lk === 'classic' || lk === 'elegant' || lk === 'sophisticated';
      })
    ) {
      colorHarmony = -4;
      debugTags.push('color:neon-vs-classic');
    } else {
      debugTags.push(`color:no-match(${productColorFamily})`);
    }
  } else {
    debugTags.push('color:insufficient-data');
  }

  // ── 3. Occasion Bonus (0 to +3) ────────────────────────────────
  signalsAvailable++;
  let occasionBonus = 0;
  const hasOccasionStyle = profile.styleKeywords.some((k) =>
    OCCASION_STYLE_KEYWORDS.includes(k.toLowerCase().trim()),
  );
  if (hasOccasionStyle) {
    const hasOccasionProduct = OCCASION_PRODUCT_TOKENS.some((t) =>
      wordBoundary(product.blob, t),
    );
    if (hasOccasionProduct) {
      signalsUsed++;
      occasionBonus = 3;
      debugTags.push('occasion:match');
    } else {
      debugTags.push('occasion:no-product-match');
    }
  } else {
    debugTags.push('occasion:no-style-keywords');
  }

  // ── 4. Silhouette Depth (-4 to +4) ─────────────────────────────
  signalsAvailable++;
  let silhouetteDepth = 0;
  const productFit = classifyProductFit(product.blob);
  const userFitPref = classifyUserFitPref(
    profile.fitPreferences,
    profile.silhouettePreference,
  );

  if (userFitPref) {
    signalsUsed++;
    if (productFit === userFitPref) {
      // Exact match
      silhouetteDepth = 4;
      debugTags.push(`silhouette:exact-match(${productFit})`);
    } else if (
      productFit === 'neutral' &&
      hasAdjacentTokens(product.blob) &&
      userFitPref === 'slim'
    ) {
      // Neutral with adjacent tokens, user wants slim → mild positive
      silhouetteDepth = 2;
      debugTags.push('silhouette:adjacent-slim');
    } else if (
      (productFit === 'slim' && userFitPref === 'loose') ||
      (productFit === 'loose' && userFitPref === 'slim')
    ) {
      // Direct conflict
      silhouetteDepth = -4;
      debugTags.push(
        `silhouette:conflict(product=${productFit},user=${userFitPref})`,
      );
    } else {
      // Neutral product, no adjacent tokens, or other combinations
      debugTags.push(
        `silhouette:neutral(product=${productFit},user=${userFitPref})`,
      );
    }
  } else {
    debugTags.push('silhouette:no-pref');
  }

  // ── 5. Material Elevation (-3 to +3) ───────────────────────────
  signalsAvailable++;
  let materialElevation = 0;
  const hasLuxuryStyle = profile.styleKeywords.some((k) =>
    LUXURY_STYLE_KEYWORDS.includes(k.toLowerCase().trim()),
  );
  if (hasLuxuryStyle) {
    const hasPremium = PREMIUM_MATERIALS.some((m) =>
      wordBoundary(product.blob, m),
    );
    const hasAthletic = ATHLETIC_MATERIALS.some((m) =>
      wordBoundary(product.blob, m),
    );
    if (hasPremium) {
      signalsUsed++;
      materialElevation = 3;
      debugTags.push('material:premium+luxury');
    } else if (hasAthletic) {
      signalsUsed++;
      materialElevation = -3;
      debugTags.push('material:athletic+luxury');
    } else {
      debugTags.push('material:luxury-no-signal');
    }
  } else {
    debugTags.push('material:no-luxury-style');
  }

  // ── 6. Brand Elevation (-4 to +2) ──────────────────────────────
  signalsAvailable++;
  let brandElevation = 0;
  if (product.brandTier != null) {
    signalsUsed++;
    switch (product.brandTier) {
      case 1:
        brandElevation = 4;
        break;
      case 2:
        brandElevation = 2;
        break;
      case 3:
        brandElevation = 0;
        break;
      case 4:
        brandElevation = -3;
        break;
      case 5:
        brandElevation = -6;
        break;
      default:
        brandElevation = 0;
    }
    debugTags.push(
      `brand:tier${product.brandTier}(${brandElevation >= 0 ? '+' : ''}${brandElevation})`,
    );
  } else {
    debugTags.push('brand:no-tier');
  }

  // ── 7. Confidence Score ────────────────────────────────────────
  const confidenceScore =
    signalsAvailable > 0 ? signalsUsed / signalsAvailable : 0;

  // ── Weight boost: silhouette + material get 1.5× authority ────
  const weightedSilhouette = +(silhouetteDepth * 1.5);
  const weightedMaterial = +(materialElevation * 1.5);

  // ── Formal-context brand amplification ─────────────────────────
  // When occasion + exact silhouette match both fire, brand authority
  // becomes the deciding lever — amplify its weight to prevent
  // low-tier brands from riding silhouette/occasion to the top.
  const formalContext = occasionBonus > 0 && silhouetteDepth >= 4;
  const weightedBrand = formalContext ? brandElevation * 1.75 : brandElevation;
  if (formalContext && brandElevation !== 0) {
    debugTags.push(
      `brand:formal-amplified(${weightedBrand >= 0 ? '+' : ''}${weightedBrand})`,
    );
  }

  // ── Clamp total ────────────────────────────────────────────────
  const rawTotal =
    formalityCoherence +
    colorHarmony +
    occasionBonus +
    weightedSilhouette +
    weightedMaterial +
    weightedBrand;
  const curatorTotal = Math.max(-15, Math.min(15, rawTotal));

  return {
    formalityCoherence,
    colorHarmony,
    occasionBonus,
    silhouetteDepth,
    materialElevation,
    brandElevation,
    confidenceScore,
    signalsUsed,
    signalsAvailable,
    curatorTotal,
    debugTags,
  };
}
