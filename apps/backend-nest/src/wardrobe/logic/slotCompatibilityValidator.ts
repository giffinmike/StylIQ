/**
 * Post-retrieval slot compatibility validator for AI Outfit Studio.
 *
 * Validates that Pinecone vector search results are semantically compatible
 * with the LLM's slot description. Catches cases where embedding similarity
 * is high but the garment type is wrong (e.g., "tailored trousers" → shorts).
 *
 * This is a HARD gate — only garment-type correctness is checked here.
 * Color/style preferences are handled elsewhere.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface SlotDescription {
  category: string;
  description: string;
  formality?: number;
}

export interface CandidateItem {
  id: string;
  name?: string;
  main_category?: string;
  subcategory?: string;
  dress_code?: string;
  formality_score?: number;
}

export interface SlotMatchResult {
  valid: boolean;
  reason?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Keyword → Required Subcategory Rules
// ─────────────────────────────────────────────────────────────────────────────
// Each rule: if the slot description matches the pattern,
// only items whose subcategory/name match `allow` pass.
// Items matching `reject` are always rejected regardless.
//
// Rules are checked in order — first match wins.
// More specific patterns MUST come before general ones.

interface SubcategoryRule {
  /** Pattern to match against the slot description (case-insensitive) */
  pattern: RegExp;
  /** If set, candidate subcategory/name MUST match one of these */
  allow?: RegExp;
  /** If set, candidate subcategory/name matching these is rejected */
  reject?: RegExp;
}

/**
 * BOTTOMS slot rules — distinguish trousers from shorts, joggers, etc.
 */
const BOTTOMS_RULES: SubcategoryRule[] = [
  // "tailored trousers", "dress pants", "slacks" → only trousers-like items
  {
    pattern:
      /\b(tailored\s+(pants?|trousers?)|dress\s+pants?|slacks?|formal\s+(pants?|trousers?)|suit\s+(pants?|trousers?))\b/i,
    allow:
      /\b(trousers?|slacks?|dress\s*pants?|chinos?|suit\s*pants?|pants?)\b/i,
    reject:
      /\b(shorts?|joggers?|sweatpants?|track\s*pants?|athletics?|cargo\s*shorts?|board\s*shorts?|swim)\b/i,
  },
  // "trousers" (generic) — still reject shorts/joggers
  {
    pattern: /\b(trousers?)\b/i,
    allow: /\b(trousers?|slacks?|dress\s*pants?|chinos?|pants?|jeans?)\b/i,
    reject:
      /\b(shorts?|joggers?|sweatpants?|track\s*pants?|athletics?|board\s*shorts?|swim)\b/i,
  },
  // "chinos" → allow chinos, trousers, pants; reject shorts
  {
    pattern: /\b(chinos?)\b/i,
    allow: /\b(chinos?|trousers?|pants?|slacks?)\b/i,
    reject: /\b(shorts?|joggers?|sweatpants?|athletics?)\b/i,
  },
  // "jeans", "denim" → allow jeans/denim
  {
    pattern: /\b(jeans?|denim\s+pants?)\b/i,
    allow: /\b(jeans?|denim|trousers?|pants?)\b/i,
    reject: /\b(shorts?|joggers?|sweatpants?|athletics?)\b/i,
  },
];

/**
 * SHOES slot rules — distinguish dress shoes from sneakers, etc.
 */
const SHOES_RULES: SubcategoryRule[] = [
  // "oxfords", "derbies", "brogues" → strict dress shoes
  {
    pattern: /\b(oxfords?|derbies?|derbys?|brogues?|wingtips?)\b/i,
    allow:
      /\b(oxfords?|derbies?|derbys?|brogues?|wingtips?|dress\s*shoes?|formal)\b/i,
    reject:
      /\b(sneakers?|trainers?|athletics?|running|sandals?|flip\s*flops?|slides?|boots?|hiking)\b/i,
  },
  // "loafers" → dress shoe family
  {
    pattern: /\b(loafers?)\b/i,
    allow: /\b(loafers?|moccasins?|dress\s*shoes?|slip[\s-]*ons?|formal)\b/i,
    reject:
      /\b(sneakers?|trainers?|athletics?|running|sandals?|flip\s*flops?|slides?|hiking)\b/i,
  },
  // "dress shoes" → any dressy footwear
  {
    pattern: /\b(dress\s+shoes?|formal\s+shoes?)\b/i,
    allow:
      /\b(oxfords?|derbies?|derbys?|loafers?|dress\s*shoes?|brogues?|monks?|formal|pumps?|heels?|flats?)\b/i,
    reject:
      /\b(sneakers?|trainers?|athletics?|running|sandals?|flip\s*flops?|slides?|hiking|boots?)\b/i,
  },
  // "sneakers", "trainers" → athletic/casual shoes
  {
    pattern: /\b(sneakers?|trainers?|running\s+shoes?|athletic\s+shoes?)\b/i,
    allow:
      /\b(sneakers?|trainers?|athletics?|running|tennis\s*shoes?|sports?|casual)\b/i,
    reject:
      /\b(oxfords?|derbies?|derbys?|loafers?|brogues?|dress\s*shoes?|formal|pumps?|heels?|monks?)\b/i,
  },
  // "boots" → boot family
  {
    pattern: /\b(boots?)\b/i,
    allow: /\b(boots?|booties?|chelsea|combat|ankle|lace[\s-]*ups?)\b/i,
    reject: /\b(sandals?|flip\s*flops?|slides?|sneakers?|loafers?)\b/i,
  },
];

/**
 * OUTERWEAR slot rules — distinguish blazers from casual outerwear.
 */
const OUTERWEAR_RULES: SubcategoryRule[] = [
  // "blazer", "sport coat", "suit jacket" → tailored outerwear
  {
    pattern:
      /\b(blazers?|sport\s*coats?|suit\s*jackets?|tailored\s+jackets?)\b/i,
    allow: /\b(blazers?|sport\s*coats?|suits?|tailored|structured|jackets?)\b/i,
    reject:
      /\b(hoodies?|sweatshirts?|puffers?|windbreakers?|anoraks?|raincoats?|fleece|track\s*jackets?)\b/i,
  },
];

/**
 * TOPS slot rules — distinguish dress shirts from casual tops.
 */
const TOPS_RULES: SubcategoryRule[] = [
  // "dress shirt", "button-up", "button-down" (formal context)
  {
    pattern:
      /\b(dress\s+shirts?|formal\s+shirts?|button[\s-]*up\s+shirts?|button[\s-]*down\s+shirts?)\b/i,
    allow: /\b(dress\s*shirts?|button|oxford|poplin|formal|collar)\b/i,
    reject:
      /\b(t[\s-]*shirts?|tee|hoodies?|sweatshirts?|tanks?|jersey|athletics?)\b/i,
  },
];

/**
 * Master map: slot → rules.
 * Only slots with specific subcategory constraints are listed.
 */
const SLOT_RULES: Record<string, SubcategoryRule[]> = {
  bottoms: BOTTOMS_RULES,
  shoes: SHOES_RULES,
  outerwear: OUTERWEAR_RULES,
  tops: TOPS_RULES,
};

// ─────────────────────────────────────────────────────────────────────────────
// Occasion keywords → rejected subcategories
// ─────────────────────────────────────────────────────────────────────────────

const FORMAL_OCCASION_PATTERN =
  /\b(church|wedding|formal|black[\s-]*tie|white[\s-]*tie|gala|cocktail\s+party|office\s+formal|business\s+formal|ceremony)\b/i;

const CASUAL_SUBCATEGORY_PATTERN =
  /\b(shorts?|hoodies?|sweatshirts?|slides?|flip[\s-]*flops?|athletic\s+sneakers?|joggers?|sweatpants?|tank\s+tops?|crop\s+tops?)\b/i;

// ─────────────────────────────────────────────────────────────────────────────
// Main Validator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates whether a candidate item is compatible with a slot description.
 *
 * Checks (in order):
 * 1. Subcategory rules — keyword-driven garment-type matching
 * 2. Formality gate — if slot formality >= 7, reject athletic/lounge items
 * 3. Occasion gate — if query mentions formal occasions, reject casualwear
 *
 * Returns { valid: true } if the item passes all checks, or
 * { valid: false, reason } with a rejection tag.
 */
export function validateSlotMatch(
  slotDesc: SlotDescription,
  candidate: CandidateItem,
  query: string,
): SlotMatchResult {
  const desc = (slotDesc.description ?? '').toLowerCase();
  const slot = (slotDesc.category ?? '').toLowerCase();

  // Build candidate text from subcategory + name for matching
  const candidateSub = (candidate.subcategory ?? '').toLowerCase();
  const candidateName = (candidate.name ?? '').toLowerCase();
  const candidateText = `${candidateSub} ${candidateName}`;

  // ── 1. Subcategory Rules ──
  const rules = SLOT_RULES[slot];
  if (rules) {
    for (const rule of rules) {
      if (!rule.pattern.test(desc)) continue;

      // Matched a rule — check reject first (hard no)
      if (rule.reject && rule.reject.test(candidateText)) {
        return {
          valid: false,
          reason: `CATEGORY_MISMATCH: "${candidateText.trim()}" rejected for "${desc}" (reject pattern matched)`,
        };
      }

      // Check allow — candidate must match if allow is specified
      if (rule.allow && !rule.allow.test(candidateText)) {
        return {
          valid: false,
          reason: `CATEGORY_MISMATCH: "${candidateText.trim()}" not in allowed set for "${desc}"`,
        };
      }

      // Passed the matched rule — stop checking further rules
      break;
    }
  }

  // ── 2. Formality Gate ──
  // If slot has high formality (>= 7 on 1-10 scale), reject athletic/lounge items
  if (slotDesc.formality != null && slotDesc.formality >= 7) {
    const candidateDressCode = (candidate.dress_code ?? '').toLowerCase();
    if (
      /\b(athletic|athleisure|loungewear|sleepwear|gym|workout)\b/i.test(
        candidateDressCode,
      ) ||
      /\b(athletic|athleisure|loungewear|sleepwear|gym|workout)\b/i.test(
        candidateSub,
      )
    ) {
      return {
        valid: false,
        reason: `FORMALITY_MISMATCH: "${candidateText.trim()}" is athletic/lounge, slot formality=${slotDesc.formality}`,
      };
    }
  }

  // ── 3. Occasion Gate ──
  // If query mentions formal occasions, reject casual items
  if (FORMAL_OCCASION_PATTERN.test(query)) {
    if (CASUAL_SUBCATEGORY_PATTERN.test(candidateText)) {
      return {
        valid: false,
        reason: `OCCASION_MISMATCH: "${candidateText.trim()}" is casualwear, query requests formal occasion`,
      };
    }
  }

  return { valid: true };
}
