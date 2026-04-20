/**
 * chatTier4.ts — Pure helpers for Ask Styla Tier 4 chat validation.
 *
 * Zero DB. Zero async. Zero IO. Zero external imports.
 * Used ONLY by chat() in ai.service.ts.
 */

// ── Phase 1: Deterministic Context Routing ──────────────────────────────

const ROUTE_RULES: Record<string, RegExp> = {
  wardrobe:
    /\b(closet|wardrobe|own|have|wear|outfit|dress me|style me|what to wear|put together|combine|pair)\b/i,
  styleProfile:
    /\b(preference|like|dislike|avoid|hate|love|favorite|body|fit|budget|bold|comfort|skin ?tone|measurement|proportions)\b/i,
  calendar:
    /\b(event|trip|travel|vacation|wedding|interview|date night|party|meeting|dinner|flight|brunch|gala|prom)\b/i,
  weather:
    /\b(weather|rain|snow|cold|hot|warm|cool|humid|forecast|temperature)\b/i,
};

/**
 * Returns contextNeeds keys that MUST be forced true based on message text.
 * Classifier output is additive on top of these — never subtractive.
 */
export function routeContextNeeds(message: string): string[] {
  const forced: string[] = [];
  for (const [key, pattern] of Object.entries(ROUTE_RULES)) {
    if (pattern.test(message)) forced.push(key);
  }
  if (forced.includes('wardrobe') || forced.includes('calendar')) {
    if (!forced.includes('styleProfile')) forced.push('styleProfile');
  }
  return forced;
}

// ── Phase 2A: Avoid-List Validation ─────────────────────────────────────

export interface ChatAvoidLists {
  avoidColors: string[];
  avoidMaterials: string[];
  avoidPatterns: string[];
  coverageNoGo: string[];
}

export interface ChatViolation {
  type:
    | 'AVOID_COLOR'
    | 'AVOID_MATERIAL'
    | 'AVOID_PATTERN'
    | 'COVERAGE_NO_GO'
    | 'WARDROBE_HALLUCINATION';
  term: string;
  snippet: string;
}

// Each family is an isolated, immutable-by-convention array. No cross-family bleed.
const COLOR_FAMILIES: ReadonlyArray<readonly string[]> = [
  [
    'blue',
    'navy',
    'cobalt',
    'royal blue',
    'sky blue',
    'powder blue',
    'steel blue',
  ],
  ['red', 'crimson', 'burgundy', 'maroon'],
  [
    'green',
    'olive',
    'sage',
    'emerald',
    'forest green',
    'hunter green',
    'mint',
    'jade',
    'moss',
  ],
  ['white', 'ivory', 'cream', 'off-white', 'eggshell', 'pearl', 'snow'],
  ['black', 'onyx', 'jet black', 'charcoal black'],
  [
    'beige',
    'nude',
    'sand',
    'oatmeal',
    'khaki',
    'wheat',
    'tan',
    'camel',
    'caramel',
  ],
  [
    'grey',
    'gray',
    'charcoal',
    'slate',
    'silver',
    'ash',
    'heather grey',
    'heather gray',
  ],
  [
    'brown',
    'chocolate',
    'espresso',
    'mocha',
    'taupe',
    'cognac',
    'chestnut',
    'walnut',
    'sienna',
  ],
  [
    'pink',
    'fuchsia',
    'magenta',
    'rose',
    'blush',
    'salmon',
    'hot pink',
    'dusty pink',
    'mauve',
  ],
  [
    'purple',
    'violet',
    'plum',
    'lavender',
    'lilac',
    'amethyst',
    'eggplant',
    'aubergine',
  ],
  [
    'orange',
    'tangerine',
    'peach',
    'apricot',
    'rust',
    'burnt orange',
    'terracotta',
    'copper',
  ],
  [
    'yellow',
    'mustard',
    'gold',
    'lemon',
    'canary',
    'marigold',
    'saffron',
    'amber',
  ],
];

/**
 * Self-contained color family expansion. Fail-closed: unknown colors pass through as-is.
 * Does NOT import from tasteValidator.
 */
export function expandAvoidColorsLite(avoidColors: string[]): string[] {
  // Fresh set per call — no mutation of input, no shared state
  const expanded = new Set<string>();
  for (const raw of avoidColors) {
    const norm = raw.trim().toLowerCase();
    if (!norm) continue;
    expanded.add(norm);
    for (const family of COLOR_FAMILIES) {
      if (family.includes(norm)) {
        for (const member of family) expanded.add(member);
      }
    }
  }
  return [...expanded];
}

const COVERAGE_TEXT_PATTERNS: Record<string, RegExp> = {
  'No midriff exposure': /\bcrop\s*top|bralette|bustier\b/i,
  'No leg exposure above knee': /\bmini\s*skirt|short shorts|micro\b/i,
  'No shoulder exposure': /\bstrapless|tube top|off[\s-]?shoulder\b/i,
  'No cleavage': /\bdeep[\s-]?v|plunging\b/i,
};

/**
 * Scan free-text AI response for avoid-list violations.
 * Returns empty array if clean.
 */
export function scanChatForViolations(
  responseText: string,
  avoidLists: ChatAvoidLists,
): ChatViolation[] {
  const violations: ChatViolation[] = [];
  const sentences = responseText
    .split(/[.!?\n]+/)
    .filter((s) => s.trim().length > 10);

  // console.log('[AskStyla T4 DEBUG] raw avoid colors:', avoidLists.avoidColors);

  // Color violations (with family expansion)
  if (avoidLists.avoidColors.length > 0) {
    const expanded = expandAvoidColorsLite(avoidLists.avoidColors);
    // console.log('[AskStyla T4 DEBUG] expanded avoid colors:', expanded);
    for (const ac of expanded) {
      const colorRegex = new RegExp(`\\b${escapeRegex(ac)}\\b`, 'i');
      if (colorRegex.test(responseText)) {
        // console.log('[AskStyla T4 DEBUG] color violation detected:', ac);
        const snippet = sentences.find((s) => colorRegex.test(s))?.trim() || '';
        violations.push({
          type: 'AVOID_COLOR',
          term: ac,
          snippet: snippet.slice(0, 120),
        });
      }
    }
  }

  // Material violations
  for (const am of avoidLists.avoidMaterials) {
    const matRegex = new RegExp(
      `\\b${escapeRegex(am.trim().toLowerCase())}\\b`,
      'i',
    );
    if (matRegex.test(responseText)) {
      const snippet = sentences.find((s) => matRegex.test(s))?.trim() || '';
      violations.push({
        type: 'AVOID_MATERIAL',
        term: am,
        snippet: snippet.slice(0, 120),
      });
    }
  }

  // Pattern violations
  for (const ap of avoidLists.avoidPatterns) {
    const patRegex = new RegExp(
      `\\b${escapeRegex(ap.trim().toLowerCase())}\\b`,
      'i',
    );
    if (patRegex.test(responseText)) {
      const snippet = sentences.find((s) => patRegex.test(s))?.trim() || '';
      violations.push({
        type: 'AVOID_PATTERN',
        term: ap,
        snippet: snippet.slice(0, 120),
      });
    }
  }

  // Coverage violations
  for (const rule of avoidLists.coverageNoGo) {
    const pattern = COVERAGE_TEXT_PATTERNS[rule];
    if (!pattern) continue;
    if (pattern.test(responseText)) {
      const snippet = sentences.find((s) => pattern.test(s))?.trim() || '';
      violations.push({
        type: 'COVERAGE_NO_GO',
        term: rule,
        snippet: snippet.slice(0, 120),
      });
    }
  }

  return violations;
}

// ── Phase 2B: Wardrobe Hallucination Guard ──────────────────────────────

const POSSESSIVE_ITEM_RE =
  /\b(?:wear|use|pair|style)\s+(?:your|my)\s+(.{3,60}?)(?=[.,!?\n]|$)/gi;

/**
 * Scan response for possessive item references ("wear your ___", "pair your ___").
 * Flags as hallucination if referenced phrase is not in the allowed wardrobe set.
 * Conservative: only matches specific verb + possessive patterns, phrases < 60 chars.
 */
export function scanForWardrobeHallucinations(
  responseText: string,
  allowedWardrobeNames: Set<string>,
): ChatViolation[] {
  if (allowedWardrobeNames.size === 0) return [];
  const violations: ChatViolation[] = [];

  // Reset regex state for each call
  const re = new RegExp(POSSESSIVE_ITEM_RE.source, POSSESSIVE_ITEM_RE.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(responseText)) !== null) {
    const phrase = match[1].trim().toLowerCase();
    if (phrase.length < 3 || phrase.length > 60) continue;
    const matched = Array.from(allowedWardrobeNames).some(
      (name) => name.includes(phrase) || phrase.includes(name),
    );
    if (!matched) {
      violations.push({
        type: 'WARDROBE_HALLUCINATION',
        term: phrase,
        snippet: match[0].slice(0, 120),
      });
    }
  }
  return violations;
}

// ── Shared: Correction & Guard Helpers ──────────────────────────────────

/**
 * Build correction instruction for regeneration attempt.
 */
export function buildCorrectionPrompt(violations: ChatViolation[]): string {
  const avoidLines = violations
    .filter((v) => v.type !== 'WARDROBE_HALLUCINATION')
    .map((v) => `- Do NOT mention or recommend "${v.term}" (${v.type})`);
  const hallucinationLines = violations
    .filter((v) => v.type === 'WARDROBE_HALLUCINATION')
    .map(
      (v) =>
        `- "${v.term}" is NOT in the user's wardrobe — do not reference it`,
    );
  const lines = [...avoidLines, ...hallucinationLines];
  return `\n\nCRITICAL CORRECTION:\n${lines.join('\n')}\nRegenerate your response respecting these constraints. Only reference items the user actually owns.`;
}

/**
 * Minimal user-facing correction note (appended when retry also fails).
 */
export function buildCorrectionNote(violations: ChatViolation[]): string {
  const terms = [...new Set(violations.map((v) => v.term))].slice(0, 3);
  return `\n\n_Note: Some suggestions above may not perfectly match your preferences regarding ${terms.join(', ')}. Please disregard those specific recommendations._`;
}

/**
 * Returns true if the response contains styling content worth validating.
 * Requires 2+ fashion token categories to trigger.
 */
export function isStylingResponse(responseText: string): boolean {
  const lower = responseText.toLowerCase();
  const hits = [
    /\b(wear|outfit|style|dress|pair|combine|match)\b/,
    /\b(color|fabric|material|pattern|silk|cotton|linen|wool)\b/,
    /\b(top|bottom|shirt|blouse|pants|skirt|jacket|blazer|shoes|boots)\b/,
    /\b(recommend|suggest|try|consider|opt for|go with)\b/,
  ].filter((r) => r.test(lower)).length;
  return hits >= 2;
}

// ── Phase 3: Outfit Item Extraction for Validator Gating ─────────────

/** Minimal shape of a wardrobe row as loaded in chat(). */
export interface ChatWardrobeRow {
  name?: string;
  ai_title?: string;
  main_category?: string;
  subcategory?: string;
  color?: string;
  material?: string;
  fit?: string;
  formality_score?: number;
  dress_code?: string;
}

/** Extracted item shape — structurally compatible with ValidatorItem. */
export type ChatExtractedItem = {
  id: string;
  slot: string;
  name?: string;
  subcategory?: string;
  color?: string;
  material?: string;
  fit?: string;
  formality_score?: number;
  dress_code?: string;
};

/** Map main_category to validator slot. Deterministic, fail-closed to 'accessories'. */
function mainCatToSlot(mainCategory: string | undefined): string {
  switch ((mainCategory ?? '').toLowerCase().trim()) {
    case 'tops':
      return 'tops';
    case 'bottoms':
      return 'bottoms';
    case 'shoes':
      return 'shoes';
    case 'outerwear':
      return 'outerwear';
    case 'dresses':
      return 'dresses';
    case 'activewear':
      return 'activewear';
    case 'swimwear':
      return 'swimwear';
    default:
      return 'accessories';
  }
}

/**
 * Extract wardrobe items referenced in AI response text.
 * Deterministic: lowercase + whitespace-collapse + substring match.
 * Returns unique matched items in order of first appearance.
 * Items with names < 4 chars are skipped to avoid false positives.
 */
export function extractOutfitItemsFromResponse(
  response: string,
  wardrobeRows: ChatWardrobeRow[],
): ChatExtractedItem[] {
  const normResp = response.toLowerCase().replace(/\s+/g, ' ');
  const seen = new Set<number>();
  const hits: Array<{ idx: number; pos: number }> = [];

  for (let i = 0; i < wardrobeRows.length; i++) {
    const row = wardrobeRows[i];
    for (const rawName of [row.ai_title, row.name]) {
      if (!rawName) continue;
      const n = rawName.toLowerCase().replace(/\s+/g, ' ').trim();
      if (n.length < 4) continue;
      const pos = normResp.indexOf(n);
      if (pos >= 0 && !seen.has(i)) {
        seen.add(i);
        hits.push({ idx: i, pos });
      }
    }
  }

  hits.sort((a, b) => a.pos - b.pos);

  return hits.map((h) => {
    const r = wardrobeRows[h.idx];
    return {
      id: String(h.idx),
      slot: mainCatToSlot(r.main_category),
      name: r.ai_title || r.name,
      subcategory: r.subcategory,
      color: r.color,
      material: r.material,
      fit: r.fit,
      formality_score:
        r.formality_score != null ? Number(r.formality_score) : undefined,
      dress_code: r.dress_code,
    };
  });
}

// ── Utility ─────────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
