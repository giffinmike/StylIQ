/**
 * Style Judge — Post-assembly curation layer.
 *
 * Scores full outfits holistically and selects the best N.
 * Pure deterministic logic. No LLM calls. No DB calls. No async.
 * Fail-open: missing metadata -> skip that check, never penalize.
 *
 * Starts at 100, applies penalties per 6 rule groups (capped per group):
 *   1. Formality Coherence        (max -35)
 *   2. Silhouette Balance          (max -20)
 *   3. Material Hierarchy          (max -20)
 *   4. Color Harmony               (max -15, +5 bonus)
 *   5. Intent Clarity              (max -25)
 *   6. Occasion Appropriateness    (max -30)
 */

// ── Types ─────────────────────────────────────────────────────────────────

export type JudgeItem = {
  id: string;
  name?: string;
  category?: string; // Stylist slot: 'top' | 'bottom' | 'shoes' ...
  main_category?: string; // Studio slot: 'Tops' | 'Bottoms' ...
  subcategory?: string;
  color?: string;
  color_family?: string;
  __canonicalColors?: string[];
  material?: string;
  formality_score?: number;
  dress_code?: string;
  shoe_style?: string;
  slot?: string;
  [key: string]: unknown;
};

export type JudgeOutfit = {
  id?: string;
  outfit_id?: string;
  items: JudgeItem[];
  [key: string]: unknown;
};

export type JudgeContext = {
  requestedDressCode?: string;
  requestedFormality?: 'formal' | 'smart-casual' | 'casual' | 'athletic';
  /** Raw user query text — used for occasion heuristics (e.g. "church outfit") */
  query?: string;
};

export type JudgeScore = {
  total: number;
  penalties: { rule: string; points: number }[];
  bonuses: { rule: string; points: number }[];
};

// ── Slot normalization ────────────────────────────────────────────────────

function getSlot(item: JudgeItem): string {
  if (item.slot) return item.slot.toLowerCase();
  if (item.category) return item.category.toLowerCase();
  const mc = item.main_category;
  if (mc) return mc.toLowerCase();
  return 'unknown';
}

// ── Formality estimation ──────────────────────────────────────────────────

const DRESS_CODE_FORMALITY: Record<string, number> = {
  ultracasual: 1,
  casual: 3,
  smartcasual: 5,
  'smart casual': 5,
  businesscasual: 6,
  'business casual': 6,
  business: 7,
  formal: 8,
  blacktie: 9,
  'black tie': 9,
};

const FORMALITY_KEYWORDS: [RegExp, number][] = [
  [/\b(joggers?|sweatpants?|hoodie|track\s?pants?|gym\s?shorts?)\b/i, 1],
  [/\b(flip\s?flops?|slides?|crocs)\b/i, 1],
  [/\b(t-?shirt|tank\s?top|shorts|sneakers?|jeans|denim)\b/i, 3],
  [/\b(polo|chinos?|khakis?|loafers?|boat\s?shoes?)\b/i, 5],
  [
    /\b(dress\s?shirt|button.?down|oxford|blazer|trousers|slacks|pumps|heels)\b/i,
    7,
  ],
  [/\b(suit|tuxedo|gown|cufflinks?|bow\s?tie)\b/i, 9],
];

export function estimateFormality(item: JudgeItem): number | null {
  if (
    typeof item.formality_score === 'number' &&
    isFinite(item.formality_score)
  ) {
    const s = item.formality_score;
    return s > 10 ? s / 10 : s;
  }

  if (item.dress_code) {
    const dc = item.dress_code.toLowerCase().replace(/[-_]/g, '');
    const dcSpaced = item.dress_code.toLowerCase().replace(/[-_]/g, ' ');
    const f = DRESS_CODE_FORMALITY[dc] ?? DRESS_CODE_FORMALITY[dcSpaced];
    if (f != null) return f;
  }

  const text = `${item.subcategory ?? ''} ${item.name ?? ''} ${item.shoe_style ?? ''}`;
  for (const [pattern, formality] of FORMALITY_KEYWORDS) {
    if (pattern.test(text)) return formality;
  }

  return null;
}

// ── Keyword detectors ─────────────────────────────────────────────────────

const ATHLETIC_RE =
  /\b(athletic|gym|sport|workout|running|training|joggers?|sweatpants?|track\s?pants?|performance|activewear)\b/i;

function isAthletic(item: JudgeItem): boolean {
  const slot = getSlot(item);
  if (slot === 'activewear') return true;
  const text = `${item.subcategory ?? ''} ${item.name ?? ''} ${item.material ?? ''}`;
  return ATHLETIC_RE.test(text);
}

const TAILORED_RE =
  /\b(blazer|suit|tuxedo|dress\s?(shirt|pants?)|trousers|slacks|tailored|structured|formal)\b/i;

function isTailored(item: JudgeItem): boolean {
  const text = `${item.subcategory ?? ''} ${item.name ?? ''} ${item.dress_code ?? ''}`;
  return TAILORED_RE.test(text);
}

const BULKY_RE =
  /\b(puffer|oversized|chunky|baggy|wide[- ]?leg|cargo|platform|combat\s?boots?)\b/i;

function isBulky(item: JudgeItem): boolean {
  const text = `${item.subcategory ?? ''} ${item.name ?? ''}`;
  return BULKY_RE.test(text);
}

const WORK_BOOT_RE =
  /\b(work\s?boots?|hiking\s?boots?|combat\s?boots?|timberland)\b/i;

function isWorkBoot(item: JudgeItem): boolean {
  const slot = getSlot(item);
  if (slot !== 'shoes') return false;
  const text = `${item.subcategory ?? ''} ${item.name ?? ''} ${item.shoe_style ?? ''}`;
  return WORK_BOOT_RE.test(text);
}

const BUSINESS_SHOE_RE =
  /\b(loafers?|oxfords?|derbys?|brogues?|monk\s?straps?|heels?|pumps?|dress\s?(shoes?|boots?))\b/i;

function isBusinessShoe(item: JudgeItem): boolean {
  const slot = getSlot(item);
  if (slot !== 'shoes') return false;
  const text = `${item.subcategory ?? ''} ${item.name ?? ''} ${item.shoe_style ?? ''}`;
  return BUSINESS_SHOE_RE.test(text);
}

// ── Material tier detection ───────────────────────────────────────────────

const TAILORING_MAT_RE =
  /\b(wool|twill|oxford|leather|silk|cashmere|tweed|gabardine|satin|velvet)\b/i;
const CASUAL_MAT_RE =
  /\b(jersey|fleece|mesh|athletic|nylon|polyester|neoprene|spandex|lycra|sweat|terry)\b/i;

function getMaterialTier(item: JudgeItem): 'tailoring' | 'casual' | null {
  const mat = item.material;
  if (!mat) return null;
  if (TAILORING_MAT_RE.test(mat)) return 'tailoring';
  if (CASUAL_MAT_RE.test(mat)) return 'casual';
  return null;
}

// ── Color family extraction ───────────────────────────────────────────────

const COLOR_FAMILY_MAP: Record<string, string> = {
  black: 'neutral',
  white: 'neutral',
  gray: 'neutral',
  grey: 'neutral',
  charcoal: 'neutral',
  ivory: 'neutral',
  cream: 'neutral',
  beige: 'neutral',
  taupe: 'neutral',
  khaki: 'neutral',
  tan: 'neutral',
  brown: 'earth',
  camel: 'earth',
  chocolate: 'earth',
  cognac: 'earth',
  burgundy: 'earth',
  olive: 'earth',
  sage: 'earth',
  moss: 'earth',
  rust: 'earth',
  terracotta: 'earth',
  sienna: 'earth',
  copper: 'earth',
  bronze: 'earth',
  navy: 'cool',
  blue: 'cool',
  teal: 'cool',
  indigo: 'cool',
  cobalt: 'cool',
  denim: 'cool',
  slate: 'cool',
  steel: 'cool',
  red: 'warm',
  orange: 'warm',
  coral: 'warm',
  salmon: 'warm',
  peach: 'warm',
  gold: 'warm',
  mustard: 'warm',
  amber: 'warm',
  neon: 'neon',
  fluorescent: 'neon',
  lime: 'neon',
  'hot pink': 'neon',
  electric: 'neon',
  pink: 'pastel',
  lavender: 'pastel',
  lilac: 'pastel',
  mint: 'pastel',
  'baby blue': 'pastel',
  powder: 'pastel',
  green: 'cool',
  emerald: 'cool',
  forest: 'cool',
  hunter: 'cool',
  purple: 'cool',
  plum: 'cool',
  mauve: 'cool',
  violet: 'cool',
  yellow: 'warm',
  lemon: 'warm',
};

function getColorFamily(colorStr: string): string {
  const lower = colorStr.toLowerCase().trim();
  if (COLOR_FAMILY_MAP[lower]) return COLOR_FAMILY_MAP[lower];
  for (const [token, family] of Object.entries(COLOR_FAMILY_MAP)) {
    if (lower.includes(token)) return family;
  }
  return 'unknown';
}

function getItemColorFamilies(item: JudgeItem): string[] {
  const colors: string[] = [];
  if (item.__canonicalColors?.length) {
    colors.push(...item.__canonicalColors);
  } else if (item.color) {
    colors.push(item.color);
  }
  if (item.color_family) {
    colors.push(item.color_family);
  }
  const families = new Set<string>();
  for (const c of colors) {
    const fam = getColorFamily(c);
    if (fam !== 'unknown') families.add(fam);
  }
  return Array.from(families);
}

// ── Request formality detection ───────────────────────────────────────────

function detectRequestedFormality(ctx: JudgeContext): string | null {
  if (ctx.requestedFormality) return ctx.requestedFormality;
  // Check both requestedDressCode and raw query
  const dc = ctx.requestedDressCode?.toLowerCase() ?? '';
  const q = ctx.query?.toLowerCase() ?? '';
  const combined = `${dc} ${q}`;
  if (!combined.trim()) return null;
  if (/formal|black\s?tie|business\s?formal|gala|cocktail/.test(combined))
    return 'formal';
  if (/smart\s?casual|business\s?casual/.test(combined))
    return 'smart-casual';
  if (/athletic|gym|sport|workout/.test(combined)) return 'athletic';
  if (/\bcasual\b|ultracasual|everyday/.test(combined)) return 'casual';
  return null;
}

// ── Occasion heuristic ───────────────────────────────────────────────────

const RESPECTFUL_FORMAL_RE =
  /\b(church|wedding|funeral|baptism|christening|communion|service|interview|client\s?meeting|formal|gala|cocktail|black\s?tie)\b/i;

/** Detect if the query implies a respectful-formal occasion. */
export function isRespectfulFormalOccasion(ctx: JudgeContext): boolean {
  const q = ctx.query?.toLowerCase() ?? '';
  const dc = ctx.requestedDressCode?.toLowerCase() ?? '';
  return RESPECTFUL_FORMAL_RE.test(q) || RESPECTFUL_FORMAL_RE.test(dc);
}

// ── Item-level detectors for occasion penalties ──────────────────────────

const JEANS_RE = /\b(jeans|denim\s?(pants?|jeans?))\b/i;

function isJeans(item: JudgeItem): boolean {
  const text = `${item.subcategory ?? ''} ${item.name ?? ''} ${item.material ?? ''}`;
  return JEANS_RE.test(text);
}

const LOUD_SHIRT_RE =
  /\b(hawaiian|aloha|floral\s?(shirt|button)|tropical\s?(shirt|print)|camp\s?collar\s?floral|loud\s?(print|shirt))\b/i;

function isLoudShirt(item: JudgeItem): boolean {
  const slot = getSlot(item);
  if (slot !== 'top' && slot !== 'tops') return false;
  const text = `${item.subcategory ?? ''} ${item.name ?? ''}`;
  return LOUD_SHIRT_RE.test(text);
}

const LOUD_COLOR_RE =
  /\b(magenta|fuchsia|neon|electric|hot\s?pink|fluorescent|lime\s?green|bright\s?orange|acid)\b/i;

function hasLoudColor(item: JudgeItem): boolean {
  const colors: string[] = [];
  if (item.__canonicalColors?.length) colors.push(...item.__canonicalColors);
  else if (item.color) colors.push(item.color);
  return colors.some((c) => LOUD_COLOR_RE.test(c));
}

// ── RULE 1: Formality Coherence (max -35) ─────────────────────────────────

function penaltyFormalityCoherence(
  items: JudgeItem[],
  ctx: JudgeContext,
): number {
  let penalty = 0;

  const formalities: number[] = [];
  for (const item of items) {
    const f = estimateFormality(item);
    if (f != null) formalities.push(f);
  }

  if (formalities.length >= 2) {
    const spread = Math.max(...formalities) - Math.min(...formalities);
    if (spread >= 4) penalty -= 20;
    if (spread >= 6) penalty -= 8;
  }

  const hasAthletic = items.some(isAthletic);
  const hasTailored = items.some(isTailored);
  if (hasAthletic && hasTailored) penalty -= 25;

  const hasJeansBottom = items.some((it) => {
    const slot = getSlot(it);
    return (slot === 'bottom' || slot === 'bottoms') && isJeans(it);
  });
  if (hasJeansBottom && items.some(isBusinessShoe)) penalty -= 8;

  const requested = detectRequestedFormality(ctx);
  if (requested === 'formal') {
    for (const item of items) {
      const slot = getSlot(item);
      if (
        slot === 'bottom' ||
        slot === 'bottoms' ||
        slot === 'shoes'
      ) {
        const f = estimateFormality(item);
        if (f != null && f <= 3) {
          penalty -= 30;
          break;
        }
      }
    }
  }

  if (requested === 'smart-casual') {
    const suitCount = items.filter((it) => {
      const text =
        `${it.subcategory ?? ''} ${it.name ?? ''}`.toLowerCase();
      return /\bsuit\b|tuxedo/.test(text);
    }).length;
    if (suitCount >= 2) penalty -= 15;
  }

  return Math.max(-35, penalty);
}

// ── RULE 2: Silhouette Balance (max -20) ──────────────────────────────────

function penaltySilhouetteBalance(items: JudgeItem[]): number {
  let penalty = 0;

  const bulkySlots = new Set<string>();
  for (const item of items) {
    if (isBulky(item)) {
      const slot = getSlot(item);
      if (['top', 'tops', 'outerwear'].includes(slot)) bulkySlots.add('top');
      if (['bottom', 'bottoms'].includes(slot)) bulkySlots.add('bottom');
      if (slot === 'shoes') bulkySlots.add('shoes');
    }
  }

  if (
    bulkySlots.has('top') &&
    bulkySlots.has('bottom') &&
    bulkySlots.has('shoes')
  )
    penalty -= 20;

  const hasTailoredTop = items.some((it) => {
    const slot = getSlot(it);
    return (slot === 'top' || slot === 'tops') && isTailored(it);
  });
  const hasOversizedAthleticBottom = items.some((it) => {
    const slot = getSlot(it);
    return (
      (slot === 'bottom' || slot === 'bottoms') &&
      isBulky(it) &&
      isAthletic(it)
    );
  });
  if (hasTailoredTop && hasOversizedAthleticBottom) penalty -= 15;

  const nonShoeItems = items.filter((it) => {
    const slot = getSlot(it);
    return slot !== 'shoes' && slot !== 'accessories' && slot !== 'accessory';
  });
  const isTailoredOutfit =
    nonShoeItems.length >= 2 &&
    nonShoeItems.every((it) => {
      const f = estimateFormality(it);
      return f != null && f >= 6;
    });
  if (isTailoredOutfit && items.some(isWorkBoot)) penalty -= 20;

  return Math.max(-20, penalty);
}

// ── RULE 3: Material Hierarchy (max -20) ──────────────────────────────────

function penaltyMaterialHierarchy(items: JudgeItem[]): number {
  let penalty = 0;

  const tiers = new Set<string>();
  let hasFormalItem = false;

  for (const item of items) {
    const tier = getMaterialTier(item);
    if (tier) tiers.add(tier);
    const f = estimateFormality(item);
    if (f != null && f >= 7) hasFormalItem = true;
  }

  if (tiers.has('tailoring') && tiers.has('casual')) penalty -= 15;

  if (hasFormalItem) {
    const hasAthleticMat = items.some((it) => {
      const mat = it.material?.toLowerCase() ?? '';
      return /\b(mesh|neoprene|spandex|lycra|athletic|performance)\b/.test(
        mat,
      );
    });
    if (hasAthleticMat) penalty -= 20;
  }

  return Math.max(-20, penalty);
}

// ── RULE 4: Color Harmony (max -15, +5 bonus) ────────────────────────────

function penaltyColorHarmony(items: JudgeItem[]): {
  penalty: number;
  bonus: number;
} {
  let penalty = 0;
  let bonus = 0;

  const allFamilies = new Set<string>();
  for (const item of items) {
    for (const fam of getItemColorFamilies(item)) allFamilies.add(fam);
  }

  if (allFamilies.size === 0) return { penalty: 0, bonus: 0 };

  if (allFamilies.size > 4) penalty -= 10;
  if (allFamilies.has('neon') && allFamilies.has('earth')) penalty -= 10;

  const nonNeutral = Array.from(allFamilies).filter((f) => f !== 'neutral');
  if (allFamilies.has('neutral') && nonNeutral.length === 1) bonus += 5;
  if (allFamilies.size === 1 && items.length >= 3) penalty -= 4;

  return { penalty: Math.max(-15, penalty), bonus: Math.min(5, bonus) };
}

// ── RULE 5: Intent Clarity (max -25) ──────────────────────────────────────

function penaltyIntentClarity(
  items: JudgeItem[],
  ctx: JudgeContext,
): number {
  let penalty = 0;

  const formalities: number[] = [];
  let athleticCount = 0;
  let tailoredCount = 0;

  for (const item of items) {
    const f = estimateFormality(item);
    if (f != null) formalities.push(f);
    if (isAthletic(item)) athleticCount++;
    if (isTailored(item)) tailoredCount++;
  }

  if (athleticCount >= 1 && tailoredCount >= 1) penalty -= 20;

  const requested = detectRequestedFormality(ctx);
  if (requested && formalities.length >= 2) {
    const avg = formalities.reduce((a, b) => a + b, 0) / formalities.length;
    if (requested === 'formal' && avg < 5) penalty -= 25;
    if (requested === 'casual' && avg > 7) penalty -= 25;
    if (requested === 'athletic' && avg > 5) penalty -= 25;
  }

  return Math.max(-25, penalty);
}

// ── RULE 6: Occasion Appropriateness (max -30) ───────────────────────────
// Penalizes items that are inappropriate for respectful-formal occasions
// (church, wedding, funeral, interview, etc.)

function penaltyOccasionAppropriateness(
  items: JudgeItem[],
  ctx: JudgeContext,
): number {
  if (!isRespectfulFormalOccasion(ctx)) return 0;

  let penalty = 0;

  for (const item of items) {
    const slot = getSlot(item);

    // A) Jeans in a respectful-formal context
    if ((slot === 'bottom' || slot === 'bottoms') && isJeans(item)) {
      penalty -= 25;
      break; // one jeans penalty is enough
    }
  }

  // B) Hawaiian / loud floral shirts
  if (items.some(isLoudShirt)) penalty -= 25;

  // C) Loud saturated colors on tailored pieces (magenta blazer etc.)
  for (const item of items) {
    if (isTailored(item) && hasLoudColor(item)) {
      penalty -= 20;
      break;
    }
  }

  return Math.max(-30, penalty);
}

// ── Public API ────────────────────────────────────────────────────────────

export function scoreOutfit(
  outfit: JudgeOutfit,
  context: JudgeContext = {},
): JudgeScore {
  const items = outfit.items ?? [];
  if (items.length === 0) return { total: 100, penalties: [], bonuses: [] };

  const penalties: { rule: string; points: number }[] = [];
  const bonuses: { rule: string; points: number }[] = [];

  const p1 = penaltyFormalityCoherence(items, context);
  if (p1 < 0) penalties.push({ rule: 'formality_coherence', points: p1 });

  const p2 = penaltySilhouetteBalance(items);
  if (p2 < 0) penalties.push({ rule: 'silhouette_balance', points: p2 });

  const p3 = penaltyMaterialHierarchy(items);
  if (p3 < 0) penalties.push({ rule: 'material_hierarchy', points: p3 });

  const color = penaltyColorHarmony(items);
  if (color.penalty < 0)
    penalties.push({ rule: 'color_harmony', points: color.penalty });
  if (color.bonus > 0)
    bonuses.push({ rule: 'color_harmony_bonus', points: color.bonus });

  const p5 = penaltyIntentClarity(items, context);
  if (p5 < 0) penalties.push({ rule: 'intent_clarity', points: p5 });

  const p6 = penaltyOccasionAppropriateness(items, context);
  if (p6 < 0)
    penalties.push({ rule: 'occasion_appropriateness', points: p6 });

  // ── Positive ranking signals ────────────────────────────────────────────

  // A) Hero Balance: exactly one anchor piece is rewarded; 0 or >1 is dinged.
  const heroCount = items.filter(
    (it) => typeof it.role === 'string' && it.role.toLowerCase() === 'hero',
  ).length;
  if (heroCount === 1) {
    bonuses.push({ rule: 'hero_balance', points: 6 });
  } else {
    penalties.push({ rule: 'hero_balance', points: -4 });
  }

  // B) Color Intentionality: reward considered palettes (no penalty branch).
  const allFamilies = new Set<string>();
  for (const it of items) {
    for (const f of getItemColorFamilies(it)) allFamilies.add(f);
  }
  if (allFamilies.size === 2) {
    bonuses.push({ rule: 'color_intentionality', points: 5 });
  } else if (allFamilies.size === 3 && allFamilies.has('neutral')) {
    bonuses.push({ rule: 'color_intentionality', points: 3 });
  }

  // C) Silhouette Balance: reward tailored/casual contrast on a 1-top + 1-bottom pair.
  const tops = items.filter((it) => {
    const s = getSlot(it);
    return s === 'top' || s === 'tops';
  });
  const bottoms = items.filter((it) => {
    const s = getSlot(it);
    return s === 'bottom' || s === 'bottoms';
  });
  if (tops.length === 1 && bottoms.length === 1) {
    const label = (it: JudgeItem): 'tailored' | 'casual' | null => {
      const t = `${it.dress_code ?? ''} ${it.subcategory ?? ''}`.toLowerCase();
      if (/\b(tailored|fitted)\b/.test(t)) return 'tailored';
      if (/\b(casual|relaxed)\b/.test(t)) return 'casual';
      return null;
    };
    const a = label(tops[0]);
    const b = label(bottoms[0]);
    if (
      (a === 'tailored' && b === 'casual') ||
      (a === 'casual' && b === 'tailored')
    ) {
      bonuses.push({ rule: 'silhouette_balance_bonus', points: 5 });
    }
  }

  let total = 80;
  for (const p of penalties) total += p.points;
  for (const b of bonuses) total += b.points;
  total = Math.max(0, Math.min(100, total));

  return { total, penalties, bonuses };
}

export function selectTopOutfits<T extends JudgeOutfit>(
  outfits: T[],
  context: JudgeContext = {},
  count = 3,
): T[] {
  if (outfits.length <= count) return outfits;

  const scored = outfits.map((outfit, index) => ({
    outfit,
    index,
    score: scoreOutfit(outfit, context),
  }));

  scored.sort((a, b) => {
    if (a.score.total !== b.score.total) return b.score.total - a.score.total;
    return a.index - b.index;
  });

  console.log(
    JSON.stringify({
      _tag: 'STYLIST_JUDGE_SCORES',
      scores: scored.map((s) => s.score.total),
      keptIndexes: scored.slice(0, count).map((s) => s.index),
    }),
  );

  return scored.slice(0, count).map((s) => s.outfit);
}
