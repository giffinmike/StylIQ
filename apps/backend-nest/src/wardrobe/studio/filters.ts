// apps/backend-nest/src/wardrobe/studio/filters.ts
//
// Pre-assembly hard filters for AI Outfit Studio.
// Applied ONCE to the retrieved catalog before any outfit is built.
// Deterministic, read-only, no mutation of input items.

import { isFeminineItem } from '../logic/presentationFilter';
import { mapMainCategoryToSlot, type Slot } from '../logic/categoryMapping';
import type { StudioItem, StudioBuildContext } from './types';

const lc = (s?: string) => (s ?? '').toLowerCase();

function itemText(item: StudioItem): string {
  return [item.label, item.name, item.subcategory, item.main_category]
    .filter(Boolean)
    .map((v) => lc(v))
    .join(' ');
}

function matchesAny(haystack: string, needles: string[] | undefined): boolean {
  if (!needles?.length) return false;
  for (const n of needles) {
    const needle = lc(n).trim();
    if (!needle) continue;
    if (haystack.includes(needle)) return true;
  }
  return false;
}

function colorTokens(item: StudioItem): string[] {
  const tokens = new Set<string>();
  const push = (v?: string) => {
    const t = lc(v).trim();
    if (t) tokens.add(t);
  };
  push(item.color);
  push(item.color_family);
  // Colors sometimes appear in the label (e.g. "Navy blazer").
  const label = lc(item.label);
  const KNOWN_COLORS = [
    'black',
    'white',
    'gray',
    'grey',
    'navy',
    'blue',
    'brown',
    'tan',
    'cognac',
    'beige',
    'cream',
    'ivory',
    'green',
    'olive',
    'red',
    'pink',
    'purple',
    'yellow',
    'orange',
    'burgundy',
    'maroon',
    'charcoal',
    'khaki',
  ];
  for (const c of KNOWN_COLORS) {
    if (label.includes(c)) tokens.add(c);
  }
  return [...tokens];
}

function itemHasAvoidedColor(
  item: StudioItem,
  avoid: string[] | undefined,
): boolean {
  if (!avoid?.length) return false;
  const tokens = colorTokens(item);
  if (!tokens.length) return false;
  for (const raw of avoid) {
    const needle = lc(raw).trim();
    if (!needle) continue;
    for (const t of tokens) {
      if (t === needle) return true;
      if (t.includes(needle) || needle.includes(t)) return true;
    }
  }
  return false;
}

function isExtremeEnvironmentMismatch(
  item: StudioItem,
  ctx: StudioBuildContext,
): boolean {
  const mc = lc(item.main_category);
  const sub = lc(item.subcategory);
  const st = ctx.studio;
  if (
    st.isFormalContext &&
    (mc === 'swimwear' ||
      /\b(trunks|boardshorts?|bikini|swimsuit)\b/.test(sub))
  ) {
    return true;
  }
  if (st.isGymContext && mc === 'formalwear') {
    return true;
  }
  if (st.isBeachContext && mc === 'formalwear') {
    return true;
  }
  return false;
}

function isExtremeDressMismatch(
  item: StudioItem,
  ctx: StudioBuildContext,
): boolean {
  const wanted = ctx.parsedConstraints.dressWanted;
  if (!wanted) return false;
  const actual = item.dress_code;
  if (!actual) return false;
  // Only hard-drop when the user asked for Business/SmartCasual and the
  // item is explicitly flagged UltraCasual — this mirrors the pre-existing
  // "extreme" threshold used by isExtremeOccasionMismatch without pulling
  // in the shared ai/occasionFilter module.
  if (
    (wanted === 'BusinessCasual' || wanted === 'SmartCasual') &&
    /ultracasual/i.test(actual)
  ) {
    return true;
  }
  return false;
}

/**
 * Hard pre-assembly filter. Any item that fails any of these checks is
 * removed from the candidate pool before the builder runs. No score
 * adjustments, no item mutation — just a pure predicate.
 */
export function filterCandidatePool(
  catalog: StudioItem[],
  ctx: StudioBuildContext,
): StudioItem[] {
  const avoidColors = ctx.styleProfile?.avoid_colors;
  const avoidSubcats =
    ctx.styleProfile?.avoid_subcategories ??
    ctx.styleProfile?.disliked_styles;

  return catalog.filter((item) => {
    // Presentation: masculine users never see feminine-coded items.
    if (
      ctx.userPresentation === 'masculine' &&
      isFeminineItem(
        item.main_category || '',
        item.subcategory || '',
        item.label || item.name || '',
      )
    ) {
      return false;
    }

    // Avoided colors from style profile (hard drop).
    if (itemHasAvoidedColor(item, avoidColors)) {
      return false;
    }

    // Avoided subcategories / disliked styles (hard drop).
    if (avoidSubcats?.length) {
      const text = itemText(item);
      if (matchesAny(text, avoidSubcats)) {
        return false;
      }
    }

    // Extreme environment mismatch (beach+formalwear, gym+formalwear, formal+swimwear).
    if (isExtremeEnvironmentMismatch(item, ctx)) {
      return false;
    }

    // Extreme dress-code mismatch (BusinessCasual + explicit UltraCasual item).
    if (isExtremeDressMismatch(item, ctx)) {
      return false;
    }

    return true;
  });
}

/** Group a (filtered) pool by canonical slot. */
export function partitionBySlot(
  pool: StudioItem[],
): Record<Slot, StudioItem[]> {
  const out: Record<Slot, StudioItem[]> = {
    tops: [],
    bottoms: [],
    shoes: [],
    outerwear: [],
    accessories: [],
    dresses: [],
    activewear: [],
    swimwear: [],
    undergarments: [],
    other: [],
  };
  for (const item of pool) {
    const slot = mapMainCategoryToSlot(item.main_category ?? '');
    out[slot].push(item);
  }
  return out;
}

/** Whether the context suppresses the layer slot entirely. */
export function shouldSuppressLayer(ctx: StudioBuildContext): boolean {
  if (ctx.studio.isBeachContext) return true;
  if (ctx.studio.isGymContext) return true;
  // Very warm weather: no outerwear.
  const tempF = ctx.weather?.tempF;
  if (typeof tempF === 'number' && tempF >= 78) return true;
  return false;
}

/** Whether the context suppresses the accessory slot entirely. */
export function shouldSuppressAccessory(ctx: StudioBuildContext): boolean {
  // Gym / swim contexts: keep accessories minimal — no watch/bag pairing.
  if (ctx.studio.isGymContext) return true;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Environmental hard gate (physics-dominant feasibility layer)
//
// Runs BEFORE scoring, compatibility checks, and slot partitioning.
// Removes items that are physically infeasible for the request's environment,
// regardless of style/occasion/brand/feedback preferences. Universal —
// no per-user, per-gender, or per-profile branches.
// Priority: Physics > Occasion > Style > Brand > Feedback.
// ─────────────────────────────────────────────────────────────────────────────

export type EnvironmentTier =
  | 'EXTREME_HEAT'
  | 'EXTREME_COLD'
  | 'ATHLETIC'
  | 'FORMAL_EVENT'
  | 'NORMAL';

const HEAT_TEMP_F = 82;
const COLD_TEMP_F = 40;

/** Derive the physical-feasibility tier for a request. Pure, no side effects. */
export function deriveEnvironmentTier(
  ctx: StudioBuildContext,
): EnvironmentTier {
  const tempF = ctx.weather?.tempF;
  const precip = ctx.weather?.precipitation;
  const st = ctx.studio;

  // Athletic wins over weather tiers when the user is explicitly going to
  // the gym — the item set shift there is absolute.
  if (st.isGymContext || ctx.parsedConstraints.wantsGym) {
    return 'ATHLETIC';
  }

  // Formal events override general heat/cold gating for formality
  // constraints; the physics of the venue is indoors-climate-controlled.
  if (st.isFormalContext) {
    return 'FORMAL_EVENT';
  }

  // Extreme heat: explicit high temp OR beach-context default (warm-weather
  // venue where wool/cashmere/tailoring are physically inappropriate).
  if (typeof tempF === 'number' && tempF >= HEAT_TEMP_F) {
    return 'EXTREME_HEAT';
  }
  if (st.isBeachContext) {
    return 'EXTREME_HEAT';
  }

  // Extreme cold: explicit low temp OR snow precipitation.
  if (typeof tempF === 'number' && tempF <= COLD_TEMP_F) {
    return 'EXTREME_COLD';
  }
  if (precip === 'snow') {
    return 'EXTREME_COLD';
  }

  return 'NORMAL';
}

function fabricText(item: StudioItem): string {
  return [item.material, item.label, item.subcategory]
    .filter(Boolean)
    .map((s) => lc(s))
    .join(' ');
}

function hasAnyMaterial(item: StudioItem, needles: RegExp[]): boolean {
  const text = fabricText(item);
  return needles.some((re) => re.test(text));
}

function subcategoryMatches(item: StudioItem, needles: RegExp[]): boolean {
  const sub = lc(item.subcategory);
  const label = lc(item.label);
  return needles.some((re) => re.test(sub) || re.test(label));
}

function isFormalDressCode(item: StudioItem): boolean {
  const dc = lc(item.dress_code);
  if (!dc) return false;
  return /business\s*formal|black\s*tie|white\s*tie|formal(?!\s*casual)/.test(
    dc,
  );
}

function isBusinessFormalByFormality(item: StudioItem): boolean {
  const f = Number(item.formality_score ?? NaN);
  return Number.isFinite(f) && f >= 8;
}

function isStructuredTrousers(item: StudioItem): boolean {
  const sub = lc(item.subcategory);
  if (!/(trouser|dress\s*pant|suit\s*pant|slack)/.test(sub)) return false;
  const mat = lc(item.material);
  if (/(wool|tweed|flannel|worsted)/.test(mat)) return true;
  // Lack of material info + trouser sub → still structured by default.
  if (!mat) return true;
  return false;
}

function isHeavyLayeredOuterwear(item: StudioItem): boolean {
  if (mapMainCategoryToSlot(item.main_category ?? '') !== 'outerwear') {
    return false;
  }
  const layering = lc(item.layering);
  if (layering === 'outer') return true;
  const mat = lc(item.material);
  if (/(wool|cashmere|down|fleece|shearling|tweed|flannel)/.test(mat)) {
    return true;
  }
  return subcategoryMatches(item, [
    /\bpuffer\b/,
    /\bparka\b/,
    /\bovercoat\b/,
    /\btrench\b/,
    /\bpeacoat\b/,
    /\btopcoat\b/,
  ]);
}

function isShorts(item: StudioItem): boolean {
  return subcategoryMatches(item, [/\bshorts?\b/]);
}

function isLinen(item: StudioItem): boolean {
  return hasAnyMaterial(item, [/\blinen\b/]);
}

function isOpenWeaveLight(item: StudioItem): boolean {
  return hasAnyMaterial(item, [
    /\bmesh\b/,
    /\bgauze\b/,
    /\bseersucker\b/,
    /\beyelet\b/,
  ]);
}

function isSandalOrUltraLight(item: StudioItem): boolean {
  return subcategoryMatches(item, [
    /\bsandals?\b/,
    /\bflip[- ]?flops?\b/,
    /\bslides?\b/,
    /\bespadrilles?\b/,
    /\bhuaraches?\b/,
  ]);
}

function isLeatherDressShoe(item: StudioItem): boolean {
  if (mapMainCategoryToSlot(item.main_category ?? '') !== 'shoes') return false;
  return subcategoryMatches(item, [
    /\bloafers?\b/,
    /\boxfords?\b/,
    /\bderbys?\b/,
    /\bmonks?\b/,
    /\bdress\s*shoes?\b/,
    /\bbrogues?\b/,
  ]);
}

function isStructuredTailoring(item: StudioItem): boolean {
  return subcategoryMatches(item, [
    /\bblazer\b/,
    /\bsport\s*coat\b/,
    /\bsuit\b/,
    /\btuxedo\b/,
    /\bstructured\s*jacket\b/,
  ]);
}

function isGymwear(item: StudioItem): boolean {
  return subcategoryMatches(item, [
    /\bathletic\b/,
    /\bjersey\b/,
    /\bsweatpants?\b/,
    /\btrack\s*pants?\b/,
    /\btrack\s*suit\b/,
    /\btank\s*top\b/,
    /\bperformance\b/,
  ]);
}

function isUltraCasual(item: StudioItem): boolean {
  const dc = lc(item.dress_code);
  return /ultra\s*casual/.test(dc);
}

function isWoolOrCashmere(item: StudioItem): boolean {
  return hasAnyMaterial(item, [/\bwool\b/, /\bcashmere\b/, /\bmerino\b/]);
}

function isSweaterOrJacket(item: StudioItem): boolean {
  return subcategoryMatches(item, [
    /\bsweater\b/,
    /\bcardigan\b/,
    /\bturtleneck\b/,
    /\bpullover\b/,
    /\bblazer\b/,
    /\bsport\s*coat\b/,
    /\bstructured\s*jacket\b/,
    /\bsuit\b/,
  ]);
}

/**
 * Hard physical-feasibility gate. Removes items that are infeasible for
 * the tier regardless of aesthetic score. No downweighting. No mutation.
 * Returns a new array; the input `pool` is not changed.
 *
 * @example
 *   const filtered = filterCandidatePool(catalog, ctx);
 *   const gated = applyEnvironmentalHardGate(filtered, ctx);
 */
export function applyEnvironmentalHardGate(
  pool: StudioItem[],
  ctx: StudioBuildContext,
): StudioItem[] {
  const tier = deriveEnvironmentTier(ctx);

  if (tier === 'NORMAL') {
    return pool;
  }

  const kept: StudioItem[] = [];
  const removed: Array<{ item: StudioItem; reason: string }> = [];

  for (const item of pool) {
    let dropReason: string | null = null;

    if (tier === 'EXTREME_HEAT') {
      if (isWoolOrCashmere(item)) dropReason = 'HEAT_WOOL_CASHMERE';
      else if (isSweaterOrJacket(item)) dropReason = 'HEAT_SWEATER_OR_JACKET';
      else if (isFormalDressCode(item) || isBusinessFormalByFormality(item))
        dropReason = 'HEAT_BUSINESS_FORMAL';
      else if (isStructuredTrousers(item))
        dropReason = 'HEAT_STRUCTURED_TROUSERS';
      else if (isHeavyLayeredOuterwear(item)) dropReason = 'HEAT_HEAVY_OUTER';
      else if (isLeatherDressShoe(item)) dropReason = 'HEAT_LEATHER_DRESS_SHOE';
    } else if (tier === 'EXTREME_COLD') {
      if (isShorts(item)) dropReason = 'COLD_SHORTS';
      else if (isLinen(item)) dropReason = 'COLD_LINEN';
      else if (isOpenWeaveLight(item)) dropReason = 'COLD_OPEN_WEAVE';
      else if (isSandalOrUltraLight(item)) dropReason = 'COLD_SANDAL_ULTRALIGHT';
    } else if (tier === 'ATHLETIC') {
      if (isStructuredTailoring(item)) dropReason = 'ATHLETIC_TAILORING';
      else if (isLeatherDressShoe(item)) dropReason = 'ATHLETIC_DRESS_SHOE';
      else if (isFormalDressCode(item) || isBusinessFormalByFormality(item))
        dropReason = 'ATHLETIC_BUSINESS_FORMAL';
    } else if (tier === 'FORMAL_EVENT') {
      if (isUltraCasual(item)) dropReason = 'FORMAL_ULTRACASUAL';
      else if (isGymwear(item)) dropReason = 'FORMAL_GYMWEAR';
      else if (isShorts(item)) dropReason = 'FORMAL_SHORTS';
      else if (isSandalOrUltraLight(item)) dropReason = 'FORMAL_SANDAL';
    }

    if (dropReason) {
      removed.push({ item, reason: dropReason });
    } else {
      kept.push(item);
    }
  }

  console.log(
    JSON.stringify({
      _tag: 'STUDIO_ENV_HARD_GATE',
      tier,
      before: pool.length,
      after: kept.length,
      droppedCount: removed.length,
      droppedReasons: removed.reduce<Record<string, number>>((acc, r) => {
        acc[r.reason] = (acc[r.reason] ?? 0) + 1;
        return acc;
      }, {}),
      beforeCategories: categoryHistogram(pool),
      afterCategories: categoryHistogram(kept),
    }),
  );

  return kept;
}

function categoryHistogram(items: StudioItem[]): Record<string, number> {
  const hist: Record<string, number> = {};
  for (const it of items) {
    const key = (it.main_category ?? 'Unknown').toString();
    hist[key] = (hist[key] ?? 0) + 1;
  }
  return hist;
}
