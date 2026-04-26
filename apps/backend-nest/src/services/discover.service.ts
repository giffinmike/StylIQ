import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { pool } from '../db/pool';
import { getSecret, secretExists } from '../config/secrets';
import { LearningEventsService } from '../learning/learning-events.service';
import { FashionStateService } from '../learning/fashion-state.service';
import type { FashionStateSummary, UserFashionState } from '../learning/dto/fashion-state.dto';
import { LEARNING_FLAGS } from '../config/feature-flags';
import { applyDiscoverVeto, type VetoProfile, type VetoResult } from './discover-veto';
import { computeCuratorSignals, type CuratorProfile, type CuratorResult } from './discover-curator';
import { runDiscoverSharedBrainGate, type BrainGateProfile } from './discover-brain-adapter';

/**
 * Compute the effective batch date for a user based on their timezone.
 * Before 5 AM local → previous calendar day.
 * At or after 5 AM local → current calendar day.
 * Returns YYYY-MM-DD string suitable for SQL date comparison.
 */
function computeUserBatchDate(timezone: string): string {
  try {
    const now = new Date();
    // Get current date parts in user's timezone
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const year = parts.find(p => p.type === 'year')!.value;
    const month = parts.find(p => p.type === 'month')!.value;
    const day = parts.find(p => p.type === 'day')!.value;
    const localDateStr = `${year}-${month}-${day}`;

    // Get current hour in user's timezone
    const hourStr = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
    }).format(now);
    const localHour = Number(hourStr);

    if (localHour < 5) {
      // Before 5 AM: use previous day
      const yesterday = new Date(now);
      const prevParts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(new Date(yesterday.getTime() - 24 * 60 * 60 * 1000));
      const py = prevParts.find(p => p.type === 'year')!.value;
      const pm = prevParts.find(p => p.type === 'month')!.value;
      const pd = prevParts.find(p => p.type === 'day')!.value;
      return `${py}-${pm}-${pd}`;
    }

    return localDateStr;
  } catch {
    // Invalid timezone — fall back to UTC date
    return new Date().toISOString().slice(0, 10);
  }
}

interface UserProfile {
  gender: string | null;
  preferred_brands: string[];
  style_keywords: string[];
  color_preferences: string[];
  disliked_styles: string[];
  style_preferences: string[];
  fit_preferences: string[];
  body_type: string | null;
  climate: string | null;
  // Hard-veto constraint fields
  avoid_colors: string[];
  avoid_materials: string[];
  avoid_patterns: string[];
  coverage_no_go: string[];
  walkability_requirement: string | null;
  silhouette_preference: string | null;
  formality_floor: string | null;
}

interface BrowserSignals {
  brands: string[];
  categories: string[];
  colors: string[];
}

interface LearnedPreferences {
  positive_features: string[];
  negative_features: string[];
}

export interface DiscoverProduct {
  id: string;
  product_id: string;
  title: string;
  brand: string | null;
  price: number | null;
  price_raw: string | null;
  image_url: string;
  link: string;
  source: string | null;
  category: string | null;
  position: number;
  saved?: boolean;
  saved_at?: string | null;
  batch_date?: string;
  is_current?: boolean;
  enriched_color?: string | null;
  enriched_color_source?: 'ml' | 'fallback' | 'cached' | null;
  disliked?: boolean;
  // Explanation layer (optional — won't break existing consumers)
  score_total?: number;
  score_breakdown?: Record<string, number>;
  match_reasons?: string[];
}

const TARGET_PRODUCTS = 10;
const DEBUG_RECOMMENDED_BUYS = process.env.DEBUG_RECOMMENDED_BUYS === 'true';

/** Brand tier multiplier: prestige-aware boost applied when brand matches. */
const BRAND_TIER_MAP: Record<string, number> = {
  // Luxury / Designer
  'gucci': 1.35,
  'prada': 1.35,
  'saint laurent': 1.35,
  'valentino': 1.35,
  'versace': 1.3,
  'balmain': 1.3,
  'roberto cavalli': 1.3,
  'dolce gabbana': 1.3,
  'bottega veneta': 1.3,
  'balenciaga': 1.3,
  'givenchy': 1.25,
  'fendi': 1.25,
  'burberry': 1.25,
  'tom ford': 1.3,
  'dior': 1.35,
  'chanel': 1.35,
  'louis vuitton': 1.35,
  'hermes': 1.35,

  // Premium Heritage
  'brioni': 1.3,
  'zegna': 1.25,
  'canali': 1.25,
  'polo ralph lauren': 1.2,
  'ralph lauren': 1.2,
  'hugo boss': 1.15,
  'brooks brothers': 1.15,

  // Contemporary
  'theory': 1.15,
  'reiss': 1.15,
  'allsaints': 1.1,
  'cos': 1.1,
  'ted baker': 1.1,
  'club monaco': 1.1,

  // Mass / Fast Fashion
  'zara': 0.95,
  'hm': 0.9,
  'uniqlo': 1.0,
  'gap': 0.95,
  'old navy': 0.85,
  'boohooman': 0.85,
  'fashion nova': 0.85,
  'shein': 0.8,
  'walmart': 0.75,
};

/** Brand authority tiers: quality intelligence independent of user preference.
 *  Tier 1 = luxury, Tier 5 = unknown/low authority. Default = Tier 4. */
const BRAND_AUTHORITY_TIERS: Record<string, number> = {
  // Tier 1 – Luxury / Designer
  'alexander mcqueen': 1, 'amiri': 1, 'armani': 1, 'balenciaga': 1,
  'balmain': 1, 'bottega veneta': 1, 'brioni': 1, 'brunello cucinelli': 1,
  'burberry': 1, 'carolina herrera': 1, 'cartier': 1, 'celine': 1,
  'chanel': 1, 'chloe': 1, 'christian louboutin': 1, 'dior': 1,
  'dolce gabbana': 1, 'elie saab': 1, 'emilio pucci': 1,
  'ermenegildo zegna': 1, 'etro': 1, 'fendi': 1, 'ferragamo': 1,
  'giorgio armani': 1, 'givenchy': 1, 'gucci': 1, 'hermes': 1,
  'isabel marant': 1, 'jacquemus': 1, 'jimmy choo': 1, 'kenzo': 1,
  'lanvin': 1, 'loewe': 1, 'louis vuitton': 1, 'manolo blahnik': 1,
  'marc jacobs': 1, 'marchesa': 1, 'marni': 1, 'max mara': 1,
  'missoni': 1, 'miu miu': 1, 'moncler': 1, 'moschino': 1,
  'off white': 1, 'offwhite': 1, 'oscar de la renta': 1, 'prada': 1,
  'proenza schouler': 1, 'pucci': 1, 'rick owens': 1,
  'roberto cavalli': 1, 'saint laurent': 1, 'salvatore ferragamo': 1,
  'stella mccartney': 1, 'thom browne': 1, 'tiffany': 1, 'tom ford': 1,
  'valentino': 1, 'vera wang': 1, 'versace': 1, 'vivienne westwood': 1,
  'zegna': 1,

  // Tier 2 – Premium Contemporary
  'acne studios': 2, 'agolde': 2, 'alice olivia': 2, 'allsaints': 2,
  'anine bing': 2, 'apc': 2, 'badgley mischka': 2, 'banana republic': 2,
  'brooks brothers': 2, 'calvin klein': 2, 'canali': 2,
  'citizens of humanity': 2, 'club monaco': 2, 'coach': 2, 'cole haan': 2,
  'cos': 2, 'derek lam': 2, 'diane von furstenberg': 2, 'diesel': 2,
  'dvf': 2, 'eileen fisher': 2, 'emporio armani': 2, 'furla': 2,
  'ganni': 2, 'helmut lang': 2, 'hugo boss': 2, 'j crew': 2, 'jcrew': 2,
  'karl lagerfeld': 2, 'kate spade': 2, 'khaite': 2, 'lacoste': 2,
  'longchamp': 2, 'lululemon': 2, 'madewell': 2, 'massimo dutti': 2,
  'mcm': 2, 'michael kors': 2, 'nili lotan': 2,
  'paul smith': 2, 'phillip lim': 2, '31 phillip lim': 2,
  'polo ralph lauren': 2, 'rag bone': 2, 'ralph lauren': 2,
  'rebecca minkoff': 2, 'reformation': 2, 'reiss': 2, 'sandro': 2,
  'self portrait': 2, 'staud': 2, 'stuart weitzman': 2, 'ted baker': 2,
  'theory': 2, 'tods': 2, 'tommy hilfiger': 2, 'tory burch': 2,
  'ulla johnson': 2, 'veronica beard': 2, 'vince': 2, 'vince camuto': 2,
  'zimmermann': 2,

  // Tier 3 – Mall / Mid-tier
  'abercrombie': 3, 'adidas': 3, 'american eagle': 3, 'ann taylor': 3,
  'armani exchange': 3, 'asos': 3, 'athleta': 3, 'bcbg': 3,
  'bcbgmaxazria': 3, 'champion': 3, 'columbia': 3, 'converse': 3,
  'dkny': 3, 'everlane': 3, 'express': 3, 'forever 21': 3,
  'free people': 3, 'french connection': 3, 'gap': 3, 'guess': 3,
  'h m': 3, 'hm': 3, 'hollister': 3, 'hollister co official': 3,
  'j jill': 3, 'jjill': 3, 'kenneth cole': 3, 'levis': 3, 'loft': 3,
  'lucky brand': 3, 'mango': 3, 'nautica': 3,
  'new balance': 3, 'nike': 3, 'north face': 3, 'the north face': 3,
  'patagonia': 3, 'perry ellis': 3, 'puma': 3, 'sam edelman': 3,
  'steve madden': 3, 'tommy bahama': 3, 'topshop': 3,
  'under armour': 3, 'under armor': 3, 'uniqlo': 3,
  'urban outfitters': 3, 'vans': 3, 'vera bradley': 3,
  'vineyard vines': 3, 'white house black market': 3, 'wrangler': 3,
  'zara': 3, 'zara usa': 3,

  // Tier 4 – Fast Fashion / Value
  'boohoo': 4, 'boohoo usa': 4, 'boohooman': 4, 'old navy': 4, 'target': 4,
  'fashion nova': 4, 'shein': 4, 'primark': 4, 'romwe': 4,

  // Tier 5 – Unknown marketplace / low authority
  'mondressy': 5, 'vardo': 5, 'suits outlets': 5,
  'walmart': 5, 'walmart gpaecead kids baby clothes': 5,
  'temu': 5, 'dhgate': 5, 'aliexpress': 5, 'wish': 5,
};

/** Map brand authority tier (1–5) to a linear score adjustment (-2 to +3) */
function getBrandAuthorityScore(brand?: string | null): number {
  if (!brand) return -1;
  const key = normalize(brand);
  if (!key) return -1;
  const tier = BRAND_AUTHORITY_TIERS[key] ?? 4;
  switch (tier) {
    case 1: return 4;
    case 2: return 3;
    case 3: return 1;
    case 4: return 0;
    case 5: return -3;
    default: return 0;
  }
}

/**
 * Extract the actual fashion brand from a product title by matching against
 * BRAND_AUTHORITY_TIERS keys. Sorted by key length descending so multi-word
 * brands (e.g. "ralph lauren") match before single-word substrings.
 * Word-boundary safe to prevent partial matches (e.g. "express" inside "expressed").
 * Returns the normalized brand key or null if no match.
 */
const _brandTierKeysByLength = Object.keys(BRAND_AUTHORITY_TIERS)
  .sort((a, b) => b.length - a.length);

const SPAM_PREFIXES = new Set(['discount', 'buy', 'sell', 'sale', 'cheap']);

/**
 * Heuristic brand extractor: pull leading capitalized word sequence from title.
 * Independent of BRAND_AUTHORITY_TIERS — works for ANY brand.
 * Stops at known product descriptors, lowercase words, or possessive markers.
 */
const BRAND_STOP_WORDS = new Set([
  'classic', 'modern', 'casual', 'formal', 'slim', 'regular', 'new', 'premium',
  'luxury', 'designer', 'original', 'authentic', 'essential', 'basic', 'organic',
  'natural', 'handmade', 'custom', 'vintage', 'retro', 'oversized', 'lightweight',
  'stretch', 'solid', 'striped', 'plaid', 'printed', 'graphic', 'plain',
  'long', 'short', 'mid', 'mini', 'maxi', 'cropped',
  'cotton', 'wool', 'silk', 'leather', 'linen', 'polyester', 'nylon', 'cashmere',
  'mens', 'womens', 'men', 'women', 'unisex', 'kids', 'boys', 'girls',
  'black', 'white', 'blue', 'red', 'green', 'navy', 'gray', 'grey',
  'brown', 'beige', 'pink', 'yellow', 'purple', 'orange', 'cream', 'ivory',
  'size', 'pack', 'set', 'piece', 'pair', 'lot',
  'for', 'with', 'in', 'on', 'at', 'by',
  'cool', 'soft', 'warm', 'light', 'heavy', 'thin', 'thick', 'wide', 'narrow',
  'tight', 'loose', 'big', 'small', 'large',
]);

function extractProductBrand(title: string): string | null {
  if (!title) return null;
  const words = title.trim().split(/\s+/);
  const brandWords: string[] = [];

  for (const word of words) {
    // Strip trailing possessive 's
    const clean = word.replace(/'s$/i, '');
    const alpha = clean.replace(/[^a-zA-Z0-9]/g, '');
    if (!alpha) break;

    // Stop at known non-brand descriptor words
    if (BRAND_STOP_WORDS.has(alpha.toLowerCase())) break;

    // Stop at lowercase words (brand names are title-cased or all-caps)
    const isCapitalized = /^[A-Z]/.test(alpha);
    const isAllCaps = /^[A-Z0-9]+$/.test(alpha) && alpha.length > 1;
    const isNumeric = /^\d+$/.test(alpha);
    if (!isCapitalized && !isAllCaps && !isNumeric) break;

    brandWords.push(clean);
    if (brandWords.length >= 4) break;
  }

  return brandWords.length > 0 ? brandWords.join(' ') : null;
}

function extractBrandFromTitle(title: string): string | null {
  if (!title) return null;
  const norm = normalize(title);
  if (!norm) return null;
  const tokens = norm.split(/\s+/);

  for (const key of _brandTierKeysByLength) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(`\\b${escaped}\\b`).test(norm)) continue;

    // Find brand start position as contiguous token sequence
    const brandTokens = key.split(/\s+/);
    let startIdx = -1;
    for (let i = 0; i <= tokens.length - brandTokens.length; i++) {
      if (brandTokens.every((bt, j) => tokens[i + j] === bt)) {
        startIdx = i;
        break;
      }
    }
    if (startIdx === -1) continue;

    // Brand must start within first 5 tokens
    if (startIdx > 4) continue;

    // Reject if any spam token precedes the brand
    if (tokens.slice(0, startIdx).some(t => SPAM_PREFIXES.has(t))) continue;

    return key;
  }
  return null;
}

/** Resolve brand tier from productBrand. Never falls back to merchant/source. Default = tier 3. */
function resolveBrandTier(productBrand: string | null | undefined): number {
  if (!productBrand) return 3;
  const norm = normalize(productBrand);
  if (!norm) return 3;
  // Exact match
  if (BRAND_AUTHORITY_TIERS[norm] != null) return BRAND_AUTHORITY_TIERS[norm];
  // Word-boundary match against known brand keys (handles "Nike Air Max" → "nike")
  for (const key of _brandTierKeysByLength) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`).test(norm)) return BRAND_AUTHORITY_TIERS[key];
  }
  return 3;
}

/** Strip non-alphanumeric (except spaces), lowercase, collapse whitespace */
function normalize(str?: string | null): string {
  return (str || '')
    .toLowerCase()
    .replace(/-/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalize a color key, collapsing "grey" → "gray" */
function normalizeColorKey(raw: string | null | undefined): string {
  if (!raw) return '';
  const n = normalize(raw);
  return n === 'grey' ? 'gray' : n;
}

function inferMainCategory(title?: string): string | null {
  if (!title) return null;
  const t = normalize(title);

  if (/(jacket|coat|parka|blazer|overshirt|anorak|windbreaker|gilet|poncho|puffer)/.test(t)) return 'Outerwear';
  if (/(dress|gown|romper|jumpsuit|kaftan)/.test(t)) return 'Dresses';
  if (/(shirt|polo|\btee\b|tshirt|t shirt|sweater|jumper|hoodie|sweatshirt|cardigan|pullover|blouse|tunic|henley|camisole|crop top|tank top)/.test(t)) return 'Tops';
  if (/(jeans|pants|trouser|shorts|legging|jogger|chino|skirt)/.test(t)) return 'Bottoms';
  if (/(sneaker|boot|loafer|shoe|sandal|slipper|mule|oxford|clog)/.test(t)) return 'Shoes';
  if (/(handbag|backpack|tote bag|clutch|purse|crossbody|duffel)/.test(t)) return 'Bags';
  if (/(watch|bracelet|necklace|earring|pendant|anklet|brooch|cufflink)/.test(t)) return 'Jewelry';
  if (/(belt|\btie\b|\bhat\b|\bcap\b|scarf|glove|sunglasses|beanie|headband)/.test(t)) return 'Accessories';
  if (/(swimsuit|bikini|swim trunk|rash guard)/.test(t)) return 'Swimwear';
  if (/(athletic|yoga|workout|activewear)/.test(t)) return 'Activewear';

  return null;
}

/** Clamp a number to the [0, 1] range */
function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** Create a Set of normalized strings from an array */
function tokenSet(items: string[]): Set<string> {
  const s = new Set<string>();
  for (const item of items) {
    const n = normalize(item);
    if (n) s.add(n);
  }
  return s;
}

/** Escape special regex characters in a string */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Word-boundary-safe token match: prevents "red" matching inside "tired" */
function wordBoundaryMatch(blob: string, token: string): boolean {
  return new RegExp(`\\b${escapeRegex(token)}\\b`).test(blob);
}

/** Fraction of needles found (substring) in text, normalized to 0..1 */
function overlap01(needles: Set<string>, text: string): number {
  if (needles.size === 0) return 0;
  const normText = normalize(text);
  if (!normText) return 0;
  let hits = 0;
  for (const needle of needles) {
    if (normText.includes(needle)) hits++;
  }
  return clamp01(hits / needles.size);
}

/** Deterministic brand saturation penalty: 8 * (brandFreq01 ^ 1.5) */
function brandSatPenalty(brandFreq01: number): number {
  return 8 * (brandFreq01 ** 1.5);
}

// ==================== SEMANTIC CLUSTER SUPPRESSION ====================
// Pure-function classification + deterministic caps to prevent silhouette spam
// (e.g., 5 suits in top 10 when style tokens expand to formal/business/suit)

/** Strict-phase caps per cluster. Unlisted clusters use CLUSTER_DEFAULT_CAP. */
const CLUSTER_STRICT_CAPS: Record<string, number> = {
  suit_cluster: 2,
  athleisure_cluster: 2,
  outerwear_cluster: 2,
};
const CLUSTER_DEFAULT_CAP = 3;

/** Classify a product into exactly one semantic cluster key. Pure function. */
function getSemanticCluster(title: string, category?: string | null): string {
  const text = normalize((title || '') + ' ' + (category || ''));

  // Suit cluster — check first (most specific problem)
  if (
    (/\bsuit\b/i.test(text) && !/\bsweatsuit\b/i.test(text)) ||
    /\btux\b/.test(text) ||
    /\btuxedo\b/.test(text) ||
    text.includes('3 piece') ||
    text.includes('three piece') ||
    text.includes('two piece') ||
    text.includes('2 piece') ||
    /\bvest\b/.test(text) ||
    /\bwaistcoat\b/.test(text) ||
    (text.includes('blazer') && (/\bmatching\b/.test(text) || /\bset\b/.test(text)))
  ) return 'suit_cluster';

  // Athleisure cluster
  if (
    text.includes('tracksuit') ||
    text.includes('jogger set') ||
    text.includes('warm up') ||
    text.includes('warmup') ||
    (text.includes('track') && /\bpants\b/.test(text)) ||
    text.includes('hoodie set') ||
    text.includes('sweat set') ||
    text.includes('sweatsuit')
  ) return 'athleisure_cluster';

  // Outerwear cluster
  if (
    /\bcoat\b/.test(text) ||
    text.includes('overcoat') ||
    /\bparka\b/.test(text) ||
    /\bpuffer\b/.test(text) ||
    /\bjacket\b/.test(text)
  ) return 'outerwear_cluster';

  // Top cluster
  if (
    /\bshirt\b/.test(text) ||
    /\btee\b/.test(text) ||
    text.includes('t shirt') ||
    text.includes('tshirt') ||
    /\bpolo\b/.test(text) ||
    /\bsweater\b/.test(text) ||
    /\bjumper\b/.test(text)
  ) return 'top_cluster';

  // Bottom cluster
  if (
    /\bpants\b/.test(text) ||
    /\btrousers?\b/.test(text) ||
    /\bjeans\b/.test(text) ||
    /\bchinos?\b/.test(text)
  ) return 'bottom_cluster';

  // Accessory cluster
  if (
    /\btie\b/.test(text) ||
    /\bbelt\b/.test(text) ||
    /\bscarf\b/.test(text) ||
    /\bhat\b/.test(text)
  ) return 'accessory_cluster';

  return 'unknown_cluster';
}

/** Get cluster cap for a given relaxation level. Cluster caps partially relax (max +1). */
function getClusterCap(cluster: string, relaxation: number): number {
  const strict = CLUSTER_STRICT_CAPS[cluster] ?? CLUSTER_DEFAULT_CAP;
  return strict + Math.min(relaxation, 1);
}

// ==================== STYLE VOCABULARY INTELLIGENCE ====================
// Maps aesthetic concepts (user vocabulary) → retail descriptors (product vocabulary)
// Enables scoring when users say "tailored" but products say "slim fit"
// ── AESTHETIC descriptors (vibe/style words — NO fit/silhouette terms) ──
const AESTHETIC_DESCRIPTOR_MAP: Record<string, string[]> = {
  // Aesthetic Families
  relaxed: ['relaxed', 'comfort', 'flowy', 'easy fit', 'laid back'],
  minimalist: ['basic', 'clean', 'solid', 'plain', 'simple', 'essential', 'neutral'],
  classic: ['straight fit', 'oxford', 'double breasted', 'button down', 'traditional', 'heritage', 'timeless', 'polo'],
  modern: ['zip', 'zip up', 'puffer', 'bomber', 'tech', 'contemporary', 'sleek', 'asymmetric'],
  vintage: ['retro', 'washed', 'faded', 'distressed', 'throwback', 'heritage', 'classic', 'old school'],
  bohemian: ['boho', 'floral', 'embroidered', 'fringe', 'paisley', 'crochet', 'flowing', 'peasant'],
  preppy: ['polo', 'button down', 'plaid', 'argyle', 'cable knit', 'oxford', 'khaki', 'chino', 'stripe'],
  edgy: ['leather', 'moto', 'studded', 'distressed', 'ripped', 'chain', 'graphic', 'punk', 'zipper'],
  romantic: ['lace', 'ruffle', 'floral', 'sheer', 'satin', 'delicate', 'soft', 'drape', 'feminine'],

  // Performance & Sport
  athletic: ['performance', 'stretch', 'sport', 'flex', 'moisture wicking', 'active', 'training', 'running', 'gym'],
  sporty: ['athletic', 'jogger', 'track', 'sneaker', 'zip up', 'hoodie', 'sweatshirt', 'workout', 'active'],
  activewear: ['legging', 'sports bra', 'tank', 'performance', 'stretch', 'moisture', 'yoga', 'running'],

  // Luxury & Elevated
  luxury: ['silk', 'cashmere', 'wool', 'leather', 'suede', 'merino', 'linen', 'italian', 'premium'],
  elevated: ['embroidered', 'textured', 'chenille', 'blend', 'detailed', 'refined', 'quality', 'artisan'],
  sophisticated: ['structured', 'wool', 'silk', 'elegant', 'polished', 'refined', 'classic'],
  elegant: ['silk', 'satin', 'chiffon', 'drape', 'maxi', 'midi', 'formal', 'evening', 'gown'],

  // Street & Casual
  streetwear: ['graphic', 'hoodie', 'jogger', 'cargo', 'sneaker', 'logo', 'urban', 'crew neck'],
  casual: ['tee', 't shirt', 'jeans', 'sneaker', 'hoodie', 'sweatshirt', 'everyday', 'basic'],
  urban: ['cargo', 'utility', 'bomber', 'sneaker', 'graphic', 'jogger', 'street'],

  // Texture & Material
  rugged: ['denim', 'canvas', 'leather', 'flannel', 'corduroy', 'work', 'utility', 'heavy duty', 'boot'],
  cozy: ['fleece', 'sherpa', 'knit', 'sweater', 'cardigan', 'wool', 'soft', 'plush', 'warm'],
  lightweight: ['linen', 'cotton', 'breathable', 'thin', 'sheer', 'mesh', 'light', 'airy'],

  // Pattern & Detail
  bold: ['print', 'pattern', 'graphic', 'bright', 'colorful', 'statement', 'vibrant', 'neon'],
  neutral: ['black', 'white', 'grey', 'gray', 'beige', 'navy', 'cream', 'khaki', 'earth tone'],
  patterned: ['stripe', 'plaid', 'check', 'floral', 'paisley', 'polka dot', 'geometric', 'print'],

  // Season & Occasion
  summer: ['linen', 'cotton', 'shorts', 'tank', 'sandal', 'light', 'breathable', 'floral'],
  winter: ['wool', 'fleece', 'puffer', 'down', 'thermal', 'insulated', 'heavy', 'coat', 'boot'],
  business: ['dress shirt', 'blazer', 'trouser', 'oxford', 'loafer', 'formal', 'professional', 'suit'],
  'smart casual': ['chino', 'polo', 'loafer', 'blazer', 'button down', 'knit', 'leather'],
};

// ── FIT descriptors (silhouette/cut terms only) ──
const FIT_DESCRIPTOR_MAP: Record<string, string[]> = {
  tailored: ['slim', 'slim fit', 'structured', 'pleated', 'tapered', 'fitted', 'darted', 'shaped'],
  fitted: ['slim fit', 'skinny', 'bodycon', 'form fitting', 'stretch', 'tapered', 'tight'],
  oversized: ['oversized', 'boxy', 'relaxed fit', 'wide', 'loose fit', 'dropped shoulder', 'baggy'],
  loose: ['loose', 'wide leg', 'baggy', 'oversized', 'boxy', 'dropped shoulder'],
};

// Combined map for backward-compatible expandStyleTokens (aesthetic + fit)
const STYLE_DESCRIPTOR_MAP: Record<string, string[]> = {
  ...AESTHETIC_DESCRIPTOR_MAP,
  ...FIT_DESCRIPTOR_MAP,
};

/** Expand style keywords using STYLE_DESCRIPTOR_MAP */
function expandStyleTokens(styleKeywords: string[]): Set<string> {
  const expanded = new Set<string>();
  for (const keyword of styleKeywords) {
    const norm = normalize(keyword);
    if (!norm) continue;
    // Always include the original keyword
    expanded.add(norm);
    // Check each map entry for matches
    for (const [concept, descriptors] of Object.entries(STYLE_DESCRIPTOR_MAP)) {
      if (norm === concept || norm.includes(concept) || concept.includes(norm)) {
        for (const desc of descriptors) {
          expanded.add(normalize(desc));
        }
      }
    }
  }
  return expanded;
}

// ==================== COLOR VOCABULARY (for auto-inference) ====================
const COLOR_VOCAB: string[] = [
  'black', 'white', 'navy', 'blue', 'red', 'green', 'gray', 'grey',
  'brown', 'beige', 'tan', 'cream', 'burgundy', 'olive',
  'charcoal', 'ivory', 'coral', 'sage', 'rust', 'mustard', 'camel', 'plum',
  'teal', 'blush', 'wine', 'mauve', 'mint', 'rose', 'khaki', 'taupe',
  'indigo', 'lavender', 'copper', 'gold', 'silver',
];

/** Maps expanded fashion color tokens to canonical color buckets */
const FASHION_COLOR_NORMALIZE: Record<string, string> = {
  charcoal: 'gray',
  ivory: 'beige',
  sage: 'green',
  rust: 'brown',
  mustard: 'beige',
  camel: 'beige',
  plum: 'burgundy',
  teal: 'blue',
  blush: 'beige',
  wine: 'burgundy',
  mauve: 'burgundy',
  mint: 'green',
  rose: 'red',
  khaki: 'beige',
  taupe: 'beige',
  indigo: 'navy',
  lavender: 'blue',
  copper: 'brown',
  gold: 'beige',
  silver: 'gray',
};

// Canonical color buckets for thumbnail-based enrichment
const CANONICAL_COLORS = [
  'black', 'white', 'gray', 'navy', 'blue', 'brown', 'beige', 'red', 'burgundy', 'green',
] as const;

/** Category adjacency map — normalized keys and values */
const CATEGORY_ADJACENCY: Record<string, string[]> = {
  outerwear: ['tops'],
  tops: ['outerwear', 'activewear'],
  bottoms: ['activewear'],
  shoes: ['accessories'],
  accessories: ['shoes', 'jewelry', 'bags'],
  dresses: ['tops', 'bottoms'],
  activewear: ['tops', 'bottoms', 'shoes'],
  bags: ['accessories'],
  jewelry: ['accessories'],
  swimwear: ['activewear'],
};

/** Category → style bridge: infers style affinity from product category keywords */
const CATEGORY_STYLE_BRIDGE: Record<string, string[]> = {
  blazer: ['formal', 'business casual', 'luxury', 'classic'],
  suit: ['formal', 'luxury', 'elegant'],
  loafer: ['classic', 'preppy', 'business casual'],
  hoodie: ['sporty', 'casual'],
  jogger: ['sporty', 'casual'],
  bomber: ['trendy', 'sporty'],
  overshirt: ['casual', 'classic'],
  'dress shirt': ['formal', 'business casual'],
  trouser: ['formal', 'classic'],
  cardigan: ['classic', 'cozy', 'casual'],
  sneaker: ['sporty', 'casual', 'streetwear'],
  boot: ['rugged', 'classic', 'edgy'],
  polo: ['preppy', 'classic', 'smart casual'],
  chino: ['smart casual', 'preppy', 'classic'],
  puffer: ['sporty', 'modern', 'casual'],
  denim: ['casual', 'rugged', 'streetwear'],
  sandal: ['casual', 'summer', 'relaxed'],
  oxford: ['classic', 'formal', 'preppy'],
};

/** Body-type → category multiplier for gap bonus (0.8–1.2 range) */
const BODY_TYPE_CATEGORY_BOOST: Record<string, Record<string, number>> = {
  inverted_triangle: { bottoms: 1.2, tops: 0.9, shoes: 1.1 },
  pear:              { tops: 1.2, bottoms: 0.9, accessories: 1.1 },
  apple:             { tops: 0.9, dresses: 1.2, outerwear: 1.1 },
  hourglass:         { dresses: 1.2, tops: 1.1, bottoms: 1.0 },
  rectangle:         { outerwear: 1.2, dresses: 1.1, accessories: 1.1 },
  petite:            { shoes: 1.1, tops: 1.1 },
  athletic:          { activewear: 1.2, tops: 1.1, bottoms: 0.9 },
};

// Fit tokens that signal loose/oversized silhouette
const LOOSE_FIT_TOKENS = new Set([
  'oversized', 'boxy', 'baggy', 'wide', 'loose fit', 'dropped shoulder',
  'relaxed', 'relaxed fit', 'wide leg', 'wide fit',
]);

/** Build normalized veto sets from profile constraints */
function buildVetoCtx(profile: UserProfile) {
  return {
    avoidColorsSet: tokenSet(profile.avoid_colors),
    avoidMaterialsSet: tokenSet(profile.avoid_materials),
    avoidPatternsSet: tokenSet(profile.avoid_patterns),
    dislikedStylesSet: tokenSet(profile.disliked_styles),
  };
}

/** Compute a stable fingerprint of profile fields that affect recommendations */
function computeProfileFingerprint(profile: UserProfile): string {
  const key = JSON.stringify({
    brands: profile.preferred_brands.slice().sort(),
    styles: profile.style_keywords.slice().sort(),
    colors: profile.color_preferences.slice().sort(),
    disliked: profile.disliked_styles.slice().sort(),
    fit: profile.fit_preferences.slice().sort(),
    avoidColors: profile.avoid_colors.slice().sort(),
    avoidMaterials: profile.avoid_materials.slice().sort(),
    avoidPatterns: profile.avoid_patterns.slice().sort(),
    bodyType: profile.body_type,
    silhouette: profile.silhouette_preference,
    formality: profile.formality_floor,
  });
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/** Jaccard similarity of two token sets (0..1) */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) { if (b.has(t)) inter++; }
  return inter / (a.size + b.size - inter);
}

/** Infer color key from product title using COLOR_VOCAB with word-boundary matching */
function inferColorFromTitle(title: string): string {
  const normTitle = normalize(title);
  for (const c of COLOR_VOCAB) {
    if (wordBoundaryMatch(normTitle, c)) {
      const base = c === 'grey' ? 'gray' : c;
      return FASHION_COLOR_NORMALIZE[base] ?? base;
    }
  }
  return '';
}

/**
 * Coherence validator: forward-only admission gating.
 * Input MUST be pre-sorted by score desc. Output preserves that order.
 * Hard filters (dupes, fit) reject permanently. Caps (brand, color, semantic cluster)
 * gate admission with staged relaxation to guarantee TARGET_PRODUCTS when supply allows.
 */
function validateSetCoherence(
  products: DiscoverProduct[],
  profile: UserProfile,
): DiscoverProduct[] {
  const TARGET = TARGET_PRODUCTS;
  const MAX_PER_BRAND = 2;
  const MAX_PER_COLOR = 3;
  const RELAXED_BRAND = 3;
  const RELAXED_COLOR = 4;

  // --- Phase 0: Hard-reject dupes & fit conflicts (permanent removal) ---
  const seenSigs = new Map<string, Set<string>>();
  const userWantsSlim = profile.fit_preferences.some(f => {
    const n = normalize(f);
    return n === 'slim' || n === 'tailored' || n === 'fitted';
  });
  let looseFitCount = 0;
  const LOOSE_FIT_CAP = userWantsSlim ? 0 : 3;

  const eligible: DiscoverProduct[] = [];

  for (const p of products) {
    const cat = p.category || inferMainCategory(p.title) || '__unknown__';
    const titleTokens = new Set(normalize(p.title).split(' ').filter(Boolean));

    // Near-duplicate check: same category + Jaccard >= 0.6
    const existingSigs = seenSigs.get(cat);
    if (existingSigs) {
      let isDupe = false;
      for (const existing of existingSigs) {
        const existingSet = new Set(existing.split(' '));
        if (jaccard(titleTokens, existingSet) >= 0.6) { isDupe = true; break; }
      }
      if (isDupe) continue;
    }

    // Fit coherence: cap loose/oversized items when user prefers slim
    const normTitle = normalize(p.title);
    const isLooseFit = [...LOOSE_FIT_TOKENS].some(t => normTitle.includes(t));
    if (isLooseFit) {
      if (looseFitCount >= LOOSE_FIT_CAP) continue;
      looseFitCount++;
    }

    eligible.push(p);
    if (!seenSigs.has(cat)) seenSigs.set(cat, new Set());
    seenSigs.get(cat)!.add([...titleTokens].join(' '));
  }

  // Pre-compute cluster keys for all eligible products (deterministic, pure)
  const eligibleClusters: string[] = eligible.map(p =>
    getSemanticCluster(p.title, p.category),
  );

  // --- Phase 1: Strict admission (brand ≤ 2, color ≤ 3, cluster ≤ strict cap) ---
  const admitted: DiscoverProduct[] = [];
  const admittedSet = new Set<number>(); // indices into eligible
  const brandCounts: Record<string, number> = {};
  const colorCounts: Record<string, number> = {};
  const clusterCounts: Record<string, number> = {};

  for (let i = 0; i < eligible.length; i++) {
    if (admitted.length >= TARGET) break;
    const p = eligible[i];
    const brandKey = normalize(p.source || p.brand || '');
    const colorKey = normalizeColorKey(p.enriched_color) || inferColorFromTitle(p.title);
    const cluster = eligibleClusters[i];

    if (brandKey && (brandCounts[brandKey] ?? 0) >= MAX_PER_BRAND) continue;
    if (colorKey && (colorCounts[colorKey] ?? 0) >= MAX_PER_COLOR) continue;
    if ((clusterCounts[cluster] ?? 0) >= getClusterCap(cluster, 0)) continue;

    admitted.push(p);
    admittedSet.add(i);
    if (brandKey) brandCounts[brandKey] = (brandCounts[brandKey] ?? 0) + 1;
    if (colorKey) colorCounts[colorKey] = (colorCounts[colorKey] ?? 0) + 1;
    clusterCounts[cluster] = (clusterCounts[cluster] ?? 0) + 1;
  }

  // --- Phase 2: Relax brand cap (≤ 3), color stays strict (≤ 3), cluster +1 ---
  if (admitted.length < TARGET) {
    for (let i = 0; i < eligible.length; i++) {
      if (admitted.length >= TARGET) break;
      if (admittedSet.has(i)) continue;
      const p = eligible[i];
      const brandKey = normalize(p.source || p.brand || '');
      const colorKey = normalizeColorKey(p.enriched_color) || inferColorFromTitle(p.title);
      const cluster = eligibleClusters[i];

      if (brandKey && (brandCounts[brandKey] ?? 0) >= RELAXED_BRAND) continue;
      if (colorKey && (colorCounts[colorKey] ?? 0) >= MAX_PER_COLOR) continue;
      if ((clusterCounts[cluster] ?? 0) >= getClusterCap(cluster, 1)) continue;

      admitted.push(p);
      admittedSet.add(i);
      if (brandKey) brandCounts[brandKey] = (brandCounts[brandKey] ?? 0) + 1;
      if (colorKey) colorCounts[colorKey] = (colorCounts[colorKey] ?? 0) + 1;
      clusterCounts[cluster] = (clusterCounts[cluster] ?? 0) + 1;
    }
  }

  // --- Phase 3: Relax color cap (≤ 4), brand stays relaxed (≤ 3), cluster +2 ---
  if (admitted.length < TARGET) {
    for (let i = 0; i < eligible.length; i++) {
      if (admitted.length >= TARGET) break;
      if (admittedSet.has(i)) continue;
      const p = eligible[i];
      const brandKey = normalize(p.source || p.brand || '');
      const colorKey = normalizeColorKey(p.enriched_color) || inferColorFromTitle(p.title);
      const cluster = eligibleClusters[i];

      if (brandKey && (brandCounts[brandKey] ?? 0) >= RELAXED_BRAND) continue;
      if (colorKey && (colorCounts[colorKey] ?? 0) >= RELAXED_COLOR) continue;
      if ((clusterCounts[cluster] ?? 0) >= getClusterCap(cluster, 2)) continue;

      admitted.push(p);
      admittedSet.add(i);
      if (brandKey) brandCounts[brandKey] = (brandCounts[brandKey] ?? 0) + 1;
      if (colorKey) colorCounts[colorKey] = (colorCounts[colorKey] ?? 0) + 1;
      clusterCounts[cluster] = (clusterCounts[cluster] ?? 0) + 1;
    }
  }

  // --- Phase 4: Final fallback — drop brand/color caps, cluster caps stay (relaxation=1), quality floor ---
  const MIN_ACCEPTABLE_SCORE = 6;
  if (admitted.length < TARGET) {
    for (let i = 0; i < eligible.length; i++) {
      if (admitted.length >= TARGET) break;
      if (admittedSet.has(i)) continue;
      if ((eligible[i].score_total ?? 0) < MIN_ACCEPTABLE_SCORE) continue;
      const cluster = eligibleClusters[i];
      const clusterCap = getClusterCap(cluster, 1);
      if ((clusterCounts[cluster] ?? 0) >= clusterCap) continue;
      admitted.push(eligible[i]);
      admittedSet.add(i);
      clusterCounts[cluster] = (clusterCounts[cluster] ?? 0) + 1;
    }
  }

  // --- Single summary log ---
  // if (DEBUG_RECOMMENDED_BUYS) {
  //   console.log('COHERENCE_ADMISSION_COUNTS', {
  //     eligible: eligible.length,
  //     admitted: admitted.length,
  //     brandCounts,
  //     colorCounts,
  //     clusterCounts,
  //     qualityFloorApplied: MIN_ACCEPTABLE_SCORE,
  //   });
  // }

  return admitted;
}

@Injectable()
export class DiscoverService {
  private readonly log = new Logger(DiscoverService.name);
  private serpEmptyResultsCooldownUntil = 0;
  private static readonly EMPTY_RESULTS_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours

  constructor(
    private readonly learningEvents: LearningEventsService,
    private readonly fashionStateService: FashionStateService,
  ) {}

  private get serpApiKey(): string | undefined {
    return secretExists('SERPAPI_KEY') ? getSecret('SERPAPI_KEY') : undefined;
  }

  // ==================== MAIN ENTRY POINT ====================

  async getRecommended(userId: string, timezone = 'UTC'): Promise<DiscoverProduct[]> {
    // console.log('🔥🔥🔥 GET RECOMMENDED ENTERED 🔥🔥🔥');
    // console.log('DEBUG_RECOMMENDED_BUYS =', process.env.DEBUG_RECOMMENDED_BUYS);
    // this.log.log(`🛒 getRecommended called for userId: ${userId}`);

    const batchDate = computeUserBatchDate(timezone);

    // ALWAYS check cache first
    const cached = await this.getCachedProducts(userId, batchDate);
    const debugMode = process.env.DEBUG_RECOMMENDED_BUYS === 'true';
    const cacheValid = debugMode
      ? false
      : await this.isCacheValid(userId, batchDate);

    // this.log.log(`🛒 Cache status: valid=${cacheValid}, cached count=${cached.length}`);

    // console.log('🔥 Cache validity evaluated 🔥', { cacheValid, cachedCount: cached.length });

    // HARDLOCK: If cache is valid (within 24 hours) AND we have products, return them. NO API CALLS.
    // If cache is "valid" but empty, we should still try to fetch.
    if (cacheValid && cached.length > 0) {
      // console.log('🔥 Returning from CACHE PATH 🔥');
      this.emitRecommendedBuysServed(userId, cached);
      return cached;
    }

    // If cache is valid but empty, log this unusual state
    if (cacheValid && cached.length === 0) {
      this.log.warn(
        `🛒 Cache marked valid but contains 0 products for user ${userId} - will attempt fetch`,
      );
    }

    // In-memory cooldown: if SerpAPI recently returned nothing, don't hammer it
    if (Date.now() < this.serpEmptyResultsCooldownUntil) {
      this.log.warn(
        `SerpAPI cooldown active for ${userId} — skipping fetch`,
      );
      return cached;
    }

    // Cache expired or never set - ONE fetch attempt, then lock for 24 hours
    this.log.log(
      `Cache expired or empty for user ${userId} - fetching fresh products`,
    );

    let products: DiscoverProduct[] = [];

    try {
      products = await this.fetchPersonalizedProducts(userId);
    } catch (error: any) {
      this.log.error(`fetchPersonalizedProducts failed: ${error?.message}`);
    }

    // Only trigger fallback if candidate pool is completely empty
    if (products.length === 0) {
      console.log('🔥 No candidates available — invoking fallback 🔥');
      try {
        products = await this.getFallbackProducts(userId);
      } catch (fallbackError: any) {
        this.log.error(
          `getFallbackProducts also failed: ${fallbackError?.message}`,
        );
      }
    }

    // If all SerpAPI paths returned nothing, set cooldown and bail out
    if (products.length === 0) {
      this.serpEmptyResultsCooldownUntil =
        Date.now() + DiscoverService.EMPTY_RESULTS_COOLDOWN_MS;
      this.log.warn(
        `All SerpAPI queries returned 0 products for ${userId} — 2h cooldown set`,
      );
      return [];
    }

    await this.saveProducts(userId, products, batchDate);
    await this.updateRefreshTimestamp(userId);

    this.log.log(
      `Saved ${products.length} products for user ${userId} — cache locked until end of day (batch ${batchDate}, tz=${timezone})`,
    );

    // Re-read from cache so response always includes saved/disliked state from DB
    const hydrated = await this.getCachedProducts(userId, batchDate);
    const result = hydrated.length > 0 ? hydrated : products;
    this.emitRecommendedBuysServed(userId, result);
    return result;
  }

  /**
   * Emit a single RECOMMENDED_BUYS_SERVED event for the entire batch.
   * Fire-and-forget: failures are swallowed so the response is never blocked.
   */
  private emitRecommendedBuysServed(
    userId: string,
    products: DiscoverProduct[],
  ): void {
    if (!LEARNING_FLAGS.EVENTS_ENABLED || products.length === 0) return;

    const productIds = products.map(p => p.product_id).filter(Boolean);
    const brands = [...new Set(products.map(p => p.brand).filter(Boolean))] as string[];
    const categories = [...new Set(products.map(p => p.category).filter(Boolean))] as string[];

    this.learningEvents
      .logEvent({
        userId,
        eventType: 'RECOMMENDED_BUYS_SERVED',
        entityType: 'product',
        entityId: undefined,
        signalPolarity: 0,
        signalWeight: 0.1,
        extractedFeatures: {
          item_ids: productIds,
          brands,
          categories,
        },
        sourceFeature: 'recommended_buys',
        clientEventId: `rec_buys_served:${userId}:${createHash('sha256').update(productIds.join(',')).digest('hex').slice(0, 16)}`,
      })
      .catch(() => {});
  }

  private derivePriceTier(price: number | null): string | null {
    if (price == null) return null;
    if (price < 30) return 'budget';
    if (price < 100) return 'mid';
    if (price < 300) return 'premium';
    return 'luxury';
  }

  private async extractProductFeatures(
    userId: string,
    productId: string,
  ): Promise<{ features: import('../learning/dto/learning-event.dto').ExtractedFeatures; found: boolean }> {
    try {
      const result = await pool.query(
        `SELECT brand, category, enriched_color, price
         FROM user_discover_products
         WHERE user_id = $1 AND product_id = $2
         LIMIT 1`,
        [userId, productId],
      );
      if (result.rowCount === 0) return { features: {}, found: false };
      const row = result.rows[0];
      const tags: string[] = [];
      const tier = this.derivePriceTier(row.price);
      if (tier) tags.push(`priceTier:${tier}`);
      return {
        found: true,
        features: {
          brands: row.brand ? [row.brand] : [],
          categories: row.category ? [row.category] : [],
          colors: row.enriched_color ? [row.enriched_color] : [],
          tags,
        },
      };
    } catch {
      return { features: {}, found: false };
    }
  }

  emitProductClick(userId: string, productId: string): void {
    if (!LEARNING_FLAGS.EVENTS_ENABLED) return;
    this.extractProductFeatures(userId, productId).then(({ features }) => {
      this.learningEvents
        .logEvent({
          userId,
          eventType: 'PRODUCT_CLICK',
          entityType: 'product',
          entityId: productId,
          signalPolarity: 1,
          signalWeight: 0.35,
          extractedFeatures: features,
          sourceFeature: 'shopping',
          clientEventId: `product_click:${userId}:${productId}:${Date.now()}`,
        })
        .catch(() => {});
    }).catch(() => {});
  }

  async emitItemDismissed(userId: string, productId: string): Promise<void> {
    // Persist disliked state for UI hydration on reload
    await pool.query(
      `UPDATE user_discover_products SET disliked = TRUE WHERE user_id = $1 AND product_id = $2`,
      [userId, productId],
    ).catch(err => this.log.error('[DISCOVER] disliked persist failed', err));

    if (!LEARNING_FLAGS.EVENTS_ENABLED) return;
    try {
      const { features } = await this.extractProductFeatures(userId, productId);
      await this.learningEvents.logEvent({
        userId,
        eventType: 'ITEM_EXPLICITLY_DISMISSED',
        entityType: 'product',
        entityId: productId,
        signalPolarity: -1,
        signalWeight: 0.4,
        extractedFeatures: features,
        sourceFeature: 'shopping',
        clientEventId: `item_dismissed:${userId}:${productId}:${Date.now()}`,
      });
      this.fashionStateService
        .computeAndSaveState(userId)
        .catch(err => this.log.error('[LEARNING INLINE] recompute failed', err));
    } catch (err) {
      this.log.error('[LEARNING] item dismissed event failed', err);
    }
  }

  async undoItemDismissed(userId: string, productId: string): Promise<void> {
    await pool.query(
      `UPDATE user_discover_products SET disliked = FALSE WHERE user_id = $1 AND product_id = $2`,
      [userId, productId],
    ).catch(err => this.log.error('[DISCOVER] undo disliked failed', err));
  }

  // Returns true if today's snapshot exists (calendar-day lock — no mid-day invalidation)
  // batchDate is computed per-user timezone via computeUserBatchDate()
  private async isCacheValid(userId: string, batchDate: string): Promise<boolean> {
    try {
      const result = await pool.query(
        `SELECT 1 FROM user_discover_products
         WHERE user_id = $1 AND is_current = TRUE AND batch_date = $2::date
         LIMIT 1`,
        [userId, batchDate],
      );
      return result.rows.length > 0;
    } catch {
      return false;
    }
  }

  // ==================== GET CACHED PRODUCTS ====================

  private async getCachedProducts(userId: string, batchDate?: string): Promise<DiscoverProduct[]> {
    try {
      // If no batchDate provided (called outside getRecommended), fall back to UTC today
      const effectiveDate = batchDate || new Date().toISOString().slice(0, 10);
      // Join with saved_recommendations to get actual saved status
      const result = await pool.query(
        `SELECT
           udp.id, udp.product_id, udp.title, udp.brand, udp.price, udp.price_raw,
           udp.image_url, udp.link, udp.source, udp.category, udp.position,
           (sr.id IS NOT NULL) as saved,
           sr.saved_at,
           udp.batch_date, udp.is_current, udp.enriched_color,
           COALESCE(udp.disliked, FALSE) as disliked
         FROM user_discover_products udp
         LEFT JOIN saved_recommendations sr
           ON sr.user_id = udp.user_id AND sr.product_id = udp.product_id
         WHERE udp.user_id = $1 AND udp.is_current = TRUE
           AND udp.batch_date = $3::date
         ORDER BY udp.position ASC, udp.product_id ASC
         LIMIT $2`,
        [userId, TARGET_PRODUCTS, effectiveDate],
      );
      // this.log.log(`🛒 getCachedProducts query returned ${result.rows.length} rows`);
      // if (result.rows.length > 0) {
      //   this.log.log(`🛒 First cached product: ${JSON.stringify(result.rows[0])}`);
      // }
      return result.rows;
    } catch (error) {
      // this.log.error(`🛒 getCachedProducts failed: ${error?.message}`);
      // Table might not exist yet - return empty
      return [];
    }
  }

  // ==================== FETCH PERSONALIZED PRODUCTS ====================

  private async fetchPersonalizedProducts(
    userId: string,
  ): Promise<DiscoverProduct[]> {
    // console.log('🔥 ENTERED fetchPersonalizedProducts 🔥');
    this.log.log(`fetchPersonalizedProducts starting for ${userId}`);

    let profile: UserProfile;
    let browserSignals: BrowserSignals;
    let learnedPrefs: LearnedPreferences;
    let ownedCategories: Map<string, number>;
    let shownProductIds: string[];
    let fsSummary: FashionStateSummary | null = null;
    let rawFashionState: UserFashionState | null = null;

    try {
      // Gather all personalization signals (fashion state is non-blocking)
      [
        profile,
        browserSignals,
        learnedPrefs,
        ownedCategories,
        shownProductIds,
        fsSummary,
        rawFashionState,
      ] = await Promise.all([
        this.getUserProfile(userId),
        this.getBrowserSignals(userId),
        this.getLearnedPreferences(userId),
        this.getOwnedCategories(userId),
        this.getShownProductIds(userId),
        this.fashionStateService.getStateSummary(userId).catch(() => null),
        this.fashionStateService.getState(userId).catch(() => null),
      ]);
    } catch (err) {
      this.log.error(`Failed to gather profile data: ${err}`);
      throw err;
    }

    this.log.log(
      `Profile for ${userId}: gender=${profile.gender}, brands=${profile.preferred_brands.length}, keywords=${profile.style_keywords.length}`,
    );

    // Must have gender - hard requirement
    if (!profile.gender) {
      this.log.warn(`User ${userId} has no gender set, returning empty for fallback`);
      console.log('🔥 RETURNING FROM fetchPersonalizedProducts (no gender → empty) 🔥');
      return [];
    }

    // Build search queries based on profile
    const queries = this.buildSearchQueries(
      profile,
      browserSignals,
      learnedPrefs,
      ownedCategories,
    );

    // --- Stage 1: Candidate Generation ---
    // Collect a large pool (up to 75) to enable scoring and diversity filtering
    const CANDIDATE_POOL_SIZE = 75;
    const allProducts: any[] = [];
    const usedProductIds = new Set(shownProductIds);

    for (const query of queries) {
      if (allProducts.length >= CANDIDATE_POOL_SIZE) break;

      try {
        const products = await this.searchSerpApi(query, profile.gender);

        for (const p of products) {
          if (allProducts.length >= CANDIDATE_POOL_SIZE) break;

          const productId = this.getProductId(p);
          if (usedProductIds.has(productId)) continue;
          if (this.matchesDisliked(p, profile.disliked_styles)) continue;

          usedProductIds.add(productId);
          allProducts.push(p);
        }
      } catch (error) {
        this.log.warn(`Query failed: ${query} - ${error}`);
      }
    }

    // Broaden search if candidate pool is thin
    if (allProducts.length < CANDIDATE_POOL_SIZE) {
      const broadQuery = `${profile.gender === 'male' ? "men's" : "women's"} fashion clothing`;
      try {
        const products = await this.searchSerpApi(broadQuery, profile.gender);
        for (const p of products) {
          if (allProducts.length >= CANDIDATE_POOL_SIZE) break;
          const productId = this.getProductId(p);
          if (usedProductIds.has(productId)) continue;
          usedProductIds.add(productId);
          allProducts.push(p);
        }
      } catch (error) {
        this.log.warn(`Broad query failed: ${error}`);
      }
    }

    if (DEBUG_RECOMMENDED_BUYS) {
      this.log.debug(`[Discover] Candidate pool size: ${allProducts.length}`);
    }

    // If candidate pool is empty, return [] and let getRecommended() handle fallback
    if (allProducts.length === 0) {
      console.log('🔥 RETURNING FROM fetchPersonalizedProducts (empty candidate pool) 🔥');
      return [];
    }

    // --- Stage 1b: Color Enrichment from thumbnails (with source tracking) ---
    const ENRICHMENT_CONCURRENCY = 5;
    for (let i = 0; i < allProducts.length; i += ENRICHMENT_CONCURRENCY) {
      const batch = allProducts.slice(i, i + ENRICHMENT_CONCURRENCY);
      const colors = await Promise.all(
        batch.map((p: any) =>
          p.enriched_color
            ? Promise.resolve(p.enriched_color as string)
            : this.inferDominantColorFromImage(p.thumbnail),
        ),
      );
      for (let j = 0; j < batch.length; j++) {
        if (batch[j].enriched_color) {
          batch[j].enriched_color_source = 'cached';
        } else {
          batch[j].enriched_color = colors[j];
          batch[j].enriched_color_source = colors[j] ? 'ml' : null;
        }
      }
    }

    // --- Gray-fallback: when enriched_color is gray or empty, try title inference ---
    for (const p of allProducts) {
      const ec = normalize(p.enriched_color || '');
      if (!ec || ec === 'gray' || ec === 'grey') {
        const titleColor = inferColorFromTitle(p.title);
        if (titleColor) {
          p.enriched_color = titleColor;
          p.enriched_color_source = 'fallback';
        }
      }
    }

    // if (DEBUG_RECOMMENDED_BUYS) {
    //   console.log('COLOR ENRICHMENT DEBUG:');
    //   allProducts.slice(0, 5).forEach((p: any) => {
    //     console.log({
    //       title: p.title,
    //       thumbnail: p.thumbnail,
    //       enriched_color: p.enriched_color,
    //     });
    //   });
    // }

    // console.log('🔥 ENTERING SCORING BLOCK 🔥', { candidateCount: allProducts.length });

    // --- Stage 1c: Hard Veto Filter (Tier 4 — uses discover-veto.ts) ---
    const vetoCtx = buildVetoCtx(profile);

    const vetoProfile: VetoProfile = {
      avoidColors: vetoCtx.avoidColorsSet,
      avoidMaterials: vetoCtx.avoidMaterialsSet,
      avoidPatterns: vetoCtx.avoidPatternsSet,
      dislikedStyles: vetoCtx.dislikedStylesSet,
      fitPreferences: profile.fit_preferences,
      coverageNoGo: profile.coverage_no_go,
      walkabilityRequirement: profile.walkability_requirement,
      formalityFloor: profile.formality_floor,
      climate: profile.climate,
    };

    const vetoStats = { nonApparel: 0, avoidColor: 0, avoidMaterial: 0, avoidPattern: 0, disliked: 0, fitVeto: 0, coverage: 0, walkability: 0, formality: 0, climate: 0, materialMix: 0 };
    const vetoPassed: any[] = [];

    for (const raw of allProducts) {
      const textParts: string[] = [
        raw.title, raw.snippet, raw.source, raw.description,
        ...(Array.isArray(raw.extensions) ? raw.extensions.map(String) : []),
      ].filter(Boolean);
      const blob = normalize(textParts.join(' '));
      const enrichedColor = raw.enriched_color ? normalize(raw.enriched_color) : '';

      const vetoResult: VetoResult = applyDiscoverVeto(
        { title: raw.title || '', blob, enrichedColor, price: raw.extracted_price ?? null, brand: raw.source ?? null },
        vetoProfile,
      );

      if (vetoResult.vetoed) {
        const ruleKey = (vetoResult.rule || '').replace('VETO_', '').toLowerCase();
        const statMap: Record<string, keyof typeof vetoStats> = {
          non_apparel: 'nonApparel',
          color: 'avoidColor', material: 'avoidMaterial', pattern: 'avoidPattern',
          disliked: 'disliked', fit: 'fitVeto', coverage: 'coverage',
          walkability: 'walkability', formality: 'formality', climate: 'climate',
          material_mix: 'materialMix',
        };
        const statKey = statMap[ruleKey];
        if (statKey) vetoStats[statKey]++;
        continue;
      }

      vetoPassed.push(raw);
    }

    // if (DEBUG_RECOMMENDED_BUYS) {
    //   console.log('🚫 VETO FILTER RESULTS', {
    //     before: allProducts.length,
    //     after: vetoPassed.length,
    //     dropped: vetoStats,
    //   });
    // }

    // --- Stage 2: Scoring ---
    // Transform raw products, then score each against profile signals
    const transformed = vetoPassed.map((p, i) =>
      this.transformProduct(p, i + 1),
    );

    const lowOwnedCategories = [...ownedCategories.entries()]
      .filter(([, count]) => count < 3)
      .map(([cat]) => cat);

    const wardrobeStats = { lowOwnedCategories };
    const behavior = { recentBrands: browserSignals.brands };

    // if (DEBUG_RECOMMENDED_BUYS) {
    //   console.log('🧥 LOW OWNED CATEGORIES', wardrobeStats.lowOwnedCategories);
    // }

    // --- Auto-infer color defaults from candidate pool when profile lacks them ---
    // if (DEBUG_RECOMMENDED_BUYS) {
    //   console.log('🔬 RAW color_preferences FROM DB', {
    //     raw: profile.color_preferences,
    //     type: typeof profile.color_preferences,
    //     length: profile.color_preferences?.length,
    //   });
    // }
    let effectiveFavoriteColors = profile.color_preferences.filter(c => {
      const n = normalize(c);
      return n.length > 0 && n !== 'null' && n !== 'undefined' && n !== 'none';
    });
    const hasUsableColors = effectiveFavoriteColors.length > 0;
    // if (DEBUG_RECOMMENDED_BUYS) {
    //   console.log('🔬 COLOR FILTER RESULT', {
    //     effectiveFavoriteColors,
    //     hasUsableColors,
    //     inferenceWillRun: !hasUsableColors,
    //   });
    // }
    if (!hasUsableColors) {
      const colorFreq = new Map<string, number>();
      for (const raw of allProducts) {
        const parts: (string | null | undefined)[] = [
          raw?.title, raw?.color, raw?.variantColor, raw?.snippet, raw?.description,
        ];
        if (raw?.extensions?.color) parts.push(raw.extensions.color);
        if (Array.isArray(raw?.extensions)) parts.push(...raw.extensions.map(String));
        const blob = normalize(parts.filter(Boolean).join(' '));
        for (const color of COLOR_VOCAB) {
          if (blob.includes(color)) {
            colorFreq.set(color, (colorFreq.get(color) || 0) + 1);
          }
        }
      }
      effectiveFavoriteColors = [...colorFreq.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([c]) => c);

      if (DEBUG_RECOMMENDED_BUYS) {
        console.log('🎨 INFERRED COLOR DEFAULTS', {
          inferredColors: effectiveFavoriteColors,
          source: 'candidate-frequency',
        });
      }
    }

    // --- Curator profile (Tier 4) ---
    const curatorProfile: CuratorProfile = {
      styleKeywords: profile.style_keywords,
      formalityFloor: profile.formality_floor,
      silhouettePreference: profile.silhouette_preference,
      climate: profile.climate,
      colorPreferences: effectiveFavoriteColors,
      fitPreferences: profile.fit_preferences,
    };

    // Pre-compute normalized profile sets for overlap scoring
    const profileColors = tokenSet(effectiveFavoriteColors);
    const expandedStyles = expandStyleTokens(profile.style_keywords);
    const literalStyleSet = tokenSet(profile.style_keywords);
    const fitTokens = tokenSet(profile.fit_preferences);
    const negativeTokens = tokenSet(learnedPrefs.negative_features);

    // if (DEBUG_RECOMMENDED_BUYS) {
    //   console.log('🎨 STYLE VOCABULARY EXPANSION', {
    //     rawKeywords: profile.style_keywords,
    //     expandedCount: expandedStyles.size,
    //     expandedTokens: [...expandedStyles],
    //   });
    // }

    // Build brand frequency map for saturation penalty
    const brandFreqMap = new Map<string, number>();
    for (const p of transformed) {
      const b = normalize(p.brand);
      if (b) brandFreqMap.set(b, (brandFreqMap.get(b) || 0) + 1);
    }
    const totalCandidates = transformed.length;

    // --- Pre-compute scoring helpers ---
    // Median price (p50) for elevation boost
    const candidatePricesForP50 = transformed
      .map(p => p.price)
      .filter((v): v is number => typeof v === 'number' && v > 0)
      .sort((a, b) => a - b);
    const p50Price = candidatePricesForP50.length > 0
      ? candidatePricesForP50[Math.floor(candidatePricesForP50.length / 2)]
      : 0;

    // Prestige descriptors for elevation boost
    const PRESTIGE_DESCRIPTORS = [
      'silk', 'cashmere', 'wool', 'leather', 'suede', 'merino', 'linen', 'italian',
      'premium', 'embroidered', 'textured', 'chenille', 'refined', 'quality', 'artisan',
    ];

    // Basic item regex for dampener (applied to normalized text)
    const BASIC_ITEM_RE = /\b(basic|regular fit tshirt|crew neck|crewneck|plain tee|solid tee)\b/;

    // --- LEARNING: build normalized brand weight map from raw fashion state ---
    const LEARNING_MULTIPLIER = 2;
    const normalizedBrandState = Object.entries(rawFashionState?.brandScores || {})
      .reduce((acc, [brand, weight]) => {
        acc[normalize(brand)] = weight as number;
        return acc;
      }, {} as Record<string, number>);

    const scored = transformed.map((p, idx) => {
      const breakdown = {
        brand: 0,
        color: 0,
        style: 0,
        gap: 0,
        behavior: 0,
        fit: 0,
        negativePenalty: 0,
        bodyMult: 1,
        penalty: 0,
        elevation: 0,
        styleDepth: 0,
        basicDamp: 0,
        authority: 0,
      };

      const normBrand = normalize(p.brand);

      // Brand match — 0 or 1 (normalized substring)
      const brandMatch01 = (normBrand && profile.preferred_brands?.some((b) => normBrand.includes(normalize(b)))) ? 1 : 0;

      // Brand tier: prestige-aware multiplier (only when brand matches)
      const brandNorm = (p.brand || '').toLowerCase().replace(/[^a-z\s]/g, '').trim();
      const brandBase = 7 * brandMatch01;
      let brandContribution = brandBase;
      if (brandMatch01 === 1) {
        const tierMult = BRAND_TIER_MAP[brandNorm] ?? 1.0;
        brandContribution = brandBase * tierMult;
      }
      brandContribution = Math.min(brandContribution, 10);

      // Behavior brand match — 0 or 1 (normalized substring)
      const behavior01 = (normBrand && behavior.recentBrands?.some((b) => normBrand.includes(normalize(b)))) ? 1 : 0;

      // --- Infer category early (used by style blob + gap) ---
      const inferredCategory = p.category || inferMainCategory(p.title);

      // --- STYLE UPGRADE: text blob from all available product fields ---
      const raw = vetoPassed[idx];

      // STEP 1 — Forensic: dump first raw product object
      // if (idx === 0 && process.env.DEBUG_RECOMMENDED_BUYS === 'true') {
      //   console.log('🔬 RAW PRODUCT OBJECT [0]');
      //   console.dir(raw, { depth: 5 });
      //   console.log('🔬 PROFILE COLORS (effective)', [...profileColors]);
      // }

      const textParts: (string | null | undefined)[] = [
        p.title, p.brand, p.source, p.category, inferredCategory,
      ];
      if (raw?.snippet) textParts.push(raw.snippet);
      if (Array.isArray(raw?.extensions)) textParts.push(...raw.extensions.map(String));
      const productTextBlob = textParts.filter(Boolean).join(' ');
      const normProductText = normalize(productTextBlob);

      // --- STYLE MATCH: single source of truth for scoring, debug, and match_reasons ---
      const styleMatch = (() => {
        const STYLE_MATCH_CAP = 3;
        let hits = 0;
        const literalTokens: string[] = [];
        const expandedTokens: string[] = [];
        for (const token of expandedStyles) {
          if (normProductText.includes(token)) {
            hits++;
            if (literalStyleSet.has(token)) {
              literalTokens.push(token);
            } else {
              expandedTokens.push(token);
            }
          }
        }
        let score01 = expandedStyles.size > 0
          ? clamp01(hits / STYLE_MATCH_CAP)
          : 0;

        // Category → style bridge: boost when product category implies user's style
        let bridgeApplied = false;
        if (score01 < 1.0) {
          for (const [categoryKeyword, impliedStyles] of Object.entries(CATEGORY_STYLE_BRIDGE)) {
            if (normProductText.includes(categoryKeyword)) {
              const userStylesNorm = profile.style_keywords.map(k => normalize(k));
              if (impliedStyles.some(s => userStylesNorm.includes(normalize(s)))) {
                score01 = clamp01(score01 + 0.4);
                bridgeApplied = true;
                break;
              }
            }
          }
        }

        return { hits, score01, literalTokens, expandedTokens, bridgeApplied };
      })();

      // if (DEBUG_RECOMMENDED_BUYS && idx < 5) {
      //   console.log('STYLE DEBUG', {
      //     title: p.title,
      //     matches: styleMatch.hits,
      //     categoryBridge: styleMatch.bridgeApplied,
      //     cappedStyle01: +styleMatch.score01.toFixed(4),
      //     weightedStyleContribution: +(16 * styleMatch.score01).toFixed(2),
      //     literalTokens: styleMatch.literalTokens,
      //     expandedTokens: styleMatch.expandedTokens,
      //   });
      // }

      // --- COLOR UPGRADE: enriched color (thumbnail) → structured fields → title fallback ---
      const COLOR_MATCH_CAP = 2;
      let colorHits = 0;
      const matchedColors: string[] = [];

      // Prefer enriched color from thumbnail analysis
      const enrichedColor = p.enriched_color;
      if (enrichedColor) {
        for (const colorToken of profileColors) {
          if (enrichedColor === colorToken) {
            colorHits++;
            matchedColors.push(colorToken + '(enriched)');
          }
        }
      }

      // Fallback to text-based color detection if enriched color didn't match
      if (colorHits === 0) {
        const colorParts: (string | null | undefined)[] = [p.title];
        if (raw?.color) colorParts.push(raw.color);
        if (raw?.extensions?.color) colorParts.push(raw.extensions.color);
        if (raw?.variantColor) colorParts.push(raw.variantColor);
        if (raw?.snippet) colorParts.push(raw.snippet);
        if (raw?.description) colorParts.push(raw.description);
        if (Array.isArray(raw?.extensions)) colorParts.push(...raw.extensions.map(String));
        const productColorBlob = colorParts.filter(Boolean).join(' ');
        const normColorBlob = normalize(productColorBlob);
        for (const colorToken of profileColors) {
          if (normColorBlob.includes(colorToken)) {
            colorHits++;
            matchedColors.push(colorToken);
          }
        }
      }

      const color01 = profileColors.size > 0
        ? clamp01(colorHits / COLOR_MATCH_CAP)
        : 0;

      // if (DEBUG_RECOMMENDED_BUYS && idx < 5) {
      //   console.log('🎨 COLOR DEBUG', {
      //     title: p.title,
      //     matchedColors,
      //     color01: +color01.toFixed(4),
      //     weightedColorContribution: +(10 * color01).toFixed(2),
      //   });
      // }

      // --- GAP UPGRADE: soft-scaled wardrobe gap intelligence ---
      let gapBonus = 0;
      if (inferredCategory) {
        const normInferred = normalize(inferredCategory);
        let catCount = 0;
        for (const [cat, count] of ownedCategories.entries()) {
          if (normalize(cat) === normInferred) { catCount = count; break; }
        }
        if (catCount === 0) gapBonus = 18;
        else if (catCount === 1) gapBonus = 12;
        else if (catCount === 2) gapBonus = 6;
        // 3+ → gapBonus stays 0
      }

      // --- FIT PREFERENCE SIGNAL ---
      const fit01 = overlap01(fitTokens, normProductText);

      // --- LEARNED NEGATIVE PREFERENCES PENALTY ---
      const negOverlap = overlap01(negativeTokens, normProductText);
      const negativePenalty = negOverlap > 0 ? 4 : 0;

      // --- SILHOUETTE / BODY-TYPE BIAS (multiplier on gap bonus only) ---
      let bodyMultiplier = 1.0;
      if (profile.body_type && inferredCategory) {
        const normBodyType = normalize(profile.body_type).replace(/\s+/g, '_');
        const boostMap = BODY_TYPE_CATEGORY_BOOST[normBodyType];
        if (boostMap) {
          const normCatKey = normalize(inferredCategory);
          const mult = boostMap[normCatKey];
          if (typeof mult === 'number') {
            bodyMultiplier = Math.max(0.8, Math.min(1.2, mult));
          }
        }
      }
      let adjustedGapBonus = gapBonus * bodyMultiplier;

      // --- GAP CLAMP: gap must never dominate style contribution ---
      const styleContribution = 16 * styleMatch.score01;
      if (styleContribution > 0 && adjustedGapBonus > styleContribution * 1.2) {
        adjustedGapBonus = styleContribution * 1.2;
      }

      // --- ELEVATION SIGNAL: reward elevated pieces with prestige materials ---
      let elevation01 = 0;
      if (typeof p.price === 'number' && p.price > p50Price && styleMatch.hits > 0) {
        let prestigeHits = 0;
        for (const d of PRESTIGE_DESCRIPTORS) {
          if (normProductText.includes(d)) prestigeHits++;
        }
        elevation01 = clamp01(prestigeHits / 2);
      }

      // --- BASIC ITEM DAMPENER: slight suppression of ultra-generic SKUs ---
      const basicDampener = BASIC_ITEM_RE.test(normProductText) ? -2 : 0;

      // --- CASUAL INFLATION DAMPENER: soft penalty for generic casual basics in default mode ---
      // Prevents mall-tier hoodies/graphic tees from outranking elevated pieces when no formality floor is set.
      const CASUAL_INFLATION_TOKENS = ['hoodie', 'sweatshirt', 'graphic tee', 'livedin tee', 'lightweight tee', 'icon tee', 'logo tee'];
      const productCluster = getSemanticCluster(p.title, p.category);
      const productBrandTier = resolveBrandTier(p.brand);
      const casualInflationPenalty =
        !profile.formality_floor &&
        productCluster === 'top_cluster' &&
        productBrandTier >= 4 &&
        CASUAL_INFLATION_TOKENS.some(token => normProductText.includes(token))
          ? -2
          : 0;

      // --- STYLE DEPTH SIGNAL: reward products matching multiple user style keywords ---
      let styleKeywordsMatched = 0;
      for (const keyword of profile.style_keywords) {
        const normKw = normalize(keyword);
        if (!normKw) continue;
        const descriptors = STYLE_DESCRIPTOR_MAP[normKw];
        const tokensToCheck = descriptors ? [normKw, ...descriptors.map(d => normalize(d))] : [normKw];
        if (tokensToCheck.some(t => normProductText.includes(t))) styleKeywordsMatched++;
      }
      const styleDepth01 = clamp01(styleKeywordsMatched / 3);

      // --- BRAND AUTHORITY: quality intelligence (independent of user preference) ---
      const brandAuthority = getBrandAuthorityScore(p.brand);

      // Brand saturation penalty — only when brand matches
      let penalty = 0;
      if (brandMatch01 === 1 && normBrand) {
        const brandCount = brandFreqMap.get(normBrand) || 0;
        const brandFreq01 = brandCount / totalCandidates;
        penalty = brandSatPenalty(brandFreq01);
      }

      // --- FASHION STATE AFFINITY BONUS (additive, bounded ±4, 0.7× no-double-count) ---
      let fashionStateBonus = 0;
      if (fsSummary && !fsSummary.isColdStart) {
        let rawFsBonus = 0;
        if (normBrand && fsSummary.topBrands.some(b => normalize(b) === normBrand)) rawFsBonus += 3;
        if (normBrand && fsSummary.avoidBrands.some(b => normalize(b) === normBrand)) rawFsBonus -= 3;
        const enrichedC = normalize(p.enriched_color || '');
        if (enrichedC && fsSummary.topColors.some(c => normalize(c) === enrichedC)) rawFsBonus += 2;
        if (enrichedC && fsSummary.avoidColors.some(c => normalize(c) === enrichedC)) rawFsBonus -= 2;
        if (fsSummary.topStyles && fsSummary.topStyles.some(s => normProductText.includes(normalize(s)))) rawFsBonus += 1;
        if (fsSummary.avoidStyles && fsSummary.avoidStyles.some(s => normProductText.includes(normalize(s)))) rawFsBonus -= 1;
        // 0.7 multiplier: legacy user_pref_feature already provides partial overlap
        fashionStateBonus = Math.max(-4, Math.min(4, +(rawFsBonus * 0.7).toFixed(2)));
      }

      // --- LEARNING SCORE: weight-based brand affinity from raw fashion state ---
      const normalizedProductBrand = normalize(p.brand);
      let brandLearningWeight = 0;
      for (const [key, weight] of Object.entries(normalizedBrandState)) {
        if (
          normalizedProductBrand.includes(key) ||
          key.includes(normalizedProductBrand)
        ) {
          brandLearningWeight = weight;
          break;
        }
      }
      const learningScore = brandLearningWeight * LEARNING_MULTIPLIER;

      // console.log('🧠 LEARNING DEBUG', {
      //   brand: p.brand,
      //   normalizedProductBrand,
      //   brandLearningWeight,
      //   learningScore,
      // });

      // Weighted score: brand(7, tier-adjusted, max 10) + behavior(3) + gap(clamped) + style(16) + color(10)
      //   + fit(4) + elevation(5) + styleDepth(3) + authority(-2..+3) - negativePenalty(4) - brandSatPenalty + basicDamp(-2) + casualInflation(-2) + fashionState(±4) + learning
      const score =
        brandContribution +
        (3  * behavior01) +
        adjustedGapBonus +
        (16 * styleMatch.score01) +
        (10 * color01) +
        (4  * fit01) +
        (5  * elevation01) +
        (3  * styleDepth01) +
        brandAuthority -
        penalty -
        negativePenalty +
        basicDampener +
        casualInflationPenalty +
        fashionStateBonus;

      breakdown.brand = +brandContribution.toFixed(2);
      breakdown.behavior = +(3 * behavior01).toFixed(2);
      breakdown.gap = +adjustedGapBonus.toFixed(2);
      breakdown.style = +(16 * styleMatch.score01).toFixed(2);
      breakdown.color = +(10 * color01).toFixed(2);
      breakdown.fit = +(4 * fit01).toFixed(2);
      breakdown.negativePenalty = negativePenalty;
      breakdown.bodyMult = +bodyMultiplier.toFixed(2);
      breakdown.penalty = +penalty.toFixed(2);
      breakdown.elevation = +(5 * elevation01).toFixed(2);
      breakdown.styleDepth = +(3 * styleDepth01).toFixed(2);
      breakdown.basicDamp = basicDampener;
      breakdown.authority = brandAuthority;
      (breakdown as any).casualInflationPenalty = casualInflationPenalty;
      (breakdown as any).fashionState = fashionStateBonus;

      // --- CURATOR SIGNALS (Tier 4) ---
      const curatorResult: CuratorResult = computeCuratorSignals(
        {
          title: p.title,
          blob: normProductText,
          enrichedColor: normalize(p.enriched_color || ''),
          price: p.price,
          brand: p.brand,
          inferredCategory,
          existingScore: score,
          existingBreakdown: breakdown,
          brandTier: productBrandTier,
        },
        curatorProfile,
      );

      const curatorWeighted = +(curatorResult.curatorTotal * 1.5).toFixed(2);
      const finalScore = score + curatorWeighted + learningScore;

      // Add curator signals to breakdown
      (breakdown as any).curatorFormality = curatorResult.formalityCoherence;
      (breakdown as any).curatorColor = curatorResult.colorHarmony;
      (breakdown as any).curatorOccasion = curatorResult.occasionBonus;
      (breakdown as any).curatorSilhouette = curatorResult.silhouetteDepth;
      (breakdown as any).curatorMaterial = curatorResult.materialElevation;
      (breakdown as any).curatorBrand = curatorResult.brandElevation;
      (breakdown as any).curatorTotal = curatorResult.curatorTotal;
      (breakdown as any).curatorWeighted = curatorWeighted;
      (breakdown as any).confidence = curatorResult.confidenceScore;
      (breakdown as any).learningScore = learningScore;
      (breakdown as any).baseScore = +score.toFixed(2);
      (breakdown as any).brandTier = productBrandTier;
      (breakdown as any).curatorDebugTags = [
        ...curatorResult.debugTags,
        ...(casualInflationPenalty < 0 ? ['casualInflationPenalty:-2'] : []),
      ];

      // if (DEBUG_RECOMMENDED_BUYS) {
      //   console.log('🎨 CURATOR DEBUG', {
      //     title: p.title,
      //     ...curatorResult,
      //   });
      // }

      // --- EXPLANATION LAYER: build match reasons (literal tokens only) ---
      const reasons: string[] = [];
      if (brandContribution > 0) reasons.push(`Matches preferred brand: ${p.brand}`);
      if (color01 > 0 && matchedColors.length > 0) reasons.push(`Aligns with color palette: ${matchedColors.join(', ')}`);
      if (styleMatch.literalTokens.length > 0) {
        reasons.push(`Style match: ${styleMatch.literalTokens.slice(0, 3).join(', ')}`);
      }
      if (styleMatch.expandedTokens.length > 0 && styleMatch.bridgeApplied) {
        reasons.push(`Style affinity (expanded): ${styleMatch.expandedTokens.slice(0, 2).join(', ')}`);
      }
      if (adjustedGapBonus > 0) reasons.push(`Fills wardrobe gap: ${inferredCategory}`);
      if (curatorResult.silhouetteDepth < 0) reasons.push('Fit conflict: silhouette mismatch');
      if (curatorResult.formalityCoherence > 0) reasons.push('Formality aligned');
      if (curatorResult.materialElevation > 0) reasons.push('Premium materials detected');
      if (curatorResult.colorHarmony > 0) reasons.push('Color harmony bonus');
      if (elevation01 > 0) reasons.push('Elevated piece: premium materials');
      if (fashionStateBonus > 0) reasons.push('Learned preference match');
      if (fashionStateBonus < 0) reasons.push('Learned preference conflict');
      if (reasons.length === 0) reasons.push('General style match');

      if (DEBUG_RECOMMENDED_BUYS) {
        this.log.debug(
          `[Discover][Score] ${JSON.stringify({ title: p.title, brand: p.brand, price: p.price, totalScore: +finalScore.toFixed(2), breakdown })}`,
        );
      }

      return { product: { ...p, score_total: +finalScore.toFixed(2), score_breakdown: breakdown, match_reasons: reasons }, score: finalScore, breakdown, idx };
    });

    scored.sort((a, b) => b.score - a.score || a.idx - b.idx);

    // --- Redundancy Penalty (pre-diversity): -2 for second item sharing brand+category+style token ---
    const seenBrandCatStyle = new Set<string>();
    for (const item of scored) {
      const nb = normalize(item.product.brand);
      const ic = item.product.category || inferMainCategory(item.product.title);
      const nc = normalize(ic);
      if (!nb || !nc) continue;
      const normTitle = normalize(item.product.title);
      for (const kw of profile.style_keywords) {
        const normKw = normalize(kw);
        if (!normKw) continue;
        const descriptors = STYLE_DESCRIPTOR_MAP[normKw];
        const tokens = descriptors ? [normKw, ...descriptors.map(d => normalize(d))] : [normKw];
        if (tokens.some(t => normTitle.includes(t))) {
          const key = `${nb}|${nc}|${normKw}`;
          if (seenBrandCatStyle.has(key)) {
            item.score -= 2;
          } else {
            seenBrandCatStyle.add(key);
          }
          break;
        }
      }
    }
    scored.sort((a, b) => b.score - a.score || a.idx - b.idx);

    // --- Soft Cluster Diversity Penalty: -2 for excess items beyond first 2 in any cluster > 60% of top window ---
    const CLUSTER_WINDOW = Math.min(scored.length, 20);
    if (CLUSTER_WINDOW > 0) {
      const windowClusters: string[] = [];
      for (let i = 0; i < CLUSTER_WINDOW; i++) {
        const p = scored[i].product;
        windowClusters.push(getSemanticCluster(p.title, p.category));
      }
      const clusterFreq: Record<string, number> = {};
      for (const c of windowClusters) {
        clusterFreq[c] = (clusterFreq[c] ?? 0) + 1;
      }
      // Find clusters exceeding 60% of window
      const threshold = CLUSTER_WINDOW * 0.6;
      const overRepresented = new Set<string>();
      for (const [cluster, count] of Object.entries(clusterFreq)) {
        if (count > threshold) overRepresented.add(cluster);
      }
      if (overRepresented.size > 0) {
        const clusterSeen: Record<string, number> = {};
        for (let i = 0; i < CLUSTER_WINDOW; i++) {
          const cluster = windowClusters[i];
          if (!overRepresented.has(cluster)) continue;
          clusterSeen[cluster] = (clusterSeen[cluster] ?? 0) + 1;
          if (clusterSeen[cluster] > 2) {
            scored[i].score -= 2;
          }
        }
        scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
      }
    }

    // if (DEBUG_RECOMMENDED_BUYS) {
    //   const scores = scored.map(s => s.score);
    //   const max = Math.max(...scores);
    //   const min = Math.min(...scores);
    //   const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    //
    //   console.log('📊 SCORE SUMMARY', {
    //     candidateCount: scored.length,
    //     max,
    //     min,
    //     avg,
    //   });
    //
    //   console.log('🏆 TOP 15 BEFORE DIVERSITY');
    //   scored.slice(0, 15).forEach((s, i) => {
    //     console.log(`#${i + 1}`, {
    //       title: s.product.title,
    //       brand: s.product.brand,
    //       finalScore: +s.score.toFixed(2),
    //       baseScore: (s.breakdown as any).baseScore,
    //       curatorTotal: (s.breakdown as any).curatorTotal,
    //       curatorWeighted: (s.breakdown as any).curatorWeighted,
    //       learningScore: (s.breakdown as any).learningScore,
    //       confidence: (s.breakdown as any).confidence,
    //       brandTier: (s.breakdown as any).brandTier,
    //       debugTags: (s.breakdown as any).curatorDebugTags,
    //     });
    //   });
    // }

    const rankedProducts = scored.map((s) => s.product);

    // --- Stage 3: Diversity Mix ---
    // Cap per-brand and per-category to ensure variety in final set
    const diversified: DiscoverProduct[] = [];
    const brandCount = new Map<string, number>();
    const categoryCount = new Map<string, number>();

    for (const p of rankedProducts) {
      const brand = p.brand || '__unknown__';
      const bc = brandCount.get(brand) || 0;

      if (bc >= 3) continue; // Max 3 per brand

      // Only enforce category cap when category is known
      if (p.category) {
        const cc = categoryCount.get(p.category) || 0;
        if (cc >= 4) continue; // Max 4 per category
      }

      diversified.push(p);
      brandCount.set(brand, bc + 1);
      if (p.category) {
        categoryCount.set(p.category, (categoryCount.get(p.category) || 0) + 1);
      }
    }

    // if (DEBUG_RECOMMENDED_BUYS) {
    //   console.log('🧩 AFTER DIVERSITY', {
    //     remaining: diversified.length,
    //   });
    // }

    // --- Stage 4: Coherence Validator ---
    const coherent = validateSetCoherence(diversified, profile);

    // if (DEBUG_RECOMMENDED_BUYS) {
    //   console.log('🧪 AFTER COHERENCE', {
    //     beforeCoherence: diversified.length,
    //     afterCoherence: coherent.length,
    //   });
    // }

    // --- Stage 5: Shared Brain Gate ---
    // Invoke shared Tier 4 modules (styleVeto, tasteValidator, stylistQualityGate)
    // on each candidate. Filter out rejects, preserve rank order.
    const brainProfile: BrainGateProfile = {
      gender: profile.gender,
      climate: profile.climate,
      fit_preferences: profile.fit_preferences,
      style_preferences: profile.style_preferences,
      disliked_styles: profile.disliked_styles,
      avoid_colors: profile.avoid_colors,
      avoid_materials: profile.avoid_materials,
      avoid_patterns: profile.avoid_patterns,
      coverage_no_go: profile.coverage_no_go,
      walkability_requirement: profile.walkability_requirement,
      silhouette_preference: profile.silhouette_preference,
      formality_floor: profile.formality_floor,
    };

    const testBrainGate = (product: DiscoverProduct) =>
      runDiscoverSharedBrainGate({
        userId,
        profile: brainProfile,
        candidateProduct: {
          product_id: product.product_id,
          title: product.title,
          brand: product.brand,
          price: product.price,
          category: product.category,
          enriched_color: product.enriched_color ?? null,
        },
      });

    const brainGated: DiscoverProduct[] = [];
    const testedIds = new Set<string>();
    const brainFailReasons = new Map<string, number>();

    // First pass: gate coherent set (already in rank order)
    for (const product of coherent) {
      testedIds.add(product.product_id);
      const result = testBrainGate(product);
      if (result.pass) {
        brainGated.push(product);
      } else {
        for (const r of result.reasons) {
          brainFailReasons.set(r, (brainFailReasons.get(r) || 0) + 1);
        }
      }
    }

    // Fill pass: if below target, pull from diversified (rank order) for items
    // not in coherent. Iterate deterministically in score-descending order.
    let fillCount = 0;
    if (brainGated.length < TARGET_PRODUCTS) {
      for (const product of diversified) {
        if (brainGated.length >= TARGET_PRODUCTS) break;
        if (testedIds.has(product.product_id)) continue;
        testedIds.add(product.product_id);
        const result = testBrainGate(product);
        if (result.pass) {
          brainGated.push(product);
          fillCount++;
        } else {
          for (const r of result.reasons) {
            brainFailReasons.set(r, (brainFailReasons.get(r) || 0) + 1);
          }
        }
      }
    }

    // if (DEBUG_RECOMMENDED_BUYS) {
    //   const topReasons = [...brainFailReasons.entries()]
    //     .sort((a, b) => b[1] - a[1])
    //     .slice(0, 5);
    //   console.log('🧠 SHARED BRAIN GATE', {
    //     beforeCount: coherent.length,
    //     afterCount: brainGated.length,
    //     topFailReasons: topReasons,
    //     fillsFromBelowCutLine: fillCount,
    //   });
    // }

    // Final slice to target count, re-assign positions
    const finalProducts = brainGated
      .slice(0, TARGET_PRODUCTS)
      .map((p, i) => ({ ...p, position: i + 1 }));

    // if (DEBUG_RECOMMENDED_BUYS) {
    //   console.log('✅ FINAL SELECTED');
    //   finalProducts.forEach((p, i) => {
    //     console.log(`#${i + 1}`, {
    //       title: p.title,
    //       brand: p.brand,
    //       score_total: p.score_total,
    //       baseScore: (p.score_breakdown as any)?.baseScore,
    //       brandTier: (p.score_breakdown as any)?.brandTier,
    //       match_reasons: p.match_reasons,
    //     });
    //   });
    // }

    // Track shown products (P0-A: save/timestamp handled ONLY by getRecommended caller)
    await this.trackShownProducts(
      userId,
      finalProducts.map((p) => p.product_id),
    );

    // console.log('🔥 FINAL PRODUCTS COUNT 🔥', finalProducts.length);
    return finalProducts;
  }

  // ==================== USER PROFILE ====================

  private async getUserProfile(userId: string): Promise<UserProfile> {
    const result = await pool.query(
      `SELECT
        u.gender_presentation,
        sp.preferred_brands,
        sp.color_preferences,
        sp.disliked_styles,
        sp.style_preferences,
        sp.fit_preferences,
        sp.body_type,
        sp.climate,
        sp.avoid_colors,
        sp.avoid_materials,
        sp.avoid_patterns,
        sp.coverage_no_go,
        sp.walkability_requirement,
        sp.silhouette_preference,
        sp.formality_floor
       FROM users u
       LEFT JOIN style_profiles sp ON sp.user_id = u.id
       WHERE u.id = $1`,
      [userId],
    );

    if (result.rowCount === 0) {
      return {
        gender: null,
        preferred_brands: [],
        style_keywords: [],
        color_preferences: [],
        disliked_styles: [],
        style_preferences: [],
        fit_preferences: [],
        body_type: null,
        climate: null,
        avoid_colors: [],
        avoid_materials: [],
        avoid_patterns: [],
        coverage_no_go: [],
        walkability_requirement: null,
        silhouette_preference: null,
        formality_floor: null,
      };
    }

    const row = result.rows[0];
    return {
      gender: this.normalizeGender(row.gender_presentation),
      preferred_brands: this.ensureArray(row.preferred_brands),
      style_keywords: this.ensureArray(row.style_preferences),
      color_preferences: this.ensureArray(row.color_preferences),
      disliked_styles: this.ensureArray(row.disliked_styles),
      style_preferences: this.ensureArray(row.style_preferences),
      fit_preferences: this.ensureArray(row.fit_preferences),
      body_type: row.body_type,
      climate: row.climate,
      avoid_colors: this.ensureArray(row.avoid_colors),
      avoid_materials: this.ensureArray(row.avoid_materials),
      avoid_patterns: this.ensureArray(row.avoid_patterns),
      coverage_no_go: this.ensureArray(row.coverage_no_go),
      walkability_requirement: row.walkability_requirement || null,
      silhouette_preference: row.silhouette_preference || null,
      formality_floor: row.formality_floor || null,
    };
  }

  private normalizeGender(gender: string | null): string | null {
    if (!gender) return null;
    const g = gender.toLowerCase().trim();
    if (g.includes('male') || g.includes('man') || g.includes('men'))
      return 'male';
    if (g.includes('female') || g.includes('woman') || g.includes('women'))
      return 'female';
    return null;
  }

  // ==================== BROWSER SIGNALS ====================

  private async getBrowserSignals(userId: string): Promise<BrowserSignals> {
    const result = await pool.query(
      `SELECT brand, category, colors_viewed
       FROM browser_bookmarks
       WHERE user_id = $1
       ORDER BY view_count DESC, updated_at DESC
       LIMIT 50`,
      [userId],
    );

    const brands = new Set<string>();
    const categories = new Set<string>();
    const colors = new Set<string>();

    for (const row of result.rows) {
      if (row.brand) brands.add(row.brand);
      if (row.category) categories.add(row.category);
      if (Array.isArray(row.colors_viewed)) {
        row.colors_viewed.forEach((c: string) => colors.add(c));
      }
    }

    return {
      brands: Array.from(brands).slice(0, 5),
      categories: Array.from(categories).slice(0, 5),
      colors: Array.from(colors).slice(0, 5),
    };
  }

  // ==================== LEARNED PREFERENCES ====================

  private async getLearnedPreferences(
    userId: string,
  ): Promise<LearnedPreferences> {
    const result = await pool.query(
      `SELECT feature, score
       FROM user_pref_feature
       WHERE user_id = $1
       ORDER BY ABS(score) DESC
       LIMIT 20`,
      [userId],
    );

    const positive: string[] = [];
    const negative: string[] = [];

    for (const row of result.rows) {
      const feature = row.feature.replace(/^(color|brand|category|style):/, '');
      if (row.score > 0) {
        positive.push(feature);
      } else if (row.score < -2) {
        negative.push(feature);
      }
    }

    return {
      positive_features: positive.slice(0, 10),
      negative_features: negative.slice(0, 10),
    };
  }

  // ==================== OWNED CATEGORIES ====================

  private async getOwnedCategories(
    userId: string,
  ): Promise<Map<string, number>> {
    const result = await pool.query(
      `SELECT main_category, COUNT(*)::int as count
       FROM wardrobe_items
       WHERE user_id = $1 AND deleted_at IS NULL
       GROUP BY main_category`,
      [userId],
    );

    const map = new Map<string, number>();
    for (const row of result.rows) {
      map.set(row.main_category, row.count);
    }
    return map;
  }

  // ==================== SHOWN PRODUCT TRACKING ====================

  private async getShownProductIds(userId: string): Promise<string[]> {
    try {
      const result = await pool.query(
        `SELECT product_id FROM user_discover_history WHERE user_id = $1`,
        [userId],
      );
      return result.rows.map((r: { product_id: string }) => r.product_id);
    } catch (error) {
      this.log.error(`getShownProductIds failed: ${error?.message}`);
      return [];
    }
  }

  private async trackShownProducts(
    userId: string,
    productIds: string[],
  ): Promise<void> {
    if (productIds.length === 0) return;

    try {
      const values = productIds.map((_, i) => `($1, $${i + 2})`).join(', ');
      const params = [userId, ...productIds];

      await pool.query(
        `INSERT INTO user_discover_history (user_id, product_id)
         VALUES ${values}
         ON CONFLICT (user_id, product_id) DO UPDATE SET shown_at = now()`,
        params,
      );
    } catch (error) {
      this.log.error(`trackShownProducts failed: ${error?.message}`);
      // Non-critical - don't throw
    }
  }

  // ==================== BUILD SEARCH QUERIES ====================

  private buildSearchQueries(
    profile: UserProfile,
    browserSignals: BrowserSignals,
    learnedPrefs: LearnedPreferences,
    ownedCategories: Map<string, number>,
  ): string[] {
    const genderPrefix = profile.gender === 'male' ? "men's" : "women's";
    const queries: string[] = [];

    // Priority 1: Browser signals (real shopping intent)
    for (const brand of browserSignals.brands.slice(0, 2)) {
      queries.push(`${genderPrefix} ${brand} clothing`);
    }

    // Priority 2: Preferred brands + style keywords
    for (const brand of profile.preferred_brands.slice(0, 2)) {
      const style = profile.style_keywords[0] || '';
      queries.push(`${genderPrefix} ${brand} ${style}`.trim());
    }

    // Priority 3: Style keywords + favorite colors
    for (const style of profile.style_keywords.slice(0, 2)) {
      const color = profile.color_preferences[0] || '';
      queries.push(`${genderPrefix} ${style} ${color} clothing`.trim());
    }

    // Priority 4: Learned positive preferences
    for (const feature of learnedPrefs.positive_features.slice(0, 2)) {
      queries.push(`${genderPrefix} ${feature} fashion`);
    }

    // Priority 5: Categories they DON'T own much of (find gaps)
    const categoryPriority = [
      'Shoes',
      'Accessories',
      'Outerwear',
      'Tops',
      'Bottoms',
    ];
    for (const cat of categoryPriority) {
      const count = ownedCategories.get(cat) || 0;
      if (count < 3) {
        queries.push(`${genderPrefix} ${cat.toLowerCase()}`);
        break; // Just add one gap-filler
      }
    }

    // Priority 6: Favorite colors as fallback
    for (const color of profile.color_preferences.slice(0, 2)) {
      queries.push(`${genderPrefix} ${color} outfit`);
    }

    // Dedupe and limit
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const q of queries) {
      const normalized = q.toLowerCase().trim();
      if (!seen.has(normalized)) {
        seen.add(normalized);
        unique.push(q);
      }
    }

    return unique.slice(0, 8);
  }

  // ==================== SERPAPI SEARCH ====================

  private async searchSerpApi(query: string, _gender: string): Promise<any[]> {
    if (!this.serpApiKey) {
      throw new Error('SERPAPI_KEY not configured');
    }

    const url = `https://serpapi.com/search.json?engine=google_shopping&q=${encodeURIComponent(
      query,
    )}&hl=en&gl=us&api_key=${this.serpApiKey}`;

    this.log.debug(`SerpAPI query: ${query}`);

    const resp = await fetch(url);
    if (resp.status === 429) {
      this.serpEmptyResultsCooldownUntil =
        Date.now() + DiscoverService.EMPTY_RESULTS_COOLDOWN_MS;
      this.log.warn('SerpAPI 429 rate-limited — 2h cooldown set');
      throw new Error('SerpAPI rate-limited (429)');
    }
    if (!resp.ok) {
      throw new Error(`SerpAPI returned ${resp.status}`);
    }

    const data = await resp.json();
    if (data.error) {
      throw new Error(`SerpAPI error: ${data.error}`);
    }

    const results = data.shopping_results || [];

    // Filter for valid products with images and links
    // Note: SerpAPI uses product_link, not link
    return results.filter((p: any) => {
      if (!p.thumbnail) return false;
      if (!p.product_link) return false;
      if (!p.title) return false;
      return true;
    });
  }

  // ==================== HELPERS ====================

  private getProductId(product: any): string {
    return (
      product.product_id ||
      product.product_link ||
      `${product.title}-${product.price}`
    );
  }

  private matchesDisliked(product: any, dislikedStyles: string[]): boolean {
    if (dislikedStyles.length === 0) return false;
    const title = (product.title || '').toLowerCase();
    return dislikedStyles.some((style) => title.includes(style.toLowerCase()));
  }

  private transformProduct(raw: any, position: number): DiscoverProduct {
    return {
      id: '', // Will be set by DB
      product_id: this.getProductId(raw),
      title: raw.title || 'Untitled',
      brand: extractProductBrand(raw.title) || null, // productBrand from title, NEVER defaults to merchant
      price: this.toNumberOrNull(raw.extracted_price),
      price_raw: raw.price || null,
      image_url: raw.thumbnail || '',
      link: raw.product_link || '',
      source: raw.source || null, // merchant/retailer
      category: inferMainCategory(raw.title) || null,
      position,
      enriched_color: raw.enriched_color || null,
      enriched_color_source: raw.enriched_color_source || null,
    };
  }

  private async saveProducts(
    userId: string,
    products: DiscoverProduct[],
    batchDate: string,
  ): Promise<void> {
    try {
      // Mark old batch as not current (preserve history, especially saved items)
      await pool.query(
        `UPDATE user_discover_products
         SET is_current = FALSE
         WHERE user_id = $1 AND is_current = TRUE`,
        [userId],
      );

      // Ensure enriched_color column exists (idempotent)
      await pool.query(
        `ALTER TABLE user_discover_products ADD COLUMN IF NOT EXISTS enriched_color TEXT`,
      ).catch(() => {}); // Ignore if already exists or permissions issue

      // Insert new products as current batch using per-user batch date
      for (const p of products) {
        await pool.query(
          `INSERT INTO user_discover_products
           (user_id, product_id, title, brand, price, price_raw, image_url, link, source, category, position, batch_date, is_current, saved, enriched_color)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::date, TRUE, FALSE, $13)
           ON CONFLICT (user_id, product_id) DO UPDATE SET
             is_current = TRUE,
             position = EXCLUDED.position,
             batch_date = EXCLUDED.batch_date,
             enriched_color = EXCLUDED.enriched_color`,
          [
            userId,
            p.product_id,
            p.title,
            p.brand,
            p.price,
            p.price_raw,
            p.image_url,
            p.link,
            p.source,
            p.category,
            p.position,
            batchDate,
            p.enriched_color || null,
          ],
        );
      }
    } catch (error) {
      this.log.error(`saveProducts failed: ${error?.message}`);
      // Non-critical for returning products - don't throw
    }
  }

  private async updateRefreshTimestamp(userId: string): Promise<void> {
    try {
      await pool.query(
        'UPDATE users SET last_discover_refresh = now() WHERE id = $1',
        [userId],
      );
      // Store profile fingerprint for cache invalidation
      const profile = await this.getUserProfile(userId);
      const fp = computeProfileFingerprint(profile);
      await pool.query(
        `UPDATE style_profiles SET prefs_jsonb = COALESCE(prefs_jsonb, '{}'::jsonb) || $2::jsonb WHERE user_id = $1`,
        [userId, JSON.stringify({ discover_profile_fp: fp })],
      );
    } catch (error) {
      this.log.error(`updateRefreshTimestamp failed: ${error?.message}`);
      // Non-critical - don't throw
    }
  }

  // ==================== FALLBACK ====================

  private async getFallbackProducts(
    userId: string,
  ): Promise<DiscoverProduct[]> {
    console.log('🔥 ENTERED getFallbackProducts 🔥');
    this.log.log(`getFallbackProducts called for ${userId}`);

    const apiKey = this.serpApiKey;
    if (!apiKey) {
      this.log.error('SERPAPI_KEY not set');
      return [];
    }

    try {
      // Get user's gender for appropriate fallback query
      const userResult = await pool.query(
        'SELECT gender_presentation FROM users WHERE id = $1',
        [userId],
      );
      const gender = this.normalizeGender(
        userResult.rows[0]?.gender_presentation,
      );
      const genderPrefix = gender === 'male' ? "men's" : "women's";

      const query = `${genderPrefix} fashion clothing`;
      const url = `https://serpapi.com/search.json?engine=google_shopping&q=${encodeURIComponent(query)}&hl=en&gl=us&api_key=${apiKey}`;

      const resp = await fetch(url);
      if (!resp.ok) {
        this.log.error(`SerpAPI HTTP error: ${resp.status}`);
        return [];
      }

      const data = await resp.json();
      if (data.error) {
        this.log.error(`SerpAPI error for query "${query}": ${data.error}`);
        return [];
      }

      const results = data.shopping_results || [];
      if (results.length === 0) {
        this.log.warn('No shopping results from SerpAPI');
        return [];
      }

      // Filter and map to our format
      const products = results
        .filter((p: any) => p.thumbnail && p.product_link && p.title)
        .slice(0, 10)
        .map((p: any, i: number) => ({
          id: '',
          product_id: p.product_id || p.product_link,
          title: p.title,
          brand: p.source || null,
          price: this.toNumberOrNull(p.extracted_price),
          price_raw: p.price || null,
          image_url: p.thumbnail,
          link: p.product_link,
          source: p.source || null,
          category: null,
          position: i + 1,
        }));

      this.log.log(`Returning ${products.length} fallback products`);
      return products;
    } catch (error: any) {
      this.log.error(`getFallbackProducts error: ${error?.message}`);
      return [];
    }
  }

  // ==================== COLOR ENRICHMENT ====================

  /**
   * Infer dominant color from a product thumbnail URL.
   * Downscales to 8x8 via sharp, averages non-background pixels,
   * converts to HSL, maps to canonical color bucket.
   */
  private async inferDominantColorFromImage(url: string): Promise<string | null> {
    if (!url) return null;
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!resp.ok) return null;
      const buffer = Buffer.from(await resp.arrayBuffer());

      const sharpModule = await import('sharp');
      const sharpFn = sharpModule.default || sharpModule;

      const { data, info } = await (sharpFn as any)(buffer)
        .resize(8, 8, { fit: 'cover' })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      // Average pixels, skipping near-white (background)
      let rSum = 0, gSum = 0, bSum = 0, count = 0;
      for (let i = 0; i < data.length; i += 3) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        // Skip very light pixels (likely white background)
        if (r > 240 && g > 240 && b > 240) continue;
        rSum += r; gSum += g; bSum += b; count++;
      }

      // If all pixels were background, use overall average
      if (count === 0) {
        const pixelCount = info.width * info.height;
        for (let i = 0; i < data.length; i += 3) {
          rSum += data[i]; gSum += data[i + 1]; bSum += data[i + 2];
        }
        count = pixelCount;
      }

      return this.rgbToCanonicalColor(rSum / count, gSum / count, bSum / count);
    } catch {
      return null;
    }
  }

  /**
   * Map an RGB color to one of the canonical color buckets via HSL conversion.
   */
  private rgbToCanonicalColor(r: number, g: number, b: number): (typeof CANONICAL_COLORS)[number] {
    const r01 = r / 255;
    const g01 = g / 255;
    const b01 = b / 255;

    const max = Math.max(r01, g01, b01);
    const min = Math.min(r01, g01, b01);
    const l = (max + min) / 2;
    const d = max - min;

    let h = 0;
    let s = 0;

    if (d > 0) {
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r01) h = ((g01 - b01) / d + (g01 < b01 ? 6 : 0)) * 60;
      else if (max === g01) h = ((b01 - r01) / d + 2) * 60;
      else h = ((r01 - g01) / d + 4) * 60;
    }

    const H = h;
    const S = s * 100;
    const L = l * 100;

    // Achromatic
    if (L < 15) return 'black';
    if (L > 85 && S < 15) return 'white';
    if (S < 12) return 'gray';

    // Chromatic — map hue ranges to canonical buckets
    if ((H >= 0 && H < 15) || H >= 345) {
      return L < 35 ? 'burgundy' : 'red';
    }
    if (H >= 15 && H < 45) {
      if (S < 40 && L > 65) return 'beige';
      return 'brown';
    }
    if (H >= 45 && H < 70) return 'beige';
    if (H >= 70 && H < 165) return 'green';
    if (H >= 165 && H < 200) return 'blue';
    if (H >= 200 && H < 260) {
      return L < 30 ? 'navy' : 'blue';
    }
    if (H >= 260 && H < 290) return L < 35 ? 'navy' : 'blue';
    if (H >= 290 && H < 345) {
      return L < 35 ? 'burgundy' : 'red';
    }

    return 'gray';
  }

  // ==================== UTILITIES ====================

  private ensureArray(val: unknown): string[] {
    if (Array.isArray(val)) return val.filter(v => v != null).map(String).filter(Boolean);
    if (typeof val === 'string') {
      const s = val.trim();
      const inner = s.startsWith('{') && s.endsWith('}') ? s.slice(1, -1) : s;
      if (!inner) return [];
      return inner
        .split(',')
        .map((x) => x.trim().replace(/^"(.*)"$/, '$1'))
        .filter(Boolean);
    }
    return [];
  }

  private toNumberOrNull(v: unknown): number | null {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(String(v).replace(/[^\d.]/g, ''));
    return Number.isFinite(n) ? n : null;
  }

  // ==================== LEGACY (keep for backward compat) ====================

  async getInternalUserId(auth0Sub: string): Promise<string> {
    const res = await pool.query('SELECT id FROM users WHERE auth0_sub = $1', [
      auth0Sub,
    ]);
    if (res.rowCount === 0) throw new Error('User not found');
    return res.rows[0].id;
  }

  // ==================== SAVED RECOMMENDATIONS (PERMANENT) ====================
  // Uses the saved_recommendations table - products are COPIED here when saved
  // and DELETED when unsaved. This survives weekly discover refreshes.

  /**
   * Get all saved recommendations for a user (permanent history)
   */
  async getSavedProducts(userId: string): Promise<DiscoverProduct[]> {
    try {
      const result = await pool.query(
        `SELECT id, product_id, title, brand, price, price_raw, image_url, link, source, category,
                0 as position, TRUE as saved, saved_at
         FROM saved_recommendations
         WHERE user_id = $1
         ORDER BY saved_at DESC`,
        [userId],
      );
      return result.rows;
    } catch (error) {
      this.log.error(`getSavedProducts failed: ${error?.message}`);
      return [];
    }
  }

  /**
   * Save a product - COPIES it to the permanent saved_recommendations table
   */
  async saveProduct(
    userId: string,
    productId: string,
  ): Promise<{ success: boolean }> {
    try {
      // Get the product details from user_discover_products
      const productResult = await pool.query(
        `SELECT product_id, title, brand, price, price_raw, image_url, link, source, category
         FROM user_discover_products
         WHERE user_id = $1 AND product_id = $2`,
        [userId, productId],
      );

      if (productResult.rowCount === 0) {
        this.log.warn(
          `saveProduct: product not found in discover - userId=${userId}, productId=${productId}`,
        );
        return { success: false };
      }

      const product = productResult.rows[0];

      // Insert into permanent saved_recommendations table
      await pool.query(
        `INSERT INTO saved_recommendations
         (user_id, product_id, title, brand, price, price_raw, image_url, link, source, category, saved_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
         ON CONFLICT (user_id, product_id) DO UPDATE SET saved_at = NOW()`,
        [
          userId,
          product.product_id,
          product.title,
          product.brand,
          product.price,
          product.price_raw,
          product.image_url,
          product.link,
          product.source,
          product.category,
        ],
      );

      // Also mark in discover products for UI consistency
      await pool.query(
        `UPDATE user_discover_products
         SET saved = TRUE, saved_at = NOW()
         WHERE user_id = $1 AND product_id = $2`,
        [userId, productId],
      );

      // Emit PRODUCT_SAVED learning event (shadow mode - no behavior change)
      if (LEARNING_FLAGS.EVENTS_ENABLED) {
        this.learningEvents
          .logEvent({
            userId,
            eventType: 'PRODUCT_SAVED',
            entityType: 'product',
            entityId: productId,
            signalPolarity: 1,
            signalWeight: 0.6,
            extractedFeatures: {
              brands: product.brand ? [product.brand] : [],
              categories: product.category ? [product.category] : [],
            },
            sourceFeature: 'shopping',
            clientEventId: `product_saved:${userId}:${productId}:${randomUUID()}`,
          })
          .catch(() => {});
      }

      this.log.log(
        `Product saved permanently: userId=${userId}, productId=${productId}`,
      );
      return { success: true };
    } catch (error) {
      this.log.error(`saveProduct failed: ${error?.message}`);
      return { success: false };
    }
  }

  /**
   * Unsave a product - DELETES it from saved_recommendations (gone forever)
   */
  async unsaveProduct(
    userId: string,
    productId: string,
  ): Promise<{ success: boolean }> {
    try {
      // DELETE from permanent saved_recommendations table
      const result = await pool.query(
        `DELETE FROM saved_recommendations
         WHERE user_id = $1 AND product_id = $2
         RETURNING id`,
        [userId, productId],
      );

      // Also update discover products if it exists there
      await pool.query(
        `UPDATE user_discover_products
         SET saved = FALSE, saved_at = NULL
         WHERE user_id = $1 AND product_id = $2`,
        [userId, productId],
      );

      if (result.rowCount === 0) {
        this.log.warn(
          `unsaveProduct: product not found in saved_recommendations - userId=${userId}, productId=${productId}`,
        );
        return { success: false };
      }

      // Emit PRODUCT_UNSAVED learning event (shadow mode - no behavior change)
      if (LEARNING_FLAGS.EVENTS_ENABLED) {
        this.extractProductFeatures(userId, productId)
          .then(({ features }) => {
            this.learningEvents
              .logEvent({
                userId,
                eventType: 'PRODUCT_UNSAVED',
                entityType: 'product',
                entityId: productId,
                signalPolarity: -1,
                signalWeight: 0.2,
                extractedFeatures: features,
                sourceFeature: 'shopping',
                clientEventId: `product_unsaved:${userId}:${productId}:${randomUUID()}`,
              })
              .catch(() => {});
          })
          .catch(() => {});
      }

      this.log.log(
        `Product deleted from saved: userId=${userId}, productId=${productId}`,
      );
      return { success: true };
    } catch (error) {
      this.log.error(`unsaveProduct failed: ${error?.message}`);
      return { success: false };
    }
  }

  /**
   * Toggle saved state for a product
   */
  async toggleSaveProduct(
    userId: string,
    productId: string,
  ): Promise<{ success: boolean; saved: boolean }> {
    try {
      // Check if product is in saved_recommendations
      const current = await pool.query(
        `SELECT id FROM saved_recommendations WHERE user_id = $1 AND product_id = $2`,
        [userId, productId],
      );

      const isSaved = current.rowCount > 0;

      if (isSaved) {
        await this.unsaveProduct(userId, productId);
        return { success: true, saved: false };
      } else {
        await this.saveProduct(userId, productId);
        return { success: true, saved: true };
      }
    } catch (error) {
      this.log.error(`toggleSaveProduct failed: ${error?.message}`);
      return { success: false, saved: false };
    }
  }
}

// --- Test-only exports ---
export const __test__ = {
  normalize,
  wordBoundaryMatch,
  tokenSet,
  buildVetoCtx,
  LOOSE_FIT_TOKENS,
  extractBrandFromTitle,
  extractProductBrand,
  resolveBrandTier,
  getSemanticCluster,
};
