// FAST-only outfit cohesion scorer — used exclusively inside generateOutfitsFast()

type CohesionItem = {
  formality_score?: number;
  dress_code?: string;
  color?: string;
  color_family?: string;
  material?: string;
  main_category?: string;
  subcategory?: string;
  name?: string;
  label?: string;
};

type CohesionContext = {
  formality: number;
  tempBand: 'hot' | 'warm' | 'mild' | 'cool' | 'cold' | null;
  season: 'summer' | 'spring' | 'fall' | 'winter' | null;
  isOutdoor: boolean;
};

type CohesionResult = {
  score: number;
  pass: boolean;
  reason?: string;
};

export type CohesionConfig = {
  maxFormalityDelta?: number; // default 5
  minScore?: number;          // default 0.45
};

const LIGHT_MATERIAL = /\b(linen|cotton|silk|chiffon|seersucker|chambray|jersey|mesh|rayon|modal)\b/i;
const HEAVY_MATERIAL = /\b(wool|cashmere|fleece|corduroy|tweed|shearling|fur|sherpa|flannel|leather|suede|denim|canvas)\b/i;

const WARM_SEASON = new Set(['summer', 'spring']);
const COLD_SEASON = new Set(['winter', 'fall']);

const NEUTRAL_COLORS = new Set([
  'black', 'white', 'gray', 'grey', 'charcoal', 'navy', 'beige',
  'cream', 'ivory', 'khaki', 'tan', 'taupe', 'brown', 'camel',
]);

const CLASH_PAIRS: [Set<string>, Set<string>][] = [
  [new Set(['red', 'orange']), new Set(['green', 'lime'])],
  [new Set(['orange', 'coral']), new Set(['purple', 'violet', 'magenta'])],
];

function getItemText(item: CohesionItem): string {
  return `${item.subcategory ?? ''} ${item.name ?? ''} ${item.label ?? ''}`.toLowerCase();
}

function classifyWeight(item: CohesionItem): 'light' | 'medium' | 'heavy' {
  const mat = (item.material ?? '').toLowerCase();
  const text = getItemText(item);
  if (HEAVY_MATERIAL.test(mat) || HEAVY_MATERIAL.test(text)) return 'heavy';
  if (LIGHT_MATERIAL.test(mat) || LIGHT_MATERIAL.test(text)) return 'light';
  return 'medium';
}

function extractColorTokens(item: CohesionItem): string[] {
  const tokens: string[] = [];
  for (const raw of [item.color, item.color_family]) {
    if (!raw) continue;
    for (const t of raw.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/)) {
      if (t) tokens.push(t);
    }
  }
  return tokens;
}

function scoreFormalitySpread(items: CohesionItem[], maxDelta = 5): { score: number; reject: boolean; reason?: string } {
  const scores = items
    .map((i) => i.formality_score)
    .filter((s): s is number => typeof s === 'number');
  if (scores.length < 2) return { score: 1, reject: false };

  const delta = Math.max(...scores) - Math.min(...scores);
  if (delta >= maxDelta) return { score: 0, reject: true, reason: `FORMALITY_SPREAD: delta=${delta}` };
  if (delta >= maxDelta - 1) return { score: 0, reject: false };
  if (delta >= 3) return { score: 0.3, reject: false };
  if (delta >= 2) return { score: 0.7, reject: false };
  return { score: 1, reject: false };
}

function scoreDressCodeAlignment(items: CohesionItem[]): number {
  const codes = items
    .map((i) => (i.dress_code ?? '').toLowerCase().trim())
    .filter(Boolean);
  if (codes.length < 2) return 1;

  const unique = new Set(codes);
  if (unique.size === 1) return 1;

  const COMPATIBLE_GROUPS = [
    new Set(['casual', 'smart casual', 'weekend', 'everyday']),
    new Set(['business casual', 'smart casual', 'business']),
    new Set(['business', 'formal', 'business formal']),
    new Set(['active', 'athletic', 'sporty']),
  ];

  for (const group of COMPATIBLE_GROUPS) {
    if ([...unique].every((c) => group.has(c))) return 0.8;
  }

  return Math.max(0, 1 - (unique.size - 1) * 0.35);
}

function scoreColorHarmony(items: CohesionItem[]): number {
  const perItem = items.map(extractColorTokens);
  const allTokens = perItem.flat();
  if (allTokens.length === 0) return 0.7; // no color data → neutral

  const hasNeutral = allTokens.some((t) => NEUTRAL_COLORS.has(t));
  let harmony = hasNeutral ? 0.7 : 0.4;

  const nonNeutral = allTokens.filter((t) => !NEUTRAL_COLORS.has(t));
  const uniqueNonNeutral = new Set(nonNeutral);
  if (uniqueNonNeutral.size <= 2) harmony += 0.3;
  else if (uniqueNonNeutral.size <= 3) harmony += 0.15;

  for (const [setA, setB] of CLASH_PAIRS) {
    const hasA = nonNeutral.some((t) => setA.has(t));
    const hasB = nonNeutral.some((t) => setB.has(t));
    if (hasA && hasB) harmony -= 0.3;
  }

  return Math.max(0, Math.min(1, harmony));
}

function scoreMaterialWeight(items: CohesionItem[], ctx: CohesionContext): number {
  const weights = items.map(classifyWeight);
  const unique = new Set(weights);

  if (unique.size === 1) return 1;

  if (unique.has('heavy') && unique.has('light')) {
    if (ctx.tempBand === 'hot' || ctx.tempBand === 'warm') return 0.1;
    return 0.3;
  }

  return 0.7;
}

function scoreSeasonCoherence(items: CohesionItem[], ctx: CohesionContext): number {
  if (!ctx.season) return 0.7;

  const weights = items.map(classifyWeight);
  const isWarm = WARM_SEASON.has(ctx.season);
  const isCold = COLD_SEASON.has(ctx.season);

  if (isWarm && weights.some((w) => w === 'heavy')) return 0.2;
  if (isCold && weights.every((w) => w === 'light')) return 0.3;

  return 1;
}

export function scoreFastOutfitCohesion(
  items: CohesionItem[],
  context: CohesionContext,
  config?: CohesionConfig,
): CohesionResult {
  if (items.length < 2) return { score: 1, pass: true };

  const maxFormalityDelta = config?.maxFormalityDelta ?? 5;
  const minScore = config?.minScore ?? 0.45;

  const formality = scoreFormalitySpread(items, maxFormalityDelta);
  if (formality.reject) return { score: 0, pass: false, reason: formality.reason };

  const dressCode = scoreDressCodeAlignment(items);
  const color = scoreColorHarmony(items);
  const material = scoreMaterialWeight(items, context);
  const season = scoreSeasonCoherence(items, context);

  const score =
    formality.score * 0.30 +
    dressCode * 0.20 +
    color * 0.20 +
    material * 0.15 +
    season * 0.15;

  const pass = score >= minScore;

  return {
    score,
    pass,
    reason: pass ? undefined : `COHESION_LOW: score=${score.toFixed(2)} (formality=${formality.score.toFixed(2)} dress=${dressCode.toFixed(2)} color=${color.toFixed(2)} material=${material.toFixed(2)} season=${season.toFixed(2)})`,
  };
}
