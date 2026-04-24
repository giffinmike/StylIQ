// Part of the LEGACY FEB OUTFITS strict-containment path.
// Pure adapter: Feb-internal result shape → LegacyFebStudioOutfit[] wire shape.
// Must not import from wardrobe/logic/*, wardrobe/studio/*, ai/*,
// learning/*, or config/*. Only ./legacyFebOutfits and other ./lf_* peers.

import type {
  LegacyFebStudioItem,
  LegacyFebStudioOutfit,
} from './legacyFebOutfits';
import { getSlot, type Slot } from './lf_categoryMapping';

// ─────────────────────────────────────────────────────────────
// Feb-internal raw shapes (structural — no import from outside).
// These mirror what the Feb wardrobe.service returned:
//   { request_id, outfit_id, items, why, missing, outfits: [...] }
// ─────────────────────────────────────────────────────────────
export interface LegacyFebRawItem {
  id?: string | null;
  name?: string | null;
  label?: string | null;
  image?: string | null;
  image_url?: string | null;
  main_category?: string | null;
  subcategory?: string | null;
  color?: string | null;
  color_family?: string | null;
  brand?: string | null;
  dress_code?: string | null;
  formality_score?: number | null;
}

export interface LegacyFebRawOutfit {
  outfit_id?: string | null;
  title?: string | null;
  why?: string | null;
  reasoning?: string | null;
  missing?: string | null;
  score?: number | null;
  items?: LegacyFebRawItem[] | null;
}

export interface LegacyFebRawResult {
  request_id?: string | null;
  outfit_id?: string | null;
  items?: LegacyFebRawItem[] | null;
  why?: string | null;
  missing?: string | null;
  outfits?: LegacyFebRawOutfit[] | null;
}

// ─────────────────────────────────────────────────────────────
// Normalization helpers
// ─────────────────────────────────────────────────────────────

const REQUIRED_OUTFIT_COUNT = 3;

function safeString(v: unknown, fallback = ''): string {
  if (v == null) return fallback;
  if (typeof v === 'string') return v;
  try {
    return String(v);
  } catch {
    return fallback;
  }
}

function safeNumber(v: unknown, fallback = 0): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function stableOutfitId(idx: number, raw: LegacyFebRawOutfit | undefined): string {
  const given = raw?.outfit_id;
  if (typeof given === 'string' && given.trim().length > 0) {
    return given.trim();
  }
  // Deterministic fallback id (stable per index within a single response).
  return `legacyFeb-outfit-${idx + 1}`;
}

function normalizeItem(raw: LegacyFebRawItem | undefined): LegacyFebStudioItem {
  const id = safeString(raw?.id);
  const name = safeString(raw?.name, '');
  const label = safeString(raw?.label, name);
  const image = safeString(raw?.image, '');
  const image_url = safeString(raw?.image_url, image);
  const main_category = safeString(raw?.main_category, '');
  const subcategory = safeString(raw?.subcategory, '');
  const color = safeString(raw?.color, '');
  const color_family = safeString(raw?.color_family, color);
  const brand = safeString(raw?.brand, '');
  const dress_code = safeString(raw?.dress_code, '');
  const formality_score = safeNumber(raw?.formality_score, 0);

  return {
    id,
    name,
    label,
    image,
    image_url,
    main_category,
    subcategory,
    color,
    color_family,
    brand,
    dress_code,
    formality_score,
  };
}

function deriveSlots(items: LegacyFebStudioItem[]): {
  top: LegacyFebStudioItem | null;
  bottom: LegacyFebStudioItem | null;
  shoes: LegacyFebStudioItem | null;
  layer: LegacyFebStudioItem | null;
  accessory: LegacyFebStudioItem | null;
} {
  let top: LegacyFebStudioItem | null = null;
  let bottom: LegacyFebStudioItem | null = null;
  let shoes: LegacyFebStudioItem | null = null;
  let layer: LegacyFebStudioItem | null = null;
  let accessory: LegacyFebStudioItem | null = null;

  for (const it of items) {
    const slot: Slot = getSlot({ main_category: it.main_category });
    switch (slot) {
      case 'tops':
        if (!top) top = it;
        break;
      case 'bottoms':
        if (!bottom) bottom = it;
        break;
      case 'shoes':
        if (!shoes) shoes = it;
        break;
      case 'outerwear':
        if (!layer) layer = it;
        break;
      case 'accessories':
        if (!accessory) accessory = it;
        break;
      case 'dresses':
        // A dress occupies the top+bottom visual role; surface as `top`
        // if unfilled; this keeps the required keys populated without
        // lying about the structure.
        if (!top) top = it;
        break;
      default:
        break;
    }
  }

  return { top, bottom, shoes, layer, accessory };
}

function normalizeOutfit(
  raw: LegacyFebRawOutfit | undefined,
  idx: number,
): LegacyFebStudioOutfit {
  const rawItems = Array.isArray(raw?.items) ? raw!.items! : [];
  const items = rawItems
    .filter((x): x is LegacyFebRawItem => x != null && typeof x === 'object')
    .map(normalizeItem);

  const outfit_id = stableOutfitId(idx, raw);
  const title = safeString(raw?.title, `Outfit ${idx + 1}`);
  const why = safeString(raw?.why, '');
  const reasoning = safeString(raw?.reasoning, why);
  const score = safeNumber(raw?.score, 0);
  const slots = deriveSlots(items);

  return {
    outfit_id,
    title,
    why,
    reasoning,
    score,
    items,
    slots,
  };
}

function buildPlaceholderOutfit(idx: number): LegacyFebStudioOutfit {
  return {
    outfit_id: `legacyFeb-placeholder-${idx + 1}`,
    title: `Outfit ${idx + 1}`,
    why: '',
    reasoning: '',
    score: 0,
    items: [],
    slots: {
      top: null,
      bottom: null,
      shoes: null,
      layer: null,
      accessory: null,
    },
  };
}

// ─────────────────────────────────────────────────────────────
// Public adapter entry
// ─────────────────────────────────────────────────────────────

/**
 * Adapts a Feb-internal raw outfit result into the on-wire contract
 * consumed by the /api/wardrobe/outfits endpoint (a bare StudioOutfit[]
 * of exactly 3 outfits).
 *
 * Guarantees:
 *  - Always returns exactly 3 outfits (pads with placeholders, or
 *    truncates if the raw result over-delivers).
 *  - Every outfit has a stable, non-empty `outfit_id`.
 *  - Every outfit has a `slots` object with `top`, `bottom`, `shoes`,
 *    `layer`, `accessory` keys present (values may be null, but keys
 *    are never undefined).
 *  - Every string field is defined (never `undefined`).
 *  - Pure function — no I/O, no side effects, no reference to shared
 *    Studio/logic/ai types.
 */
export function adaptLegacyFebToStudioShape(
  raw: LegacyFebRawResult | null | undefined,
): LegacyFebStudioOutfit[] {
  const rawOutfits = Array.isArray(raw?.outfits) ? raw!.outfits! : [];

  const normalized: LegacyFebStudioOutfit[] = rawOutfits
    .slice(0, REQUIRED_OUTFIT_COUNT)
    .map((o, idx) => normalizeOutfit(o ?? undefined, idx));

  while (normalized.length < REQUIRED_OUTFIT_COUNT) {
    normalized.push(buildPlaceholderOutfit(normalized.length));
  }

  return normalized;
}
