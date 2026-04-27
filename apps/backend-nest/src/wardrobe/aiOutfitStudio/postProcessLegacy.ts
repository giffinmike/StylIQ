// AI Outfit Studio – legacy slow-path post-processor.
//
// Containment-only quality pass. Operates on the object returned by
// WardrobeService.generateOutfits(...) and reshapes the *output array* to:
//   1. Deduplicate by the sorted set of resolved wardrobe item IDs.
//   2. Optionally reorder the top of the list when the request context
//      clearly implies a beach / hot-weather setting, using only fields
//      already present on each item (subcategory, main_category, label,
//      name). No new scoring system; no shared imports; no upstream
//      mutations.
//   3. Trim to exactly 3 outfits when at least 3 unique candidates exist;
//      otherwise return whatever unique candidates remain (never empty if
//      input was non-empty).
//
// The top-level "best_outfit" mirror fields (`outfit_id`, `items`, `why`,
// `missing`) are re-synced to whatever outfit ends up at index 0 so the
// frontend's best-pick view matches the reordered list. All other fields
// on the result object are passed through untouched.

const BEACH_QUERY_RE =
  /\b(beach|beaches|miami|sandy|tropical|hawaii|hawaiian|pool|poolside|seaside|seashore|coast|coastal|ocean|swim|swimsuit|island)\b/i;
const HOT_CLIMATE_RE =
  /\b(hot|tropical|warm|summer|sweltering|sun)\b/i;

const TARGET_COUNT = 3;
const HOT_TEMP_F_THRESHOLD = 82;
const DEBUG = process.env.AI_OUTFIT_STUDIO_DEBUG === '1';

export interface PostProcessCtx {
  query?: string;
  userStyle?: any;
  weather?: any;
}

interface OutfitLike {
  outfit_id?: string;
  title?: string;
  why?: string;
  missing?: any;
  items?: any[];
  [key: string]: any;
}

interface ResultLike {
  outfits?: OutfitLike[];
  outfit_id?: string;
  items?: any[];
  why?: string;
  missing?: any;
  [key: string]: any;
}

function isBeachContext(ctx: PostProcessCtx): boolean {
  const query = typeof ctx?.query === 'string' ? ctx.query : '';
  if (query && BEACH_QUERY_RE.test(query)) return true;

  const climate = String(ctx?.userStyle?.climate ?? '').trim();
  if (climate && HOT_CLIMATE_RE.test(climate)) return true;

  const weatherCond = String(
    ctx?.weather?.condition ?? ctx?.weather?.summary ?? '',
  );
  if (weatherCond && HOT_CLIMATE_RE.test(weatherCond)) return true;

  const tempCandidates = [
    ctx?.weather?.temperatureF,
    ctx?.weather?.tempF,
    ctx?.weather?.temp_f,
    ctx?.weather?.feelsLikeF,
  ];
  for (const t of tempCandidates) {
    const n = Number(t);
    if (Number.isFinite(n) && n >= HOT_TEMP_F_THRESHOLD) return true;
  }

  return false;
}

function fingerprint(outfit: OutfitLike): string {
  const items = Array.isArray(outfit?.items) ? outfit.items : [];
  const ids = items
    .map((it: any) => (it && it.id != null ? String(it.id) : ''))
    .filter((s) => s.length > 0)
    .slice()
    .sort();
  return ids.join('|');
}

function itemText(it: any): string {
  return `${String(it?.subcategory ?? '')} ${String(
    it?.main_category ?? '',
  )} ${String(it?.label ?? it?.name ?? '')}`.toLowerCase();
}

function scoreBeach(outfit: OutfitLike): number {
  const items: any[] = Array.isArray(outfit?.items) ? outfit.items : [];
  let score = 0;
  let hasDressShirt = false;
  let hasSneakers = false;

  for (const it of items) {
    const text = itemText(it);
    const main = String(it?.main_category ?? '').toLowerCase();
    const sub = String(it?.subcategory ?? '').toLowerCase();

    const looksBottom =
      main === 'bottoms' ||
      /\b(pants|trousers|jeans|shorts|chinos|slacks|skirt)\b/.test(sub);
    if (looksBottom) {
      if (/\b(shorts|swim trunks|board shorts|swimsuit|swim shorts)\b/.test(text)) {
        score += 3;
      } else if (/\b(trousers|chinos|jeans|slacks|dress pants)\b/.test(text)) {
        score -= 2;
      }
    }

    const looksTop =
      main === 'tops' ||
      /\b(shirt|tee|tank|polo|blouse|top)\b/.test(sub);
    if (looksTop) {
      if (/\b(t[- ]?shirt|tee|tank|hawaiian|aloha|linen|polo)\b/.test(text)) {
        score += 2;
      }
      if (/\bdress shirt\b/.test(text) || /\bbutton[- ]?down\b/.test(text)) {
        hasDressShirt = true;
        score -= 1;
      }
    }

    if (/\b(hat|cap|visor|sunglasses|bucket hat|panama|straw hat)\b/.test(text)) {
      score += 1;
    }

    if (/\b(sandals?|flip[- ]?flops?|slides?|thongs?|espadrilles?)\b/.test(text)) {
      score += 1;
    }
    if (/\b(sneakers?|trainers?|running shoes?)\b/.test(text)) {
      hasSneakers = true;
    }
  }

  if (hasDressShirt && hasSneakers) score -= 1;
  return score;
}

export function postProcessLegacyResult<T extends ResultLike>(
  result: T,
  ctx: PostProcessCtx,
): T {
  // Defensive: if the upstream value isn't an object, pass it through
  // unchanged. WardrobeService.generateOutfits always returns an object on
  // success, so this is purely a runtime guardrail.
  if (!result || typeof result !== 'object') return result;

  const inputOutfits: OutfitLike[] = Array.isArray((result as any).outfits)
    ? ((result as any).outfits as OutfitLike[])
    : [];

  const before = inputOutfits.length;

  const seen = new Set<string>();
  const deduped: OutfitLike[] = [];
  for (const o of inputOutfits) {
    const fp = fingerprint(o);
    if (!fp) {
      deduped.push(o);
      continue;
    }
    if (seen.has(fp)) continue;
    seen.add(fp);
    deduped.push(o);
  }

  const afterDedupe = deduped.length;

  let reordered: OutfitLike[] = deduped;
  if (isBeachContext(ctx)) {
    reordered = deduped
      .map((o, i) => ({ o, i, s: scoreBeach(o) }))
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .map((x) => x.o);
  }

  // Hard clamp: outfits.length is always <= TARGET_COUNT (3) on the way out.
  const top: OutfitLike[] = reordered.slice(0, TARGET_COUNT);

  if (DEBUG) {
    const fps = top.map(fingerprint);
    // eslint-disable-next-line no-console
    console.log(
      `[AI_OUTFIT_STUDIO_DEBUG] legacy_postprocess before=${before} after_dedupe=${afterDedupe} returned=${top.length} fingerprints=${fps.join(',')}`,
    );
  }

  // Always return a NEW object (shallow clone) so callers cannot accidentally
  // observe the un-trimmed upstream array.
  const next: any = { ...(result as any), outfits: top };
  if (top.length > 0) {
    const head: any = top[0];
    if (head?.outfit_id !== undefined) next.outfit_id = head.outfit_id;
    if (head?.items !== undefined) next.items = head.items;
    if (head?.why !== undefined) next.why = head.why;
    next.missing = head?.missing;
  }
  return next as T;
}
