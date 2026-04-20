/**
 * Discover Brain Adapter — Shared Tier 4 brain gating for Recommended Buys.
 *
 * Maps a single Discover product candidate into the minimal data structures
 * the shared brain modules expect, invokes them, and returns pass/fail.
 *
 * Module invocation order:
 *   1. styleVeto.isStylisticallyIncoherent  (structural coherence)
 *   2. tasteValidator.validateOutfit         (taste + preference hard/soft checks)
 *   3. stylistQualityGate.selectTopOutfitsWithQualityFloor  (quality floor via styleJudge)
 *
 * STRUCTURAL NOTE — MISSING_REQUIRED_SLOTS exception:
 *   Shared modules are outfit-level (multi-item). A single product is wrapped
 *   as a 1-item outfit. The MISSING_REQUIRED_SLOTS hard fail from tasteValidator
 *   (tasteValidator.ts:177-208) always fires for single items because no single
 *   product can form a complete outfit (e.g. a top alone has no bottoms/shoes).
 *   This adapter filters that specific hard fail as a known structural exception.
 *   All OTHER hard fails (AVOID_COLOR, COVERAGE_NO_GO, etc.) are enforced.
 *
 * Fail-safe: if the adapter throws, the candidate is dropped (pass=false)
 * but the overall request continues.
 *
 * Pure deterministic. No randomness. No Date.now() in scoring paths.
 */

import { isStylisticallyIncoherent, type VetoOutfit } from '../ai/styleVeto';

import {
  validateOutfit,
  type ValidatorItem,
  type ValidatorSlot,
  type ValidatorContext,
} from '../ai/elite/tasteValidator';

import { selectTopOutfitsWithQualityFloor } from '../ai/stylistQualityGate';

import type { JudgeItem, JudgeOutfit } from '../ai/styleJudge';

import { inferProductFormality } from './discover-veto';

// ── Public Types ─────────────────────────────────────────────────────────────

export interface BrainGateProduct {
  product_id: string;
  title: string;
  brand: string | null;
  price: number | null;
  category: string | null;
  enriched_color: string | null;
}

export interface BrainGateProfile {
  gender: string | null;
  climate: string | null;
  fit_preferences: string[];
  style_preferences: string[];
  disliked_styles: string[];
  avoid_colors: string[];
  avoid_materials: string[];
  avoid_patterns: string[];
  coverage_no_go: string[];
  walkability_requirement: string | null;
  silhouette_preference: string | null;
  formality_floor: string | null;
}

export interface BrainGateResult {
  pass: boolean;
  reasons: string[];
  tags?: string[];
}

// ── Internal Maps ────────────────────────────────────────────────────────────

/** Discover's inferred main_category → tasteValidator's ValidatorSlot. */
const CATEGORY_TO_VALIDATOR_SLOT: Record<string, ValidatorSlot> = {
  Tops: 'tops',
  Bottoms: 'bottoms',
  Shoes: 'shoes',
  Outerwear: 'outerwear',
  Dresses: 'dresses',
  Accessories: 'accessories',
  Bags: 'accessories',
  Jewelry: 'accessories',
  Activewear: 'activewear',
  Swimwear: 'swimwear',
};

/** Profile climate string → ValidatorContext climateZone. */
const CLIMATE_TO_ZONE: Record<string, ValidatorContext['climateZone']> = {
  freezing: 'freezing',
  cold: 'cold',
  cool: 'cool',
  mild: 'mild',
  warm: 'warm',
  hot: 'hot',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function mapPresentation(
  gender: string | null,
): ValidatorContext['userPresentation'] {
  if (!gender) return undefined;
  const g = gender.toLowerCase();
  if (g.includes('male') || g.includes('man') || g.includes('masculine'))
    return 'masculine';
  if (g.includes('female') || g.includes('woman') || g.includes('feminine'))
    return 'feminine';
  return 'mixed';
}

/**
 * MISSING_REQUIRED_SLOTS is a structural exception for single-item evaluation.
 * See tasteValidator.ts:177-208 — checks outfit slot completeness.
 * A single product can never satisfy multi-slot requirements.
 */
function isStructuralException(hardFail: string): boolean {
  return hardFail.startsWith('MISSING_REQUIRED_SLOTS');
}

// ── Core Gate Function ───────────────────────────────────────────────────────

export function runDiscoverSharedBrainGate(input: {
  userId: string;
  profile: BrainGateProfile;
  candidateProduct: BrainGateProduct;
  context?: { query?: string };
}): BrainGateResult {
  const { profile, candidateProduct: prod, context } = input;
  const reasons: string[] = [];
  const tags: string[] = [];

  try {
    // ── 1. styleVeto ───────────────────────────────────────────────────
    const vetoOutfit: VetoOutfit = {
      items: [
        {
          id: prod.product_id,
          name: prod.title,
          main_category: prod.category ?? undefined,
          subcategory: prod.category ?? undefined,
        },
      ],
    };

    const vetoResult = isStylisticallyIncoherent(vetoOutfit, {
      query: context?.query,
    });

    if (vetoResult.invalid) {
      reasons.push(`styleVeto: ${vetoResult.reason}`);
      tags.push('STYLE_VETO_REJECT');
      return { pass: false, reasons, tags };
    }
    tags.push('styleVeto:pass');

    // ── 2. tasteValidator ──────────────────────────────────────────────
    const slot: ValidatorSlot =
      (prod.category ? CATEGORY_TO_VALIDATOR_SLOT[prod.category] : null) ??
      'tops';

    const validatorItem: ValidatorItem = {
      id: prod.product_id,
      slot,
      name: prod.title,
      color: prod.enriched_color ?? undefined,
      price: prod.price ?? undefined,
      formality_score: inferProductFormality(prod.title) ?? undefined,
    };

    const validatorCtx: ValidatorContext = {
      userPresentation: mapPresentation(profile.gender),
      climateZone: profile.climate
        ? CLIMATE_TO_ZONE[profile.climate.toLowerCase()]
        : undefined,
      styleProfile: {
        fit_preferences: profile.fit_preferences,
        style_preferences: profile.style_preferences,
        disliked_styles: profile.disliked_styles,
        coverage_no_go: profile.coverage_no_go,
        avoid_colors: profile.avoid_colors,
        avoid_materials: profile.avoid_materials,
        formality_floor: profile.formality_floor,
        walkability_requirement: profile.walkability_requirement,
        avoid_patterns: profile.avoid_patterns,
        silhouette_preference: profile.silhouette_preference,
      },
    };

    const validation = validateOutfit([validatorItem], validatorCtx);

    // Filter structural exceptions (MISSING_REQUIRED_SLOTS — see doc header)
    const meaningfulHardFails = validation.hardFails.filter(
      (f) => !isStructuralException(f),
    );

    if (meaningfulHardFails.length > 0) {
      for (const fail of meaningfulHardFails) {
        reasons.push(`tasteValidator: ${fail}`);
      }
      tags.push('TASTE_VALIDATOR_REJECT');
      return { pass: false, reasons, tags };
    }

    // Track soft penalties as informational tags (non-blocking)
    for (const p of validation.softPenalties) {
      tags.push(`tasteValidator:soft:${p}`);
    }
    tags.push('tasteValidator:pass');

    // ── 3. stylistQualityGate (invokes styleJudge internally) ──────────
    const judgeItem: JudgeItem = {
      id: prod.product_id,
      name: prod.title,
      main_category: prod.category ?? undefined,
      color: prod.enriched_color ?? undefined,
      formality_score: inferProductFormality(prod.title) ?? undefined,
    };

    const judgeOutfit: JudgeOutfit = {
      id: prod.product_id,
      items: [judgeItem],
    };

    const qualityResult = selectTopOutfitsWithQualityFloor([judgeOutfit]);

    if (qualityResult.length === 0) {
      reasons.push('stylistQualityGate: below MIN_SHIP quality floor');
      tags.push('QUALITY_GATE_REJECT');
      return { pass: false, reasons, tags };
    }
    tags.push('stylistQualityGate:pass');

    // All gates passed
    return { pass: true, reasons: [], tags };
  } catch (err) {
    // Fail-safe: adapter error → drop candidate, don't fail request
    reasons.push(
      `adapter_error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { pass: false, reasons, tags: ['ADAPTER_ERROR'] };
  }
}
