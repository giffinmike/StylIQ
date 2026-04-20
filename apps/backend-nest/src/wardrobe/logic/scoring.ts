// scoring.ts — item scoring + reranking (constraints + user style + weather + feedback)

import type { ParsedConstraints } from './constraints';
import { scoreItemForStyle, type UserStyle } from './style';
import { scoreItemForWeather, type WeatherContext } from './weather';
import type { StudioContext } from './studioContext';

type CatalogItemLite = {
  index: number;
  main_category?: string;
  subcategory?: string;
  shoe_style?: string;
  dress_code?: string;
  color?: string;
  color_family?: string;
  formality_score?: number;

  // carry-through fields preserved during mapping
  id?: string;
  label?: string;
  image_url?: string;

  // optional extras used by weather/style scorers
  brand?: string;
  material?: string;
  sleeve_length?: string;
  layering?: string;
  waterproof_rating?: number | string;
  rain_ok?: boolean;
};

const text = (val: any) => (val ?? '').toString().trim();

/** Map constraint dress intent to style.dressBias so style scoring can apply formality penalties */
function mapDressFromConstraints(
  d?: string,
): 'Casual' | 'SmartCasual' | 'BusinessCasual' | 'Business' | undefined {
  if (!d) return undefined;
  const lc = d.toLowerCase();
  if (lc.includes('ultracasual')) return 'Casual';
  if (lc === 'casual') return 'Casual';
  if (lc === 'smartcasual' || lc === 'smart casual') return 'SmartCasual';
  if (lc === 'businesscasual' || lc === 'business casual')
    return 'BusinessCasual';
  if (lc === 'business') return 'Business';
  return undefined;
}

/** Infer a sensible dressBias when dressWanted is missing but other intent signals exist */
function inferBiasFromConstraints(c: ParsedConstraints) {
  const explicit = mapDressFromConstraints((c as any).dressWanted);
  if (explicit) return explicit;

  // Heuristics from other constraint signals
  if ((c as any).wantsBlazer) return 'BusinessCasual';
  if ((c as any).wantsLoafers) return 'SmartCasual';
  if ((c as any).wantsSneakers && !(c as any).wantsBlazer) return 'Casual';

  // ✅ No fallback — stay undefined
  return undefined;
}

/** ─────────────────────────────────────────────────────────────
 * Constraints scorer
 * ──────────────────────────────────────────────────────────── */
export function scoreItemForConstraints(
  item: CatalogItemLite,
  c: ParsedConstraints,
  baseBias: number,
): number {
  let score = baseBias;
  const cat = text(item.main_category).toLowerCase();
  const sub = text(item.subcategory).toLowerCase();
  const shoe = text(item.shoe_style).toLowerCase();
  const dress = text(item.dress_code);
  const color = (text(item.color) || text(item.color_family)).toLowerCase();
  const label = (item.label ?? '').toLowerCase();
  const f = Number(item.formality_score ?? NaN);

  // robust footwear flags
  const isLoafer = /loafer/.test(sub) || /loafer/.test(shoe);
  const isSneaker =
    /(sneaker|trainer)/.test(sub) || /(sneaker|trainer)/.test(shoe);
  const isBoot = /boot/.test(sub) || /boot/.test(shoe);

  // hard negatives
  if ((c as any).excludeLoafers && isLoafer) score -= 50;
  if ((c as any).excludeSneakers && isSneaker) score -= 40;
  if ((c as any).excludeBoots && isBoot) score -= 40;
  if ((c as any).excludeBrown && color.includes('brown')) score -= 12;

  // positives / preferences
  if ((c as any).wantsLoafers) {
    if (isLoafer) score += 50;
    if ((c as any).wantsBrown && color.includes('brown')) score += 10;
    if (cat === 'shoes' && !isLoafer) score -= 15;
  }
  if ((c as any).wantsSneakers && isSneaker) score += 35;
  if ((c as any).wantsBoots && isBoot) score += 35;

  if ((c as any).wantsBlazer) {
    if (sub === 'blazer' || sub === 'sport coat') {
      score += 40;
      if ((c as any).colorWanted === 'Blue' && color.includes('blue'))
        score += 12;
    } else if (cat === 'outerwear') {
      score -= 12;
    }
  }

  if (
    (c as any).colorWanted &&
    color.includes((c as any).colorWanted.toLowerCase())
  )
    score += 10;

  // dress code bias + formality proximity
  if ((c as any).dressWanted) {
    if (dress === (c as any).dressWanted) score += 10;
    if ((c as any).dressWanted === 'BusinessCasual' && isSneaker) score -= 8;
    if ((c as any).dressWanted === 'BusinessCasual' && sub === 'jeans')
      score -= 6;
  }
  if ((c as any).dressWanted === 'BusinessCasual' && Number.isFinite(f)) {
    const dist = Math.abs(f - 7); // prefer 6–8
    score += Math.max(0, 10 - 3 * dist);
  }

  // soft guardrails on upscale intents
  const upscale =
    (c as any).dressWanted &&
    ['BusinessCasual', 'Business'].includes((c as any).dressWanted);
  if (upscale) {
    if (sub === 'hoodie') score -= 20;
    if (sub === 'windbreaker') score -= 15;
    if (sub === 'shorts') score -= 20;
    if ((c as any).dressWanted === 'Business' && isSneaker) score -= 12;
  }

  // Prevent constraint layer from dominating total score.
  // Keep it in same scale as styleScore (~0–1 range).
  const MAX_CONSTRAINT_SCORE = 2;
  score = Math.min(score, MAX_CONSTRAINT_SCORE);

  // Hard dress-tier mismatch penalty. Applied AFTER the cap so it
  // always meaningfully alters ranking order — never scaled/clamped.
  if ((c as any).dressWanted && item.dress_code) {
    const wanted = (c as any).dressWanted as string;
    const actual = item.dress_code;

    const mismatchMatrix: Record<string, string[]> = {
      SmartCasual: ['Casual', 'UltraCasual'],
      BusinessCasual: ['Casual', 'UltraCasual'],
      BusinessFormal: ['SmartCasual', 'Casual', 'UltraCasual'],
    };

    const disallowed = mismatchMatrix[wanted] || [];

    if (disallowed.includes(actual)) {
      score -= 5;
    }
  }

  return score;
}

/** Basic constraints-only reranker (kept for compatibility) */
export function rerankCatalog<T extends CatalogItemLite>(
  catalog: T[],
  c: ParsedConstraints,
): T[] {
  const scored = catalog.map((item, i) => ({
    item,
    score: scoreItemForConstraints(item, c, (catalog.length - i) * 0.01),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s, i) => ({ ...s.item, index: i + 1 }));
}

/** ─────────────────────────────────────────────────────────────
 * Context blend (constraints + style + weather + feedback)
 * ──────────────────────────────────────────────────────────── */

export type ContextWeights =
  | {
      constraintsWeight: number;
      styleWeight: number;
      weatherWeight: number;
      feedbackWeight?: number;
    }
  | { constraints: number; style: number; weather: number; feedback?: number };

export const DEFAULT_CONTEXT_WEIGHTS = {
  constraintsWeight: 2.0, // strong anchor
  styleWeight: 1.0, // direct [0..1] style score
  weatherWeight: 0.8, // gentle nudge
  feedbackWeight: 1.0, // ±0.2 cap
};

function normalizeWeights(w?: ContextWeights) {
  if (!w) return DEFAULT_CONTEXT_WEIGHTS;
  if ('constraints' in w) {
    return {
      constraintsWeight: (w as any).constraints,
      styleWeight: (w as any).style,
      weatherWeight: (w as any).weather,
      feedbackWeight:
        (w as any).feedback ?? DEFAULT_CONTEXT_WEIGHTS.feedbackWeight,
    };
  }
  return {
    constraintsWeight: (w as any).constraintsWeight,
    styleWeight: (w as any).styleWeight,
    weatherWeight: (w as any).weatherWeight,
    feedbackWeight:
      (w as any).feedbackWeight ?? DEFAULT_CONTEXT_WEIGHTS.feedbackWeight,
  };
}

/**
 * Main reranker
 */
export function rerankCatalogWithContext<T extends CatalogItemLite>(
  catalog: T[],
  c: ParsedConstraints,
  opts?: {
    userStyle?: UserStyle;
    weather?: WeatherContext;
    weights?: ContextWeights;
    useWeather?: boolean;
    userPrefs?: Map<string, number>;
    studio?: StudioContext;
  },
): T[] {
  const W = normalizeWeights(opts?.weights);

  const scored = catalog
    .map((item, i) => {
      const baseBias = (catalog.length - i) * 0.01;

      const constraintsScore = scoreItemForConstraints(item, c, baseBias);

      // 🚫 If scoreItemForConstraints killed it, skip from results
      if (constraintsScore <= -9999) return null;

      // 🚩 FIX: Only infer from constraints if constraintsWeight > 0
      const inferredBias =
        W.constraintsWeight > 0 ? inferBiasFromConstraints(c) : undefined;

      // 🚩 Agent style always wins. Only fill in from constraints if *no* agent style provided.
      const effectiveStyle: UserStyle | undefined = opts?.userStyle
        ? {
            ...opts.userStyle,
            dressBias: opts.userStyle.dressBias, // 🔒 lock agent’s bias
          }
        : inferredBias
          ? ({ dressBias: inferredBias } as UserStyle)
          : undefined;

      const styleScoreNorm = scoreItemForStyle(
        item as any,
        effectiveStyle,
        undefined,
        { neutralizeDressBias: opts?.studio?.neutralizeProfileDressBias },
      );

      const weatherScore =
        opts?.useWeather && opts?.weather
          ? scoreItemForWeather(item as any, opts.weather)
          : 0;

      const feedbackRaw = opts?.userPrefs?.get(item.id ?? '') ?? 0;
      const feedbackNorm = Math.max(-1, Math.min(1, feedbackRaw / 5));
      const feedbackScaled = feedbackNorm * 0.2;

      const total =
        W.constraintsWeight * constraintsScore +
        W.styleWeight * styleScoreNorm +
        W.weatherWeight * weatherScore +
        (W.feedbackWeight ?? 1) * feedbackScaled;

      if (process.env.NODE_ENV !== 'production') {
        console.log(
          `[RERANK] ${item.label}`,
          `constraints=${constraintsScore.toFixed(2)}`,
          `style=${styleScoreNorm.toFixed(2)}`,
          `weather=${weatherScore.toFixed(2)}`,
          `feedbackRaw=${feedbackRaw}`,
          `feedbackScaled=${feedbackScaled.toFixed(2)}`,
          `→ total=${total.toFixed(2)}`,
          `useWeather=${opts?.useWeather ? 'ON' : 'OFF'}`,
        );
      }

      return { item, score: total };
    })
    .filter((s): s is { item: T; score: number } => s !== null);

  scored.sort((a, b) => b.score - a.score);
  return scored.map((s, i2) => ({ ...s.item, index: i2 + 1 }));
}
