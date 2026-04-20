/**
 * Outfit Composition Context
 *
 * Deterministic coordination layer that ensures items are selected
 * with awareness of each other, anchored on a hero piece.
 *
 * Used by: completeness injection, synthetic expansion, outfit scoring.
 * NOT used by: LLM selection, validators, vetoes, style judge.
 */

// ── Types ──────────────────────────────────────────────────────────

export type ColorTemperature = 'warm' | 'cool' | 'neutral' | 'mixed';
export type SilhouetteProfile = 'structured' | 'relaxed' | 'mixed';
export type MaterialTier = 'athletic' | 'casual' | 'smart' | 'formal';

export interface OutfitCompositionContext {
  anchorItemId: string;
  anchorCategory: string;
  paletteProfile: {
    temperature: ColorTemperature;
    dominantFamilies: string[];
    neutralBase: boolean;
  };
  silhouetteProfile: SilhouetteProfile;
  materialTier: MaterialTier;
  formalityTarget: number; // 0–4
  requestedDescription?: string; // overall request text for tone detection (e.g., "understated", "minimal")
}

/**
 * Minimal item shape expected by composition functions.
 * Matches fields available on fullItemMap entries in ai.service.ts.
 */
export interface CompositionItem {
  id: string;
  category?: string; // simplified: top/bottom/shoes/dress/outerwear/accessory
  main_category?: string;
  subcategory?: string;
  name?: string;
  ai_title?: string;
  color?: string;
  material?: string;
}

// ── Color vocabulary (extracted from ai.service.ts aesthetic helpers) ──

const WARM_COLORS = new Set([
  'red',
  'orange',
  'yellow',
  'coral',
  'peach',
  'gold',
  'amber',
  'rust',
  'burgundy',
  'terracotta',
  'salmon',
  'copper',
  'brick',
  'wine',
  'maroon',
]);

const COOL_COLORS = new Set([
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
  'indigo',
  'sapphire',
  'turquoise',
  'aqua',
  'plum',
  'mauve',
]);

const NEUTRAL_COLORS = new Set([
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
  'olive',
  'camel',
  'stone',
  'oatmeal',
]);

// ── Silhouette vocabulary ──

const STRUCTURED_KEYWORDS = new Set([
  'blazer',
  'sport coat',
  'suit',
  'dress shirt',
  'button down',
  'button-down',
  'oxford',
  'tailored',
  'trouser',
  'slack',
  'dress pant',
  'pencil',
  'sheath',
  'structured',
  'derby',
  'brogue',
  'wingtip',
  'pump',
  'heel',
  'loafer',
]);

const RELAXED_KEYWORDS = new Set([
  'hoodie',
  'sweatshirt',
  'sweatpant',
  'jogger',
  'oversized',
  'relaxed',
  'baggy',
  'cargo',
  't-shirt',
  'tee',
  'tank top',
  'jersey',
  'sneaker',
  'sandal',
  'slide',
  'flip flop',
  'running',
  'athletic',
  'gym',
  'track',
]);

// ── Material tier vocabulary ──

const FORMAL_MATERIALS = new Set([
  'wool',
  'cashmere',
  'silk',
  'satin',
  'velvet',
  'patent',
  'tweed',
  'crepe',
  'brocade',
  'chiffon',
]);

const SMART_MATERIALS = new Set([
  'cotton',
  'linen',
  'twill',
  'poplin',
  'chambray',
  'suede',
  'leather',
  'corduroy',
  'canvas',
  'knit',
]);

const CASUAL_MATERIALS = new Set([
  'denim',
  'jersey',
  'fleece',
  'terry',
  'flannel',
  'canvas',
  'rubber',
]);

const ATHLETIC_MATERIALS = new Set([
  'mesh',
  'nylon',
  'polyester',
  'spandex',
  'lycra',
  'neoprene',
  'gore-tex',
  'ripstop',
  'tech',
  'performance',
  'dri-fit',
  'moisture',
]);

// ── Style-color precision vocabulary (5th dimension) ──

const COLOR_FAMILIES: [string, string[]][] = [
  ['white', ['white', 'off white', 'cream', 'ivory', 'ecru']],
  [
    'beige',
    ['beige', 'tan', 'taupe', 'khaki', 'stone', 'oatmeal', 'sand', 'nude'],
  ],
  ['gray', ['gray', 'grey', 'charcoal', 'silver', 'slate', 'heather']],
  ['black', ['black']],
  ['navy', ['navy', 'dark blue']],
  ['brown', ['brown', 'cognac', 'camel', 'chocolate', 'espresso']],
  ['olive', ['olive', 'army', 'moss']],
  ['rust', ['rust', 'terracotta', 'brick', 'copper']],
  ['burgundy', ['burgundy', 'wine', 'maroon', 'oxblood']],
  ['red', ['red', 'scarlet', 'crimson']],
  ['orange', ['orange', 'tangerine', 'coral', 'peach']],
  ['yellow', ['yellow', 'mustard', 'gold', 'amber']],
  ['pink', ['pink', 'rose', 'blush', 'salmon']],
  ['magenta', ['magenta', 'fuchsia', 'hot pink']],
  ['blue', ['blue', 'cobalt', 'royal', 'indigo', 'sapphire']],
  ['light-blue', ['light blue', 'sky', 'ice', 'powder']],
  ['teal', ['teal', 'turquoise', 'aqua', 'cyan']],
  ['green', ['green', 'emerald', 'forest', 'mint']],
  ['purple', ['purple', 'violet']],
  ['lavender', ['lavender', 'mauve', 'plum', 'periwinkle', 'lilac']],
  ['neon', ['neon']],
  ['bright', ['bright']],
  ['lime', ['lime']],
];

const COLOR_FAMILY_MAP: Record<string, string> = {};
for (const [family, members] of COLOR_FAMILIES) {
  for (const m of members) COLOR_FAMILY_MAP[m] = family;
}

const NEUTRAL_FAMILIES = new Set([
  'white',
  'beige',
  'gray',
  'black',
  'navy',
  'brown',
  'olive',
]);

const LOUD_FAMILIES = new Set([
  'red',
  'magenta',
  'neon',
  'bright',
  'lime',
  'purple',
]);

const UNDERSTATED_TONE_WORDS = [
  'understated',
  'low-key',
  'lowkey',
  'minimal',
  'minimalist',
  'simple',
  'effortless',
  'subtle',
  'muted',
  'quiet',
  'clean',
  'classic',
  'neutral',
  'monochrome',
  'tonal',
  'balanced',
];

const STATEMENT_KEYWORDS = [
  'logo',
  'graphic',
  'statement',
  'print',
  'printed',
  'pattern',
  'patterned',
  'tie-dye',
  'neon',
  'sequin',
  'glitter',
  'metallic',
  'colorblock',
  'striped',
];

// ── Anchor priority by category (spec: outerwear > shoes > statement top > statement bottom > dress) ──

const ANCHOR_PRIORITY: Record<string, number> = {
  outerwear: 0,
  shoes: 1,
  top: 2,
  bottom: 3,
  dress: 4,
  accessory: 99,
  activewear: 99,
  swimwear: 99,
};

// ── Compatibility matrices ──

/** Temperature compatibility: which temperatures pair well together */
const TEMP_COMPAT: Record<ColorTemperature, Set<ColorTemperature>> = {
  warm: new Set(['warm', 'neutral']),
  cool: new Set(['cool', 'neutral']),
  neutral: new Set(['warm', 'cool', 'neutral', 'mixed']),
  mixed: new Set(['neutral', 'mixed']),
};

/** Material tier adjacency: tiers within 1 step are compatible */
const TIER_ORDER: MaterialTier[] = ['athletic', 'casual', 'smart', 'formal'];

/** Silhouette compatibility */
const SILHOUETTE_COMPAT: Record<SilhouetteProfile, Set<SilhouetteProfile>> = {
  structured: new Set(['structured', 'mixed']),
  relaxed: new Set(['relaxed', 'mixed']),
  mixed: new Set(['structured', 'relaxed', 'mixed']),
};

// ── Helper: extract color words from a color string ──

function extractColorWords(colorStr: string): string[] {
  return (colorStr || '')
    .toLowerCase()
    .split(/[\s,/&+\-]+/)
    .filter(Boolean);
}

// ── Helper: detect keywords in subcategory + name ──

function textContainsKeyword(text: string, keywords: Set<string>): boolean {
  const lower = text.toLowerCase();
  for (const kw of keywords) {
    if (lower.includes(kw)) return true;
  }
  return false;
}

// ── Style-color precision helpers ──

function extractColorTokens(text: string): string[] {
  if (!text) return [];
  const lower = text
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = lower.split(' ');
  const tokens: string[] = [];
  for (let i = 0; i < words.length; i++) {
    if (i < words.length - 1) {
      const bigram = `${words[i]} ${words[i + 1]}`;
      if (COLOR_FAMILY_MAP[bigram] !== undefined) {
        tokens.push(bigram);
        i++;
        continue;
      }
    }
    if (COLOR_FAMILY_MAP[words[i]] !== undefined) {
      tokens.push(words[i]);
    }
  }
  return tokens;
}

function hasUnderstatedTone(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return UNDERSTATED_TONE_WORDS.some((w) => lower.includes(w));
}

function scoreStyleColorPrecision(
  candidate: CompositionItem,
  ctx: OutfitCompositionContext,
  requestedSlotDescription?: string,
): { score: number; reason: string } | null {
  const candidateText = `${candidate.color || ''} ${candidate.name || candidate.ai_title || ''}`;
  const candidateTokens = extractColorTokens(candidateText);
  const candidateFamilies = candidateTokens
    .map((t) => COLOR_FAMILY_MAP[t])
    .filter(Boolean);

  let colorScore = 0;
  let reason = '';
  let hasData = false;

  // ── Color precision: requested description > anchor families ──
  let refFamilies: string[] = [];
  if (requestedSlotDescription) {
    refFamilies = extractColorTokens(requestedSlotDescription)
      .map((t) => COLOR_FAMILY_MAP[t])
      .filter((f): f is string => !!f);
  }
  if (refFamilies.length === 0) {
    refFamilies = (ctx.paletteProfile.dominantFamilies || [])
      .map((c) => COLOR_FAMILY_MAP[c])
      .filter((f): f is string => !!f);
  }

  if (refFamilies.length > 0 && candidateFamilies.length > 0) {
    hasData = true;
    const refSet = new Set(refFamilies);
    const overlap = candidateFamilies.filter((f) => refSet.has(f));

    if (overlap.length > 0) {
      colorScore = 1.0;
      reason = `colorMatch:${overlap[0]}`;
    } else {
      const refNeutral = refFamilies.some((f) => NEUTRAL_FAMILIES.has(f));
      const candNeutral = candidateFamilies.some((f) =>
        NEUTRAL_FAMILIES.has(f),
      );
      const candLoud = candidateFamilies.some((f) => LOUD_FAMILIES.has(f));

      if (refNeutral && candNeutral) {
        colorScore = 0.5;
        reason = 'neutralHarmony';
      } else if (refNeutral && candLoud) {
        colorScore = -0.5;
        reason = 'colorMiss:loudVsNeutral';
      } else {
        colorScore = 0.0;
        reason = 'colorMismatch';
      }
    }
  }

  // ── Understated tone adjustment ──
  const toneText = ctx.requestedDescription || '';
  const hasTone = hasUnderstatedTone(toneText);
  const useNeutralProxy = !toneText && ctx.paletteProfile.neutralBase;

  if ((hasTone || useNeutralProxy) && candidateFamilies.length > 0) {
    hasData = true;
    const toneStrength = hasTone ? 1.0 : 0.5;
    const candNeutral = candidateFamilies.some((f) => NEUTRAL_FAMILIES.has(f));
    const candLoud = candidateFamilies.some((f) => LOUD_FAMILIES.has(f));

    if (candNeutral) {
      colorScore += 0.4 * toneStrength;
      if (!reason) reason = 'understatedBonus';
    }
    if (candLoud) {
      colorScore -= 0.6 * toneStrength;
      reason = reason
        ? `${reason}+understatedPenalty:loud`
        : 'understatedPenalty:loud';
    }

    const candName = (candidate.name || candidate.ai_title || '').toLowerCase();
    if (STATEMENT_KEYWORDS.some((k) => candName.includes(k))) {
      colorScore -= 0.3 * toneStrength;
      reason = reason ? `${reason}+statementPenalty` : 'statementPenalty';
    }

    // Multi-color penalty (e.g., "white and green striped")
    if (new Set(candidateFamilies).size > 1) {
      colorScore -= 0.2 * toneStrength;
      reason = reason ? `${reason}+multiColor` : 'multiColor';
    }
  }

  if (!hasData) return null;

  const finalScore = Math.max(-1, Math.min(1, colorScore));
  if (Math.abs(finalScore) < 0.01) return null;

  return { score: finalScore, reason: reason || 'neutral' };
}

// ── Core derivation functions ──

function deriveColorTemperature(colorStr: string): ColorTemperature {
  const words = extractColorWords(colorStr);
  if (words.length === 0) return 'neutral';

  let warm = 0;
  let cool = 0;
  let neutral = 0;

  for (const w of words) {
    if (WARM_COLORS.has(w)) warm++;
    else if (COOL_COLORS.has(w)) cool++;
    else if (NEUTRAL_COLORS.has(w)) neutral++;
  }

  // If only neutrals or no recognized colors, it's neutral
  if (warm === 0 && cool === 0) return 'neutral';
  // If both warm and cool present, it's mixed
  if (warm > 0 && cool > 0) return 'mixed';
  return warm > 0 ? 'warm' : 'cool';
}

function deriveDominantFamilies(colorStr: string): string[] {
  const words = extractColorWords(colorStr);
  // Return unique recognized color words
  return [
    ...new Set(
      words.filter(
        (w) =>
          WARM_COLORS.has(w) || COOL_COLORS.has(w) || NEUTRAL_COLORS.has(w),
      ),
    ),
  ];
}

function isNeutralBase(colorStr: string): boolean {
  const words = extractColorWords(colorStr);
  if (words.length === 0) return true; // no color info → treat as neutral
  return words.every(
    (w) =>
      NEUTRAL_COLORS.has(w) || (!WARM_COLORS.has(w) && !COOL_COLORS.has(w)),
  );
}

function deriveSilhouetteProfile(item: CompositionItem): SilhouetteProfile {
  const sub = (item.subcategory || '').toLowerCase();
  const name = (item.name || item.ai_title || '').toLowerCase();
  const text = `${sub} ${name}`;

  const hasStructured = textContainsKeyword(text, STRUCTURED_KEYWORDS);
  const hasRelaxed = textContainsKeyword(text, RELAXED_KEYWORDS);

  if (hasStructured && !hasRelaxed) return 'structured';
  if (hasRelaxed && !hasStructured) return 'relaxed';
  if (hasStructured && hasRelaxed) return 'mixed';
  return 'mixed'; // unknown defaults to mixed (most permissive)
}

function deriveMaterialTier(item: CompositionItem): MaterialTier {
  const mat = (item.material || '').toLowerCase();
  const sub = (item.subcategory || '').toLowerCase();
  const name = (item.name || item.ai_title || '').toLowerCase();
  const text = `${mat} ${sub} ${name}`;

  // Check material string first (most direct signal)
  if (mat) {
    for (const kw of ATHLETIC_MATERIALS)
      if (mat.includes(kw)) return 'athletic';
    for (const kw of FORMAL_MATERIALS) if (mat.includes(kw)) return 'formal';
    for (const kw of SMART_MATERIALS) if (mat.includes(kw)) return 'smart';
    for (const kw of CASUAL_MATERIALS) if (mat.includes(kw)) return 'casual';
  }

  // Fall back to subcategory/name keywords
  if (textContainsKeyword(text, ATHLETIC_MATERIALS)) return 'athletic';
  if (
    textContainsKeyword(sub, new Set(['tuxedo', 'gown', 'formal', 'evening']))
  )
    return 'formal';
  if (
    textContainsKeyword(
      sub,
      new Set([
        'blazer',
        'sport coat',
        'dress shirt',
        'trouser',
        'oxford',
        'derby',
      ]),
    )
  )
    return 'smart';
  if (
    textContainsKeyword(
      sub,
      new Set([
        'hoodie',
        'sweatshirt',
        'sneaker',
        'jean',
        'denim',
        't-shirt',
        'tee',
      ]),
    )
  )
    return 'casual';

  return 'casual'; // safe default
}

function deriveFormalityScore(
  item: CompositionItem,
  categoryFormalityMap: Record<string, number>,
  subcategorySignals: Array<[number, string[]]>,
): number {
  const cat = item.category || '';
  const sub = (item.subcategory || '').toLowerCase();
  const mainCat = (item.main_category || '').toLowerCase();

  if (mainCat === 'formalwear' || mainCat === 'suits') return 4;

  let score = categoryFormalityMap[cat] ?? 2;

  for (const [formality, signals] of subcategorySignals) {
    if (signals.some((s) => sub.includes(s))) {
      score = formality;
      break;
    }
  }

  return score;
}

// ── Public API ──

/**
 * Select the anchor item from a list of outfit items.
 * Priority: outerwear > shoes > statement top > statement bottom > dress.
 * Among items at the same priority, prefer the one with the highest combined score.
 */
export function selectAnchorItem(
  items: CompositionItem[],
  itemScores?: Map<string, number>,
): CompositionItem | null {
  if (items.length === 0) return null;

  const scored = items
    .filter((i) => i.id && i.category)
    .map((i) => ({
      item: i,
      priority: ANCHOR_PRIORITY[i.category!] ?? 99,
      score: itemScores?.get(i.id) ?? 0,
    }))
    .sort((a, b) => a.priority - b.priority || b.score - a.score);

  return scored[0]?.item ?? items[0];
}

/**
 * Build a composition context from an anchor item.
 * All derivation is pure and deterministic.
 */
export function buildCompositionContext(
  anchor: CompositionItem,
  categoryFormalityMap: Record<string, number>,
  subcategorySignals: Array<[number, string[]]>,
): OutfitCompositionContext {
  const colorStr = anchor.color || '';

  return {
    anchorItemId: anchor.id,
    anchorCategory: anchor.category || '',
    paletteProfile: {
      temperature: deriveColorTemperature(colorStr),
      dominantFamilies: deriveDominantFamilies(colorStr),
      neutralBase: isNeutralBase(colorStr),
    },
    silhouetteProfile: deriveSilhouetteProfile(anchor),
    materialTier: deriveMaterialTier(anchor),
    formalityTarget: deriveFormalityScore(
      anchor,
      categoryFormalityMap,
      subcategorySignals,
    ),
  };
}

/**
 * Score how compatible a candidate item is with a composition context.
 * Returns a value in [-1.0, +1.0].
 *   +1.0 = perfect match
 *    0.0 = neutral / unknown
 *   -1.0 = strong conflict
 */
export function scoreItemComposition(
  candidate: CompositionItem,
  ctx: OutfitCompositionContext,
  categoryFormalityMap: Record<string, number>,
  subcategorySignals: Array<[number, string[]]>,
  requestedSlotDescription?: string,
  _skipStyleDim = false,
): number {
  let score = 0;
  let signals = 0;

  // ── Palette compatibility ──
  const candidateTemp = deriveColorTemperature(candidate.color || '');
  const candidateNeutral = isNeutralBase(candidate.color || '');

  if (candidateNeutral) {
    // Neutrals are always compatible
    score += 0.5;
  } else if (TEMP_COMPAT[ctx.paletteProfile.temperature].has(candidateTemp)) {
    score += 1.0;
  } else {
    score -= 1.0; // warm + cool clash
  }
  signals++;

  // ── Silhouette compatibility ──
  const candidateSilhouette = deriveSilhouetteProfile(candidate);
  if (SILHOUETTE_COMPAT[ctx.silhouetteProfile].has(candidateSilhouette)) {
    score += 1.0;
  } else {
    score -= 0.8; // structured + relaxed mismatch
  }
  signals++;

  // ── Material tier compatibility (adjacent tiers OK, 2+ tiers apart = conflict) ──
  const candidateTier = deriveMaterialTier(candidate);
  const ctxTierIdx = TIER_ORDER.indexOf(ctx.materialTier);
  const candTierIdx = TIER_ORDER.indexOf(candidateTier);
  const tierDist = Math.abs(ctxTierIdx - candTierIdx);

  if (tierDist === 0) {
    score += 1.0;
  } else if (tierDist === 1) {
    score += 0.3;
  } else {
    score -= 1.0; // athletic + formal, athletic + smart
  }
  signals++;

  // ── Formality tolerance (within 1 step = good, 2 = mild, 3+ = bad) ──
  const candidateFormality = deriveFormalityScore(
    candidate,
    categoryFormalityMap,
    subcategorySignals,
  );
  const formalityDist = Math.abs(candidateFormality - ctx.formalityTarget);

  if (formalityDist === 0) {
    score += 1.0;
  } else if (formalityDist === 1) {
    score += 0.5;
  } else if (formalityDist === 2) {
    score -= 0.3;
  } else {
    score -= 1.0;
  }
  signals++;

  // ── Style-color precision (5th dimension — additive, skippable for base-score calc) ──
  if (!_skipStyleDim) {
    const styleResult = scoreStyleColorPrecision(
      candidate,
      ctx,
      requestedSlotDescription,
    );
    if (styleResult !== null) {
      score += styleResult.score;
      signals++;
    }
  }

  // Normalize to [-1.0, +1.0]
  return signals > 0 ? Math.max(-1, Math.min(1, score / signals)) : 0;
}

/**
 * Score a fully assembled outfit for composition coherence.
 * Returns a value in [-1.0, +1.0] suitable for the aesthetic weight budget (±0.15).
 *
 * This replaces the old colorHarmony + silhouetteBalance + redundancyPenalty block.
 */
export function scoreOutfitComposition(
  items: CompositionItem[],
  fullItemMap: Map<string, any>,
  categoryFormalityMap: Record<string, number>,
  subcategorySignals: Array<[number, string[]]>,
): number {
  if (items.length < 2) return 0;

  // Resolve full item data
  const resolved = items.filter(Boolean).map((i) => {
    const full = fullItemMap.get(i.id);
    return full
      ? {
          ...i,
          color: full.color,
          material: full.material,
          subcategory: full.subcategory,
          name: full.name || full.ai_title,
          main_category: full.main_category,
        }
      : i;
  });

  // Find anchor
  const anchor = selectAnchorItem(resolved);
  if (!anchor) return 0;

  const ctx = buildCompositionContext(
    anchor,
    categoryFormalityMap,
    subcategorySignals,
  );

  // Score non-anchor items against context
  const nonAnchor = resolved.filter((i) => i.id !== anchor.id);
  if (nonAnchor.length === 0) return 0;

  const itemScores = nonAnchor.map((item) =>
    scoreItemComposition(item, ctx, categoryFormalityMap, subcategorySignals),
  );

  const avgScore =
    itemScores.reduce((sum, s) => sum + s, 0) / itemScores.length;

  // ── Redundancy penalty (preserved from original) ──
  const coreItems = resolved.filter((i) => i.category !== 'accessory');
  const catCounts = new Map<string, number>();
  for (const i of coreItems) {
    if (i.category)
      catCounts.set(i.category, (catCounts.get(i.category) || 0) + 1);
  }
  let duplicates = 0;
  for (const count of catCounts.values()) {
    if (count > 1) duplicates += count - 1;
  }
  const redundancyPenalty =
    coreItems.length > 0 ? Math.min(1, duplicates / coreItems.length) : 0;

  // Blend: composition coherence dominates, redundancy is secondary
  return Math.max(-1, Math.min(1, avgScore * 0.85 - redundancyPenalty * 0.15));
}

/**
 * Rank candidate items by composition compatibility with a context.
 * Returns items sorted best-first, each annotated with __compositionScore.
 */
export function rankByComposition<T extends CompositionItem>(
  candidates: T[],
  ctx: OutfitCompositionContext,
  categoryFormalityMap: Record<string, number>,
  subcategorySignals: Array<[number, string[]]>,
  requestedSlotDescription?: string,
): (T & { __compositionScore: number })[] {
  const ranked = candidates
    .map((item) => ({
      ...item,
      __compositionScore: scoreItemComposition(
        item,
        ctx,
        categoryFormalityMap,
        subcategorySignals,
        requestedSlotDescription,
      ),
    }))
    .sort((a, b) => b.__compositionScore - a.__compositionScore);

  // Log style adjustment for the winning candidate only
  if (ranked.length > 0) {
    const winner = ranked[0];
    const baseScore = scoreItemComposition(
      winner,
      ctx,
      categoryFormalityMap,
      subcategorySignals,
      undefined,
      true, // skip style dimension for base score
    );
    const adjustment = winner.__compositionScore - baseScore;
    if (Math.abs(adjustment) > 0.001) {
      const styleResult = scoreStyleColorPrecision(
        winner,
        ctx,
        requestedSlotDescription,
      );
      // console.log(
      //   `STYLE_SCORE_ADJUSTMENT { slot: "${winner.category || ''}", requested: "${(requestedSlotDescription || '').slice(0, 60)}", itemId: "${winner.id}", itemName: "${(winner.name || '').slice(0, 40)}", baseScore: ${baseScore.toFixed(3)}, adjustment: ${adjustment.toFixed(3)}, finalScore: ${winner.__compositionScore.toFixed(3)}, reason: "${styleResult?.reason || 'none'}" }`,
      // );
    }
  }

  return ranked;
}
