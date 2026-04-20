/**
 * Taste / Coherence Validator — Pure deterministic functions.
 *
 * Zero DB calls, zero async, zero IO. Used by Stylist, Studio, and (type-only) Trips.
 * Fail-open: missing metadata ⇒ skip that check, never block.
 */

// ── Types ───────────────────────────────────────────────────────────────────

export type ValidatorSlot =
  | 'tops'
  | 'bottoms'
  | 'shoes'
  | 'outerwear'
  | 'dresses'
  | 'accessories'
  | 'activewear'
  | 'swimwear';

export type ValidatorItem = {
  id: string;
  slot: ValidatorSlot;
  name?: string;
  subcategory?: string;
  color?: string;
  material?: string;
  fit?: string;
  formality_score?: number;
  dress_code?: string;
  style_descriptors?: string[];
  style_archetypes?: string[];
  price?: number;
  presentation_code?: string;
};

export type ValidatorContext = {
  userPresentation?: 'masculine' | 'feminine' | 'mixed';
  climateZone?: 'freezing' | 'cold' | 'cool' | 'mild' | 'warm' | 'hot';
  requestedDressCode?: string;
  styleProfile?: {
    fit_preferences?: string[];
    fabric_preferences?: string[];
    style_preferences?: string[];
    disliked_styles?: string[];
    // P0 hard vetoes
    coverage_no_go?: string[];
    avoid_colors?: string[];
    avoid_materials?: string[];
    formality_floor?: string | null;
    walkability_requirement?: string | null;
    // P1 soft preferences
    avoid_patterns?: string[];
    silhouette_preference?: string | null;
  } | null;
};

export type ValidationResult = {
  valid: boolean;
  hardFails: string[];
  softPenalties: string[];
  totalPenalty: number;
  coherenceScore: number;
};

export type BatchValidationResult = {
  results: Array<{ outfitId: string; validation: ValidationResult }>;
};

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Detect open footwear by name/subcategory tokens (case-insensitive). */
export function isOpenFootwear(item: {
  name?: string;
  subcategory?: string;
}): boolean {
  const text = `${item.subcategory ?? ''} ${item.name ?? ''}`.toLowerCase();
  return /\b(sandals?|flip[- ]?flops?|slides?|thongs?)\b/.test(text);
}

function lc(s: string | undefined | null): string {
  return (s ?? '').toLowerCase();
}

function intersects(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const bLower = new Set(b.map((s) => s.toLowerCase()));
  return a.some((s) => bLower.has(s.toLowerCase()));
}

function getNum(v: unknown): number | undefined {
  return typeof v === 'number' && isFinite(v) ? v : undefined;
}

// ── Hard Fail Checks ────────────────────────────────────────────────────────

function checkCrossPresentation(
  items: ValidatorItem[],
  pres: string | undefined,
): string | null {
  if (!pres || pres === 'mixed') return null;
  for (const item of items) {
    if (!item.presentation_code) continue;
    if (
      (pres === 'masculine' && item.presentation_code === 'feminine') ||
      (pres === 'feminine' && item.presentation_code === 'masculine')
    ) {
      return `CROSS_PRESENTATION: item ${item.id} is "${item.presentation_code}" but user is "${pres}"`;
    }
  }
  return null;
}

function checkWeatherContradiction(
  items: ValidatorItem[],
  zone: string | undefined,
): string | null {
  if (!zone) return null;
  const isColdOrFreezing = zone === 'freezing' || zone === 'cold';
  if (isColdOrFreezing) {
    for (const item of items) {
      if (item.slot !== 'shoes') continue;
      if (isOpenFootwear(item)) {
        return `EXTREME_WEATHER_CONTRADICTION: open footwear "${item.name ?? item.subcategory ?? item.id}" in ${zone}`;
      }
    }
  }
  // Conservative: heavy outerwear in hot — only if material is clearly heavy
  if (zone === 'hot') {
    const heavyFabrics = ['wool', 'down', 'sherpa', 'fleece'];
    for (const item of items) {
      if (item.slot !== 'outerwear') continue;
      const mat = lc(item.material);
      if (mat && heavyFabrics.some((f) => mat.includes(f))) {
        return `EXTREME_WEATHER_CONTRADICTION: heavy outerwear "${mat}" in hot climate`;
      }
    }
  }
  return null;
}

function checkDressCodeMismatch(
  items: ValidatorItem[],
  requestedDressCode: string | undefined,
): string | null {
  if (!requestedDressCode) return null;
  const req = requestedDressCode.toLowerCase();
  // Only enforce for formal/business/black-tie requests
  const formalCodes = [
    'business',
    'businesscasual',
    'business casual',
    'formal',
    'blacktie',
    'black tie',
    'black-tie',
  ];
  if (!formalCodes.some((f) => req.includes(f))) return null;

  const casualCodes = ['ultracasual', 'ultra casual', 'athletic'];
  for (const item of items) {
    const dc = lc(item.dress_code);
    if (!dc) continue;
    if (casualCodes.some((c) => dc.includes(c))) {
      return `DRESS_CODE_MISMATCH: item ${item.id} dress_code "${item.dress_code}" incompatible with "${requestedDressCode}"`;
    }
  }
  return null;
}

/**
 * Mirror existing validateOutfitCore from finalize.ts EXACTLY:
 * - swimwear alone passes (shoes optional)
 * - activewear needs shoes
 * - dress/one-piece needs shoes
 * - separates need tops + bottoms + shoes
 */
function checkRequiredSlots(items: ValidatorItem[]): string | null {
  if (items.length === 0) return 'MISSING_REQUIRED_SLOTS: no items';

  const slots = new Set(items.map((i) => i.slot));
  const hasTop = slots.has('tops');
  const hasBottom = slots.has('bottoms');
  const hasShoes = slots.has('shoes');
  const hasDress = slots.has('dresses');
  const hasActivewear = slots.has('activewear');
  const hasSwimwear = slots.has('swimwear');

  // Swimwear — shoes optional
  if (hasSwimwear) return null;
  // Activewear — needs shoes
  if (hasActivewear) {
    if (hasShoes) return null;
    return 'MISSING_REQUIRED_SLOTS: activewear missing shoes';
  }
  // One-piece (dress) — needs shoes
  if (hasDress) {
    if (hasShoes) return null;
    return 'MISSING_REQUIRED_SLOTS: dress missing shoes';
  }
  // Separates — tops + bottoms + shoes
  if (hasTop && hasBottom && hasShoes) return null;

  const missing: string[] = [];
  if (!hasTop) missing.push('tops');
  if (!hasBottom) missing.push('bottoms');
  if (!hasShoes) missing.push('shoes');
  return `MISSING_REQUIRED_SLOTS: separates missing ${missing.join(', ')}`;
}

// ── P0 Hard Fail: Profile Vetoes ─────────────────────────────────────────────

const COVERAGE_PATTERNS: Record<string, RegExp> = {
  'No midriff exposure': /crop.?top|bralette|bustier/i,
  'No leg exposure above knee': /mini.?skirt|short shorts|micro/i,
  'No shoulder exposure': /strapless|tube top|off.?shoulder/i,
  'No cleavage': /deep.?v|plunging/i,
};

function checkCoverageNoGo(
  items: ValidatorItem[],
  ctx: ValidatorContext,
): string | null {
  const noGo = ctx.styleProfile?.coverage_no_go;
  if (!noGo || noGo.length === 0) return null;
  for (const rule of noGo) {
    const pattern = COVERAGE_PATTERNS[rule];
    if (!pattern) continue;
    for (const item of items) {
      const text = `${item.subcategory ?? ''} ${item.name ?? ''}`;
      if (pattern.test(text)) {
        return `COVERAGE_NO_GO: "${rule}" violated by item ${item.id} ("${text.trim()}")`;
      }
    }
  }
  return null;
}

// ── Color-family synonym expansion ────────────────────────────────────────
const COLOR_SYNONYMS: Record<string, string[]> = {
  navy: ['navy blue', 'dark navy', 'midnight', 'ink'],
  red: ['crimson', 'scarlet', 'burgundy', 'maroon', 'magenta', 'wine'],
  pink: ['fuchsia', 'blush', 'rose'],
};

// ── Known color tokens (for extracting color intent from free text) ───────
const KNOWN_COLOR_TOKENS = new Set([
  'black',
  'white',
  'red',
  'blue',
  'green',
  'yellow',
  'orange',
  'purple',
  'pink',
  'brown',
  'grey',
  'gray',
  'beige',
  'cream',
  'ivory',
  'tan',
  'khaki',
  'navy',
  'cobalt',
  'teal',
  'turquoise',
  'cyan',
  'indigo',
  'cerulean',
  'azure',
  'crimson',
  'scarlet',
  'burgundy',
  'maroon',
  'magenta',
  'wine',
  'olive',
  'sage',
  'emerald',
  'mint',
  'jade',
  'moss',
  'lime',
  'fuchsia',
  'blush',
  'rose',
  'salmon',
  'coral',
  'mauve',
  'charcoal',
  'slate',
  'silver',
  'ash',
  'chocolate',
  'espresso',
  'mocha',
  'cognac',
  'chestnut',
  'walnut',
  'sienna',
  'taupe',
  'mustard',
  'gold',
  'amber',
  'rust',
  'copper',
  'terracotta',
  'peach',
  'apricot',
  'violet',
  'plum',
  'lavender',
  'lilac',
  'eggplant',
  'aubergine',
  'camel',
  'nude',
  'sand',
  'oatmeal',
  'wheat',
  'caramel',
  'pearl',
]);

/**
 * Extract explicit color tokens from a free-text description (e.g. LLM slot description).
 * Deterministic: lowercase, strip punctuation, match against known color list.
 * Returns de-duped color tokens in order of appearance.
 */
export function extractColorIntent(description: string): string[] {
  const tokens = description
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const t of tokens) {
    if (KNOWN_COLOR_TOKENS.has(t) && !seen.has(t)) {
      seen.add(t);
      result.push(t);
    }
  }
  return result;
}

// ── Known garment tokens (for extracting garment-type intent from free text) ──
// Multi-word tokens MUST come before their single-word substrings so that
// the greedy scan matches the most specific form first.
const KNOWN_GARMENT_PHRASES: string[] = [
  // outerwear – multi-word first
  'sport coat',
  'sports coat',
  'suit jacket',
  'bomber jacket',
  'leather jacket',
  'denim jacket',
  'puffer jacket',
  'rain jacket',
  'field jacket',
  'shirt jacket',
  'shacket',
  'trench coat',
  'overcoat',
  'topcoat',
  'pea coat',
  'peacoat',
  'puffer coat',
  // tops – multi-word first
  'dress shirt',
  'button down',
  'button up',
  'camp shirt',
  'camp collar',
  'polo shirt',
  'rugby shirt',
  'henley shirt',
  't shirt',
  'tee shirt',
  'tank top',
  'crop top',
  'tube top',
  'sports bra',
  'sport bra',
  'bralette',
  // bottoms – multi-word first
  'cargo pants',
  'dress pants',
  'wide leg pants',
  'jogger pants',
  'cargo shorts',
  'board shorts',
  'swim trunks',
  // shoes – multi-word first
  'chelsea boots',
  'combat boots',
  'ankle boots',
  'knee boots',
  'dress shoes',
  'running shoes',
  // dresses / jumpsuits – multi-word first
  'maxi dress',
  'midi dress',
  'mini dress',
  'wrap dress',
  'shirt dress',
  // single-word outerwear
  'blazer',
  'coat',
  'jacket',
  'parka',
  'anorak',
  'windbreaker',
  'vest',
  'gilet',
  'cape',
  'poncho',
  'puffer',
  // single-word tops
  'shirt',
  'blouse',
  'tunic',
  'camisole',
  'bodysuit',
  'sweater',
  'jumper',
  'pullover',
  'hoodie',
  'cardigan',
  'sweatshirt',
  'turtleneck',
  'crewneck',
  // single-word bottoms
  'pants',
  'trousers',
  'chinos',
  'jeans',
  'leggings',
  'joggers',
  'shorts',
  'skirt',
  'culottes',
  // single-word shoes
  'loafers',
  'oxfords',
  'derbies',
  'brogues',
  'monks',
  'mules',
  'clogs',
  'boots',
  'sneakers',
  'trainers',
  'sandals',
  'espadrilles',
  'heels',
  'pumps',
  'flats',
  'slides',
  'slippers',
  'moccasins',
  // dresses / jumpsuits
  'dress',
  'gown',
  'jumpsuit',
  'romper',
  'overalls',
  // accessories (garment-adjacent)
  'scarf',
  'tie',
  'belt',
  'hat',
  'cap',
  'beanie',
  'gloves',
];

// Build a Set of the normalized phrases for O(1) lookup during candidate matching
const KNOWN_GARMENT_TOKEN_SET = new Set(
  KNOWN_GARMENT_PHRASES.map((p) => p.toLowerCase()),
);

// ── Category families for controlled equivalency in CATEGORY_DRIFT gate ──
// Tokens within the same family are considered stylistically interchangeable.
const CATEGORY_FAMILIES: Record<string, string[]> = {
  formal_shoes: [
    'oxford',
    'oxfords',
    'derby',
    'derbies',
    'loafers',
    'dress shoes',
    'monks',
    'brogues',
  ],
  tailored_outerwear: [
    'blazer',
    'sport coat',
    'sports coat',
    'suit jacket',
    'tailored jacket',
  ],
  tailored_trousers: ['trousers', 'dress pants', 'chinos'],
  dress_shirts: ['dress shirt', 'button down', 'button up', 'button up shirt'],
};

// Pre-compute token → family lookup for O(1) matching
const TOKEN_TO_FAMILY = new Map<string, string>();
for (const [family, tokens] of Object.entries(CATEGORY_FAMILIES)) {
  for (const token of tokens) {
    TOKEN_TO_FAMILY.set(token, family);
  }
}

/** Returns true if any intent token shares a category family with any candidate token. */
function sharesFamily(
  intentTokens: string[],
  candidateTokens: Set<string>,
): boolean {
  for (const gi of intentTokens) {
    const family = TOKEN_TO_FAMILY.get(gi);
    if (!family) continue;
    for (const ct of candidateTokens) {
      if (TOKEN_TO_FAMILY.get(ct) === family) return true;
    }
  }
  return false;
}

/**
 * Extract explicit garment-type tokens from a free-text description.
 * Multi-word phrases are matched greedily before single-word tokens.
 * Returns de-duped garment tokens in order of appearance.
 */
export function extractGarmentIntent(description: string): string[] {
  const text = description
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const seen = new Set<string>();
  const result: string[] = [];
  for (const phrase of KNOWN_GARMENT_PHRASES) {
    if (text.includes(phrase) && !seen.has(phrase)) {
      seen.add(phrase);
      result.push(phrase);
    }
  }
  return result;
}

/**
 * Build a flat set of garment tokens from a candidate item's metadata.
 * Used by the garment category drift gate.
 */
export function extractCandidateGarmentTokens(item: {
  main_category?: string;
  subcategory?: string;
  item_type?: string;
  name?: string;
}): Set<string> {
  const parts: string[] = [];
  if (item.main_category) parts.push(item.main_category);
  if (item.subcategory) parts.push(item.subcategory);
  if (item.item_type) parts.push(item.item_type);
  if (item.name) parts.push(item.name);
  const text = parts
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const tokens = new Set<string>();
  // Match multi-word phrases first, then single tokens
  for (const phrase of KNOWN_GARMENT_PHRASES) {
    if (text.includes(phrase)) {
      tokens.add(phrase);
    }
  }
  // Also add individual words so single-token intents can match
  for (const word of text.split(' ')) {
    if (KNOWN_GARMENT_TOKEN_SET.has(word)) {
      tokens.add(word);
    }
  }
  return tokens;
}

/** Extract all color strings from an item, normalized + de-duped. */
export function extractItemColors(item: ValidatorItem): string[] {
  // Prefer pre-hydrated canonical colors if available
  const a = item as any;
  if (Array.isArray(a.__canonicalColors) && a.__canonicalColors.length > 0)
    return a.__canonicalColors;
  const raw: string[] = [];
  if (item.color) raw.push(item.color);
  // Safety net: enriched items may carry extra color fields
  if (Array.isArray(a.colors)) raw.push(...a.colors);
  if (typeof a.metadata?.color === 'string') raw.push(a.metadata.color);
  if (Array.isArray(a.metadata?.colors)) raw.push(...a.metadata.colors);
  if (typeof a.enrichment?.color === 'string') raw.push(a.enrichment.color);
  if (Array.isArray(a.enrichment?.colors)) raw.push(...a.enrichment.colors);
  // Normalize + dedupe
  const seen = new Set<string>();
  const result: string[] = [];
  for (const c of raw) {
    if (typeof c !== 'string') continue;
    const n = c.trim().toLowerCase();
    if (n && !seen.has(n)) {
      seen.add(n);
      result.push(n);
    }
  }
  return result;
}

/** Expand avoided colors with known synonyms (bidirectional). */
export function expandAvoidColors(avoid: string[]): string[] {
  const expanded = new Set<string>();
  for (const c of avoid) {
    const norm = c.trim().toLowerCase();
    if (!norm) continue;
    expanded.add(norm);
    for (const [canonical, synonyms] of Object.entries(COLOR_SYNONYMS)) {
      if (norm === canonical) synonyms.forEach((s) => expanded.add(s));
      if (synonyms.includes(norm)) expanded.add(canonical);
    }
  }
  return [...expanded];
}

/**
 * Token-safe color match: does item color `ic` match avoided color `ac`?
 *
 * Rules:
 * 1. Exact normalized match → true
 * 2. Multi-word avoid phrase: one-way containment icNorm.includes(acNorm) → true
 *    (NEVER reverse: "dark blue".includes("blue") must NOT trigger when avoid="navy")
 * 3. Single-token avoid: match only if that token appears as a full token in item color
 *    e.g. avoid "navy" matches "navy blue" (token "navy" present)
 *         avoid "navy" does NOT match "blue" (token "navy" absent)
 */
export function colorMatchesSafe(ic: string, ac: string): boolean {
  const icNorm = ic.trim().toLowerCase().replace(/\s+/g, ' ');
  const acNorm = ac.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!icNorm || !acNorm) return false;

  // 1. Exact match
  if (icNorm === acNorm) return true;

  // 2. Multi-word avoid: check if item color contains the full phrase
  if (acNorm.includes(' ')) {
    return icNorm.includes(acNorm);
  }

  // 3. Single-token avoid: must appear as a full token in item color
  const icTokens = icNorm.split(/[^a-z]+/).filter(Boolean);
  return icTokens.includes(acNorm);
}

// ── Import for dual avoid-color expansion ──────────────────────────────────
// Local re-export to avoid circular dependency:
// expandStylistAvoidColors lives in stylistQualityGate.ts.
// We import it lazily inside validateItemAgainstIntent to keep this module
// zero-side-effect at parse time.
import { expandStylistAvoidColors } from '../stylistQualityGate';

/**
 * Unified drift validation gate — deterministic, reject-only.
 *
 * Checks a single candidate item against:
 *   1. Avoid-color expansion (synonym + family)
 *   2. Color intent extracted from slot/query description
 *   3. Garment-type intent extracted from slot/query description
 *
 * Returns { valid: true } when the item passes ALL gates,
 * or { valid: false, reason } on the first failing gate.
 *
 * Callers MUST pass a meaningful `slotDescription` (per-slot LLM text or the
 * user query). Passing an empty string disables color/garment intent gates,
 * which lets wrong-color items through.
 */
export function validateItemAgainstIntent(opts: {
  slotDescription: string;
  candidateItem: {
    color?: string;
    color_family?: string;
    name?: string;
    main_category?: string;
    subcategory?: string;
    item_type?: string;
  };
  avoidColors?: string[];
}): { valid: boolean; reason?: string } {
  const { slotDescription, candidateItem, avoidColors } = opts;

  // ── 1. Avoid-color gate ──────────────────────────────────────────────────
  if (avoidColors && avoidColors.length > 0) {
    const expandedAvoid = new Set([
      ...expandAvoidColors(avoidColors),
      ...expandStylistAvoidColors(avoidColors),
    ]);
    const itemColors = extractItemColors(candidateItem as any);
    if (candidateItem.color_family) {
      itemColors.push(candidateItem.color_family.trim().toLowerCase());
    }
    for (const ic of itemColors) {
      for (const ac of expandedAvoid) {
        if (colorMatchesSafe(ic, ac)) {
          return {
            valid: false,
            reason: `AVOID_COLOR: "${ic}" matches avoided "${ac}"`,
          };
        }
      }
    }
  }

  // ── 2. Color intent gate ─────────────────────────────────────────────────
  const intentColors = extractColorIntent(slotDescription);
  if (intentColors.length > 0) {
    const candidateColorStrs = extractItemColors(candidateItem as any);
    if (candidateItem.color_family) {
      candidateColorStrs.push(candidateItem.color_family.trim().toLowerCase());
    }
    // Also pull color-like tokens from item name (e.g. "Yellow Hooded Puffer")
    if (candidateItem.name) {
      candidateColorStrs.push(candidateItem.name.trim().toLowerCase());
    }
    const candidateTokens = new Set<string>();
    for (const c of candidateColorStrs) {
      for (const t of c.replace(/[^a-z\s]/g, ' ').split(/\s+/)) {
        if (t) candidateTokens.add(t);
      }
    }
    if (!intentColors.some((ic) => candidateTokens.has(ic))) {
      return {
        valid: false,
        reason: `COLOR_DRIFT: intent [${intentColors}] no overlap with candidate [${[...candidateTokens].slice(0, 10)}]`,
      };
    }
  }

  // ── 3. Garment intent gate ───────────────────────────────────────────────
  const garmentIntent = extractGarmentIntent(slotDescription);
  if (garmentIntent.length > 0) {
    const candidateGarmentTokens = extractCandidateGarmentTokens(candidateItem);
    if (!garmentIntent.some((gi) => candidateGarmentTokens.has(gi))) {
      // Allow if intent and candidate belong to the same category family
      if (!sharesFamily(garmentIntent, candidateGarmentTokens)) {
        return {
          valid: false,
          reason: `CATEGORY_DRIFT: intent [${garmentIntent}] no overlap with candidate [${[...candidateGarmentTokens].slice(0, 10)}]`,
        };
      }
    }
  }

  return { valid: true };
}

function checkAvoidColors(
  items: ValidatorItem[],
  ctx: ValidatorContext,
): string | null {
  const avoid = ctx.styleProfile?.avoid_colors;
  if (!avoid || avoid.length === 0) return null;
  const expandedAvoid = expandAvoidColors(avoid);
  for (const item of items) {
    const itemColors = extractItemColors(item);
    for (const ic of itemColors) {
      for (const ac of expandedAvoid) {
        if (colorMatchesSafe(ic, ac)) {
          return `AVOID_COLOR: item ${item.id} color "${ic}" matches avoided "${ac}"`;
        }
      }
    }
  }
  return null;
}

function checkAvoidMaterials(
  items: ValidatorItem[],
  ctx: ValidatorContext,
): string | null {
  const avoid = ctx.styleProfile?.avoid_materials;
  if (!avoid || avoid.length === 0) return null;
  for (const item of items) {
    if (!item.material) continue;
    const matLower = item.material.toLowerCase();
    for (const am of avoid) {
      if (matLower.includes(am.toLowerCase())) {
        return `AVOID_MATERIAL: item ${item.id} material "${item.material}" matches avoided "${am}"`;
      }
    }
  }
  return null;
}

const FORMALITY_RANKS = [
  'Casual',
  'Smart Casual',
  'Business Casual',
  'Business Formal',
  'Black Tie',
];

function checkFormalityFloor(
  items: ValidatorItem[],
  ctx: ValidatorContext,
): string | null {
  const floor = ctx.styleProfile?.formality_floor;
  if (!floor || floor === 'No minimum') return null;
  const floorIdx = FORMALITY_RANKS.indexOf(floor);
  if (floorIdx < 0) return null;
  for (const item of items) {
    // Estimate item formality from dress_code or formality_score
    let itemIdx = -1;
    if (item.dress_code) {
      const dc = item.dress_code;
      const dcIdx = FORMALITY_RANKS.findIndex(
        (r) => r.toLowerCase() === dc.toLowerCase(),
      );
      if (dcIdx >= 0) itemIdx = dcIdx;
    }
    if (itemIdx < 0 && item.formality_score != null) {
      // Map 1-10 score → 0-4 rank
      itemIdx = Math.min(
        4,
        Math.max(0, Math.round((item.formality_score / 10) * 4)),
      );
    }
    if (itemIdx < 0) continue; // no formality data → fail-open
    // 2+ ranks below floor → hard fail (1-step tolerance)
    if (floorIdx - itemIdx >= 2) {
      return `FORMALITY_FLOOR: item ${item.id} formality rank ${FORMALITY_RANKS[itemIdx] ?? itemIdx} is 2+ below floor "${floor}"`;
    }
  }
  return null;
}

function checkWalkability(
  items: ValidatorItem[],
  ctx: ValidatorContext,
): string | null {
  const req = ctx.styleProfile?.walkability_requirement;
  if (!req || req === 'Low') return null;
  for (const item of items) {
    if (item.slot !== 'shoes') continue;
    const text = `${item.subcategory ?? ''} ${item.name ?? ''}`.toLowerCase();
    if (req === 'High' && /stiletto|platform heel|sky.?high/i.test(text)) {
      return `WALKABILITY: item ${item.id} ("${text.trim()}") incompatible with High walkability`;
    }
    if (req === 'Medium' && /stiletto/i.test(text)) {
      return `WALKABILITY: item ${item.id} ("${text.trim()}") incompatible with Medium walkability`;
    }
  }
  return null;
}

// ── Soft Penalty Checks ─────────────────────────────────────────────────────

function penaltyFormalityIncoherence(items: ValidatorItem[]): string | null {
  const scores = items
    .map((i) => getNum(i.formality_score))
    .filter((s): s is number => s != null);
  if (scores.length < 2) return null;
  const range = Math.max(...scores) - Math.min(...scores);
  if (range > 4) return 'FORMALITY_INCOHERENCE';
  return null;
}

function penaltyFitMismatch(
  items: ValidatorItem[],
  ctx: ValidatorContext,
): string | null {
  const prefs = ctx.styleProfile?.fit_preferences;
  if (!prefs || prefs.length === 0) return null;
  const prefsLower = prefs.map((p) => p.toLowerCase());
  for (const item of items) {
    if (!item.fit) continue;
    const fitLower = item.fit.toLowerCase();
    // Penalize if user wants slim and item is oversized (or vice versa)
    if (prefsLower.includes('slim') && fitLower.includes('oversized'))
      return 'FIT_PREFERENCE_MISMATCH';
    if (prefsLower.includes('oversized') && fitLower.includes('slim'))
      return 'FIT_PREFERENCE_MISMATCH';
  }
  return null;
}

function penaltyFabricClimate(
  items: ValidatorItem[],
  ctx: ValidatorContext,
): string | null {
  if (!ctx.climateZone) return null;
  const zone = ctx.climateZone;
  const isHot = zone === 'hot' || zone === 'warm';
  const isCold = zone === 'cold' || zone === 'freezing';
  const hotBad = ['wool', 'cashmere', 'fleece', 'down', 'velvet', 'corduroy'];
  const coldBad = ['linen', 'chiffon', 'mesh'];

  for (const item of items) {
    const mat = lc(item.material);
    if (!mat) continue;
    if (isHot && hotBad.some((f) => mat.includes(f)))
      return 'FABRIC_CLIMATE_MISMATCH';
    if (isCold && coldBad.some((f) => mat.includes(f)))
      return 'FABRIC_CLIMATE_MISMATCH';
  }
  return null;
}

function penaltyDislikedStyle(
  items: ValidatorItem[],
  ctx: ValidatorContext,
): string | null {
  const disliked = ctx.styleProfile?.disliked_styles;
  if (!disliked || disliked.length === 0) return null;
  for (const item of items) {
    const tokens = [
      ...(item.style_descriptors ?? []),
      ...(item.style_archetypes ?? []),
    ];
    if (tokens.length === 0) continue;
    if (intersects(tokens, disliked)) return 'DISLIKED_STYLE_MATCH';
  }
  return null;
}

function penaltyStylePreference(
  items: ValidatorItem[],
  ctx: ValidatorContext,
): string | null {
  const prefs = ctx.styleProfile?.style_preferences;
  if (!prefs || prefs.length === 0) return null;
  for (const item of items) {
    const tokens = [
      ...(item.style_descriptors ?? []),
      ...(item.style_archetypes ?? []),
    ];
    if (tokens.length === 0) continue;
    if (intersects(tokens, prefs)) return null; // match is GOOD — no penalty
  }
  // No items matched any style preference
  return 'STYLE_PREFERENCE_MISMATCH';
}

function penaltyAvoidPatterns(
  items: ValidatorItem[],
  ctx: ValidatorContext,
): string | null {
  const avoid = ctx.styleProfile?.avoid_patterns;
  if (!avoid || avoid.length === 0) return null;
  for (const item of items) {
    const descriptors = item.style_descriptors ?? [];
    if (descriptors.length === 0) continue;
    if (intersects(descriptors, avoid)) return 'AVOID_PATTERN_MATCH';
  }
  return null;
}

function penaltySilhouetteMismatch(
  items: ValidatorItem[],
  ctx: ValidatorContext,
): string | null {
  const pref = ctx.styleProfile?.silhouette_preference;
  if (!pref || pref === 'Mix of both') return null;
  for (const item of items) {
    if (!item.fit) continue;
    const fitLower = item.fit.toLowerCase();
    if (pref === 'Structured' && /oversized|relaxed|loose/i.test(fitLower)) {
      return 'SILHOUETTE_MISMATCH';
    }
    if (pref === 'Relaxed' && /slim|tailored|structured/i.test(fitLower)) {
      return 'SILHOUETTE_MISMATCH';
    }
  }
  return null;
}

// ── Public API ──────────────────────────────────────────────────────────────

export function validateOutfit(
  items: ValidatorItem[],
  ctx: ValidatorContext,
): ValidationResult {
  // // ALWAYS-ON: prove what avoid_colors + item colors the validator sees
  // console.log(
  //   JSON.stringify({
  //     _tag: 'AVOID_COLOR_INPUT_PROOF',
  //     avoid: ctx?.styleProfile?.avoid_colors ?? null,
  //     firstItemId: items?.[0]?.id ?? null,
  //     firstItemColors: extractItemColors(items?.[0] ?? ({} as ValidatorItem)),
  //   }),
  // );

  const hardFails: string[] = [];
  const softPenalties: string[] = [];

  // Hard fails
  const pres = checkCrossPresentation(items, ctx.userPresentation);
  if (pres) hardFails.push(pres);

  const weather = checkWeatherContradiction(items, ctx.climateZone);
  if (weather) hardFails.push(weather);

  const dc = checkDressCodeMismatch(items, ctx.requestedDressCode);
  if (dc) hardFails.push(dc);

  const slots = checkRequiredSlots(items);
  if (slots) hardFails.push(slots);

  // P0 profile vetoes (hard fails)
  const coverage = checkCoverageNoGo(items, ctx);
  if (coverage) hardFails.push(coverage);

  const avoidCol = checkAvoidColors(items, ctx);
  if (avoidCol) hardFails.push(avoidCol);

  // // AVOID_COLOR_PROOF: low-volume proof log when avoid_colors is active
  // if (ctx.styleProfile?.avoid_colors?.length) {
  //   const expanded = expandAvoidColors(ctx.styleProfile.avoid_colors);
  //   console.log(
  //     JSON.stringify({
  //       _tag: 'AVOID_COLOR_PROOF',
  //       avoidList: ctx.styleProfile.avoid_colors,
  //       expandedAvoidList: expanded,
  //       items: items.map((it) => {
  //         const colors = extractItemColors(it);
  //         return {
  //           id: it.id,
  //           name: it.name,
  //           slot: it.slot,
  //           extractedColors: colors,
  //           matched: colors.some((ic) =>
  //             expanded.some((ac) => colorMatchesSafe(ic, ac)),
  //           ),
  //         };
  //       }),
  //     }),
  //   );
  // }

  const avoidMat = checkAvoidMaterials(items, ctx);
  if (avoidMat) hardFails.push(avoidMat);

  const formalFloor = checkFormalityFloor(items, ctx);
  if (formalFloor) hardFails.push(formalFloor);

  const walkable = checkWalkability(items, ctx);
  if (walkable) hardFails.push(walkable);

  // Soft penalties (skip if already hard-failed for efficiency)
  if (hardFails.length === 0) {
    const formality = penaltyFormalityIncoherence(items);
    if (formality) softPenalties.push(formality);

    const fit = penaltyFitMismatch(items, ctx);
    if (fit) softPenalties.push(fit);

    const fabric = penaltyFabricClimate(items, ctx);
    if (fabric) softPenalties.push(fabric);

    const disliked = penaltyDislikedStyle(items, ctx);
    if (disliked) softPenalties.push(disliked);

    const stylePref = penaltyStylePreference(items, ctx);
    if (stylePref) softPenalties.push(stylePref);

    const avoidPat = penaltyAvoidPatterns(items, ctx);
    if (avoidPat) softPenalties.push(avoidPat);

    const silhouette = penaltySilhouetteMismatch(items, ctx);
    if (silhouette) softPenalties.push(silhouette);
  }

  const totalPenalty = softPenalties.length * -3;
  const coherenceScore =
    hardFails.length > 0 ? 0 : Math.max(0, 100 + totalPenalty);

  return {
    valid: hardFails.length === 0,
    hardFails,
    softPenalties,
    totalPenalty,
    coherenceScore,
  };
}

export function validateOutfits(
  outfits: Array<{ outfitId: string; items: ValidatorItem[] }>,
  ctx: ValidatorContext,
): BatchValidationResult {
  return {
    results: outfits.map((o) => ({
      outfitId: o.outfitId,
      validation: validateOutfit(o.items, ctx),
    })),
  };
}

/**
 * Temperature to climate zone helper (pure).
 */
export function tempToClimateZone(
  tempF: number | undefined | null,
): ValidatorContext['climateZone'] | undefined {
  if (tempF == null) return undefined;
  if (tempF < 32) return 'freezing';
  if (tempF < 45) return 'cold';
  if (tempF < 55) return 'cool';
  if (tempF < 65) return 'mild';
  if (tempF < 85) return 'warm';
  return 'hot';
}
