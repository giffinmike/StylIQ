/**
 * chatTier4Reasoning.ts — Pre-LLM shortlisting + luxury reasoning helpers for Ask Styla.
 *
 * SCOPE: Ask Styla ONLY. No shared modules modified. No other surfaces affected.
 * Imports ONLY pure functions from chatTier4.ts (expandAvoidColorsLite, ChatAvoidLists type).
 */

import { expandAvoidColorsLite, ChatAvoidLists } from './chatTier4';

// ── 1a. Category Detection ──────────────────────────────────────────────

const CATEGORY_MAP: Record<string, RegExp> = {
  Outerwear:
    /\b(blazer|jacket|coat|parka|trench|puffer|bomber|cardigan|overcoat|peacoat|anorak|windbreaker|cape|poncho|shrug|vest)\b/i,
  Tops: /\b(top|blouse|shirt|tee|t-shirt|tank|camisole|tunic|polo|henley|sweater|pullover|sweatshirt|hoodie|crop top|bodysuit)\b/i,
  Bottoms:
    /\b(pants|trousers|jeans|shorts|skirt|leggings|joggers|chinos|culottes|palazzo|cargo|slacks|bermuda)\b/i,
  Dresses:
    /\b(dress|gown|maxi|midi|mini dress|sundress|sheath|wrap dress|shift dress|cocktail dress|evening dress)\b/i,
  Footwear:
    /\b(shoes|boots|sneakers|heels|loafers|sandals|pumps|flats|oxfords|mules|espadrilles|slides|stilettos|wedges|ankle boots)\b/i,
  Bags: /\b(bag|purse|tote|clutch|backpack|crossbody|satchel|handbag|messenger|duffel|weekender)\b/i,
  Accessories:
    /\b(watch|belt|scarf|hat|sunglasses|bracelet|necklace|earring|ring|tie|pocket square|cufflinks|brooch|gloves)\b/i,
  Activewear:
    /\b(activewear|athletic|workout|gym|sports bra|yoga|running|track)\b/i,
  Swimwear:
    /\b(swimsuit|bikini|one-piece|swim trunks|boardshorts|cover-up|rash guard)\b/i,
  Suits: /\b(suit|tuxedo|dinner jacket)\b/i,
  Loungewear: /\b(loungewear|pajamas|robe|sleepwear|nightgown)\b/i,
};

export function detectRelevantCategory(message: string): string | null {
  for (const [category, pattern] of Object.entries(CATEGORY_MAP)) {
    if (pattern.test(message)) return category;
  }
  return null;
}

// ── 1b. Formality Anchor ────────────────────────────────────────────────

const AUTHORITY_TRIGGERS =
  /\b(powerful|luxurious|authoritative|expensive|commanding|prestigious|elegant|executive|sophisticated)\b/i;

export function detectFormalityAnchor(
  message: string,
): 'elevated_business' | null {
  return AUTHORITY_TRIGGERS.test(message) ? 'elevated_business' : null;
}

// ── 1c. Pre-LLM Shortlist Builder ───────────────────────────────────────

export interface ShortlistItem {
  name: string;
  main_category?: string;
  subcategory?: string;
  color?: string;
  material?: string;
  brand?: string;
  fit?: string;
  pattern?: string;
  occasion_tags?: string | string[];
  dress_code?: string;
  formality_score?: number;
  seasonality?: string;
  layering?: string;
  color_family?: string;
  ai_title?: string;
  ai_description?: string;
}

const DARK_NEUTRAL_COLORS = new Set([
  'black',
  'charcoal',
  'navy',
  'dark grey',
  'dark gray',
  'slate',
  'onyx',
  'jet black',
  'charcoal black',
  'steel blue',
  'midnight',
  'espresso',
  'chocolate',
  'deep navy',
  'dark brown',
]);

const STRUCTURED_KEYWORDS =
  /\b(tailored|structured|fitted|darted|lined|bespoke|sharp|crisp|pressed|suiting|wool|cashmere|silk|tweed)\b/i;

export function buildShortlist(
  items: ShortlistItem[],
  avoidLists: ChatAvoidLists,
  category: string | null,
  formalityAnchor: 'elevated_business' | null,
): ShortlistItem[] {
  const expandedAvoidColors =
    avoidLists.avoidColors.length > 0
      ? new Set(
          expandAvoidColorsLite(avoidLists.avoidColors).map((c) =>
            c.toLowerCase(),
          ),
        )
      : new Set<string>();

  const avoidMaterials = new Set(
    avoidLists.avoidMaterials.map((m) => m.trim().toLowerCase()),
  );
  const avoidPatterns = new Set(
    avoidLists.avoidPatterns.map((p) => p.trim().toLowerCase()),
  );

  const candidates = items.filter((item) => {
    // Filter by category if detected
    if (category && item.main_category && item.main_category !== category)
      return false;

    // Exclude avoid colors
    const itemColor = (item.color || '').toLowerCase();
    const itemColorFamily = (item.color_family || '').toLowerCase();
    if (itemColor && expandedAvoidColors.has(itemColor)) return false;
    if (itemColorFamily && expandedAvoidColors.has(itemColorFamily))
      return false;

    // Exclude avoid patterns
    const itemPattern = (item.pattern || '').toLowerCase();
    if (itemPattern && avoidPatterns.has(itemPattern)) return false;

    // Exclude avoid materials
    const itemMaterial = (item.material || '').toLowerCase();
    if (itemMaterial && avoidMaterials.has(itemMaterial)) return false;

    // Formality threshold
    if (
      formalityAnchor === 'elevated_business' &&
      item.formality_score != null &&
      item.formality_score < 6
    ) {
      return false;
    }

    return true;
  });

  // Deterministic sort: dark neutrals first → higher formality → structured tailoring
  candidates.sort((a, b) => {
    const aIsDark = DARK_NEUTRAL_COLORS.has((a.color || '').toLowerCase())
      ? 1
      : 0;
    const bIsDark = DARK_NEUTRAL_COLORS.has((b.color || '').toLowerCase())
      ? 1
      : 0;
    if (bIsDark !== aIsDark) return bIsDark - aIsDark;

    const aFormality = a.formality_score ?? 0;
    const bFormality = b.formality_score ?? 0;
    if (bFormality !== aFormality) return bFormality - aFormality;

    const aStructured = STRUCTURED_KEYWORDS.test(
      `${a.material || ''} ${a.fit || ''} ${a.ai_description || ''}`,
    )
      ? 1
      : 0;
    const bStructured = STRUCTURED_KEYWORDS.test(
      `${b.material || ''} ${b.fit || ''} ${b.ai_description || ''}`,
    )
      ? 1
      : 0;
    return bStructured - aStructured;
  });

  return candidates.slice(0, 5);
}

// ── 1d. Shortlist Formatting + Luxury Stylist Prompt ────────────────────

export function formatShortlistForPrompt(shortlist: ShortlistItem[]): string {
  const lines = shortlist.map((item, i) => {
    const parts = [
      item.color,
      item.ai_title || item.name,
      item.brand,
      item.material,
      item.fit,
    ]
      .filter(Boolean)
      .join(' \u2022 ');

    const extras = [
      item.pattern && `pattern:${item.pattern}`,
      item.formality_score != null && `formality:${item.formality_score}`,
      item.dress_code && `dress-code:${item.dress_code}`,
      item.seasonality && `season:${item.seasonality}`,
      item.color_family && `color-family:${item.color_family}`,
    ]
      .filter(Boolean)
      .join(' | ');

    const desc = item.ai_description
      ? `\n      ${String(item.ai_description).slice(0, 200)}`
      : '';
    return `  ${i + 1}. ${parts}${extras ? `\n      [${extras}]` : ''}${desc}`;
  });

  return lines.join('\n');
}

export function buildLuxuryStylistPrompt(
  shortlistContext: string,
  styleProfileContext: string,
  fullContext: string,
): string {
  return `You are a clinical luxury style intelligence.

STYLE PROFILE DATA:
${styleProfileContext || '(no style profile available)'}

SHORTLISTED WARDROBE CANDIDATES (evaluate ONLY these):
${shortlistContext}

ADDITIONAL CONTEXT:
${fullContext}

YOU MUST:
1. Respect ALL avoid constraints absolutely — never reference avoided colors, materials, or patterns.
2. Evaluate ONLY the shortlisted wardrobe items above.
3. Choose EXACTLY ONE primary item from the shortlist.
4. Justify your recommendation using ALL of the following:
   - Body type: explain the structural mechanism (shoulder width creation, vertical line control, waist definition, silhouette hierarchy)
   - Undertone: explain contrast or tonal depth (saturation control, warmth balance, authority signaling)
   - Formality: how the construction and fabric project the desired presence
   - Goal alignment: how the piece serves the stated objective
5. Briefly imply why competing shortlist options were not selected — without listing all items.

RULES:
- BANNED WORDS: sleek, sophisticated, elegant, excellent choice, impactful, harmonious, stunning, gorgeous, fabulous, chic, lovely, beautiful, perfect, amazing, wonderful. Never use these.
- Use decisive language. Use structural and color-theory terms only.
- No lifestyle-blog tone. No filler adjectives. No retail marketing language.
- No invented items — use EXACT wardrobe item names only.
- Under 140 words.
- Output must be a clean paragraph. Do not reveal reasoning steps as bullet points.

At the end, return a short JSON block like:
{"search_terms":["smart casual men","navy blazer outfit","loafers"]}`;
}

// ── 1e. Reasoning Quality Validator ─────────────────────────────────────

const REQUIRED_MECHANISM_TOKENS = [
  'shoulder',
  'vertical',
  'waist',
  'proportion',
  'hierarchy',
  'taper',
  'structure',
  'frame',
  'saturation',
  'contrast',
  'warmth',
  'authority',
];

const CONTRAST_CLAUSE_INDICATORS = [
  'lacks',
  'does not provide',
  'less structured',
  'weaker option',
  'compared to',
];

const BANNED_WORDS = [
  'sleek',
  'sophisticated',
  'elegant',
  'excellent choice',
  'impactful',
  'harmonious',
  'stunning',
  'gorgeous',
  'fabulous',
  'chic',
  'lovely',
  'beautiful',
  'perfect',
  'amazing',
  'wonderful',
];

export function validateReasoningQuality(
  response: string,
  shortlistNames: string[],
): boolean {
  const lower = response.toLowerCase();

  // A) Must reference at least 1 shortlist item by name
  const hasItemRef = shortlistNames.some(
    (name) => name.length >= 3 && lower.includes(name.toLowerCase()),
  );
  if (!hasItemRef) return false;

  // B) Must use at least 3 mechanism tokens
  const tokenHits = REQUIRED_MECHANISM_TOKENS.filter((t) =>
    lower.includes(t),
  ).length;
  if (tokenHits < 3) return false;

  // C) Must include at least 1 contrast clause indicator
  const hasContrast = CONTRAST_CLAUSE_INDICATORS.some((c) => lower.includes(c));
  if (!hasContrast) return false;

  // D) Must NOT contain any banned words
  const hasBanned = BANNED_WORDS.some((b) => lower.includes(b));
  if (hasBanned) return false;

  return true;
}

export const REASONING_CORRECTION =
  'You failed to apply structural mechanism reasoning. Use explicit silhouette mechanics (shoulder width creation, vertical line control, waist definition, proportion control, tonal saturation logic) and briefly contrast against other shortlist options. No lifestyle tone. No banned adjectives.';
