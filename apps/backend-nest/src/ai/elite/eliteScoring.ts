/**
 * Elite Scoring — Phase 2 (Rerank)
 *
 * Shared post-processor for outfit quality scoring.
 * Phase 2: scores and reranks outfits based on style context signals.
 *
 * // SYNC: keep types in sync with apps/frontend/src/lib/elite/eliteScoring.ts
 */

import { randomUUID } from 'crypto';
import type { CreateLearningEventInput } from '../../learning/dto/learning-event.dto';

// ── Canonical Slot Taxonomy ──────────────────────────────────────────────────

export type CanonicalSlot =
  | 'tops'
  | 'bottoms'
  | 'shoes'
  | 'outerwear'
  | 'dresses'
  | 'accessories'
  | 'activewear'
  | 'swimwear';

export type CanonicalItem = {
  id: string;
  slot: CanonicalSlot;
  [key: string]: unknown;
};

export type CanonicalOutfit = {
  id: string;
  items: CanonicalItem[];
  [key: string]: unknown;
};

export type StyleContext = {
  presentation?: 'masculine' | 'feminine' | 'mixed';
  fashionState?: {
    topBrands: string[];
    avoidBrands: string[];
    topColors: string[];
    avoidColors: string[];
    topStyles?: string[];
    avoidStyles?: string[];
    topCategories: string[];
    priceBracket: string | null;
    isColdStart: boolean;
  } | null;
  wardrobeStats?: {
    dominantColors: string[];
    topCategories: string[];
    topBrands: string[];
    totalItems: number;
  };
  preferredBrands?: string[];
  /** Style profile fields for fit/fabric/style scoring signals */
  styleProfile?: {
    fit_preferences: string[];
    fabric_preferences: string[];
    favorite_colors?: string[];
    style_preferences?: string[];
    disliked_styles?: string[];
    // P0/P1 profile-driven scoring
    avoid_colors?: string[];
    avoid_materials?: string[];
    pattern_preferences?: string[];
    avoid_patterns?: string[];
    silhouette_preference?: string | null;
    contrast_preference?: string | null;
  } | null;
};

export type EliteEnv = {
  mode: 'stylist' | 'trips' | 'studio';
  weather?: unknown;
  activities?: unknown;
  requestId?: string;
  rerank?: boolean;
  debug?: boolean;
};

export type QueryContext = {
  rawQuery: string;
  derivedOccasion: string | null;
  derivedFormality: number | null; // 1–10 scale (from outfitPlanPrompt.deriveFormality)
  keywordTags: string[]; // lowercased tokens extracted from rawQuery
};

export type EliteResult<T> = {
  outfits: T[];
  debug: Record<string, unknown>;
};

export type OutfitScore = {
  score: number;
  confidence: number;
  flags: string[];
};

// Minimal stopword list for keyword-tag extraction (local, no external NLP lib).
const KEYWORD_STOPWORDS = new Set<string>([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'for',
  'from',
  'has',
  'have',
  'i',
  'in',
  'is',
  'it',
  'its',
  'me',
  'my',
  'not',
  'of',
  'on',
  'or',
  's',
  'so',
  'some',
  'such',
  'that',
  'the',
  'their',
  'there',
  'these',
  'they',
  'this',
  'to',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'will',
  'with',
  'you',
  'your',
  'im',
  'ill',
  'ive',
  'id',
  'do',
  'does',
  'done',
  'just',
  'like',
  'want',
  'wanna',
  'really',
  'look',
  'looking',
  'something',
  'thing',
  'today',
  'now',
  'go',
  'going',
  'get',
  'make',
  'wear',
  'outfit',
  'outfits',
  'ok',
  'okay',
  'please',
  'thanks',
  'thank',
  'help',
]);

// Bold / contrast intent cue set. Local to this file.
const BOLDNESS_KEYWORDS = new Set<string>([
  'bold',
  'contrast',
  'statement',
  'edgy',
  'pop',
  'vibrant',
  'striking',
  'daring',
  'standout',
  'fierce',
  'loud',
]);

// Occasion/context cues where deliberate formality range is welcome.
const HIGH_LOW_OCCASIONS = new Set<string>([
  'smart-casual',
  'dressy-casual',
  'date',
  'night-out',
  'nightlife',
  'creative',
  'going-out',
]);
const HIGH_LOW_KEYWORDS = new Set<string>([
  'dressy',
  'elevated',
  'mix',
  'high-low',
  'edgy',
]);

export function extractKeywordTags(query: string): string[] {
  if (!query) return [];
  const tokens = query
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const out: string[] = [];
  for (const t of tokens) {
    if (t.length < 2) continue;
    if (KEYWORD_STOPWORDS.has(t)) continue;
    out.push(t);
  }
  return out;
}

// ── Scoring Helpers (Phase 2) ───────────────────────────────────────────────

export function colorMatches(itemColor: string, prefColor: string): boolean {
  const a = itemColor.toLowerCase();
  const b = prefColor.toLowerCase();
  return a === b || a.includes(b) || b.includes(a);
}

export function deterministicHash(s: string): number {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  }
  return hash;
}

export function scoreOutfit(
  outfit: CanonicalOutfit,
  ctx: StyleContext,
  env: EliteEnv,
  queryContext?: QueryContext,
): OutfitScore {
  let score = 0;
  let learningScore = 0; // Tracks learning-derived contributions for clamping
  const flags: string[] = [];
  let signalsAvailable = 0;
  let signalsUsed = 0;

  const fs = ctx.fashionState;
  const ws = ctx.wardrobeStats;

  // ── Brand affinity (skip gracefully when items lack brand) ──
  if (fs) {
    const topBrands = [...(fs.topBrands ?? []), ...(ctx.preferredBrands ?? [])];
    const avoidBrands = fs.avoidBrands ?? [];
    if (topBrands.length > 0 || avoidBrands.length > 0) {
      signalsAvailable++;
      let brandFired = false;
      for (const item of outfit.items) {
        const brand = (item as any).brand as string | undefined;
        if (!brand) continue;
        const brandLower = brand.toLowerCase();
        if (topBrands.some((b) => b.toLowerCase() === brandLower)) {
          score += 10;
          learningScore += 10;
          brandFired = true;
        }
        if (avoidBrands.some((b) => b.toLowerCase() === brandLower)) {
          score -= 10;
          learningScore -= 10;
          brandFired = true;
        }
      }
      if (brandFired) {
        signalsUsed++;
        flags.push('brand');
      }
    }
  }

  // ── Color affinity (merge fashionState + wardrobeStats sources) ──
  {
    const topColors = [...(fs?.topColors ?? []), ...(ws?.dominantColors ?? [])];
    const avoidColors = fs?.avoidColors ?? [];

    if (topColors.length > 0 || avoidColors.length > 0) {
      signalsAvailable++;
      let colorFired = false;
      for (const item of outfit.items) {
        const itemColor = (item as any).color as string | undefined;
        if (!itemColor) continue;
        if (topColors.some((c) => colorMatches(itemColor, c))) {
          score += 5;
          learningScore += 5;
          colorFired = true;
        }
        if (avoidColors.some((c) => colorMatches(itemColor, c))) {
          score -= 8;
          learningScore -= 8;
          colorFired = true;
        }
      }
      if (colorFired) {
        signalsUsed++;
        flags.push('color');
      }
    }
  }

  // ── Favorite color boost (profile-driven, additive) ──
  {
    const favColors = ctx.styleProfile?.favorite_colors ?? [];
    if (favColors.length > 0) {
      signalsAvailable++;
      let favFired = false;
      for (const item of outfit.items) {
        const itemColor = (item as any).color as string | undefined;
        if (!itemColor) continue;
        if (favColors.some((c) => colorMatches(itemColor, c))) {
          score += 5;
          favFired = true;
        }
      }
      if (favFired) {
        signalsUsed++;
        flags.push('favorite_color');
      }
    }
  }

  // ── Category affinity ──
  {
    const topCategories = fs?.topCategories ?? ws?.topCategories ?? [];
    if (topCategories.length > 0) {
      signalsAvailable++;
      let catFired = false;
      const topCatLower = topCategories.map((c) => c.toLowerCase());
      for (const item of outfit.items) {
        if (topCatLower.includes(item.slot.toLowerCase())) {
          score += 3;
          catFired = true;
        }
      }
      if (catFired) {
        signalsUsed++;
        flags.push('category');
      }
    }
  }

  // ── Style affinity (items may have style_descriptors[] and/or style_archetypes[]) ──
  {
    const topStyles = fs?.topStyles ?? [];
    const avoidStyles = fs?.avoidStyles ?? [];
    if (topStyles.length > 0 || avoidStyles.length > 0) {
      signalsAvailable++;
      let styleFired = false;
      const topLower = topStyles.map((s) => s.toLowerCase());
      const avoidLower = avoidStyles.map((s) => s.toLowerCase());
      for (const item of outfit.items) {
        const descriptors = (item as any).style_descriptors as
          | string[]
          | undefined;
        const archetypes = (item as any).style_archetypes as
          | string[]
          | undefined;
        const tokens: string[] = [
          ...(Array.isArray(descriptors) ? descriptors : []),
          ...(Array.isArray(archetypes) ? archetypes : []),
        ];
        if (tokens.length === 0) continue;
        for (const token of tokens) {
          const tLower = token.toLowerCase();
          if (topLower.includes(tLower)) {
            score += 5;
            learningScore += 5;
            styleFired = true;
          }
          if (avoidLower.includes(tLower)) {
            score -= 8;
            learningScore -= 8;
            styleFired = true;
          }
        }
      }
      if (styleFired) {
        signalsUsed++;
        flags.push('style');
      }
    }
  }

  // ── Presentation safety (penalize cross-presentation items) ──
  if (ctx.presentation === 'masculine' || ctx.presentation === 'feminine') {
    let presentationFired = false;
    for (const item of outfit.items) {
      const itemPres = (item as any).presentation_code as string | undefined;
      if (!itemPres) continue;
      if (
        (ctx.presentation === 'masculine' && itemPres === 'feminine') ||
        (ctx.presentation === 'feminine' && itemPres === 'masculine')
      ) {
        score -= 8;
        presentationFired = true;
      }
    }
    if (presentationFired) {
      signalsAvailable++;
      signalsUsed++;
      flags.push('presentation');
    }
  }

  // ── Formality high-low contrast (Studio only, query-gated).
  // Replaces the former formality-compression bonus which rewarded monotone
  // formality clusters. New rule: only reward deliberate range (≥3 levels)
  // when the query context invites it (e.g. smart-casual, dressy-casual,
  // date, night-out). Without queryContext this signal stays silent. ──
  if (env.mode === 'studio' && queryContext) {
    const fScores: number[] = [];
    for (const item of outfit.items) {
      const f = (item as any).formality_score;
      if (typeof f === 'number' && isFinite(f)) fScores.push(f);
    }
    if (fScores.length >= 2) {
      const range = Math.max(...fScores) - Math.min(...fScores);
      const occasionAllows =
        queryContext.derivedOccasion !== null &&
        HIGH_LOW_OCCASIONS.has(queryContext.derivedOccasion);
      const keywordsAllow = queryContext.keywordTags.some((t) =>
        HIGH_LOW_KEYWORDS.has(t),
      );
      if (range >= 3 && (occasionAllows || keywordsAllow)) {
        signalsAvailable++;
        score += 6;
        signalsUsed++;
        flags.push('formality_contrast');
      }
    }
  }

  // ── Fit preference (profile-driven) ──
  {
    const fitPrefs = ctx.styleProfile?.fit_preferences ?? [];
    if (fitPrefs.length > 0) {
      signalsAvailable++;
      let fitFired = false;
      const fitPrefsLower = fitPrefs.map((f) => f.toLowerCase());
      for (const item of outfit.items) {
        const itemFit = ((item as any).fit ?? (item as any).fit_type) as
          | string
          | undefined;
        if (!itemFit) continue;
        const itemFitLower = itemFit.toLowerCase();
        if (
          fitPrefsLower.some(
            (f) => itemFitLower.includes(f) || f.includes(itemFitLower),
          )
        ) {
          score += 4;
          fitFired = true;
        }
      }
      if (fitFired) {
        signalsUsed++;
        flags.push('fit');
      }
    }
  }

  // ── Fabric/material preference (profile-driven) ──
  {
    const fabricPrefs = ctx.styleProfile?.fabric_preferences ?? [];
    if (fabricPrefs.length > 0) {
      signalsAvailable++;
      let fabricFired = false;
      const fabricPrefsLower = fabricPrefs.map((f) => f.toLowerCase());
      for (const item of outfit.items) {
        const itemMaterial = ((item as any).material ??
          (item as any).fabric_blend) as string | undefined;
        if (!itemMaterial) continue;
        const itemMatLower = itemMaterial.toLowerCase();
        if (
          fabricPrefsLower.some(
            (f) => itemMatLower.includes(f) || f.includes(itemMatLower),
          )
        ) {
          score += 3;
          fabricFired = true;
        }
      }
      if (fabricFired) {
        signalsUsed++;
        flags.push('fabric');
      }
    }
  }

  // ── Style preferences (profile-driven, conservative) ──
  {
    const stylePrefs = ctx.styleProfile?.style_preferences ?? [];
    if (stylePrefs.length > 0) {
      signalsAvailable++;
      let prefFired = false;
      const prefsLower = stylePrefs.map((s) => s.toLowerCase());
      for (const item of outfit.items) {
        const descriptors = (item as any).style_descriptors as
          | string[]
          | undefined;
        const archetypes = (item as any).style_archetypes as
          | string[]
          | undefined;
        const tokens: string[] = [
          ...(Array.isArray(descriptors) ? descriptors : []),
          ...(Array.isArray(archetypes) ? archetypes : []),
        ];
        for (const token of tokens) {
          if (prefsLower.includes(token.toLowerCase())) {
            score += 3;
            prefFired = true;
          }
        }
      }
      if (prefFired) {
        signalsUsed++;
        flags.push('style_preference');
      }
    }
  }

  // ── Disliked styles (profile-driven penalty, conservative) ──
  {
    const disliked = ctx.styleProfile?.disliked_styles ?? [];
    if (disliked.length > 0) {
      signalsAvailable++;
      let dislikedFired = false;
      const dislikedLower = disliked.map((s) => s.toLowerCase());
      for (const item of outfit.items) {
        const descriptors = (item as any).style_descriptors as
          | string[]
          | undefined;
        const archetypes = (item as any).style_archetypes as
          | string[]
          | undefined;
        const tokens: string[] = [
          ...(Array.isArray(descriptors) ? descriptors : []),
          ...(Array.isArray(archetypes) ? archetypes : []),
        ];
        for (const token of tokens) {
          if (dislikedLower.includes(token.toLowerCase())) {
            score -= 6;
            dislikedFired = true;
          }
        }
      }
      if (dislikedFired) {
        signalsUsed++;
        flags.push('disliked_style');
      }
    }
  }

  // ── Profile avoid_colors (P0 veto — stronger than fashionState avoidColors) ──
  {
    const profAvoidColors = ctx.styleProfile?.avoid_colors ?? [];
    if (profAvoidColors.length > 0) {
      signalsAvailable++;
      let profColorFired = false;
      for (const item of outfit.items) {
        const itemColor = (item as any).color as string | undefined;
        if (!itemColor) continue;
        if (profAvoidColors.some((c) => colorMatches(itemColor, c))) {
          score -= 6;
          profColorFired = true;
        }
      }
      if (profColorFired) {
        signalsUsed++;
        flags.push('profile_avoid_colors');
      }
    }
  }

  // ── Profile avoid_materials (P0 veto) ──
  {
    const profAvoidMats = ctx.styleProfile?.avoid_materials ?? [];
    if (profAvoidMats.length > 0) {
      signalsAvailable++;
      let profMatFired = false;
      for (const item of outfit.items) {
        const itemMat = ((item as any).material ??
          (item as any).fabric_blend) as string | undefined;
        if (!itemMat) continue;
        const matLower = itemMat.toLowerCase();
        if (profAvoidMats.some((m) => matLower.includes(m.toLowerCase()))) {
          score -= 6;
          profMatFired = true;
        }
      }
      if (profMatFired) {
        signalsUsed++;
        flags.push('profile_avoid_materials');
      }
    }
  }

  // ── Pattern preferences (P1: +2 match / -5 avoid) ──
  {
    const patternPrefs = ctx.styleProfile?.pattern_preferences ?? [];
    const avoidPatterns = ctx.styleProfile?.avoid_patterns ?? [];
    if (patternPrefs.length > 0 || avoidPatterns.length > 0) {
      signalsAvailable++;
      let patternFired = false;
      const prefsLower = patternPrefs.map((p) => p.toLowerCase());
      const avoidLower = avoidPatterns.map((p) => p.toLowerCase());
      for (const item of outfit.items) {
        const descriptors = (item as any).style_descriptors as
          | string[]
          | undefined;
        if (!Array.isArray(descriptors) || descriptors.length === 0) continue;
        for (const d of descriptors) {
          const dLower = d.toLowerCase();
          if (prefsLower.includes(dLower)) {
            score += 2;
            patternFired = true;
          }
          if (avoidLower.includes(dLower)) {
            score -= 5;
            patternFired = true;
          }
        }
      }
      if (patternFired) {
        signalsUsed++;
        flags.push('pattern');
      }
    }
  }

  // ── Silhouette preference (P1: +2 match / -3 mismatch) ──
  {
    const silPref = ctx.styleProfile?.silhouette_preference;
    if (silPref && silPref !== 'Mix of both') {
      signalsAvailable++;
      let silFired = false;
      const structuredTokens = ['tailored', 'slim', 'structured'];
      const relaxedTokens = ['relaxed', 'oversized', 'loose'];
      for (const item of outfit.items) {
        const itemFit = ((item as any).fit ?? (item as any).fit_type) as
          | string
          | undefined;
        if (!itemFit) continue;
        const fitLower = itemFit.toLowerCase();
        if (silPref === 'Structured') {
          if (structuredTokens.some((t) => fitLower.includes(t))) {
            score += 6;
            silFired = true;
          }
          if (relaxedTokens.some((t) => fitLower.includes(t))) {
            score -= 6;
            silFired = true;
          }
        } else if (silPref === 'Relaxed') {
          if (relaxedTokens.some((t) => fitLower.includes(t))) {
            score += 6;
            silFired = true;
          }
          if (structuredTokens.some((t) => fitLower.includes(t))) {
            score -= 6;
            silFired = true;
          }
        }
      }
      if (silFired) {
        signalsUsed++;
        flags.push('silhouette');
      }
    }
  }

  // ── Contrast preference (P1: +3 when outfit contrast matches) ──
  {
    const contrastPref = ctx.styleProfile?.contrast_preference;
    if (contrastPref && contrastPref !== 'No preference') {
      signalsAvailable++;
      const lightTokens = [
        'white',
        'cream',
        'beige',
        'ivory',
        'pastel',
        'light',
      ];
      const darkTokens = ['black', 'navy', 'charcoal', 'dark'];
      let hasLight = false;
      let hasDark = false;
      for (const item of outfit.items) {
        const c = ((item as any).color as string | undefined)?.toLowerCase();
        if (!c) continue;
        if (lightTokens.some((t) => c.includes(t))) hasLight = true;
        if (darkTokens.some((t) => c.includes(t))) hasDark = true;
      }
      const isHighContrast = hasLight && hasDark;
      const isLowContrast = !hasLight || !hasDark; // monochrome-ish
      let matched = false;
      if (contrastPref === 'High contrast' && isHighContrast) matched = true;
      if (contrastPref === 'Low contrast' && isLowContrast && !isHighContrast)
        matched = true;
      if (contrastPref === 'Medium contrast') matched = true; // medium always matches
      if (matched) {
        score += 7;
        signalsUsed++;
        flags.push('contrast');
      }
    }
  }

  // ── Dress-code coherence (extends formality — Studio only) ──
  if (env.mode === 'studio') {
    const dressCodes: string[] = [];
    for (const item of outfit.items) {
      const dc = (item as any).dress_code as string | undefined;
      if (dc) dressCodes.push(dc.toLowerCase());
    }
    if (dressCodes.length >= 2) {
      signalsAvailable++;
      const unique = new Set(dressCodes);
      if (unique.size === 1) {
        score += 3;
        signalsUsed++;
        flags.push('dress_code');
      } else if (unique.size >= 2) {
        // Penalize conflicting dress codes (e.g., "athletic" + "business")
        const CONFLICTING_PAIRS = [
          ['athletic', 'business'],
          ['athletic', 'formal'],
          ['casual', 'formal'],
          ['beach', 'business'],
        ];
        const codes = [...unique];
        const hasConflict = CONFLICTING_PAIRS.some(
          ([a, b]) => codes.includes(a) && codes.includes(b),
        );
        if (hasConflict) {
          score -= 5;
          signalsUsed++;
          flags.push('dress_code');
        }
      }
    }
  }

  // ── Query-awareness signals (only when queryContext is provided) ──
  if (queryContext) {
    const keywordSet = new Set(queryContext.keywordTags);

    // Occasion alignment: item dress_code or activities tokens match derivedOccasion.
    if (queryContext.derivedOccasion) {
      const occ = queryContext.derivedOccasion.toLowerCase();
      signalsAvailable++;
      let occasionFired = false;
      for (const item of outfit.items) {
        const dc = (
          (item as any).dress_code as string | undefined
        )?.toLowerCase();
        const activities = (item as any).activities as string[] | undefined;
        if (dc && (dc === occ || dc.includes(occ) || occ.includes(dc))) {
          occasionFired = true;
          break;
        }
        if (Array.isArray(activities)) {
          for (const a of activities) {
            const aLower = a.toLowerCase();
            if (
              aLower === occ ||
              aLower.includes(occ) ||
              occ.includes(aLower)
            ) {
              occasionFired = true;
              break;
            }
          }
        }
        if (occasionFired) break;
      }
      if (occasionFired) {
        score += 6;
        signalsUsed++;
        flags.push('query_occasion');
      }
    }

    // Intent keyword alignment: item style_descriptors/archetypes/subcategory
    // overlap with keywordTags.
    if (keywordSet.size > 0) {
      signalsAvailable++;
      let intentFired = false;
      for (const item of outfit.items) {
        const descriptors = (item as any).style_descriptors as
          | string[]
          | undefined;
        const archetypes = (item as any).style_archetypes as
          | string[]
          | undefined;
        const sub = (
          (item as any).subcategory as string | undefined
        )?.toLowerCase();
        const tokens: string[] = [
          ...(Array.isArray(descriptors) ? descriptors : []),
          ...(Array.isArray(archetypes) ? archetypes : []),
        ];
        for (const t of tokens) {
          if (keywordSet.has(t.toLowerCase())) {
            intentFired = true;
            break;
          }
        }
        if (!intentFired && sub && keywordSet.has(sub)) intentFired = true;
        if (intentFired) break;
      }
      if (intentFired) {
        score += 5;
        signalsUsed++;
        flags.push('query_intent');
      }
    }

    // Boldness / contrast cue: reward palette variance, penalize monotone.
    const wantsBoldness = queryContext.keywordTags.some((t) =>
      BOLDNESS_KEYWORDS.has(t),
    );
    if (wantsBoldness) {
      signalsAvailable++;
      const colorBuckets = new Map<string, number>();
      for (const item of outfit.items) {
        const c = ((item as any).color as string | undefined)
          ?.toLowerCase()
          .trim();
        if (!c) continue;
        colorBuckets.set(c, (colorBuckets.get(c) ?? 0) + 1);
      }
      const totalColored = [...colorBuckets.values()].reduce(
        (a, b) => a + b,
        0,
      );
      const dominantCount = Math.max(0, ...colorBuckets.values());
      const hasVariance =
        colorBuckets.size >= 2 && dominantCount < totalColored;
      const isMonotone = totalColored >= 3 && dominantCount >= 3;
      if (hasVariance && !isMonotone) {
        score += 4;
        signalsUsed++;
        flags.push('query_contrast');
      } else if (isMonotone) {
        score -= 4;
        signalsUsed++;
        flags.push('query_monotone');
      }
    }
  }

  // ── Slot completeness (all modes) ──
  {
    signalsAvailable++;
    const slots = new Set(outfit.items.map((i) => i.slot));
    const hasComplete =
      (slots.has('tops') && slots.has('bottoms') && slots.has('shoes')) ||
      (slots.has('dresses') && slots.has('shoes'));
    if (hasComplete) {
      score += 5;
      signalsUsed++;
      flags.push('slot_complete');
    }
  }

  // Clamp learning-derived contribution to prevent runaway influence
  const clampedLearning = Math.max(-20, Math.min(20, learningScore));
  score = score - learningScore + clampedLearning;

  const confidence = signalsAvailable > 0 ? signalsUsed / signalsAvailable : 0;

  return { score, confidence, flags };
}

export function stableSortOutfits<T extends CanonicalOutfit>(
  outfits: T[],
  scores: Map<string, OutfitScore>,
): T[] {
  const indexed = outfits.map((o, i) => ({ o, i }));
  indexed.sort((a, b) => {
    const sa = scores.get(a.o.id)?.score ?? 0;
    const sb = scores.get(b.o.id)?.score ?? 0;
    if (sa !== sb) return sb - sa;
    return a.i - b.i; // preserve original order for ties
  });
  return indexed.map(({ o }) => o);
}

// ── Post-Processor (Phase 2: Rerank) ────────────────────────────────────────

export function elitePostProcessOutfits<T>(
  outfits: T[],
  ctx: StyleContext,
  env: EliteEnv,
): EliteResult<T> {
  // Pass-through when rerank not enabled or <=1 outfit
  if (!env.rerank || outfits.length <= 1) {
    return { outfits, debug: {} };
  }

  const canonical = outfits as unknown as CanonicalOutfit[];

  // Score each outfit
  const scores = new Map<string, OutfitScore>();
  for (const outfit of canonical) {
    scores.set(outfit.id, scoreOutfit(outfit, ctx, env));
  }

  // Stable sort by score descending (originalIndex tie-break)
  const reranked = stableSortOutfits(canonical, scores) as unknown as T[];

  // Safety fallback: if count changed unexpectedly, return the input unchanged.
  if (reranked.length !== outfits.length) {
    const debug: Record<string, unknown> = { skipped: 'count_mismatch' };
    return { outfits, debug };
  }

  // Debug output (only when debug flag enabled)
  const debug: Record<string, unknown> = {};
  if (env.debug) {
    debug.scores = canonical.map((o) => ({
      outfitId: o.id,
      ...scores.get(o.id),
    }));
    debug.originalOrder = canonical.map((o) => o.id);
    debug.rerankedOrder = (reranked as unknown as CanonicalOutfit[]).map(
      (o) => o.id,
    );
  }

  return { outfits: reranked, debug };
}

// ── Slate Selection (MMR-style) ─────────────────────────────────────────────
//
// selectEliteSlate is the curator. Given a pool of candidate outfits it scores
// each one (optionally using a query context) and greedily picks a slate of
// three that maximises `score(c) − λ * maxSimilarity(c, selected)`. The
// similarity metric blends item-id Jaccard, palette overlap, and formality
// proximity. Output is then checked against diversity guarantees; on failure
// the loop is re-run once with a stronger λ. No regeneration, no LLM calls.

const MMR_LAMBDA = 0.35;
const MMR_LAMBDA_RETRY = 0.55;
const SLATE_SIZE = 3;

type SilhouetteRegister = 'structured' | 'relaxed' | 'mixed' | 'unknown';
type FormalityRegister = 'low' | 'mid' | 'high' | 'unknown';

function itemIds(outfit: CanonicalOutfit): string[] {
  const ids: string[] = [];
  for (const item of outfit.items) {
    if (item && typeof item.id === 'string') ids.push(item.id);
  }
  return ids;
}

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const x of setA) if (setB.has(x)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function dominantColorSet(outfit: CanonicalOutfit): Set<string> {
  const colors = new Set<string>();
  for (const item of outfit.items) {
    const c = ((item as any).color as string | undefined)?.toLowerCase().trim();
    if (c) colors.add(c);
  }
  return colors;
}

function paletteOverlap(a: CanonicalOutfit, b: CanonicalOutfit): number {
  const ca = dominantColorSet(a);
  const cb = dominantColorSet(b);
  if (ca.size === 0 || cb.size === 0) return 0;
  let shared = 0;
  for (const c of ca) if (cb.has(c)) shared++;
  return shared / Math.max(ca.size, cb.size);
}

function avgFormality(outfit: CanonicalOutfit): number | null {
  const vals: number[] = [];
  for (const item of outfit.items) {
    const f = (item as any).formality_score ?? (item as any).formality;
    if (typeof f === 'number' && isFinite(f)) vals.push(f);
  }
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function formalityProximity(a: CanonicalOutfit, b: CanonicalOutfit): number {
  const fa = avgFormality(a);
  const fb = avgFormality(b);
  if (fa === null || fb === null) return 0;
  return 1 - Math.min(1, Math.abs(fa - fb) / 5);
}

function similarity(a: CanonicalOutfit, b: CanonicalOutfit): number {
  const j = jaccard(itemIds(a), itemIds(b));
  const p = paletteOverlap(a, b);
  const fp = formalityProximity(a, b);
  return Math.max(0, Math.min(1, 0.5 * j + 0.3 * p + 0.2 * fp));
}

function silhouetteRegister(outfit: CanonicalOutfit): SilhouetteRegister {
  const structuredTokens = ['tailored', 'slim', 'structured', 'fitted'];
  const relaxedTokens = ['relaxed', 'oversized', 'loose', 'baggy'];
  let structured = 0;
  let relaxed = 0;
  let seen = 0;
  for (const item of outfit.items) {
    const fit = ((item as any).fit ?? (item as any).fit_type) as
      | string
      | undefined;
    if (!fit) continue;
    const fl = fit.toLowerCase();
    seen++;
    if (structuredTokens.some((t) => fl.includes(t))) structured++;
    if (relaxedTokens.some((t) => fl.includes(t))) relaxed++;
  }
  if (seen === 0) return 'unknown';
  if (structured > 0 && relaxed > 0) return 'mixed';
  if (structured > 0) return 'structured';
  if (relaxed > 0) return 'relaxed';
  return 'unknown';
}

function formalityRegister(outfit: CanonicalOutfit): FormalityRegister {
  const f = avgFormality(outfit);
  if (f === null) return 'unknown';
  if (f <= 4) return 'low';
  if (f <= 6) return 'mid';
  return 'high';
}

function paletteBucket(outfit: CanonicalOutfit): string {
  const colors = [...dominantColorSet(outfit)].sort();
  return colors.join('|');
}

function axesDiffer(a: CanonicalOutfit, b: CanonicalOutfit): number {
  let differs = 0;
  if (paletteBucket(a) !== paletteBucket(b)) differs++;
  if (silhouetteRegister(a) !== silhouetteRegister(b)) differs++;
  if (formalityRegister(a) !== formalityRegister(b)) differs++;
  return differs;
}

function hasDuplicateTop(selected: CanonicalOutfit[]): boolean {
  const topIds = new Set<string>();
  for (const o of selected) {
    for (const item of o.items) {
      if (item.slot !== 'tops' && item.slot !== 'dresses') continue;
      if (typeof item.id !== 'string') continue;
      if (topIds.has(item.id)) return true;
      topIds.add(item.id);
    }
  }
  return false;
}

function hasOverlapOver50(selected: CanonicalOutfit[]): boolean {
  for (let i = 0; i < selected.length; i++) {
    for (let j = i + 1; j < selected.length; j++) {
      if (jaccard(itemIds(selected[i]), itemIds(selected[j])) > 0.5)
        return true;
    }
  }
  return false;
}

function axesViolation(selected: CanonicalOutfit[]): boolean {
  for (let i = 0; i < selected.length; i++) {
    for (let j = i + 1; j < selected.length; j++) {
      if (axesDiffer(selected[i], selected[j]) < 2) return true;
    }
  }
  return false;
}

function runMmr(
  pool: CanonicalOutfit[],
  scores: Map<string, OutfitScore>,
  lambda: number,
  limit: number,
): CanonicalOutfit[] {
  const selected: CanonicalOutfit[] = [];
  const remaining = [...pool];

  // Seed: highest score, deterministic tiebreak by id.
  remaining.sort((a, b) => {
    const sa = scores.get(a.id)?.score ?? 0;
    const sb = scores.get(b.id)?.score ?? 0;
    if (sa !== sb) return sb - sa;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  if (remaining.length === 0) return selected;
  selected.push(remaining.shift()!);

  while (selected.length < limit && remaining.length > 0) {
    let best: CanonicalOutfit | null = null;
    let bestAdj = -Infinity;
    let bestId = '';
    for (const c of remaining) {
      const base = scores.get(c.id)?.score ?? 0;
      let maxSim = 0;
      for (const s of selected) {
        const sim = similarity(c, s);
        if (sim > maxSim) maxSim = sim;
      }
      const adj = base - lambda * maxSim * 20; // scale sim into score units
      if (
        adj > bestAdj ||
        (adj === bestAdj && (best === null || c.id < bestId))
      ) {
        best = c;
        bestAdj = adj;
        bestId = c.id;
      }
    }
    if (!best) break;
    selected.push(best);
    const idx = remaining.indexOf(best);
    if (idx >= 0) remaining.splice(idx, 1);
  }
  return selected;
}

export function selectEliteSlate<T>(
  outfits: T[],
  ctx: StyleContext,
  env: EliteEnv,
  queryContext?: QueryContext,
): EliteResult<T> {
  if (outfits.length <= 1) return { outfits, debug: {} };

  const canonical = outfits as unknown as CanonicalOutfit[];

  const scores = new Map<string, OutfitScore>();
  for (const outfit of canonical) {
    scores.set(outfit.id, scoreOutfit(outfit, ctx, env, queryContext));
  }

  let selected = runMmr(canonical, scores, MMR_LAMBDA, SLATE_SIZE);
  let retried = false;
  let violation = false;

  const slateHasViolation = (sel: CanonicalOutfit[]) =>
    sel.length >= 2 &&
    (hasDuplicateTop(sel) || hasOverlapOver50(sel) || axesViolation(sel));

  if (selected.length >= SLATE_SIZE && slateHasViolation(selected)) {
    retried = true;
    const retrySelected = runMmr(
      canonical,
      scores,
      MMR_LAMBDA_RETRY,
      SLATE_SIZE,
    );
    if (!slateHasViolation(retrySelected)) {
      selected = retrySelected;
    } else {
      violation = true;
      // Keep higher-scoring initial selection; flag violation for telemetry.
      const initSum = selected.reduce(
        (s, o) => s + (scores.get(o.id)?.score ?? 0),
        0,
      );
      const retrySum = retrySelected.reduce(
        (s, o) => s + (scores.get(o.id)?.score ?? 0),
        0,
      );
      if (retrySum > initSum) selected = retrySelected;
    }
  }

  const result = selected as unknown as T[];

  // Count safety: if we ended up with fewer than input, and fewer than slate
  // size, still return what we have (downstream handles partial slates).
  const debug: Record<string, unknown> = {};
  if (env.debug) {
    debug.scores = canonical.map((o) => ({
      outfitId: o.id,
      ...scores.get(o.id),
    }));
    debug.originalOrder = canonical.map((o) => o.id);
    debug.slateOrder = selected.map((o) => o.id);
    debug.lambda = retried ? MMR_LAMBDA_RETRY : MMR_LAMBDA;
    if (retried) debug.retried = true;
    if (violation) debug.slate_constraints_violated = true;
  }

  return { outfits: result, debug };
}

// ── Exposure Event Builder ──────────────────────────────────────────────────

export function buildEliteExposureEvent(
  userId: string,
  outfits: CanonicalOutfit[],
  env: EliteEnv,
): CreateLearningEventInput {
  const allItemIds = outfits.flatMap((o) => o.items.map((i) => i.id));
  const canonicalSlots = outfits.flatMap((o) => o.items.map((i) => i.slot));

  return {
    userId,
    eventType: 'ELITE_SUGGESTION_SERVED',
    entityType: 'outfit',
    entityId: env.requestId ?? randomUUID(),
    signalPolarity: 0,
    signalWeight: 0,
    sourceFeature: 'elite_scoring',
    extractedFeatures: {
      categories: canonicalSlots,
      item_ids: allItemIds,
    },
    context: {
      occasion: env.mode,
      temp_f:
        typeof env.weather === 'object' && env.weather !== null
          ? (env.weather as { temp?: number }).temp
          : undefined,
      schema_version: 1,
      pipeline_version: 1,
    },
  };
}

// ── Stylist Adapters ─────────────────────────────────────────────────────────
// Stylist items use: { id, name, imageUrl, category: 'top'|'bottom'|'shoes'|... }

const STYLIST_TO_CANONICAL: Record<string, CanonicalSlot> = {
  top: 'tops',
  bottom: 'bottoms',
  shoes: 'shoes',
  outerwear: 'outerwear',
  dress: 'dresses',
  accessory: 'accessories',
  activewear: 'activewear',
  swimwear: 'swimwear',
};

const CANONICAL_TO_STYLIST: Record<CanonicalSlot, string> = {
  tops: 'top',
  bottoms: 'bottom',
  shoes: 'shoes',
  outerwear: 'outerwear',
  dresses: 'dress',
  accessories: 'accessory',
  activewear: 'activewear',
  swimwear: 'swimwear',
};

export function normalizeStylistOutfit(outfit: any): CanonicalOutfit {
  return {
    ...outfit,
    items: (outfit.items ?? []).map((item: any) => ({
      ...item,
      slot: STYLIST_TO_CANONICAL[item.category] ?? 'accessories',
    })),
  };
}

export function denormalizeStylistOutfit(outfit: CanonicalOutfit): any {
  const { items, ...rest } = outfit;
  return {
    ...rest,
    items: items.map(({ slot, ...item }) => ({
      ...item,
      category: CANONICAL_TO_STYLIST[slot] ?? 'accessory',
    })),
  };
}

// ── Studio Adapters ──────────────────────────────────────────────────────────
// Studio items use: { id, label, main_category: 'Tops'|'Bottoms'|..., ... }
// Studio outfit: { outfit_id, title, items, why, missing? }

const STUDIO_MAIN_CAT_TO_CANONICAL: Record<string, CanonicalSlot> = {
  Tops: 'tops',
  Bottoms: 'bottoms',
  Shoes: 'shoes',
  Outerwear: 'outerwear',
  Dresses: 'dresses',
  Accessories: 'accessories',
  Activewear: 'activewear',
  Swimwear: 'swimwear',
  Skirts: 'bottoms',
  Bags: 'accessories',
  Headwear: 'accessories',
  Jewelry: 'accessories',
  Formalwear: 'dresses',
  TraditionalWear: 'dresses',
  Loungewear: 'tops',
  Sleepwear: 'tops',
  Maternity: 'tops',
  Unisex: 'tops',
  Costumes: 'tops',
  Undergarments: 'accessories',
};

export function normalizeStudioOutfit(outfit: any): CanonicalOutfit {
  return {
    ...outfit,
    id: outfit.outfit_id ?? outfit.id,
    items: (outfit.items ?? []).map((item: any) => ({
      ...item,
      slot: STUDIO_MAIN_CAT_TO_CANONICAL[item.main_category] ?? 'accessories',
    })),
  };
}

export function denormalizeStudioOutfit(outfit: CanonicalOutfit): any {
  const { slot: _unusedSlot, items, id, ...rest } = outfit as any;
  return {
    ...rest,
    id,
    outfit_id: rest.outfit_id ?? id,
    items: items.map(({ slot, ...item }: any) => item),
  };
}
