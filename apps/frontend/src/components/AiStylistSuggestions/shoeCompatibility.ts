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
  cool: ['warm'],
  warm: ['cool'],
  earth: [],
  neutral: [],
  green: [],
};

// ---------------------------------------------------------------------------
// Authority tier (shoe craft / polish level, independent of occasion)
// ---------------------------------------------------------------------------

const AUTHORITY_BY_ARCHETYPE: Record<ShoeArchetype, number> = {
  dress: 5,
  'smart-casual': 4,
  minimal: 3,
  'casual-sneaker': 2,
  rugged: 2,
  athletic: 1,
};

const CONTEXT_FORMALITY_TARGET: Record<OutfitContext, number> = {
  formal: 4,
  'business-casual': 3,
  unknown: 2,
  casual: 1,
  rugged: 1,
  athletic: 0,
};

const ARCHETYPE_FORMALITY_LEVEL: Record<ShoeArchetype, number> = {
  dress: 4,
  'smart-casual': 3,
  minimal: 1,
  'casual-sneaker': 1,
  rugged: 1,
  athletic: 0,
};

// ---------------------------------------------------------------------------
// Tiered evaluation
// ---------------------------------------------------------------------------

type ShoeTiers = {
  occasionMatch: number;
  authority: number;
  formalityDist: number;
  climate: number;
  profile: number;
  harmony: number;
  tonalPenalty: number;
};

function compositeScore(t: ShoeTiers): number {
  return (
    t.occasionMatch * 1e8 +
    t.authority * 1e6 -
    t.formalityDist * 1e4 +
    t.tonalPenalty * 1e3 +
    t.climate * 1e2 +
    t.profile * 10 +
    t.harmony
  );
}

function isStrictlyBetter(
  cand: ShoeTiers,
  curr: ShoeTiers,
  outfitCtx: OutfitContext,
): boolean {
  if (cand.occasionMatch !== curr.occasionMatch) {
    return cand.occasionMatch > curr.occasionMatch;
  }
  if (
    (outfitCtx === 'formal' || outfitCtx === 'business-casual') &&
    cand.authority < curr.authority
  ) {
    return false;
  }
  if (cand.authority !== curr.authority) {
    return cand.authority > curr.authority;
  }
  if (cand.formalityDist !== curr.formalityDist) {
    return cand.formalityDist < curr.formalityDist;
  }
  return compositeScore(cand) > compositeScore(curr);
}

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

/**
 * Gather all likely text fields from a shoe item into a single searchable string.
 * Broadens archetype resolution beyond just subCategory + name.
 */
function gatherShoeText(item: any): string {
  const fields: (string | undefined)[] = [
    item?.subCategory, item?.subcategory,
    item?.name, item?.aiTitle, item?.ai_title,
    item?.title, item?.label, item?.displayName,
    item?.type, item?.shoeType, item?.shoe_type,
  ];
  return fields
    .filter((f): f is string => typeof f === 'string' && f.length > 0)
    .map(f => f.toLowerCase())
    .join(' ');
}

function resolveShoeArchetype(item: any): ShoeArchetype | null {
  // 1. Exact subcategory match (most reliable)
  const sub = (
    (item?.subCategory ?? item?.subcategory ?? '') as string
  ).toLowerCase().trim();

  if (sub && SUBCATEGORY_TO_ARCHETYPE[sub]) {
    return SUBCATEGORY_TO_ARCHETYPE[sub];
  }

  // 2. Regex match across all text fields
  const text = gatherShoeText(item);

  for (const [re, archetype] of NAME_ARCHETYPE_RULES) {
    if (re.test(text)) return archetype;
  }

  // 3. Leather heuristic: leather + no casual/boot signals → dress
  if (/leather/.test(text) && !/sneaker|trainer|boot|sandal|slide|flip|casual/.test(text)) {
    return 'dress';
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
  const sub = (
    (item?.subCategory ?? item?.subcategory ?? '') as string
  ).toLowerCase();
  const name = ((item?.name ?? '') as string).toLowerCase();
  const combined = `${sub} ${name}`;
  const dc: string | undefined = item?.dressCode ?? item?.dress_code;

  let regexResult: OutfitContext | null = null;
  let matchedRule: string | null = null;
  for (const [re, ctx] of ITEM_CONTEXT_RULES) {
    if (re.test(combined)) {
      regexResult = ctx;
      matchedRule = re.source;
      break;
    }
  }

  const result = regexResult ?? (dc && DRESS_CODE_TO_CONTEXT[dc]) ?? null;

  console.log('[shoeRefine] CLASSIFY_ITEM', {
    name: item?.name,
    subCategory: item?.subCategory ?? item?.subcategory,
    combined,
    dressCode: dc ?? null,
    regexResult,
    matchedRule,
    finalResult: result,
  });

  return result;
}

// Adjacency: contexts that are "close enough" merge to the more permissive one
const CONTEXT_ADJACENCY: Record<string, OutfitContext> = {
  'formal+business-casual': 'business-casual',
  'business-casual+formal': 'business-casual',
  'business-casual+casual': 'business-casual',
  'casual+business-casual': 'business-casual',
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

  console.log('[shoeRefine] CONTEXT_COUNTS', { counts, classified });

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
  if (first.count > classified - first.count) {
    console.log('[shoeRefine] CONTEXT_RESOLVED', { path: 'majority', result: first.ctx, first, second });
    return first.ctx;
  }

  // Tie or close — check adjacency
  if (second.count > 0) {
    const key = `${first.ctx}+${second.ctx}`;
    if (CONTEXT_ADJACENCY[key]) {
      console.log('[shoeRefine] CONTEXT_RESOLVED', { path: 'adjacency', key, result: CONTEXT_ADJACENCY[key] });
      return CONTEXT_ADJACENCY[key];
    }
  }

  // Mixed non-adjacent → unknown (conservative)
  console.log('[shoeRefine] CONTEXT_RESOLVED', { path: 'unknown-fallback', first, second });
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
    'business-casual': false,
    casual: true,
    rugged: true,
    athletic: true, // borderline but allowed
    unknown: true,
  },
  rugged: {
    formal: false,
    'business-casual': false,
    casual: false, // work boots / hiking boots clash with casual outfits
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
// Outfit-item ↔ wardrobe-row signal merge
//
// The AI response OutfitItem may carry a richer display name than the DB row
// (e.g., "Blue Leather Dress Shoes" vs DB "Dress Shoes"). This helper builds
// a merged evaluation object: wardrobe row is primary, outfit item text fills
// gaps so color/archetype resolution never misses visible signals.
// ---------------------------------------------------------------------------

function mergeItemSignals(wardrobeRow: any, outfitItem: OutfitItem): any {
  if (!wardrobeRow) return wardrobeRow;

  return {
    ...wardrobeRow,
    // name: prefer wardrobe row, but append outfit item name if different
    // so color words in the display name are visible to regex scanners
    name: wardrobeRow.name
      ? (wardrobeRow.name === outfitItem.name
          ? wardrobeRow.name
          : `${wardrobeRow.name} ${outfitItem.name}`)
      : outfitItem.name,
    // aiTitle: preserve wardrobe row, fall back to outfit item name
    aiTitle: wardrobeRow.aiTitle ?? wardrobeRow.ai_title ?? outfitItem.name,
  };
}

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

const HIGH_SAT_COOL_FAMILIES: ReadonlySet<string> = new Set([
  'Blue',
  'Royal Blue',
  'Cobalt',
  'Sky Blue',
  'Purple',
  'Magenta',
]);

function resolveColorFamily(item: any): string | null {
  const family: string | undefined = item?.colorFamily ?? item?.color_family;
  if (family && FAMILY_TO_TEMP[family]) return family;

  const raw: string | undefined = item?.color;
  if (raw) {
    const lc = raw.toLowerCase();
    for (const [re, fam] of COLOR_TEXT_RULES) {
      if (re.test(lc)) return fam;
    }
  }

  const name: string | undefined = item?.name ?? item?.aiTitle ?? item?.ai_title;
  if (name) {
    const lc = name.toLowerCase();
    for (const [re, fam] of COLOR_TEXT_RULES) {
      if (re.test(lc)) return fam;
    }
  }

  return null;
}

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
// Centralized shoe validity check
//
// Used IDENTICALLY for both the current shoe and every replacement candidate.
// Layered gates: STYLE (hard) → COLOR primary/bottom → COLOR accents/palette
// → CLASH matrix. A shoe must pass ALL gates.
// ---------------------------------------------------------------------------

function isShoeValid(
  shoeFull: any,
  outfitCtx: OutfitContext,
  bottomTemp: TempGroup | null,
  outfitGroups: Set<TempGroup>,
  dominant: TempGroup | null,
  hasCasualSignal: boolean,
  hasFormalBcSignal: boolean,
): boolean {
  // ── GATE 1: STYLE (hard, non-bypassable) ──

  let archetype = resolveShoeArchetype(shoeFull);

  // dressCode fallback when archetype is still null
  if (!archetype) {
    const dc: string | undefined = shoeFull?.dressCode ?? shoeFull?.dress_code;
    if (dc) {
      const DC_TO_ARCH: Record<string, ShoeArchetype> = {
        BlackTie: 'dress', Business: 'dress',
        BusinessCasual: 'smart-casual', SmartCasual: 'smart-casual',
        Casual: 'casual-sneaker', UltraCasual: 'minimal',
      };
      archetype = DC_TO_ARCH[dc] ?? null;
    }
  }

  if (archetype && outfitCtx !== 'unknown') {
    // Known archetype + known context → STYLE_COMPAT is the hard gate
    if (!STYLE_COMPAT[archetype][outfitCtx]) return false;
  } else if (archetype && outfitCtx === 'unknown') {
    // Known archetype + unknown context → use item-level hints
    if (hasCasualSignal && (archetype === 'dress' || archetype === 'rugged')) return false;
    if (hasFormalBcSignal && (archetype === 'rugged' || archetype === 'athletic')) return false;
  } else if (!archetype) {
    // Null archetype → restrictive contexts reject, unknown uses text heuristics
    if (outfitCtx === 'casual' || outfitCtx === 'formal' || outfitCtx === 'athletic') {
      return false;
    }
    if (outfitCtx === 'unknown') {
      const text = gatherShoeText(shoeFull);
      if (hasCasualSignal && /leather|dress|oxford|derby|brogue|wingtip|pump|heel|stiletto/.test(text)) return false;
      if (hasFormalBcSignal && /work\s*boot|hiking|combat|cowboy|tactical|rain\s*boot|lug/.test(text)) return false;
    }
  }

  // ── EXTREME CHROMATIC CLASH (cool<->warm only) ──

  const primaryTemp = resolveTemp(shoeFull);

  if (primaryTemp && primaryTemp !== 'neutral' && primaryTemp !== 'earth' && dominant) {
    if (SHOE_CLASHES[primaryTemp]?.includes(dominant)) {
      return false;
    }
  }

  // ── HIGH-SATURATION COOL vs WARM/EARTH REJECTION ──
  if (dominant === 'warm' || dominant === 'earth') {
    const family = resolveColorFamily(shoeFull);
    if (family && HIGH_SAT_COOL_FAMILIES.has(family)) {
      return false;
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Tiered candidate evaluation
// ---------------------------------------------------------------------------

function resolveAuthorityTier(item: any): number {
  const arch = resolveShoeArchetype(item);
  if (!arch) return 2;
  return AUTHORITY_BY_ARCHETYPE[arch] ?? 2;
}

function resolveOccasionMatch(item: any, outfitCtx: OutfitContext): number {
  if (outfitCtx === 'unknown') return 1;
  const arch = resolveShoeArchetype(item);
  if (!arch) return 0;
  const ideals = IDEAL_ARCHETYPES[outfitCtx];
  if (ideals.includes(arch)) return 2;
  if (STYLE_COMPAT[arch][outfitCtx]) return 1;
  return 0;
}

function resolveFormalityDistance(item: any, outfitCtx: OutfitContext): number {
  const arch = resolveShoeArchetype(item);
  if (!arch) return 3;
  return Math.abs(
    (ARCHETYPE_FORMALITY_LEVEL[arch] ?? 1) -
    (CONTEXT_FORMALITY_TARGET[outfitCtx] ?? 2),
  );
}

function resolveClimateScore(item: any): number {
  const raw = item?.weatherScore ?? item?.weather_score ?? item?.climateScore ?? item?.climate_score;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
  return Math.max(-5, Math.min(5, raw));
}

function resolveProfileScore(item: any): number {
  const raw = item?.profileScore ?? item?.profile_score ?? item?.styleProfileScore ?? item?.style_profile_score;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
  return Math.max(-5, Math.min(5, raw));
}

function resolveHarmonyAdjustment(
  item: any,
  bottomTemp: TempGroup | null,
  dominant: TempGroup | null,
): number {
  const shoeTemp = resolveTemp(item);
  if (!shoeTemp) return 0;
  let h = 0;
  if (shoeTemp === 'neutral') h += 1;
  if (bottomTemp && shoeTemp === bottomTemp) h += 2;
  if (
    dominant &&
    shoeTemp !== 'neutral' &&
    shoeTemp !== 'earth' &&
    SHOE_CLASHES[shoeTemp]?.includes(dominant)
  ) {
    h -= 3;
  }
  return Math.max(-5, Math.min(5, h));
}

function computeTiers(
  item: any,
  outfitCtx: OutfitContext,
  bottomTemp: TempGroup | null,
  dominant: TempGroup | null,
  warmCount?: number,
  earthCount?: number,
): ShoeTiers {
  let tonalPenalty = 0;
  const shoeTemp = resolveTemp(item);
  if (
    (warmCount ?? 0) + (earthCount ?? 0) >= 2 &&
    shoeTemp === 'cool'
  ) {
    tonalPenalty = -3;
  }

  return {
    occasionMatch: resolveOccasionMatch(item, outfitCtx),
    authority: resolveAuthorityTier(item),
    formalityDist: resolveFormalityDistance(item, outfitCtx),
    climate: resolveClimateScore(item),
    profile: resolveProfileScore(item),
    harmony: resolveHarmonyAdjustment(item, bottomTemp, dominant),
    tonalPenalty,
  };
}

// ---------------------------------------------------------------------------
// Tonal-authority penalty
// ---------------------------------------------------------------------------

function applyTonalAuthorityPenalty(
  tiers: ShoeTiers,
  item: any,
  outfitCtx: OutfitContext,
  dominant: TempGroup | null,
  coolCount: number,
): ShoeTiers {
  if (
    (outfitCtx === 'formal' || outfitCtx === 'business-casual') &&
    dominant === 'cool' &&
    coolCount >= 2 &&
    resolveTemp(item) === 'earth' &&
    resolveAuthorityTier(item) < 5
  ) {
    return {
      ...tiers,
      authority: Math.max(1, tiers.authority - 2),
      formalityDist: tiers.formalityDist + 1,
    };
  }
  return tiers;
}

// ---------------------------------------------------------------------------
// Warm-dominance penalty
// ---------------------------------------------------------------------------

function applyWarmDominancePenalty(
  tiers: ShoeTiers,
  item: any,
  outfitCtx: OutfitContext,
  dominant: TempGroup | null,
  warmCount: number,
  earthCount: number,
): ShoeTiers {
  if (
    (dominant === 'warm' || dominant === 'earth') &&
    warmCount + earthCount >= 2 &&
    resolveTemp(item) === 'cool'
  ) {
    return {
      ...tiers,
      authority: Math.max(1, tiers.authority - 2),
      formalityDist: tiers.formalityDist + 1,
    };
  }
  return tiers;
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
  console.log('[shoeRefine] START', {
    outfitCount: data?.outfits?.length,
    wardrobeCount: wardrobe?.length,
  });

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
    console.log('[shoeRefine] OUTFIT', {
      outfitId: outfit.id,
      items: outfit.items?.map(i => ({
        id: i.id,
        name: i.name,
        category: i.category,
      })),
    });

    const shoeItem = outfit.items.find((i) => i.category === 'shoes');
    if (!shoeItem) return outfit;

    usedShoeIds.add(shoeItem.id);

    const shoeFull = wardrobeMap.get(shoeItem.id);
    if (!shoeFull) return outfit;

    console.log('[shoeRefine] SHOE_LOOKUP', {
      shoeItemId: shoeItem?.id,
      shoeItemName: shoeItem?.name,
      wardrobeRowName: shoeFull?.name,
      wardrobeColorFamily: shoeFull?.colorFamily,
      wardrobeColor: shoeFull?.color,
    });

    // ── Merge outfit-item display text into wardrobe rows ──
    // The AI response may carry richer names than the DB row (e.g., color
    // words in the display name that the DB row lacks). Build merged
    // evaluation objects so resolveTemp / classifyItemContext / archetype
    // resolution see ALL available text.

    const shoeEval = mergeItemSignals(shoeFull, shoeItem);

    // ── Compute ALL outfit signals in a single pass ──

    // Build a merged-signal map for non-shoe outfit items too, so context
    // classification and color resolution benefit from display names.
    const mergedNonShoeItems: {oi: OutfitItem; merged: any}[] = [];
    for (const oi of outfit.items) {
      if (oi.category === 'shoes') continue;
      const full = wardrobeMap.get(oi.id);
      if (!full) continue;
      mergedNonShoeItems.push({oi, merged: mergeItemSignals(full, oi)});
    }

    // Build a map overlay with merged signals for context/color resolution
    const mergedMap = new Map<string, any>(wardrobeMap);
    for (const {oi, merged} of mergedNonShoeItems) {
      mergedMap.set(oi.id, merged);
    }

    // Outfit context uses merged items for better classification
    const outfitCtx = resolveOutfitContext(outfit.items, mergedMap);
    const dominant = outfitDominantTemp(outfit.items, mergedMap);

    const outfitGroups = new Set<TempGroup>();
    let coolCount = 0;
    let warmCount = 0;
    let earthCount = 0;
    let hasCasualSignal = false;
    let hasFormalBcSignal = false;
    let bottomTemp: TempGroup | null = null;

    for (const {oi, merged} of mergedNonShoeItems) {
      const t = resolveTemp(merged);
      if (t && t !== 'neutral') outfitGroups.add(t);
      if (t === 'cool') coolCount++;
      if (t === 'warm') warmCount++;
      if (t === 'earth') earthCount++;
      if (oi.category === 'bottom' && t) bottomTemp = t;

      const itemCtx = classifyItemContext(merged);
      if (itemCtx === 'casual') hasCasualSignal = true;
      if (itemCtx === 'formal' || itemCtx === 'business-casual') hasFormalBcSignal = true;
    }

    // ── Validate current shoe using MERGED evaluation object ──

    const currentShoeOk = isShoeValid(
      shoeEval, outfitCtx, bottomTemp, outfitGroups, dominant,
      hasCasualSignal, hasFormalBcSignal,
    );

    // ── Tier-based replacement decision ──

    const currentTiers = computeTiers(shoeEval, outfitCtx, bottomTemp, dominant, warmCount, earthCount);
    const adjustedCurrentTiers = applyWarmDominancePenalty(
      applyTonalAuthorityPenalty(
        !currentShoeOk ? { ...currentTiers, occasionMatch: 0 } : currentTiers,
        shoeEval, outfitCtx, dominant, coolCount,
      ),
      shoeEval, outfitCtx, dominant, warmCount, earthCount,
    );

    console.log('[shoeRefine] VALIDATION', {
      shoe: shoeItem?.name,
      isValid: currentShoeOk,
      context: outfitCtx,
      bottomTemp,
      dominantTemp: dominant,
      coolCount,
      currentTiers: adjustedCurrentTiers,
    });

    type Ranked = { item: any; tiers: ShoeTiers; score: number };

    const buildPool = (gateStrict: boolean): Ranked[] => {
      const result: Ranked[] = [];
      for (const candidate of allShoes) {
        if (candidate.id === shoeItem.id) continue;
        if (usedShoeIds.has(candidate.id)) continue;

        if (gateStrict) {
          if (!isShoeValid(
            candidate, outfitCtx, bottomTemp, outfitGroups, dominant,
            hasCasualSignal, hasFormalBcSignal,
          )) {
            continue;
          }
        }

        const candArchetype = resolveShoeArchetype(candidate);
        if (candArchetype === 'rugged' && outfitCtx !== 'rugged') continue;

        const tiers = applyWarmDominancePenalty(
          applyTonalAuthorityPenalty(
            computeTiers(candidate, outfitCtx, bottomTemp, dominant, warmCount, earthCount),
            candidate, outfitCtx, dominant, coolCount,
          ),
          candidate, outfitCtx, dominant, warmCount, earthCount,
        );
        result.push({ item: candidate, tiers, score: compositeScore(tiers) });
      }
      result.sort((a, b) => b.score - a.score);
      return result;
    };

    let pool = buildPool(true);
    if (pool.length === 0) {
      pool = buildPool(false);
    }

    if (pool.length === 0 && !currentShoeOk) {
      pool = allShoes
        .filter(s => s.id !== shoeItem.id && !usedShoeIds.has(s.id))
        .map(s => {
          const tiers = applyWarmDominancePenalty(
            applyTonalAuthorityPenalty(
              computeTiers(s, outfitCtx, bottomTemp, dominant, warmCount, earthCount),
              s, outfitCtx, dominant, coolCount,
            ),
            s, outfitCtx, dominant, warmCount, earthCount,
          );
          return { item: s, tiers, score: compositeScore(tiers) } as Ranked;
        })
        .sort((a, b) => b.score - a.score);
    }

    console.log('[shoeRefine] DEBUG_POOL_FULL', {
      outfitId: outfit.id,
      poolSize: pool.length,
      candidates: pool.map(p => ({
        name: p.item.name,
        score: p.score,
        tiers: p.tiers,
      })),
    });

    let bestCandidate: any | null = null;
    let bestTiers: ShoeTiers | null = null;
    for (const ranked of pool) {
      if (isStrictlyBetter(ranked.tiers, adjustedCurrentTiers, outfitCtx)) {
        bestCandidate = ranked.item;
        bestTiers = ranked.tiers;
        break;
      }
    }

    console.log('[shoeRefine] FINAL_DECISION', {
      original: shoeItem?.name,
      replacement: bestCandidate?.name ?? null,
      poolSize: pool.length,
      currentTiers: adjustedCurrentTiers,
      bestTiers,
    });

    if (!bestCandidate) {
      console.log('[shoeRefine] REFINED_OUTFIT', {
        outfitId: outfit.id,
        originalShoe: shoeItem?.name,
        finalShoe: shoeItem?.name,
      });
      return outfit;
    }

    usedShoeIds.add(bestCandidate.id);

    const replacementItem = buildReplacementItem(bestCandidate);
    const originalName = shoeItem.name;
    const replacementName = replacementItem.name;

    // Replace exact old shoe name in text fields, then run generic color correction
    const fixText = (text: string): string => {
      const swapped = originalName ? text.replace(originalName, replacementName) : text;
      return correctDescription(swapped);
    };

    console.log('[shoeRefine] REFINED_OUTFIT', {
      outfitId: outfit.id,
      originalShoe: shoeItem?.name,
      finalShoe: bestCandidate?.name,
    });

    return {
      ...outfit,
      summary: fixText(outfit.summary),
      ...(outfit.reasoning != null
        ? {reasoning: fixText(outfit.reasoning)}
        : {}),
      items: outfit.items.map((i) =>
        i.category === 'shoes' ? replacementItem : i,
      ),
    };
  });

  return {...data, outfits: refinedOutfits};
}
