/**
 * Shoe compatibility refinement for Home Screen AI Suggestions.
 *
 * Runs after the API response is received, before outfits are set into
 * component state. Pure synchronous function with no side effects.
 *
 * Two independent passes:
 *   1. Color temperature — blocks shoes whose color clashes with outfit palette
 *   2. Style/formality  — blocks shoes whose archetype clashes with outfit context
 *
 * Only replaces a shoe when a clear mismatch is found AND a better alternative
 * exists in the user's wardrobe.
 */

// ---------------------------------------------------------------------------
// Types (compatible with AiStylistSuggestions local types)
// ---------------------------------------------------------------------------

type OutfitItem = {
  id: string;
  name: string;
  imageUrl: string;
  category: 'top' | 'bottom' | 'outerwear' | 'shoes' | 'accessory';
};

type OutfitSuggestion = {
  id: string;
  rank: number;
  summary: string;
  items: OutfitItem[];
  reasoning?: string;
};

type VisualResponse = {
  weatherSummary?: string;
  outfits: OutfitSuggestion[];
};

type TempGroup = 'neutral' | 'earth' | 'cool' | 'warm' | 'green';

// ---------------------------------------------------------------------------
// Color family → temperature group
// ---------------------------------------------------------------------------

const FAMILY_TO_TEMP: Record<string, TempGroup> = {
  Black: 'neutral',
  White: 'neutral',
  Gray: 'neutral',
  Beige: 'earth',
  Brown: 'earth',
  Blue: 'cool',
  Navy: 'cool',
  Purple: 'cool',
  Red: 'warm',
  Orange: 'warm',
  Yellow: 'warm',
  Green: 'green',
};

// ---------------------------------------------------------------------------
// Free-text color → colorFamily fallback
// Ordered so more-specific patterns match first.
// ---------------------------------------------------------------------------

const COLOR_TEXT_RULES: [RegExp, string][] = [
  [/navy|midnight|indigo/, 'Navy'],
  [/burgundy|maroon|wine|oxblood/, 'Red'],
  [/brown|chocolate|cognac|camel|chestnut|mahogany|walnut|espresso|mocha/, 'Brown'],
  [/beige|tan|cream|ivory|khaki|sand|ecru|taupe|oatmeal|buff|wheat|bone/, 'Beige'],
  [/black/, 'Black'],
  [/white|off-white/, 'White'],
  [/gr[ae]y|charcoal|silver|slate/, 'Gray'],
  [/blue|cobalt|royal|sky|denim|azure|cerulean|periwinkle/, 'Blue'],
  [/purple|violet|plum|lavender|mauve|lilac|eggplant|amethyst|fuchsia|magenta/, 'Purple'],
  [/teal|green|olive|sage|emerald|forest|mint|jade|lime|army|hunter|moss/, 'Green'],
  [/red|crimson|scarlet|cherry|ruby|pink|rose|blush/, 'Red'],
  [/orange|coral|terracotta|peach|salmon|tangerine|rust/, 'Orange'],
  [/yellow|gold|mustard|amber|lemon|saffron/, 'Yellow'],
];

// ---------------------------------------------------------------------------
// Color clash matrix
// ---------------------------------------------------------------------------

const SHOE_CLASHES: Record<TempGroup, TempGroup[]> = {
  cool: ['earth', 'warm'],
  warm: ['cool'],
  earth: [],
  neutral: [],
  green: [],
};

// ---------------------------------------------------------------------------
// Shoe archetype system
// ---------------------------------------------------------------------------

type ShoeArchetype =
  | 'dress'
  | 'smart-casual'
  | 'casual-sneaker'
  | 'rugged'
  | 'athletic'
  | 'minimal';

// SubCategory → archetype (case-insensitive lookup via lowercase keys)
const SUBCATEGORY_TO_ARCHETYPE: Record<string, ShoeArchetype> = {
  oxfords: 'dress',
  derbies: 'dress',
  'monk straps': 'dress',
  'dress shoes': 'dress',
  heels: 'dress',
  wedges: 'dress',
  platforms: 'dress',
  loafers: 'smart-casual',
  'chelsea boots': 'smart-casual',
  chukkas: 'smart-casual',
  'ankle boots': 'smart-casual',
  'thigh-high boots': 'smart-casual',
  mules: 'smart-casual',
  'boat shoes': 'smart-casual',
  flats: 'smart-casual',
  espadrilles: 'smart-casual',
  'knee-high boots': 'smart-casual',
  sneakers: 'casual-sneaker',
  'lifestyle sneakers': 'casual-sneaker',
  boots: 'rugged',
  'combat boots': 'rugged',
  'work boots': 'rugged',
  'hiking boots': 'rugged',
  'rain boots': 'rugged',
  'cowboy boots': 'rugged',
  'athletic sneakers': 'athletic',
  sandals: 'minimal',
  slides: 'minimal',
  clogs: 'minimal',
  slippers: 'minimal',
};

// Name-based fallback patterns (checked in order, more specific first)
const NAME_ARCHETYPE_RULES: [RegExp, ShoeArchetype][] = [
  [/work\s*boot|hiking\s*boot|lug\s*sole|military\s*boot|tactical|timber/, 'rugged'],
  [/combat\s*boot|cowboy|western\s*boot|rain\s*boot/, 'rugged'],
  [/running|training|athletic|sport|gym|cross.?fit/, 'athletic'],
  [/oxford|derby|dress\s*shoe|pump|heel|stiletto|brogue|monk\s*strap|wingtip/, 'dress'],
  [/chelsea|chukka|ankle\s*boot|loafer|moccasin|boat\s*shoe|flat|espadrille/, 'smart-casual'],
  [/sneaker|trainer/, 'casual-sneaker'],
  [/flip.?flop|slide|sandal|slipper|clog|mule/, 'minimal'],
  [/\bboot/, 'rugged'],
];

function resolveShoeArchetype(item: any): ShoeArchetype | null {
  const sub = (
    (item?.subCategory ?? item?.subcategory ?? '') as string
  ).toLowerCase().trim();

  if (sub && SUBCATEGORY_TO_ARCHETYPE[sub]) {
    return SUBCATEGORY_TO_ARCHETYPE[sub];
  }

  const name = ((item?.name ?? '') as string).toLowerCase();
  const combined = `${sub} ${name}`;

  for (const [re, archetype] of NAME_ARCHETYPE_RULES) {
    if (re.test(combined)) return archetype;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Outfit context detection
// ---------------------------------------------------------------------------

type OutfitContext =
  | 'formal'
  | 'business-casual'
  | 'casual'
  | 'rugged'
  | 'athletic'
  | 'unknown';

// Item-level formality signals from subCategory + name
const ITEM_CONTEXT_RULES: [RegExp, OutfitContext][] = [
  // Athletic (check first — "sport coat" is excluded by requiring boundary)
  [/legging|track\s*pant|sports?\s*bra|athletic\s*short|performance|moisture|compression|yoga\s*pant|jogger/, 'athletic'],
  // Formal
  [/\bblaz|suit\b|dress\s*pant|dress\s*shirt|\btie\b|pocket\s*square|sport\s*coat|tuxedo|waistcoat|\bvest\b|gown|formal/, 'formal'],
  // Business-casual
  [/chino|slacks|trouser|\bpolo\b|cardigan|sweater|blouse|pencil\s*skirt|khaki|button.?down|dress\s*skirt|pullover|turtleneck|crew\s*neck|knit|v.?neck|mock.?neck|quarter.?zip/, 'business-casual'],
  // Rugged / workwear
  [/flannel|denim\s*jacket|work\s*jacket|overall|cargo\s*pant|utility|canvas|barn\s*coat|field\s*jacket|wax/, 'rugged'],
  // Casual
  [/t.?shirt|jeans|\bshort|hoodie|sweatshirt|tank\s*top|graphic|crop\s*top|henley|jersey|denim(?!\s*jacket)|hawaiian|camp\s*shirt|aloha|bowling\s*shirt/, 'casual'],
];

const DRESS_CODE_TO_CONTEXT: Record<string, OutfitContext> = {
  BlackTie: 'formal',
  Business: 'formal',
  BusinessCasual: 'business-casual',
  SmartCasual: 'business-casual',
  Casual: 'casual',
  UltraCasual: 'casual',
};

function classifyItemContext(item: any): OutfitContext | null {
  // Primary: dressCode field (authoritative when present)
  const dc: string | undefined = item?.dressCode ?? item?.dress_code;
  if (dc && DRESS_CODE_TO_CONTEXT[dc]) {
    return DRESS_CODE_TO_CONTEXT[dc];
  }

  // Fallback: subcategory + name regex matching
  const sub = (
    (item?.subCategory ?? item?.subcategory ?? '') as string
  ).toLowerCase();
  const name = ((item?.name ?? '') as string).toLowerCase();
  const combined = `${sub} ${name}`;

  for (const [re, ctx] of ITEM_CONTEXT_RULES) {
    if (re.test(combined)) return ctx;
  }

  return null;
}

// Adjacency: contexts that are "close enough" merge to the more permissive one
const CONTEXT_ADJACENCY: Record<string, OutfitContext> = {
  'formal+business-casual': 'business-casual',
  'business-casual+formal': 'business-casual',
  'business-casual+casual': 'casual',
  'casual+business-casual': 'casual',
};

function resolveOutfitContext(
  outfitItems: OutfitItem[],
  wardrobeMap: Map<string, any>,
): OutfitContext {
  const counts: Record<OutfitContext, number> = {
    formal: 0,
    'business-casual': 0,
    casual: 0,
    rugged: 0,
    athletic: 0,
    unknown: 0,
  };

  let classified = 0;

  for (const oi of outfitItems) {
    if (oi.category === 'shoes') continue;
    const full = wardrobeMap.get(oi.id);
    if (!full) continue;

    const ctx = classifyItemContext(full);
    if (!ctx) continue;

    counts[ctx]++;
    classified++;
  }

  if (classified < 1) return 'unknown';

  // Find top two contexts
  const ranked = (
    ['formal', 'business-casual', 'casual', 'rugged', 'athletic'] as OutfitContext[]
  )
    .map((c) => ({ctx: c, count: counts[c]}))
    .sort((a, b) => b.count - a.count);

  const first = ranked[0];
  const second = ranked[1];

  if (first.count === 0) return 'unknown';

  // Clear majority
  if (first.count > classified - first.count) return first.ctx;

  // Tie or close — check adjacency
  if (second.count > 0) {
    const key = `${first.ctx}+${second.ctx}`;
    if (CONTEXT_ADJACENCY[key]) return CONTEXT_ADJACENCY[key];
  }

  // Mixed non-adjacent → unknown (conservative)
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Style compatibility matrix
//
// BLOCK = clear mismatch → attempt replacement
// true  = allowed (PASS or borderline pass*)
// ---------------------------------------------------------------------------

const STYLE_COMPAT: Record<ShoeArchetype, Record<OutfitContext, boolean>> = {
  dress: {
    formal: true,
    'business-casual': true,
    casual: false, // dress shoes clash with casual (jeans, tees, Hawaiian shirts)
    rugged: false,
    athletic: false,
    unknown: true,
  },
  'smart-casual': {
    formal: true, // borderline but allowed
    'business-casual': true,
    casual: true,
    rugged: true, // borderline but allowed
    athletic: false,
    unknown: true,
  },
  'casual-sneaker': {
    formal: false,
    'business-casual': true, // borderline but allowed
    casual: true,
    rugged: true,
    athletic: true, // borderline but allowed
    unknown: true,
  },
  rugged: {
    formal: false,
    'business-casual': false,
    casual: true, // borderline but allowed
    rugged: true,
    athletic: false,
    unknown: false,
  },
  athletic: {
    formal: false,
    'business-casual': false,
    casual: true, // borderline but allowed
    rugged: false,
    athletic: true,
    unknown: false,
  },
  minimal: {
    formal: false,
    'business-casual': false,
    casual: true,
    rugged: false,
    athletic: true, // borderline but allowed
    unknown: true,
  },
};

// Ideal archetype(s) for each outfit context (used for replacement scoring)
const IDEAL_ARCHETYPES: Record<OutfitContext, ShoeArchetype[]> = {
  formal: ['dress'],
  'business-casual': ['smart-casual', 'dress'],
  casual: ['casual-sneaker', 'smart-casual'],
  rugged: ['rugged', 'casual-sneaker'],
  athletic: ['athletic', 'casual-sneaker'],
  unknown: [],
};

// ---------------------------------------------------------------------------
// Color helpers (unchanged from original)
// ---------------------------------------------------------------------------

function resolveTempFromText(text: string): TempGroup | null {
  const lc = text.toLowerCase();
  for (const [re, fam] of COLOR_TEXT_RULES) {
    if (re.test(lc)) return FAMILY_TO_TEMP[fam] ?? null;
  }
  return null;
}

const COLOR_TEMP_MAP: Record<string, TempGroup> = {
  Warm: 'warm',
  Cool: 'cool',
  Neutral: 'neutral',
};

function resolveTemp(item: any): TempGroup | null {
  // 1. Explicit colorFamily (most precise)
  const family: string | undefined = item?.colorFamily ?? item?.color_family;
  if (family && FAMILY_TO_TEMP[family]) {
    return FAMILY_TO_TEMP[family];
  }

  // 2. Free-text color field
  const raw: string | undefined = item?.color;
  if (raw) {
    const fromColor = resolveTempFromText(raw);
    if (fromColor) return fromColor;
  }

  // 3. colorTemp field (coarse but useful — loses earth/green distinction)
  const ct: string | undefined = item?.colorTemp ?? item?.color_temp;
  if (ct && COLOR_TEMP_MAP[ct]) {
    return COLOR_TEMP_MAP[ct];
  }

  // 4. Item name / aiTitle as last resort
  const name: string | undefined =
    item?.name ?? item?.aiTitle ?? item?.ai_title;
  if (name) {
    const fromName = resolveTempFromText(name);
    if (fromName) return fromName;
  }

  return null;
}

/**
 * Extract all distinct temp groups from a shoe's color/name fields.
 * Catches multi-color shoes like "green & white leather sneakers" that
 * resolve to a single primary temp but hide a chromatic accent.
 */
function resolveAllShoeTemps(item: any): TempGroup[] {
  const temps = new Set<TempGroup>();

  // Primary temp (same as resolveTemp)
  const primary = resolveTemp(item);
  if (primary) temps.add(primary);

  // Scan color + name text for additional color tokens
  const colorText: string = (item?.color ?? '') as string;
  const nameText: string =
    (item?.name ?? item?.aiTitle ?? item?.ai_title ?? '') as string;
  const combined = `${colorText} ${nameText}`.toLowerCase();

  for (const [re, fam] of COLOR_TEXT_RULES) {
    if (re.test(combined)) {
      const t = FAMILY_TO_TEMP[fam];
      if (t) temps.add(t);
    }
  }

  return Array.from(temps);
}

function outfitDominantTemp(
  outfitItems: OutfitItem[],
  wardrobeMap: Map<string, any>,
): TempGroup | null {
  const counts: Record<TempGroup, number> = {
    neutral: 0,
    earth: 0,
    cool: 0,
    warm: 0,
    green: 0,
  };

  let chromatic = 0;

  for (const oi of outfitItems) {
    if (oi.category === 'shoes') continue;
    const full = wardrobeMap.get(oi.id);
    if (!full) continue;

    const temp = resolveTemp(full);
    if (!temp) continue;

    counts[temp]++;
    if (temp !== 'neutral') chromatic++;
  }

  if (chromatic < 1) return null;

  let best: TempGroup | null = null;
  let bestCount = 0;
  for (const g of ['earth', 'cool', 'warm', 'green'] as TempGroup[]) {
    if (counts[g] > bestCount) {
      bestCount = counts[g];
      best = g;
    }
  }

  if (!best) return null;

  const otherChromatic = chromatic - bestCount;
  if (bestCount <= otherChromatic) return null;

  return best;
}

// ---------------------------------------------------------------------------
// Mismatch detection
// ---------------------------------------------------------------------------

type MismatchReason = 'color' | 'style' | 'both';

function detectMismatch(
  shoeFull: any,
  shoeTemp: TempGroup | null,
  shoeArchetype: ShoeArchetype | null,
  outfitItems: OutfitItem[],
  wardrobeMap: Map<string, any>,
): {reason: MismatchReason; outfitCtx: OutfitContext; dominant: TempGroup | null} | null {
  let colorClash = false;
  let styleClash = false;

  // --- Color check ---
  // Primary: set-based foreign chromatic check. A non-neutral, non-earth shoe
  // must match at least one chromatic group already present in the outfit.
  const dominant = outfitDominantTemp(outfitItems, wardrobeMap);

  if (shoeTemp && shoeTemp !== 'neutral' && shoeTemp !== 'earth') {
    const outfitGroups = new Set<TempGroup>();
    for (const oi of outfitItems) {
      if (oi.category === 'shoes') continue;
      const full = wardrobeMap.get(oi.id);
      if (!full) continue;
      const t = resolveTemp(full);
      if (t && t !== 'neutral') outfitGroups.add(t);
    }
    if (outfitGroups.size > 0 && !outfitGroups.has(shoeTemp)) {
      colorClash = true;
    }

    // Secondary: SHOE_CLASHES matrix for known strong clashes (belt-and-suspenders)
    if (!colorClash && dominant) {
      const clashTargets = SHOE_CLASHES[shoeTemp];
      if (clashTargets.includes(dominant)) {
        colorClash = true;
      }
    }

    // Bottom–shoe harmony: chromatic shoes must match the bottom garment's
    // color temperature. Catches cases like brown chinos + blue dress shoes
    // that the overall-palette check misses when the top shares the shoe color.
    if (!colorClash) {
      const bottomOi = outfitItems.find(i => i.category === 'bottom');
      if (bottomOi) {
        const bottomFull = wardrobeMap.get(bottomOi.id);
        if (bottomFull) {
          const bottomTemp = resolveTemp(bottomFull);
          if (bottomTemp && bottomTemp !== 'neutral' && shoeTemp !== bottomTemp) {
            colorClash = true;
          }
        }
      }
    }
  }

  // --- Multi-color accent check ---
  // A shoe whose primary temp passes may still carry a chromatic accent that
  // clashes. E.g. "white & green sneakers" resolves primary as neutral but
  // the green accent is foreign to an earth/warm outfit.
  if (!colorClash) {
    const allTemps = resolveAllShoeTemps(shoeFull);
    const outfitGroups = new Set<TempGroup>();
    for (const oi of outfitItems) {
      if (oi.category === 'shoes') continue;
      const full = wardrobeMap.get(oi.id);
      if (!full) continue;
      const t = resolveTemp(full);
      if (t && t !== 'neutral') outfitGroups.add(t);
    }
    for (const t of allTemps) {
      if (t === 'neutral' || t === 'earth') continue;
      if (outfitGroups.size > 0 && !outfitGroups.has(t)) {
        colorClash = true;
        break;
      }
    }
  }

  // --- Bottom–shoe harmony (expanded) ---
  // Runs even for neutral/earth shoes. The visual proximity of shoes to
  // the bottom garment means a chromatic mismatch there is always jarring.
  if (!colorClash) {
    const bottomOi = outfitItems.find(i => i.category === 'bottom');
    if (bottomOi) {
      const bottomFull = wardrobeMap.get(bottomOi.id);
      if (bottomFull) {
        const bottomTemp = resolveTemp(bottomFull);
        const allShoeTemps = resolveAllShoeTemps(shoeFull);
        if (bottomTemp && bottomTemp !== 'neutral') {
          for (const st of allShoeTemps) {
            if (st === 'neutral' || st === 'earth') continue;
            if (st !== bottomTemp) {
              colorClash = true;
              break;
            }
          }
        }
      }
    }
  }

  // --- Style check ---
  const outfitCtx = resolveOutfitContext(outfitItems, wardrobeMap);

  // Use resolved archetype, or derive from shoe's dressCode as fallback
  let effectiveArchetype = shoeArchetype;
  if (!effectiveArchetype) {
    const dc: string | undefined = shoeFull?.dressCode ?? shoeFull?.dress_code;
    if (dc) {
      const DRESS_CODE_TO_ARCHETYPE: Record<string, ShoeArchetype> = {
        BlackTie: 'dress',
        Business: 'dress',
        BusinessCasual: 'smart-casual',
        SmartCasual: 'smart-casual',
        Casual: 'casual-sneaker',
        UltraCasual: 'minimal',
      };
      effectiveArchetype = DRESS_CODE_TO_ARCHETYPE[dc] ?? null;
    }
  }

  if (effectiveArchetype && outfitCtx !== 'unknown') {
    if (!STYLE_COMPAT[effectiveArchetype][outfitCtx]) {
      styleClash = true;
    }
  }

  if (!colorClash && !styleClash) return null;

  const reason: MismatchReason =
    colorClash && styleClash ? 'both' : colorClash ? 'color' : 'style';

  return {reason, outfitCtx, dominant};
}

// ---------------------------------------------------------------------------
// Replacement scoring
// ---------------------------------------------------------------------------

function scoreCandidate(
  candidate: any,
  outfitCtx: OutfitContext,
  dominant: TempGroup | null,
  originalArchetype: ShoeArchetype | null,
  bottomTemp: TempGroup | null,
): number {
  let score = 0;

  // --- Style scoring ---
  const candArchetype = resolveShoeArchetype(candidate);
  if (candArchetype) {
    const ideals = IDEAL_ARCHETYPES[outfitCtx];
    if (ideals.length > 0 && ideals[0] === candArchetype) {
      score += 40; // ideal match
    } else if (ideals.includes(candArchetype)) {
      score += 30; // good match
    } else if (STYLE_COMPAT[candArchetype][outfitCtx]) {
      score += 15; // compatible (pass or borderline)
    }
  }

  // --- Color scoring ---
  const candTemp = resolveTemp(candidate);
  if (candTemp) {
    if (candTemp === 'neutral') score += 15;
    else if (dominant && candTemp === dominant) score += 12;
    else if (candTemp === 'earth') score += 8;
  }

  // --- Bottom–shoe harmony scoring (dominant signal) ---
  if (bottomTemp && candTemp) {
    if (candTemp === bottomTemp) {
      score += 45; // strong harmony (e.g., brown loafer + brown chinos)
    } else if (
      (candTemp === 'neutral' || candTemp === 'earth') &&
      (bottomTemp === 'earth' || bottomTemp === 'neutral')
    ) {
      score += 25; // acceptable harmony (e.g., black shoe + tan chinos)
    } else if (
      candTemp !== 'neutral' &&
      candTemp !== 'earth' &&
      candTemp !== bottomTemp
    ) {
      score -= 35; // mismatch (e.g., blue shoe + brown chinos)
    }
  }

  // --- Formality proximity to original shoe ---
  if (originalArchetype && candArchetype) {
    const ARCHETYPE_FORMALITY: Record<ShoeArchetype, number> = {
      athletic: 0,
      minimal: 0,
      'casual-sneaker': 1,
      rugged: 1,
      'smart-casual': 2,
      dress: 3,
    };
    const gap = Math.abs(
      ARCHETYPE_FORMALITY[candArchetype] - ARCHETYPE_FORMALITY[originalArchetype],
    );
    score -= gap * 1;
  }

  return score;
}

// ---------------------------------------------------------------------------
// Description text correction (post-replacement)
// ---------------------------------------------------------------------------

const SHOE_COLOR_PHRASE_RE = /\b(black|white|blue|navy|brown|tan|cream|ivory|beige|red|green|olive|gray|grey|charcoal|purple|orange|yellow|gold|burgundy|maroon|cognac|camel|wine|pink|coral|mustard|silver|khaki|taupe)\s+(shoes|shoe|sneakers|loafers|boots|oxfords|derbies|flats|heels|pumps|footwear|mules|sandals|slides|trainers)\b/gi;
const NEUTRAL_SHOE_PHRASE = 'polished footwear';

function correctDescription(text: string): string {
  return text.replace(SHOE_COLOR_PHRASE_RE, NEUTRAL_SHOE_PHRASE);
}

// ---------------------------------------------------------------------------
// Replacement builder (shared helper)
// ---------------------------------------------------------------------------

function buildReplacementItem(candidate: any): OutfitItem {
  return {
    id: candidate.id,
    name:
      candidate.name ??
      candidate.aiTitle ??
      candidate.ai_title ??
      'Shoes',
    imageUrl:
      candidate.image ??
      candidate.touchedUpImageUrl ??
      candidate.processedImageUrl ??
      candidate.imageUrl ??
      '',
    category: 'shoes',
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Refine shoe selections across a batch of outfit suggestions.
 *
 * For each outfit, checks for:
 *   1. Color temperature clash with the outfit's dominant palette
 *   2. Style/formality mismatch (e.g., work boots with business-casual)
 *
 * If a clear mismatch is found and the user owns a better shoe, substitutes it.
 *
 * @param data       - The AI suggestion response (must have `outfits` array)
 * @param wardrobe   - The user's full wardrobe items array
 * @returns          - A new response object with refined shoe selections
 */
export function refineOutfitShoes(
  data: VisualResponse,
  wardrobe: any[],
): VisualResponse {
  if (!data?.outfits?.length || !wardrobe?.length) return data;

  const wardrobeMap = new Map<string, any>();
  for (const item of wardrobe) {
    if (item?.id) wardrobeMap.set(item.id, item);
  }

  const allShoes = wardrobe.filter(
    (w) => (w.mainCategory ?? w.main_category) === 'Shoes',
  );

  if (allShoes.length < 2) return data;

  const usedShoeIds = new Set<string>();

  const refinedOutfits = data.outfits.map((outfit) => {
    const shoeItem = outfit.items.find((i) => i.category === 'shoes');
    if (!shoeItem) return outfit;

    usedShoeIds.add(shoeItem.id);

    const shoeFull = wardrobeMap.get(shoeItem.id);
    if (!shoeFull) return outfit;

    const shoeTemp = resolveTemp(shoeFull);
    const shoeArchetype = resolveShoeArchetype(shoeFull);

    // If we can't determine either signal, there's nothing to evaluate against
    if (!shoeTemp && !shoeArchetype) {
      // Last attempt: if the shoe has a dressCode, we can still run a style check
      const dc: string | undefined = shoeFull?.dressCode ?? shoeFull?.dress_code;
      if (!dc) return outfit;
    }

    const mismatch = detectMismatch(
      shoeFull,
      shoeTemp,
      shoeArchetype,
      outfit.items,
      wardrobeMap,
    );

    if (!mismatch) return outfit;

    // -----------------------------------------------------------------
    // Mismatch detected — find the best replacement
    // -----------------------------------------------------------------

    // Compute outfit chromatic groups for foreign-color candidate filtering
    const outfitGroups = new Set<TempGroup>();
    for (const oi of outfit.items) {
      if (oi.category === 'shoes') continue;
      const full = wardrobeMap.get(oi.id);
      if (!full) continue;
      const t = resolveTemp(full);
      if (t && t !== 'neutral') outfitGroups.add(t);
    }

    // Resolve bottom garment temp for candidate scoring
    let bottomTemp: TempGroup | null = null;
    const bottomOi = outfit.items.find(i => i.category === 'bottom');
    if (bottomOi) {
      const bottomFull = wardrobeMap.get(bottomOi.id);
      if (bottomFull) bottomTemp = resolveTemp(bottomFull);
    }

    let bestCandidate: any | null = null;
    let bestScore = -Infinity;

    for (const candidate of allShoes) {
      if (candidate.id === shoeItem.id) continue;
      if (usedShoeIds.has(candidate.id)) continue;

      const candTemp = resolveTemp(candidate);
      const candArchetype = resolveShoeArchetype(candidate);

      // Candidate must not have a color clash
      if (
        candTemp &&
        candTemp !== 'neutral' &&
        candTemp !== 'earth' &&
        mismatch.dominant
      ) {
        if (SHOE_CLASHES[candTemp]?.includes(mismatch.dominant)) continue;
      }

      // Candidate must not introduce a foreign chromatic color
      if (
        candTemp &&
        candTemp !== 'neutral' &&
        candTemp !== 'earth' &&
        outfitGroups.size > 0 &&
        !outfitGroups.has(candTemp)
      ) {
        continue;
      }

      // Candidate must not clash with the bottom garment
      if (
        candTemp &&
        candTemp !== 'neutral' &&
        candTemp !== 'earth' &&
        bottomTemp &&
        bottomTemp !== 'neutral' &&
        candTemp !== bottomTemp
      ) {
        continue;
      }

      // Candidate accent colors must not clash with outfit or bottom
      const candAllTemps = resolveAllShoeTemps(candidate);
      let candAccentClash = false;
      for (const ct of candAllTemps) {
        if (ct === 'neutral' || ct === 'earth') continue;
        if (outfitGroups.size > 0 && !outfitGroups.has(ct)) {
          candAccentClash = true;
          break;
        }
        if (bottomTemp && bottomTemp !== 'neutral' && ct !== bottomTemp) {
          candAccentClash = true;
          break;
        }
      }
      if (candAccentClash) continue;

      // Candidate must not have a style clash
      if (candArchetype && mismatch.outfitCtx !== 'unknown') {
        if (!STYLE_COMPAT[candArchetype][mismatch.outfitCtx]) continue;
      }

      const score = scoreCandidate(
        candidate,
        mismatch.outfitCtx,
        mismatch.dominant,
        shoeArchetype,
        bottomTemp,
      );

      if (score > bestScore) {
        bestScore = score;
        bestCandidate = candidate;
      }
    }

    if (!bestCandidate || bestScore < 5) return outfit;

    usedShoeIds.add(bestCandidate.id);

    const replacementItem = buildReplacementItem(bestCandidate);

    return {
      ...outfit,
      summary: correctDescription(outfit.summary),
      ...(outfit.reasoning != null
        ? {reasoning: correctDescription(outfit.reasoning)}
        : {}),
      items: outfit.items.map((i) =>
        i.category === 'shoes' ? replacementItem : i,
      ),
    };
  });

  return {...data, outfits: refinedOutfits};
}
