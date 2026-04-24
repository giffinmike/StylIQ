// Part of the LEGACY FEB OUTFITS strict-containment path.
// Isolated engine entry. Must not import from wardrobe/logic/*,
// wardrobe/studio/*, ai/*, learning/*, or config/feature-flags.
// Logic/scoring/presentation helpers live under ./lf_* (legacyFeb/) only.
// Data-plumbing infrastructure (Pinecone, Node crypto) is imported directly
// because those modules are not shared scoring/compatibility logic.

import { randomUUID } from 'crypto';
import { queryUserNs } from '../../pinecone/pinecone-query';

import type { UserStyle } from './lf_style';
import type { WeatherContext } from './lf_weather';
import { extractStrictJson } from './lf_json';

// ─────────────────────────────────────────────────────────────
// Minimal structural typing for the dependencies passed through
// the controller without importing from outside legacyFeb/.
// The controller forwards its injected VertexService; we only
// require the surface we actually use.
// ─────────────────────────────────────────────────────────────
export interface LegacyFebVertexLike {
  embedText(text: string): Promise<number[]>;
  generateOutfits(prompt: string): Promise<any>;
}

// ─────────────────────────────────────────────────────────────
// Output shape contract — matches the current /outfits response
// (bare StudioOutfit[]) without importing from wardrobe/studio/*.
// The full adapter + field mapping will be implemented later in a
// dedicated legacyFebAdapter.ts file; this type is the on-wire
// shape only.
// ─────────────────────────────────────────────────────────────
export interface LegacyFebStudioItem {
  id: string;
  name?: string;
  label?: string;
  image?: string;
  image_url?: string;
  main_category?: string;
  subcategory?: string;
  color?: string;
  color_family?: string;
  brand?: string;
  dress_code?: string;
  formality_score?: number;
}

export interface LegacyFebStudioOutfit {
  outfit_id: string;
  title: string;
  why: string;
  reasoning?: string;
  score?: number;
  items: LegacyFebStudioItem[];
  slots?: {
    top?: LegacyFebStudioItem | null;
    bottom?: LegacyFebStudioItem | null;
    shoes?: LegacyFebStudioItem | null;
    layer?: LegacyFebStudioItem | null;
    accessory?: LegacyFebStudioItem | null;
  };
}

// ─────────────────────────────────────────────────────────────
// Args shape for the isolated engine entry.
// ─────────────────────────────────────────────────────────────
export interface GenerateLegacyFebOutfitsArgs {
  userId: string;
  query: string;
  refinementPrompt?: string;
  lockedItemIds?: string[];
  topK?: number;
  userStyle?: UserStyle;
  weather?: WeatherContext;
  vertex: LegacyFebVertexLike;
}

// ─────────────────────────────────────────────────────────────
// Raw Feb-internal result shape (engine output BEFORE adapter).
// The adapter (legacyFebAdapter.ts) normalizes this into the
// on-wire LegacyFebStudioOutfit[] contract consumed by the route.
// Defined locally to keep legacyFeb/ self-contained (no imports
// from outside this directory).
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
// Internal catalog row — prompt-friendly view of a Pinecone match
// with the DB-like fields needed to render outfit items.
// ─────────────────────────────────────────────────────────────
interface LegacyFebCatalogRow {
  index: number;
  id: string;
  name: string;
  label: string;
  image: string;
  image_url: string;
  main_category: string;
  subcategory: string;
  color: string;
  color_family: string;
  brand: string;
  dress_code: string;
  formality_score: number;
}

// ─────────────────────────────────────────────────────────────
// Minimal structural view of a Pinecone match with metadata.
// Narrower than the full SDK type so we don't pull types in.
// ─────────────────────────────────────────────────────────────
interface LegacyFebPineconeMatch {
  id: string;
  score?: number;
  metadata?: Record<string, unknown> | null;
}

const REQUIRED_OUTFIT_COUNT = 3;
const DEFAULT_TOP_K = 40;

function asStr(v: unknown, fallback = ''): string {
  if (v == null) return fallback;
  if (typeof v === 'string') return v;
  try {
    return String(v);
  } catch {
    return fallback;
  }
}

function asNum(v: unknown, fallback = 0): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function buildCatalogFromMatches(
  matches: LegacyFebPineconeMatch[],
): LegacyFebCatalogRow[] {
  return matches.map((m, index) => {
    const md = (m.metadata ?? {}) as Record<string, unknown>;
    const name = asStr(md.name ?? md.label);
    const label = asStr(md.label ?? md.name, name);
    const image = asStr(md.image_url ?? md.image);
    return {
      index,
      id: asStr(m.id),
      name,
      label,
      image,
      image_url: image,
      main_category: asStr(md.main_category),
      subcategory: asStr(md.subcategory),
      color: asStr(md.color),
      color_family: asStr(md.color_family ?? md.color),
      brand: asStr(md.brand),
      dress_code: asStr(md.dress_code),
      formality_score: asNum(md.formality_score, 0),
    };
  });
}

function buildEffectiveQuery(query: string, refinementPrompt?: string): string {
  const base = (query ?? '').trim();
  const refine = (refinementPrompt ?? '').trim();
  if (!refine) return base;
  return `${base}. User refinement: ${refine}`;
}

// ─────────────────────────────────────────────────────────────
// Minimal Feb-style prompt. Kept local because the full Feb
// `buildOutfitPrompt` helper lives under wardrobe/prompts/* and
// has not yet been copied into legacyFeb/. This inline prompt
// asks the LLM for the same JSON envelope Feb returned.
// ─────────────────────────────────────────────────────────────
function buildMinimalFebPrompt(args: {
  effectiveQuery: string;
  catalog: LegacyFebCatalogRow[];
  userStyle?: UserStyle;
  weather?: WeatherContext;
  lockedItemIds?: string[];
}): string {
  const catalogLines = args.catalog
    .map((c) => {
      const parts = [
        `#${c.index}`,
        `id=${c.id}`,
        c.label || '(unnamed)',
        c.main_category ? `main=${c.main_category}` : '',
        c.subcategory ? `sub=${c.subcategory}` : '',
        c.color ? `color=${c.color}` : '',
        c.brand ? `brand=${c.brand}` : '',
        c.dress_code ? `dress=${c.dress_code}` : '',
      ].filter(Boolean);
      return parts.join(' | ');
    })
    .join('\n');

  const stylePrefs = args.userStyle
    ? [
        args.userStyle.preferredColors?.length
          ? `preferred_colors=${args.userStyle.preferredColors.join(',')}`
          : '',
        args.userStyle.avoidColors?.length
          ? `avoid_colors=${args.userStyle.avoidColors.join(',')}`
          : '',
        args.userStyle.favoriteBrands?.length
          ? `favorite_brands=${args.userStyle.favoriteBrands.join(',')}`
          : '',
        args.userStyle.dressBias
          ? `dress_bias=${args.userStyle.dressBias}`
          : '',
      ]
        .filter(Boolean)
        .join('\n')
    : '';

  const weatherLine = args.weather
    ? `weather: tempF=${args.weather.tempF} precip=${args.weather.precipitation ?? 'none'} wind=${args.weather.windMph ?? 0}`
    : '';

  const lockedLine =
    args.lockedItemIds && args.lockedItemIds.length
      ? `locked_item_ids (must include): ${args.lockedItemIds.join(', ')}`
      : '';

  return [
    'You are a fashion outfit generator. Build exactly 3 distinct outfits from the CATALOG below.',
    'Each outfit must include at minimum: a top, a bottom, and shoes (from the catalog).',
    'Use ONLY items that appear in the catalog. Reference them by their numeric index (#N).',
    '',
    stylePrefs ? `USER_STYLE:\n${stylePrefs}` : '',
    weatherLine,
    lockedLine,
    '',
    `USER_QUERY: ${args.effectiveQuery}`,
    '',
    'CATALOG:',
    catalogLines || '(empty)',
    '',
    'Return STRICT JSON ONLY, matching this exact envelope:',
    '{',
    '  "outfits": [',
    '    {',
    '      "title": "short human title",',
    '      "why": "1-sentence rationale",',
    '      "items": [ { "index": <catalog index number> } ]',
    '    }',
    '  ]',
    '}',
    'Do not include any prose outside the JSON object.',
  ]
    .filter(Boolean)
    .join('\n');
}

// ─────────────────────────────────────────────────────────────
// Extract text from a Vertex generateContent response. The exact
// SDK shape is intentionally loose here (LegacyFebVertexLike types
// it as `Promise<any>`), so we walk the canonical paths defensively.
// ─────────────────────────────────────────────────────────────
function extractTextFromVertexResponse(resp: any): string {
  if (!resp) return '';
  try {
    // @google-cloud/vertexai shape: { response: { candidates: [ { content: { parts: [ { text } ] } } ] } }
    const parts =
      resp?.response?.candidates?.[0]?.content?.parts ??
      resp?.candidates?.[0]?.content?.parts ??
      [];
    if (Array.isArray(parts)) {
      const joined = parts
        .map((p: any) => (typeof p?.text === 'string' ? p.text : ''))
        .join('');
      if (joined) return joined;
    }
    if (typeof resp?.text === 'string') return resp.text;
    if (typeof resp?.response?.text === 'function') {
      const t = resp.response.text();
      if (typeof t === 'string') return t;
    }
  } catch {
    // fall through
  }
  return '';
}

function mapCatalogItemToRawItem(row: LegacyFebCatalogRow): LegacyFebRawItem {
  return {
    id: row.id,
    name: row.name,
    label: row.label,
    image: row.image,
    image_url: row.image_url,
    main_category: row.main_category,
    subcategory: row.subcategory,
    color: row.color,
    color_family: row.color_family,
    brand: row.brand,
    dress_code: row.dress_code,
    formality_score: row.formality_score,
  };
}

function resolveParsedItems(
  parsedItems: unknown,
  catalog: LegacyFebCatalogRow[],
): LegacyFebRawItem[] {
  if (!Array.isArray(parsedItems)) return [];
  const byId = new Map(catalog.map((c) => [c.id, c]));
  const resolved: LegacyFebRawItem[] = [];
  const seen = new Set<string>();

  for (const entry of parsedItems) {
    let row: LegacyFebCatalogRow | undefined;
    if (typeof entry === 'number' && catalog[entry]) {
      row = catalog[entry];
    } else if (entry && typeof entry === 'object') {
      const e = entry as Record<string, unknown>;
      if (typeof e.index === 'number' && catalog[e.index as number]) {
        row = catalog[e.index as number];
      } else if (typeof e.id === 'string' && byId.has(e.id)) {
        row = byId.get(e.id);
      }
    } else if (typeof entry === 'string' && byId.has(entry)) {
      row = byId.get(entry);
    }
    if (row && !seen.has(row.id)) {
      seen.add(row.id);
      resolved.push(mapCatalogItemToRawItem(row));
    }
  }
  return resolved;
}

/**
 * LEGACY FEB OUTFITS — core pipeline (phase 1).
 *
 * Phases implemented here:
 *   1. Retrieval          — Vertex embedding + Pinecone queryUserNs
 *   2. Prompt construction — minimal inline Feb-style envelope prompt
 *   3. Vertex call         — args.vertex.generateContent
 *   4. JSON parse          — lf_json.extractStrictJson
 *   5. Basic validation    — resolve catalog references, dedupe items
 *   6. Raw return          — LegacyFebRawResult (no Studio adapter here)
 *
 * Deliberately NOT implemented in this step:
 *   - Context filters, constraint parsing, rerank, presentation filter,
 *     style-agent prompt injection, elite scoring, finalize/enforce/
 *     pad-to-3, session/refinement Redis, must-have color+slot injection,
 *     extra-fetch boosts. Those require helpers that have not yet been
 *     copied into legacyFeb/ and will be added in later phases under
 *     strict containment.
 *
 * This function produces the raw Feb envelope. The adapter
 * (legacyFebAdapter.ts) is the sole place that shapes this for the
 * wire contract. No controller wiring is performed here.
 */
export async function generateLegacyFebOutfits(
  args: GenerateLegacyFebOutfitsArgs,
): Promise<LegacyFebRawResult> {
  const request_id = randomUUID();
  const topK = Math.max(1, Math.floor(args.topK ?? DEFAULT_TOP_K));

  // ── Phase 1: Retrieval ─────────────────────────────────────
  const effectiveQuery = buildEffectiveQuery(args.query, args.refinementPrompt);
  const queryVec = await args.vertex.embedText(effectiveQuery);
  const matchesRaw = (await queryUserNs({
    userId: args.userId,
    vector: queryVec,
    topK,
    includeMetadata: true,
  })) as unknown as LegacyFebPineconeMatch[];
  const matches = Array.isArray(matchesRaw) ? matchesRaw : [];
  const catalog = buildCatalogFromMatches(matches);

  if (catalog.length === 0) {
    return {
      request_id,
      outfit_id: null,
      items: [],
      why: '',
      missing: 'No wardrobe items available for this user.',
      outfits: [],
    };
  }

  // ── Phase 2: Prompt construction ───────────────────────────
  const prompt = buildMinimalFebPrompt({
    effectiveQuery,
    catalog,
    userStyle: args.userStyle,
    weather: args.weather,
    lockedItemIds: args.lockedItemIds,
  });

  // ── Phase 3: Vertex LLM call ───────────────────────────────
  // VertexService.generateOutfits(prompt) takes a prompt string and
  // returns the SDK's `result.response` object (candidates → content
  // → parts → text). We don't set generationConfig here because the
  // wrapper uses the configured Gemini model defaults — matching
  // February behavior.
  const llmResponse = await args.vertex.generateOutfits(prompt);
  const llmText = extractTextFromVertexResponse(llmResponse);

  // ── Phase 4: JSON parse (lf_json) ──────────────────────────
  let parsed: any;
  try {
    parsed = extractStrictJson(llmText);
  } catch {
    return {
      request_id,
      outfit_id: null,
      items: [],
      why: '',
      missing: 'LLM returned no parseable outfit JSON.',
      outfits: [],
    };
  }

  // ── Phase 5: Basic validation ──────────────────────────────
  const parsedOutfits: any[] = Array.isArray(parsed?.outfits)
    ? parsed.outfits
    : [];

  const outfits: LegacyFebRawOutfit[] = parsedOutfits
    .slice(0, REQUIRED_OUTFIT_COUNT)
    .map((o: any, i: number) => {
      const items = resolveParsedItems(o?.items, catalog);
      return {
        outfit_id: asStr(o?.outfit_id, `legacyFeb-${request_id}-${i + 1}`),
        title: asStr(o?.title, `Outfit ${i + 1}`),
        why: asStr(o?.why, ''),
        reasoning: asStr(o?.reasoning ?? o?.why, ''),
        missing: asStr(o?.missing, ''),
        score: typeof o?.score === 'number' ? o.score : null,
        items,
      };
    });

  // ── Phase 6: Raw return (no adapter here) ──────────────────
  const best = outfits[0];
  return {
    request_id,
    outfit_id: best?.outfit_id ?? null,
    items: best?.items ?? [],
    why: best?.why ?? '',
    missing: best ? (best.missing ?? '') : 'No outfits produced.',
    outfits,
  };
}
