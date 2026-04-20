/**
 * Style Veto — Structural coherence gate.
 *
 * Rejects outfits where garments communicate mutually exclusive
 * formality/activity signals. This is NOT taste or preference —
 * it is universal clothing logic that applies regardless of gender,
 * age, culture, or personal style.
 *
 * Pure deterministic. No LLM. No DB. No async. Fail-open on missing data.
 */

export type VetoItem = {
  id?: string;
  name?: string;
  label?: string;
  subcategory?: string;
  main_category?: string;
  slot?: string;
  [key: string]: unknown;
};

export type VetoOutfit = {
  items: VetoItem[];
  [key: string]: unknown;
};

export type VetoContext = {
  query?: string;
};

export type VetoResult = {
  invalid: boolean;
  reason?: string;
};

// ── Slot normalization ────────────────────────────────────────────────────

function getSlot(item: VetoItem): string {
  if (item.slot) return item.slot.toLowerCase();
  if (item.main_category) return item.main_category.toLowerCase();
  return 'unknown';
}

// ── Text helpers ──────────────────────────────────────────────────────────

function itemText(item: VetoItem): string {
  return `${item.subcategory ?? ''} ${item.name ?? item.label ?? ''}`.toLowerCase();
}

// ── Detectors ─────────────────────────────────────────────────────────────

const TAILORED_UPPER_RE =
  /\b(blazer|sport\s?coat|suit\s?jacket|dress\s?shirt|button[- ]?down|tuxedo\s?jacket)\b/i;

function isTailoredUpper(item: VetoItem): boolean {
  const slot = getSlot(item);
  if (slot !== 'tops' && slot !== 'outerwear' && slot !== 'top') return false;
  return TAILORED_UPPER_RE.test(itemText(item));
}

const TAILORED_JACKET_RE =
  /\b(blazer|sport\s?coat|suit\s?jacket|tuxedo\s?jacket|structured\s?jacket)\b/i;

function isTailoredJacket(item: VetoItem): boolean {
  const slot = getSlot(item);
  if (slot !== 'tops' && slot !== 'outerwear' && slot !== 'top') return false;
  return TAILORED_JACKET_RE.test(itemText(item));
}

const ATHLETIC_LOWER_RE =
  /\b(gym\s?shorts?|athletic\s?shorts?|joggers?|sweatpants?|track\s?pants?|running\s?shorts?)\b/i;

function isAthleticLower(item: VetoItem): boolean {
  const slot = getSlot(item);
  if (slot !== 'bottoms' && slot !== 'bottom' && slot !== 'activewear')
    return false;
  return ATHLETIC_LOWER_RE.test(itemText(item));
}

const FORMAL_FOOTWEAR_RE =
  /\b(oxfords?|derbies|derby|dress\s?shoes?|loafers?|brogues?|monk\s?straps?|cap[- ]?toe)\b/i;

function isFormalFootwear(item: VetoItem): boolean {
  const slot = getSlot(item);
  if (slot !== 'shoes') return false;
  return FORMAL_FOOTWEAR_RE.test(itemText(item));
}

const CASUAL_OPEN_FOOTWEAR_RE =
  /\b(sandals?|flip[- ]?flops?|slides?|thongs?)\b/i;

function isCasualOpenFootwear(item: VetoItem): boolean {
  const slot = getSlot(item);
  if (slot !== 'shoes') return false;
  return CASUAL_OPEN_FOOTWEAR_RE.test(itemText(item));
}

const EXPOSED_ATHLETIC_RE =
  /\b(shorts|gym\s?shorts?|athletic\s?shorts?|slides?|flip[- ]?flops?|hoodie|hoody|sweatshirt)\b/i;

function isExposedAthleticwear(item: VetoItem): boolean {
  return EXPOSED_ATHLETIC_RE.test(itemText(item));
}

const FORMAL_CONTEXT_RE =
  /\b(wedding|funeral|church|interview|formal|business|black\s?tie|gala|cocktail)\b/i;

function isFormalContext(ctx: VetoContext): boolean {
  if (!ctx.query) return false;
  return FORMAL_CONTEXT_RE.test(ctx.query);
}

const LONG_SLEEVE_TAILORING_RE =
  /\b(blazer|sport\s?coat|suit\s?jacket|dress\s?shirt|button[- ]?down|tuxedo)\b/i;

function isLongSleeveTailoring(item: VetoItem): boolean {
  const slot = getSlot(item);
  if (slot !== 'tops' && slot !== 'outerwear' && slot !== 'top') return false;
  return LONG_SLEEVE_TAILORING_RE.test(itemText(item));
}

const BARE_LEG_LOWER_RE = /\b(shorts|mini\s?skirt|micro\s?skirt)\b/i;

function isBareLegLower(item: VetoItem): boolean {
  const slot = getSlot(item);
  if (slot !== 'bottoms' && slot !== 'bottom') return false;
  return BARE_LEG_LOWER_RE.test(itemText(item));
}

// ── Veto rules ────────────────────────────────────────────────────────────

function checkTailoredUpperAthleticLower(items: VetoItem[]): string | null {
  const hasTailored = items.some(isTailoredUpper);
  const hasAthletic = items.some(isAthleticLower);
  if (hasTailored && hasAthletic) return 'TAILORED_UPPER_ATHLETIC_LOWER';
  return null;
}

function checkFormalFootwearAthleticLower(items: VetoItem[]): string | null {
  const hasFormal = items.some(isFormalFootwear);
  const hasAthletic = items.some(isAthleticLower);
  if (hasFormal && hasAthletic) return 'FORMAL_FOOTWEAR_ATHLETIC_LOWER';
  return null;
}

function checkFormalContextExposedAthletic(
  items: VetoItem[],
  ctx: VetoContext,
): string | null {
  if (!isFormalContext(ctx)) return null;
  const hasExposed = items.some(isExposedAthleticwear);
  if (hasExposed) return 'FORMAL_CONTEXT_EXPOSED_ATHLETIC';
  return null;
}

function checkTailoredJacketCasualFootwear(items: VetoItem[]): string | null {
  const hasJacket = items.some(isTailoredJacket);
  const hasCasual = items.some(isCasualOpenFootwear);
  if (hasJacket && hasCasual) return 'TAILORED_JACKET_CASUAL_OPEN_FOOTWEAR';
  return null;
}

function checkCoveredFormalExposedCasual(items: VetoItem[]): string | null {
  const hasTailoring = items.some(isLongSleeveTailoring);
  const hasBareLeg = items.some(isBareLegLower);
  if (hasTailoring && hasBareLeg) return 'COVERED_FORMAL_UPPER_BARE_LEG_LOWER';
  return null;
}

// ── Public API ────────────────────────────────────────────────────────────

export function isStylisticallyIncoherent(
  outfit: VetoOutfit,
  context: VetoContext = {},
): VetoResult {
  const items = outfit.items ?? [];
  if (items.length === 0) return { invalid: false };

  const checks: (string | null)[] = [
    checkTailoredUpperAthleticLower(items),
    checkFormalFootwearAthleticLower(items),
    checkFormalContextExposedAthletic(items, context),
    checkTailoredJacketCasualFootwear(items),
    checkCoveredFormalExposedCasual(items),
  ];

  for (const reason of checks) {
    if (reason) return { invalid: true, reason };
  }

  return { invalid: false };
}
