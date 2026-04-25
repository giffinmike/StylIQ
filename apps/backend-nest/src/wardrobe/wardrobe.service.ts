// // apps/backend-nest/src/wardrobe/wardrobe.service.ts

import { Injectable } from '@nestjs/common';
import { Storage } from '@google-cloud/storage';
import { CreateWardrobeItemDto } from './dto/create-wardrobe-item.dto';
import { UpdateWardrobeItemDto } from './dto/update-wardrobe-item.dto';
import { DeleteItemDto } from './dto/delete-item.dto';
import { upsertItemNs, deleteItemNs } from '../pinecone/pinecone-upsert';
import { queryUserNs, hybridQueryUserNs } from '../pinecone/pinecone-query';
import { VertexService } from '../vertex/vertex.service';
import { randomUUID } from 'crypto'; // ← NEW
import { pool } from '../db/pool';
import { getSecret, secretExists } from '../config/secrets';
import { getRedisClient } from '../utils/redisClient';

// NEW imports for extracted logic (prompts + scoring only)
import { parseConstraints } from './logic/constraints';
import {
  rerankCatalogWithContext,
  DEFAULT_CONTEXT_WEIGHTS,
  type ContextWeights,
} from './logic/scoring';
import type { UserStyle } from './logic/style';
import type { WeatherContext } from './logic/weather';
import {
  finalizeOutfitSlots,
  validateOutfits,
  validateOutfitCore,
  padToThreeOutfits,
} from './logic/finalize';
import { enforceConstraintsOnOutfits } from './logic/enforce';
import { buildOutfitPrompt } from './prompts/outfitPrompt';
import {
  buildOutfitPlanPrompt,
  buildStartWithItemPrompt,
  buildStartWithItemPromptV4,
  normalizeStartWithItemIntent,
  validateStartWithItemComposition,
  validateStartWithItemIntentMode,
  MutualExclusionError,
  type OutfitPlan,
  type OutfitPlanSlot,
  type CenterpieceItem,
  type RawStartWithItemInput,
  type NormalizedStartWithItemInput,
} from './prompts/outfitPlanPrompt';
import { extractStrictJson } from './logic/json';
import { applyContextualFilters } from './logic/contextFilters';
import { parseEnvContext, type EnvContext } from './logic/envContext';
import {
  resolveUserPresentation,
  isFeminineItem,
  buildGenderDirective,
} from './logic/presentationFilter';
import { STYLE_AGENTS } from './logic/style-agents';
import { validateCategoryPair } from './logic/categoryValidator';
import {
  mapMainCategoryToSlot,
  mapPlanCategoryToSlot,
  pineconeFilterForSlot,
  type Slot,
  REFINEMENT_CATEGORY_KEYWORDS,
  detectSlotsInText,
  SLOT_TO_PLAN_CATEGORY,
  filterBySlot,
} from './logic/categoryMapping';
import { validateSlotMatch } from './logic/slotCompatibilityValidator';

// NEW: feedback filters
import {
  applyFeedbackFilters,
  compileFeedbackRulesFromRows,
  OutfitFeedbackRow, // ✅ correct type
} from './logic/feedbackFilters';

import { ELITE_FLAGS, LEARNING_FLAGS, isEliteDemoUser } from '../config/feature-flags';
import {
  elitePostProcessOutfits,
  normalizeStudioOutfit,
  denormalizeStudioOutfit,
  buildEliteExposureEvent,
} from '../ai/elite/eliteScoring';
import type { StyleContext } from '../ai/elite/eliteScoring';
import { selectTopOutfits, scoreOutfit } from '../ai/styleJudge';
import { isStylisticallyIncoherent } from '../ai/styleVeto';
import { isOccasionAppropriate, getOccasionRejectionReason } from '../ai/occasionFilter';
import { FashionStateService } from '../learning/fashion-state.service';
import {
  loadStylistBrainContext,
  type StyleProfileFields,
} from '../ai/elite/stylistBrain';
import { LearningEventsService } from '../learning/learning-events.service';
import type { LearningEventType, SignalPolarity } from '../learning/dto/learning-event.dto';
import {
  validateOutfit as tasteValidateOutfit,
  extractItemColors,
  expandAvoidColors,
  colorMatchesSafe,
  extractColorIntent,
  extractGarmentIntent,
  extractCandidateGarmentTokens,
  validateItemAgainstIntent,
} from '../ai/elite/tasteValidator';
import type {
  ValidatorItem,
  ValidatorContext,
  ValidatorSlot,
} from '../ai/elite/tasteValidator';

import {
  selectAnchorItem,
  buildCompositionContext,
  rankByComposition,
  scoreOutfitComposition,
  type CompositionItem,
} from '../ai/composition';

// FAST-scoped learning signal loader + boost (bypasses STATE_ENABLED)
import {
  loadFastLearningSignals,
  applyFastLearningBoost,
} from './fast-learning-loader';

// FAST-scoped outfit cohesion scorer
import { scoreFastOutfitCohesion } from './fast-cohesion';

// Structured audit logging (gated behind OUTFIT_AI_DEBUG env var)
import {
  logInput,
  logPrompt,
  logRawResponse,
  logParsed,
  logFilter,
  logOutput,
  logContext,
  logTrace,
} from './logging/outfitAI.logger';

/**
 * Google Cloud Storage client.
 * - Used to delete images from GCS when wardrobe items are removed.
 */
const storage = new Storage();

// ─────────────────────────────────────────────────────────────────────────────
// Catalog typing + coercion helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The shape of an item the "catalog" (Pinecone search results) feeds into the
 * outfit generator. This is a lightweight, prompt-friendly view.
 */
type CatalogItem = {
  index: number;
  id: string;
  name?: string; // original DB name — used by styleJudge detectors
  label: string;
  image?: string; // computed best: touched_up > processed > original
  image_url?: string; // original uploaded image (preserved for semantics)

  // core used by all scorers
  main_category?: string;
  subcategory?: string;
  color?: string;
  color_family?: string;
  shoe_style?: string;
  dress_code?: string;
  formality_score?: number;

  // extras used by style/weather scorers (all optional)
  brand?: string;
  material?: string;
  sleeve_length?: string;
  layering?: string; // 'Base' | 'Mid' | 'Outer'
  waterproof_rating?: number | string;
  rain_ok?: boolean;
};

// ── Weights normalization helpers ────────────────────────────────────────────
type WeightsLong = {
  constraintsWeight: number;
  styleWeight: number;
  weatherWeight: number;
  feedbackWeight?: number;
};
type WeightsShort = {
  constraints: number;
  style: number;
  weather: number;
  feedback?: number;
};
type AnyWeights = WeightsLong | WeightsShort;

// ───────────────────────────────────────────────
// Slot helpers (now using canonical categoryMapping)
// ───────────────────────────────────────────────
// NOTE: Slot type is imported from ./logic/categoryMapping

function toLongWeights(w: AnyWeights): WeightsLong {
  if ('styleWeight' in w) return { ...w };
  return {
    constraintsWeight: w.constraints,
    styleWeight: w.style,
    weatherWeight: w.weather,
    feedbackWeight: w.feedback,
  };
}

function fromLongWeights(longW: WeightsLong, like: AnyWeights): AnyWeights {
  if ('styleWeight' in like) {
    // Convert frontend shape → short shape
    return {
      constraints: like.constraintsWeight ?? longW.constraintsWeight,
      style: like.styleWeight ?? longW.styleWeight,
      weather: like.weatherWeight ?? longW.weatherWeight,
      feedback: like.feedbackWeight ?? longW.feedbackWeight,
    };
  }
  // Already in short shape → just normalize from long
  return {
    constraints: longW.constraintsWeight,
    style: longW.styleWeight,
    weather: longW.weatherWeight,
    feedback: longW.feedbackWeight,
  };
}

// Soft numeric prefs derived from feedback rules (only for rerank nudges)
function buildUserPrefsFromRules(
  catalog: Array<{
    id?: string;
    label?: string;
    subcategory?: string;
    main_category?: string;
    color?: string;
    color_family?: string;
  }>,
  rules: ReturnType<typeof compileFeedbackRulesFromRows>,
): Map<string, number> {
  const m = new Map<string, number>();
  if (!rules?.length || !catalog?.length) return m;

  const lc = (v?: string) => (v ?? '').toLowerCase();

  // mirror the predicate logic lightly to issue a -5 soft penalty
  const hit = (it: any): boolean => {
    const id = it?.id;
    const brand = lc(it.brand);
    const color = lc(it.color) || lc(it.color_family);
    const main = lc(it.main_category);
    const sub = lc(it.subcategory);
    const lbl = lc(it.label);

    for (const r of rules) {
      switch (r.kind) {
        case 'excludeItemIds':
          if (id && r.item_ids.includes(id)) return true;
          break;
        case 'excludeBrand':
          if (brand && brand.includes(lc(r.brand))) {
            if (!r.category) return true;
            if (main.includes(lc(r.category))) return true;
          }
          break;
        case 'excludeColorOnCategory':
          if (
            r.category &&
            (main.includes(r.category) || sub.includes(r.category))
          ) {
            if (color.includes(r.color)) return true;
            if (lbl.includes(r.color)) return true;
          }
          break;
        case 'excludeColor':
          if (color.includes(r.color) || lbl.includes(r.color)) return true;
          break;
        case 'excludeSubstring':
          if ((r.field === 'label' ? lbl : sub).includes(lc(r.value))) {
            if (!r.category) return true;
            if (main.includes(lc(r.category))) return true;
          }
          break;
      }
    }
    return false;
  };

  for (const it of catalog) {
    const id = it?.id;
    if (!id) continue;
    if (hit(it)) m.set(id, -5); // -5 raw → scaled to ~ -0.2 in reranker
  }
  return m;
}

// Phase 2 containment: legacy-path-only environment gate.
// Pure, local helper. Does not mutate inputs; preserves locked/forceKeep items;
// safety-valve returns the original catalog when filtering would leave < 6 items.
function applyEnvironmentalFilters(catalog: any[], env: EnvContext): any[] {
  if (!Array.isArray(catalog) || catalog.length === 0) return catalog;
  if (
    env.climate !== 'hot' &&
    env.climate !== 'cold' &&
    env.climate !== 'extreme'
  ) {
    return catalog;
  }

  const COLD_OUTERWEAR =
    /\b(parka|puffer|down\s+jacket|peacoat|pea\s+coat|overcoat|topcoat|trench(?:\s+coat)?|wool\s+coat|fur\s+coat|sherpa|fleece|heavy\s+coat|winter\s+coat|ski\s+jacket)\b/i;
  const HEAVY_ITEMS =
    /\b(turtleneck|cable\s*knit|chunky\s*knit|heavy\s*sweater|wool\s*sweater|thermal|long\s*johns|corduroy|tweed|flannel|wool\s*pants|wool\s*trousers)\b/i;
  const SHORTS = /\bshorts?\b/i;
  const SANDALS = /\b(sandals?|flip[\s-]?flops?|slides?|espadrilles?)\b/i;

  const blob = (it: any): string =>
    `${String(it?.main_category ?? '')} ${String(it?.subcategory ?? '')} ${String(it?.label ?? '')}`.toLowerCase();

  const isHeavyForHot = (it: any): boolean => {
    const b = blob(it);
    return COLD_OUTERWEAR.test(b) || HEAVY_ITEMS.test(b);
  };

  const isShortsOrSandals = (it: any): boolean => {
    const b = blob(it);
    return SHORTS.test(b) || SANDALS.test(b);
  };

  const filtered = catalog.filter((it: any) => {
    if (it?.__locked || it?.forceKeep) return true;
    if (env.climate === 'hot') return !isHeavyForHot(it);
    return !isShortsOrSandals(it);
  });

  if (filtered.length < 6) return catalog;
  return filtered;
}

@Injectable()
export class WardrobeService {
  constructor(
    private readonly vertex: VertexService,
    private readonly fashionStateService: FashionStateService,
    private readonly learningEventsService: LearningEventsService,
  ) {}

  private emitRefinementLearning(
    userId: string,
    eventType: LearningEventType,
    polarity: SignalPolarity,
    weight: number,
    opts: {
      entityId?: string;
      entitySignature?: string;
      itemIds?: string[];
      tags?: string[];
      metadata?: Record<string, any>;
    },
  ): void {
    if (!LEARNING_FLAGS.EVENTS_ENABLED) return;
    const cw = Math.max(0.1, Math.min(1.0, weight));
    try {
      this.learningEventsService
        .logEvent({
          userId,
          eventType,
          entityType: 'outfit',
          entityId: opts.entityId,
          entitySignature: opts.entitySignature,
          signalPolarity: polarity,
          signalWeight: cw,
          extractedFeatures: {
            item_ids: opts.itemIds,
            tags: opts.entitySignature
              ? [...(opts.tags ?? []), opts.entitySignature]
              : opts.tags,
          },
          sourceFeature: 'outfit_refinement',
          context: opts.metadata
            ? ({ ...opts.metadata, schema_version: 1 } as any)
            : ({ schema_version: 1 } as any),
          clientEventId: opts.entitySignature
            ? `${opts.entitySignature}:${userId}:${opts.entityId ?? 'none'}`
            : undefined,
        })
        .catch(() => {});
      this.fashionStateService
        .computeAndSaveState(userId)
        .catch(err =>
          console.error('[LEARNING INLINE] recompute failed', err),
        );
    } catch (err) {
      console.warn('[LEARNING] refinement emit failed:', (err as any)?.message);
    }
  }

  // 👇 track base query + refinements per session (Redis-backed, 30-min TTL)
  private static readonly SESSION_TTL = 1800; // 30 minutes

  private sessionKey(id: string) {
    return `outfit_session:${id}`;
  }

  private async getSession(
    id: string,
  ): Promise<{ baseQuery: string; refinements: string[] } | null> {
    try {
      const raw = await getRedisClient().get(this.sessionKey(id));
      if (!raw) return null;
      return typeof raw === 'string' ? JSON.parse(raw) : (raw as any);
    } catch {
      return null;
    }
  }

  private async setSession(
    id: string,
    data: { baseQuery: string; refinements: string[] },
  ): Promise<void> {
    try {
      await getRedisClient().set(this.sessionKey(id), JSON.stringify(data), {
        ex: WardrobeService.SESSION_TTL,
      });
    } catch {
      // Redis unavailable — refinement degrades gracefully
    }
  }

  /**
   * Load StyleContext for elite scoring (non-blocking).
   */
  private async loadEliteStyleContext(
    userId: string,
  ): Promise<
    StyleContext & { _brainStyleProfile?: StyleProfileFields | null }
  > {
    try {
      const brainCtx = await loadStylistBrainContext(
        userId,
        this.fashionStateService,
      );

      // P0 VETO FALLBACK: if brain timed out (200ms race), fetch P0 columns directly
      // so avoid_colors / coverage_no_go / avoid_materials enforcement is never skipped.
      // Mirrors ai.service.ts suggestVisualOutfits P0 fallback.
      if (!brainCtx.styleProfile && userId) {
        try {
          const _p0Row = (
            await pool.query(
              `SELECT coverage_no_go, avoid_colors, avoid_materials,
                      formality_floor, walkability_requirement,
                      avoid_patterns, silhouette_preference,
                      fit_preferences, fabric_preferences, style_preferences, disliked_styles
               FROM style_profiles WHERE user_id = $1 LIMIT 1`,
              [userId],
            )
          ).rows[0];
          if (_p0Row) {
            const _toArr = (v: unknown): string[] =>
              Array.isArray(v)
                ? v.filter((x: any) => typeof x === 'string')
                : [];
            const _toStr = (v: unknown): string | null =>
              typeof v === 'string' ? v : null;
            (brainCtx as any).styleProfile = {
              coverage_no_go: _toArr(_p0Row.coverage_no_go),
              avoid_colors: _toArr(_p0Row.avoid_colors),
              avoid_materials: _toArr(_p0Row.avoid_materials),
              formality_floor: _toStr(_p0Row.formality_floor),
              walkability_requirement: _toStr(_p0Row.walkability_requirement),
              avoid_patterns: _toArr(_p0Row.avoid_patterns),
              silhouette_preference: _toStr(_p0Row.silhouette_preference),
              fit_preferences: _toArr(_p0Row.fit_preferences),
              fabric_preferences: _toArr(_p0Row.fabric_preferences),
              style_preferences: _toArr(_p0Row.style_preferences),
              disliked_styles: _toArr(_p0Row.disliked_styles),
            };
          }
        } catch {
          // fail-open: no P0 vetoes if fallback also fails
        }
      }
      return {
        presentation: brainCtx.presentation,
        fashionState: brainCtx.fashionState
          ? {
              topBrands: brainCtx.fashionState.topBrands,
              avoidBrands: brainCtx.fashionState.avoidBrands,
              topColors: brainCtx.fashionState.topColors,
              avoidColors: brainCtx.fashionState.avoidColors,
              topStyles: brainCtx.fashionState.topStyles,
              avoidStyles: brainCtx.fashionState.avoidStyles,
              topCategories: brainCtx.fashionState.topCategories,
              priceBracket: brainCtx.fashionState.priceBracket,
              isColdStart: brainCtx.fashionState.isColdStart,
            }
          : null,
        preferredBrands: brainCtx.styleProfile?.preferred_brands ?? [],
        styleProfile: brainCtx.styleProfile
          ? {
              fit_preferences: brainCtx.styleProfile.fit_preferences,
              fabric_preferences: brainCtx.styleProfile.fabric_preferences,
              style_preferences: brainCtx.styleProfile.style_preferences,
              disliked_styles: brainCtx.styleProfile.disliked_styles,
              // P0/P1 profile-driven scoring
              avoid_colors: brainCtx.styleProfile.avoid_colors,
              avoid_materials: brainCtx.styleProfile.avoid_materials,
              pattern_preferences: brainCtx.styleProfile.pattern_preferences,
              avoid_patterns: brainCtx.styleProfile.avoid_patterns,
              silhouette_preference:
                brainCtx.styleProfile.silhouette_preference,
              contrast_preference: brainCtx.styleProfile.contrast_preference,
            }
          : null,
        // Full brain profile for validator P0 fields (coverage_no_go, formality_floor, walkability_requirement)
        _brainStyleProfile: brainCtx.styleProfile ?? null,
      };
    } catch {
      return {};
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Enum whitelists
  // ─────────────────────────────────────────────────────────────

  private static readonly PATTERN_ENUM_WHITELIST: string[] = [
    'SOLID',
    'STRIPE',
    'CHECK',
    'HERRINGBONE',
    'WINDOWPANE',
    'FLORAL',
    'DOT',
    'CAMO',
    'ABSTRACT',
    'OTHER',
  ];
  private static readonly SEASONALITY_ENUM_WHITELIST: string[] = [
    'SS',
    'FW',
    'ALL_SEASON',
  ];
  private static readonly LAYERING_ENUM_WHITELIST: string[] = [
    'BASE',
    'MID',
    'SHELL',
    'ACCENT',
  ];

  // Generic safe-casters
  private asStr(v: any): string | undefined {
    if (v === undefined || v === null) return undefined;
    const s = String(v).trim();
    return s ? s : undefined;
  }
  private asNum(v: any): number | undefined {
    if (v === undefined || v === null) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }

  // // apps/backend-nest/src/wardrobe/wardrobe.service.ts

  // apps/backend-nest/src/wardrobe/wardrobe.service.ts

  // apps/backend-nest/src/wardrobe/wardrobe.service.ts

  private parseRefinementLocks(
    refinement: string,
    catalog: CatalogItem[],
    prevLockedIds: string[],
  ): {
    keepSlots: Set<Slot>;
    replaceSlots: Set<Slot>;
    additionsBySlot: Map<Slot, string>;
  } {
    const lc = refinement.toLowerCase();

    const keepSlots = new Set<Slot>();
    const replaceSlots = new Set<Slot>();
    const additionsBySlot = new Map<Slot, string>();

    // 1) Detect explicit "keep" language
    if (/keep[^.]*shirt|keep[^.]*top/.test(lc)) keepSlots.add('tops');
    if (/keep[^.]*shorts?|keep[^.]*pants?/.test(lc)) keepSlots.add('bottoms');
    if (/keep[^.]*shoes?|keep[^.]*sneakers?/.test(lc)) keepSlots.add('shoes');

    // 2) Detect color+slot replacements — always unlock slot even if not found
    const colorSlotReqs: { re: RegExp; slot: Slot; color: RegExp }[] = [
      {
        re: /\bgrey\s+(shorts|pants|trousers)\b/,
        slot: 'bottoms',
        color: /grey|gray/i,
      },
      { re: /\bred\s+shoes?\b/, slot: 'shoes', color: /red/i },
      {
        re: /\bblue\s+(shirt|top|tee|t-?shirt|polo)\b/,
        slot: 'tops',
        color: /blue|navy/i,
      },
      { re: /\bred\s+shoes?\b/, slot: 'shoes', color: /red/i },
      {
        re: /\bred\s+(shirt|top|tee|t-?shirt|polo)\b/,
        slot: 'tops',
        color: /red/i,
      },
      {
        re: /\bgrey\s+(shorts|pants|trousers)\b/,
        slot: 'bottoms',
        color: /grey|gray/i,
      },
      {
        re: /\bblue\s+(shirt|top|tee|t-?shirt|polo)\b/,
        slot: 'tops',
        color: /blue|navy/i,
      },
    ];

    for (const req of colorSlotReqs) {
      if (req.re.test(lc)) {
        const found = this.findByColorAndSlot(catalog, req.slot, req.color);
        if (found) additionsBySlot.set(req.slot, found);

        // ✅ always unlock the slot, even if no item was found
        replaceSlots.add(req.slot);
      }
    }

    // 3) Detect generic "replace/swap" language
    if (/\b(replace|swap|change|different|other|not those)\b/.test(lc)) {
      if (/\bshoes?|sneakers?\b/.test(lc) && !keepSlots.has('shoes'))
        replaceSlots.add('shoes');
      if (/\bshorts?|pants?|bottoms?\b/.test(lc) && !keepSlots.has('bottoms'))
        replaceSlots.add('bottoms');
      if (
        /\b(shirt|top|tee|t-?shirt|polo)\b/.test(lc) &&
        !keepSlots.has('tops')
      )
        replaceSlots.add('tops');
    }

    // 🛡️ DRESS PROMOTION RULE (normal mode)
    // If refinement mentions a dress, promote to dresses slot and suppress tops+bottoms
    const dressPattern = /\b(dress|gown|romper|jumpsuit|midi\s*dress)\b/i;
    if (dressPattern.test(lc)) {
      replaceSlots.delete('bottoms');
      replaceSlots.delete('tops');
      replaceSlots.add('dresses');
      keepSlots.delete('bottoms');
      keepSlots.delete('tops');
    }

    return { keepSlots, replaceSlots, additionsBySlot };
  }

  private mergeLockedIds(
    prevLockedIds: string[],
    catalog: CatalogItem[],
    keepSlots: Set<Slot>,
    replaceSlots: Set<Slot>,
    additionsBySlot: Map<Slot, string>,
  ): string[] {
    const idToItem = new Map(
      prevLockedIds.map((id) => [id, catalog.find((c) => c.id === id)]),
    );
    const resultBySlot = new Map<Slot, string>();

    // ✅ 1. Carry over only items whose slot is explicitly kept
    for (const id of prevLockedIds) {
      const item = idToItem.get(id);
      const slot = this.getSlot(item);
      if (!slot) continue;
      if (keepSlots.has(slot)) resultBySlot.set(slot, id);
    }

    // ✅ 2. Force-remove anything in replaceSlots even if no new item was found
    for (const slot of replaceSlots) {
      resultBySlot.delete(slot);
    }

    // ✅ 3. Add newly requested items (color match, etc.)
    for (const [slot, id] of additionsBySlot.entries()) {
      resultBySlot.set(slot, id);
    }

    return Array.from(new Set(resultBySlot.values()));
  }

  // Pull user feedback rows from your DB (adjust table/columns if yours differ)

  // Replace your current fetchFeedbackRows with this exact version:
  private async fetchFeedbackRows(
    userId: string,
  ): Promise<OutfitFeedbackRow[]> {
    // Adjust table/column names only if they differ in your DB.
    // This version is compatible with your CSV: rating = -1/1, notes = free text.
    const { rows } = await pool.query(
      `SELECT id, user_id, outfit_id, rating, notes, created_at
       FROM outfit_feedback
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 500`,
      [userId],
    );

    return rows.map((r: any) => {
      // rating: -1 => "dislike", 1 => "like", anything else => null
      const rating =
        r.rating === -1 ? 'dislike' : r.rating === 1 ? 'like' : null;

      // notes may be plain text like: "Avoid shoes with green in them."
      // Keep as-is; compileFeedbackRulesFromRows() will parse color/brand/slot.
      const notes =
        typeof r.notes === 'string' && r.notes.trim().length ? r.notes : null;

      return {
        id: String(r.id),
        request_id: '', // unknown here
        user_id: String(r.user_id),
        rating, // "like" | "dislike" | null
        tags: null, // not present in your CSV
        notes, // free text
        outfit_json: null, // not present in your CSV
        created_at: String(r.created_at),
      } as OutfitFeedbackRow;
    });
  }

  // Normalizers
  private normLower(val?: string | null) {
    if (!val) return undefined;
    const s = String(val).trim();
    if (!s) return undefined;
    return s.toLowerCase();
  }
  private normalizePattern(val?: string | null) {
    const s = this.normLower(val);
    if (!s) return undefined;
    const map: Record<string, string> = {
      solid: 'SOLID',
      stripe: 'STRIPE',
      striped: 'STRIPE',
      stripes: 'STRIPE',
      plaid: 'CHECK',
      check: 'CHECK',
      checked: 'CHECK',
      herringbone: 'HERRINGBONE',
      windowpane: 'WINDOWPANE',
      floral: 'FLORAL',
      flower: 'FLORAL',
      dot: 'DOT',
      dots: 'DOT',
      polka: 'DOT',
      polka_dot: 'DOT',
      camo: 'CAMO',
      camouflage: 'CAMO',
      abstract: 'ABSTRACT',
      print: 'ABSTRACT',
      printed: 'ABSTRACT',
      graphic: 'ABSTRACT',
      other: 'OTHER',
    };
    return map[s] ?? undefined;
  }
  private coerceMainCategoryFromSub(
    rawMain?: string,
    sub?: string,
  ): string | undefined {
    const main = (rawMain ?? '').trim();
    const s = (sub ?? '').toLowerCase();

    const isOuter = [
      'blazer',
      'sport coat',
      'sportcoat',
      'suit jacket',
      'jacket',
      'coat',
      'parka',
      'trench',
      'overcoat',
      'topcoat',
    ].some((k) => s.includes(k));
    if (isOuter) return 'Outerwear';

    const isShoe = [
      'loafer',
      'loafers',
      'sneaker',
      'sneakers',
      'boot',
      'boots',
      'heel',
      'heels',
      'pump',
      'oxford',
      'derby',
      'dress shoe',
      'dress shoes',
      'sandal',
      'sandals',
    ].some((k) => s.includes(k));
    if (isShoe) return 'Shoes';

    const isAccessory = [
      'belt',
      'hat',
      'scarf',
      'tie',
      'watch',
      'sunglasses',
      'bag',
      'briefcase',
    ].some((k) => s.includes(k));
    if (isAccessory) return 'Accessories';

    return main || undefined;
  }
  private normalizeAnchorRole(val?: string | null) {
    const s = this.normLower(val);
    if (!s) return undefined;
    const map: Record<string, string> = {
      hero: 'Hero',
      neutral: 'Neutral',
      connector: 'Connector',
    };
    return map[s] ?? undefined;
  }
  private normalizeSeasonality(val?: string | null) {
    const s = this.normLower(val);
    if (!s) return undefined;
    const map: Record<string, string> = {
      ss: 'SS',
      'spring/summer': 'SS',
      spring: 'SS',
      summer: 'SS',
      fw: 'FW',
      'fall/winter': 'FW',
      fall: 'FW',
      autumn: 'FW',
      winter: 'FW',
      allseason: 'ALL_SEASON',
      'all season': 'ALL_SEASON',
      'all-season': 'ALL_SEASON',
      all_season: 'ALL_SEASON',
      all: 'ALL_SEASON',
      'year-round': 'ALL_SEASON',
      'year round': 'ALL_SEASON',
    };
    return map[s];
  }

  /**
   * Maps a CatalogItem to its Slot using the canonical categoryMapping.
   * NEVER returns undefined - all 21 categories are mapped.
   */
  private getSlot(c?: CatalogItem): Slot {
    if (!c) return 'other';
    const main = c.main_category ?? '';
    // Use the canonical mapping - never returns undefined
    return mapMainCategoryToSlot(main);
  }

  private textOf(c: CatalogItem): string {
    return `${c.color ?? ''} ${c.color_family ?? ''} ${c.label ?? ''}`.toLowerCase();
  }

  private findByColorAndSlot(
    catalog: CatalogItem[],
    slot: Slot,
    colorRe: RegExp,
    extra?: (c: CatalogItem) => boolean,
  ): string | undefined {
    const match = catalog.find(
      (c) =>
        this.getSlot(c) === slot &&
        colorRe.test(this.textOf(c)) &&
        (!extra || extra(c)),
    );
    return match?.id;
  }

  // Ultra-casual screen used only when the query implies "upscale"
  private isUltraCasualForUpscale(c: {
    main_category?: string;
    subcategory?: string;
    label?: string;
    dress_code?: string;
    formality_score?: number;
  }): boolean {
    const main = (c.main_category ?? '').toLowerCase();
    const sub = (c.subcategory ?? '').toLowerCase();
    const lbl = (c.label ?? '').toLowerCase();

    // obvious casual tops & loud casual items
    const casualWords = /(t-?shirt|tee|hoodie|tank|graphic tee|hawaiian)/;
    if (casualWords.test(sub) || casualWords.test(lbl)) return true;

    // shorts for bottoms
    if (main === 'bottoms' && /\bshorts?\b/.test(sub)) return true;

    // jeans: allow only if clearly dressy; otherwise screen out for upscale
    if (/\bjeans?\b/.test(sub) && (c.formality_score ?? 0) < 6) return true;

    // generic dress code + formality gate
    const dc = c.dress_code;
    if (
      dc &&
      (dc === 'UltraCasual' || dc === 'Casual') &&
      (c.formality_score ?? 0) < 6
    ) {
      return true;
    }

    return false;
  }

  private retitleOutfit(o: {
    title: string;
    why: string;
    items: CatalogItem[];
  }): { title: string; why: string } {
    if (!o.items?.length) return { title: o.title, why: o.why };

    // Use canonical slot mapping for category filtering
    const tops = filterBySlot(o.items, 'tops');
    const bottoms = filterBySlot(o.items, 'bottoms');
    const shoes = filterBySlot(o.items, 'shoes');

    const topName = tops[0]?.label ?? '';
    const bottomName = bottoms[0]?.label ?? '';
    const shoeName = shoes[0]?.label ?? '';

    // Very simple rewrite
    const title = `Outfit with ${[topName, bottomName, shoeName]
      .filter(Boolean)
      .join(', ')}`;

    const why = `This look combines ${topName || 'a top'} with ${
      bottomName || 'a bottom'
    } and ${shoeName || 'shoes'} for a complete outfit.`;

    return { title, why };
  }

  /**
   * MAIN OUTFIT GENERATOR
   */
  async generateOutfits(
    userId: string,
    query: string,
    topK: number,
    opts: {
      userStyle?: UserStyle;
      weather?: WeatherContext;
      weights?: ContextWeights;
      useWeather?: boolean;
      useFeedback?: boolean;
      styleAgent?:
        | 'agent1'
        | 'agent2'
        | 'agent3'
        | 'agent4'
        | 'agent5'
        | 'agent6'
        | 'agent7'
        | 'agent8'
        | 'agent9'
        | 'agent10'
        | 'agent11'
        | 'agent12';
      sessionId?: string;
      refinementPrompt?: string;
      lockedItemIds?: string[];
      requestId?: string;
      aaaaMode?: boolean;
    },
  ) {
    const reqId = opts?.requestId || randomUUID();
    const stdStartTime = Date.now();
    const aaaaMode = opts?.aaaaMode ?? false;
    console.log('🔥 LEGACY generateOutfits() PATH EXECUTED');
    try {
      let lockedIds =
        (opts as any)?.lockedItemIds ?? (opts as any)?.locked_item_ids ?? [];
      console.log('[CTRL] lockedIds =', lockedIds);
      if (aaaaMode) console.log('🎯 [AAAA] Mode active — max quality settings');

      logInput(reqId, {
        userId,
        query,
        mode: aaaaMode ? 'standard-aaaa' : 'standard',
        topK,
        weather: opts?.weather,
        userStyle: opts?.userStyle,
        lockedItemIds: lockedIds,
        styleAgent: opts?.styleAgent,
      });

      // ── Gender/presentation query (mirrors ai.service.ts) ──────
      let userPresentation: 'masculine' | 'feminine' | 'mixed' = 'mixed';
      try {
        const { rows: genderRows } = await pool.query(
          'SELECT gender_presentation FROM users WHERE id = $1 LIMIT 1',
          [userId],
        );
        userPresentation = resolveUserPresentation(
          genderRows[0]?.gender_presentation || '',
        );
      } catch {
        // Fail open — default to 'mixed' (no filtering)
      }

      // ── Session & refinement handling ───────────────────────────
      const sessionId = opts?.sessionId?.trim();
      const refinement = (opts?.refinementPrompt ?? '').trim();
      console.log('[CTRL] lockedItemIds =', opts?.lockedItemIds);

      let baseQuery = query;
      if (sessionId) {
        const sess = await this.getSession(sessionId);
        if (!sess) {
          await this.setSession(sessionId, {
            baseQuery: query,
            refinements: [],
          });
        } else {
          baseQuery = sess.baseQuery || query;
          if (refinement) {
            sess.refinements.push(refinement);
            await this.setSession(sessionId, sess);
          }
        }
      }

      // Build effectiveQuery (what we actually embed and parse for constraints)
      let effectiveQuery = baseQuery;
      if (refinement) {
        effectiveQuery = refinement;
      } else if (sessionId) {
        const sess = await this.getSession(sessionId);
        if (sess && sess.refinements.length) {
          effectiveQuery = `${baseQuery}. User refinements: ${sess.refinements.join('; ')}`;
        }
      }

      // Heuristic: detect requested slots/items in the refinement for retrieval/rerank
      const needSneakers =
        /\b(sneaker|sneakers|trainers|running shoes?|athletic (?:shoe|shoes))\b/i.test(
          refinement,
        );
      const needShorts = /\bshorts?\b/i.test(refinement);
      const needLoafers = /\bloafers?\b/i.test(refinement);
      const needJeans = /\bjeans?\b/i.test(refinement);

      const isSneaker = (c?: CatalogItem) => {
        if (!c) return false;
        const sub = (c.subcategory ?? '').toLowerCase();
        const lbl = (c.label ?? '').toLowerCase();
        return /\b(sneakers?|trainers?|running|athletic)\b/i.test(sub || lbl);
      };
      const isShorts = (c?: CatalogItem) => {
        if (!c) return false;
        const sub = (c.subcategory ?? '').toLowerCase();
        const lbl = (c.label ?? '').toLowerCase();
        return /\bshorts?\b/i.test(sub || lbl);
      };
      const isLoafers = (c?: CatalogItem) => {
        if (!c) return false;
        const sub = (c.subcategory ?? '').toLowerCase();
        const lbl = (c.label ?? '').toLowerCase();
        return /\bloafers?\b/i.test(sub || lbl);
      };
      const isJeans = (c?: CatalogItem) => {
        if (!c) return false;
        const sub = (c.subcategory ?? '').toLowerCase();
        const lbl = (c.label ?? '').toLowerCase();
        return /\bjeans?\b/i.test(sub || lbl);
      };

      // ── 1) Retrieval on effectiveQuery (NOT just baseQuery) ─────
      const queryVec = await this.vertex.embedText(effectiveQuery);
      let matches = await queryUserNs({
        userId,
        vector: queryVec,
        topK,
        includeMetadata: true,
      });

      // ── Inject any explicitly requested color+slot items not in matches ─────────
      const mustHaves: {
        color: string;
        slot: 'shoes' | 'bottoms' | 'tops';
        name: string;
      }[] = [];

      // crude color+slot intent detection
      if (/\bblack\b/i.test(refinement) && /\bloafers?\b/i.test(refinement)) {
        mustHaves.push({
          color: 'black',
          slot: 'shoes',
          name: 'black loafers',
        });
      }
      if (/\bbrown\b/i.test(refinement) && /\bshorts?\b/i.test(refinement)) {
        mustHaves.push({
          color: 'brown',
          slot: 'bottoms',
          name: 'brown shorts',
        });
      }
      // add more color+slot combos as needed

      if (mustHaves.length) {
        const { rows } = await pool.query(
          `SELECT * FROM wardrobe_items 
     WHERE user_id = $1
       AND main_category ILIKE ANY($2)
       AND color ILIKE ANY($3)
     LIMIT 10`,
          [
            userId,
            mustHaves.map((m) =>
              m.slot === 'shoes'
                ? 'Shoes'
                : m.slot === 'bottoms'
                  ? 'Bottoms'
                  : 'Tops',
            ),
            mustHaves.map((m) => `%${m.color}%`),
          ],
        );

        const seen = new Set(
          matches.map((m) => this.normalizePineconeId(m.id).id),
        );

        for (const r of rows) {
          // ✅ Force inject even if seen already
          if (seen.has(r.id)) {
            console.log('⚡ Overriding seen for must-have:', r.name);
          } else {
            seen.add(r.id);
          }

          // ✅ Use real categories from DB row (more robust than hardcoded)
          const main = r.main_category || 'Shoes';
          const sub = r.subcategory || 'Loafers';

          // ✅ Inject as Pinecone-style match with unique ID + forceKeep
          matches.unshift({
            id: `${r.id}:forced_musthave`, // ⚡ unique ID → bypass dedupe
            score: 999, // ⚡ float to top
            values: new Array(512).fill(0), // ⚡ required so rerank accepts it
            metadata: {
              id: r.id,
              name: r.name,
              label: r.name,
              image_url: r.image_url,
              main_category: main,
              subcategory: sub,
              color: r.color,
              color_family: r.color_family,
              brand: r.brand,
              dress_code: r.dress_code,
              formality_score: r.formality_score,
              forceKeep: true, // ⚡ survive contextual filters
            },
          });

          // ⚡ Also lock them by real DB ID so they survive all filters
          if (!lockedIds.includes(r.id)) {
            lockedIds.push(r.id);
          }
        }

        console.log(
          '🧩 Injected must-have items into matches:',
          matches
            .filter((m) => m.id.endsWith(':forced_musthave'))
            .map((m) => m.metadata?.name),
        );
        console.log(
          '🧩 MATCHES snapshot after inject:',
          matches.map((m) => ({
            rawId: m.id,
            normId: this.normalizePineconeId(m.id).id,
            name: m.metadata?.name,
            sub: m.metadata?.subcategory,
            locked: lockedIds.includes(this.normalizePineconeId(m.id).id),
          })),
        );
      }

      // ── 1b) Targeted retrieval boosts for requested items ───────
      // Pull a smaller batch per requested term and merge to front.
      const extraFetches: Array<{
        term: string;
        tester: (c?: CatalogItem) => boolean;
      }> = [];
      if (needSneakers)
        extraFetches.push({ term: 'sneakers', tester: isSneaker });
      if (needShorts) extraFetches.push({ term: 'shorts', tester: isShorts });
      if (needLoafers)
        extraFetches.push({ term: 'loafers', tester: isLoafers });
      if (needJeans) extraFetches.push({ term: 'jeans', tester: isJeans });

      if (extraFetches.length) {
        const per = Math.max(5, Math.ceil(topK / 2));
        const seen = new Set(
          matches.map((m) => this.normalizePineconeId(m.id).id),
        );
        for (const { term } of extraFetches) {
          const vec = await this.vertex.embedText(`${baseQuery} ${term}`);
          const extra = await queryUserNs({
            userId,
            vector: vec,
            topK: per,
            includeMetadata: true,
          });
          // Dedup and prepend
          const uniques = extra.filter((e) => {
            const { id } = this.normalizePineconeId(e.id);
            if (seen.has(id)) return false;
            seen.add(id);
            return true;
          });
          matches = [...uniques, ...matches].slice(
            0,
            Math.max(topK, matches.length),
          );
        }
      }

      console.log('📦 Building catalog from matches, lockedIds =', lockedIds);

      // ── 2) Build catalog ────────────────────────────────────────
      let catalog: CatalogItem[] = matches.map((m, i) => {
        const { id } = this.normalizePineconeId(m.id);
        const meta: any = m.metadata || {};
        const sub_raw = this.asStr(meta.subcategory ?? meta.subCategory);
        const main_raw = this.asStr(meta.main_category ?? meta.mainCategory);
        const main_fix = this.coerceMainCategoryFromSub(main_raw, sub_raw);

        return {
          index: i + 1,
          id,
          label: this.summarizeItem(meta),

          image_url: this.asStr(meta.image_url ?? meta.imageUrl),
          main_category: main_fix,
          subcategory: sub_raw,
          color: this.asStr(meta.color ?? meta.color_family),
          color_family: this.asStr(meta.color_family),
          shoe_style: this.asStr(meta.shoe_style),
          dress_code: this.asStr(meta.dress_code ?? meta.dressCode),

          formality_score: this.asNum(meta.formality_score),

          brand: this.asStr(meta.brand),
          material: this.asStr(meta.material),
          sleeve_length: this.asStr(meta.sleeve_length),
          layering: this.asStr(meta.layering),
          waterproof_rating: this.asNum(meta.waterproof_rating),
          rain_ok: !!meta.rain_ok,
        };
      });

      // ── Masculine presentation filter (Layer 1: pre-pool) ──────
      if (userPresentation === 'masculine') {
        const beforeLen = catalog.length;
        catalog = catalog.filter(
          (item) =>
            !isFeminineItem(
              item.main_category || '',
              item.subcategory || '',
              item.label || '',
            ),
        );
        console.log(
          `[STD] Masculine filter: ${beforeLen} → ${catalog.length} items`,
        );
      }

      // ── Occasion appropriateness filter (Layer 1.5: pre-pool) ──────
      {
        const _occasionCtx = { query };
        const _beforeOccasion = catalog.length;
        catalog = catalog.filter((item) => {
          if (isOccasionAppropriate(item, _occasionCtx)) return true;
          // console.log(
          //   JSON.stringify({
          //     _tag: 'OCCASION_FILTER_REJECTED',
          //     mode: 'standard',
          //     itemName: item.label,
          //     reason: getOccasionRejectionReason(item, _occasionCtx),
          //   }),
          // );
          return false;
        });
        if (_beforeOccasion > catalog.length) {
          // console.log(
          //   `[STD] Occasion filter: ${_beforeOccasion} → ${catalog.length} items`,
          // );
        }
      }

      // 👇 ADD THIS
      const catalogPreAgent = [...catalog];

      if (refinement) {
        const prevLockedIds = Array.isArray(lockedIds) ? lockedIds.slice() : [];
        const { keepSlots, replaceSlots, additionsBySlot } =
          this.parseRefinementLocks(refinement, catalog, prevLockedIds);

        lockedIds = this.mergeLockedIds(
          prevLockedIds,
          catalog,
          keepSlots,
          replaceSlots,
          additionsBySlot,
        );

        console.log('🔒 Final lockedIds after robust merge:', lockedIds);
      }

      // ⚡ Re-lock any injected must-haves that got wiped out during merge
      for (const m of matches) {
        const norm = this.normalizePineconeId(m.id).id;
        if (m.id.endsWith(':forced_musthave') && !lockedIds.includes(norm)) {
          console.log('⚡ Re-locking forced must-have:', norm);
          lockedIds.push(norm);
        }
      }

      // ── NEW: mark locked items
      if (lockedIds.length) {
        for (const item of catalog) {
          if (lockedIds.includes(item.id)) {
            (item as any).__locked = true;
          }
        }
        console.log('🔒 Locked items marked:', lockedIds);
      }

      console.log(
        '📦 CATALOG snapshot:',
        catalog.map((c) => ({
          id: c.id,
          label: c.label,
          sub: c.subcategory,
          locked: (c as any).__locked,
          forceKeep: (c as any).forceKeep,
        })),
      );

      // ⛓ Mark locked loafers to always survive filtering
      for (const item of catalog) {
        if (
          (item as any).__locked &&
          /\bloafers?\b/i.test(item.subcategory ?? '')
        ) {
          (item as any).forceKeep = true;
        }
      }

      // Style Agent hard filters
      const preAgentCount = catalog.length;
      // Style Agent 1
      if (opts?.styleAgent && STYLE_AGENTS[opts.styleAgent]) {
        const agent = STYLE_AGENTS[opts.styleAgent];

        catalog = catalog.filter((c) => {
          // if ((c as any).__locked || (c as any).forceKeep) return true; // ⛓ allow
          if ((c as any).forceKeep) return true;
          const brand = (c.brand ?? '').toLowerCase();
          const color = (c.color ?? '').toLowerCase();
          const dress = (c.dress_code ?? '').toLowerCase();
          const sub = (c.subcategory ?? '').toLowerCase();

          const matchesBrand = agent.favoriteBrands?.some((b) =>
            brand.includes(b.toLowerCase()),
          );
          const matchesColor = agent.preferredColors?.some((col) =>
            color.includes(col.toLowerCase()),
          );
          const matchesDress = agent.dressBias
            ? dress.includes(agent.dressBias.toLowerCase())
            : false;

          // const banned =
          //   /\b(blazer|dress shirt|loafers?|oxfords?|derbys?|tux|formal)\b/i.test(
          //     sub,
          //   );

          // ⚡ Allow locked items and loafers to bypass banning
          const banned =
            /\b(blazer|dress shirt|oxfords?|derbys?|tux|formal)\b/i.test(sub);

          if ((c as any).__locked || /\bloafers?\b/i.test(sub)) return true;
          return (matchesBrand || matchesColor || matchesDress) && !banned;
        });

        console.log(
          `🎯 Hard-filtered catalog for ${opts.styleAgent}:`,
          catalog.length,
          'items kept',
        );
      }

      // Style Agent 2 (Minimal Luxe)
      // BEFORE: banned blazer/sport coat/loafers/dress shirt/belt → too aggressive
      if (opts?.styleAgent === 'agent2') {
        catalog = catalog.filter((c) => {
          if ((c as any).forceKeep) return true;

          const sub = (c.subcategory ?? '').toLowerCase();
          const lbl = (c.label ?? '').toLowerCase();
          const colorTxt = (c.color ?? c.color_family ?? '').toLowerCase();

          // ban loud/flashy rather than tailoring basics
          const loudPrint =
            /\b(hawaiian|graphic\s*tee|camo|logo|distressed)\b/i.test(sub) ||
            /\b(hawaiian|graphic|logo)\b/i.test(lbl);

          const neonOrHighSat =
            /\b(neon|magenta|lime|bright|high\s*saturation|multi-?color)\b/i.test(
              lbl + ' ' + colorTxt,
            );

          // keep tailoring + neutrals; drop only loud/flashy items
          const banned = loudPrint || neonOrHighSat;
          return !banned;
        });

        console.log(
          `🎯 Agent2 refined filter applied: ${catalog.length} items left (loud prints & neon removed)`,
        );
      }

      // Agent12: Editorial Classic
      if (opts?.styleAgent === 'agent12') {
        catalog = catalog.filter((c) => {
          if ((c as any).forceKeep) return true;

          const sub = (c.subcategory ?? '').toLowerCase();
          const txt =
            `${c.label ?? ''} ${c.color ?? c.color_family ?? ''}`.toLowerCase();

          const loudPrint = /\b(hawaiian|graphic\s*tee|logo|distressed)\b/.test(
            txt,
          );
          const sporty =
            /\b(windbreaker|hoodie|athletic|sneaker)\b/.test(sub) &&
            !/\bloafer|oxford/.test(sub);
          const neon = /\b(neon|magenta|lime|bright|multi-?color)\b/.test(txt);

          return !(loudPrint || sporty || neon);
        });
        // console.log(`🎯 Agent12 refined filter: ${catalog.length} items left`);
      }

      if (opts?.styleAgent) {
        logFilter(reqId, {
          stage: 'style_agent',
          reason: opts.styleAgent,
          catalogBefore: preAgentCount,
          catalogAfter: catalog.length,
          rejectedCount: preAgentCount - catalog.length,
        });
      }

      // 3) Contextual pre-filters — ALWAYS apply (even with styleAgent)
      {
        // ⚡ Keep a copy of locked/forceKeep items before filtering
        const keepMap = new Map(
          catalog
            .filter((c: any) => c.__locked || c.forceKeep)
            .map((c) => [c.id, c]),
        );

        console.log('🎨 Pre-contextual filter catalog count:', catalog.length);

        // Apply contextual filters on the effective query
        catalog = applyContextualFilters(effectiveQuery, catalog, {
          minKeep: 6,
        });

        // 🔒 Restore any locked/forceKeep items that got filtered out
        for (const [id, item] of keepMap.entries()) {
          if (!catalog.some((c) => c.id === id)) {
            catalog.unshift(item);
          }
        }
        console.log('🎨 Post-contextual filter catalog count:', catalog.length);

        logFilter(reqId, {
          stage: 'contextual',
          catalogBefore: preAgentCount,
          catalogAfter: catalog.length,
          rejectedCount: preAgentCount - catalog.length,
        });

        if (keepMap.size) {
          console.log(
            '🔒 Restored locked/forceKeep items after contextual filters',
          );
        }
      }

      // Phase 2: legacy-path environment gate (catalog stage only)
      const env = parseEnvContext(effectiveQuery, opts?.weather);
      catalog = applyEnvironmentalFilters(catalog, env);

      // 3b) Feedback filters / soft prefs
      let feedbackRows: any[] = [];
      let feedbackRules: any[] = [];
      let userPrefs = new Map<string, number>();

      const clientWantsFeedback = opts?.useFeedback !== false; // default ON
      const envDisable = process.env.DISABLE_FEEDBACK === '1';
      const disableFeedback = !clientWantsFeedback || envDisable;

      // console.log('[FEEDBACK] useFeedback (client):', opts?.useFeedback);

      if (!disableFeedback) {
        feedbackRows = await this.fetchFeedbackRows(userId);
        feedbackRules = compileFeedbackRulesFromRows(feedbackRows);

        const preFeedbackCount = catalog.length;
        catalog = applyFeedbackFilters(catalog, feedbackRules, {
          minKeep: 6,
          softenWhenBelow: true,
        });

        logFilter(reqId, {
          stage: 'feedback',
          catalogBefore: preFeedbackCount,
          catalogAfter: catalog.length,
          rejectedCount: preFeedbackCount - catalog.length,
        });

        // soft prefs from rules
        userPrefs = buildUserPrefsFromRules(catalog, feedbackRules);

        // per-item prefs from DB
        const prefRes = await pool.query(
          `SELECT item_id, score FROM user_pref_item WHERE user_id = $1`,
          [userId],
        );
        const prefMap = new Map<string, number>(
          prefRes.rows.map((r: any) => [String(r.item_id), Number(r.score)]),
        );
        for (const [itemId, score] of prefMap) {
          const existing = userPrefs.get(itemId) ?? 0;
          userPrefs.set(itemId, existing + score);
        }
      } else {
        // console.log('[FEEDBACK] Feedback influence skipped.');
      }

      // 3c) Soft-boost requested slots from refinement
      if (needSneakers || needShorts || needLoafers || needJeans) {
        for (const c of catalog) {
          const id = c.id;
          if (!id) continue;
          let bonus = 0;
          if (needSneakers && isSneaker(c)) bonus += 10;
          if (needShorts && isShorts(c)) bonus += 6;
          if (needLoafers && isLoafers(c)) bonus += 6;
          if (needJeans && isJeans(c)) bonus += 6;
          if (bonus) userPrefs.set(id, (userPrefs.get(id) ?? 0) + bonus);
        }
      }

      // 3d) Safety valve if agent filtering became too tight
      if (opts?.styleAgent) {
        const MIN_AGENT_KEEP = 18;
        if (catalog.length < MIN_AGENT_KEEP) {
          console.log(
            `🛟 Agent filter too tight (${catalog.length}); softening to ${MIN_AGENT_KEEP}+ using pre-agent pool + feedback rules.`,
          );
          // Rebuild from the broader pre-agent set, then re-apply feedback bans softly
          catalog = applyFeedbackFilters([...catalogPreAgent], feedbackRules, {
            minKeep: MIN_AGENT_KEEP,
            softenWhenBelow: true,
          });

          // Ensure locked/forceKeep items are still present
          const keepMap2 = new Map(
            catalogPreAgent
              .filter((c: any) => c.__locked || c.forceKeep)
              .map((c) => [c.id, c]),
          );
          for (const [id, item] of keepMap2.entries()) {
            if (!catalog.some((c) => c.id === id)) catalog.unshift(item);
          }
        }
      }

      // Upscale clamp based on effective query
      const needUpscale =
        /\b(upscale|smart\s*casual|business|formal|dressy|rooftop)\b/i.test(
          effectiveQuery,
        );

      const baseConstraints = parseConstraints(effectiveQuery);
      const constraints = { ...baseConstraints };

      // weights normalization
      const incoming = opts?.weights ?? DEFAULT_CONTEXT_WEIGHTS;
      const longW = toLongWeights(incoming);
      if (needUpscale && longW.styleWeight > 0.35) {
        longW.styleWeight = 0.35;
      }
      const tunedWeights = fromLongWeights(longW, incoming) as ContextWeights;

      // Resolve style source
      let effectiveStyle: UserStyle | undefined;
      if (opts?.styleAgent && STYLE_AGENTS[opts.styleAgent]) {
        effectiveStyle = STYLE_AGENTS[opts.styleAgent];
        console.log(
          '🎨 Using style agent override:',
          opts.styleAgent,
          effectiveStyle,
        );
      } else if (opts?.userStyle) {
        effectiveStyle = opts.userStyle;
        console.log('👤 Using user style profile:', effectiveStyle);
      } else {
        console.log('⚪ No style profile or agent applied');
      }

      // 4) Rerank
      let reranked: CatalogItem[];
      if (opts?.styleAgent && STYLE_AGENTS[opts.styleAgent]) {
        console.log(
          '🎨 StyleAgent mode → blended rerank (keeps constraints & feedback)',
        );
        reranked = rerankCatalogWithContext(catalog, constraints, {
          userStyle: STYLE_AGENTS[opts.styleAgent],
          weather: opts?.weather,
          weights: tunedWeights, // keep your computed weights as-is
          useWeather: opts?.useWeather,
          userPrefs, // preserve feedback nudges
        });
      } else {
        reranked = rerankCatalogWithContext(catalog, constraints, {
          userStyle: effectiveStyle,
          weather: opts?.weather,
          weights: tunedWeights,
          useWeather: opts?.useWeather,
          userPrefs,
        });
      }

      // ── NEW: Hard lock items so they always stay in outfits
      if (lockedIds.length) {
        reranked = reranked.map((item) =>
          lockedIds.includes(item.id)
            ? { ...item, __locked: true, rerankScore: Number.MAX_SAFE_INTEGER }
            : item,
        );

        console.log('🔒 Locked items enforced:', lockedIds);
      }

      // ── Force locked items to the very front as indices 1..N ──
      const locked = reranked.filter((it) => (it as any).__locked);
      const unlocked = reranked.filter((it) => !(it as any).__locked);
      const workingCatalog = [...locked, ...unlocked].map((item, i) => ({
        ...item,
        index: i + 1,
      }));

      // 🔢 Map locked items to their current workingCatalog indices
      const wcIndex = new Map(workingCatalog.map((c) => [c.id, c.index]));
      const lockedLines = locked
        .map((l) => `${wcIndex.get(l.id)!}. ${l.label}`)
        .join('\n');

      const catalogLines = workingCatalog
        .map((c) => `${c.index}. ${c.label}`)
        .join('\n');

      if (process.env.DEBUG_STUDIO === 'true') {
        const us = opts?.userStyle as Record<string, any> | undefined;
        console.log('🎨 [Studio] style signals →', {
          occasions: us?.occasions?.length ?? 0,
          preferredColors: us?.preferredColors?.length ?? 0,
          favoriteBrands: us?.favoriteBrands?.length ?? 0,
          avoidSubcategories: us?.avoidSubcategories?.length ?? 0,
          fitPreferences: us?.fitPreferences?.length ?? 0,
          fabricPreferences: us?.fabricPreferences?.length ?? 0,
          stylePreferences: us?.stylePreferences?.length ?? 0,
          styleKeywords: us?.styleKeywords?.length ?? 0,
          climate: us?.climate ?? null,
        });
      }

      let fullPrompt = buildOutfitPrompt(
        catalogLines,
        effectiveQuery,
        opts?.styleAgent,
        opts?.userStyle,
        buildGenderDirective(userPresentation),
      );
      // ── Oversize candidate pool: request more so valid-only gate still yields 3 ──
      fullPrompt = fullPrompt.replace(
        'Build 2–3 complete outfits',
        'Build 6–9 complete outfits',
      );
      if (refinement) fullPrompt += `\n\nUser refinement: ${refinement}`;
      if (locked.length) {
        fullPrompt += `

LOCKED ITEMS (MANDATORY):
- These locked items MUST appear in every single outfit.
- Do NOT remove, swap, or omit them under any circumstance.
- Only choose additional non-locked items to complete the outfit.
${lockedLines}
`;
      }

      console.log('📝 Final prompt for outfit generation:\n', fullPrompt);

      if (process.env.DEBUG_STUDIO === 'true') {
        // Extract the style-profile section from the prompt (bounded to ~25 lines)
        const profileIdx = fullPrompt.indexOf('USER STYLE PROFILE');
        if (profileIdx >= 0) {
          const excerpt = fullPrompt
            .substring(profileIdx, profileIdx + 800)
            .split('\n')
            .slice(0, 25)
            .join('\n');
          console.log(
            '🎨 [Studio][SLOW] prompt style-profile excerpt:\n' + excerpt,
          );
        } else {
          console.log(
            '🎨 [Studio][SLOW] prompt: no USER STYLE PROFILE section found',
          );
        }
      }

      logPrompt(reqId, {
        prompt: fullPrompt,
        model: 'gemini-2.5-pro',
        catalogSize: workingCatalog.length,
      });

      // 6) LLM call and parse
      const llmStartTime = Date.now();
      const raw = await this.vertex.generateReasonedOutfit(
        fullPrompt,
        aaaaMode ? 0.4 : undefined,
      );
      const llmLatencyMs = Date.now() - llmStartTime;
      const text =
        (raw?.candidates?.[0]?.content?.parts?.[0]?.text as string) ??
        (typeof raw === 'string' ? raw : '');
      const parsed = extractStrictJson(text);

      logRawResponse(reqId, {
        responseText: text,
        model: 'gemini-2.5-pro',
        latencyMs: llmLatencyMs,
      });

      logParsed(reqId, {
        outfitCount: (parsed.outfits || []).length,
        reasoning: parsed.outfits?.[0]?.why,
      });

      // Map by index (use workingCatalog indices only)
      const byIndex = new Map<number, (typeof workingCatalog)[number]>();
      workingCatalog.forEach((c) => byIndex.set(c.index, c));
      // Do not add from 'catalog'; those indices are stale after reindexing.

      // 7) Build outfits
      let outfits = (parsed.outfits || []).map((o: any) => ({
        title: String(o.title ?? 'Outfit'),
        items: Array.isArray(o.items)
          ? (o.items
              .map((it: any) => {
                if (typeof it === 'number') return byIndex.get(it);
                if (typeof it === 'string') {
                  const n = Number(it.trim());
                  if (!Number.isNaN(n)) return byIndex.get(n);
                  return catalog.find(
                    (c) => c.label.toLowerCase() === it.toLowerCase(),
                  );
                }
                return undefined;
              })
              .filter(Boolean) as CatalogItem[])
          : [],
        why: String(o.why ?? ''),
        missing: o.missing ? String(o.missing) : undefined,
      }));

      // ⛓ Ensure locked items are always present in every outfit
      if (locked.length) {
        outfits = outfits.map((o) => {
          const ids = new Set(o.items.map((it) => it.id));
          const mustAdd = locked.filter((l) => !ids.has(l.id));
          if (mustAdd.length) {
            console.log(
              '🔒 Injecting missing locked items into outfit',
              o.title,
              mustAdd.map((i) => i.id),
            );
          }
          return { ...o, items: [...mustAdd, ...o.items] };
        });
      }

      // // inject locked items into every outfit
      // if (locked.length) {
      //   outfits = outfits.map((o) => {
      //     const ids = new Set(o.items.map((it) => it?.id));
      //     const mustAdd = locked.filter((l) => !ids.has(l.id));
      //     return { ...o, items: [...mustAdd, ...o.items] };
      //   });
      // }

      // ── Hard repair of slots (TOP/BOTTOM/SHOES + gym sneakers) ──
      const toLc = (s?: string) => (s ?? '').toLowerCase();
      const gymIntent = /\b(gym|work ?out|workout|training|exercise)\b/i.test(
        effectiveQuery,
      );

      const isBottom = (c?: CatalogItem) => {
        if (!c) return false;
        const main = toLc(c.main_category);
        const sub = toLc(c.subcategory);
        const lbl = toLc(c.label);
        return (
          main === 'bottoms' ||
          /\b(trouser|pants|jeans|chinos|shorts|joggers?|sweatpants?|track\s*pants?)\b/i.test(
            sub,
          ) ||
          /\bshorts?\b/i.test(lbl)
        );
      };
      const isShoes = (c?: CatalogItem) => {
        if (!c) return false;
        const main = toLc(c.main_category);
        const sub = toLc(c.subcategory);
        return (
          main === 'shoes' ||
          /\b(sneakers?|trainers?|running|athletic|loafers?|boots?|oxfords?|derbys?|dress\s*shoes?|sandals?)\b/i.test(
            sub,
          )
        );
      };
      const isTop = (c?: CatalogItem) => {
        if (!c) return false;
        const main = toLc(c.main_category);
        const sub = toLc(c.subcategory);
        return (
          main === 'tops' ||
          /\b(t-?shirt|tee|polo|shirt|sweater|knit|henley|hoodie)\b/i.test(sub)
        );
      };
      const orderRank = (c: CatalogItem) =>
        isTop(c) ? 1 : isBottom(c) ? 2 : isShoes(c) ? 3 : 4;

      // Phase 3: legacy-path environment fitness check for repair lookups.
      // Pure, local. Does not mutate; respects __locked / forceKeep.
      const envFitsItem = (it: any, e: EnvContext): boolean => {
        if (!it) return false;
        if (it.__locked || it.forceKeep) return true;
        if (
          e.climate !== 'hot' &&
          e.climate !== 'cold' &&
          e.climate !== 'extreme'
        ) {
          return true;
        }
        const main = String(it.main_category ?? '').toLowerCase();
        const sub = String(it.subcategory ?? '').toLowerCase();
        const lbl = String(it.label ?? '').toLowerCase();
        const blob = `${main} ${sub} ${lbl}`;
        if (e.climate === 'hot') {
          const COLD_OUTERWEAR =
            /\b(parka|puffer|down\s+jacket|peacoat|pea\s+coat|overcoat|topcoat|trench(?:\s+coat)?|wool\s+coat|fur\s+coat|sherpa|fleece|heavy\s+coat|winter\s+coat|ski\s+jacket)\b/i;
          const HEAVY_ITEMS =
            /\b(turtleneck|cable\s*knit|chunky\s*knit|heavy\s*sweater|wool\s*sweater|thermal|long\s*johns|corduroy|tweed|flannel|wool\s*pants|wool\s*trousers)\b/i;
          return !COLD_OUTERWEAR.test(blob) && !HEAVY_ITEMS.test(blob);
        }
        const SHORTS = /\bshorts?\b/i;
        const SANDALS = /\b(sandals?|flip[\s-]?flops?|slides?|espadrilles?)\b/i;
        return !SHORTS.test(blob) && !SANDALS.test(blob);
      };

      const firstBottom =
        reranked.find((it) => isBottom(it) && envFitsItem(it, env)) ??
        reranked.find(isBottom);
      const firstShoes =
        reranked.find((it) => isShoes(it) && envFitsItem(it, env)) ??
        reranked.find(isShoes);
      const firstSneaker = reranked.find(isSneaker);
      const firstShorts = reranked.find(isShorts);
      const firstTop =
        reranked.find((it) => isTop(it) && envFitsItem(it, env)) ??
        reranked.find(isTop);

      outfits = outfits.map((o) => {
        const haveBottom = o.items.some(isBottom);
        const haveShoes = o.items.some(isShoes);
        const haveSneaker = o.items.some(isSneaker);
        const haveShorts = o.items.some(isShorts);
        const already = new Set(o.items.map((x) => x?.id));

        // Gym / refinement: sneakers required if asked
        if (
          (gymIntent || needSneakers) &&
          !haveSneaker &&
          firstSneaker &&
          !already.has(firstSneaker.id)
        ) {
          o.items.push(firstSneaker);
          o.missing = o.missing || 'auto-added sneakers';
          already.add(firstSneaker.id);
        }

        // Refinement: prefer shorts if asked
        if (
          needShorts &&
          !haveShorts &&
          firstShorts &&
          !already.has(firstShorts.id)
        ) {
          o.items.push(firstShorts);
          o.missing = o.missing || 'auto-added shorts';
          already.add(firstShorts.id);
        }

        // Always ensure a bottom exists
        if (!haveBottom && firstBottom && !already.has(firstBottom.id)) {
          o.items.push(firstBottom);
          o.missing = o.missing || 'auto-added bottom';
          already.add(firstBottom.id);
        }

        // Always ensure some shoes exist
        if (!haveShoes && firstShoes && !already.has(firstShoes.id)) {
          o.items.push(firstShoes);
          o.missing = o.missing || 'auto-added shoes';
          already.add(firstShoes.id);
        }

        // Ensure at least one top
        if (!o.items.some(isTop) && firstTop && !already.has(firstTop.id)) {
          o.items.unshift(firstTop);
          o.missing = o.missing || 'auto-added top';
          already.add(firstTop.id);
        }

        o.items = [...o.items].sort((a, b) => orderRank(a) - orderRank(b));
        return o;
      });

      // ── Masculine post-assembly filter (Layer C: defense-in-depth) ──
      if (userPresentation === 'masculine') {
        for (const o of outfits) {
          const preLen = o.items.length;
          o.items = o.items.filter(
            (it: any) =>
              !isFeminineItem(
                it.main_category || '',
                it.subcategory || '',
                it.name || it.label || '',
              ),
          );
          if (o.items.length < preLen) {
            console.log(
              `🎯 [STD] Masculine post-filter: ${preLen} → ${o.items.length} items in "${o.title}"`,
            );
          }
        }
      }

      // finalize + enforce + retitle
      outfits = outfits.map((o) =>
        finalizeOutfitSlots(o, reranked, effectiveQuery),
      );
      outfits = enforceConstraintsOnOutfits(
        outfits,
        reranked as any,
        effectiveQuery,
      ) as any;

      // Hard validation gate — discard structurally invalid outfits
      outfits = validateOutfitCore(outfits, effectiveQuery);
      if (outfits.length === 0) {
        outfits = validateOutfits(effectiveQuery, reranked, []);
      }

      // Pad to 3 outfits from catalog if wardrobe has enough items
      if (outfits.length < 3) {
        const stdPool = reranked.map((c) => ({
          id: c.id,
          name: c.label,
          main_category: c.main_category,
          subcategory: c.subcategory,
          color: c.color,
          image_url: c.image_url,
        }));
        outfits = padToThreeOutfits(outfits, stdPool, (items) => ({
          title: 'More from your wardrobe',
          items: items
            .map((r) => reranked.find((c) => c.id === r.id)!)
            .filter(Boolean),
          why: 'Additional outfit built from your best-ranked items.',
          missing: undefined,
        }));
      }

      outfits = outfits.map((o) => {
        const { title, why } = this.retitleOutfit(o);
        return { ...o, title, why };
      });

      // Minimal personalization via per-item prefs
      const withIds = outfits.map((o) => ({ ...o, outfit_id: randomUUID() }));
      const ids = Array.from(
        new Set(
          withIds.flatMap((o) =>
            o.items.map((it: any) => it?.id).filter(Boolean),
          ),
        ),
      );

      await pool.query(
        `CREATE TABLE IF NOT EXISTS user_pref_item(
         user_id TEXT NOT NULL,
         item_id TEXT NOT NULL,
         score REAL NOT NULL DEFAULT 0,
         updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         PRIMARY KEY (user_id, item_id)
       );`,
      );

      const prefRows =
        ids.length > 0
          ? await pool.query(
              'SELECT item_id, score FROM user_pref_item WHERE user_id = $1 AND item_id = ANY($2)',
              [userId, ids],
            )
          : { rows: [] as any[] };

      const pref = new Map<string, number>(
        prefRows.rows.map((r: any) => [String(r.item_id), Number(r.score)]),
      );

      const ranked = withIds
        .map((o) => {
          const items = o.items as any[];
          const boost =
            items.length === 0
              ? 0
              : items.reduce((a, it) => a + (pref.get(it?.id) ?? 0), 0) /
                items.length;
          return { o, boost };
        })
        .sort((a, b) => b.boost - a.boost);

      const best = ranked[0]?.o ??
        withIds[0] ?? {
          items: [],
          why: '',
          missing: undefined,
          outfit_id: 'o1',
        };

      logOutput(reqId, {
        outfits: withIds.map((o) => ({
          id: o.outfit_id,
          title: o.title,
          itemCategories: o.items.map((it: any) => it?.main_category),
        })),
        totalLatencyMs: Date.now() - stdStartTime,
        itemCounts: withIds.map((o) => o.items.length),
      });

      const request_id = reqId;

      if (process.env.NODE_ENV !== 'production') {
        console.dir(
          {
            level: 'OUTFIT_RESULT',
            request_id,
            user_id: userId,
            query: effectiveQuery, // ← log the combined query
            best_outfit: {
              outfit_id: best.outfit_id,
              title: best.title,
              why: best.why,
              missing: best.missing,
              items: best.items.map((it: any) => ({
                id: it?.id,
                label: it?.label,
                image_url: it?.image_url,
                main_category: it?.main_category,
                subcategory: it?.subcategory,
                brand: it?.brand,
                color: it?.color,
                dress_code: it?.dress_code,
                formality_score: it?.formality_score,
              })),
            },
            all_outfits: withIds.map((o) => ({
              outfit_id: o.outfit_id,
              title: o.title,
              why: o.why,
              missing: o.missing,
              items: o.items.map((it) => ({
                id: it?.id,
                label: it?.label,
                image_url: it?.image_url,
                main_category: it?.main_category,
                subcategory: it?.subcategory,
                brand: it?.brand,
                color: it?.color,
                dress_code: it?.dress_code,
                formality_score: it?.formality_score,
              })),
            })),
          },
          { depth: null },
        );
      }

      // ── Elite Scoring: load context (non-blocking, used by taste validator + rerank) ──
      const eliteStyleContext = await this.loadEliteStyleContext(userId);

      // ── Taste Validation + Deterministic Repair (slow path) ──
      let _validatorRanSlow = false;
      let _numHardFailedSlow = 0;
      let _numRepairedViaSwapSlow = 0;
      let vCtx: ValidatorContext;
      {
        const _isOpenFoot = (it: any): boolean => {
          const text =
            `${it?.subcategory ?? ''} ${it?.name ?? it?.label ?? ''}`.toLowerCase();
          return /\b(sandals?|flip[- ]?flops?|slides?|thongs?)\b/.test(text);
        };
        const _toVI = (it: any): ValidatorItem => ({
          id: it?.id ?? '',
          slot:
            (mapMainCategoryToSlot(it?.main_category) as ValidatorSlot) ||
            ('accessories' as ValidatorSlot),
          name: it?.name ?? it?.label,
          subcategory: it?.subcategory,
          color: it?.color,
          material: it?.material,
          fit: it?.fit ?? it?.fit_type,
          dress_code: it?.dress_code,
          formality_score: it?.formality_score,
          style_descriptors: it?.style_descriptors,
          presentation_code: it?.presentation_code,
        });
        const _tempToZone = (tempF?: number | null) => {
          if (tempF == null) return undefined;
          if (tempF < 32) return 'freezing' as const;
          if (tempF < 45) return 'cold' as const;
          if (tempF < 55) return 'cool' as const;
          if (tempF < 65) return 'mild' as const;
          if (tempF < 85) return 'warm' as const;
          return 'hot' as const;
        };
        const _bp = (eliteStyleContext as any)?._brainStyleProfile;
        const _requestedDressCodeSlow: string | undefined = (() => {
          if (!query) return undefined;
          const c = query.toLowerCase();
          if (c.includes('formal') || c.includes('business')) return 'formal';
          if (c.includes('church') || c.includes('wedding') || c.includes('funeral') || c.includes('interview')) return 'formal';
          return undefined;
        })();
        vCtx = {
          userPresentation:
            userPresentation === 'masculine' || userPresentation === 'feminine'
              ? userPresentation
              : undefined,
          climateZone: _tempToZone(opts?.weather?.tempF),
          requestedDressCode: _requestedDressCodeSlow,
          styleProfile: {
            ...(eliteStyleContext?.styleProfile ?? {}),
            coverage_no_go: _bp?.coverage_no_go,
            avoid_colors: _bp?.avoid_colors,
            avoid_materials: _bp?.avoid_materials,
            formality_floor: _bp?.formality_floor,
            walkability_requirement: _bp?.walkability_requirement,
            avoid_patterns: _bp?.avoid_patterns,
            silhouette_preference: _bp?.silhouette_preference,
          },
        };
        // Build slot pools from reranked catalog
        const slotPools = new Map<string, any[]>();
        for (const item of reranked) {
          const slot = mapMainCategoryToSlot(item?.main_category);
          if (!slotPools.has(slot)) slotPools.set(slot, []);
          slotPools.get(slot)!.push(item);
        }

        const repaired: typeof withIds = [];
        for (const outfit of withIds) {
          const items = outfit.items ?? [];
          const vItems = items.map(_toVI);
          const result = tasteValidateOutfit(vItems, vCtx);
          if (result.valid) {
            repaired.push(outfit);
            continue;
          }
          // Attempt deterministic repair
          let fixedItems = [...items];
          const usedIds = new Set(fixedItems.map((it: any) => it?.id));
          for (const fail of result.hardFails) {
            if (
              fail.startsWith('EXTREME_WEATHER_CONTRADICTION') &&
              fail.includes('footwear')
            ) {
              const shoePool = (slotPools.get('shoes') ?? []).filter(
                (s: any) => !_isOpenFoot(s) && !usedIds.has(s?.id),
              );
              if (shoePool.length > 0) {
                fixedItems = fixedItems.filter(
                  (it: any) =>
                    mapMainCategoryToSlot(it?.main_category) !== 'shoes',
                );
                fixedItems.push(shoePool[0]);
                usedIds.add(shoePool[0].id);
              }
            } else if (fail.startsWith('CROSS_PRESENTATION')) {
              const idMatch = fail.match(/item (\S+)/);
              if (idMatch) {
                const badItem = fixedItems.find(
                  (it: any) => it?.id === idMatch[1],
                );
                if (badItem) {
                  const slot = mapMainCategoryToSlot(badItem?.main_category);
                  const pool = (slotPools.get(slot) ?? []).filter((c: any) => {
                    if (usedIds.has(c?.id)) return false;
                    const pc = c?.presentation_code;
                    if (!pc) return true;
                    if (vCtx.userPresentation === 'masculine')
                      return pc !== 'feminine';
                    if (vCtx.userPresentation === 'feminine')
                      return pc !== 'masculine';
                    return true;
                  });
                  if (pool.length > 0) {
                    fixedItems = fixedItems.filter(
                      (it: any) => it?.id !== idMatch[1],
                    );
                    fixedItems.push(pool[0]);
                    usedIds.add(pool[0].id);
                  }
                }
              }
            } else if (fail.startsWith('DRESS_CODE_MISMATCH')) {
              const idMatch = fail.match(/item (\S+)/);
              if (idMatch) {
                const badItem = fixedItems.find(
                  (it: any) => it?.id === idMatch[1],
                );
                if (badItem) {
                  const slot = mapMainCategoryToSlot(badItem?.main_category);
                  const casualCodes = [
                    'ultracasual',
                    'ultra casual',
                    'athletic',
                  ];
                  const pool = (slotPools.get(slot) ?? []).filter((c: any) => {
                    if (usedIds.has(c?.id)) return false;
                    const dc = (c?.dress_code ?? '').toLowerCase();
                    if (!dc) return true;
                    return !casualCodes.some((cc) => dc.includes(cc));
                  });
                  if (pool.length > 0) {
                    fixedItems = fixedItems.filter(
                      (it: any) => it?.id !== idMatch[1],
                    );
                    fixedItems.push(pool[0]);
                    usedIds.add(pool[0].id);
                  }
                }
              }
            } else if (fail.startsWith('AVOID_COLOR')) {
              const idMatch = fail.match(/item (\S+)/);
              if (idMatch) {
                const badItem = fixedItems.find(
                  (it: any) => it?.id === idMatch[1],
                );
                if (badItem) {
                  const slot = mapMainCategoryToSlot(badItem?.main_category);
                  const _avoidExp = expandAvoidColors(
                    vCtx?.styleProfile?.avoid_colors ?? [],
                  );
                  const pool = (slotPools.get(slot) ?? []).filter((c: any) => {
                    if (usedIds.has(c?.id)) return false;
                    const cColors = extractItemColors(c as any);
                    if (c.color_family) cColors.push(c.color_family.trim().toLowerCase());
                    if (c.name ?? c.label) cColors.push((c.name ?? c.label).trim().toLowerCase());
                    for (const ic of cColors) {
                      for (const ac of _avoidExp) {
                        if (colorMatchesSafe(ic, ac)) return false;
                      }
                    }
                    return true;
                  });
                  if (pool.length > 0) {
                    fixedItems = fixedItems.filter(
                      (it: any) => it?.id !== idMatch[1],
                    );
                    fixedItems.push(pool[0]);
                    usedIds.add(pool[0].id);
                  }
                }
              }
            } else if (fail.startsWith('MISSING_REQUIRED_SLOTS')) {
              const slots = new Set(
                fixedItems.map((it: any) =>
                  mapMainCategoryToSlot(it?.main_category),
                ),
              );
              const hasDressLike =
                slots.has('dresses') ||
                slots.has('activewear') ||
                slots.has('swimwear');
              if (!hasDressLike) {
                for (const ms of ['tops', 'bottoms', 'shoes'] as const) {
                  if (!slots.has(ms)) {
                    const pool = (slotPools.get(ms) ?? []).filter(
                      (c: any) => !usedIds.has(c?.id),
                    );
                    if (pool.length > 0) {
                      fixedItems.push(pool[0]);
                      usedIds.add(pool[0].id);
                    }
                  }
                }
              } else if (!slots.has('shoes') && !slots.has('swimwear')) {
                const pool = (slotPools.get('shoes') ?? []).filter(
                  (c: any) => !usedIds.has(c?.id),
                );
                if (pool.length > 0) {
                  fixedItems.push(pool[0]);
                  usedIds.add(pool[0].id);
                }
              }
            }
          }
          const recheck = tasteValidateOutfit(fixedItems.map(_toVI), vCtx);
          repaired.push(
            recheck.valid ? { ...outfit, items: fixedItems } : outfit,
          );
        }
        // Sort: valid first, take 3
        const scored = repaired.map((o: any, idx: number) => {
          const r = tasteValidateOutfit((o.items ?? []).map(_toVI), vCtx);
          const wasRepaired =
            !tasteValidateOutfit((withIds[idx]?.items ?? []).map(_toVI), vCtx)
              .valid && r.valid;
          return { o, valid: r.valid, cs: r.coherenceScore, wasRepaired };
        });
        scored.sort((a: any, b: any) =>
          a.valid === b.valid ? b.cs - a.cs : a.valid ? -1 : 1,
        );
        const tasteFiltered = scored.filter((s: any) => s.valid).map((s: any) => s.o);
        withIds.length = 0;
        withIds.push(...tasteFiltered);
        _validatorRanSlow = true;
        _numHardFailedSlow = scored.filter((s: any) => !s.valid).length;
        _numRepairedViaSwapSlow = scored.filter(
          (s: any) => s.wasRepaired,
        ).length;
      }

      // Elite Scoring hook — Phase 2: rerank when V2 flag on
      // ONE-FLAG: ELITE_ENABLED in feature-flags.ts:42 force-enables STUDIO + STUDIO_V2
      const demoElite = isEliteDemoUser(userId);
      const _usedV2Slow = ELITE_FLAGS.STUDIO_V2 || demoElite;
      const _shadowOnlySlow =
        demoElite &&
        LEARNING_FLAGS.SHADOW_MODE &&
        !ELITE_FLAGS.STUDIO &&
        !ELITE_FLAGS.STUDIO_V2;
      let _eliteRerankRanSlow = false;
      let eliteOutfits = withIds;
      if (ELITE_FLAGS.STUDIO || ELITE_FLAGS.STUDIO_V2 || demoElite) {
        const canonical = withIds.map(normalizeStudioOutfit);
        const result = elitePostProcessOutfits(canonical, eliteStyleContext, {
          mode: 'studio',
          requestId: request_id,
          rerank: _usedV2Slow,
          debug: true,
        });
        if (_shadowOnlySlow) {
          const eliteIds = (result.outfits as any[]).map((o) => o.id);
          const baseIds = canonical.map((o) => o.id);
          console.log(
            JSON.stringify({
              _tag: 'ELITE_SHADOW_COMPARE',
              mode: 'standard',
              baseOrder: baseIds,
              eliteOrder: eliteIds,
              orderChanged:
                JSON.stringify(baseIds) !== JSON.stringify(eliteIds),
              scores: result.debug?.scores,
            }),
          );
          // Shadow: keep original order
        } else {
          eliteOutfits = result.outfits.map(denormalizeStudioOutfit);
          _eliteRerankRanSlow = _usedV2Slow;
          // Safety: fall back if count unexpectedly reduced
          if (eliteOutfits.length < withIds.length) {
            console.log(
              JSON.stringify({
                _tag: 'ELITE_RERANK_FALLBACK',
                mode: 'standard',
                preCount: withIds.length,
                postCount: eliteOutfits.length,
              }),
            );
            eliteOutfits = withIds;
          }
        }
      }
      // Activation status (allowlist users only — no noise for general traffic)
      if (demoElite) {
        console.log(
          JSON.stringify({
            _tag: 'ELITE_ACTIVATION_STATUS',
            mode: 'standard',
            shadowMode: _shadowOnlySlow,
            demoElite: true,
            stateLoaded: !!eliteStyleContext?.fashionState,
            signalCount: eliteStyleContext?.fashionState
              ? Object.keys(eliteStyleContext.fashionState).length
              : 0,
          }),
        );
      }
      // ── Elite Scoring: log exposure event (fire-and-forget) ──
      // NOT gated by ELITE_FLAGS — gated by LEARNING_FLAGS + consent + circuit breaker
      {
        const canonicalForEvent = eliteOutfits.map(normalizeStudioOutfit);
        const exposureEvent = buildEliteExposureEvent(
          userId,
          canonicalForEvent,
          {
            mode: 'studio',
            requestId: request_id,
            weather: opts?.weather ? { temp: opts.weather.tempF } : undefined,
          },
        );
        this.learningEventsService.logEvent(exposureEvent).catch(() => {});
      }

      // ── Avoided-color return guard (mirrors suggestVisualOutfits) ──
      const _avoid = vCtx?.styleProfile?.avoid_colors ?? [];
      if (_avoid.length > 0) {
        const _expandedSlow = expandAvoidColors(_avoid);
        const _hasAvoided = (outfit: any): boolean => {
          for (const it of outfit.items ?? []) {
            for (const ic of extractItemColors(it as any)) {
              for (const ac of _expandedSlow) {
                if (colorMatchesSafe(ic, ac)) return true;
              }
            }
          }
          return false;
        };
        eliteOutfits = eliteOutfits.filter((o: any) => !_hasAvoided(o));
      }

      // ── Style Veto: remove structurally incoherent outfits ──
      {
        const _vetoCtx = { query };
        const _beforeVetoSlow = eliteOutfits.length;
        const _coherentSlow = eliteOutfits.filter((o: any) => {
          const v = isStylisticallyIncoherent(o, _vetoCtx);
          if (v.invalid) {
            // console.log(
            //   JSON.stringify({
            //     _tag: 'STYLIST_VETO_REJECTED',
            //     mode: 'standard',
            //     reason: v.reason,
            //     outfitSummary: (o.items ?? []).map((it: any) =>
            //       `${it.name ?? it.label ?? '?'} (${it.subcategory ?? it.main_category ?? '?'})`
            //     ),
            //   }),
            // );
          }
          return !v.invalid;
        });
        if (_coherentSlow.length < _beforeVetoSlow && _coherentSlow.length < 3) {
          // console.log(
          //   JSON.stringify({
          //     _tag: 'STYLIST_VETO_INSUFFICIENT',
          //     mode: 'standard',
          //     remainingCount: _coherentSlow.length,
          //   }),
          // );
        }
        eliteOutfits = _coherentSlow.length >= 3 ? _coherentSlow : eliteOutfits;
      }

      // ── Style Judge: curate best outfits by holistic taste scoring ──
      const _judgeCtxSlow = {
        requestedDressCode: vCtx?.requestedDressCode,
        query,
      };
      const _candidateCountSlow = eliteOutfits.length;
      eliteOutfits = selectTopOutfits(eliteOutfits, _judgeCtxSlow);
      // console.log(
      //   JSON.stringify({
      //     _tag: 'STUDIO_FINAL_CURATION_PROOF',
      //     mode: 'standard',
      //     candidateCount: _candidateCountSlow,
      //     returnedCount: eliteOutfits.length,
      //     topScores: eliteOutfits.map((o: any) =>
      //       scoreOutfit(o, _judgeCtxSlow).total,
      //     ),
      //   }),
      // );

      return {
        request_id,
        outfit_id: best.outfit_id,
        items: best.items,
        why: best.why,
        missing: best.missing,
        outfits: eliteOutfits,
      };
    } catch (err: any) {
      console.error('❌ Error in generateOutfits:', err.message, err.stack);
      throw err;
    }
  }

  /**
   * FAST OUTFIT GENERATOR (New Architecture)
   *
   * Flow:
   * 1. Gemini Flash generates outfit PLAN (no catalog, text-only) ~0.5-1s
   * 2. Backend embeds each slot description using Vertex embeddings ~0.3-0.5s (parallel)
   * 3. Backend queries Pinecone for matching items ~0.2-0.3s (parallel)
   * 4. Backend fetches image URLs from PostgreSQL ~0.1s
   * 5. Return assembled outfits to UI
   *
   * Total latency: ~1-2s (vs 20-30s with old architecture)
   * Cost reduction: ~90% (no catalog in prompt)
   */
  async generateOutfitsFast(
    userId: string,
    query: string,
    opts?: {
      userStyle?: UserStyle;
      weather?: WeatherContext;
      styleAgent?: string;
      lockedItemIds?: string[];
      requestId?: string;
    },
  ) {
    const startTime = Date.now();
    const reqId = opts?.requestId || randomUUID();
    console.log('🔥 FAST PATH EXECUTED');
    // console.log('⚡ [FAST] Starting generateOutfitsFast for user:', userId);
    // console.log('⚡ [FAST] Full query:', query);

    try {
      const { weather, lockedItemIds = [] } = opts || {};

      logInput(reqId, {
        userId,
        query,
        mode: 'fast',
        weather,
        userStyle: opts?.userStyle,
        lockedItemIds,
        styleAgent: opts?.styleAgent,
        isRefinement: query.toLowerCase().includes('refinement'),
        isStartWithItem:
          lockedItemIds.length > 0 &&
          !query.toLowerCase().includes('refinement'),
      });

      // ── Gender/presentation query (mirrors ai.service.ts) ──────
      let userPresentation: 'masculine' | 'feminine' | 'mixed' = 'mixed';
      try {
        const { rows: genderRows } = await pool.query(
          'SELECT gender_presentation FROM users WHERE id = $1 LIMIT 1',
          [userId],
        );
        userPresentation = resolveUserPresentation(
          genderRows[0]?.gender_presentation || '',
        );
      } catch {
        // Fail open — default to 'mixed' (no filtering)
      }

      // ── 0) Fetch available item types from user's wardrobe ──
      const { rows: categoryRows } = await pool.query(
        `SELECT DISTINCT main_category, subcategory
         FROM wardrobe_items
         WHERE user_id = $1 AND main_category IS NOT NULL`,
        [userId],
      );

      // ── Masculine presentation filter (Layer 1: pre-pool) ──────
      const filteredCategoryRows =
        userPresentation === 'masculine'
          ? (categoryRows as any[]).filter(
              (r: any) =>
                !isFeminineItem(r.main_category || '', r.subcategory || '', ''),
            )
          : categoryRows;

      const availableItems = (filteredCategoryRows as any[]).map(
        (r: any) => `${r.main_category}: ${r.subcategory || 'general'}`,
      );
      if (userPresentation === 'masculine') {
        // console.log(
        //   `⚡ [FAST] Masculine filter: ${(categoryRows as any[]).length} → ${filteredCategoryRows.length} category types`,
        // );
      }
      // console.log('⚡ [FAST] Available item types:', availableItems.join(', '));

      // ── 0–P3) Studio Context — inverse contextual enforcement signals ──
      const _q = query.toLowerCase();
      const _studioContext = {
        formality: /\b(formal|business|interview|wedding|gala|black.?tie)\b/.test(_q) ? 9
          : /\b(smart.?casual|business.?casual|dinner|date|upscale)\b/.test(_q) ? 7
          : /\b(casual|everyday|relaxed|weekend|brunch)\b/.test(_q) ? 4
          : /\b(gym|workout|athletic|exercise|training)\b/.test(_q) ? 2
          : /\b(lounge|home|sleep|pajama)\b/.test(_q) ? 1 : 5,
        isOutdoor: /\b(beach|pool|park|hike|hiking|camping|outdoor|picnic|lake|garden|trail|barbecue|festival|resort|patio|rooftop)\b/i.test(_q),
        activityLevel: (
          /\b(hike|hiking|run|running|gym|workout|cycling|climbing|sports?|training|dance|dancing)\b/i.test(_q) ? 'active'
          : /\b(walk|walking|shopping|sightseeing|travel|stroll|explore|touring)\b/i.test(_q) ? 'moderate'
          : 'sedentary'
        ) as 'active' | 'moderate' | 'sedentary',
        tempBand: (
          weather?.tempF != null
            ? (weather.tempF > 85 ? 'hot' : weather.tempF > 72 ? 'warm' : weather.tempF > 58 ? 'mild' : weather.tempF > 40 ? 'cool' : 'cold')
            : /\b(hot|scorching|sweltering)\b/i.test(_q) ? 'hot'
            : /\b(sunny|warm|tropical|humid)\b/i.test(_q) ? 'warm'
            : /\b(cold|freezing|chilly)\b/i.test(_q) ? 'cold'
            : null
        ) as 'hot' | 'warm' | 'mild' | 'cool' | 'cold' | null,
        season: (
          /\b(winter|cold|freezing|snow)\b/.test(_q) ? 'winter'
          : /\b(summer|hot|warm|beach)\b/.test(_q) ? 'summer'
          : /\b(spring|mild)\b/.test(_q) ? 'spring'
          : /\b(fall|autumn|cool)\b/.test(_q) ? 'fall'
          : weather?.tempF != null
            ? (weather.tempF < 40 ? 'winter' : weather.tempF < 60 ? 'fall' : weather.tempF < 75 ? 'spring' : 'summer')
            : null
        ) as 'summer' | 'spring' | 'fall' | 'winter' | null,
      };

      logContext(reqId, { ..._studioContext, sourceQuery: query });

      const HEAVY_FABRIC = /\b(wool|cashmere|fleece|corduroy|tweed|shearling|fur|sherpa|flannel)\b/i;
      const HIGH_COVERAGE = /\b(parka|puffer|peacoat|trench|overcoat|wool\s*coat|down\s*jacket|heavy\s*jacket|turtleneck|mock\s*neck|thermal)\b/i;
      const STRUCTURED = /\b(blazer|suit\s*jacket|sport\s*coat|tuxedo|pencil\s*skirt|dress\s*pant|formal\s*dress|evening\s*gown)\b/i;
      const OPEN_FOOTWEAR = /\b(sandal|flip[- ]?flop|slide|espadrille|open[- ]?toe)\b/i;

      const _contextAppropriate = (item: any): { appropriate: boolean; reason?: string } => {
        const mat = (item.material ?? '').toLowerCase();
        const sub = (item.subcategory ?? '').toLowerCase();
        const name = (item.name ?? '').toLowerCase();
        const itemText = `${sub} ${name}`;
        const slot = mapMainCategoryToSlot(item.main_category);

        // Fail-open: if no context signals, approve everything
        if (!_studioContext.tempBand && !_studioContext.isOutdoor && _studioContext.activityLevel === 'sedentary') {
          return { appropriate: true };
        }

        // Signal 1: heavy fabric in hot/warm temps
        if ((_studioContext.tempBand === 'hot' || _studioContext.tempBand === 'warm') && HEAVY_FABRIC.test(mat)) {
          if (!OPEN_FOOTWEAR.test(itemText)) {
            return { appropriate: false, reason: `HEAVY_FABRIC_IN_HEAT: "${mat}" in tempBand=${_studioContext.tempBand}` };
          }
        }

        // Signal 2: high-coverage outerwear in outdoor heat
        if (_studioContext.isOutdoor && (_studioContext.tempBand === 'hot' || _studioContext.tempBand === 'warm')) {
          if (slot === 'outerwear' && HIGH_COVERAGE.test(itemText)) {
            return { appropriate: false, reason: `HIGH_COVERAGE_OUTDOOR_HEAT: "${itemText.trim()}" outdoor+${_studioContext.tempBand}` };
          }
        }

        // Signal 3: structured items in active/moderate-outdoor contexts (unless high formality)
        if (_studioContext.formality < 7 && STRUCTURED.test(itemText)) {
          if (_studioContext.activityLevel === 'active') {
            return { appropriate: false, reason: `STRUCTURED_IN_ACTIVE: "${itemText.trim()}" activity=${_studioContext.activityLevel}` };
          }
          if (_studioContext.activityLevel === 'moderate' && _studioContext.isOutdoor) {
            return { appropriate: false, reason: `STRUCTURED_IN_OUTDOOR_MODERATE: "${itemText.trim()}" outdoor+moderate` };
          }
        }

        // Signal 4: formality ceiling — extreme formal items in very casual contexts
        if (_studioContext.formality <= 3 && typeof item.formality_score === 'number' && item.formality_score >= 8) {
          return { appropriate: false, reason: `FORMALITY_CEILING: item_formality=${item.formality_score} context_formality=${_studioContext.formality}` };
        }

        return { appropriate: true };
      };

      // ── 0a) Inventory-Aware Color Shaping ─────────────────────────
      // Extract color intent from query and build a per-slot color map
      // so the LLM prompt can be constrained to colors actually in the wardrobe.
      const _colorIntent = extractColorIntent(query);
      let _availableColorsBySlot: Record<string, string[]> = {};
      let _colorAnchorSlot: string | undefined;

      if (_colorIntent.length > 0) {
        const { rows: colorRows } = await pool.query(
          `SELECT main_category, color, color_family FROM wardrobe_items
           WHERE user_id = $1 AND main_category IS NOT NULL`,
          [userId],
        );
        // Build slot → unique colors map
        const slotColorMap = new Map<string, Set<string>>();
        for (const r of colorRows as any[]) {
          const slot = mapMainCategoryToSlot(r.main_category);
          if (!slot) continue;
          if (!slotColorMap.has(slot)) slotColorMap.set(slot, new Set());
          const colorTokens = [r.color, r.color_family]
            .filter(Boolean)
            .map((c: string) => c.trim().toLowerCase());
          for (const ct of colorTokens) slotColorMap.get(slot)!.add(ct);
        }
        _availableColorsBySlot = Object.fromEntries(
          [...slotColorMap.entries()].map(([s, cs]) => [s, [...cs]]),
        );

        // Determine primary anchor slot — prefer bottoms for charcoal/gray tones
        const grayTones = new Set(['charcoal', 'gray', 'grey', 'slate', 'graphite']);
        const intentIsGray = _colorIntent.some((t) => grayTones.has(t));
        const slotPreference = intentIsGray
          ? ['bottoms', 'outerwear', 'tops', 'shoes', 'accessories']
          : ['outerwear', 'bottoms', 'tops', 'shoes', 'accessories'];

        for (const slot of slotPreference) {
          const colors = _availableColorsBySlot[slot] ?? [];
          const hasMatch = colors.some((c) =>
            _colorIntent.some((intent) => colorMatchesSafe(c, intent)),
          );
          if (hasMatch) {
            _colorAnchorSlot = slot;
            break;
          }
        }
        // console.log(
        //   `⚡ [FAST] Color intent: [${_colorIntent.join(', ')}] anchor_slot=${_colorAnchorSlot ?? 'none'} colors_by_slot=${JSON.stringify(_availableColorsBySlot)}`,
        // );
      }

      // ── 0b) For refinements, determine which SLOTS to keep vs change ──
      // CRITICAL: LLM NEVER receives item names, only slot-level actions
      // Parse user's refinement prompt to detect EXPLICIT change requests
      const isRefinement = query.toLowerCase().includes('refinement');
      let refinementAction:
        | { keep_slots: string[]; change_slots: string[] }
        | undefined;
      const lockedItemsByCategory = new Map<string, string>(); // category -> itemId

      if (isRefinement && lockedItemIds.length > 0) {
        // Fetch locked items to determine their categories ONLY (not to pass names to LLM)
        const { rows: lockedRows } = await pool.query(
          `SELECT id, main_category
           FROM wardrobe_items
           WHERE id = ANY($1) AND user_id = $2`,
          [lockedItemIds, userId],
        );

        // Build category -> itemId map for ALL locked items
        const lockedCategories: string[] = [];
        for (const row of lockedRows as any[]) {
          const cat = row.main_category;
          if (cat) {
            lockedCategories.push(cat);
            lockedItemsByCategory.set(cat.toLowerCase(), row.id);
          }
        }

        // Parse refinement prompt to detect which categories user wants to CHANGE
        // CRITICAL: Only parse the REFINEMENT portion, not the original query
        // Extract just the user's refinement text from within quotes
        const refinementMatch = query.match(
          /IMPORTANT REFINEMENT:.*?"([^"]+)"/i,
        );
        const refinementText = refinementMatch
          ? refinementMatch[1].toLowerCase()
          : '';

        // console.log('⚡ [FAST] Parsing refinement text only:', refinementText);

        // Use canonical REFINEMENT_CATEGORY_KEYWORDS from categoryMapping
        const categoryKeywords = REFINEMENT_CATEGORY_KEYWORDS;

        // Detect categories mentioned with explicit "change" intent
        // More precise patterns - require change verb directly before category
        const changeIntentPatterns = [
          /(?:change|different|switch|swap|new|another)\s+(?:the\s+)?(\w+)/gi,
          /(?:give\s+me|want|need)\s+(?:a\s+|some\s+)?(?:different\s+)?(?:\w+\s+)?(\w+)/gi,
        ];

        const explicitlyChangeCategories: string[] = [];

        // Only parse if we have refinement text (not the original query!)
        if (refinementText) {
          for (const pattern of changeIntentPatterns) {
            let match;
            while ((match = pattern.exec(refinementText)) !== null) {
              const word = match[1]?.toLowerCase()?.trim();
              if (!word) continue;

              // Find which category this word belongs to
              for (const [cat, keywords] of Object.entries(categoryKeywords)) {
                if (
                  keywords.some((kw) => word.includes(kw) || kw.includes(word))
                ) {
                  const normalizedCat =
                    cat.charAt(0).toUpperCase() + cat.slice(1);
                  if (!explicitlyChangeCategories.includes(normalizedCat)) {
                    explicitlyChangeCategories.push(normalizedCat);
                  }
                }
              }
            }
          }
        }

        // console.log(
        //   '⚡ [FAST] Refinement - detected explicit change intent for:',
        //   explicitlyChangeCategories,
        // );

        // Keep slots = locked categories MINUS explicitly changed ones
        const keepCategories = lockedCategories.filter(
          (c) =>
            !explicitlyChangeCategories
              .map((e) => e.toLowerCase())
              .includes(c.toLowerCase()),
        );

        // Remove explicitly changed categories from lockedItemsByCategory
        for (const changeCat of explicitlyChangeCategories) {
          lockedItemsByCategory.delete(changeCat.toLowerCase());
        }

        // All standard plan categories (from canonical categoryMapping)
        const allCategories = [
          'Tops',
          'Bottoms',
          'Dresses',
          'Shoes',
          'Outerwear',
          'Accessories',
          'Activewear',
          'Swimwear',
          'Undergarments',
          'Other',
        ];

        // Change slots = categories NOT being kept
        let changeCategories = allCategories.filter(
          (c) =>
            !keepCategories
              .map((k) => k.toLowerCase())
              .includes(c.toLowerCase()),
        );

        // 🛡️ DRESS PROMOTION RULE
        // If refinement mentions a dress (dress/gown/romper/jumpsuit/midi),
        // promote to Dresses slot and suppress Tops+Bottoms
        const dressPattern = /\b(dress|gown|romper|jumpsuit|midi\s*dress)\b/i;
        const hasDressIntent = dressPattern.test(refinementText);

        if (hasDressIntent) {
          // console.log(
          //   '⚡ [FAST] Dress promotion triggered - refinement contains dress keyword',
          // );

          // Remove Tops and Bottoms from change_slots (will be replaced by Dresses)
          changeCategories = changeCategories.filter(
            (c) => c !== 'Tops' && c !== 'Bottoms',
          );

          // Ensure Dresses is in change_slots
          if (!changeCategories.includes('Dresses')) {
            changeCategories.push('Dresses');
          }

          // Also remove from keep_slots if present
          const filteredKeep = keepCategories.filter(
            (c) => c.toLowerCase() !== 'tops' && c.toLowerCase() !== 'bottoms',
          );

          // console.log(
          //   '⚡ [FAST] Dress promotion - updated change_slots:',
          //   changeCategories,
          // );

          refinementAction = {
            keep_slots: filteredKeep,
            change_slots: changeCategories,
          };
        } else {
          refinementAction = {
            keep_slots: keepCategories,
            change_slots: changeCategories,
          };
        }

        // console.log(
        //   '⚡ [FAST] Refinement - keep slots:',
        //   keepCategories,
        //   'change slots:',
        //   changeCategories,
        // );
        // console.log(
        //   '⚡ [FAST] Refinement - NO item names sent to LLM (slot-level only)',
        // );
      }

      // ── 0c) PATH #2: Detect "Start with Item" case ──
      // This is an ISOLATED path - when user starts with a specific item
      // CRITICAL: This ONLY applies when lockedItemIds present AND NOT refinement
      const isStartWithItem = lockedItemIds.length > 0 && !isRefinement;
      let centerpieceItem: CenterpieceItem | null = null;
      let centerpieceDbItem: any = null;

      if (isStartWithItem) {
        // console.log('⚡ [FAST] PATH #2: Start with Item detected');
        // console.log(
        //   '⚡ [FAST] PATH #2: Centerpiece item ID:',
        //   lockedItemIds[0],
        // );

        // Fetch the centerpiece item details from database
        const { rows: centerpieceRows } = await pool.query(
          `SELECT id, name, main_category, subcategory, color, color_family,
                  formality_score, dress_code, material, fit, image_url
           FROM wardrobe_items
           WHERE id = $1 AND user_id = $2`,
          [lockedItemIds[0], userId],
        );

        if (centerpieceRows.length > 0) {
          centerpieceDbItem = centerpieceRows[0];
          const cp = centerpieceDbItem;

          // Build centerpiece description for LLM
          const descParts = [
            cp.color || cp.color_family,
            cp.subcategory || cp.name,
            cp.material,
          ].filter(Boolean);

          centerpieceItem = {
            category: cp.main_category as CenterpieceItem['category'],
            description: descParts.join(' ') || cp.name || 'item',
            color: cp.color || cp.color_family,
            formality: cp.formality_score,
            style: cp.dress_code,
          };

          // console.log(
          //   '⚡ [FAST] PATH #2: Centerpiece item:',
          //   JSON.stringify(centerpieceItem, null, 2),
          // );
        } else {
          // console.warn(
          //   '⚡ [FAST] PATH #2: Centerpiece item not found in database',
          // );
        }
      }

      // ── 1) Generate outfit PLAN using Gemini Flash (stateless, deterministic) ──
      // CRITICAL: Use different prompt for PATH #2 (Start with Item) vs PATH #1 (standard)
      let planPrompt: string;

      if (isStartWithItem && centerpieceItem) {
        // PATH #2: Use specialized V4 prompt with CENTERPIECE-FIRST enforcement
        // V4 ensures centerpiece is PRIMARY constraint - user input is only a styling MODIFIER
        // console.log(
        //   '⚡ [FAST] PATH #2: Using buildStartWithItemPromptV4 (centerpiece-first enforcement)',
        // );

        // Extract mood prompts and freeform prompt from the query string
        // Format: "outfit built around my X. IMPORTANT REFINEMENT: User specifically requested: "mood. prompt". You MUST..."
        const extractedMoods: string[] = [];
        let extractedFreeform: string | undefined;

        const refinementMatch = query.match(
          /IMPORTANT REFINEMENT:.*?"([^"]+)"/i,
        );
        if (refinementMatch && refinementMatch[1]) {
          const refinementText = refinementMatch[1];
          // console.log(
          //   '⚡ [FAST] PATH #2: Extracted refinement text:',
          //   refinementText,
          // );

          // Split by period to separate mood prompts from freeform prompt
          // Mood prompts typically start with "Create an outfit with..."
          const parts = refinementText.split(/\.\s+/).filter(Boolean);

          for (const part of parts) {
            const trimmed = part.trim();
            if (
              trimmed.toLowerCase().startsWith('create an outfit') ||
              trimmed.toLowerCase().startsWith('create a ')
            ) {
              // This is a mood prompt
              extractedMoods.push(trimmed);
            } else if (trimmed.length > 0) {
              // This is freeform user input
              extractedFreeform = extractedFreeform
                ? `${extractedFreeform}. ${trimmed}`
                : trimmed;
            }
          }
        }

        // console.log('⚡ [FAST] PATH #2: Extracted moods:', extractedMoods);
        // console.log(
        //   '⚡ [FAST] PATH #2: Extracted freeform:',
        //   extractedFreeform,
        // );

        // Build raw input for normalization
        const rawInput: RawStartWithItemInput = {
          centerpieceItem,
          moodPrompts: extractedMoods.length > 0 ? extractedMoods : undefined,
          freeformPrompt: extractedFreeform,
          weather: weather
            ? {
                temp_f: weather.tempF,
                condition: weather.precipitation,
              }
            : undefined,
          availableItems,
        };

        // NORMALIZE INPUT AND ENFORCE MUTUAL EXCLUSIVITY
        // This will throw MutualExclusionError if both moods AND freeform are present
        let normalizedInput: NormalizedStartWithItemInput;
        try {
          normalizedInput = normalizeStartWithItemIntent(rawInput);
          // console.log(
          //   '⚡ [FAST] PATH #2: Intent mode:',
          //   normalizedInput.intentMode,
          // );
        } catch (error) {
          if (error instanceof MutualExclusionError) {
            // console.error(
            //   '⚡ [FAST] PATH #2: MUTUAL EXCLUSION ERROR - cannot combine moods with freeform prompt',
            // );
            throw error; // Fail closed - do not proceed
          }
          throw error;
        }

        // Validate normalized input for internal consistency
        const intentValidation =
          validateStartWithItemIntentMode(normalizedInput);
        if (!intentValidation.valid) {
          // console.error(
          //   '⚡ [FAST] PATH #2: Intent mode validation failed:',
          //   intentValidation.errors,
          // );
          throw new Error(
            `PATH #2 intent mode validation failed: ${intentValidation.errors.join('; ')}`,
          );
        }

        // Attach approved style signals (same source as PATH #1)
        if (opts?.userStyle) {
          normalizedInput.userStyleProfile = opts.userStyle as any;
        }

        // Build V4 prompt with CENTERPIECE-FIRST enforcement
        planPrompt = buildStartWithItemPromptV4(normalizedInput);
      } else {
        // PATH #1: Standard prompt (unchanged behavior)
        // CRITICAL: refinementAction contains ONLY slot categories, NEVER item names
        planPrompt = buildOutfitPlanPrompt(query, {
          weather: weather
            ? {
                temp_f: weather.tempF,
                condition: weather.precipitation,
              }
            : undefined,
          availableItems,
          refinementAction, // Slot-level only - NO item names ever sent to LLM
          userStyleProfile: opts?.userStyle as any, // FIX 3: soft guidance
          genderDirective: buildGenderDirective(userPresentation), // FIX 4
        });
      }

      // ── Oversize candidate pool: request 12 so cohesion + structure gates still yield 3 ──
      planPrompt = planPrompt
        .replace(/exactly 3 ranked outfits/gi, 'exactly 12 ranked outfits')
        .replace(/Exactly 3 outfits/g, 'Exactly 12 outfits')
        .replace(/ALL 3 outfits/g, 'ALL 12 outfits')
        .replace(/All 3 outfits/g, 'All 12 outfits');

      // ── JSON safety constraints to reduce malformed output ──
      planPrompt += `\n\nJSON SAFETY RULES (MANDATORY):
- Return ONLY valid JSON. No markdown, no backticks, no trailing text.
- All string values must be single-line (no newline characters inside strings).
- Do not use unescaped quotes inside string values.
- "why" must be <= 140 chars, single sentence.
- If you cannot produce 9 outfits, produce as many as possible but still valid JSON.`;

      // ── Inventory Color Constraint — append to prompt if color intent detected ──
      if (_colorIntent.length > 0 && Object.keys(_availableColorsBySlot).length > 0) {
        const slotLines = Object.entries(_availableColorsBySlot)
          .map(([slot, colors]) => `  - ${slot}: ${colors.join(', ')}`)
          .join('\n');
        const anchorLine = _colorAnchorSlot
          ? `The PRIMARY color anchor slot is "${_colorAnchorSlot}" — it MUST contain a ${_colorIntent.join('/')} piece.`
          : `No exact color match found for ${_colorIntent.join('/')} — use the closest tonal match available.`;
        planPrompt += `\n\nINVENTORY COLOR CONSTRAINT (MANDATORY):
The user wants: ${_colorIntent.join(', ')}.
${anchorLine}
Available colors by slot in the user's wardrobe:
${slotLines}
- Do NOT suggest colors that are not listed above for any slot.
- If a slot has no exact match for the requested color, choose the closest tonal complement from that slot's available colors.
- Prioritize tonal harmony across the outfit (e.g., charcoal + navy + black, not charcoal + magenta + lime).`;
      }

      // console.log('⚡ [FAST] Plan prompt length:', planPrompt.length, 'chars');
      // console.log(
      //   '⚡ [FAST] Plan prompt (first 500 chars):',
      //   planPrompt.substring(0, 500),
      // );

      if (process.env.DEBUG_STUDIO === 'true') {
        const profileIdx = planPrompt.indexOf('STYLE PREFERENCES');
        if (profileIdx >= 0) {
          const excerpt = planPrompt
            .substring(profileIdx, profileIdx + 800)
            .split('\n')
            .slice(0, 25)
            .join('\n');
          console.log(
            `🎨 [Studio][FAST] path=${isStartWithItem ? 'PATH2_START_WITH_ITEM' : 'PATH1_STANDARD'} prompt style excerpt:\n` +
              excerpt,
          );
        } else {
          console.log(
            `🎨 [Studio][FAST] path=${isStartWithItem ? 'PATH2_START_WITH_ITEM' : 'PATH1_STANDARD'} prompt: no STYLE PREFERENCES section`,
          );
        }
      }

      logPrompt(reqId, {
        prompt: planPrompt,
        model: 'gemini-2.0-flash',
        promptLength: planPrompt.length,
      });

      const planStartTime = Date.now();

      // Use generateOutfits (returns raw response) instead of generateOutfitPlan
      // so we retain the raw text for robust salvage parsing when JSON is truncated.
      const planRaw = await this.vertex.generateOutfits(planPrompt);
      const planText: string =
        (planRaw?.candidates?.[0]?.content?.parts?.[0]?.text as string) ??
        (typeof planRaw === 'string' ? planRaw : '');

      const planLatencyMs = Date.now() - planStartTime;
      // console.log('⚡ [FAST] Plan generated in', planLatencyMs, 'ms');
      // console.log('⚡ [FAST] Plan raw text:', planText.substring(0, 800));

      logRawResponse(reqId, {
        responseText: planText,
        model: 'gemini-2.5-flash',
        latencyMs: planLatencyMs,
      });

      // ── Robust JSON extraction + salvage ──
      let plan: { outfit?: any; outfits?: any[] } = { outfits: [] };

      // Step 1: Brace-balanced JSON extraction
      const _extractBraceBalanced = (raw: string): string | null => {
        const idx = raw.indexOf('{');
        if (idx === -1) return null;
        let depth = 0;
        let inStr = false;
        let escaped = false;
        for (let i = idx; i < raw.length; i++) {
          const ch = raw[i];
          if (escaped) { escaped = false; continue; }
          if (ch === '\\' && inStr) { escaped = true; continue; }
          if (ch === '"') { inStr = !inStr; continue; }
          if (inStr) continue;
          if (ch === '{') depth++;
          else if (ch === '}') { depth--; if (depth === 0) return raw.slice(idx, i + 1); }
        }
        return null; // unbalanced
      };

      // Step 2: Strip control chars that break JSON
      const _sanitize = (s: string): string =>
        s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ' ');

      // Try brace-balanced extraction first
      const balanced = _extractBraceBalanced(_sanitize(planText));
      if (balanced) {
        try {
          plan = JSON.parse(balanced);
        } catch {
          // Try extractStrictJson as fallback (first { to last })
          try { plan = extractStrictJson(_sanitize(planText)); } catch { /* handled below */ }
        }
      } else {
        try { plan = extractStrictJson(_sanitize(planText)); } catch { /* handled below */ }
      }

      // Step 3: Partial salvage via regex when JSON parse fails entirely
      let outfitsArray = plan.outfit ? [plan.outfit] : plan.outfits || [];

      if (!outfitsArray.length && planText.length > 50) {
        // console.warn('⚡ [FAST] JSON parse failed, attempting partial outfit salvage');
        const salvaged: any[] = [];
        // Match each outfit block: "title" + "slots" array
        const outfitRe = /"title"\s*:\s*"([^"]*)"[\s\S]*?"slots"\s*:\s*\[([\s\S]*?)\]/g;
        let regexMatch: RegExpExecArray | null;
        while ((regexMatch = outfitRe.exec(planText)) !== null && salvaged.length < 12) {
          const title = regexMatch[1];
          const slotsRaw = regexMatch[2];
          // Extract individual slot objects
          const slotRe = /\{\s*"category"\s*:\s*"([^"]*)"\s*,\s*"description"\s*:\s*"([^"]*)"/g;
          const slots: any[] = [];
          let slotMatch: RegExpExecArray | null;
          while ((slotMatch = slotRe.exec(slotsRaw)) !== null) {
            slots.push({ category: slotMatch[1], description: slotMatch[2], formality: 5 });
          }
          if (title && slots.length >= 2) {
            salvaged.push({ title, slots, why: '' });
          }
        }
        if (salvaged.length > 0) {
          // console.log(`⚡ [FAST] Salvaged ${salvaged.length} outfits from malformed JSON`);
          outfitsArray = salvaged;
        }
      }

      // console.log('⚡ [FAST] Plan outfits count:', outfitsArray.length);

      if (!outfitsArray.length) {
        // console.warn('⚡ [FAST] No outfits in plan after salvage, returning empty');
        return {
          request_id: randomUUID(),
          outfit_id: randomUUID(),
          items: [],
          why: 'No outfits could be generated',
          outfits: [],
        };
      }

      logTrace(reqId, {
        stage: 'post_llm_parse_slot_counts',
        counts: outfitsArray.map((o: any) => o.slots?.length ?? 0),
      });

      // ── 2) Flatten all slots, embed in parallel, then query Pinecone ──
      const embedStartTime = Date.now();

      // Flatten all slots with outfit index for reconstruction
      type SlotWithContext = {
        outfitIdx: number;
        slotIdx: number;
        slot: { category: string; description: string; formality?: number };
      };
      const allSlots: SlotWithContext[] = [];
      outfitsArray.forEach((outfit, outfitIdx) => {
        outfit.slots.forEach((slot: any, slotIdx: number) => {
          allSlots.push({ outfitIdx, slotIdx, slot });
        });
      });

      // 🛡️ SLOT NORMALIZATION GUARD (last-line defense)
      // If any slot maps to 'bottoms' slot but description contains dress keywords,
      // normalize to 'Dresses' before Pinecone lookup
      // Use canonical slot mapping to detect bottoms-classified items
      const dressDescPattern = /\b(dress|gown|romper|jumpsuit|midi\s*dress)\b/i;
      for (const s of allSlots) {
        if (
          mapPlanCategoryToSlot(s.slot.category || '') === 'bottoms' &&
          dressDescPattern.test(s.slot.description || '')
        ) {
          // console.log(
          //   `⚡ [FAST] Slot normalization: "${s.slot.description}" category ${s.slot.category} → Dresses`,
          // );
          s.slot.category = 'Dresses';
        }
      }

      // console.log('⚡ [FAST] Total slots to embed:', allSlots.length);

      // Embed ALL slot descriptions in a SINGLE batch API call
      const slotDescriptions = allSlots.map((s) => s.slot.description);
      const embeddings = await this.vertex.embedTextBatch(slotDescriptions);

      // console.log(
      //   '⚡ [FAST] Embeddings done in',
      //   Date.now() - embedStartTime,
      //   'ms (batch)',
      // );

      // Query Pinecone for all slots in parallel
      // IMPORTANT: Filter by kind: "text" to match text embeddings against text vectors
      const pineconeStartTime = Date.now();
      const pineconeResults = await Promise.all(
        allSlots.map(async (s, idx) => {
          const categoryFilter = this.mapSlotCategoryToFilter(
            s.slot.category as OutfitPlanSlot['category'],
          );
          // Combine category filter with kind filter for text-to-text matching
          const filter = {
            ...categoryFilter,
            kind: { $eq: 'text' },
          };
          const matches = await queryUserNs({
            userId,
            vector: embeddings[idx],
            topK: 5, // Increased to get more candidates
            filter,
            includeMetadata: true,
          });
          return { ...s, matches };
        }),
      );

      // console.log(
      //   '⚡ [FAST] Pinecone queries in',
      //   Date.now() - pineconeStartTime,
      //   'ms',
      // );

      // Debug: Log what Pinecone returned for each slot
      for (const result of pineconeResults) {
        const topMatch = result.matches[0];
        // console.log(
        //   `⚡ [FAST] Slot "${result.slot.description}" (${result.slot.category}) → ${result.matches.length} matches, top: ${topMatch?.metadata?.name || topMatch?.metadata?.ai_title || topMatch?.id || 'none'} (score: ${topMatch?.score?.toFixed(3) || 'n/a'})`,
        // );

        logFilter(reqId, {
          stage: `pinecone_slot:${result.slot.category}`,
          reason: result.slot.description,
          catalogBefore: 5,
          catalogAfter: result.matches.length,
        });
      }

      // Reconstruct assembledOutfits structure
      const assembledOutfits = outfitsArray.map((outfitPlan, outfitIdx) => {
        const slotResults = pineconeResults
          .filter((r) => r.outfitIdx === outfitIdx)
          .sort((a, b) => a.slotIdx - b.slotIdx)
          .map((r) => ({ slot: r.slot, matches: r.matches }));
        return { outfitPlan, slotResults };
      });

      const embedPineconeMs = Date.now() - embedStartTime;
      // console.log(
      //   '⚡ [FAST] Total embed + Pinecone time:',
      //   embedPineconeMs,
      //   'ms',
      // );

      logParsed(reqId, {
        outfitCount: outfitsArray.length,
        slots: allSlots.map((s) => ({
          category: s.slot.category,
          description: s.slot.description,
        })),
        reasoning: `embed+pinecone: ${embedPineconeMs}ms`,
      });

      // ── 3) Fetch full item details from PostgreSQL ──
      const dbStartTime = Date.now();

      // Collect all unique item IDs from Pinecone results
      const allItemIds = new Set<string>();
      for (const outfit of assembledOutfits) {
        for (const sr of outfit.slotResults) {
          for (const match of sr.matches) {
            const itemId = this.normalizePineconeId(match.id).id;
            allItemIds.add(itemId);
          }
        }
      }

      // Also include locked items
      for (const id of lockedItemIds) {
        allItemIds.add(id);
      }

      // Fetch all items in one query
      const itemIds = Array.from(allItemIds);
      let itemsMap = new Map<string, any>();

      if (itemIds.length > 0) {
        const { rows } = await pool.query(
          `SELECT id, name, image_url, touched_up_image_url, processed_image_url,
                  main_category, subcategory, color, color_family, brand,
                  dress_code, formality_score, material, fit
           FROM wardrobe_items
           WHERE id = ANY($1) AND user_id = $2`,
          [itemIds, userId],
        );

        itemsMap = new Map(rows.map((r: any) => [r.id, r]));
      }

      // console.log(
      //   '⚡ [FAST] PostgreSQL fetch in',
      //   Date.now() - dbStartTime,
      //   'ms',
      // );

      // ── Elite Scoring: load context early (needed for slot-pick avoid_colors + taste validator + rerank) ──
      const eliteStyleContext = await this.loadEliteStyleContext(userId);

      // ── FAST-scoped learning signal loader (bypasses STATE_ENABLED) ──
      const fastSignals = await loadFastLearningSignals(userId);

      const _bpEarly = (eliteStyleContext as any)?._brainStyleProfile;
      const _earlyAvoid: string[] = _bpEarly?.avoid_colors ?? eliteStyleContext?.styleProfile?.avoid_colors ?? [];
      const _earlyAvoidExpanded = _earlyAvoid.length > 0 ? expandAvoidColors(_earlyAvoid) : [];

      const _itemViolatesAvoidColors = (item: any): boolean => {
        if (_earlyAvoidExpanded.length === 0) return false;
        // Collect all color signals from hydrated DB row:
        // extractItemColors reads .color, .colors, .metadata.color, etc.
        // We also check .color_family and item .name to catch cases where
        // the color DB field is null but the name contains the color word.
        const colors = extractItemColors(item as any);
        if (item.color_family) colors.push(item.color_family.trim().toLowerCase());
        if (item.name) colors.push(item.name.trim().toLowerCase());
        for (const ic of colors) {
          for (const ac of _earlyAvoidExpanded) {
            if (colorMatchesSafe(ic, ac)) return true;
          }
        }
        return false;
      };

      // ── 4) Assemble final outfits with real items ──
      // PATH #1 (standard): LLM generates all slots, we match with Pinecone
      // PATH #2 (start with item): Centerpiece is FIRST in every outfit, LLM generated complementary slots
      // Refinement: backend handles kept items directly (no LLM involvement with item names)
      if (isStartWithItem && centerpieceDbItem) {
        // console.log(
        //   '⚡ [FAST] PATH #2: Assembling outfits with centerpiece:',
        //   centerpieceDbItem.name,
        // );
        // console.log(
        //   '⚡ [FAST] PATH #2: Centerpiece category:',
        //   centerpieceDbItem.main_category,
        // );
      } else if (isRefinement) {
        // console.log(
        //   '⚡ [FAST] Refinement - backend directly uses locked items for kept slots',
        // );
        // console.log(
        //   '⚡ [FAST] Refinement - LLM only generated descriptions for changed slots',
        // );
      }

      let outfits = assembledOutfits.map((assembled, outfitIdx) => {
        const { outfitPlan, slotResults } = assembled;

        // Pick best match for each slot
        const items: CatalogItem[] = [];
        const usedIds = new Set<string>();

        // ── PATH #2: Start with Item - Add centerpiece FIRST ──
        // The centerpiece is the foundation of ALL 3 outfits
        if (isStartWithItem && centerpieceDbItem) {
          const centerpieceId = centerpieceDbItem.id;
          items.push(this.dbRowToCatalogItem(centerpieceDbItem));
          usedIds.add(centerpieceId);
          // console.log(
          //   `⚡ [FAST] PATH #2: Outfit ${outfitIdx + 1} - Centerpiece: ${centerpieceDbItem.name} (${centerpieceDbItem.main_category})`,
          // );
        }
        // ── Refinement: Add locked items for KEPT slots ──
        else if (isRefinement && lockedItemsByCategory.size > 0) {
          // Add kept items directly from locked items map
          for (const [category, itemId] of lockedItemsByCategory) {
            const item = itemsMap.get(itemId);
            if (item && !usedIds.has(itemId)) {
              items.push(this.dbRowToCatalogItem(item));
              usedIds.add(itemId);
              // console.log(
              //   `⚡ [FAST] Kept ${category} slot: ${item.name} (backend-direct, no LLM)`,
              // );
            }
          }
        }
        // ── PATH #1: Standard - add locked items if any (legacy behavior) ──
        else if (!isRefinement && !isStartWithItem) {
          for (const lockedId of lockedItemIds) {
            const item = itemsMap.get(lockedId);
            if (item && !usedIds.has(lockedId)) {
              items.push(this.dbRowToCatalogItem(item));
              usedIds.add(lockedId);
            }
          }
        }

        // Fill CHANGED slots with best matches from Pinecone (based on LLM's generic descriptions)
        for (const sr of slotResults) {
          // Skip if we already have an item for this slot (from kept slots)
          // Use slot-based comparison to handle categories that map to the same slot
          // (e.g., Skirts maps to 'bottoms' slot same as Bottoms)
          const targetSlot = mapPlanCategoryToSlot(sr.slot.category);
          const alreadyHasCategory = items.some(
            (it) => mapMainCategoryToSlot(it.main_category) === targetSlot,
          );

          if (alreadyHasCategory) {
            if (isStartWithItem) {
              // console.log(
              //   `⚡ [FAST] PATH #2: Skipping ${targetSlot} slot (centerpiece already fills this category)`,
              // );
            }
            continue;
          }

          // Pick best unused match from Pinecone results,
          // skipping P0 avoid_color violators AND slot-incompatible items
          let _pickedFallback: any = null;
          let _slotPicked = false;
          for (const match of sr.matches) {
            const itemId = this.normalizePineconeId(match.id).id;
            if (usedIds.has(itemId)) continue;

            const item = itemsMap.get(itemId);
            if (!item) continue;

            // P-0: masculine presentation — reject feminine items at candidate level (not post-hoc splice)
            if (userPresentation === 'masculine' && isFeminineItem(
              item.main_category || '',
              item.subcategory || '',
              item.name || '',
            )) continue;

            // P-1: occasion appropriateness — reject items inappropriate for formal contexts
            if (!isOccasionAppropriate(item, { query })) {
              // console.log(
              //   JSON.stringify({
              //     _tag: 'OCCASION_FILTER_REJECTED',
              //     mode: 'fast',
              //     itemName: item.name,
              //     reason: getOccasionRejectionReason(item, { query }),
              //   }),
              // );
              continue;
            }

            // P1: slot compatibility — reject garment-type mismatches
            const slotCheck = validateSlotMatch(
              { category: targetSlot, description: sr.slot.description, formality: sr.slot.formality },
              { id: item.id, name: item.name, main_category: item.main_category, subcategory: item.subcategory, dress_code: item.dress_code, formality_score: item.formality_score },
              query,
            );
            if (!slotCheck.valid) {
              // console.log(
              //   `⚡ [FAST] STUDIO_SLOT_REJECTED | slot: "${sr.slot.description}" | candidate: "${item.name}" (${item.subcategory || item.main_category}) | reason: ${slotCheck.reason}`,
              // );
              continue;
            }

            // Capture first hard-gate survivor as fallback before soft gates can reject
            if (!_pickedFallback) _pickedFallback = item;

            // P2: unified drift gate — replaces inline P0 (avoid colors) + P2 (color intent) + P3 (garment intent)
            const _driftCheck = validateItemAgainstIntent({
              slotDescription: sr.slot.description,
              candidateItem: item,
              avoidColors: _earlyAvoid,
            });
            if (!_driftCheck.valid) {
              // console.log(
              //   `⚡ [FAST] DRIFT_REJECTED | slot: "${sr.slot.description}" | candidate: "${item.name}" | ${_driftCheck.reason}`,
              // );
              continue;
            }

            // P3: inverse contextual gate — reject heavy/structured/formal items in casual/outdoor/active contexts
            const _ctxCheck = _contextAppropriate(item);
            logTrace(reqId, {
              stage: `context_eval:${targetSlot}`,
              itemId: item.id,
              itemName: item.name,
              material: item.material ?? null,
              dressCode: item.dress_code ?? null,
              formalityScore: item.formality_score ?? null,
              context: {
                formality: _studioContext.formality,
                isOutdoor: _studioContext.isOutdoor,
                activityLevel: _studioContext.activityLevel,
                tempBand: _studioContext.tempBand,
                season: _studioContext.season,
              },
              appropriate: _ctxCheck.appropriate,
              reason: _ctxCheck.reason ?? null,
            });
            if (!_ctxCheck.appropriate) {
              logFilter(reqId, {
                stage: `context_gate:${targetSlot}`,
                reason: _ctxCheck.reason,
                catalogBefore: sr.matches.length,
                catalogAfter: sr.matches.length,
              });
              continue;
            }

            // FAST-only: reject structured business footwear in outdoor warm/hot casual contexts
            if (
              _studioContext.isOutdoor &&
              (_studioContext.tempBand === 'warm' || _studioContext.tempBand === 'hot') &&
              _studioContext.formality <= 7 &&
              typeof item.formality_score === 'number' &&
              item.formality_score >= 8
            ) {
              const _dc = (item.dress_code ?? '').toLowerCase();
              const _sub = (item.subcategory ?? '').toLowerCase();
              const _nm = (item.name ?? '').toLowerCase();
              const _itemSig = `${_sub} ${_nm}`;
              const STRUCTURED_BIZ_FOOTWEAR = /\b(oxford|derby|cap[- ]?toe|wingtip|brogue|monk[- ]?strap|dress\s*shoe|formal\s*shoe)\b/i;
              if (_dc.includes('business') || STRUCTURED_BIZ_FOOTWEAR.test(_itemSig)) {
                logFilter(reqId, {
                  stage: `fast_strict_formal_outdoor_heat:${targetSlot}`,
                  reason: `FAST_STRICT_FORMAL_OUTDOOR_HEAT: "${item.name}" formality=${item.formality_score} dressCode="${item.dress_code}" outdoor+${_studioContext.tempBand} contextFormality=${_studioContext.formality}`,
                  catalogBefore: sr.matches.length,
                  catalogAfter: sr.matches.length,
                });
                continue;
              }
            }

            logTrace(reqId, {
              stage: `slot_final:${targetSlot}`,
              itemId: item.id,
              itemName: item.name,
            });
            items.push(this.dbRowToCatalogItem(item));
            usedIds.add(itemId);
            _slotPicked = true;
            // console.log(
            //   `⚡ [FAST] STUDIO_SLOT_ACCEPTED | slot: "${sr.slot.description}" | picked: "${item.name}" (${item.subcategory || item.main_category})`,
            // );
            if (isRefinement) {
              // console.log(
              //   `⚡ [FAST] Changed ${targetSlot} slot: ${item.name} (from LLM description: "${sr.slot.description}")`,
              // );
            } else if (isStartWithItem) {
              // console.log(
              //   `⚡ [FAST] PATH #2: Complementary ${targetSlot}: ${item.name} (matched: "${sr.slot.description}")`,
              // );
            }
            _pickedFallback = null;
            break;
          }
          // If ALL candidates failed soft gates, use the hard-gate survivor as fallback unconditionally.
          // The fallback already passed P-0 (masculine), P-1 (occasion), P1 (slot compat).
          // Re-running validateItemAgainstIntent here would repeat the P2 drift check that
          // already rejected this item in the main loop — defeating the fallback's purpose.
          if (!_slotPicked && _pickedFallback && !items.some((it) => mapMainCategoryToSlot(it.main_category) === targetSlot)) {
            logTrace(reqId, {
              stage: `fallback_used:${targetSlot}`,
              itemId: _pickedFallback.id,
              itemName: _pickedFallback.name,
            });
            items.push(this.dbRowToCatalogItem(_pickedFallback));
            usedIds.add(_pickedFallback.id);
          }
        }

        // Sort items: Tops, Bottoms, Shoes, Outerwear, Accessories
        const orderRank = (c: CatalogItem) => {
          const main = (c.main_category ?? '').toLowerCase();
          if (main === 'tops') return 1;
          if (main === 'bottoms') return 2;
          if (main === 'shoes') return 3;
          if (main === 'outerwear') return 4;
          return 5;
        };
        items.sort((a, b) => orderRank(a) - orderRank(b));

        return {
          outfit_id: randomUUID(),
          title: outfitPlan.title || 'Outfit',
          items,
          why: (outfitPlan as any).why || '',
        };
      });

      // ── Primary Color Anchor Rule ─────────────────────────────
      // If color intent was extracted, reject outfits that lack at least one
      // item matching the intent color. Fail-open: if rejection would empty
      // the list, keep all outfits.
      if (_colorIntent.length > 0) {
        const anchorSlotPreference = ['bottoms', 'outerwear', 'tops', 'shoes', 'accessories'];
        const withAnchor = outfits.filter((outfit: any) => {
          const items: CatalogItem[] = outfit.items ?? [];
          // Check if any item's color tokens match the intent
          for (const item of items) {
            const itemColors = extractItemColors(item as any);
            if (item.color_family) itemColors.push(item.color_family.trim().toLowerCase());
            const matches = itemColors.some((ic) =>
              _colorIntent.some((intent) => colorMatchesSafe(ic, intent)),
            );
            if (matches) return true;
          }
          // console.log(
          //   `⚡ [FAST] EXECUTIVE_COLOR_ANCHOR_FAIL: "${outfit.title}" has no ${_colorIntent.join('/')} piece`,
          // );
          return false;
        });
        // Fail-open: only apply filter if it doesn't empty the list
        if (withAnchor.length > 0) {
          // console.log(
          //   `⚡ [FAST] Color anchor filter: ${outfits.length} → ${withAnchor.length} outfits`,
          // );
          outfits = withAnchor;
        } else {
          // console.log(
          //   '⚡ [FAST] Color anchor filter would reject all — keeping originals (fail-open)',
          // );
        }
      }

      // ── FAST slot-completeness gate — reject outfits with fewer than 4 filled slots ──
      {
        const preComplete = outfits.length;
        const complete = outfits.filter((outfit: any) => {
          const items: any[] = outfit.items ?? [];
          const slots = new Set(items.map((it: any) => mapMainCategoryToSlot(it.main_category)));
          const hasCore = slots.has('tops') && slots.has('bottoms') && slots.has('shoes');
          if (!hasCore || items.length < 4) {
            logTrace(reqId, {
              stage: 'fast_slot_completeness_reject',
              title: outfit.title,
              itemCount: items.length,
              slots: [...slots],
              missingCore: [
                ...(!slots.has('tops') ? ['tops'] : []),
                ...(!slots.has('bottoms') ? ['bottoms'] : []),
                ...(!slots.has('shoes') ? ['shoes'] : []),
              ],
            });
            return false;
          }
          return true;
        });
        if (complete.length > 0) {
          outfits = complete;
        }
        logTrace(reqId, {
          stage: 'fast_slot_completeness',
          before: preComplete,
          after: outfits.length,
        });
      }

      // Snapshot before cohesion filtering — used by relaxed retry if all are eliminated
      const _preCohesionOutfits = [...outfits];

      // ── FAST cohesion gate — reject outfits that pass structure but lack stylistic cohesion ──
      {
        const preCohesion = outfits.length;
        const cohesionPassed = outfits.filter((outfit: any) => {
          const cohesionItems = (outfit.items ?? []) as CatalogItem[];
          const cohesion = scoreFastOutfitCohesion(cohesionItems, _studioContext);
          if (!cohesion.pass) {
            logFilter(reqId, {
              stage: 'fast_cohesion_gate',
              reason: `${cohesion.reason} | outfit="${outfit.title}"`,
              catalogBefore: preCohesion,
              catalogAfter: preCohesion,
            });
          }
          return cohesion.pass;
        });
        if (cohesionPassed.length > 0) {
          outfits = cohesionPassed;
        }
        logTrace(reqId, {
          stage: 'fast_cohesion_summary',
          before: preCohesion,
          after: outfits.length,
        });
      }

      // Hard validation gate — discard structurally invalid outfits
      outfits = validateOutfitCore(outfits, query);

      // ── FAST: Rank by cohesion and take top 3 ──
      // No deterministic fallback. No padding. Only elite survivors.
      if (outfits.length > 3) {
        const scored = outfits.map((outfit: any) => {
          const cohesionItems = (outfit.items ?? []) as CatalogItem[];
          const cohesion = scoreFastOutfitCohesion(cohesionItems, _studioContext);
          return { outfit, score: cohesion.score };
        });
        scored.sort((a, b) => b.score - a.score);
        outfits = scored.slice(0, 3).map((s) => s.outfit);
        logTrace(reqId, {
          stage: 'fast_cohesion_rank',
          scores: scored.map((s) => ({ title: s.outfit.title, score: +(s.score.toFixed(3)) })),
          kept: 3,
        });
      }

      // ── FAST relaxed retry — backfill when strict gating leaves fewer than 3 ──
      if (outfits.length < 3 && _preCohesionOutfits.length > 0) {
        const needed = 3 - outfits.length;
        const existingIds = new Set(outfits.map((o: any) => o.outfit_id));
        const relaxed = _preCohesionOutfits
          .filter((o: any) => !existingIds.has(o.outfit_id))
          .map((outfit: any) => {
            const cohesionItems = (outfit.items ?? []) as CatalogItem[];
            const cohesion = scoreFastOutfitCohesion(cohesionItems, _studioContext, {
              maxFormalityDelta: 6,
              minScore: 0.38,
            });
            return { outfit, score: cohesion.score, pass: cohesion.pass };
          })
          .filter((r) => r.pass)
          .sort((a, b) => (b.outfit.items?.length ?? 0) - (a.outfit.items?.length ?? 0) || b.score - a.score)
          .slice(0, needed)
          .map((r) => r.outfit);

        if (relaxed.length > 0) {
          outfits = [...outfits, ...relaxed];
        }
        logTrace(reqId, {
          stage: 'fast_relaxed_retry',
          preCohesionPool: _preCohesionOutfits.length,
          relaxedSurvivors: relaxed.length,
        });
      }

      if (outfits.length < 3 && outfits.length > 0) {
        logTrace(reqId, {
          stage: 'fast_undersupply',
          survivingOutfits: outfits.length,
        });
      }

      // ── 5) PATH #2 POST-PARSE VALIDATION ──
      // Validate outfit[0] only — padded outfits (#2, #3) may not contain centerpiece
      if (isStartWithItem && centerpieceDbItem && outfits.length > 0) {
        const centerpieceId = centerpieceDbItem.id;
        const centerpieceCategory =
          centerpieceDbItem.main_category?.toLowerCase() || '';

        // console.log(
        //   '⚡ [FAST] PATH #2: Running composition validation on outfit[0]...',
        // );

        // Validate only the primary outfit (outfit[0]) for centerpiece constraints
        const validationResult = validateStartWithItemComposition(
          outfits[0] as any,
          centerpieceId,
          centerpieceCategory,
          0,
        );

        // Log warnings (non-fatal)
        for (const warning of validationResult.warnings) {
          console.warn(`⚠️ [FAST] PATH #2 WARNING: ${warning}`);
        }

        // Fail closed on any validation errors for outfit[0]
        if (!validationResult.valid) {
          for (const error of validationResult.errors) {
            console.error(`❌ [FAST] PATH #2 VALIDATION FAILED: ${error}`);
          }
          throw new Error(
            `PATH #2 composition validation failed: ${validationResult.errors.join('; ')}`,
          );
        }

        console.log('✅ [FAST] PATH #2: Composition validation PASSED');
        console.log(
          `✅ [FAST] PATH #2: Centerpiece ${centerpieceDbItem.name} present in outfit[0]`,
        );
        console.log(
          `✅ [FAST] PATH #2: ${outfits.length} outfits total (${outfits.length > 1 ? 'padded' : 'single'})`,
        );
      }

      // ── Pref-based ranking: pick best outfit by user preference scores ──
      let best: any;
      if (outfits.length <= 1) {
        best = outfits[0];
      } else {
        const allIds = Array.from(
          new Set(
            outfits.flatMap(
              (o: any) =>
                o.items?.map((it: any) => it?.id).filter(Boolean) ?? [],
            ),
          ),
        );
        const prefRows =
          allIds.length > 0
            ? await pool.query(
                'SELECT item_id, score FROM user_pref_item WHERE user_id = $1 AND item_id = ANY($2)',
                [userId, allIds],
              )
            : { rows: [] as any[] };
        const pref = new Map<string, number>(
          prefRows.rows.map((r: any) => [String(r.item_id), Number(r.score)]),
        );
        const ranked = outfits
          .map((o: any) => {
            const items = o.items ?? [];
            const boost =
              items.length === 0
                ? 0
                : items.reduce(
                    (a: number, it: any) => a + (pref.get(it?.id) ?? 0),
                    0,
                  ) / items.length;
            return { o, boost };
          })
          .sort((a: any, b: any) => b.boost - a.boost);
        best = ranked[0]?.o;
      }
      if (!best) {
        best = {
          outfit_id: randomUUID(),
          title: 'No complete outfit found',
          items: [],
          why: 'Your wardrobe may not have enough items to build a complete outfit for this request. Try adding more tops, bottoms, or shoes.',
        };
      }

      const totalTime = Date.now() - startTime;
      // console.log('⚡ [FAST] Total generateOutfitsFast time:', totalTime, 'ms');

      logOutput(reqId, {
        outfits: outfits.map((o: any) => ({
          id: o.outfit_id,
          title: o.title,
          itemCategories: o.items?.map((it: any) => it?.main_category),
        })),
        totalLatencyMs: totalTime,
        itemCounts: outfits.map((o: any) => o.items?.length ?? 0),
      });

      // Elite Scoring hook — Phase 2: rerank when V2 flag on
      const demoEliteFast = isEliteDemoUser(userId);
      let eliteOutfits = outfits;
      if (ELITE_FLAGS.STUDIO || ELITE_FLAGS.STUDIO_V2 || demoEliteFast) {
        const canonical = outfits.map(normalizeStudioOutfit);
        const result = elitePostProcessOutfits(canonical, eliteStyleContext, {
          mode: 'studio',
          requestId: reqId,
          rerank: ELITE_FLAGS.STUDIO_V2 || demoEliteFast,
          debug: true,
        });
        eliteOutfits = result.outfits.map(denormalizeStudioOutfit);
      }

      // ── Elite Scoring: log exposure event (fire-and-forget) ──
      // NOT gated by ELITE_FLAGS — gated by LEARNING_FLAGS + consent + circuit breaker
      {
        const canonicalForEvent = eliteOutfits.map(normalizeStudioOutfit);
        const exposureEvent = buildEliteExposureEvent(
          userId,
          canonicalForEvent,
          {
            mode: 'studio',
            requestId: reqId,
            weather: opts?.weather ? { temp: opts.weather.tempF } : undefined,
          },
        );
        this.learningEventsService.logEvent(exposureEvent).catch(() => {});
      }

      // ── Local quality gate: drop outfits with obvious stylistic conflicts ──
      {
        const _txt = (it: any): string =>
          `${it?.name ?? ''} ${it?.label ?? ''} ${it?.subcategory ?? ''}`.toLowerCase();

        const _hasConflict = (outfit: any): boolean => {
          const items: any[] = outfit.items ?? [];
          if (items.length === 0) return true;

          const bySlot = (s: string) =>
            items.filter((it: any) => mapMainCategoryToSlot(it.main_category) === s);

          const tops = bySlot('tops');
          const bottoms = bySlot('bottoms');
          const shoes = bySlot('shoes');
          const dresses = bySlot('dresses');

          const TAILORED_TOP = /\b(blazer|sport\s*coat|suit\s*jacket|dress\s*shirt)\b/i;
          const ATHLETIC_BOTTOM = /\b(jogger|sweatpant|track\s*pant|gym\s*short|athletic\s*short)\b/i;
          const FORMAL_SHOE = /\b(oxford|derby|loafer|dress\s*shoe|brogue|monk\s*strap)\b/i;
          const ATHLETIC_WEAR = /\b(hoodie|sweatshirt|jogger|sweatpant|track|gym|athletic)\b/i;
          const TAILORED = /\b(blazer|sport\s*coat|suit)\b/i;
          const CASUAL_FOOT = /\b(flip[- ]?flop|slides?|crocs?)\b/i;
          const FORMAL_DRESS = /\b(gown|evening\s*dress|cocktail\s*dress|formal\s*dress)\b/i;
          const ATHLETIC_SHOE = /\b(sneaker|trainer|running\s*shoe|athletic\s*shoe)\b/i;

          // Rule 1: Tailored upper + athletic lower
          if (tops.some((t: any) => TAILORED_TOP.test(_txt(t))) &&
              bottoms.some((b: any) => ATHLETIC_BOTTOM.test(_txt(b)))) return true;

          // Rule 2: Formal shoes + athletic wear
          if (shoes.some((s: any) => FORMAL_SHOE.test(_txt(s))) &&
              [...tops, ...bottoms].some((i: any) => ATHLETIC_WEAR.test(_txt(i)))) return true;

          // Rule 3: Blazer/suit + flip-flops/slides
          if ([...tops, ...bySlot('outerwear')].some((i: any) => TAILORED.test(_txt(i))) &&
              shoes.some((s: any) => CASUAL_FOOT.test(_txt(s)))) return true;

          // Rule 4: Formal dress + sneakers
          if (dresses.some((d: any) => FORMAL_DRESS.test(_txt(d))) &&
              shoes.some((s: any) => ATHLETIC_SHOE.test(_txt(s)))) return true;

          // Rule 5: Formality spread > 4 across items
          const fScores = items
            .map((it: any) => it.formality_score)
            .filter((s: any): s is number => typeof s === 'number');
          if (fScores.length >= 2 && Math.max(...fScores) - Math.min(...fScores) > 4) return true;

          // Rule 6: Mixed athletic + non-athletic base layers
          const ATHLETIC_ANY = /\b(athletic|gym|workout|training|sport|track|running)\b/i;
          const hasAthleticBase = [...tops, ...bottoms].some((i: any) => ATHLETIC_ANY.test(_txt(i)));
          const hasNonAthleticBase = [...tops, ...bottoms].some((i: any) => !ATHLETIC_ANY.test(_txt(i)));
          const allBase = [...tops, ...bottoms];
          if (allBase.length >= 2 && hasAthleticBase && hasNonAthleticBase) return true;

          // Rule 7: Open-toe footwear + heavy outerwear
          const OPEN_TOE = /\b(sandal|open[- ]?toe|flip[- ]?flop|slide|mule)\b/i;
          const HEAVY_OUTER = /\b(parka|puffer|peacoat|overcoat|down\s*jacket|wool\s*coat|shearling)\b/i;
          const outerwear = bySlot('outerwear');
          if (shoes.some((s: any) => OPEN_TOE.test(_txt(s))) &&
              outerwear.some((o: any) => HEAVY_OUTER.test(_txt(o)))) return true;

          // Rule 8: Formal accessories + casual base
          const FORMAL_ACC = /\b(cufflink|tie\s*bar|pocket\s*square|bow\s*tie|silk\s*tie)\b/i;
          const CASUAL_BASE = /\b(t-shirt|tee|tank\s*top|hoodie|sweatshirt|cargo|jean|denim)\b/i;
          const accessories = bySlot('accessories');
          if (accessories.some((a: any) => FORMAL_ACC.test(_txt(a))) &&
              [...tops, ...bottoms].some((i: any) => CASUAL_BASE.test(_txt(i)))) return true;

          return false;
        };

        const _filtered = eliteOutfits.filter((o: any) => !_hasConflict(o));
        eliteOutfits = _filtered.length > 0 ? _filtered : [eliteOutfits[0]];
      }

      return {
        request_id: reqId,
        outfit_id: best.outfit_id,
        items: best.items,
        why: best.why,
        outfits: eliteOutfits,
      };
    } catch (err: any) {
      console.error(
        '❌ [FAST] Error in generateOutfitsFast:',
        err.message,
        err.stack,
      );
      throw err;
    }
  }

  // ── SWAP SLOT MAP: frontend swap sections → DB main_category values ──
  private static readonly SWAP_SLOT_TO_MAIN_CATEGORIES: Record<string, string[]> = {
    top: ['Tops'],
    bottom: ['Bottoms', 'Skirts'],
    shoes: ['Shoes'],
    outerwear: ['Outerwear'],
    accessories: ['Accessories', 'Bags', 'Headwear', 'Jewelry'],
    dress: ['Dresses', 'Formalwear', 'TraditionalWear'],
  };

  // ── FORMALITY CONSTANTS (mirrors ai.service.ts, needed for composition scoring) ──
  private static readonly SWAP_CATEGORY_FORMALITY: Record<string, number> = {
    activewear: 0, swimwear: 0, top: 2, bottom: 2, shoes: 2,
    outerwear: 2, dress: 2, accessory: 2,
  };
  private static readonly SWAP_SUBCATEGORY_SIGNALS: Array<[number, string[]]> = [
    [0, ['performance', 'running', 'training', 'gym', 'track', 'athletic', 'sport', 'jogger', 'sweatpant', 'sweatshort', 'slide', 'flip flop']],
    [1, ['t-shirt', 'tee', 'hoodie', 'sweatshirt', 'sneaker', 'canvas', 'sandal', 'jean', 'denim', 'cargo', 'tank top', 'jersey', 'short']],
    [2, ['polo', 'sweater', 'knit', 'cardigan', 'henley', 'boot', 'chino', 'khaki', 'loafer', 'moccasin', 'pullover']],
    [3, ['button down', 'dress shirt', 'blouse', 'blazer', 'trouser', 'slack', 'dress pant', 'oxford', 'derby', 'brogue', 'wingtip', 'heel', 'pump', 'cocktail']],
    [4, ['tuxedo', 'gown', 'formal', 'patent', 'evening', 'black tie']],
  ];

  // ── REMOVAL INTENT: slots that can be removed without breaking an outfit ──
  private static readonly REMOVABLE_SLOTS: Set<string> = new Set([
    'outerwear', 'accessories',
  ]);

  private static readonly REMOVAL_PHRASES: string[] = [
    'remove', 'get rid of', 'drop', 'ditch', 'without',
    "don't need", 'do not need', 'skip', 'take off', 'lose the',
  ];

  private static readonly REMOVAL_NO_PATTERNS: RegExp =
    /\bno\s+(belt|jacket|blazer|coat|outerwear|tie|scarf|hat|bag|watch|bracelet|necklace|sunglasses|cardigan|hoodie|vest|parka|trench|windbreaker|raincoat)\b/i;

  private static readonly REMOVAL_KEYWORD_TO_SLOT: Record<string, Slot> = {
    belt: 'accessories',
    tie: 'accessories',
    scarf: 'accessories',
    hat: 'accessories',
    bag: 'accessories',
    watch: 'accessories',
    bracelet: 'accessories',
    necklace: 'accessories',
    sunglasses: 'accessories',
    jacket: 'outerwear',
    blazer: 'outerwear',
    coat: 'outerwear',
    outerwear: 'outerwear',
    cardigan: 'outerwear',
    hoodie: 'outerwear',
    vest: 'outerwear',
    parka: 'outerwear',
    trench: 'outerwear',
    windbreaker: 'outerwear',
    raincoat: 'outerwear',
  };

  /**
   * Detect if a refinement prompt expresses intent to REMOVE an item.
   * Deterministic substring matching only.
   */
  private static detectRemovalIntent(prompt: string): boolean {
    const lower = prompt.toLowerCase();
    for (const phrase of WardrobeService.REMOVAL_PHRASES) {
      if (lower.includes(phrase)) return true;
    }
    if (WardrobeService.REMOVAL_NO_PATTERNS.test(lower)) return true;
    return false;
  }

  /**
   * Infer which slot to remove from prompt keywords.
   * Returns null if ambiguous or not inferable.
   */
  private static inferRemovalSlot(prompt: string): Slot | null {
    const lower = prompt.toLowerCase();
    for (const [keyword, slot] of Object.entries(WardrobeService.REMOVAL_KEYWORD_TO_SLOT)) {
      if (lower.includes(keyword)) return slot;
    }
    return null;
  }

  /**
   * DETERMINISTIC OUTFIT SLOT SWAP (Composition-Guided Recomposition)
   *
   * Replaces a single slot in an existing outfit using composition context.
   * NO LLM calls. NO Pinecone. NO embeddings. Pure DB + composition ranking.
   *
   * Flow:
   * 1. Identify anchor from existing outfit items
   * 2. Build OutfitCompositionContext from anchor
   * 3. Fetch candidate items from DB for the target slot
   * 4. Rank candidates by composition compatibility
   * 5. Replace slot with top-ranked compatible item
   * 6. Validate via taste validator + style veto + style judge
   * 7. Return single recomposed outfit
   *
   * Latency target: <120ms
   */
  async recomposeOutfitSlot(
    userId: string,
    input: {
      outfitItems: Array<{
        id: string;
        label?: string;
        name?: string;
        image?: string;
        image_url?: string;
        main_category?: string;
        subcategory?: string;
        color?: string;
        color_family?: string;
        brand?: string;
        dress_code?: string;
        formality_score?: number;
        material?: string;
        fit?: string;
      }>;
      swapSlot: string; // 'top' | 'bottom' | 'shoes' | 'outerwear' | 'accessories'
      newItemId: string; // the user-chosen replacement item ID
      weather?: WeatherContext;
      requestId?: string;
    },
  ) {
    const startTime = Date.now();
    const reqId = input.requestId || randomUUID();

    // LEARNING: pure logging accept — early exit before any refinement logic
    if ((input as any).learning_accept === true) {
      this.emitRefinementLearning(userId, 'STYLE_CONSTRAINT_SIGNAL', 1, 0.7, {
        entityId: reqId,
        entitySignature: 'refinement_applied',
        itemIds: input.outfitItems?.map((i) => i.id).filter(Boolean) ?? [],
        tags: ['explicit_accept'],
        metadata: { outfit_id: reqId },
      });
      return {
        request_id: reqId,
        outfit_id: reqId,
        items: input.outfitItems ?? [],
        why: 'accepted',
        outfits: [],
      };
    }

    console.log(`⚡ [SWAP] Starting recomposeOutfitSlot reqId=${reqId} slot=${input.swapSlot} newItem=${input.newItemId}`);

    // 1. Fetch the new item + all existing outfit items from DB in one query
    const allIds = [
      ...input.outfitItems.map((i) => i.id).filter(Boolean),
      input.newItemId,
    ];
    const { rows: dbItems } = await pool.query(
      `SELECT id, name, image_url, touched_up_image_url, processed_image_url,
              main_category, subcategory, color, color_family, brand,
              dress_code, formality_score, material, fit
       FROM wardrobe_items
       WHERE id = ANY($1) AND user_id = $2`,
      [allIds, userId],
    );
    const itemMap = new Map(dbItems.map((r: any) => [r.id, r]));

    // Resolve new item
    const newItemDb = itemMap.get(input.newItemId);
    if (!newItemDb) {
      console.warn(`⚡ [SWAP] New item ${input.newItemId} not found in DB, falling back`);
      return null; // caller falls through to generateOutfitsFast
    }

    // 2. Build the swapped outfit items
    const mainCatsForSlot = WardrobeService.SWAP_SLOT_TO_MAIN_CATEGORIES[input.swapSlot] ?? [];

    // Replace items in the target slot with the new item; keep everything else
    const swappedItems: any[] = [];
    let slotReplaced = false;
    let replacedItemId: string | undefined;
    for (const item of input.outfitItems) {
      const db: any = itemMap.get(item.id);
      const mainCat = (db?.main_category || (item as any).main_category || '').trim();
      const isTargetSlot = mainCatsForSlot.some(
        (mc) => mc.toLowerCase() === mainCat.toLowerCase(),
      );

      if (isTargetSlot && !slotReplaced) {
        replacedItemId = db?.id ?? item.id;
        slotReplaced = true;
        continue;
      }
      // Keep item (merge DB data for richer metadata)
      swappedItems.push(db ?? item);
    }

    // Add the new item
    swappedItems.push(newItemDb);

    // 3. Build composition context from anchor for scoring
    const slotToCompCat = (mainCat: string): string => {
      const s = mapMainCategoryToSlot(mainCat);
      if (s === 'tops') return 'top';
      if (s === 'bottoms') return 'bottom';
      if (s === 'dresses') return 'dress';
      if (s === 'accessories') return 'accessory';
      return s; // shoes, outerwear, activewear, swimwear pass through
    };

    const compositionItems: CompositionItem[] = swappedItems.map((it) => ({
      id: it.id,
      category: slotToCompCat(it.main_category ?? ''),
      main_category: it.main_category,
      subcategory: it.subcategory,
      name: it.name,
      color: it.color,
      material: it.material,
    }));

    const fullItemMap = new Map(swappedItems.map((it) => [it.id, it]));
    const compositionScore = scoreOutfitComposition(
      compositionItems,
      fullItemMap,
      WardrobeService.SWAP_CATEGORY_FORMALITY,
      WardrobeService.SWAP_SUBCATEGORY_SIGNALS,
    );

    // 4. Build CatalogItem-shaped output for frontend compatibility
    const formatItem = (it: any, idx: number) => ({
      index: idx,
      id: it.id,
      name: it.name,
      label: it.name || it.label || 'Item',
      image: it.touched_up_image_url || it.processed_image_url || it.image_url,
      image_url: it.image_url,
      main_category: it.main_category,
      subcategory: it.subcategory,
      color: it.color,
      color_family: it.color_family,
      brand: it.brand,
      dress_code: it.dress_code,
      formality_score: it.formality_score,
      material: it.material,
      fit: it.fit,
    });

    const outfitItems = swappedItems.map(formatItem);

    // 5. Run taste validation (fail-close on hard fails → return null for safe regeneration)
    let validationPassed = true;
    try {
      const toVI = (it: any): ValidatorItem => ({
        id: it?.id ?? '',
        slot: (mapMainCategoryToSlot(it?.main_category) as ValidatorSlot) || ('accessories' as ValidatorSlot),
        name: it?.name ?? it?.label,
        subcategory: it?.subcategory,
        color: it?.color,
        material: it?.material,
        fit: it?.fit,
        dress_code: it?.dress_code,
        formality_score: it?.formality_score,
      });
      const eliteCtx = await this.loadEliteStyleContext(userId);
      const _bp = (eliteCtx as any)?._brainStyleProfile;
      const _tempToZone = (tempF?: number | null) => {
        if (tempF == null) return undefined;
        if (tempF < 32) return 'freezing' as const;
        if (tempF < 45) return 'cold' as const;
        if (tempF < 55) return 'cool' as const;
        if (tempF < 65) return 'mild' as const;
        if (tempF < 85) return 'warm' as const;
        return 'hot' as const;
      };
      const vCtx: ValidatorContext = {
        userPresentation: undefined,
        climateZone: _tempToZone(input.weather?.tempF),
        styleProfile: {
          ...(eliteCtx?.styleProfile ?? {}),
          coverage_no_go: _bp?.coverage_no_go,
          avoid_colors: _bp?.avoid_colors,
          avoid_materials: _bp?.avoid_materials,
          formality_floor: _bp?.formality_floor,
          walkability_requirement: _bp?.walkability_requirement,
        },
      };

      const vItems = swappedItems.map(toVI);
      const result = tasteValidateOutfit(vItems, vCtx);
      if (!result.valid) {
        console.log(`⚡ [SWAP] Taste validation FAIL (log-only, manual swap override): ${result.hardFails.join(', ')}`);
        validationPassed = false;
      }

      // Style veto check
      const vetoOutfit = {
        items: outfitItems,
        outfit_id: reqId,
      };
      const vetoResult = isStylisticallyIncoherent(vetoOutfit, {});
      if (vetoResult.invalid) {
        console.log(`⚡ [SWAP] Style veto FAIL (log-only, manual swap override): ${vetoResult.reason}`);
        validationPassed = false;
      }
    } catch (err) {
      console.warn('⚡ [SWAP] Validation error (log-only, manual swap override):', (err as any)?.message);
      validationPassed = false;
    }

    const elapsed = Date.now() - startTime;
    console.log(`⚡ [SWAP] Completed in ${elapsed}ms valid=${validationPassed} composition=${compositionScore.toFixed(3)}`);

    // LEARNING: manual swap override
    this.emitRefinementLearning(userId, 'SLOT_OVERRIDE', 1, 1.0, {
      entityId: reqId,
      entitySignature: 'refinement_item_override',
      itemIds: [input.newItemId],
      tags: ['manual_swap', input.swapSlot],
      metadata: { slot: input.swapSlot, selected_item_id: input.newItemId },
    });
    if (replacedItemId && replacedItemId !== input.newItemId) {
      this.emitRefinementLearning(userId, 'ITEM_EXPLICITLY_DISMISSED', -1, 0.9, {
        entityId: reqId,
        entitySignature: 'refinement_item_rejected',
        itemIds: [replacedItemId],
        tags: ['rejection', 'manual_swap', input.swapSlot],
        metadata: { slot: input.swapSlot, rejected_item_id: replacedItemId },
      });
    }

    const outfit = {
      outfit_id: reqId,
      title: 'Recomposed Outfit',
      items: outfitItems,
      why: validationPassed
        ? 'Slot swapped with composition-compatible item.'
        : 'Slot swapped per user selection (validation logged).',
      missing: undefined,
    };

    return {
      request_id: reqId,
      outfit_id: reqId,
      items: outfitItems,
      why: outfit.why,
      outfits: [outfit],
    };
  }

  /**
   * DETERMINISTIC OUTFIT MUTATION (Refine Path)
   *
   * Mutates a single slot in an existing outfit based on natural language refinement.
   * 1 Pinecone query for the changed slot. No LLM. No full generation.
   *
   * Flow:
   * 1. Parse refinement text → identify target slot
   * 2. Fetch current outfit items from DB
   * 3. Embed refinement text → 1 Pinecone query for target slot
   * 4. Rank candidates by composition compatibility
   * 5. Replace slot with best candidate
   * 6. Validate (taste + veto, fail-close on hard fails → return null)
   * 7. Return single mutated outfit (or null if hard fails → controller safe path)
   *
   * Returns null if parsing fails or no candidates found → caller falls back.
   */

  // ── Refinement constraint filter ──────────────────────────────────
  private static readonly REFINE_COLOR_FAMILIES = [
    'red', 'blue', 'navy', 'brown', 'black', 'white', 'gray', 'grey',
    'green', 'olive', 'tan', 'beige', 'cream', 'pink', 'purple', 'orange',
    'yellow', 'burgundy', 'maroon', 'teal', 'coral', 'gold', 'silver',
    'ivory', 'khaki', 'charcoal', 'camel',
  ];

  private static readonly REFINE_SUBTYPE_KEYWORDS: Record<string, string[]> = {
    shoes: ['sneakers', 'loafers', 'boots', 'derbies', 'oxfords', 'trainers', 'sandals', 'mules', 'heels', 'pumps', 'flats', 'slides', 'espadrilles', 'moccasins', 'clogs'],
    tops: ['hoodie', 'sweater', 't-shirt', 'tshirt', 'shirt', 'blouse', 'tank', 'polo', 'henley', 'cardigan', 'turtleneck', 'crop top', 'camisole', 'tunic'],
    outerwear: ['blazer', 'coat', 'jacket', 'parka', 'vest', 'windbreaker', 'trench', 'bomber', 'peacoat', 'overcoat', 'anorak', 'cape', 'poncho'],
    bottoms: ['jeans', 'chinos', 'trousers', 'pants', 'shorts', 'skirt', 'leggings', 'joggers', 'culottes', 'cargo'],
    dresses: ['dress', 'gown', 'romper', 'jumpsuit'],
  };

  private static parseRefinementConstraints(
    refinementPrompt: string,
    targetSlot: string,
  ): { colors: string[]; subtypes: string[] } {
    const lower = refinementPrompt.toLowerCase();
    const colors = WardrobeService.REFINE_COLOR_FAMILIES.filter(
      (c) => new RegExp(`\\b${c}\\b`).test(lower),
    );
    const slotKeywords = WardrobeService.REFINE_SUBTYPE_KEYWORDS[targetSlot] ?? [];
    const subtypes = slotKeywords.filter((kw) => lower.includes(kw));
    return { colors, subtypes };
  }

  private static filterCandidatesByRefinementIntent(
    candidates: any[],
    refinementPrompt: string,
    targetSlot: string,
  ): { filtered: any[]; colors: string[]; subtypes: string[] } {
    const { colors, subtypes } = WardrobeService.parseRefinementConstraints(refinementPrompt, targetSlot);

    if (colors.length === 0 && subtypes.length === 0) {
      return { filtered: candidates, colors, subtypes };
    }

    console.log(`REFINE_CONSTRAINTS_PARSED ${JSON.stringify({ slot: targetSlot, colors, subtypes })}`);
    console.log(`REFINE_POOL_BEFORE ${JSON.stringify({ count: candidates.length })}`);

    const filtered = candidates.filter((c) => {
      const cColor = (c.color || c.color_family || '').toLowerCase();
      const cName = (c.name || '').toLowerCase();
      const cSub = (c.subcategory || '').toLowerCase();

      const colorMatch =
        colors.length === 0 ||
        colors.some((col) => cColor.includes(col) || cName.includes(col));

      const subtypeMatch =
        subtypes.length === 0 ||
        subtypes.some((st) => cSub.includes(st) || cName.includes(st));

      return colorMatch && subtypeMatch;
    });

    console.log(`REFINE_POOL_AFTER ${JSON.stringify({ count: filtered.length })}`);

    if (filtered.length === 0) {
      console.log('REFINE_CONSTRAINTS_EMPTY_FALLBACK');
      return { filtered: candidates, colors, subtypes };
    }

    return { filtered, colors, subtypes };
  }

  // ── Escalation intent detection ──────────────────────────────────
  private static readonly ESCALATION_KEYWORDS = [
    'better', 'stronger', 'sharper', 'more elite', 'elevate', 'upgrade',
    'more formal', 'higher level', 'premium', 'nicer', 'dressier',
    'classier', 'more polished', 'step up', 'level up', 'refined',
    'powerful', 'executive', 'commanding', 'authoritative',
    'stronger presence', 'more serious', 'boardroom ready', 'boardroom',
    'more senior', 'more dominant', 'more commanding', 'more presence',
    'more authority',
  ];

  private static detectEscalationIntent(prompt: string): boolean {
    const lower = prompt.toLowerCase();
    return WardrobeService.ESCALATION_KEYWORDS.some((kw) => lower.includes(kw));
  }

  /**
   * Derives a formality tier (0–4) from subcategory/name using SWAP_SUBCATEGORY_SIGNALS.
   * Same logic as composition.ts deriveFormalityScore but scoped to studio-only usage.
   */
  private static inferFormalityTier(item: any): number {
    const sub = (item.subcategory || '').toLowerCase();
    const name = (item.name || '').toLowerCase();
    const mainCat = (item.main_category || '').toLowerCase();

    if (mainCat === 'formalwear' || mainCat === 'suits') return 4;

    const combined = `${sub} ${name}`;
    for (const [tier, signals] of WardrobeService.SWAP_SUBCATEGORY_SIGNALS) {
      if (signals.some((s) => combined.includes(s))) return tier;
    }

    const cat = mapMainCategoryToSlot(item.main_category ?? '');
    return WardrobeService.SWAP_CATEGORY_FORMALITY[cat] ?? 2;
  }

  private static computeIntentBonus(
    candidate: any,
    colors: string[],
    subtypes: string[],
  ): { bonus: number; colorMatch: 'exact' | 'family' | 'none'; subtypeMatch: boolean } {
    if (colors.length === 0 && subtypes.length === 0) {
      return { bonus: 0, colorMatch: 'none', subtypeMatch: false };
    }

    const cColor = (candidate.color || '').toLowerCase();
    const cColorFamily = (candidate.color_family || '').toLowerCase();
    const cName = (candidate.name || '').toLowerCase();
    const cSub = (candidate.subcategory || '').toLowerCase();

    let colorMatch: 'exact' | 'family' | 'none' = 'none';
    if (colors.length > 0) {
      if (colors.some((col) => cColor === col || cColor.startsWith(col + ' '))) {
        colorMatch = 'exact';
      } else if (colors.some((col) => cColorFamily.includes(col) || cName.includes(col) || cColor.includes(col))) {
        colorMatch = 'family';
      }
    }

    const subtypeMatch = subtypes.length > 0 &&
      subtypes.some((st) => cSub.includes(st) || cName.includes(st));

    let bonus = 0;
    if (colorMatch === 'exact') bonus += 0.35;
    else if (colorMatch === 'family') bonus += 0.20;
    if (subtypeMatch) bonus += 0.35;

    return { bonus, colorMatch, subtypeMatch };
  }

  async mutateOutfit(
    userId: string,
    input: {
      currentItemIds: string[];
      refinementPrompt: string;
      weather?: WeatherContext;
      requestId?: string;
    },
  ) {
    const startTime = Date.now();
    const reqId = input.requestId || randomUUID();

    // LEARNING: pure logging accept — early exit before any refinement logic
    if ((input as any).learning_accept === true) {
      this.emitRefinementLearning(userId, 'STYLE_CONSTRAINT_SIGNAL', 1, 0.7, {
        entityId: reqId,
        entitySignature: 'refinement_applied',
        itemIds: input.currentItemIds,
        tags: ['explicit_accept'],
        metadata: { outfit_id: reqId },
      });
      return {
        request_id: reqId,
        outfit_id: reqId,
        items: input.currentItemIds.map((id) => ({ id })),
        why: 'accepted',
        outfits: [],
      };
    }

    // 1. Parse which slot to CHANGE (not keep)
    //    "Keep the shirt and slacks but give me brown shoes instead"
    //    → change zone = "give me brown shoes instead" → shoes
    //    Split on change markers; detect slots in change zone only.
    const lower = input.refinementPrompt.toLowerCase();
    const changeMarkers = /\b(but|instead|give me|swap|change|replace|switch|try|want|different|another|new)\b/;
    const markerMatch = lower.match(changeMarkers);
    let changeZone = lower; // default: whole prompt
    if (markerMatch && markerMatch.index != null) {
      changeZone = lower.substring(markerMatch.index);
    }
    // Strip keep phrases but ONLY up to the next comma or "and" — NOT to end-of-string.
    // "keep everything except the shoes" → strip "keep everything" up to "except", preserve "the shoes".
    // The old regex .*?(and|,|$) consumed to $ which destroyed the entire prompt.
    const keepPhrases = /\b(keep|love|like|don't change|leave)\b[^,]*(and|,)/gi;
    changeZone = changeZone.replace(keepPhrases, ' ');
    // Also handle "except/but" after keep — promote everything AFTER except/but as the change zone
    const exceptMatch = changeZone.match(/\b(except|but|other than|aside from)\b\s*(.*)/i);
    if (exceptMatch && exceptMatch[2]) {
      changeZone = exceptMatch[2];
    }

    const detectedSlots = detectSlotsInText(changeZone);
    if (detectedSlots.length === 0) {
      // Fallback: try full prompt (maybe no change marker, e.g. "brown shoes please")
      const fallbackSlots = detectSlotsInText(lower);
      if (fallbackSlots.length !== 1) {
        console.log(`MUTATE_OUTFIT_NULL { reason: "slot_parse_failed: changeZone detected ${detectedSlots.length} slots, full prompt detected ${fallbackSlots.length} slots from '${input.refinementPrompt}'" }`);
        return null;
      }
      detectedSlots.push(fallbackSlots[0]);
    }
    if (detectedSlots.length !== 1) {
      console.log(`MUTATE_OUTFIT_NULL { reason: "ambiguous_slots: detected ${detectedSlots.length} slots [${detectedSlots.join(',')}] from '${input.refinementPrompt}'" }`);
      return null;
    }
    const targetSlot: Slot = detectedSlots[0];
    console.log(`⚡ [MUTATE] reqId=${reqId} slot=${targetSlot} prompt="${input.refinementPrompt}"`);

    // 2. Fetch current outfit items from DB
    const { rows: currentDbItems } = await pool.query(
      `SELECT id, name, image_url, touched_up_image_url, processed_image_url,
              main_category, subcategory, color, color_family, brand,
              dress_code, formality_score, material, fit
       FROM wardrobe_items
       WHERE id = ANY($1) AND user_id = $2`,
      [input.currentItemIds, userId],
    );
    if (currentDbItems.length === 0) {
      console.log(`MUTATE_OUTFIT_NULL { reason: "no_current_items: none of ${input.currentItemIds.length} IDs found in DB for user" }`);
      return null;
    }

    // Split into kept items vs items in the target slot
    const keptItems: any[] = [];
    const oldSlotItems: any[] = [];
    for (const row of currentDbItems) {
      if (mapMainCategoryToSlot(row.main_category) === targetSlot) {
        oldSlotItems.push(row);
      } else {
        keptItems.push(row);
      }
    }

    // ── REMOVAL EARLY-RETURN: if user wants to remove a slot, skip all ranking ──
    const isRemoval = WardrobeService.detectRemovalIntent(input.refinementPrompt);
    if (isRemoval && WardrobeService.REMOVABLE_SLOTS.has(targetSlot)) {
      // Use explicit keyword slot if main parser yielded a different removable slot
      const removalSlot = WardrobeService.inferRemovalSlot(input.refinementPrompt) ?? targetSlot;
      if (!WardrobeService.REMOVABLE_SLOTS.has(removalSlot)) {
        // Inferred slot is non-removable (e.g., tops/bottoms/shoes) → preserve existing behavior
        console.log(`REMOVAL_BLOCKED ${JSON.stringify({ prompt: input.refinementPrompt, slot: removalSlot, reason: 'non-removable slot' })}`);
      } else {
        const removedItem = oldSlotItems[0];
        console.log(`REMOVAL_DETECTED ${JSON.stringify({ prompt: input.refinementPrompt, slot: removalSlot })}`);

        // Re-split if inferRemovalSlot gave a different slot than parser
        let finalKeptItems = keptItems;
        if (removalSlot !== targetSlot) {
          finalKeptItems = [];
          for (const row of currentDbItems) {
            if (mapMainCategoryToSlot(row.main_category) !== removalSlot) {
              finalKeptItems.push(row);
            }
          }
        }

        const formatItem = (it: any, idx: number) => ({
          index: idx,
          id: it.id,
          name: it.name,
          label: it.name || 'Item',
          image: it.touched_up_image_url || it.processed_image_url || it.image_url,
          image_url: it.image_url,
          main_category: it.main_category,
          subcategory: it.subcategory,
          color: it.color,
          color_family: it.color_family,
          brand: it.brand,
          dress_code: it.dress_code,
          formality_score: it.formality_score,
          material: it.material,
          fit: it.fit,
        });
        const outfitItems = finalKeptItems.map(formatItem);

        const elapsed = Date.now() - startTime;
        console.log(`REMOVE_OUTFIT_SUCCESS ${JSON.stringify({ slot: removalSlot, removedItemId: removedItem?.id, reason: 'user_remove_intent', elapsedMs: elapsed })}`);

        this.emitRefinementLearning(userId, 'SLOT_OVERRIDE', 1, 0.8, {
          entityId: reqId,
          entitySignature: 'refinement_item_removed',
          tags: ['removal', removalSlot],
          metadata: { slot: removalSlot, removed_item_id: removedItem?.id },
        });
        if (removedItem?.id) {
          this.emitRefinementLearning(userId, 'ITEM_EXPLICITLY_DISMISSED', -1, 0.8, {
            entityId: reqId,
            entitySignature: 'refinement_item_rejected',
            itemIds: [removedItem.id],
            tags: ['rejection', 'removal', removalSlot],
          });
        }

        const outfit = {
          outfit_id: reqId,
          title: 'Refined Outfit',
          items: outfitItems,
          why: `Removed ${removalSlot} per your request.`,
          missing: undefined,
        };

        return {
          request_id: reqId,
          outfit_id: reqId,
          items: outfitItems,
          why: outfit.why,
          outfits: [outfit],
        };
      }
    }

    // 3. Single Pinecone query for the target slot
    const slotFilter = pineconeFilterForSlot(targetSlot);
    let candidateIds: string[] = [];
    try {
      const queryVec = await this.vertex.embedText(input.refinementPrompt);
      const matches = await queryUserNs({
        userId,
        vector: queryVec,
        topK: 20,
        includeMetadata: true,
        filter: { ...slotFilter, kind: { $eq: 'text' } },
      });
      candidateIds = (matches || [])
        .map((m: any) => {
          const raw: string = m.metadata?.db_id || m.id || '';
          // Pinecone IDs may have ":text" or ":image" suffix — strip to pure UUID
          const normalized = raw.includes(':') ? raw.split(':')[0] : raw;
          if (raw !== normalized) {
            console.log(`MUTATE_ID_NORMALIZED { before: "${raw}", after: "${normalized}" }`);
          }
          return normalized;
        })
        .filter(Boolean);
    } catch (err) {
      console.warn('⚡ [MUTATE] Pinecone query failed (falling back to DB):', (err as any)?.message);
    }

    // Fallback: if Pinecone returned nothing, query DB directly for slot items
    if (candidateIds.length === 0) {
      const mainCats = Object.values(REFINEMENT_CATEGORY_KEYWORDS).length > 0
        ? (() => {
            // Get main categories for the target slot from the Pinecone filter
            const f = slotFilter?.main_category;
            if (f?.$eq) return [f.$eq];
            if (f?.$in) return f.$in;
            return [];
          })()
        : [];
      if (mainCats.length > 0) {
        const { rows: fallbackRows } = await pool.query(
          `SELECT id FROM wardrobe_items
           WHERE user_id = $1 AND main_category = ANY($2)
           ORDER BY created_at DESC LIMIT 30`,
          [userId, mainCats],
        );
        candidateIds = fallbackRows.map((r: any) => r.id);
      }
    }

    // Exclude items already in the outfit
    const currentIdSet = new Set(input.currentItemIds);
    candidateIds = candidateIds.filter((id) => !currentIdSet.has(id));

    if (candidateIds.length === 0) {
      console.log(`MUTATE_OUTFIT_NULL { reason: "no_candidates: pinecone returned 0 and DB fallback returned 0 for slot=${targetSlot}" }`);
      return null;
    }

    // 4. Fetch candidate DB rows
    const { rows: candidateRows } = await pool.query(
      `SELECT id, name, image_url, touched_up_image_url, processed_image_url,
              main_category, subcategory, color, color_family, brand,
              dress_code, formality_score, material, fit
       FROM wardrobe_items
       WHERE id = ANY($1) AND user_id = $2`,
      [candidateIds, userId],
    );

    if (candidateRows.length === 0) {
      console.log(`MUTATE_OUTFIT_NULL { reason: "no_candidate_rows: ${candidateIds.length} IDs from pinecone/fallback but 0 matched in DB for slot=${targetSlot}" }`);
      return null;
    }

    // 4b. Filter candidates by explicit user constraints (color, subtype)
    const {
      filtered: filteredCandidateRows,
      colors: refineColors,
      subtypes: refineSubtypes,
    } = WardrobeService.filterCandidatesByRefinementIntent(
      candidateRows,
      input.refinementPrompt,
      targetSlot,
    );

    // 5. Score candidates with composition
    const slotToCompCat = (mainCat: string): string => {
      const s = mapMainCategoryToSlot(mainCat);
      if (s === 'tops') return 'top';
      if (s === 'bottoms') return 'bottom';
      if (s === 'dresses') return 'dress';
      if (s === 'accessories') return 'accessory';
      return s;
    };

    // Build composition items from kept items for context
    const contextItems: CompositionItem[] = keptItems.map((it: any) => ({
      id: it.id,
      category: slotToCompCat(it.main_category ?? ''),
      main_category: it.main_category,
      subcategory: it.subcategory,
      name: it.name,
      color: it.color,
      material: it.material,
    }));

    // Score each candidate
    let bestCandidate: any = filteredCandidateRows[0];
    let bestScore = -Infinity;
    const fullItemMap = new Map(
      [...keptItems, ...filteredCandidateRows].map((it: any) => [it.id, it]),
    );

    // 5a. Detect escalation intent for quality-biased ranking
    const isEscalation = WardrobeService.detectEscalationIntent(input.refinementPrompt);
    const originalSlotItem = oldSlotItems[0];
    const originalFormalityTier = originalSlotItem
      ? WardrobeService.inferFormalityTier(originalSlotItem)
      : -1;

    // Compute styleJudge score for original outfit (baseline for escalation comparison)
    let originalJudgeScore = 0;
    if (isEscalation) {
      const originalJudgeOutfit = {
        items: [...keptItems, ...(originalSlotItem ? [originalSlotItem] : [])].map((it: any) => ({
          id: it.id,
          name: it.name,
          main_category: it.main_category,
          subcategory: it.subcategory,
          color: it.color,
          color_family: it.color_family,
          material: it.material,
          formality_score: it.formality_score,
          dress_code: it.dress_code,
        })),
      };
      originalJudgeScore = scoreOutfit(originalJudgeOutfit, {}).total;
      console.log(`ESCALATION_DETECTED ${JSON.stringify({ prompt: input.refinementPrompt, originalFormalityTier, originalJudgeScore })}`);

      this.emitRefinementLearning(userId, 'STYLE_CONSTRAINT_SIGNAL', 1, 0.6, {
        entityId: reqId,
        entitySignature: 'refinement_escalation_requested',
        tags: ['escalation', targetSlot],
        metadata: { slot: targetSlot, request_text: input.refinementPrompt },
      });
    }

    // Scored candidate list for escalation re-ranking
    const scoredCandidates: Array<{
      candidate: any;
      compositionScore: number;
      intentBonus: number;
      judgeScore: number;
      formalityTier: number;
      finalScore: number;
    }> = [];

    for (const candidate of filteredCandidateRows) {
      const testItems: CompositionItem[] = [
        ...contextItems,
        {
          id: candidate.id,
          category: slotToCompCat(candidate.main_category ?? ''),
          main_category: candidate.main_category,
          subcategory: candidate.subcategory,
          name: candidate.name,
          color: candidate.color,
          material: candidate.material,
        },
      ];
      const baseScore = scoreOutfitComposition(
        testItems,
        fullItemMap,
        WardrobeService.SWAP_CATEGORY_FORMALITY,
        WardrobeService.SWAP_SUBCATEGORY_SIGNALS,
      );
      const { bonus, colorMatch, subtypeMatch } = WardrobeService.computeIntentBonus(
        candidate, refineColors, refineSubtypes,
      );
      const compositeScore = Math.min(baseScore + bonus, 1.0);
      if (bonus > 0) {
        console.log(`REFINE_INTENT_SCORE ${JSON.stringify({ itemId: candidate.id, baseScore: +baseScore.toFixed(3), bonus: +bonus.toFixed(2), finalScore: +compositeScore.toFixed(3), colorMatch, subtypeMatch })}`);
      }

      // Compute escalation metrics (judge score + formality tier) for all candidates
      // when escalation is active; zero-cost when not
      let judgeScore = 0;
      let formalityTier = 0;
      if (isEscalation) {
        formalityTier = WardrobeService.inferFormalityTier(candidate);
        const candidateJudgeOutfit = {
          items: [...keptItems, candidate].map((it: any) => ({
            id: it.id,
            name: it.name,
            main_category: it.main_category,
            subcategory: it.subcategory,
            color: it.color,
            color_family: it.color_family,
            material: it.material,
            formality_score: it.formality_score,
            dress_code: it.dress_code,
          })),
        };
        judgeScore = scoreOutfit(candidateJudgeOutfit, {}).total;
      }

      scoredCandidates.push({
        candidate,
        compositionScore: compositeScore,
        intentBonus: bonus,
        judgeScore,
        formalityTier,
        finalScore: compositeScore, // base; may be adjusted below
      });
    }

    // 5b. Escalation re-ranking: bias toward higher judge score + higher formality
    if (isEscalation && scoredCandidates.length > 0) {
      // ── HARD GUARD: reject candidates with formality tier below original ──
      const poolSizeBeforeFilter = scoredCandidates.length;
      const downgradedIds: string[] = [];
      for (let i = scoredCandidates.length - 1; i >= 0; i--) {
        if (scoredCandidates[i].formalityTier < originalFormalityTier) {
          downgradedIds.push(scoredCandidates[i].candidate.id);
          scoredCandidates.splice(i, 1);
        }
      }
      if (downgradedIds.length > 0) {
        console.log(`ESCALATION_DOWNGRADE_BLOCKED ${JSON.stringify({ blocked: downgradedIds.length, originalTier: originalFormalityTier, poolSizeBeforeFilter })}`);
      }

      // If no candidates survive the tier guard → return original outfit unchanged
      if (scoredCandidates.length === 0) {
        const elapsed = Date.now() - startTime;
        console.log(`ESCALATION_NO_UPGRADE_AVAILABLE ${JSON.stringify({ originalTier: originalFormalityTier, poolSizeBeforeFilter, elapsedMs: elapsed })}`);

        // Return original outfit as-is — maintain dignity, no downgrade
        const originalItems = currentDbItems;
        const formatItemOriginal = (it: any, idx: number) => ({
          index: idx,
          id: it.id,
          name: it.name,
          label: it.name || 'Item',
          image: it.touched_up_image_url || it.processed_image_url || it.image_url,
          image_url: it.image_url,
          main_category: it.main_category,
          subcategory: it.subcategory,
          color: it.color,
          color_family: it.color_family,
          brand: it.brand,
          dress_code: it.dress_code,
          formality_score: it.formality_score,
          material: it.material,
          fit: it.fit,
        });
        const originalOutfitItems = originalItems.map(formatItemOriginal);
        const outfit = {
          outfit_id: reqId,
          title: 'Refined Outfit',
          items: originalOutfitItems,
          why: 'No higher-formality option available. Keeping current outfit.',
          missing: undefined,
        };
        return {
          request_id: reqId,
          outfit_id: reqId,
          items: originalOutfitItems,
          why: outfit.why,
          outfits: [outfit],
        };
      }

      for (const sc of scoredCandidates) {
        let escalationBonus = 0;

        // Reward candidates that produce a higher styleJudge total than original
        const judgeDelta = sc.judgeScore - originalJudgeScore;
        if (judgeDelta > 0) {
          // Normalize: +10 judge points → +0.15 bonus (capped at +0.30)
          escalationBonus += Math.min(judgeDelta * 0.015, 0.30);
        }

        // Reward formality tier upgrade (penalize lateral/downgrade)
        const formalityDelta = sc.formalityTier - originalFormalityTier;
        if (formalityDelta > 0) {
          // Each tier up → +0.10 bonus (capped at +0.20)
          escalationBonus += Math.min(formalityDelta * 0.10, 0.20);
        } else if (formalityDelta === 0 && originalFormalityTier >= 0) {
          // Lateral swap penalty: same tier as original → small penalty to prefer upgrades
          escalationBonus -= 0.05;
        }

        sc.finalScore = Math.min(sc.compositionScore + escalationBonus, 1.0);
      }

      // Sort by final score descending; ties broken by judge score
      scoredCandidates.sort((a, b) =>
        b.finalScore !== a.finalScore
          ? b.finalScore - a.finalScore
          : b.judgeScore - a.judgeScore,
      );

      console.log(`ESCALATION_RANKING ${JSON.stringify({
        topCandidates: scoredCandidates.slice(0, 3).map((sc) => ({
          id: sc.candidate.id,
          name: sc.candidate.name,
          compositionScore: +sc.compositionScore.toFixed(3),
          judgeScore: sc.judgeScore,
          formalityTier: sc.formalityTier,
          finalScore: +sc.finalScore.toFixed(3),
        })),
        originalJudgeScore,
        originalFormalityTier,
        poolSizeBeforeFilter,
        poolSizeAfterFilter: scoredCandidates.length,
      })}`);

      bestCandidate = scoredCandidates[0].candidate;
      bestScore = scoredCandidates[0].finalScore;
    } else {
      // Non-escalation: pick best by composition + intent (original logic)
      for (const sc of scoredCandidates) {
        if (sc.finalScore > bestScore) {
          bestScore = sc.finalScore;
          bestCandidate = sc.candidate;
        }
      }
    }

    // 6. Build the mutated outfit
    const allItems = [...keptItems, bestCandidate];
    const formatItem = (it: any, idx: number) => ({
      index: idx,
      id: it.id,
      name: it.name,
      label: it.name || 'Item',
      image: it.touched_up_image_url || it.processed_image_url || it.image_url,
      image_url: it.image_url,
      main_category: it.main_category,
      subcategory: it.subcategory,
      color: it.color,
      color_family: it.color_family,
      brand: it.brand,
      dress_code: it.dress_code,
      formality_score: it.formality_score,
      material: it.material,
      fit: it.fit,
    });
    const outfitItems = allItems.map(formatItem);

    // 7. Validate (fail-close on hard fails → return null for safe regeneration)
    let validationPassed = true;
    try {
      const toVI = (it: any): ValidatorItem => ({
        id: it?.id ?? '',
        slot: (mapMainCategoryToSlot(it?.main_category) as ValidatorSlot) || ('accessories' as ValidatorSlot),
        name: it?.name ?? it?.label,
        subcategory: it?.subcategory,
        color: it?.color,
        material: it?.material,
        fit: it?.fit,
        dress_code: it?.dress_code,
        formality_score: it?.formality_score,
      });
      const eliteCtx = await this.loadEliteStyleContext(userId);
      const _bp = (eliteCtx as any)?._brainStyleProfile;
      const _tempToZone = (tempF?: number | null) => {
        if (tempF == null) return undefined;
        if (tempF < 32) return 'freezing' as const;
        if (tempF < 45) return 'cold' as const;
        if (tempF < 55) return 'cool' as const;
        if (tempF < 65) return 'mild' as const;
        if (tempF < 85) return 'warm' as const;
        return 'hot' as const;
      };
      const vCtx: ValidatorContext = {
        userPresentation: undefined,
        climateZone: _tempToZone(input.weather?.tempF),
        styleProfile: {
          ...(eliteCtx?.styleProfile ?? {}),
          coverage_no_go: _bp?.coverage_no_go,
          avoid_colors: _bp?.avoid_colors,
          avoid_materials: _bp?.avoid_materials,
          formality_floor: _bp?.formality_floor,
          walkability_requirement: _bp?.walkability_requirement,
        },
      };
      const vItems = allItems.map(toVI);
      const result = tasteValidateOutfit(vItems, vCtx);
      if (!result.valid) {
        console.log(`⚡ [MUTATE] Taste validation HARD FAIL (fail-close): ${result.hardFails.join(', ')}`);
        validationPassed = false;
      }

      const vetoOutfit = { items: outfitItems, outfit_id: reqId };
      const vetoResult = isStylisticallyIncoherent(vetoOutfit, {});
      if (vetoResult.invalid) {
        console.log(`⚡ [MUTATE] Style veto HARD FAIL (fail-close): ${vetoResult.reason}`);
        validationPassed = false;
      }
    } catch (err) {
      console.warn('⚡ [MUTATE] Validation error (fail-close):', (err as any)?.message);
      validationPassed = false;
    }

    const elapsed = Date.now() - startTime;

    // 8. Fail-close: if hard validation failures exist, return null so controller
    //    falls through to generateOutfitsFast() which has the full repair pipeline.
    if (!validationPassed) {
      console.log(
        JSON.stringify({
          _tag: 'MUTATE_FAIL_CLOSE',
          reqId,
          slot: targetSlot,
          candidateId: bestCandidate.id,
          reason: 'hard validation failure in mutateOutfit, delegating to safe path',
          elapsedMs: elapsed,
        }),
      );
      return null;
    }

    console.log(`MUTATE_OUTFIT_SUCCESS { reason: "slot=${targetSlot} candidate=${bestCandidate.id} score=${bestScore.toFixed(3)} elapsed=${elapsed}ms valid=${validationPassed}" }`);

    const outfit = {
      outfit_id: reqId,
      title: 'Refined Outfit',
      items: outfitItems,
      why: 'Outfit refined with composition-compatible replacement.',
      missing: undefined,
    };

    return {
      request_id: reqId,
      outfit_id: reqId,
      items: outfitItems,
      why: outfit.why,
      outfits: [outfit],
    };
  }

  /**
   * Maps slot category to Pinecone metadata filter.
   * Uses canonical categoryMapping - ALWAYS returns a filter, NEVER undefined.
   */
  private mapSlotCategoryToFilter(category: string): Record<string, any> {
    const slot = mapPlanCategoryToSlot(category);
    return pineconeFilterForSlot(slot);
  }

  /**
   * Maps slot category to main_category string for comparison.
   * Uses canonical categoryMapping.
   */
  private slotCategoryToMainCategory(category: string): string {
    // For comparison purposes, we use the plan category directly
    // as Pinecone stores the original main_category
    return SLOT_TO_PLAN_CATEGORY[mapPlanCategoryToSlot(category)];
  }

  /**
   * Converts a database row to CatalogItem format
   */
  private dbRowToCatalogItem(row: any, index = 0): CatalogItem {
    return {
      index,
      id: row.id,
      name: row.name || undefined,
      label: row.name || 'Unknown Item',
      image:
        row.touched_up_image_url || row.processed_image_url || row.image_url,
      image_url: row.image_url,
      main_category: row.main_category,
      subcategory: row.subcategory,
      color: row.color,
      color_family: row.color_family,
      brand: row.brand,
      dress_code: row.dress_code,
      formality_score: row.formality_score,
      material: row.material,
    };
  }

  /**
   * Defensive extractor for various LLM wrapper shapes.
   */
  private extractModelText(output: any): string {
    if (typeof output === 'string') return output;

    const parts = output?.candidates?.[0]?.content?.parts;
    if (Array.isArray(parts)) {
      const joined = parts.map((p: any) => p?.text ?? '').join('');
      if (joined) return joined;
    }
    if (typeof output?.text === 'string') return output.text;
    return JSON.stringify(output ?? '');
  }

  private parseModelJson(s: string): any {
    const cleaned = s
      .replace(/^\s*```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/i, '')
      .trim();

    try {
      return JSON.parse(cleaned);
    } catch {
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (m) return JSON.parse(m[0]);
      throw new Error('Model did not return valid JSON.');
    }
  }

  // More text-normalizers
  private normalizeDressCode(val?: string | null) {
    const s = this.normLower(val);
    if (!s) return undefined;
    const map: Record<
      string,
      | 'UltraCasual'
      | 'Casual'
      | 'SmartCasual'
      | 'BusinessCasual'
      | 'Business'
      | 'BlackTie'
    > = {
      ultracasual: 'UltraCasual',
      ultra_casual: 'UltraCasual',
      casual: 'Casual',
      smartcasual: 'SmartCasual',
      smart_casual: 'SmartCasual',
      businesscasual: 'BusinessCasual',
      business_casual: 'BusinessCasual',
      business: 'Business',
      blacktie: 'BlackTie',
      black_tie: 'BlackTie',
      'black tie': 'BlackTie',
    };
    return map[s];
  }
  private normalizeLayering(val?: string | null) {
    const s = this.normLower(val);
    if (!s) return undefined;
    const map: Record<string, string> = {
      base: 'BASE',
      baselayer: 'BASE',
      'base layer': 'BASE',
      mid: 'MID',
      midlayer: 'MID',
      'mid layer': 'MID',
      shell: 'SHELL',
      outer: 'SHELL',
      outerwear: 'SHELL',
      jacket: 'SHELL',
      accent: 'ACCENT',
      accessory: 'ACCENT',
      acc: 'ACCENT',
    };
    return map[s];
  }

  // DTO-facing normalizers
  private normalizeMainCategory(
    val?: string | null,
  ): CreateWardrobeItemDto['main_category'] {
    const unions: CreateWardrobeItemDto['main_category'][] = [
      'Tops',
      'Bottoms',
      'Outerwear',
      'Shoes',
      'Accessories',
      'Undergarments',
      'Activewear',
      'Formalwear',
      'Loungewear',
      'Sleepwear',
      'Swimwear',
      'Maternity',
      'Unisex',
      'Costumes',
      'TraditionalWear',
      'Dresses',
      'Skirts',
      'Bags',
      'Headwear',
      'Jewelry',
      'Other',
    ];
    const raw = (val ?? '').toString().trim();
    if (unions.includes(raw as any))
      return raw as CreateWardrobeItemDto['main_category'];
    const s = raw.toLowerCase();
    if (/\bdress(es)?\b/i.test(s)) return 'Dresses';
    const map: Record<string, CreateWardrobeItemDto['main_category']> = {
      top: 'Tops',
      tops: 'Tops',
      tshirt: 'Tops',
      't-shirt': 'Tops',
      tee: 'Tops',
      shirt: 'Tops',
      blouse: 'Tops',
      knit: 'Tops',
      sweater: 'Tops',
      bottom: 'Bottoms',
      bottoms: 'Bottoms',
      pants: 'Bottoms',
      trousers: 'Bottoms',
      jeans: 'Bottoms',
      chinos: 'Bottoms',
      shorts: 'Bottoms',
      skirt: 'Skirts',
      outer: 'Outerwear',
      outerwear: 'Outerwear',
      jacket: 'Outerwear',
      coat: 'Outerwear',
      parka: 'Outerwear',
      blazer: 'Outerwear',
      shoe: 'Shoes',
      shoes: 'Shoes',
      sneaker: 'Shoes',
      sneakers: 'Shoes',
      boot: 'Shoes',
      boots: 'Shoes',
      heel: 'Shoes',
      loafers: 'Shoes',
      accessory: 'Accessories',
      accessories: 'Accessories',
      bag: 'Bags',
      belt: 'Accessories',
      hat: 'Headwear',
      scarf: 'Accessories',
      tie: 'Accessories',
      sunglasses: 'Accessories',
      watch: 'Accessories',
      underwear: 'Undergarments',
      undergarments: 'Undergarments',
      bra: 'Undergarments',
      briefs: 'Undergarments',
      socks: 'Undergarments',
      active: 'Activewear',
      activewear: 'Activewear',
      athleisure: 'Activewear',
      gym: 'Activewear',
      formal: 'Formalwear',
      formalwear: 'Formalwear',
      suit: 'Formalwear',
      tuxedo: 'Formalwear',
      lounge: 'Loungewear',
      loungewear: 'Loungewear',
      sweats: 'Loungewear',
      sleep: 'Sleepwear',
      sleepwear: 'Sleepwear',
      pajama: 'Sleepwear',
      pajamas: 'Sleepwear',
      swim: 'Swimwear',
      swimwear: 'Swimwear',
      swimsuit: 'Swimwear',
      trunks: 'Swimwear',
      bikini: 'Swimwear',
      maternity: 'Maternity',
      unisex: 'Unisex',
      costume: 'Costumes',
      costumes: 'Costumes',
      'traditional wear': 'TraditionalWear',
      traditionalwear: 'TraditionalWear',
      kimono: 'TraditionalWear',
      sari: 'TraditionalWear',
      dress: 'Dresses',
      dresses: 'Dresses',
      skirts: 'Skirts',
      bags: 'Bags',
      handbag: 'Bags',
      handbags: 'Bags',
      tote: 'Bags',
      clutch: 'Bags',
      crossbody: 'Bags',
      headwear: 'Headwear',
      beanie: 'Headwear',
      fedora: 'Headwear',
      cap: 'Headwear',
      jewelry: 'Jewelry',
      necklace: 'Jewelry',
      bracelet: 'Jewelry',
      earrings: 'Jewelry',
      ring: 'Jewelry',
      other: 'Other',
    };
    return map[s] ?? 'Tops';
  }
  private resolveMainCategory(
    rawMain?: string | null,
    sub?: string | null,
    layering?: string | null,
  ): CreateWardrobeItemDto['main_category'] {
    const normalized = this.normalizeMainCategory(rawMain);
    // If normalizeMainCategory already resolved to a specific new category,
    // skip subcategory coercion — these categories are canonical and should
    // not be overridden by legacy subcategory keyword checks.
    const newCategories: CreateWardrobeItemDto['main_category'][] = [
      'Dresses',
      'Skirts',
      'Bags',
      'Headwear',
      'Jewelry',
      'Other',
      'Loungewear',
      'Sleepwear',
      'Swimwear',
      'Maternity',
      'Unisex',
      'Costumes',
      'TraditionalWear',
    ];
    if (newCategories.includes(normalized)) return normalized;
    const s = (sub ?? '').toLowerCase();
    const lay = (layering ?? '').toUpperCase();
    if (
      [
        'blazer',
        'sport coat',
        'sportcoat',
        'suit jacket',
        'jacket',
        'coat',
        'parka',
        'trench',
        'overcoat',
        'topcoat',
      ].some((k) => s.includes(k))
    )
      return 'Outerwear';
    if (
      [
        'loafer',
        'loafers',
        'sneaker',
        'sneakers',
        'boot',
        'boots',
        'heel',
        'heels',
        'pump',
        'oxford',
        'derby',
        'dress shoe',
        'dress shoes',
        'sandal',
        'sandals',
      ].some((k) => s.includes(k))
    )
      return 'Shoes';
    if (
      ['belt', 'scarf', 'tie', 'watch', 'sunglasses', 'briefcase'].some((k) =>
        s.includes(k),
      )
    )
      return 'Accessories';
    if (normalized === 'Tops' && lay === 'SHELL') return 'Outerwear';
    return normalized;
  }
  private normalizePatternScaleDto(
    val?: string | null,
  ): CreateWardrobeItemDto['pattern_scale'] | undefined {
    const s = (val ?? '').toString().trim().toLowerCase();
    if (!s) return undefined;
    if (['micro', 'subtle', '0', '-1', 'small'].includes(s)) return 'Micro';
    if (['medium', 'mid', '1'].includes(s)) return 'Medium';
    if (['bold', 'large', 'big', '2'].includes(s)) return 'Bold';
    return undefined;
  }
  private normalizeSeasonalityDto(
    val?: string | null,
  ): CreateWardrobeItemDto['seasonality'] | undefined {
    const s = (val ?? '').toString().trim().toLowerCase();
    if (!s) return undefined;
    if (['spring', 'spr', 'ss', 's/s'].includes(s)) return 'Spring';
    if (['summer', 'ss2'].includes(s)) return 'Summer';
    if (['fall', 'autumn', 'fw', 'f/w'].includes(s)) return 'Fall';
    if (['winter', 'win'].includes(s)) return 'Winter';
    if (
      [
        'all',
        'allseason',
        'all-season',
        'all season',
        'year-round',
        'year round',
        'all_season',
        'allseasonal',
        'allseasonwear',
      ].includes(s)
    )
      return 'AllSeason';
    return undefined;
  }
  private normalizeLayeringDto(
    val?: string | null,
  ): CreateWardrobeItemDto['layering'] | undefined {
    const s = (val ?? '').toString().trim().toLowerCase();
    if (!s) return undefined;
    if (['base', 'base layer', 'baselayer'].includes(s)) return 'Base';
    if (['mid', 'midlayer', 'mid layer'].includes(s)) return 'Mid';
    if (['outer', 'outerwear', 'jacket', 'shell'].includes(s)) return 'Outer';
    return undefined;
  }
  private normalizeColorTemp(val?: string | null) {
    const s = this.normLower(val);
    if (!s) return undefined;
    const map: Record<string, string> = {
      warm: 'Warm',
      cool: 'Cool',
      neutral: 'Neutral',
    };
    return map[s] ?? undefined;
  }
  private normalizeContrast(val?: string | null) {
    const s = this.normLower(val);
    if (!s) return undefined;
    const map: Record<string, string> = {
      low: 'Low',
      medium: 'Medium',
      med: 'Medium',
      high: 'High',
    };
    return map[s] ?? undefined;
  }

  /**
   * Pinecone id helper
   */
  private normalizePineconeId(raw: string | undefined | null): {
    id: string;
    modality: 'text' | 'image' | 'unknown';
  } {
    if (!raw) return { id: '', modality: 'unknown' };
    const [base, modality] = String(raw).split(':');
    return {
      id: base,
      modality:
        modality === 'text' || modality === 'image' ? modality : 'unknown',
    };
  }

  private extractFileName(url: string): string {
    const parts = url.split('/');
    return decodeURIComponent(parts[parts.length - 1].split('?')[0]);
  }

  private sanitizeMeta(
    raw: Record<string, any>,
  ): Record<string, string | number | boolean | string[]> {
    const out: Record<string, string | number | boolean | string[]> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (v === undefined || v === null) continue;
      if (k === 'metadata') {
        out['meta_json'] = typeof v === 'string' ? v : JSON.stringify(v);
        continue;
      }
      if (Array.isArray(v)) {
        out[k] = v.map((x) => String(x)).filter((x) => x.length > 0);
        continue;
      }
      switch (typeof v) {
        case 'string':
          out[k] = v;
          break;
        case 'number':
          if (Number.isFinite(v)) out[k] = v;
          break;
        case 'boolean':
          out[k] = v;
          break;
        case 'object':
          out[k] = JSON.stringify(v);
          break;
      }
    }
    return out;
  }

  private toCamel(row: any) {
    if (!row) return row;
    return {
      ...row,
      userId: row.user_id,
      image:
        row.touched_up_image_url || row.processed_image_url || row.image_url,
      gsutilUri: row.gsutil_uri,
      objectKey: row.object_key,
      processedImageUrl: row.processed_image_url,
      processedGsutilUri: row.processed_gsutil_uri,
      touchedUpImageUrl: row.touched_up_image_url,
      aiTitle: row.ai_title,
      aiDescription: row.ai_description,
      aiKeyAttributes: row.ai_key_attributes,
      aiConfidence: row.ai_confidence,
      mainCategory: row.main_category,
      subCategory: row.subcategory,
      styleDescriptors: row.style_descriptors,
      styleArchetypes: row.style_archetypes,
      anchorRole: row.anchor_role,
      occasionTags: row.occasion_tags,
      dressCode: row.dress_code,
      formalityScore: row.formality_score,
      dominantHex: row.dominant_hex,
      paletteHex: row.palette_hex,
      colorFamily: row.color_family,
      colorTemp: row.color_temp,
      contrastProfile: row.contrast_profile,
      fabricBlend: row.fabric_blend,
      fabricWeightGsm: row.fabric_weight_gsm,
      wrinkleResistance: row.wrinkle_resistance,
      stretchDirection: row.stretch_direction,
      stretchPct: row.stretch_pct,
      sizeSystem: row.size_system,
      sizeLabel: row.size_label,
      inseamIn: row.inseam_in,
      seasonalityArr: row.seasonality_arr,
      goesWithIds: row.goes_with_ids,
      avoidWithIds: row.avoid_with_ids,
      userRating: row.user_rating,
      fitConfidence: row.fit_confidence,
      outfitFeedback: row.outfit_feedback,
      dislikedFeatures: row.disliked_features,
      purchaseDate: row.purchase_date,
      purchasePrice: row.purchase_price,
      countryOfOrigin: row.country_of_origin,
      lastWornAt: row.last_worn_at,
      rotationPriority: row.rotation_priority,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at,
    };
  }

  composeFromAiDraft(
    base: Partial<CreateWardrobeItemDto>,
    draft: Record<string, any>,
  ): CreateWardrobeItemDto {
    const pick = <T>(k: string, fallback?: T): T | undefined =>
      (base as any)[k] ?? (draft?.[k] as T) ?? fallback;

    const name = pick<string>('name') ?? draft?.ai_title ?? 'Wardrobe Item';

    const rawSub =
      pick<string>('subcategory') ??
      draft?.subcategory ??
      (draft as any)?.subCategory;
    const layeringRaw = pick<string>('layering') ?? draft?.layering;

    const rawMain =
      (base as any).main_category ??
      (draft?.main_category as string | undefined) ??
      (draft?.category as string | undefined);

    const resolvedMain: CreateWardrobeItemDto['main_category'] =
      this.resolveMainCategory(rawMain, rawSub, layeringRaw);

    // Validate main_category ↔ subcategory pair (catches AI misclassification)
    const validated = validateCategoryPair(resolvedMain, rawSub, name);
    const main_category =
      validated.main_category as CreateWardrobeItemDto['main_category'];
    const validatedSub = validated.subcategory;

    const layering = this.normalizeLayeringDto(layeringRaw);
    const pattern_scale = this.normalizePatternScaleDto(
      pick<string>('pattern_scale') ?? draft?.pattern_scale,
    );
    const seasonality = this.normalizeSeasonalityDto(
      pick<string>('seasonality') ?? draft?.seasonality,
    );

    const rawTags = pick<string[] | string>('tags') ?? draft?.tags ?? [];
    const tags: string[] = Array.isArray(rawTags)
      ? rawTags.filter(Boolean).map(String)
      : String(rawTags)
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean);

    const parseNum = (x: any) =>
      typeof x === 'number'
        ? x
        : typeof x === 'string' && x.trim() !== '' && !Number.isNaN(+x)
          ? Number(x)
          : undefined;

    return {
      user_id: String(base.user_id),
      image_url: String(base.image_url),
      name,
      main_category,

      gsutil_uri: pick('gsutil_uri'),
      object_key: pick('object_key'),

      subcategory: validatedSub ?? pick('subcategory'),
      color: pick('color'),
      material: pick('material'),
      fit: pick('fit'),
      size: pick('size'),
      brand: pick('brand'),
      tags,

      style_descriptors: draft?.style_descriptors,
      style_archetypes: draft?.style_archetypes,
      anchor_role: draft?.anchor_role,
      occasion_tags: draft?.occasion_tags,
      dress_code: draft?.dress_code,
      formality_score: draft?.formality_score,

      dominant_hex: draft?.dominant_hex,
      palette_hex: draft?.palette_hex,
      color_family: draft?.color_family,
      color_temp: draft?.color_temp,
      contrast_profile: draft?.contrast_profile,

      pattern: draft?.pattern,
      pattern_scale,

      seasonality,
      seasonality_arr: draft?.seasonality_arr,
      layering,
      thermal_rating: draft?.thermal_rating,
      breathability: draft?.breathability,
      rain_ok: draft?.rain_ok,
      wind_ok: draft?.wind_ok,
      waterproof_rating: draft?.waterproof_rating,
      climate_sweetspot_f_min: draft?.climate_sweetspot_f_min,
      climate_sweetspot_f_max: draft?.climate_sweetspot_f_max,

      fabric_blend: draft?.fabric_blend,
      fabric_weight_gsm: draft?.fabric_weight_gsm,
      wrinkle_resistance: draft?.wrinkle_resistance,
      stretch_direction: draft?.stretch_direction,
      stretch_pct: draft?.stretch_pct,
      thickness: draft?.thickness,
      size_system: draft?.size_system,
      size_label: draft?.size_label,
      measurements: draft?.measurements,
      width: draft?.width,
      height: draft?.height,

      neckline: draft?.neckline,
      collar_type: draft?.collar_type,
      sleeve_length: draft?.sleeve_length,
      hem_style: draft?.hem_style,
      rise: draft?.rise,
      leg: draft?.leg,
      inseam_in: draft?.inseam_in,
      cuff: draft?.cuff,
      lapel: draft?.lapel,
      closure: draft?.closure,
      length_class: draft?.length_class,
      shoe_style: draft?.shoe_style,
      sole: draft?.sole,
      toe_shape: draft?.toe_shape,

      care_symbols: draft?.care_symbols,
      wash_temp_c: draft?.wash_temp_c,
      dry_clean: draft?.dry_clean,
      iron_ok: draft?.iron_ok,

      retailer: draft?.retailer,
      purchase_date: draft?.purchase_date,
      purchase_price: draft?.purchase_price,
      country_of_origin: draft?.country_of_origin,
      condition: draft?.condition,
      defects_notes: draft?.defects_notes,

      ai_title: draft?.ai_title,
      ai_description: draft?.ai_description,
      ai_key_attributes: draft?.ai_key_attributes,
      ai_confidence: parseNum(draft?.ai_confidence),

      metadata: (base as any).metadata,
      constraints: (base as any).constraints,
    };
  }

  // CREATE
  async createItem(dto: CreateWardrobeItemDto) {
    const cols: string[] = [];
    const vals: any[] = [];
    const params: string[] = [];
    let i = 1;

    const add = (col: string, val: any, kind: 'json' | 'raw' = 'raw') => {
      if (val === undefined) return;
      if (Array.isArray(val) && val.length === 0) return;
      cols.push(col);
      if (kind === 'json' && val !== null) {
        vals.push(JSON.stringify(val));
      } else {
        vals.push(val);
      }
      params.push(`$${i++}`);
    };

    // REQUIRED
    add('user_id', dto.user_id);
    add('image_url', dto.image_url);
    add('name', dto.name);
    add('main_category', dto.main_category);

    // Optional core/meta
    add('subcategory', dto.subcategory);
    add('color', dto.color);
    add('material', dto.material);
    add('fit', dto.fit);
    add('size', dto.size);
    add('brand', dto.brand);
    add('gsutil_uri', dto.gsutil_uri);
    add('object_key', dto.object_key);
    add('processed_image_url', dto.processed_image_url);
    add('processed_gsutil_uri', dto.processed_gsutil_uri);
    add('metadata', dto.metadata, 'json');
    add('width', dto.width);
    add('height', dto.height);
    add('tags', dto.tags);

    // Visuals & styling
    add('style_descriptors', dto.style_descriptors);
    add('style_archetypes', dto.style_archetypes);
    add('anchor_role', this.normalizeAnchorRole(dto.anchor_role));

    const normalizedPattern = this.normalizePattern(dto.pattern);
    if (
      normalizedPattern &&
      WardrobeService.PATTERN_ENUM_WHITELIST.includes(normalizedPattern)
    ) {
      add('pattern', normalizedPattern);
    }
    if (dto.pattern_scale !== undefined) {
      add(
        'pattern_scale',
        this.normalizePatternScaleDto(dto.pattern_scale) ?? null,
      );
    }

    add('dominant_hex', dto.dominant_hex);
    add('palette_hex', dto.palette_hex);
    add('color_family', dto.color_family);
    add('color_temp', this.normalizeColorTemp(dto.color_temp));
    add('contrast_profile', this.normalizeContrast(dto.contrast_profile));

    // Occasion & formality
    add('occasion_tags', dto.occasion_tags);
    add('dress_code', this.normalizeDressCode(dto.dress_code));
    // Ensure formality_score is integer for smallint column
    add(
      'formality_score',
      dto.formality_score != null
        ? Math.round(Number(dto.formality_score))
        : undefined,
    );

    // Seasonality & climate (ENUMS)
    const normalizedSeasonality = this.normalizeSeasonality(dto.seasonality);
    if (
      normalizedSeasonality &&
      WardrobeService.SEASONALITY_ENUM_WHITELIST.includes(normalizedSeasonality)
    ) {
      add('seasonality', normalizedSeasonality);
    }
    const normalizedLayering = this.normalizeLayering(dto.layering);
    if (
      normalizedLayering &&
      WardrobeService.LAYERING_ENUM_WHITELIST.includes(normalizedLayering)
    ) {
      add('layering', normalizedLayering);
    }

    add('seasonality_arr', dto.seasonality_arr);
    add('thermal_rating', dto.thermal_rating);
    add('breathability', dto.breathability);
    add('rain_ok', dto.rain_ok);
    add('wind_ok', dto.wind_ok);
    add('waterproof_rating', dto.waterproof_rating);
    add('climate_sweetspot_f_min', dto.climate_sweetspot_f_min);
    add('climate_sweetspot_f_max', dto.climate_sweetspot_f_max);

    // Construction & sizing
    add('fabric_blend', dto.fabric_blend, 'json');
    add('fabric_weight_gsm', dto.fabric_weight_gsm);
    add('wrinkle_resistance', dto.wrinkle_resistance);
    add('stretch_direction', dto.stretch_direction);
    add('stretch_pct', dto.stretch_pct);
    add('thickness', dto.thickness);
    add('size_system', dto.size_system);
    add('size_label', dto.size_label);
    add('measurements', dto.measurements, 'json');

    // Silhouette & cut
    add('neckline', dto.neckline);
    add('collar_type', dto.collar_type);
    add('sleeve_length', dto.sleeve_length);
    add('hem_style', dto.hem_style);
    add('rise', dto.rise);
    add('leg', dto.leg);
    add('inseam_in', dto.inseam_in);
    add('cuff', dto.cuff);
    add('lapel', dto.lapel);
    add('closure', dto.closure);
    add('length_class', dto.length_class);
    add('shoe_style', dto.shoe_style);
    add('sole', dto.sole);
    add('toe_shape', dto.toe_shape);

    // Care
    add('care_symbols', dto.care_symbols);
    add('wash_temp_c', dto.wash_temp_c);
    add('dry_clean', dto.dry_clean);
    add('iron_ok', dto.iron_ok);

    // Usage
    add('wear_count', dto.wear_count ?? 0);
    add('last_worn_at', dto.last_worn_at);
    add('rotation_priority', dto.rotation_priority);

    // Commerce & provenance
    add('purchase_date', dto.purchase_date);
    add('purchase_price', dto.purchase_price);
    add('retailer', dto.retailer);
    add('country_of_origin', dto.country_of_origin);
    add('condition', dto.condition);
    add('defects_notes', dto.defects_notes);

    // Pairing & feedback
    add('goes_with_ids', dto.goes_with_ids);
    add('avoid_with_ids', dto.avoid_with_ids);
    add('user_rating', dto.user_rating);
    // Ensure fit_confidence is integer for smallint column
    add(
      'fit_confidence',
      dto.fit_confidence != null
        ? Math.round(Number(dto.fit_confidence))
        : undefined,
    );
    add('outfit_feedback', dto.outfit_feedback, 'json');
    add('disliked_features', dto.disliked_features);

    // AI
    add('ai_title', dto.ai_title);
    add('ai_description', dto.ai_description);
    add('ai_key_attributes', dto.ai_key_attributes);
    // ai_confidence from AI is 0-1 float, DB expects smallint (0-100)
    add(
      'ai_confidence',
      dto.ai_confidence != null
        ? Math.round(Number(dto.ai_confidence) * 100)
        : undefined,
    );

    // Location
    add('location_id', dto.location_id ?? 'home');

    // Availability
    add('care_status', dto.care_status ?? 'available');
    add('cleaner_info', dto.cleaner_info ?? null);

    // System
    add('constraints', dto.constraints);

    const sql = `
      INSERT INTO wardrobe_items (${cols.join(', ')})
      VALUES (${params.join(', ')})
      RETURNING *;
    `;
    const result = await pool.query(sql, vals);
    const item = result.rows[0];

    // Embeddings (parallel — image and text are independent)
    const gcs = dto.gsutil_uri ?? item.gsutil_uri;
    const compositeText = [
      item.name,
      item.main_category,
      item.subcategory,
      item.color,
      item.color_family,
      item.material,
      item.fit,
      item.size,
      item.brand,
      item.color_temp,
      item.contrast_profile,
      String(item.formality_score ?? ''),
      item.seasonality,
      item.layering,
      item.pattern,
      item.pattern_scale,
      item.neckline,
      item.collar_type,
      item.sleeve_length,
      item.rise,
      item.leg,
      String(item.inseam_in ?? ''),
      item.length_class,
      item.shoe_style,
      item.sole,
      Array.isArray(item.occasion_tags) ? item.occasion_tags.join(' ') : '',
      Array.isArray(item.tags) ? item.tags.join(' ') : '',
      item.dress_code,
      item.anchor_role,
      item.dominant_hex,
      Array.isArray(item.palette_hex) ? item.palette_hex.join(' ') : '',
    ]
      .filter(Boolean)
      .join(' ');

    const [imageVec, textVec] = await Promise.all([
      gcs ? this.vertex.embedImage(gcs) : Promise.resolve(undefined),
      this.vertex.embedText(compositeText),
    ]);

    const meta = this.sanitizeMeta({ ...item });
    await upsertItemNs({
      userId: dto.user_id,
      itemId: item.id,
      imageVec,
      textVec,
      meta,
    });

    return {
      message: 'Wardrobe item created + indexed successfully',
      item: this.toCamel(item),
    };
  }

  // READ
  async getItemsByUser(userId: string) {
    const result = await pool.query(
      'SELECT * FROM wardrobe_items WHERE user_id = $1 ORDER BY created_at DESC',
      [userId],
    );
    return result.rows.map((r) => this.toCamel(r));
  }

  // 👉 NEW: return distinct, nicely-cased brand names for a user
  async getWardrobeBrands(userId: string): Promise<{ brands: string[] }> {
    const { rows } = await pool.query(
      `
      SELECT DISTINCT ON (LOWER(TRIM(brand)))
             TRIM(brand) AS brand
      FROM wardrobe_items
      WHERE user_id = $1
        AND brand IS NOT NULL
        AND TRIM(brand) <> ''
      ORDER BY LOWER(TRIM(brand)) ASC, brand ASC
      `,
      [userId],
    );

    const brands = rows
      .map((r: any) => String(r.brand))
      .filter(Boolean)
      .sort((a: string, b: string) => a.localeCompare(b));

    return { brands };
  }

  // UPDATE
  async updateItem(itemId: string, userId: string, dto: UpdateWardrobeItemDto) {
    const fields: string[] = [];
    const values: any[] = [];
    let index = 1;

    if (dto.pattern !== undefined) {
      const p = this.normalizePattern(dto.pattern);
      (dto as any).pattern =
        p && WardrobeService.PATTERN_ENUM_WHITELIST.includes(p) ? p : null;
    }
    if (dto.seasonality !== undefined) {
      const s = this.normalizeSeasonality(dto.seasonality);
      (dto as any).seasonality =
        s && WardrobeService.SEASONALITY_ENUM_WHITELIST.includes(s) ? s : null;
    }
    if (dto.layering !== undefined) {
      const l = this.normalizeLayering(dto.layering);
      (dto as any).layering =
        l && WardrobeService.LAYERING_ENUM_WHITELIST.includes(l) ? l : null;
    }
    if (dto.anchor_role !== undefined)
      (dto as any).anchor_role =
        this.normalizeAnchorRole(dto.anchor_role) ?? null;
    if (dto.dress_code !== undefined)
      (dto as any).dress_code = this.normalizeDressCode(dto.dress_code) ?? null;
    if (dto.color_temp !== undefined)
      (dto as any).color_temp = this.normalizeColorTemp(dto.color_temp) ?? null;
    if (dto.contrast_profile !== undefined)
      (dto as any).contrast_profile =
        this.normalizeContrast(dto.contrast_profile) ?? null;
    if (dto.pattern_scale !== undefined)
      (dto as any).pattern_scale =
        this.normalizePatternScaleDto(dto.pattern_scale) ?? null;

    // Allowlist of real wardrobe_items columns safe to SET via dynamic UPDATE.
    // Derived from createItem() add() calls. Blocks ANY unknown key (category,
    // __proto__, randomField, etc.) from reaching Postgres SQL.
    // System columns (id, user_id, created_at, updated_at) excluded deliberately.
    const ALLOWED_UPDATE_KEYS = new Set([
      // core
      'image_url', 'name', 'main_category', 'subcategory', 'color', 'material',
      'fit', 'size', 'brand', 'gsutil_uri', 'object_key', 'processed_image_url',
      'processed_gsutil_uri', 'metadata', 'width', 'height', 'tags',
      // visuals & styling
      'style_descriptors', 'style_archetypes', 'anchor_role', 'pattern',
      'pattern_scale', 'dominant_hex', 'palette_hex', 'color_family', 'color_temp',
      'contrast_profile',
      // occasion & formality
      'occasion_tags', 'dress_code', 'formality_score',
      // seasonality & climate
      'seasonality', 'layering', 'seasonality_arr', 'thermal_rating',
      'breathability', 'rain_ok', 'wind_ok', 'waterproof_rating',
      'climate_sweetspot_f_min', 'climate_sweetspot_f_max',
      // construction & sizing
      'fabric_blend', 'fabric_weight_gsm', 'wrinkle_resistance',
      'stretch_direction', 'stretch_pct', 'thickness', 'size_system',
      'size_label', 'measurements',
      // silhouette & cut
      'neckline', 'collar_type', 'sleeve_length', 'hem_style', 'rise', 'leg',
      'inseam_in', 'cuff', 'lapel', 'closure', 'length_class', 'shoe_style',
      'sole', 'toe_shape',
      // care
      'care_symbols', 'wash_temp_c', 'dry_clean', 'iron_ok',
      // usage
      'wear_count', 'last_worn_at', 'rotation_priority',
      // commerce & provenance
      'purchase_date', 'purchase_price', 'retailer', 'country_of_origin',
      'condition', 'defects_notes',
      // pairing & feedback
      'goes_with_ids', 'avoid_with_ids', 'user_rating', 'fit_confidence',
      'outfit_feedback', 'disliked_features',
      // AI
      'ai_title', 'ai_description', 'ai_key_attributes', 'ai_confidence',
      // location & availability
      'location_id', 'care_status', 'cleaner_info', 'constraints',
    ]);

    for (const [key, value] of Object.entries(dto)) {
      if (!ALLOWED_UPDATE_KEYS.has(key)) continue;
      if (value !== undefined) {
        fields.push(`${key} = $${index}`);
        if (Array.isArray(value)) {
          values.push(value.length ? value : null);
        } else if (typeof value === 'object' && value !== null) {
          values.push(JSON.stringify(value));
        } else {
          values.push(value);
        }
        index++;
      }
    }

    if (fields.length === 0) throw new Error('No fields provided for update.');

    values.push(itemId);
    values.push(userId);

    const query = `
      UPDATE wardrobe_items
      SET ${fields.join(', ')}, updated_at = NOW()
      WHERE id = $${index} AND user_id = $${index + 1}
      RETURNING *;
    `;
    const result = await pool.query(query, values);
    if (result.rowCount === 0) {
      return null;
    }
    const item = result.rows[0];

    let textVec: number[] | undefined;
    let imageVec: number[] | undefined;

    const textFields = [
      'name',
      'main_category',
      'subcategory',
      'color',
      'color_family',
      'material',
      'fit',
      'size',
      'brand',
      'pattern',
      'pattern_scale',
      'seasonality',
      'layering',
      'dress_code',
      'occasion_tags',
      'tags',
      'anchor_role',
    ];
    const textChanged = textFields.some((f) => f in dto);
    if (textChanged) {
      const textInput = [
        item.name,
        item.main_category,
        item.subcategory,
        item.color,
        item.color_family,
        item.material,
        item.fit,
        item.size,
        item.brand,
        item.color_temp,
        item.contrast_profile,
        String(item.formality_score ?? ''),
        item.seasonality,
        item.layering,
        item.pattern,
        item.pattern_scale,
        item.neckline,
        item.collar_type,
        item.sleeve_length,
        item.rise,
        item.leg,
        String(item.inseam_in ?? ''),
        item.length_class,
        item.shoe_style,
        item.sole,
        Array.isArray(item.occasion_tags) ? item.occasion_tags.join(' ') : '',
        Array.isArray(item.tags) ? item.tags.join(' ') : '',
        item.dress_code,
        item.anchor_role,
        item.dominant_hex,
        Array.isArray(item.palette_hex) ? item.palette_hex.join(' ') : '',
      ]
        .filter(Boolean)
        .join(' ');
      textVec = await this.vertex.embedText(textInput);
    }

    const imageChanged = 'gsutil_uri' in dto || 'image_url' in dto;
    const gcs = (dto as any).gsutil_uri ?? item.gsutil_uri;
    if (imageChanged && gcs) {
      imageVec = await this.vertex.embedImage(gcs);
    }

    const meta = this.sanitizeMeta({ ...item });

    if (textVec || imageVec) {
      await upsertItemNs({
        userId: item.user_id,
        itemId: item.id,
        textVec,
        imageVec,
        meta,
      });
    } else {
      await upsertItemNs({ userId: item.user_id, itemId: item.id, meta });
    }

    return {
      message: 'Wardrobe item updated successfully',
      item: this.toCamel(item),
    };
  }

  async updateFavorite(itemId: string, userId: string, favorite: boolean) {
    const result = await pool.query(
      `UPDATE wardrobe_items
     SET favorite = $1,
         updated_at = now()
     WHERE id = $2 AND user_id = $3
     RETURNING *`,
      [favorite, itemId, userId],
    );
    if (result.rowCount === 0) {
      return null;
    }
    return result.rows[0];
  }

  // TOUCH-UP (Beautify / Flat-lay enhancement)
  async touchUpItem(itemId: string, userId: string) {
    // 1. Fetch the item
    const itemResult = await pool.query(
      `SELECT * FROM wardrobe_items WHERE id = $1 AND user_id = $2`,
      [itemId, userId],
    );
    if (itemResult.rowCount === 0) {
      return null;
    }
    const item = itemResult.rows[0];

    // 2. Get the processed image URL (or fall back to original)
    const sourceImageUrl = item.processed_image_url || item.image_url;
    if (!sourceImageUrl) {
      console.error('[TouchUp] No source image URL found for item:', itemId);
      return null;
    }

    // 3. Call PhotoRoom touch-up API
    const objectKey =
      item.gsutil_uri?.replace(/^gs:\/\/[^/]+\//, '') ||
      `items/${userId}/${itemId}`;
    const touchUpResult = await this.vertex.touchUpImage(
      sourceImageUrl,
      userId,
      objectKey,
    );

    if (!touchUpResult) {
      console.error('[TouchUp] PhotoRoom touch-up failed for item:', itemId);
      return null;
    }

    // 4. Update DB with new touched_up_image_url
    const updateResult = await pool.query(
      `UPDATE wardrobe_items
       SET touched_up_image_url = $1,
           updated_at = now()
       WHERE id = $2 AND user_id = $3
       RETURNING *`,
      [touchUpResult.touchedUpPublicUrl, itemId, userId],
    );

    if (updateResult.rowCount === 0) {
      return null;
    }

    return {
      message: 'Touch-up completed successfully',
      item: this.toCamel(updateResult.rows[0]),
    };
  }

  // REMOVE BACKGROUND (Re-process background removal for existing item)
  async removeBackgroundItem(itemId: string, userId: string) {
    // 1. Fetch the item
    const itemResult = await pool.query(
      `SELECT * FROM wardrobe_items WHERE id = $1 AND user_id = $2`,
      [itemId, userId],
    );
    if (itemResult.rowCount === 0) {
      return null;
    }
    const item = itemResult.rows[0];

    // 2. Get the original image URL
    const sourceImageUrl = item.image_url;
    if (!sourceImageUrl) {
      console.error(
        '[RemoveBackground] No source image URL found for item:',
        itemId,
      );
      return null;
    }

    // 3. Download the image and call removeBackground
    const objectKey =
      item.gsutil_uri?.replace(/^gs:\/\/[^/]+\//, '') ||
      `items/${userId}/${itemId}`;

    // Fetch the image buffer from the URL
    const response = await fetch(sourceImageUrl);
    if (!response.ok) {
      console.error(
        '[RemoveBackground] Failed to fetch source image:',
        sourceImageUrl,
      );
      return null;
    }
    const imageBuffer = Buffer.from(await response.arrayBuffer());

    const removeResult = await this.vertex.removeBackground(
      imageBuffer,
      userId,
      objectKey,
    );

    if (!removeResult) {
      console.error(
        '[RemoveBackground] PhotoRoom remove-background failed for item:',
        itemId,
      );
      return null;
    }

    // 4. Update DB with new processed_image_url
    const updateResult = await pool.query(
      `UPDATE wardrobe_items
       SET processed_image_url = $1,
           processed_gsutil_uri = $2,
           updated_at = now()
       WHERE id = $3 AND user_id = $4
       RETURNING *`,
      [
        removeResult.processedPublicUrl,
        removeResult.processedGcsUri,
        itemId,
        userId,
      ],
    );

    if (updateResult.rowCount === 0) {
      return null;
    }

    return {
      message: 'Background removal completed successfully',
      item: this.toCamel(updateResult.rows[0]),
    };
  }

  // DELETE
  async deleteItem(dto: DeleteItemDto) {
    const { item_id, user_id, image_url } = dto;
    try {
      await pool.query(
        'DELETE FROM wardrobe_items WHERE id = $1 AND user_id = $2',
        [item_id, user_id],
      );
    } catch (err: any) {
      console.warn(`⚠️ Skipped DB delete: ${err.message}`);
    }
    try {
      await deleteItemNs(user_id, item_id);
    } catch (err: any) {
      console.warn(`⚠️ Pinecone delete skipped: ${err.message}`);
    }
    if (image_url) {
      const bucketName = getSecret('GCS_BUCKET_NAME');
      const fileName = this.extractFileName(image_url);
      try {
        await storage.bucket(bucketName).file(fileName).delete();
      } catch (err: any) {
        if (err.code === 404) {
          console.warn('🧼 GCS file already deleted:', fileName);
        } else {
          console.error('❌ Error deleting GCS file:', err.message);
        }
      }
    }
    return { message: 'Wardrobe item cleanup attempted (DB, Pinecone, GCS)' };
  }

  // VECTOR SEARCH UTILITIES
  async suggestOutfits(userId: string, queryVec: number[]) {
    const matches = await queryUserNs({
      userId,
      vector: queryVec,
      topK: 20,
      includeMetadata: true,
    });
    return matches.map((m) => {
      const { id, modality } = this.normalizePineconeId(m.id);
      return { id, modality, score: m.score, meta: m.metadata };
    });
  }
  async searchText(userId: string, q: string, topK = 20) {
    const vec = await this.vertex.embedText(q);
    const matches = await queryUserNs({
      userId,
      vector: vec,
      topK,
      includeMetadata: true,
    });
    return matches.map((m) => {
      const { id, modality } = this.normalizePineconeId(m.id);
      return { id, modality, score: m.score, meta: m.metadata };
    });
  }
  async searchImage(userId: string, gcsUri: string, topK = 20) {
    const vec = await this.vertex.embedImage(gcsUri);
    const matches = await queryUserNs({
      userId,
      vector: vec,
      topK,
      includeMetadata: true,
    });
    return matches.map((m) => {
      const { id, modality } = this.normalizePineconeId(m.id);
      return { id, modality, score: m.score, meta: m.metadata };
    });
  }
  async searchHybrid(userId: string, q?: string, gcsUri?: string, topK = 20) {
    const [textVec, imageVec] = await Promise.all([
      q ? this.vertex.embedText(q) : Promise.resolve(undefined),
      gcsUri ? this.vertex.embedImage(gcsUri) : Promise.resolve(undefined),
    ]);
    const matches = await hybridQueryUserNs({
      userId,
      textVec,
      imageVec,
      topK,
    });
    return matches.map((m) => {
      const { id, modality } = this.normalizePineconeId(m.id);
      return { id, modality, score: m.score, meta: m.metadata };
    });
  }

  // Label helper
  private summarizeItem(meta: any): string {
    if (!meta) return 'Item';
    const name = (meta.name || '').toString().trim();

    const color = meta.color || meta.color_family;
    const cat = meta.main_category || meta.mainCategory;
    const sub = meta.subcategory || meta.subCategory;
    const mat = meta.material;
    const brand = meta.brand;
    const fit = meta.fit;
    const size = meta.size_label || meta.size;
    const dress = meta.dress_code || meta.dressCode;
    const role = meta.anchor_role || meta.anchorRole;
    const patternish = meta.pattern_scale || meta.patternScale || meta.pattern;

    // ── NEW: slot detection to make roles explicit ─────────────
    const toLc = (s: any) => (s ?? '').toString().trim().toLowerCase();
    const mainLc = toLc(cat);
    const subLc = toLc(sub);

    const isBottom =
      mainLc === 'bottoms' ||
      /\b(trouser|pants|jeans|chinos|shorts|joggers?|sweatpants?|track\s*pants?)\b/i.test(
        subLc,
      );

    const isShoes =
      mainLc === 'shoes' ||
      /\b(sneakers?|trainers?|running|athletic|loafers?|boots?|oxfords?|derbys?|dress\s*shoes?|sandals?)\b/i.test(
        subLc,
      );

    const isOuter =
      mainLc === 'outerwear' ||
      /\b(blazer|sport\s*coat|suit\s*jacket|jacket|coat|windbreaker|parka|trench|overcoat|topcoat)\b/i.test(
        subLc,
      );

    const isTop =
      mainLc === 'tops' ||
      /\b(t-?shirt|tee|polo|shirt|sweater|knit|henley|hoodie)\b/i.test(subLc);

    const isAcc =
      mainLc === 'accessories' ||
      /\b(belt|watch|hat|scarf|tie|sunglasses|bag|briefcase)\b/i.test(subLc);

    const isDress =
      mainLc === 'dresses' ||
      mainLc === 'formalwear' ||
      /\b(dress|gown|romper|jumpsuit)\b/i.test(subLc);

    const isActive =
      mainLc === 'activewear' ||
      /\b(legging|jogger|athletic|sport|gym|workout)\b/i.test(subLc);

    const isSwim =
      mainLc === 'swimwear' ||
      /\b(bikini|swimsuit|swim\s*trunk|rash\s*guard)\b/i.test(subLc);

    const slot =
      (isDress && 'DRESS') ||
      (isActive && 'ACTIVE') ||
      (isSwim && 'SWIM') ||
      (isBottom && 'BOTTOM') ||
      (isShoes && 'SHOES') ||
      (isOuter && 'OUTER') ||
      (isTop && 'TOP') ||
      (isAcc && 'ACC') ||
      undefined;

    // ───────────────────────────────────────────────────────────

    const primary = [color, mat, sub || cat].filter(Boolean).join(' ');

    const season =
      meta.seasonality ||
      (Array.isArray(meta.seasonality_arr) && meta.seasonality_arr.join('/'));
    const temp = meta.color_temp;
    const contrast = meta.contrast_profile;
    const form = meta.formality_score != null ? `F${meta.formality_score}` : '';

    const extras = [
      brand && `${brand}`,
      fit && `${fit} fit`,
      size && `(${size})`,
      dress && `${dress}`,
      role && `${role} role`,
      patternish && `pattern:${patternish}`,
      season && `${season}`,
      temp && `temp:${temp}`,
      contrast && `contrast:${contrast}`,
      form,
    ]
      .filter(Boolean)
      .join(', ');

    const headRaw = primary || name || 'Item';
    const head = slot ? `[${slot}] ${headRaw}` : headRaw;
    return extras ? `${head} — ${extras}` : head;
  }
}

///////////////////

// // // apps/backend-nest/src/wardrobe/wardrobe.service.ts

// import { Injectable } from '@nestjs/common';
// import { Pool } from 'pg';
// import { Storage } from '@google-cloud/storage';
// import { CreateWardrobeItemDto } from './dto/create-wardrobe-item.dto';
// import { UpdateWardrobeItemDto } from './dto/update-wardrobe-item.dto';
// import { DeleteItemDto } from './dto/delete-item.dto';
// import { upsertItemNs, deleteItemNs } from '../pinecone/pinecone-upsert';
// import { queryUserNs, hybridQueryUserNs } from '../pinecone/pinecone-query';
// import { VertexService } from '../vertex/vertex.service';
// import { randomUUID } from 'crypto'; // ← NEW

// // NEW imports for extracted logic (prompts + scoring only)
// import { parseConstraints } from './logic/constraints';
// import {
//   rerankCatalogWithContext,
//   DEFAULT_CONTEXT_WEIGHTS,
//   type ContextWeights,
// } from './logic/scoring';
// import type { UserStyle } from './logic/style';
// import type { WeatherContext } from './logic/weather';
// import { finalizeOutfitSlots } from './logic/finalize';
// import { enforceConstraintsOnOutfits } from './logic/enforce';
// import { buildOutfitPrompt } from './prompts/outfitPrompt';
// import { extractStrictJson } from './logic/json';
// import { applyContextualFilters } from './logic/contextFilters';
// import { STYLE_AGENTS } from './logic/style-agents';

// // NEW: feedback filters
// import {
//   applyFeedbackFilters,
//   compileFeedbackRulesFromRows,
//   OutfitFeedbackRow, // ✅ correct type
// } from './logic/feedbackFilters';

// /**
//  * Postgres connection pool.
//  * - SSL enabled for managed DBs.
//  * - Used for all CRUD on wardrobe_items table.
//  */
// const pool = new Pool({
//   connectionString: process.env.DATABASE_URL,
//   ssl: { rejectUnauthorized: false },
// });

// /**
//  * Google Cloud Storage client.
//  * - Used to delete images from GCS when wardrobe items are removed.
//  */
// const storage = new Storage();

// // ─────────────────────────────────────────────────────────────────────────────
// // Catalog typing + coercion helpers
// // ─────────────────────────────────────────────────────────────────────────────

// /**
//  * The shape of an item the "catalog" (Pinecone search results) feeds into the
//  * outfit generator. This is a lightweight, prompt-friendly view.
//  */
// type CatalogItem = {
//   index: number;
//   id: string;
//   label: string;
//   image_url?: string;

//   // core used by all scorers
//   main_category?: string;
//   subcategory?: string;
//   color?: string;
//   color_family?: string;
//   shoe_style?: string;
//   dress_code?: string;
//   formality_score?: number;

//   // extras used by style/weather scorers (all optional)
//   brand?: string;
//   material?: string;
//   sleeve_length?: string;
//   layering?: string; // 'Base' | 'Mid' | 'Outer'
//   waterproof_rating?: number | string;
//   rain_ok?: boolean;
// };

// // ── Weights normalization helpers ────────────────────────────────────────────
// type WeightsLong = {
//   constraintsWeight: number;
//   styleWeight: number;
//   weatherWeight: number;
//   feedbackWeight?: number;
// };
// type WeightsShort = {
//   constraints: number;
//   style: number;
//   weather: number;
//   feedback?: number;
// };
// type AnyWeights = WeightsLong | WeightsShort;

// // ───────────────────────────────────────────────
// // Slot helpers
// // ───────────────────────────────────────────────
// type Slot = 'tops' | 'bottoms' | 'shoes' | 'outerwear' | 'accessories';

// function toLongWeights(w: AnyWeights): WeightsLong {
//   if ('styleWeight' in w) return { ...w };
//   return {
//     constraintsWeight: w.constraints,
//     styleWeight: w.style,
//     weatherWeight: w.weather,
//     feedbackWeight: w.feedback,
//   };
// }

// function fromLongWeights(longW: WeightsLong, like: AnyWeights): AnyWeights {
//   if ('styleWeight' in like) {
//     // Convert frontend shape → short shape
//     return {
//       constraints: like.constraintsWeight ?? longW.constraintsWeight,
//       style: like.styleWeight ?? longW.styleWeight,
//       weather: like.weatherWeight ?? longW.weatherWeight,
//       feedback: like.feedbackWeight ?? longW.feedbackWeight,
//     };
//   }
//   // Already in short shape → just normalize from long
//   return {
//     constraints: longW.constraintsWeight,
//     style: longW.styleWeight,
//     weather: longW.weatherWeight,
//     feedback: longW.feedbackWeight,
//   };
// }

// // Soft numeric prefs derived from feedback rules (only for rerank nudges)
// function buildUserPrefsFromRules(
//   catalog: Array<{
//     id?: string;
//     label?: string;
//     subcategory?: string;
//     main_category?: string;
//     color?: string;
//     color_family?: string;
//   }>,
//   rules: ReturnType<typeof compileFeedbackRulesFromRows>,
// ): Map<string, number> {
//   const m = new Map<string, number>();
//   if (!rules?.length || !catalog?.length) return m;

//   const lc = (v?: string) => (v ?? '').toLowerCase();

//   // mirror the predicate logic lightly to issue a -5 soft penalty
//   const hit = (it: any): boolean => {
//     const id = it?.id;
//     const brand = lc((it as any).brand);
//     const color = lc((it as any).color) || lc((it as any).color_family);
//     const main = lc((it as any).main_category);
//     const sub = lc((it as any).subcategory);
//     const lbl = lc((it as any).label);

//     for (const r of rules) {
//       switch (r.kind) {
//         case 'excludeItemIds':
//           if (id && r.item_ids.includes(id)) return true;
//           break;
//         case 'excludeBrand':
//           if (brand && brand.includes(lc(r.brand))) {
//             if (!r.category) return true;
//             if (main.includes(lc(r.category))) return true;
//           }
//           break;
//         case 'excludeColorOnCategory':
//           if (
//             r.category &&
//             (main.includes(r.category) || sub.includes(r.category))
//           ) {
//             if (color.includes(r.color)) return true;
//             if (lbl.includes(r.color)) return true;
//           }
//           break;
//         case 'excludeColor':
//           if (color.includes(r.color) || lbl.includes(r.color)) return true;
//           break;
//         case 'excludeSubstring':
//           if ((r.field === 'label' ? lbl : sub).includes(lc(r.value))) {
//             if (!r.category) return true;
//             if (main.includes(lc(r.category))) return true;
//           }
//           break;
//       }
//     }
//     return false;
//   };

//   for (const it of catalog) {
//     const id = it?.id;
//     if (!id) continue;
//     if (hit(it)) m.set(id, -5); // -5 raw → scaled to ~ -0.2 in reranker
//   }
//   return m;
// }

// @Injectable()
// export class WardrobeService {
//   constructor(private readonly vertex: VertexService) {}

//   // 👇 track base query + refinements per session
//   // at the top of WardrobeService class
//   private sessions = new Map<
//     string,
//     { baseQuery: string; refinements: string[] }
//   >();

//   // ─────────────────────────────────────────────────────────────
//   // Enum whitelists
//   // ─────────────────────────────────────────────────────────────

//   private static readonly PATTERN_ENUM_WHITELIST: string[] = [
//     'SOLID',
//     'STRIPE',
//     'CHECK',
//     'HERRINGBONE',
//     'WINDOWPANE',
//     'FLORAL',
//     'DOT',
//     'CAMO',
//     'ABSTRACT',
//     'OTHER',
//   ];
//   private static readonly SEASONALITY_ENUM_WHITELIST: string[] = [
//     'SS',
//     'FW',
//     'ALL_SEASON',
//   ];
//   private static readonly LAYERING_ENUM_WHITELIST: string[] = [
//     'BASE',
//     'MID',
//     'SHELL',
//     'ACCENT',
//   ];

//   // Generic safe-casters
//   private asStr(v: any): string | undefined {
//     if (v === undefined || v === null) return undefined;
//     const s = String(v).trim();
//     return s ? s : undefined;
//   }
//   private asNum(v: any): number | undefined {
//     if (v === undefined || v === null) return undefined;
//     const n = Number(v);
//     return Number.isFinite(n) ? n : undefined;
//   }

//   // // apps/backend-nest/src/wardrobe/wardrobe.service.ts

//   // apps/backend-nest/src/wardrobe/wardrobe.service.ts

//   // apps/backend-nest/src/wardrobe/wardrobe.service.ts

//   private parseRefinementLocks(
//     refinement: string,
//     catalog: CatalogItem[],
//     prevLockedIds: string[],
//   ): {
//     keepSlots: Set<Slot>;
//     replaceSlots: Set<Slot>;
//     additionsBySlot: Map<Slot, string>;
//   } {
//     const lc = refinement.toLowerCase();

//     const keepSlots = new Set<Slot>();
//     const replaceSlots = new Set<Slot>();
//     const additionsBySlot = new Map<Slot, string>();

//     // 1) Detect explicit "keep" language
//     if (/keep[^.]*shirt|keep[^.]*top/.test(lc)) keepSlots.add('tops');
//     if (/keep[^.]*shorts?|keep[^.]*pants?/.test(lc)) keepSlots.add('bottoms');
//     if (/keep[^.]*shoes?|keep[^.]*sneakers?/.test(lc)) keepSlots.add('shoes');

//     // 2) Detect color+slot replacements — always unlock slot even if not found
//     const colorSlotReqs: { re: RegExp; slot: Slot; color: RegExp }[] = [
//       {
//         re: /\bgrey\s+(shorts|pants|trousers)\b/,
//         slot: 'bottoms',
//         color: /grey|gray/i,
//       },
//       { re: /\bred\s+shoes?\b/, slot: 'shoes', color: /red/i },
//       {
//         re: /\bblue\s+(shirt|top|tee|t-?shirt|polo)\b/,
//         slot: 'tops',
//         color: /blue|navy/i,
//       },
//       { re: /\bred\s+shoes?\b/, slot: 'shoes', color: /red/i },
//       {
//         re: /\bred\s+(shirt|top|tee|t-?shirt|polo)\b/,
//         slot: 'tops',
//         color: /red/i,
//       },
//       {
//         re: /\bgrey\s+(shorts|pants|trousers)\b/,
//         slot: 'bottoms',
//         color: /grey|gray/i,
//       },
//       {
//         re: /\bblue\s+(shirt|top|tee|t-?shirt|polo)\b/,
//         slot: 'tops',
//         color: /blue|navy/i,
//       },
//     ];

//     for (const req of colorSlotReqs) {
//       if (req.re.test(lc)) {
//         const found = this.findByColorAndSlot(catalog, req.slot, req.color);
//         if (found) additionsBySlot.set(req.slot, found);

//         // ✅ always unlock the slot, even if no item was found
//         replaceSlots.add(req.slot);
//       }
//     }

//     // 3) Detect generic "replace/swap" language
//     if (/\b(replace|swap|change|different|other|not those)\b/.test(lc)) {
//       if (/\bshoes?|sneakers?\b/.test(lc) && !keepSlots.has('shoes'))
//         replaceSlots.add('shoes');
//       if (/\bshorts?|pants?|bottoms?\b/.test(lc) && !keepSlots.has('bottoms'))
//         replaceSlots.add('bottoms');
//       if (
//         /\b(shirt|top|tee|t-?shirt|polo)\b/.test(lc) &&
//         !keepSlots.has('tops')
//       )
//         replaceSlots.add('tops');
//     }

//     return { keepSlots, replaceSlots, additionsBySlot };
//   }

//   private mergeLockedIds(
//     prevLockedIds: string[],
//     catalog: CatalogItem[],
//     keepSlots: Set<Slot>,
//     replaceSlots: Set<Slot>,
//     additionsBySlot: Map<Slot, string>,
//   ): string[] {
//     const idToItem = new Map(
//       prevLockedIds.map((id) => [id, catalog.find((c) => c.id === id)]),
//     );
//     const resultBySlot = new Map<Slot, string>();

//     // ✅ 1. Carry over only items whose slot is explicitly kept
//     for (const id of prevLockedIds) {
//       const item = idToItem.get(id);
//       const slot = this.getSlot(item);
//       if (!slot) continue;
//       if (keepSlots.has(slot)) resultBySlot.set(slot, id);
//     }

//     // ✅ 2. Force-remove anything in replaceSlots even if no new item was found
//     for (const slot of replaceSlots) {
//       resultBySlot.delete(slot);
//     }

//     // ✅ 3. Add newly requested items (color match, etc.)
//     for (const [slot, id] of additionsBySlot.entries()) {
//       resultBySlot.set(slot, id);
//     }

//     return Array.from(new Set(resultBySlot.values()));
//   }

//   // Pull user feedback rows from your DB (adjust table/columns if yours differ)

//   // Replace your current fetchFeedbackRows with this exact version:
//   private async fetchFeedbackRows(
//     userId: string,
//   ): Promise<OutfitFeedbackRow[]> {
//     // Adjust table/column names only if they differ in your DB.
//     // This version is compatible with your CSV: rating = -1/1, notes = free text.
//     const { rows } = await pool.query(
//       `SELECT id, user_id, outfit_id, rating, notes, created_at
//        FROM outfit_feedback
//       WHERE user_id = $1
//       ORDER BY created_at DESC
//       LIMIT 500`,
//       [userId],
//     );

//     return rows.map((r: any) => {
//       // rating: -1 => "dislike", 1 => "like", anything else => null
//       const rating =
//         r.rating === -1 ? 'dislike' : r.rating === 1 ? 'like' : null;

//       // notes may be plain text like: "Avoid shoes with green in them."
//       // Keep as-is; compileFeedbackRulesFromRows() will parse color/brand/slot.
//       const notes =
//         typeof r.notes === 'string' && r.notes.trim().length ? r.notes : null;

//       return {
//         id: String(r.id),
//         request_id: '', // unknown here
//         user_id: String(r.user_id),
//         rating, // "like" | "dislike" | null
//         tags: null, // not present in your CSV
//         notes, // free text
//         outfit_json: null, // not present in your CSV
//         created_at: String(r.created_at),
//       } as OutfitFeedbackRow;
//     });
//   }

//   // Normalizers
//   private normLower(val?: string | null) {
//     if (!val) return undefined;
//     const s = String(val).trim();
//     if (!s) return undefined;
//     return s.toLowerCase();
//   }
//   private normalizePattern(val?: string | null) {
//     const s = this.normLower(val);
//     if (!s) return undefined;
//     const map: Record<string, string> = {
//       solid: 'SOLID',
//       stripe: 'STRIPE',
//       striped: 'STRIPE',
//       stripes: 'STRIPE',
//       plaid: 'CHECK',
//       check: 'CHECK',
//       checked: 'CHECK',
//       herringbone: 'HERRINGBONE',
//       windowpane: 'WINDOWPANE',
//       floral: 'FLORAL',
//       flower: 'FLORAL',
//       dot: 'DOT',
//       dots: 'DOT',
//       polka: 'DOT',
//       polka_dot: 'DOT',
//       camo: 'CAMO',
//       camouflage: 'CAMO',
//       abstract: 'ABSTRACT',
//       print: 'ABSTRACT',
//       printed: 'ABSTRACT',
//       graphic: 'ABSTRACT',
//       other: 'OTHER',
//     };
//     return map[s] ?? undefined;
//   }
//   private coerceMainCategoryFromSub(
//     rawMain?: string,
//     sub?: string,
//   ): string | undefined {
//     const main = (rawMain ?? '').trim();
//     const s = (sub ?? '').toLowerCase();

//     const isOuter = [
//       'blazer',
//       'sport coat',
//       'sportcoat',
//       'suit jacket',
//       'jacket',
//       'coat',
//       'parka',
//       'trench',
//       'overcoat',
//       'topcoat',
//     ].some((k) => s.includes(k));
//     if (isOuter) return 'Outerwear';

//     const isShoe = [
//       'loafer',
//       'loafers',
//       'sneaker',
//       'sneakers',
//       'boot',
//       'boots',
//       'heel',
//       'heels',
//       'pump',
//       'oxford',
//       'derby',
//       'dress shoe',
//       'dress shoes',
//       'sandal',
//       'sandals',
//     ].some((k) => s.includes(k));
//     if (isShoe) return 'Shoes';

//     const isAccessory = [
//       'belt',
//       'hat',
//       'scarf',
//       'tie',
//       'watch',
//       'sunglasses',
//       'bag',
//       'briefcase',
//     ].some((k) => s.includes(k));
//     if (isAccessory) return 'Accessories';

//     return main || undefined;
//   }
//   private normalizeAnchorRole(val?: string | null) {
//     const s = this.normLower(val);
//     if (!s) return undefined;
//     const map: Record<string, string> = {
//       hero: 'Hero',
//       neutral: 'Neutral',
//       connector: 'Connector',
//     };
//     return map[s] ?? undefined;
//   }
//   private normalizeSeasonality(val?: string | null) {
//     const s = this.normLower(val);
//     if (!s) return undefined;
//     const map: Record<string, string> = {
//       ss: 'SS',
//       'spring/summer': 'SS',
//       spring: 'SS',
//       summer: 'SS',
//       fw: 'FW',
//       'fall/winter': 'FW',
//       fall: 'FW',
//       autumn: 'FW',
//       winter: 'FW',
//       allseason: 'ALL_SEASON',
//       'all season': 'ALL_SEASON',
//       'all-season': 'ALL_SEASON',
//       all_season: 'ALL_SEASON',
//       all: 'ALL_SEASON',
//       'year-round': 'ALL_SEASON',
//       'year round': 'ALL_SEASON',
//     };
//     return map[s];
//   }

//   private getSlot(c?: CatalogItem): Slot | undefined {
//     if (!c) return undefined;
//     const main = (c.main_category ?? '').toLowerCase();
//     const sub = (c.subcategory ?? '').toLowerCase();
//     if (
//       main === 'tops' ||
//       /\b(t-?shirt|tee|polo|shirt|sweater|knit|henley|hoodie)\b/i.test(sub)
//     )
//       return 'tops';
//     if (
//       main === 'bottoms' ||
//       /\b(trouser|pants|jeans|chinos|shorts|joggers?|sweatpants?)\b/i.test(sub)
//     )
//       return 'bottoms';
//     if (
//       main === 'shoes' ||
//       /\b(sneakers?|trainers?|running|athletic|loafers?|boots?|oxfords?|derbys?|sandals?)\b/i.test(
//         sub,
//       )
//     )
//       return 'shoes';
//     if (
//       main === 'outerwear' ||
//       /\b(blazer|sport\s*coat|suit\s*jacket|jacket|coat|parka|tren(ch|ch)|overcoat|topcoat|windbreaker)\b/i.test(
//         sub,
//       )
//     )
//       return 'outerwear';
//     if (
//       main === 'accessories' ||
//       /\b(belt|watch|hat|scarf|tie|sunglasses|bag|briefcase)\b/i.test(sub)
//     )
//       return 'accessories';
//     return undefined;
//   }

//   private textOf(c: CatalogItem): string {
//     return `${c.color ?? ''} ${c.color_family ?? ''} ${c.label ?? ''}`.toLowerCase();
//   }

//   private findByColorAndSlot(
//     catalog: CatalogItem[],
//     slot: Slot,
//     colorRe: RegExp,
//     extra?: (c: CatalogItem) => boolean,
//   ): string | undefined {
//     const match = catalog.find(
//       (c) =>
//         this.getSlot(c) === slot &&
//         colorRe.test(this.textOf(c)) &&
//         (!extra || extra(c)),
//     );
//     return match?.id;
//   }

//   // Ultra-casual screen used only when the query implies "upscale"
//   private isUltraCasualForUpscale(c: {
//     main_category?: string;
//     subcategory?: string;
//     label?: string;
//     dress_code?: string;
//     formality_score?: number;
//   }): boolean {
//     const main = (c.main_category ?? '').toLowerCase();
//     const sub = (c.subcategory ?? '').toLowerCase();
//     const lbl = (c.label ?? '').toLowerCase();

//     // obvious casual tops & loud casual items
//     const casualWords = /(t-?shirt|tee|hoodie|tank|graphic tee|hawaiian)/;
//     if (casualWords.test(sub) || casualWords.test(lbl)) return true;

//     // shorts for bottoms
//     if (main === 'bottoms' && /\bshorts?\b/.test(sub)) return true;

//     // jeans: allow only if clearly dressy; otherwise screen out for upscale
//     if (/\bjeans?\b/.test(sub) && (c.formality_score ?? 0) < 6) return true;

//     // generic dress code + formality gate
//     const dc = c.dress_code;
//     if (
//       dc &&
//       (dc === 'UltraCasual' || dc === 'Casual') &&
//       (c.formality_score ?? 0) < 6
//     ) {
//       return true;
//     }

//     return false;
//   }

//   private retitleOutfit(o: {
//     title: string;
//     why: string;
//     items: CatalogItem[];
//   }): { title: string; why: string } {
//     if (!o.items?.length) return { title: o.title, why: o.why };

//     const tops = o.items.filter(
//       (c) => (c.main_category ?? '').toLowerCase() === 'tops',
//     );
//     const bottoms = o.items.filter(
//       (c) => (c.main_category ?? '').toLowerCase() === 'bottoms',
//     );
//     const shoes = o.items.filter(
//       (c) => (c.main_category ?? '').toLowerCase() === 'shoes',
//     );

//     const topName = tops[0]?.label ?? '';
//     const bottomName = bottoms[0]?.label ?? '';
//     const shoeName = shoes[0]?.label ?? '';

//     // Very simple rewrite
//     const title = `Outfit with ${[topName, bottomName, shoeName]
//       .filter(Boolean)
//       .join(', ')}`;

//     const why = `This look combines ${topName || 'a top'} with ${
//       bottomName || 'a bottom'
//     } and ${shoeName || 'shoes'} for a complete outfit.`;

//     return { title, why };
//   }

//   /**
//    * MAIN OUTFIT GENERATOR
//    */
//   async generateOutfits(
//     userId: string,
//     query: string,
//     topK: number,
//     opts: {
//       userStyle?: UserStyle;
//       weather?: WeatherContext;
//       weights?: ContextWeights;
//       useWeather?: boolean;
//       useFeedback?: boolean;
//       styleAgent?: 'agent1' | 'agent2' | 'agent3';
//       sessionId?: string;
//       refinementPrompt?: string;
//       lockedItemIds?: string[]; // 👇 ADD THIS
//     },
//   ) {
//     try {
//       let lockedIds =
//         (opts as any)?.lockedItemIds ?? (opts as any)?.locked_item_ids ?? [];
//       console.log('[CTRL] lockedIds =', lockedIds);
//       // ── Session & refinement handling ───────────────────────────
//       const sessionId = opts?.sessionId?.trim();
//       const refinement = (opts?.refinementPrompt ?? '').trim();
//       console.log('[CTRL] lockedItemIds =', opts?.lockedItemIds);

//       let baseQuery = query;
//       if (sessionId) {
//         const sess = this.sessions.get(sessionId);
//         if (!sess) {
//           this.sessions.set(sessionId, { baseQuery: query, refinements: [] });
//         } else {
//           baseQuery = sess.baseQuery || query;
//           if (refinement) sess.refinements.push(refinement);
//         }
//       }

//       // Build effectiveQuery (what we actually embed and parse for constraints)
//       let effectiveQuery = baseQuery;
//       if (refinement) {
//         effectiveQuery = `${baseQuery}. User refinement: ${refinement}`;
//       } else if (sessionId) {
//         const sess = this.sessions.get(sessionId);
//         if (sess && sess.refinements.length) {
//           effectiveQuery = `${baseQuery}. User refinements: ${sess.refinements.join('; ')}`;
//         }
//       }

//       // Heuristic: detect requested slots/items in the refinement for retrieval/rerank
//       const needSneakers =
//         /\b(sneaker|sneakers|trainers|running shoes?|athletic (?:shoe|shoes))\b/i.test(
//           refinement,
//         );
//       const needShorts = /\bshorts?\b/i.test(refinement);
//       const needLoafers = /\bloafers?\b/i.test(refinement);
//       const needJeans = /\bjeans?\b/i.test(refinement);

//       const isSneaker = (c?: CatalogItem) => {
//         if (!c) return false;
//         const sub = (c.subcategory ?? '').toLowerCase();
//         const lbl = (c.label ?? '').toLowerCase();
//         return /\b(sneakers?|trainers?|running|athletic)\b/i.test(sub || lbl);
//       };
//       const isShorts = (c?: CatalogItem) => {
//         if (!c) return false;
//         const sub = (c.subcategory ?? '').toLowerCase();
//         const lbl = (c.label ?? '').toLowerCase();
//         return /\bshorts?\b/i.test(sub || lbl);
//       };
//       const isLoafers = (c?: CatalogItem) => {
//         if (!c) return false;
//         const sub = (c.subcategory ?? '').toLowerCase();
//         const lbl = (c.label ?? '').toLowerCase();
//         return /\bloafers?\b/i.test(sub || lbl);
//       };
//       const isJeans = (c?: CatalogItem) => {
//         if (!c) return false;
//         const sub = (c.subcategory ?? '').toLowerCase();
//         const lbl = (c.label ?? '').toLowerCase();
//         return /\bjeans?\b/i.test(sub || lbl);
//       };

//       // ── 1) Retrieval on effectiveQuery (NOT just baseQuery) ─────
//       const queryVec = await this.vertex.embedText(effectiveQuery);
//       let matches = await queryUserNs({
//         userId,
//         vector: queryVec,
//         topK,
//         includeMetadata: true,
//       });

//       // ── Inject any explicitly requested color+slot items not in matches ─────────
//       const mustHaves: {
//         color: string;
//         slot: 'shoes' | 'bottoms' | 'tops';
//         name: string;
//       }[] = [];

//       // crude color+slot intent detection
//       if (/\bblack\b/i.test(refinement) && /\bloafers?\b/i.test(refinement)) {
//         mustHaves.push({
//           color: 'black',
//           slot: 'shoes',
//           name: 'black loafers',
//         });
//       }
//       if (/\bbrown\b/i.test(refinement) && /\bshorts?\b/i.test(refinement)) {
//         mustHaves.push({
//           color: 'brown',
//           slot: 'bottoms',
//           name: 'brown shorts',
//         });
//       }
//       // add more color+slot combos as needed

//       if (mustHaves.length) {
//         const { rows } = await pool.query(
//           `SELECT * FROM wardrobe_items
//      WHERE user_id = $1
//        AND main_category ILIKE ANY($2)
//        AND color ILIKE ANY($3)
//      LIMIT 10`,
//           [
//             userId,
//             mustHaves.map((m) =>
//               m.slot === 'shoes'
//                 ? 'Shoes'
//                 : m.slot === 'bottoms'
//                   ? 'Bottoms'
//                   : 'Tops',
//             ),
//             mustHaves.map((m) => `%${m.color}%`),
//           ],
//         );

//         const seen = new Set(
//           matches.map((m) => this.normalizePineconeId(m.id as string).id),
//         );

//         for (const r of rows) {
//           // ✅ Force inject even if seen already
//           if (seen.has(r.id)) {
//             console.log('⚡ Overriding seen for must-have:', r.name);
//           } else {
//             seen.add(r.id);
//           }

//           // ✅ Use real categories from DB row (more robust than hardcoded)
//           const main = r.main_category || 'Shoes';
//           const sub = r.subcategory || 'Loafers';

//           // ✅ Inject as Pinecone-style match with unique ID + forceKeep
//           matches.unshift({
//             id: `${r.id}:forced_musthave`, // ⚡ unique ID → bypass dedupe
//             score: 999, // ⚡ float to top
//             values: new Array(512).fill(0), // ⚡ required so rerank accepts it
//             metadata: {
//               id: r.id,
//               name: r.name,
//               label: r.name,
//               image_url: r.image_url,
//               main_category: main,
//               subcategory: sub,
//               color: r.color,
//               color_family: r.color_family,
//               brand: r.brand,
//               dress_code: r.dress_code,
//               formality_score: r.formality_score,
//               forceKeep: true, // ⚡ survive contextual filters
//             },
//           });

//           // ⚡ Also lock them by real DB ID so they survive all filters
//           if (!lockedIds.includes(r.id)) {
//             lockedIds.push(r.id);
//           }
//         }

//         console.log(
//           '🧩 Injected must-have items into matches:',
//           matches
//             .filter((m) => m.id.endsWith(':forced_musthave'))
//             .map((m) => m.metadata?.name),
//         );
//         console.log(
//           '🧩 MATCHES snapshot after inject:',
//           matches.map((m) => ({
//             rawId: m.id,
//             normId: this.normalizePineconeId(m.id as string).id,
//             name: m.metadata?.name,
//             sub: m.metadata?.subcategory,
//             locked: lockedIds.includes(
//               this.normalizePineconeId(m.id as string).id,
//             ),
//           })),
//         );
//       }

//       // ── 1b) Targeted retrieval boosts for requested items ───────
//       // Pull a smaller batch per requested term and merge to front.
//       const extraFetches: Array<{
//         term: string;
//         tester: (c?: CatalogItem) => boolean;
//       }> = [];
//       if (needSneakers)
//         extraFetches.push({ term: 'sneakers', tester: isSneaker });
//       if (needShorts) extraFetches.push({ term: 'shorts', tester: isShorts });
//       if (needLoafers)
//         extraFetches.push({ term: 'loafers', tester: isLoafers });
//       if (needJeans) extraFetches.push({ term: 'jeans', tester: isJeans });

//       if (extraFetches.length) {
//         const per = Math.max(5, Math.ceil(topK / 2));
//         const seen = new Set(
//           matches.map((m) => this.normalizePineconeId(m.id as string).id),
//         );
//         for (const { term } of extraFetches) {
//           const vec = await this.vertex.embedText(`${baseQuery} ${term}`);
//           const extra = await queryUserNs({
//             userId,
//             vector: vec,
//             topK: per,
//             includeMetadata: true,
//           });
//           // Dedup and prepend
//           const uniques = extra.filter((e) => {
//             const { id } = this.normalizePineconeId(e.id as string);
//             if (seen.has(id)) return false;
//             seen.add(id);
//             return true;
//           });
//           matches = [...uniques, ...matches].slice(
//             0,
//             Math.max(topK, matches.length),
//           );
//         }
//       }

//       console.log('📦 Building catalog from matches, lockedIds =', lockedIds);

//       // ── 2) Build catalog ────────────────────────────────────────
//       let catalog: CatalogItem[] = matches.map((m, i) => {
//         const { id } = this.normalizePineconeId(m.id as string);
//         const meta: any = m.metadata || {};
//         const sub_raw = this.asStr(meta.subcategory ?? meta.subCategory);
//         const main_raw = this.asStr(meta.main_category ?? meta.mainCategory);
//         const main_fix = this.coerceMainCategoryFromSub(main_raw, sub_raw);

//         return {
//           index: i + 1,
//           id,
//           label: this.summarizeItem(meta),

//           image_url: this.asStr(meta.image_url ?? meta.imageUrl),
//           main_category: main_fix,
//           subcategory: sub_raw,
//           color: this.asStr(meta.color ?? meta.color_family),
//           color_family: this.asStr(meta.color_family),
//           shoe_style: this.asStr(meta.shoe_style),
//           dress_code: this.asStr(meta.dress_code ?? meta.dressCode),

//           formality_score: this.asNum(meta.formality_score),

//           brand: this.asStr(meta.brand),
//           material: this.asStr(meta.material),
//           sleeve_length: this.asStr(meta.sleeve_length),
//           layering: this.asStr(meta.layering),
//           waterproof_rating: this.asNum(meta.waterproof_rating),
//           rain_ok: !!meta.rain_ok,
//         };
//       });

//       if (refinement) {
//         const prevLockedIds = Array.isArray(lockedIds) ? lockedIds.slice() : [];
//         const { keepSlots, replaceSlots, additionsBySlot } =
//           this.parseRefinementLocks(refinement, catalog, prevLockedIds);

//         lockedIds = this.mergeLockedIds(
//           prevLockedIds,
//           catalog,
//           keepSlots,
//           replaceSlots,
//           additionsBySlot,
//         );

//         console.log('🔒 Final lockedIds after robust merge:', lockedIds);
//       }

//       // ⚡ Re-lock any injected must-haves that got wiped out during merge
//       for (const m of matches) {
//         const norm = this.normalizePineconeId(m.id as string).id;
//         if (m.id.endsWith(':forced_musthave') && !lockedIds.includes(norm)) {
//           console.log('⚡ Re-locking forced must-have:', norm);
//           lockedIds.push(norm);
//         }
//       }

//       // ── NEW: mark locked items
//       if (lockedIds.length) {
//         for (const item of catalog) {
//           if (lockedIds.includes(item.id)) {
//             (item as any).__locked = true;
//           }
//         }
//         console.log('🔒 Locked items marked:', lockedIds);
//       }

//       console.log(
//         '📦 CATALOG snapshot:',
//         catalog.map((c) => ({
//           id: c.id,
//           label: c.label,
//           sub: c.subcategory,
//           locked: (c as any).__locked,
//           forceKeep: (c as any).forceKeep,
//         })),
//       );

//       // ⛓ Mark locked loafers to always survive filtering
//       for (const item of catalog) {
//         if (
//           (item as any).__locked &&
//           /\bloafers?\b/i.test(item.subcategory ?? '')
//         ) {
//           (item as any).forceKeep = true;
//         }
//       }

//       // Style Agent hard filters
//       // Style Agent 1
//       if (opts?.styleAgent && STYLE_AGENTS[opts.styleAgent]) {
//         const agent = STYLE_AGENTS[opts.styleAgent];

//         catalog = catalog.filter((c) => {
//           // if ((c as any).__locked || (c as any).forceKeep) return true; // ⛓ allow
//           if ((c as any).forceKeep) return true;
//           const brand = (c.brand ?? '').toLowerCase();
//           const color = (c.color ?? '').toLowerCase();
//           const dress = (c.dress_code ?? '').toLowerCase();
//           const sub = (c.subcategory ?? '').toLowerCase();

//           const matchesBrand = agent.favoriteBrands?.some((b) =>
//             brand.includes(b.toLowerCase()),
//           );
//           const matchesColor = agent.preferredColors?.some((col) =>
//             color.includes(col.toLowerCase()),
//           );
//           const matchesDress = agent.dressBias
//             ? dress.includes(agent.dressBias.toLowerCase())
//             : false;

//           // const banned =
//           //   /\b(blazer|dress shirt|loafers?|oxfords?|derbys?|tux|formal)\b/i.test(
//           //     sub,
//           //   );

//           // ⚡ Allow locked items and loafers to bypass banning
//           const banned =
//             /\b(blazer|dress shirt|oxfords?|derbys?|tux|formal)\b/i.test(sub);

//           if ((c as any).__locked || /\bloafers?\b/i.test(sub)) return true;
//           return (matchesBrand || matchesColor || matchesDress) && !banned;
//         });

//         console.log(
//           `🎯 Hard-filtered catalog for ${opts.styleAgent}:`,
//           catalog.length,
//           'items kept',
//         );
//       }

//       // Style Agent 2
//       if (opts?.styleAgent === 'agent2') {
//         catalog = catalog.filter((c) => {
//           // if ((c as any).__locked || (c as any).forceKeep) return true; // ⛓ allow
//           if ((c as any).forceKeep) return true;
//           const sub = (c.subcategory ?? '').toLowerCase();
//           const dress = (c.dress_code ?? '').toLowerCase();
//           const banned =
//             /\b(blazer|sport coat|dress shirt|oxfords?|derbys?|loafers?|dress shoes?|belt)\b/i.test(
//               sub,
//             ) ||
//             dress.includes('business') ||
//             dress.includes('formal');
//           return !banned;
//         });
//         console.log(
//           `🎯 Agent2 negative filter applied: ${catalog.length} items left`,
//         );
//       }

//       // 3) Contextual pre-filters — skip if styleAgent, else use effectiveQuery
//       if (opts?.styleAgent) {
//         console.log(
//           '🎨 Style agent override, skipping contextual filters + constraints',
//         );
//       } else {
//         // ⚡ Keep a copy of locked/forceKeep items before filtering
//         const keepMap = new Map(
//           catalog
//             .filter((c: any) => c.__locked || c.forceKeep)
//             .map((c) => [c.id, c]),
//         );

//         console.log('🎨 Pre-contextual filter catalog count:', catalog.length);

//         // Apply contextual filters
//         catalog = applyContextualFilters(effectiveQuery, catalog, {
//           minKeep: 6,
//         });

//         // 🔒 Restore any locked/forceKeep items that got filtered out
//         for (const [id, item] of keepMap.entries()) {
//           if (!catalog.some((c) => c.id === id)) {
//             catalog.unshift(item);
//           }
//         }
//         console.log('🎨 Post-contextual filter catalog count:', catalog.length);

//         if (keepMap.size) {
//           console.log(
//             '🔒 Restored locked/forceKeep items after contextual filters',
//           );
//         }
//       }

//       // 3b) Feedback filters / soft prefs
//       let feedbackRows: any[] = [];
//       let feedbackRules: any[] = [];
//       let userPrefs = new Map<string, number>();

//       const clientWantsFeedback = opts?.useFeedback !== false; // default ON
//       const envDisable = process.env.DISABLE_FEEDBACK === '1';
//       const disableFeedback = !clientWantsFeedback || envDisable;

//       console.log('[FEEDBACK] useFeedback (client):', opts?.useFeedback);

//       if (!disableFeedback) {
//         feedbackRows = await this.fetchFeedbackRows(userId);
//         feedbackRules = compileFeedbackRulesFromRows(feedbackRows);

//         catalog = applyFeedbackFilters(catalog, feedbackRules, {
//           minKeep: 6,
//           softenWhenBelow: true,
//         });

//         // soft prefs from rules
//         userPrefs = buildUserPrefsFromRules(catalog, feedbackRules);

//         // per-item prefs from DB
//         const prefRes = await pool.query(
//           `SELECT item_id, score FROM user_pref_item WHERE user_id = $1`,
//           [userId],
//         );
//         const prefMap = new Map<string, number>(
//           prefRes.rows.map((r: any) => [String(r.item_id), Number(r.score)]),
//         );
//         for (const [itemId, score] of prefMap) {
//           const existing = userPrefs.get(itemId) ?? 0;
//           userPrefs.set(itemId, existing + score);
//         }
//       } else {
//         console.log('[FEEDBACK] Feedback influence skipped.');
//       }

//       // 3c) Soft-boost requested slots from refinement
//       if (needSneakers || needShorts || needLoafers || needJeans) {
//         for (const c of catalog) {
//           const id = c.id;
//           if (!id) continue;
//           let bonus = 0;
//           if (needSneakers && isSneaker(c)) bonus += 10;
//           if (needShorts && isShorts(c)) bonus += 6;
//           if (needLoafers && isLoafers(c)) bonus += 6;
//           if (needJeans && isJeans(c)) bonus += 6;
//           if (bonus) userPrefs.set(id, (userPrefs.get(id) ?? 0) + bonus);
//         }
//       }

//       // Upscale clamp based on effective query
//       const needUpscale =
//         /\b(upscale|smart\s*casual|business|formal|dressy|rooftop)\b/i.test(
//           effectiveQuery,
//         );

//       const baseConstraints = parseConstraints(effectiveQuery);
//       const constraints = { ...baseConstraints };

//       // weights normalization
//       const incoming = opts?.weights ?? DEFAULT_CONTEXT_WEIGHTS;
//       const longW = toLongWeights(incoming);
//       if (needUpscale && longW.styleWeight > 0.35) {
//         longW.styleWeight = 0.35;
//       }
//       const tunedWeights = fromLongWeights(longW, incoming) as ContextWeights;

//       // Resolve style source
//       let effectiveStyle: UserStyle | undefined;
//       if (opts?.styleAgent && STYLE_AGENTS[opts.styleAgent]) {
//         effectiveStyle = STYLE_AGENTS[opts.styleAgent];
//         console.log(
//           '🎨 Using style agent override:',
//           opts.styleAgent,
//           effectiveStyle,
//         );
//       } else if (opts?.userStyle) {
//         effectiveStyle = opts.userStyle;
//         console.log('👤 Using user style profile:', effectiveStyle);
//       } else {
//         console.log('⚪ No style profile or agent applied');
//       }

//       // Debug
//       console.log('[DEBUG] weights =', tunedWeights);
//       console.log('[DEBUG] useWeather =', opts?.useWeather);
//       console.log('[DEBUG] useFeedback =', opts?.useFeedback);
//       console.log(
//         '[DEBUG] userPrefs (from feedback/refinement) =',
//         Array.from(userPrefs.entries()),
//       );

//       // 4) Rerank
//       let reranked: CatalogItem[];
//       if (opts?.styleAgent && STYLE_AGENTS[opts.styleAgent]) {
//         console.log('🎨 StyleAgent mode → style-only rerank');
//         const longW2 = toLongWeights(tunedWeights);
//         reranked = rerankCatalogWithContext(catalog, {} as any, {
//           userStyle: STYLE_AGENTS[opts.styleAgent],
//           weights: {
//             constraintsWeight: 0,
//             styleWeight: longW2.styleWeight ?? 1.0,
//             weatherWeight: opts.useWeather ? (longW2.weatherWeight ?? 0.8) : 0,
//             feedbackWeight: 0,
//           },
//           useWeather: opts.useWeather,
//         });
//       } else {
//         reranked = rerankCatalogWithContext(catalog, constraints, {
//           userStyle: effectiveStyle,
//           weather: opts?.weather,
//           weights: tunedWeights,
//           useWeather: opts?.useWeather,
//           userPrefs,
//         });
//       }

//       // ── NEW: Hard lock items so they always stay in outfits
//       if (lockedIds.length) {
//         reranked = reranked.map((item) =>
//           lockedIds.includes(item.id)
//             ? { ...item, __locked: true, rerankScore: Number.MAX_SAFE_INTEGER }
//             : item,
//         );

//         console.log('🔒 Locked items enforced:', lockedIds);
//       }

//       // ── Force locked items to the very front as indices 1..N ──
//       const locked = reranked.filter((it) => (it as any).__locked);
//       const unlocked = reranked.filter((it) => !(it as any).__locked);
//       const workingCatalog = [...locked, ...unlocked].map((item, i) => ({
//         ...item,
//         index: i + 1,
//       }));

//       // 🔢 Map locked items to their current workingCatalog indices
//       const wcIndex = new Map(workingCatalog.map((c) => [c.id, c.index]));
//       const lockedLines = locked
//         .map((l) => `${wcIndex.get(l.id)!}. ${l.label}`)
//         .join('\n');

//       const catalogLines = workingCatalog
//         .map((c) => `${c.index}. ${c.label}`)
//         .join('\n');

//       let fullPrompt = buildOutfitPrompt(catalogLines, effectiveQuery);
//       if (refinement) fullPrompt += `\n\nUser refinement: ${refinement}`;
//       if (locked.length) {
//         fullPrompt += `

// LOCKED ITEMS (MANDATORY):
// - These locked items MUST appear in every single outfit.
// - Do NOT remove, swap, or omit them under any circumstance.
// - Only choose additional non-locked items to complete the outfit.
// ${lockedLines}
// `;
//       }

//       console.log('📝 Final prompt for outfit generation:\n', fullPrompt);

//       // 6) LLM call and parse
//       const raw = await this.vertex.generateReasonedOutfit(fullPrompt);
//       const text =
//         (raw?.candidates?.[0]?.content?.parts?.[0]?.text as string) ??
//         (typeof raw === 'string' ? raw : '');
//       const parsed = extractStrictJson(text);

//       // Map by index (use workingCatalog indices only)
//       const byIndex = new Map<number, (typeof workingCatalog)[number]>();
//       workingCatalog.forEach((c) => byIndex.set(c.index, c));
//       // Do not add from 'catalog'; those indices are stale after reindexing.

//       // 7) Build outfits
//       let outfits = (parsed.outfits || []).map((o: any) => ({
//         title: String(o.title ?? 'Outfit'),
//         items: Array.isArray(o.items)
//           ? (o.items
//               .map((it: any) => {
//                 if (typeof it === 'number') return byIndex.get(it);
//                 if (typeof it === 'string') {
//                   const n = Number(it.trim());
//                   if (!Number.isNaN(n)) return byIndex.get(n);
//                   return catalog.find(
//                     (c) => c.label.toLowerCase() === it.toLowerCase(),
//                   );
//                 }
//                 return undefined;
//               })
//               .filter(Boolean) as CatalogItem[])
//           : [],
//         why: String(o.why ?? ''),
//         missing: o.missing ? String(o.missing) : undefined,
//       }));

//       // ⛓ Ensure locked items are always present in every outfit
//       if (locked.length) {
//         outfits = outfits.map((o) => {
//           const ids = new Set(o.items.map((it) => it.id));
//           const mustAdd = locked.filter((l) => !ids.has(l.id));
//           if (mustAdd.length) {
//             console.log(
//               '🔒 Injecting missing locked items into outfit',
//               o.title,
//               mustAdd.map((i) => i.id),
//             );
//           }
//           return { ...o, items: [...mustAdd, ...o.items] };
//         });
//       }

//       // // inject locked items into every outfit
//       // if (locked.length) {
//       //   outfits = outfits.map((o) => {
//       //     const ids = new Set(o.items.map((it) => it?.id));
//       //     const mustAdd = locked.filter((l) => !ids.has(l.id));
//       //     return { ...o, items: [...mustAdd, ...o.items] };
//       //   });
//       // }

//       // ── Hard repair of slots (TOP/BOTTOM/SHOES + gym sneakers) ──
//       const toLc = (s?: string) => (s ?? '').toLowerCase();
//       const gymIntent = /\b(gym|work ?out|workout|training|exercise)\b/i.test(
//         effectiveQuery,
//       );

//       const isBottom = (c?: CatalogItem) => {
//         if (!c) return false;
//         const main = toLc(c.main_category);
//         const sub = toLc(c.subcategory);
//         const lbl = toLc(c.label);
//         return (
//           main === 'bottoms' ||
//           /\b(trouser|pants|jeans|chinos|shorts|joggers?|sweatpants?|track\s*pants?)\b/i.test(
//             sub,
//           ) ||
//           /\bshorts?\b/i.test(lbl)
//         );
//       };
//       const isShoes = (c?: CatalogItem) => {
//         if (!c) return false;
//         const main = toLc(c.main_category);
//         const sub = toLc(c.subcategory);
//         return (
//           main === 'shoes' ||
//           /\b(sneakers?|trainers?|running|athletic|loafers?|boots?|oxfords?|derbys?|dress\s*shoes?|sandals?)\b/i.test(
//             sub,
//           )
//         );
//       };
//       const isTop = (c?: CatalogItem) => {
//         if (!c) return false;
//         const main = toLc(c.main_category);
//         const sub = toLc(c.subcategory);
//         return (
//           main === 'tops' ||
//           /\b(t-?shirt|tee|polo|shirt|sweater|knit|henley|hoodie)\b/i.test(sub)
//         );
//       };
//       const orderRank = (c: CatalogItem) =>
//         isTop(c) ? 1 : isBottom(c) ? 2 : isShoes(c) ? 3 : 4;

//       const firstBottom = reranked.find(isBottom);
//       const firstShoes = reranked.find(isShoes);
//       const firstSneaker = reranked.find(isSneaker);
//       const firstShorts = reranked.find(isShorts);
//       const firstTop = reranked.find(isTop);

//       outfits = outfits.map((o) => {
//         const haveBottom = o.items.some(isBottom);
//         const haveShoes = o.items.some(isShoes);
//         const haveSneaker = o.items.some(isSneaker);
//         const haveShorts = o.items.some(isShorts);
//         const already = new Set(o.items.map((x) => x?.id));

//         // Gym / refinement: sneakers required if asked
//         if (
//           (gymIntent || needSneakers) &&
//           !haveSneaker &&
//           firstSneaker &&
//           !already.has(firstSneaker.id)
//         ) {
//           o.items.push(firstSneaker);
//           o.missing = o.missing || 'auto-added sneakers';
//           already.add(firstSneaker.id);
//         }

//         // Refinement: prefer shorts if asked
//         if (
//           needShorts &&
//           !haveShorts &&
//           firstShorts &&
//           !already.has(firstShorts.id)
//         ) {
//           o.items.push(firstShorts);
//           o.missing = o.missing || 'auto-added shorts';
//           already.add(firstShorts.id);
//         }

//         // Always ensure a bottom exists
//         if (!haveBottom && firstBottom && !already.has(firstBottom.id)) {
//           o.items.push(firstBottom);
//           o.missing = o.missing || 'auto-added bottom';
//           already.add(firstBottom.id);
//         }

//         // Always ensure some shoes exist
//         if (!haveShoes && firstShoes && !already.has(firstShoes.id)) {
//           o.items.push(firstShoes);
//           o.missing = o.missing || 'auto-added shoes';
//           already.add(firstShoes.id);
//         }

//         // Ensure at least one top
//         if (!o.items.some(isTop) && firstTop && !already.has(firstTop.id)) {
//           o.items.unshift(firstTop);
//           o.missing = o.missing || 'auto-added top';
//           already.add(firstTop.id);
//         }

//         o.items = [...o.items].sort((a, b) => orderRank(a) - orderRank(b));
//         return o;
//       });

//       // finalize + enforce + retitle
//       outfits = outfits.map((o) =>
//         finalizeOutfitSlots(o, reranked, effectiveQuery),
//       );
//       outfits = enforceConstraintsOnOutfits(
//         outfits as any,
//         reranked as any,
//         effectiveQuery,
//       ) as any;

//       outfits = outfits.map((o) => {
//         const { title, why } = this.retitleOutfit(o);
//         return { ...o, title, why };
//       });

//       // Minimal personalization via per-item prefs
//       const withIds = outfits.map((o) => ({ ...o, outfit_id: randomUUID() }));
//       const ids = Array.from(
//         new Set(
//           withIds.flatMap((o) =>
//             o.items.map((it: any) => it?.id).filter(Boolean),
//           ),
//         ),
//       ) as string[];

//       await pool.query(
//         `CREATE TABLE IF NOT EXISTS user_pref_item(
//          user_id TEXT NOT NULL,
//          item_id TEXT NOT NULL,
//          score REAL NOT NULL DEFAULT 0,
//          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
//          PRIMARY KEY (user_id, item_id)
//        );`,
//       );

//       const prefRows =
//         ids.length > 0
//           ? await pool.query(
//               'SELECT item_id, score FROM user_pref_item WHERE user_id = $1 AND item_id = ANY($2)',
//               [userId, ids],
//             )
//           : { rows: [] as any[] };

//       const pref = new Map<string, number>(
//         prefRows.rows.map((r: any) => [String(r.item_id), Number(r.score)]),
//       );

//       const ranked = withIds
//         .map((o) => {
//           const items = o.items as any[];
//           const boost =
//             items.length === 0
//               ? 0
//               : items.reduce((a, it) => a + (pref.get(it?.id) ?? 0), 0) /
//                 items.length;
//           return { o, boost };
//         })
//         .sort((a, b) => b.boost - a.boost);

//       const best = ranked[0]?.o ??
//         withIds[0] ?? {
//           items: [],
//           why: '',
//           missing: undefined,
//           outfit_id: 'o1',
//         };

//       const request_id = randomUUID();

//       if (process.env.NODE_ENV !== 'production') {
//         console.dir(
//           {
//             level: 'OUTFIT_RESULT',
//             request_id,
//             user_id: userId,
//             query: effectiveQuery, // ← log the combined query
//             best_outfit: {
//               outfit_id: (best as any).outfit_id,
//               title: (best as any).title,
//               why: (best as any).why,
//               missing: (best as any).missing,
//               items: (best as any).items.map((it: any) => ({
//                 id: it?.id,
//                 label: it?.label,
//                 image_url: it?.image_url,
//                 main_category: it?.main_category,
//                 subcategory: it?.subcategory,
//                 brand: it?.brand,
//                 color: it?.color,
//                 dress_code: it?.dress_code,
//                 formality_score: it?.formality_score,
//               })),
//             },
//             all_outfits: withIds.map((o) => ({
//               outfit_id: o.outfit_id,
//               title: o.title,
//               why: o.why,
//               missing: o.missing,
//               items: o.items.map((it) => ({
//                 id: it?.id,
//                 label: it?.label,
//                 image_url: it?.image_url,
//                 main_category: it?.main_category,
//                 subcategory: it?.subcategory,
//                 brand: it?.brand,
//                 color: it?.color,
//                 dress_code: it?.dress_code,
//                 formality_score: it?.formality_score,
//               })),
//             })),
//           },
//           { depth: null },
//         );
//       }

//       return {
//         request_id,
//         outfit_id: (best as any).outfit_id,
//         items: (best as any).items,
//         why: (best as any).why,
//         missing: (best as any).missing,
//         outfits: withIds,
//       };
//     } catch (err: any) {
//       console.error('❌ Error in generateOutfits:', err.message, err.stack);
//       throw err;
//     }
//   }

//   /**
//    * Defensive extractor for various LLM wrapper shapes.
//    */
//   private extractModelText(output: any): string {
//     if (typeof output === 'string') return output;

//     const parts = output?.candidates?.[0]?.content?.parts;
//     if (Array.isArray(parts)) {
//       const joined = parts.map((p: any) => p?.text ?? '').join('');
//       if (joined) return joined;
//     }
//     if (typeof output?.text === 'string') return output.text;
//     return JSON.stringify(output ?? '');
//   }

//   private parseModelJson(s: string): any {
//     const cleaned = s
//       .replace(/^\s*```(?:json)?\s*/i, '')
//       .replace(/\s*```\s*$/i, '')
//       .trim();

//     try {
//       return JSON.parse(cleaned);
//     } catch {
//       const m = cleaned.match(/\{[\s\S]*\}/);
//       if (m) return JSON.parse(m[0]);
//       throw new Error('Model did not return valid JSON.');
//     }
//   }

//   // More text-normalizers
//   private normalizeDressCode(val?: string | null) {
//     const s = this.normLower(val);
//     if (!s) return undefined;
//     const map: Record<
//       string,
//       | 'UltraCasual'
//       | 'Casual'
//       | 'SmartCasual'
//       | 'BusinessCasual'
//       | 'Business'
//       | 'BlackTie'
//     > = {
//       ultracasual: 'UltraCasual',
//       ultra_casual: 'UltraCasual',
//       casual: 'Casual',
//       smartcasual: 'SmartCasual',
//       smart_casual: 'SmartCasual',
//       businesscasual: 'BusinessCasual',
//       business_casual: 'BusinessCasual',
//       business: 'Business',
//       blacktie: 'BlackTie',
//       black_tie: 'BlackTie',
//       'black tie': 'BlackTie',
//     };
//     return map[s];
//   }
//   private normalizeLayering(val?: string | null) {
//     const s = this.normLower(val);
//     if (!s) return undefined;
//     const map: Record<string, string> = {
//       base: 'BASE',
//       baselayer: 'BASE',
//       'base layer': 'BASE',
//       mid: 'MID',
//       midlayer: 'MID',
//       'mid layer': 'MID',
//       shell: 'SHELL',
//       outer: 'SHELL',
//       outerwear: 'SHELL',
//       jacket: 'SHELL',
//       accent: 'ACCENT',
//       accessory: 'ACCENT',
//       acc: 'ACCENT',
//     };
//     return map[s];
//   }

//   // DTO-facing normalizers
//   private normalizeMainCategory(
//     val?: string | null,
//   ): CreateWardrobeItemDto['main_category'] {
//     const unions: CreateWardrobeItemDto['main_category'][] = [
//       'Tops',
//       'Bottoms',
//       'Outerwear',
//       'Shoes',
//       'Accessories',
//       'Undergarments',
//       'Activewear',
//       'Formalwear',
//       'Loungewear',
//       'Sleepwear',
//       'Swimwear',
//       'Maternity',
//       'Unisex',
//       'Costumes',
//       'TraditionalWear',
//     ];
//     const raw = (val ?? '').toString().trim();
//     if (unions.includes(raw as any))
//       return raw as CreateWardrobeItemDto['main_category'];
//     const s = raw.toLowerCase();
//     const map: Record<string, CreateWardrobeItemDto['main_category']> = {
//       top: 'Tops',
//       tops: 'Tops',
//       tshirt: 'Tops',
//       't-shirt': 'Tops',
//       tee: 'Tops',
//       shirt: 'Tops',
//       blouse: 'Tops',
//       knit: 'Tops',
//       sweater: 'Tops',
//       bottom: 'Bottoms',
//       bottoms: 'Bottoms',
//       pants: 'Bottoms',
//       trousers: 'Bottoms',
//       jeans: 'Bottoms',
//       chinos: 'Bottoms',
//       shorts: 'Bottoms',
//       skirt: 'Bottoms',
//       outer: 'Outerwear',
//       outerwear: 'Outerwear',
//       jacket: 'Outerwear',
//       coat: 'Outerwear',
//       parka: 'Outerwear',
//       blazer: 'Outerwear',
//       shoe: 'Shoes',
//       shoes: 'Shoes',
//       sneaker: 'Shoes',
//       sneakers: 'Shoes',
//       boot: 'Shoes',
//       boots: 'Shoes',
//       heel: 'Shoes',
//       loafers: 'Shoes',
//       accessory: 'Accessories',
//       accessories: 'Accessories',
//       bag: 'Accessories',
//       belt: 'Accessories',
//       hat: 'Accessories',
//       scarf: 'Accessories',
//       tie: 'Accessories',
//       sunglasses: 'Accessories',
//       watch: 'Accessories',
//       underwear: 'Undergarments',
//       undergarments: 'Undergarments',
//       bra: 'Undergarments',
//       briefs: 'Undergarments',
//       socks: 'Undergarments',
//       active: 'Activewear',
//       activewear: 'Activewear',
//       athleisure: 'Activewear',
//       gym: 'Activewear',
//       formal: 'Formalwear',
//       formalwear: 'Formalwear',
//       suit: 'Formalwear',
//       tuxedo: 'Formalwear',
//       lounge: 'Loungewear',
//       loungewear: 'Loungewear',
//       sweats: 'Loungewear',
//       sleep: 'Sleepwear',
//       sleepwear: 'Sleepwear',
//       pajama: 'Sleepwear',
//       pajamas: 'Sleepwear',
//       swim: 'Swimwear',
//       swimwear: 'Swimwear',
//       swimsuit: 'Swimwear',
//       trunks: 'Swimwear',
//       bikini: 'Swimwear',
//       maternity: 'Maternity',
//       unisex: 'Unisex',
//       costume: 'Costumes',
//       costumes: 'Costumes',
//       'traditional wear': 'TraditionalWear',
//       traditionalwear: 'TraditionalWear',
//       kimono: 'TraditionalWear',
//       sari: 'TraditionalWear',
//     };
//     return map[s] ?? 'Tops';
//   }
//   private resolveMainCategory(
//     rawMain?: string | null,
//     sub?: string | null,
//     layering?: string | null,
//   ): CreateWardrobeItemDto['main_category'] {
//     const normalized = this.normalizeMainCategory(rawMain);
//     const s = (sub ?? '').toLowerCase();
//     const lay = (layering ?? '').toUpperCase();
//     if (
//       [
//         'blazer',
//         'sport coat',
//         'sportcoat',
//         'suit jacket',
//         'jacket',
//         'coat',
//         'parka',
//         'trench',
//         'overcoat',
//         'topcoat',
//       ].some((k) => s.includes(k))
//     )
//       return 'Outerwear';
//     if (
//       [
//         'loafer',
//         'loafers',
//         'sneaker',
//         'sneakers',
//         'boot',
//         'boots',
//         'heel',
//         'heels',
//         'pump',
//         'oxford',
//         'derby',
//         'dress shoe',
//         'dress shoes',
//         'sandal',
//         'sandals',
//       ].some((k) => s.includes(k))
//     )
//       return 'Shoes';
//     if (
//       [
//         'belt',
//         'hat',
//         'scarf',
//         'tie',
//         'watch',
//         'sunglasses',
//         'bag',
//         'briefcase',
//       ].some((k) => s.includes(k))
//     )
//       return 'Accessories';
//     if (normalized === 'Tops' && lay === 'SHELL') return 'Outerwear';
//     return normalized;
//   }
//   private normalizePatternScaleDto(
//     val?: string | null,
//   ): CreateWardrobeItemDto['pattern_scale'] | undefined {
//     const s = (val ?? '').toString().trim().toLowerCase();
//     if (!s) return undefined;
//     if (['micro', 'subtle', '0', '-1', 'small'].includes(s)) return 'Micro';
//     if (['medium', 'mid', '1'].includes(s)) return 'Medium';
//     if (['bold', 'large', 'big', '2'].includes(s)) return 'Bold';
//     return undefined;
//   }
//   private normalizeSeasonalityDto(
//     val?: string | null,
//   ): CreateWardrobeItemDto['seasonality'] | undefined {
//     const s = (val ?? '').toString().trim().toLowerCase();
//     if (!s) return undefined;
//     if (['spring', 'spr', 'ss', 's/s'].includes(s)) return 'Spring';
//     if (['summer', 'ss2'].includes(s)) return 'Summer';
//     if (['fall', 'autumn', 'fw', 'f/w'].includes(s)) return 'Fall';
//     if (['winter', 'win'].includes(s)) return 'Winter';
//     if (
//       [
//         'all',
//         'allseason',
//         'all-season',
//         'all season',
//         'year-round',
//         'year round',
//         'all_season',
//         'allseasonal',
//         'allseasonwear',
//       ].includes(s)
//     )
//       return 'AllSeason';
//     return undefined;
//   }
//   private normalizeLayeringDto(
//     val?: string | null,
//   ): CreateWardrobeItemDto['layering'] | undefined {
//     const s = (val ?? '').toString().trim().toLowerCase();
//     if (!s) return undefined;
//     if (['base', 'base layer', 'baselayer'].includes(s)) return 'Base';
//     if (['mid', 'midlayer', 'mid layer'].includes(s)) return 'Mid';
//     if (['outer', 'outerwear', 'jacket', 'shell'].includes(s)) return 'Outer';
//     return undefined;
//   }
//   private normalizeColorTemp(val?: string | null) {
//     const s = this.normLower(val);
//     if (!s) return undefined;
//     const map: Record<string, string> = {
//       warm: 'Warm',
//       cool: 'Cool',
//       neutral: 'Neutral',
//     };
//     return map[s] ?? undefined;
//   }
//   private normalizeContrast(val?: string | null) {
//     const s = this.normLower(val);
//     if (!s) return undefined;
//     const map: Record<string, string> = {
//       low: 'Low',
//       medium: 'Medium',
//       med: 'Medium',
//       high: 'High',
//     };
//     return map[s] ?? undefined;
//   }

//   /**
//    * Pinecone id helper
//    */
//   private normalizePineconeId(raw: string | undefined | null): {
//     id: string;
//     modality: 'text' | 'image' | 'unknown';
//   } {
//     if (!raw) return { id: '', modality: 'unknown' };
//     const [base, modality] = String(raw).split(':');
//     return {
//       id: base,
//       modality:
//         modality === 'text' || modality === 'image' ? modality : 'unknown',
//     };
//   }

//   private extractFileName(url: string): string {
//     const parts = url.split('/');
//     return decodeURIComponent(parts[parts.length - 1].split('?')[0]);
//   }

//   private sanitizeMeta(
//     raw: Record<string, any>,
//   ): Record<string, string | number | boolean | string[]> {
//     const out: Record<string, string | number | boolean | string[]> = {};
//     for (const [k, v] of Object.entries(raw)) {
//       if (v === undefined || v === null) continue;
//       if (k === 'metadata') {
//         out['meta_json'] = typeof v === 'string' ? v : JSON.stringify(v);
//         continue;
//       }
//       if (Array.isArray(v)) {
//         out[k] = v.map((x) => String(x)).filter((x) => x.length > 0);
//         continue;
//       }
//       switch (typeof v) {
//         case 'string':
//           out[k] = v;
//           break;
//         case 'number':
//           if (Number.isFinite(v)) out[k] = v;
//           break;
//         case 'boolean':
//           out[k] = v;
//           break;
//         case 'object':
//           out[k] = JSON.stringify(v);
//           break;
//       }
//     }
//     return out;
//   }

//   private toCamel(row: any) {
//     if (!row) return row;
//     return {
//       ...row,
//       userId: row.user_id,
//       image: row.image_url,
//       gsutilUri: row.gsutil_uri,
//       objectKey: row.object_key,
//       aiTitle: row.ai_title,
//       aiDescription: row.ai_description,
//       aiKeyAttributes: row.ai_key_attributes,
//       aiConfidence: row.ai_confidence,
//       mainCategory: row.main_category,
//       subCategory: row.subcategory,
//       styleDescriptors: row.style_descriptors,
//       styleArchetypes: row.style_archetypes,
//       anchorRole: row.anchor_role,
//       occasionTags: row.occasion_tags,
//       dressCode: row.dress_code,
//       formalityScore: row.formality_score,
//       dominantHex: row.dominant_hex,
//       paletteHex: row.palette_hex,
//       colorFamily: row.color_family,
//       colorTemp: row.color_temp,
//       contrastProfile: row.contrast_profile,
//       fabricBlend: row.fabric_blend,
//       fabricWeightGsm: row.fabric_weight_gsm,
//       wrinkleResistance: row.wrinkle_resistance,
//       stretchDirection: row.stretch_direction,
//       stretchPct: row.stretch_pct,
//       sizeSystem: row.size_system,
//       sizeLabel: row.size_label,
//       inseamIn: row.inseam_in,
//       seasonalityArr: row.seasonality_arr,
//       goesWithIds: row.goes_with_ids,
//       avoidWithIds: row.avoid_with_ids,
//       userRating: row.user_rating,
//       fitConfidence: row.fit_confidence,
//       outfitFeedback: row.outfit_feedback,
//       dislikedFeatures: row.disliked_features,
//       purchaseDate: row.purchase_date,
//       purchasePrice: row.purchase_price,
//       countryOfOrigin: row.country_of_origin,
//       lastWornAt: row.last_worn_at,
//       rotationPriority: row.rotation_priority,
//       createdAt: row.created_at,
//       updatedAt: row.updated_at,
//       deletedAt: row.deleted_at,
//     };
//   }

//   composeFromAiDraft(
//     base: Partial<CreateWardrobeItemDto>,
//     draft: Record<string, any>,
//   ): CreateWardrobeItemDto {
//     const pick = <T>(k: string, fallback?: T): T | undefined =>
//       (base as any)[k] ?? (draft?.[k] as T) ?? fallback;

//     const name = pick<string>('name') ?? draft?.ai_title ?? 'Wardrobe Item';

//     const rawSub =
//       pick<string>('subcategory') ??
//       draft?.subcategory ??
//       (draft as any)?.subCategory;
//     const layeringRaw = pick<string>('layering') ?? draft?.layering;

//     const rawMain =
//       (base as any).main_category ??
//       (draft?.main_category as string | undefined) ??
//       (draft?.category as string | undefined);

//     const main_category: CreateWardrobeItemDto['main_category'] =
//       this.resolveMainCategory(rawMain, rawSub, layeringRaw);

//     const layering = this.normalizeLayeringDto(layeringRaw);
//     const pattern_scale = this.normalizePatternScaleDto(
//       pick<string>('pattern_scale') ?? draft?.pattern_scale,
//     );
//     const seasonality = this.normalizeSeasonalityDto(
//       pick<string>('seasonality') ?? draft?.seasonality,
//     );

//     const rawTags =
//       pick<string[] | string>('tags') ?? (draft?.tags as any) ?? [];
//     const tags: string[] = Array.isArray(rawTags)
//       ? rawTags.filter(Boolean).map(String)
//       : String(rawTags)
//           .split(',')
//           .map((t) => t.trim())
//           .filter(Boolean);

//     const parseNum = (x: any) =>
//       typeof x === 'number'
//         ? x
//         : typeof x === 'string' && x.trim() !== '' && !Number.isNaN(+x)
//           ? Number(x)
//           : undefined;

//     return {
//       user_id: String(base.user_id),
//       image_url: String(base.image_url),
//       name,
//       main_category,

//       gsutil_uri: pick('gsutil_uri'),
//       object_key: pick('object_key'),

//       subcategory: pick('subcategory'),
//       color: pick('color'),
//       material: pick('material'),
//       fit: pick('fit'),
//       size: pick('size'),
//       brand: pick('brand'),
//       tags,

//       style_descriptors: draft?.style_descriptors,
//       style_archetypes: draft?.style_archetypes,
//       anchor_role: draft?.anchor_role,
//       occasion_tags: draft?.occasion_tags,
//       dress_code: draft?.dress_code,
//       formality_score: draft?.formality_score,

//       dominant_hex: draft?.dominant_hex,
//       palette_hex: draft?.palette_hex,
//       color_family: draft?.color_family,
//       color_temp: draft?.color_temp,
//       contrast_profile: draft?.contrast_profile,

//       pattern: draft?.pattern,
//       pattern_scale,

//       seasonality,
//       seasonality_arr: draft?.seasonality_arr,
//       layering,
//       thermal_rating: draft?.thermal_rating,
//       breathability: draft?.breathability,
//       rain_ok: draft?.rain_ok,
//       wind_ok: draft?.wind_ok,
//       waterproof_rating: draft?.waterproof_rating,
//       climate_sweetspot_f_min: draft?.climate_sweetspot_f_min,
//       climate_sweetspot_f_max: draft?.climate_sweetspot_f_max,

//       fabric_blend: draft?.fabric_blend,
//       fabric_weight_gsm: draft?.fabric_weight_gsm,
//       wrinkle_resistance: draft?.wrinkle_resistance,
//       stretch_direction: draft?.stretch_direction,
//       stretch_pct: draft?.stretch_pct,
//       thickness: draft?.thickness,
//       size_system: draft?.size_system,
//       size_label: draft?.size_label,
//       measurements: draft?.measurements,
//       width: draft?.width,
//       height: draft?.height,

//       neckline: draft?.neckline,
//       collar_type: draft?.collar_type,
//       sleeve_length: draft?.sleeve_length,
//       hem_style: draft?.hem_style,
//       rise: draft?.rise,
//       leg: draft?.leg,
//       inseam_in: draft?.inseam_in,
//       cuff: draft?.cuff,
//       lapel: draft?.lapel,
//       closure: draft?.closure,
//       length_class: draft?.length_class,
//       shoe_style: draft?.shoe_style,
//       sole: draft?.sole,
//       toe_shape: draft?.toe_shape,

//       care_symbols: draft?.care_symbols,
//       wash_temp_c: draft?.wash_temp_c,
//       dry_clean: draft?.dry_clean,
//       iron_ok: draft?.iron_ok,

//       retailer: draft?.retailer,
//       purchase_date: draft?.purchase_date,
//       purchase_price: draft?.purchase_price,
//       country_of_origin: draft?.country_of_origin,
//       condition: draft?.condition,
//       defects_notes: draft?.defects_notes,

//       ai_title: draft?.ai_title,
//       ai_description: draft?.ai_description,
//       ai_key_attributes: draft?.ai_key_attributes,
//       ai_confidence: parseNum(draft?.ai_confidence),

//       metadata: (base as any).metadata,
//       constraints: (base as any).constraints,
//     };
//   }

//   // CREATE
//   async createItem(dto: CreateWardrobeItemDto) {
//     const cols: string[] = [];
//     const vals: any[] = [];
//     const params: string[] = [];
//     let i = 1;

//     const add = (col: string, val: any, kind: 'json' | 'raw' = 'raw') => {
//       if (val === undefined) return;
//       if (Array.isArray(val) && val.length === 0) return;
//       cols.push(col);
//       if (kind === 'json' && val !== null) {
//         vals.push(JSON.stringify(val));
//       } else {
//         vals.push(val);
//       }
//       params.push(`$${i++}`);
//     };

//     // REQUIRED
//     add('user_id', dto.user_id);
//     add('image_url', dto.image_url);
//     add('name', dto.name);
//     add('main_category', dto.main_category);

//     // Optional core/meta
//     add('subcategory', dto.subcategory);
//     add('color', dto.color);
//     add('material', dto.material);
//     add('fit', dto.fit);
//     add('size', dto.size);
//     add('brand', dto.brand);
//     add('gsutil_uri', dto.gsutil_uri);
//     add('object_key', dto.object_key);
//     add('metadata', dto.metadata, 'json');
//     add('width', dto.width);
//     add('height', dto.height);
//     add('tags', dto.tags);

//     // Visuals & styling
//     add('style_descriptors', dto.style_descriptors);
//     add('style_archetypes', dto.style_archetypes);
//     add('anchor_role', this.normalizeAnchorRole(dto.anchor_role));

//     const normalizedPattern = this.normalizePattern(dto.pattern);
//     if (
//       normalizedPattern &&
//       WardrobeService.PATTERN_ENUM_WHITELIST.includes(normalizedPattern)
//     ) {
//       add('pattern', normalizedPattern);
//     }
//     if (dto.pattern_scale !== undefined) {
//       add(
//         'pattern_scale',
//         this.normalizePatternScaleDto(dto.pattern_scale) ?? null,
//       );
//     }

//     add('dominant_hex', dto.dominant_hex);
//     add('palette_hex', dto.palette_hex);
//     add('color_family', dto.color_family);
//     add('color_temp', this.normalizeColorTemp(dto.color_temp));
//     add('contrast_profile', this.normalizeContrast(dto.contrast_profile));

//     // Occasion & formality
//     add('occasion_tags', dto.occasion_tags);
//     add('dress_code', this.normalizeDressCode(dto.dress_code));
//     add('formality_score', dto.formality_score);

//     // Seasonality & climate (ENUMS)
//     const normalizedSeasonality = this.normalizeSeasonality(dto.seasonality);
//     if (
//       normalizedSeasonality &&
//       WardrobeService.SEASONALITY_ENUM_WHITELIST.includes(normalizedSeasonality)
//     ) {
//       add('seasonality', normalizedSeasonality);
//     }
//     const normalizedLayering = this.normalizeLayering(dto.layering);
//     if (
//       normalizedLayering &&
//       WardrobeService.LAYERING_ENUM_WHITELIST.includes(normalizedLayering)
//     ) {
//       add('layering', normalizedLayering);
//     }

//     add('seasonality_arr', dto.seasonality_arr);
//     add('thermal_rating', dto.thermal_rating);
//     add('breathability', dto.breathability);
//     add('rain_ok', dto.rain_ok);
//     add('wind_ok', dto.wind_ok);
//     add('waterproof_rating', dto.waterproof_rating);
//     add('climate_sweetspot_f_min', dto.climate_sweetspot_f_min);
//     add('climate_sweetspot_f_max', dto.climate_sweetspot_f_max);

//     // Construction & sizing
//     add('fabric_blend', dto.fabric_blend, 'json');
//     add('fabric_weight_gsm', dto.fabric_weight_gsm);
//     add('wrinkle_resistance', dto.wrinkle_resistance);
//     add('stretch_direction', dto.stretch_direction);
//     add('stretch_pct', dto.stretch_pct);
//     add('thickness', dto.thickness);
//     add('size_system', dto.size_system);
//     add('size_label', dto.size_label);
//     add('measurements', dto.measurements, 'json');

//     // Silhouette & cut
//     add('neckline', dto.neckline);
//     add('collar_type', dto.collar_type);
//     add('sleeve_length', dto.sleeve_length);
//     add('hem_style', dto.hem_style);
//     add('rise', dto.rise);
//     add('leg', dto.leg);
//     add('inseam_in', dto.inseam_in);
//     add('cuff', dto.cuff);
//     add('lapel', dto.lapel);
//     add('closure', dto.closure);
//     add('length_class', dto.length_class);
//     add('shoe_style', dto.shoe_style);
//     add('sole', dto.sole);
//     add('toe_shape', dto.toe_shape);

//     // Care
//     add('care_symbols', dto.care_symbols);
//     add('wash_temp_c', dto.wash_temp_c);
//     add('dry_clean', dto.dry_clean);
//     add('iron_ok', dto.iron_ok);

//     // Usage
//     add('wear_count', dto.wear_count ?? 0);
//     add('last_worn_at', dto.last_worn_at);
//     add('rotation_priority', dto.rotation_priority);

//     // Commerce & provenance
//     add('purchase_date', dto.purchase_date);
//     add('purchase_price', dto.purchase_price);
//     add('retailer', dto.retailer);
//     add('country_of_origin', dto.country_of_origin);
//     add('condition', dto.condition);
//     add('defects_notes', dto.defects_notes);

//     // Pairing & feedback
//     add('goes_with_ids', dto.goes_with_ids);
//     add('avoid_with_ids', dto.avoid_with_ids);
//     add('user_rating', dto.user_rating);
//     add('fit_confidence', dto.fit_confidence);
//     add('outfit_feedback', dto.outfit_feedback, 'json');
//     add('disliked_features', dto.disliked_features);

//     // AI
//     add('ai_title', dto.ai_title);
//     add('ai_description', dto.ai_description);
//     add('ai_key_attributes', dto.ai_key_attributes);
//     add('ai_confidence', dto.ai_confidence);

//     // System
//     add('constraints', dto.constraints);

//     const sql = `
//       INSERT INTO wardrobe_items (${cols.join(', ')})
//       VALUES (${params.join(', ')})
//       RETURNING *;
//     `;
//     const result = await pool.query(sql, vals);
//     const item = result.rows[0];

//     // Embeddings
//     let imageVec: number[] | undefined;
//     const gcs = dto.gsutil_uri ?? item.gsutil_uri;
//     if (gcs) imageVec = await this.vertex.embedImage(gcs);

//     const textVec = await this.vertex.embedText(
//       [
//         item.name,
//         item.main_category,
//         item.subcategory,
//         item.color,
//         item.color_family,
//         item.material,
//         item.fit,
//         item.size,
//         item.brand,
//         item.color_temp,
//         item.contrast_profile,
//         String(item.formality_score ?? ''),
//         item.seasonality,
//         item.layering,
//         item.pattern,
//         item.pattern_scale,
//         item.neckline,
//         item.collar_type,
//         item.sleeve_length,
//         item.rise,
//         item.leg,
//         String(item.inseam_in ?? ''),
//         item.length_class,
//         item.shoe_style,
//         item.sole,
//         Array.isArray(item.occasion_tags) ? item.occasion_tags.join(' ') : '',
//         Array.isArray(item.tags) ? item.tags.join(' ') : '',
//         item.dress_code,
//         item.anchor_role,
//         item.dominant_hex,
//         Array.isArray(item.palette_hex) ? item.palette_hex.join(' ') : '',
//       ]
//         .filter(Boolean)
//         .join(' '),
//     );

//     const meta = this.sanitizeMeta({ ...item });
//     await upsertItemNs({
//       userId: dto.user_id,
//       itemId: item.id,
//       imageVec,
//       textVec,
//       meta,
//     });

//     return {
//       message: 'Wardrobe item created + indexed successfully',
//       item: this.toCamel(item),
//     };
//   }

//   // READ
//   async getItemsByUser(userId: string) {
//     const result = await pool.query(
//       'SELECT * FROM wardrobe_items WHERE user_id = $1 ORDER BY created_at DESC',
//       [userId],
//     );
//     return result.rows.map((r) => this.toCamel(r));
//   }

//   // 👉 NEW: return distinct, nicely-cased brand names for a user
//   async getWardrobeBrands(userId: string): Promise<{ brands: string[] }> {
//     const { rows } = await pool.query(
//       `
//       SELECT DISTINCT ON (LOWER(TRIM(brand)))
//              TRIM(brand) AS brand
//       FROM wardrobe_items
//       WHERE user_id = $1
//         AND brand IS NOT NULL
//         AND TRIM(brand) <> ''
//       ORDER BY LOWER(TRIM(brand)) ASC, brand ASC
//       `,
//       [userId],
//     );

//     const brands = rows
//       .map((r: any) => String(r.brand))
//       .filter(Boolean)
//       .sort((a: string, b: string) => a.localeCompare(b));

//     return { brands };
//   }

//   // UPDATE
//   async updateItem(itemId: string, dto: UpdateWardrobeItemDto) {
//     const fields: string[] = [];
//     const values: any[] = [];
//     let index = 1;

//     if (dto.pattern !== undefined) {
//       const p = this.normalizePattern(dto.pattern);
//       (dto as any).pattern =
//         p && WardrobeService.PATTERN_ENUM_WHITELIST.includes(p) ? p : null;
//     }
//     if (dto.seasonality !== undefined) {
//       const s = this.normalizeSeasonality(dto.seasonality);
//       (dto as any).seasonality =
//         s && WardrobeService.SEASONALITY_ENUM_WHITELIST.includes(s) ? s : null;
//     }
//     if (dto.layering !== undefined) {
//       const l = this.normalizeLayering(dto.layering);
//       (dto as any).layering =
//         l && WardrobeService.LAYERING_ENUM_WHITELIST.includes(l) ? l : null;
//     }
//     if (dto.anchor_role !== undefined)
//       (dto as any).anchor_role =
//         this.normalizeAnchorRole(dto.anchor_role) ?? null;
//     if (dto.dress_code !== undefined)
//       (dto as any).dress_code = this.normalizeDressCode(dto.dress_code) ?? null;
//     if (dto.color_temp !== undefined)
//       (dto as any).color_temp = this.normalizeColorTemp(dto.color_temp) ?? null;
//     if (dto.contrast_profile !== undefined)
//       (dto as any).contrast_profile =
//         this.normalizeContrast(dto.contrast_profile) ?? null;
//     if (dto.pattern_scale !== undefined)
//       (dto as any).pattern_scale =
//         this.normalizePatternScaleDto(dto.pattern_scale) ?? null;

//     for (const [key, value] of Object.entries(dto)) {
//       if (value !== undefined) {
//         fields.push(`${key} = $${index}`);
//         if (Array.isArray(value)) {
//           values.push(value.length ? value : null);
//         } else if (typeof value === 'object' && value !== null) {
//           values.push(JSON.stringify(value));
//         } else {
//           values.push(value);
//         }
//         index++;
//       }
//     }

//     if (fields.length === 0) throw new Error('No fields provided for update.');

//     values.push(itemId);

//     const query = `
//       UPDATE wardrobe_items
//       SET ${fields.join(', ')}, updated_at = NOW()
//       WHERE id = $${index}
//       RETURNING *;
//     `;
//     const result = await pool.query(query, values);
//     const item = result.rows[0];

//     let textVec: number[] | undefined;
//     let imageVec: number[] | undefined;

//     const textFields = [
//       'name',
//       'main_category',
//       'subcategory',
//       'color',
//       'color_family',
//       'material',
//       'fit',
//       'size',
//       'brand',
//       'pattern',
//       'pattern_scale',
//       'seasonality',
//       'layering',
//       'dress_code',
//       'occasion_tags',
//       'tags',
//       'anchor_role',
//     ];
//     const textChanged = textFields.some((f) => f in dto);
//     if (textChanged) {
//       const textInput = [
//         item.name,
//         item.main_category,
//         item.subcategory,
//         item.color,
//         item.color_family,
//         item.material,
//         item.fit,
//         item.size,
//         item.brand,
//         item.color_temp,
//         item.contrast_profile,
//         String(item.formality_score ?? ''),
//         item.seasonality,
//         item.layering,
//         item.pattern,
//         item.pattern_scale,
//         item.neckline,
//         item.collar_type,
//         item.sleeve_length,
//         item.rise,
//         item.leg,
//         String(item.inseam_in ?? ''),
//         item.length_class,
//         item.shoe_style,
//         item.sole,
//         Array.isArray(item.occasion_tags) ? item.occasion_tags.join(' ') : '',
//         Array.isArray(item.tags) ? item.tags.join(' ') : '',
//         item.dress_code,
//         item.anchor_role,
//         item.dominant_hex,
//         Array.isArray(item.palette_hex) ? item.palette_hex.join(' ') : '',
//       ]
//         .filter(Boolean)
//         .join(' ');
//       textVec = await this.vertex.embedText(textInput);
//     }

//     const imageChanged = 'gsutil_uri' in dto || 'image_url' in dto;
//     const gcs = (dto as any).gsutil_uri ?? item.gsutil_uri;
//     if (imageChanged && gcs) {
//       imageVec = await this.vertex.embedImage(gcs);
//     }

//     const meta = this.sanitizeMeta({ ...item });

//     if (textVec || imageVec) {
//       await upsertItemNs({
//         userId: item.user_id,
//         itemId: item.id,
//         textVec,
//         imageVec,
//         meta,
//       });
//     } else {
//       await upsertItemNs({ userId: item.user_id, itemId: item.id, meta });
//     }

//     return {
//       message: 'Wardrobe item updated successfully',
//       item: this.toCamel(item),
//     };
//   }

//   // 👉 ADD THIS RIGHT BELOW updateItem
//   async updateFavorite(itemId: string, favorite: boolean) {
//     const result = await pool.query(
//       `UPDATE wardrobe_items
//      SET favorite = $1,
//          updated_at = now()
//      WHERE id = $2
//      RETURNING *`,
//       [favorite, itemId],
//     );
//     return result.rows[0];
//   }

//   // DELETE
//   async deleteItem(dto: DeleteItemDto) {
//     const { item_id, user_id, image_url } = dto;
//     try {
//       await pool.query(
//         'DELETE FROM wardrobe_items WHERE id = $1 AND user_id = $2',
//         [item_id, user_id],
//       );
//     } catch (err: any) {
//       console.warn(`⚠️ Skipped DB delete: ${err.message}`);
//     }
//     try {
//       await deleteItemNs(user_id, item_id);
//     } catch (err: any) {
//       console.warn(`⚠️ Pinecone delete skipped: ${err.message}`);
//     }
//     if (image_url) {
//       const bucketName = process.env.GCS_BUCKET_NAME!;
//       const fileName = this.extractFileName(image_url);
//       try {
//         await storage.bucket(bucketName).file(fileName).delete();
//       } catch (err: any) {
//         if ((err as any).code === 404) {
//           console.warn('🧼 GCS file already deleted:', fileName);
//         } else {
//           console.error('❌ Error deleting GCS file:', (err as any).message);
//         }
//       }
//     }
//     return { message: 'Wardrobe item cleanup attempted (DB, Pinecone, GCS)' };
//   }

//   // VECTOR SEARCH UTILITIES
//   async suggestOutfits(userId: string, queryVec: number[]) {
//     const matches = await queryUserNs({
//       userId,
//       vector: queryVec,
//       topK: 20,
//       includeMetadata: true,
//     });
//     return matches.map((m) => {
//       const { id, modality } = this.normalizePineconeId(m.id as string);
//       return { id, modality, score: m.score, meta: m.metadata };
//     });
//   }
//   async searchText(userId: string, q: string, topK = 20) {
//     const vec = await this.vertex.embedText(q);
//     const matches = await queryUserNs({
//       userId,
//       vector: vec,
//       topK,
//       includeMetadata: true,
//     });
//     return matches.map((m) => {
//       const { id, modality } = this.normalizePineconeId(m.id as string);
//       return { id, modality, score: m.score, meta: m.metadata };
//     });
//   }
//   async searchImage(userId: string, gcsUri: string, topK = 20) {
//     const vec = await this.vertex.embedImage(gcsUri);
//     const matches = await queryUserNs({
//       userId,
//       vector: vec,
//       topK,
//       includeMetadata: true,
//     });
//     return matches.map((m) => {
//       const { id, modality } = this.normalizePineconeId(m.id as string);
//       return { id, modality, score: m.score, meta: m.metadata };
//     });
//   }
//   async searchHybrid(userId: string, q?: string, gcsUri?: string, topK = 20) {
//     const [textVec, imageVec] = await Promise.all([
//       q ? this.vertex.embedText(q) : Promise.resolve(undefined),
//       gcsUri ? this.vertex.embedImage(gcsUri) : Promise.resolve(undefined),
//     ]);
//     const matches = await hybridQueryUserNs({
//       userId,
//       textVec,
//       imageVec,
//       topK,
//     });
//     return matches.map((m) => {
//       const { id, modality } = this.normalizePineconeId(m.id as string);
//       return { id, modality, score: m.score, meta: m.metadata };
//     });
//   }

//   // Label helper
//   private summarizeItem(meta: any): string {
//     if (!meta) return 'Item';
//     const name = (meta.name || '').toString().trim();

//     const color = meta.color || meta.color_family;
//     const cat = meta.main_category || meta.mainCategory;
//     const sub = meta.subcategory || meta.subCategory;
//     const mat = meta.material;
//     const brand = meta.brand;
//     const fit = meta.fit;
//     const size = meta.size_label || meta.size;
//     const dress = meta.dress_code || meta.dressCode;
//     const role = meta.anchor_role || meta.anchorRole;
//     const patternish = meta.pattern_scale || meta.patternScale || meta.pattern;

//     // ── NEW: slot detection to make roles explicit ─────────────
//     const toLc = (s: any) => (s ?? '').toString().trim().toLowerCase();
//     const mainLc = toLc(cat);
//     const subLc = toLc(sub);

//     const isBottom =
//       mainLc === 'bottoms' ||
//       /\b(trouser|pants|jeans|chinos|shorts|joggers?|sweatpants?|track\s*pants?)\b/i.test(
//         subLc,
//       );

//     const isShoes =
//       mainLc === 'shoes' ||
//       /\b(sneakers?|trainers?|running|athletic|loafers?|boots?|oxfords?|derbys?|dress\s*shoes?|sandals?)\b/i.test(
//         subLc,
//       );

//     const isOuter =
//       mainLc === 'outerwear' ||
//       /\b(blazer|sport\s*coat|suit\s*jacket|jacket|coat|windbreaker|parka|trench|overcoat|topcoat)\b/i.test(
//         subLc,
//       );

//     const isTop =
//       mainLc === 'tops' ||
//       /\b(t-?shirt|tee|polo|shirt|sweater|knit|henley|hoodie)\b/i.test(subLc);

//     const isAcc =
//       mainLc === 'accessories' ||
//       /\b(belt|watch|hat|scarf|tie|sunglasses|bag|briefcase)\b/i.test(subLc);

//     const slot =
//       (isBottom && 'BOTTOM') ||
//       (isShoes && 'SHOES') ||
//       (isOuter && 'OUTER') ||
//       (isTop && 'TOP') ||
//       (isAcc && 'ACC') ||
//       undefined;

//     // ───────────────────────────────────────────────────────────

//     const primary = [color, mat, sub || cat].filter(Boolean).join(' ');

//     const season =
//       meta.seasonality ||
//       (Array.isArray(meta.seasonality_arr) && meta.seasonality_arr.join('/'));
//     const temp = meta.color_temp;
//     const contrast = meta.contrast_profile;
//     const form = meta.formality_score != null ? `F${meta.formality_score}` : '';

//     const extras = [
//       brand && `${brand}`,
//       fit && `${fit} fit`,
//       size && `(${size})`,
//       dress && `${dress}`,
//       role && `${role} role`,
//       patternish && `pattern:${patternish}`,
//       season && `${season}`,
//       temp && `temp:${temp}`,
//       contrast && `contrast:${contrast}`,
//       form,
//     ]
//       .filter(Boolean)
//       .join(', ');

//     const headRaw = primary || name || 'Item';
//     const head = slot ? `[${slot}] ${headRaw}` : headRaw;
//     return extras ? `${head} — ${extras}` : head;
//   }
// }
