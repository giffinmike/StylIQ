// Copied verbatim from 7fd819b08:apps/backend-nest/src/wardrobe/logic/style.ts
// Part of the LEGACY FEB OUTFITS strict-containment path.
// Do not import from wardrobe/logic/*, wardrobe/studio/*, or ai/*.

// apps/backend-nest/src/wardrobe/logic/style.ts

import { isSlot } from './lf_categoryMapping';

// ───────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────
export type FitLevel = 'slim' | 'regular' | 'relaxed' | 'boxy';
export type BottomsFit = 'skinny' | 'slim' | 'straight' | 'wide';
export type ContrastTarget = 'low' | 'medium' | 'high';

export type UserStyle = {
  // 🎨 Color preferences
  preferredColors?: string[];
  avoidColors?: string[];

  // 👕 Categories
  preferredCategories?: string[];
  avoidSubcategories?: string[];

  // 🏷️ Brands
  favoriteBrands?: string[];

  // 👔 Dress code orientation
  dressBias?:
    | 'UltraCasual'
    | 'Casual'
    | 'SmartCasual'
    | 'BusinessCasual'
    | 'Business'
    | 'Formal';

  // ✨ Extended fields for stylist agents & DB parity
  name?: string;
  styleKeywords?: string[];
  fitPreferences?: string[];
  fabricPreferences?: string[];
  stylePreferences?: string[];
  occasions?: string[];
  personalityTraits?: string[];
  lifestyle?: string[]; // ✅ always array
  climate?: string;
  bodyType?: string;
  proportions?: string;
  skinTone?: string;
  undertone?: string;
  hairColor?: string;
  eyeColor?: string;
  fashionGoals?: string[]; // ✅ always array
  shoppingHabits?: string[]; // ✅ always array
  budgetLevel?: number; // e.g. 500, 1000
  confidence?: string; // e.g. "Very confident"

  // 🆕 Silhouette / fit
  topsFit?: FitLevel;
  bottomsFit?: BottomsFit;
  risePreference?: 'low' | 'mid' | 'high';
  trouserBreak?: 'none' | 'slight' | 'full';
  outerShoulder?: 'soft' | 'natural' | 'structured';

  // 🆕 Fabric / texture
  preferredFabrics?: string[];
  avoidFabrics?: string[];
  textureLevel?: 'low' | 'medium' | 'high';

  // 🆕 Pattern
  patternScale?: 'none' | 'micro' | 'medium' | 'bold';
  patternMaxCountPerOutfit?: number;

  // 🆕 Color logic
  palette?: { base?: string[]; accents?: string[]; metallic?: string[] };
  contrastTarget?: ContrastTarget;
  saturationTolerance?: 'low' | 'medium' | 'high';

  // 🆕 Pairing heuristics
  mustPair?: Record<string, string[]>; // subcat → must include one of…
  avoidPair?: Record<string, string[]>; // subcat → must NOT include any of…
  structureBalance?: boolean; // require 1 structured piece w/ streetwear
  layerTolerance?: 'none' | 'light' | 'heavy';

  // 🆕 Footwear & accessories nuance
  footwearLast?: 'sleek' | 'round' | 'chunky';
  beltRequiredWhen?: 'never' | 'dress shoes' | 'always';
  jewelryTolerance?: 'none' | 'minimal' | 'statement';

  // 🆕 Occasion / risk
  occasionWeights?: Partial<
    Record<'work' | 'gala' | 'weekend' | 'travel' | 'date' | 'wedding', number>
  >;
  riskAppetite?: 'low' | 'medium' | 'high';
  logoTolerance?: 'none' | 'discreet' | 'loud';

  // 🆕 Body/comfort & shopping gaps
  emphasize?: string[];
  deEmphasize?: string[];
  mobilityNeed?: 'low' | 'medium' | 'high';
  allowSubstitutions?: boolean;
  canonicalGrailList?: string[];
};

export type StyleWeights = {
  preferredColor: number;
  avoidColor: number;
  preferredCategory: number;
  avoidSubcategory: number;
  favoriteBrand: number;
  dressMatch: number; // reward for matching dress bias
  dressProximity: number; // reward for being close
  dressPenalty: number; // penalty for being far off

  // 🆕 extras (optional usage; low values so legacy behavior dominates)
  fitMatch?: number; // tops/bottoms fit alignment
  fabricMatch?: number; // preferred fabrics
  fabricAvoid?: number; // avoid fabrics
  patternScaleMatch?: number; // micro/medium/bold alignment
  contrastBonus?: number; // proximity to contrast target

  // 🆕 NEW gentle palette nudges
  paletteBaseBonus?: number; // hit style.palette.base
  paletteAccentBonus?: number; // hit style.palette.accents
  offPalettePenalty?: number; // neither base nor accent hit (soft)
};

export const DEFAULT_STYLE_WEIGHTS: StyleWeights = {
  preferredColor: 6,
  avoidColor: 8,
  preferredCategory: 4,
  avoidSubcategory: 7,
  favoriteBrand: 5,
  dressMatch: 6,
  dressProximity: 3,
  dressPenalty: 6,

  // 🆕 gentle defaults
  fitMatch: 2,
  fabricMatch: 2,
  fabricAvoid: 3,
  patternScaleMatch: 1,
  contrastBonus: 2,

  // 🆕 palette gentle nudges
  paletteBaseBonus: 2,
  paletteAccentBonus: 1,
  offPalettePenalty: 1,
};

export type Item = {
  main_category?: string;
  subcategory?: string;
  brand?: string;
  color?: string;
  color_family?: string;
  dress_code?: string;
  label?: string;

  // 🆕 optional fields (use if present)
  fabric?: string; // legacy name
  material?: string; // common in your catalog
  pattern?: 'none' | 'micro' | 'medium' | 'bold';
  fit?:
    | 'slim'
    | 'regular'
    | 'relaxed'
    | 'boxy'
    | 'skinny'
    | 'straight'
    | 'wide';
  structure?: 'soft' | 'natural' | 'structured';
  last_shape?: 'sleek' | 'round' | 'chunky'; // footwear last
};

// ───────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────
const t = (s: any) => (s ?? '').toString().trim().toLowerCase();
const STYLE_DEBUG = !!process.env.STYLE_DEBUG;

/** Case-insensitive, tolerant color hit */
function colorHits(itemColorLc: string, prefLc: string) {
  if (!itemColorLc || !prefLc) return false;
  return itemColorLc.includes(prefLc) || prefLc.includes(itemColorLc);
}

/** Map dress codes to numeric ranks for proximity scoring */
const DRESS_RANK: Record<string, number> = {
  ultracasual: 1,
  casual: 2,
  smartcasual: 3,
  businesscasual: 4,
  business: 5,
  formal: 6,
};

/** Rough contrast bucket if you don't have LAB—good enough for nudging */
export function roughContrastBucketFromColors(
  colors: string[],
): 'low' | 'medium' | 'high' {
  const c = colors.map(t);
  const hasBlack = c.some((x) => x.includes('black'));
  const hasWhite = c.some((x) => x.includes('white') || x.includes('ivory'));
  if (hasBlack && hasWhite) return 'high';
  const darks = c.filter((x) =>
    /(black|charcoal|navy|dark|ink)/.test(x),
  ).length;
  const lights = c.filter((x) =>
    /(white|ivory|beige|cream|light|stone)/.test(x),
  ).length;
  if (Math.abs(darks - lights) <= 1) return 'medium';
  return 'low';
}

/** Derive a pattern scale if missing by peeking at label text */
function derivePattern(item: Item): 'none' | 'micro' | 'medium' | 'bold' {
  if (item.pattern) return item.pattern;
  const lbl = t(item.label);
  // common tokens coming from your labels
  if (/\bpattern:solid\b/i.test(item.label ?? '') || /\bsolid\b/i.test(lbl))
    return 'none';
  if (/\bpattern:micro\b/i.test(item.label ?? '') || /\bmicro\b/i.test(lbl))
    return 'micro';
  if (
    /\bpattern:medium\b/i.test(item.label ?? '') ||
    /\b(check|stripe)\b/i.test(lbl)
  )
    return 'medium';
  if (
    /\bpattern:bold\b/i.test(item.label ?? '') ||
    /\b(hawaiian|floral|graphic)\b/i.test(lbl)
  )
    return 'bold';
  return 'none';
}

/** Soft check if item color hits any from a list */
function anyColorHit(itemColor: string, list?: string[]) {
  const L = (list ?? []).map(t);
  return !!(itemColor && L.some((c) => colorHits(itemColor, c)));
}

// ───────────────────────────────────────────────────────────────
/**
 * Scores a single item for a UserStyle.
 * Returns a normalized score in [0,1].
 * Backward-compatible: if new style fields are absent, extra signals are ignored.
 */
// ───────────────────────────────────────────────────────────────
export function scoreItemForStyle(
  item: Item,
  style: UserStyle | undefined,
  W: StyleWeights = DEFAULT_STYLE_WEIGHTS,
): number {
  if (!style) return 0;
  let rawScore = 0;
  let maxPossible = 0;

  const prefColors = (style.preferredColors ?? []).map(t);
  const badColors = (style.avoidColors ?? []).map(t);
  const prefCats = (style.preferredCategories ?? []).map(t);
  const badSubs = (style.avoidSubcategories ?? []).map(t);
  const favBrands = (style.favoriteBrands ?? []).map(t);
  const dressBiasLc = style.dressBias ? t(style.dressBias) : '';

  const color = t(item.color) || t(item.color_family);
  const cat = t(item.main_category);
  const sub = t(item.subcategory);
  const brand = t(item.brand);
  const dress = t(item.dress_code);

  // material/fabric alias (reads both)
  const materialLc = t(item.material) || t(item.fabric) || t(item.label);

  // derived pattern if missing
  const pattern = (item.pattern ?? derivePattern(item)).toLowerCase() as
    | 'none'
    | 'micro'
    | 'medium'
    | 'bold';

  const reasons: string[] = [];

  // Preferred colors
  if (prefColors.length && color) {
    maxPossible += W.preferredColor;
    if (prefColors.some((c) => colorHits(color, c))) {
      rawScore += W.preferredColor;
      reasons.push(`+${W.preferredColor} preferredColor:${color}`);
    }
  }

  // Avoid colors
  if (badColors.length && color) {
    maxPossible += W.avoidColor;
    if (badColors.some((c) => colorHits(color, c))) {
      rawScore -= W.avoidColor;
      reasons.push(`-${W.avoidColor} avoidColor:${color}`);
    }
  }

  // Palette nudges (gentle)
  if (style.palette && color) {
    const baseHit = anyColorHit(color, style.palette.base);
    const accentHit = anyColorHit(color, style.palette.accents);
    if (W.paletteBaseBonus && baseHit) {
      maxPossible += W.paletteBaseBonus;
      rawScore += W.paletteBaseBonus;
      reasons.push(`+${W.paletteBaseBonus} paletteBase:${color}`);
    } else if (W.paletteAccentBonus && accentHit) {
      maxPossible += W.paletteAccentBonus;
      rawScore += W.paletteAccentBonus;
      reasons.push(`+${W.paletteAccentBonus} paletteAccent:${color}`);
    } else if (
      W.offPalettePenalty &&
      (style.palette.base?.length || style.palette.accents?.length)
    ) {
      maxPossible += W.offPalettePenalty;
      rawScore -= W.offPalettePenalty; // soft nudge away from off-palette
      reasons.push(`-${W.offPalettePenalty} offPalette:${color || 'n/a'}`);
    }
  }

  // Preferred categories
  if (prefCats.length && cat) {
    maxPossible += W.preferredCategory;
    if (prefCats.includes(cat)) {
      rawScore += W.preferredCategory;
      reasons.push(`+${W.preferredCategory} preferredCat:${cat}`);
    }
  }

  // Avoid subcategories
  if (badSubs.length && sub) {
    maxPossible += W.avoidSubcategory;
    if (badSubs.includes(sub)) {
      rawScore -= W.avoidSubcategory;
      reasons.push(`-${W.avoidSubcategory} avoidSub:${sub}`);
    }
  }

  // Favorite brands
  if (favBrands.length && brand) {
    maxPossible += W.favoriteBrand;
    if (favBrands.includes(brand)) {
      rawScore += W.favoriteBrand;
      reasons.push(`+${W.favoriteBrand} brand:${brand}`);
    }
  }

  // Dress code bias with proximity + penalty
  if (dressBiasLc && dress) {
    const biasRank = DRESS_RANK[dressBiasLc] ?? 0;
    const itemRank = DRESS_RANK[t(dress)] ?? 0;
    if (biasRank && itemRank) {
      const dist = Math.abs(biasRank - itemRank);
      maxPossible += W.dressMatch;

      if (dist === 0) {
        rawScore += W.dressMatch;
        reasons.push(`+${W.dressMatch} dressMatch:${dress}`);
      } else if (dist === 1) {
        const prox = W.dressProximity ?? 0;
        rawScore += prox;
        maxPossible += prox;
        reasons.push(`+${prox} dressProximity:${dress}`);
      } else if (dist >= 3) {
        const pen = W.dressPenalty ?? 0;
        rawScore -= pen;
        maxPossible += pen;
        reasons.push(`-${pen} dressPenalty:${dress}`);
      }
    }
  }

  // ── NEW OPTIONAL SIGNALS ──────────────────────────────────────

  // Fit alignment (simple but effective)
  // Use canonical slot mapping for category detection
  if (W.fitMatch) {
    if (
      style.topsFit &&
      isSlot(item, 'tops') &&
      t(item.fit) === style.topsFit
    ) {
      maxPossible += W.fitMatch;
      rawScore += W.fitMatch;
      reasons.push(`+${W.fitMatch} fitMatch:tops=${t(item.fit)}`);
    }
    if (
      style.bottomsFit &&
      isSlot(item, 'bottoms') &&
      t(item.fit) === style.bottomsFit
    ) {
      maxPossible += W.fitMatch;
      rawScore += W.fitMatch;
      reasons.push(`+${W.fitMatch} fitMatch:bottoms=${t(item.fit)}`);
    }
  }

  // Fabric/material preferences (reads item.material OR item.fabric)
  if (materialLc) {
    if (
      W.fabricMatch &&
      (style.preferredFabrics ?? []).some((f) => materialLc.includes(t(f)))
    ) {
      maxPossible += W.fabricMatch;
      rawScore += W.fabricMatch;
      reasons.push(`+${W.fabricMatch} fabricMatch:${materialLc}`);
    }
    if (
      W.fabricAvoid &&
      (style.avoidFabrics ?? []).some((f) => materialLc.includes(t(f)))
    ) {
      maxPossible += W.fabricAvoid;
      rawScore -= W.fabricAvoid;
      reasons.push(`-${W.fabricAvoid} fabricAvoid:${materialLc}`);
    }
  }

  // Pattern scale alignment (with fallback from label)
  if (W.patternScaleMatch && style.patternScale) {
    const target = style.patternScale;
    // If user wants 'none', treat SOLID/MICRO as okay; lightly penalize 'bold'
    if (target === 'none') {
      maxPossible += W.patternScaleMatch;
      if (pattern === 'none' || pattern === 'micro') {
        rawScore += W.patternScaleMatch;
        reasons.push(`+${W.patternScaleMatch} pattern:none|micro`);
      } else if (pattern === 'bold') {
        rawScore -= W.patternScaleMatch; // gentle push away
        reasons.push(`-${W.patternScaleMatch} pattern:bold`);
      }
    } else if (pattern === target) {
      maxPossible += W.patternScaleMatch;
      rawScore += W.patternScaleMatch;
      reasons.push(`+${W.patternScaleMatch} patternScale:${pattern}`);
    }
  }

  // Footwear last alignment (tiny nudge)
  if (
    item.last_shape &&
    style.footwearLast &&
    t(item.last_shape) === style.footwearLast
  ) {
    rawScore += 0.5;
    maxPossible += 0.5;
    reasons.push(`+0.5 footwearLast:${t(item.last_shape)}`);
  }

  // Outer structure alignment (tiny nudge)
  if (
    item.structure &&
    style.outerShoulder &&
    t(item.structure) === style.outerShoulder
  ) {
    rawScore += 0.5;
    maxPossible += 0.5;
    reasons.push(`+0.5 structure:${t(item.structure)}`);
  }

  // Contrast proximity (small bonus if style specifies a target)
  if (style.contrastTarget && W.contrastBonus) {
    const colors = [item.color, item.color_family].filter(Boolean) as string[];
    if (colors.length) {
      const bucket = roughContrastBucketFromColors(colors);
      if (bucket === style.contrastTarget) {
        maxPossible += W.contrastBonus;
        rawScore += W.contrastBonus;
        reasons.push(`+${W.contrastBonus} contrast:${bucket}`);
      }
    }
  }

  // Normalize: map rawScore into [0,1]
  let norm = 0;
  if (maxPossible > 0) {
    const range = maxPossible * 2;
    const shifted = rawScore + maxPossible;
    norm = Math.max(0, Math.min(1, shifted / range));
  }

  if (STYLE_DEBUG) {
    const label =
      (item as any).label ||
      [item.main_category, item.subcategory].filter(Boolean).join(' / ') ||
      'Item';

    console.log(
      `[STYLE] ${label} raw=${rawScore.toFixed(2)} norm=${norm.toFixed(
        2,
      )} max=${maxPossible}`,
    );
  }

  return norm;
}

// ───────────────────────────────────────────────────────────────
// Outfit-level helpers (guardrails; optional to use)
// ───────────────────────────────────────────────────────────────
export type OutfitValidationResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'avoidPair'
        | 'mustPair'
        | 'patternMax'
        | 'structureBalance'
        | 'beltRule';
    };

export function validateOutfit(
  items: Item[],
  style?: UserStyle,
): OutfitValidationResult {
  if (!style) return { ok: true };

  const subs = items.map((i) => t(i.subcategory)).filter(Boolean);
  const map: Record<string, number> = {};
  subs.forEach((s) => (map[s] = (map[s] ?? 0) + 1));

  // avoidPair: any forbidden pairing present?
  if (style.avoidPair) {
    for (const [a, badList] of Object.entries(style.avoidPair)) {
      const aLc = t(a);
      if (!map[aLc]) continue;
      for (const b of badList) {
        if (map[t(b)]) return { ok: false, reason: 'avoidPair' };
      }
    }
  }

  // mustPair: if A is present, at least one of list must be present
  if (style.mustPair) {
    for (const [a, mustList] of Object.entries(style.mustPair)) {
      const aLc = t(a);
      if (!map[aLc]) continue;
      const satisfied = mustList.some((m) => map[t(m)]);
      if (!satisfied) return { ok: false, reason: 'mustPair' };
    }
  }

  // patternMaxCountPerOutfit
  const patterned = items.filter(
    (i) => (i.pattern ?? derivePattern(i)) !== 'none',
  ).length;
  const maxPat = style.patternMaxCountPerOutfit ?? Infinity;
  if (patterned > maxPat) return { ok: false, reason: 'patternMax' };

  // structureBalance: if streetwear present, require at least one structured piece
  if (style.structureBalance) {
    const hasStreet = subs.some((s) => ['hoodie', 'graphic tee'].includes(s));
    if (hasStreet) {
      const hasStructured =
        items.some((i) => i.structure === 'structured') ||
        subs.some((s) => s === 'blazer' || s === 'sport coat');
      if (!hasStructured) return { ok: false, reason: 'structureBalance' };
    }
  }

  // beltRequiredWhen
  if (
    style.beltRequiredWhen === 'always' ||
    style.beltRequiredWhen === 'dress shoes'
  ) {
    const hasDressShoes =
      subs.includes('dress shoes') ||
      subs.includes('oxfords') ||
      subs.includes('loafers');
    const hasBelt = subs.includes('belt');
    if (
      (style.beltRequiredWhen === 'always' && !hasBelt) ||
      (style.beltRequiredWhen === 'dress shoes' && hasDressShoes && !hasBelt)
    ) {
      return { ok: false, reason: 'beltRule' };
    }
  }

  return { ok: true };
}

/** Optional: outfit contrast distance (use with contrastTarget for a small bonus) */
export function contrastDistanceToTarget(
  items: Item[],
  target: ContrastTarget = 'medium',
): number {
  const colors = items
    .map((i) => i.color || i.color_family)
    .filter(Boolean) as string[];
  const bucket = roughContrastBucketFromColors(colors);
  const rank = { low: 0, medium: 1, high: 2 } as const;
  return -Math.abs(rank[bucket] - rank[target]); // 0 best, -1, -2 worse
}

/////////////////////

// KEEP BELOW AS IT WORKED BEFORE ENRICHING STLE AGENTS MORE

// // apps/backend-nest/src/wardrobe/logic/style.ts

// // ───────────────────────────────────────────────────────────────
// // Types
// // ───────────────────────────────────────────────────────────────
// export type FitLevel = 'slim' | 'regular' | 'relaxed' | 'boxy';
// export type BottomsFit = 'skinny' | 'slim' | 'straight' | 'wide';
// export type ContrastTarget = 'low' | 'medium' | 'high';

// export type UserStyle = {
//   // 🎨 Color preferences
//   preferredColors?: string[];
//   avoidColors?: string[];

//   // 👕 Categories
//   preferredCategories?: string[];
//   avoidSubcategories?: string[];

//   // 🏷️ Brands
//   favoriteBrands?: string[];

//   // 👔 Dress code orientation
//   dressBias?:
//     | 'UltraCasual'
//     | 'Casual'
//     | 'SmartCasual'
//     | 'BusinessCasual'
//     | 'Business'
//     | 'Formal';

//   // ✨ Extended fields for stylist agents & DB parity
//   name?: string;
//   styleKeywords?: string[];
//   personalityTraits?: string[];
//   lifestyle?: string[]; // ✅ always array
//   climate?: string;
//   bodyType?: string;
//   proportions?: string;
//   skinTone?: string;
//   undertone?: string;
//   hairColor?: string;
//   eyeColor?: string;
//   fashionGoals?: string[]; // ✅ always array
//   shoppingHabits?: string[]; // ✅ always array
//   budgetLevel?: number; // e.g. 500, 1000
//   confidence?: string; // e.g. "Very confident"

//   // 🆕 Silhouette / fit
//   topsFit?: FitLevel;
//   bottomsFit?: BottomsFit;
//   risePreference?: 'low' | 'mid' | 'high';
//   trouserBreak?: 'none' | 'slight' | 'full';
//   outerShoulder?: 'soft' | 'natural' | 'structured';

//   // 🆕 Fabric / texture
//   preferredFabrics?: string[];
//   avoidFabrics?: string[];
//   textureLevel?: 'low' | 'medium' | 'high';

//   // 🆕 Pattern
//   patternScale?: 'none' | 'micro' | 'medium' | 'bold';
//   patternMaxCountPerOutfit?: number;

//   // 🆕 Color logic
//   palette?: { base?: string[]; accents?: string[]; metallic?: string[] };
//   contrastTarget?: ContrastTarget;
//   saturationTolerance?: 'low' | 'medium' | 'high';

//   // 🆕 Pairing heuristics
//   mustPair?: Record<string, string[]>; // subcat → must include one of…
//   avoidPair?: Record<string, string[]>; // subcat → must NOT include any of…
//   structureBalance?: boolean; // require 1 structured piece w/ streetwear
//   layerTolerance?: 'none' | 'light' | 'heavy';

//   // 🆕 Footwear & accessories nuance
//   footwearLast?: 'sleek' | 'round' | 'chunky';
//   beltRequiredWhen?: 'never' | 'dress shoes' | 'always';
//   jewelryTolerance?: 'none' | 'minimal' | 'statement';

//   // 🆕 Occasion / risk
//   occasionWeights?: Partial<
//     Record<'work' | 'gala' | 'weekend' | 'travel' | 'date' | 'wedding', number>
//   >;
//   riskAppetite?: 'low' | 'medium' | 'high';
//   logoTolerance?: 'none' | 'discreet' | 'loud';

//   // 🆕 Body/comfort & shopping gaps
//   emphasize?: string[];
//   deEmphasize?: string[];
//   mobilityNeed?: 'low' | 'medium' | 'high';
//   allowSubstitutions?: boolean;
//   canonicalGrailList?: string[];
// };

// export type StyleWeights = {
//   preferredColor: number;
//   avoidColor: number;
//   preferredCategory: number;
//   avoidSubcategory: number;
//   favoriteBrand: number;
//   dressMatch: number; // reward for matching dress bias
//   dressProximity: number; // reward for being close
//   dressPenalty: number; // penalty for being far off

//   // 🆕 extras (optional usage; low values so legacy behavior dominates)
//   fitMatch?: number; // tops/bottoms fit alignment
//   fabricMatch?: number; // preferred fabrics
//   fabricAvoid?: number; // avoid fabrics
//   patternScaleMatch?: number; // micro/medium/bold alignment
//   contrastBonus?: number; // proximity to contrast target
// };

// export const DEFAULT_STYLE_WEIGHTS: StyleWeights = {
//   preferredColor: 6,
//   avoidColor: 8,
//   preferredCategory: 4,
//   avoidSubcategory: 7,
//   favoriteBrand: 5,
//   dressMatch: 6,
//   dressProximity: 3,
//   dressPenalty: 6,

//   // 🆕 gentle defaults
//   fitMatch: 2,
//   fabricMatch: 2,
//   fabricAvoid: 3,
//   patternScaleMatch: 1,
//   contrastBonus: 2,
// };

// export type Item = {
//   main_category?: string;
//   subcategory?: string;
//   brand?: string;
//   color?: string;
//   color_family?: string;
//   dress_code?: string;
//   label?: string;

//   // 🆕 optional fields (use if present)
//   fabric?: string; // "worsted wool", "cashmere", "jersey", …
//   pattern?: 'none' | 'micro' | 'medium' | 'bold';
//   fit?:
//     | 'slim'
//     | 'regular'
//     | 'relaxed'
//     | 'boxy'
//     | 'skinny'
//     | 'straight'
//     | 'wide';
//   structure?: 'soft' | 'natural' | 'structured';
//   last_shape?: 'sleek' | 'round' | 'chunky'; // footwear last
// };

// // ───────────────────────────────────────────────────────────────
// // Helpers
// // ───────────────────────────────────────────────────────────────
// const t = (s: any) => (s ?? '').toString().trim().toLowerCase();
// const STYLE_DEBUG = !!process.env.STYLE_DEBUG;

// /** Case-insensitive, tolerant color hit */
// function colorHits(itemColorLc: string, prefLc: string) {
//   if (!itemColorLc || !prefLc) return false;
//   return itemColorLc.includes(prefLc) || prefLc.includes(itemColorLc);
// }

// /** Map dress codes to numeric ranks for proximity scoring */
// const DRESS_RANK: Record<string, number> = {
//   ultracasual: 1,
//   casual: 2,
//   smartcasual: 3,
//   businesscasual: 4,
//   business: 5,
//   formal: 6,
// };

// /** Rough contrast bucket if you don't have LAB—good enough for nudging */
// export function roughContrastBucketFromColors(
//   colors: string[],
// ): 'low' | 'medium' | 'high' {
//   const c = colors.map(t);
//   const hasBlack = c.some((x) => x.includes('black'));
//   const hasWhite = c.some((x) => x.includes('white') || x.includes('ivory'));
//   if (hasBlack && hasWhite) return 'high';
//   const darks = c.filter((x) =>
//     /(black|charcoal|navy|dark|ink)/.test(x),
//   ).length;
//   const lights = c.filter((x) =>
//     /(white|ivory|beige|cream|light|stone)/.test(x),
//   ).length;
//   if (Math.abs(darks - lights) <= 1) return 'medium';
//   return 'low';
// }

// // ───────────────────────────────────────────────────────────────
// /**
//  * Scores a single item for a UserStyle.
//  * Returns a normalized score in [0,1].
//  * Backward-compatible: if new style fields are absent, extra signals are ignored.
//  */
// // ───────────────────────────────────────────────────────────────
// export function scoreItemForStyle(
//   item: Item,
//   style: UserStyle | undefined,
//   W: StyleWeights = DEFAULT_STYLE_WEIGHTS,
// ): number {
//   if (!style) return 0;
//   let rawScore = 0;
//   let maxPossible = 0;

//   const prefColors = (style.preferredColors ?? []).map(t);
//   const badColors = (style.avoidColors ?? []).map(t);
//   const prefCats = (style.preferredCategories ?? []).map(t);
//   const badSubs = (style.avoidSubcategories ?? []).map(t);
//   const favBrands = (style.favoriteBrands ?? []).map(t);
//   const dressBiasLc = style.dressBias ? t(style.dressBias) : '';

//   const color = t(item.color) || t(item.color_family);
//   const cat = t(item.main_category);
//   const sub = t(item.subcategory);
//   const brand = t(item.brand);
//   const dress = t(item.dress_code);

//   const reasons: string[] = [];

//   // Preferred colors
//   if (prefColors.length && color) {
//     maxPossible += W.preferredColor;
//     if (prefColors.some((c) => colorHits(color, c))) {
//       rawScore += W.preferredColor;
//       reasons.push(`+${W.preferredColor} preferredColor:${color}`);
//     }
//   }

//   // Avoid colors
//   if (badColors.length && color) {
//     maxPossible += W.avoidColor;
//     if (badColors.some((c) => colorHits(color, c))) {
//       rawScore -= W.avoidColor;
//       reasons.push(`-${W.avoidColor} avoidColor:${color}`);
//     }
//   }

//   // Preferred categories
//   if (prefCats.length && cat) {
//     maxPossible += W.preferredCategory;
//     if (prefCats.includes(cat)) {
//       rawScore += W.preferredCategory;
//       reasons.push(`+${W.preferredCategory} preferredCat:${cat}`);
//     }
//   }

//   // Avoid subcategories
//   if (badSubs.length && sub) {
//     maxPossible += W.avoidSubcategory;
//     if (badSubs.includes(sub)) {
//       rawScore -= W.avoidSubcategory;
//       reasons.push(`-${W.avoidSubcategory} avoidSub:${sub}`);
//     }
//   }

//   // Favorite brands
//   if (favBrands.length && brand) {
//     maxPossible += W.favoriteBrand;
//     if (favBrands.includes(brand)) {
//       rawScore += W.favoriteBrand;
//       reasons.push(`+${W.favoriteBrand} brand:${brand}`);
//     }
//   }

//   // Dress code bias with proximity + penalty
//   if (dressBiasLc && dress) {
//     const biasRank = DRESS_RANK[dressBiasLc] ?? 0;
//     const itemRank = DRESS_RANK[t(dress)] ?? 0;
//     if (biasRank && itemRank) {
//       const dist = Math.abs(biasRank - itemRank);
//       maxPossible += W.dressMatch;

//       if (dist === 0) {
//         rawScore += W.dressMatch;
//         reasons.push(`+${W.dressMatch} dressMatch:${dress}`);
//       } else if (dist === 1) {
//         const prox = W.dressProximity ?? 0;
//         rawScore += prox;
//         maxPossible += prox;
//         reasons.push(`+${prox} dressProximity:${dress}`);
//       } else if (dist >= 3) {
//         const pen = W.dressPenalty ?? 0;
//         rawScore -= pen;
//         maxPossible += pen;
//         reasons.push(`-${pen} dressPenalty:${dress}`);
//       }
//     }
//   }

//   // ── NEW OPTIONAL SIGNALS ──────────────────────────────────────
//   const fabric = t(item.fabric);
//   const pattern = (item.pattern ?? 'none').toLowerCase() as
//     | 'none'
//     | 'micro'
//     | 'medium'
//     | 'bold';
//   const fit = t(item.fit);
//   const structure = t(item.structure);
//   const lastShape = t(item.last_shape);

//   // Fit alignment (simple but effective)
//   if (W.fitMatch) {
//     if (
//       style.topsFit &&
//       item.main_category &&
//       t(item.main_category) === 'tops' &&
//       fit === style.topsFit
//     ) {
//       maxPossible += W.fitMatch;
//       rawScore += W.fitMatch;
//       reasons.push(`+${W.fitMatch} fitMatch:tops=${fit}`);
//     }
//     if (
//       style.bottomsFit &&
//       item.main_category &&
//       t(item.main_category) === 'bottoms' &&
//       fit === style.bottomsFit
//     ) {
//       maxPossible += W.fitMatch;
//       rawScore += W.fitMatch;
//       reasons.push(`+${W.fitMatch} fitMatch:bottoms=${fit}`);
//     }
//   }

//   // Fabric preferences
//   if (fabric) {
//     if (
//       W.fabricMatch &&
//       style.preferredFabrics?.some((f) => fabric.includes(t(f)))
//     ) {
//       maxPossible += W.fabricMatch;
//       rawScore += W.fabricMatch;
//       reasons.push(`+${W.fabricMatch} fabricMatch:${fabric}`);
//     }
//     if (
//       W.fabricAvoid &&
//       style.avoidFabrics?.some((f) => fabric.includes(t(f)))
//     ) {
//       maxPossible += W.fabricAvoid;
//       rawScore -= W.fabricAvoid;
//       reasons.push(`-${W.fabricAvoid} fabricAvoid:${fabric}`);
//     }
//   }

//   // Pattern scale alignment
//   if (W.patternScaleMatch && style.patternScale) {
//     const target = style.patternScale;
//     if (pattern === target) {
//       maxPossible += W.patternScaleMatch;
//       rawScore += W.patternScaleMatch;
//       reasons.push(`+${W.patternScaleMatch} patternScale:${pattern}`);
//     }
//   }

//   // Footwear last alignment (tiny nudge)
//   if (lastShape && style.footwearLast && lastShape === style.footwearLast) {
//     rawScore += 0.5;
//     maxPossible += 0.5;
//     reasons.push(`+0.5 footwearLast:${lastShape}`);
//   }

//   // Outer structure alignment (tiny nudge)
//   if (structure && style.outerShoulder && structure === style.outerShoulder) {
//     rawScore += 0.5;
//     maxPossible += 0.5;
//     reasons.push(`+0.5 structure:${structure}`);
//   }

//   // Normalize: map rawScore into [0,1]
//   let norm = 0;
//   if (maxPossible > 0) {
//     const range = maxPossible * 2;
//     const shifted = rawScore + maxPossible;
//     norm = Math.max(0, Math.min(1, shifted / range));
//   }

//   if (STYLE_DEBUG) {
//     const label =
//       item.label ||
//       [item.main_category, item.subcategory].filter(Boolean).join(' / ') ||
//       'Item';
//     console.log(
//       `[STYLE] ${label} raw=${rawScore.toFixed(2)} norm=${norm.toFixed(
//         2,
//       )} max=${maxPossible}`,
//     );
//   }

//   return norm;
// }

// // ───────────────────────────────────────────────────────────────
// // Outfit-level helpers (guardrails; optional to use)
// // ───────────────────────────────────────────────────────────────
// export type OutfitValidationResult =
//   | { ok: true }
//   | {
//       ok: false;
//       reason:
//         | 'avoidPair'
//         | 'mustPair'
//         | 'patternMax'
//         | 'structureBalance'
//         | 'beltRule';
//     };

// export function validateOutfit(
//   items: Item[],
//   style?: UserStyle,
// ): OutfitValidationResult {
//   if (!style) return { ok: true };

//   const subs = items.map((i) => t(i.subcategory)).filter(Boolean);
//   const map: Record<string, number> = {};
//   subs.forEach((s) => (map[s] = (map[s] ?? 0) + 1));

//   // avoidPair: any forbidden pairing present?
//   if (style.avoidPair) {
//     for (const [a, badList] of Object.entries(style.avoidPair)) {
//       const aLc = t(a);
//       if (!map[aLc]) continue;
//       for (const b of badList) {
//         if (map[t(b)]) return { ok: false, reason: 'avoidPair' };
//       }
//     }
//   }

//   // mustPair: if A is present, at least one of list must be present
//   if (style.mustPair) {
//     for (const [a, mustList] of Object.entries(style.mustPair)) {
//       const aLc = t(a);
//       if (!map[aLc]) continue;
//       const satisfied = mustList.some((m) => map[t(m)]);
//       if (!satisfied) return { ok: false, reason: 'mustPair' };
//     }
//   }

//   // patternMaxCountPerOutfit
//   const patterned = items.filter(
//     (i) => (i.pattern ?? 'none') !== 'none',
//   ).length;
//   const maxPat = style.patternMaxCountPerOutfit ?? Infinity;
//   if (patterned > maxPat) return { ok: false, reason: 'patternMax' };

//   // structureBalance: if streetwear present, require at least one structured piece
//   if (style.structureBalance) {
//     const hasStreet = subs.some((s) => ['hoodie', 'graphic tee'].includes(s));
//     if (hasStreet) {
//       const hasStructured =
//         items.some((i) => i.structure === 'structured') ||
//         subs.some((s) => s === 'blazer' || s === 'sport coat');
//       if (!hasStructured) return { ok: false, reason: 'structureBalance' };
//     }
//   }

//   // beltRequiredWhen
//   if (
//     style.beltRequiredWhen === 'always' ||
//     style.beltRequiredWhen === 'dress shoes'
//   ) {
//     const hasDressShoes =
//       subs.includes('dress shoes') ||
//       subs.includes('oxfords') ||
//       subs.includes('loafers');
//     const hasBelt = subs.includes('belt');
//     if (
//       (style.beltRequiredWhen === 'always' && !hasBelt) ||
//       (style.beltRequiredWhen === 'dress shoes' && hasDressShoes && !hasBelt)
//     ) {
//       return { ok: false, reason: 'beltRule' };
//     }
//   }

//   return { ok: true };
// }

// /** Optional: outfit contrast distance (use with contrastTarget for a small bonus) */
// export function contrastDistanceToTarget(
//   items: Item[],
//   target: ContrastTarget = 'medium',
// ): number {
//   const colors = items
//     .map((i) => i.color || i.color_family)
//     .filter(Boolean) as string[];
//   const bucket = roughContrastBucketFromColors(colors);
//   const rank = { low: 0, medium: 1, high: 2 } as const;
//   return -Math.abs(rank[bucket] - rank[target]); // 0 best, -1, -2 worse
// }
