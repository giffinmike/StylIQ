import { Injectable, BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import OpenAI from 'openai';
import { ChatDto } from './dto/chat.dto';
import { VertexService } from '../vertex/vertex.service'; // 🔹 ADDED
import { ProductSearchService } from '../product-services/product-search.service';
import { Express } from 'express';
import { redis } from '../utils/redisClient';
import { pool } from '../db/pool';
import {
  scoreItemForWeather,
  type WeatherContext,
} from '../wardrobe/logic/weather';
import { isFeminineItem, inferImplicitPresentation } from '../wardrobe/logic/presentationFilter';
import { getSecret, secretExists } from '../config/secrets';
import { ELITE_FLAGS, isEliteDemoUser } from '../config/feature-flags';
import {
  elitePostProcessOutfits,
  normalizeStylistOutfit,
  denormalizeStylistOutfit,
  buildEliteExposureEvent,
} from './elite/eliteScoring';
import type { StyleContext } from './elite/eliteScoring';
import { loadStylistBrainContext, parseStyleProfileRow, resolvePresentation, STYLE_PROFILE_COLUMNS } from './elite/stylistBrain';
import {
  validateOutfits as tasteValidateOutfits,
  validateOutfit as tasteValidateOutfit,
  isOpenFootwear,
  tempToClimateZone,
  extractItemColors,
  expandAvoidColors,
  colorMatchesSafe,
  type ValidatorItem,
  type ValidatorContext,
} from './elite/tasteValidator';
import type { StylistBrainContext } from './elite/stylistBrain';
import { selectTopOutfits, scoreOutfit } from './styleJudge';
import {
  selectTopOutfitsWithQualityFloor,
  applyStylistProfileEnhancements,
  filterWardrobeForStylist,
  expandStylistAvoidColors,
} from './stylistQualityGate';
import { isStylisticallyIncoherent } from './styleVeto';
import {
  routeContextNeeds,
  scanChatForViolations,
  scanForWardrobeHallucinations,
  buildCorrectionPrompt,
  buildCorrectionNote,
  isStylingResponse,
  expandAvoidColorsLite,
  extractOutfitItemsFromResponse,
  type ChatAvoidLists,
} from './chatTier4';
import {
  detectRelevantCategory,
  detectFormalityAnchor,
  buildShortlist,
  formatShortlistForPrompt,
  buildLuxuryStylistPrompt,
  validateReasoningQuality,
  REASONING_CORRECTION,
} from './chatTier4Reasoning';
import { isOccasionAppropriate, getOccasionRejectionReason } from './occasionFilter';
import { FashionStateService } from '../learning/fashion-state.service';
import { LearningEventsService } from '../learning/learning-events.service';
import {
  selectAnchorItem,
  buildCompositionContext,
  rankByComposition,
  scoreOutfitComposition,
  type CompositionItem,
} from './composition';

// 🧥 Basic capsule wardrobe templates
const CAPSULES = {
  Spring: [
    { category: 'Outerwear', subcategory: 'Light Jacket', recommended: 2 },
    { category: 'Tops', subcategory: 'Oxford Shirt', recommended: 3 },
    { category: 'Bottoms', subcategory: 'Chinos', recommended: 2 },
    { category: 'Shoes', subcategory: 'Loafers', recommended: 1 },
    { category: 'Shoes', subcategory: 'Sneakers', recommended: 1 },
  ],
  Summer: [
    { category: 'Tops', subcategory: 'Short Sleeve Shirt', recommended: 4 },
    { category: 'Tops', subcategory: 'Polo Shirt', recommended: 2 },
    { category: 'Bottoms', subcategory: 'Linen Trousers', recommended: 2 },
    { category: 'Shoes', subcategory: 'Loafers', recommended: 1 },
    { category: 'Shoes', subcategory: 'Sandals', recommended: 1 },
  ],
  Fall: [
    { category: 'Outerwear', subcategory: 'Field Jacket', recommended: 1 },
    { category: 'Outerwear', subcategory: 'Blazer', recommended: 1 },
    { category: 'Tops', subcategory: 'Knit Sweater', recommended: 2 },
    { category: 'Bottoms', subcategory: 'Wool Trousers', recommended: 2 },
    { category: 'Shoes', subcategory: 'Chelsea Boots', recommended: 1 },
  ],
  Winter: [
    { category: 'Outerwear', subcategory: 'Overcoat', recommended: 1 },
    { category: 'Outerwear', subcategory: 'Heavy Parka', recommended: 1 },
    { category: 'Tops', subcategory: 'Heavy Knit Sweater', recommended: 2 },
    { category: 'Bottoms', subcategory: 'Wool Trousers', recommended: 2 },
    { category: 'Shoes', subcategory: 'Boots', recommended: 2 },
  ],
};

// 🗓️ Auto-detect season based on month
function getCurrentSeason(): 'Spring' | 'Summer' | 'Fall' | 'Winter' {
  const month = new Date().getMonth() + 1;
  if ([3, 4, 5].includes(month)) return 'Spring';
  if ([6, 7, 8].includes(month)) return 'Summer';
  if ([9, 10, 11].includes(month)) return 'Fall';
  return 'Winter';
}

// 🧠 Compare wardrobe to capsule and return simple forecast text
function generateSeasonalForecast(wardrobe: any[] = []): string | undefined {
  const season = getCurrentSeason();
  const capsule = CAPSULES[season];
  if (!capsule) return;

  const missing: string[] = [];

  capsule.forEach((item) => {
    const owned = wardrobe.filter(
      (w) =>
        w.category?.toLowerCase() === item.category.toLowerCase() &&
        w.subcategory?.toLowerCase() === item.subcategory.toLowerCase(),
    ).length;

    if (owned < item.recommended) {
      const needed = item.recommended - owned;
      missing.push(`${needed} × ${item.subcategory}`);
    }
  });

  if (missing.length === 0) {
    return `✅ Your ${season} capsule is complete — you're ready for the season.`;
  }

  return `🍂 ${season} is approaching — you're missing: ${missing.join(', ')}.`;
}

// 🌦️ Weather fetching helper for AI context
async function fetchWeatherForAI(
  lat: number,
  lon: number,
): Promise<{
  tempF: number;
  humidity: number;
  windSpeed: number;
  weatherCode: number;
  condition: string;
} | null> {
  try {
    if (!secretExists('TOMORROW_API_KEY')) {
      return null;
    }
    const apiKey = getSecret('TOMORROW_API_KEY');
    const url = `https://api.tomorrow.io/v4/weather/realtime?location=${lat},${lon}&apikey=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const values = data?.data?.values;
    if (!values) return null;

    // Map weather codes to conditions
    const weatherConditions: Record<number, string> = {
      1000: 'Clear/Sunny',
      1100: 'Mostly Clear',
      1101: 'Partly Cloudy',
      1102: 'Mostly Cloudy',
      1001: 'Cloudy',
      2000: 'Fog',
      4000: 'Drizzle',
      4001: 'Rain',
      4200: 'Light Rain',
      4201: 'Heavy Rain',
      5000: 'Snow',
      5001: 'Flurries',
      5100: 'Light Snow',
      5101: 'Heavy Snow',
      6000: 'Freezing Drizzle',
      6001: 'Freezing Rain',
      7000: 'Ice Pellets',
      7101: 'Heavy Ice Pellets',
      7102: 'Light Ice Pellets',
      8000: 'Thunderstorm',
    };

    return {
      tempF: Math.round((values.temperature * 9) / 5 + 32),
      humidity: Math.round(values.humidity),
      windSpeed: Math.round(values.windSpeed),
      weatherCode: values.weatherCode,
      condition: weatherConditions[values.weatherCode] || 'Unknown',
    };
  } catch (err: any) {
    return null;
  }
}

/** Enrich thin Stylist outfit items with wardrobe metadata for elite scoring. */
export function enrichStylistOutfits(
  outfits: any[],
  fullItemMap: Map<string, any>,
): void {
  for (const outfit of outfits) {
    outfit.items = outfit.items.map((item: any) => {
      if (!item?.id) return item;
      const full = fullItemMap.get(item.id);
      if (!full) return item;
      return {
        ...item,
        ...(full.brand && { brand: full.brand }),
        ...(full.color && { color: full.color }),
        ...(full.subcategory && { subcategory: full.subcategory }),
        ...(Array.isArray(full.style_descriptors) &&
          full.style_descriptors.length > 0 && {
            style_descriptors: full.style_descriptors,
          }),
        ...(Array.isArray(full.style_archetypes) &&
          full.style_archetypes.length > 0 && {
            style_archetypes: full.style_archetypes,
          }),
        ...(full.formality_score != null && {
          formality_score: full.formality_score,
        }),
        ...(full.material && { material: full.material }),
      };
    });
  }
}

@Injectable()
export class AiService {
  private openai: OpenAI;
  private useVertex: boolean;
  private vertexService?: VertexService; // 🔹 optional instance
  private productSearch: ProductSearchService; // ✅ add this
  // 🧠 Fast in-memory cache for repeated TTS phrases
  private ttsCache = new Map<string, Buffer>();
  // 🔄 Short-term exclusion cache for visual outfit variety (per user)
  private visualExclusionCache = new Map<string, string[]>();
  // Deterministic swipe paging: tracks offset per user for visual outfit rotation
  private visualSwipeOffset = new Map<string, number>();
  private fashionStateService?: FashionStateService;
  private learningEventsService?: LearningEventsService;

  constructor(
    vertexService?: VertexService,
    fashionStateService?: FashionStateService,
    learningEventsService?: LearningEventsService,
  ) {
    const apiKey = getSecret('OPENAI_API_KEY');
    const project = secretExists('OPENAI_PROJECT_ID')
      ? getSecret('OPENAI_PROJECT_ID')
      : undefined;

    if (!apiKey) {
      throw new Error('OPENAI_API_KEY secret not found.');
    }
    if (/^sk-?x{3,}/i.test(apiKey)) {
      throw new Error('OPENAI_API_KEY appears masked (e.g., "sk-xxxxx...").');
    }
    if (!apiKey.startsWith('sk-')) {
      throw new Error('OPENAI_API_KEY is malformed — must start with "sk-".');
    }

    this.openai = new OpenAI({ apiKey, project });

    // 🔹 New: Vertex toggle - feature flag (not a secret)
    this.useVertex = process.env.USE_VERTEX === 'true';
    if (this.useVertex) {
      this.vertexService = vertexService;
    }

    this.productSearch = new ProductSearchService();
    this.fashionStateService = fashionStateService;
    this.learningEventsService = learningEventsService;
  }

  // async generateSpeechBuffer(text: string): Promise<Buffer> {
  //   if (!text?.trim()) throw new BadRequestException('Empty text');

  //   // 👇 bypass outdated type definition safely
  //   const resp = await this.openai.audio.speech.create({
  //     model: 'gpt-4o-mini-tts',
  //     voice: 'alloy',
  //     input: text,

  //     format: 'mp3',
  //   } as any);

  //   const arrayBuf = await resp.arrayBuffer();
  //   return Buffer.from(arrayBuf);
  // }

  /** 🎙️ Generate Alloy voice speech (cached + streamable) */
  async generateSpeechBuffer(text: string): Promise<Buffer> {
    if (!text?.trim()) throw new BadRequestException('Empty text');

    // 🧠 Cache key (base64 of text)
    const cacheKey = Buffer.from(text).toString('base64').slice(0, 40);
    if (this.ttsCache.has(cacheKey)) {
      console.log('💾 [TTS] cache hit:', text.slice(0, 60));
      return this.ttsCache.get(cacheKey)!;
    }

    console.log('🎤 [TTS] generating voice:', text.slice(0, 80));

    // ✅ bypass type errors safely
    const resp: any = await (this.openai as any).audio.speech.create(
      {
        model: 'gpt-4o-mini-tts',
        voice: 'alloy',
        input: text,
        format: 'mp3',
      },
      { responseType: 'stream' }, // runtime param (missing from types)
    );

    const stream: NodeJS.ReadableStream = resp.data;
    const chunks: Buffer[] = [];

    for await (const chunk of stream) {
      // 👇 Normalize chunk type (handles both string and Uint8Array)
      chunks.push(
        typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk),
      );
    }

    const buffer = Buffer.concat(chunks);
    this.ttsCache.set(cacheKey, buffer);

    return buffer;
  }

  //  'alloy','ash','ballad','coral','echo','fable','nova','onyx','sage','shimmer','verse'

  /** 🎧 Stream version for immediate browser playback */
  async generateSpeechStream(text: string) {
    if (!text?.trim()) throw new BadRequestException('Empty text');

    const response = await this.openai.audio.speech.create({
      model: 'gpt-4o-mini-tts',
      voice: 'coral',
      input: text,
      format: 'mp3',
      stream: true, // <—— critical flag for live stream
      // 🔧 optional fine-tuning parameters:
      speed: 1.0, // 1.0 = normal, higher = faster, 0.8 = slower
      pitch: 1.0, // 1.0 = default, higher = brighter tone
    } as any);

    // ✅ Return the WebReadableStream
    return response.body;
  }

  //////ANALYZE LOOK

  async analyze(imageUrl: string) {
    console.log('🧠 [AI] analyze() called with', imageUrl);
    if (!imageUrl) throw new Error('Missing imageUrl');

    // 🔹 Try Vertex first if enabled
    if (this.useVertex && this.vertexService) {
      try {
        const gcsUri = imageUrl.replace(
          'https://storage.googleapis.com/',
          'gs://',
        );
        const metadata = await this.vertexService.analyzeImage(gcsUri);
        const tags = [
          ...(metadata.tags || []),
          ...(metadata.style_descriptors || []),
          metadata.main_category,
          metadata.subcategory,
        ].filter(Boolean);
        console.log('🧠 [Vertex] analyze() success:', tags);
        return { tags };
      } catch (err: any) {
        console.warn(
          '[Vertex] analyze() failed → fallback to OpenAI:',
          err.message,
        );
      }
    }

    // 🔸 OpenAI fallback
    try {
      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content:
              'You are a professional fashion classifier. Return only JSON with a "tags" array describing the outfit’s style, color palette, and vibe.',
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Describe this outfit as tags only:' },
              { type: 'image_url', image_url: { url: imageUrl } },
            ],
          },
        ],
        response_format: { type: 'json_object' },
      });

      const raw = completion.choices[0]?.message?.content;
      console.log('🧠 [AI] analyze() raw response:', raw);

      if (!raw) throw new Error('Empty response from OpenAI');
      const parsed = JSON.parse(raw || '{}');
      return { tags: parsed.tags || [] };
    } catch (err: any) {
      console.error('❌ [AI] analyze() failed:', err.message);
      return { tags: ['casual', 'modern', 'neutral'] };
    }
  }

  /**
   * 👗 Analyze outfit image and identify each individual clothing piece
   * Returns an array of pieces with category, item, color, material, style
   */
  async analyzeOutfitPieces(
    imageUrl: string,
    gender?: string,
  ): Promise<
    Array<{
      category: string;
      item: string;
      color: string;
      material?: string;
      style?: string;
      brand?: string;
    }>
  > {
    // console.log('👗 [AI] analyzeOutfitPieces() called with', imageUrl);
    if (!imageUrl) throw new Error('Missing imageUrl');

    const genderContext = gender ? `The person appears to be ${gender}.` : '';

    try {
      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: `You are an expert fashion analyst. Analyze the outfit in the image and identify EVERY clothing piece and accessory visible. Look carefully from head to toe.

For EACH piece, extract:
- category: Item type (Top, Bottom, Outerwear, Shoes, Accessories, Hat, Bag, Jewelry, Eyewear)
- item: Specific item name (e.g., "wrap dress", "cargo pants", "chelsea boots", "crossbody bag")
- color: Primary color with descriptors (e.g., "forest green", "blush pink", "charcoal gray", "leopard print")
- material: Fabric if identifiable (e.g., "silk", "denim", "suede", "cashmere", "tweed", "linen")
- style: Style descriptors (e.g., "bohemian", "minimalist", "streetwear", "preppy", "Y2K", "cottagecore", "quiet luxury")
- brand: Any identifiable brand, designer, logo, or distinguishing text/graphics. Look for:
  * Fashion brands (Zara, H&M, Gucci, Prada, Lululemon, Aritzia, Free People)
  * Designer labels (Chanel, Louis Vuitton, Dior, Balenciaga, Hermès)
  * Athletic brands (Nike, Adidas, New Balance, Lululemon, Alo Yoga)
  * Streetwear (Supreme, Stüssy, Off-White, Palace, BAPE)
  * Workwear/outdoor (Carhartt, Patagonia, The North Face, Arc'teryx)
  * Sports teams, universities, band tees, graphic prints
  * Distinctive patterns (Burberry plaid, Louis Vuitton monogram, Gucci GG)
  * If no brand visible, use null

IMPORTANT: Return a JSON object with "pieces" array containing ALL visible items:
- Tops (blouses, tees, tanks, sweaters, bodysuits, crop tops)
- Bottoms (jeans, trousers, skirts, shorts, leggings)
- Dresses/Jumpsuits (if applicable, categorize as "Top" or separate category)
- Shoes (heels, flats, boots, sneakers, sandals, loafers)
- Outerwear (blazers, jackets, coats, vests, cardigans)
- Accessories (bags, belts, jewelry, scarves, hats, sunglasses, watches)

${genderContext}

Return format:
{
  "pieces": [
    {"category": "Top", "item": "silk blouse", "color": "ivory", "material": "silk", "style": "minimalist", "brand": null},
    {"category": "Bottom", "item": "wide-leg trousers", "color": "black", "material": "wool blend", "style": "tailored", "brand": "Aritzia"},
    {"category": "Shoes", "item": "pointed-toe mules", "color": "tan", "material": "leather", "style": "quiet luxury", "brand": null},
    {"category": "Bag", "item": "structured tote", "color": "cognac", "material": "leather", "style": "classic", "brand": "Madewell"}
  ]
}`,
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Analyze this outfit image completely. Identify EVERY piece from head to toe: tops, bottoms, shoes, outerwear, bags, jewelry, hats, sunglasses, belts. For each piece, note the specific item type, exact color, material/fabric, style aesthetic, and any visible brand/logo/designer/pattern. Be specific and detailed. Return as a JSON object with a "pieces" array.',
              },
              { type: 'image_url', image_url: { url: imageUrl } },
            ],
          },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 1000,
      });

      const raw = completion.choices[0]?.message?.content;
      // console.log('👗 [AI] analyzeOutfitPieces() raw response:', raw);

      if (!raw) throw new Error('Empty response from OpenAI');

      const parsed = JSON.parse(raw);

      // Handle multiple response formats:
      // 1. Direct array: [{...}, {...}]
      // 2. Object with array key: { pieces: [...] } or { items: [...] } or { outfit: [...] }
      // 3. Single object with category: { category: "Top", ... } - wrap in array
      let pieces: any[];

      if (Array.isArray(parsed)) {
        pieces = parsed;
      } else if (parsed.pieces && Array.isArray(parsed.pieces)) {
        pieces = parsed.pieces;
      } else if (parsed.items && Array.isArray(parsed.items)) {
        pieces = parsed.items;
      } else if (parsed.outfit && Array.isArray(parsed.outfit)) {
        pieces = parsed.outfit;
      } else if (parsed.category && parsed.item) {
        // Single object returned - wrap in array
        pieces = [parsed];
      } else {
        // Try to extract any array value from the object
        const arrayValue = Object.values(parsed).find((v) => Array.isArray(v));
        pieces = arrayValue ? arrayValue : [];
      }

      // console.log('👗 [AI] analyzeOutfitPieces() found', pieces.length, 'pieces');
      return pieces;
    } catch (err: any) {
      console.error('❌ [AI] analyzeOutfitPieces() failed:', err.message);
      // Return basic fallback pieces
      return [
        { category: 'Top', item: 'shirt', color: 'neutral' },
        { category: 'Bottom', item: 'pants', color: 'neutral' },
        { category: 'Shoes', item: 'shoes', color: 'neutral' },
      ];
    }
  }

  /**
   * 🔍 Classify product image presentation as masculine/feminine/neutral/unknown.
   * Used ONLY by recreate() vision guard. Fail-open: returns 'unknown' on any error.
   */
  private async classifyProductPresentation(
    imageUrl: string,
  ): Promise<'masculine' | 'feminine' | 'neutral' | 'unknown'> {
    const ALLOWED = new Set(['masculine', 'feminine', 'neutral', 'unknown']);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const resp = await this.openai.chat.completions.create(
        {
          model: 'gpt-4o',
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: 'Look at this product photo. Based ONLY on the model/mannequin/presentation visible, classify the presentation as one of: masculine, feminine, neutral. If you cannot determine, respond unknown. Respond with exactly one word.',
                },
                { type: 'image_url', image_url: { url: imageUrl } },
              ],
            },
          ],
          max_tokens: 5,
        },
        { signal: controller.signal },
      );
      const word = (resp.choices[0]?.message?.content ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z]/g, '');
      return ALLOWED.has(word) ? (word as any) : 'unknown';
    } catch (err: any) {
      console.warn('⚠️ [recreate] vision guard classification error:', err.message);
      return 'unknown';
    } finally {
      clearTimeout(timer);
    }
  }

  /* ------------------------------------------------------------
     🧩 Weighted Tag Enrichment + Trend Injection
  -------------------------------------------------------------*/
  private async enrichTags(tags: string[]): Promise<string[]> {
    const weightMap: Record<string, number> = {
      tailored: 3,
      minimal: 3,
      neutral: 3,
      modern: 2,
      vintage: 2,
      classic: 2,
      streetwear: 2,
      oversized: 2,
      slim: 2,
      relaxed: 2,
      casual: 1,
      sporty: 1,
    };

    // 🧹 Normalize + de-dupe
    const cleanTags = Array.from(
      new Set(
        tags
          .map((t) => t.toLowerCase().trim())
          .filter((t) => t && !['outfit', 'style', 'fashion'].includes(t)),
      ),
    );

    // 🧠 Apply weights
    const weighted = cleanTags
      .map((t) => ({ tag: t, weight: weightMap[t] || 1 }))
      .sort((a, b) => b.weight - a.weight);

    // 🌍 Inject current trend tags
    const trendTags = await this.fetchTrendTags();
    const final = Array.from(
      new Set([...weighted.map((w) => w.tag), ...trendTags.slice(0, 3)]),
    );

    console.log('🎯 [AI] Enriched tags →', final);
    return final;
  }

  private async fetchTrendTags(): Promise<string[]> {
    try {
      const res = await fetch(
        'https://trends.google.com/trends/hottrends/visualize/internal/data/en_us',
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json().catch(() => []);
      const trendWords = JSON.stringify(json).toLowerCase();
      const matched = trendWords.match(
        /(quiet luxury|monochrome|minimalism|maximalism|italian|tailoring|loafers|neutrals|linen|structured|preppy|flannel|earth tones|autumn layering)/gi,
      );
      if (matched?.length) return Array.from(new Set(matched));

      // 🧭 If Google Trends returned empty, use local backup
      return [
        'quiet luxury',
        'neutral tones',
        'tailored fit',
        'autumn layering',
      ];
    } catch (err: any) {
      console.warn('⚠️ Trend fetch fallback triggered:', err.message);
      return [
        'quiet luxury',
        'neutral tones',
        'tailored fit',
        'autumn layering',
      ];
    }
  }

  // RECREATE//////////////
  async recreate(
    user_id: string,
    tags: string[],
    image_url?: string,
    user_gender?: string,
  ) {
    console.log(
      '🧥 [AI] recreate() called for user',
      user_id,
      'with tags:',
      tags,
      'and gender:',
      user_gender,
    );

    if (!user_id) throw new Error('Missing user_id');
    if (!tags?.length) {
      console.warn('⚠️ [AI] recreate() empty tags → using defaults.');
      tags = ['modern', 'neutral', 'tailored'];
    }

    // ✅ Weighted + trend-injected tags
    tags = await this.enrichTags(tags);

    // 🧠 Fetch gender_presentation if missing
    if (!user_gender) {
      try {
        const result = await pool.query(
          'SELECT gender_presentation FROM users WHERE id = $1 LIMIT 1',
          [user_id],
        );
        user_gender = result.rows[0]?.gender_presentation || 'neutral';
      } catch {
        user_gender = 'neutral';
      }
    }

    // 🧩 Normalize gender — order matters: female-like FIRST (since 'female' contains 'male')
    const genderLower = (user_gender ?? '').toLowerCase().trim();
    const normalizedGender =
      genderLower.includes('female') || genderLower.includes('woman') || genderLower.includes('feminine') || genderLower === 'fem'
        ? 'female'
        : genderLower.includes('male') || genderLower.includes('man') || genderLower.includes('masculine') || genderLower === 'masc'
          ? 'male'
          : process.env.DEFAULT_GENDER === 'male' || process.env.DEFAULT_GENDER === 'female'
            ? process.env.DEFAULT_GENDER
            : 'neutral';

    const searchGender: 'male' | 'female' | 'unisex' =
      normalizedGender === 'male' ? 'male' : normalizedGender === 'female' ? 'female' : 'unisex';

    const targetPresentation: 'masculine' | 'feminine' | 'neutral' =
      normalizedGender === 'male' ? 'masculine' : normalizedGender === 'female' ? 'feminine' : 'neutral';

    const mismatchRe: RegExp | null =
      targetPresentation === 'masculine' ? /(women|woman|female|ladies|girls|womens|women's|womenswear)/i :
      targetPresentation === 'feminine' ? /(\bmen\b|\bmale\b|mens|men's|menswear|gentleman)/i :
      null;

    // 🧠 Build stylist prompt (base)
    const prompt = `
        You are a world-class AI stylist for ${normalizedGender} fashion.
        Create a cohesive outfit inspired by an uploaded look.

        Client: ${user_id}
        Image: ${image_url || 'N/A'}
        Detected tags: ${tags.join(', ')}

        Rules:
        - Match fabric, color palette, and silhouette.
        - Use ${normalizedGender}-appropriate pieces.
        - Output only JSON:
        {
          "outfit": [
            { "category": "Top", "item": "Grey Cotton Tee", "color": "gray" },
            { "category": "Bottom", "item": "Navy Chinos", "color": "navy" },
            { "category": "Outerwear", "item": "Beige Overshirt", "color": "beige" },
            { "category": "Shoes", "item": "White Sneakers", "color": "white" }
          ],
          "style_note": "Describe how the look connects to the uploaded image."
        }
        `;

    // 🔹 Pull soft profile context (optional)
    let profileCtx = '';
    try {
      const res = await pool.query(
        `SELECT color_preferences AS favorite_colors, fit_preferences, preferred_brands, disliked_styles,
                coverage_no_go, avoid_colors, avoid_materials,
                formality_floor, walkability_requirement
       FROM style_profiles WHERE user_id::text = $1 LIMIT 1`,
        [user_id],
      );
      const prof = res.rows[0];
      if (prof) {
        const pLines: string[] = [
          `• Preferred colors: ${(prof.favorite_colors || []).join(', ') || '—'}`,
          `• Fit preferences: ${(prof.fit_preferences || []).join(', ') || '—'}`,
          `• Favorite brands: ${(prof.preferred_brands || []).join(', ') || '—'}`,
          `• Disliked styles: ${Array.isArray(prof.disliked_styles) ? prof.disliked_styles.join(', ') : prof.disliked_styles || '—'}`,
        ];
        const _covNoGo = Array.isArray(prof.coverage_no_go)
          ? prof.coverage_no_go
          : [];
        const _avCol = Array.isArray(prof.avoid_colors)
          ? prof.avoid_colors
          : [];
        const _avMat = Array.isArray(prof.avoid_materials)
          ? prof.avoid_materials
          : [];
        if (_covNoGo.length > 0)
          pLines.push(
            `HARD RULE — Coverage restrictions: ${_covNoGo.join(', ')}`,
          );
        if (_avCol.length > 0)
          pLines.push(
            `HARD RULE — NEVER use these colors: ${_avCol.join(', ')}`,
          );
        if (_avMat.length > 0)
          pLines.push(
            `HARD RULE — NEVER use these materials: ${_avMat.join(', ')}`,
          );
        if (prof.formality_floor && prof.formality_floor !== 'No minimum')
          pLines.push(`HARD RULE — Minimum formality: ${prof.formality_floor}`);
        if (
          prof.walkability_requirement &&
          prof.walkability_requirement !== 'Low'
        )
          pLines.push(
            `HARD RULE — Walkability: ${prof.walkability_requirement}`,
          );
        profileCtx = `
      # USER STYLE CONTEXT (soft influence — hard rules MUST be obeyed)
      ${pLines.join('\n      ')}
      Do NOT override the image's vibe — just bias tone/material choices if relevant.
      `;
      }
    } catch {
      /* silent fail */
    }

    // ✅ Final prompt (merge only if context exists)
    // Inside recreate() or personalizedShop() final prompt:
    const finalPrompt = `
${prompt}

# HARD RULES
- ALWAYS output a full outfit of at least 4–6 distinct pieces.
- Include a Top, Bottom, Outerwear (if seasonally appropriate), Shoes, and optionally 1–2 Accessories.
- NEVER omit items because they already exist in the user’s wardrobe.
- Each piece should have its own JSON object, even if similar to a wardrobe item.
- Always include color and fit for every item.
`;

    // 🧠 Generate outfit via Vertex or OpenAI
    let parsed: any;
    if (this.useVertex && this.vertexService) {
      try {
        const result =
          await this.vertexService.generateReasonedOutfit(finalPrompt);
        let text = result?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
        text = text
          .replace(/^```json\s*/i, '')
          .replace(/```$/, '')
          .trim();
        parsed = JSON.parse(text);
        console.log('🧠 [Vertex] recreate() success');
      } catch (err: any) {
        console.warn('[Vertex] recreate() failed → fallback', err.message);
      }
    }

    if (!parsed) {
      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.7,
        messages: [{ role: 'user', content: finalPrompt }],
        response_format: { type: 'json_object' },
      });

      const raw = completion.choices[0]?.message?.content || '{}';
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = {};
      }
    }

    const outfit = Array.isArray(parsed?.outfit) ? parsed.outfit : [];
    const style_note =
      parsed?.style_note || 'Modern outfit inspired by the uploaded look.';

    // 🛍️ Enrich each item with live products
    const enriched = await Promise.all(
      outfit.map(async (o: any) => {
        const query =
          `${normalizedGender} ${o.item || o.category || ''} ${o.color || ''}`.trim();
        const products = await this.productSearch.search(query, searchGender);
        const passesTextFilter = (p: any) => !mismatchRe || !mismatchRe.test(`${p.name ?? ''} ${p.title ?? ''} ${p.product_title ?? ''} ${p.shopUrl ?? ''} ${p.link ?? ''} ${p.image ?? ''}`.toLowerCase());
        let top = mismatchRe
          ? products.find(passesTextFilter) ?? null
          : products[0];

        // 🔄 Retry with stronger gendered prefix if ALL primary candidates were mismatched
        if (!top && mismatchRe && targetPresentation !== 'neutral') {
          const retryPrefix = targetPresentation === 'masculine' ? 'mens' : 'womens';
          const retryQuery = `${retryPrefix} ${query}`;
          console.log(`🔄 [recreate] all ${products.length} candidates mismatched for target=${targetPresentation}, retrying: "${retryQuery}"`);
          const retryProducts = await this.productSearch.search(retryQuery, searchGender);
          top = retryProducts.find(passesTextFilter) ?? null;
          if (!top) {
            console.warn(`⚠️ [recreate] retry still mismatched (${retryProducts.length} candidates), using safe fallback for "${query}"`);
          }
        }

        // 🛡️ Vision guard: classify top candidate images to catch presentation mismatches
        const visionGuardOn = process.env.ENABLE_RECREATE_VISION_GUARD === 'true' && targetPresentation !== 'neutral';
        const visionMaxChecks = Math.max(1, parseInt(process.env.RECREATE_VISION_GUARD_MAX_CHECKS || '2', 10) || 2);

        if (visionGuardOn && top?.image && top.image.startsWith('http')) {
          const textPassCandidates = products.filter(p => p.image && p.image.startsWith('http') && passesTextFilter(p));
          const toCheck = textPassCandidates.slice(0, visionMaxChecks);
          let accepted = false;
          for (const candidate of toCheck) {
            const detected = await this.classifyProductPresentation(candidate.image!);
            if (detected === targetPresentation || detected === 'neutral' || detected === 'unknown') {
              top = candidate;
              accepted = true;
              break;
            }
            console.log(`🛡️ [recreate] vision guard skipped candidate "${candidate.name ?? '?'}" — detected=${detected}, target=${targetPresentation}`);
          }
          if (!accepted) {
            console.warn(`🚫 [recreate] vision guard: all ${toCheck.length} candidates had opposite presentation → fallback`);
            top = null;
          }
        }

        if (!top?.image || top.image.includes('No_image')) {
          const serp = await this.productSearch.searchSerpApi(query, searchGender);
          let serpPick = mismatchRe
            ? serp.find(passesTextFilter) ?? null
            : serp[0];

          // 🔄 SerpAPI retry with gendered prefix if all serp results mismatched
          if (!serpPick && mismatchRe && targetPresentation !== 'neutral') {
            const retryPrefix = targetPresentation === 'masculine' ? 'mens' : 'womens';
            const serpRetryQuery = `${retryPrefix} ${query}`;
            console.log(`🔄 [recreate] all ${serp.length} serp candidates mismatched, retrying: "${serpRetryQuery}"`);
            const retrySerp = await this.productSearch.searchSerpApi(serpRetryQuery, searchGender);
            serpPick = retrySerp.find(passesTextFilter) ?? null;
            if (!serpPick) {
              console.warn(`⚠️ [recreate] serp retry still mismatched (${retrySerp.length} candidates), using safe fallback`);
            }
          }

          if (visionGuardOn && serpPick?.image && serpPick.image.startsWith('http')) {
            const serpTextPass = serp.filter(p => p.image && p.image.startsWith('http') && passesTextFilter(p));
            const serpToCheck = serpTextPass.slice(0, visionMaxChecks);
            let serpAccepted = false;
            for (const candidate of serpToCheck) {
              const detected = await this.classifyProductPresentation(candidate.image!);
              if (detected === targetPresentation || detected === 'neutral' || detected === 'unknown') {
                serpPick = candidate;
                serpAccepted = true;
                break;
              }
              console.log(`🛡️ [recreate] vision guard skipped serp candidate "${candidate.name ?? '?'}" — detected=${detected}, target=${targetPresentation}`);
            }
            if (!serpAccepted) {
              console.warn(`🚫 [recreate] vision guard: all ${serpToCheck.length} serp candidates had opposite presentation → fallback`);
              serpPick = null;
            }
          }

          if (serpPick) top = { ...serpPick, source: 'SerpAPI' };
        }

        // 🛡️ FINAL GUARD: never return a gendered-mismatched product
        if (top && mismatchRe) {
          const finalCombined = `${top.name ?? ''} ${(top as any).title ?? ''} ${(top as any).product_title ?? ''} ${top.shopUrl ?? ''} ${(top as any).link ?? ''} ${top.image ?? ''}`.toLowerCase();
          if (mismatchRe.test(finalCombined)) {
            console.warn(`🚫 [recreate] FINAL GUARD blocked mismatched product "${top.name ?? (top as any).title ?? '?'}" for target=${targetPresentation}`);
            top = null;
          }
        }

        const materialHint =
          query.match(/(wool|cotton|linen|leather|denim|polyester)/i)?.[0] ||
          null;
        const seasonalityHint =
          query.match(/(summer|winter|fall|spring)/i)?.[0] ||
          getCurrentSeason();
        const fitHint =
          query.match(/(slim|regular|relaxed|oversized|tailored)/i)?.[0] ||
          'regular';

        const safeFallbackUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&tbm=shop`;

        return {
          category: o.category,
          item: o.item,
          color: o.color,
          brand: top?.brand || 'Unknown',
          price: top?.price || '—',
          image:
            top?.image && top.image.startsWith('http')
              ? top.image
              : 'https://upload.wikimedia.org/wikipedia/commons/a/ac/No_image_available.svg',
          shopUrl: top?.shopUrl || safeFallbackUrl,
          source: top?.source || 'ASOS / Fallback',
          material: materialHint,
          seasonality: seasonalityHint,
          fit: fitHint,
        };
      }),
    );

    return { user_id, outfit: enriched, style_note };
  }

  /**
   * 🔍 RECREATE VISUAL — Uses Google Lens to find 1:1 purchasable matches
   * Analyzes the outfit image, identifies each piece, then uses visual search
   * to find the closest purchasable items from Google Shopping.
   */
  async recreateVisual(
    user_id: string,
    image_url: string,
    user_gender?: string,
  ) {
    console.log(
      '🔍 [AI] recreateVisual() called for user',
      user_id,
      'with image:',
      image_url,
    );

    if (!user_id) throw new Error('Missing user_id');
    if (!image_url) throw new Error('Missing image_url');

    // 🧠 Fetch gender if missing
    if (!user_gender) {
      try {
        const result = await pool.query(
          'SELECT gender_presentation FROM users WHERE id = $1 LIMIT 1',
          [user_id],
        );
        user_gender = result.rows[0]?.gender_presentation || 'neutral';
      } catch {
        user_gender = 'neutral';
      }
    }

    const normalizedGender =
      user_gender?.toLowerCase().includes('female') ||
      user_gender?.toLowerCase().includes('woman')
        ? 'female'
        : user_gender?.toLowerCase().includes('male') ||
            user_gender?.toLowerCase().includes('man')
          ? 'male'
          : 'neutral';

    // 🧠 Load P0 hard vetoes for user (fail-open: no rules if missing)
    let p0Rules = '';
    try {
      const profRes = await pool.query(
        `SELECT coverage_no_go, avoid_colors, avoid_materials,
                formality_floor, walkability_requirement
         FROM style_profiles WHERE user_id = $1 LIMIT 1`,
        [user_id],
      );
      const prof = profRes.rows[0];
      if (prof) {
        const lines: string[] = [];
        const covNoGo = Array.isArray(prof.coverage_no_go)
          ? prof.coverage_no_go
          : [];
        const avCol = Array.isArray(prof.avoid_colors)
          ? prof.avoid_colors
          : [];
        const avMat = Array.isArray(prof.avoid_materials)
          ? prof.avoid_materials
          : [];
        if (covNoGo.length > 0)
          lines.push(
            `HARD RULE — Coverage restrictions: ${covNoGo.join(', ')}`,
          );
        if (avCol.length > 0)
          lines.push(
            `HARD RULE — NEVER suggest these colors: ${avCol.join(', ')}`,
          );
        if (avMat.length > 0)
          lines.push(
            `HARD RULE — NEVER suggest these materials: ${avMat.join(', ')}`,
          );
        if (prof.formality_floor && prof.formality_floor !== 'No minimum')
          lines.push(
            `HARD RULE — Minimum formality: ${prof.formality_floor}`,
          );
        if (
          prof.walkability_requirement &&
          prof.walkability_requirement !== 'Low'
        )
          lines.push(
            `HARD RULE — Walkability: ${prof.walkability_requirement}`,
          );
        if (lines.length > 0)
          p0Rules = '\n' + lines.join('\n') + '\n';
      }
    } catch {
      /* fail-open */
    }

    // 🧠 Step 1: Analyze image to identify each outfit piece with AI
    const identifyPrompt = `
You are a fashion AI expert. Analyze this outfit image and identify EACH distinct clothing item/piece visible.

For each piece, provide:
- category: The type (Top, Bottom, Outerwear, Shoes, Accessory, Bag, Hat, etc.)
- item: Specific description (e.g., "Navy Blue Wool Overcoat", "White Leather Sneakers")
- color: Primary color
- material: If identifiable (wool, cotton, leather, denim, etc.)
- brand: If visible/identifiable, otherwise null
- search_query: A detailed search query to find this exact item (e.g., "men navy wool double breasted overcoat")

Rules:
- Identify ALL visible pieces, typically 3-6 items
- Be specific about colors, materials, and styles
- Include the gender (${normalizedGender}) in search queries
- Focus on recreating the EXACT look, not similar alternatives${p0Rules ? `\nUser constraints (MUST obey when suggesting alternatives):\n${p0Rules}` : ''}

Output JSON only:
{
  "pieces": [
    {
      "category": "Outerwear",
      "item": "Navy Blue Wool Overcoat",
      "color": "navy",
      "material": "wool",
      "brand": null,
      "search_query": "${normalizedGender} navy wool overcoat double breasted"
    }
  ],
  "style_note": "Brief description of the overall look/vibe"
}
`;

    let identified: any = { pieces: [], style_note: '' };

    // Try Vertex first, then OpenAI
    if (this.useVertex && this.vertexService) {
      try {
        const result =
          await this.vertexService.generateReasonedOutfit(identifyPrompt);
        let text = result?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
        text = text
          .replace(/^```json\s*/i, '')
          .replace(/```$/, '')
          .trim();
        identified = JSON.parse(text);
        console.log('🧠 [Vertex] recreateVisual identify success');
      } catch (err: any) {
        console.warn(
          '[Vertex] recreateVisual identify failed → fallback',
          err.message,
        );
      }
    }

    if (!identified?.pieces?.length) {
      try {
        const completion = await this.openai.chat.completions.create({
          model: 'gpt-4o',
          temperature: 0.3,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: identifyPrompt },
                { type: 'image_url', image_url: { url: image_url } },
              ],
            },
          ],
          response_format: { type: 'json_object' },
        });

        const raw = completion.choices[0]?.message?.content || '{}';
        identified = JSON.parse(raw);
        console.log(
          '🧠 [OpenAI] recreateVisual identified pieces:',
          identified,
        );
      } catch (err: any) {
        console.error('❌ recreateVisual identify failed:', err.message);
        identified = { pieces: [], style_note: 'Could not analyze image' };
      }
    }

    const pieces = Array.isArray(identified?.pieces) ? identified.pieces : [];
    const style_note =
      identified?.style_note || 'Outfit recreation from your saved look.';

    if (!pieces.length) {
      return {
        user_id,
        outfit: [],
        style_note: 'Could not identify outfit pieces in the image.',
        error: 'No pieces identified',
      };
    }

    // 🛍️ Step 2: Use Google Lens to find purchasable matches for EACH piece
    const serpApiKey = secretExists('SERPAPI_KEY')
      ? getSecret('SERPAPI_KEY')
      : null;

    const enrichedPieces = await Promise.all(
      pieces.map(async (piece: any) => {
        const searchQuery =
          piece.search_query ||
          `${normalizedGender} ${piece.item} ${piece.color}`;

        let products: any[] = [];

        // First try Google Shopping with specific query
        try {
          const shoppingUrl = `https://serpapi.com/search.json?engine=google_shopping&q=${encodeURIComponent(
            searchQuery,
          )}&gl=us&hl=en&api_key=${serpApiKey}`;

          const shoppingRes = await fetch(shoppingUrl);
          if (shoppingRes.ok) {
            const shoppingJson = await shoppingRes.json();
            const shoppingResults = shoppingJson?.shopping_results || [];

            products = shoppingResults.slice(0, 5).map((item: any) => {
              let price = item.price || item.extracted_price;
              if (typeof price === 'number') {
                price = `$${price.toFixed(2)}`;
              }

              return {
                title: item.title || piece.item,
                brand: item.source || item.merchant || 'Unknown',
                price: price || '—',
                image: item.thumbnail || item.image,
                shopUrl: item.link || item.product_link,
                source: 'Google Shopping',
              };
            });
          }
        } catch (err: any) {
          console.warn(
            `[recreateVisual] Shopping search failed for ${piece.category}:`,
            err.message,
          );
        }

        // If no products found, try fallback product search
        if (!products.length) {
          try {
            const fallbackProducts =
              await this.productSearch.search(searchQuery);
            products = fallbackProducts.slice(0, 3).map((p: any) => ({
              title: p.name || p.title || piece.item,
              brand: p.brand || 'Unknown',
              price: p.price || '—',
              image: p.image || p.thumbnail,
              shopUrl: p.shopUrl || p.link,
              source: p.source || 'Product Search',
            }));
          } catch {
            // Silent fail
          }
        }

        // If still no products, create a Google search fallback
        if (!products.length) {
          products = [
            {
              title: piece.item,
              brand: piece.brand || 'Various',
              price: '—',
              image: null,
              shopUrl: `https://www.google.com/search?q=${encodeURIComponent(searchQuery)}&tbm=shop`,
              source: 'Google Search',
            },
          ];
        }

        return {
          category: piece.category,
          item: piece.item,
          color: piece.color,
          material: piece.material,
          brand: piece.brand,
          products: products,
          topMatch: products[0] || null,
        };
      }),
    );

    console.log(
      '✅ [recreateVisual] Complete with',
      enrichedPieces.length,
      'pieces',
    );

    return {
      user_id,
      outfit: enrichedPieces,
      style_note,
    };
  }

  // 🧩 Ensure every product object includes a usable image URL
  private fixProductImages(products: any[] = []): any[] {
    return products.map((prod) => ({
      ...prod,
      image:
        prod.image ||
        prod.image_url ||
        prod.thumbnail ||
        prod.serpapi_thumbnail || // ✅ added
        prod.img ||
        prod.picture ||
        prod.thumbnail_url ||
        'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg',
    }));
  }

  // 👔 PERSONALIZED SHOP — image + wardrobe + preferences
  async personalizedShop(
    user_id: string,
    image_url: string,
    user_gender?: string,
  ) {
    if (!user_id || !image_url) throw new Error('Missing user_id or image_url');

    /** -----------------------------------------------------------
     * 🧠 buildProfileConstraints(profile)
     * Converts full style_profiles record into explicit hard rules
     * ---------------------------------------------------------- */
    function buildProfileConstraints(profile: any): string {
      if (!profile) return '';

      const fit = Array.isArray(profile.fit_preferences)
        ? profile.fit_preferences.join(', ')
        : profile.fit_preferences;

      const colors = Array.isArray(profile.favorite_colors)
        ? profile.favorite_colors.join(', ')
        : profile.favorite_colors;

      const brands = Array.isArray(profile.preferred_brands)
        ? profile.preferred_brands.join(', ')
        : profile.preferred_brands;

      const styles = [
        ...(profile.style_keywords || []),
        ...(profile.style_preferences || []),
      ]
        .filter(Boolean)
        .join(', ');

      const dislikes =
        typeof profile.disliked_styles === 'string'
          ? profile.disliked_styles
          : (profile.disliked_styles || []).join(', ');

      const climate = profile.climate || 'Temperate';
      const goals = profile.goals || '';

      // 🔹 Inject explicit hard “only color” or “except color” rule for the model itself
      let colorRule = '';
      if (profile.disliked_styles?.match(/only\s+(\w+)/i)) {
        const onlyColor = profile.disliked_styles.match(/only\s+(\w+)/i)[1];
        colorRule = `• Use ONLY ${onlyColor} items — all other colors are forbidden.`;
      } else if (profile.disliked_styles?.match(/except\s+(\w+)/i)) {
        const exceptColor = profile.disliked_styles.match(/except\s+(\w+)/i)[1];
        colorRule = `• Exclude every color except ${exceptColor}.`;
      }

      // 🔹 Explicitly enforce fit preferences
      let fitRule = '';
      if (profile.fit_preferences?.length) {
        fitRule = `• Allow ONLY these fits: ${profile.fit_preferences.join(
          ', ',
        )}; exclude all others.`;
      }

      return `
# USER PROFILE CONSTRAINTS (Hard Rules)

${fitRule}
${colorRule}

• Fit: ${fit || 'Regular fit'} — outfit items must match this silhouette; exclude all opposing fits.
• Climate: ${climate} — use materials and layers appropriate to this temperature zone.
• Preferred brands: ${brands || '—'} — bias all product searches toward these or comparable aesthetics.
• Favorite colors: ${colors || '—'} — bias color palette to these tones; avoid disliked colors.
• Disliked styles: ${dislikes || '—'} — exclude these aesthetics entirely.
• Style & vibe keywords: ${styles || '—'} — reflect these qualities in overall tone and accessories.
• Goals: ${goals}
• Body & proportions: ${profile.body_type || '—'}, ${
        profile.proportions || '—'
      } — ensure silhouette and layering suit these proportions.
• Skin tone / hair / eyes: ${profile.skin_tone || '—'}, ${
        profile.hair_color || '—'
      }, ${profile.eye_color || '—'} — choose tones that complement.

${(() => {
  const hardRules: string[] = [];
  const covNoGo = Array.isArray(profile.coverage_no_go)
    ? profile.coverage_no_go
    : [];
  const avCol = Array.isArray(profile.avoid_colors) ? profile.avoid_colors : [];
  const avMat = Array.isArray(profile.avoid_materials)
    ? profile.avoid_materials
    : [];
  if (covNoGo.length > 0)
    hardRules.push(`HARD RULE — Coverage restrictions: ${covNoGo.join(', ')}`);
  if (avCol.length > 0)
    hardRules.push(`HARD RULE — NEVER use these colors: ${avCol.join(', ')}`);
  if (avMat.length > 0)
    hardRules.push(
      `HARD RULE — NEVER use these materials: ${avMat.join(', ')}`,
    );
  if (profile.formality_floor && profile.formality_floor !== 'No minimum')
    hardRules.push(`HARD RULE — Minimum formality: ${profile.formality_floor}`);
  if (
    profile.walkability_requirement &&
    profile.walkability_requirement !== 'Low'
  )
    hardRules.push(
      `HARD RULE — Walkability: ${profile.walkability_requirement}`,
    );
  const patPrefs = Array.isArray(profile.pattern_preferences)
    ? profile.pattern_preferences
    : [];
  const avPat = Array.isArray(profile.avoid_patterns)
    ? profile.avoid_patterns
    : [];
  if (patPrefs.length > 0)
    hardRules.push(`• Preferred patterns: ${patPrefs.join(', ')}`);
  if (avPat.length > 0) hardRules.push(`• Avoid patterns: ${avPat.join(', ')}`);
  if (profile.silhouette_preference)
    hardRules.push(`• Silhouette preference: ${profile.silhouette_preference}`);
  if (profile.budget_min != null || profile.budget_max != null)
    hardRules.push(
      `• Budget range: ${profile.budget_min ?? '?'}–${profile.budget_max ?? '?'}`,
    );
  return hardRules.join('\n');
})()}
`;
    }

    // 1) Analyze uploaded image
    const analysis = await this.analyze(image_url);
    const tags = analysis?.tags || [];

    //   const { rows: wardrobe } = await pool.query(
    //     `SELECT name, main_category AS category, subcategory, color, material
    //  FROM wardrobe_items
    //  WHERE user_id::text = $1
    //  ORDER BY updated_at DESC
    //  LIMIT 50`,
    //     [user_id],
    //   );

    // 🚫 Skip wardrobe entirely for personalized mode
    const wardrobe: any[] = [];

    const prefRes = await pool.query(
      `SELECT gender_presentation
     FROM users
     WHERE id = $1
     LIMIT 1`,
      [user_id],
    );
    const profile = prefRes.rows[0] || {};
    const gender = user_gender || profile.gender_presentation || 'neutral';
    // 2️⃣ Fetch user style profile (full data used for personalization)
    const styleProfileRes = await pool.query(
      `
  SELECT
    body_type,
    skin_tone,
    undertone,
    climate,
    color_preferences AS favorite_colors,
    disliked_styles,
    style_keywords,
    preferred_brands,
    goals,
    proportions,
    hair_color,
    eye_color,
    height,
    waist,
    fit_preferences,
    style_preferences,
    coverage_no_go,
    avoid_colors,
    avoid_materials,
    formality_floor,
    walkability_requirement,
    pattern_preferences,
    avoid_patterns,
    silhouette_preference,
    budget_min,
    budget_max
  FROM style_profiles
  WHERE user_id::text = $1
  LIMIT 1
`,
      [user_id],
    );

    const styleProfile = styleProfileRes.rows[0] || {};

    // 🔹 Build user filter preferences
    const { preferFit, bannedWords } = buildUserFilter(styleProfile);

    /* ------------------------------------------------------------
   🎛️ VISUAL + STYLE FILTERING HELPERS
-------------------------------------------------------------*/
    const FIT_KEYWORDS = {
      skinny: [/skinny/i, /super[- ]skinny/i, /spray[- ]on/i],
      slim: [/slim/i],
      tailored: [/tailored/i, /tapered/i],
      relaxed: [/relaxed/i, /loose/i, /baggy/i, /wide[- ]leg/i],
      oversized: [/oversized/i, /boxy/i],
    };

    function buildUserFilter(profile: any) {
      const fitPrefs = (profile.fit_preferences || []).map((x: string) =>
        x.toLowerCase(),
      );
      const disliked = (profile.disliked_styles || '')
        .toLowerCase()
        .split(/[,\s]+/)
        .filter(Boolean);
      const favColors = (profile.favorite_colors || []).map((x: string) =>
        x.toLowerCase(),
      );

      const preferFit =
        fitPrefs.find((f) => /(relaxed|loose|baggy|oversized|boxy)/.test(f)) ||
        fitPrefs.find((f) => /(regular|tailored)/.test(f)) ||
        fitPrefs[0] ||
        null;

      const banFits: string[] = [];
      if (preferFit?.match(/relaxed|loose|baggy|oversized|boxy/))
        banFits.push('skinny', 'slim');
      else if (preferFit?.match(/skinny|slim/))
        banFits.push('relaxed', 'baggy', 'oversized');

      const bannedWords = [
        ...disliked,
        ...banFits,
        ...(!favColors.includes('green') ? ['green'] : []),
      ]
        .filter(Boolean)
        .map((x) => new RegExp(x, 'i'));

      return { preferFit, bannedWords };
    }

    function enforceProfileFilters(
      products: any[] = [],
      preferFit?: string | null,
      bannedWords: RegExp[] = [],
    ) {
      if (!products.length) return products;

      return products
        .filter((p) => {
          const hay = `${p.title || ''} ${p.name || ''} ${p.description || ''}`;
          return !bannedWords.some((rx) => rx.test(hay));
        })
        .sort((a, b) => {
          if (!preferFit) return 0;
          const aHit = FIT_KEYWORDS[preferFit]?.some((rx) =>
            rx.test(`${a.title} ${a.name}`),
          )
            ? 1
            : 0;
          const bHit = FIT_KEYWORDS[preferFit]?.some((rx) =>
            rx.test(`${b.title} ${b.name}`),
          )
            ? 1
            : 0;
          return bHit - aHit; // boost preferred fits
        });
    }

    // 3) Ask model to split into "owned" vs "missing"

    const climateNote = styleProfile.climate
      ? `The user's climate is ${styleProfile.climate}.
    If it is cold (like Polar or Cold), emphasize insulated materials, coats, layers, scarves, gloves, and boots.
    If it is hot (like Tropical or Desert), emphasize breathable, lightweight fabrics and open footwear.`
      : '';

    // 🛍️ SHOPPING ASSISTANT: Fetch detailed wardrobe items for specific gap analysis
    let wardrobeItems = [];
    try {
      const result = await pool.query(
        `SELECT name, main_category, subcategory, color, material
         FROM wardrobe_items
         WHERE user_id::text = $1
         ORDER BY main_category, updated_at DESC
         LIMIT 200`,
        [user_id],
      );
      wardrobeItems = result.rows || [];
      console.log(
        '🛍️ [personalizedShop] Wardrobe query executed:',
        wardrobeItems.length,
        'items found',
      );
    } catch (err) {
      console.error('🛍️ [personalizedShop] ERROR fetching wardrobe:', err);
      wardrobeItems = [];
    }

    // 🛍️ Build detailed wardrobe inventory with actual item names
    const wardrobeByCategory = wardrobeItems.reduce((acc: any, item: any) => {
      const category = item.main_category || 'Other';
      if (!acc[category]) acc[category] = [];
      acc[category].push({
        name: item.name,
        color: item.color,
        material: item.material,
        subcategory: item.subcategory,
      });
      return acc;
    }, {});

    // 🛍️ Format detailed inventory: show actual items user owns
    const detailedInventory = Object.entries(wardrobeByCategory)
      .map(([category, items]: [string, any]) => {
        const itemList = items
          .slice(0, 10) // Show top 10 items per category
          .map((i: any) => `${i.name}${i.color ? ` (${i.color})` : ''}`)
          .join(', ');
        const moreCount =
          items.length > 10 ? ` +${items.length - 10} more` : '';
        return `• **${category}**: ${itemList}${moreCount}`;
      })
      .join('\n');

    // 🛍️ Count by category to identify major gaps
    const categoryStats = Object.entries(wardrobeByCategory)
      .map(([cat, items]: [string, any]) => `${cat} (${items.length})`)
      .join(', ');

    const wardrobeContext = `# CRITICAL: SPECIFIC, PERSONALIZED RECOMMENDATIONS ONLY
NEVER make generic suggestions. ALWAYS be specific about WHY each item is needed.

${
  wardrobeItems.length > 0
    ? `## USER'S EXISTING WARDROBE - SPECIFIC ITEMS & QUANTITIES
Category totals: ${categoryStats}

Actual items owned:
${detailedInventory}

REFERENCE ACTUAL ITEMS: Name specific pieces from their wardrobe in your reasons.`
    : `## NO WARDROBE DATA AVAILABLE YET
The user has not yet added items to their wardrobe. STILL be specific by:
- Referencing the uploaded image aesthetic
- Referencing their stated style preferences and goals
- Suggesting items that fill SPECIFIC functional gaps (e.g., "You have no layering pieces")
- Being explicit about COLOR, MATERIAL, and FIT choices`
}

## MANDATORY SPECIFICITY RULES FOR ALL RECOMMENDATIONS:
1. EVERY recommendation MUST state WHY it's needed (avoid generic words like "elevates" or "completes")
   ✓ GOOD: "Adds neutral bottoms in cotton - all your existing pieces are dark structured items"
   ✓ GOOD: "For layering in moderate weather - fills temperature transition gap"
   ✗ BAD: "Elevates your wardrobe"
   ✗ BAD: "Completes your basics"

2. REFERENCE THE UPLOADED IMAGE in your reasoning:
   ✓ "Complements the [specific color/style] aesthetic from your image"
   ✓ "Works with the [silhouette] style you showed interest in"

3. BE SPECIFIC ABOUT USE CASE:
   ✓ "For [occasion/weather/activity]"
   ✓ "Pairs with [type of items most people own]"
   ✗ "Just adds to your collection"

4. MENTION SPECIFIC COLORS/MATERIALS/FIT:
   ✓ "Adds [specific color] in [material] which [specific reason]"
   ✓ "Camel-toned [fit] [garment] for [climate/use]"

## EXAMPLE GOOD REASONS:
- "Neutral base layer in cream linen for the minimalist aesthetic you showed"
- "Adds breathable layering piece in cotton for warm weather - pairs with your smart-casual style"
- "Complements the crisp formal vibe of your image; adds structured elegance"
- "Provides casual footwear in canvas - versatile neutral that works with most styles"`;

    // 🔒 Enforced personalization hierarchy
    const rules = `
    # PERSONALIZATION ENFORCEMENT
    Follow these user preferences as *absolute constraints*, not suggestions.
    `;

    const profileConstraints = buildProfileConstraints(styleProfile);

    const prompt = `
You are a world-class personal stylist analyzing user's wardrobe gaps and recommending strategic purchases.
${rules}
${profileConstraints}

# IMAGE INSPIRATION
• Use the uploaded image as inspiration for aesthetic direction (color story, silhouette, vibe).
• Respect all style profile constraints exactly.
• Maintain the same mood and spirit as the uploaded image.

${wardrobeContext}

# STRATEGIC SHOPPING RECOMMENDATIONS - MUST BE SPECIFIC
For EACH recommendation, you MUST:
1. Reference 2-3 actual items from their wardrobe by NAME (e.g., "pairs with the gray cardigans")
2. State the SPECIFIC GAP you're filling (e.g., "you have 12 tops but only 3 bottoms")
3. Name the CATEGORY imbalance (e.g., "all your pants are dark - this adds a neutral option")
4. Explain what they'll USE it WITH (e.g., "complements your existing navy blazer collection")

CRITICAL: NO VAGUE REASONS. These are REQUIRED:
❌ WRONG: "Elevates your wardrobe"
✅ RIGHT: "Works with your navy blazers and black pants; adds the warm-toned bottom option you lack"

❌ WRONG: "Completes your basics"
✅ RIGHT: "You own 8 tops (grays, blacks, white) but only 2 bottoms - this adds jean variety"

❌ WRONG: "Fills a style gap"
✅ RIGHT: "Your wardrobe is mostly structured pieces (blazers, cardigans) - this adds the relaxed layer you need"

# OUTPUT RULES
- ALWAYS output a complete outfit with distinct Top, Bottom, Shoes, and (if seasonally appropriate) Outerwear and Accessories.
- Each piece must include category, item, color, fit, and a SPECIFIC reason
- suggested_purchases reasons MUST name actual wardrobe items and specific gaps
- gap_analysis must list 2-3 concrete imbalances found in their wardrobe

Return ONLY valid JSON:
{
  "recreated_outfit": [
    { "source":"purchase", "category":"Top", "item":"...", "color":"...", "fit":"..." }
  ],
  "suggested_purchases": [
    { "category":"...", "item":"...", "color":"...", "material":"...", "brand":"...", "fit":"...", "reason":"Why this fills a gap or completes their style", "shopUrl":"..." }
  ],
  "style_note": "Explain the gap analysis, what's missing from their wardrobe, and how these purchases strengthen their styling foundation.",
  "gap_analysis": "Concise summary of 2-3 key wardrobe gaps being addressed"
}

User gender: ${gender}
Detected tags (inspiration from uploaded look): ${tags.join(', ')}
User style profile: ${JSON.stringify(styleProfile, null, 2)}
${climateNote}
`;

    console.log('🧥 [personalizedShop] profile:', profile);
    console.log('🧥 [personalizedShop] gender:', gender);
    console.log('🧥 [personalizedShop] styleProfile:', styleProfile);
    console.log('🛍️ [personalizedShop] WARDROBE DATA SENT TO AI:');
    console.log('   Category totals:', categoryStats);
    console.log('   Items found:', wardrobeItems.length);
    if (wardrobeItems.length > 0) {
      console.log(
        '   Sample items:',
        wardrobeItems
          .slice(0, 5)
          .map((w: any) => `${w.name} (${w.color})`)
          .join(', '),
      );
    }
    console.log('🧠 [personalizedShop] Prompt preview:', prompt.slice(0, 800));

    // 🧠 DEBUG START — prompt verification
    console.log('─────────────── PROMPT SENT TO MODEL ───────────────');
    console.log(prompt);
    console.log('─────────────── END PROMPT ───────────────');

    const completion = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.7,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
    });

    // 🧠 DEBUG END — raw model output
    console.log('─────────────── RAW MODEL RESPONSE ───────────────');
    console.log(completion.choices[0]?.message?.content);
    console.log('─────────────── END RESPONSE ───────────────');

    let parsed: any = {};
    try {
      parsed = JSON.parse(completion.choices[0]?.message?.content || '{}');

      // 🧩 SAFETY GUARD — ensure we keep valid recreated_outfit
      try {
        const parsedKeys = Object.keys(parsed);
        console.log('✅ [personalizedShop] Parsed JSON keys:', parsedKeys);

        // If model used "outfit" instead of "recreated_outfit", normalize it
        if (!parsed.recreated_outfit && parsed.outfit) {
          parsed.recreated_outfit = parsed.outfit;
          console.log('✅ [personalizedShop] Mapped outfit → recreated_outfit');
        }

        // Double-check array validity before fallback clears it
        if (parsed.recreated_outfit && parsed.recreated_outfit.length > 0) {
          console.log(
            '✅ [personalizedShop] Using recreated_outfit from model',
          );
        } else {
          console.warn(
            '⚠️ [personalizedShop] No recreated_outfit found — fallback may trigger',
          );
        }
      } catch (err) {
        console.error(
          '❌ [personalizedShop] JSON structure guard failed:',
          err,
        );
      }

      // ✅ Final filter fix — keep wardrobe items but still respect banned fits/styles
      if (parsed?.recreated_outfit?.length) {
        parsed.recreated_outfit = parsed.recreated_outfit.filter((o: any) => {
          if (!o) return false;
          const text =
            `${o.item} ${o.category} ${o.color} ${o.fit}`.toLowerCase();
          if (!text.trim() || text.includes('undefined')) return false;
          // ✅ Always keep wardrobe items regardless of style bans
          if (o.source === 'wardrobe') return true;

          const fitBan = preferFit?.match(/relaxed|oversized|boxy|loose/)
            ? ['skinny']
            : preferFit?.match(/skinny|slim|tailored/)
              ? ['relaxed', 'baggy', 'oversized']
              : [];

          const styleBan =
            (styleProfile.disliked_styles || '')
              .toLowerCase()
              .split(/[,\s]+/)
              .filter(Boolean) || [];

          const banned = [...fitBan, ...styleBan];
          return !banned.some((b) => text.includes(b));
        });

        console.log(
          '✅ [personalizedShop] Final filtered outfit →',
          parsed.recreated_outfit,
        );
      }

      console.log(
        '💎 [personalizedShop] Parsed recreated outfit sample:',
        parsed?.recreated_outfit?.slice(0, 2),
      );
      console.log(
        '💎 [personalizedShop] Parsed suggested purchases sample:',
        parsed?.suggested_purchases?.slice(0, 2),
      );

      // 🧩 Merge recreated_outfit into suggested_purchases for display
      if (
        Array.isArray(parsed?.recreated_outfit) &&
        parsed.recreated_outfit.length
      ) {
        parsed.suggested_purchases = [
          ...(parsed.suggested_purchases || []),
          ...parsed.recreated_outfit.map((o: any) => ({
            ...o,
            brand: o.brand || '—',
            previewImage: o.previewImage || o.image || o.image_url || null,
            source: 'purchase',
          })),
        ];
        console.log(
          '🧩 [personalizedShop] merged recreated_outfit → suggested_purchases',
        );
      }

      // 🖼️ Ensure every recreated outfit item has a visible preview image
      if (Array.isArray(parsed?.recreated_outfit)) {
        parsed.recreated_outfit = parsed.recreated_outfit.map((item: any) => {
          if (!item.previewImage && item.source === 'wardrobe') {
            item.previewImage =
              item.image_url ||
              item.wardrobe_image ||
              'https://upload.wikimedia.org/wikipedia/commons/a/ac/No_image_available.svg';
          }
          return item;
        });
      }

      // 🎨 Enforce "only <color>" rule from disliked_styles (e.g. "I dislike all colors except pink")
      // 🎨 Optional color-only enforcement — only if explicit "ONLY <color>" flag exists
      if (styleProfile?.disliked_styles?.toLowerCase().includes('only')) {
        const match = styleProfile.disliked_styles.match(/only\s+(\w+)/i);
        if (match) {
          const onlyColor = match[1].toLowerCase();
          const filterColor = (arr: any[]) =>
            arr.filter((x) =>
              (x.color || '').toLowerCase().includes(onlyColor),
            );

          if (Array.isArray(parsed?.recreated_outfit))
            parsed.recreated_outfit = filterColor(parsed.recreated_outfit);
          if (Array.isArray(parsed?.suggested_purchases))
            parsed.suggested_purchases = filterColor(
              parsed.suggested_purchases,
            );

          console.log(
            `[personalizedShop] 🎨 Enforcing ONLY-color rule: ${onlyColor}`,
          );
        }
      }
    } catch {
      parsed = {};
    }

    const purchases = Array.isArray(parsed?.suggested_purchases)
      ? parsed.suggested_purchases
      : [];

    if (parsed?.recreated_outfit?.some((i: any) => i.source === 'wardrobe')) {
      console.log('🧥 [personalizedShop] ✅ Model reused wardrobe pieces.');
    } else {
      console.warn(
        '🧥 [personalizedShop] ⚠️ Model did NOT reuse wardrobe — fallback to generic recreation.',
      );
    }

    // 🚫 Enforce profile bans in returned outfit
    const banned = [
      ...(styleProfile.disliked_styles?.toLowerCase().split(/[,\s]+/) || []),
      ...(preferFit?.match(/relaxed|oversized|boxy|loose/)
        ? ['skinny', 'slim']
        : []),
      ...(preferFit?.match(/skinny|slim/)
        ? ['relaxed', 'oversized', 'baggy']
        : []),
    ].filter(Boolean);

    if (parsed?.recreated_outfit?.length) {
      // ✅ Keep *all* wardrobe and purchase items — only filter garbage entries
      parsed.recreated_outfit = parsed.recreated_outfit.filter((o: any) => {
        if (!o || !o.item) return false;
        const text =
          `${o.item} ${o.category} ${o.color} ${o.fit}`.toLowerCase();
        return text.trim().length > 0 && !text.includes('undefined');
      });

      // 🧱 Guarantee full outfit completeness (Top, Bottom, Shoes, Optional Outerwear/Accessory)
      const categories = parsed.recreated_outfit.map((o: any) =>
        o.category?.toLowerCase(),
      );
      const missing: any[] = [];

      if (!categories.includes('top'))
        missing.push({
          source: 'purchase',
          category: 'Top',
          item: 'White Oxford Shirt',
          color: 'White',
          fit: 'Slim Fit',
        });
      if (!categories.includes('bottoms'))
        missing.push({
          source: 'purchase',
          category: 'Bottoms',
          item: 'Beige Chinos',
          color: 'Beige',
          fit: 'Slim Fit',
        });
      if (!categories.includes('shoes'))
        missing.push({
          source: 'purchase',
          category: 'Shoes',
          item: 'White Leather Sneakers',
          color: 'White',
          fit: 'Slim Fit',
        });

      parsed.recreated_outfit.push(...missing);

      console.log(
        '✅ [personalizedShop] Final full outfit →',
        parsed.recreated_outfit,
      );
    }

    // 🧩 Centralized enforcement for personalizedShop only
    function applyProfileFilters(products: any[], profile: any) {
      if (!Array.isArray(products) || !products.length) return [];

      const favColors = (profile.favorite_colors || []).map((x: string) =>
        x.toLowerCase(),
      );
      const prefBrands = (profile.preferred_brands || []).map((x: string) =>
        x.toLowerCase(),
      );
      const fitPrefs = (profile.fit_preferences || []).map((x: string) =>
        x.toLowerCase(),
      );
      const dislikes = (profile.disliked_styles || '')
        .toLowerCase()
        .split(/[,\s]+/);
      const climate = (profile.climate || '').toLowerCase();

      const isCold = /(polar|cold|arctic|tundra|winter)/.test(climate);
      const isHot = /(tropical|desert|hot|humid|summer)/.test(climate);

      // 🩷 detect "only" or "except" color rule from disliked_styles
      let onlyColor: string | null = null;
      let exceptColor: string | null = null;

      if (profile.disliked_styles?.match(/only\s+(\w+)/i)) {
        onlyColor = profile.disliked_styles
          .match(/only\s+(\w+)/i)[1]
          .toLowerCase();
      } else if (profile.disliked_styles?.match(/except\s+(\w+)/i)) {
        exceptColor = profile.disliked_styles
          .match(/except\s+(\w+)/i)[1]
          .toLowerCase();
      }

      return products
        .filter((p) => {
          const t = `${p.name ?? ''} ${p.title ?? ''} ${p.brand ?? ''} ${
            p.description ?? ''
          } ${p.color ?? ''} ${p.fit ?? ''}`.toLowerCase();

          // 🚫 Filter out disliked words/styles
          if (dislikes.some((d) => d && t.includes(d))) return false;

          // 🎨 HARD color enforcement from DB rules
          if (onlyColor) {
            // Only allow if text or color includes the specified color
            if (
              !t.includes(onlyColor) &&
              !p.color?.toLowerCase().includes(onlyColor)
            )
              return false;
          } else if (exceptColor) {
            // Exclude everything not matching that color
            if (
              !t.includes(exceptColor) &&
              !p.color?.toLowerCase().includes(exceptColor)
            )
              return false;
          } else {
            // Normal favorite color bias if no hard rule
            if (favColors.length && !favColors.some((c) => t.includes(c)))
              return false;
          }

          // 👕 Fit preferences
          if (fitPrefs.length && !fitPrefs.some((f) => t.includes(f)))
            return false;

          // 🌡️ Climate-based filtering
          if (isCold && /(tank|shorts|sandal)/.test(t)) return false;
          if (isHot && /(wool|parka|coat|boot|knit)/.test(t)) return false;

          return true;
        })
        .sort((a, b) => {
          const score = (x: any) => {
            const txt =
              `${x.name} ${x.title} ${x.brand} ${x.color} ${x.fit}`.toLowerCase();
            let s = 0;
            if (onlyColor && txt.includes(onlyColor)) s += 4;
            if (exceptColor && txt.includes(exceptColor)) s += 4;
            if (favColors.some((c) => txt.includes(c))) s += 2;
            if (prefBrands.some((b) => txt.includes(b))) s += 2;
            if (fitPrefs.some((f) => txt.includes(f))) s += 1;
            return s;
          };
          return score(b) - score(a);
        });
    }

    // 4️⃣ Attach live shop links to the "missing" items — now honoring user taste
    let enrichedPurchases = await Promise.all(
      purchases.map(async (p: any) => {
        // 🧠 Gender-locked prefix
        const genderPrefix =
          gender?.toLowerCase().includes('female') ||
          gender?.toLowerCase().includes('woman')
            ? 'women female womens ladies'
            : 'men male mens masculine -women -womens -female -girls -ladies';

        // Base query with gender lock
        let q = [
          genderPrefix,
          p.item || p.category || '',
          p.color || '',
          p.material || '',
        ]
          .filter(Boolean)
          .join(' ')
          .trim();

        // 🔹 Inject personalization bias terms
        const brandTerms = (styleProfile.preferred_brands || [])
          .slice(0, 3)
          .join(' ');
        const colorTerms = (styleProfile.favorite_colors || [])
          .slice(0, 2)
          .join(' ');
        const fitTerms = Array.isArray(styleProfile.fit_preferences)
          ? styleProfile.fit_preferences.join(' ')
          : styleProfile.fit_preferences || '';

        // 🎨 “Only color” rule (e.g. “I dislike all colors except pink”)
        const colorMatch =
          styleProfile.disliked_styles?.match(/except\s+(\w+)/i);
        if (colorMatch) {
          const onlyColor = colorMatch[1].toLowerCase();
          q += ` ${onlyColor}`;
        }

        // Combine into final query with brand + color + fit bias
        q = [q, brandTerms, colorTerms, fitTerms].filter(Boolean).join(' ');

        // 🔒 Ensure all queries exclude female results explicitly
        if (
          !/-(women|female|ladies|girls)/i.test(q) &&
          /\bmen\b|\bmale\b/i.test(q)
        ) {
          q += ' -women -womens -female -girls -ladies';
        }

        // Combine into final query with brand + color + fit bias
        q = [q, brandTerms, colorTerms, fitTerms].filter(Boolean).join(' ');

        // 🔒 Ensure all queries exclude female results explicitly
        if (
          !/-(women|female|ladies|girls)/i.test(q) &&
          /\bmen\b|\bmale\b/i.test(q)
        ) {
          q += ' -women -womens -female -girls -ladies';
        }

        // 🧠 Gender-aware product search
        let products = await this.productSearch.search(
          q,
          gender?.toLowerCase() === 'female'
            ? 'female'
            : gender?.toLowerCase() === 'male'
              ? 'male'
              : 'unisex',
        );

        // 🚫 Filter out any accidental female/unisex results
        products = products.filter(
          (prod) =>
            !/women|female|womens|ladies|girls/i.test(
              `${prod.name ?? ''} ${prod.brand ?? ''} ${prod.title ?? ''}`,
            ),
        );

        // 🩷 Hard visual color filter — ensures displayed products actually match the enforced color rule
        if (
          styleProfile?.disliked_styles?.match(/only\s+(\w+)/i) ||
          styleProfile?.disliked_styles?.match(/except\s+(\w+)/i)
        ) {
          const match =
            styleProfile.disliked_styles.match(/only\s+(\w+)/i) ||
            styleProfile.disliked_styles.match(/except\s+(\w+)/i);
          const enforcedColor = match?.[1]?.toLowerCase();
          if (enforcedColor) {
            products = products.filter((p) => {
              const text =
                `${p.name ?? ''} ${p.title ?? ''} ${p.color ?? ''}`.toLowerCase();
              return text.includes(enforcedColor);
            });
          }
        }

        return {
          ...p,
          query: q,
          products: applyProfileFilters(products, styleProfile),
        };
      }),
    );

    // 5️⃣ Fallback enrichment if AI returned nothing or products failed
    if (!enrichedPurchases.length) {
      console.warn(
        '⚠️ [personalizedShop] Empty suggested_purchases → fallback.',
      );

      const tagSeed = tags.slice(0, 6).join(' ');
      const season = getCurrentSeason();

      // 🧠 Gender prefix for fallback with hard lock
      const genderPrefix =
        gender?.toLowerCase().includes('female') ||
        gender?.toLowerCase().includes('woman')
          ? 'women female womens ladies'
          : 'men male mens masculine -women -womens -female -girls -ladies';

      // 🧠 Enrich fallback with style taste as well
      const brandTerms = (styleProfile.preferred_brands || [])
        .slice(0, 3)
        .join(' ');
      const colorTerms = (styleProfile.favorite_colors || [])
        .slice(0, 2)
        .join(' ');
      const fitTerms = Array.isArray(styleProfile.fit_preferences)
        ? styleProfile.fit_preferences.join(' ')
        : styleProfile.fit_preferences || '';

      const fallbackQuery = `${genderPrefix} ${tagSeed} ${season} fashion ${brandTerms} ${colorTerms} ${fitTerms}`;
      console.log('🧩 [personalizedShop] fallbackQuery →', fallbackQuery);

      const products = await this.productSearch.search(
        fallbackQuery,
        gender?.toLowerCase() === 'female'
          ? 'female'
          : gender?.toLowerCase() === 'male'
            ? 'male'
            : 'unisex',
      );

      // 🚫 Filter out any accidental female/unisex results
      const maleProducts = products.filter(
        (prod) =>
          !/women|female|womens|ladies|girls/i.test(
            `${prod.name ?? ''} ${prod.brand ?? ''} ${prod.title ?? ''}`,
          ),
      );

      enrichedPurchases = [
        {
          category: 'General',
          item: 'Curated Outfit Add-Ons',
          color: 'Mixed',
          material: null,
          products: applyProfileFilters(maleProducts.slice(0, 8), styleProfile),
          query: fallbackQuery,
          source: 'fallback',
        },
      ];
    }

    // 🎨 Enforce color-only rule on fallback products too
    if (styleProfile?.disliked_styles) {
      const match = styleProfile.disliked_styles.match(/except\s+(\w+)/i);
      if (match) {
        const onlyColor = match[1].toLowerCase();
        enrichedPurchases = enrichedPurchases.map((p) => ({
          ...p,
          products: (p.products || []).filter((prod) =>
            (prod.color || '').toLowerCase().includes(onlyColor),
          ),
        }));
        console.log(
          `[personalizedShop] 🎨 Enforced fallback color-only rule: ${onlyColor}`,
        );
      }
    }

    const cleanPurchases = enrichedPurchases.map((p) => ({
      ...p,
      products: this.fixProductImages(
        enforceProfileFilters(p.products || [], preferFit, bannedWords),
      ),
    }));

    // 🎨 FINAL VISUAL CONSISTENCY NORMALIZATION
    const normalizedPurchases = await Promise.all(
      enrichedPurchases.map(async (p) => {
        const validProduct =
          (p.products || []).find(
            (x) =>
              (x.image ||
                x.image_url ||
                x.thumbnail ||
                x.serpapi_thumbnail ||
                x.thumbnail_url ||
                x.img ||
                x.result?.thumbnail ||
                x.result?.serpapi_thumbnail) &&
              /^https?:\/\//.test(
                x.image ||
                  x.image_url ||
                  x.thumbnail ||
                  x.serpapi_thumbnail ||
                  x.thumbnail_url ||
                  x.img ||
                  x.result?.thumbnail ||
                  x.result?.serpapi_thumbnail ||
                  '',
              ) &&
              !/no[_-]?image/i.test(
                x.image ||
                  x.image_url ||
                  x.thumbnail ||
                  x.serpapi_thumbnail ||
                  x.thumbnail_url ||
                  x.img ||
                  '',
              ),
          ) || p.products?.[0];

        let previewImage =
          validProduct?.image ||
          validProduct?.image_url ||
          validProduct?.thumbnail ||
          validProduct?.serpapi_thumbnail ||
          validProduct?.thumbnail_url ||
          validProduct?.img ||
          validProduct?.product_thumbnail ||
          validProduct?.result?.thumbnail ||
          validProduct?.result?.serpapi_thumbnail ||
          null;

        // 🎯 Gender-aware image guard
        const userGender = (gender || '').toLowerCase();

        if (previewImage) {
          const url = previewImage.toLowerCase();

          // 🧍‍♂️ If male → block clearly female-coded URLs
          if (
            userGender.includes('male') &&
            /(women|woman|female|ladies|girls|womenswear|femme|skims|shein|fashionnova|princesspolly|revolve|anthropologie)/i.test(
              url,
            )
          ) {
            previewImage =
              'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg';
          }

          // 🧍‍♀️ If female → block clearly male-coded URLs
          else if (
            userGender.includes('female') &&
            /(men|man|male|menswear|masculine)/i.test(url)
          ) {
            previewImage =
              'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg';
          }

          // 🧍 Unisex → allow all images
        }

        // 🧠 If still missing, do a quick SerpAPI lookup and cache
        if (!previewImage && p.query) {
          const results = await this.productSearch.searchSerpApi(p.query);
          const r = results?.[0];
          previewImage =
            r?.image ||
            r?.image_url ||
            r?.thumbnail ||
            r?.serpapi_thumbnail ||
            r?.thumbnail_url ||
            r?.result?.thumbnail ||
            r?.result?.serpapi_thumbnail ||
            null;

          // 🎯 Apply same gender guard to SerpAPI result
          if (previewImage) {
            const url = previewImage.toLowerCase();

            if (
              userGender.includes('male') &&
              /(women|woman|female|ladies|girls|womenswear|femme|skims|shein|fashionnova|princesspolly|revolve|anthropologie)/i.test(
                url,
              )
            ) {
              previewImage =
                'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg';
            } else if (
              userGender.includes('female') &&
              /(men|man|male|menswear|masculine)/i.test(url)
            ) {
              previewImage =
                'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg';
            }
          }
        }

        return {
          ...p,
          previewImage:
            previewImage ||
            'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg',
          previewBrand: validProduct?.brand || p.brand || 'Unknown',
          previewPrice: validProduct?.price || '—',
          previewUrl: validProduct?.shopUrl || p.shopUrl || null,
        };
      }),
    ); // ✅ ← closes Promise.all()

    // 🧹 remove empty product groups (no valid images)
    const filteredPurchases = normalizedPurchases.filter(
      (p) => !!p.previewImage,
    );

    // 🧊 Climate sanity check — if Polar but outfit lacks insulation, patch style_note
    if (
      styleProfile.climate?.toLowerCase().includes('polar') &&
      !/coat|jacket|parka|boot|knit|sweater/i.test(
        JSON.stringify(parsed.recreated_outfit || []),
      )
    ) {
      parsed.style_note +=
        ' Reinforced with insulated outerwear and cold-weather layering for Polar climates.';
    }

    // 🚫 Prevent fallback or secondary recreate() from overwriting personalized flow
    if (
      enrichedPurchases?.length > 0 ||
      parsed?.suggested_purchases?.length > 0
    ) {
      console.log(
        '✅ [personalizedShop] Finalizing personalized results — skipping generic recreate()',
      );
      return {
        user_id,
        image_url,
        tags,
        recreated_outfit: parsed?.recreated_outfit || [],
        suggested_purchases: normalizedPurchases,
        style_note:
          parsed?.style_note ||
          'Personalized recreation based on your wardrobe, with curated seasonal add-ons.',
        gap_analysis: parsed?.gap_analysis || null,
        applied_filters: {
          preferFit,
          bannedWords: bannedWords.map((r) => r.source),
        },
      };
    }

    return {
      user_id,
      image_url,
      tags,
      recreated_outfit: parsed?.recreated_outfit || [],
      suggested_purchases: normalizedPurchases,
      style_note:
        parsed?.style_note ||
        'Personalized recreation based on your wardrobe, with curated seasonal add-ons.',
      gap_analysis: parsed?.gap_analysis || null,
      applied_filters: {
        preferFit,
        bannedWords: bannedWords.map((r) => r.source),
      },
    };
  }

  ////////END CREATE LOOK

  //////. START REPLACED CHAT WITH LINKS AND SEARCH NET
  async chat(dto: ChatDto) {
    const { messages, user_id } = dto;
    const lastUserMsg = messages
      .slice()
      .reverse()
      .find((m) => m.role === 'user')?.content;

    if (!lastUserMsg) {
      throw new Error('No user message provided');
    }

    /* 🔍 --- PHASE 0: Deterministic Inventory Short-Circuit (Tier 4.5) --- */
    const inventoryPatterns = [
      /^do i (have|own)\b/i,
      /^what (do )?i (have|own)\b/i,
      /^any\b.*\b(in my (closet|wardrobe))?\s*\??$/i,
      /^is there\b.*\b(in my (closet|wardrobe))?\s*\??$/i,
    ];
    const isInventoryQuery = inventoryPatterns.some((p) => p.test(lastUserMsg.trim()));
    if (isInventoryQuery) {
      // Extract search phrase: strip intent prefix and trailing punctuation
      const searchRaw = lastUserMsg
        .replace(/^(do i (have|own)|what (do )?i (have|own)|any|is there)\s*/i, '')
        .replace(/\b(in my (closet|wardrobe))\s*/i, '')
        .replace(/[?.!]+$/, '')
        .trim()
        .toLowerCase();
      // Simple plural normalization (hoodies→hoodie, pants stays pants, dresses→dress)
      const searchPhrase = searchRaw
        .replace(/ies$/, 'ie')       // hoodies → hoodie
        .replace(/([^s])ses$/, '$1se') // dresses → dress (preserve trailing e)
        .replace(/([^s])s$/, '$1');    // jackets → jacket (but not "pants")
      // console.log(`[AskStyla T4] inventory intent detected: "${searchPhrase}"`);

      try {
        const { rows: invRows } = await pool.query(
          `SELECT name FROM wardrobe_items WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
          [user_id],
        );
        if (invRows.length > 0) {
          const searchTokens = searchPhrase.split(/\s+/).filter((t) => t.length > 2);
          const matches = invRows.filter((r) => {
            const nameLower = (r.name || '').toLowerCase();
            // Full phrase match
            if (nameLower.includes(searchPhrase)) return true;
            // Token match: require at least 1 meaningful token
            return searchTokens.length > 0 && searchTokens.some((t) => nameLower.includes(t));
          });
          // console.log(`[AskStyla T4] inventory matches: ${JSON.stringify(matches.map((m) => m.name))}`);

          let reply: string;
          if (matches.length > 0) {
            const list = matches.map((m) => `  • ${m.name}`).join('\n');
            reply = `Yes — you have the following:\n\n${list}`;
          } else {
            reply = `I don't see any items matching "${searchPhrase}" in your wardrobe.`;
          }

          // Save user message + assistant reply
          try {
            await pool.query(
              `INSERT INTO chat_messages (user_id, role, content) VALUES ($1,$2,$3)`,
              [user_id, 'user', lastUserMsg],
            );
            await pool.query(
              `INSERT INTO chat_messages (user_id, role, content) VALUES ($1,$2,$3)`,
              [user_id, 'assistant', reply],
            );
          } catch (err: any) {
            console.warn('⚠️ inventory short-circuit: failed to save messages:', err.message);
          }

          return { reply, images: [], links: [] };
        }
        // No wardrobe items at all → fall through to normal GPT flow
        // console.log('[AskStyla T4] inventory: no wardrobe items, falling through to GPT');
      } catch (err: any) {
        // console.warn('[AskStyla T4] inventory query failed, falling through to GPT:', err.message);
      }
    }

    /* 🎯 --- SMART CONTEXT: Classify query to load only relevant data --- */
    const contextNeeds = {
      memory: true, // always load chat history
      styleProfile: false,
      wardrobe: false,
      calendar: false,
      savedLooks: false,
      feedback: false,
      wearHistory: false,
      scheduledOutfits: false,
      favorites: false,
      customOutfits: false,
      itemPrefs: false,
      lookMemories: false,
      notifications: false,
      weather: false,
    };

    // ── Tier 4: Deterministic routing (forces needs BEFORE classifier) ──
    const forcedNeeds = routeContextNeeds(lastUserMsg);
    for (const key of forcedNeeds) {
      if (key in contextNeeds) (contextNeeds as any)[key] = true;
    }
    if (forcedNeeds.length > 0) {
      // console.log(`[AskStyla T4] deterministic routing forced: ${JSON.stringify(forcedNeeds)}`);
    }

    try {
      const classifyRes = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0,
        max_tokens: 150,
        messages: [
          {
            role: 'system',
            content: `Classify what data is needed to answer this fashion/style question. Return JSON only.
Categories: styleProfile (body type, colors, preferences, fabrics, materials, patterns, avoid colors, avoid patterns, avoid materials, fit, brands, style icons, occasions, budget, boldness, comfort, measurements, skin tone, proportions), wardrobe (clothes owned, inventory, items count), calendar (events), savedLooks, feedback (outfit ratings), wearHistory (recently worn), scheduledOutfits, favorites, customOutfits, itemPrefs (liked/disliked items), lookMemories (style exploration), notifications, weather.
For general chat/greetings, return empty needs. For outfit suggestions, include styleProfile+wardrobe+weather.
IMPORTANT: Questions about "how many items", "what do I own", "my clothes", "my wardrobe", "closet", "inventory", or item counts MUST include wardrobe.
IMPORTANT: Any question about the user's preferences, style, body, measurements, fabrics, materials, patterns, colors they like/avoid, fit, brands, budget, or personal details MUST include styleProfile.`,
          },
          {
            role: 'user',
            content: `Query: "${lastUserMsg}"\n\nReturn JSON: {"needs": ["category1", "category2"]}`,
          },
        ],
      });
      const classifyContent = classifyRes.choices[0]?.message?.content || '{}';
      const parsed = JSON.parse(classifyContent.match(/\{.*\}/s)?.[0] || '{}');
      const needs: string[] = parsed.needs || [];

      // Map needs to contextNeeds
      needs.forEach((n: string) => {
        const key = n.toLowerCase().replace(/[^a-z]/g, '');
        if (key in contextNeeds) (contextNeeds as any)[key] = true;
      });

      // console.log(`[AskStyla Debug] classifier needs: ${JSON.stringify(needs)}, styleProfile=${contextNeeds.styleProfile}`);
      if (forcedNeeds.length > 0) {
        // console.log(`[AskStyla T4] merged needs — rule: ${JSON.stringify(forcedNeeds)}, classifier: ${JSON.stringify(needs)}`);
      }
      // ✅ Force-enable weather context if location or weather was passed
      if (dto.lat || dto.lon || dto.weather) {
        contextNeeds.weather = true;
      }
    } catch (err: any) {
      // Fallback: load everything if classification fails
      console.warn(
        '⚠️ Context classification failed, loading all:',
        err.message,
      );
      Object.keys(contextNeeds).forEach(
        (k) => ((contextNeeds as any)[k] = true),
      );
    }

    /* 🧠 --- MEMORY BLOCK START --- */
    try {
      // Save the latest user message
      await pool.query(
        `INSERT INTO chat_messages (user_id, role, content)
       VALUES ($1,$2,$3)`,
        [user_id, 'user', lastUserMsg],
      );

      // Fetch the last 10 messages for this user
      const { rows } = await pool.query(
        `SELECT role, content
       FROM chat_messages
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 10`,
        [user_id],
      );

      // Add them (chronological) to current messages for context
      const history = rows.reverse();
      for (const h of history) {
        if (h.content !== lastUserMsg)
          messages.unshift({ role: h.role, content: h.content });
      }

      // 🧹 Purge older messages beyond last 30
      await pool.query(
        `DELETE FROM chat_messages
       WHERE user_id = $1
       AND id NOT IN (
         SELECT id FROM chat_messages
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT 30
       );`,
        [user_id],
      );
    } catch (err: any) {
      console.warn('⚠️ chat history retrieval failed:', err.message);
    }
    /* 🧠 --- MEMORY BLOCK END --- */

    /* 🧠 --- LOAD LONG-TERM SUMMARY MEMORY (with Redis cache) --- */
    let longTermSummary = '';
    try {
      const cacheKey = `memory:${user_id}`;
      const cached = await redis.get<string>(cacheKey);

      if (cached) {
        // console.log(`🟢 Redis HIT for ${cacheKey}`);
        longTermSummary = cached;
      } else {
        // console.log(`🔴 Redis MISS for ${cacheKey} — fetching from Postgres`);
        const { rows } = await pool.query(
          `SELECT summary FROM chat_memory WHERE user_id = $1`,
          [user_id],
        );
        if (rows[0]?.summary) {
          longTermSummary = rows[0].summary;
          // console.log(`🟢 Caching summary in Redis for ${cacheKey}`);
          await redis.set(cacheKey, longTermSummary, { ex: 86400 });
        }
      }
    } catch (err: any) {
      console.warn(
        '⚠️ failed to load summary from Redis/Postgres:',
        err.message,
      );
    }

    /* 📅 --- LOAD CALENDAR EVENTS FOR CHAT CONTEXT --- */
    let calendarContext = '';
    if (contextNeeds.calendar)
      try {
        const { rows: calendarRows } = await pool.query(
          `SELECT title, start_date, end_date, location, notes
         FROM user_calendar_events
         WHERE user_id = $1
         AND start_date >= NOW()
         ORDER BY start_date ASC
         LIMIT 15`,
          [user_id],
        );
        if (calendarRows.length > 0) {
          const eventsList = calendarRows
            .map((e, i) => {
              const start = new Date(e.start_date);
              const dateStr = start.toLocaleDateString('en-US', {
                weekday: 'long',
                month: 'long',
                day: 'numeric',
                year: 'numeric',
              });
              const timeStr = start.toLocaleTimeString('en-US', {
                hour: '2-digit',
                minute: '2-digit',
                hour12: true,
              });
              let eventLine = `${i + 1}. "${e.title}" - ${dateStr} at ${timeStr}`;
              if (e.location) eventLine += ` @ ${e.location}`;
              if (e.notes) eventLine += ` (${e.notes})`;
              return eventLine;
            })
            .join('\n');

          calendarContext = `\n\nCALENDAR EVENTS (${calendarRows.length} upcoming):\n${eventsList}`;
          // console.log(
          //   `📅 Chat: Loaded ${calendarRows.length} upcoming calendar events`,
          // );
        }
      } catch (err: any) {
        console.warn(
          '⚠️ failed to load calendar events for chat:',
          err.message,
        );
      }

    // ── Tier 4: Hoist avoid-lists + wardrobe names for post-LLM validation ──
    let chatAvoidLists: ChatAvoidLists = {
      avoidColors: [], avoidMaterials: [], avoidPatterns: [], coverageNoGo: [],
    };
    const wardrobeItemNames = new Set<string>();
    let chatValidatorProfile: ValidatorContext['styleProfile'] = null;
    let chatTempF: number | null = null;

    /* 👗 --- LOAD STYLE PROFILE FOR CHAT CONTEXT --- */
    let styleProfileContext = '';
    if (contextNeeds.styleProfile)
      try {
        const CHAT_STYLE_PROFILE_COLUMNS = STYLE_PROFILE_COLUMNS.replace(
          'favorite_colors',
          'color_preferences AS favorite_colors',
        );
        const { rows: styleRows } = await pool.query(
          `SELECT ${CHAT_STYLE_PROFILE_COLUMNS}, goals
         FROM style_profiles
         WHERE user_id = $1
         LIMIT 1`,
          [user_id],
        );
        if (styleRows.length > 0) {
          const sp = styleRows[0];
          // [AskStyla Debug] — raw data shape verification
          // console.log('[AskStyla Debug] raw fabric_preferences:', sp.fabric_preferences);
          // console.log('[AskStyla Debug] typeof fabric_preferences:', typeof sp.fabric_preferences);
          // console.log('[AskStyla Debug] raw avoid_patterns:', sp.avoid_patterns);
          // console.log('[AskStyla Debug] raw avoid_colors:', sp.avoid_colors);
          /** Safe Postgres TEXT[] parser — handles real arrays, pg string format, null */
          const pgArr = (v: any): string[] => {
            if (!v) return [];
            if (Array.isArray(v)) return v;
            if (typeof v === 'string' && v.startsWith('{') && v.endsWith('}')) {
              return v.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
            }
            return [];
          };
          const arr = (v: any) => pgArr(v).join(', ');
          // console.log('[AskStyla Debug] parsed fabric_preferences:', pgArr(sp.fabric_preferences));
          // console.log('[AskStyla Debug] parsed avoid_patterns:', pgArr(sp.avoid_patterns));
          // console.log('[AskStyla Debug] parsed avoid_colors:', pgArr(sp.avoid_colors));
          const parts: string[] = [];
          if (sp.body_type) parts.push(`Body type: ${sp.body_type}`);
          if (sp.skin_tone) parts.push(`Skin tone: ${sp.skin_tone}`);
          if (sp.undertone) parts.push(`Undertone: ${sp.undertone}`);
          if (sp.hair_color) parts.push(`Hair: ${sp.hair_color}`);
          if (sp.eye_color) parts.push(`Eyes: ${sp.eye_color}`);
          if (sp.height) parts.push(`Height: ${sp.height}`);
          if (sp.climate) parts.push(`Climate: ${sp.climate}`);
          if (sp.favorite_colors?.length)
            parts.push(`Favorite colors: ${arr(sp.favorite_colors)}`);
          if (sp.fit_preferences?.length)
            parts.push(`Fit preferences: ${arr(sp.fit_preferences)}`);
          if (sp.preferred_brands?.length)
            parts.push(`Preferred brands: ${arr(sp.preferred_brands)}`);
          if (sp.disliked_styles?.length)
            parts.push(`Dislikes: ${arr(sp.disliked_styles)}`);
          if (sp.style_keywords?.length)
            parts.push(`Style keywords: ${arr(sp.style_keywords)}`);
          if (sp.goals) parts.push(`Goals: ${sp.goals}`);
          if (sp.style_preferences?.length)
            parts.push(`Style preferences: ${arr(sp.style_preferences)}`);
          if (sp.waist) parts.push(`Waist: ${sp.waist}`);
          // P0 hard vetoes
          const coverageNoGo = pgArr(sp.coverage_no_go);
          const avoidColors = pgArr(sp.avoid_colors);
          const avoidMaterials = pgArr(sp.avoid_materials);
          const avoidPatterns = pgArr(sp.avoid_patterns);
          // Tier 4: populate outer-scope avoid lists for post-LLM validation
          chatAvoidLists = { avoidColors, avoidMaterials, avoidPatterns, coverageNoGo };
          chatValidatorProfile = {
            coverage_no_go: coverageNoGo,
            avoid_colors: avoidColors,
            avoid_materials: avoidMaterials,
            formality_floor: sp.formality_floor || null,
            walkability_requirement: sp.walkability_requirement || null,
            avoid_patterns: avoidPatterns,
            silhouette_preference: sp.silhouette_preference || null,
            fit_preferences: pgArr(sp.fit_preferences),
            fabric_preferences: pgArr(sp.fabric_preferences),
            style_preferences: pgArr(sp.style_preferences),
            disliked_styles: pgArr(sp.disliked_styles),
          };
          // console.log('[AskStyla T4 DEBUG] styleProfile loaded:', {
          //   avoid_colors: chatAvoidLists.avoidColors,
          //   avoid_materials: chatAvoidLists.avoidMaterials,
          //   avoid_patterns: chatAvoidLists.avoidPatterns,
          //   coverage_no_go: chatAvoidLists.coverageNoGo,
          // });
          if (coverageNoGo.length > 0)
            parts.push(
              `HARD RULE — Coverage restrictions: ${coverageNoGo.join(', ')}`,
            );
          if (avoidColors.length > 0)
            parts.push(
              `HARD RULE — NEVER use these colors: ${avoidColors.join(', ')}`,
            );
          if (avoidMaterials.length > 0)
            parts.push(
              `HARD RULE — NEVER use these materials: ${avoidMaterials.join(', ')}`,
            );
          if (sp.formality_floor && sp.formality_floor !== 'No minimum')
            parts.push(`HARD RULE — Minimum formality: ${sp.formality_floor}`);
          if (
            sp.walkability_requirement &&
            sp.walkability_requirement !== 'Low'
          )
            parts.push(
              `HARD RULE — Walkability requirement: ${sp.walkability_requirement}`,
            );
          // LLM-only soft context
          if (sp.fashion_boldness)
            parts.push(`Fashion boldness: ${sp.fashion_boldness}`);
          if (sp.budget_min != null || sp.budget_max != null)
            parts.push(
              `Budget range: ${sp.budget_min ?? '?'}–${sp.budget_max ?? '?'}`,
            );
          const styleIcons = pgArr(sp.style_icons);
          if (styleIcons.length > 0)
            parts.push(`Style icons: ${styleIcons.join(', ')}`);
          // Canonical fields previously missing from chat context
          if (sp.fabric_preferences?.length)
            parts.push(`Fabric preferences: ${arr(sp.fabric_preferences)}`);
          if (sp.occasions?.length)
            parts.push(`Occasions: ${arr(sp.occasions)}`);
          if (sp.pattern_preferences?.length)
            parts.push(`Pattern preferences: ${arr(sp.pattern_preferences)}`);
          if (sp.avoid_patterns?.length)
            parts.push(`HARD RULE — Avoid patterns: ${arr(sp.avoid_patterns)}`);
          if (sp.trend_appetite)
            parts.push(`Trend appetite: ${sp.trend_appetite}`);
          if (sp.fashion_confidence)
            parts.push(`Fashion confidence: ${sp.fashion_confidence}`);
          if (sp.silhouette_preference)
            parts.push(`Silhouette preference: ${sp.silhouette_preference}`);
          if (sp.care_tolerance)
            parts.push(`Care tolerance: ${sp.care_tolerance}`);
          if (sp.metal_preference)
            parts.push(`Metal preference: ${sp.metal_preference}`);
          if (sp.contrast_preference)
            parts.push(`Contrast preference: ${sp.contrast_preference}`);
          if (sp.footwear_comfort)
            parts.push(`Footwear comfort: ${sp.footwear_comfort}`);
          if (sp.foot_width)
            parts.push(`Foot width: ${sp.foot_width}`);
          if (sp.proportions)
            parts.push(`Proportions: ${sp.proportions}`);
          if (sp.weight) parts.push(`Weight: ${sp.weight}`);
          if (sp.chest) parts.push(`Chest: ${sp.chest}`);
          if (sp.hip) parts.push(`Hip: ${sp.hip}`);
          if (sp.shoulder_width)
            parts.push(`Shoulder width: ${sp.shoulder_width}`);
          if (sp.inseam) parts.push(`Inseam: ${sp.inseam}`);
          if (sp.shoe_size) parts.push(`Shoe size: ${sp.shoe_size}`);
          if (sp.color_preferences?.length)
            parts.push(`Color preferences: ${arr(sp.color_preferences)}`);
          if (sp.daily_activities?.length)
            parts.push(`Daily activities: ${arr(sp.daily_activities)}`);
          if (sp.personality_traits?.length)
            parts.push(`Personality: ${arr(sp.personality_traits)}`);
          if (sp.lifestyle_notes)
            parts.push(`Lifestyle: ${String(sp.lifestyle_notes).slice(0, 500)}`);
          if (sp.unit_preference)
            parts.push(`Unit preference: ${sp.unit_preference}`);
          if (parts.length > 0) {
            styleProfileContext = '\n\n👗 STYLE PROFILE:\n' + parts.join('\n');
            // console.log(
            //   `👗 Chat: Loaded style profile with ${parts.length} attributes`,
            // );
            // console.log('[AskStyla Debug] styleProfileContext preview:', styleProfileContext.slice(0, 500));
          }
        }
      } catch (err: any) {
        // console.log('[AskStyla T4 DEBUG] styleProfile FAILED to load');
        console.warn('⚠️ failed to load style profile for chat:', err.message);
      }

    /* 👔 --- LOAD WARDROBE ITEMS FOR CHAT CONTEXT (WITH SPECIFIC ITEM DETAILS) --- */
    let wardrobeContext = '';
    let wardrobeRows: any[] = [];
    if (contextNeeds.wardrobe)
      try {
        ({ rows: wardrobeRows } = await pool.query(
          `SELECT name, main_category, subcategory, color, material, brand, fit,
                 pattern, occasion_tags, dress_code, formality_score,
                 seasonality, layering, color_family,
                 ai_title, ai_description
         FROM wardrobe_items
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT 100`,
          [user_id],
        ));
        if (wardrobeRows.length > 0) {
          // Tier 4: build allowed wardrobe name set for hallucination guard
          for (const item of wardrobeRows) {
            if (item.name) wardrobeItemNames.add(item.name.trim().toLowerCase());
          }
          const grouped: Record<string, any[]> = {};
          for (const item of wardrobeRows) {
            const cat = item.main_category || 'Other';
            if (!grouped[cat]) grouped[cat] = [];
            grouped[cat].push({
              name: item.ai_title || item.name,
              color: item.color,
              material: item.material,
              brand: item.brand,
              fit: item.fit,
              subcategory: item.subcategory,
              pattern: item.pattern,
              occasion: item.occasion_tags,
              dressCode: item.dress_code,
              formality: item.formality_score,
              season: item.seasonality,
              layering: item.layering,
              colorFamily: item.color_family,
              aiDesc: item.ai_description,
            });
          }

          // Format wardrobe for easy reference in recommendations
          const formatted = Object.entries(grouped)
            .map(([cat, items]) => {
              const itemDescriptions = items
                .slice(0, 12)
                .map((i) => {
                  const mainParts = [
                    i.color,
                    i.name || i.subcategory,
                    i.brand,
                    i.material,
                    i.fit,
                  ]
                    .filter(Boolean)
                    .join(' • ');
                  const extras = [
                    i.pattern && `pattern:${i.pattern}`,
                    i.season && `season:${i.season}`,
                    i.layering && `layer:${i.layering}`,
                    i.occasion && `occasion:${Array.isArray(i.occasion) ? i.occasion.join('/') : i.occasion}`,
                    i.dressCode && `dress-code:${i.dressCode}`,
                    i.formality != null && `formality:${i.formality}`,
                    i.colorFamily && `color-family:${i.colorFamily}`,
                  ].filter(Boolean).join(' | ');
                  const desc = i.aiDesc ? `\n      ${String(i.aiDesc).slice(0, 200)}` : '';
                  return `  • ${mainParts}${extras ? `\n      [${extras}]` : ''}${desc}`;
                })
                .join('\n');
              return `${cat}:\n${itemDescriptions}`;
            })
            .join('\n\n');

          wardrobeContext = `\n\n👔 USER'S EXACT WARDROBE ITEMS (use these specific names and colors in recommendations):\n\n${formatted}\n\nWARNING: Always reference ACTUAL item names from above when making recommendations. Use language like:
- "pair with your [COLOR] [ITEM NAME] you own"
- "complements the [BRAND] [ITEM] in [COLOR]"
- "works with your [fit] [COLOR] [ITEM]"
NEVER make generic references. ALWAYS name the SPECIFIC pieces they own.`;

          // console.log('[AskStyla T4 DEBUG] wardrobe rows count:', wardrobeRows.length);
          // console.log('[AskStyla T4 DEBUG] wardrobe item names:', wardrobeRows.map(r => r.name));
          // console.log('[AskStyla T4 DEBUG] wardrobe context preview START');
          // console.log(wardrobeContext.slice(0, 1500));
          // console.log('[AskStyla T4 DEBUG] wardrobe context preview END');
        }
      } catch (err: any) {
        console.warn('⚠️ failed to load wardrobe items for chat:', err.message);
      }

    // ── Tier 4 Reasoning: Pre-LLM Shortlist (Ask Styla only) ──
    const detectedCategory = contextNeeds.wardrobe ? detectRelevantCategory(lastUserMsg) : null;
    const formalityAnchor = detectFormalityAnchor(lastUserMsg);
    const shortlist = wardrobeRows.length > 0
      ? buildShortlist(wardrobeRows, chatAvoidLists, detectedCategory, formalityAnchor)
      : [];
    const useShortlist = shortlist.length > 0 && contextNeeds.wardrobe;
    let shortlistContext = '';
    if (useShortlist) {
      shortlistContext = formatShortlistForPrompt(shortlist);
      // console.log(`[AskStyla T4 Reasoning] shortlist: ${shortlist.length} items, category=${detectedCategory}, formality=${formalityAnchor}`);
    }

    /* ⭐ --- LOAD SAVED LOOKS FOR CHAT CONTEXT --- */
    let savedLooksContext = '';
    if (contextNeeds.savedLooks)
      try {
        const { rows: savedRows } = await pool.query(
          `SELECT name, created_at
         FROM saved_looks
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT 10`,
          [user_id],
        );
        if (savedRows.length > 0) {
          savedLooksContext =
            '\n\n⭐ SAVED LOOKS:\n' +
            savedRows.map((l) => `• ${l.name}`).join('\n');
          // console.log(`⭐ Chat: Loaded ${savedRows.length} saved looks`);
        }
      } catch (err: any) {
        // console.warn('⚠️ failed to load saved looks for chat:', err.message);
      }

    /* 🎨 --- LOAD RECREATED LOOKS FOR CHAT CONTEXT --- */
    let recreatedLooksContext = '';
    if (contextNeeds.savedLooks)
      try {
        const { rows: recreatedRows } = await pool.query(
          `SELECT tags, created_at
         FROM recreated_looks
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT 10`,
          [user_id],
        );
        if (recreatedRows.length > 0) {
          const allTags = recreatedRows
            .flatMap((r) => r.tags || [])
            .filter(Boolean);
          const uniqueTags = [...new Set(allTags)].slice(0, 20);
          if (uniqueTags.length > 0) {
            recreatedLooksContext =
              '\n\n🎨 RECENT LOOK INSPIRATIONS (tags): ' +
              uniqueTags.join(', ');
            console.log(
              `🎨 Chat: Loaded ${recreatedRows.length} recreated looks`,
            );
          }
        }
      } catch (err: any) {
        console.warn(
          '⚠️ failed to load recreated looks for chat:',
          err.message,
        );
      }

    /* 📝 --- LOAD OUTFIT FEEDBACK FOR CHAT CONTEXT --- */
    let feedbackContext = '';
    if (contextNeeds.feedback)
      try {
        const { rows: feedbackRows } = await pool.query(
          `SELECT rating, notes, outfit_json
         FROM outfit_feedback
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT 10`,
          [user_id],
        );
        if (feedbackRows.length > 0) {
          const likes = feedbackRows.filter((f) => f.rating >= 4);
          const dislikes = feedbackRows.filter((f) => f.rating <= 2);
          const parts: string[] = [];
          if (likes.length > 0) {
            const likeNotes = likes
              .map((f) => f.notes)
              .filter(Boolean)
              .slice(0, 3);
            parts.push(
              `Liked outfits: ${likes.length}${likeNotes.length ? ' - ' + likeNotes.join('; ') : ''}`,
            );
          }
          if (dislikes.length > 0) {
            const dislikeNotes = dislikes
              .map((f) => f.notes)
              .filter(Boolean)
              .slice(0, 3);
            parts.push(
              `Disliked outfits: ${dislikes.length}${dislikeNotes.length ? ' - ' + dislikeNotes.join('; ') : ''}`,
            );
          }
          if (parts.length > 0) {
            feedbackContext = '\n\n📝 OUTFIT FEEDBACK:\n' + parts.join('\n');
            console.log(
              `📝 Chat: Loaded ${feedbackRows.length} outfit feedback entries`,
            );
          }
        }
      } catch (err: any) {
        console.warn(
          '⚠️ failed to load outfit feedback for chat:',
          err.message,
        );
      }

    /* 👕 --- LOAD WEAR HISTORY FOR CHAT CONTEXT --- */
    let wearHistoryContext = '';
    if (contextNeeds.wearHistory)
      try {
        const { rows: wearRows } = await pool.query(
          `SELECT items_jsonb, context_jsonb, worn_at
         FROM wear_events
         WHERE user_id = $1
         ORDER BY worn_at DESC
         LIMIT 10`,
          [user_id],
        );
        if (wearRows.length > 0) {
          const recentWears = wearRows
            .slice(0, 5)
            .map((w) => {
              const date = new Date(w.worn_at).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
              });
              const context =
                w.context_jsonb?.occasion || w.context_jsonb?.event || '';
              return `• ${date}${context ? ' (' + context + ')' : ''}`;
            })
            .filter(Boolean);
          if (recentWears.length > 0) {
            wearHistoryContext =
              '\n\n👕 RECENTLY WORN:\n' + recentWears.join('\n');
            // console.log(`👕 Chat: Loaded ${wearRows.length} wear events`);
          }
        }
      } catch (err: any) {
        // console.warn('⚠️ failed to load wear history for chat:', err.message);
      }

    /* 📆 --- LOAD SCHEDULED OUTFITS FOR CHAT CONTEXT --- */
    let scheduledOutfitsContext = '';
    if (contextNeeds.scheduledOutfits)
      try {
        const { rows: scheduledRows } = await pool.query(
          `SELECT scheduled_for, notes, location
         FROM scheduled_outfits
         WHERE user_id = $1
         AND scheduled_for >= NOW()
         ORDER BY scheduled_for ASC
         LIMIT 5`,
          [user_id],
        );
        if (scheduledRows.length > 0) {
          scheduledOutfitsContext =
            '\n\n📆 SCHEDULED OUTFITS:\n' +
            scheduledRows
              .map((s) => {
                const date = new Date(s.scheduled_for).toLocaleDateString(
                  'en-US',
                  { weekday: 'short', month: 'short', day: 'numeric' },
                );
                return `• ${date}${s.location ? ' at ' + s.location : ''}${s.notes ? ' - ' + s.notes : ''}`;
              })
              .join('\n');
          console.log(
            `📆 Chat: Loaded ${scheduledRows.length} scheduled outfits`,
          );
        }
      } catch (err: any) {
        console.warn(
          '⚠️ failed to load scheduled outfits for chat:',
          err.message,
        );
      }

    /* ❤️ --- LOAD OUTFIT FAVORITES FOR CHAT CONTEXT --- */
    let favoritesContext = '';
    if (contextNeeds.favorites)
      try {
        const { rows: favRows } = await pool.query(
          `SELECT outfit_type, COUNT(*) as count
         FROM outfit_favorites
         WHERE user_id = $1
         GROUP BY outfit_type`,
          [user_id],
        );
        if (favRows.length > 0) {
          favoritesContext =
            '\n\n❤️ FAVORITED OUTFITS: ' +
            favRows
              .map((f) => `${f.outfit_type || 'outfit'}: ${f.count}`)
              .join(', ');
          console.log(
            `❤️ Chat: Loaded ${favRows.length} outfit favorite types`,
          );
        }
      } catch (err: any) {
        console.warn(
          '⚠️ failed to load outfit favorites for chat:',
          err.message,
        );
      }

    /* 🎯 --- LOAD CUSTOM OUTFITS FOR CHAT CONTEXT --- */
    let customOutfitsContext = '';
    if (contextNeeds.customOutfits)
      try {
        const { rows: customRows } = await pool.query(
          `SELECT name, notes, rating
         FROM custom_outfits
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT 10`,
          [user_id],
        );
        if (customRows.length > 0) {
          customOutfitsContext =
            '\n\n🎯 CUSTOM OUTFITS CREATED:\n' +
            customRows
              .map(
                (c) =>
                  `• ${c.name}${c.rating ? ' (rated ' + c.rating + '/5)' : ''}${c.notes ? ' - ' + c.notes : ''}`,
              )
              .join('\n');
          // console.log(`🎯 Chat: Loaded ${customRows.length} custom outfits`);
        }
      } catch (err: any) {
        // console.warn('⚠️ failed to load custom outfits for chat:', err.message);
      }

    /* 👍 --- LOAD ITEM PREFERENCES FOR CHAT CONTEXT --- */
    let itemPrefsContext = '';
    if (contextNeeds.itemPrefs)
      try {
        const { rows: prefRows } = await pool.query(
          `SELECT up.score, wi.name, wi.main_category, wi.color
         FROM user_pref_item up
         JOIN wardrobe_items wi ON up.item_id = wi.id
         WHERE up.user_id = $1
         ORDER BY up.score DESC
         LIMIT 10`,
          [user_id],
        );
        if (prefRows.length > 0) {
          const liked = prefRows.filter((p) => p.score > 0);
          const disliked = prefRows.filter((p) => p.score < 0);
          const parts: string[] = [];
          if (liked.length > 0) {
            parts.push(
              'Most liked items: ' +
                liked
                  .slice(0, 5)
                  .map((p) => p.name || `${p.color} ${p.main_category}`)
                  .join(', '),
            );
          }
          if (disliked.length > 0) {
            parts.push(
              'Least liked items: ' +
                disliked
                  .slice(0, 3)
                  .map((p) => p.name || `${p.color} ${p.main_category}`)
                  .join(', '),
            );
          }
          if (parts.length > 0) {
            itemPrefsContext = '\n\n👍 ITEM PREFERENCES:\n' + parts.join('\n');
            // console.log(`👍 Chat: Loaded ${prefRows.length} item preferences`);
          }
        }
      } catch (err: any) {
        // console.warn(
        //   '⚠️ failed to load item preferences for chat:',
        //   err.message,
        // );
      }

    /* 🔍 --- LOAD LOOK MEMORIES FOR CHAT CONTEXT --- */
    let lookMemoriesContext = '';
    if (contextNeeds.lookMemories)
      try {
        const { rows: memRows } = await pool.query(
          `SELECT ai_tags, query_used
         FROM look_memories
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT 15`,
          [user_id],
        );
        if (memRows.length > 0) {
          const allTags = memRows
            .flatMap((m) => m.ai_tags || [])
            .filter(Boolean);
          const uniqueTags = [...new Set(allTags)].slice(0, 15);
          const queries = [
            ...new Set(memRows.map((m) => m.query_used).filter(Boolean)),
          ].slice(0, 5);
          const parts: string[] = [];
          if (uniqueTags.length > 0)
            parts.push('Style tags explored: ' + uniqueTags.join(', '));
          if (queries.length > 0)
            parts.push('Recent searches: ' + queries.join(', '));
          if (parts.length > 0) {
            lookMemoriesContext =
              '\n\n🔍 LOOK EXPLORATION HISTORY:\n' + parts.join('\n');
            // console.log(`🔍 Chat: Loaded ${memRows.length} look memories`);
          }
        }
      } catch (err: any) {
        // console.warn('⚠️ failed to load look memories for chat:', err.message);
      }

    /* 🔔 --- LOAD NOTIFICATIONS FOR CHAT CONTEXT --- */
    let notificationsContext = '';
    if (contextNeeds.notifications)
      try {
        const { rows: notifRows } = await pool.query(
          `SELECT title, message, timestamp, category, read
         FROM user_notifications
         WHERE user_id = $1
         ORDER BY timestamp DESC
         LIMIT 15`,
          [user_id],
        );
        if (notifRows.length > 0) {
          notificationsContext =
            '\n\n🔔 RECENT NOTIFICATIONS:\n' +
            notifRows
              .map((n: any, i: number) => {
                const date = new Date(n.timestamp).toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                });
                const readStatus = n.read ? '' : ' (unread)';
                return `${i + 1}. [${date}] ${n.title || n.category || 'Notification'}: ${n.message}${readStatus}`;
              })
              .join('\n');
          // console.log(`🔔 Chat: Loaded ${notifRows.length} notifications`);
          // console.log(
          //   `🔔 Chat: Notifications preview: ${notificationsContext.substring(0, 500)}`,
          // );
        }
      } catch (err: any) {
        // console.warn('⚠️ failed to load notifications for chat:', err.message);
      }

    /* 🌦️ --- FETCH CURRENT WEATHER FOR CHAT CONTEXT --- */
    let weatherContext = '';
    if (contextNeeds.weather)
      try {
        if (dto.lat && dto.lon) {
          const weather = await fetchWeatherForAI(dto.lat, dto.lon);
          if (weather) {
            weatherContext = `\n\n🌦️ CURRENT WEATHER:\n• Temperature: ${weather.tempF}°F\n• Condition: ${weather.condition}\n• Humidity: ${weather.humidity}%\n• Wind: ${weather.windSpeed} mph`;
            chatTempF = weather.tempF;
          }
        } else if (dto.weather) {
          // Use weather passed directly from frontend if no lat/lon
          const w = dto.weather;
          if (w.tempF || w.temperature) {
            const temp = w.tempF || Math.round((w.temperature * 9) / 5 + 32);
            weatherContext = `\n\n🌦️ CURRENT WEATHER:\n• Temperature: ${temp}°F${w.condition ? `\n• Condition: ${w.condition}` : ''}`;
            chatTempF = temp;
          }
        }
      } catch (err: any) {
        // Weather fetch for chat failed silently
      }

    // --- LEARNED PREFERENCES (fashion state, compact, max ~80 tokens, fail-open) ---
    let learnedPrefsContext = '';
    if (this.fashionStateService && user_id) {
      try {
        const fsSummary = await this.fashionStateService.getStateSummary(user_id);
        if (fsSummary && !fsSummary.isColdStart) {
          const parts: string[] = [];
          if (fsSummary.topBrands.length) parts.push(`Brands: ${fsSummary.topBrands.slice(0, 3).join(', ')}`);
          if (fsSummary.topColors.length) parts.push(`Colors: ${fsSummary.topColors.slice(0, 3).join(', ')}`);
          if (fsSummary.topStyles.length) parts.push(`Styles: ${fsSummary.topStyles.slice(0, 3).join(', ')}`);
          if (fsSummary.avoidStyles?.length) parts.push(`Avoid: ${fsSummary.avoidStyles.slice(0, 2).join(', ')}`);
          if (parts.length) {
            learnedPrefsContext = `\n\nLEARNED PREFERENCES (from behavior):\n${parts.join(' | ')}`;
          }
        }
      } catch { /* fail-open: skip learned prefs on any error */ }
    }

    // Combine all context into enhanced summary
    const fullContext =
      (longTermSummary || '(no prior memory yet)') +
      styleProfileContext +
      wardrobeContext +
      calendarContext +
      savedLooksContext +
      recreatedLooksContext +
      feedbackContext +
      wearHistoryContext +
      scheduledOutfitsContext +
      favoritesContext +
      customOutfitsContext +
      itemPrefsContext +
      lookMemoriesContext +
      notificationsContext +
      weatherContext +
      learnedPrefsContext;

    // console.log(
    //   `🔍 [Ask Styla] context: styleProfile=${styleProfileContext ? 'YES' : 'NO'} | ` +
    //   `wardrobe=${wardrobeContext ? 'YES' : 'NO'} | ` +
    //   `calendar=${calendarContext ? 'YES' : 'NO'} | ` +
    //   `memory=${longTermSummary ? 'YES' : 'NO'} | ` +
    //   `learnedPrefs=${learnedPrefsContext ? 'YES' : 'NO'}`
    // );

    // 1️⃣ Generate base text with OpenAI
    // Tier 4 Reasoning: Use luxury stylist prompt when shortlist is active
    let systemContent = useShortlist
      ? buildLuxuryStylistPrompt(shortlistContext, styleProfileContext, fullContext)
      : `
You are a world-class personal fashion stylist with FULL ACCESS to the user's personal data.

YOU HAVE COMPLETE ACCESS TO ALL OF THIS USER DATA:
${fullContext}

CRITICAL RULES - MANDATORY FOR ALL RESPONSES:
1. ONLY reference events, items, and data actually shown above
2. DO NOT make up or invent calendar events, wardrobe items, or preferences
3. If the user asks about something not in the data above, say "I don't see that in your data"
4. Use ONLY the real calendar events, wardrobe items, and preferences provided
5. When answering questions about their calendar - reference ONLY the events listed above
6. You DO have access to real-time weather data - if CURRENT WEATHER is shown above, use it confidently
7. You DO have access to notification history - if RECENT NOTIFICATIONS is shown above, use it to answer questions about notifications

⭐ WARDROBE RECOMMENDATION RULES (MANDATORY):
- WHEN MAKING SHOPPING SUGGESTIONS: You MUST reference specific items they ALREADY OWN
- Use language patterns like:
  • "pair with your [COLOR] [ITEM NAME] you own"
  • "matches the [BRAND] [ITEM] in [COLOR]"
  • "works perfectly with your [fit] [COLOR] [ITEM NAME]"
  • "complements your existing [COLOR] [MATERIAL] [ITEM]"
  • "You currently have [NUMBER] [CATEGORY], so adding a [specific item] would fill the gap"
- SHOW PROOF you know their wardrobe by naming SPECIFIC items, colors, materials, brands
- Example RIGHT answer: "Navy blazer to pair with your sleek white pants you own - fills your structured top gap"
- Example WRONG answer: "Add a navy blazer to complete your look" ← NEVER do this

Respond naturally about outfits, wardrobe planning, or styling using ONLY the user data provided.

🖼️ IMAGES & LINKS - IMPORTANT:
- You ARE able to show images and shopping links to users
- The app will automatically display relevant images and shopping links based on your search_terms
- When users ask to "show me images" or "give me links", respond helpfully and include relevant search_terms
- NEVER say you "can't display images" or "can't provide links" - the system handles this automatically
- Just respond naturally and provide good search_terms at the end

At the end, return a short JSON block like:
{"search_terms":["smart casual men","navy blazer outfit","loafers"]}
        `;

    // Tier 4: Inject explicit avoid-list validation rules into system prompt
    if (chatAvoidLists.avoidColors.length > 0
      || chatAvoidLists.avoidMaterials.length > 0
      || chatAvoidLists.avoidPatterns.length > 0
      || chatAvoidLists.coverageNoGo.length > 0) {
      const expandedColors = chatAvoidLists.avoidColors.length > 0
        ? expandAvoidColorsLite(chatAvoidLists.avoidColors) : [];
      systemContent += `\n\n════════════════════════
AVOID-LIST ENFORCEMENT (MANDATORY — INTERNAL ONLY)
════════════════════════

Before recommending ANY item, you MUST internally verify it against these banned lists:
  avoid_colors (expanded): ${expandedColors.length > 0 ? expandedColors.join(', ') : '(none)'}
  avoid_materials: ${chatAvoidLists.avoidMaterials.length > 0 ? chatAvoidLists.avoidMaterials.join(', ') : '(none)'}
  avoid_patterns: ${chatAvoidLists.avoidPatterns.length > 0 ? chatAvoidLists.avoidPatterns.join(', ') : '(none)'}
  coverage_no_go: ${chatAvoidLists.coverageNoGo.length > 0 ? chatAvoidLists.coverageNoGo.join(', ') : '(none)'}

Rules:
- Check EVERY proposed item against ALL lists above before including it in your response.
- If ANY item matches a banned color, material, pattern, or coverage rule, silently exclude it and choose a compliant alternative.
- NEVER mention the validation process, avoid lists, or filtering to the user.
- Your response must read as a clean, natural luxury stylist recommendation with zero validation artifacts.
- Never ignore avoid lists even if wardrobe/styleProfile is loaded.
`;
    }

    // ── Pre-generation: inject structural slot requirements for business/formal contexts ──
    const msgLower = lastUserMsg.toLowerCase();
    const isFormalContext =
      /\b(black[\s-]?tie|gala|formal)\b/.test(msgLower) ||
      /\b(business|dinner|office|interview|meeting|professional)\b/.test(msgLower);
    if (isFormalContext && wardrobeRows.length > 0) {
      systemContent += `\n\nSTRUCTURAL REQUIREMENTS (MANDATORY):
- You MUST include exactly one TOP (shirt, sweater, knit, button-up, polo, turtleneck, etc.)
- You MUST include exactly one BOTTOM (trousers, chinos, dress pants, skirt, etc.)
- You MUST include exactly one pair of SHOES
- Outerwear (blazer, coat, jacket) is OPTIONAL and does NOT count as a top
- Do NOT omit any required slot
- Do NOT treat a blazer, coat, or jacket as a top — they are outerwear only`;
    }

    // ── Tier 4: Inventory authority — detect non-owned garment references (Ask Styla only) ──
    const nonOwnedRefs: string[] = [];
    if (wardrobeItemNames.size > 0) {
      const GARMENT_RE = /\b(tuxedo|tux|suit|blazer|jacket|coat|parka|windbreaker|trench\s*coat|peacoat|bomber|anorak|blouse|sweater|hoodie|cardigan|vest|polo|turtleneck|henley|camisole|trousers|jeans|shorts|chinos|skirt|gown|jumpsuit|romper|boots?|sneakers?|loafers?|oxfords?|heels?|pumps?|sandals?|flip\s*flops?|mules?|flats?|slides?|espadrilles?|brogues?|hat|cap|beanie|scarf|tie|bow\s*tie|belt|watch|purse|clutch|backpack|sunglasses|gloves|earrings?|necklace|bracelet|cufflinks?|poncho|cape|kimono|tunic|bodysuit|leggings|joggers|sweatpants)\b/gi;

      const garmentHits = [...new Set(
        (msgLower.match(GARMENT_RE) || []).map(m => m.trim().toLowerCase()),
      )];

      for (const term of garmentHits) {
        let owned = false;
        for (const name of wardrobeItemNames) {
          if (name.includes(term)) { owned = true; break; }
        }
        if (!owned) nonOwnedRefs.push(term);
      }

      if (nonOwnedRefs.length > 0) {
        // console.log(`[AskStyla T4 InventoryAuth] non-owned refs detected: ${JSON.stringify(nonOwnedRefs)}`);
        systemContent += `\n\n════════════════════════
INVENTORY AUTHORITY (MANDATORY — INTERNAL ONLY)
════════════════════════
The user referenced the following items that are NOT in their wardrobe:
${nonOwnedRefs.map(r => `  - "${r}"`).join('\n')}

Rules:
- Do NOT treat these items as owned by the user.
- Do NOT style the user with these items.
- Do NOT reference them as if the user owns them.
- Briefly note: "I don't see a [item] in your wardrobe — would you like to add one?"
- Then build a complete outfit recommendation using ONLY actual wardrobe pieces.
- NEVER mention this validation to the user beyond the ownership note.
`;
      }
    }

    // Build LLM-safe messages — strip non-owned garment phrases from last user message
    let llmMessages = messages;
    let llmUserMsg = lastUserMsg;
    if (nonOwnedRefs.length > 0) {
      let sanitized = lastUserMsg;
      for (const ref of nonOwnedRefs) {
        const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        sanitized = sanitized
          .replace(new RegExp(`\\bwith\\s+my\\s+(?:\\w+\\s+){0,3}${escaped}\\b`, 'gi'), '')
          .replace(new RegExp(`\\bmy\\s+(?:\\w+\\s+){0,3}${escaped}\\b`, 'gi'), '')
          .replace(new RegExp(`\\band\\s+(?:\\w+\\s+){0,3}${escaped}\\b`, 'gi'), '')
          .replace(new RegExp(`\\b${escaped}\\b`, 'gi'), '');
      }
      sanitized = sanitized.replace(/\s{2,}/g, ' ').replace(/\s+([,.])/g, '$1').trim();
      if (sanitized) {
        llmUserMsg = sanitized;
        llmMessages = [...messages];
        for (let i = llmMessages.length - 1; i >= 0; i--) {
          if (llmMessages[i].role === 'user') {
            llmMessages[i] = { ...llmMessages[i], content: sanitized };
            break;
          }
        }
        // console.log(`[AskStyla T4 InventoryAuth] sanitized msg: "${sanitized}"`);
      }
    }

    // ── Structured Slot Output: Force JSON slot selection for outfit-building queries ──
    const isOutfitBuildRequest = wardrobeRows.length > 0 && (
      /\b(style me|dress me|put.{0,10}together|build.{0,10}(?:outfit|look)|create.{0,10}(?:outfit|look)|suggest.{0,10}(?:outfit|look)|recommend.{0,15}(?:outfit|look|wear))\b/i.test(msgLower) ||
      /\bwhat.{0,20}(?:should|can|could|to)\s+(?:i\s+)?wear\b/i.test(msgLower) ||
      /\boutfit\s+(?:for|idea|suggestion)\b/i.test(msgLower) ||
      isFormalContext
    );

    let structuredSlotLocked = false;
    let lockedSlotSummary = '';

    if (isOutfitBuildRequest) {
      try {
        const wardrobeItemList = wardrobeRows
          .map(r => `- ${r.ai_title || r.name} [${r.main_category}]`)
          .join('\n');

        const slotMemoryContext =
          longTermSummary && typeof longTermSummary === 'string'
            ? longTermSummary.slice(0, 1500)
            : '';

        const slotSystemPrompt = `You are a fashion stylist selecting outfit items from a user's wardrobe.
${slotMemoryContext ? `\n=== LONG-TERM USER MEMORY (CONSTRAINTS ONLY) ===\n${slotMemoryContext}\n=== END MEMORY ===\n` : ''}
USER'S WARDROBE:
${wardrobeItemList}

USER REQUEST: "${llmUserMsg}"

You MUST output a valid JSON object with the following structure:
{
  "tops": "exact wardrobe item name",
  "bottoms": "exact wardrobe item name",
  "outerwear": "exact wardrobe item name or null",
  "shoes": "exact wardrobe item name",
  "accessories": []
}

Rules:
- Use ONLY exact wardrobe item names provided above.
- Do NOT output prose.
- Do NOT explain.
- Do NOT omit required slots.
- tops, bottoms, shoes are MANDATORY.
- A blazer, coat, or jacket is OUTERWEAR — never tops.
- tops means: shirt, sweater, blouse, t-shirt, polo, turtleneck, knit, button-up, henley, tank, camisole, etc.
- If no suitable outerwear exists, set outerwear to null.
- accessories must be an array (empty array if none).`;

        const slotCompletion = await this.openai.chat.completions.create({
          model: 'gpt-4o',
          temperature: 0.5,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: slotSystemPrompt },
            ...llmMessages,
          ],
        });

        const slotRaw = slotCompletion.choices[0]?.message?.content?.trim() || '';
        const slots = JSON.parse(slotRaw);

        if (slots.tops && slots.bottoms && slots.shoes) {
          // console.log(`[AskStyla Structured Slots] ✅ locked: tops=${slots.tops}, bottoms=${slots.bottoms}, shoes=${slots.shoes}, outerwear=${slots.outerwear || 'none'}, accessories=${(slots.accessories || []).length}`);

          // ── Build ValidatorItem[] directly from structured slots ──
          // Inline slot resolution — mirrors mainCatToSlot() in chatTier4.ts exactly
          const resolveSlot = (mainCat: string | undefined): string => {
            switch ((mainCat ?? '').toLowerCase().trim()) {
              case 'tops': return 'tops';
              case 'bottoms': return 'bottoms';
              case 'shoes': return 'shoes';
              case 'outerwear': return 'outerwear';
              case 'dresses': return 'dresses';
              case 'activewear': return 'activewear';
              case 'swimwear': return 'swimwear';
              default: return 'accessories';
            }
          };

          const findWardrobeRow = (itemName: string) => {
            const norm = itemName.toLowerCase().replace(/\s+/g, ' ').trim();
            return wardrobeRows.find(r => {
              const aiNorm = (r.ai_title || '').toLowerCase().replace(/\s+/g, ' ').trim();
              const nameNorm = (r.name || '').toLowerCase().replace(/\s+/g, ' ').trim();
              return aiNorm === norm || nameNorm === norm;
            });
          };

          const buildValidatorItem = (itemName: string, fallbackSlot: string): ValidatorItem => {
            const row = findWardrobeRow(itemName);
            if (row) {
              return {
                id: itemName,
                slot: resolveSlot(row.main_category) as any,
                name: row.ai_title || row.name,
                subcategory: row.subcategory,
                color: row.color,
                material: row.material,
                fit: row.fit,
                formality_score: row.formality_score != null ? Number(row.formality_score) : undefined,
                dress_code: row.dress_code,
              };
            }
            return { id: itemName, slot: fallbackSlot as any, name: itemName };
          };

          const structuredValidatorItems: ValidatorItem[] = [
            buildValidatorItem(slots.tops, 'tops'),
            buildValidatorItem(slots.bottoms, 'bottoms'),
            buildValidatorItem(slots.shoes, 'shoes'),
            ...(slots.outerwear ? [buildValidatorItem(slots.outerwear, 'outerwear')] : []),
            ...(Array.isArray(slots.accessories)
              ? slots.accessories.filter(Boolean).map((a: string) => buildValidatorItem(a, 'accessories'))
              : []),
          ];

          // ── Build ValidatorContext ──
          const chatRequestedDressCode: string | undefined = (() => {
            if (!lastUserMsg) return undefined;
            const m = lastUserMsg.toLowerCase();
            if (/\b(black[\s-]?tie|gala|formal)\b/.test(m)) return 'formal';
            if (/\b(business|office|interview|meeting|professional)\b/.test(m)) return 'business casual';
            return undefined;
          })();

          const chatValidatorCtx: ValidatorContext = {
            climateZone: chatTempF != null ? tempToClimateZone(chatTempF) : undefined,
            requestedDressCode: chatRequestedDressCode,
            styleProfile: chatValidatorProfile,
          };

          // ── Validate structured slots BEFORE prose generation ──
          // console.log(`[AskStyla T4 Validator] validating structured slots: ${structuredValidatorItems.map(i => `${i.slot}=${i.name}`).join(', ')}`);
          const slotValidation = tasteValidateOutfit(
            structuredValidatorItems,
            chatValidatorCtx,
          );

          if (slotValidation.valid) {
            // console.log(`[AskStyla T4 Validator] validation clean (coherence: ${slotValidation.coherenceScore})`);
            structuredSlotLocked = true;
          } else {
            // console.log(`[AskStyla T4 Validator] structured slots HARD FAIL: ${slotValidation.hardFails.join('; ')}`);

            // ── One retry: re-select slots with correction instructions ──
            try {
              const failLines = slotValidation.hardFails.map(f => `- ${f}`).join('\n');
              const retryCorrectionPrompt = `${slotSystemPrompt}

CRITICAL: Your previous slot selection FAILED validation:
${failLines}

You MUST correct these issues:
- Respect dress code, formality, climate, and user preferences.
- Do NOT repeat the previous invalid combination.
- tops, bottoms, shoes remain MANDATORY.`;

              const retrySlotCompletion = await this.openai.chat.completions.create({
                model: 'gpt-4o',
                temperature: 0.5,
                response_format: { type: 'json_object' },
                messages: [
                  { role: 'system', content: retryCorrectionPrompt },
                  ...llmMessages,
                ],
              });

              const retrySlotRaw = retrySlotCompletion.choices[0]?.message?.content?.trim() || '';
              const retrySlots = JSON.parse(retrySlotRaw);

              if (retrySlots.tops && retrySlots.bottoms && retrySlots.shoes) {
                const retryValidatorItems: ValidatorItem[] = [
                  buildValidatorItem(retrySlots.tops, 'tops'),
                  buildValidatorItem(retrySlots.bottoms, 'bottoms'),
                  buildValidatorItem(retrySlots.shoes, 'shoes'),
                  ...(retrySlots.outerwear ? [buildValidatorItem(retrySlots.outerwear, 'outerwear')] : []),
                  ...(Array.isArray(retrySlots.accessories)
                    ? retrySlots.accessories.filter(Boolean).map((a: string) => buildValidatorItem(a, 'accessories'))
                    : []),
                ];

                const retryValidation = tasteValidateOutfit(retryValidatorItems, chatValidatorCtx);

                if (retryValidation.valid) {
                  // Retry succeeded — update slots for prose generation
                  slots.tops = retrySlots.tops;
                  slots.bottoms = retrySlots.bottoms;
                  slots.shoes = retrySlots.shoes;
                  slots.outerwear = retrySlots.outerwear || null;
                  slots.accessories = Array.isArray(retrySlots.accessories) ? retrySlots.accessories : [];
                  structuredSlotLocked = true;
                  // console.log(`[AskStyla T4 Validator] retry succeeded — validation passed (coherence: ${retryValidation.coherenceScore})`);
                } else {
                  // console.log(`[AskStyla T4 Validator] retry also failed (${retryValidation.hardFails.join('; ')}) — falling through to free-text`);
                }
              } else {
                // console.log(`[AskStyla T4 Validator] retry missing required slots — falling through to free-text`);
              }
            } catch (retryErr: any) {
              // console.warn(`[AskStyla T4 Validator] retry slot selection error — falling through to free-text: ${retryErr.message}`);
            }
          }

          // ── Inject slot-lock into systemContent for prose rendering ──
          if (structuredSlotLocked) {
            const lockedItemsList = [
              `- Top: ${slots.tops}`,
              `- Bottom: ${slots.bottoms}`,
              `- Shoes: ${slots.shoes}`,
              ...(slots.outerwear ? [`- Outerwear: ${slots.outerwear}`] : []),
              ...(Array.isArray(slots.accessories) && slots.accessories.length > 0
                ? [`- Accessories: ${slots.accessories.join(', ')}`]
                : []),
            ].join('\n');
            lockedSlotSummary = lockedItemsList;

            systemContent += `\n\n════════════════════════════════════════
SLOT-LOCKED ITEMS (MANDATORY — DO NOT CHANGE)
════════════════════════════════════════
You MUST use EXACTLY these items in your outfit recommendation:
${lockedItemsList}

VERBATIM NAME RULES (ZERO TOLERANCE — FAILURE = INVALID RESPONSE):
1. You MUST copy each item name EXACTLY as written above — character for character.
2. Do NOT shorten, abbreviate, paraphrase, reword, or summarize any item name.
3. Do NOT remove hyphens, apostrophes, or any punctuation from item names.
4. Do NOT reorder words within an item name.
5. Do NOT change casing (uppercase/lowercase) of any item name.
6. Do NOT drop qualifiers like "Men's", "Women's", color descriptors, or brand prefixes.
7. Each locked item name string MUST appear at least once VERBATIM in your response body.
8. If you cannot include an item name verbatim, stop and regenerate your response — do NOT output a modified version.
9. Treat every item name as a frozen string literal. Copy-paste it; do not retype it.

Additional rules:
- Do NOT substitute, add, or remove any items from the locked list.
- Write a natural, conversational styling recommendation around these verbatim item names.
- Include search_terms JSON at the end as usual.`;
          }
        } else {
          // console.log(`[AskStyla Structured Slots] ⚠️ missing required slots (tops=${!!slots.tops}, bottoms=${!!slots.bottoms}, shoes=${!!slots.shoes}), falling through to free-text`);
        }
      } catch (slotErr: any) {
        // console.warn(`[AskStyla Structured Slots] slot selection failed, falling through to free-text: ${slotErr.message}`);
      }
    }

    const proseMessages = structuredSlotLocked
      ? [
          { role: 'system' as const, content: systemContent },
          { role: 'user' as const, content: llmUserMsg },
          { role: 'assistant' as const, content: `Validated outfit:\n${lockedSlotSummary}` },
        ]
      : [
          { role: 'system' as const, content: systemContent },
          ...llmMessages,
        ];

    const completion = await this.openai.chat.completions.create({
      model: 'gpt-4o',
      temperature: structuredSlotLocked ? 0.5 : (useShortlist ? 0.6 : 0.8),
      messages: proseMessages,
    });

    let aiReply =
      completion.choices[0]?.message?.content?.trim() ||
      'Styled response unavailable.';

    // ── Tier 4: Post-LLM avoid-list validation + wardrobe hallucination guard ──
    try {
      // console.log('[AskStyla T4 DEBUG] validation starting');
      const hasAvoidLists = chatAvoidLists.avoidColors.length > 0
        || chatAvoidLists.avoidMaterials.length > 0
        || chatAvoidLists.avoidPatterns.length > 0
        || chatAvoidLists.coverageNoGo.length > 0;
      let allViolations: import('./chatTier4').ChatViolation[] = [];

      // 2A: Avoid-list scan
      if (hasAvoidLists && isStylingResponse(aiReply)) {
        allViolations = scanChatForViolations(aiReply, chatAvoidLists);
      }

      // 2B: Wardrobe hallucination scan
      if (wardrobeItemNames.size > 0 && isStylingResponse(aiReply)) {
        const hallucinations = scanForWardrobeHallucinations(aiReply, wardrobeItemNames);
        if (hallucinations.length > 0) {
          // console.log(`[AskStyla T4] wardrobe hallucination: ${JSON.stringify(hallucinations.map(v => v.term))} not in allowed set`);
          allViolations = [...allViolations, ...hallucinations];
        }
      }

      // console.log('[AskStyla T4 DEBUG] violations:', allViolations);

      if (allViolations.length > 0) {
        // console.log(`[AskStyla T4] violations found: ${JSON.stringify(allViolations.map(v => ({ type: v.type, term: v.term })))}`);

        // Exactly ONE regeneration attempt
        let retried = false;
        if (!retried) {
          retried = true;
          // console.log('[AskStyla T4 DEBUG] regeneration triggered');
          try {
            const correctionPrompt = buildCorrectionPrompt(allViolations);
            const retryCompletion = await this.openai.chat.completions.create({
              model: 'gpt-4o',
              temperature: 0.6,
              messages: [
                {
                  role: 'system',
                  content: `
You are a world-class personal fashion stylist with FULL ACCESS to the user's personal data.

YOU HAVE COMPLETE ACCESS TO ALL OF THIS USER DATA:
${fullContext}
${correctionPrompt}

At the end, return a short JSON block like:
{"search_terms":["smart casual men","navy blazer outfit","loafers"]}
                  `,
                },
                ...llmMessages,
              ],
            });
            const retryReply = retryCompletion.choices[0]?.message?.content?.trim() || '';

            if (retryReply) {
              const retryAvoidViolations = hasAvoidLists ? scanChatForViolations(retryReply, chatAvoidLists) : [];
              const retryHallucinations = wardrobeItemNames.size > 0 ? scanForWardrobeHallucinations(retryReply, wardrobeItemNames) : [];
              const retryViolations = [...retryAvoidViolations, ...retryHallucinations];

              if (retryViolations.length === 0) {
                aiReply = retryReply;
                // console.log('[AskStyla T4] regeneration succeeded — violations cleared');
              } else {
                aiReply = retryReply + buildCorrectionNote(retryViolations);
                // console.log(`[AskStyla T4] regeneration still has ${retryViolations.length} violations — appending note`);
              }
            }
          } catch (retryErr: any) {
            // console.warn(`[AskStyla T4] regeneration failed, using original: ${retryErr.message}`);
            aiReply = aiReply + buildCorrectionNote(allViolations);
          }
          // console.log('[AskStyla T4 DEBUG] regeneration complete');
        }
      } else if (
        (hasAvoidLists || wardrobeItemNames.size > 0) && isStylingResponse(aiReply)
      ) {
        // Tier 4 guard: warn if validation artifacts leaked into user-facing response
        const hasLeakedMarkers = /\bChecked:/i.test(aiReply) || /\bResult:\s*(PASS|FAIL)/i.test(aiReply);
        if (hasLeakedMarkers) {
          // console.warn('[AskStyla T4] validation clean BUT response contains leaked validation markers');
        } else {
          // console.log('[AskStyla T4] validation clean');
        }
      }
    } catch (validationErr: any) {
      // Fail-open: never block the response
      // console.warn(`[AskStyla T4] validation error: ${validationErr.message}`);
    }

    // ── Tier 4: Outfit-shaped response → tasteValidateOutfit gating ──
    // SKIP prose-based extraction validation when structured slots were already validated
    if (!structuredSlotLocked && wardrobeRows.length > 0 && isStylingResponse(aiReply)) {
      try {
        const extractedItems = extractOutfitItemsFromResponse(aiReply, wardrobeRows);

        if (extractedItems.length >= 2) {
          // console.log(`[AskStyla T4 Validator] ${extractedItems.length} outfit items detected: ${extractedItems.map(i => i.name).join(', ')}`);

          // Derive requestedDressCode from user message — same pattern as Stylist Suggestions (line ~6106)
          const chatRequestedDressCode: string | undefined = (() => {
            if (!lastUserMsg) return undefined;
            const m = lastUserMsg.toLowerCase();
            if (/\b(black[\s-]?tie|gala|formal)\b/.test(m)) return 'formal';
            if (/\b(business|office|interview|meeting|professional)\b/.test(m)) return 'business casual';
            return undefined;
          })();

          const chatValidatorCtx: ValidatorContext = {
            climateZone: chatTempF != null ? tempToClimateZone(chatTempF) : undefined,
            requestedDressCode: chatRequestedDressCode,
            styleProfile: chatValidatorProfile,
          };

          const outfitValidation = tasteValidateOutfit(
            extractedItems as ValidatorItem[],
            chatValidatorCtx,
          );

          if (!outfitValidation.valid) {
            // console.log(`[AskStyla T4 Validator] HARD FAIL: ${outfitValidation.hardFails.join('; ')}`);

            // Build targeted correction instructions from specific hardFail types
            const correctionInstructions: string[] = [];
            for (const fail of outfitValidation.hardFails) {
              if (fail.startsWith('MISSING_REQUIRED_SLOTS')) {
                const missing = fail.replace('MISSING_REQUIRED_SLOTS:', '').trim();

                // Inline slot resolution — mirrors mainCatToSlot() in chatTier4.ts exactly
                const resolveSlot = (mainCat: string | undefined): string => {
                  switch ((mainCat ?? '').toLowerCase().trim()) {
                    case 'tops': return 'tops';
                    case 'bottoms': return 'bottoms';
                    case 'shoes': return 'shoes';
                    case 'outerwear': return 'outerwear';
                    case 'dresses': return 'dresses';
                    case 'activewear': return 'activewear';
                    case 'swimwear': return 'swimwear';
                    default: return 'accessories';
                  }
                };

                const injectCandidates = (slotKey: string, slotLabel: string) => {
                  const candidates = wardrobeRows
                    .filter(r => resolveSlot(r.main_category) === slotKey)
                    .slice(0, 5);

                  const candidateNames = candidates
                    .map(r => r.ai_title || r.name)
                    .filter(Boolean);

                  if (candidateNames.length > 0) {
                    correctionInstructions.push(
                      `You MUST include exactly one ${slotLabel} item from the user's wardrobe. Choose one of:\n${candidateNames.map(n => `  - ${n}`).join('\n')}`,
                    );
                  } else {
                    correctionInstructions.push(`You MUST include at least one ${slotLabel} item from the wardrobe.`);
                  }
                };

                if (missing.includes('tops'))    injectCandidates('tops', 'TOP');
                if (missing.includes('bottoms')) injectCandidates('bottoms', 'BOTTOM');
                if (missing.includes('shoes'))   injectCandidates('shoes', 'SHOES');
                if (!missing.includes('tops') && !missing.includes('bottoms') && !missing.includes('shoes')) {
                  correctionInstructions.push(`You are missing required outfit slots: ${missing}. Include items for all required slots.`);
                }
              } else if (fail.startsWith('DRESS_CODE_MISMATCH')) {
                correctionInstructions.push('One or more items violate the requested dress code. Replace them with items whose dress_code is compatible.');
              } else if (fail.startsWith('FORMALITY_FLOOR')) {
                correctionInstructions.push('One or more items are below the user\'s minimum formality level. Choose more formal alternatives from the wardrobe.');
              } else if (fail.startsWith('EXTREME_WEATHER_CONTRADICTION')) {
                correctionInstructions.push('One or more items are inappropriate for the current weather/climate. Choose climate-appropriate alternatives.');
              } else if (fail.startsWith('COVERAGE_NO_GO')) {
                correctionInstructions.push('One or more items violate the user\'s coverage preferences. Choose items that respect their coverage requirements.');
              } else if (fail.startsWith('AVOID_COLOR')) {
                const colorMatch = fail.match(/matches avoided "([^"]+)"/);
                correctionInstructions.push(`Do NOT include items in ${colorMatch ? `"${colorMatch[1]}"` : 'the user\'s avoided colors'}. Pick different-colored alternatives.`);
              } else if (fail.startsWith('AVOID_MATERIAL')) {
                correctionInstructions.push('One or more items use a material the user wants to avoid. Choose items made from different materials.');
              } else if (fail.startsWith('WALKABILITY')) {
                correctionInstructions.push('The shoes are not suitable for the user\'s walkability requirement. Choose more practical footwear.');
              } else if (fail.startsWith('CROSS_PRESENTATION')) {
                correctionInstructions.push('One or more items do not match the user\'s presentation preference. Choose items aligned with their style presentation.');
              }
            }

            const failLines = outfitValidation.hardFails.map(f => `- ${f}`);
            const outfitCorrectionPrompt =
              `\n\nCRITICAL: Your previous outfit suggestion FAILED validation:\n${failLines.join('\n')}\n\nYou must correct these issues. Rules:\n- Use ONLY items from the user's wardrobe.\n- Include all required outfit slots (top, bottom, shoes for separates; dress + shoes for dresses).\n- Respect dress code, formality, climate, and user preferences.\n- Do NOT repeat the previous invalid combination.\n\nRequired corrections:\n${correctionInstructions.map(c => `- ${c}`).join('\n')}`;

            try {
              const validatorRetry = await this.openai.chat.completions.create({
                model: 'gpt-4o',
                temperature: 0.6,
                messages: [
                  { role: 'system', content: systemContent + outfitCorrectionPrompt },
                  ...llmMessages,
                ],
              });
              const retryReply = validatorRetry.choices[0]?.message?.content?.trim() || '';

              if (retryReply) {
                const retryItems = extractOutfitItemsFromResponse(retryReply, wardrobeRows);
                if (retryItems.length >= 2) {
                  const retryValidation = tasteValidateOutfit(
                    retryItems as ValidatorItem[],
                    chatValidatorCtx,
                  );
                  if (retryValidation.valid) {
                    aiReply = retryReply;
                    // console.log('[AskStyla T4 Validator] retry succeeded — validation passed');
                  } else {
                    aiReply = 'I cannot construct a compliant outfit from your wardrobe under current constraints.';
                    // console.log(`[AskStyla T4 Validator] retry also failed (${retryValidation.hardFails.join('; ')}) — returning fallback`);
                  }
                } else {
                  // Retry produced non-outfit response — accept it
                  aiReply = retryReply;
                  // console.log('[AskStyla T4 Validator] retry is non-outfit — accepting');
                }
              }
            } catch (retryErr: any) {
              aiReply = 'I cannot construct a compliant outfit from your wardrobe under current constraints.';
              // console.warn(`[AskStyla T4 Validator] retry error — returning fallback: ${retryErr.message}`);
            }
          } else {
            // console.log(`[AskStyla T4 Validator] passed (coherence: ${outfitValidation.coherenceScore})`);
          }
        }
      } catch (extractErr: any) {
        // Extraction/infrastructure error — log and continue (don't block response)
        // console.warn(`[AskStyla T4 Validator] extraction error: ${extractErr.message}`);
      }
    } else if (structuredSlotLocked) {
      // console.log('[AskStyla T4 Validator] skipped prose extraction — structured slots already validated');
    }

    // ── Tier 4 Reasoning: Quality validation (shortlist queries only) ──
    // Skip when structured slots already validated — prevents spurious regeneration
    if (useShortlist && isStylingResponse(aiReply) && !structuredSlotLocked) {
      try {
        const shortlistNames = shortlist.map(i => (i.name || '').trim().toLowerCase());
        const reasoningOk = validateReasoningQuality(aiReply, shortlistNames);
        if (!reasoningOk) {
          // console.log('[AskStyla T4 Reasoning] quality check failed, regenerating once');
          const retryCompletion = await this.openai.chat.completions.create({
            model: 'gpt-4o',
            temperature: 0.5,
            messages: [
              { role: 'system', content: systemContent + '\n\n' + REASONING_CORRECTION },
              ...llmMessages,
            ],
          });
          const retryReply = retryCompletion.choices[0]?.message?.content?.trim();
          if (retryReply) {
            aiReply = retryReply;
            // console.log('[AskStyla T4 Reasoning] quality retry complete');
          }
        } else {
          // console.log('[AskStyla T4 Reasoning] quality check passed');
        }
      } catch (reasoningErr: any) {
        // Fail-open: never block the response
        // console.warn(`[AskStyla T4 Reasoning] quality validation error: ${reasoningErr.message}`);
      }
    }

    // 2️⃣ Extract search terms if model provided them
    let searchTerms: string[] = [];
    const match = aiReply.match(/\{.*"search_terms":.*\}/s);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        searchTerms = parsed.search_terms ?? [];
      } catch {
        searchTerms = [];
      }
    }

    // 3️⃣ Fallback heuristic: derive terms if none found
    if (!searchTerms.length) {
      const lowered = lastUserMsg.toLowerCase();
      if (lowered.includes('smart')) searchTerms.push('smart casual outfit');
      if (lowered.includes('summer')) searchTerms.push('summer outfit');
      if (lowered.includes('work')) searchTerms.push('business casual look');
      if (!searchTerms.length)
        searchTerms.push(`${lowered} outfit inspiration`);
    }

    // 4️⃣ Fetch Unsplash images
    // console.log('🖼️ Fetching Unsplash for terms:', searchTerms);
    const images = await this.fetchUnsplash(searchTerms);
    // console.log('🖼️ Unsplash returned:', images?.length, 'images');

    // 5️⃣ Build shoppable links
    const links = searchTerms.map((term) => ({
      label: `Shop ${term} on ASOS`,
      url: `https://www.asos.com/search/?q=${encodeURIComponent(term)}`,
    }));
    // console.log('🔗 Built', links?.length, 'shopping links');
    // console.log('✅ Chat response ready - images:', images?.length, 'links:', links?.length);

    /* 🧠 --- SAVE ASSISTANT REPLY --- */
    try {
      await pool.query(
        `INSERT INTO chat_messages (user_id, role, content)
       VALUES ($1,$2,$3)`,
        [user_id, 'assistant', aiReply],
      );
    } catch (err: any) {
      console.warn('⚠️ failed to store assistant reply:', err.message);
    }

    /* 🧠 --- UPDATE LONG-TERM SUMMARY MEMORY (Postgres + Redis) --- */
    try {
      const { rows } = await pool.query(
        `SELECT summary FROM chat_memory WHERE user_id = $1`,
        [user_id],
      );
      const prevSummary = rows[0]?.summary || '';

      const { rows: recent } = await pool.query(
        `SELECT role, content FROM chat_messages
       WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [user_id],
      );

      const context = recent
        .reverse()
        .map((r) => `${r.role}: ${r.content}`)
        .join('\n');

      const memoryPrompt = `
You are a memory summarizer for an AI stylist.
Update this user's long-term fashion memory summary.
Keep what you've already learned, and merge any new useful insights.

Previous memory summary:
${prevSummary}

Recent chat history:
${context}

Write a concise, 150-word updated summary focusing on their taste, preferences, and style evolution.
`;

      const memCompletion = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.3,
        messages: [{ role: 'system', content: memoryPrompt }],
      });

      const newSummary =
        memCompletion.choices[0]?.message?.content?.trim() || prevSummary;

      const trimmedSummary = newSummary.slice(0, 1000).replace(/[*_#`]/g, '');

      await pool.query(
        `INSERT INTO chat_memory (user_id, summary, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id)
       DO UPDATE SET summary = $2, updated_at = NOW();`,
        [user_id, trimmedSummary],
      );

      // ✅ Cache the updated summary in Redis for 24 hours
      await redis.set(`memory:${user_id}`, trimmedSummary, { ex: 86400 });
    } catch (err: any) {
      console.warn('⚠️ failed to update long-term memory:', err.message);
    }

    return { reply: aiReply, images, links };
  }

  // 🧠 Completely clear all chat + memory for a user
  async clearChatHistory(user_id: string) {
    try {
      // 1️⃣ Delete all chat messages for the user
      await pool.query(`DELETE FROM chat_messages WHERE user_id = $1`, [
        user_id,
      ]);

      // 2️⃣ Delete long-term memory summaries
      await pool.query(`DELETE FROM chat_memory WHERE user_id = $1`, [user_id]);

      // 3️⃣ Clear Redis cache for this user
      await redis.del(`memory:${user_id}`);

      console.log(`🧹 Cleared ALL chat + memory for user ${user_id}`);
      return { success: true, message: 'All chat history and memory cleared.' };
    } catch (err: any) {
      console.error('❌ Failed to clear chat history:', err.message);
      throw new Error('Failed to clear chat history.');
    }
  }

  // 🧹 Soft reset: clear short-term chat but retain long-term memory
  async softResetChat(user_id: string) {
    try {
      // Delete recent messages but keep memory summary
      await pool.query(`DELETE FROM chat_messages WHERE user_id = $1`, [
        user_id,
      ]);

      console.log(`🧹 Soft reset chat for user ${user_id}`);
      return {
        success: true,
        message: 'Recent chat messages cleared (long-term memory retained).',
      };
    } catch (err: any) {
      console.error('❌ Failed to soft-reset chat:', err.message);
      throw new Error('Failed to soft reset chat.');
    }
  }

  /** 🔍 Lightweight Unsplash fetch helper */
  private async fetchUnsplash(terms: string[]) {
    if (!secretExists('UNSPLASH_ACCESS_KEY') || !terms.length) return [];
    const key = getSecret('UNSPLASH_ACCESS_KEY');
    const q = encodeURIComponent(terms[0]);
    const res = await fetch(
      `https://api.unsplash.com/search/photos?query=${q}&per_page=5&client_id=${key}`,
    );
    if (!res.ok) return [];
    const json = await res.json();
    return json.results.map((r) => ({
      imageUrl: r.urls.small,
      title: r.description || r.alt_description,
      sourceLink: r.links.html,
    }));
  }

  /** 🌤️ Suggest daily style plan */
  async suggest(body: {
    user?: string;
    user_id?: string; // Auth user ID for feedback read-back
    weather?: any;
    wardrobe?: any[];
    preferences?: Record<string, any>;
    format?: 'text' | 'visual';
    constraint?: string;
    mode?: 'auto' | 'manual';
  }) {
    const {
      user,
      user_id,
      weather,
      wardrobe,
      preferences,
      format = 'text',
      constraint,
      mode = 'manual',
    } = body;

    // If visual format requested and wardrobe has items with images
    const hasWardrobeWithImages = wardrobe?.some(
      (item) => item.image_url || item.image,
    );
    if (format === 'visual' && hasWardrobeWithImages && wardrobe) {
      return this.suggestVisualOutfits(
        user,
        user_id,
        weather,
        wardrobe,
        preferences,
        constraint,
        mode,
      );
    }

    // Original text-based suggestion logic
    const temp = weather?.fahrenheit?.main?.temp;
    const tempDesc = temp
      ? `${temp}°F and ${temp < 60 ? 'cool' : temp > 85 ? 'warm' : 'mild'} weather`
      : 'unknown temperature';

    const wardrobeCount = wardrobe?.length || 0;

    const systemPrompt = `
You are a luxury personal stylist.
Your goal is to provide a daily style briefing that helps the user feel prepared, stylish, and confident.
Be concise, intelligent, and polished — similar to a stylist at a high-end menswear brand.

Output must be JSON with:
- suggestion
- insight
- tomorrow
Optionally include seasonalForecast, lifecycleForecast, styleTrajectory.
`;

    const userPrompt = `
Client: ${user || 'The user'}
Weather: ${tempDesc}
Wardrobe items: ${wardrobeCount}
Preferences: ${JSON.stringify(preferences || {})}
`;

    const completion = await this.openai.chat.completions.create({
      model: 'gpt-4o',
      temperature: 0.8,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
    });

    const raw = completion.choices[0]?.message?.content;
    if (!raw) throw new Error('No suggestion response received from model.');

    let parsed: {
      suggestion: string;
      insight: string;
      tomorrow: string;
      seasonalForecast?: string;
      lifecycleForecast?: string;
      styleTrajectory?: string;
    };

    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error('❌ Failed to parse AI JSON:', raw);
      throw new Error('AI response was not valid JSON.');
    }

    if (!parsed.seasonalForecast) {
      parsed.seasonalForecast = generateSeasonalForecast(wardrobe);
    }

    return parsed;
  }

  /**
   * 🎯 LEARNING INTEGRATION: Fetch user feedback context for AI Stylist
   * Reads from user_pref_item and outfit_feedback to provide preference signals
   */
  private async getUserFeedbackContext(
    userId: string | undefined,
    wardrobe: any[],
  ): Promise<{
    itemScores: Map<string, number>;
    likedPatterns: string[];
    dislikedPatterns: string[];
    recentFeedbackSummary: string;
  }> {
    const emptyResult = {
      itemScores: new Map<string, number>(),
      likedPatterns: [] as string[],
      dislikedPatterns: [] as string[],
      recentFeedbackSummary: '',
    };

    if (!userId) {
      return emptyResult;
    }

    try {
      // 1. Fetch item-level preference scores
      const itemIds = wardrobe.map((item) => item.id).filter(Boolean);
      if (itemIds.length === 0) {
        return emptyResult;
      }

      const { rows: prefRows } = await pool.query<{
        item_id: string;
        score: number;
      }>(
        `SELECT item_id, score FROM user_pref_item
         WHERE user_id = $1 AND item_id = ANY($2)`,
        [userId, itemIds],
      );

      const itemScores = new Map<string, number>(
        prefRows.map((r) => [String(r.item_id), Number(r.score)]),
      );

      // 2. Extract liked/disliked patterns from high-scoring items
      const likedPatterns: string[] = [];
      const dislikedPatterns: string[] = [];

      for (const item of wardrobe) {
        const score = itemScores.get(item.id);
        if (score && score >= 2) {
          // Strongly liked items
          const pattern =
            `${item.color || ''} ${item.main_category || item.category || ''}`.trim();
          if (pattern && !likedPatterns.includes(pattern)) {
            likedPatterns.push(pattern);
          }
        } else if (score && score <= -2) {
          // Strongly disliked items
          const pattern =
            `${item.color || ''} ${item.main_category || item.category || ''}`.trim();
          if (pattern && !dislikedPatterns.includes(pattern)) {
            dislikedPatterns.push(pattern);
          }
        }
      }

      // 3. Build summary for prompt injection
      const parts: string[] = [];
      if (likedPatterns.length > 0) {
        parts.push(`Preferred: ${likedPatterns.slice(0, 5).join(', ')}`);
      }
      if (dislikedPatterns.length > 0) {
        parts.push(`Avoid: ${dislikedPatterns.slice(0, 3).join(', ')}`);
      }

      const recentFeedbackSummary =
        parts.length > 0
          ? `\n\n👍 USER PREFERENCES (from past feedback):\n${parts.join('\n')}`
          : '';

      // console.log(
      //   `🎯 [AI Stylist] Loaded feedback for ${userId}: ${prefRows.length} item scores, ${likedPatterns.length} liked patterns`,
      // );

      return {
        itemScores,
        likedPatterns,
        dislikedPatterns,
        recentFeedbackSummary,
      };
    } catch (err: any) {
      console.warn(
        '⚠️ [AI Stylist] Failed to load user feedback:',
        err.message,
      );
      return emptyResult;
    }
  }

  /** 👗 Suggest visual outfit combinations with images */
  private async suggestVisualOutfits(
    user: string | undefined,
    userId: string | undefined, // Auth user ID for feedback read-back
    weather: any,
    wardrobe: any[],
    preferences: Record<string, any> | undefined,
    constraint?: string,
    mode: 'auto' | 'manual' = 'manual',
  ) {
    const temp = weather?.fahrenheit?.main?.temp;
    const condition = weather?.fahrenheit?.weather?.[0]?.main || '';
    const tempDesc = temp
      ? `${temp}°F and ${temp < 60 ? 'cool' : temp > 85 ? 'warm' : 'mild'} weather`
      : 'unknown temperature';

    // Generate concise weather summary for UI
    const weatherSummary = this.generateWeatherSummary(temp, condition);

    // 🎯 LEARNING INTEGRATION: Fetch user feedback context
    const feedbackContext = await this.getUserFeedbackContext(userId, wardrobe);

    // 🧠 STYLIST BRAIN: Load full style context (presentation + style profile + fashion state)
    // Replaces standalone gender_presentation query with unified loader.
    let brainCtx: StylistBrainContext = {
      presentation: 'mixed',
      styleProfile: null,
      fashionState: null,
    };
    if (userId && this.fashionStateService) {
      brainCtx = await loadStylistBrainContext(
        userId,
        this.fashionStateService,
      );
    }

    // ── BLOCKING FALLBACK: Guarantee styleProfile for Suggestions path ──
    // loadStylistBrainContext uses Promise.race with 200ms timeout.
    // Cloud SQL can exceed this, returning defaults. Recover here with
    // a direct blocking fetch — no timeout race — so outfit generation
    // never runs against null styleProfile.
    if (userId && !brainCtx.styleProfile) {
      try {
        const [profileResult, presentationResult] = await Promise.all([
          pool.query(
            'SELECT * FROM style_profiles WHERE user_id = $1',
            [userId],
          ),
          // Also recover presentation if brain timed out (still 'mixed' default)
          brainCtx.presentation === 'mixed'
            ? pool.query(
                'SELECT gender_presentation FROM users WHERE id = $1 LIMIT 1',
                [userId],
              )
            : Promise.resolve(null),
        ]);

        if (profileResult.rows[0]) {
          brainCtx.styleProfile = parseStyleProfileRow(profileResult.rows[0]);
        }
        if (presentationResult?.rows?.[0]?.gender_presentation) {
          brainCtx.presentation = resolvePresentation(
            presentationResult.rows[0].gender_presentation,
          );
        }

        // console.log(
        //   JSON.stringify({
        //     _tag: 'STYLIST_BRAIN_FALLBACK_USED',
        //     recoveredProfile: !!brainCtx.styleProfile,
        //     presentation: brainCtx.presentation,
        //   }),
        // );
      } catch (err) {
        console.error('STYLIST_BRAIN_FALLBACK_FAILED:', err);
      }
    }

    // HARD GUARD: Never generate outfits without personalization
    if (userId && !brainCtx?.styleProfile) {
      throw new Error('STYLIST_BRAIN_MISSING: personalization required');
    }

    // ALWAYS-ON: prove what brainCtx.styleProfile contains after load
    // console.log(
    //   JSON.stringify({
    //     _tag: 'BRAIN_STYLE_PROFILE_PROOF',
    //     hasStyleProfile: !!brainCtx?.styleProfile,
    //     keys: Object.keys(brainCtx?.styleProfile ?? {}),
    //     avoid: (brainCtx as any)?.styleProfile?.avoid_colors ?? null,
    //   }),
    // );

    // STYLIST_BRAIN_READY: Proof brain is loaded BEFORE candidate generation
    // console.log(
    //   JSON.stringify({
    //     _tag: 'STYLIST_BRAIN_READY',
    //     hasProfile: true,
    //     presentation: brainCtx.presentation,
    //     keys: Object.keys(brainCtx.styleProfile || {}),
    //   }),
    // );
    let userPresentation = brainCtx.presentation;

    // ── Implicit presentation fallback when no style profile exists ──
    // If brain returned 'mixed' AND no style profile, infer from wardrobe composition.
    // This prevents cross-presentation outfits (e.g. men's sweater + women's skirt).
    let _implicitPresentation: 'masculine' | 'feminine' | 'mixed' | null = null;
    if (userPresentation === 'mixed' && !brainCtx.styleProfile) {
      _implicitPresentation = inferImplicitPresentation(wardrobe);
      if (_implicitPresentation) {
        userPresentation = _implicitPresentation;
      }
      console.log(
        JSON.stringify({
          _tag: 'IMPLICIT_PRESENTATION_PROOF',
          implicitPresentation: _implicitPresentation,
          effectivePresentation: userPresentation,
        }),
      );
    }

    // Build filtered wardrobe: exclude feminine-only items for masculine users.
    // Does NOT mutate the original wardrobe array.
    const filteredWardrobe =
      userPresentation === 'masculine'
        ? wardrobe.filter((item) => {
            const cat = item.main_category || item.category || '';
            const sub = (item.subcategory || '').toLowerCase();
            const name = (item.name || '').toLowerCase();

            // Main category hard blocks
            if (cat === 'Dresses' || cat === 'Skirts') return false;

            // Subcategory feminine-only detection (matches capsuleEngine.inferGarmentFlags)
            const isDress = sub.endsWith('dress');
            const isSkirt = sub.includes('skirt');
            const isBlouse = sub.includes('blouse');
            const isGown = sub.includes('gown');
            const isHeels =
              (sub.includes('heel') && !name.includes('heel tab')) ||
              sub.includes('stiletto') ||
              sub.includes('pump') ||
              sub.includes('slingback') ||
              sub.includes('mary jane');
            const isBalletFlat =
              sub.includes('ballet flat') ||
              (name.includes('ballet') && name.includes('flat'));
            const isEarring =
              sub.includes('earring') || name.includes('earring');
            const isBracelet =
              sub.includes('bracelet') || name.includes('bracelet');
            const isAnklet = sub.includes('anklet') || name.includes('anklet');
            const isPurse =
              sub.includes('purse') ||
              sub.includes('handbag') ||
              sub.includes('clutch') ||
              name.includes('purse') ||
              name.includes('handbag');

            if (
              isDress ||
              isSkirt ||
              isBlouse ||
              isGown ||
              isHeels ||
              isBalletFlat ||
              isEarring ||
              isBracelet ||
              isAnklet ||
              isPurse
            ) {
              return false;
            }
            return true;
          })
        : wardrobe; // feminine / mixed → no filtering

    // Exclude items at the cleaner — cannot be worn
    const availableWardrobe = filteredWardrobe.filter(
      (item) =>
        (item.careStatus ?? item.care_status ?? 'available') !== 'at_cleaner',
    );

    // 🔄 VARIETY: Hard exclusion of previously suggested items from LLM input.
    // categoryPools (completeness injection) still use availableWardrobe — only LLM sees the reduced set.
    const prevIds = userId ? this.visualExclusionCache.get(userId) : undefined;
    const prevIdSet = prevIds?.length ? new Set(prevIds) : null;
    let llmWardrobe = availableWardrobe;
    if (prevIdSet && availableWardrobe.length >= 8) {
      const candidate = availableWardrobe.filter(
        (item) => !prevIdSet.has(item.id),
      );
      const poolCount = (arr: any[], cat: string) =>
        arr.filter(
          (i) => this.mapToCategory(i.main_category || i.category) === cat,
        ).length;
      const ok =
        (poolCount(candidate, 'top') >= 3 &&
          poolCount(candidate, 'bottom') >= 3 &&
          poolCount(candidate, 'shoes') >= 3) ||
        poolCount(candidate, 'dress') >= 2;
      if (ok) llmWardrobe = candidate;
    }

    // 🔄 DEBUG: variety tracking (toggle via DEBUG_VARIETY env var)
    if (process.env.DEBUG_VARIETY === 'true' && userId) {
      console.log(
        `🔄 [Variety] req=${Date.now()} uid=${userId.slice(0, 8)} prevIds=${prevIdSet ? prevIds!.slice(0, 10).join(',') : 'none'} filtered=${availableWardrobe.length} llm=${llmWardrobe.length}`,
      );
    }

    // 🌡️ HARD WEATHER PRE-FILTER: Score items against structured weather context
    const wxContext: WeatherContext | undefined =
      temp != null
        ? {
            tempF: temp,
            precipitation: (condition || '').toLowerCase().includes('rain')
              ? 'rain'
              : (condition || '').toLowerCase().includes('snow')
                ? 'snow'
                : 'none',
            windMph: weather?.fahrenheit?.wind?.speed,
          }
        : undefined;

    for (const item of availableWardrobe) {
      item.__weatherScore = scoreItemForWeather(item, wxContext);
    }

    // Build wardrobe summary with IDs for AI to reference
    // Blended ranking: weather relevance (0.6) + feedback preference (0.4)
    // Weather hard filter preserved: items below -5 still excluded
    const _blendedItems = llmWardrobe
      .filter((item) => item.image_url || item.image)
      .filter((item) => item.__weatherScore >= -5) // hard weather filter preserved
      .map((item) => {
        const feedbackScore = feedbackContext.itemScores.get(item.id) || 0;
        // Normalize weather to [0,1]: __weatherScore range is approx [-5, +10]
        // Items that passed filter are >= -5. Clamp to [0,1].
        const rawWeather = item.__weatherScore ?? 0;
        const normWeather = Math.max(0, Math.min(1, (rawWeather + 5) / 15));
        // Normalize feedback to [0,1]: typical range [-5, +5]
        const normFeedback = Math.max(0, Math.min(1, (feedbackScore + 5) / 10));
        const blendedScore = 0.6 * normWeather + 0.4 * normFeedback;
        return { ...item, feedbackScore, __blendedScore: blendedScore };
      })
      // Sort by blended score (weather + feedback) — best contextual fit first
      .sort((a, b) => b.__blendedScore - a.__blendedScore);

    // 🎯 LEARNING FILTER: Hard-exclude disliked items, guarantee-include favorites
    const { filtered: _learningFiltered, vetoIds: _stylistVetoIds } =
      filterWardrobeForStylist(_blendedItems, feedbackContext.itemScores);

    const wardrobeSummary = _learningFiltered
      .map((item) => ({
        id: item.id,
        name: (item as any).name || (item as any).ai_title || 'Unnamed item',
        category: (item as any).main_category || (item as any).category || 'unknown',
        color: (item as any).color || (item as any).dominant_hex || 'unknown',
        style: (item as any).style_descriptors?.join(', ') || '',
        // Include preference indicator for AI context
        preference:
          (item as any).feedbackScore > 0
            ? 'liked'
            : (item as any).feedbackScore < 0
              ? 'avoid'
              : undefined,
      }));

    // Guard: empty wardrobe → clean early return (no LLM call)
    if (wardrobeSummary.length === 0) {
      return {
        weatherSummary: weatherSummary || 'No weather data available.',
        outfits: [],
        message: 'Add items to your wardrobe to get AI outfit suggestions.',
      };
    }

    // Detect if this is a single-piece swap request
    const isSwapRequest = constraint?.toLowerCase().startsWith('swap ');
    const swapMatch = constraint?.match(
      /swap (\w+) only, keep these items: (.+)/i,
    );
    const swapCategory = swapMatch?.[1];
    const keepItemIds = swapMatch?.[2]?.split(', ').filter(Boolean) || [];

    // Detect adjustment type for partial outfit modifications
    const adjustmentType = constraint?.toLowerCase();
    const isPartialAdjustment =
      adjustmentType &&
      [
        'more casual',
        'more formal',
        'warmer layers',
        'lighter, cooler',
        'different color palette',
      ].includes(adjustmentType);

    // Build adjustment-specific rules for preserving outfit continuity
    let adjustmentRules = '';
    if (isPartialAdjustment && !isSwapRequest) {
      const adjustmentGuide: Record<string, string> = {
        'more casual': `PARTIAL ADJUSTMENT - MORE CASUAL:
   - Keep 70-80% of the previous outfit items
   - Only swap 1-2 pieces to reduce formality (e.g., dress shoes → clean sneakers, blazer → casual jacket)
   - Preserve the color palette and silhouette integrity
   - In reasoning, reference what you kept: "Keeping the [item], but swapping [item] for..."`,
        'more formal': `PARTIAL ADJUSTMENT - MORE FORMAL:
   - Keep 70-80% of the previous outfit items
   - Only swap 1-2 pieces to increase structure (e.g., sneakers → loafers, t-shirt → button-down)
   - Preserve the color palette and overall cohesion
   - In reasoning, reference what you kept: "Same foundation, elevating with..."`,
        'warmer layers': `PARTIAL ADJUSTMENT - WARMER LAYERS:
   - Keep 80%+ of the outfit items
   - Only ADD or UPGRADE outerwear (e.g., add a jacket, swap light layer → heavier)
   - Do NOT change shoes, bottoms, or accessories unless absolutely necessary
   - In reasoning, reference what stays: "Adding warmth with [item] while keeping..."`,
        'lighter, cooler': `PARTIAL ADJUSTMENT - COOLER OUTFIT:
   - Keep 80%+ of the outfit items
   - Only REMOVE or DOWNGRADE layers (e.g., remove jacket, swap heavy → light)
   - Do NOT change the core outfit pieces
   - In reasoning, reference what stays: "Lightening up by removing [item], keeping..."`,
        'different color palette': `PARTIAL ADJUSTMENT - DIFFERENT COLORS:
   - Keep the SAME silhouettes and item categories
   - Only swap items for different color variations from the wardrobe
   - Preserve fit, formality, and weather-appropriateness
   - In reasoning, reference the shift: "Same shapes, shifting to [color family]..."`,
      };
      adjustmentRules = adjustmentGuide[adjustmentType] || '';
    }

    // Mode-specific tone guidance
    const modeGuidance =
      mode === 'auto'
        ? `MODE: AUTOMATIC — Use proactive phrasing: "Styled for your day ahead...", "Ready for your evening"`
        : `MODE: MANUAL — Use responsive phrasing: "Here's what works...", "This should do the trick..."`;

    // Gender-aware prompt guidance (visual mode only)
    const genderGuidance =
      userPresentation === 'masculine'
        ? `\n════════════════════════\nGENDER CONTEXT\n════════════════════════\nThis user presents masculine. NEVER include dresses, skirts, gowns, blouses, heels, ballet flats, purses, or any feminine-coded garments. Only use items from the wardrobe list provided.\n`
        : userPresentation === 'feminine'
          ? `\n════════════════════════\nGENDER CONTEXT\n════════════════════════\nThis user presents feminine. Dresses, skirts, and all feminine garments are allowed and encouraged when appropriate.\n`
          : ''; // mixed → no additional guidance

    let systemPrompt = `
You are a PROFESSIONAL HUMAN FASHION STYLIST, not an assistant, not a chatbot, and not a creative experimenter.

This recommendation appears ABOVE THE FOLD on app launch.
A single bad suggestion causes user trust loss and app deletion.

Your primary objective is NOT creativity.
Your objective is ACCURACY, STYLE ALIGNMENT, and TRUST.

${modeGuidance}
${genderGuidance}

════════════════════════
NON-NEGOTIABLE RULES
════════════════════════

1. NEVER output an outfit unless you are highly confident it matches the user's style.
2. NEVER surprise the user with bold, experimental, or identity-breaking choices.
3. NEVER justify a bad outfit with clever wording.
4. WHEN IN DOUBT, choose safer, simpler, more classic options.
5. BORING BUT CORRECT beats interesting but risky.
6. YOU ARE ALLOWED TO BE CONSERVATIVE. THIS IS A FEATURE.

════════════════════════
HARD FILTERS (ABSOLUTE BLOCKERS)
════════════════════════

DISCARD any outfit that violates ANY of the following:
- Weather incompatibility (wrong fabric weight, missing layers for cold, too heavy for warm)
- Dress code mismatch
- Missing required layers (top, bottom, shoes minimum)
- Unbalanced silhouettes or clashing color harmony
- Radical deviation from classic, safe styling

If an outfit fails ANY filter → IT MUST NOT EXIST.

════════════════════════
CONFIDENCE THRESHOLD
════════════════════════

Only output outfits you are CONFIDENT the user would realistically wear today.

High confidence indicators:
- Similar silhouettes to classic, proven combinations
- Neutral or trusted color palettes (navy, grey, black, white, earth tones)
- Context-appropriate layering
- Weather-right fabric choices

Low confidence → choose safer alternatives or reduce complexity.

════════════════════════
RANKING RULES
════════════════════════

Rank 1 = PRIMARY RECOMMENDATION
- Must be the safest, strongest, most reliable option
- Should feel inevitable, not experimental
- This is the outfit you would personally stand behind with your reputation

Rank 2 = POLISHED VARIATION
- Slightly more elevated or refined
- Still fully safe and aligned

Rank 3 = RELAXED OPTION
- Lower formality, more laid-back
- Still coherent and intentional

Do NOT make ranks feel equal. Rank 1 is THE recommendation.

${
  isSwapRequest && swapCategory
    ? `
════════════════════════
SINGLE-PIECE SWAP
════════════════════════
User wants to swap ONLY the ${swapCategory}.
- MUST keep these exact items in ALL 3 outfits: ${keepItemIds.join(', ')}
- Only change the ${swapCategory} - pick 3 different safe options
- Each outfit = same kept items + different ${swapCategory}
- In reasoning, reference continuity: "Keeping everything else, but trying..."
`
    : adjustmentRules
      ? `
════════════════════════
ADJUSTMENT MODE
════════════════════════
${adjustmentRules}
`
      : constraint
        ? `
════════════════════════
CONSTRAINT
════════════════════════
"${constraint}" - adjust accordingly but maintain safety and alignment.
`
        : ''
}

════════════════════════
EXPLANATION STYLE
════════════════════════

Sound like a confident human stylist. Be concise and opinionated.

DO:
- Explain WHY it works (weather, silhouette, practicality)
- Be direct and confident
- Reinforce trust

DO NOT:
- Describe items mechanically
- Use phrases like "this outfit combines…"
- Over-explain or justify weak choices

Good: "Clean, confident, and weather-right. The layers add warmth without bulk, silhouette stays sharp."
Bad: "This outfit combines a shirt with pants and shoes for a cohesive look."

════════════════════════
FAILSAFE RULE
════════════════════════

If you cannot confidently produce a GREAT outfit:
- Default to a simple, clean, classic, low-risk option
- Reduce color complexity
- Reduce layering complexity
- Prefer familiarity over novelty

Never output a risky outfit just to fill space.

════════════════════════
FINAL SELF-CHECK (MANDATORY)
════════════════════════

Before outputting, ask:
"Would I confidently recommend this to a real client I care about?"

If the answer is not an immediate YES → DO NOT OUTPUT.

════════════════════════
OUTPUT FORMAT
════════════════════════

Build 6–9 complete outfits. We will select the best 3 downstream — your job is to
give us a strong pool of candidates. Each outfit must stand on its own as a complete,
wearable look. Prefer items listed earlier in the wardrobe (they are ordered by relevance).

Output valid JSON only:
{
  "outfits": [
    {
      "id": "outfit-1",
      "rank": 1,
      "title": "Short creative outfit name (3-6 words, e.g. 'Relaxed Weekend Layers')",
      "summary": "2-4 sentence professional stylist explanation (120-220 chars). Reference silhouette, color harmony, and occasion suitability. No emojis. No markdown. No bullet points. No system labels.",
      "reasoning": "WHY this works — 1-2 sentences, reference weather/context",
      "itemIds": ["item-id-1", "item-id-2", "item-id-3"]
    },
    {
      "id": "outfit-2",
      "rank": 2,
      "title": "...",
      "summary": "...",
      "reasoning": "...",
      "itemIds": ["..."]
    }
    // ... continue for 6-9 outfits total. Rank each 1-9 (1 = best).
  ]
}
`;

    // 🛡️ FORMALITY CONSISTENCY — generation-time guidance to prevent tier mismatches
    systemPrompt += `
════════════════════════
FORMALITY CONSISTENCY RULE (STRICT)
════════════════════════

Each outfit must stay within a single formality tier.

Tiers:
0 - Athletic: activewear, gym shorts, performance sneakers
1 - Casual: t-shirts, hoodies, denim, sneakers
2 - Smart Casual: knitwear, polos, chinos, boots, loafers
3 - Business: dress shirts, dress trousers, derbies, structured leather shoes
4 - Formal: tuxedo, gown, patent shoes, eveningwear

Do NOT mix items across tiers where the spread exceeds 2 levels.
Examples of invalid mixes:
- Athletic bottom + business or formal shoes
- Swimwear + dress shoes
- Gym shorts + blazer + leather dress shoes

All items in a single outfit must feel coherent in social context.
`;

    // 🧠 STYLE PROFILE CONTEXT — inject DB-backed preferences into system prompt
    if (brainCtx.styleProfile) {
      const sp = brainCtx.styleProfile;
      const fs = brainCtx.fashionState;
      const lines: string[] = [];

      // Coloring context
      const coloringParts: string[] = [];
      if (sp.skin_tone) coloringParts.push(`skin: ${sp.skin_tone}`);
      if (sp.undertone) coloringParts.push(`undertone: ${sp.undertone}`);
      if (sp.hair_color) coloringParts.push(`hair: ${sp.hair_color}`);
      if (sp.eye_color) coloringParts.push(`eyes: ${sp.eye_color}`);
      if (coloringParts.length > 0)
        lines.push(`• Coloring: ${coloringParts.join(', ')}`);

      // Body & proportions
      if (sp.body_type) lines.push(`• Body type: ${sp.body_type}`);
      if (sp.proportions) lines.push(`• Proportions: ${sp.proportions}`);

      // Key measurements
      const measParts: string[] = [];
      if (sp.height != null) measParts.push(`height: ${sp.height}`);
      if (sp.waist != null) measParts.push(`waist: ${sp.waist}`);
      if (sp.shoe_size != null) measParts.push(`shoe: ${sp.shoe_size}`);
      if (sp.chest != null) measParts.push(`chest: ${sp.chest}`);
      if (sp.hip != null) measParts.push(`hip: ${sp.hip}`);
      if (measParts.length > 0)
        lines.push(`• Key measurements: ${measParts.join(', ')}`);

      if (sp.favorite_colors.length > 0)
        lines.push(`• Preferred colors: ${sp.favorite_colors.join(', ')}`);
      if (sp.fit_preferences.length > 0)
        lines.push(`• Fit preferences: ${sp.fit_preferences.join(', ')}`);
      if (sp.fabric_preferences.length > 0)
        lines.push(`• Fabric preferences: ${sp.fabric_preferences.join(', ')}`);

      // Merge preferred brands from style_profiles + fashionState
      const allBrands = [
        ...new Set([...sp.preferred_brands, ...(fs?.topBrands ?? [])]),
      ];
      if (allBrands.length > 0)
        lines.push(`• Preferred brands: ${allBrands.join(', ')}`);

      // Avoid lists from fashionState + disliked_styles
      const avoidStyles = [
        ...new Set([...sp.disliked_styles, ...(fs?.avoidStyles ?? [])]),
      ];
      if (avoidStyles.length > 0)
        lines.push(`• Avoided styles: ${avoidStyles.join(', ')}`);
      if (fs?.avoidBrands?.length)
        lines.push(`• Avoided brands: ${fs.avoidBrands.join(', ')}`);
      if (fs?.avoidColors?.length)
        lines.push(`• Avoided colors: ${fs.avoidColors.join(', ')}`);

      // Occasions
      if (sp.occasions.length > 0)
        lines.push(`• Typical occasions: ${sp.occasions.join(', ')}`);

      // P0 hard vetoes — LLM must respect
      if (sp.coverage_no_go.length > 0)
        lines.push(
          `HARD RULE — Coverage restrictions (NEVER include items violating these): ${sp.coverage_no_go.join(', ')}`,
        );
      if (sp.avoid_colors.length > 0) {
        const _expandedPromptAvoid = expandStylistAvoidColors(sp.avoid_colors);
        lines.push(
          `HARD RULE — NEVER use these colors (or any shade/variant): ${_expandedPromptAvoid.join(', ')}`,
        );
      }
      if (sp.avoid_materials.length > 0)
        lines.push(
          `HARD RULE — NEVER use these materials: ${sp.avoid_materials.join(', ')}`,
        );
      if (sp.formality_floor)
        lines.push(
          `HARD RULE — Minimum formality: ${sp.formality_floor} (never suggest items below this level)`,
        );
      if (sp.walkability_requirement && sp.walkability_requirement !== 'Low')
        lines.push(
          `HARD RULE — Walkability requirement: ${sp.walkability_requirement} (avoid impractical footwear)`,
        );

      // P1 soft preferences
      if (sp.pattern_preferences.length > 0)
        lines.push(
          `• Preferred patterns: ${sp.pattern_preferences.join(', ')}`,
        );
      if (sp.avoid_patterns.length > 0)
        lines.push(`• Avoided patterns: ${sp.avoid_patterns.join(', ')}`);
      if (sp.silhouette_preference)
        lines.push(`• Silhouette preference: ${sp.silhouette_preference}`);
      if (sp.care_tolerance)
        lines.push(`• Care tolerance: ${sp.care_tolerance}`);
      if (sp.metal_preference && sp.metal_preference !== 'No preference')
        lines.push(`• Jewelry metal preference: ${sp.metal_preference}`);
      if (sp.contrast_preference && sp.contrast_preference !== 'No preference')
        lines.push(`• Contrast preference: ${sp.contrast_preference}`);
      if (sp.footwear_comfort)
        lines.push(`• Footwear comfort priority: ${sp.footwear_comfort}`);
      if (sp.foot_width && sp.foot_width !== 'Standard')
        lines.push(`• Foot width: ${sp.foot_width}`);

      // LLM-only soft context
      if (sp.fashion_boldness)
        lines.push(`• Fashion boldness: ${sp.fashion_boldness}`);
      if (sp.trend_appetite)
        lines.push(`• Trend appetite: ${sp.trend_appetite}`);
      if (sp.fashion_confidence)
        lines.push(`• Fashion confidence: ${sp.fashion_confidence}`);
      if (sp.budget_min != null || sp.budget_max != null)
        lines.push(
          `• Budget range: ${sp.budget_min ?? '?'}–${sp.budget_max ?? '?'}`,
        );
      if (sp.style_icons.length > 0)
        lines.push(`• Style icons: ${sp.style_icons.join(', ')}`);
      if (sp.daily_activities.length > 0)
        lines.push(`• Daily activities: ${sp.daily_activities.join(', ')}`);
      if (sp.personality_traits.length > 0)
        lines.push(`• Personality traits: ${sp.personality_traits.join(', ')}`);
      if (sp.lifestyle_notes)
        lines.push(`• Lifestyle notes: ${sp.lifestyle_notes}`);

      if (lines.length > 0) {
        systemPrompt += `
════════════════════════
STYLE PROFILE (from user's saved preferences — treat as strong signals)
════════════════════════

${lines.join('\n')}

Use these preferences to guide outfit selection. Prioritize items matching these preferences.
`;
      }
    }

    const userPrompt = `
Client: ${user || 'The user'}
Weather: ${tempDesc}
${preferences && Object.keys(preferences).length > 0 ? `Client-provided preferences (treat as session overrides): ${JSON.stringify(preferences)}` : ''}
${feedbackContext.recentFeedbackSummary}

Available wardrobe items (ordered by relevance — prefer items listed earlier):
${JSON.stringify(wardrobeSummary, null, 2)}

${feedbackContext.likedPatterns.length > 0 ? `NOTE: Items marked with "preference": "liked" are user favorites - prioritize these.` : ''}
${feedbackContext.dislikedPatterns.length > 0 ? `NOTE: Items marked with "preference": "avoid" have been disliked - use sparingly or avoid.` : ''}
`;

    const completion = await this.openai.chat.completions.create({
      model: 'gpt-4o',
      temperature: 0, // Deterministic: variety via visualExclusionCache, not randomness
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
    });

    const raw = completion.choices[0]?.message?.content;
    if (!raw)
      throw new Error('No visual suggestion response received from model.');

    let parsed: {
      outfits: Array<{
        id: string;
        rank: number;
        title?: string;
        summary: string;
        reasoning?: string;
        itemIds: string[];
      }>;
    };

    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error('❌ Failed to parse visual AI JSON:', raw);
      throw new Error('AI response was not valid JSON.');
    }

    // 🛡️ HARD BLOCK: Strongly disliked items (score <= -2) cannot appear in Rank 1
    const stronglyDislikedIds = new Set(
      [...feedbackContext.itemScores.entries()]
        .filter(([_, score]) => score <= -2)
        .map(([id]) => id),
    );

    if (stronglyDislikedIds.size > 0) {
      const rank1Outfit = parsed.outfits.find((o) => o.rank === 1);
      if (rank1Outfit) {
        const hasDislikedItem = rank1Outfit.itemIds.some((id) =>
          stronglyDislikedIds.has(id),
        );
        if (hasDislikedItem) {
          console.warn(
            '🛡️ [AI Stylist] Rank 1 contained disliked item — swapping with Rank 2',
          );
          // Swap Rank 1 and Rank 2
          const rank2Outfit = parsed.outfits.find((o) => o.rank === 2);
          if (
            rank2Outfit &&
            !rank2Outfit.itemIds.some((id) => stronglyDislikedIds.has(id))
          ) {
            rank1Outfit.rank = 2;
            rank2Outfit.rank = 1;
            // Re-sort by rank
            parsed.outfits.sort((a, b) => a.rank - b.rank);
          }
        }
      }
    }

    // Map item IDs back to full wardrobe items with images (scoped to llmWardrobe)
    const wardrobeMap = new Map(llmWardrobe.map((item) => [item.id, item]));

    const outfitsWithItems = parsed.outfits.map((outfit) => ({
      id: outfit.id,
      rank: outfit.rank,
      title: outfit.title,
      summary: outfit.summary,
      reasoning: outfit.reasoning,
      items: outfit.itemIds
        .map((itemId) => {
          const item = wardrobeMap.get(itemId);
          if (!item) return null;
          return {
            id: item.id,
            name: item.name || item.ai_title || 'Item',
            imageUrl:
              item.touched_up_image_url ||
              item.processed_image_url ||
              item.image_url ||
              item.image,
            category: this.mapToCategory(item.main_category || item.category),
          };
        })
        .filter(Boolean),
    }));

    // 🛡️ POST-ASSEMBLY MASCULINE FILTER — PASS 1 (before completeness injection)
    const rawLookup = new Map(wardrobe.map((i) => [i.id, i]));
    if (userPresentation === 'masculine') {
      for (const outfit of outfitsWithItems) {
        const preLen = outfit.items.length;
        outfit.items = outfit.items.filter((it) => {
          if (!it) return false;
          const raw = rawLookup.get(it.id);
          return !isFeminineItem(
            raw?.main_category || raw?.category || '',
            raw?.subcategory || '',
            raw?.name || it.name || '',
          );
        });
        if (outfit.items.length < preLen) {
          console.log(
            `🎯 [AI Stylist] Masculine post-filter pass 1: ${preLen} → ${outfit.items.length} items`,
          );
        }
      }
    }

    // 🛡️ OUTFIT COMPLETENESS ENFORCEMENT
    // Every outfit MUST have: 1 top, 1 bottom, 1 shoes (outerwear optional)
    // Build category pools — weather-aware with tiered fallback
    const buildPoolAtThreshold = (cat: string, minScore: number) =>
      availableWardrobe
        .filter((item) => !_stylistVetoIds.has(item.id)) // hard veto propagation
        .filter(
          (item) =>
            this.mapToCategory(item.main_category || item.category) === cat,
        )
        .filter((item) => item.__weatherScore >= minScore)
        .map((item) => ({
          ...item,
          feedbackScore: feedbackContext.itemScores.get(item.id) || 0,
        }))
        .sort(
          (a, b) =>
            b.__weatherScore - a.__weatherScore ||
            b.feedbackScore - a.feedbackScore,
        );

    const buildPool = (cat: string) => {
      // Tier 1: strict (>= 0)
      let pool = buildPoolAtThreshold(cat, 0);
      if (pool.length > 0) return pool;
      // Tier 2: relaxed (>= -2)
      pool = buildPoolAtThreshold(cat, -2);
      if (pool.length > 0) return pool;
      // Tier 3: degraded — allow any item in category
      return buildPoolAtThreshold(cat, -Infinity);
    };

    const categoryPools = {
      top: buildPool('top'),
      bottom: buildPool('bottom'),
      shoes: buildPool('shoes'),
      dress: buildPool('dress'),
      activewear: buildPool('activewear'),
      swimwear: buildPool('swimwear'),
      outerwear: buildPool('outerwear'),
    };

    // ── Formality scoring constants (hoisted for composition context) ──
    // Scores: 0=athletic, 1=casual, 2=smart-casual, 3=business, 4=formal
    const CATEGORY_FORMALITY: Record<string, number> = {
      activewear: 0,
      swimwear: 0,
      top: 2,
      bottom: 2,
      shoes: 2,
      outerwear: 2,
      dress: 2,
      accessory: 2,
    };

    const SUBCATEGORY_SIGNALS: Array<[number, string[]]> = [
      [
        0,
        [
          'performance',
          'running',
          'training',
          'gym',
          'track',
          'athletic',
          'sport',
          'jogger',
          'sweatpant',
          'sweatshort',
          'slide',
          'flip flop',
        ],
      ],
      [
        1,
        [
          't-shirt',
          'tee',
          'hoodie',
          'sweatshirt',
          'sneaker',
          'canvas',
          'sandal',
          'jean',
          'denim',
          'cargo',
          'tank top',
          'jersey',
          'short',
        ],
      ],
      [
        2,
        [
          'polo',
          'sweater',
          'knit',
          'cardigan',
          'henley',
          'boot',
          'chino',
          'khaki',
          'loafer',
          'moccasin',
          'pullover',
        ],
      ],
      [
        3,
        [
          'button down',
          'dress shirt',
          'blouse',
          'blazer',
          'trouser',
          'slack',
          'dress pant',
          'oxford',
          'derby',
          'brogue',
          'wingtip',
          'heel',
          'pump',
          'cocktail',
        ],
      ],
      [4, ['tuxedo', 'gown', 'formal', 'patent', 'evening', 'black tie']],
    ];

    // Enforce completeness for each outfit — COMPOSITION-AWARE
    // Dress-based outfits: dress + shoes (no top/bottom needed)
    // Separates outfits: top + bottom + shoes
    // Items injected via composition context to match anchor palette/silhouette/material.
    for (const outfit of outfitsWithItems) {
      const existingIds = new Set(
        outfit.items.map((item) => item?.id).filter(Boolean),
      );
      const hasDress = outfit.items.some((item) => item?.category === 'dress');
      const hasTop = outfit.items.some((item) => item?.category === 'top');
      const hasBottom = outfit.items.some(
        (item) => item?.category === 'bottom',
      );
      const hasShoes = outfit.items.some((item) => item?.category === 'shoes');

      // Build composition context from existing outfit items for guided injection
      const existingCompositionItems: CompositionItem[] = outfit.items
        .filter(Boolean)
        .map((i: any) => {
          const full = availableWardrobe.find((w) => w.id === i.id);
          return {
            id: i.id,
            category: i.category,
            main_category: full?.main_category,
            subcategory: full?.subcategory,
            name: full?.name || full?.ai_title || i.name,
            color: full?.color,
            material: full?.material,
          };
        });

      const compositionAnchor = selectAnchorItem(existingCompositionItems);
      const compositionCtx = compositionAnchor
        ? buildCompositionContext(compositionAnchor, CATEGORY_FORMALITY, SUBCATEGORY_SIGNALS)
        : null;

      // Helper: pick best composition-compatible item from a pool
      const pickCompositionFallback = (
        pool: any[],
        category: string,
      ): any | null => {
        const available = pool.filter((item) => !existingIds.has(item.id));
        if (available.length === 0) return null;
        if (!compositionCtx) return available[0]; // no context → original behavior

        const ranked = rankByComposition(
          available.map((item) => ({
            id: item.id,
            category,
            main_category: item.main_category,
            subcategory: item.subcategory,
            name: item.name || item.ai_title,
            color: item.color,
            material: item.material,
          })),
          compositionCtx,
          CATEGORY_FORMALITY,
          SUBCATEGORY_SIGNALS,
        );
        // Return the original pool item matching the best-ranked candidate
        return available.find((item) => item.id === ranked[0]?.id) ?? available[0];
      };

      // Skip top/bottom injection for dress-based outfits (dresses are one-piece)
      if (!hasDress) {
        // Inject missing top — composition-guided
        if (!hasTop && categoryPools.top.length > 0) {
          const fallback = pickCompositionFallback(categoryPools.top, 'top');
          if (fallback) {
            outfit.items.push({
              id: fallback.id,
              name: fallback.name || fallback.ai_title || 'Item',
              imageUrl:
                fallback.touched_up_image_url ||
                fallback.processed_image_url ||
                fallback.image_url ||
                fallback.image,
              category: 'top',
            });
            existingIds.add(fallback.id);
          }
        }

        // Inject missing bottom — composition-guided
        if (!hasBottom && categoryPools.bottom.length > 0) {
          const fallback = pickCompositionFallback(categoryPools.bottom, 'bottom');
          if (fallback) {
            outfit.items.push({
              id: fallback.id,
              name: fallback.name || fallback.ai_title || 'Item',
              imageUrl:
                fallback.touched_up_image_url ||
                fallback.processed_image_url ||
                fallback.image_url ||
                fallback.image,
              category: 'bottom',
            });
            existingIds.add(fallback.id);
          }
        }
      }

      // Inject missing shoes — composition-guided (always required for all outfit types)
      if (!hasShoes && categoryPools.shoes.length > 0) {
        const fallback = pickCompositionFallback(categoryPools.shoes, 'shoes');
        if (fallback) {
          outfit.items.push({
            id: fallback.id,
            name: fallback.name || fallback.ai_title || 'Item',
            imageUrl:
              fallback.touched_up_image_url ||
              fallback.processed_image_url ||
              fallback.image_url ||
              fallback.image,
            category: 'shoes',
          });
          existingIds.add(fallback.id);
        }
      }

      // 🧥 COLD WEATHER OUTERWEAR MANDATE (HARD GATE)
      // If tempF ≤ 55 and outfit has no outerwear, inject highest weatherScore outerwear
      const hasOuterwear = outfit.items.some((item) => item?.category === 'outerwear');
      if (!hasOuterwear && wxContext?.tempF != null && wxContext.tempF <= 55 && categoryPools.outerwear.length > 0) {
        const fallback = pickCompositionFallback(categoryPools.outerwear, 'outerwear');
        if (fallback) {
          outfit.items.push({
            id: fallback.id,
            name: fallback.name || fallback.ai_title || 'Item',
            imageUrl:
              fallback.touched_up_image_url ||
              fallback.processed_image_url ||
              fallback.image_url ||
              fallback.image,
            category: 'outerwear',
          });
          existingIds.add(fallback.id);
        }
      }
    }

    // 🔗 INTER-OUTFIT ANCHOR DEDUPE
    // Prevent multiple outfits from sharing the same anchor (top+bottom or dress)
    // If a duplicate is found, attempt to swap the anchor piece from categoryPools
    const getAnchor = (outfit: any): string => {
      const hasDress = outfit.items.some((i: any) => i?.category === 'dress');
      if (hasDress) {
        const dressItem = outfit.items.find(
          (i: any) => i?.category === 'dress',
        );
        return `dress:${dressItem?.id}`;
      }
      const topItem = outfit.items.find((i: any) => i?.category === 'top');
      const bottomItem = outfit.items.find(
        (i: any) => i?.category === 'bottom',
      );
      return `${topItem?.id || 'none'}+${bottomItem?.id || 'none'}`;
    };

    const usedAnchors = new Set<string>();
    const usedItemIds = new Set<string>();
    // Collect all item IDs already committed across outfits
    for (const outfit of outfitsWithItems) {
      for (const item of outfit.items) if (item?.id) usedItemIds.add(item.id);
    }

    for (const outfit of outfitsWithItems) {
      let anchor = getAnchor(outfit);

      if (usedAnchors.has(anchor)) {
        // Attempt to swap the anchor piece with an unused alternative
        const hasDress = outfit.items.some((i: any) => i?.category === 'dress');

        if (hasDress) {
          const alt = categoryPools.dress.find((d) => !usedItemIds.has(d.id));
          if (alt) {
            const idx = outfit.items.findIndex(
              (i: any) => i?.category === 'dress',
            );
            outfit.items[idx] = {
              id: alt.id,
              name: alt.name || alt.ai_title || 'Item',
              imageUrl:
                alt.touched_up_image_url ||
                alt.processed_image_url ||
                alt.image_url ||
                alt.image,
              category: 'dress',
            };
            usedItemIds.add(alt.id);
            anchor = getAnchor(outfit);
          }
        } else {
          // Try swapping top first, then bottom
          const topIdx = outfit.items.findIndex(
            (i: any) => i?.category === 'top',
          );
          const altTop = categoryPools.top.find((t) => !usedItemIds.has(t.id));
          if (topIdx >= 0 && altTop) {
            outfit.items[topIdx] = {
              id: altTop.id,
              name: altTop.name || altTop.ai_title || 'Item',
              imageUrl:
                altTop.touched_up_image_url ||
                altTop.processed_image_url ||
                altTop.image_url ||
                altTop.image,
              category: 'top',
            };
            usedItemIds.add(altTop.id);
            anchor = getAnchor(outfit);
          }
          if (usedAnchors.has(anchor)) {
            const bottomIdx = outfit.items.findIndex(
              (i: any) => i?.category === 'bottom',
            );
            const altBottom = categoryPools.bottom.find(
              (b) => !usedItemIds.has(b.id),
            );
            if (bottomIdx >= 0 && altBottom) {
              outfit.items[bottomIdx] = {
                id: altBottom.id,
                name: altBottom.name || altBottom.ai_title || 'Item',
                imageUrl:
                  altBottom.touched_up_image_url ||
                  altBottom.processed_image_url ||
                  altBottom.image_url ||
                  altBottom.image,
                category: 'bottom',
              };
              usedItemIds.add(altBottom.id);
              anchor = getAnchor(outfit);
            }
          }
        }
      }

      (outfit as any).__anchor = anchor;
      (outfit as any).__uniqueAnchor = !usedAnchors.has(anchor);
      usedAnchors.add(anchor);
    }

    // 🛡️ FORMALITY COHERENCE GATE — reject outfits with extreme formality mismatches.
    // Uses structured scoring (0–4) instead of fragile regex. If uncertain → default neutral (2).
    // CATEGORY_FORMALITY and SUBCATEGORY_SIGNALS hoisted above completeness injection.

    // Lookup full item metadata by ID for subcategory access
    const fullItemMap = new Map(availableWardrobe.map((i) => [i.id, i]));

    const getFormalityScore = (outfitItem: any): number => {
      const cat = outfitItem?.category || '';
      const full = fullItemMap.get(outfitItem?.id);
      const mainCat = (full?.main_category || '').toLowerCase();
      const sub = (full?.subcategory || '').toLowerCase();

      // Main category overrides
      if (mainCat === 'formalwear' || mainCat === 'suits') return 4;

      // Base from simplified category
      let score = CATEGORY_FORMALITY[cat] ?? 2;

      // Refine via subcategory signals (first match wins)
      for (const [formality, signals] of SUBCATEGORY_SIGNALS) {
        if (signals.some((s) => sub.includes(s))) {
          score = formality;
          break;
        }
      }

      return score;
    };

    // Reject outfits where max formality - min formality > 2 (e.g. gym shorts + dress shoes)
    const coherentOutfits = outfitsWithItems.filter((outfit) => {
      const scores = outfit.items
        .filter((i) => i?.category && i.category !== 'accessory')
        .map((i) => getFormalityScore(i));
      if (scores.length < 2) return true; // can't compare with < 2 items
      return Math.max(...scores) - Math.min(...scores) <= 2;
    });
    // Gather candidates: prioritize coherent, backfill from originals
    // Pool target raised to 18 so avoid_colors validation can filter without returning 0.
    const _POOL_TARGET = 18;
    const candidateOutfits = [...coherentOutfits];
    if (candidateOutfits.length < _POOL_TARGET) {
      const remaining = outfitsWithItems.filter(
        (o) => !candidateOutfits.includes(o),
      );
      for (const outfit of remaining) {
        if (candidateOutfits.length >= _POOL_TARGET) break;
        candidateOutfits.push(outfit);
      }
    }
    for (const outfit of outfitsWithItems) {
      if (candidateOutfits.length >= _POOL_TARGET) break;
      if (!candidateOutfits.includes(outfit)) {
        candidateOutfits.push(outfit);
      }
    }

    // ── SYNTHETIC OUTFIT EXPANSION ──
    // Generate additional combos from wardrobe items so the pool has enough
    // candidates to survive avoid_colors filtering.
    if (candidateOutfits.length < _POOL_TARGET) {
      // Pre-filter wardrobe items by avoid_colors so synthetics are born valid
      const _synAvoidRaw = (brainCtx as any)?.styleProfile?.avoid_colors ?? [];
      const _synExpanded = _synAvoidRaw.length > 0
        ? [...new Set([...expandAvoidColors(_synAvoidRaw), ...expandStylistAvoidColors(_synAvoidRaw)])]
        : [];
      const _synItemHasAvoidedColor = (item: any): boolean => {
        if (_synExpanded.length === 0) return false;
        const colors: string[] = [];
        if (item.color) colors.push(item.color);
        if (Array.isArray(item.colors)) colors.push(...item.colors);
        if (item.metadata?.color) colors.push(item.metadata.color);
        if (Array.isArray(item.metadata?.colors)) colors.push(...item.metadata.colors);
        if (item.enrichment?.color) colors.push(item.enrichment.color);
        if (Array.isArray(item.enrichment?.colors)) colors.push(...item.enrichment.colors);
        for (const raw of colors) {
          if (typeof raw !== 'string') continue;
          const ic = raw.trim().toLowerCase();
          for (const ac of _synExpanded) {
            if (colorMatchesSafe(ic, ac)) return true;
          }
        }
        return false;
      };

      // Build slot pools with full metadata for composition scoring
      const _bySlot: Record<string, any[]> = {};
      const _bySlotFull: Record<string, CompositionItem[]> = {};
      for (const item of availableWardrobe) {
        // Skip vetoed items (hard-excluded disliked items)
        if (_stylistVetoIds.has(item.id)) continue;
        // Skip items whose colors match avoid list
        if (_synItemHasAvoidedColor(item)) continue;
        const cat = this.mapToCategory(item.main_category || item.category);
        if (!_bySlot[cat]) _bySlot[cat] = [];
        if (!_bySlotFull[cat]) _bySlotFull[cat] = [];
        _bySlot[cat].push({
          id: item.id,
          name: item.name || item.ai_title || 'Item',
          imageUrl:
            item.touched_up_image_url ||
            item.processed_image_url ||
            item.image_url ||
            item.image,
          category: cat,
        });
        _bySlotFull[cat].push({
          id: item.id,
          category: cat,
          main_category: item.main_category,
          subcategory: item.subcategory,
          name: item.name || item.ai_title,
          color: item.color,
          material: item.material,
        });
      }
      const _synTops = _bySlot['top'] ?? [];
      const _synBottoms = _bySlot['bottom'] ?? [];
      const _synShoes = _bySlot['shoes'] ?? [];
      const _synDresses = _bySlot['dress'] ?? [];
      const _synTopsFull = _bySlotFull['top'] ?? [];
      const _synBottomsFull = _bySlotFull['bottom'] ?? [];
      const _synShoesFull = _bySlotFull['shoes'] ?? [];
      const _synDressesFull = _bySlotFull['dress'] ?? [];
      const _existingCombos = new Set(
        candidateOutfits.map((o) =>
          (o.items || [])
            .map((i: any) => i?.id)
            .filter(Boolean)
            .sort()
            .join(','),
        ),
      );
      let _synId = 0;

      // ── COMPOSITION-GUIDED SYNTHETIC EXPANSION ──
      // Instead of brute-force top × bottom × shoes, anchor on the highest-scored
      // item per slot and build outfits around it using composition context.

      // Helper: get thin stub from _bySlot matching an id
      const _synStub = (id: string, slotArr: any[]): any =>
        slotArr.find((s) => s.id === id);

      // Separates: anchor → rank other slots by composition compatibility
      const _synAnchors = [
        ..._synTopsFull.map((i) => ({ ...i, _srcSlot: 'top' as const })),
        ..._synBottomsFull.map((i) => ({ ...i, _srcSlot: 'bottom' as const })),
        ..._synShoesFull.map((i) => ({ ...i, _srcSlot: 'shoes' as const })),
      ].sort((a, b) => {
        // Sort by weather+feedback score (match original pool ordering)
        const aFull = availableWardrobe.find((w) => w.id === a.id);
        const bFull = availableWardrobe.find((w) => w.id === b.id);
        const aScore = (aFull?.__weatherScore ?? 0) + (feedbackContext.itemScores.get(a.id) ?? 0);
        const bScore = (bFull?.__weatherScore ?? 0) + (feedbackContext.itemScores.get(b.id) ?? 0);
        return bScore - aScore;
      });

      for (const anchor of _synAnchors) {
        if (candidateOutfits.length >= _POOL_TARGET) break;

        const ctx = buildCompositionContext(anchor, CATEGORY_FORMALITY, SUBCATEGORY_SIGNALS);

        // Rank items in each slot by compatibility with anchor
        const pickSlot = (slot: string, fullArr: CompositionItem[], stubArr: any[]): any | null => {
          if (slot === anchor._srcSlot) return _synStub(anchor.id, stubArr);
          const ranked = rankByComposition(fullArr, ctx, CATEGORY_FORMALITY, SUBCATEGORY_SIGNALS);
          for (const r of ranked) {
            const stub = _synStub(r.id, stubArr);
            if (stub) return stub;
          }
          return stubArr[0] ?? null;
        };

        const top = pickSlot('top', _synTopsFull, _synTops);
        const bottom = pickSlot('bottom', _synBottomsFull, _synBottoms);
        const shoes = pickSlot('shoes', _synShoesFull, _synShoes);

        if (!top || !bottom || !shoes) continue;
        const items = [top, bottom, shoes];
        const combo = items.map((i) => i.id).sort().join(',');
        if (_existingCombos.has(combo)) continue;
        _existingCombos.add(combo);
        candidateOutfits.push({
          id: `syn-${_synId++}`,
          rank: 3 as any,
          title: undefined,
          summary: 'Synthetic candidate (composition-guided)',
          reasoning: '',
          items,
        });
      }

      // Dress-based synthetics: anchor on dress, rank shoes by composition
      for (const dress of _synDressesFull) {
        if (candidateOutfits.length >= _POOL_TARGET) break;

        const ctx = buildCompositionContext(dress, CATEGORY_FORMALITY, SUBCATEGORY_SIGNALS);
        const rankedShoes = rankByComposition(_synShoesFull, ctx, CATEGORY_FORMALITY, SUBCATEGORY_SIGNALS);

        for (const shoe of rankedShoes) {
          if (candidateOutfits.length >= _POOL_TARGET) break;
          const dressStub = _synStub(dress.id, _synDresses);
          const shoeStub = _synStub(shoe.id, _synShoes);
          if (!dressStub || !shoeStub) continue;
          const items = [dressStub, shoeStub];
          const combo = items.map((i) => i.id).sort().join(',');
          if (_existingCombos.has(combo)) continue;
          _existingCombos.add(combo);
          candidateOutfits.push({
            id: `syn-${_synId++}`,
            rank: 3 as any,
            title: undefined,
            summary: 'Synthetic candidate (composition-guided)',
            reasoning: '',
            items,
          });
        }
      }
    }

    // 🎯 DETERMINISTIC FINAL SCORING
    // Stable hash for daily tie-breaking (same user + day → same order)
    const hashString = (str: string): number => {
      let h = 0;
      for (let i = 0; i < str.length; i++) {
        h = (h << 5) - h + str.charCodeAt(i);
        h |= 0;
      }
      return Math.abs(h);
    };
    const todayKey = new Date().toISOString().slice(0, 10);
    const seedString = `${userId}-${todayKey}`;

    // ── Aesthetic tie-breaker helpers (pure, deterministic) ──────
    const aestheticExtractColorWords = (colorStr: string): string[] =>
      (colorStr || '')
        .toLowerCase()
        .split(/[\s,/&+\-]+/)
        .filter(Boolean);

    const AESTHETIC_WARM = [
      'red',
      'orange',
      'yellow',
      'coral',
      'peach',
      'gold',
      'amber',
      'rust',
    ];
    const AESTHETIC_COOL = [
      'blue',
      'teal',
      'cyan',
      'mint',
      'lavender',
      'periwinkle',
      'ice',
      'cobalt',
      'navy',
      'slate',
    ];
    const AESTHETIC_NEUTRAL = [
      'black',
      'white',
      'gray',
      'grey',
      'beige',
      'cream',
      'tan',
      'khaki',
      'ivory',
      'charcoal',
      'taupe',
      'brown',
      'nude',
    ];
    const AESTHETIC_BOLD = ['red', 'orange', 'yellow', 'purple'];

    const computeColorHarmony = (
      outfit: any,
      itemMap: Map<string, any>,
    ): number => {
      const items = (outfit.items || []).filter(Boolean);
      const allColors: string[] = items.flatMap((i: any) => {
        const full = itemMap.get(i.id);
        return aestheticExtractColorWords(full?.color || '');
      });
      if (allColors.length === 0) return 0;

      const warmCount = allColors.filter((w) =>
        AESTHETIC_WARM.includes(w),
      ).length;
      const coolCount = allColors.filter((w) =>
        AESTHETIC_COOL.includes(w),
      ).length;
      const neutralCount = allColors.filter((w) =>
        AESTHETIC_NEUTRAL.includes(w),
      ).length;
      const boldFamilies = new Set(
        allColors.filter((w) => AESTHETIC_BOLD.includes(w)),
      );

      // -1.0: >1 bold color family without neutral base
      if (boldFamilies.size > 1 && neutralCount === 0) return -1.0;

      // +0.5: neutrals dominate (>50% of color words)
      if (neutralCount > allColors.length / 2) return 0.5;

      // +1.0: all non-neutral colors from same temperature family
      const hasWarm = warmCount > 0;
      const hasCool = coolCount > 0;
      if (hasWarm && !hasCool) return 1.0;
      if (hasCool && !hasWarm) return 1.0;

      return 0;
    };

    // Score an outfit — reusable for initial scoring and retry pipeline
    const scoreOutfit = (outfit: any): any => {
      const itemDetails = outfit.items.filter(Boolean).map((i: any) => {
        const full = fullItemMap.get(i.id);
        return {
          weather: full?.__weatherScore || 0,
          feedback: feedbackContext.itemScores.get(i.id) || 0,
          formality: getFormalityScore(i),
        };
      });
      const n = itemDetails.length || 1;
      const avgWeather = itemDetails.reduce((s, d) => s + d.weather, 0) / n;
      const avgFeedback = itemDetails.reduce((s, d) => s + d.feedback, 0) / n;
      const fScores = itemDetails.map((d) => d.formality);
      const formalitySpread =
        fScores.length >= 2 ? Math.max(...fScores) - Math.min(...fScores) : 0;
      const diversityBonus = outfit.__uniqueAnchor ? 1 : 0;

      // Composition coherence — primary aesthetic axis for Outfit Studio.
      const compositionScore = scoreOutfitComposition(
        outfit.items.filter(Boolean).map((i: any) => ({
          id: i.id,
          category: i.category,
        })),
        fullItemMap,
        CATEGORY_FORMALITY,
        SUBCATEGORY_SIGNALS,
      );

      let finalScore =
        0.28 * avgWeather +
        0.25 * avgFeedback -
        0.17 * formalitySpread +
        0.10 * diversityBonus +
        0.30 * compositionScore;

      const anchor = outfit.__anchor || getAnchor(outfit);
      const tieBreaker = hashString(seedString + anchor) % 1000;

      return { ...outfit, __finalScore: finalScore, __tieBreaker: tieBreaker };
    };

    let scoredOutfits = candidateOutfits.map(scoreOutfit);

    // ── Deterministic repair: fix top outfit if severe color clash ──
    const topByScore = [...scoredOutfits].sort(
      (a, b) =>
        b.__finalScore - a.__finalScore || a.__tieBreaker - b.__tieBreaker,
    );
    if (topByScore.length > 0) {
      const top = topByScore[0];
      const topHarmony = computeColorHarmony(top, fullItemMap);
      if (topHarmony < -0.7) {
        const items = top.items.filter(Boolean);
        const itemColors = items.map((i: any) => {
          const full = fullItemMap.get(i.id);
          const colors = aestheticExtractColorWords(full?.color || '');
          const isWarm = colors.some((w) => AESTHETIC_WARM.includes(w));
          const isCool = colors.some((w) => AESTHETIC_COOL.includes(w));
          return {
            item: i,
            full,
            colors,
            isWarm,
            isCool,
            category: i.category,
          };
        });
        const warmCount = itemColors.filter((ic) => ic.isWarm).length;
        const coolCount = itemColors.filter((ic) => ic.isCool).length;
        const minorityTemp = warmCount <= coolCount ? 'warm' : 'cool';
        const clashingEntry = itemColors.find((ic) =>
          minorityTemp === 'warm' ? ic.isWarm : ic.isCool,
        );

        if (clashingEntry) {
          const replacements = [...availableWardrobe]
            .filter((w) => {
              if (_stylistVetoIds.has(w.id)) return false; // hard veto propagation
              if (w.id === clashingEntry.item.id) return false;
              if (
                this.mapToCategory(w.main_category || w.category) !==
                clashingEntry.category
              )
                return false;
              if ((w.__weatherScore ?? -Infinity) < -5) return false;
              const cWords = aestheticExtractColorWords(w.color || '');
              return cWords.some((c) => AESTHETIC_NEUTRAL.includes(c));
            })
            .sort((a, b) => {
              const weatherA = a.__weatherScore ?? -Infinity;
              const weatherB = b.__weatherScore ?? -Infinity;
              if (weatherB !== weatherA) return weatherB - weatherA;
              const feedbackA = feedbackContext.itemScores.get(a.id) ?? 0;
              const feedbackB = feedbackContext.itemScores.get(b.id) ?? 0;
              if (feedbackB !== feedbackA) return feedbackB - feedbackA;
              return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
            });

          if (replacements.length > 0) {
            const replacement = replacements[0];
            const newItem = {
              id: replacement.id,
              name: replacement.name || replacement.ai_title || 'Item',
              imageUrl:
                replacement.touched_up_image_url ||
                replacement.processed_image_url ||
                replacement.image_url ||
                replacement.image,
              category: this.mapToCategory(
                replacement.main_category || replacement.category,
              ),
            };
            const idx = top.items.findIndex(
              (i: any) => i?.id === clashingEntry.item.id,
            );
            if (idx !== -1) {
              top.items[idx] = newItem;
              const rescored = scoreOutfit(top);
              const topIdx = scoredOutfits.findIndex((o) => o === top);
              if (topIdx !== -1) scoredOutfits[topIdx] = rescored;
            }
          }
        }
      }
    }

    // ─── Post-Processing Pipeline ──────────────────────────────
    // Pipeline: QUALITY GATE → SILHOUETTE DIVERSITY → SORT →
    //           CANONICALIZE + RESCORE → CONFIDENCE CHECK →
    //           ENRICHMENT → STRIP → CACHE → RETURN

    // Color analysis constants
    const BOLD_COLOR_FAMILIES = ['red', 'orange', 'yellow', 'purple'];
    const WARM_COLORS = [
      'red',
      'orange',
      'yellow',
      'coral',
      'peach',
      'gold',
      'amber',
      'rust',
    ];
    const COOL_COLORS = [
      'blue',
      'teal',
      'cyan',
      'mint',
      'lavender',
      'periwinkle',
      'ice',
      'cobalt',
      'navy',
      'slate',
    ];
    const NEUTRAL_COLORS = [
      'black',
      'white',
      'gray',
      'grey',
      'beige',
      'cream',
      'tan',
      'khaki',
      'ivory',
      'charcoal',
      'taupe',
      'brown',
      'nude',
    ];

    const extractColorWords = (colorStr: string): string[] =>
      (colorStr || '')
        .toLowerCase()
        .split(/[\s,/&+\-]+/)
        .filter(Boolean);

    // 🛡️ QUALITY GATE — reject outfits with irreconcilable clashes
    const qualityGateFilter = (outfit: any): boolean => {
      const items = outfit.items.filter(Boolean);
      const details = items.map((i: any) => {
        const full = fullItemMap.get(i.id);
        return {
          category: i.category,
          formality: getFormalityScore(i),
          sub: (full?.subcategory || '').toLowerCase(),
          name: (full?.name || '').toLowerCase(),
          color: (full?.color || '').toLowerCase(),
          weatherScore: full?.__weatherScore || 0,
          material: (full?.material || '').toLowerCase(),
        };
      });

      // Rule 1: avgWeather < -1
      const avgW =
        details.reduce((s, d) => s + d.weatherScore, 0) / (details.length || 1);
      if (avgW < -1) return false;

      // Rule 2: athletic shoes + tailored top
      const hasAthleticShoes = details.some(
        (d) =>
          d.category === 'shoes' &&
          (d.formality === 0 || /running|slide|sneaker/.test(d.sub)),
      );
      const TAILORED_RE =
        /blazer|sport coat|suit|dress shirt|button.?down|oxford|tailored/;
      const hasTailoredTop = details.some(
        (d) =>
          (d.category === 'top' || d.category === 'outerwear') &&
          (TAILORED_RE.test(d.sub) || TAILORED_RE.test(d.name)),
      );
      if (hasAthleticShoes && hasTailoredTop) return false;

      // Rule 3: heavy outerwear + shorts
      const hasHeavyOuterwear = details.some(
        (d) =>
          d.category === 'outerwear' && /coat|parka|puffer|down/.test(d.sub),
      );
      const hasShorts = details.some(
        (d) => d.category === 'bottom' && /short/.test(d.sub),
      );
      if (hasHeavyOuterwear && hasShorts) return false;

      // Rule 4: more than 1 bold color family (word-split exact match)
      const allColors = details.flatMap((d) => extractColorWords(d.color));
      const boldPresent = BOLD_COLOR_FAMILIES.filter((family) =>
        allColors.some((word) => word === family),
      );
      if (boldPresent.length > 1) return false;

      // Rule 5: warm + cool clash without neutral base
      const hasWarm = allColors.some((word) => WARM_COLORS.includes(word));
      const hasCool = allColors.some((word) => COOL_COLORS.includes(word));
      const hasNeutralBase = allColors.some((word) =>
        NEUTRAL_COLORS.includes(word),
      );
      if (hasWarm && hasCool && !hasNeutralBase) return false;

      // Rule 6 (HARD WEATHER GATE): open-toe footwear block in cold (≤ 55°F)
      const _tempF = wxContext?.tempF;
      if (_tempF != null && _tempF <= 55) {
        const hasOpenToe = details.some(
          (d) =>
            d.category === 'shoes' &&
            /sandal|slide|flip.?flop|open.?toe|thong/i.test(d.sub + ' ' + d.name),
        );
        if (hasOpenToe) return false;
      }

      // Rule 7 (HARD WEATHER GATE): heavy winter outerwear block in heat (≥ 80°F)
      if (_tempF != null && _tempF >= 80) {
        const hasHeavyWinter = details.some(
          (d) =>
            d.category === 'outerwear' &&
            /parka|puffer|down|heavy|wool coat/i.test(d.sub + ' ' + d.name),
        );
        if (hasHeavyWinter) return false;
      }

      // Rule 8 (HARD WEATHER GATE): rain footwear block — no suede shoes in rain
      if (wxContext?.precipitation === 'rain') {
        const hasSuedeShoes = details.some(
          (d) =>
            d.category === 'shoes' &&
            (d.material.includes('suede') || /suede/i.test(d.name)),
        );
        if (hasSuedeShoes) return false;
      }

      return true;
    };

    // 🎨 SILHOUETTE TYPE — classify outfit shape
    const TAILORED_SIGNALS_RE =
      /blazer|sport coat|suit|dress shirt|button.?down|oxford|tailored/;
    const getSilhouetteType = (
      outfit: any,
    ): 'dress' | 'tailored' | 'relaxed' => {
      const items = outfit.items.filter(Boolean);
      if (items.some((i: any) => i.category === 'dress')) return 'dress';
      const hasTailored = items.some((i: any) => {
        if (i.category !== 'top' && i.category !== 'outerwear') return false;
        const full = fullItemMap.get(i.id);
        const sub = (full?.subcategory || '').toLowerCase();
        const name = (full?.name || '').toLowerCase();
        return TAILORED_SIGNALS_RE.test(sub) || TAILORED_SIGNALS_RE.test(name);
      });
      return hasTailored ? 'tailored' : 'relaxed';
    };

    // 🏗️ CANONICALIZE — enforce clean outfit structure, rescore if changed
    const canonicalizeOutfit = (outfit: any): void => {
      const items = [...outfit.items.filter(Boolean)];
      const hasDress = items.some((i: any) => i.category === 'dress');
      let newItems: any[];

      if (hasDress) {
        const dress = items.find((i: any) => i.category === 'dress');
        const shoes = items.find((i: any) => i.category === 'shoes');
        const outerwear =
          temp !== undefined && temp <= 60
            ? items.find((i: any) => i.category === 'outerwear')
            : null;
        newItems = [dress, shoes, outerwear].filter(Boolean);
      } else {
        const top = items.find((i: any) => i.category === 'top');
        const bottom = items.find((i: any) => i.category === 'bottom');
        const shoes = items.find((i: any) => i.category === 'shoes');
        const outerwear =
          temp !== undefined && temp <= 60
            ? items.find((i: any) => i.category === 'outerwear')
            : null;
        newItems = [top, bottom, shoes, outerwear].filter(Boolean);
      }

      // temp >= 75: strip all outerwear
      if (temp !== undefined && temp >= 75) {
        newItems = newItems.filter((i: any) => i.category !== 'outerwear');
      }

      const changed =
        newItems.length !== items.length ||
        newItems.some((ni, idx) => ni !== items[idx]);

      if (changed) {
        outfit.items = newItems;
        // RECOMPUTE scores
        const itemDets = newItems.filter(Boolean).map((i: any) => {
          const full = fullItemMap.get(i.id);
          return {
            weather: full?.__weatherScore || 0,
            feedback: feedbackContext.itemScores.get(i.id) || 0,
            formality: getFormalityScore(i),
          };
        });
        const n = itemDets.length || 1;
        const avgWeather = itemDets.reduce((s, d) => s + d.weather, 0) / n;
        const avgFeedback = itemDets.reduce((s, d) => s + d.feedback, 0) / n;
        const fScores = itemDets.map((d) => d.formality);
        const formalitySpread =
          fScores.length >= 2 ? Math.max(...fScores) - Math.min(...fScores) : 0;
        const diversityBonus = outfit.__uniqueAnchor ? 1 : 0;
        const compositionScoreRescore = scoreOutfitComposition(
          newItems.filter(Boolean).map((i: any) => ({
            id: i.id,
            category: i.category,
          })),
          fullItemMap,
          CATEGORY_FORMALITY,
          SUBCATEGORY_SIGNALS,
        );
        outfit.__finalScore =
          0.28 * avgWeather +
          0.25 * avgFeedback -
          0.17 * formalitySpread +
          0.10 * diversityBonus +
          0.30 * compositionScoreRescore;
      }
    };

    const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

    // Full post-processing pipeline (gate → silhouette → sort → canonicalize)
    const applyPostProcessing = (outfits: any[]): any[] => {
      // console.log(JSON.stringify({ _tag: 'STYLIST_WEATHER_HARD_GATE_ACTIVE', tempF: wxContext?.tempF, precipitation: wxContext?.precipitation }));
      // 1. Quality gate (fallback to originals if all rejected)
      let result = outfits.filter(qualityGateFilter);
      if (result.length === 0) result = [...outfits];

      // 2. Silhouette diversity adjustment
      const silCounts = new Map<string, number>();
      for (const o of result) {
        const sil = getSilhouetteType(o);
        o.__silhouette = sil;
        silCounts.set(sil, (silCounts.get(sil) || 0) + 1);
      }
      for (const o of result) {
        const count = silCounts.get(o.__silhouette) || 1;
        o.__finalScore += count > 1 ? -0.05 * (count - 1) : 0.05;
      }

      // 3. Sort by score, then tie-breaker
      result.sort(
        (a, b) =>
          b.__finalScore - a.__finalScore || b.__tieBreaker - a.__tieBreaker,
      );

      // 4. Canonicalize + rescore top candidates
      for (let i = 0; i < Math.min(result.length, 5); i++) {
        canonicalizeOutfit(result[i]);
      }

      // 5. Re-sort after canonicalization
      result.sort(
        (a, b) =>
          b.__finalScore - a.__finalScore || b.__tieBreaker - a.__tieBreaker,
      );

      return result;
    };

    // Apply post-processing pipeline
    scoredOutfits = applyPostProcessing(scoredOutfits);

    // 🔍 CONFIDENCE CHECK — retry once if top outfit confidence is too low
    if (
      scoredOutfits.length > 0 &&
      sigmoid(scoredOutfits[0].__finalScore) < 0.4
    ) {
      console.warn(
        '⚠️ [AI Stylist] Low confidence on top outfit — triggering retry',
      );
      try {
        const retryHint =
          '\n\nIMPORTANT: The previous suggestions lacked confidence. Focus on the most weather-appropriate, well-coordinated combinations. Prioritize classic, reliable pairings over creative ones.';
        const retryCompletion = await this.openai.chat.completions.create({
          model: 'gpt-4o',
          temperature: 0.2,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt + retryHint },
          ],
          response_format: { type: 'json_object' },
        });
        const retryRaw = retryCompletion.choices[0]?.message?.content;
        if (retryRaw) {
          const retryParsed = JSON.parse(retryRaw);
          if (retryParsed?.outfits?.length) {
            const retryMapped = retryParsed.outfits.map((o: any) => ({
              id: o.id,
              rank: o.rank,
              summary: o.summary,
              reasoning: o.reasoning,
              items: (o.itemIds || [])
                .map((itemId: string) => {
                  const item = wardrobeMap.get(itemId);
                  if (!item) return null;
                  return {
                    id: item.id,
                    name: item.name || item.ai_title || 'Item',
                    imageUrl:
                      item.touched_up_image_url ||
                      item.processed_image_url ||
                      item.image_url ||
                      item.image,
                    category: this.mapToCategory(
                      item.main_category || item.category,
                    ),
                  };
                })
                .filter(Boolean),
              __anchor: '', // placeholder, will be set by scoreOutfit
            }));
            // Compute anchors for retry outfits
            for (const o of retryMapped) {
              o.__anchor = getAnchor(o);
            }
            let retryScoredOutfits = retryMapped.map(scoreOutfit);
            retryScoredOutfits = applyPostProcessing(retryScoredOutfits);
            // Merge retry results into pool (don't replace — preserves synthetic backfill)
            if (
              retryScoredOutfits.length > 0 &&
              sigmoid(retryScoredOutfits[0].__finalScore) >
                sigmoid(scoredOutfits[0].__finalScore)
            ) {
              const _retryIds = new Set(retryScoredOutfits.map((o: any) => o.id));
              scoredOutfits = [
                ...retryScoredOutfits,
                ...scoredOutfits.filter((o: any) => !_retryIds.has(o.id)),
              ];
            }
          }
        }
      } catch (retryErr) {
        console.warn(
          '⚠️ [AI Stylist] Retry failed, keeping original results:',
          retryErr,
        );
      }
    }

    // 🛡️ POST-ASSEMBLY MASCULINE FILTER — PASS 2 (after injection/repair, before final gate)
    if (userPresentation === 'masculine') {
      for (const outfit of scoredOutfits) {
        const preLen = (outfit.items || []).length;
        outfit.items = (outfit.items || []).filter((it: any) => {
          if (!it) return false;
          const raw = rawLookup.get(it.id);
          return !isFeminineItem(
            raw?.main_category || raw?.category || '',
            raw?.subcategory || '',
            raw?.name || it.name || '',
          );
        });
        if (outfit.items.length < preLen) {
          console.log(
            `🎯 [AI Stylist] Masculine post-filter pass 2: ${preLen} → ${outfit.items.length} items`,
          );
        }
      }
    }

    // 🛡️ HARD COMPLETENESS GATE — fail closed, no partial outfits escape
    // Runs AFTER all injection, canonicalization, quality gates, and retries.
    const isVisualOutfitComplete = (outfit: any): boolean => {
      const items = (outfit.items || []).filter(Boolean);
      const cats = new Set(items.map((i: any) => i.category));
      const hasDress = cats.has('dress');
      const hasShoes = cats.has('shoes');
      if (hasDress) return hasShoes; // dress + shoes
      return cats.has('top') && cats.has('bottom') && hasShoes; // separates
    };
    scoredOutfits = scoredOutfits.filter((outfit) => {
      if (isVisualOutfitComplete(outfit)) return true;
      console.warn('🛡️ [AI Stylist][COMPLETENESS_REJECT]', {
        rank: outfit.rank,
        cats: outfit.items?.filter(Boolean).map((i: any) => i.category),
      });
      return false;
    });

    // 📋 RESPONSE ENRICHMENT — add fashionContext to each outfit
    const getWeatherFit = (outfit: any): 'optimal' | 'good' | 'marginal' => {
      const items = outfit.items.filter(Boolean);
      const avgW =
        items.reduce((s: number, i: any) => {
          const full = fullItemMap.get(i.id);
          return s + (full?.__weatherScore || 0);
        }, 0) / (items.length || 1);
      if (avgW >= 2) return 'optimal';
      if (avgW >= 0) return 'good';
      return 'marginal';
    };

    const getColorStrategy = (
      outfit: any,
    ): 'monochrome' | 'neutral palette' | 'single accent' | 'bold mix' => {
      const items = outfit.items.filter(Boolean);
      const allColors = items.flatMap((i: any) => {
        const full = fullItemMap.get(i.id);
        return extractColorWords(full?.color || '');
      });
      const boldPresent = BOLD_COLOR_FAMILIES.filter((f) =>
        allColors.some((w) => w === f),
      );
      const neutralCount = allColors.filter((w) =>
        NEUTRAL_COLORS.includes(w),
      ).length;
      // Check if all colors map to same family
      const uniqueFamilies = new Set(
        allColors.filter((w) => !NEUTRAL_COLORS.includes(w)),
      );
      if (
        uniqueFamilies.size <= 1 &&
        neutralCount === 0 &&
        allColors.length > 0
      )
        return 'monochrome';
      if (boldPresent.length >= 2) return 'bold mix';
      if (boldPresent.length === 1) return 'single accent';
      return 'neutral palette';
    };

    // Strip internal fields + attach fashionContext
    // Keep up to 18 candidates for avoid_colors validation; final selection picks top 3.
    const finalOutfits = scoredOutfits.slice(0, _POOL_TARGET).map((outfit: any) => {
      const fashionContext = {
        weatherFit: getWeatherFit(outfit),
        silhouette: outfit.__silhouette || getSilhouetteType(outfit),
        colorStrategy: getColorStrategy(outfit),
        confidenceLevel: Number(sigmoid(outfit.__finalScore).toFixed(2)),
      };
      const {
        __finalScore,
        __tieBreaker,
        __anchor,
        __uniqueAnchor,
        __silhouette,
        ...rest
      } = outfit;
      return { ...rest, fashionContext };
    });

    // 🔄 VARIETY: Cache current suggestion item IDs for next call
    // Only cache top 3 (LLM-picked) — synthetic backfill shouldn't pollute exclusion.
    if (userId) {
      const allSuggestedIds = finalOutfits.slice(0, 3).flatMap((o) =>
        o.items.map((i) => i?.id).filter(Boolean),
      );
      if (allSuggestedIds.length > 0) {
        this.visualExclusionCache.set(userId, allSuggestedIds);
      }
      // 🔄 DEBUG: log returned outfit IDs
      if (process.env.DEBUG_VARIETY === 'true') {
        const outIds = finalOutfits
          .map(
            (o) =>
              `R${o.rank}:[${o.items.map((i) => i?.id?.slice(0, 8)).join(',')}]`,
          )
          .join(' ');
        console.log(`🔄 [Variety] result uid=${userId.slice(0, 8)} ${outIds}`);
      }
    }

    // ── Elite Scoring: load context (non-blocking) ──
    let eliteFashionState: StyleContext['fashionState'] = null;
    let elitePreferredBrands: string[] = [];
    if (userId && this.fashionStateService) {
      try {
        const [summary, brandsRes] = await Promise.all([
          this.fashionStateService.getStateSummary(userId).catch(() => null),
          pool
            .query(
              'SELECT preferred_brands FROM style_profiles WHERE user_id = $1',
              [userId],
            )
            .then((r) => {
              const raw = r.rows[0]?.preferred_brands;
              return Array.isArray(raw) ? raw : [];
            })
            .catch(() => [] as string[]),
        ]);
        if (summary) {
          eliteFashionState = {
            topBrands: summary.topBrands,
            avoidBrands: summary.avoidBrands,
            topColors: summary.topColors,
            avoidColors: summary.avoidColors,
            topStyles: summary.topStyles,
            avoidStyles: summary.avoidStyles,
            topCategories: summary.topCategories,
            priceBracket: summary.priceBracket,
            isColdStart: summary.isColdStart,
          };
        }
        elitePreferredBrands = brandsRes;
      } catch {
        // Non-blocking: fallback to empty context
      }
    }

    const eliteStyleContext: StyleContext = {
      presentation: userPresentation,
      fashionState: eliteFashionState,
      preferredBrands: elitePreferredBrands,
      styleProfile: brainCtx.styleProfile
        ? {
            fit_preferences: brainCtx.styleProfile.fit_preferences,
            fabric_preferences: brainCtx.styleProfile.fabric_preferences,
            favorite_colors: brainCtx.styleProfile.favorite_colors,
            style_preferences: brainCtx.styleProfile.style_preferences,
            disliked_styles: brainCtx.styleProfile.disliked_styles,
            avoid_colors: brainCtx.styleProfile.avoid_colors,
            avoid_materials: brainCtx.styleProfile.avoid_materials,
            pattern_preferences: brainCtx.styleProfile.pattern_preferences,
            avoid_patterns: brainCtx.styleProfile.avoid_patterns,
            silhouette_preference:
              brainCtx.styleProfile.silhouette_preference,
            contrast_preference: brainCtx.styleProfile.contrast_preference,
          }
        : null,
    };

    // Elite Scoring: enrich thin Stylist items with wardrobe metadata for scoring
    const demoElite = userId ? isEliteDemoUser(userId) : false;
    if (ELITE_FLAGS.STYLIST || ELITE_FLAGS.STYLIST_V2 || demoElite) {
      enrichStylistOutfits(finalOutfits, fullItemMap);
    }

    // ── Taste Validator: validate + backfill to guarantee 3 outfits ──
    const stylistCatToSlot: Record<string, ValidatorItem['slot']> = {
      top: 'tops',
      bottom: 'bottoms',
      shoes: 'shoes',
      outerwear: 'outerwear',
      dress: 'dresses',
      accessory: 'accessories',
      activewear: 'activewear',
      swimwear: 'swimwear',
    };
    const toValidatorItems = (outfit: any): ValidatorItem[] =>
      (outfit.items ?? []).map(
        (it: any) =>
          ({
            id: it.id ?? '',
            slot: stylistCatToSlot[it.category] ?? 'accessories',
            name: it.name,
            subcategory: it.subcategory,
            color: it.color,
            material: it.material,
            fit: it.fit,
            formality_score: it.formality_score,
            dress_code: it.dress_code,
            style_descriptors: it.style_descriptors,
            style_archetypes: it.style_archetypes,
            price: it.price,
            presentation_code: it.presentation_code,
            __canonicalColors: it.__canonicalColors,
          }) as ValidatorItem,
      );

    // Derive requestedDressCode from constraint (only reliable formality signal).
    // Fail-open: undefined = no restriction.
    const requestedDressCode: string | undefined = (() => {
      if (!constraint) return undefined;
      const c = constraint.toLowerCase();
      if (c.includes('formal') || c.includes('business')) return 'formal';
      return undefined;
    })();

    // P0 VETO FALLBACK: if brain timed out (200ms race), fetch P0 columns directly
    // so avoid_colors / coverage_no_go / avoid_materials enforcement is never skipped.
    if (!brainCtx.styleProfile && userId) {
      try {
        const _p0Row = (
          await pool.query(
            `SELECT coverage_no_go, avoid_colors, avoid_materials,
                    formality_floor, walkability_requirement,
                    avoid_patterns, silhouette_preference,
                    fit_preferences, fabric_preferences, style_preferences, disliked_styles
             FROM style_profiles WHERE user_id = $1 LIMIT 1`,
            [userId],
          )
        ).rows[0];
        if (_p0Row) {
          const _toArr = (v: unknown): string[] =>
            Array.isArray(v)
              ? v.filter((x: any) => typeof x === 'string')
              : [];
          const _toStr = (v: unknown): string | null =>
            typeof v === 'string' ? v : null;
          (brainCtx as any).styleProfile = {
            coverage_no_go: _toArr(_p0Row.coverage_no_go),
            avoid_colors: _toArr(_p0Row.avoid_colors),
            avoid_materials: _toArr(_p0Row.avoid_materials),
            formality_floor: _toStr(_p0Row.formality_floor),
            walkability_requirement: _toStr(_p0Row.walkability_requirement),
            avoid_patterns: _toArr(_p0Row.avoid_patterns),
            silhouette_preference: _toStr(_p0Row.silhouette_preference),
            fit_preferences: _toArr(_p0Row.fit_preferences),
            fabric_preferences: _toArr(_p0Row.fabric_preferences),
            style_preferences: _toArr(_p0Row.style_preferences),
            disliked_styles: _toArr(_p0Row.disliked_styles),
          };
          console.log(
            JSON.stringify({
              _tag: 'P0_VETO_FALLBACK_FIRED',
              avoid: (brainCtx as any).styleProfile.avoid_colors,
            }),
          );
        }
      } catch {
        // fail-open: no P0 vetoes if fallback also fails
      }
    }

    const validatorCtx: ValidatorContext = {
      userPresentation: userPresentation as any,
      climateZone: tempToClimateZone(temp),
      requestedDressCode,
      styleProfile: brainCtx.styleProfile
        ? {
            fit_preferences: brainCtx.styleProfile.fit_preferences,
            fabric_preferences: brainCtx.styleProfile.fabric_preferences,
            style_preferences: brainCtx.styleProfile.style_preferences,
            disliked_styles: brainCtx.styleProfile.disliked_styles,
            coverage_no_go: brainCtx.styleProfile.coverage_no_go,
            avoid_colors: brainCtx.styleProfile.avoid_colors,
            avoid_materials: brainCtx.styleProfile.avoid_materials,
            formality_floor: brainCtx.styleProfile.formality_floor,
            walkability_requirement:
              brainCtx.styleProfile.walkability_requirement,
            avoid_patterns: brainCtx.styleProfile.avoid_patterns,
            silhouette_preference:
              brainCtx.styleProfile.silhouette_preference,
          }
        : null,
    };

    // ── Hydrate outfit items with canonical wardrobe colors ──
    // Outfit items are thin stubs ({id,name,imageUrl,category}) without color.
    // Hydrate from fullItemMap so extractItemColors / avoid_colors checks work.
    const _normColor = (v: any): string | null => {
      if (typeof v !== 'string') return null;
      return v
        .trim()
        .toLowerCase()
        .replace(/[-_]/g, ' ')
        .replace(/\s+/g, ' ');
    };

    const _getCanonicalColors = (full: any): string[] => {
      const raw: any[] = [];
      if (!full) return [];
      raw.push(full.color);
      if (Array.isArray(full.colors)) raw.push(...full.colors);
      raw.push(full.metadata?.color);
      if (Array.isArray(full.metadata?.colors))
        raw.push(...full.metadata.colors);
      raw.push(full.enrichment?.color);
      if (Array.isArray(full.enrichment?.colors))
        raw.push(...full.enrichment.colors);
      const out = new Set<string>();
      for (const r of raw) {
        const n = _normColor(r);
        if (n) out.add(n);
      }
      return [...out];
    };

    const _hydrateOutfitColors = (outfit: any): any => {
      const items = Array.isArray(outfit?.items) ? outfit.items : [];
      outfit.items = items.map((it: any) => {
        const full = it?.id ? fullItemMap.get(it.id) : null;
        let canonicalColors = _getCanonicalColors(full);
        // Stub fallback: when item ID is missing from fullItemMap, extract
        // colors from the outfit stub itself so avoid_colors guards still work.
        if (canonicalColors.length === 0 && it) {
          const stubRaw: any[] = [];
          if (it.color) stubRaw.push(it.color);
          if (Array.isArray(it.colors)) stubRaw.push(...it.colors);
          if (it.metadata?.color) stubRaw.push(it.metadata.color);
          if (Array.isArray(it.metadata?.colors)) stubRaw.push(...it.metadata.colors);
          const stubOut = new Set<string>();
          for (const r of stubRaw) {
            const n = _normColor(r);
            if (n) stubOut.add(n);
          }
          if (stubOut.size > 0) canonicalColors = [...stubOut];
        }
        return { ...it, __canonicalColors: canonicalColors };
      });
      return outfit;
    };

    // Validate ALL candidates (expanded pool for avoid_colors survival)
    const candidatePool = finalOutfits.slice();
    // Hydrate BEFORE taste validation so checkAvoidColors sees canonical colors
    candidatePool.forEach(_hydrateOutfitColors);

    // ── Occasion filter: reject outfits containing inappropriate items for formal contexts ──
    {
      const _occasionCtx = { query: constraint };
      const _beforeOccasion = candidatePool.length;
      for (let i = candidatePool.length - 1; i >= 0; i--) {
        const o = candidatePool[i];
        const badItem = (o.items ?? []).find((it: any) => !isOccasionAppropriate(it, _occasionCtx));
        if (badItem) {
          // console.log(
          //   JSON.stringify({
          //     _tag: 'OCCASION_FILTER_REJECTED',
          //     mode: 'stylist',
          //     itemName: badItem.name ?? badItem.label ?? '?',
          //     reason: getOccasionRejectionReason(badItem, _occasionCtx),
          //   }),
          // );
          candidatePool.splice(i, 1);
        }
      }
      if (_beforeOccasion > candidatePool.length) {
        // console.log(
        //   `[STYLIST] Occasion filter: ${_beforeOccasion} → ${candidatePool.length} outfits`,
        // );
      }
    }

    // ALWAYS-ON: prove expanded pool size before validation
    // console.log(
    //   JSON.stringify({
    //     _tag: 'STYLIST_POOL_EXPANDED_PROOF',
    //     poolSize: candidatePool.length,
    //     avoid: validatorCtx?.styleProfile?.avoid_colors ?? null,
    //   }),
    // );

    // console.log(
    //   JSON.stringify({
    //     _tag: 'CANONICAL_COLOR_HYDRATION_PROOF',
    //     firstItem: candidatePool?.[0]?.items?.[0]?.id ?? null,
    //     firstItemCanonicalColors:
    //       candidatePool?.[0]?.items?.[0]?.__canonicalColors ?? null,
    //   }),
    // );
    // ALWAYS-ON: prove avoid_colors is populated in validatorCtx BEFORE validator runs
    // console.log(
    //   JSON.stringify({
    //     _tag: 'AVOID_COLOR_CTX_PROOF',
    //     avoid: validatorCtx?.styleProfile?.avoid_colors ?? null,
    //   }),
    // );
    const validation = tasteValidateOutfits(
      candidatePool.map((o, i) => ({
        outfitId: o.id ?? `outfit-${i}`,
        items: toValidatorItems(o),
      })),
      validatorCtx,
    );

    // ── Per-item repair for invalid outfits (reuses Studio pattern) ──
    // Instead of rejecting entire outfits, swap offending items from slot pools.
    const _slotToSimpleCat: Record<string, string> = {
      tops: 'top', bottoms: 'bottom', shoes: 'shoes',
      outerwear: 'outerwear', dresses: 'dress',
      accessories: 'accessory', activewear: 'activewear', swimwear: 'swimwear',
    };
    const _avoidExpRepair = [
      ...new Set([
        ...expandAvoidColors(validatorCtx?.styleProfile?.avoid_colors ?? []),
        ...expandStylistAvoidColors(validatorCtx?.styleProfile?.avoid_colors ?? []),
      ]),
    ];
    let _numRepairedViaSwap = 0;

    const repairedPool: any[] = [];
    for (let oi = 0; oi < candidatePool.length; oi++) {
      const outfit = candidatePool[oi];
      const outfitId = outfit.id ?? `outfit-${oi}`;
      const vResult = validation.results.find((r) => r.outfitId === outfitId);
      if (!vResult || vResult.validation.valid) {
        repairedPool.push(outfit);
        continue;
      }
      // Attempt per-item repair
      let fixedItems = [...(outfit.items ?? [])];
      const usedIds = new Set(fixedItems.map((it: any) => it?.id).filter(Boolean));
      for (const fail of vResult.validation.hardFails) {
        if (fail.startsWith('EXTREME_WEATHER_CONTRADICTION') && fail.includes('footwear')) {
          const pool = (categoryPools.shoes ?? []).filter(
            (s: any) => !isOpenFootwear(s) && !usedIds.has(s?.id),
          );
          if (pool.length > 0) {
            fixedItems = fixedItems.filter((it: any) => it?.category !== 'shoes');
            const pick = pool[0];
            fixedItems.push({
              id: pick.id,
              name: pick.name || pick.ai_title || 'Item',
              imageUrl: pick.touched_up_image_url || pick.processed_image_url || pick.image_url || pick.image,
              category: 'shoes',
            });
            usedIds.add(pick.id);
          }
        } else if (fail.startsWith('CROSS_PRESENTATION')) {
          const idMatch = fail.match(/item (\S+)/);
          if (idMatch) {
            const badItem = fixedItems.find((it: any) => it?.id === idMatch[1]);
            if (badItem) {
              const cat = badItem.category as string;
              const poolKey = cat as keyof typeof categoryPools;
              const pool = ((categoryPools as any)[poolKey] ?? []).filter((c: any) => {
                if (usedIds.has(c?.id)) return false;
                const pc = c?.presentation_code;
                if (!pc) return true;
                if (validatorCtx.userPresentation === 'masculine') return pc !== 'feminine';
                if (validatorCtx.userPresentation === 'feminine') return pc !== 'masculine';
                return true;
              });
              if (pool.length > 0) {
                fixedItems = fixedItems.filter((it: any) => it?.id !== idMatch[1]);
                const pick = pool[0];
                fixedItems.push({
                  id: pick.id,
                  name: pick.name || pick.ai_title || 'Item',
                  imageUrl: pick.touched_up_image_url || pick.processed_image_url || pick.image_url || pick.image,
                  category: cat,
                });
                usedIds.add(pick.id);
              }
            }
          }
        } else if (fail.startsWith('DRESS_CODE_MISMATCH')) {
          const idMatch = fail.match(/item (\S+)/);
          if (idMatch) {
            const badItem = fixedItems.find((it: any) => it?.id === idMatch[1]);
            if (badItem) {
              const cat = badItem.category as string;
              const poolKey = cat as keyof typeof categoryPools;
              const casualCodes = ['ultracasual', 'ultra casual', 'athletic'];
              const pool = ((categoryPools as any)[poolKey] ?? []).filter((c: any) => {
                if (usedIds.has(c?.id)) return false;
                const dc = (c?.dress_code ?? '').toLowerCase();
                if (!dc) return true;
                return !casualCodes.some((cc) => dc.includes(cc));
              });
              if (pool.length > 0) {
                fixedItems = fixedItems.filter((it: any) => it?.id !== idMatch[1]);
                const pick = pool[0];
                fixedItems.push({
                  id: pick.id,
                  name: pick.name || pick.ai_title || 'Item',
                  imageUrl: pick.touched_up_image_url || pick.processed_image_url || pick.image_url || pick.image,
                  category: cat,
                });
                usedIds.add(pick.id);
              }
            }
          }
        } else if (fail.startsWith('AVOID_COLOR')) {
          const idMatch = fail.match(/item (\S+)/);
          if (idMatch) {
            const badItem = fixedItems.find((it: any) => it?.id === idMatch[1]);
            if (badItem) {
              const cat = badItem.category as string;
              const poolKey = cat as keyof typeof categoryPools;
              const pool = ((categoryPools as any)[poolKey] ?? []).filter((c: any) => {
                if (usedIds.has(c?.id)) return false;
                const cColors = extractItemColors(c as any);
                if (c.color_family) cColors.push(c.color_family.trim().toLowerCase());
                for (const ic of cColors) {
                  for (const ac of _avoidExpRepair) {
                    if (colorMatchesSafe(ic, ac)) return false;
                  }
                }
                return true;
              });
              if (pool.length > 0) {
                fixedItems = fixedItems.filter((it: any) => it?.id !== idMatch[1]);
                const pick = pool[0];
                fixedItems.push({
                  id: pick.id,
                  name: pick.name || pick.ai_title || 'Item',
                  imageUrl: pick.touched_up_image_url || pick.processed_image_url || pick.image_url || pick.image,
                  category: cat,
                });
                usedIds.add(pick.id);
              }
            }
          }
        } else if (fail.startsWith('MISSING_REQUIRED_SLOTS')) {
          const existingCats = new Set(fixedItems.map((it: any) => it?.category));
          const hasDressLike = existingCats.has('dress') || existingCats.has('activewear') || existingCats.has('swimwear');
          if (!hasDressLike) {
            for (const [cat, poolKey] of [['top', 'top'], ['bottom', 'bottom'], ['shoes', 'shoes']] as const) {
              if (!existingCats.has(cat)) {
                const pool = ((categoryPools as any)[poolKey] ?? []).filter((c: any) => !usedIds.has(c?.id));
                if (pool.length > 0) {
                  const pick = pool[0];
                  fixedItems.push({
                    id: pick.id,
                    name: pick.name || pick.ai_title || 'Item',
                    imageUrl: pick.touched_up_image_url || pick.processed_image_url || pick.image_url || pick.image,
                    category: cat,
                  });
                  usedIds.add(pick.id);
                }
              }
            }
          } else if (!existingCats.has('shoes') && !existingCats.has('swimwear')) {
            const pool = (categoryPools.shoes ?? []).filter((c: any) => !usedIds.has(c?.id));
            if (pool.length > 0) {
              const pick = pool[0];
              fixedItems.push({
                id: pick.id,
                name: pick.name || pick.ai_title || 'Item',
                imageUrl: pick.touched_up_image_url || pick.processed_image_url || pick.image_url || pick.image,
                category: 'shoes',
              });
              usedIds.add(pick.id);
            }
          }
        }
      }
      // Re-validate repaired outfit; hydrate colors on new items first
      const repairedOutfit = { ...outfit, items: fixedItems };
      _hydrateOutfitColors(repairedOutfit);
      const recheck = tasteValidateOutfit(toValidatorItems(repairedOutfit), validatorCtx);
      if (recheck.valid) {
        _numRepairedViaSwap++;
        repairedPool.push(repairedOutfit);
        console.log(JSON.stringify({
          _tag: 'STYLIST_TASTE_REPAIR_SUCCESS',
          outfitId,
          failsFixed: vResult.validation.hardFails,
        }));
      } else {
        // Repair failed — discard (no fail-open backfill of broken outfits)
        console.log(JSON.stringify({
          _tag: 'STYLIST_TASTE_REPAIR_FAILED',
          outfitId,
          remainingFails: recheck.hardFails,
        }));
      }
    }

    const validOutfits = repairedPool;
    const invalidCount = candidatePool.length - repairedPool.length;

    // Build result: only valid (including repaired) outfits proceed
    let selectedOutfits: any[];
    let _backfillUsed = 'NONE';
    if (validOutfits.length >= 3) {
      selectedOutfits = validOutfits;
    } else {
      // Fallback: if repair couldn't salvage 3, use what we have (fail-open)
      selectedOutfits = validOutfits;
      _backfillUsed = validOutfits.length < 3 ? 'INSUFFICIENT' : 'NONE';
    }
    // ALWAYS-ON: taste validation proof (ungated for debugging avoid_colors)
    // console.log(
    //   JSON.stringify({
    //     _tag: 'STYLIST_TASTE_PROOF',
    //     candidatePoolSize: candidatePool.length,
    //     numHardFailed: invalidCount,
    //     numRepairedViaSwap: _numRepairedViaSwap,
    //     numValidAfterValidation: validOutfits.length,
    //     backfillUsed: _backfillUsed,
    //     finalReturnedCount: selectedOutfits.length,
    //     ...(selectedOutfits.length < 3
    //       ? { reason: 'WARDROBE_INSUFFICIENT' }
    //       : {}),
    //   }),
    // );

    // Elite Scoring hook — Phase 2: rerank when V2 flag on
    // ONE-FLAG: ELITE_ENABLED in feature-flags.ts:42 force-enables STYLIST + STYLIST_V2
    const _usedV2 = ELITE_FLAGS.STYLIST_V2 || demoElite;
    let _eliteRerankRan = false;
    let eliteOutfits = selectedOutfits;
    if (ELITE_FLAGS.STYLIST || ELITE_FLAGS.STYLIST_V2 || demoElite) {
      const canonical = eliteOutfits.map(normalizeStylistOutfit);
      const result = elitePostProcessOutfits(canonical, eliteStyleContext, {
        mode: 'stylist',
        rerank: _usedV2,
        debug: ELITE_FLAGS.DEBUG || demoElite,
      });
      eliteOutfits = result.outfits.map(denormalizeStylistOutfit);
      _eliteRerankRan = _usedV2;
    }
    if (ELITE_FLAGS.DEBUG) {
      // console.log(
      //   JSON.stringify({
      //     _tag: 'STYLIST_ELITE_PROOF',
      //     eliteEnabled: ELITE_FLAGS.STYLIST || ELITE_FLAGS.STYLIST_V2,
      //     usedV2: _eliteRerankRan,
      //     returned: eliteOutfits.length,
      //     validatorRan: true,
      //     numHardFailed: invalidCount,
      //     numRepaired: _numRepairedViaSwap,
      //     backfillUsed: _backfillUsed !== 'NONE',
      //   }),
      // );
    }
    // Re-hydrate eliteOutfits (elite scoring creates new objects via denormalize)
    eliteOutfits.forEach(_hydrateOutfitColors);

    // ── AVOID_COLOR REGENERATION: generate new valid outfits instead of restoring invalid ones ──
    const _regenerateAvoidSafe = (
      avoidExpanded: string[],
      existingIds: Set<string>,
      outfitChecker: (outfit: any) => boolean,
    ): any[] => {
      const _itemHasAvoidColor = (item: any): boolean => {
        const colors: string[] = [];
        if (item.color) colors.push(item.color);
        if (Array.isArray(item.colors)) colors.push(...item.colors);
        if (item.metadata?.color) colors.push(item.metadata.color);
        if (Array.isArray(item.metadata?.colors)) colors.push(...item.metadata.colors);
        if (item.enrichment?.color) colors.push(item.enrichment.color);
        if (Array.isArray(item.enrichment?.colors)) colors.push(...item.enrichment.colors);
        for (const raw of colors) {
          if (typeof raw !== 'string') continue;
          const ic = raw.trim().toLowerCase();
          for (const ac of avoidExpanded) {
            if (colorMatchesSafe(ic, ac)) return true;
          }
        }
        return false;
      };

      const _bySlot: Record<string, any[]> = {};
      for (const item of availableWardrobe) {
        if (_stylistVetoIds.has(item.id)) continue; // hard veto propagation
        if (_itemHasAvoidColor(item)) continue;
        const cat = this.mapToCategory(item.main_category || item.category);
        if (!_bySlot[cat]) _bySlot[cat] = [];
        _bySlot[cat].push({
          id: item.id,
          name: item.name || item.ai_title || 'Item',
          imageUrl:
            item.touched_up_image_url ||
            item.processed_image_url ||
            item.image_url ||
            item.image,
          category: cat,
        });
      }

      const tops = _bySlot['top'] ?? [];
      const bottoms = _bySlot['bottom'] ?? [];
      const shoes = _bySlot['shoes'] ?? [];
      const dresses = _bySlot['dress'] ?? [];

      let generated: any[] = [];
      let _synId = 0;
      const _usedCombos = new Set<string>();

      for (let attempt = 1; attempt <= 3; attempt++) {
        console.log(
          JSON.stringify({
            _tag: 'AVOID_COLOR_REGEN_TRIGGERED',
            avoid: avoidExpanded.slice(0, 20),
            attempt,
          }),
        );

        // Separates: top + bottom + shoes
        for (let ti = 0; ti < tops.length && generated.length < 3; ti++) {
          for (let bi = 0; bi < bottoms.length && generated.length < 3; bi++) {
            for (let si = 0; si < shoes.length && generated.length < 3; si++) {
              const items = [tops[ti], bottoms[bi], shoes[si]];
              const combo = items
                .map((i) => i.id)
                .sort()
                .join(',');
              if (_usedCombos.has(combo) || existingIds.has(combo)) continue;
              _usedCombos.add(combo);
              const outfit = {
                id: `regen-${_synId++}`,
                rank: 3 as any,
                summary: 'Regenerated (avoid-safe)',
                reasoning: '',
                items,
              };
              _hydrateOutfitColors(outfit);
              if (!outfitChecker(outfit)) {
                generated.push(outfit);
              }
            }
          }
        }

        // Dresses: dress + shoes
        for (let di = 0; di < dresses.length && generated.length < 3; di++) {
          for (let si = 0; si < shoes.length && generated.length < 3; si++) {
            const items = [dresses[di], shoes[si]];
            const combo = items
              .map((i) => i.id)
              .sort()
              .join(',');
            if (_usedCombos.has(combo) || existingIds.has(combo)) continue;
            _usedCombos.add(combo);
            const outfit = {
              id: `regen-${_synId++}`,
              rank: 3 as any,
              summary: 'Regenerated (avoid-safe)',
              reasoning: '',
              items,
            };
            _hydrateOutfitColors(outfit);
            if (!outfitChecker(outfit)) {
              generated.push(outfit);
            }
          }
        }

        console.log(
          JSON.stringify({
            _tag: 'AVOID_COLOR_REGEN_RESULT',
            generated: generated.length,
            valid: generated.length,
            attempt,
          }),
        );

        if (generated.length >= 1) break;
      }

      return generated;
    };

    // ── AVOID_COLOR FINAL GUARD: deterministic post-repair filter ──
    const _avoidColorList = validatorCtx.styleProfile?.avoid_colors;
    if (_avoidColorList && _avoidColorList.length > 0) {
      const _expanded = [
        ...new Set([
          ...expandAvoidColors(_avoidColorList),
          ...expandStylistAvoidColors(_avoidColorList),
        ]),
      ];

      const _outfitHasAvoidedColor = (outfit: any): boolean => {
        for (const it of outfit.items ?? []) {
          const colors = extractItemColors(it as any);
          for (const ic of colors) {
            for (const ac of _expanded) {
              if (colorMatchesSafe(ic, ac)) return true;
            }
          }
        }
        return false;
      };

      const _beforeCount = eliteOutfits.length;
      let _cleanElite = eliteOutfits.filter(
        (o) => !_outfitHasAvoidedColor(o),
      );
      if (_cleanElite.length < 3) {
        // Backfill from candidate pool, excluding already-selected + color-violating
        const _cleanBackfill = candidatePool
          .filter((o) => !_outfitHasAvoidedColor(o))
          .filter(
            (o) => !_cleanElite.some((c) => (c.id ?? '') === (o.id ?? '')),
          );
        _cleanElite = [..._cleanElite, ..._cleanBackfill].slice(0, 3);
      }
      // REGENERATION: generate new valid outfits instead of restoring invalid ones
      if (_cleanElite.length === 0 && _beforeCount > 0) {
        const _regenExistingIds = new Set(
          candidatePool.map((o) =>
            (o.items || [])
              .map((i: any) => i?.id)
              .filter(Boolean)
              .sort()
              .join(','),
          ),
        );
        const _regenerated = _regenerateAvoidSafe(
          _expanded,
          _regenExistingIds,
          _outfitHasAvoidedColor,
        );
        if (_regenerated.length > 0) {
          _cleanElite = _regenerated.slice(0, 3);
          console.log(
            JSON.stringify({
              _tag: 'AVOID_COLOR_REGEN_SUCCESS',
              returned: _cleanElite.length,
            }),
          );
        } else {
          console.log(
            JSON.stringify({
              _tag: 'AVOID_COLOR_REGEN_FAILED',
              reason: 'WARDROBE_TRULY_INSUFFICIENT',
            }),
          );
        }
      }
      eliteOutfits = _cleanElite;
      // ALWAYS-ON: final guard proof (ungated for debugging avoid_colors)
      // console.log(
      //   JSON.stringify({
      //     _tag: 'AVOID_COLOR_FINAL_GUARD',
      //     avoidColors: _avoidColorList,
      //     expandedAvoid: _expanded,
      //     beforeCount: _beforeCount,
      //     afterCount: eliteOutfits.length,
      //   }),
      // );
    }

    // ── Elite Scoring: log exposure event (fire-and-forget) ──
    // NOT gated by ELITE_FLAGS — gated by LEARNING_FLAGS + consent + circuit breaker
    if (this.learningEventsService && userId) {
      const canonicalForEvent = eliteOutfits.map(normalizeStylistOutfit);
      const exposureEvent = buildEliteExposureEvent(userId, canonicalForEvent, {
        mode: 'stylist',
        weather: temp != null ? { temp } : undefined,
      });
      this.learningEventsService.logEvent(exposureEvent).catch(() => {});
    }

    // ── RETURN-TIME AVOID_COLOR HARD GUARD (fail-closed) ──
    const _rtNorm = (s: any) =>
      typeof s === 'string'
        ? s
            .trim()
            .toLowerCase()
            .replace(/[-_]/g, ' ')
            .replace(/\s+/g, ' ')
        : '';
    const _rtAvoidRaw = validatorCtx?.styleProfile?.avoid_colors ?? [];
    const _rtAvoid = Array.from(
      new Set(_rtAvoidRaw.map(_rtNorm).filter(Boolean)),
    );
    // Use expanded avoid list for return-time guard (synonyms + color families)
    const _rtExpandedAvoid = [
      ...new Set([
        ...expandAvoidColors(_rtAvoid),
        ...expandStylistAvoidColors(_rtAvoid),
      ]),
    ];
    const _rtHasAvoid = (outfit: any): boolean => {
      const items = Array.isArray(outfit?.items) ? outfit.items : [];
      for (const it of items) {
        const colors: string[] = Array.isArray((it as any).__canonicalColors)
          ? (it as any).__canonicalColors
          : [];
        for (const c of colors) {
          for (const a of _rtExpandedAvoid) {
            if (colorMatchesSafe(c, a)) return true;
          }
        }
      }
      return false;
    };
    if (_rtAvoid.length > 0) {
      const _rtBefore = eliteOutfits.length;

      eliteOutfits = eliteOutfits.filter((o: any) => !_rtHasAvoid(o));
      if (eliteOutfits.length < 3) {
        const _rtBackfill = candidatePool
          .filter((o: any) => !_rtHasAvoid(o))
          .filter(
            (o: any) =>
              !eliteOutfits.some(
                (x: any) => (x.id ?? '') === (o.id ?? ''),
              ),
          );
        eliteOutfits = [...eliteOutfits, ..._rtBackfill].slice(0, 3);
      }
      // REGENERATION: generate new valid outfits instead of restoring invalid ones
      if (eliteOutfits.length === 0 && _rtBefore > 0) {
        const _rtRegenExistingIds = new Set(
          candidatePool.map((o) =>
            (o.items || [])
              .map((i: any) => i?.id)
              .filter(Boolean)
              .sort()
              .join(','),
          ),
        );
        const _rtRegenerated = _regenerateAvoidSafe(
          _rtExpandedAvoid,
          _rtRegenExistingIds,
          _rtHasAvoid,
        );
        if (_rtRegenerated.length > 0) {
          eliteOutfits = _rtRegenerated.slice(0, 3);
          console.log(
            JSON.stringify({
              _tag: 'AVOID_COLOR_REGEN_SUCCESS',
              returned: eliteOutfits.length,
            }),
          );
        } else {
          console.log(
            JSON.stringify({
              _tag: 'AVOID_COLOR_REGEN_FAILED',
              reason: 'WARDROBE_TRULY_INSUFFICIENT',
            }),
          );
        }
      }
      // console.log(
      //   JSON.stringify({
      //     _tag: 'AVOID_COLOR_RETURN_GUARD_PROOF',
      //     avoid: _rtAvoid,
      //     before: _rtBefore,
      //     after: eliteOutfits.length,
      //     firstOutfitColors: (eliteOutfits?.[0]?.items ?? [])
      //       .flatMap((it: any) => it.__canonicalColors ?? [])
      //       .slice(0, 20),
      //   }),
      // );
    }

    // ALWAYS-ON: log when avoid_colors leaves fewer than 3 outfits
    if (eliteOutfits.length < 3 && (_rtAvoid.length > 0 || (_avoidColorList && _avoidColorList.length > 0))) {
      console.log(
        JSON.stringify({
          _tag: 'WARDROBE_INSUFFICIENT_AFTER_AVOID_COLORS',
          avoid: _rtAvoid,
          valid: eliteOutfits.length,
          pool: candidatePool.length,
        }),
      );
    }

    // ── Style Veto: remove structurally incoherent outfits ──
    {
      const _vetoCtxStylist = { query: constraint };
      const _beforeVetoStylist = eliteOutfits.length;
      const _coherentStylist = eliteOutfits.filter((o: any) => {
        const v = isStylisticallyIncoherent(o, _vetoCtxStylist);
        if (v.invalid) {
          // console.log(
          //   JSON.stringify({
          //     _tag: 'STYLIST_VETO_REJECTED',
          //     mode: 'stylist',
          //     reason: v.reason,
          //     outfitSummary: (o.items ?? []).map((it: any) =>
          //       `${it.name ?? it.label ?? '?'} (${it.subcategory ?? it.main_category ?? '?'})`
          //     ),
          //   }),
          // );
        }
        return !v.invalid;
      });
      if (_coherentStylist.length < _beforeVetoStylist && _coherentStylist.length < 3) {
        // console.log(
        //   JSON.stringify({
        //     _tag: 'STYLIST_VETO_INSUFFICIENT',
        //     mode: 'stylist',
        //     remainingCount: _coherentStylist.length,
        //   }),
        // );
      }
      eliteOutfits = _coherentStylist;
    }

    // ── Quality Floor: curate best outfits by holistic taste scoring + profile delta ──
    const _judgeCtxStylist = {
      requestedDressCode: validatorCtx?.requestedDressCode,
      query: constraint,
    };

    // Save full elite pool BEFORE quality-floor truncation (for swipe paging).
    // These items have passed: weather gate, avoid-color, elite scoring, style veto.
    const _fullElitePool = [...eliteOutfits];

    const _candidateCountStylist = eliteOutfits.length;

    // Defensive assertion: pool must not be empty when candidates exist
    if (_fullElitePool.length === 0 && _candidateCountStylist > 0) {
      console.log(
        JSON.stringify({
          _tag: 'STYLIST_PAGING_POOL_MISMATCH',
          candidateCount: _candidateCountStylist,
          fullElitePoolSize: _fullElitePool.length,
        }),
      );
    }
    eliteOutfits = selectTopOutfitsWithQualityFloor(
      eliteOutfits,
      _judgeCtxStylist,
      (outfit) => applyStylistProfileEnhancements(outfit, brainCtx.styleProfile),
    );
    // Regen debug tag
    if (constraint) {
      console.log(
        JSON.stringify({
          _tag: 'STYLIST_REGEN_GUARD_USED',
          reason: constraint,
          regenCount: _candidateCountStylist,
          shippedCount: eliteOutfits.length,
        }),
      );
    }
    // console.log(
    //   JSON.stringify({
    //     _tag: 'STUDIO_FINAL_CURATION_PROOF',
    //     mode: 'stylist',
    //     candidateCount: _candidateCountStylist,
    //     returnedCount: eliteOutfits.length,
    //     topScores: eliteOutfits.map((o: any) => o.qualityScore ?? (scoreOutfit as any)(o, _judgeCtxStylist).total),
    //   }),
    // );

    // ── DETERMINISTIC SWIPE PAGING: rotate through FULL quality-approved pool ──
    // Pages through ALL quality-eligible outfits (not just the truncated top 3)
    // so each swipe surfaces a fresh group of 3.
    {
      const pageSize = 3;
      const _uid = userId ?? '';
      const _profileDelta = (o: any) => applyStylistProfileEnhancements(o, brainCtx.styleProfile);

      // Score the FULL elite pool (pre-truncation) for ranking.
      // No quality floor filter here — items already passed taste validation,
      // elite scoring, avoid-color, and style veto upstream.
      // selectTopOutfitsWithQualityFloor handles quality thresholds for its own output;
      // paging ranks the full surviving pool for swipe rotation.
      const _scoredAll = _fullElitePool.map((o, i) => {
        const base = (scoreOutfit as any)(o, _judgeCtxStylist).total;
        const delta = _profileDelta(o);
        return { outfit: o, score: Math.max(0, base + delta), index: i };
      });

      _scoredAll.sort((a, b) => b.score - a.score || a.index - b.index);

      // ── ELITE BAND DIVERSITY: deterministic secondary ordering within tight score band ──
      {
        const maxScore = _scoredAll.length > 0 ? _scoredAll[0].score : 0;
        const bandThreshold = 0.05;
        const bandSize = _scoredAll.filter(
          (s) => maxScore - s.score <= bandThreshold,
        ).length;

        if (bandSize > 1) {
          // Deterministic string hash: djb2
          const djb2 = (str: string): number => {
            let hash = 5381;
            for (let i = 0; i < str.length; i++) {
              hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
            }
            return hash >>> 0; // unsigned 32-bit
          };

          // Reorder ONLY within the band using hash(userId + outfitId)
          const bandItems = _scoredAll.slice(0, bandSize);
          const nonBandItems = _scoredAll.slice(bandSize);

          bandItems.sort((a, b) => {
            const idA = a.outfit.id ?? `idx-${a.index}`;
            const idB = b.outfit.id ?? `idx-${b.index}`;
            const hashA = djb2(`${_uid}:${idA}`);
            const hashB = djb2(`${_uid}:${idB}`);
            return hashA - hashB;
          });

          _scoredAll.length = 0;
          _scoredAll.push(...bandItems, ...nonBandItems);

          console.log(
            JSON.stringify({
              _tag: 'STYLIST_ELITE_BAND_DIVERSITY',
              maxScore,
              bandSize,
            }),
          );
        }
      }

      // ── STRICT ROTATION LIMIT: cap swipe pool to top 6 to eliminate quality drift ──
      const ELITE_ROTATION_LIMIT = 6;
      const _rotationPool = _scoredAll.slice(0, ELITE_ROTATION_LIMIT);

      const currentOffset = this.visualSwipeOffset.get(_uid) ?? 0;
      const safeOffset =
        _rotationPool.length <= pageSize
          ? 0
          : currentOffset >= _rotationPool.length
            ? 0
            : currentOffset;
      const paged = _rotationPool.slice(safeOffset, safeOffset + pageSize);
      const nextOffset =
        _rotationPool.length <= pageSize
          ? 0
          : safeOffset + pageSize >= _rotationPool.length
            ? 0
            : safeOffset + pageSize;
      this.visualSwipeOffset.set(_uid, nextOffset);

      eliteOutfits = paged.map((p) => p.outfit);

      // console.log(
      //   JSON.stringify({
      //     _tag: 'STYLIST_ROTATION_TOP_BAND',
      //     rotationPoolSize: _rotationPool.length,
      //     pageOffset: safeOffset,
      //     returnedCount: eliteOutfits.length,
      //   }),
      // );
    }

    // ── EXPLANATION BACKFILL: ensure every returned outfit has a stylist explanation ──
    {
      const _needsExplanation = eliteOutfits.filter(
        (o: any) =>
          !o.summary ||
          o.summary.includes('Synthetic candidate') ||
          o.summary.length < 20,
      );
      let _synExplainCount = 0;
      if (_needsExplanation.length > 0) {
        const _explainItems = (o: any) =>
          (o.items || [])
            .filter(Boolean)
            .map((i: any) => {
              const full = fullItemMap.get(i.id);
              return `${full?.name || i.name} (${i.category})`;
            })
            .join(', ');

        const _buildFallback = (o: any) => {
          const items = (o.items || []).filter(Boolean);
          const topItem = items.find((i: any) => i.category === 'top' || i.category === 'dress');
          const bottomItem = items.find((i: any) => i.category === 'bottom');
          const outerwearItem = items.find((i: any) => i.category === 'outerwear');
          const shoesItem = items.find((i: any) => i.category === 'shoes');
          const topName = topItem ? (fullItemMap.get(topItem.id)?.name || topItem.name) : 'The top';
          const bottomName = bottomItem ? (fullItemMap.get(bottomItem.id)?.name || bottomItem.name) : null;
          const outerwearName = outerwearItem ? (fullItemMap.get(outerwearItem.id)?.name || outerwearItem.name) : null;

          let text = bottomName
            ? `${topName} pairs with ${bottomName} to create a balanced silhouette.`
            : `${topName} anchors the look with a clean silhouette.`;
          if (outerwearName && temp != null) {
            text += ` The ${outerwearName} provides appropriate layering for ${Math.round(temp)}°F weather.`;
          } else if (temp != null) {
            text += ` Well-suited for ${Math.round(temp)}°F conditions.`;
          }
          if (shoesItem) {
            text += ' The footwear grounds the look while maintaining stylistic cohesion.';
          }
          return text;
        };

        await Promise.all(
          _needsExplanation.map(async (outfit: any) => {
            try {
              const itemList = _explainItems(outfit);
              const completion = await this.openai.chat.completions.create({
                model: 'gpt-4o-mini',
                temperature: 0.4,
                max_tokens: 150,
                messages: [
                  {
                    role: 'system',
                    content:
                      'You are a professional fashion stylist writing a brief outfit explanation. Write 2-4 sentences explaining why this outfit works. Mention weather appropriateness and color harmony or silhouette. No emojis. No markdown. No bullet points. Professional tone.',
                  },
                  {
                    role: 'user',
                    content: `Weather: ${temp != null ? `${Math.round(temp)}°F` : 'unknown'}${wxContext?.precipitation !== 'none' ? `, ${wxContext?.precipitation}` : ''}. Client: ${user || 'The user'}. Style: ${preferences ? JSON.stringify(preferences) : 'general'}. Outfit items: ${itemList}.`,
                  },
                ],
              });
              const text = completion.choices[0]?.message?.content?.trim();
              if (text && text.length > 10) {
                outfit.summary = text;
                _synExplainCount++;
              } else {
                outfit.summary = _buildFallback(outfit);
                _synExplainCount++;
              }
            } catch {
              outfit.summary = _buildFallback(outfit);
              _synExplainCount++;
            }
          }),
        );
      }
      // console.log(
      //   JSON.stringify({
      //     _tag: 'STYLIST_EXPLANATION_GENERATED',
      //     syntheticCount: _synExplainCount,
      //     totalReturned: eliteOutfits.length,
      //   }),
      // );
    }

    // ── TITLE HARDENING: enforce max 60 chars, no sentence leakage ──
    {
      const _leakyPatterns = /[.!?]|\bfor the\b|\bbecause\b|\bwhich\b|\bthat\b/i;
      const _weatherLabel = (t: number | undefined) => {
        if (t == null) return '';
        if (t < 50) return 'Cold-Weather';
        if (t < 65) return 'Cool-Weather';
        if (t < 80) return 'Mild-Weather';
        return 'Warm-Weather';
      };
      const _dominantSlot = (o: any): string => {
        const items = (o.items || []).filter(Boolean);
        const _n = (i: any) => ((i.name ?? '') as string).toLowerCase();
        const _c = (i: any) => ((i.category ?? i.main_category ?? '') as string).toLowerCase();
        const _s = (i: any) => ((i.subcategory ?? '') as string).toLowerCase();
        const _m = (i: any) => ((i.material ?? '') as string).toLowerCase();

        if (items.some((i: any) => _c(i) === 'outerwear')) return 'Layered Look';
        if (items.some((i: any) => _s(i).includes('blazer') || _s(i).includes('jacket') || _n(i).includes('blazer'))) return 'Tailoring';
        if (items.some((i: any) => _c(i) === 'dresses' || _c(i) === 'dress')) return 'Ensemble';
        if (items.some((i: any) => (_c(i) === 'bottoms' || _c(i) === 'pants') && (_n(i).includes('denim') || _n(i).includes('jean') || _s(i).includes('jean') || _m(i).includes('denim')))) return 'Denim';
        if (items.some((i: any) => (_c(i) === 'tops' || _c(i) === 'top') && (_n(i).includes('knit') || _n(i).includes('sweater') || _s(i).includes('knit') || _s(i).includes('sweater') || _m(i).includes('knit')))) return 'Knit Ensemble';
        return 'Polished Look';
      };

      for (const outfit of eliteOutfits) {
        const original = (outfit.title || '').trim();
        const originalLength = original.length;
        let title = original;

        // If no title, or title leaks explanation text, or exceeds 60 chars → fix
        if (!title || title.length > 60 || _leakyPatterns.test(title)) {
          if (title && title.length > 0) {
            // Deterministic truncation: first 6 words, capitalize, trim partials
            const words = title.replace(/[.!?,;:]+$/g, '').split(/\s+/).slice(0, 6);
            title = words.join(' ');
            // Remove trailing partial words (under 3 chars) from truncation
            if (title.length > 60) {
              const trimWords = title.split(/\s+/);
              while (trimWords.length > 1 && trimWords.join(' ').length > 60) {
                trimWords.pop();
              }
              title = trimWords.join(' ');
            }
          }
          // Still bad or empty → construct deterministic fallback
          if (!title || title.length < 3 || title.length > 60 || _leakyPatterns.test(title)) {
            const wLabel = _weatherLabel(temp);
            const slot = _dominantSlot(outfit);
            title = wLabel ? `Refined ${wLabel} ${slot}` : `Curated ${slot}`;
            // console.log(JSON.stringify({ _tag: 'STYLIST_TITLE_CONTEXTUALIZED', descriptor: slot }));
          }
        }

        // Strip trailing punctuation
        title = title.replace(/[.!?,;:]+$/g, '').trim();

        // Guarantee title !== explanation
        if (title === (outfit.summary || '').trim()) {
          const wLabel = _weatherLabel(temp);
          const slot = _dominantSlot(outfit);
          title = wLabel ? `Refined ${wLabel} ${slot}` : `Curated ${slot}`;
          console.log(JSON.stringify({ _tag: 'STYLIST_TITLE_CONTEXTUALIZED', descriptor: slot }));
        }

        outfit.title = title;

        // console.log(
        //   JSON.stringify({
        //     _tag: 'STYLIST_TITLE_HARDENED',
        //     originalLength,
        //     finalLength: title.length,
        //   }),
        // );
      }
    }

    // console.log(JSON.stringify({
    //   _tag: 'STYLIST_TITLE_FIELD_PROOF',
    //   titles: eliteOutfits.map((o: any) => o.title),
    // }));

    return { weatherSummary, outfits: eliteOutfits };
  }

  /** Generate concise weather summary for UI (one line max) */
  private generateWeatherSummary(
    temp: number | undefined,
    condition: string,
  ): string {
    if (!temp) return 'Check local weather for best outfit choices.';

    temp = Math.round(temp);
    const conditionLower = (condition || '').toLowerCase();
    const isRainy =
      conditionLower.includes('rain') || conditionLower.includes('drizzle');
    const isCloudy =
      conditionLower.includes('cloud') || conditionLower.includes('overcast');
    const isClear =
      conditionLower.includes('clear') || conditionLower.includes('sun');

    if (temp < 50) {
      if (isRainy)
        return `Cold and rainy (${temp}°F) — warm layers and waterproof shoes.`;
      return `Cold today (${temp}°F) — heavier layers recommended.`;
    }
    if (temp < 65) {
      if (isRainy)
        return `Cool with rain (${temp}°F) — light layers and closed shoes.`;
      return `Cool and ${isClear ? 'clear' : 'crisp'} (${temp}°F) — light layers work well.`;
    }
    if (temp < 80) {
      if (isRainy)
        return `Mild with rain expected (${temp}°F) — breathable layers, closed shoes.`;
      return `Pleasant ${temp}°F — versatile options today.`;
    }
    // Hot weather
    if (isRainy)
      return `Warm and humid (${temp}°F) — lightweight, breathable fabrics.`;
    return `Warm today (${temp}°F) — keep it light and breathable.`;
  }

  /**
   * Map backend category to frontend category type.
   * Uses canonical categoryMapping for slot resolution, then converts to
   * the simplified category format expected by outfit completion logic.
   */
  private mapToCategory(
    category: string,
  ):
    | 'top'
    | 'bottom'
    | 'outerwear'
    | 'shoes'
    | 'accessory'
    | 'dress'
    | 'activewear'
    | 'swimwear' {
    // Import canonical mapping (lazy to avoid circular deps)
    const {
      mapMainCategoryToSlot,
    } = require('../wardrobe/logic/categoryMapping');

    const slot = mapMainCategoryToSlot(category);

    // Convert slot names to simplified category format
    const SLOT_TO_SIMPLE: Record<string, string> = {
      tops: 'top',
      bottoms: 'bottom',
      shoes: 'shoes',
      outerwear: 'outerwear',
      accessories: 'accessory',
      dresses: 'dress',
      activewear: 'activewear',
      swimwear: 'swimwear',
      undergarments: 'accessory', // Treat as accessory for outfit logic
      other: 'accessory', // Default to accessory
    };

    return (SLOT_TO_SIMPLE[slot] || 'accessory') as any;
  }

  /* ------------------------------------------------------------
     🧾 BARCODE / CLOTHING LABEL DECODER
  -------------------------------------------------------------*/
  async decodeBarcode(file: {
    buffer: Buffer;
    originalname: string;
    mimetype: string;
  }) {
    const tempPath = `/tmp/${Date.now()}-barcode.jpg`;
    fs.writeFileSync(tempPath, file.buffer);

    try {
      const base64 = fs.readFileSync(tempPath).toString('base64');

      const prompt = `
      You are analyzing a photo of a product or clothing label.
      If the image contains a barcode, return ONLY the numeric digits (UPC/EAN).
      Otherwise, infer structured product info like:
      {
        "name": "Uniqlo Linen Shirt",
        "brand": "Uniqlo",
        "category": "Shirts",
        "material": "Linen"
      }
      Respond with JSON only. No extra text.
      `;

      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              {
                type: 'image_url',
                image_url: { url: `data:${file.mimetype};base64,${base64}` },
              },
            ],
          },
        ],
        max_tokens: 200,
      });

      const message = completion.choices?.[0]?.message;

      let text = '';
      if (typeof message?.content === 'string') {
        text = message.content;
      } else if (Array.isArray(message?.content)) {
        const parts = message.content as Array<{ text?: string }>;
        text = parts.map((c) => c.text || '').join(' ');
      }

      text = text.trim().replace(/```json|```/g, '');

      const match = text.match(/\b\d{8,14}\b/);
      if (match) return { barcode: match[0], raw: text };

      try {
        const parsed = JSON.parse(text);
        if (parsed?.name) return { barcode: null, inferred: parsed };
      } catch {}

      return { barcode: null, raw: text };
    } catch (err: any) {
      console.error('❌ [AI] decodeBarcode error:', err.message);
      return { barcode: null, error: err.message };
    } finally {
      try {
        fs.unlinkSync(tempPath);
      } catch {}
    }
  }

  /* ------------------------------------------------------------
     🧩 PRODUCT LOOKUP BY BARCODE
  -------------------------------------------------------------*/
  async lookupProductByBarcode(upc: string) {
    const normalized = upc.padStart(12, '0');
    try {
      const res = await fetch(
        `https://api.upcitemdb.com/prod/trial/lookup?upc=${normalized}`,
      );
      const json = await res.json();

      const item = json?.items?.[0];
      if (!item) throw new Error('No product data from UPCItemDB');

      return {
        name: item.title,
        brand: item.brand,
        image: item.images?.[0],
        category: item.category,
        source: 'upcitemdb',
      };
    } catch (err: any) {
      console.warn('⚠️ UPCItemDB lookup failed:', err.message);
      const fallback = await this.lookupFallback(normalized);
      if (!fallback?.name || fallback.name === 'Unknown product') {
        return await this.lookupFallbackWithAI(normalized);
      }
      return fallback;
    }
  }

  /* ------------------------------------------------------------
     🔁 RapidAPI or Dummy Fallback
  -------------------------------------------------------------*/
  async lookupFallback(upc: string) {
    try {
      const rapidApiKey = secretExists('RAPIDAPI_KEY')
        ? getSecret('RAPIDAPI_KEY')
        : '';
      const res = await fetch(`https://barcodes1.p.rapidapi.com/?upc=${upc}`, {
        headers: {
          'X-RapidAPI-Key': rapidApiKey,
          'X-RapidAPI-Host': 'barcodes1.p.rapidapi.com',
        },
      });

      const json = await res.json();
      const product = json?.product ?? {};

      return {
        name: product.title || json.title || 'Unknown product',
        brand: product.brand || json.brand || 'Unknown brand',
        image: product.image || json.image || null,
        category: product.category || 'Uncategorized',
        source: 'rapidapi',
      };
    } catch (err: any) {
      console.error('❌ lookupFallback failed:', err.message);
      return { name: null, brand: null, image: null, category: null };
    }
  }

  /* ------------------------------------------------------------
     🤖 AI Fallback Guess
  -------------------------------------------------------------*/
  async lookupFallbackWithAI(upc: string) {
    try {
      const prompt = `
      The barcode number is: ${upc}.
      Guess the product based on global manufacturer codes.
      Return valid JSON only:
      {"name":"Example Product","brand":"Brand","category":"Category"}
      `;

      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 150,
      });

      let text = completion.choices?.[0]?.message?.content?.trim() || '{}';
      text = text.replace(/```json|```/g, '').trim();

      let parsed: any;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = {
          name:
            text.replace(/["{}]/g, '').split(',')[0]?.trim() ||
            'Unknown product',
          brand: 'Unknown',
          category: 'Misc',
        };
      }

      return {
        name: parsed.name || 'Unknown product',
        brand: parsed.brand || 'Unknown',
        category: parsed.category || 'Misc',
        source: 'ai-fallback',
      };
    } catch (err: any) {
      console.error('❌ AI fallback failed:', err.message);
      return {
        name: 'Unknown product',
        brand: 'Unknown',
        category: 'Uncategorized',
        source: 'ai-fallback',
      };
    }
  }
}

///////////////////

// import { Injectable, BadRequestException } from '@nestjs/common';
// import OpenAI from 'openai';
// import { ChatDto } from './dto/chat.dto';
// import { VertexService } from '../vertex/vertex.service'; // 🔹 ADDED
// import { ProductSearchService } from '../product-services/product-search.service';
// import { Pool } from 'pg';
// import { Express } from 'express';
// import { redis } from '../utils/redisClient';

// const pool = new Pool({
//   connectionString: process.env.DATABASE_URL,
//   ssl: { rejectUnauthorized: false },
// });

// import * as fs from 'fs';
// import * as path from 'path';
// import * as dotenv from 'dotenv';

// function loadOpenAISecrets(): {
//   apiKey?: string;
//   project?: string;
//   source: string;
// } {
//   const candidates = [
//     path.join(process.cwd(), '.env'),
//     path.join(process.cwd(), 'apps', 'backend-nest', '.env'),
//     path.join(__dirname, '..', '..', '.env'),
//   ];

//   for (const p of candidates) {
//     try {
//       if (fs.existsSync(p)) {
//         const parsed = dotenv.parse(fs.readFileSync(p));
//         const apiKey = parsed['OPENAI_API_KEY'];
//         const project = parsed['OPENAI_PROJECT_ID'];
//         if (apiKey) return { apiKey, project, source: p };
//       }
//     } catch {
//       // ignore
//     }
//   }

//   return {
//     apiKey: process.env.OPENAI_API_KEY,
//     project: process.env.OPENAI_PROJECT_ID,
//     source: 'process.env',
//   };
// }

// // 🧥 Basic capsule wardrobe templates
// const CAPSULES = {
//   Spring: [
//     { category: 'Outerwear', subcategory: 'Light Jacket', recommended: 2 },
//     { category: 'Tops', subcategory: 'Oxford Shirt', recommended: 3 },
//     { category: 'Bottoms', subcategory: 'Chinos', recommended: 2 },
//     { category: 'Shoes', subcategory: 'Loafers', recommended: 1 },
//     { category: 'Shoes', subcategory: 'Sneakers', recommended: 1 },
//   ],
//   Summer: [
//     { category: 'Tops', subcategory: 'Short Sleeve Shirt', recommended: 4 },
//     { category: 'Tops', subcategory: 'Polo Shirt', recommended: 2 },
//     { category: 'Bottoms', subcategory: 'Linen Trousers', recommended: 2 },
//     { category: 'Shoes', subcategory: 'Loafers', recommended: 1 },
//     { category: 'Shoes', subcategory: 'Sandals', recommended: 1 },
//   ],
//   Fall: [
//     { category: 'Outerwear', subcategory: 'Field Jacket', recommended: 1 },
//     { category: 'Outerwear', subcategory: 'Blazer', recommended: 1 },
//     { category: 'Tops', subcategory: 'Knit Sweater', recommended: 2 },
//     { category: 'Bottoms', subcategory: 'Wool Trousers', recommended: 2 },
//     { category: 'Shoes', subcategory: 'Chelsea Boots', recommended: 1 },
//   ],
//   Winter: [
//     { category: 'Outerwear', subcategory: 'Overcoat', recommended: 1 },
//     { category: 'Outerwear', subcategory: 'Heavy Parka', recommended: 1 },
//     { category: 'Tops', subcategory: 'Heavy Knit Sweater', recommended: 2 },
//     { category: 'Bottoms', subcategory: 'Wool Trousers', recommended: 2 },
//     { category: 'Shoes', subcategory: 'Boots', recommended: 2 },
//   ],
// };

// // 🗓️ Auto-detect season based on month
// function getCurrentSeason(): 'Spring' | 'Summer' | 'Fall' | 'Winter' {
//   const month = new Date().getMonth() + 1;
//   if ([3, 4, 5].includes(month)) return 'Spring';
//   if ([6, 7, 8].includes(month)) return 'Summer';
//   if ([9, 10, 11].includes(month)) return 'Fall';
//   return 'Winter';
// }

// // 🧠 Compare wardrobe to capsule and return simple forecast text
// function generateSeasonalForecast(wardrobe: any[] = []): string | undefined {
//   const season = getCurrentSeason();
//   const capsule = CAPSULES[season];
//   if (!capsule) return;

//   const missing: string[] = [];

//   capsule.forEach((item) => {
//     const owned = wardrobe.filter(
//       (w) =>
//         w.category?.toLowerCase() === item.category.toLowerCase() &&
//         w.subcategory?.toLowerCase() === item.subcategory.toLowerCase(),
//     ).length;

//     if (owned < item.recommended) {
//       const needed = item.recommended - owned;
//       missing.push(`${needed} × ${item.subcategory}`);
//     }
//   });

//   if (missing.length === 0) {
//     return `✅ Your ${season} capsule is complete — you're ready for the season.`;
//   }

//   return `🍂 ${season} is approaching — you're missing: ${missing.join(', ')}.`;
// }

// // 🌦️ Weather fetching helper for AI context
// async function fetchWeatherForAI(
//   lat: number,
//   lon: number,
// ): Promise<{
//   tempF: number;
//   humidity: number;
//   windSpeed: number;
//   weatherCode: number;
//   condition: string;
// } | null> {
//   try {
//     const apiKey = process.env.TOMORROW_API_KEY;
//     if (!apiKey) {
//       console.warn('⚠️ TOMORROW_API_KEY not set - weather unavailable for AI');
//       return null;
//     }
//     const url = `https://api.tomorrow.io/v4/weather/realtime?location=${lat},${lon}&apikey=${apiKey}`;
//     const res = await fetch(url);
//     if (!res.ok) return null;
//     const data = await res.json();
//     const values = data?.data?.values;
//     if (!values) return null;

//     // Map weather codes to conditions
//     const weatherConditions: Record<number, string> = {
//       1000: 'Clear/Sunny',
//       1100: 'Mostly Clear',
//       1101: 'Partly Cloudy',
//       1102: 'Mostly Cloudy',
//       1001: 'Cloudy',
//       2000: 'Fog',
//       4000: 'Drizzle',
//       4001: 'Rain',
//       4200: 'Light Rain',
//       4201: 'Heavy Rain',
//       5000: 'Snow',
//       5001: 'Flurries',
//       5100: 'Light Snow',
//       5101: 'Heavy Snow',
//       6000: 'Freezing Drizzle',
//       6001: 'Freezing Rain',
//       7000: 'Ice Pellets',
//       7101: 'Heavy Ice Pellets',
//       7102: 'Light Ice Pellets',
//       8000: 'Thunderstorm',
//     };

//     return {
//       tempF: Math.round((values.temperature * 9) / 5 + 32),
//       humidity: Math.round(values.humidity),
//       windSpeed: Math.round(values.windSpeed),
//       weatherCode: values.weatherCode,
//       condition: weatherConditions[values.weatherCode] || 'Unknown',
//     };
//   } catch (err: any) {
//     console.warn('⚠️ Weather fetch failed:', err.message);
//     return null;
//   }
// }

// @Injectable()
// export class AiService {
//   private openai: OpenAI;
//   private useVertex: boolean;
//   private vertexService?: VertexService; // 🔹 optional instance
//   private productSearch: ProductSearchService; // ✅ add this
//   // 🧠 Fast in-memory cache for repeated TTS phrases
//   private ttsCache = new Map<string, Buffer>();

//   constructor(vertexService?: VertexService) {
//     const { apiKey, project, source } = loadOpenAISecrets();

//     const snippet = apiKey?.slice(0, 20) ?? '';
//     const len = apiKey?.length ?? 0;
//     console.log('🔑 OPENAI key source:', source);
//     console.log('🔑 OPENAI key snippet:', JSON.stringify(snippet));
//     console.log('🔑 OPENAI key length:', len);
//     console.log('📂 CWD:', process.cwd());

//     if (!apiKey) {
//       throw new Error('OPENAI_API_KEY not found in .env or environment.');
//     }
//     if (/^sk-?x{3,}/i.test(apiKey)) {
//       throw new Error(
//         'OPENAI_API_KEY appears masked (e.g., "sk-xxxxx..."). Read from the correct .env instead.',
//       );
//     }
//     if (!apiKey.startsWith('sk-')) {
//       throw new Error('OPENAI_API_KEY is malformed — must start with "sk-".');
//     }

//     this.openai = new OpenAI({ apiKey, project });

//     // 🔹 New: Vertex toggle
//     this.useVertex = process.env.USE_VERTEX === 'true';
//     if (this.useVertex) {
//       this.vertexService = vertexService;
//       console.log('🧠 Vertex/Gemini mode enabled for analyze/recreate');
//     }

//     this.productSearch = new ProductSearchService(); // NEW
//   }

//   // async generateSpeechBuffer(text: string): Promise<Buffer> {
//   //   if (!text?.trim()) throw new BadRequestException('Empty text');

//   //   // 👇 bypass outdated type definition safely
//   //   const resp = await this.openai.audio.speech.create({
//   //     model: 'gpt-4o-mini-tts',
//   //     voice: 'alloy',
//   //     input: text,

//   //     format: 'mp3',
//   //   } as any);

//   //   const arrayBuf = await resp.arrayBuffer();
//   //   return Buffer.from(arrayBuf);
//   // }

//   /** 🎙️ Generate Alloy voice speech (cached + streamable) */
//   async generateSpeechBuffer(text: string): Promise<Buffer> {
//     if (!text?.trim()) throw new BadRequestException('Empty text');

//     // 🧠 Cache key (base64 of text)
//     const cacheKey = Buffer.from(text).toString('base64').slice(0, 40);
//     if (this.ttsCache.has(cacheKey)) {
//       console.log('💾 [TTS] cache hit:', text.slice(0, 60));
//       return this.ttsCache.get(cacheKey)!;
//     }

//     console.log('🎤 [TTS] generating voice:', text.slice(0, 80));

//     // ✅ bypass type errors safely
//     const resp: any = await (this.openai as any).audio.speech.create(
//       {
//         model: 'gpt-4o-mini-tts',
//         voice: 'alloy',
//         input: text,
//         format: 'mp3',
//       },
//       { responseType: 'stream' }, // runtime param (missing from types)
//     );

//     const stream: NodeJS.ReadableStream = resp.data;
//     const chunks: Buffer[] = [];

//     for await (const chunk of stream) {
//       // 👇 Normalize chunk type (handles both string and Uint8Array)
//       chunks.push(
//         typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk),
//       );
//     }

//     const buffer = Buffer.concat(chunks);
//     this.ttsCache.set(cacheKey, buffer);

//     return buffer;
//   }

//   //  'alloy','ash','ballad','coral','echo','fable','nova','onyx','sage','shimmer','verse'

//   /** 🎧 Stream version for immediate browser playback */
//   async generateSpeechStream(text: string) {
//     if (!text?.trim()) throw new BadRequestException('Empty text');

//     const response = await this.openai.audio.speech.create({
//       model: 'gpt-4o-mini-tts',
//       voice: 'coral',
//       input: text,
//       format: 'mp3',
//       stream: true, // <—— critical flag for live stream
//       // 🔧 optional fine-tuning parameters:
//       speed: 1.0, // 1.0 = normal, higher = faster, 0.8 = slower
//       pitch: 1.0, // 1.0 = default, higher = brighter tone
//     } as any);

//     // ✅ Return the WebReadableStream
//     return response.body;
//   }

//   //////ANALYZE LOOK

//   async analyze(imageUrl: string) {
//     console.log('🧠 [AI] analyze() called with', imageUrl);
//     if (!imageUrl) throw new Error('Missing imageUrl');

//     // 🔹 Try Vertex first if enabled
//     if (this.useVertex && this.vertexService) {
//       try {
//         const gcsUri = imageUrl.replace(
//           'https://storage.googleapis.com/',
//           'gs://',
//         );
//         const metadata = await this.vertexService.analyzeImage(gcsUri);
//         const tags = [
//           ...(metadata.tags || []),
//           ...(metadata.style_descriptors || []),
//           metadata.main_category,
//           metadata.subcategory,
//         ].filter(Boolean);
//         console.log('🧠 [Vertex] analyze() success:', tags);
//         return { tags };
//       } catch (err: any) {
//         console.warn(
//           '[Vertex] analyze() failed → fallback to OpenAI:',
//           err.message,
//         );
//       }
//     }

//     // 🔸 OpenAI fallback
//     try {
//       const completion = await this.openai.chat.completions.create({
//         model: 'gpt-4o-mini',
//         messages: [
//           {
//             role: 'system',
//             content:
//               'You are a professional fashion classifier. Return only JSON with a "tags" array describing the outfit’s style, color palette, and vibe.',
//           },
//           {
//             role: 'user',
//             content: [
//               { type: 'text', text: 'Describe this outfit as tags only:' },
//               { type: 'image_url', image_url: { url: imageUrl } },
//             ],
//           },
//         ],
//         response_format: { type: 'json_object' },
//       });

//       const raw = completion.choices[0]?.message?.content;
//       console.log('🧠 [AI] analyze() raw response:', raw);

//       if (!raw) throw new Error('Empty response from OpenAI');
//       const parsed = JSON.parse(raw || '{}');
//       return { tags: parsed.tags || [] };
//     } catch (err: any) {
//       console.error('❌ [AI] analyze() failed:', err.message);
//       return { tags: ['casual', 'modern', 'neutral'] };
//     }
//   }

//   /* ------------------------------------------------------------
//      🧩 Weighted Tag Enrichment + Trend Injection
//   -------------------------------------------------------------*/
//   private async enrichTags(tags: string[]): Promise<string[]> {
//     const weightMap: Record<string, number> = {
//       tailored: 3,
//       minimal: 3,
//       neutral: 3,
//       modern: 2,
//       vintage: 2,
//       classic: 2,
//       streetwear: 2,
//       oversized: 2,
//       slim: 2,
//       relaxed: 2,
//       casual: 1,
//       sporty: 1,
//     };

//     // 🧹 Normalize + de-dupe
//     const cleanTags = Array.from(
//       new Set(
//         tags
//           .map((t) => t.toLowerCase().trim())
//           .filter((t) => t && !['outfit', 'style', 'fashion'].includes(t)),
//       ),
//     );

//     // 🧠 Apply weights
//     const weighted = cleanTags
//       .map((t) => ({ tag: t, weight: weightMap[t] || 1 }))
//       .sort((a, b) => b.weight - a.weight);

//     // 🌍 Inject current trend tags
//     const trendTags = await this.fetchTrendTags();
//     const final = Array.from(
//       new Set([...weighted.map((w) => w.tag), ...trendTags.slice(0, 3)]),
//     );

//     console.log('🎯 [AI] Enriched tags →', final);
//     return final;
//   }

//   private async fetchTrendTags(): Promise<string[]> {
//     try {
//       const res = await fetch(
//         'https://trends.google.com/trends/hottrends/visualize/internal/data/en_us',
//       );
//       if (!res.ok) throw new Error(`HTTP ${res.status}`);
//       const json = await res.json().catch(() => []);
//       const trendWords = JSON.stringify(json).toLowerCase();
//       const matched = trendWords.match(
//         /(quiet luxury|monochrome|minimalism|maximalism|italian|tailoring|loafers|neutrals|linen|structured|preppy|flannel|earth tones|autumn layering)/gi,
//       );
//       if (matched?.length) return Array.from(new Set(matched));

//       // 🧭 If Google Trends returned empty, use local backup
//       return [
//         'quiet luxury',
//         'neutral tones',
//         'tailored fit',
//         'autumn layering',
//       ];
//     } catch (err: any) {
//       console.warn('⚠️ Trend fetch fallback triggered:', err.message);
//       return [
//         'quiet luxury',
//         'neutral tones',
//         'tailored fit',
//         'autumn layering',
//       ];
//     }
//   }

//   // RECREATE//////////////
//   async recreate(
//     user_id: string,
//     tags: string[],
//     image_url?: string,
//     user_gender?: string,
//   ) {
//     console.log(
//       '🧥 [AI] recreate() called for user',
//       user_id,
//       'with tags:',
//       tags,
//       'and gender:',
//       user_gender,
//     );

//     if (!user_id) throw new Error('Missing user_id');
//     if (!tags?.length) {
//       console.warn('⚠️ [AI] recreate() empty tags → using defaults.');
//       tags = ['modern', 'neutral', 'tailored'];
//     }

//     // ✅ Weighted + trend-injected tags
//     tags = await this.enrichTags(tags);

//     // 🧠 Fetch gender_presentation if missing
//     if (!user_gender) {
//       try {
//         const result = await pool.query(
//           'SELECT gender_presentation FROM users WHERE id = $1 LIMIT 1',
//           [user_id],
//         );
//         user_gender = result.rows[0]?.gender_presentation || 'neutral';
//       } catch {
//         user_gender = 'neutral';
//       }
//     }

//     // 🧩 Normalize gender
//     const normalizedGender =
//       user_gender?.toLowerCase().includes('female') ||
//       user_gender?.toLowerCase().includes('woman')
//         ? 'female'
//         : user_gender?.toLowerCase().includes('male') ||
//             user_gender?.toLowerCase().includes('man')
//           ? 'male'
//           : process.env.DEFAULT_GENDER || 'neutral';

//     // 🧠 Build stylist prompt (base)
//     let prompt = `
//         You are a world-class AI stylist for ${normalizedGender} fashion.
//         Create a cohesive outfit inspired by an uploaded look.

//         Client: ${user_id}
//         Image: ${image_url || 'N/A'}
//         Detected tags: ${tags.join(', ')}

//         Rules:
//         - Match fabric, color palette, and silhouette.
//         - Use ${normalizedGender}-appropriate pieces.
//         - Output only JSON:
//         {
//           "outfit": [
//             { "category": "Top", "item": "Grey Cotton Tee", "color": "gray" },
//             { "category": "Bottom", "item": "Navy Chinos", "color": "navy" },
//             { "category": "Outerwear", "item": "Beige Overshirt", "color": "beige" },
//             { "category": "Shoes", "item": "White Sneakers", "color": "white" }
//           ],
//           "style_note": "Describe how the look connects to the uploaded image."
//         }
//         `;

//     // 🔹 Pull soft profile context (optional)
//     let profileCtx = '';
//     try {
//       const res = await pool.query(
//         `SELECT favorite_colors, fit_preferences, preferred_brands, disliked_styles
//        FROM style_profiles WHERE user_id::text = $1 LIMIT 1`,
//         [user_id],
//       );
//       const prof = res.rows[0];
//       if (prof) {
//         profileCtx = `
//       # USER STYLE CONTEXT (soft influence)
//       • Preferred colors: ${(prof.favorite_colors || []).join(', ') || '—'}
//       • Fit preferences: ${(prof.fit_preferences || []).join(', ') || '—'}
//       • Favorite brands: ${(prof.preferred_brands || []).join(', ') || '—'}
//       • Disliked styles: ${prof.disliked_styles || '—'}
//       Do NOT override the image’s vibe — just bias tone/material choices if relevant.
//       `;
//       }
//     } catch {
//       /* silent fail */
//     }

//     // ✅ Final prompt (merge only if context exists)
//     // Inside recreate() or personalizedShop() final prompt:
//     const finalPrompt = `
// ${prompt}

// # HARD RULES
// - ALWAYS output a full outfit of at least 4–6 distinct pieces.
// - Include a Top, Bottom, Outerwear (if seasonally appropriate), Shoes, and optionally 1–2 Accessories.
// - NEVER omit items because they already exist in the user’s wardrobe.
// - Each piece should have its own JSON object, even if similar to a wardrobe item.
// - Always include color and fit for every item.
// `;

//     // 🧠 Generate outfit via Vertex or OpenAI
//     let parsed: any;
//     if (this.useVertex && this.vertexService) {
//       try {
//         const result =
//           await this.vertexService.generateReasonedOutfit(finalPrompt);
//         let text = result?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
//         text = text
//           .replace(/^```json\s*/i, '')
//           .replace(/```$/, '')
//           .trim();
//         parsed = JSON.parse(text);
//         console.log('🧠 [Vertex] recreate() success');
//       } catch (err: any) {
//         console.warn('[Vertex] recreate() failed → fallback', err.message);
//       }
//     }

//     if (!parsed) {
//       const completion = await this.openai.chat.completions.create({
//         model: 'gpt-4o-mini',
//         temperature: 0.7,
//         messages: [{ role: 'user', content: finalPrompt }],
//         response_format: { type: 'json_object' },
//       });

//       const raw = completion.choices[0]?.message?.content || '{}';
//       try {
//         parsed = JSON.parse(raw);
//       } catch {
//         parsed = {};
//       }
//     }

//     const outfit = Array.isArray(parsed?.outfit) ? parsed.outfit : [];
//     const style_note =
//       parsed?.style_note || 'Modern outfit inspired by the uploaded look.';

//     // 🛍️ Enrich each item with live products
//     const enriched = await Promise.all(
//       outfit.map(async (o: any) => {
//         const query =
//           `${normalizedGender} ${o.item || o.category || ''} ${o.color || ''}`.trim();
//         let products = await this.productSearch.search(query);
//         let top = products[0];

//         if (!top?.image || top.image.includes('No_image')) {
//           const serp = await this.productSearch.searchSerpApi(query);
//           if (serp?.[0]) top = { ...serp[0], source: 'SerpAPI' };
//         }

//         const materialHint =
//           query.match(/(wool|cotton|linen|leather|denim|polyester)/i)?.[0] ||
//           null;
//         const seasonalityHint =
//           query.match(/(summer|winter|fall|spring)/i)?.[0] ||
//           getCurrentSeason();
//         const fitHint =
//           query.match(/(slim|regular|relaxed|oversized|tailored)/i)?.[0] ||
//           'regular';

//         return {
//           category: o.category,
//           item: o.item,
//           color: o.color,
//           brand: top?.brand || 'Unknown',
//           price: top?.price || '—',
//           image:
//             top?.image && top.image.startsWith('http')
//               ? top.image
//               : 'https://upload.wikimedia.org/wikipedia/commons/a/ac/No_image_available.svg',
//           shopUrl:
//             top?.shopUrl ||
//             `https://www.google.com/search?q=${encodeURIComponent(query)}&tbm=shop`,
//           source: top?.source || 'ASOS / Fallback',
//           material: materialHint,
//           seasonality: seasonalityHint,
//           fit: fitHint,
//         };
//       }),
//     );

//     return { user_id, outfit: enriched, style_note };
//   }

//   // 🧩 Ensure every product object includes a usable image URL
//   private fixProductImages(products: any[] = []): any[] {
//     return products.map((prod) => ({
//       ...prod,
//       image:
//         prod.image ||
//         prod.image_url ||
//         prod.thumbnail ||
//         prod.serpapi_thumbnail || // ✅ added
//         prod.img ||
//         prod.picture ||
//         prod.thumbnail_url ||
//         'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg',
//     }));
//   }

//   // 👔 PERSONALIZED SHOP — image + wardrobe + preferences
//   async personalizedShop(
//     user_id: string,
//     image_url: string,
//     user_gender?: string,
//   ) {
//     if (!user_id || !image_url) throw new Error('Missing user_id or image_url');

//     /** -----------------------------------------------------------
//      * 🧠 buildProfileConstraints(profile)
//      * Converts full style_profiles record into explicit hard rules
//      * ---------------------------------------------------------- */
//     function buildProfileConstraints(profile: any): string {
//       if (!profile) return '';

//       const fit = Array.isArray(profile.fit_preferences)
//         ? profile.fit_preferences.join(', ')
//         : profile.fit_preferences;

//       const colors = Array.isArray(profile.favorite_colors)
//         ? profile.favorite_colors.join(', ')
//         : profile.favorite_colors;

//       const brands = Array.isArray(profile.preferred_brands)
//         ? profile.preferred_brands.join(', ')
//         : profile.preferred_brands;

//       const styles = [
//         ...(profile.style_keywords || []),
//         ...(profile.style_preferences || []),
//       ]
//         .filter(Boolean)
//         .join(', ');

//       const dislikes =
//         typeof profile.disliked_styles === 'string'
//           ? profile.disliked_styles
//           : (profile.disliked_styles || []).join(', ');

//       const climate = profile.climate || 'Temperate';
//       const goals = profile.goals || '';

//       // 🔹 Inject explicit hard “only color” or “except color” rule for the model itself
//       let colorRule = '';
//       if (profile.disliked_styles?.match(/only\s+(\w+)/i)) {
//         const onlyColor = profile.disliked_styles.match(/only\s+(\w+)/i)[1];
//         colorRule = `• Use ONLY ${onlyColor} items — all other colors are forbidden.`;
//       } else if (profile.disliked_styles?.match(/except\s+(\w+)/i)) {
//         const exceptColor = profile.disliked_styles.match(/except\s+(\w+)/i)[1];
//         colorRule = `• Exclude every color except ${exceptColor}.`;
//       }

//       // 🔹 Explicitly enforce fit preferences
//       let fitRule = '';
//       if (profile.fit_preferences?.length) {
//         fitRule = `• Allow ONLY these fits: ${profile.fit_preferences.join(
//           ', ',
//         )}; exclude all others.`;
//       }

//       return `
// # USER PROFILE CONSTRAINTS (Hard Rules)

// ${fitRule}
// ${colorRule}

// • Fit: ${fit || 'Regular fit'} — outfit items must match this silhouette; exclude all opposing fits.
// • Climate: ${climate} — use materials and layers appropriate to this temperature zone.
// • Preferred brands: ${brands || '—'} — bias all product searches toward these or comparable aesthetics.
// • Favorite colors: ${colors || '—'} — bias color palette to these tones; avoid disliked colors.
// • Disliked styles: ${dislikes || '—'} — exclude these aesthetics entirely.
// • Style & vibe keywords: ${styles || '—'} — reflect these qualities in overall tone and accessories.
// • Goals: ${goals}
// • Body & proportions: ${profile.body_type || '—'}, ${
//         profile.proportions || '—'
//       } — ensure silhouette and layering suit these proportions.
// • Skin tone / hair / eyes: ${profile.skin_tone || '—'}, ${
//         profile.hair_color || '—'
//       }, ${profile.eye_color || '—'} — choose tones that complement.
// `;
//     }

//     // 1) Analyze uploaded image
//     const analysis = await this.analyze(image_url);
//     const tags = analysis?.tags || [];

//     //   const { rows: wardrobe } = await pool.query(
//     //     `SELECT name, main_category AS category, subcategory, color, material
//     //  FROM wardrobe_items
//     //  WHERE user_id::text = $1
//     //  ORDER BY updated_at DESC
//     //  LIMIT 50`,
//     //     [user_id],
//     //   );

//     // 🚫 Skip wardrobe entirely for personalized mode
//     const wardrobe: any[] = [];

//     const prefRes = await pool.query(
//       `SELECT gender_presentation
//      FROM users
//      WHERE id = $1
//      LIMIT 1`,
//       [user_id],
//     );
//     const profile = prefRes.rows[0] || {};
//     const gender = user_gender || profile.gender_presentation || 'neutral';
//     // 2️⃣ Fetch user style profile (full data used for personalization)
//     const styleProfileRes = await pool.query(
//       `
//   SELECT
//     body_type,
//     skin_tone,
//     undertone,
//     climate,
//     favorite_colors,
//     disliked_styles,
//     style_keywords,
//     preferred_brands,
//     goals,
//     proportions,
//     hair_color,
//     eye_color,
//     height,
//     waist,
//     fit_preferences,
//     style_preferences
//   FROM style_profiles
//   WHERE user_id::text = $1
//   LIMIT 1
// `,
//       [user_id],
//     );

//     const styleProfile = styleProfileRes.rows[0] || {};

//     // 🔹 Build user filter preferences
//     const { preferFit, bannedWords } = buildUserFilter(styleProfile);

//     /* ------------------------------------------------------------
//    🎛️ VISUAL + STYLE FILTERING HELPERS
// -------------------------------------------------------------*/
//     const FIT_KEYWORDS = {
//       skinny: [/skinny/i, /super[- ]skinny/i, /spray[- ]on/i],
//       slim: [/slim/i],
//       tailored: [/tailored/i, /tapered/i],
//       relaxed: [/relaxed/i, /loose/i, /baggy/i, /wide[- ]leg/i],
//       oversized: [/oversized/i, /boxy/i],
//     };

//     function buildUserFilter(profile: any) {
//       const fitPrefs = (profile.fit_preferences || []).map((x: string) =>
//         x.toLowerCase(),
//       );
//       const disliked = (profile.disliked_styles || '')
//         .toLowerCase()
//         .split(/[,\s]+/)
//         .filter(Boolean);
//       const favColors = (profile.favorite_colors || []).map((x: string) =>
//         x.toLowerCase(),
//       );

//       const preferFit =
//         fitPrefs.find((f) => /(relaxed|loose|baggy|oversized|boxy)/.test(f)) ||
//         fitPrefs.find((f) => /(regular|tailored)/.test(f)) ||
//         fitPrefs[0] ||
//         null;

//       const banFits: string[] = [];
//       if (preferFit?.match(/relaxed|loose|baggy|oversized|boxy/))
//         banFits.push('skinny', 'slim');
//       else if (preferFit?.match(/skinny|slim/))
//         banFits.push('relaxed', 'baggy', 'oversized');

//       const bannedWords = [
//         ...disliked,
//         ...banFits,
//         ...(!favColors.includes('green') ? ['green'] : []),
//       ]
//         .filter(Boolean)
//         .map((x) => new RegExp(x, 'i'));

//       return { preferFit, bannedWords };
//     }

//     function enforceProfileFilters(
//       products: any[] = [],
//       preferFit?: string | null,
//       bannedWords: RegExp[] = [],
//     ) {
//       if (!products.length) return products;

//       return products
//         .filter((p) => {
//           const hay = `${p.title || ''} ${p.name || ''} ${p.description || ''}`;
//           return !bannedWords.some((rx) => rx.test(hay));
//         })
//         .sort((a, b) => {
//           if (!preferFit) return 0;
//           const aHit = FIT_KEYWORDS[preferFit]?.some((rx) =>
//             rx.test(`${a.title} ${a.name}`),
//           )
//             ? 1
//             : 0;
//           const bHit = FIT_KEYWORDS[preferFit]?.some((rx) =>
//             rx.test(`${b.title} ${b.name}`),
//           )
//             ? 1
//             : 0;
//           return bHit - aHit; // boost preferred fits
//         });
//     }

//     // 3) Ask model to split into "owned" vs "missing"

//     const climateNote = styleProfile.climate
//       ? `The user's climate is ${styleProfile.climate}.
//     If it is cold (like Polar or Cold), emphasize insulated materials, coats, layers, scarves, gloves, and boots.
//     If it is hot (like Tropical or Desert), emphasize breathable, lightweight fabrics and open footwear.`
//       : '';

//     // 🛍️ SHOPPING ASSISTANT: Fetch detailed wardrobe items for specific gap analysis
//     let wardrobeItems = [];
//     try {
//       const result = await pool.query(
//         `SELECT name, main_category, subcategory, color, material
//          FROM wardrobe_items
//          WHERE user_id::text = $1
//          ORDER BY main_category, updated_at DESC
//          LIMIT 200`,
//         [user_id],
//       );
//       wardrobeItems = result.rows || [];
//       console.log(
//         '🛍️ [personalizedShop] Wardrobe query executed:',
//         wardrobeItems.length,
//         'items found',
//       );
//     } catch (err) {
//       console.error('🛍️ [personalizedShop] ERROR fetching wardrobe:', err);
//       wardrobeItems = [];
//     }

//     // 🛍️ Build detailed wardrobe inventory with actual item names
//     const wardrobeByCategory = wardrobeItems.reduce((acc: any, item: any) => {
//       const category = item.main_category || 'Other';
//       if (!acc[category]) acc[category] = [];
//       acc[category].push({
//         name: item.name,
//         color: item.color,
//         material: item.material,
//         subcategory: item.subcategory,
//       });
//       return acc;
//     }, {});

//     // 🛍️ Format detailed inventory: show actual items user owns
//     const detailedInventory = Object.entries(wardrobeByCategory)
//       .map(([category, items]: [string, any]) => {
//         const itemList = items
//           .slice(0, 10) // Show top 10 items per category
//           .map((i: any) => `${i.name}${i.color ? ` (${i.color})` : ''}`)
//           .join(', ');
//         const moreCount =
//           items.length > 10 ? ` +${items.length - 10} more` : '';
//         return `• **${category}**: ${itemList}${moreCount}`;
//       })
//       .join('\n');

//     // 🛍️ Count by category to identify major gaps
//     const categoryStats = Object.entries(wardrobeByCategory)
//       .map(([cat, items]: [string, any]) => `${cat} (${items.length})`)
//       .join(', ');

//     const wardrobeContext = `# CRITICAL: SPECIFIC, PERSONALIZED RECOMMENDATIONS ONLY
// NEVER make generic suggestions. ALWAYS be specific about WHY each item is needed.

// ${
//   wardrobeItems.length > 0
//     ? `## USER'S EXISTING WARDROBE - SPECIFIC ITEMS & QUANTITIES
// Category totals: ${categoryStats}

// Actual items owned:
// ${detailedInventory}

// REFERENCE ACTUAL ITEMS: Name specific pieces from their wardrobe in your reasons.`
//     : `## NO WARDROBE DATA AVAILABLE YET
// The user has not yet added items to their wardrobe. STILL be specific by:
// - Referencing the uploaded image aesthetic
// - Referencing their stated style preferences and goals
// - Suggesting items that fill SPECIFIC functional gaps (e.g., "You have no layering pieces")
// - Being explicit about COLOR, MATERIAL, and FIT choices`
// }

// ## MANDATORY SPECIFICITY RULES FOR ALL RECOMMENDATIONS:
// 1. EVERY recommendation MUST state WHY it's needed (avoid generic words like "elevates" or "completes")
//    ✓ GOOD: "Adds neutral bottoms in cotton - all your existing pieces are dark structured items"
//    ✓ GOOD: "For layering in moderate weather - fills temperature transition gap"
//    ✗ BAD: "Elevates your wardrobe"
//    ✗ BAD: "Completes your basics"

// 2. REFERENCE THE UPLOADED IMAGE in your reasoning:
//    ✓ "Complements the [specific color/style] aesthetic from your image"
//    ✓ "Works with the [silhouette] style you showed interest in"

// 3. BE SPECIFIC ABOUT USE CASE:
//    ✓ "For [occasion/weather/activity]"
//    ✓ "Pairs with [type of items most people own]"
//    ✗ "Just adds to your collection"

// 4. MENTION SPECIFIC COLORS/MATERIALS/FIT:
//    ✓ "Adds [specific color] in [material] which [specific reason]"
//    ✓ "Camel-toned [fit] [garment] for [climate/use]"

// ## EXAMPLE GOOD REASONS:
// - "Neutral base layer in cream linen for the minimalist aesthetic you showed"
// - "Adds breathable layering piece in cotton for warm weather - pairs with your smart-casual style"
// - "Complements the crisp formal vibe of your image; adds structured elegance"
// - "Provides casual footwear in canvas - versatile neutral that works with most styles"`;

//     // 🔒 Enforced personalization hierarchy
//     const rules = `
//     # PERSONALIZATION ENFORCEMENT
//     Follow these user preferences as *absolute constraints*, not suggestions.
//     `;

//     const profileConstraints = buildProfileConstraints(styleProfile);

//     const prompt = `
// You are a world-class personal stylist analyzing user's wardrobe gaps and recommending strategic purchases.
// ${rules}
// ${profileConstraints}

// # IMAGE INSPIRATION
// • Use the uploaded image as inspiration for aesthetic direction (color story, silhouette, vibe).
// • Respect all style profile constraints exactly.
// • Maintain the same mood and spirit as the uploaded image.

// ${wardrobeContext}

// # STRATEGIC SHOPPING RECOMMENDATIONS - MUST BE SPECIFIC
// For EACH recommendation, you MUST:
// 1. Reference 2-3 actual items from their wardrobe by NAME (e.g., "pairs with the gray cardigans")
// 2. State the SPECIFIC GAP you're filling (e.g., "you have 12 tops but only 3 bottoms")
// 3. Name the CATEGORY imbalance (e.g., "all your pants are dark - this adds a neutral option")
// 4. Explain what they'll USE it WITH (e.g., "complements your existing navy blazer collection")

// CRITICAL: NO VAGUE REASONS. These are REQUIRED:
// ❌ WRONG: "Elevates your wardrobe"
// ✅ RIGHT: "Works with your navy blazers and black pants; adds the warm-toned bottom option you lack"

// ❌ WRONG: "Completes your basics"
// ✅ RIGHT: "You own 8 tops (grays, blacks, white) but only 2 bottoms - this adds jean variety"

// ❌ WRONG: "Fills a style gap"
// ✅ RIGHT: "Your wardrobe is mostly structured pieces (blazers, cardigans) - this adds the relaxed layer you need"

// # OUTPUT RULES
// - ALWAYS output a complete outfit with distinct Top, Bottom, Shoes, and (if seasonally appropriate) Outerwear and Accessories.
// - Each piece must include category, item, color, fit, and a SPECIFIC reason
// - suggested_purchases reasons MUST name actual wardrobe items and specific gaps
// - gap_analysis must list 2-3 concrete imbalances found in their wardrobe

// Return ONLY valid JSON:
// {
//   "recreated_outfit": [
//     { "source":"purchase", "category":"Top", "item":"...", "color":"...", "fit":"..." }
//   ],
//   "suggested_purchases": [
//     { "category":"...", "item":"...", "color":"...", "material":"...", "brand":"...", "fit":"...", "reason":"Why this fills a gap or completes their style", "shopUrl":"..." }
//   ],
//   "style_note": "Explain the gap analysis, what's missing from their wardrobe, and how these purchases strengthen their styling foundation.",
//   "gap_analysis": "Concise summary of 2-3 key wardrobe gaps being addressed"
// }

// User gender: ${gender}
// Detected tags (inspiration from uploaded look): ${tags.join(', ')}
// User style profile: ${JSON.stringify(styleProfile, null, 2)}
// ${climateNote}
// `;

//     console.log('🧥 [personalizedShop] profile:', profile);
//     console.log('🧥 [personalizedShop] gender:', gender);
//     console.log('🧥 [personalizedShop] styleProfile:', styleProfile);
//     console.log('🛍️ [personalizedShop] WARDROBE DATA SENT TO AI:');
//     console.log('   Category totals:', categoryStats);
//     console.log('   Items found:', wardrobeItems.length);
//     if (wardrobeItems.length > 0) {
//       console.log(
//         '   Sample items:',
//         wardrobeItems
//           .slice(0, 5)
//           .map((w: any) => `${w.name} (${w.color})`)
//           .join(', '),
//       );
//     }
//     console.log('🧠 [personalizedShop] Prompt preview:', prompt.slice(0, 800));

//     // 🧠 DEBUG START — prompt verification
//     console.log('─────────────── PROMPT SENT TO MODEL ───────────────');
//     console.log(prompt);
//     console.log('─────────────── END PROMPT ───────────────');

//     const completion = await this.openai.chat.completions.create({
//       model: 'gpt-4o-mini',
//       temperature: 0.7,
//       messages: [{ role: 'user', content: prompt }],
//       response_format: { type: 'json_object' },
//     });

//     // 🧠 DEBUG END — raw model output
//     console.log('─────────────── RAW MODEL RESPONSE ───────────────');
//     console.log(completion.choices[0]?.message?.content);
//     console.log('─────────────── END RESPONSE ───────────────');

//     let parsed: any = {};
//     try {
//       parsed = JSON.parse(completion.choices[0]?.message?.content || '{}');

//       // 🧩 SAFETY GUARD — ensure we keep valid recreated_outfit
//       try {
//         const parsedKeys = Object.keys(parsed);
//         console.log('✅ [personalizedShop] Parsed JSON keys:', parsedKeys);

//         // If model used "outfit" instead of "recreated_outfit", normalize it
//         if (!parsed.recreated_outfit && parsed.outfit) {
//           parsed.recreated_outfit = parsed.outfit;
//           console.log('✅ [personalizedShop] Mapped outfit → recreated_outfit');
//         }

//         // Double-check array validity before fallback clears it
//         if (parsed.recreated_outfit && parsed.recreated_outfit.length > 0) {
//           console.log(
//             '✅ [personalizedShop] Using recreated_outfit from model',
//           );
//         } else {
//           console.warn(
//             '⚠️ [personalizedShop] No recreated_outfit found — fallback may trigger',
//           );
//         }
//       } catch (err) {
//         console.error(
//           '❌ [personalizedShop] JSON structure guard failed:',
//           err,
//         );
//       }

//       // ✅ Final filter fix — keep wardrobe items but still respect banned fits/styles
//       if (parsed?.recreated_outfit?.length) {
//         parsed.recreated_outfit = parsed.recreated_outfit.filter((o: any) => {
//           if (!o) return false;
//           const text =
//             `${o.item} ${o.category} ${o.color} ${o.fit}`.toLowerCase();
//           if (!text.trim() || text.includes('undefined')) return false;
//           // ✅ Always keep wardrobe items regardless of style bans
//           if (o.source === 'wardrobe') return true;

//           const fitBan = preferFit?.match(/relaxed|oversized|boxy|loose/)
//             ? ['skinny']
//             : preferFit?.match(/skinny|slim|tailored/)
//               ? ['relaxed', 'baggy', 'oversized']
//               : [];

//           const styleBan =
//             (styleProfile.disliked_styles || '')
//               .toLowerCase()
//               .split(/[,\s]+/)
//               .filter(Boolean) || [];

//           const banned = [...fitBan, ...styleBan];
//           return !banned.some((b) => text.includes(b));
//         });

//         console.log(
//           '✅ [personalizedShop] Final filtered outfit →',
//           parsed.recreated_outfit,
//         );
//       }

//       console.log(
//         '💎 [personalizedShop] Parsed recreated outfit sample:',
//         parsed?.recreated_outfit?.slice(0, 2),
//       );
//       console.log(
//         '💎 [personalizedShop] Parsed suggested purchases sample:',
//         parsed?.suggested_purchases?.slice(0, 2),
//       );

//       // 🧩 Merge recreated_outfit into suggested_purchases for display
//       if (
//         Array.isArray(parsed?.recreated_outfit) &&
//         parsed.recreated_outfit.length
//       ) {
//         parsed.suggested_purchases = [
//           ...(parsed.suggested_purchases || []),
//           ...parsed.recreated_outfit.map((o: any) => ({
//             ...o,
//             brand: o.brand || '—',
//             previewImage: o.previewImage || o.image || o.image_url || null,
//             source: 'purchase',
//           })),
//         ];
//         console.log(
//           '🧩 [personalizedShop] merged recreated_outfit → suggested_purchases',
//         );
//       }

//       // 🖼️ Ensure every recreated outfit item has a visible preview image
//       if (Array.isArray(parsed?.recreated_outfit)) {
//         parsed.recreated_outfit = parsed.recreated_outfit.map((item: any) => {
//           if (!item.previewImage && item.source === 'wardrobe') {
//             item.previewImage =
//               item.image_url ||
//               item.wardrobe_image ||
//               'https://upload.wikimedia.org/wikipedia/commons/a/ac/No_image_available.svg';
//           }
//           return item;
//         });
//       }

//       // 🎨 Enforce "only <color>" rule from disliked_styles (e.g. "I dislike all colors except pink")
//       // 🎨 Optional color-only enforcement — only if explicit "ONLY <color>" flag exists
//       if (styleProfile?.disliked_styles?.toLowerCase().includes('only')) {
//         const match = styleProfile.disliked_styles.match(/only\s+(\w+)/i);
//         if (match) {
//           const onlyColor = match[1].toLowerCase();
//           const filterColor = (arr: any[]) =>
//             arr.filter((x) =>
//               (x.color || '').toLowerCase().includes(onlyColor),
//             );

//           if (Array.isArray(parsed?.recreated_outfit))
//             parsed.recreated_outfit = filterColor(parsed.recreated_outfit);
//           if (Array.isArray(parsed?.suggested_purchases))
//             parsed.suggested_purchases = filterColor(
//               parsed.suggested_purchases,
//             );

//           console.log(
//             `[personalizedShop] 🎨 Enforcing ONLY-color rule: ${onlyColor}`,
//           );
//         }
//       }
//     } catch {
//       parsed = {};
//     }

//     const purchases = Array.isArray(parsed?.suggested_purchases)
//       ? parsed.suggested_purchases
//       : [];

//     if (parsed?.recreated_outfit?.some((i: any) => i.source === 'wardrobe')) {
//       console.log('🧥 [personalizedShop] ✅ Model reused wardrobe pieces.');
//     } else {
//       console.warn(
//         '🧥 [personalizedShop] ⚠️ Model did NOT reuse wardrobe — fallback to generic recreation.',
//       );
//     }

//     // 🚫 Enforce profile bans in returned outfit
//     const banned = [
//       ...(styleProfile.disliked_styles?.toLowerCase().split(/[,\s]+/) || []),
//       ...(preferFit?.match(/relaxed|oversized|boxy|loose/)
//         ? ['skinny', 'slim']
//         : []),
//       ...(preferFit?.match(/skinny|slim/)
//         ? ['relaxed', 'oversized', 'baggy']
//         : []),
//     ].filter(Boolean);

//     if (parsed?.recreated_outfit?.length) {
//       // ✅ Keep *all* wardrobe and purchase items — only filter garbage entries
//       parsed.recreated_outfit = parsed.recreated_outfit.filter((o: any) => {
//         if (!o || !o.item) return false;
//         const text =
//           `${o.item} ${o.category} ${o.color} ${o.fit}`.toLowerCase();
//         return text.trim().length > 0 && !text.includes('undefined');
//       });

//       // 🧱 Guarantee full outfit completeness (Top, Bottom, Shoes, Optional Outerwear/Accessory)
//       const categories = parsed.recreated_outfit.map((o: any) =>
//         o.category?.toLowerCase(),
//       );
//       const missing: any[] = [];

//       if (!categories.includes('top'))
//         missing.push({
//           source: 'purchase',
//           category: 'Top',
//           item: 'White Oxford Shirt',
//           color: 'White',
//           fit: 'Slim Fit',
//         });
//       if (!categories.includes('bottoms'))
//         missing.push({
//           source: 'purchase',
//           category: 'Bottoms',
//           item: 'Beige Chinos',
//           color: 'Beige',
//           fit: 'Slim Fit',
//         });
//       if (!categories.includes('shoes'))
//         missing.push({
//           source: 'purchase',
//           category: 'Shoes',
//           item: 'White Leather Sneakers',
//           color: 'White',
//           fit: 'Slim Fit',
//         });

//       parsed.recreated_outfit.push(...missing);

//       console.log(
//         '✅ [personalizedShop] Final full outfit →',
//         parsed.recreated_outfit,
//       );
//     }

//     // 🧩 Centralized enforcement for personalizedShop only
//     function applyProfileFilters(products: any[], profile: any) {
//       if (!Array.isArray(products) || !products.length) return [];

//       const favColors = (profile.favorite_colors || []).map((x: string) =>
//         x.toLowerCase(),
//       );
//       const prefBrands = (profile.preferred_brands || []).map((x: string) =>
//         x.toLowerCase(),
//       );
//       const fitPrefs = (profile.fit_preferences || []).map((x: string) =>
//         x.toLowerCase(),
//       );
//       const dislikes = (profile.disliked_styles || '')
//         .toLowerCase()
//         .split(/[,\s]+/);
//       const climate = (profile.climate || '').toLowerCase();

//       const isCold = /(polar|cold|arctic|tundra|winter)/.test(climate);
//       const isHot = /(tropical|desert|hot|humid|summer)/.test(climate);

//       // 🩷 detect "only" or "except" color rule from disliked_styles
//       let onlyColor: string | null = null;
//       let exceptColor: string | null = null;

//       if (profile.disliked_styles?.match(/only\s+(\w+)/i)) {
//         onlyColor = profile.disliked_styles
//           .match(/only\s+(\w+)/i)[1]
//           .toLowerCase();
//       } else if (profile.disliked_styles?.match(/except\s+(\w+)/i)) {
//         exceptColor = profile.disliked_styles
//           .match(/except\s+(\w+)/i)[1]
//           .toLowerCase();
//       }

//       return products
//         .filter((p) => {
//           const t = `${p.name ?? ''} ${p.title ?? ''} ${p.brand ?? ''} ${
//             p.description ?? ''
//           } ${p.color ?? ''} ${p.fit ?? ''}`.toLowerCase();

//           // 🚫 Filter out disliked words/styles
//           if (dislikes.some((d) => d && t.includes(d))) return false;

//           // 🎨 HARD color enforcement from DB rules
//           if (onlyColor) {
//             // Only allow if text or color includes the specified color
//             if (
//               !t.includes(onlyColor) &&
//               !p.color?.toLowerCase().includes(onlyColor)
//             )
//               return false;
//           } else if (exceptColor) {
//             // Exclude everything not matching that color
//             if (
//               !t.includes(exceptColor) &&
//               !p.color?.toLowerCase().includes(exceptColor)
//             )
//               return false;
//           } else {
//             // Normal favorite color bias if no hard rule
//             if (favColors.length && !favColors.some((c) => t.includes(c)))
//               return false;
//           }

//           // 👕 Fit preferences
//           if (fitPrefs.length && !fitPrefs.some((f) => t.includes(f)))
//             return false;

//           // 🌡️ Climate-based filtering
//           if (isCold && /(tank|shorts|sandal)/.test(t)) return false;
//           if (isHot && /(wool|parka|coat|boot|knit)/.test(t)) return false;

//           return true;
//         })
//         .sort((a, b) => {
//           const score = (x: any) => {
//             const txt =
//               `${x.name} ${x.title} ${x.brand} ${x.color} ${x.fit}`.toLowerCase();
//             let s = 0;
//             if (onlyColor && txt.includes(onlyColor)) s += 4;
//             if (exceptColor && txt.includes(exceptColor)) s += 4;
//             if (favColors.some((c) => txt.includes(c))) s += 2;
//             if (prefBrands.some((b) => txt.includes(b))) s += 2;
//             if (fitPrefs.some((f) => txt.includes(f))) s += 1;
//             return s;
//           };
//           return score(b) - score(a);
//         });
//     }

//     // 4️⃣ Attach live shop links to the "missing" items — now honoring user taste
//     let enrichedPurchases = await Promise.all(
//       purchases.map(async (p: any) => {
//         // 🧠 Gender-locked prefix
//         const genderPrefix =
//           gender?.toLowerCase().includes('female') ||
//           gender?.toLowerCase().includes('woman')
//             ? 'women female womens ladies'
//             : 'men male mens masculine -women -womens -female -girls -ladies';

//         // Base query with gender lock
//         let q = [
//           genderPrefix,
//           p.item || p.category || '',
//           p.color || '',
//           p.material || '',
//         ]
//           .filter(Boolean)
//           .join(' ')
//           .trim();

//         // 🔹 Inject personalization bias terms
//         const brandTerms = (styleProfile.preferred_brands || [])
//           .slice(0, 3)
//           .join(' ');
//         const colorTerms = (styleProfile.favorite_colors || [])
//           .slice(0, 2)
//           .join(' ');
//         const fitTerms = Array.isArray(styleProfile.fit_preferences)
//           ? styleProfile.fit_preferences.join(' ')
//           : styleProfile.fit_preferences || '';

//         // 🎨 “Only color” rule (e.g. “I dislike all colors except pink”)
//         const colorMatch =
//           styleProfile.disliked_styles?.match(/except\s+(\w+)/i);
//         if (colorMatch) {
//           const onlyColor = colorMatch[1].toLowerCase();
//           q += ` ${onlyColor}`;
//         }

//         // Combine into final query with brand + color + fit bias
//         q = [q, brandTerms, colorTerms, fitTerms].filter(Boolean).join(' ');

//         // 🔒 Ensure all queries exclude female results explicitly
//         if (
//           !/-(women|female|ladies|girls)/i.test(q) &&
//           /\bmen\b|\bmale\b/i.test(q)
//         ) {
//           q += ' -women -womens -female -girls -ladies';
//         }

//         // Combine into final query with brand + color + fit bias
//         q = [q, brandTerms, colorTerms, fitTerms].filter(Boolean).join(' ');

//         // 🔒 Ensure all queries exclude female results explicitly
//         if (
//           !/-(women|female|ladies|girls)/i.test(q) &&
//           /\bmen\b|\bmale\b/i.test(q)
//         ) {
//           q += ' -women -womens -female -girls -ladies';
//         }

//         // 🧠 Gender-aware product search
//         let products = await this.productSearch.search(
//           q,
//           gender?.toLowerCase() === 'female'
//             ? 'female'
//             : gender?.toLowerCase() === 'male'
//               ? 'male'
//               : 'unisex',
//         );

//         // 🚫 Filter out any accidental female/unisex results
//         products = products.filter(
//           (prod) =>
//             !/women|female|womens|ladies|girls/i.test(
//               `${prod.name ?? ''} ${prod.brand ?? ''} ${prod.title ?? ''}`,
//             ),
//         );

//         // 🩷 Hard visual color filter — ensures displayed products actually match the enforced color rule
//         if (
//           styleProfile?.disliked_styles?.match(/only\s+(\w+)/i) ||
//           styleProfile?.disliked_styles?.match(/except\s+(\w+)/i)
//         ) {
//           const match =
//             styleProfile.disliked_styles.match(/only\s+(\w+)/i) ||
//             styleProfile.disliked_styles.match(/except\s+(\w+)/i);
//           const enforcedColor = match?.[1]?.toLowerCase();
//           if (enforcedColor) {
//             products = products.filter((p) => {
//               const text =
//                 `${p.name ?? ''} ${p.title ?? ''} ${p.color ?? ''}`.toLowerCase();
//               return text.includes(enforcedColor);
//             });
//           }
//         }

//         return {
//           ...p,
//           query: q,
//           products: applyProfileFilters(products, styleProfile),
//         };
//       }),
//     );

//     // 5️⃣ Fallback enrichment if AI returned nothing or products failed
//     if (!enrichedPurchases.length) {
//       console.warn(
//         '⚠️ [personalizedShop] Empty suggested_purchases → fallback.',
//       );

//       const tagSeed = tags.slice(0, 6).join(' ');
//       const season = getCurrentSeason();

//       // 🧠 Gender prefix for fallback with hard lock
//       const genderPrefix =
//         gender?.toLowerCase().includes('female') ||
//         gender?.toLowerCase().includes('woman')
//           ? 'women female womens ladies'
//           : 'men male mens masculine -women -womens -female -girls -ladies';

//       // 🧠 Enrich fallback with style taste as well
//       const brandTerms = (styleProfile.preferred_brands || [])
//         .slice(0, 3)
//         .join(' ');
//       const colorTerms = (styleProfile.favorite_colors || [])
//         .slice(0, 2)
//         .join(' ');
//       const fitTerms = Array.isArray(styleProfile.fit_preferences)
//         ? styleProfile.fit_preferences.join(' ')
//         : styleProfile.fit_preferences || '';

//       const fallbackQuery = `${genderPrefix} ${tagSeed} ${season} fashion ${brandTerms} ${colorTerms} ${fitTerms}`;
//       console.log('🧩 [personalizedShop] fallbackQuery →', fallbackQuery);

//       const products = await this.productSearch.search(
//         fallbackQuery,
//         gender?.toLowerCase() === 'female'
//           ? 'female'
//           : gender?.toLowerCase() === 'male'
//             ? 'male'
//             : 'unisex',
//       );

//       // 🚫 Filter out any accidental female/unisex results
//       const maleProducts = products.filter(
//         (prod) =>
//           !/women|female|womens|ladies|girls/i.test(
//             `${prod.name ?? ''} ${prod.brand ?? ''} ${prod.title ?? ''}`,
//           ),
//       );

//       enrichedPurchases = [
//         {
//           category: 'General',
//           item: 'Curated Outfit Add-Ons',
//           color: 'Mixed',
//           material: null,
//           products: applyProfileFilters(maleProducts.slice(0, 8), styleProfile),
//           query: fallbackQuery,
//           source: 'fallback',
//         },
//       ];
//     }

//     // 🎨 Enforce color-only rule on fallback products too
//     if (styleProfile?.disliked_styles) {
//       const match = styleProfile.disliked_styles.match(/except\s+(\w+)/i);
//       if (match) {
//         const onlyColor = match[1].toLowerCase();
//         enrichedPurchases = enrichedPurchases.map((p) => ({
//           ...p,
//           products: (p.products || []).filter((prod) =>
//             (prod.color || '').toLowerCase().includes(onlyColor),
//           ),
//         }));
//         console.log(
//           `[personalizedShop] 🎨 Enforced fallback color-only rule: ${onlyColor}`,
//         );
//       }
//     }

//     const cleanPurchases = enrichedPurchases.map((p) => ({
//       ...p,
//       products: this.fixProductImages(
//         enforceProfileFilters(p.products || [], preferFit, bannedWords),
//       ),
//     }));

//     // 🎨 FINAL VISUAL CONSISTENCY NORMALIZATION
//     const normalizedPurchases = await Promise.all(
//       enrichedPurchases.map(async (p) => {
//         const validProduct =
//           (p.products || []).find(
//             (x) =>
//               (x.image ||
//                 x.image_url ||
//                 x.thumbnail ||
//                 x.serpapi_thumbnail ||
//                 x.thumbnail_url ||
//                 x.img ||
//                 x.result?.thumbnail ||
//                 x.result?.serpapi_thumbnail) &&
//               /^https?:\/\//.test(
//                 x.image ||
//                   x.image_url ||
//                   x.thumbnail ||
//                   x.serpapi_thumbnail ||
//                   x.thumbnail_url ||
//                   x.img ||
//                   x.result?.thumbnail ||
//                   x.result?.serpapi_thumbnail ||
//                   '',
//               ) &&
//               !/no[_-]?image/i.test(
//                 x.image ||
//                   x.image_url ||
//                   x.thumbnail ||
//                   x.serpapi_thumbnail ||
//                   x.thumbnail_url ||
//                   x.img ||
//                   '',
//               ),
//           ) || p.products?.[0];

//         let previewImage =
//           validProduct?.image ||
//           validProduct?.image_url ||
//           validProduct?.thumbnail ||
//           validProduct?.serpapi_thumbnail ||
//           validProduct?.thumbnail_url ||
//           validProduct?.img ||
//           validProduct?.product_thumbnail ||
//           validProduct?.result?.thumbnail ||
//           validProduct?.result?.serpapi_thumbnail ||
//           null;

//         // 🎯 Gender-aware image guard
//         const userGender = (gender || '').toLowerCase();

//         if (previewImage) {
//           const url = previewImage.toLowerCase();

//           // 🧍‍♂️ If male → block clearly female-coded URLs
//           if (
//             userGender.includes('male') &&
//             /(women|woman|female|ladies|girls|womenswear|femme|skims|shein|fashionnova|princesspolly|revolve|anthropologie)/i.test(
//               url,
//             )
//           ) {
//             previewImage =
//               'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg';
//           }

//           // 🧍‍♀️ If female → block clearly male-coded URLs
//           else if (
//             userGender.includes('female') &&
//             /(men|man|male|menswear|masculine)/i.test(url)
//           ) {
//             previewImage =
//               'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg';
//           }

//           // 🧍 Unisex → allow all images
//         }

//         // 🧠 If still missing, do a quick SerpAPI lookup and cache
//         if (!previewImage && p.query) {
//           const results = await this.productSearch.searchSerpApi(p.query);
//           const r = results?.[0];
//           previewImage =
//             r?.image ||
//             r?.image_url ||
//             r?.thumbnail ||
//             r?.serpapi_thumbnail ||
//             r?.thumbnail_url ||
//             r?.result?.thumbnail ||
//             r?.result?.serpapi_thumbnail ||
//             null;

//           // 🎯 Apply same gender guard to SerpAPI result
//           if (previewImage) {
//             const url = previewImage.toLowerCase();

//             if (
//               userGender.includes('male') &&
//               /(women|woman|female|ladies|girls|womenswear|femme|skims|shein|fashionnova|princesspolly|revolve|anthropologie)/i.test(
//                 url,
//               )
//             ) {
//               previewImage =
//                 'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg';
//             } else if (
//               userGender.includes('female') &&
//               /(men|man|male|menswear|masculine)/i.test(url)
//             ) {
//               previewImage =
//                 'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg';
//             }
//           }
//         }

//         return {
//           ...p,
//           previewImage:
//             previewImage ||
//             'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg',
//           previewBrand: validProduct?.brand || p.brand || 'Unknown',
//           previewPrice: validProduct?.price || '—',
//           previewUrl: validProduct?.shopUrl || p.shopUrl || null,
//         };
//       }),
//     ); // ✅ ← closes Promise.all()

//     // 🧹 remove empty product groups (no valid images)
//     const filteredPurchases = normalizedPurchases.filter(
//       (p) => !!p.previewImage,
//     );

//     // 🧊 Climate sanity check — if Polar but outfit lacks insulation, patch style_note
//     if (
//       styleProfile.climate?.toLowerCase().includes('polar') &&
//       !/coat|jacket|parka|boot|knit|sweater/i.test(
//         JSON.stringify(parsed.recreated_outfit || []),
//       )
//     ) {
//       parsed.style_note +=
//         ' Reinforced with insulated outerwear and cold-weather layering for Polar climates.';
//     }

//     // 🚫 Prevent fallback or secondary recreate() from overwriting personalized flow
//     if (
//       enrichedPurchases?.length > 0 ||
//       parsed?.suggested_purchases?.length > 0
//     ) {
//       console.log(
//         '✅ [personalizedShop] Finalizing personalized results — skipping generic recreate()',
//       );
//       return {
//         user_id,
//         image_url,
//         tags,
//         recreated_outfit: parsed?.recreated_outfit || [],
//         suggested_purchases: normalizedPurchases,
//         style_note:
//           parsed?.style_note ||
//           'Personalized recreation based on your wardrobe, with curated seasonal add-ons.',
//         gap_analysis: parsed?.gap_analysis || null,
//         applied_filters: {
//           preferFit,
//           bannedWords: bannedWords.map((r) => r.source),
//         },
//       };
//     }

//     return {
//       user_id,
//       image_url,
//       tags,
//       recreated_outfit: parsed?.recreated_outfit || [],
//       suggested_purchases: normalizedPurchases,
//       style_note:
//         parsed?.style_note ||
//         'Personalized recreation based on your wardrobe, with curated seasonal add-ons.',
//       gap_analysis: parsed?.gap_analysis || null,
//       applied_filters: {
//         preferFit,
//         bannedWords: bannedWords.map((r) => r.source),
//       },
//     };
//   }

//   ////////END CREATE LOOK

//   //////. START REPLACED CHAT WITH LINKS AND SEARCH NET
//   async chat(dto: ChatDto) {
//     const { messages, user_id } = dto;
//     const lastUserMsg = messages
//       .slice()
//       .reverse()
//       .find((m) => m.role === 'user')?.content;

//     if (!lastUserMsg) {
//       throw new Error('No user message provided');
//     }

//     /* 🎯 --- SMART CONTEXT: Classify query to load only relevant data --- */
//     let contextNeeds = {
//       memory: true, // always load chat history
//       styleProfile: false,
//       wardrobe: false,
//       calendar: false,
//       savedLooks: false,
//       feedback: false,
//       wearHistory: false,
//       scheduledOutfits: false,
//       favorites: false,
//       customOutfits: false,
//       itemPrefs: false,
//       lookMemories: false,
//       notifications: false,
//       weather: false,
//     };

//     try {
//       const classifyRes = await this.openai.chat.completions.create({
//         model: 'gpt-4o-mini',
//         temperature: 0,
//         max_tokens: 150,
//         messages: [
//           {
//             role: 'system',
//             content: `Classify what data is needed to answer this fashion/style question. Return JSON only.
// Categories: styleProfile (body type, colors, preferences), wardrobe (clothes owned), calendar (events), savedLooks, feedback (outfit ratings), wearHistory (recently worn), scheduledOutfits, favorites, customOutfits, itemPrefs (liked/disliked items), lookMemories (style exploration), notifications, weather.
// For general chat/greetings, return empty needs. For outfit suggestions, include styleProfile+wardrobe+weather. Be minimal.`,
//           },
//           {
//             role: 'user',
//             content: `Query: "${lastUserMsg}"\n\nReturn JSON: {"needs": ["category1", "category2"]}`,
//           },
//         ],
//       });
//       const classifyContent = classifyRes.choices[0]?.message?.content || '{}';
//       const parsed = JSON.parse(classifyContent.match(/\{.*\}/s)?.[0] || '{}');
//       const needs: string[] = parsed.needs || [];

//       // Map needs to contextNeeds
//       needs.forEach((n: string) => {
//         const key = n.toLowerCase().replace(/[^a-z]/g, '');
//         if (key in contextNeeds) (contextNeeds as any)[key] = true;
//       });

//       console.log(
//         `🎯 Smart context: ${needs.length ? needs.join(', ') : 'minimal (chat only)'}`,
//       );
//       // ✅ Force-enable weather context if location or weather was passed
//       if (dto.lat || dto.lon || dto.weather) {
//         contextNeeds.weather = true;
//       }
//     } catch (err: any) {
//       // Fallback: load everything if classification fails
//       console.warn(
//         '⚠️ Context classification failed, loading all:',
//         err.message,
//       );
//       Object.keys(contextNeeds).forEach(
//         (k) => ((contextNeeds as any)[k] = true),
//       );
//     }

//     /* 🧠 --- MEMORY BLOCK START --- */
//     try {
//       // Save the latest user message
//       await pool.query(
//         `INSERT INTO chat_messages (user_id, role, content)
//        VALUES ($1,$2,$3)`,
//         [user_id, 'user', lastUserMsg],
//       );

//       // Fetch the last 10 messages for this user
//       const { rows } = await pool.query(
//         `SELECT role, content
//        FROM chat_messages
//        WHERE user_id = $1
//        ORDER BY created_at DESC
//        LIMIT 10`,
//         [user_id],
//       );

//       // Add them (chronological) to current messages for context
//       const history = rows.reverse();
//       for (const h of history) {
//         if (h.content !== lastUserMsg)
//           messages.unshift({ role: h.role, content: h.content });
//       }

//       // 🧹 Purge older messages beyond last 30
//       await pool.query(
//         `DELETE FROM chat_messages
//        WHERE user_id = $1
//        AND id NOT IN (
//          SELECT id FROM chat_messages
//          WHERE user_id = $1
//          ORDER BY created_at DESC
//          LIMIT 30
//        );`,
//         [user_id],
//       );
//     } catch (err: any) {
//       console.warn('⚠️ chat history retrieval failed:', err.message);
//     }
//     /* 🧠 --- MEMORY BLOCK END --- */

//     /* 🧠 --- LOAD LONG-TERM SUMMARY MEMORY (with Redis cache) --- */
//     let longTermSummary = '';
//     try {
//       const cacheKey = `memory:${user_id}`;
//       const cached = await redis.get<string>(cacheKey);

//       if (cached) {
//         console.log(`🟢 Redis HIT for ${cacheKey}`);
//         longTermSummary = cached;
//       } else {
//         console.log(`🔴 Redis MISS for ${cacheKey} — fetching from Postgres`);
//         const { rows } = await pool.query(
//           `SELECT summary FROM chat_memory WHERE user_id = $1`,
//           [user_id],
//         );
//         if (rows[0]?.summary) {
//           longTermSummary = rows[0].summary;
//           console.log(`🟢 Caching summary in Redis for ${cacheKey}`);
//           await redis.set(cacheKey, longTermSummary, { ex: 86400 });
//         }
//       }
//     } catch (err: any) {
//       console.warn(
//         '⚠️ failed to load summary from Redis/Postgres:',
//         err.message,
//       );
//     }

//     /* 📅 --- LOAD CALENDAR EVENTS FOR CHAT CONTEXT --- */
//     let calendarContext = '';
//     if (contextNeeds.calendar)
//       try {
//         const { rows: calendarRows } = await pool.query(
//           `SELECT title, start_date, end_date, location, notes
//          FROM user_calendar_events
//          WHERE user_id = $1
//          AND start_date >= NOW()
//          ORDER BY start_date ASC
//          LIMIT 15`,
//           [user_id],
//         );
//         if (calendarRows.length > 0) {
//           const eventsList = calendarRows
//             .map((e, i) => {
//               const start = new Date(e.start_date);
//               const dateStr = start.toLocaleDateString('en-US', {
//                 weekday: 'long',
//                 month: 'long',
//                 day: 'numeric',
//                 year: 'numeric',
//               });
//               const timeStr = start.toLocaleTimeString('en-US', {
//                 hour: '2-digit',
//                 minute: '2-digit',
//                 hour12: true,
//               });
//               let eventLine = `${i + 1}. "${e.title}" - ${dateStr} at ${timeStr}`;
//               if (e.location) eventLine += ` @ ${e.location}`;
//               if (e.notes) eventLine += ` (${e.notes})`;
//               return eventLine;
//             })
//             .join('\n');

//           calendarContext = `\n\nCALENDAR EVENTS (${calendarRows.length} upcoming):\n${eventsList}`;
//           console.log(
//             `📅 Chat: Loaded ${calendarRows.length} upcoming calendar events`,
//           );
//         }
//       } catch (err: any) {
//         console.warn(
//           '⚠️ failed to load calendar events for chat:',
//           err.message,
//         );
//       }

//     /* 👗 --- LOAD STYLE PROFILE FOR CHAT CONTEXT --- */
//     let styleProfileContext = '';
//     if (contextNeeds.styleProfile)
//       try {
//         const { rows: styleRows } = await pool.query(
//           `SELECT body_type, skin_tone, undertone, climate,
//                 favorite_colors, fit_preferences, preferred_brands,
//                 disliked_styles, style_keywords, style_preferences,
//                 hair_color, eye_color, height, waist, goals
//          FROM style_profiles
//          WHERE user_id = $1
//          LIMIT 1`,
//           [user_id],
//         );
//         if (styleRows.length > 0) {
//           const sp = styleRows[0];
//           const parts: string[] = [];
//           if (sp.body_type) parts.push(`Body type: ${sp.body_type}`);
//           if (sp.skin_tone) parts.push(`Skin tone: ${sp.skin_tone}`);
//           if (sp.undertone) parts.push(`Undertone: ${sp.undertone}`);
//           if (sp.hair_color) parts.push(`Hair: ${sp.hair_color}`);
//           if (sp.eye_color) parts.push(`Eyes: ${sp.eye_color}`);
//           if (sp.height) parts.push(`Height: ${sp.height}`);
//           if (sp.climate) parts.push(`Climate: ${sp.climate}`);
//           if (sp.favorite_colors?.length)
//             parts.push(
//               `Favorite colors: ${Array.isArray(sp.favorite_colors) ? sp.favorite_colors.join(', ') : sp.favorite_colors}`,
//             );
//           if (sp.fit_preferences?.length)
//             parts.push(
//               `Fit preferences: ${Array.isArray(sp.fit_preferences) ? sp.fit_preferences.join(', ') : sp.fit_preferences}`,
//             );
//           if (sp.preferred_brands?.length)
//             parts.push(
//               `Preferred brands: ${Array.isArray(sp.preferred_brands) ? sp.preferred_brands.join(', ') : sp.preferred_brands}`,
//             );
//           if (sp.disliked_styles?.length)
//             parts.push(
//               `Dislikes: ${Array.isArray(sp.disliked_styles) ? sp.disliked_styles.join(', ') : sp.disliked_styles}`,
//             );
//           if (sp.style_keywords?.length)
//             parts.push(
//               `Style keywords: ${Array.isArray(sp.style_keywords) ? sp.style_keywords.join(', ') : sp.style_keywords}`,
//             );
//           if (sp.goals) parts.push(`Goals: ${sp.goals}`);
//           if (parts.length > 0) {
//             styleProfileContext = '\n\n👗 STYLE PROFILE:\n' + parts.join('\n');
//             console.log(
//               `👗 Chat: Loaded style profile with ${parts.length} attributes`,
//             );
//           }
//         }
//       } catch (err: any) {
//         console.warn('⚠️ failed to load style profile for chat:', err.message);
//       }

//     /* 👔 --- LOAD WARDROBE ITEMS FOR CHAT CONTEXT (WITH SPECIFIC ITEM DETAILS) --- */
//     let wardrobeContext = '';
//     if (contextNeeds.wardrobe)
//       try {
//         const { rows: wardrobeRows } = await pool.query(
//           `SELECT name, main_category, subcategory, color, material, brand, fit
//          FROM wardrobe_items
//          WHERE user_id = $1
//          ORDER BY created_at DESC
//          LIMIT 100`,
//           [user_id],
//         );
//         if (wardrobeRows.length > 0) {
//           const grouped: Record<string, any[]> = {};
//           for (const item of wardrobeRows) {
//             const cat = item.main_category || 'Other';
//             if (!grouped[cat]) grouped[cat] = [];
//             grouped[cat].push({
//               name: item.name,
//               color: item.color,
//               material: item.material,
//               brand: item.brand,
//               fit: item.fit,
//               subcategory: item.subcategory,
//             });
//           }

//           // Format wardrobe for easy reference in recommendations
//           const formatted = Object.entries(grouped)
//             .map(([cat, items]) => {
//               const itemDescriptions = items
//                 .slice(0, 12)
//                 .map((i) => {
//                   const parts = [
//                     i.color,
//                     i.name || i.subcategory,
//                     i.brand,
//                     i.material,
//                     i.fit,
//                   ]
//                     .filter(Boolean)
//                     .join(' • ');
//                   return `  • ${parts}`;
//                 })
//                 .join('\n');
//               return `${cat}:\n${itemDescriptions}`;
//             })
//             .join('\n\n');

//           wardrobeContext = `\n\n👔 USER'S EXACT WARDROBE ITEMS (use these specific names and colors in recommendations):\n\n${formatted}\n\nWARNING: Always reference ACTUAL item names from above when making recommendations. Use language like:
// - "pair with your [COLOR] [ITEM NAME] you own"
// - "complements the [BRAND] [ITEM] in [COLOR]"
// - "works with your [fit] [COLOR] [ITEM]"
// NEVER make generic references. ALWAYS name the SPECIFIC pieces they own.`;

//           console.log(
//             `👔 Chat: Loaded ${wardrobeRows.length} wardrobe items from ${Object.keys(grouped).length} categories`,
//           );
//         }
//       } catch (err: any) {
//         console.warn('⚠️ failed to load wardrobe items for chat:', err.message);
//       }

//     /* ⭐ --- LOAD SAVED LOOKS FOR CHAT CONTEXT --- */
//     let savedLooksContext = '';
//     if (contextNeeds.savedLooks)
//       try {
//         const { rows: savedRows } = await pool.query(
//           `SELECT name, created_at
//          FROM saved_looks
//          WHERE user_id = $1
//          ORDER BY created_at DESC
//          LIMIT 10`,
//           [user_id],
//         );
//         if (savedRows.length > 0) {
//           savedLooksContext =
//             '\n\n⭐ SAVED LOOKS:\n' +
//             savedRows.map((l) => `• ${l.name}`).join('\n');
//           console.log(`⭐ Chat: Loaded ${savedRows.length} saved looks`);
//         }
//       } catch (err: any) {
//         console.warn('⚠️ failed to load saved looks for chat:', err.message);
//       }

//     /* 🎨 --- LOAD RECREATED LOOKS FOR CHAT CONTEXT --- */
//     let recreatedLooksContext = '';
//     if (contextNeeds.savedLooks)
//       try {
//         const { rows: recreatedRows } = await pool.query(
//           `SELECT tags, created_at
//          FROM recreated_looks
//          WHERE user_id = $1
//          ORDER BY created_at DESC
//          LIMIT 10`,
//           [user_id],
//         );
//         if (recreatedRows.length > 0) {
//           const allTags = recreatedRows
//             .flatMap((r) => r.tags || [])
//             .filter(Boolean);
//           const uniqueTags = [...new Set(allTags)].slice(0, 20);
//           if (uniqueTags.length > 0) {
//             recreatedLooksContext =
//               '\n\n🎨 RECENT LOOK INSPIRATIONS (tags): ' +
//               uniqueTags.join(', ');
//             console.log(
//               `🎨 Chat: Loaded ${recreatedRows.length} recreated looks`,
//             );
//           }
//         }
//       } catch (err: any) {
//         console.warn(
//           '⚠️ failed to load recreated looks for chat:',
//           err.message,
//         );
//       }

//     /* 📝 --- LOAD OUTFIT FEEDBACK FOR CHAT CONTEXT --- */
//     let feedbackContext = '';
//     if (contextNeeds.feedback)
//       try {
//         const { rows: feedbackRows } = await pool.query(
//           `SELECT rating, notes, outfit_json
//          FROM outfit_feedback
//          WHERE user_id = $1
//          ORDER BY created_at DESC
//          LIMIT 10`,
//           [user_id],
//         );
//         if (feedbackRows.length > 0) {
//           const likes = feedbackRows.filter((f) => f.rating >= 4);
//           const dislikes = feedbackRows.filter((f) => f.rating <= 2);
//           const parts: string[] = [];
//           if (likes.length > 0) {
//             const likeNotes = likes
//               .map((f) => f.notes)
//               .filter(Boolean)
//               .slice(0, 3);
//             parts.push(
//               `Liked outfits: ${likes.length}${likeNotes.length ? ' - ' + likeNotes.join('; ') : ''}`,
//             );
//           }
//           if (dislikes.length > 0) {
//             const dislikeNotes = dislikes
//               .map((f) => f.notes)
//               .filter(Boolean)
//               .slice(0, 3);
//             parts.push(
//               `Disliked outfits: ${dislikes.length}${dislikeNotes.length ? ' - ' + dislikeNotes.join('; ') : ''}`,
//             );
//           }
//           if (parts.length > 0) {
//             feedbackContext = '\n\n📝 OUTFIT FEEDBACK:\n' + parts.join('\n');
//             console.log(
//               `📝 Chat: Loaded ${feedbackRows.length} outfit feedback entries`,
//             );
//           }
//         }
//       } catch (err: any) {
//         console.warn(
//           '⚠️ failed to load outfit feedback for chat:',
//           err.message,
//         );
//       }

//     /* 👕 --- LOAD WEAR HISTORY FOR CHAT CONTEXT --- */
//     let wearHistoryContext = '';
//     if (contextNeeds.wearHistory)
//       try {
//         const { rows: wearRows } = await pool.query(
//           `SELECT items_jsonb, context_jsonb, worn_at
//          FROM wear_events
//          WHERE user_id = $1
//          ORDER BY worn_at DESC
//          LIMIT 10`,
//           [user_id],
//         );
//         if (wearRows.length > 0) {
//           const recentWears = wearRows
//             .slice(0, 5)
//             .map((w) => {
//               const date = new Date(w.worn_at).toLocaleDateString('en-US', {
//                 month: 'short',
//                 day: 'numeric',
//               });
//               const context =
//                 w.context_jsonb?.occasion || w.context_jsonb?.event || '';
//               return `• ${date}${context ? ' (' + context + ')' : ''}`;
//             })
//             .filter(Boolean);
//           if (recentWears.length > 0) {
//             wearHistoryContext =
//               '\n\n👕 RECENTLY WORN:\n' + recentWears.join('\n');
//             console.log(`👕 Chat: Loaded ${wearRows.length} wear events`);
//           }
//         }
//       } catch (err: any) {
//         console.warn('⚠️ failed to load wear history for chat:', err.message);
//       }

//     /* 📆 --- LOAD SCHEDULED OUTFITS FOR CHAT CONTEXT --- */
//     let scheduledOutfitsContext = '';
//     if (contextNeeds.scheduledOutfits)
//       try {
//         const { rows: scheduledRows } = await pool.query(
//           `SELECT scheduled_for, notes, location
//          FROM scheduled_outfits
//          WHERE user_id = $1
//          AND scheduled_for >= NOW()
//          ORDER BY scheduled_for ASC
//          LIMIT 5`,
//           [user_id],
//         );
//         if (scheduledRows.length > 0) {
//           scheduledOutfitsContext =
//             '\n\n📆 SCHEDULED OUTFITS:\n' +
//             scheduledRows
//               .map((s) => {
//                 const date = new Date(s.scheduled_for).toLocaleDateString(
//                   'en-US',
//                   { weekday: 'short', month: 'short', day: 'numeric' },
//                 );
//                 return `• ${date}${s.location ? ' at ' + s.location : ''}${s.notes ? ' - ' + s.notes : ''}`;
//               })
//               .join('\n');
//           console.log(
//             `📆 Chat: Loaded ${scheduledRows.length} scheduled outfits`,
//           );
//         }
//       } catch (err: any) {
//         console.warn(
//           '⚠️ failed to load scheduled outfits for chat:',
//           err.message,
//         );
//       }

//     /* ❤️ --- LOAD OUTFIT FAVORITES FOR CHAT CONTEXT --- */
//     let favoritesContext = '';
//     if (contextNeeds.favorites)
//       try {
//         const { rows: favRows } = await pool.query(
//           `SELECT outfit_type, COUNT(*) as count
//          FROM outfit_favorites
//          WHERE user_id = $1
//          GROUP BY outfit_type`,
//           [user_id],
//         );
//         if (favRows.length > 0) {
//           favoritesContext =
//             '\n\n❤️ FAVORITED OUTFITS: ' +
//             favRows
//               .map((f) => `${f.outfit_type || 'outfit'}: ${f.count}`)
//               .join(', ');
//           console.log(
//             `❤️ Chat: Loaded ${favRows.length} outfit favorite types`,
//           );
//         }
//       } catch (err: any) {
//         console.warn(
//           '⚠️ failed to load outfit favorites for chat:',
//           err.message,
//         );
//       }

//     /* 🎯 --- LOAD CUSTOM OUTFITS FOR CHAT CONTEXT --- */
//     let customOutfitsContext = '';
//     if (contextNeeds.customOutfits)
//       try {
//         const { rows: customRows } = await pool.query(
//           `SELECT name, notes, rating
//          FROM custom_outfits
//          WHERE user_id = $1
//          ORDER BY created_at DESC
//          LIMIT 10`,
//           [user_id],
//         );
//         if (customRows.length > 0) {
//           customOutfitsContext =
//             '\n\n🎯 CUSTOM OUTFITS CREATED:\n' +
//             customRows
//               .map(
//                 (c) =>
//                   `• ${c.name}${c.rating ? ' (rated ' + c.rating + '/5)' : ''}${c.notes ? ' - ' + c.notes : ''}`,
//               )
//               .join('\n');
//           console.log(`🎯 Chat: Loaded ${customRows.length} custom outfits`);
//         }
//       } catch (err: any) {
//         console.warn('⚠️ failed to load custom outfits for chat:', err.message);
//       }

//     /* 👍 --- LOAD ITEM PREFERENCES FOR CHAT CONTEXT --- */
//     let itemPrefsContext = '';
//     if (contextNeeds.itemPrefs)
//       try {
//         const { rows: prefRows } = await pool.query(
//           `SELECT up.score, wi.name, wi.main_category, wi.color
//          FROM user_pref_item up
//          JOIN wardrobe_items wi ON up.item_id = wi.id
//          WHERE up.user_id = $1
//          ORDER BY up.score DESC
//          LIMIT 10`,
//           [user_id],
//         );
//         if (prefRows.length > 0) {
//           const liked = prefRows.filter((p) => p.score > 0);
//           const disliked = prefRows.filter((p) => p.score < 0);
//           const parts: string[] = [];
//           if (liked.length > 0) {
//             parts.push(
//               'Most liked items: ' +
//                 liked
//                   .slice(0, 5)
//                   .map((p) => p.name || `${p.color} ${p.main_category}`)
//                   .join(', '),
//             );
//           }
//           if (disliked.length > 0) {
//             parts.push(
//               'Least liked items: ' +
//                 disliked
//                   .slice(0, 3)
//                   .map((p) => p.name || `${p.color} ${p.main_category}`)
//                   .join(', '),
//             );
//           }
//           if (parts.length > 0) {
//             itemPrefsContext = '\n\n👍 ITEM PREFERENCES:\n' + parts.join('\n');
//             console.log(`👍 Chat: Loaded ${prefRows.length} item preferences`);
//           }
//         }
//       } catch (err: any) {
//         console.warn(
//           '⚠️ failed to load item preferences for chat:',
//           err.message,
//         );
//       }

//     /* 🔍 --- LOAD LOOK MEMORIES FOR CHAT CONTEXT --- */
//     let lookMemoriesContext = '';
//     if (contextNeeds.lookMemories)
//       try {
//         const { rows: memRows } = await pool.query(
//           `SELECT ai_tags, query_used
//          FROM look_memories
//          WHERE user_id = $1
//          ORDER BY created_at DESC
//          LIMIT 15`,
//           [user_id],
//         );
//         if (memRows.length > 0) {
//           const allTags = memRows
//             .flatMap((m) => m.ai_tags || [])
//             .filter(Boolean);
//           const uniqueTags = [...new Set(allTags)].slice(0, 15);
//           const queries = [
//             ...new Set(memRows.map((m) => m.query_used).filter(Boolean)),
//           ].slice(0, 5);
//           const parts: string[] = [];
//           if (uniqueTags.length > 0)
//             parts.push('Style tags explored: ' + uniqueTags.join(', '));
//           if (queries.length > 0)
//             parts.push('Recent searches: ' + queries.join(', '));
//           if (parts.length > 0) {
//             lookMemoriesContext =
//               '\n\n🔍 LOOK EXPLORATION HISTORY:\n' + parts.join('\n');
//             console.log(`🔍 Chat: Loaded ${memRows.length} look memories`);
//           }
//         }
//       } catch (err: any) {
//         console.warn('⚠️ failed to load look memories for chat:', err.message);
//       }

//     /* 🔔 --- LOAD NOTIFICATIONS FOR CHAT CONTEXT --- */
//     let notificationsContext = '';
//     if (contextNeeds.notifications)
//       try {
//         const { rows: notifRows } = await pool.query(
//           `SELECT title, message, timestamp, category, read
//          FROM user_notifications
//          WHERE user_id = $1
//          ORDER BY timestamp DESC
//          LIMIT 15`,
//           [user_id],
//         );
//         if (notifRows.length > 0) {
//           notificationsContext =
//             '\n\n🔔 RECENT NOTIFICATIONS:\n' +
//             notifRows
//               .map((n: any, i: number) => {
//                 const date = new Date(n.timestamp).toLocaleDateString('en-US', {
//                   month: 'short',
//                   day: 'numeric',
//                 });
//                 const readStatus = n.read ? '' : ' (unread)';
//                 return `${i + 1}. [${date}] ${n.title || n.category || 'Notification'}: ${n.message}${readStatus}`;
//               })
//               .join('\n');
//           console.log(`🔔 Chat: Loaded ${notifRows.length} notifications`);
//           console.log(
//             `🔔 Chat: Notifications preview: ${notificationsContext.substring(0, 500)}`,
//           );
//         }
//       } catch (err: any) {
//         console.warn('⚠️ failed to load notifications for chat:', err.message);
//       }

//     /* 🌦️ --- FETCH CURRENT WEATHER FOR CHAT CONTEXT --- */
//     let weatherContext = '';
//     if (contextNeeds.weather)
//       try {
//         if (dto.lat && dto.lon) {
//           const weather = await fetchWeatherForAI(dto.lat, dto.lon);
//           if (weather) {
//             weatherContext = `\n\n🌦️ CURRENT WEATHER:\n• Temperature: ${weather.tempF}°F\n• Condition: ${weather.condition}\n• Humidity: ${weather.humidity}%\n• Wind: ${weather.windSpeed} mph`;
//             console.log(
//               `🌦️ Chat: Loaded weather - ${weather.tempF}°F, ${weather.condition}`,
//             );
//           }
//         } else if (dto.weather) {
//           // Use weather passed directly from frontend if no lat/lon
//           const w = dto.weather;
//           if (w.tempF || w.temperature) {
//             const temp = w.tempF || Math.round((w.temperature * 9) / 5 + 32);
//             weatherContext = `\n\n🌦️ CURRENT WEATHER:\n• Temperature: ${temp}°F${w.condition ? `\n• Condition: ${w.condition}` : ''}`;
//             console.log(`🌦️ Chat: Using passed weather - ${temp}°F`);
//           }
//         }
//       } catch (err: any) {
//         console.warn('⚠️ failed to fetch weather for chat:', err.message);
//       }

//     // Combine all context into enhanced summary
//     const fullContext =
//       (longTermSummary || '(no prior memory yet)') +
//       styleProfileContext +
//       wardrobeContext +
//       calendarContext +
//       savedLooksContext +
//       recreatedLooksContext +
//       feedbackContext +
//       wearHistoryContext +
//       scheduledOutfitsContext +
//       favoritesContext +
//       customOutfitsContext +
//       itemPrefsContext +
//       lookMemoriesContext +
//       notificationsContext +
//       weatherContext;

//     console.log(`📊 Chat: Full context length: ${fullContext.length} chars`);
//     console.log(
//       `📊 Chat: Calendar context included: ${calendarContext.length > 0}`,
//     );
//     console.log(
//       `📊 Chat: Calendar context length: ${calendarContext.length} chars`,
//     );
//     console.log(`📊 Chat: Calendar data: ${calendarContext.substring(0, 200)}`);
//     console.log(
//       `📊 Chat: Wardrobe context included: ${wardrobeContext.length > 0}`,
//     );
//     console.log(
//       `📊 Chat: Style profile context included: ${styleProfileContext.length > 0}`,
//     );

//     // 1️⃣ Generate base text with OpenAI
//     const completion = await this.openai.chat.completions.create({
//       model: 'gpt-4o',
//       temperature: 0.8,
//       messages: [
//         {
//           role: 'system',
//           content: `
// You are a world-class personal fashion stylist with FULL ACCESS to the user's personal data.

// YOU HAVE COMPLETE ACCESS TO ALL OF THIS USER DATA:
// ${fullContext}

// CRITICAL RULES - MANDATORY FOR ALL RESPONSES:
// 1. ONLY reference events, items, and data actually shown above
// 2. DO NOT make up or invent calendar events, wardrobe items, or preferences
// 3. If the user asks about something not in the data above, say "I don't see that in your data"
// 4. Use ONLY the real calendar events, wardrobe items, and preferences provided
// 5. When answering questions about their calendar - reference ONLY the events listed above
// 6. You DO have access to real-time weather data - if CURRENT WEATHER is shown above, use it confidently
// 7. You DO have access to notification history - if RECENT NOTIFICATIONS is shown above, use it to answer questions about notifications

// ⭐ WARDROBE RECOMMENDATION RULES (MANDATORY):
// - WHEN MAKING SHOPPING SUGGESTIONS: You MUST reference specific items they ALREADY OWN
// - Use language patterns like:
//   • "pair with your [COLOR] [ITEM NAME] you own"
//   • "matches the [BRAND] [ITEM] in [COLOR]"
//   • "works perfectly with your [fit] [COLOR] [ITEM NAME]"
//   • "complements your existing [COLOR] [MATERIAL] [ITEM]"
//   • "You currently have [NUMBER] [CATEGORY], so adding a [specific item] would fill the gap"
// - SHOW PROOF you know their wardrobe by naming SPECIFIC items, colors, materials, brands
// - Example RIGHT answer: "Navy blazer to pair with your sleek white pants you own - fills your structured top gap"
// - Example WRONG answer: "Add a navy blazer to complete your look" ← NEVER do this

// Respond naturally about outfits, wardrobe planning, or styling using ONLY the user data provided.
// At the end, return a short JSON block like:
// {"search_terms":["smart casual men","navy blazer outfit","loafers"]}
//         `,
//         },
//         ...messages,
//       ],
//     });

//     const aiReply =
//       completion.choices[0]?.message?.content?.trim() ||
//       'Styled response unavailable.';

//     // 2️⃣ Extract search terms if model provided them
//     let searchTerms: string[] = [];
//     const match = aiReply.match(/\{.*"search_terms":.*\}/s);
//     if (match) {
//       try {
//         const parsed = JSON.parse(match[0]);
//         searchTerms = parsed.search_terms ?? [];
//       } catch {
//         searchTerms = [];
//       }
//     }

//     // 3️⃣ Fallback heuristic: derive terms if none found
//     if (!searchTerms.length) {
//       const lowered = lastUserMsg.toLowerCase();
//       if (lowered.includes('smart')) searchTerms.push('smart casual outfit');
//       if (lowered.includes('summer')) searchTerms.push('summer outfit');
//       if (lowered.includes('work')) searchTerms.push('business casual look');
//       if (!searchTerms.length)
//         searchTerms.push(`${lowered} outfit inspiration`);
//     }

//     // 4️⃣ Fetch Unsplash images
//     const images = await this.fetchUnsplash(searchTerms);

//     // 5️⃣ Build shoppable links
//     const links = searchTerms.map((term) => ({
//       label: `Shop ${term} on ASOS`,
//       url: `https://www.asos.com/search/?q=${encodeURIComponent(term)}`,
//     }));

//     /* 🧠 --- SAVE ASSISTANT REPLY --- */
//     try {
//       await pool.query(
//         `INSERT INTO chat_messages (user_id, role, content)
//        VALUES ($1,$2,$3)`,
//         [user_id, 'assistant', aiReply],
//       );
//     } catch (err: any) {
//       console.warn('⚠️ failed to store assistant reply:', err.message);
//     }

//     /* 🧠 --- UPDATE LONG-TERM SUMMARY MEMORY (Postgres + Redis) --- */
//     try {
//       const { rows } = await pool.query(
//         `SELECT summary FROM chat_memory WHERE user_id = $1`,
//         [user_id],
//       );
//       const prevSummary = rows[0]?.summary || '';

//       const { rows: recent } = await pool.query(
//         `SELECT role, content FROM chat_messages
//        WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
//         [user_id],
//       );

//       const context = recent
//         .reverse()
//         .map((r) => `${r.role}: ${r.content}`)
//         .join('\n');

//       const memoryPrompt = `
// You are a memory summarizer for an AI stylist.
// Update this user's long-term fashion memory summary.
// Keep what you've already learned, and merge any new useful insights.

// Previous memory summary:
// ${prevSummary}

// Recent chat history:
// ${context}

// Write a concise, 150-word updated summary focusing on their taste, preferences, and style evolution.
// `;

//       const memCompletion = await this.openai.chat.completions.create({
//         model: 'gpt-4o-mini',
//         temperature: 0.3,
//         messages: [{ role: 'system', content: memoryPrompt }],
//       });

//       const newSummary =
//         memCompletion.choices[0]?.message?.content?.trim() || prevSummary;

//       const trimmedSummary = newSummary.slice(0, 1000).replace(/[*_#`]/g, '');

//       await pool.query(
//         `INSERT INTO chat_memory (user_id, summary, updated_at)
//        VALUES ($1, $2, NOW())
//        ON CONFLICT (user_id)
//        DO UPDATE SET summary = $2, updated_at = NOW();`,
//         [user_id, trimmedSummary],
//       );

//       // ✅ Cache the updated summary in Redis for 24 hours
//       await redis.set(`memory:${user_id}`, trimmedSummary, { ex: 86400 });
//     } catch (err: any) {
//       console.warn('⚠️ failed to update long-term memory:', err.message);
//     }

//     return { reply: aiReply, images, links };
//   }

//   // 🧠 Completely clear all chat + memory for a user
//   async clearChatHistory(user_id: string) {
//     try {
//       // 1️⃣ Delete all chat messages for the user
//       await pool.query(`DELETE FROM chat_messages WHERE user_id = $1`, [
//         user_id,
//       ]);

//       // 2️⃣ Delete long-term memory summaries
//       await pool.query(`DELETE FROM chat_memory WHERE user_id = $1`, [user_id]);

//       // 3️⃣ Clear Redis cache for this user
//       await redis.del(`memory:${user_id}`);

//       console.log(`🧹 Cleared ALL chat + memory for user ${user_id}`);
//       return { success: true, message: 'All chat history and memory cleared.' };
//     } catch (err: any) {
//       console.error('❌ Failed to clear chat history:', err.message);
//       throw new Error('Failed to clear chat history.');
//     }
//   }

//   // 🧹 Soft reset: clear short-term chat but retain long-term memory
//   async softResetChat(user_id: string) {
//     try {
//       // Delete recent messages but keep memory summary
//       await pool.query(`DELETE FROM chat_messages WHERE user_id = $1`, [
//         user_id,
//       ]);

//       console.log(`🧹 Soft reset chat for user ${user_id}`);
//       return {
//         success: true,
//         message: 'Recent chat messages cleared (long-term memory retained).',
//       };
//     } catch (err: any) {
//       console.error('❌ Failed to soft-reset chat:', err.message);
//       throw new Error('Failed to soft reset chat.');
//     }
//   }

//   /** 🔍 Lightweight Unsplash fetch helper */
//   private async fetchUnsplash(terms: string[]) {
//     const key = process.env.UNSPLASH_ACCESS_KEY;
//     if (!key || !terms.length) return [];
//     const q = encodeURIComponent(terms[0]);
//     const res = await fetch(
//       `https://api.unsplash.com/search/photos?query=${q}&per_page=5&client_id=${key}`,
//     );
//     if (!res.ok) return [];
//     const json = await res.json();
//     return json.results.map((r) => ({
//       imageUrl: r.urls.small,
//       title: r.description || r.alt_description,
//       sourceLink: r.links.html,
//     }));
//   }

//   /** 🌤️ Suggest daily style plan */
//   async suggest(body: {
//     user?: string;
//     weather?: any;
//     wardrobe?: any[];
//     preferences?: Record<string, any>;
//   }) {
//     const { user, weather, wardrobe, preferences } = body;

//     const temp = weather?.fahrenheit?.main?.temp;
//     const tempDesc = temp
//       ? `${temp}°F and ${temp < 60 ? 'cool' : temp > 85 ? 'warm' : 'mild'} weather`
//       : 'unknown temperature';

//     const wardrobeCount = wardrobe?.length || 0;

//     const systemPrompt = `
// You are a luxury personal stylist.
// Your goal is to provide a daily style briefing that helps the user feel prepared, stylish, and confident.
// Be concise, intelligent, and polished — similar to a stylist at a high-end menswear brand.

// Output must be JSON with:
// - suggestion
// - insight
// - tomorrow
// Optionally include seasonalForecast, lifecycleForecast, styleTrajectory.
// `;

//     const userPrompt = `
// Client: ${user || 'The user'}
// Weather: ${tempDesc}
// Wardrobe items: ${wardrobeCount}
// Preferences: ${JSON.stringify(preferences || {})}
// `;

//     const completion = await this.openai.chat.completions.create({
//       model: 'gpt-4o',
//       temperature: 0.8,
//       messages: [
//         { role: 'system', content: systemPrompt },
//         { role: 'user', content: userPrompt },
//       ],
//       response_format: { type: 'json_object' },
//     });

//     const raw = completion.choices[0]?.message?.content;
//     if (!raw) throw new Error('No suggestion response received from model.');

//     let parsed: {
//       suggestion: string;
//       insight: string;
//       tomorrow: string;
//       seasonalForecast?: string;
//       lifecycleForecast?: string;
//       styleTrajectory?: string;
//     };

//     try {
//       parsed = JSON.parse(raw);
//     } catch {
//       console.error('❌ Failed to parse AI JSON:', raw);
//       throw new Error('AI response was not valid JSON.');
//     }

//     if (!parsed.seasonalForecast) {
//       parsed.seasonalForecast = generateSeasonalForecast(wardrobe);
//     }

//     return parsed;
//   }

//   /* ------------------------------------------------------------
//      🧾 BARCODE / CLOTHING LABEL DECODER
//   -------------------------------------------------------------*/
//   async decodeBarcode(file: {
//     buffer: Buffer;
//     originalname: string;
//     mimetype: string;
//   }) {
//     const tempPath = `/tmp/${Date.now()}-barcode.jpg`;
//     fs.writeFileSync(tempPath, file.buffer);

//     try {
//       const base64 = fs.readFileSync(tempPath).toString('base64');

//       const prompt = `
//       You are analyzing a photo of a product or clothing label.
//       If the image contains a barcode, return ONLY the numeric digits (UPC/EAN).
//       Otherwise, infer structured product info like:
//       {
//         "name": "Uniqlo Linen Shirt",
//         "brand": "Uniqlo",
//         "category": "Shirts",
//         "material": "Linen"
//       }
//       Respond with JSON only. No extra text.
//       `;

//       const completion = await this.openai.chat.completions.create({
//         model: 'gpt-4o-mini',
//         messages: [
//           {
//             role: 'user',
//             content: [
//               { type: 'text', text: prompt },
//               {
//                 type: 'image_url',
//                 image_url: { url: `data:${file.mimetype};base64,${base64}` },
//               },
//             ],
//           },
//         ],
//         max_tokens: 200,
//       });

//       const message = completion.choices?.[0]?.message;

//       let text = '';
//       if (typeof message?.content === 'string') {
//         text = message.content;
//       } else if (Array.isArray(message?.content)) {
//         const parts = message.content as Array<{ text?: string }>;
//         text = parts.map((c) => c.text || '').join(' ');
//       }

//       text = text.trim().replace(/```json|```/g, '');

//       const match = text.match(/\b\d{8,14}\b/);
//       if (match) return { barcode: match[0], raw: text };

//       try {
//         const parsed = JSON.parse(text);
//         if (parsed?.name) return { barcode: null, inferred: parsed };
//       } catch {}

//       return { barcode: null, raw: text };
//     } catch (err: any) {
//       console.error('❌ [AI] decodeBarcode error:', err.message);
//       return { barcode: null, error: err.message };
//     } finally {
//       try {
//         fs.unlinkSync(tempPath);
//       } catch {}
//     }
//   }

//   /* ------------------------------------------------------------
//      🧩 PRODUCT LOOKUP BY BARCODE
//   -------------------------------------------------------------*/
//   async lookupProductByBarcode(upc: string) {
//     const normalized = upc.padStart(12, '0');
//     try {
//       const res = await fetch(
//         `https://api.upcitemdb.com/prod/trial/lookup?upc=${normalized}`,
//       );
//       const json = await res.json();

//       const item = json?.items?.[0];
//       if (!item) throw new Error('No product data from UPCItemDB');

//       return {
//         name: item.title,
//         brand: item.brand,
//         image: item.images?.[0],
//         category: item.category,
//         source: 'upcitemdb',
//       };
//     } catch (err: any) {
//       console.warn('⚠️ UPCItemDB lookup failed:', err.message);
//       const fallback = await this.lookupFallback(normalized);
//       if (!fallback?.name || fallback.name === 'Unknown product') {
//         return await this.lookupFallbackWithAI(normalized);
//       }
//       return fallback;
//     }
//   }

//   /* ------------------------------------------------------------
//      🔁 RapidAPI or Dummy Fallback
//   -------------------------------------------------------------*/
//   async lookupFallback(upc: string) {
//     try {
//       const res = await fetch(`https://barcodes1.p.rapidapi.com/?upc=${upc}`, {
//         headers: {
//           'X-RapidAPI-Key': process.env.RAPIDAPI_KEY ?? '',
//           'X-RapidAPI-Host': 'barcodes1.p.rapidapi.com',
//         },
//       });

//       const json = await res.json();
//       const product = json?.product ?? {};

//       return {
//         name: product.title || json.title || 'Unknown product',
//         brand: product.brand || json.brand || 'Unknown brand',
//         image: product.image || json.image || null,
//         category: product.category || 'Uncategorized',
//         source: 'rapidapi',
//       };
//     } catch (err: any) {
//       console.error('❌ lookupFallback failed:', err.message);
//       return { name: null, brand: null, image: null, category: null };
//     }
//   }

//   /* ------------------------------------------------------------
//      🤖 AI Fallback Guess
//   -------------------------------------------------------------*/
//   async lookupFallbackWithAI(upc: string) {
//     try {
//       const prompt = `
//       The barcode number is: ${upc}.
//       Guess the product based on global manufacturer codes.
//       Return valid JSON only:
//       {"name":"Example Product","brand":"Brand","category":"Category"}
//       `;

//       const completion = await this.openai.chat.completions.create({
//         model: 'gpt-4o-mini',
//         messages: [{ role: 'user', content: prompt }],
//         max_tokens: 150,
//       });

//       let text = completion.choices?.[0]?.message?.content?.trim() || '{}';
//       text = text.replace(/```json|```/g, '').trim();

//       let parsed: any;
//       try {
//         parsed = JSON.parse(text);
//       } catch {
//         parsed = {
//           name:
//             text.replace(/["{}]/g, '').split(',')[0]?.trim() ||
//             'Unknown product',
//           brand: 'Unknown',
//           category: 'Misc',
//         };
//       }

//       return {
//         name: parsed.name || 'Unknown product',
//         brand: parsed.brand || 'Unknown',
//         category: parsed.category || 'Misc',
//         source: 'ai-fallback',
//       };
//     } catch (err: any) {
//       console.error('❌ AI fallback failed:', err.message);
//       return {
//         name: 'Unknown product',
//         brand: 'Unknown',
//         category: 'Uncategorized',
//         source: 'ai-fallback',
//       };
//     }
//   }
// }

////////////////

// import { Injectable, BadRequestException } from '@nestjs/common';
// import OpenAI from 'openai';
// import { ChatDto } from './dto/chat.dto';
// import { VertexService } from '../vertex/vertex.service'; // 🔹 ADDED
// import { ProductSearchService } from '../product-services/product-search.service';
// import { Pool } from 'pg';
// import { Express } from 'express';
// import { redis } from '../utils/redisClient';

// const pool = new Pool({
//   connectionString: process.env.DATABASE_URL,
//   ssl: { rejectUnauthorized: false },
// });

// import * as fs from 'fs';
// import * as path from 'path';
// import * as dotenv from 'dotenv';

// function loadOpenAISecrets(): {
//   apiKey?: string;
//   project?: string;
//   source: string;
// } {
//   const candidates = [
//     path.join(process.cwd(), '.env'),
//     path.join(process.cwd(), 'apps', 'backend-nest', '.env'),
//     path.join(__dirname, '..', '..', '.env'),
//   ];

//   for (const p of candidates) {
//     try {
//       if (fs.existsSync(p)) {
//         const parsed = dotenv.parse(fs.readFileSync(p));
//         const apiKey = parsed['OPENAI_API_KEY'];
//         const project = parsed['OPENAI_PROJECT_ID'];
//         if (apiKey) return { apiKey, project, source: p };
//       }
//     } catch {
//       // ignore
//     }
//   }

//   return {
//     apiKey: process.env.OPENAI_API_KEY,
//     project: process.env.OPENAI_PROJECT_ID,
//     source: 'process.env',
//   };
// }

// // 🧥 Basic capsule wardrobe templates
// const CAPSULES = {
//   Spring: [
//     { category: 'Outerwear', subcategory: 'Light Jacket', recommended: 2 },
//     { category: 'Tops', subcategory: 'Oxford Shirt', recommended: 3 },
//     { category: 'Bottoms', subcategory: 'Chinos', recommended: 2 },
//     { category: 'Shoes', subcategory: 'Loafers', recommended: 1 },
//     { category: 'Shoes', subcategory: 'Sneakers', recommended: 1 },
//   ],
//   Summer: [
//     { category: 'Tops', subcategory: 'Short Sleeve Shirt', recommended: 4 },
//     { category: 'Tops', subcategory: 'Polo Shirt', recommended: 2 },
//     { category: 'Bottoms', subcategory: 'Linen Trousers', recommended: 2 },
//     { category: 'Shoes', subcategory: 'Loafers', recommended: 1 },
//     { category: 'Shoes', subcategory: 'Sandals', recommended: 1 },
//   ],
//   Fall: [
//     { category: 'Outerwear', subcategory: 'Field Jacket', recommended: 1 },
//     { category: 'Outerwear', subcategory: 'Blazer', recommended: 1 },
//     { category: 'Tops', subcategory: 'Knit Sweater', recommended: 2 },
//     { category: 'Bottoms', subcategory: 'Wool Trousers', recommended: 2 },
//     { category: 'Shoes', subcategory: 'Chelsea Boots', recommended: 1 },
//   ],
//   Winter: [
//     { category: 'Outerwear', subcategory: 'Overcoat', recommended: 1 },
//     { category: 'Outerwear', subcategory: 'Heavy Parka', recommended: 1 },
//     { category: 'Tops', subcategory: 'Heavy Knit Sweater', recommended: 2 },
//     { category: 'Bottoms', subcategory: 'Wool Trousers', recommended: 2 },
//     { category: 'Shoes', subcategory: 'Boots', recommended: 2 },
//   ],
// };

// // 🗓️ Auto-detect season based on month
// function getCurrentSeason(): 'Spring' | 'Summer' | 'Fall' | 'Winter' {
//   const month = new Date().getMonth() + 1;
//   if ([3, 4, 5].includes(month)) return 'Spring';
//   if ([6, 7, 8].includes(month)) return 'Summer';
//   if ([9, 10, 11].includes(month)) return 'Fall';
//   return 'Winter';
// }

// // 🧠 Compare wardrobe to capsule and return simple forecast text
// function generateSeasonalForecast(wardrobe: any[] = []): string | undefined {
//   const season = getCurrentSeason();
//   const capsule = CAPSULES[season];
//   if (!capsule) return;

//   const missing: string[] = [];

//   capsule.forEach((item) => {
//     const owned = wardrobe.filter(
//       (w) =>
//         w.category?.toLowerCase() === item.category.toLowerCase() &&
//         w.subcategory?.toLowerCase() === item.subcategory.toLowerCase(),
//     ).length;

//     if (owned < item.recommended) {
//       const needed = item.recommended - owned;
//       missing.push(`${needed} × ${item.subcategory}`);
//     }
//   });

//   if (missing.length === 0) {
//     return `✅ Your ${season} capsule is complete — you're ready for the season.`;
//   }

//   return `🍂 ${season} is approaching — you're missing: ${missing.join(', ')}.`;
// }

// // 🌦️ Weather fetching helper for AI context
// async function fetchWeatherForAI(
//   lat: number,
//   lon: number,
// ): Promise<{
//   tempF: number;
//   humidity: number;
//   windSpeed: number;
//   weatherCode: number;
//   condition: string;
// } | null> {
//   try {
//     const apiKey = process.env.TOMORROW_API_KEY;
//     if (!apiKey) {
//       console.warn('⚠️ TOMORROW_API_KEY not set - weather unavailable for AI');
//       return null;
//     }
//     const url = `https://api.tomorrow.io/v4/weather/realtime?location=${lat},${lon}&apikey=${apiKey}`;
//     const res = await fetch(url);
//     if (!res.ok) return null;
//     const data = await res.json();
//     const values = data?.data?.values;
//     if (!values) return null;

//     // Map weather codes to conditions
//     const weatherConditions: Record<number, string> = {
//       1000: 'Clear/Sunny',
//       1100: 'Mostly Clear',
//       1101: 'Partly Cloudy',
//       1102: 'Mostly Cloudy',
//       1001: 'Cloudy',
//       2000: 'Fog',
//       4000: 'Drizzle',
//       4001: 'Rain',
//       4200: 'Light Rain',
//       4201: 'Heavy Rain',
//       5000: 'Snow',
//       5001: 'Flurries',
//       5100: 'Light Snow',
//       5101: 'Heavy Snow',
//       6000: 'Freezing Drizzle',
//       6001: 'Freezing Rain',
//       7000: 'Ice Pellets',
//       7101: 'Heavy Ice Pellets',
//       7102: 'Light Ice Pellets',
//       8000: 'Thunderstorm',
//     };

//     return {
//       tempF: Math.round((values.temperature * 9) / 5 + 32),
//       humidity: Math.round(values.humidity),
//       windSpeed: Math.round(values.windSpeed),
//       weatherCode: values.weatherCode,
//       condition: weatherConditions[values.weatherCode] || 'Unknown',
//     };
//   } catch (err: any) {
//     console.warn('⚠️ Weather fetch failed:', err.message);
//     return null;
//   }
// }

// @Injectable()
// export class AiService {
//   private openai: OpenAI;
//   private useVertex: boolean;
//   private vertexService?: VertexService; // 🔹 optional instance
//   private productSearch: ProductSearchService; // ✅ add this
//   // 🧠 Fast in-memory cache for repeated TTS phrases
//   private ttsCache = new Map<string, Buffer>();

//   constructor(vertexService?: VertexService) {
//     const { apiKey, project, source } = loadOpenAISecrets();

//     const snippet = apiKey?.slice(0, 20) ?? '';
//     const len = apiKey?.length ?? 0;
//     console.log('🔑 OPENAI key source:', source);
//     console.log('🔑 OPENAI key snippet:', JSON.stringify(snippet));
//     console.log('🔑 OPENAI key length:', len);
//     console.log('📂 CWD:', process.cwd());

//     if (!apiKey) {
//       throw new Error('OPENAI_API_KEY not found in .env or environment.');
//     }
//     if (/^sk-?x{3,}/i.test(apiKey)) {
//       throw new Error(
//         'OPENAI_API_KEY appears masked (e.g., "sk-xxxxx..."). Read from the correct .env instead.',
//       );
//     }
//     if (!apiKey.startsWith('sk-')) {
//       throw new Error('OPENAI_API_KEY is malformed — must start with "sk-".');
//     }

//     this.openai = new OpenAI({ apiKey, project });

//     // 🔹 New: Vertex toggle
//     this.useVertex = process.env.USE_VERTEX === 'true';
//     if (this.useVertex) {
//       this.vertexService = vertexService;
//       console.log('🧠 Vertex/Gemini mode enabled for analyze/recreate');
//     }

//     this.productSearch = new ProductSearchService(); // NEW
//   }

//   // async generateSpeechBuffer(text: string): Promise<Buffer> {
//   //   if (!text?.trim()) throw new BadRequestException('Empty text');

//   //   // 👇 bypass outdated type definition safely
//   //   const resp = await this.openai.audio.speech.create({
//   //     model: 'gpt-4o-mini-tts',
//   //     voice: 'alloy',
//   //     input: text,

//   //     format: 'mp3',
//   //   } as any);

//   //   const arrayBuf = await resp.arrayBuffer();
//   //   return Buffer.from(arrayBuf);
//   // }

//   /** 🎙️ Generate Alloy voice speech (cached + streamable) */
//   async generateSpeechBuffer(text: string): Promise<Buffer> {
//     if (!text?.trim()) throw new BadRequestException('Empty text');

//     // 🧠 Cache key (base64 of text)
//     const cacheKey = Buffer.from(text).toString('base64').slice(0, 40);
//     if (this.ttsCache.has(cacheKey)) {
//       console.log('💾 [TTS] cache hit:', text.slice(0, 60));
//       return this.ttsCache.get(cacheKey)!;
//     }

//     console.log('🎤 [TTS] generating voice:', text.slice(0, 80));

//     // ✅ bypass type errors safely
//     const resp: any = await (this.openai as any).audio.speech.create(
//       {
//         model: 'gpt-4o-mini-tts',
//         voice: 'alloy',
//         input: text,
//         format: 'mp3',
//       },
//       { responseType: 'stream' }, // runtime param (missing from types)
//     );

//     const stream: NodeJS.ReadableStream = resp.data;
//     const chunks: Buffer[] = [];

//     for await (const chunk of stream) {
//       // 👇 Normalize chunk type (handles both string and Uint8Array)
//       chunks.push(
//         typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk),
//       );
//     }

//     const buffer = Buffer.concat(chunks);
//     this.ttsCache.set(cacheKey, buffer);

//     return buffer;
//   }

//   //  'alloy','ash','ballad','coral','echo','fable','nova','onyx','sage','shimmer','verse'

//   /** 🎧 Stream version for immediate browser playback */
//   async generateSpeechStream(text: string) {
//     if (!text?.trim()) throw new BadRequestException('Empty text');

//     const response = await this.openai.audio.speech.create({
//       model: 'gpt-4o-mini-tts',
//       voice: 'coral',
//       input: text,
//       format: 'mp3',
//       stream: true, // <—— critical flag for live stream
//       // 🔧 optional fine-tuning parameters:
//       speed: 1.0, // 1.0 = normal, higher = faster, 0.8 = slower
//       pitch: 1.0, // 1.0 = default, higher = brighter tone
//     } as any);

//     // ✅ Return the WebReadableStream
//     return response.body;
//   }

//   //////ANALYZE LOOK

//   async analyze(imageUrl: string) {
//     console.log('🧠 [AI] analyze() called with', imageUrl);
//     if (!imageUrl) throw new Error('Missing imageUrl');

//     // 🔹 Try Vertex first if enabled
//     if (this.useVertex && this.vertexService) {
//       try {
//         const gcsUri = imageUrl.replace(
//           'https://storage.googleapis.com/',
//           'gs://',
//         );
//         const metadata = await this.vertexService.analyzeImage(gcsUri);
//         const tags = [
//           ...(metadata.tags || []),
//           ...(metadata.style_descriptors || []),
//           metadata.main_category,
//           metadata.subcategory,
//         ].filter(Boolean);
//         console.log('🧠 [Vertex] analyze() success:', tags);
//         return { tags };
//       } catch (err: any) {
//         console.warn(
//           '[Vertex] analyze() failed → fallback to OpenAI:',
//           err.message,
//         );
//       }
//     }

//     // 🔸 OpenAI fallback
//     try {
//       const completion = await this.openai.chat.completions.create({
//         model: 'gpt-4o-mini',
//         messages: [
//           {
//             role: 'system',
//             content:
//               'You are a professional fashion classifier. Return only JSON with a "tags" array describing the outfit’s style, color palette, and vibe.',
//           },
//           {
//             role: 'user',
//             content: [
//               { type: 'text', text: 'Describe this outfit as tags only:' },
//               { type: 'image_url', image_url: { url: imageUrl } },
//             ],
//           },
//         ],
//         response_format: { type: 'json_object' },
//       });

//       const raw = completion.choices[0]?.message?.content;
//       console.log('🧠 [AI] analyze() raw response:', raw);

//       if (!raw) throw new Error('Empty response from OpenAI');
//       const parsed = JSON.parse(raw || '{}');
//       return { tags: parsed.tags || [] };
//     } catch (err: any) {
//       console.error('❌ [AI] analyze() failed:', err.message);
//       return { tags: ['casual', 'modern', 'neutral'] };
//     }
//   }

//   /* ------------------------------------------------------------
//      🧩 Weighted Tag Enrichment + Trend Injection
//   -------------------------------------------------------------*/
//   private async enrichTags(tags: string[]): Promise<string[]> {
//     const weightMap: Record<string, number> = {
//       tailored: 3,
//       minimal: 3,
//       neutral: 3,
//       modern: 2,
//       vintage: 2,
//       classic: 2,
//       streetwear: 2,
//       oversized: 2,
//       slim: 2,
//       relaxed: 2,
//       casual: 1,
//       sporty: 1,
//     };

//     // 🧹 Normalize + de-dupe
//     const cleanTags = Array.from(
//       new Set(
//         tags
//           .map((t) => t.toLowerCase().trim())
//           .filter((t) => t && !['outfit', 'style', 'fashion'].includes(t)),
//       ),
//     );

//     // 🧠 Apply weights
//     const weighted = cleanTags
//       .map((t) => ({ tag: t, weight: weightMap[t] || 1 }))
//       .sort((a, b) => b.weight - a.weight);

//     // 🌍 Inject current trend tags
//     const trendTags = await this.fetchTrendTags();
//     const final = Array.from(
//       new Set([...weighted.map((w) => w.tag), ...trendTags.slice(0, 3)]),
//     );

//     console.log('🎯 [AI] Enriched tags →', final);
//     return final;
//   }

//   private async fetchTrendTags(): Promise<string[]> {
//     try {
//       const res = await fetch(
//         'https://trends.google.com/trends/hottrends/visualize/internal/data/en_us',
//       );
//       if (!res.ok) throw new Error(`HTTP ${res.status}`);
//       const json = await res.json().catch(() => []);
//       const trendWords = JSON.stringify(json).toLowerCase();
//       const matched = trendWords.match(
//         /(quiet luxury|monochrome|minimalism|maximalism|italian|tailoring|loafers|neutrals|linen|structured|preppy|flannel|earth tones|autumn layering)/gi,
//       );
//       if (matched?.length) return Array.from(new Set(matched));

//       // 🧭 If Google Trends returned empty, use local backup
//       return [
//         'quiet luxury',
//         'neutral tones',
//         'tailored fit',
//         'autumn layering',
//       ];
//     } catch (err: any) {
//       console.warn('⚠️ Trend fetch fallback triggered:', err.message);
//       return [
//         'quiet luxury',
//         'neutral tones',
//         'tailored fit',
//         'autumn layering',
//       ];
//     }
//   }

//   // RECREATE//////////////
//   async recreate(
//     user_id: string,
//     tags: string[],
//     image_url?: string,
//     user_gender?: string,
//   ) {
//     console.log(
//       '🧥 [AI] recreate() called for user',
//       user_id,
//       'with tags:',
//       tags,
//       'and gender:',
//       user_gender,
//     );

//     if (!user_id) throw new Error('Missing user_id');
//     if (!tags?.length) {
//       console.warn('⚠️ [AI] recreate() empty tags → using defaults.');
//       tags = ['modern', 'neutral', 'tailored'];
//     }

//     // ✅ Weighted + trend-injected tags
//     tags = await this.enrichTags(tags);

//     // 🧠 Fetch gender_presentation if missing
//     if (!user_gender) {
//       try {
//         const result = await pool.query(
//           'SELECT gender_presentation FROM users WHERE id = $1 LIMIT 1',
//           [user_id],
//         );
//         user_gender = result.rows[0]?.gender_presentation || 'neutral';
//       } catch {
//         user_gender = 'neutral';
//       }
//     }

//     // 🧩 Normalize gender
//     const normalizedGender =
//       user_gender?.toLowerCase().includes('female') ||
//       user_gender?.toLowerCase().includes('woman')
//         ? 'female'
//         : user_gender?.toLowerCase().includes('male') ||
//             user_gender?.toLowerCase().includes('man')
//           ? 'male'
//           : process.env.DEFAULT_GENDER || 'neutral';

//     // 🧠 Build stylist prompt (base)
//     let prompt = `
//         You are a world-class AI stylist for ${normalizedGender} fashion.
//         Create a cohesive outfit inspired by an uploaded look.

//         Client: ${user_id}
//         Image: ${image_url || 'N/A'}
//         Detected tags: ${tags.join(', ')}

//         Rules:
//         - Match fabric, color palette, and silhouette.
//         - Use ${normalizedGender}-appropriate pieces.
//         - Output only JSON:
//         {
//           "outfit": [
//             { "category": "Top", "item": "Grey Cotton Tee", "color": "gray" },
//             { "category": "Bottom", "item": "Navy Chinos", "color": "navy" },
//             { "category": "Outerwear", "item": "Beige Overshirt", "color": "beige" },
//             { "category": "Shoes", "item": "White Sneakers", "color": "white" }
//           ],
//           "style_note": "Describe how the look connects to the uploaded image."
//         }
//         `;

//     // 🔹 Pull soft profile context (optional)
//     let profileCtx = '';
//     try {
//       const res = await pool.query(
//         `SELECT favorite_colors, fit_preferences, preferred_brands, disliked_styles
//        FROM style_profiles WHERE user_id::text = $1 LIMIT 1`,
//         [user_id],
//       );
//       const prof = res.rows[0];
//       if (prof) {
//         profileCtx = `
//       # USER STYLE CONTEXT (soft influence)
//       • Preferred colors: ${(prof.favorite_colors || []).join(', ') || '—'}
//       • Fit preferences: ${(prof.fit_preferences || []).join(', ') || '—'}
//       • Favorite brands: ${(prof.preferred_brands || []).join(', ') || '—'}
//       • Disliked styles: ${prof.disliked_styles || '—'}
//       Do NOT override the image’s vibe — just bias tone/material choices if relevant.
//       `;
//       }
//     } catch {
//       /* silent fail */
//     }

//     // ✅ Final prompt (merge only if context exists)
//     // Inside recreate() or personalizedShop() final prompt:
//     const finalPrompt = `
// ${prompt}

// # HARD RULES
// - ALWAYS output a full outfit of at least 4–6 distinct pieces.
// - Include a Top, Bottom, Outerwear (if seasonally appropriate), Shoes, and optionally 1–2 Accessories.
// - NEVER omit items because they already exist in the user’s wardrobe.
// - Each piece should have its own JSON object, even if similar to a wardrobe item.
// - Always include color and fit for every item.
// `;

//     // 🧠 Generate outfit via Vertex or OpenAI
//     let parsed: any;
//     if (this.useVertex && this.vertexService) {
//       try {
//         const result =
//           await this.vertexService.generateReasonedOutfit(finalPrompt);
//         let text = result?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
//         text = text
//           .replace(/^```json\s*/i, '')
//           .replace(/```$/, '')
//           .trim();
//         parsed = JSON.parse(text);
//         console.log('🧠 [Vertex] recreate() success');
//       } catch (err: any) {
//         console.warn('[Vertex] recreate() failed → fallback', err.message);
//       }
//     }

//     if (!parsed) {
//       const completion = await this.openai.chat.completions.create({
//         model: 'gpt-4o-mini',
//         temperature: 0.7,
//         messages: [{ role: 'user', content: finalPrompt }],
//         response_format: { type: 'json_object' },
//       });

//       const raw = completion.choices[0]?.message?.content || '{}';
//       try {
//         parsed = JSON.parse(raw);
//       } catch {
//         parsed = {};
//       }
//     }

//     const outfit = Array.isArray(parsed?.outfit) ? parsed.outfit : [];
//     const style_note =
//       parsed?.style_note || 'Modern outfit inspired by the uploaded look.';

//     // 🛍️ Enrich each item with live products
//     const enriched = await Promise.all(
//       outfit.map(async (o: any) => {
//         const query =
//           `${normalizedGender} ${o.item || o.category || ''} ${o.color || ''}`.trim();
//         let products = await this.productSearch.search(query);
//         let top = products[0];

//         if (!top?.image || top.image.includes('No_image')) {
//           const serp = await this.productSearch.searchSerpApi(query);
//           if (serp?.[0]) top = { ...serp[0], source: 'SerpAPI' };
//         }

//         const materialHint =
//           query.match(/(wool|cotton|linen|leather|denim|polyester)/i)?.[0] ||
//           null;
//         const seasonalityHint =
//           query.match(/(summer|winter|fall|spring)/i)?.[0] ||
//           getCurrentSeason();
//         const fitHint =
//           query.match(/(slim|regular|relaxed|oversized|tailored)/i)?.[0] ||
//           'regular';

//         return {
//           category: o.category,
//           item: o.item,
//           color: o.color,
//           brand: top?.brand || 'Unknown',
//           price: top?.price || '—',
//           image:
//             top?.image && top.image.startsWith('http')
//               ? top.image
//               : 'https://upload.wikimedia.org/wikipedia/commons/a/ac/No_image_available.svg',
//           shopUrl:
//             top?.shopUrl ||
//             `https://www.google.com/search?q=${encodeURIComponent(query)}&tbm=shop`,
//           source: top?.source || 'ASOS / Fallback',
//           material: materialHint,
//           seasonality: seasonalityHint,
//           fit: fitHint,
//         };
//       }),
//     );

//     return { user_id, outfit: enriched, style_note };
//   }

//   // 🧩 Ensure every product object includes a usable image URL
//   private fixProductImages(products: any[] = []): any[] {
//     return products.map((prod) => ({
//       ...prod,
//       image:
//         prod.image ||
//         prod.image_url ||
//         prod.thumbnail ||
//         prod.serpapi_thumbnail || // ✅ added
//         prod.img ||
//         prod.picture ||
//         prod.thumbnail_url ||
//         'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg',
//     }));
//   }

//   // 👔 PERSONALIZED SHOP — image + wardrobe + preferences
//   async personalizedShop(
//     user_id: string,
//     image_url: string,
//     user_gender?: string,
//   ) {
//     if (!user_id || !image_url) throw new Error('Missing user_id or image_url');

//     /** -----------------------------------------------------------
//      * 🧠 buildProfileConstraints(profile)
//      * Converts full style_profiles record into explicit hard rules
//      * ---------------------------------------------------------- */
//     function buildProfileConstraints(profile: any): string {
//       if (!profile) return '';

//       const fit = Array.isArray(profile.fit_preferences)
//         ? profile.fit_preferences.join(', ')
//         : profile.fit_preferences;

//       const colors = Array.isArray(profile.favorite_colors)
//         ? profile.favorite_colors.join(', ')
//         : profile.favorite_colors;

//       const brands = Array.isArray(profile.preferred_brands)
//         ? profile.preferred_brands.join(', ')
//         : profile.preferred_brands;

//       const styles = [
//         ...(profile.style_keywords || []),
//         ...(profile.style_preferences || []),
//       ]
//         .filter(Boolean)
//         .join(', ');

//       const dislikes =
//         typeof profile.disliked_styles === 'string'
//           ? profile.disliked_styles
//           : (profile.disliked_styles || []).join(', ');

//       const climate = profile.climate || 'Temperate';
//       const goals = profile.goals || '';

//       // 🔹 Inject explicit hard “only color” or “except color” rule for the model itself
//       let colorRule = '';
//       if (profile.disliked_styles?.match(/only\s+(\w+)/i)) {
//         const onlyColor = profile.disliked_styles.match(/only\s+(\w+)/i)[1];
//         colorRule = `• Use ONLY ${onlyColor} items — all other colors are forbidden.`;
//       } else if (profile.disliked_styles?.match(/except\s+(\w+)/i)) {
//         const exceptColor = profile.disliked_styles.match(/except\s+(\w+)/i)[1];
//         colorRule = `• Exclude every color except ${exceptColor}.`;
//       }

//       // 🔹 Explicitly enforce fit preferences
//       let fitRule = '';
//       if (profile.fit_preferences?.length) {
//         fitRule = `• Allow ONLY these fits: ${profile.fit_preferences.join(
//           ', ',
//         )}; exclude all others.`;
//       }

//       return `
// # USER PROFILE CONSTRAINTS (Hard Rules)

// ${fitRule}
// ${colorRule}

// • Fit: ${fit || 'Regular fit'} — outfit items must match this silhouette; exclude all opposing fits.
// • Climate: ${climate} — use materials and layers appropriate to this temperature zone.
// • Preferred brands: ${brands || '—'} — bias all product searches toward these or comparable aesthetics.
// • Favorite colors: ${colors || '—'} — bias color palette to these tones; avoid disliked colors.
// • Disliked styles: ${dislikes || '—'} — exclude these aesthetics entirely.
// • Style & vibe keywords: ${styles || '—'} — reflect these qualities in overall tone and accessories.
// • Goals: ${goals}
// • Body & proportions: ${profile.body_type || '—'}, ${
//         profile.proportions || '—'
//       } — ensure silhouette and layering suit these proportions.
// • Skin tone / hair / eyes: ${profile.skin_tone || '—'}, ${
//         profile.hair_color || '—'
//       }, ${profile.eye_color || '—'} — choose tones that complement.
// `;
//     }

//     // 1) Analyze uploaded image
//     const analysis = await this.analyze(image_url);
//     const tags = analysis?.tags || [];

//     //   const { rows: wardrobe } = await pool.query(
//     //     `SELECT name, main_category AS category, subcategory, color, material
//     //  FROM wardrobe_items
//     //  WHERE user_id::text = $1
//     //  ORDER BY updated_at DESC
//     //  LIMIT 50`,
//     //     [user_id],
//     //   );

//     // 🚫 Skip wardrobe entirely for personalized mode
//     const wardrobe: any[] = [];

//     const prefRes = await pool.query(
//       `SELECT gender_presentation
//      FROM users
//      WHERE id = $1
//      LIMIT 1`,
//       [user_id],
//     );
//     const profile = prefRes.rows[0] || {};
//     const gender = user_gender || profile.gender_presentation || 'neutral';
//     // 2️⃣ Fetch user style profile (full data used for personalization)
//     const styleProfileRes = await pool.query(
//       `
//   SELECT
//     body_type,
//     skin_tone,
//     undertone,
//     climate,
//     favorite_colors,
//     disliked_styles,
//     style_keywords,
//     preferred_brands,
//     goals,
//     proportions,
//     hair_color,
//     eye_color,
//     height,
//     waist,
//     fit_preferences,
//     style_preferences
//   FROM style_profiles
//   WHERE user_id::text = $1
//   LIMIT 1
// `,
//       [user_id],
//     );

//     const styleProfile = styleProfileRes.rows[0] || {};

//     // 🔹 Build user filter preferences
//     const { preferFit, bannedWords } = buildUserFilter(styleProfile);

//     /* ------------------------------------------------------------
//    🎛️ VISUAL + STYLE FILTERING HELPERS
// -------------------------------------------------------------*/
//     const FIT_KEYWORDS = {
//       skinny: [/skinny/i, /super[- ]skinny/i, /spray[- ]on/i],
//       slim: [/slim/i],
//       tailored: [/tailored/i, /tapered/i],
//       relaxed: [/relaxed/i, /loose/i, /baggy/i, /wide[- ]leg/i],
//       oversized: [/oversized/i, /boxy/i],
//     };

//     function buildUserFilter(profile: any) {
//       const fitPrefs = (profile.fit_preferences || []).map((x: string) =>
//         x.toLowerCase(),
//       );
//       const disliked = (profile.disliked_styles || '')
//         .toLowerCase()
//         .split(/[,\s]+/)
//         .filter(Boolean);
//       const favColors = (profile.favorite_colors || []).map((x: string) =>
//         x.toLowerCase(),
//       );

//       const preferFit =
//         fitPrefs.find((f) => /(relaxed|loose|baggy|oversized|boxy)/.test(f)) ||
//         fitPrefs.find((f) => /(regular|tailored)/.test(f)) ||
//         fitPrefs[0] ||
//         null;

//       const banFits: string[] = [];
//       if (preferFit?.match(/relaxed|loose|baggy|oversized|boxy/))
//         banFits.push('skinny', 'slim');
//       else if (preferFit?.match(/skinny|slim/))
//         banFits.push('relaxed', 'baggy', 'oversized');

//       const bannedWords = [
//         ...disliked,
//         ...banFits,
//         ...(!favColors.includes('green') ? ['green'] : []),
//       ]
//         .filter(Boolean)
//         .map((x) => new RegExp(x, 'i'));

//       return { preferFit, bannedWords };
//     }

//     function enforceProfileFilters(
//       products: any[] = [],
//       preferFit?: string | null,
//       bannedWords: RegExp[] = [],
//     ) {
//       if (!products.length) return products;

//       return products
//         .filter((p) => {
//           const hay = `${p.title || ''} ${p.name || ''} ${p.description || ''}`;
//           return !bannedWords.some((rx) => rx.test(hay));
//         })
//         .sort((a, b) => {
//           if (!preferFit) return 0;
//           const aHit = FIT_KEYWORDS[preferFit]?.some((rx) =>
//             rx.test(`${a.title} ${a.name}`),
//           )
//             ? 1
//             : 0;
//           const bHit = FIT_KEYWORDS[preferFit]?.some((rx) =>
//             rx.test(`${b.title} ${b.name}`),
//           )
//             ? 1
//             : 0;
//           return bHit - aHit; // boost preferred fits
//         });
//     }

//     // 3) Ask model to split into "owned" vs "missing"

//     const climateNote = styleProfile.climate
//       ? `The user's climate is ${styleProfile.climate}.
//     If it is cold (like Polar or Cold), emphasize insulated materials, coats, layers, scarves, gloves, and boots.
//     If it is hot (like Tropical or Desert), emphasize breathable, lightweight fabrics and open footwear.`
//       : '';

//     // 🛍️ SHOPPING ASSISTANT: Fetch detailed wardrobe items for specific gap analysis
//     let wardrobeItems = [];
//     try {
//       const result = await pool.query(
//         `SELECT name, main_category, subcategory, color, material
//          FROM wardrobe_items
//          WHERE user_id::text = $1
//          ORDER BY main_category, updated_at DESC
//          LIMIT 200`,
//         [user_id],
//       );
//       wardrobeItems = result.rows || [];
//       console.log(
//         '🛍️ [personalizedShop] Wardrobe query executed:',
//         wardrobeItems.length,
//         'items found',
//       );
//     } catch (err) {
//       console.error('🛍️ [personalizedShop] ERROR fetching wardrobe:', err);
//       wardrobeItems = [];
//     }

//     // 🛍️ Build detailed wardrobe inventory with actual item names
//     const wardrobeByCategory = wardrobeItems.reduce((acc: any, item: any) => {
//       const category = item.main_category || 'Other';
//       if (!acc[category]) acc[category] = [];
//       acc[category].push({
//         name: item.name,
//         color: item.color,
//         material: item.material,
//         subcategory: item.subcategory,
//       });
//       return acc;
//     }, {});

//     // 🛍️ Format detailed inventory: show actual items user owns
//     const detailedInventory = Object.entries(wardrobeByCategory)
//       .map(([category, items]: [string, any]) => {
//         const itemList = items
//           .slice(0, 10) // Show top 10 items per category
//           .map((i: any) => `${i.name}${i.color ? ` (${i.color})` : ''}`)
//           .join(', ');
//         const moreCount =
//           items.length > 10 ? ` +${items.length - 10} more` : '';
//         return `• **${category}**: ${itemList}${moreCount}`;
//       })
//       .join('\n');

//     // 🛍️ Count by category to identify major gaps
//     const categoryStats = Object.entries(wardrobeByCategory)
//       .map(([cat, items]: [string, any]) => `${cat} (${items.length})`)
//       .join(', ');

//     const wardrobeContext = `# CRITICAL: SPECIFIC, PERSONALIZED RECOMMENDATIONS ONLY
// NEVER make generic suggestions. ALWAYS be specific about WHY each item is needed.

// ${
//   wardrobeItems.length > 0
//     ? `## USER'S EXISTING WARDROBE - SPECIFIC ITEMS & QUANTITIES
// Category totals: ${categoryStats}

// Actual items owned:
// ${detailedInventory}

// REFERENCE ACTUAL ITEMS: Name specific pieces from their wardrobe in your reasons.`
//     : `## NO WARDROBE DATA AVAILABLE YET
// The user has not yet added items to their wardrobe. STILL be specific by:
// - Referencing the uploaded image aesthetic
// - Referencing their stated style preferences and goals
// - Suggesting items that fill SPECIFIC functional gaps (e.g., "You have no layering pieces")
// - Being explicit about COLOR, MATERIAL, and FIT choices`
// }

// ## MANDATORY SPECIFICITY RULES FOR ALL RECOMMENDATIONS:
// 1. EVERY recommendation MUST state WHY it's needed (avoid generic words like "elevates" or "completes")
//    ✓ GOOD: "Adds neutral bottoms in cotton - all your existing pieces are dark structured items"
//    ✓ GOOD: "For layering in moderate weather - fills temperature transition gap"
//    ✗ BAD: "Elevates your wardrobe"
//    ✗ BAD: "Completes your basics"

// 2. REFERENCE THE UPLOADED IMAGE in your reasoning:
//    ✓ "Complements the [specific color/style] aesthetic from your image"
//    ✓ "Works with the [silhouette] style you showed interest in"

// 3. BE SPECIFIC ABOUT USE CASE:
//    ✓ "For [occasion/weather/activity]"
//    ✓ "Pairs with [type of items most people own]"
//    ✗ "Just adds to your collection"

// 4. MENTION SPECIFIC COLORS/MATERIALS/FIT:
//    ✓ "Adds [specific color] in [material] which [specific reason]"
//    ✓ "Camel-toned [fit] [garment] for [climate/use]"

// ## EXAMPLE GOOD REASONS:
// - "Neutral base layer in cream linen for the minimalist aesthetic you showed"
// - "Adds breathable layering piece in cotton for warm weather - pairs with your smart-casual style"
// - "Complements the crisp formal vibe of your image; adds structured elegance"
// - "Provides casual footwear in canvas - versatile neutral that works with most styles"`;

//     // 🔒 Enforced personalization hierarchy
//     const rules = `
//     # PERSONALIZATION ENFORCEMENT
//     Follow these user preferences as *absolute constraints*, not suggestions.
//     `;

//     const profileConstraints = buildProfileConstraints(styleProfile);

//     const prompt = `
// You are a world-class personal stylist analyzing user's wardrobe gaps and recommending strategic purchases.
// ${rules}
// ${profileConstraints}

// # IMAGE INSPIRATION
// • Use the uploaded image as inspiration for aesthetic direction (color story, silhouette, vibe).
// • Respect all style profile constraints exactly.
// • Maintain the same mood and spirit as the uploaded image.

// ${wardrobeContext}

// # STRATEGIC SHOPPING RECOMMENDATIONS - MUST BE SPECIFIC
// For EACH recommendation, you MUST:
// 1. Reference 2-3 actual items from their wardrobe by NAME (e.g., "pairs with the gray cardigans")
// 2. State the SPECIFIC GAP you're filling (e.g., "you have 12 tops but only 3 bottoms")
// 3. Name the CATEGORY imbalance (e.g., "all your pants are dark - this adds a neutral option")
// 4. Explain what they'll USE it WITH (e.g., "complements your existing navy blazer collection")

// CRITICAL: NO VAGUE REASONS. These are REQUIRED:
// ❌ WRONG: "Elevates your wardrobe"
// ✅ RIGHT: "Works with your navy blazers and black pants; adds the warm-toned bottom option you lack"

// ❌ WRONG: "Completes your basics"
// ✅ RIGHT: "You own 8 tops (grays, blacks, white) but only 2 bottoms - this adds jean variety"

// ❌ WRONG: "Fills a style gap"
// ✅ RIGHT: "Your wardrobe is mostly structured pieces (blazers, cardigans) - this adds the relaxed layer you need"

// # OUTPUT RULES
// - ALWAYS output a complete outfit with distinct Top, Bottom, Shoes, and (if seasonally appropriate) Outerwear and Accessories.
// - Each piece must include category, item, color, fit, and a SPECIFIC reason
// - suggested_purchases reasons MUST name actual wardrobe items and specific gaps
// - gap_analysis must list 2-3 concrete imbalances found in their wardrobe

// Return ONLY valid JSON:
// {
//   "recreated_outfit": [
//     { "source":"purchase", "category":"Top", "item":"...", "color":"...", "fit":"..." }
//   ],
//   "suggested_purchases": [
//     { "category":"...", "item":"...", "color":"...", "material":"...", "brand":"...", "fit":"...", "reason":"Why this fills a gap or completes their style", "shopUrl":"..." }
//   ],
//   "style_note": "Explain the gap analysis, what's missing from their wardrobe, and how these purchases strengthen their styling foundation.",
//   "gap_analysis": "Concise summary of 2-3 key wardrobe gaps being addressed"
// }

// User gender: ${gender}
// Detected tags (inspiration from uploaded look): ${tags.join(', ')}
// User style profile: ${JSON.stringify(styleProfile, null, 2)}
// ${climateNote}
// `;

//     console.log('🧥 [personalizedShop] profile:', profile);
//     console.log('🧥 [personalizedShop] gender:', gender);
//     console.log('🧥 [personalizedShop] styleProfile:', styleProfile);
//     console.log('🛍️ [personalizedShop] WARDROBE DATA SENT TO AI:');
//     console.log('   Category totals:', categoryStats);
//     console.log('   Items found:', wardrobeItems.length);
//     if (wardrobeItems.length > 0) {
//       console.log(
//         '   Sample items:',
//         wardrobeItems
//           .slice(0, 5)
//           .map((w: any) => `${w.name} (${w.color})`)
//           .join(', '),
//       );
//     }
//     console.log('🧠 [personalizedShop] Prompt preview:', prompt.slice(0, 800));

//     // 🧠 DEBUG START — prompt verification
//     console.log('─────────────── PROMPT SENT TO MODEL ───────────────');
//     console.log(prompt);
//     console.log('─────────────── END PROMPT ───────────────');

//     const completion = await this.openai.chat.completions.create({
//       model: 'gpt-4o-mini',
//       temperature: 0.7,
//       messages: [{ role: 'user', content: prompt }],
//       response_format: { type: 'json_object' },
//     });

//     // 🧠 DEBUG END — raw model output
//     console.log('─────────────── RAW MODEL RESPONSE ───────────────');
//     console.log(completion.choices[0]?.message?.content);
//     console.log('─────────────── END RESPONSE ───────────────');

//     let parsed: any = {};
//     try {
//       parsed = JSON.parse(completion.choices[0]?.message?.content || '{}');

//       // 🧩 SAFETY GUARD — ensure we keep valid recreated_outfit
//       try {
//         const parsedKeys = Object.keys(parsed);
//         console.log('✅ [personalizedShop] Parsed JSON keys:', parsedKeys);

//         // If model used "outfit" instead of "recreated_outfit", normalize it
//         if (!parsed.recreated_outfit && parsed.outfit) {
//           parsed.recreated_outfit = parsed.outfit;
//           console.log('✅ [personalizedShop] Mapped outfit → recreated_outfit');
//         }

//         // Double-check array validity before fallback clears it
//         if (parsed.recreated_outfit && parsed.recreated_outfit.length > 0) {
//           console.log(
//             '✅ [personalizedShop] Using recreated_outfit from model',
//           );
//         } else {
//           console.warn(
//             '⚠️ [personalizedShop] No recreated_outfit found — fallback may trigger',
//           );
//         }
//       } catch (err) {
//         console.error(
//           '❌ [personalizedShop] JSON structure guard failed:',
//           err,
//         );
//       }

//       // ✅ Final filter fix — keep wardrobe items but still respect banned fits/styles
//       if (parsed?.recreated_outfit?.length) {
//         parsed.recreated_outfit = parsed.recreated_outfit.filter((o: any) => {
//           if (!o) return false;
//           const text =
//             `${o.item} ${o.category} ${o.color} ${o.fit}`.toLowerCase();
//           if (!text.trim() || text.includes('undefined')) return false;
//           // ✅ Always keep wardrobe items regardless of style bans
//           if (o.source === 'wardrobe') return true;

//           const fitBan = preferFit?.match(/relaxed|oversized|boxy|loose/)
//             ? ['skinny']
//             : preferFit?.match(/skinny|slim|tailored/)
//               ? ['relaxed', 'baggy', 'oversized']
//               : [];

//           const styleBan =
//             (styleProfile.disliked_styles || '')
//               .toLowerCase()
//               .split(/[,\s]+/)
//               .filter(Boolean) || [];

//           const banned = [...fitBan, ...styleBan];
//           return !banned.some((b) => text.includes(b));
//         });

//         console.log(
//           '✅ [personalizedShop] Final filtered outfit →',
//           parsed.recreated_outfit,
//         );
//       }

//       console.log(
//         '💎 [personalizedShop] Parsed recreated outfit sample:',
//         parsed?.recreated_outfit?.slice(0, 2),
//       );
//       console.log(
//         '💎 [personalizedShop] Parsed suggested purchases sample:',
//         parsed?.suggested_purchases?.slice(0, 2),
//       );

//       // 🧩 Merge recreated_outfit into suggested_purchases for display
//       if (
//         Array.isArray(parsed?.recreated_outfit) &&
//         parsed.recreated_outfit.length
//       ) {
//         parsed.suggested_purchases = [
//           ...(parsed.suggested_purchases || []),
//           ...parsed.recreated_outfit.map((o: any) => ({
//             ...o,
//             brand: o.brand || '—',
//             previewImage: o.previewImage || o.image || o.image_url || null,
//             source: 'purchase',
//           })),
//         ];
//         console.log(
//           '🧩 [personalizedShop] merged recreated_outfit → suggested_purchases',
//         );
//       }

//       // 🖼️ Ensure every recreated outfit item has a visible preview image
//       if (Array.isArray(parsed?.recreated_outfit)) {
//         parsed.recreated_outfit = parsed.recreated_outfit.map((item: any) => {
//           if (!item.previewImage && item.source === 'wardrobe') {
//             item.previewImage =
//               item.image_url ||
//               item.wardrobe_image ||
//               'https://upload.wikimedia.org/wikipedia/commons/a/ac/No_image_available.svg';
//           }
//           return item;
//         });
//       }

//       // 🎨 Enforce "only <color>" rule from disliked_styles (e.g. "I dislike all colors except pink")
//       // 🎨 Optional color-only enforcement — only if explicit "ONLY <color>" flag exists
//       if (styleProfile?.disliked_styles?.toLowerCase().includes('only')) {
//         const match = styleProfile.disliked_styles.match(/only\s+(\w+)/i);
//         if (match) {
//           const onlyColor = match[1].toLowerCase();
//           const filterColor = (arr: any[]) =>
//             arr.filter((x) =>
//               (x.color || '').toLowerCase().includes(onlyColor),
//             );

//           if (Array.isArray(parsed?.recreated_outfit))
//             parsed.recreated_outfit = filterColor(parsed.recreated_outfit);
//           if (Array.isArray(parsed?.suggested_purchases))
//             parsed.suggested_purchases = filterColor(
//               parsed.suggested_purchases,
//             );

//           console.log(
//             `[personalizedShop] 🎨 Enforcing ONLY-color rule: ${onlyColor}`,
//           );
//         }
//       }
//     } catch {
//       parsed = {};
//     }

//     const purchases = Array.isArray(parsed?.suggested_purchases)
//       ? parsed.suggested_purchases
//       : [];

//     if (parsed?.recreated_outfit?.some((i: any) => i.source === 'wardrobe')) {
//       console.log('🧥 [personalizedShop] ✅ Model reused wardrobe pieces.');
//     } else {
//       console.warn(
//         '🧥 [personalizedShop] ⚠️ Model did NOT reuse wardrobe — fallback to generic recreation.',
//       );
//     }

//     // 🚫 Enforce profile bans in returned outfit
//     const banned = [
//       ...(styleProfile.disliked_styles?.toLowerCase().split(/[,\s]+/) || []),
//       ...(preferFit?.match(/relaxed|oversized|boxy|loose/)
//         ? ['skinny', 'slim']
//         : []),
//       ...(preferFit?.match(/skinny|slim/)
//         ? ['relaxed', 'oversized', 'baggy']
//         : []),
//     ].filter(Boolean);

//     if (parsed?.recreated_outfit?.length) {
//       // ✅ Keep *all* wardrobe and purchase items — only filter garbage entries
//       parsed.recreated_outfit = parsed.recreated_outfit.filter((o: any) => {
//         if (!o || !o.item) return false;
//         const text =
//           `${o.item} ${o.category} ${o.color} ${o.fit}`.toLowerCase();
//         return text.trim().length > 0 && !text.includes('undefined');
//       });

//       // 🧱 Guarantee full outfit completeness (Top, Bottom, Shoes, Optional Outerwear/Accessory)
//       const categories = parsed.recreated_outfit.map((o: any) =>
//         o.category?.toLowerCase(),
//       );
//       const missing: any[] = [];

//       if (!categories.includes('top'))
//         missing.push({
//           source: 'purchase',
//           category: 'Top',
//           item: 'White Oxford Shirt',
//           color: 'White',
//           fit: 'Slim Fit',
//         });
//       if (!categories.includes('bottoms'))
//         missing.push({
//           source: 'purchase',
//           category: 'Bottoms',
//           item: 'Beige Chinos',
//           color: 'Beige',
//           fit: 'Slim Fit',
//         });
//       if (!categories.includes('shoes'))
//         missing.push({
//           source: 'purchase',
//           category: 'Shoes',
//           item: 'White Leather Sneakers',
//           color: 'White',
//           fit: 'Slim Fit',
//         });

//       parsed.recreated_outfit.push(...missing);

//       console.log(
//         '✅ [personalizedShop] Final full outfit →',
//         parsed.recreated_outfit,
//       );
//     }

//     // 🧩 Centralized enforcement for personalizedShop only
//     function applyProfileFilters(products: any[], profile: any) {
//       if (!Array.isArray(products) || !products.length) return [];

//       const favColors = (profile.favorite_colors || []).map((x: string) =>
//         x.toLowerCase(),
//       );
//       const prefBrands = (profile.preferred_brands || []).map((x: string) =>
//         x.toLowerCase(),
//       );
//       const fitPrefs = (profile.fit_preferences || []).map((x: string) =>
//         x.toLowerCase(),
//       );
//       const dislikes = (profile.disliked_styles || '')
//         .toLowerCase()
//         .split(/[,\s]+/);
//       const climate = (profile.climate || '').toLowerCase();

//       const isCold = /(polar|cold|arctic|tundra|winter)/.test(climate);
//       const isHot = /(tropical|desert|hot|humid|summer)/.test(climate);

//       // 🩷 detect "only" or "except" color rule from disliked_styles
//       let onlyColor: string | null = null;
//       let exceptColor: string | null = null;

//       if (profile.disliked_styles?.match(/only\s+(\w+)/i)) {
//         onlyColor = profile.disliked_styles
//           .match(/only\s+(\w+)/i)[1]
//           .toLowerCase();
//       } else if (profile.disliked_styles?.match(/except\s+(\w+)/i)) {
//         exceptColor = profile.disliked_styles
//           .match(/except\s+(\w+)/i)[1]
//           .toLowerCase();
//       }

//       return products
//         .filter((p) => {
//           const t = `${p.name ?? ''} ${p.title ?? ''} ${p.brand ?? ''} ${
//             p.description ?? ''
//           } ${p.color ?? ''} ${p.fit ?? ''}`.toLowerCase();

//           // 🚫 Filter out disliked words/styles
//           if (dislikes.some((d) => d && t.includes(d))) return false;

//           // 🎨 HARD color enforcement from DB rules
//           if (onlyColor) {
//             // Only allow if text or color includes the specified color
//             if (
//               !t.includes(onlyColor) &&
//               !p.color?.toLowerCase().includes(onlyColor)
//             )
//               return false;
//           } else if (exceptColor) {
//             // Exclude everything not matching that color
//             if (
//               !t.includes(exceptColor) &&
//               !p.color?.toLowerCase().includes(exceptColor)
//             )
//               return false;
//           } else {
//             // Normal favorite color bias if no hard rule
//             if (favColors.length && !favColors.some((c) => t.includes(c)))
//               return false;
//           }

//           // 👕 Fit preferences
//           if (fitPrefs.length && !fitPrefs.some((f) => t.includes(f)))
//             return false;

//           // 🌡️ Climate-based filtering
//           if (isCold && /(tank|shorts|sandal)/.test(t)) return false;
//           if (isHot && /(wool|parka|coat|boot|knit)/.test(t)) return false;

//           return true;
//         })
//         .sort((a, b) => {
//           const score = (x: any) => {
//             const txt =
//               `${x.name} ${x.title} ${x.brand} ${x.color} ${x.fit}`.toLowerCase();
//             let s = 0;
//             if (onlyColor && txt.includes(onlyColor)) s += 4;
//             if (exceptColor && txt.includes(exceptColor)) s += 4;
//             if (favColors.some((c) => txt.includes(c))) s += 2;
//             if (prefBrands.some((b) => txt.includes(b))) s += 2;
//             if (fitPrefs.some((f) => txt.includes(f))) s += 1;
//             return s;
//           };
//           return score(b) - score(a);
//         });
//     }

//     // 4️⃣ Attach live shop links to the "missing" items — now honoring user taste
//     let enrichedPurchases = await Promise.all(
//       purchases.map(async (p: any) => {
//         // 🧠 Gender-locked prefix
//         const genderPrefix =
//           gender?.toLowerCase().includes('female') ||
//           gender?.toLowerCase().includes('woman')
//             ? 'women female womens ladies'
//             : 'men male mens masculine -women -womens -female -girls -ladies';

//         // Base query with gender lock
//         let q = [
//           genderPrefix,
//           p.item || p.category || '',
//           p.color || '',
//           p.material || '',
//         ]
//           .filter(Boolean)
//           .join(' ')
//           .trim();

//         // 🔹 Inject personalization bias terms
//         const brandTerms = (styleProfile.preferred_brands || [])
//           .slice(0, 3)
//           .join(' ');
//         const colorTerms = (styleProfile.favorite_colors || [])
//           .slice(0, 2)
//           .join(' ');
//         const fitTerms = Array.isArray(styleProfile.fit_preferences)
//           ? styleProfile.fit_preferences.join(' ')
//           : styleProfile.fit_preferences || '';

//         // 🎨 “Only color” rule (e.g. “I dislike all colors except pink”)
//         const colorMatch =
//           styleProfile.disliked_styles?.match(/except\s+(\w+)/i);
//         if (colorMatch) {
//           const onlyColor = colorMatch[1].toLowerCase();
//           q += ` ${onlyColor}`;
//         }

//         // Combine into final query with brand + color + fit bias
//         q = [q, brandTerms, colorTerms, fitTerms].filter(Boolean).join(' ');

//         // 🔒 Ensure all queries exclude female results explicitly
//         if (
//           !/-(women|female|ladies|girls)/i.test(q) &&
//           /\bmen\b|\bmale\b/i.test(q)
//         ) {
//           q += ' -women -womens -female -girls -ladies';
//         }

//         // Combine into final query with brand + color + fit bias
//         q = [q, brandTerms, colorTerms, fitTerms].filter(Boolean).join(' ');

//         // 🔒 Ensure all queries exclude female results explicitly
//         if (
//           !/-(women|female|ladies|girls)/i.test(q) &&
//           /\bmen\b|\bmale\b/i.test(q)
//         ) {
//           q += ' -women -womens -female -girls -ladies';
//         }

//         // 🧠 Gender-aware product search
//         let products = await this.productSearch.search(
//           q,
//           gender?.toLowerCase() === 'female'
//             ? 'female'
//             : gender?.toLowerCase() === 'male'
//               ? 'male'
//               : 'unisex',
//         );

//         // 🚫 Filter out any accidental female/unisex results
//         products = products.filter(
//           (prod) =>
//             !/women|female|womens|ladies|girls/i.test(
//               `${prod.name ?? ''} ${prod.brand ?? ''} ${prod.title ?? ''}`,
//             ),
//         );

//         // 🩷 Hard visual color filter — ensures displayed products actually match the enforced color rule
//         if (
//           styleProfile?.disliked_styles?.match(/only\s+(\w+)/i) ||
//           styleProfile?.disliked_styles?.match(/except\s+(\w+)/i)
//         ) {
//           const match =
//             styleProfile.disliked_styles.match(/only\s+(\w+)/i) ||
//             styleProfile.disliked_styles.match(/except\s+(\w+)/i);
//           const enforcedColor = match?.[1]?.toLowerCase();
//           if (enforcedColor) {
//             products = products.filter((p) => {
//               const text =
//                 `${p.name ?? ''} ${p.title ?? ''} ${p.color ?? ''}`.toLowerCase();
//               return text.includes(enforcedColor);
//             });
//           }
//         }

//         return {
//           ...p,
//           query: q,
//           products: applyProfileFilters(products, styleProfile),
//         };
//       }),
//     );

//     // 5️⃣ Fallback enrichment if AI returned nothing or products failed
//     if (!enrichedPurchases.length) {
//       console.warn(
//         '⚠️ [personalizedShop] Empty suggested_purchases → fallback.',
//       );

//       const tagSeed = tags.slice(0, 6).join(' ');
//       const season = getCurrentSeason();

//       // 🧠 Gender prefix for fallback with hard lock
//       const genderPrefix =
//         gender?.toLowerCase().includes('female') ||
//         gender?.toLowerCase().includes('woman')
//           ? 'women female womens ladies'
//           : 'men male mens masculine -women -womens -female -girls -ladies';

//       // 🧠 Enrich fallback with style taste as well
//       const brandTerms = (styleProfile.preferred_brands || [])
//         .slice(0, 3)
//         .join(' ');
//       const colorTerms = (styleProfile.favorite_colors || [])
//         .slice(0, 2)
//         .join(' ');
//       const fitTerms = Array.isArray(styleProfile.fit_preferences)
//         ? styleProfile.fit_preferences.join(' ')
//         : styleProfile.fit_preferences || '';

//       const fallbackQuery = `${genderPrefix} ${tagSeed} ${season} fashion ${brandTerms} ${colorTerms} ${fitTerms}`;
//       console.log('🧩 [personalizedShop] fallbackQuery →', fallbackQuery);

//       const products = await this.productSearch.search(
//         fallbackQuery,
//         gender?.toLowerCase() === 'female'
//           ? 'female'
//           : gender?.toLowerCase() === 'male'
//             ? 'male'
//             : 'unisex',
//       );

//       // 🚫 Filter out any accidental female/unisex results
//       const maleProducts = products.filter(
//         (prod) =>
//           !/women|female|womens|ladies|girls/i.test(
//             `${prod.name ?? ''} ${prod.brand ?? ''} ${prod.title ?? ''}`,
//           ),
//       );

//       enrichedPurchases = [
//         {
//           category: 'General',
//           item: 'Curated Outfit Add-Ons',
//           color: 'Mixed',
//           material: null,
//           products: applyProfileFilters(maleProducts.slice(0, 8), styleProfile),
//           query: fallbackQuery,
//           source: 'fallback',
//         },
//       ];
//     }

//     // 🎨 Enforce color-only rule on fallback products too
//     if (styleProfile?.disliked_styles) {
//       const match = styleProfile.disliked_styles.match(/except\s+(\w+)/i);
//       if (match) {
//         const onlyColor = match[1].toLowerCase();
//         enrichedPurchases = enrichedPurchases.map((p) => ({
//           ...p,
//           products: (p.products || []).filter((prod) =>
//             (prod.color || '').toLowerCase().includes(onlyColor),
//           ),
//         }));
//         console.log(
//           `[personalizedShop] 🎨 Enforced fallback color-only rule: ${onlyColor}`,
//         );
//       }
//     }

//     const cleanPurchases = enrichedPurchases.map((p) => ({
//       ...p,
//       products: this.fixProductImages(
//         enforceProfileFilters(p.products || [], preferFit, bannedWords),
//       ),
//     }));

//     // 🎨 FINAL VISUAL CONSISTENCY NORMALIZATION
//     const normalizedPurchases = await Promise.all(
//       enrichedPurchases.map(async (p) => {
//         const validProduct =
//           (p.products || []).find(
//             (x) =>
//               (x.image ||
//                 x.image_url ||
//                 x.thumbnail ||
//                 x.serpapi_thumbnail ||
//                 x.thumbnail_url ||
//                 x.img ||
//                 x.result?.thumbnail ||
//                 x.result?.serpapi_thumbnail) &&
//               /^https?:\/\//.test(
//                 x.image ||
//                   x.image_url ||
//                   x.thumbnail ||
//                   x.serpapi_thumbnail ||
//                   x.thumbnail_url ||
//                   x.img ||
//                   x.result?.thumbnail ||
//                   x.result?.serpapi_thumbnail ||
//                   '',
//               ) &&
//               !/no[_-]?image/i.test(
//                 x.image ||
//                   x.image_url ||
//                   x.thumbnail ||
//                   x.serpapi_thumbnail ||
//                   x.thumbnail_url ||
//                   x.img ||
//                   '',
//               ),
//           ) || p.products?.[0];

//         let previewImage =
//           validProduct?.image ||
//           validProduct?.image_url ||
//           validProduct?.thumbnail ||
//           validProduct?.serpapi_thumbnail ||
//           validProduct?.thumbnail_url ||
//           validProduct?.img ||
//           validProduct?.product_thumbnail ||
//           validProduct?.result?.thumbnail ||
//           validProduct?.result?.serpapi_thumbnail ||
//           null;

//         // 🎯 Gender-aware image guard
//         const userGender = (gender || '').toLowerCase();

//         if (previewImage) {
//           const url = previewImage.toLowerCase();

//           // 🧍‍♂️ If male → block clearly female-coded URLs
//           if (
//             userGender.includes('male') &&
//             /(women|woman|female|ladies|girls|womenswear|femme|skims|shein|fashionnova|princesspolly|revolve|anthropologie)/i.test(
//               url,
//             )
//           ) {
//             previewImage =
//               'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg';
//           }

//           // 🧍‍♀️ If female → block clearly male-coded URLs
//           else if (
//             userGender.includes('female') &&
//             /(men|man|male|menswear|masculine)/i.test(url)
//           ) {
//             previewImage =
//               'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg';
//           }

//           // 🧍 Unisex → allow all images
//         }

//         // 🧠 If still missing, do a quick SerpAPI lookup and cache
//         if (!previewImage && p.query) {
//           const results = await this.productSearch.searchSerpApi(p.query);
//           const r = results?.[0];
//           previewImage =
//             r?.image ||
//             r?.image_url ||
//             r?.thumbnail ||
//             r?.serpapi_thumbnail ||
//             r?.thumbnail_url ||
//             r?.result?.thumbnail ||
//             r?.result?.serpapi_thumbnail ||
//             null;

//           // 🎯 Apply same gender guard to SerpAPI result
//           if (previewImage) {
//             const url = previewImage.toLowerCase();

//             if (
//               userGender.includes('male') &&
//               /(women|woman|female|ladies|girls|womenswear|femme|skims|shein|fashionnova|princesspolly|revolve|anthropologie)/i.test(
//                 url,
//               )
//             ) {
//               previewImage =
//                 'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg';
//             } else if (
//               userGender.includes('female') &&
//               /(men|man|male|menswear|masculine)/i.test(url)
//             ) {
//               previewImage =
//                 'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg';
//             }
//           }
//         }

//         return {
//           ...p,
//           previewImage:
//             previewImage ||
//             'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg',
//           previewBrand: validProduct?.brand || p.brand || 'Unknown',
//           previewPrice: validProduct?.price || '—',
//           previewUrl: validProduct?.shopUrl || p.shopUrl || null,
//         };
//       }),
//     ); // ✅ ← closes Promise.all()

//     // 🧹 remove empty product groups (no valid images)
//     const filteredPurchases = normalizedPurchases.filter(
//       (p) => !!p.previewImage,
//     );

//     // 🧊 Climate sanity check — if Polar but outfit lacks insulation, patch style_note
//     if (
//       styleProfile.climate?.toLowerCase().includes('polar') &&
//       !/coat|jacket|parka|boot|knit|sweater/i.test(
//         JSON.stringify(parsed.recreated_outfit || []),
//       )
//     ) {
//       parsed.style_note +=
//         ' Reinforced with insulated outerwear and cold-weather layering for Polar climates.';
//     }

//     // 🚫 Prevent fallback or secondary recreate() from overwriting personalized flow
//     if (
//       enrichedPurchases?.length > 0 ||
//       parsed?.suggested_purchases?.length > 0
//     ) {
//       console.log(
//         '✅ [personalizedShop] Finalizing personalized results — skipping generic recreate()',
//       );
//       return {
//         user_id,
//         image_url,
//         tags,
//         recreated_outfit: parsed?.recreated_outfit || [],
//         suggested_purchases: normalizedPurchases,
//         style_note:
//           parsed?.style_note ||
//           'Personalized recreation based on your wardrobe, with curated seasonal add-ons.',
//         gap_analysis: parsed?.gap_analysis || null,
//         applied_filters: {
//           preferFit,
//           bannedWords: bannedWords.map((r) => r.source),
//         },
//       };
//     }

//     return {
//       user_id,
//       image_url,
//       tags,
//       recreated_outfit: parsed?.recreated_outfit || [],
//       suggested_purchases: normalizedPurchases,
//       style_note:
//         parsed?.style_note ||
//         'Personalized recreation based on your wardrobe, with curated seasonal add-ons.',
//       gap_analysis: parsed?.gap_analysis || null,
//       applied_filters: {
//         preferFit,
//         bannedWords: bannedWords.map((r) => r.source),
//       },
//     };
//   }

//   ////////END CREATE LOOK

//   //////. START REPLACED CHAT WITH LINKS AND SEARCH NET
//   async chat(dto: ChatDto) {
//     const { messages, user_id } = dto;
//     const lastUserMsg = messages
//       .slice()
//       .reverse()
//       .find((m) => m.role === 'user')?.content;

//     if (!lastUserMsg) {
//       throw new Error('No user message provided');
//     }

//     /* 🎯 --- SMART CONTEXT: Classify query to load only relevant data --- */
//     let contextNeeds = {
//       memory: true, // always load chat history
//       styleProfile: false,
//       wardrobe: false,
//       calendar: false,
//       savedLooks: false,
//       feedback: false,
//       wearHistory: false,
//       scheduledOutfits: false,
//       favorites: false,
//       customOutfits: false,
//       itemPrefs: false,
//       lookMemories: false,
//       notifications: false,
//       weather: false,
//     };

//     try {
//       const classifyRes = await this.openai.chat.completions.create({
//         model: 'gpt-4o-mini',
//         temperature: 0,
//         max_tokens: 150,
//         messages: [
//           {
//             role: 'system',
//             content: `Classify what data is needed to answer this fashion/style question. Return JSON only.
// Categories: styleProfile (body type, colors, preferences), wardrobe (clothes owned), calendar (events), savedLooks, feedback (outfit ratings), wearHistory (recently worn), scheduledOutfits, favorites, customOutfits, itemPrefs (liked/disliked items), lookMemories (style exploration), notifications, weather.
// For general chat/greetings, return empty needs. For outfit suggestions, include styleProfile+wardrobe+weather. Be minimal.`,
//           },
//           {
//             role: 'user',
//             content: `Query: "${lastUserMsg}"\n\nReturn JSON: {"needs": ["category1", "category2"]}`,
//           },
//         ],
//       });
//       const classifyContent = classifyRes.choices[0]?.message?.content || '{}';
//       const parsed = JSON.parse(classifyContent.match(/\{.*\}/s)?.[0] || '{}');
//       const needs: string[] = parsed.needs || [];

//       // Map needs to contextNeeds
//       needs.forEach((n: string) => {
//         const key = n.toLowerCase().replace(/[^a-z]/g, '');
//         if (key in contextNeeds) (contextNeeds as any)[key] = true;
//       });

//       console.log(
//         `🎯 Smart context: ${needs.length ? needs.join(', ') : 'minimal (chat only)'}`,
//       );
//     } catch (err: any) {
//       // Fallback: load everything if classification fails
//       console.warn(
//         '⚠️ Context classification failed, loading all:',
//         err.message,
//       );
//       Object.keys(contextNeeds).forEach(
//         (k) => ((contextNeeds as any)[k] = true),
//       );
//     }

//     /* 🧠 --- MEMORY BLOCK START --- */
//     try {
//       // Save the latest user message
//       await pool.query(
//         `INSERT INTO chat_messages (user_id, role, content)
//        VALUES ($1,$2,$3)`,
//         [user_id, 'user', lastUserMsg],
//       );

//       // Fetch the last 10 messages for this user
//       const { rows } = await pool.query(
//         `SELECT role, content
//        FROM chat_messages
//        WHERE user_id = $1
//        ORDER BY created_at DESC
//        LIMIT 10`,
//         [user_id],
//       );

//       // Add them (chronological) to current messages for context
//       const history = rows.reverse();
//       for (const h of history) {
//         if (h.content !== lastUserMsg)
//           messages.unshift({ role: h.role, content: h.content });
//       }

//       // 🧹 Purge older messages beyond last 30
//       await pool.query(
//         `DELETE FROM chat_messages
//        WHERE user_id = $1
//        AND id NOT IN (
//          SELECT id FROM chat_messages
//          WHERE user_id = $1
//          ORDER BY created_at DESC
//          LIMIT 30
//        );`,
//         [user_id],
//       );
//     } catch (err: any) {
//       console.warn('⚠️ chat history retrieval failed:', err.message);
//     }
//     /* 🧠 --- MEMORY BLOCK END --- */

//     /* 🧠 --- LOAD LONG-TERM SUMMARY MEMORY (with Redis cache) --- */
//     let longTermSummary = '';
//     try {
//       const cacheKey = `memory:${user_id}`;
//       const cached = await redis.get<string>(cacheKey);

//       if (cached) {
//         console.log(`🟢 Redis HIT for ${cacheKey}`);
//         longTermSummary = cached;
//       } else {
//         console.log(`🔴 Redis MISS for ${cacheKey} — fetching from Postgres`);
//         const { rows } = await pool.query(
//           `SELECT summary FROM chat_memory WHERE user_id = $1`,
//           [user_id],
//         );
//         if (rows[0]?.summary) {
//           longTermSummary = rows[0].summary;
//           console.log(`🟢 Caching summary in Redis for ${cacheKey}`);
//           await redis.set(cacheKey, longTermSummary, { ex: 86400 });
//         }
//       }
//     } catch (err: any) {
//       console.warn(
//         '⚠️ failed to load summary from Redis/Postgres:',
//         err.message,
//       );
//     }

//     /* 📅 --- LOAD CALENDAR EVENTS FOR CHAT CONTEXT --- */
//     let calendarContext = '';
//     if (contextNeeds.calendar)
//       try {
//         const { rows: calendarRows } = await pool.query(
//           `SELECT title, start_date, end_date, location, notes
//          FROM user_calendar_events
//          WHERE user_id = $1
//          AND start_date >= NOW()
//          ORDER BY start_date ASC
//          LIMIT 15`,
//           [user_id],
//         );
//         if (calendarRows.length > 0) {
//           const eventsList = calendarRows
//             .map((e, i) => {
//               const start = new Date(e.start_date);
//               const dateStr = start.toLocaleDateString('en-US', {
//                 weekday: 'long',
//                 month: 'long',
//                 day: 'numeric',
//                 year: 'numeric',
//               });
//               const timeStr = start.toLocaleTimeString('en-US', {
//                 hour: '2-digit',
//                 minute: '2-digit',
//                 hour12: true,
//               });
//               let eventLine = `${i + 1}. "${e.title}" - ${dateStr} at ${timeStr}`;
//               if (e.location) eventLine += ` @ ${e.location}`;
//               if (e.notes) eventLine += ` (${e.notes})`;
//               return eventLine;
//             })
//             .join('\n');

//           calendarContext = `\n\nCALENDAR EVENTS (${calendarRows.length} upcoming):\n${eventsList}`;
//           console.log(
//             `📅 Chat: Loaded ${calendarRows.length} upcoming calendar events`,
//           );
//         }
//       } catch (err: any) {
//         console.warn(
//           '⚠️ failed to load calendar events for chat:',
//           err.message,
//         );
//       }

//     /* 👗 --- LOAD STYLE PROFILE FOR CHAT CONTEXT --- */
//     let styleProfileContext = '';
//     if (contextNeeds.styleProfile)
//       try {
//         const { rows: styleRows } = await pool.query(
//           `SELECT body_type, skin_tone, undertone, climate,
//                 favorite_colors, fit_preferences, preferred_brands,
//                 disliked_styles, style_keywords, style_preferences,
//                 hair_color, eye_color, height, waist, goals
//          FROM style_profiles
//          WHERE user_id = $1
//          LIMIT 1`,
//           [user_id],
//         );
//         if (styleRows.length > 0) {
//           const sp = styleRows[0];
//           const parts: string[] = [];
//           if (sp.body_type) parts.push(`Body type: ${sp.body_type}`);
//           if (sp.skin_tone) parts.push(`Skin tone: ${sp.skin_tone}`);
//           if (sp.undertone) parts.push(`Undertone: ${sp.undertone}`);
//           if (sp.hair_color) parts.push(`Hair: ${sp.hair_color}`);
//           if (sp.eye_color) parts.push(`Eyes: ${sp.eye_color}`);
//           if (sp.height) parts.push(`Height: ${sp.height}`);
//           if (sp.climate) parts.push(`Climate: ${sp.climate}`);
//           if (sp.favorite_colors?.length)
//             parts.push(
//               `Favorite colors: ${Array.isArray(sp.favorite_colors) ? sp.favorite_colors.join(', ') : sp.favorite_colors}`,
//             );
//           if (sp.fit_preferences?.length)
//             parts.push(
//               `Fit preferences: ${Array.isArray(sp.fit_preferences) ? sp.fit_preferences.join(', ') : sp.fit_preferences}`,
//             );
//           if (sp.preferred_brands?.length)
//             parts.push(
//               `Preferred brands: ${Array.isArray(sp.preferred_brands) ? sp.preferred_brands.join(', ') : sp.preferred_brands}`,
//             );
//           if (sp.disliked_styles?.length)
//             parts.push(
//               `Dislikes: ${Array.isArray(sp.disliked_styles) ? sp.disliked_styles.join(', ') : sp.disliked_styles}`,
//             );
//           if (sp.style_keywords?.length)
//             parts.push(
//               `Style keywords: ${Array.isArray(sp.style_keywords) ? sp.style_keywords.join(', ') : sp.style_keywords}`,
//             );
//           if (sp.goals) parts.push(`Goals: ${sp.goals}`);
//           if (parts.length > 0) {
//             styleProfileContext = '\n\n👗 STYLE PROFILE:\n' + parts.join('\n');
//             console.log(
//               `👗 Chat: Loaded style profile with ${parts.length} attributes`,
//             );
//           }
//         }
//       } catch (err: any) {
//         console.warn('⚠️ failed to load style profile for chat:', err.message);
//       }

//     /* 👔 --- LOAD WARDROBE ITEMS FOR CHAT CONTEXT (WITH SPECIFIC ITEM DETAILS) --- */
//     let wardrobeContext = '';
//     if (contextNeeds.wardrobe)
//       try {
//         const { rows: wardrobeRows } = await pool.query(
//           `SELECT name, main_category, subcategory, color, material, brand, fit
//          FROM wardrobe_items
//          WHERE user_id = $1
//          ORDER BY created_at DESC
//          LIMIT 100`,
//           [user_id],
//         );
//         if (wardrobeRows.length > 0) {
//           const grouped: Record<string, any[]> = {};
//           for (const item of wardrobeRows) {
//             const cat = item.main_category || 'Other';
//             if (!grouped[cat]) grouped[cat] = [];
//             grouped[cat].push({
//               name: item.name,
//               color: item.color,
//               material: item.material,
//               brand: item.brand,
//               fit: item.fit,
//               subcategory: item.subcategory,
//             });
//           }

//           // Format wardrobe for easy reference in recommendations
//           const formatted = Object.entries(grouped)
//             .map(([cat, items]) => {
//               const itemDescriptions = items
//                 .slice(0, 12)
//                 .map((i) => {
//                   const parts = [
//                     i.color,
//                     i.name || i.subcategory,
//                     i.brand,
//                     i.material,
//                     i.fit,
//                   ]
//                     .filter(Boolean)
//                     .join(' • ');
//                   return `  • ${parts}`;
//                 })
//                 .join('\n');
//               return `${cat}:\n${itemDescriptions}`;
//             })
//             .join('\n\n');

//           wardrobeContext = `\n\n👔 USER'S EXACT WARDROBE ITEMS (use these specific names and colors in recommendations):\n\n${formatted}\n\nWARNING: Always reference ACTUAL item names from above when making recommendations. Use language like:
// - "pair with your [COLOR] [ITEM NAME] you own"
// - "complements the [BRAND] [ITEM] in [COLOR]"
// - "works with your [fit] [COLOR] [ITEM]"
// NEVER make generic references. ALWAYS name the SPECIFIC pieces they own.`;

//           console.log(
//             `👔 Chat: Loaded ${wardrobeRows.length} wardrobe items from ${Object.keys(grouped).length} categories`,
//           );
//         }
//       } catch (err: any) {
//         console.warn('⚠️ failed to load wardrobe items for chat:', err.message);
//       }

//     /* ⭐ --- LOAD SAVED LOOKS FOR CHAT CONTEXT --- */
//     let savedLooksContext = '';
//     if (contextNeeds.savedLooks)
//       try {
//         const { rows: savedRows } = await pool.query(
//           `SELECT name, created_at
//          FROM saved_looks
//          WHERE user_id = $1
//          ORDER BY created_at DESC
//          LIMIT 10`,
//           [user_id],
//         );
//         if (savedRows.length > 0) {
//           savedLooksContext =
//             '\n\n⭐ SAVED LOOKS:\n' +
//             savedRows.map((l) => `• ${l.name}`).join('\n');
//           console.log(`⭐ Chat: Loaded ${savedRows.length} saved looks`);
//         }
//       } catch (err: any) {
//         console.warn('⚠️ failed to load saved looks for chat:', err.message);
//       }

//     /* 🎨 --- LOAD RECREATED LOOKS FOR CHAT CONTEXT --- */
//     let recreatedLooksContext = '';
//     if (contextNeeds.savedLooks)
//       try {
//         const { rows: recreatedRows } = await pool.query(
//           `SELECT tags, created_at
//          FROM recreated_looks
//          WHERE user_id = $1
//          ORDER BY created_at DESC
//          LIMIT 10`,
//           [user_id],
//         );
//         if (recreatedRows.length > 0) {
//           const allTags = recreatedRows
//             .flatMap((r) => r.tags || [])
//             .filter(Boolean);
//           const uniqueTags = [...new Set(allTags)].slice(0, 20);
//           if (uniqueTags.length > 0) {
//             recreatedLooksContext =
//               '\n\n🎨 RECENT LOOK INSPIRATIONS (tags): ' +
//               uniqueTags.join(', ');
//             console.log(
//               `🎨 Chat: Loaded ${recreatedRows.length} recreated looks`,
//             );
//           }
//         }
//       } catch (err: any) {
//         console.warn(
//           '⚠️ failed to load recreated looks for chat:',
//           err.message,
//         );
//       }

//     /* 📝 --- LOAD OUTFIT FEEDBACK FOR CHAT CONTEXT --- */
//     let feedbackContext = '';
//     if (contextNeeds.feedback)
//       try {
//         const { rows: feedbackRows } = await pool.query(
//           `SELECT rating, notes, outfit_json
//          FROM outfit_feedback
//          WHERE user_id = $1
//          ORDER BY created_at DESC
//          LIMIT 10`,
//           [user_id],
//         );
//         if (feedbackRows.length > 0) {
//           const likes = feedbackRows.filter((f) => f.rating >= 4);
//           const dislikes = feedbackRows.filter((f) => f.rating <= 2);
//           const parts: string[] = [];
//           if (likes.length > 0) {
//             const likeNotes = likes
//               .map((f) => f.notes)
//               .filter(Boolean)
//               .slice(0, 3);
//             parts.push(
//               `Liked outfits: ${likes.length}${likeNotes.length ? ' - ' + likeNotes.join('; ') : ''}`,
//             );
//           }
//           if (dislikes.length > 0) {
//             const dislikeNotes = dislikes
//               .map((f) => f.notes)
//               .filter(Boolean)
//               .slice(0, 3);
//             parts.push(
//               `Disliked outfits: ${dislikes.length}${dislikeNotes.length ? ' - ' + dislikeNotes.join('; ') : ''}`,
//             );
//           }
//           if (parts.length > 0) {
//             feedbackContext = '\n\n📝 OUTFIT FEEDBACK:\n' + parts.join('\n');
//             console.log(
//               `📝 Chat: Loaded ${feedbackRows.length} outfit feedback entries`,
//             );
//           }
//         }
//       } catch (err: any) {
//         console.warn(
//           '⚠️ failed to load outfit feedback for chat:',
//           err.message,
//         );
//       }

//     /* 👕 --- LOAD WEAR HISTORY FOR CHAT CONTEXT --- */
//     let wearHistoryContext = '';
//     if (contextNeeds.wearHistory)
//       try {
//         const { rows: wearRows } = await pool.query(
//           `SELECT items_jsonb, context_jsonb, worn_at
//          FROM wear_events
//          WHERE user_id = $1
//          ORDER BY worn_at DESC
//          LIMIT 10`,
//           [user_id],
//         );
//         if (wearRows.length > 0) {
//           const recentWears = wearRows
//             .slice(0, 5)
//             .map((w) => {
//               const date = new Date(w.worn_at).toLocaleDateString('en-US', {
//                 month: 'short',
//                 day: 'numeric',
//               });
//               const context =
//                 w.context_jsonb?.occasion || w.context_jsonb?.event || '';
//               return `• ${date}${context ? ' (' + context + ')' : ''}`;
//             })
//             .filter(Boolean);
//           if (recentWears.length > 0) {
//             wearHistoryContext =
//               '\n\n👕 RECENTLY WORN:\n' + recentWears.join('\n');
//             console.log(`👕 Chat: Loaded ${wearRows.length} wear events`);
//           }
//         }
//       } catch (err: any) {
//         console.warn('⚠️ failed to load wear history for chat:', err.message);
//       }

//     /* 📆 --- LOAD SCHEDULED OUTFITS FOR CHAT CONTEXT --- */
//     let scheduledOutfitsContext = '';
//     if (contextNeeds.scheduledOutfits)
//       try {
//         const { rows: scheduledRows } = await pool.query(
//           `SELECT scheduled_for, notes, location
//          FROM scheduled_outfits
//          WHERE user_id = $1
//          AND scheduled_for >= NOW()
//          ORDER BY scheduled_for ASC
//          LIMIT 5`,
//           [user_id],
//         );
//         if (scheduledRows.length > 0) {
//           scheduledOutfitsContext =
//             '\n\n📆 SCHEDULED OUTFITS:\n' +
//             scheduledRows
//               .map((s) => {
//                 const date = new Date(s.scheduled_for).toLocaleDateString(
//                   'en-US',
//                   { weekday: 'short', month: 'short', day: 'numeric' },
//                 );
//                 return `• ${date}${s.location ? ' at ' + s.location : ''}${s.notes ? ' - ' + s.notes : ''}`;
//               })
//               .join('\n');
//           console.log(
//             `📆 Chat: Loaded ${scheduledRows.length} scheduled outfits`,
//           );
//         }
//       } catch (err: any) {
//         console.warn(
//           '⚠️ failed to load scheduled outfits for chat:',
//           err.message,
//         );
//       }

//     /* ❤️ --- LOAD OUTFIT FAVORITES FOR CHAT CONTEXT --- */
//     let favoritesContext = '';
//     if (contextNeeds.favorites)
//       try {
//         const { rows: favRows } = await pool.query(
//           `SELECT outfit_type, COUNT(*) as count
//          FROM outfit_favorites
//          WHERE user_id = $1
//          GROUP BY outfit_type`,
//           [user_id],
//         );
//         if (favRows.length > 0) {
//           favoritesContext =
//             '\n\n❤️ FAVORITED OUTFITS: ' +
//             favRows
//               .map((f) => `${f.outfit_type || 'outfit'}: ${f.count}`)
//               .join(', ');
//           console.log(
//             `❤️ Chat: Loaded ${favRows.length} outfit favorite types`,
//           );
//         }
//       } catch (err: any) {
//         console.warn(
//           '⚠️ failed to load outfit favorites for chat:',
//           err.message,
//         );
//       }

//     /* 🎯 --- LOAD CUSTOM OUTFITS FOR CHAT CONTEXT --- */
//     let customOutfitsContext = '';
//     if (contextNeeds.customOutfits)
//       try {
//         const { rows: customRows } = await pool.query(
//           `SELECT name, notes, rating
//          FROM custom_outfits
//          WHERE user_id = $1
//          ORDER BY created_at DESC
//          LIMIT 10`,
//           [user_id],
//         );
//         if (customRows.length > 0) {
//           customOutfitsContext =
//             '\n\n🎯 CUSTOM OUTFITS CREATED:\n' +
//             customRows
//               .map(
//                 (c) =>
//                   `• ${c.name}${c.rating ? ' (rated ' + c.rating + '/5)' : ''}${c.notes ? ' - ' + c.notes : ''}`,
//               )
//               .join('\n');
//           console.log(`🎯 Chat: Loaded ${customRows.length} custom outfits`);
//         }
//       } catch (err: any) {
//         console.warn('⚠️ failed to load custom outfits for chat:', err.message);
//       }

//     /* 👍 --- LOAD ITEM PREFERENCES FOR CHAT CONTEXT --- */
//     let itemPrefsContext = '';
//     if (contextNeeds.itemPrefs)
//       try {
//         const { rows: prefRows } = await pool.query(
//           `SELECT up.score, wi.name, wi.main_category, wi.color
//          FROM user_pref_item up
//          JOIN wardrobe_items wi ON up.item_id = wi.id
//          WHERE up.user_id = $1
//          ORDER BY up.score DESC
//          LIMIT 10`,
//           [user_id],
//         );
//         if (prefRows.length > 0) {
//           const liked = prefRows.filter((p) => p.score > 0);
//           const disliked = prefRows.filter((p) => p.score < 0);
//           const parts: string[] = [];
//           if (liked.length > 0) {
//             parts.push(
//               'Most liked items: ' +
//                 liked
//                   .slice(0, 5)
//                   .map((p) => p.name || `${p.color} ${p.main_category}`)
//                   .join(', '),
//             );
//           }
//           if (disliked.length > 0) {
//             parts.push(
//               'Least liked items: ' +
//                 disliked
//                   .slice(0, 3)
//                   .map((p) => p.name || `${p.color} ${p.main_category}`)
//                   .join(', '),
//             );
//           }
//           if (parts.length > 0) {
//             itemPrefsContext = '\n\n👍 ITEM PREFERENCES:\n' + parts.join('\n');
//             console.log(`👍 Chat: Loaded ${prefRows.length} item preferences`);
//           }
//         }
//       } catch (err: any) {
//         console.warn(
//           '⚠️ failed to load item preferences for chat:',
//           err.message,
//         );
//       }

//     /* 🔍 --- LOAD LOOK MEMORIES FOR CHAT CONTEXT --- */
//     let lookMemoriesContext = '';
//     if (contextNeeds.lookMemories)
//       try {
//         const { rows: memRows } = await pool.query(
//           `SELECT ai_tags, query_used
//          FROM look_memories
//          WHERE user_id = $1
//          ORDER BY created_at DESC
//          LIMIT 15`,
//           [user_id],
//         );
//         if (memRows.length > 0) {
//           const allTags = memRows
//             .flatMap((m) => m.ai_tags || [])
//             .filter(Boolean);
//           const uniqueTags = [...new Set(allTags)].slice(0, 15);
//           const queries = [
//             ...new Set(memRows.map((m) => m.query_used).filter(Boolean)),
//           ].slice(0, 5);
//           const parts: string[] = [];
//           if (uniqueTags.length > 0)
//             parts.push('Style tags explored: ' + uniqueTags.join(', '));
//           if (queries.length > 0)
//             parts.push('Recent searches: ' + queries.join(', '));
//           if (parts.length > 0) {
//             lookMemoriesContext =
//               '\n\n🔍 LOOK EXPLORATION HISTORY:\n' + parts.join('\n');
//             console.log(`🔍 Chat: Loaded ${memRows.length} look memories`);
//           }
//         }
//       } catch (err: any) {
//         console.warn('⚠️ failed to load look memories for chat:', err.message);
//       }

//     /* 🔔 --- LOAD NOTIFICATIONS FOR CHAT CONTEXT --- */
//     let notificationsContext = '';
//     if (contextNeeds.notifications)
//       try {
//         const { rows: notifRows } = await pool.query(
//           `SELECT title, message, timestamp, category, read
//          FROM user_notifications
//          WHERE user_id = $1
//          ORDER BY timestamp DESC
//          LIMIT 15`,
//           [user_id],
//         );
//         if (notifRows.length > 0) {
//           notificationsContext =
//             '\n\n🔔 RECENT NOTIFICATIONS:\n' +
//             notifRows
//               .map((n: any, i: number) => {
//                 const date = new Date(n.timestamp).toLocaleDateString('en-US', {
//                   month: 'short',
//                   day: 'numeric',
//                 });
//                 const readStatus = n.read ? '' : ' (unread)';
//                 return `${i + 1}. [${date}] ${n.title || n.category || 'Notification'}: ${n.message}${readStatus}`;
//               })
//               .join('\n');
//           console.log(`🔔 Chat: Loaded ${notifRows.length} notifications`);
//           console.log(
//             `🔔 Chat: Notifications preview: ${notificationsContext.substring(0, 500)}`,
//           );
//         }
//       } catch (err: any) {
//         console.warn('⚠️ failed to load notifications for chat:', err.message);
//       }

//     /* 🌦️ --- FETCH CURRENT WEATHER FOR CHAT CONTEXT --- */
//     let weatherContext = '';
//     if (contextNeeds.weather)
//       try {
//         if (dto.lat && dto.lon) {
//           const weather = await fetchWeatherForAI(dto.lat, dto.lon);
//           if (weather) {
//             weatherContext = `\n\n🌦️ CURRENT WEATHER:\n• Temperature: ${weather.tempF}°F\n• Condition: ${weather.condition}\n• Humidity: ${weather.humidity}%\n• Wind: ${weather.windSpeed} mph`;
//             console.log(
//               `🌦️ Chat: Loaded weather - ${weather.tempF}°F, ${weather.condition}`,
//             );
//           }
//         } else if (dto.weather) {
//           // Use weather passed directly from frontend if no lat/lon
//           const w = dto.weather;
//           if (w.tempF || w.temperature) {
//             const temp = w.tempF || Math.round((w.temperature * 9) / 5 + 32);
//             weatherContext = `\n\n🌦️ CURRENT WEATHER:\n• Temperature: ${temp}°F${w.condition ? `\n• Condition: ${w.condition}` : ''}`;
//             console.log(`🌦️ Chat: Using passed weather - ${temp}°F`);
//           }
//         }
//       } catch (err: any) {
//         console.warn('⚠️ failed to fetch weather for chat:', err.message);
//       }

//     // Combine all context into enhanced summary
//     const fullContext =
//       (longTermSummary || '(no prior memory yet)') +
//       styleProfileContext +
//       wardrobeContext +
//       calendarContext +
//       savedLooksContext +
//       recreatedLooksContext +
//       feedbackContext +
//       wearHistoryContext +
//       scheduledOutfitsContext +
//       favoritesContext +
//       customOutfitsContext +
//       itemPrefsContext +
//       lookMemoriesContext +
//       notificationsContext +
//       weatherContext;

//     console.log(`📊 Chat: Full context length: ${fullContext.length} chars`);
//     console.log(
//       `📊 Chat: Calendar context included: ${calendarContext.length > 0}`,
//     );
//     console.log(
//       `📊 Chat: Calendar context length: ${calendarContext.length} chars`,
//     );
//     console.log(`📊 Chat: Calendar data: ${calendarContext.substring(0, 200)}`);
//     console.log(
//       `📊 Chat: Wardrobe context included: ${wardrobeContext.length > 0}`,
//     );
//     console.log(
//       `📊 Chat: Style profile context included: ${styleProfileContext.length > 0}`,
//     );

//     // 1️⃣ Generate base text with OpenAI
//     const completion = await this.openai.chat.completions.create({
//       model: 'gpt-4o',
//       temperature: 0.8,
//       messages: [
//         {
//           role: 'system',
//           content: `
// You are a world-class personal fashion stylist with FULL ACCESS to the user's personal data.

// YOU HAVE COMPLETE ACCESS TO ALL OF THIS USER DATA:
// ${fullContext}

// CRITICAL RULES - MANDATORY FOR ALL RESPONSES:
// 1. ONLY reference events, items, and data actually shown above
// 2. DO NOT make up or invent calendar events, wardrobe items, or preferences
// 3. If the user asks about something not in the data above, say "I don't see that in your data"
// 4. Use ONLY the real calendar events, wardrobe items, and preferences provided
// 5. When answering questions about their calendar - reference ONLY the events listed above
// 6. You DO have access to real-time weather data - if CURRENT WEATHER is shown above, use it confidently
// 7. You DO have access to notification history - if RECENT NOTIFICATIONS is shown above, use it to answer questions about notifications

// ⭐ WARDROBE RECOMMENDATION RULES (MANDATORY):
// - WHEN MAKING SHOPPING SUGGESTIONS: You MUST reference specific items they ALREADY OWN
// - Use language patterns like:
//   • "pair with your [COLOR] [ITEM NAME] you own"
//   • "matches the [BRAND] [ITEM] in [COLOR]"
//   • "works perfectly with your [fit] [COLOR] [ITEM NAME]"
//   • "complements your existing [COLOR] [MATERIAL] [ITEM]"
//   • "You currently have [NUMBER] [CATEGORY], so adding a [specific item] would fill the gap"
// - SHOW PROOF you know their wardrobe by naming SPECIFIC items, colors, materials, brands
// - Example RIGHT answer: "Navy blazer to pair with your sleek white pants you own - fills your structured top gap"
// - Example WRONG answer: "Add a navy blazer to complete your look" ← NEVER do this

// Respond naturally about outfits, wardrobe planning, or styling using ONLY the user data provided.
// At the end, return a short JSON block like:
// {"search_terms":["smart casual men","navy blazer outfit","loafers"]}
//         `,
//         },
//         ...messages,
//       ],
//     });

//     const aiReply =
//       completion.choices[0]?.message?.content?.trim() ||
//       'Styled response unavailable.';

//     // 2️⃣ Extract search terms if model provided them
//     let searchTerms: string[] = [];
//     const match = aiReply.match(/\{.*"search_terms":.*\}/s);
//     if (match) {
//       try {
//         const parsed = JSON.parse(match[0]);
//         searchTerms = parsed.search_terms ?? [];
//       } catch {
//         searchTerms = [];
//       }
//     }

//     // 3️⃣ Fallback heuristic: derive terms if none found
//     if (!searchTerms.length) {
//       const lowered = lastUserMsg.toLowerCase();
//       if (lowered.includes('smart')) searchTerms.push('smart casual outfit');
//       if (lowered.includes('summer')) searchTerms.push('summer outfit');
//       if (lowered.includes('work')) searchTerms.push('business casual look');
//       if (!searchTerms.length)
//         searchTerms.push(`${lowered} outfit inspiration`);
//     }

//     // 4️⃣ Fetch Unsplash images
//     const images = await this.fetchUnsplash(searchTerms);

//     // 5️⃣ Build shoppable links
//     const links = searchTerms.map((term) => ({
//       label: `Shop ${term} on ASOS`,
//       url: `https://www.asos.com/search/?q=${encodeURIComponent(term)}`,
//     }));

//     /* 🧠 --- SAVE ASSISTANT REPLY --- */
//     try {
//       await pool.query(
//         `INSERT INTO chat_messages (user_id, role, content)
//        VALUES ($1,$2,$3)`,
//         [user_id, 'assistant', aiReply],
//       );
//     } catch (err: any) {
//       console.warn('⚠️ failed to store assistant reply:', err.message);
//     }

//     /* 🧠 --- UPDATE LONG-TERM SUMMARY MEMORY (Postgres + Redis) --- */
//     try {
//       const { rows } = await pool.query(
//         `SELECT summary FROM chat_memory WHERE user_id = $1`,
//         [user_id],
//       );
//       const prevSummary = rows[0]?.summary || '';

//       const { rows: recent } = await pool.query(
//         `SELECT role, content FROM chat_messages
//        WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
//         [user_id],
//       );

//       const context = recent
//         .reverse()
//         .map((r) => `${r.role}: ${r.content}`)
//         .join('\n');

//       const memoryPrompt = `
// You are a memory summarizer for an AI stylist.
// Update this user's long-term fashion memory summary.
// Keep what you've already learned, and merge any new useful insights.

// Previous memory summary:
// ${prevSummary}

// Recent chat history:
// ${context}

// Write a concise, 150-word updated summary focusing on their taste, preferences, and style evolution.
// `;

//       const memCompletion = await this.openai.chat.completions.create({
//         model: 'gpt-4o-mini',
//         temperature: 0.3,
//         messages: [{ role: 'system', content: memoryPrompt }],
//       });

//       const newSummary =
//         memCompletion.choices[0]?.message?.content?.trim() || prevSummary;

//       const trimmedSummary = newSummary.slice(0, 1000).replace(/[*_#`]/g, '');

//       await pool.query(
//         `INSERT INTO chat_memory (user_id, summary, updated_at)
//        VALUES ($1, $2, NOW())
//        ON CONFLICT (user_id)
//        DO UPDATE SET summary = $2, updated_at = NOW();`,
//         [user_id, trimmedSummary],
//       );

//       // ✅ Cache the updated summary in Redis for 24 hours
//       await redis.set(`memory:${user_id}`, trimmedSummary, { ex: 86400 });
//     } catch (err: any) {
//       console.warn('⚠️ failed to update long-term memory:', err.message);
//     }

//     return { reply: aiReply, images, links };
//   }

//   // 🧠 Completely clear all chat + memory for a user
//   async clearChatHistory(user_id: string) {
//     try {
//       // 1️⃣ Delete all chat messages for the user
//       await pool.query(`DELETE FROM chat_messages WHERE user_id = $1`, [
//         user_id,
//       ]);

//       // 2️⃣ Delete long-term memory summaries
//       await pool.query(`DELETE FROM chat_memory WHERE user_id = $1`, [user_id]);

//       // 3️⃣ Clear Redis cache for this user
//       await redis.del(`memory:${user_id}`);

//       console.log(`🧹 Cleared ALL chat + memory for user ${user_id}`);
//       return { success: true, message: 'All chat history and memory cleared.' };
//     } catch (err: any) {
//       console.error('❌ Failed to clear chat history:', err.message);
//       throw new Error('Failed to clear chat history.');
//     }
//   }

//   // 🧹 Soft reset: clear short-term chat but retain long-term memory
//   async softResetChat(user_id: string) {
//     try {
//       // Delete recent messages but keep memory summary
//       await pool.query(`DELETE FROM chat_messages WHERE user_id = $1`, [
//         user_id,
//       ]);

//       console.log(`🧹 Soft reset chat for user ${user_id}`);
//       return {
//         success: true,
//         message: 'Recent chat messages cleared (long-term memory retained).',
//       };
//     } catch (err: any) {
//       console.error('❌ Failed to soft-reset chat:', err.message);
//       throw new Error('Failed to soft reset chat.');
//     }
//   }

//   /** 🔍 Lightweight Unsplash fetch helper */
//   private async fetchUnsplash(terms: string[]) {
//     const key = process.env.UNSPLASH_ACCESS_KEY;
//     if (!key || !terms.length) return [];
//     const q = encodeURIComponent(terms[0]);
//     const res = await fetch(
//       `https://api.unsplash.com/search/photos?query=${q}&per_page=5&client_id=${key}`,
//     );
//     if (!res.ok) return [];
//     const json = await res.json();
//     return json.results.map((r) => ({
//       imageUrl: r.urls.small,
//       title: r.description || r.alt_description,
//       sourceLink: r.links.html,
//     }));
//   }

//   /** 🌤️ Suggest daily style plan */
//   async suggest(body: {
//     user?: string;
//     weather?: any;
//     wardrobe?: any[];
//     preferences?: Record<string, any>;
//   }) {
//     const { user, weather, wardrobe, preferences } = body;

//     const temp = weather?.fahrenheit?.main?.temp;
//     const tempDesc = temp
//       ? `${temp}°F and ${temp < 60 ? 'cool' : temp > 85 ? 'warm' : 'mild'} weather`
//       : 'unknown temperature';

//     const wardrobeCount = wardrobe?.length || 0;

//     const systemPrompt = `
// You are a luxury personal stylist.
// Your goal is to provide a daily style briefing that helps the user feel prepared, stylish, and confident.
// Be concise, intelligent, and polished — similar to a stylist at a high-end menswear brand.

// Output must be JSON with:
// - suggestion
// - insight
// - tomorrow
// Optionally include seasonalForecast, lifecycleForecast, styleTrajectory.
// `;

//     const userPrompt = `
// Client: ${user || 'The user'}
// Weather: ${tempDesc}
// Wardrobe items: ${wardrobeCount}
// Preferences: ${JSON.stringify(preferences || {})}
// `;

//     const completion = await this.openai.chat.completions.create({
//       model: 'gpt-4o',
//       temperature: 0.8,
//       messages: [
//         { role: 'system', content: systemPrompt },
//         { role: 'user', content: userPrompt },
//       ],
//       response_format: { type: 'json_object' },
//     });

//     const raw = completion.choices[0]?.message?.content;
//     if (!raw) throw new Error('No suggestion response received from model.');

//     let parsed: {
//       suggestion: string;
//       insight: string;
//       tomorrow: string;
//       seasonalForecast?: string;
//       lifecycleForecast?: string;
//       styleTrajectory?: string;
//     };

//     try {
//       parsed = JSON.parse(raw);
//     } catch {
//       console.error('❌ Failed to parse AI JSON:', raw);
//       throw new Error('AI response was not valid JSON.');
//     }

//     if (!parsed.seasonalForecast) {
//       parsed.seasonalForecast = generateSeasonalForecast(wardrobe);
//     }

//     return parsed;
//   }

//   /* ------------------------------------------------------------
//      🧾 BARCODE / CLOTHING LABEL DECODER
//   -------------------------------------------------------------*/
//   async decodeBarcode(file: {
//     buffer: Buffer;
//     originalname: string;
//     mimetype: string;
//   }) {
//     const tempPath = `/tmp/${Date.now()}-barcode.jpg`;
//     fs.writeFileSync(tempPath, file.buffer);

//     try {
//       const base64 = fs.readFileSync(tempPath).toString('base64');

//       const prompt = `
//       You are analyzing a photo of a product or clothing label.
//       If the image contains a barcode, return ONLY the numeric digits (UPC/EAN).
//       Otherwise, infer structured product info like:
//       {
//         "name": "Uniqlo Linen Shirt",
//         "brand": "Uniqlo",
//         "category": "Shirts",
//         "material": "Linen"
//       }
//       Respond with JSON only. No extra text.
//       `;

//       const completion = await this.openai.chat.completions.create({
//         model: 'gpt-4o-mini',
//         messages: [
//           {
//             role: 'user',
//             content: [
//               { type: 'text', text: prompt },
//               {
//                 type: 'image_url',
//                 image_url: { url: `data:${file.mimetype};base64,${base64}` },
//               },
//             ],
//           },
//         ],
//         max_tokens: 200,
//       });

//       const message = completion.choices?.[0]?.message;

//       let text = '';
//       if (typeof message?.content === 'string') {
//         text = message.content;
//       } else if (Array.isArray(message?.content)) {
//         const parts = message.content as Array<{ text?: string }>;
//         text = parts.map((c) => c.text || '').join(' ');
//       }

//       text = text.trim().replace(/```json|```/g, '');

//       const match = text.match(/\b\d{8,14}\b/);
//       if (match) return { barcode: match[0], raw: text };

//       try {
//         const parsed = JSON.parse(text);
//         if (parsed?.name) return { barcode: null, inferred: parsed };
//       } catch {}

//       return { barcode: null, raw: text };
//     } catch (err: any) {
//       console.error('❌ [AI] decodeBarcode error:', err.message);
//       return { barcode: null, error: err.message };
//     } finally {
//       try {
//         fs.unlinkSync(tempPath);
//       } catch {}
//     }
//   }

//   /* ------------------------------------------------------------
//      🧩 PRODUCT LOOKUP BY BARCODE
//   -------------------------------------------------------------*/
//   async lookupProductByBarcode(upc: string) {
//     const normalized = upc.padStart(12, '0');
//     try {
//       const res = await fetch(
//         `https://api.upcitemdb.com/prod/trial/lookup?upc=${normalized}`,
//       );
//       const json = await res.json();

//       const item = json?.items?.[0];
//       if (!item) throw new Error('No product data from UPCItemDB');

//       return {
//         name: item.title,
//         brand: item.brand,
//         image: item.images?.[0],
//         category: item.category,
//         source: 'upcitemdb',
//       };
//     } catch (err: any) {
//       console.warn('⚠️ UPCItemDB lookup failed:', err.message);
//       const fallback = await this.lookupFallback(normalized);
//       if (!fallback?.name || fallback.name === 'Unknown product') {
//         return await this.lookupFallbackWithAI(normalized);
//       }
//       return fallback;
//     }
//   }

//   /* ------------------------------------------------------------
//      🔁 RapidAPI or Dummy Fallback
//   -------------------------------------------------------------*/
//   async lookupFallback(upc: string) {
//     try {
//       const res = await fetch(`https://barcodes1.p.rapidapi.com/?upc=${upc}`, {
//         headers: {
//           'X-RapidAPI-Key': process.env.RAPIDAPI_KEY ?? '',
//           'X-RapidAPI-Host': 'barcodes1.p.rapidapi.com',
//         },
//       });

//       const json = await res.json();
//       const product = json?.product ?? {};

//       return {
//         name: product.title || json.title || 'Unknown product',
//         brand: product.brand || json.brand || 'Unknown brand',
//         image: product.image || json.image || null,
//         category: product.category || 'Uncategorized',
//         source: 'rapidapi',
//       };
//     } catch (err: any) {
//       console.error('❌ lookupFallback failed:', err.message);
//       return { name: null, brand: null, image: null, category: null };
//     }
//   }

//   /* ------------------------------------------------------------
//      🤖 AI Fallback Guess
//   -------------------------------------------------------------*/
//   async lookupFallbackWithAI(upc: string) {
//     try {
//       const prompt = `
//       The barcode number is: ${upc}.
//       Guess the product based on global manufacturer codes.
//       Return valid JSON only:
//       {"name":"Example Product","brand":"Brand","category":"Category"}
//       `;

//       const completion = await this.openai.chat.completions.create({
//         model: 'gpt-4o-mini',
//         messages: [{ role: 'user', content: prompt }],
//         max_tokens: 150,
//       });

//       let text = completion.choices?.[0]?.message?.content?.trim() || '{}';
//       text = text.replace(/```json|```/g, '').trim();

//       let parsed: any;
//       try {
//         parsed = JSON.parse(text);
//       } catch {
//         parsed = {
//           name:
//             text.replace(/["{}]/g, '').split(',')[0]?.trim() ||
//             'Unknown product',
//           brand: 'Unknown',
//           category: 'Misc',
//         };
//       }

//       return {
//         name: parsed.name || 'Unknown product',
//         brand: parsed.brand || 'Unknown',
//         category: parsed.category || 'Misc',
//         source: 'ai-fallback',
//       };
//     } catch (err: any) {
//       console.error('❌ AI fallback failed:', err.message);
//       return {
//         name: 'Unknown product',
//         brand: 'Unknown',
//         category: 'Uncategorized',
//         source: 'ai-fallback',
//       };
//     }
//   }
// }

// END REPLACED CHAT WITH LINKS AND SEARCH NET

/////////////////

// import { Injectable } from '@nestjs/common';
// import OpenAI from 'openai';
// import { ChatDto } from './dto/chat.dto';
// import { VertexService } from '../vertex/vertex.service'; // 🔹 ADDED
// import { ProductSearchService } from '../product-services/product-search.service';
// import { Pool } from 'pg';
// import { Express } from 'express';
// import { redis } from '../utils/redisClient';

// const pool = new Pool({
//   connectionString: process.env.DATABASE_URL,
//   ssl: { rejectUnauthorized: false },
// });

// import * as fs from 'fs';
// import * as path from 'path';
// import * as dotenv from 'dotenv';

// function loadOpenAISecrets(): {
//   apiKey?: string;
//   project?: string;
//   source: string;
// } {
//   const candidates = [
//     path.join(process.cwd(), '.env'),
//     path.join(process.cwd(), 'apps', 'backend-nest', '.env'),
//     path.join(__dirname, '..', '..', '.env'),
//   ];

//   for (const p of candidates) {
//     try {
//       if (fs.existsSync(p)) {
//         const parsed = dotenv.parse(fs.readFileSync(p));
//         const apiKey = parsed['OPENAI_API_KEY'];
//         const project = parsed['OPENAI_PROJECT_ID'];
//         if (apiKey) return { apiKey, project, source: p };
//       }
//     } catch {
//       // ignore
//     }
//   }

//   return {
//     apiKey: process.env.OPENAI_API_KEY,
//     project: process.env.OPENAI_PROJECT_ID,
//     source: 'process.env',
//   };
// }

// // 🧥 Basic capsule wardrobe templates
// const CAPSULES = {
//   Spring: [
//     { category: 'Outerwear', subcategory: 'Light Jacket', recommended: 2 },
//     { category: 'Tops', subcategory: 'Oxford Shirt', recommended: 3 },
//     { category: 'Bottoms', subcategory: 'Chinos', recommended: 2 },
//     { category: 'Shoes', subcategory: 'Loafers', recommended: 1 },
//     { category: 'Shoes', subcategory: 'Sneakers', recommended: 1 },
//   ],
//   Summer: [
//     { category: 'Tops', subcategory: 'Short Sleeve Shirt', recommended: 4 },
//     { category: 'Tops', subcategory: 'Polo Shirt', recommended: 2 },
//     { category: 'Bottoms', subcategory: 'Linen Trousers', recommended: 2 },
//     { category: 'Shoes', subcategory: 'Loafers', recommended: 1 },
//     { category: 'Shoes', subcategory: 'Sandals', recommended: 1 },
//   ],
//   Fall: [
//     { category: 'Outerwear', subcategory: 'Field Jacket', recommended: 1 },
//     { category: 'Outerwear', subcategory: 'Blazer', recommended: 1 },
//     { category: 'Tops', subcategory: 'Knit Sweater', recommended: 2 },
//     { category: 'Bottoms', subcategory: 'Wool Trousers', recommended: 2 },
//     { category: 'Shoes', subcategory: 'Chelsea Boots', recommended: 1 },
//   ],
//   Winter: [
//     { category: 'Outerwear', subcategory: 'Overcoat', recommended: 1 },
//     { category: 'Outerwear', subcategory: 'Heavy Parka', recommended: 1 },
//     { category: 'Tops', subcategory: 'Heavy Knit Sweater', recommended: 2 },
//     { category: 'Bottoms', subcategory: 'Wool Trousers', recommended: 2 },
//     { category: 'Shoes', subcategory: 'Boots', recommended: 2 },
//   ],
// };

// // 🗓️ Auto-detect season based on month
// function getCurrentSeason(): 'Spring' | 'Summer' | 'Fall' | 'Winter' {
//   const month = new Date().getMonth() + 1;
//   if ([3, 4, 5].includes(month)) return 'Spring';
//   if ([6, 7, 8].includes(month)) return 'Summer';
//   if ([9, 10, 11].includes(month)) return 'Fall';
//   return 'Winter';
// }

// // 🧠 Compare wardrobe to capsule and return simple forecast text
// function generateSeasonalForecast(wardrobe: any[] = []): string | undefined {
//   const season = getCurrentSeason();
//   const capsule = CAPSULES[season];
//   if (!capsule) return;

//   const missing: string[] = [];

//   capsule.forEach((item) => {
//     const owned = wardrobe.filter(
//       (w) =>
//         w.category?.toLowerCase() === item.category.toLowerCase() &&
//         w.subcategory?.toLowerCase() === item.subcategory.toLowerCase(),
//     ).length;

//     if (owned < item.recommended) {
//       const needed = item.recommended - owned;
//       missing.push(`${needed} × ${item.subcategory}`);
//     }
//   });

//   if (missing.length === 0) {
//     return `✅ Your ${season} capsule is complete — you're ready for the season.`;
//   }

//   return `🍂 ${season} is approaching — you're missing: ${missing.join(', ')}.`;
// }

// @Injectable()
// export class AiService {
//   private openai: OpenAI;
//   private useVertex: boolean;
//   private vertexService?: VertexService; // 🔹 optional instance
//   private productSearch: ProductSearchService; // ✅ add this

//   constructor(vertexService?: VertexService) {
//     const { apiKey, project, source } = loadOpenAISecrets();

//     const snippet = apiKey?.slice(0, 20) ?? '';
//     const len = apiKey?.length ?? 0;
//     console.log('🔑 OPENAI key source:', source);
//     console.log('🔑 OPENAI key snippet:', JSON.stringify(snippet));
//     console.log('🔑 OPENAI key length:', len);
//     console.log('📂 CWD:', process.cwd());

//     if (!apiKey) {
//       throw new Error('OPENAI_API_KEY not found in .env or environment.');
//     }
//     if (/^sk-?x{3,}/i.test(apiKey)) {
//       throw new Error(
//         'OPENAI_API_KEY appears masked (e.g., "sk-xxxxx..."). Read from the correct .env instead.',
//       );
//     }
//     if (!apiKey.startsWith('sk-')) {
//       throw new Error('OPENAI_API_KEY is malformed — must start with "sk-".');
//     }

//     this.openai = new OpenAI({ apiKey, project });

//     // 🔹 New: Vertex toggle
//     this.useVertex = process.env.USE_VERTEX === 'true';
//     if (this.useVertex) {
//       this.vertexService = vertexService;
//       console.log('🧠 Vertex/Gemini mode enabled for analyze/recreate');
//     }

//     this.productSearch = new ProductSearchService(); // NEW
//   }

//   //////ANALYZE LOOK

//   async analyze(imageUrl: string) {
//     console.log('🧠 [AI] analyze() called with', imageUrl);
//     if (!imageUrl) throw new Error('Missing imageUrl');

//     // 🔹 Try Vertex first if enabled
//     if (this.useVertex && this.vertexService) {
//       try {
//         const gcsUri = imageUrl.replace(
//           'https://storage.googleapis.com/',
//           'gs://',
//         );
//         const metadata = await this.vertexService.analyzeImage(gcsUri);
//         const tags = [
//           ...(metadata.tags || []),
//           ...(metadata.style_descriptors || []),
//           metadata.main_category,
//           metadata.subcategory,
//         ].filter(Boolean);
//         console.log('🧠 [Vertex] analyze() success:', tags);
//         return { tags };
//       } catch (err: any) {
//         console.warn(
//           '[Vertex] analyze() failed → fallback to OpenAI:',
//           err.message,
//         );
//       }
//     }

//     // 🔸 OpenAI fallback
//     try {
//       const completion = await this.openai.chat.completions.create({
//         model: 'gpt-4o-mini',
//         messages: [
//           {
//             role: 'system',
//             content:
//               'You are a professional fashion classifier. Return only JSON with a "tags" array describing the outfit’s style, color palette, and vibe.',
//           },
//           {
//             role: 'user',
//             content: [
//               { type: 'text', text: 'Describe this outfit as tags only:' },
//               { type: 'image_url', image_url: { url: imageUrl } },
//             ],
//           },
//         ],
//         response_format: { type: 'json_object' },
//       });

//       const raw = completion.choices[0]?.message?.content;
//       console.log('🧠 [AI] analyze() raw response:', raw);

//       if (!raw) throw new Error('Empty response from OpenAI');
//       const parsed = JSON.parse(raw || '{}');
//       return { tags: parsed.tags || [] };
//     } catch (err: any) {
//       console.error('❌ [AI] analyze() failed:', err.message);
//       return { tags: ['casual', 'modern', 'neutral'] };
//     }
//   }

//   /* ------------------------------------------------------------
//      🧩 Weighted Tag Enrichment + Trend Injection
//   -------------------------------------------------------------*/
//   private async enrichTags(tags: string[]): Promise<string[]> {
//     const weightMap: Record<string, number> = {
//       tailored: 3,
//       minimal: 3,
//       neutral: 3,
//       modern: 2,
//       vintage: 2,
//       classic: 2,
//       streetwear: 2,
//       oversized: 2,
//       slim: 2,
//       relaxed: 2,
//       casual: 1,
//       sporty: 1,
//     };

//     // 🧹 Normalize + de-dupe
//     const cleanTags = Array.from(
//       new Set(
//         tags
//           .map((t) => t.toLowerCase().trim())
//           .filter((t) => t && !['outfit', 'style', 'fashion'].includes(t)),
//       ),
//     );

//     // 🧠 Apply weights
//     const weighted = cleanTags
//       .map((t) => ({ tag: t, weight: weightMap[t] || 1 }))
//       .sort((a, b) => b.weight - a.weight);

//     // 🌍 Inject current trend tags
//     const trendTags = await this.fetchTrendTags();
//     const final = Array.from(
//       new Set([...weighted.map((w) => w.tag), ...trendTags.slice(0, 3)]),
//     );

//     console.log('🎯 [AI] Enriched tags →', final);
//     return final;
//   }

//   private async fetchTrendTags(): Promise<string[]> {
//     try {
//       const res = await fetch(
//         'https://trends.google.com/trends/hottrends/visualize/internal/data/en_us',
//       );
//       if (!res.ok) throw new Error(`HTTP ${res.status}`);
//       const json = await res.json().catch(() => []);
//       const trendWords = JSON.stringify(json).toLowerCase();
//       const matched = trendWords.match(
//         /(quiet luxury|monochrome|minimalism|maximalism|italian|tailoring|loafers|neutrals|linen|structured|preppy|flannel|earth tones|autumn layering)/gi,
//       );
//       if (matched?.length) return Array.from(new Set(matched));

//       // 🧭 If Google Trends returned empty, use local backup
//       return [
//         'quiet luxury',
//         'neutral tones',
//         'tailored fit',
//         'autumn layering',
//       ];
//     } catch (err: any) {
//       console.warn('⚠️ Trend fetch fallback triggered:', err.message);
//       return [
//         'quiet luxury',
//         'neutral tones',
//         'tailored fit',
//         'autumn layering',
//       ];
//     }
//   }

//   // RECREATE//////////////
//   async recreate(
//     user_id: string,
//     tags: string[],
//     image_url?: string,
//     user_gender?: string,
//   ) {
//     console.log(
//       '🧥 [AI] recreate() called for user',
//       user_id,
//       'with tags:',
//       tags,
//       'and gender:',
//       user_gender,
//     );

//     if (!user_id) throw new Error('Missing user_id');
//     if (!tags?.length) {
//       console.warn('⚠️ [AI] recreate() empty tags → using defaults.');
//       tags = ['modern', 'neutral', 'tailored'];
//     }

//     // ✅ Weighted + trend-injected tags
//     tags = await this.enrichTags(tags);

//     // 🧠 Fetch gender_presentation if missing
//     if (!user_gender) {
//       try {
//         const result = await pool.query(
//           'SELECT gender_presentation FROM users WHERE id = $1 LIMIT 1',
//           [user_id],
//         );
//         user_gender = result.rows[0]?.gender_presentation || 'neutral';
//       } catch {
//         user_gender = 'neutral';
//       }
//     }

//     // 🧩 Normalize gender
//     const normalizedGender =
//       user_gender?.toLowerCase().includes('female') ||
//       user_gender?.toLowerCase().includes('woman')
//         ? 'female'
//         : user_gender?.toLowerCase().includes('male') ||
//             user_gender?.toLowerCase().includes('man')
//           ? 'male'
//           : process.env.DEFAULT_GENDER || 'neutral';

//     // 🧠 Build stylist prompt (base)
//     let prompt = `
//         You are a world-class AI stylist for ${normalizedGender} fashion.
//         Create a cohesive outfit inspired by an uploaded look.

//         Client: ${user_id}
//         Image: ${image_url || 'N/A'}
//         Detected tags: ${tags.join(', ')}

//         Rules:
//         - Match fabric, color palette, and silhouette.
//         - Use ${normalizedGender}-appropriate pieces.
//         - Output only JSON:
//         {
//           "outfit": [
//             { "category": "Top", "item": "Grey Cotton Tee", "color": "gray" },
//             { "category": "Bottom", "item": "Navy Chinos", "color": "navy" },
//             { "category": "Outerwear", "item": "Beige Overshirt", "color": "beige" },
//             { "category": "Shoes", "item": "White Sneakers", "color": "white" }
//           ],
//           "style_note": "Describe how the look connects to the uploaded image."
//         }
//         `;

//     // 🔹 Pull soft profile context (optional)
//     let profileCtx = '';
//     try {
//       const res = await pool.query(
//         `SELECT favorite_colors, fit_preferences, preferred_brands, disliked_styles
//        FROM style_profiles WHERE user_id::text = $1 LIMIT 1`,
//         [user_id],
//       );
//       const prof = res.rows[0];
//       if (prof) {
//         profileCtx = `
//       # USER STYLE CONTEXT (soft influence)
//       • Preferred colors: ${(prof.favorite_colors || []).join(', ') || '—'}
//       • Fit preferences: ${(prof.fit_preferences || []).join(', ') || '—'}
//       • Favorite brands: ${(prof.preferred_brands || []).join(', ') || '—'}
//       • Disliked styles: ${prof.disliked_styles || '—'}
//       Do NOT override the image’s vibe — just bias tone/material choices if relevant.
//       `;
//       }
//     } catch {
//       /* silent fail */
//     }

//     // ✅ Final prompt (merge only if context exists)
//     // Inside recreate() or personalizedShop() final prompt:
//     const finalPrompt = `
// ${prompt}

// # HARD RULES
// - ALWAYS output a full outfit of at least 4–6 distinct pieces.
// - Include a Top, Bottom, Outerwear (if seasonally appropriate), Shoes, and optionally 1–2 Accessories.
// - NEVER omit items because they already exist in the user’s wardrobe.
// - Each piece should have its own JSON object, even if similar to a wardrobe item.
// - Always include color and fit for every item.
// `;

//     // 🧠 Generate outfit via Vertex or OpenAI
//     let parsed: any;
//     if (this.useVertex && this.vertexService) {
//       try {
//         const result =
//           await this.vertexService.generateReasonedOutfit(finalPrompt);
//         let text = result?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
//         text = text
//           .replace(/^```json\s*/i, '')
//           .replace(/```$/, '')
//           .trim();
//         parsed = JSON.parse(text);
//         console.log('🧠 [Vertex] recreate() success');
//       } catch (err: any) {
//         console.warn('[Vertex] recreate() failed → fallback', err.message);
//       }
//     }

//     if (!parsed) {
//       const completion = await this.openai.chat.completions.create({
//         model: 'gpt-4o-mini',
//         temperature: 0.7,
//         messages: [{ role: 'user', content: finalPrompt }],
//         response_format: { type: 'json_object' },
//       });

//       const raw = completion.choices[0]?.message?.content || '{}';
//       try {
//         parsed = JSON.parse(raw);
//       } catch {
//         parsed = {};
//       }
//     }

//     const outfit = Array.isArray(parsed?.outfit) ? parsed.outfit : [];
//     const style_note =
//       parsed?.style_note || 'Modern outfit inspired by the uploaded look.';

//     // 🛍️ Enrich each item with live products
//     const enriched = await Promise.all(
//       outfit.map(async (o: any) => {
//         const query =
//           `${normalizedGender} ${o.item || o.category || ''} ${o.color || ''}`.trim();
//         let products = await this.productSearch.search(query);
//         let top = products[0];

//         if (!top?.image || top.image.includes('No_image')) {
//           const serp = await this.productSearch.searchSerpApi(query);
//           if (serp?.[0]) top = { ...serp[0], source: 'SerpAPI' };
//         }

//         const materialHint =
//           query.match(/(wool|cotton|linen|leather|denim|polyester)/i)?.[0] ||
//           null;
//         const seasonalityHint =
//           query.match(/(summer|winter|fall|spring)/i)?.[0] ||
//           getCurrentSeason();
//         const fitHint =
//           query.match(/(slim|regular|relaxed|oversized|tailored)/i)?.[0] ||
//           'regular';

//         return {
//           category: o.category,
//           item: o.item,
//           color: o.color,
//           brand: top?.brand || 'Unknown',
//           price: top?.price || '—',
//           image:
//             top?.image && top.image.startsWith('http')
//               ? top.image
//               : 'https://upload.wikimedia.org/wikipedia/commons/a/ac/No_image_available.svg',
//           shopUrl:
//             top?.shopUrl ||
//             `https://www.google.com/search?q=${encodeURIComponent(query)}&tbm=shop`,
//           source: top?.source || 'ASOS / Fallback',
//           material: materialHint,
//           seasonality: seasonalityHint,
//           fit: fitHint,
//         };
//       }),
//     );

//     return { user_id, outfit: enriched, style_note };
//   }

//   // 🧩 Ensure every product object includes a usable image URL
//   private fixProductImages(products: any[] = []): any[] {
//     return products.map((prod) => ({
//       ...prod,
//       image:
//         prod.image ||
//         prod.image_url ||
//         prod.thumbnail ||
//         prod.serpapi_thumbnail || // ✅ added
//         prod.img ||
//         prod.picture ||
//         prod.thumbnail_url ||
//         'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg',
//     }));
//   }

//   // 👔 PERSONALIZED SHOP — image + wardrobe + preferences
//   async personalizedShop(
//     user_id: string,
//     image_url: string,
//     user_gender?: string,
//   ) {
//     if (!user_id || !image_url) throw new Error('Missing user_id or image_url');

//     /** -----------------------------------------------------------
//      * 🧠 buildProfileConstraints(profile)
//      * Converts full style_profiles record into explicit hard rules
//      * ---------------------------------------------------------- */
//     function buildProfileConstraints(profile: any): string {
//       if (!profile) return '';

//       const fit = Array.isArray(profile.fit_preferences)
//         ? profile.fit_preferences.join(', ')
//         : profile.fit_preferences;

//       const colors = Array.isArray(profile.favorite_colors)
//         ? profile.favorite_colors.join(', ')
//         : profile.favorite_colors;

//       const brands = Array.isArray(profile.preferred_brands)
//         ? profile.preferred_brands.join(', ')
//         : profile.preferred_brands;

//       const styles = [
//         ...(profile.style_keywords || []),
//         ...(profile.style_preferences || []),
//       ]
//         .filter(Boolean)
//         .join(', ');

//       const dislikes =
//         typeof profile.disliked_styles === 'string'
//           ? profile.disliked_styles
//           : (profile.disliked_styles || []).join(', ');

//       const climate = profile.climate || 'Temperate';
//       const goals = profile.goals || '';

//       // 🔹 Inject explicit hard “only color” or “except color” rule for the model itself
//       let colorRule = '';
//       if (profile.disliked_styles?.match(/only\s+(\w+)/i)) {
//         const onlyColor = profile.disliked_styles.match(/only\s+(\w+)/i)[1];
//         colorRule = `• Use ONLY ${onlyColor} items — all other colors are forbidden.`;
//       } else if (profile.disliked_styles?.match(/except\s+(\w+)/i)) {
//         const exceptColor = profile.disliked_styles.match(/except\s+(\w+)/i)[1];
//         colorRule = `• Exclude every color except ${exceptColor}.`;
//       }

//       // 🔹 Explicitly enforce fit preferences
//       let fitRule = '';
//       if (profile.fit_preferences?.length) {
//         fitRule = `• Allow ONLY these fits: ${profile.fit_preferences.join(
//           ', ',
//         )}; exclude all others.`;
//       }

//       return `
// # USER PROFILE CONSTRAINTS (Hard Rules)

// ${fitRule}
// ${colorRule}

// • Fit: ${fit || 'Regular fit'} — outfit items must match this silhouette; exclude all opposing fits.
// • Climate: ${climate} — use materials and layers appropriate to this temperature zone.
// • Preferred brands: ${brands || '—'} — bias all product searches toward these or comparable aesthetics.
// • Favorite colors: ${colors || '—'} — bias color palette to these tones; avoid disliked colors.
// • Disliked styles: ${dislikes || '—'} — exclude these aesthetics entirely.
// • Style & vibe keywords: ${styles || '—'} — reflect these qualities in overall tone and accessories.
// • Goals: ${goals}
// • Body & proportions: ${profile.body_type || '—'}, ${
//         profile.proportions || '—'
//       } — ensure silhouette and layering suit these proportions.
// • Skin tone / hair / eyes: ${profile.skin_tone || '—'}, ${
//         profile.hair_color || '—'
//       }, ${profile.eye_color || '—'} — choose tones that complement.
// `;
//     }

//     // 1) Analyze uploaded image
//     const analysis = await this.analyze(image_url);
//     const tags = analysis?.tags || [];

//     //   const { rows: wardrobe } = await pool.query(
//     //     `SELECT name, main_category AS category, subcategory, color, material
//     //  FROM wardrobe_items
//     //  WHERE user_id::text = $1
//     //  ORDER BY updated_at DESC
//     //  LIMIT 50`,
//     //     [user_id],
//     //   );

//     // 🚫 Skip wardrobe entirely for personalized mode
//     const wardrobe: any[] = [];

//     const prefRes = await pool.query(
//       `SELECT gender_presentation
//      FROM users
//      WHERE id = $1
//      LIMIT 1`,
//       [user_id],
//     );
//     const profile = prefRes.rows[0] || {};
//     const gender = user_gender || profile.gender_presentation || 'neutral';
//     // 2️⃣ Fetch user style profile (full data used for personalization)
//     const styleProfileRes = await pool.query(
//       `
//   SELECT
//     body_type,
//     skin_tone,
//     undertone,
//     climate,
//     favorite_colors,
//     disliked_styles,
//     style_keywords,
//     preferred_brands,
//     goals,
//     proportions,
//     hair_color,
//     eye_color,
//     height,
//     waist,
//     fit_preferences,
//     style_preferences
//   FROM style_profiles
//   WHERE user_id::text = $1
//   LIMIT 1
// `,
//       [user_id],
//     );

//     const styleProfile = styleProfileRes.rows[0] || {};

//     // 🔹 Build user filter preferences
//     const { preferFit, bannedWords } = buildUserFilter(styleProfile);

//     /* ------------------------------------------------------------
//    🎛️ VISUAL + STYLE FILTERING HELPERS
// -------------------------------------------------------------*/
//     const FIT_KEYWORDS = {
//       skinny: [/skinny/i, /super[- ]skinny/i, /spray[- ]on/i],
//       slim: [/slim/i],
//       tailored: [/tailored/i, /tapered/i],
//       relaxed: [/relaxed/i, /loose/i, /baggy/i, /wide[- ]leg/i],
//       oversized: [/oversized/i, /boxy/i],
//     };

//     function buildUserFilter(profile: any) {
//       const fitPrefs = (profile.fit_preferences || []).map((x: string) =>
//         x.toLowerCase(),
//       );
//       const disliked = (profile.disliked_styles || '')
//         .toLowerCase()
//         .split(/[,\s]+/)
//         .filter(Boolean);
//       const favColors = (profile.favorite_colors || []).map((x: string) =>
//         x.toLowerCase(),
//       );

//       const preferFit =
//         fitPrefs.find((f) => /(relaxed|loose|baggy|oversized|boxy)/.test(f)) ||
//         fitPrefs.find((f) => /(regular|tailored)/.test(f)) ||
//         fitPrefs[0] ||
//         null;

//       const banFits: string[] = [];
//       if (preferFit?.match(/relaxed|loose|baggy|oversized|boxy/))
//         banFits.push('skinny', 'slim');
//       else if (preferFit?.match(/skinny|slim/))
//         banFits.push('relaxed', 'baggy', 'oversized');

//       const bannedWords = [
//         ...disliked,
//         ...banFits,
//         ...(!favColors.includes('green') ? ['green'] : []),
//       ]
//         .filter(Boolean)
//         .map((x) => new RegExp(x, 'i'));

//       return { preferFit, bannedWords };
//     }

//     function enforceProfileFilters(
//       products: any[] = [],
//       preferFit?: string | null,
//       bannedWords: RegExp[] = [],
//     ) {
//       if (!products.length) return products;

//       return products
//         .filter((p) => {
//           const hay = `${p.title || ''} ${p.name || ''} ${p.description || ''}`;
//           return !bannedWords.some((rx) => rx.test(hay));
//         })
//         .sort((a, b) => {
//           if (!preferFit) return 0;
//           const aHit = FIT_KEYWORDS[preferFit]?.some((rx) =>
//             rx.test(`${a.title} ${a.name}`),
//           )
//             ? 1
//             : 0;
//           const bHit = FIT_KEYWORDS[preferFit]?.some((rx) =>
//             rx.test(`${b.title} ${b.name}`),
//           )
//             ? 1
//             : 0;
//           return bHit - aHit; // boost preferred fits
//         });
//     }

//     // 3) Ask model to split into "owned" vs "missing"

//     const climateNote = styleProfile.climate
//       ? `The user's climate is ${styleProfile.climate}.
//     If it is cold (like Polar or Cold), emphasize insulated materials, coats, layers, scarves, gloves, and boots.
//     If it is hot (like Tropical or Desert), emphasize breathable, lightweight fabrics and open footwear.`
//       : '';

//     // 🔒 Enforced personalization hierarchy
//     const rules = `
//     # PERSONALIZATION ENFORCEMENT
//     Follow these user preferences as *absolute constraints*, not suggestions.
//     `;

//     const profileConstraints = buildProfileConstraints(styleProfile);

//     const prompt = `
// You are a world-class personal stylist generating a personalized recreation of an uploaded look.
// ${rules}
// ${profileConstraints}

// # IMAGE INSPIRATION
// • Use the uploaded image only as an aesthetic anchor (color story, silhouette, or texture).
// • Do NOT reference or reuse the user's wardrobe.
// • Respect all style profile constraints exactly.
// • Maintain the same mood and spirit as the uploaded image, not a literal copy.
// • Preserve one clear visual motif from the source image (e.g., plaid pattern or color tone) unless climate prohibits.

// # OUTPUT RULES
// - ALWAYS output a complete outfit with distinct Top, Bottom, Shoes, and (if seasonally appropriate) Outerwear and Accessories.
// - Each piece must include category, item, color, and fit.

// Return ONLY valid JSON:
// {
//   "recreated_outfit": [
//     { "source":"purchase", "category":"Top", "item":"...", "color":"...", "fit":"..." }
//   ],
//   "suggested_purchases": [
//     { "category":"...", "item":"...", "color":"...", "material":"...", "brand":"...", "shopUrl":"..." }
//   ],
//   "style_note": "Explain how this respects the user's climate, fit, and taste."
// }

// User gender: ${gender}
// Detected tags: ${tags.join(', ')}
// Weighted tags: ${tags.map((t) => `high priority: ${t}`).join(', ')}
// User style profile: ${JSON.stringify(styleProfile, null, 2)}
// ${climateNote}
// `;

//     console.log('🧥 [personalizedShop] profile:', profile);
//     console.log('🧥 [personalizedShop] gender:', gender);
//     console.log('🧥 [personalizedShop] styleProfile:', styleProfile);
//     console.log('🧠 [personalizedShop] Prompt preview:', prompt.slice(0, 800));

//     // 🧠 DEBUG START — prompt verification
//     console.log('─────────────── PROMPT SENT TO MODEL ───────────────');
//     console.log(prompt);
//     console.log('─────────────── END PROMPT ───────────────');

//     const completion = await this.openai.chat.completions.create({
//       model: 'gpt-4o-mini',
//       temperature: 0.7,
//       messages: [{ role: 'user', content: prompt }],
//       response_format: { type: 'json_object' },
//     });

//     // 🧠 DEBUG END — raw model output
//     console.log('─────────────── RAW MODEL RESPONSE ───────────────');
//     console.log(completion.choices[0]?.message?.content);
//     console.log('─────────────── END RESPONSE ───────────────');

//     let parsed: any = {};
//     try {
//       parsed = JSON.parse(completion.choices[0]?.message?.content || '{}');

//       // 🧩 SAFETY GUARD — ensure we keep valid recreated_outfit
//       try {
//         const parsedKeys = Object.keys(parsed);
//         console.log('✅ [personalizedShop] Parsed JSON keys:', parsedKeys);

//         // If model used "outfit" instead of "recreated_outfit", normalize it
//         if (!parsed.recreated_outfit && parsed.outfit) {
//           parsed.recreated_outfit = parsed.outfit;
//           console.log('✅ [personalizedShop] Mapped outfit → recreated_outfit');
//         }

//         // Double-check array validity before fallback clears it
//         if (parsed.recreated_outfit && parsed.recreated_outfit.length > 0) {
//           console.log(
//             '✅ [personalizedShop] Using recreated_outfit from model',
//           );
//         } else {
//           console.warn(
//             '⚠️ [personalizedShop] No recreated_outfit found — fallback may trigger',
//           );
//         }
//       } catch (err) {
//         console.error(
//           '❌ [personalizedShop] JSON structure guard failed:',
//           err,
//         );
//       }

//       // ✅ Final filter fix — keep wardrobe items but still respect banned fits/styles
//       if (parsed?.recreated_outfit?.length) {
//         parsed.recreated_outfit = parsed.recreated_outfit.filter((o: any) => {
//           if (!o) return false;
//           const text =
//             `${o.item} ${o.category} ${o.color} ${o.fit}`.toLowerCase();
//           if (!text.trim() || text.includes('undefined')) return false;
//           // ✅ Always keep wardrobe items regardless of style bans
//           if (o.source === 'wardrobe') return true;

//           const fitBan = preferFit?.match(/relaxed|oversized|boxy|loose/)
//             ? ['skinny']
//             : preferFit?.match(/skinny|slim|tailored/)
//               ? ['relaxed', 'baggy', 'oversized']
//               : [];

//           const styleBan =
//             (styleProfile.disliked_styles || '')
//               .toLowerCase()
//               .split(/[,\s]+/)
//               .filter(Boolean) || [];

//           const banned = [...fitBan, ...styleBan];
//           return !banned.some((b) => text.includes(b));
//         });

//         console.log(
//           '✅ [personalizedShop] Final filtered outfit →',
//           parsed.recreated_outfit,
//         );
//       }

//       console.log(
//         '💎 [personalizedShop] Parsed recreated outfit sample:',
//         parsed?.recreated_outfit?.slice(0, 2),
//       );
//       console.log(
//         '💎 [personalizedShop] Parsed suggested purchases sample:',
//         parsed?.suggested_purchases?.slice(0, 2),
//       );

//       // 🧩 Merge recreated_outfit into suggested_purchases for display
//       if (
//         Array.isArray(parsed?.recreated_outfit) &&
//         parsed.recreated_outfit.length
//       ) {
//         parsed.suggested_purchases = [
//           ...(parsed.suggested_purchases || []),
//           ...parsed.recreated_outfit.map((o: any) => ({
//             ...o,
//             brand: o.brand || '—',
//             previewImage: o.previewImage || o.image || o.image_url || null,
//             source: 'purchase',
//           })),
//         ];
//         console.log(
//           '🧩 [personalizedShop] merged recreated_outfit → suggested_purchases',
//         );
//       }

//       // 🖼️ Ensure every recreated outfit item has a visible preview image
//       if (Array.isArray(parsed?.recreated_outfit)) {
//         parsed.recreated_outfit = parsed.recreated_outfit.map((item: any) => {
//           if (!item.previewImage && item.source === 'wardrobe') {
//             item.previewImage =
//               item.image_url ||
//               item.wardrobe_image ||
//               'https://upload.wikimedia.org/wikipedia/commons/a/ac/No_image_available.svg';
//           }
//           return item;
//         });
//       }

//       // 🎨 Enforce "only <color>" rule from disliked_styles (e.g. "I dislike all colors except pink")
//       // 🎨 Optional color-only enforcement — only if explicit "ONLY <color>" flag exists
//       if (styleProfile?.disliked_styles?.toLowerCase().includes('only')) {
//         const match = styleProfile.disliked_styles.match(/only\s+(\w+)/i);
//         if (match) {
//           const onlyColor = match[1].toLowerCase();
//           const filterColor = (arr: any[]) =>
//             arr.filter((x) =>
//               (x.color || '').toLowerCase().includes(onlyColor),
//             );

//           if (Array.isArray(parsed?.recreated_outfit))
//             parsed.recreated_outfit = filterColor(parsed.recreated_outfit);
//           if (Array.isArray(parsed?.suggested_purchases))
//             parsed.suggested_purchases = filterColor(
//               parsed.suggested_purchases,
//             );

//           console.log(
//             `[personalizedShop] 🎨 Enforcing ONLY-color rule: ${onlyColor}`,
//           );
//         }
//       }
//     } catch {
//       parsed = {};
//     }

//     const purchases = Array.isArray(parsed?.suggested_purchases)
//       ? parsed.suggested_purchases
//       : [];

//     if (parsed?.recreated_outfit?.some((i: any) => i.source === 'wardrobe')) {
//       console.log('🧥 [personalizedShop] ✅ Model reused wardrobe pieces.');
//     } else {
//       console.warn(
//         '🧥 [personalizedShop] ⚠️ Model did NOT reuse wardrobe — fallback to generic recreation.',
//       );
//     }

//     // 🚫 Enforce profile bans in returned outfit
//     const banned = [
//       ...(styleProfile.disliked_styles?.toLowerCase().split(/[,\s]+/) || []),
//       ...(preferFit?.match(/relaxed|oversized|boxy|loose/)
//         ? ['skinny', 'slim']
//         : []),
//       ...(preferFit?.match(/skinny|slim/)
//         ? ['relaxed', 'oversized', 'baggy']
//         : []),
//     ].filter(Boolean);

//     if (parsed?.recreated_outfit?.length) {
//       // ✅ Keep *all* wardrobe and purchase items — only filter garbage entries
//       parsed.recreated_outfit = parsed.recreated_outfit.filter((o: any) => {
//         if (!o || !o.item) return false;
//         const text =
//           `${o.item} ${o.category} ${o.color} ${o.fit}`.toLowerCase();
//         return text.trim().length > 0 && !text.includes('undefined');
//       });

//       // 🧱 Guarantee full outfit completeness (Top, Bottom, Shoes, Optional Outerwear/Accessory)
//       const categories = parsed.recreated_outfit.map((o: any) =>
//         o.category?.toLowerCase(),
//       );
//       const missing: any[] = [];

//       if (!categories.includes('top'))
//         missing.push({
//           source: 'purchase',
//           category: 'Top',
//           item: 'White Oxford Shirt',
//           color: 'White',
//           fit: 'Slim Fit',
//         });
//       if (!categories.includes('bottoms'))
//         missing.push({
//           source: 'purchase',
//           category: 'Bottoms',
//           item: 'Beige Chinos',
//           color: 'Beige',
//           fit: 'Slim Fit',
//         });
//       if (!categories.includes('shoes'))
//         missing.push({
//           source: 'purchase',
//           category: 'Shoes',
//           item: 'White Leather Sneakers',
//           color: 'White',
//           fit: 'Slim Fit',
//         });

//       parsed.recreated_outfit.push(...missing);

//       console.log(
//         '✅ [personalizedShop] Final full outfit →',
//         parsed.recreated_outfit,
//       );
//     }

//     // 🧩 Centralized enforcement for personalizedShop only
//     function applyProfileFilters(products: any[], profile: any) {
//       if (!Array.isArray(products) || !products.length) return [];

//       const favColors = (profile.favorite_colors || []).map((x: string) =>
//         x.toLowerCase(),
//       );
//       const prefBrands = (profile.preferred_brands || []).map((x: string) =>
//         x.toLowerCase(),
//       );
//       const fitPrefs = (profile.fit_preferences || []).map((x: string) =>
//         x.toLowerCase(),
//       );
//       const dislikes = (profile.disliked_styles || '')
//         .toLowerCase()
//         .split(/[,\s]+/);
//       const climate = (profile.climate || '').toLowerCase();

//       const isCold = /(polar|cold|arctic|tundra|winter)/.test(climate);
//       const isHot = /(tropical|desert|hot|humid|summer)/.test(climate);

//       // 🩷 detect "only" or "except" color rule from disliked_styles
//       let onlyColor: string | null = null;
//       let exceptColor: string | null = null;

//       if (profile.disliked_styles?.match(/only\s+(\w+)/i)) {
//         onlyColor = profile.disliked_styles
//           .match(/only\s+(\w+)/i)[1]
//           .toLowerCase();
//       } else if (profile.disliked_styles?.match(/except\s+(\w+)/i)) {
//         exceptColor = profile.disliked_styles
//           .match(/except\s+(\w+)/i)[1]
//           .toLowerCase();
//       }

//       return products
//         .filter((p) => {
//           const t = `${p.name ?? ''} ${p.title ?? ''} ${p.brand ?? ''} ${
//             p.description ?? ''
//           } ${p.color ?? ''} ${p.fit ?? ''}`.toLowerCase();

//           // 🚫 Filter out disliked words/styles
//           if (dislikes.some((d) => d && t.includes(d))) return false;

//           // 🎨 HARD color enforcement from DB rules
//           if (onlyColor) {
//             // Only allow if text or color includes the specified color
//             if (
//               !t.includes(onlyColor) &&
//               !p.color?.toLowerCase().includes(onlyColor)
//             )
//               return false;
//           } else if (exceptColor) {
//             // Exclude everything not matching that color
//             if (
//               !t.includes(exceptColor) &&
//               !p.color?.toLowerCase().includes(exceptColor)
//             )
//               return false;
//           } else {
//             // Normal favorite color bias if no hard rule
//             if (favColors.length && !favColors.some((c) => t.includes(c)))
//               return false;
//           }

//           // 👕 Fit preferences
//           if (fitPrefs.length && !fitPrefs.some((f) => t.includes(f)))
//             return false;

//           // 🌡️ Climate-based filtering
//           if (isCold && /(tank|shorts|sandal)/.test(t)) return false;
//           if (isHot && /(wool|parka|coat|boot|knit)/.test(t)) return false;

//           return true;
//         })
//         .sort((a, b) => {
//           const score = (x: any) => {
//             const txt =
//               `${x.name} ${x.title} ${x.brand} ${x.color} ${x.fit}`.toLowerCase();
//             let s = 0;
//             if (onlyColor && txt.includes(onlyColor)) s += 4;
//             if (exceptColor && txt.includes(exceptColor)) s += 4;
//             if (favColors.some((c) => txt.includes(c))) s += 2;
//             if (prefBrands.some((b) => txt.includes(b))) s += 2;
//             if (fitPrefs.some((f) => txt.includes(f))) s += 1;
//             return s;
//           };
//           return score(b) - score(a);
//         });
//     }

//     // 4️⃣ Attach live shop links to the "missing" items — now honoring user taste
//     let enrichedPurchases = await Promise.all(
//       purchases.map(async (p: any) => {
//         // 🧠 Gender-locked prefix
//         const genderPrefix =
//           gender?.toLowerCase().includes('female') ||
//           gender?.toLowerCase().includes('woman')
//             ? 'women female womens ladies'
//             : 'men male mens masculine -women -womens -female -girls -ladies';

//         // Base query with gender lock
//         let q = [
//           genderPrefix,
//           p.item || p.category || '',
//           p.color || '',
//           p.material || '',
//         ]
//           .filter(Boolean)
//           .join(' ')
//           .trim();

//         // 🔹 Inject personalization bias terms
//         const brandTerms = (styleProfile.preferred_brands || [])
//           .slice(0, 3)
//           .join(' ');
//         const colorTerms = (styleProfile.favorite_colors || [])
//           .slice(0, 2)
//           .join(' ');
//         const fitTerms = Array.isArray(styleProfile.fit_preferences)
//           ? styleProfile.fit_preferences.join(' ')
//           : styleProfile.fit_preferences || '';

//         // 🎨 “Only color” rule (e.g. “I dislike all colors except pink”)
//         const colorMatch =
//           styleProfile.disliked_styles?.match(/except\s+(\w+)/i);
//         if (colorMatch) {
//           const onlyColor = colorMatch[1].toLowerCase();
//           q += ` ${onlyColor}`;
//         }

//         // Combine into final query with brand + color + fit bias
//         q = [q, brandTerms, colorTerms, fitTerms].filter(Boolean).join(' ');

//         // 🔒 Ensure all queries exclude female results explicitly
//         if (
//           !/-(women|female|ladies|girls)/i.test(q) &&
//           /\bmen\b|\bmale\b/i.test(q)
//         ) {
//           q += ' -women -womens -female -girls -ladies';
//         }

//         // Combine into final query with brand + color + fit bias
//         q = [q, brandTerms, colorTerms, fitTerms].filter(Boolean).join(' ');

//         // 🔒 Ensure all queries exclude female results explicitly
//         if (
//           !/-(women|female|ladies|girls)/i.test(q) &&
//           /\bmen\b|\bmale\b/i.test(q)
//         ) {
//           q += ' -women -womens -female -girls -ladies';
//         }

//         // 🧠 Gender-aware product search
//         let products = await this.productSearch.search(
//           q,
//           gender?.toLowerCase() === 'female'
//             ? 'female'
//             : gender?.toLowerCase() === 'male'
//               ? 'male'
//               : 'unisex',
//         );

//         // 🚫 Filter out any accidental female/unisex results
//         products = products.filter(
//           (prod) =>
//             !/women|female|womens|ladies|girls/i.test(
//               `${prod.name ?? ''} ${prod.brand ?? ''} ${prod.title ?? ''}`,
//             ),
//         );

//         // 🩷 Hard visual color filter — ensures displayed products actually match the enforced color rule
//         if (
//           styleProfile?.disliked_styles?.match(/only\s+(\w+)/i) ||
//           styleProfile?.disliked_styles?.match(/except\s+(\w+)/i)
//         ) {
//           const match =
//             styleProfile.disliked_styles.match(/only\s+(\w+)/i) ||
//             styleProfile.disliked_styles.match(/except\s+(\w+)/i);
//           const enforcedColor = match?.[1]?.toLowerCase();
//           if (enforcedColor) {
//             products = products.filter((p) => {
//               const text =
//                 `${p.name ?? ''} ${p.title ?? ''} ${p.color ?? ''}`.toLowerCase();
//               return text.includes(enforcedColor);
//             });
//           }
//         }

//         return {
//           ...p,
//           query: q,
//           products: applyProfileFilters(products, styleProfile),
//         };
//       }),
//     );

//     // 5️⃣ Fallback enrichment if AI returned nothing or products failed
//     if (!enrichedPurchases.length) {
//       console.warn(
//         '⚠️ [personalizedShop] Empty suggested_purchases → fallback.',
//       );

//       const tagSeed = tags.slice(0, 6).join(' ');
//       const season = getCurrentSeason();

//       // 🧠 Gender prefix for fallback with hard lock
//       const genderPrefix =
//         gender?.toLowerCase().includes('female') ||
//         gender?.toLowerCase().includes('woman')
//           ? 'women female womens ladies'
//           : 'men male mens masculine -women -womens -female -girls -ladies';

//       // 🧠 Enrich fallback with style taste as well
//       const brandTerms = (styleProfile.preferred_brands || [])
//         .slice(0, 3)
//         .join(' ');
//       const colorTerms = (styleProfile.favorite_colors || [])
//         .slice(0, 2)
//         .join(' ');
//       const fitTerms = Array.isArray(styleProfile.fit_preferences)
//         ? styleProfile.fit_preferences.join(' ')
//         : styleProfile.fit_preferences || '';

//       const fallbackQuery = `${genderPrefix} ${tagSeed} ${season} fashion ${brandTerms} ${colorTerms} ${fitTerms}`;
//       console.log('🧩 [personalizedShop] fallbackQuery →', fallbackQuery);

//       const products = await this.productSearch.search(
//         fallbackQuery,
//         gender?.toLowerCase() === 'female'
//           ? 'female'
//           : gender?.toLowerCase() === 'male'
//             ? 'male'
//             : 'unisex',
//       );

//       // 🚫 Filter out any accidental female/unisex results
//       const maleProducts = products.filter(
//         (prod) =>
//           !/women|female|womens|ladies|girls/i.test(
//             `${prod.name ?? ''} ${prod.brand ?? ''} ${prod.title ?? ''}`,
//           ),
//       );

//       enrichedPurchases = [
//         {
//           category: 'General',
//           item: 'Curated Outfit Add-Ons',
//           color: 'Mixed',
//           material: null,
//           products: applyProfileFilters(maleProducts.slice(0, 8), styleProfile),
//           query: fallbackQuery,
//           source: 'fallback',
//         },
//       ];
//     }

//     // 🎨 Enforce color-only rule on fallback products too
//     if (styleProfile?.disliked_styles) {
//       const match = styleProfile.disliked_styles.match(/except\s+(\w+)/i);
//       if (match) {
//         const onlyColor = match[1].toLowerCase();
//         enrichedPurchases = enrichedPurchases.map((p) => ({
//           ...p,
//           products: (p.products || []).filter((prod) =>
//             (prod.color || '').toLowerCase().includes(onlyColor),
//           ),
//         }));
//         console.log(
//           `[personalizedShop] 🎨 Enforced fallback color-only rule: ${onlyColor}`,
//         );
//       }
//     }

//     const cleanPurchases = enrichedPurchases.map((p) => ({
//       ...p,
//       products: this.fixProductImages(
//         enforceProfileFilters(p.products || [], preferFit, bannedWords),
//       ),
//     }));

//     // 🎨 FINAL VISUAL CONSISTENCY NORMALIZATION
//     const normalizedPurchases = await Promise.all(
//       enrichedPurchases.map(async (p) => {
//         const validProduct =
//           (p.products || []).find(
//             (x) =>
//               (x.image ||
//                 x.image_url ||
//                 x.thumbnail ||
//                 x.serpapi_thumbnail ||
//                 x.thumbnail_url ||
//                 x.img ||
//                 x.result?.thumbnail ||
//                 x.result?.serpapi_thumbnail) &&
//               /^https?:\/\//.test(
//                 x.image ||
//                   x.image_url ||
//                   x.thumbnail ||
//                   x.serpapi_thumbnail ||
//                   x.thumbnail_url ||
//                   x.img ||
//                   x.result?.thumbnail ||
//                   x.result?.serpapi_thumbnail ||
//                   '',
//               ) &&
//               !/no[_-]?image/i.test(
//                 x.image ||
//                   x.image_url ||
//                   x.thumbnail ||
//                   x.serpapi_thumbnail ||
//                   x.thumbnail_url ||
//                   x.img ||
//                   '',
//               ),
//           ) || p.products?.[0];

//         let previewImage =
//           validProduct?.image ||
//           validProduct?.image_url ||
//           validProduct?.thumbnail ||
//           validProduct?.serpapi_thumbnail ||
//           validProduct?.thumbnail_url ||
//           validProduct?.img ||
//           validProduct?.product_thumbnail ||
//           validProduct?.result?.thumbnail ||
//           validProduct?.result?.serpapi_thumbnail ||
//           null;

//         // 🎯 Gender-aware image guard
//         const userGender = (gender || '').toLowerCase();

//         if (previewImage) {
//           const url = previewImage.toLowerCase();

//           // 🧍‍♂️ If male → block clearly female-coded URLs
//           if (
//             userGender.includes('male') &&
//             /(women|woman|female|ladies|girls|womenswear|femme|skims|shein|fashionnova|princesspolly|revolve|anthropologie)/i.test(
//               url,
//             )
//           ) {
//             previewImage =
//               'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg';
//           }

//           // 🧍‍♀️ If female → block clearly male-coded URLs
//           else if (
//             userGender.includes('female') &&
//             /(men|man|male|menswear|masculine)/i.test(url)
//           ) {
//             previewImage =
//               'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg';
//           }

//           // 🧍 Unisex → allow all images
//         }

//         // 🧠 If still missing, do a quick SerpAPI lookup and cache
//         if (!previewImage && p.query) {
//           const results = await this.productSearch.searchSerpApi(p.query);
//           const r = results?.[0];
//           previewImage =
//             r?.image ||
//             r?.image_url ||
//             r?.thumbnail ||
//             r?.serpapi_thumbnail ||
//             r?.thumbnail_url ||
//             r?.result?.thumbnail ||
//             r?.result?.serpapi_thumbnail ||
//             null;

//           // 🎯 Apply same gender guard to SerpAPI result
//           if (previewImage) {
//             const url = previewImage.toLowerCase();

//             if (
//               userGender.includes('male') &&
//               /(women|woman|female|ladies|girls|womenswear|femme|skims|shein|fashionnova|princesspolly|revolve|anthropologie)/i.test(
//                 url,
//               )
//             ) {
//               previewImage =
//                 'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg';
//             } else if (
//               userGender.includes('female') &&
//               /(men|man|male|menswear|masculine)/i.test(url)
//             ) {
//               previewImage =
//                 'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg';
//             }
//           }
//         }

//         return {
//           ...p,
//           previewImage:
//             previewImage ||
//             'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg',
//           previewBrand: validProduct?.brand || p.brand || 'Unknown',
//           previewPrice: validProduct?.price || '—',
//           previewUrl: validProduct?.shopUrl || p.shopUrl || null,
//         };
//       }),
//     ); // ✅ ← closes Promise.all()

//     // 🧹 remove empty product groups (no valid images)
//     const filteredPurchases = normalizedPurchases.filter(
//       (p) => !!p.previewImage,
//     );

//     // 🧊 Climate sanity check — if Polar but outfit lacks insulation, patch style_note
//     if (
//       styleProfile.climate?.toLowerCase().includes('polar') &&
//       !/coat|jacket|parka|boot|knit|sweater/i.test(
//         JSON.stringify(parsed.recreated_outfit || []),
//       )
//     ) {
//       parsed.style_note +=
//         ' Reinforced with insulated outerwear and cold-weather layering for Polar climates.';
//     }

//     // 🚫 Prevent fallback or secondary recreate() from overwriting personalized flow
//     if (
//       enrichedPurchases?.length > 0 ||
//       parsed?.suggested_purchases?.length > 0
//     ) {
//       console.log(
//         '✅ [personalizedShop] Finalizing personalized results — skipping generic recreate()',
//       );
//       return {
//         user_id,
//         image_url,
//         tags,
//         recreated_outfit: parsed?.recreated_outfit || [],
//         suggested_purchases: normalizedPurchases,
//         style_note:
//           parsed?.style_note ||
//           'Personalized recreation based on your wardrobe, with curated seasonal add-ons.',
//         applied_filters: {
//           preferFit,
//           bannedWords: bannedWords.map((r) => r.source),
//         },
//       };
//     }

//     return {
//       user_id,
//       image_url,
//       tags,
//       recreated_outfit: parsed?.recreated_outfit || [],
//       suggested_purchases: normalizedPurchases,
//       style_note:
//         parsed?.style_note ||
//         'Personalized recreation based on your wardrobe, with curated seasonal add-ons.',
//       applied_filters: {
//         preferFit,
//         bannedWords: bannedWords.map((r) => r.source),
//       },
//     };
//   }

//   ////////END CREATE LOOK

//   //////. START REPLACED CHAT WITH LINKS AND SEARCH NET
//   async chat(dto: ChatDto) {
//     const { messages, user_id } = dto;
//     const lastUserMsg = messages
//       .slice()
//       .reverse()
//       .find((m) => m.role === 'user')?.content;

//     if (!lastUserMsg) {
//       throw new Error('No user message provided');
//     }

//     /* 🧠 --- MEMORY BLOCK START --- */
//     try {
//       // Save the latest user message
//       await pool.query(
//         `INSERT INTO chat_messages (user_id, role, content)
//        VALUES ($1,$2,$3)`,
//         [user_id, 'user', lastUserMsg],
//       );

//       // Fetch the last 10 messages for this user
//       const { rows } = await pool.query(
//         `SELECT role, content
//        FROM chat_messages
//        WHERE user_id = $1
//        ORDER BY created_at DESC
//        LIMIT 10`,
//         [user_id],
//       );

//       // Add them (chronological) to current messages for context
//       const history = rows.reverse();
//       for (const h of history) {
//         if (h.content !== lastUserMsg)
//           messages.unshift({ role: h.role, content: h.content });
//       }

//       // 🧹 Purge older messages beyond last 30
//       await pool.query(
//         `DELETE FROM chat_messages
//        WHERE user_id = $1
//        AND id NOT IN (
//          SELECT id FROM chat_messages
//          WHERE user_id = $1
//          ORDER BY created_at DESC
//          LIMIT 30
//        );`,
//         [user_id],
//       );
//     } catch (err: any) {
//       console.warn('⚠️ chat history retrieval failed:', err.message);
//     }
//     /* 🧠 --- MEMORY BLOCK END --- */

//     /* 🧠 --- LOAD LONG-TERM SUMMARY MEMORY (with Redis cache) --- */
//     let longTermSummary = '';
//     try {
//       const cacheKey = `memory:${user_id}`;
//       const cached = await redis.get<string>(cacheKey);

//       if (cached) {
//         console.log(`🟢 Redis HIT for ${cacheKey}`);
//         longTermSummary = cached;
//       } else {
//         console.log(`🔴 Redis MISS for ${cacheKey} — fetching from Postgres`);
//         const { rows } = await pool.query(
//           `SELECT summary FROM chat_memory WHERE user_id = $1`,
//           [user_id],
//         );
//         if (rows[0]?.summary) {
//           longTermSummary = rows[0].summary;
//           console.log(`🟢 Caching summary in Redis for ${cacheKey}`);
//           await redis.set(cacheKey, longTermSummary, { ex: 86400 });
//         }
//       }
//     } catch (err: any) {
//       console.warn(
//         '⚠️ failed to load summary from Redis/Postgres:',
//         err.message,
//       );
//     }

//     // 1️⃣ Generate base text with OpenAI
//     const completion = await this.openai.chat.completions.create({
//       model: 'gpt-4o',
//       temperature: 0.8,
//       messages: [
//         {
//           role: 'system',
//           content: `
// You are a world-class personal fashion stylist.
// Keep in mind the user's previous preferences and style details:
// ${longTermSummary || '(no prior memory yet)'}
// Respond naturally about outfits, wardrobe planning, or styling.
// At the end, return a short JSON block like:
// {"search_terms":["smart casual men","navy blazer outfit","loafers"]}
//         `,
//         },
//         ...messages,
//       ],
//     });

//     const aiReply =
//       completion.choices[0]?.message?.content?.trim() ||
//       'Styled response unavailable.';

//     // 2️⃣ Extract search terms if model provided them
//     let searchTerms: string[] = [];
//     const match = aiReply.match(/\{.*"search_terms":.*\}/s);
//     if (match) {
//       try {
//         const parsed = JSON.parse(match[0]);
//         searchTerms = parsed.search_terms ?? [];
//       } catch {
//         searchTerms = [];
//       }
//     }

//     // 3️⃣ Fallback heuristic: derive terms if none found
//     if (!searchTerms.length) {
//       const lowered = lastUserMsg.toLowerCase();
//       if (lowered.includes('smart')) searchTerms.push('smart casual outfit');
//       if (lowered.includes('summer')) searchTerms.push('summer outfit');
//       if (lowered.includes('work')) searchTerms.push('business casual look');
//       if (!searchTerms.length)
//         searchTerms.push(`${lowered} outfit inspiration`);
//     }

//     // 4️⃣ Fetch Unsplash images
//     const images = await this.fetchUnsplash(searchTerms);

//     // 5️⃣ Build shoppable links
//     const links = searchTerms.map((term) => ({
//       label: `Shop ${term} on ASOS`,
//       url: `https://www.asos.com/search/?q=${encodeURIComponent(term)}`,
//     }));

//     /* 🧠 --- SAVE ASSISTANT REPLY --- */
//     try {
//       await pool.query(
//         `INSERT INTO chat_messages (user_id, role, content)
//        VALUES ($1,$2,$3)`,
//         [user_id, 'assistant', aiReply],
//       );
//     } catch (err: any) {
//       console.warn('⚠️ failed to store assistant reply:', err.message);
//     }

//     /* 🧠 --- UPDATE LONG-TERM SUMMARY MEMORY (Postgres + Redis) --- */
//     try {
//       const { rows } = await pool.query(
//         `SELECT summary FROM chat_memory WHERE user_id = $1`,
//         [user_id],
//       );
//       const prevSummary = rows[0]?.summary || '';

//       const { rows: recent } = await pool.query(
//         `SELECT role, content FROM chat_messages
//        WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
//         [user_id],
//       );

//       const context = recent
//         .reverse()
//         .map((r) => `${r.role}: ${r.content}`)
//         .join('\n');

//       const memoryPrompt = `
// You are a memory summarizer for an AI stylist.
// Update this user's long-term fashion memory summary.
// Keep what you've already learned, and merge any new useful insights.

// Previous memory summary:
// ${prevSummary}

// Recent chat history:
// ${context}

// Write a concise, 150-word updated summary focusing on their taste, preferences, and style evolution.
// `;

//       const memCompletion = await this.openai.chat.completions.create({
//         model: 'gpt-4o-mini',
//         temperature: 0.3,
//         messages: [{ role: 'system', content: memoryPrompt }],
//       });

//       const newSummary =
//         memCompletion.choices[0]?.message?.content?.trim() || prevSummary;

//       const trimmedSummary = newSummary.slice(0, 1000).replace(/[*_#`]/g, '');

//       await pool.query(
//         `INSERT INTO chat_memory (user_id, summary, updated_at)
//        VALUES ($1, $2, NOW())
//        ON CONFLICT (user_id)
//        DO UPDATE SET summary = $2, updated_at = NOW();`,
//         [user_id, trimmedSummary],
//       );

//       // ✅ Cache the updated summary in Redis for 24 hours
//       await redis.set(`memory:${user_id}`, trimmedSummary, { ex: 86400 });
//     } catch (err: any) {
//       console.warn('⚠️ failed to update long-term memory:', err.message);
//     }

//     return { reply: aiReply, images, links };
//   }

//   // 🧠 Completely clear all chat + memory for a user
//   async clearChatHistory(user_id: string) {
//     try {
//       // 1️⃣ Delete all chat messages for the user
//       await pool.query(`DELETE FROM chat_messages WHERE user_id = $1`, [
//         user_id,
//       ]);

//       // 2️⃣ Delete long-term memory summaries
//       await pool.query(`DELETE FROM chat_memory WHERE user_id = $1`, [user_id]);

//       // 3️⃣ Clear Redis cache for this user
//       await redis.del(`memory:${user_id}`);

//       console.log(`🧹 Cleared ALL chat + memory for user ${user_id}`);
//       return { success: true, message: 'All chat history and memory cleared.' };
//     } catch (err: any) {
//       console.error('❌ Failed to clear chat history:', err.message);
//       throw new Error('Failed to clear chat history.');
//     }
//   }

//   // 🧹 Soft reset: clear short-term chat but retain long-term memory
//   async softResetChat(user_id: string) {
//     try {
//       // Delete recent messages but keep memory summary
//       await pool.query(`DELETE FROM chat_messages WHERE user_id = $1`, [
//         user_id,
//       ]);

//       console.log(`🧹 Soft reset chat for user ${user_id}`);
//       return {
//         success: true,
//         message: 'Recent chat messages cleared (long-term memory retained).',
//       };
//     } catch (err: any) {
//       console.error('❌ Failed to soft-reset chat:', err.message);
//       throw new Error('Failed to soft reset chat.');
//     }
//   }

//   /** 🔍 Lightweight Unsplash fetch helper */
//   private async fetchUnsplash(terms: string[]) {
//     const key = process.env.UNSPLASH_ACCESS_KEY;
//     if (!key || !terms.length) return [];
//     const q = encodeURIComponent(terms[0]);
//     const res = await fetch(
//       `https://api.unsplash.com/search/photos?query=${q}&per_page=5&client_id=${key}`,
//     );
//     if (!res.ok) return [];
//     const json = await res.json();
//     return json.results.map((r) => ({
//       imageUrl: r.urls.small,
//       title: r.description || r.alt_description,
//       sourceLink: r.links.html,
//     }));
//   }

//   /** 🌤️ Suggest daily style plan */
//   async suggest(body: {
//     user?: string;
//     weather?: any;
//     wardrobe?: any[];
//     preferences?: Record<string, any>;
//   }) {
//     const { user, weather, wardrobe, preferences } = body;

//     const temp = weather?.fahrenheit?.main?.temp;
//     const tempDesc = temp
//       ? `${temp}°F and ${temp < 60 ? 'cool' : temp > 85 ? 'warm' : 'mild'} weather`
//       : 'unknown temperature';

//     const wardrobeCount = wardrobe?.length || 0;

//     const systemPrompt = `
// You are a luxury personal stylist.
// Your goal is to provide a daily style briefing that helps the user feel prepared, stylish, and confident.
// Be concise, intelligent, and polished — similar to a stylist at a high-end menswear brand.

// Output must be JSON with:
// - suggestion
// - insight
// - tomorrow
// Optionally include seasonalForecast, lifecycleForecast, styleTrajectory.
// `;

//     const userPrompt = `
// Client: ${user || 'The user'}
// Weather: ${tempDesc}
// Wardrobe items: ${wardrobeCount}
// Preferences: ${JSON.stringify(preferences || {})}
// `;

//     const completion = await this.openai.chat.completions.create({
//       model: 'gpt-4o',
//       temperature: 0.8,
//       messages: [
//         { role: 'system', content: systemPrompt },
//         { role: 'user', content: userPrompt },
//       ],
//       response_format: { type: 'json_object' },
//     });

//     const raw = completion.choices[0]?.message?.content;
//     if (!raw) throw new Error('No suggestion response received from model.');

//     let parsed: {
//       suggestion: string;
//       insight: string;
//       tomorrow: string;
//       seasonalForecast?: string;
//       lifecycleForecast?: string;
//       styleTrajectory?: string;
//     };

//     try {
//       parsed = JSON.parse(raw);
//     } catch {
//       console.error('❌ Failed to parse AI JSON:', raw);
//       throw new Error('AI response was not valid JSON.');
//     }

//     if (!parsed.seasonalForecast) {
//       parsed.seasonalForecast = generateSeasonalForecast(wardrobe);
//     }

//     return parsed;
//   }

//   /* ------------------------------------------------------------
//      🧾 BARCODE / CLOTHING LABEL DECODER
//   -------------------------------------------------------------*/
//   async decodeBarcode(file: {
//     buffer: Buffer;
//     originalname: string;
//     mimetype: string;
//   }) {
//     const tempPath = `/tmp/${Date.now()}-barcode.jpg`;
//     fs.writeFileSync(tempPath, file.buffer);

//     try {
//       const base64 = fs.readFileSync(tempPath).toString('base64');

//       const prompt = `
//       You are analyzing a photo of a product or clothing label.
//       If the image contains a barcode, return ONLY the numeric digits (UPC/EAN).
//       Otherwise, infer structured product info like:
//       {
//         "name": "Uniqlo Linen Shirt",
//         "brand": "Uniqlo",
//         "category": "Shirts",
//         "material": "Linen"
//       }
//       Respond with JSON only. No extra text.
//       `;

//       const completion = await this.openai.chat.completions.create({
//         model: 'gpt-4o-mini',
//         messages: [
//           {
//             role: 'user',
//             content: [
//               { type: 'text', text: prompt },
//               {
//                 type: 'image_url',
//                 image_url: { url: `data:${file.mimetype};base64,${base64}` },
//               },
//             ],
//           },
//         ],
//         max_tokens: 200,
//       });

//       const message = completion.choices?.[0]?.message;

//       let text = '';
//       if (typeof message?.content === 'string') {
//         text = message.content;
//       } else if (Array.isArray(message?.content)) {
//         const parts = message.content as Array<{ text?: string }>;
//         text = parts.map((c) => c.text || '').join(' ');
//       }

//       text = text.trim().replace(/```json|```/g, '');

//       const match = text.match(/\b\d{8,14}\b/);
//       if (match) return { barcode: match[0], raw: text };

//       try {
//         const parsed = JSON.parse(text);
//         if (parsed?.name) return { barcode: null, inferred: parsed };
//       } catch {}

//       return { barcode: null, raw: text };
//     } catch (err: any) {
//       console.error('❌ [AI] decodeBarcode error:', err.message);
//       return { barcode: null, error: err.message };
//     } finally {
//       try {
//         fs.unlinkSync(tempPath);
//       } catch {}
//     }
//   }

//   /* ------------------------------------------------------------
//      🧩 PRODUCT LOOKUP BY BARCODE
//   -------------------------------------------------------------*/
//   async lookupProductByBarcode(upc: string) {
//     const normalized = upc.padStart(12, '0');
//     try {
//       const res = await fetch(
//         `https://api.upcitemdb.com/prod/trial/lookup?upc=${normalized}`,
//       );
//       const json = await res.json();

//       const item = json?.items?.[0];
//       if (!item) throw new Error('No product data from UPCItemDB');

//       return {
//         name: item.title,
//         brand: item.brand,
//         image: item.images?.[0],
//         category: item.category,
//         source: 'upcitemdb',
//       };
//     } catch (err: any) {
//       console.warn('⚠️ UPCItemDB lookup failed:', err.message);
//       const fallback = await this.lookupFallback(normalized);
//       if (!fallback?.name || fallback.name === 'Unknown product') {
//         return await this.lookupFallbackWithAI(normalized);
//       }
//       return fallback;
//     }
//   }

//   /* ------------------------------------------------------------
//      🔁 RapidAPI or Dummy Fallback
//   -------------------------------------------------------------*/
//   async lookupFallback(upc: string) {
//     try {
//       const res = await fetch(`https://barcodes1.p.rapidapi.com/?upc=${upc}`, {
//         headers: {
//           'X-RapidAPI-Key': process.env.RAPIDAPI_KEY ?? '',
//           'X-RapidAPI-Host': 'barcodes1.p.rapidapi.com',
//         },
//       });

//       const json = await res.json();
//       const product = json?.product ?? {};

//       return {
//         name: product.title || json.title || 'Unknown product',
//         brand: product.brand || json.brand || 'Unknown brand',
//         image: product.image || json.image || null,
//         category: product.category || 'Uncategorized',
//         source: 'rapidapi',
//       };
//     } catch (err: any) {
//       console.error('❌ lookupFallback failed:', err.message);
//       return { name: null, brand: null, image: null, category: null };
//     }
//   }

//   /* ------------------------------------------------------------
//      🤖 AI Fallback Guess
//   -------------------------------------------------------------*/
//   async lookupFallbackWithAI(upc: string) {
//     try {
//       const prompt = `
//       The barcode number is: ${upc}.
//       Guess the product based on global manufacturer codes.
//       Return valid JSON only:
//       {"name":"Example Product","brand":"Brand","category":"Category"}
//       `;

//       const completion = await this.openai.chat.completions.create({
//         model: 'gpt-4o-mini',
//         messages: [{ role: 'user', content: prompt }],
//         max_tokens: 150,
//       });

//       let text = completion.choices?.[0]?.message?.content?.trim() || '{}';
//       text = text.replace(/```json|```/g, '').trim();

//       let parsed: any;
//       try {
//         parsed = JSON.parse(text);
//       } catch {
//         parsed = {
//           name:
//             text.replace(/["{}]/g, '').split(',')[0]?.trim() ||
//             'Unknown product',
//           brand: 'Unknown',
//           category: 'Misc',
//         };
//       }

//       return {
//         name: parsed.name || 'Unknown product',
//         brand: parsed.brand || 'Unknown',
//         category: parsed.category || 'Misc',
//         source: 'ai-fallback',
//       };
//     } catch (err: any) {
//       console.error('❌ AI fallback failed:', err.message);
//       return {
//         name: 'Unknown product',
//         brand: 'Unknown',
//         category: 'Uncategorized',
//         source: 'ai-fallback',
//       };
//     }
//   }
// }

// END REPLACED CHAT WITH LINKS AND SEARCH NET

/////////////////////////////////////

// import { Injectable } from '@nestjs/common';
// import OpenAI from 'openai';
// import { ChatDto } from './dto/chat.dto';
// import { VertexService } from '../vertex/vertex.service'; // 🔹 ADDED
// import { ProductSearchService } from '../product-services/product-search.service';
// import { Pool } from 'pg';
// import { Express } from 'express';
// import { redis } from '../utils/redisClient';

// const pool = new Pool({
//   connectionString: process.env.DATABASE_URL,
//   ssl: { rejectUnauthorized: false },
// });

// import * as fs from 'fs';
// import * as path from 'path';
// import * as dotenv from 'dotenv';

// function loadOpenAISecrets(): {
//   apiKey?: string;
//   project?: string;
//   source: string;
// } {
//   const candidates = [
//     path.join(process.cwd(), '.env'),
//     path.join(process.cwd(), 'apps', 'backend-nest', '.env'),
//     path.join(__dirname, '..', '..', '.env'),
//   ];

//   for (const p of candidates) {
//     try {
//       if (fs.existsSync(p)) {
//         const parsed = dotenv.parse(fs.readFileSync(p));
//         const apiKey = parsed['OPENAI_API_KEY'];
//         const project = parsed['OPENAI_PROJECT_ID'];
//         if (apiKey) return { apiKey, project, source: p };
//       }
//     } catch {
//       // ignore
//     }
//   }

//   return {
//     apiKey: process.env.OPENAI_API_KEY,
//     project: process.env.OPENAI_PROJECT_ID,
//     source: 'process.env',
//   };
// }

// // 🧥 Basic capsule wardrobe templates
// const CAPSULES = {
//   Spring: [
//     { category: 'Outerwear', subcategory: 'Light Jacket', recommended: 2 },
//     { category: 'Tops', subcategory: 'Oxford Shirt', recommended: 3 },
//     { category: 'Bottoms', subcategory: 'Chinos', recommended: 2 },
//     { category: 'Shoes', subcategory: 'Loafers', recommended: 1 },
//     { category: 'Shoes', subcategory: 'Sneakers', recommended: 1 },
//   ],
//   Summer: [
//     { category: 'Tops', subcategory: 'Short Sleeve Shirt', recommended: 4 },
//     { category: 'Tops', subcategory: 'Polo Shirt', recommended: 2 },
//     { category: 'Bottoms', subcategory: 'Linen Trousers', recommended: 2 },
//     { category: 'Shoes', subcategory: 'Loafers', recommended: 1 },
//     { category: 'Shoes', subcategory: 'Sandals', recommended: 1 },
//   ],
//   Fall: [
//     { category: 'Outerwear', subcategory: 'Field Jacket', recommended: 1 },
//     { category: 'Outerwear', subcategory: 'Blazer', recommended: 1 },
//     { category: 'Tops', subcategory: 'Knit Sweater', recommended: 2 },
//     { category: 'Bottoms', subcategory: 'Wool Trousers', recommended: 2 },
//     { category: 'Shoes', subcategory: 'Chelsea Boots', recommended: 1 },
//   ],
//   Winter: [
//     { category: 'Outerwear', subcategory: 'Overcoat', recommended: 1 },
//     { category: 'Outerwear', subcategory: 'Heavy Parka', recommended: 1 },
//     { category: 'Tops', subcategory: 'Heavy Knit Sweater', recommended: 2 },
//     { category: 'Bottoms', subcategory: 'Wool Trousers', recommended: 2 },
//     { category: 'Shoes', subcategory: 'Boots', recommended: 2 },
//   ],
// };

// // 🗓️ Auto-detect season based on month
// function getCurrentSeason(): 'Spring' | 'Summer' | 'Fall' | 'Winter' {
//   const month = new Date().getMonth() + 1;
//   if ([3, 4, 5].includes(month)) return 'Spring';
//   if ([6, 7, 8].includes(month)) return 'Summer';
//   if ([9, 10, 11].includes(month)) return 'Fall';
//   return 'Winter';
// }

// // 🧠 Compare wardrobe to capsule and return simple forecast text
// function generateSeasonalForecast(wardrobe: any[] = []): string | undefined {
//   const season = getCurrentSeason();
//   const capsule = CAPSULES[season];
//   if (!capsule) return;

//   const missing: string[] = [];

//   capsule.forEach((item) => {
//     const owned = wardrobe.filter(
//       (w) =>
//         w.category?.toLowerCase() === item.category.toLowerCase() &&
//         w.subcategory?.toLowerCase() === item.subcategory.toLowerCase(),
//     ).length;

//     if (owned < item.recommended) {
//       const needed = item.recommended - owned;
//       missing.push(`${needed} × ${item.subcategory}`);
//     }
//   });

//   if (missing.length === 0) {
//     return `✅ Your ${season} capsule is complete — you're ready for the season.`;
//   }

//   return `🍂 ${season} is approaching — you're missing: ${missing.join(', ')}.`;
// }

// @Injectable()
// export class AiService {
//   private openai: OpenAI;
//   private useVertex: boolean;
//   private vertexService?: VertexService; // 🔹 optional instance
//   private productSearch: ProductSearchService; // ✅ add this

//   constructor(vertexService?: VertexService) {
//     const { apiKey, project, source } = loadOpenAISecrets();

//     const snippet = apiKey?.slice(0, 20) ?? '';
//     const len = apiKey?.length ?? 0;
//     console.log('🔑 OPENAI key source:', source);
//     console.log('🔑 OPENAI key snippet:', JSON.stringify(snippet));
//     console.log('🔑 OPENAI key length:', len);
//     console.log('📂 CWD:', process.cwd());

//     if (!apiKey) {
//       throw new Error('OPENAI_API_KEY not found in .env or environment.');
//     }
//     if (/^sk-?x{3,}/i.test(apiKey)) {
//       throw new Error(
//         'OPENAI_API_KEY appears masked (e.g., "sk-xxxxx..."). Read from the correct .env instead.',
//       );
//     }
//     if (!apiKey.startsWith('sk-')) {
//       throw new Error('OPENAI_API_KEY is malformed — must start with "sk-".');
//     }

//     this.openai = new OpenAI({ apiKey, project });

//     // 🔹 New: Vertex toggle
//     this.useVertex = process.env.USE_VERTEX === 'true';
//     if (this.useVertex) {
//       this.vertexService = vertexService;
//       console.log('🧠 Vertex/Gemini mode enabled for analyze/recreate');
//     }

//     this.productSearch = new ProductSearchService(); // NEW
//   }

//   //////ANALYZE LOOK

//   async analyze(imageUrl: string) {
//     console.log('🧠 [AI] analyze() called with', imageUrl);
//     if (!imageUrl) throw new Error('Missing imageUrl');

//     // 🔹 Try Vertex first if enabled
//     if (this.useVertex && this.vertexService) {
//       try {
//         const gcsUri = imageUrl.replace(
//           'https://storage.googleapis.com/',
//           'gs://',
//         );
//         const metadata = await this.vertexService.analyzeImage(gcsUri);
//         const tags = [
//           ...(metadata.tags || []),
//           ...(metadata.style_descriptors || []),
//           metadata.main_category,
//           metadata.subcategory,
//         ].filter(Boolean);
//         console.log('🧠 [Vertex] analyze() success:', tags);
//         return { tags };
//       } catch (err: any) {
//         console.warn(
//           '[Vertex] analyze() failed → fallback to OpenAI:',
//           err.message,
//         );
//       }
//     }

//     // 🔸 OpenAI fallback
//     try {
//       const completion = await this.openai.chat.completions.create({
//         model: 'gpt-4o-mini',
//         messages: [
//           {
//             role: 'system',
//             content:
//               'You are a professional fashion classifier. Return only JSON with a "tags" array describing the outfit’s style, color palette, and vibe.',
//           },
//           {
//             role: 'user',
//             content: [
//               { type: 'text', text: 'Describe this outfit as tags only:' },
//               { type: 'image_url', image_url: { url: imageUrl } },
//             ],
//           },
//         ],
//         response_format: { type: 'json_object' },
//       });

//       const raw = completion.choices[0]?.message?.content;
//       console.log('🧠 [AI] analyze() raw response:', raw);

//       if (!raw) throw new Error('Empty response from OpenAI');
//       const parsed = JSON.parse(raw || '{}');
//       return { tags: parsed.tags || [] };
//     } catch (err: any) {
//       console.error('❌ [AI] analyze() failed:', err.message);
//       return { tags: ['casual', 'modern', 'neutral'] };
//     }
//   }

//   /* ------------------------------------------------------------
//      🧩 Weighted Tag Enrichment + Trend Injection
//   -------------------------------------------------------------*/
//   private async enrichTags(tags: string[]): Promise<string[]> {
//     const weightMap: Record<string, number> = {
//       tailored: 3,
//       minimal: 3,
//       neutral: 3,
//       modern: 2,
//       vintage: 2,
//       classic: 2,
//       streetwear: 2,
//       oversized: 2,
//       slim: 2,
//       relaxed: 2,
//       casual: 1,
//       sporty: 1,
//     };

//     // 🧹 Normalize + de-dupe
//     const cleanTags = Array.from(
//       new Set(
//         tags
//           .map((t) => t.toLowerCase().trim())
//           .filter((t) => t && !['outfit', 'style', 'fashion'].includes(t)),
//       ),
//     );

//     // 🧠 Apply weights
//     const weighted = cleanTags
//       .map((t) => ({ tag: t, weight: weightMap[t] || 1 }))
//       .sort((a, b) => b.weight - a.weight);

//     // 🌍 Inject current trend tags
//     const trendTags = await this.fetchTrendTags();
//     const final = Array.from(
//       new Set([...weighted.map((w) => w.tag), ...trendTags.slice(0, 3)]),
//     );

//     console.log('🎯 [AI] Enriched tags →', final);
//     return final;
//   }

//   private async fetchTrendTags(): Promise<string[]> {
//     try {
//       const res = await fetch(
//         'https://trends.google.com/trends/hottrends/visualize/internal/data/en_us',
//       );
//       if (!res.ok) throw new Error(`HTTP ${res.status}`);
//       const json = await res.json().catch(() => []);
//       const trendWords = JSON.stringify(json).toLowerCase();
//       const matched = trendWords.match(
//         /(quiet luxury|monochrome|minimalism|maximalism|italian|tailoring|loafers|neutrals|linen|structured|preppy|flannel|earth tones|autumn layering)/gi,
//       );
//       if (matched?.length) return Array.from(new Set(matched));

//       // 🧭 If Google Trends returned empty, use local backup
//       return [
//         'quiet luxury',
//         'neutral tones',
//         'tailored fit',
//         'autumn layering',
//       ];
//     } catch (err: any) {
//       console.warn('⚠️ Trend fetch fallback triggered:', err.message);
//       return [
//         'quiet luxury',
//         'neutral tones',
//         'tailored fit',
//         'autumn layering',
//       ];
//     }
//   }

//   // RECREATE//////////////
//   async recreate(
//     user_id: string,
//     tags: string[],
//     image_url?: string,
//     user_gender?: string,
//   ) {
//     console.log(
//       '🧥 [AI] recreate() called for user',
//       user_id,
//       'with tags:',
//       tags,
//       'and gender:',
//       user_gender,
//     );

//     if (!user_id) throw new Error('Missing user_id');
//     if (!tags?.length) {
//       console.warn('⚠️ [AI] recreate() empty tags → using defaults.');
//       tags = ['modern', 'neutral', 'tailored'];
//     }

//     // ✅ Weighted + trend-injected tags
//     tags = await this.enrichTags(tags);

//     // 🧠 Fetch gender_presentation if missing
//     if (!user_gender) {
//       try {
//         const result = await pool.query(
//           'SELECT gender_presentation FROM users WHERE id = $1 LIMIT 1',
//           [user_id],
//         );
//         user_gender = result.rows[0]?.gender_presentation || 'neutral';
//       } catch {
//         user_gender = 'neutral';
//       }
//     }

//     // 🧩 Normalize gender
//     const normalizedGender =
//       user_gender?.toLowerCase().includes('female') ||
//       user_gender?.toLowerCase().includes('woman')
//         ? 'female'
//         : user_gender?.toLowerCase().includes('male') ||
//             user_gender?.toLowerCase().includes('man')
//           ? 'male'
//           : process.env.DEFAULT_GENDER || 'neutral';

//     // 🧠 Build stylist prompt (base)
//     let prompt = `
//         You are a world-class AI stylist for ${normalizedGender} fashion.
//         Create a cohesive outfit inspired by an uploaded look.

//         Client: ${user_id}
//         Image: ${image_url || 'N/A'}
//         Detected tags: ${tags.join(', ')}

//         Rules:
//         - Match fabric, color palette, and silhouette.
//         - Use ${normalizedGender}-appropriate pieces.
//         - Output only JSON:
//         {
//           "outfit": [
//             { "category": "Top", "item": "Grey Cotton Tee", "color": "gray" },
//             { "category": "Bottom", "item": "Navy Chinos", "color": "navy" },
//             { "category": "Outerwear", "item": "Beige Overshirt", "color": "beige" },
//             { "category": "Shoes", "item": "White Sneakers", "color": "white" }
//           ],
//           "style_note": "Describe how the look connects to the uploaded image."
//         }
//         `;

//     // 🔹 Pull soft profile context (optional)
//     let profileCtx = '';
//     try {
//       const res = await pool.query(
//         `SELECT favorite_colors, fit_preferences, preferred_brands, disliked_styles
//        FROM style_profiles WHERE user_id::text = $1 LIMIT 1`,
//         [user_id],
//       );
//       const prof = res.rows[0];
//       if (prof) {
//         profileCtx = `
//       # USER STYLE CONTEXT (soft influence)
//       • Preferred colors: ${(prof.favorite_colors || []).join(', ') || '—'}
//       • Fit preferences: ${(prof.fit_preferences || []).join(', ') || '—'}
//       • Favorite brands: ${(prof.preferred_brands || []).join(', ') || '—'}
//       • Disliked styles: ${prof.disliked_styles || '—'}
//       Do NOT override the image’s vibe — just bias tone/material choices if relevant.
//       `;
//       }
//     } catch {
//       /* silent fail */
//     }

//     // ✅ Final prompt (merge only if context exists)
//     // Inside recreate() or personalizedShop() final prompt:
//     const finalPrompt = `
// ${prompt}

// # HARD RULES
// - ALWAYS output a full outfit of at least 4–6 distinct pieces.
// - Include a Top, Bottom, Outerwear (if seasonally appropriate), Shoes, and optionally 1–2 Accessories.
// - NEVER omit items because they already exist in the user’s wardrobe.
// - Each piece should have its own JSON object, even if similar to a wardrobe item.
// - Always include color and fit for every item.
// `;

//     // 🧠 Generate outfit via Vertex or OpenAI
//     let parsed: any;
//     if (this.useVertex && this.vertexService) {
//       try {
//         const result =
//           await this.vertexService.generateReasonedOutfit(finalPrompt);
//         let text = result?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
//         text = text
//           .replace(/^```json\s*/i, '')
//           .replace(/```$/, '')
//           .trim();
//         parsed = JSON.parse(text);
//         console.log('🧠 [Vertex] recreate() success');
//       } catch (err: any) {
//         console.warn('[Vertex] recreate() failed → fallback', err.message);
//       }
//     }

//     if (!parsed) {
//       const completion = await this.openai.chat.completions.create({
//         model: 'gpt-4o-mini',
//         temperature: 0.7,
//         messages: [{ role: 'user', content: finalPrompt }],
//         response_format: { type: 'json_object' },
//       });

//       const raw = completion.choices[0]?.message?.content || '{}';
//       try {
//         parsed = JSON.parse(raw);
//       } catch {
//         parsed = {};
//       }
//     }

//     const outfit = Array.isArray(parsed?.outfit) ? parsed.outfit : [];
//     const style_note =
//       parsed?.style_note || 'Modern outfit inspired by the uploaded look.';

//     // 🛍️ Enrich each item with live products
//     const enriched = await Promise.all(
//       outfit.map(async (o: any) => {
//         const query =
//           `${normalizedGender} ${o.item || o.category || ''} ${o.color || ''}`.trim();
//         let products = await this.productSearch.search(query);
//         let top = products[0];

//         if (!top?.image || top.image.includes('No_image')) {
//           const serp = await this.productSearch.searchSerpApi(query);
//           if (serp?.[0]) top = { ...serp[0], source: 'SerpAPI' };
//         }

//         const materialHint =
//           query.match(/(wool|cotton|linen|leather|denim|polyester)/i)?.[0] ||
//           null;
//         const seasonalityHint =
//           query.match(/(summer|winter|fall|spring)/i)?.[0] ||
//           getCurrentSeason();
//         const fitHint =
//           query.match(/(slim|regular|relaxed|oversized|tailored)/i)?.[0] ||
//           'regular';

//         return {
//           category: o.category,
//           item: o.item,
//           color: o.color,
//           brand: top?.brand || 'Unknown',
//           price: top?.price || '—',
//           image:
//             top?.image && top.image.startsWith('http')
//               ? top.image
//               : 'https://upload.wikimedia.org/wikipedia/commons/a/ac/No_image_available.svg',
//           shopUrl:
//             top?.shopUrl ||
//             `https://www.google.com/search?q=${encodeURIComponent(query)}&tbm=shop`,
//           source: top?.source || 'ASOS / Fallback',
//           material: materialHint,
//           seasonality: seasonalityHint,
//           fit: fitHint,
//         };
//       }),
//     );

//     return { user_id, outfit: enriched, style_note };
//   }

//   // 🧩 Ensure every product object includes a usable image URL
//   private fixProductImages(products: any[] = []): any[] {
//     return products.map((prod) => ({
//       ...prod,
//       image:
//         prod.image ||
//         prod.image_url ||
//         prod.thumbnail ||
//         prod.serpapi_thumbnail || // ✅ added
//         prod.img ||
//         prod.picture ||
//         prod.thumbnail_url ||
//         'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg',
//     }));
//   }

//   // 👔 PERSONALIZED SHOP — image + wardrobe + preferences
//   async personalizedShop(
//     user_id: string,
//     image_url: string,
//     user_gender?: string,
//   ) {
//     if (!user_id || !image_url) throw new Error('Missing user_id or image_url');

//     /** -----------------------------------------------------------
//      * 🧠 buildProfileConstraints(profile)
//      * Converts full style_profiles record into explicit hard rules
//      * ---------------------------------------------------------- */
//     function buildProfileConstraints(profile: any): string {
//       if (!profile) return '';

//       const fit = Array.isArray(profile.fit_preferences)
//         ? profile.fit_preferences.join(', ')
//         : profile.fit_preferences;

//       const colors = Array.isArray(profile.favorite_colors)
//         ? profile.favorite_colors.join(', ')
//         : profile.favorite_colors;

//       const brands = Array.isArray(profile.preferred_brands)
//         ? profile.preferred_brands.join(', ')
//         : profile.preferred_brands;

//       const styles = [
//         ...(profile.style_keywords || []),
//         ...(profile.style_preferences || []),
//       ]
//         .filter(Boolean)
//         .join(', ');

//       const dislikes =
//         typeof profile.disliked_styles === 'string'
//           ? profile.disliked_styles
//           : (profile.disliked_styles || []).join(', ');

//       const climate = profile.climate || 'Temperate';
//       const goals = profile.goals || '';

//       // 🔹 Inject explicit hard “only color” or “except color” rule for the model itself
//       let colorRule = '';
//       if (profile.disliked_styles?.match(/only\s+(\w+)/i)) {
//         const onlyColor = profile.disliked_styles.match(/only\s+(\w+)/i)[1];
//         colorRule = `• Use ONLY ${onlyColor} items — all other colors are forbidden.`;
//       } else if (profile.disliked_styles?.match(/except\s+(\w+)/i)) {
//         const exceptColor = profile.disliked_styles.match(/except\s+(\w+)/i)[1];
//         colorRule = `• Exclude every color except ${exceptColor}.`;
//       }

//       // 🔹 Explicitly enforce fit preferences
//       let fitRule = '';
//       if (profile.fit_preferences?.length) {
//         fitRule = `• Allow ONLY these fits: ${profile.fit_preferences.join(
//           ', ',
//         )}; exclude all others.`;
//       }

//       return `
// # USER PROFILE CONSTRAINTS (Hard Rules)

// ${fitRule}
// ${colorRule}

// • Fit: ${fit || 'Regular fit'} — outfit items must match this silhouette; exclude all opposing fits.
// • Climate: ${climate} — use materials and layers appropriate to this temperature zone.
// • Preferred brands: ${brands || '—'} — bias all product searches toward these or comparable aesthetics.
// • Favorite colors: ${colors || '—'} — bias color palette to these tones; avoid disliked colors.
// • Disliked styles: ${dislikes || '—'} — exclude these aesthetics entirely.
// • Style & vibe keywords: ${styles || '—'} — reflect these qualities in overall tone and accessories.
// • Goals: ${goals}
// • Body & proportions: ${profile.body_type || '—'}, ${
//         profile.proportions || '—'
//       } — ensure silhouette and layering suit these proportions.
// • Skin tone / hair / eyes: ${profile.skin_tone || '—'}, ${
//         profile.hair_color || '—'
//       }, ${profile.eye_color || '—'} — choose tones that complement.
// `;
//     }

//     // 1) Analyze uploaded image
//     const analysis = await this.analyze(image_url);
//     const tags = analysis?.tags || [];

//     //   const { rows: wardrobe } = await pool.query(
//     //     `SELECT name, main_category AS category, subcategory, color, material
//     //  FROM wardrobe_items
//     //  WHERE user_id::text = $1
//     //  ORDER BY updated_at DESC
//     //  LIMIT 50`,
//     //     [user_id],
//     //   );

//     // 🚫 Skip wardrobe entirely for personalized mode
//     const wardrobe: any[] = [];

//     const prefRes = await pool.query(
//       `SELECT gender_presentation
//      FROM users
//      WHERE id = $1
//      LIMIT 1`,
//       [user_id],
//     );
//     const profile = prefRes.rows[0] || {};
//     const gender = user_gender || profile.gender_presentation || 'neutral';
//     // 2️⃣ Fetch user style profile (full data used for personalization)
//     const styleProfileRes = await pool.query(
//       `
//   SELECT
//     body_type,
//     skin_tone,
//     undertone,
//     climate,
//     favorite_colors,
//     disliked_styles,
//     style_keywords,
//     preferred_brands,
//     goals,
//     proportions,
//     hair_color,
//     eye_color,
//     height,
//     waist,
//     fit_preferences,
//     style_preferences
//   FROM style_profiles
//   WHERE user_id::text = $1
//   LIMIT 1
// `,
//       [user_id],
//     );

//     const styleProfile = styleProfileRes.rows[0] || {};

//     // 🔹 Build user filter preferences
//     const { preferFit, bannedWords } = buildUserFilter(styleProfile);

//     /* ------------------------------------------------------------
//    🎛️ VISUAL + STYLE FILTERING HELPERS
// -------------------------------------------------------------*/
//     const FIT_KEYWORDS = {
//       skinny: [/skinny/i, /super[- ]skinny/i, /spray[- ]on/i],
//       slim: [/slim/i],
//       tailored: [/tailored/i, /tapered/i],
//       relaxed: [/relaxed/i, /loose/i, /baggy/i, /wide[- ]leg/i],
//       oversized: [/oversized/i, /boxy/i],
//     };

//     function buildUserFilter(profile: any) {
//       const fitPrefs = (profile.fit_preferences || []).map((x: string) =>
//         x.toLowerCase(),
//       );
//       const disliked = (profile.disliked_styles || '')
//         .toLowerCase()
//         .split(/[,\s]+/)
//         .filter(Boolean);
//       const favColors = (profile.favorite_colors || []).map((x: string) =>
//         x.toLowerCase(),
//       );

//       const preferFit =
//         fitPrefs.find((f) => /(relaxed|loose|baggy|oversized|boxy)/.test(f)) ||
//         fitPrefs.find((f) => /(regular|tailored)/.test(f)) ||
//         fitPrefs[0] ||
//         null;

//       const banFits: string[] = [];
//       if (preferFit?.match(/relaxed|loose|baggy|oversized|boxy/))
//         banFits.push('skinny', 'slim');
//       else if (preferFit?.match(/skinny|slim/))
//         banFits.push('relaxed', 'baggy', 'oversized');

//       const bannedWords = [
//         ...disliked,
//         ...banFits,
//         ...(!favColors.includes('green') ? ['green'] : []),
//       ]
//         .filter(Boolean)
//         .map((x) => new RegExp(x, 'i'));

//       return { preferFit, bannedWords };
//     }

//     function enforceProfileFilters(
//       products: any[] = [],
//       preferFit?: string | null,
//       bannedWords: RegExp[] = [],
//     ) {
//       if (!products.length) return products;

//       return products
//         .filter((p) => {
//           const hay = `${p.title || ''} ${p.name || ''} ${p.description || ''}`;
//           return !bannedWords.some((rx) => rx.test(hay));
//         })
//         .sort((a, b) => {
//           if (!preferFit) return 0;
//           const aHit = FIT_KEYWORDS[preferFit]?.some((rx) =>
//             rx.test(`${a.title} ${a.name}`),
//           )
//             ? 1
//             : 0;
//           const bHit = FIT_KEYWORDS[preferFit]?.some((rx) =>
//             rx.test(`${b.title} ${b.name}`),
//           )
//             ? 1
//             : 0;
//           return bHit - aHit; // boost preferred fits
//         });
//     }

//     // 3) Ask model to split into "owned" vs "missing"

//     const climateNote = styleProfile.climate
//       ? `The user's climate is ${styleProfile.climate}.
//     If it is cold (like Polar or Cold), emphasize insulated materials, coats, layers, scarves, gloves, and boots.
//     If it is hot (like Tropical or Desert), emphasize breathable, lightweight fabrics and open footwear.`
//       : '';

//     // 🔒 Enforced personalization hierarchy
//     const rules = `
//     # PERSONALIZATION ENFORCEMENT
//     Follow these user preferences as *absolute constraints*, not suggestions.
//     `;

//     const profileConstraints = buildProfileConstraints(styleProfile);

//     const prompt = `
// You are a world-class personal stylist generating a personalized recreation of an uploaded look.
// ${rules}
// ${profileConstraints}

// # IMAGE INSPIRATION
// • Use the uploaded image only as an aesthetic anchor (color story, silhouette, or texture).
// • Do NOT reference or reuse the user's wardrobe.
// • Respect all style profile constraints exactly.
// • Maintain the same mood and spirit as the uploaded image, not a literal copy.
// • Preserve one clear visual motif from the source image (e.g., plaid pattern or color tone) unless climate prohibits.

// # OUTPUT RULES
// - ALWAYS output a complete outfit with distinct Top, Bottom, Shoes, and (if seasonally appropriate) Outerwear and Accessories.
// - Each piece must include category, item, color, and fit.

// Return ONLY valid JSON:
// {
//   "recreated_outfit": [
//     { "source":"purchase", "category":"Top", "item":"...", "color":"...", "fit":"..." }
//   ],
//   "suggested_purchases": [
//     { "category":"...", "item":"...", "color":"...", "material":"...", "brand":"...", "shopUrl":"..." }
//   ],
//   "style_note": "Explain how this respects the user's climate, fit, and taste."
// }

// User gender: ${gender}
// Detected tags: ${tags.join(', ')}
// Weighted tags: ${tags.map((t) => `high priority: ${t}`).join(', ')}
// User style profile: ${JSON.stringify(styleProfile, null, 2)}
// ${climateNote}
// `;

//     console.log('🧥 [personalizedShop] profile:', profile);
//     console.log('🧥 [personalizedShop] gender:', gender);
//     console.log('🧥 [personalizedShop] styleProfile:', styleProfile);
//     console.log('🧠 [personalizedShop] Prompt preview:', prompt.slice(0, 800));

//     // 🧠 DEBUG START — prompt verification
//     console.log('─────────────── PROMPT SENT TO MODEL ───────────────');
//     console.log(prompt);
//     console.log('─────────────── END PROMPT ───────────────');

//     const completion = await this.openai.chat.completions.create({
//       model: 'gpt-4o-mini',
//       temperature: 0.7,
//       messages: [{ role: 'user', content: prompt }],
//       response_format: { type: 'json_object' },
//     });

//     // 🧠 DEBUG END — raw model output
//     console.log('─────────────── RAW MODEL RESPONSE ───────────────');
//     console.log(completion.choices[0]?.message?.content);
//     console.log('─────────────── END RESPONSE ───────────────');

//     let parsed: any = {};
//     try {
//       parsed = JSON.parse(completion.choices[0]?.message?.content || '{}');

//       // 🧩 SAFETY GUARD — ensure we keep valid recreated_outfit
//       try {
//         const parsedKeys = Object.keys(parsed);
//         console.log('✅ [personalizedShop] Parsed JSON keys:', parsedKeys);

//         // If model used "outfit" instead of "recreated_outfit", normalize it
//         if (!parsed.recreated_outfit && parsed.outfit) {
//           parsed.recreated_outfit = parsed.outfit;
//           console.log('✅ [personalizedShop] Mapped outfit → recreated_outfit');
//         }

//         // Double-check array validity before fallback clears it
//         if (parsed.recreated_outfit && parsed.recreated_outfit.length > 0) {
//           console.log(
//             '✅ [personalizedShop] Using recreated_outfit from model',
//           );
//         } else {
//           console.warn(
//             '⚠️ [personalizedShop] No recreated_outfit found — fallback may trigger',
//           );
//         }
//       } catch (err) {
//         console.error(
//           '❌ [personalizedShop] JSON structure guard failed:',
//           err,
//         );
//       }

//       // ✅ Final filter fix — keep wardrobe items but still respect banned fits/styles
//       if (parsed?.recreated_outfit?.length) {
//         parsed.recreated_outfit = parsed.recreated_outfit.filter((o: any) => {
//           if (!o) return false;
//           const text =
//             `${o.item} ${o.category} ${o.color} ${o.fit}`.toLowerCase();
//           if (!text.trim() || text.includes('undefined')) return false;
//           // ✅ Always keep wardrobe items regardless of style bans
//           if (o.source === 'wardrobe') return true;

//           const fitBan = preferFit?.match(/relaxed|oversized|boxy|loose/)
//             ? ['skinny']
//             : preferFit?.match(/skinny|slim|tailored/)
//               ? ['relaxed', 'baggy', 'oversized']
//               : [];

//           const styleBan =
//             (styleProfile.disliked_styles || '')
//               .toLowerCase()
//               .split(/[,\s]+/)
//               .filter(Boolean) || [];

//           const banned = [...fitBan, ...styleBan];
//           return !banned.some((b) => text.includes(b));
//         });

//         console.log(
//           '✅ [personalizedShop] Final filtered outfit →',
//           parsed.recreated_outfit,
//         );
//       }

//       console.log(
//         '💎 [personalizedShop] Parsed recreated outfit sample:',
//         parsed?.recreated_outfit?.slice(0, 2),
//       );
//       console.log(
//         '💎 [personalizedShop] Parsed suggested purchases sample:',
//         parsed?.suggested_purchases?.slice(0, 2),
//       );

//       // 🧩 Merge recreated_outfit into suggested_purchases for display
//       if (
//         Array.isArray(parsed?.recreated_outfit) &&
//         parsed.recreated_outfit.length
//       ) {
//         parsed.suggested_purchases = [
//           ...(parsed.suggested_purchases || []),
//           ...parsed.recreated_outfit.map((o: any) => ({
//             ...o,
//             brand: o.brand || '—',
//             previewImage: o.previewImage || o.image || o.image_url || null,
//             source: 'purchase',
//           })),
//         ];
//         console.log(
//           '🧩 [personalizedShop] merged recreated_outfit → suggested_purchases',
//         );
//       }

//       // 🖼️ Ensure every recreated outfit item has a visible preview image
//       if (Array.isArray(parsed?.recreated_outfit)) {
//         parsed.recreated_outfit = parsed.recreated_outfit.map((item: any) => {
//           if (!item.previewImage && item.source === 'wardrobe') {
//             item.previewImage =
//               item.image_url ||
//               item.wardrobe_image ||
//               'https://upload.wikimedia.org/wikipedia/commons/a/ac/No_image_available.svg';
//           }
//           return item;
//         });
//       }

//       // 🎨 Enforce "only <color>" rule from disliked_styles (e.g. "I dislike all colors except pink")
//       // 🎨 Optional color-only enforcement — only if explicit "ONLY <color>" flag exists
//       if (styleProfile?.disliked_styles?.toLowerCase().includes('only')) {
//         const match = styleProfile.disliked_styles.match(/only\s+(\w+)/i);
//         if (match) {
//           const onlyColor = match[1].toLowerCase();
//           const filterColor = (arr: any[]) =>
//             arr.filter((x) =>
//               (x.color || '').toLowerCase().includes(onlyColor),
//             );

//           if (Array.isArray(parsed?.recreated_outfit))
//             parsed.recreated_outfit = filterColor(parsed.recreated_outfit);
//           if (Array.isArray(parsed?.suggested_purchases))
//             parsed.suggested_purchases = filterColor(
//               parsed.suggested_purchases,
//             );

//           console.log(
//             `[personalizedShop] 🎨 Enforcing ONLY-color rule: ${onlyColor}`,
//           );
//         }
//       }
//     } catch {
//       parsed = {};
//     }

//     const purchases = Array.isArray(parsed?.suggested_purchases)
//       ? parsed.suggested_purchases
//       : [];

//     if (parsed?.recreated_outfit?.some((i: any) => i.source === 'wardrobe')) {
//       console.log('🧥 [personalizedShop] ✅ Model reused wardrobe pieces.');
//     } else {
//       console.warn(
//         '🧥 [personalizedShop] ⚠️ Model did NOT reuse wardrobe — fallback to generic recreation.',
//       );
//     }

//     // 🚫 Enforce profile bans in returned outfit
//     const banned = [
//       ...(styleProfile.disliked_styles?.toLowerCase().split(/[,\s]+/) || []),
//       ...(preferFit?.match(/relaxed|oversized|boxy|loose/)
//         ? ['skinny', 'slim']
//         : []),
//       ...(preferFit?.match(/skinny|slim/)
//         ? ['relaxed', 'oversized', 'baggy']
//         : []),
//     ].filter(Boolean);

//     if (parsed?.recreated_outfit?.length) {
//       // ✅ Keep *all* wardrobe and purchase items — only filter garbage entries
//       parsed.recreated_outfit = parsed.recreated_outfit.filter((o: any) => {
//         if (!o || !o.item) return false;
//         const text =
//           `${o.item} ${o.category} ${o.color} ${o.fit}`.toLowerCase();
//         return text.trim().length > 0 && !text.includes('undefined');
//       });

//       // 🧱 Guarantee full outfit completeness (Top, Bottom, Shoes, Optional Outerwear/Accessory)
//       const categories = parsed.recreated_outfit.map((o: any) =>
//         o.category?.toLowerCase(),
//       );
//       const missing: any[] = [];

//       if (!categories.includes('top'))
//         missing.push({
//           source: 'purchase',
//           category: 'Top',
//           item: 'White Oxford Shirt',
//           color: 'White',
//           fit: 'Slim Fit',
//         });
//       if (!categories.includes('bottoms'))
//         missing.push({
//           source: 'purchase',
//           category: 'Bottoms',
//           item: 'Beige Chinos',
//           color: 'Beige',
//           fit: 'Slim Fit',
//         });
//       if (!categories.includes('shoes'))
//         missing.push({
//           source: 'purchase',
//           category: 'Shoes',
//           item: 'White Leather Sneakers',
//           color: 'White',
//           fit: 'Slim Fit',
//         });

//       parsed.recreated_outfit.push(...missing);

//       console.log(
//         '✅ [personalizedShop] Final full outfit →',
//         parsed.recreated_outfit,
//       );
//     }

//     // 🧩 Centralized enforcement for personalizedShop only
//     function applyProfileFilters(products: any[], profile: any) {
//       if (!Array.isArray(products) || !products.length) return [];

//       const favColors = (profile.favorite_colors || []).map((x: string) =>
//         x.toLowerCase(),
//       );
//       const prefBrands = (profile.preferred_brands || []).map((x: string) =>
//         x.toLowerCase(),
//       );
//       const fitPrefs = (profile.fit_preferences || []).map((x: string) =>
//         x.toLowerCase(),
//       );
//       const dislikes = (profile.disliked_styles || '')
//         .toLowerCase()
//         .split(/[,\s]+/);
//       const climate = (profile.climate || '').toLowerCase();

//       const isCold = /(polar|cold|arctic|tundra|winter)/.test(climate);
//       const isHot = /(tropical|desert|hot|humid|summer)/.test(climate);

//       // 🩷 detect "only" or "except" color rule from disliked_styles
//       let onlyColor: string | null = null;
//       let exceptColor: string | null = null;

//       if (profile.disliked_styles?.match(/only\s+(\w+)/i)) {
//         onlyColor = profile.disliked_styles
//           .match(/only\s+(\w+)/i)[1]
//           .toLowerCase();
//       } else if (profile.disliked_styles?.match(/except\s+(\w+)/i)) {
//         exceptColor = profile.disliked_styles
//           .match(/except\s+(\w+)/i)[1]
//           .toLowerCase();
//       }

//       return products
//         .filter((p) => {
//           const t = `${p.name ?? ''} ${p.title ?? ''} ${p.brand ?? ''} ${
//             p.description ?? ''
//           } ${p.color ?? ''} ${p.fit ?? ''}`.toLowerCase();

//           // 🚫 Filter out disliked words/styles
//           if (dislikes.some((d) => d && t.includes(d))) return false;

//           // 🎨 HARD color enforcement from DB rules
//           if (onlyColor) {
//             // Only allow if text or color includes the specified color
//             if (
//               !t.includes(onlyColor) &&
//               !p.color?.toLowerCase().includes(onlyColor)
//             )
//               return false;
//           } else if (exceptColor) {
//             // Exclude everything not matching that color
//             if (
//               !t.includes(exceptColor) &&
//               !p.color?.toLowerCase().includes(exceptColor)
//             )
//               return false;
//           } else {
//             // Normal favorite color bias if no hard rule
//             if (favColors.length && !favColors.some((c) => t.includes(c)))
//               return false;
//           }

//           // 👕 Fit preferences
//           if (fitPrefs.length && !fitPrefs.some((f) => t.includes(f)))
//             return false;

//           // 🌡️ Climate-based filtering
//           if (isCold && /(tank|shorts|sandal)/.test(t)) return false;
//           if (isHot && /(wool|parka|coat|boot|knit)/.test(t)) return false;

//           return true;
//         })
//         .sort((a, b) => {
//           const score = (x: any) => {
//             const txt =
//               `${x.name} ${x.title} ${x.brand} ${x.color} ${x.fit}`.toLowerCase();
//             let s = 0;
//             if (onlyColor && txt.includes(onlyColor)) s += 4;
//             if (exceptColor && txt.includes(exceptColor)) s += 4;
//             if (favColors.some((c) => txt.includes(c))) s += 2;
//             if (prefBrands.some((b) => txt.includes(b))) s += 2;
//             if (fitPrefs.some((f) => txt.includes(f))) s += 1;
//             return s;
//           };
//           return score(b) - score(a);
//         });
//     }

//     // 4️⃣ Attach live shop links to the "missing" items — now honoring user taste
//     let enrichedPurchases = await Promise.all(
//       purchases.map(async (p: any) => {
//         // 🧠 Gender-locked prefix
//         const genderPrefix =
//           gender?.toLowerCase().includes('female') ||
//           gender?.toLowerCase().includes('woman')
//             ? 'women female womens ladies'
//             : 'men male mens masculine -women -womens -female -girls -ladies';

//         // Base query with gender lock
//         let q = [
//           genderPrefix,
//           p.item || p.category || '',
//           p.color || '',
//           p.material || '',
//         ]
//           .filter(Boolean)
//           .join(' ')
//           .trim();

//         // 🔹 Inject personalization bias terms
//         const brandTerms = (styleProfile.preferred_brands || [])
//           .slice(0, 3)
//           .join(' ');
//         const colorTerms = (styleProfile.favorite_colors || [])
//           .slice(0, 2)
//           .join(' ');
//         const fitTerms = Array.isArray(styleProfile.fit_preferences)
//           ? styleProfile.fit_preferences.join(' ')
//           : styleProfile.fit_preferences || '';

//         // 🎨 “Only color” rule (e.g. “I dislike all colors except pink”)
//         const colorMatch =
//           styleProfile.disliked_styles?.match(/except\s+(\w+)/i);
//         if (colorMatch) {
//           const onlyColor = colorMatch[1].toLowerCase();
//           q += ` ${onlyColor}`;
//         }

//         // Combine into final query with brand + color + fit bias
//         q = [q, brandTerms, colorTerms, fitTerms].filter(Boolean).join(' ');

//         // 🔒 Ensure all queries exclude female results explicitly
//         if (
//           !/-(women|female|ladies|girls)/i.test(q) &&
//           /\bmen\b|\bmale\b/i.test(q)
//         ) {
//           q += ' -women -womens -female -girls -ladies';
//         }

//         // Combine into final query with brand + color + fit bias
//         q = [q, brandTerms, colorTerms, fitTerms].filter(Boolean).join(' ');

//         // 🔒 Ensure all queries exclude female results explicitly
//         if (
//           !/-(women|female|ladies|girls)/i.test(q) &&
//           /\bmen\b|\bmale\b/i.test(q)
//         ) {
//           q += ' -women -womens -female -girls -ladies';
//         }

//         // 🧠 Gender-aware product search
//         let products = await this.productSearch.search(
//           q,
//           gender?.toLowerCase() === 'female'
//             ? 'female'
//             : gender?.toLowerCase() === 'male'
//               ? 'male'
//               : 'unisex',
//         );

//         // 🚫 Filter out any accidental female/unisex results
//         products = products.filter(
//           (prod) =>
//             !/women|female|womens|ladies|girls/i.test(
//               `${prod.name ?? ''} ${prod.brand ?? ''} ${prod.title ?? ''}`,
//             ),
//         );

//         // 🩷 Hard visual color filter — ensures displayed products actually match the enforced color rule
//         if (
//           styleProfile?.disliked_styles?.match(/only\s+(\w+)/i) ||
//           styleProfile?.disliked_styles?.match(/except\s+(\w+)/i)
//         ) {
//           const match =
//             styleProfile.disliked_styles.match(/only\s+(\w+)/i) ||
//             styleProfile.disliked_styles.match(/except\s+(\w+)/i);
//           const enforcedColor = match?.[1]?.toLowerCase();
//           if (enforcedColor) {
//             products = products.filter((p) => {
//               const text =
//                 `${p.name ?? ''} ${p.title ?? ''} ${p.color ?? ''}`.toLowerCase();
//               return text.includes(enforcedColor);
//             });
//           }
//         }

//         return {
//           ...p,
//           query: q,
//           products: applyProfileFilters(products, styleProfile),
//         };
//       }),
//     );

//     // 5️⃣ Fallback enrichment if AI returned nothing or products failed
//     if (!enrichedPurchases.length) {
//       console.warn(
//         '⚠️ [personalizedShop] Empty suggested_purchases → fallback.',
//       );

//       const tagSeed = tags.slice(0, 6).join(' ');
//       const season = getCurrentSeason();

//       // 🧠 Gender prefix for fallback with hard lock
//       const genderPrefix =
//         gender?.toLowerCase().includes('female') ||
//         gender?.toLowerCase().includes('woman')
//           ? 'women female womens ladies'
//           : 'men male mens masculine -women -womens -female -girls -ladies';

//       // 🧠 Enrich fallback with style taste as well
//       const brandTerms = (styleProfile.preferred_brands || [])
//         .slice(0, 3)
//         .join(' ');
//       const colorTerms = (styleProfile.favorite_colors || [])
//         .slice(0, 2)
//         .join(' ');
//       const fitTerms = Array.isArray(styleProfile.fit_preferences)
//         ? styleProfile.fit_preferences.join(' ')
//         : styleProfile.fit_preferences || '';

//       const fallbackQuery = `${genderPrefix} ${tagSeed} ${season} fashion ${brandTerms} ${colorTerms} ${fitTerms}`;
//       console.log('🧩 [personalizedShop] fallbackQuery →', fallbackQuery);

//       const products = await this.productSearch.search(
//         fallbackQuery,
//         gender?.toLowerCase() === 'female'
//           ? 'female'
//           : gender?.toLowerCase() === 'male'
//             ? 'male'
//             : 'unisex',
//       );

//       // 🚫 Filter out any accidental female/unisex results
//       const maleProducts = products.filter(
//         (prod) =>
//           !/women|female|womens|ladies|girls/i.test(
//             `${prod.name ?? ''} ${prod.brand ?? ''} ${prod.title ?? ''}`,
//           ),
//       );

//       enrichedPurchases = [
//         {
//           category: 'General',
//           item: 'Curated Outfit Add-Ons',
//           color: 'Mixed',
//           material: null,
//           products: applyProfileFilters(maleProducts.slice(0, 8), styleProfile),
//           query: fallbackQuery,
//           source: 'fallback',
//         },
//       ];
//     }

//     // 🎨 Enforce color-only rule on fallback products too
//     if (styleProfile?.disliked_styles) {
//       const match = styleProfile.disliked_styles.match(/except\s+(\w+)/i);
//       if (match) {
//         const onlyColor = match[1].toLowerCase();
//         enrichedPurchases = enrichedPurchases.map((p) => ({
//           ...p,
//           products: (p.products || []).filter((prod) =>
//             (prod.color || '').toLowerCase().includes(onlyColor),
//           ),
//         }));
//         console.log(
//           `[personalizedShop] 🎨 Enforced fallback color-only rule: ${onlyColor}`,
//         );
//       }
//     }

//     const cleanPurchases = enrichedPurchases.map((p) => ({
//       ...p,
//       products: this.fixProductImages(
//         enforceProfileFilters(p.products || [], preferFit, bannedWords),
//       ),
//     }));

//     // 🎨 FINAL VISUAL CONSISTENCY NORMALIZATION
//     const normalizedPurchases = await Promise.all(
//       enrichedPurchases.map(async (p) => {
//         const validProduct =
//           (p.products || []).find(
//             (x) =>
//               (x.image ||
//                 x.image_url ||
//                 x.thumbnail ||
//                 x.serpapi_thumbnail ||
//                 x.thumbnail_url ||
//                 x.img ||
//                 x.result?.thumbnail ||
//                 x.result?.serpapi_thumbnail) &&
//               /^https?:\/\//.test(
//                 x.image ||
//                   x.image_url ||
//                   x.thumbnail ||
//                   x.serpapi_thumbnail ||
//                   x.thumbnail_url ||
//                   x.img ||
//                   x.result?.thumbnail ||
//                   x.result?.serpapi_thumbnail ||
//                   '',
//               ) &&
//               !/no[_-]?image/i.test(
//                 x.image ||
//                   x.image_url ||
//                   x.thumbnail ||
//                   x.serpapi_thumbnail ||
//                   x.thumbnail_url ||
//                   x.img ||
//                   '',
//               ),
//           ) || p.products?.[0];

//         let previewImage =
//           validProduct?.image ||
//           validProduct?.image_url ||
//           validProduct?.thumbnail ||
//           validProduct?.serpapi_thumbnail ||
//           validProduct?.thumbnail_url ||
//           validProduct?.img ||
//           validProduct?.product_thumbnail ||
//           validProduct?.result?.thumbnail ||
//           validProduct?.result?.serpapi_thumbnail ||
//           null;

//         // 🎯 Gender-aware image guard
//         const userGender = (gender || '').toLowerCase();

//         if (previewImage) {
//           const url = previewImage.toLowerCase();

//           // 🧍‍♂️ If male → block clearly female-coded URLs
//           if (
//             userGender.includes('male') &&
//             /(women|woman|female|ladies|girls|womenswear|femme|skims|shein|fashionnova|princesspolly|revolve|anthropologie)/i.test(
//               url,
//             )
//           ) {
//             previewImage =
//               'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg';
//           }

//           // 🧍‍♀️ If female → block clearly male-coded URLs
//           else if (
//             userGender.includes('female') &&
//             /(men|man|male|menswear|masculine)/i.test(url)
//           ) {
//             previewImage =
//               'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg';
//           }

//           // 🧍 Unisex → allow all images
//         }

//         // 🧠 If still missing, do a quick SerpAPI lookup and cache
//         if (!previewImage && p.query) {
//           const results = await this.productSearch.searchSerpApi(p.query);
//           const r = results?.[0];
//           previewImage =
//             r?.image ||
//             r?.image_url ||
//             r?.thumbnail ||
//             r?.serpapi_thumbnail ||
//             r?.thumbnail_url ||
//             r?.result?.thumbnail ||
//             r?.result?.serpapi_thumbnail ||
//             null;

//           // 🎯 Apply same gender guard to SerpAPI result
//           if (previewImage) {
//             const url = previewImage.toLowerCase();

//             if (
//               userGender.includes('male') &&
//               /(women|woman|female|ladies|girls|womenswear|femme|skims|shein|fashionnova|princesspolly|revolve|anthropologie)/i.test(
//                 url,
//               )
//             ) {
//               previewImage =
//                 'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg';
//             } else if (
//               userGender.includes('female') &&
//               /(men|man|male|menswear|masculine)/i.test(url)
//             ) {
//               previewImage =
//                 'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg';
//             }
//           }
//         }

//         return {
//           ...p,
//           previewImage:
//             previewImage ||
//             'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg',
//           previewBrand: validProduct?.brand || p.brand || 'Unknown',
//           previewPrice: validProduct?.price || '—',
//           previewUrl: validProduct?.shopUrl || p.shopUrl || null,
//         };
//       }),
//     ); // ✅ ← closes Promise.all()

//     // 🧹 remove empty product groups (no valid images)
//     const filteredPurchases = normalizedPurchases.filter(
//       (p) => !!p.previewImage,
//     );

//     // 🧊 Climate sanity check — if Polar but outfit lacks insulation, patch style_note
//     if (
//       styleProfile.climate?.toLowerCase().includes('polar') &&
//       !/coat|jacket|parka|boot|knit|sweater/i.test(
//         JSON.stringify(parsed.recreated_outfit || []),
//       )
//     ) {
//       parsed.style_note +=
//         ' Reinforced with insulated outerwear and cold-weather layering for Polar climates.';
//     }

//     // 🚫 Prevent fallback or secondary recreate() from overwriting personalized flow
//     if (
//       enrichedPurchases?.length > 0 ||
//       parsed?.suggested_purchases?.length > 0
//     ) {
//       console.log(
//         '✅ [personalizedShop] Finalizing personalized results — skipping generic recreate()',
//       );
//       return {
//         user_id,
//         image_url,
//         tags,
//         recreated_outfit: parsed?.recreated_outfit || [],
//         suggested_purchases: normalizedPurchases,
//         style_note:
//           parsed?.style_note ||
//           'Personalized recreation based on your wardrobe, with curated seasonal add-ons.',
//         applied_filters: {
//           preferFit,
//           bannedWords: bannedWords.map((r) => r.source),
//         },
//       };
//     }

//     return {
//       user_id,
//       image_url,
//       tags,
//       recreated_outfit: parsed?.recreated_outfit || [],
//       suggested_purchases: normalizedPurchases,
//       style_note:
//         parsed?.style_note ||
//         'Personalized recreation based on your wardrobe, with curated seasonal add-ons.',
//       applied_filters: {
//         preferFit,
//         bannedWords: bannedWords.map((r) => r.source),
//       },
//     };
//   }

//   ////////END CREATE LOOK

//   //////. START REPLACED CHAT WITH LINKS AND SEARCH NET
//   async chat(dto: ChatDto) {
//     const { messages, user_id } = dto;
//     const lastUserMsg = messages
//       .slice()
//       .reverse()
//       .find((m) => m.role === 'user')?.content;

//     if (!lastUserMsg) {
//       throw new Error('No user message provided');
//     }

//     /* 🧠 --- MEMORY BLOCK START --- */
//     try {
//       // Save the latest user message
//       await pool.query(
//         `INSERT INTO chat_messages (user_id, role, content)
//        VALUES ($1,$2,$3)`,
//         [user_id, 'user', lastUserMsg],
//       );

//       // Fetch the last 10 messages for this user
//       const { rows } = await pool.query(
//         `SELECT role, content
//        FROM chat_messages
//        WHERE user_id = $1
//        ORDER BY created_at DESC
//        LIMIT 10`,
//         [user_id],
//       );

//       // Add them (chronological) to current messages for context
//       const history = rows.reverse();
//       for (const h of history) {
//         if (h.content !== lastUserMsg)
//           messages.unshift({ role: h.role, content: h.content });
//       }

//       // 🧹 Purge older messages beyond last 30
//       await pool.query(
//         `DELETE FROM chat_messages
//        WHERE user_id = $1
//        AND id NOT IN (
//          SELECT id FROM chat_messages
//          WHERE user_id = $1
//          ORDER BY created_at DESC
//          LIMIT 30
//        );`,
//         [user_id],
//       );
//     } catch (err: any) {
//       console.warn('⚠️ chat history retrieval failed:', err.message);
//     }
//     /* 🧠 --- MEMORY BLOCK END --- */

//     /* 🧠 --- LOAD LONG-TERM SUMMARY MEMORY (with Redis cache) --- */
//     let longTermSummary = '';
//     try {
//       const cacheKey = `memory:${user_id}`;
//       const cached = await redis.get<string>(cacheKey);

//       if (cached) {
//         console.log(`🟢 Redis HIT for ${cacheKey}`);
//         longTermSummary = cached;
//       } else {
//         console.log(`🔴 Redis MISS for ${cacheKey} — fetching from Postgres`);
//         const { rows } = await pool.query(
//           `SELECT summary FROM chat_memory WHERE user_id = $1`,
//           [user_id],
//         );
//         if (rows[0]?.summary) {
//           longTermSummary = rows[0].summary;
//           console.log(`🟢 Caching summary in Redis for ${cacheKey}`);
//           await redis.set(cacheKey, longTermSummary, { ex: 86400 });
//         }
//       }
//     } catch (err: any) {
//       console.warn(
//         '⚠️ failed to load summary from Redis/Postgres:',
//         err.message,
//       );
//     }

//     // 1️⃣ Generate base text with OpenAI
//     const completion = await this.openai.chat.completions.create({
//       model: 'gpt-4o',
//       temperature: 0.8,
//       messages: [
//         {
//           role: 'system',
//           content: `
// You are a world-class personal fashion stylist.
// Keep in mind the user's previous preferences and style details:
// ${longTermSummary || '(no prior memory yet)'}
// Respond naturally about outfits, wardrobe planning, or styling.
// At the end, return a short JSON block like:
// {"search_terms":["smart casual men","navy blazer outfit","loafers"]}
//         `,
//         },
//         ...messages,
//       ],
//     });

//     const aiReply =
//       completion.choices[0]?.message?.content?.trim() ||
//       'Styled response unavailable.';

//     // 2️⃣ Extract search terms if model provided them
//     let searchTerms: string[] = [];
//     const match = aiReply.match(/\{.*"search_terms":.*\}/s);
//     if (match) {
//       try {
//         const parsed = JSON.parse(match[0]);
//         searchTerms = parsed.search_terms ?? [];
//       } catch {
//         searchTerms = [];
//       }
//     }

//     // 3️⃣ Fallback heuristic: derive terms if none found
//     if (!searchTerms.length) {
//       const lowered = lastUserMsg.toLowerCase();
//       if (lowered.includes('smart')) searchTerms.push('smart casual outfit');
//       if (lowered.includes('summer')) searchTerms.push('summer outfit');
//       if (lowered.includes('work')) searchTerms.push('business casual look');
//       if (!searchTerms.length)
//         searchTerms.push(`${lowered} outfit inspiration`);
//     }

//     // 4️⃣ Fetch Unsplash images
//     const images = await this.fetchUnsplash(searchTerms);

//     // 5️⃣ Build shoppable links
//     const links = searchTerms.map((term) => ({
//       label: `Shop ${term} on ASOS`,
//       url: `https://www.asos.com/search/?q=${encodeURIComponent(term)}`,
//     }));

//     /* 🧠 --- SAVE ASSISTANT REPLY --- */
//     try {
//       await pool.query(
//         `INSERT INTO chat_messages (user_id, role, content)
//        VALUES ($1,$2,$3)`,
//         [user_id, 'assistant', aiReply],
//       );
//     } catch (err: any) {
//       console.warn('⚠️ failed to store assistant reply:', err.message);
//     }

//     /* 🧠 --- UPDATE LONG-TERM SUMMARY MEMORY (Postgres + Redis) --- */
//     try {
//       const { rows } = await pool.query(
//         `SELECT summary FROM chat_memory WHERE user_id = $1`,
//         [user_id],
//       );
//       const prevSummary = rows[0]?.summary || '';

//       const { rows: recent } = await pool.query(
//         `SELECT role, content FROM chat_messages
//        WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
//         [user_id],
//       );

//       const context = recent
//         .reverse()
//         .map((r) => `${r.role}: ${r.content}`)
//         .join('\n');

//       const memoryPrompt = `
// You are a memory summarizer for an AI stylist.
// Update this user's long-term fashion memory summary.
// Keep what you've already learned, and merge any new useful insights.

// Previous memory summary:
// ${prevSummary}

// Recent chat history:
// ${context}

// Write a concise, 150-word updated summary focusing on their taste, preferences, and style evolution.
// `;

//       const memCompletion = await this.openai.chat.completions.create({
//         model: 'gpt-4o-mini',
//         temperature: 0.3,
//         messages: [{ role: 'system', content: memoryPrompt }],
//       });

//       const newSummary =
//         memCompletion.choices[0]?.message?.content?.trim() || prevSummary;

//       const trimmedSummary = newSummary.slice(0, 1000).replace(/[*_#`]/g, '');

//       await pool.query(
//         `INSERT INTO chat_memory (user_id, summary, updated_at)
//        VALUES ($1, $2, NOW())
//        ON CONFLICT (user_id)
//        DO UPDATE SET summary = $2, updated_at = NOW();`,
//         [user_id, trimmedSummary],
//       );

//       // ✅ Cache the updated summary in Redis for 24 hours
//       await redis.set(`memory:${user_id}`, trimmedSummary, { ex: 86400 });
//     } catch (err: any) {
//       console.warn('⚠️ failed to update long-term memory:', err.message);
//     }

//     return { reply: aiReply, images, links };
//   }

//   // 🧠 Completely clear all chat + memory for a user
//   async clearChatHistory(user_id: string) {
//     try {
//       // 1️⃣ Delete all chat messages for the user
//       await pool.query(`DELETE FROM chat_messages WHERE user_id = $1`, [
//         user_id,
//       ]);

//       // 2️⃣ Delete long-term memory summaries
//       await pool.query(`DELETE FROM chat_memory WHERE user_id = $1`, [user_id]);

//       // 3️⃣ Clear Redis cache for this user
//       await redis.del(`memory:${user_id}`);

//       console.log(`🧹 Cleared ALL chat + memory for user ${user_id}`);
//       return { success: true, message: 'All chat history and memory cleared.' };
//     } catch (err: any) {
//       console.error('❌ Failed to clear chat history:', err.message);
//       throw new Error('Failed to clear chat history.');
//     }
//   }

//   // 🧹 Soft reset: clear short-term chat but retain long-term memory
//   async softResetChat(user_id: string) {
//     try {
//       // Delete recent messages but keep memory summary
//       await pool.query(`DELETE FROM chat_messages WHERE user_id = $1`, [
//         user_id,
//       ]);

//       console.log(`🧹 Soft reset chat for user ${user_id}`);
//       return {
//         success: true,
//         message: 'Recent chat messages cleared (long-term memory retained).',
//       };
//     } catch (err: any) {
//       console.error('❌ Failed to soft-reset chat:', err.message);
//       throw new Error('Failed to soft reset chat.');
//     }
//   }

//   /** 🔍 Lightweight Unsplash fetch helper */
//   private async fetchUnsplash(terms: string[]) {
//     const key = process.env.UNSPLASH_ACCESS_KEY;
//     if (!key || !terms.length) return [];
//     const q = encodeURIComponent(terms[0]);
//     const res = await fetch(
//       `https://api.unsplash.com/search/photos?query=${q}&per_page=5&client_id=${key}`,
//     );
//     if (!res.ok) return [];
//     const json = await res.json();
//     return json.results.map((r) => ({
//       imageUrl: r.urls.small,
//       title: r.description || r.alt_description,
//       sourceLink: r.links.html,
//     }));
//   }

//   /** 🌤️ Suggest daily style plan */
//   async suggest(body: {
//     user?: string;
//     weather?: any;
//     wardrobe?: any[];
//     preferences?: Record<string, any>;
//   }) {
//     const { user, weather, wardrobe, preferences } = body;

//     const temp = weather?.fahrenheit?.main?.temp;
//     const tempDesc = temp
//       ? `${temp}°F and ${temp < 60 ? 'cool' : temp > 85 ? 'warm' : 'mild'} weather`
//       : 'unknown temperature';

//     const wardrobeCount = wardrobe?.length || 0;

//     const systemPrompt = `
// You are a luxury personal stylist.
// Your goal is to provide a daily style briefing that helps the user feel prepared, stylish, and confident.
// Be concise, intelligent, and polished — similar to a stylist at a high-end menswear brand.

// Output must be JSON with:
// - suggestion
// - insight
// - tomorrow
// Optionally include seasonalForecast, lifecycleForecast, styleTrajectory.
// `;

//     const userPrompt = `
// Client: ${user || 'The user'}
// Weather: ${tempDesc}
// Wardrobe items: ${wardrobeCount}
// Preferences: ${JSON.stringify(preferences || {})}
// `;

//     const completion = await this.openai.chat.completions.create({
//       model: 'gpt-4o',
//       temperature: 0.8,
//       messages: [
//         { role: 'system', content: systemPrompt },
//         { role: 'user', content: userPrompt },
//       ],
//       response_format: { type: 'json_object' },
//     });

//     const raw = completion.choices[0]?.message?.content;
//     if (!raw) throw new Error('No suggestion response received from model.');

//     let parsed: {
//       suggestion: string;
//       insight: string;
//       tomorrow: string;
//       seasonalForecast?: string;
//       lifecycleForecast?: string;
//       styleTrajectory?: string;
//     };

//     try {
//       parsed = JSON.parse(raw);
//     } catch {
//       console.error('❌ Failed to parse AI JSON:', raw);
//       throw new Error('AI response was not valid JSON.');
//     }

//     if (!parsed.seasonalForecast) {
//       parsed.seasonalForecast = generateSeasonalForecast(wardrobe);
//     }

//     return parsed;
//   }

//   /* ------------------------------------------------------------
//      🧾 BARCODE / CLOTHING LABEL DECODER
//   -------------------------------------------------------------*/
//   async decodeBarcode(file: {
//     buffer: Buffer;
//     originalname: string;
//     mimetype: string;
//   }) {
//     const tempPath = `/tmp/${Date.now()}-barcode.jpg`;
//     fs.writeFileSync(tempPath, file.buffer);

//     try {
//       const base64 = fs.readFileSync(tempPath).toString('base64');

//       const prompt = `
//       You are analyzing a photo of a product or clothing label.
//       If the image contains a barcode, return ONLY the numeric digits (UPC/EAN).
//       Otherwise, infer structured product info like:
//       {
//         "name": "Uniqlo Linen Shirt",
//         "brand": "Uniqlo",
//         "category": "Shirts",
//         "material": "Linen"
//       }
//       Respond with JSON only. No extra text.
//       `;

//       const completion = await this.openai.chat.completions.create({
//         model: 'gpt-4o-mini',
//         messages: [
//           {
//             role: 'user',
//             content: [
//               { type: 'text', text: prompt },
//               {
//                 type: 'image_url',
//                 image_url: { url: `data:${file.mimetype};base64,${base64}` },
//               },
//             ],
//           },
//         ],
//         max_tokens: 200,
//       });

//       const message = completion.choices?.[0]?.message;

//       let text = '';
//       if (typeof message?.content === 'string') {
//         text = message.content;
//       } else if (Array.isArray(message?.content)) {
//         const parts = message.content as Array<{ text?: string }>;
//         text = parts.map((c) => c.text || '').join(' ');
//       }

//       text = text.trim().replace(/```json|```/g, '');

//       const match = text.match(/\b\d{8,14}\b/);
//       if (match) return { barcode: match[0], raw: text };

//       try {
//         const parsed = JSON.parse(text);
//         if (parsed?.name) return { barcode: null, inferred: parsed };
//       } catch {}

//       return { barcode: null, raw: text };
//     } catch (err: any) {
//       console.error('❌ [AI] decodeBarcode error:', err.message);
//       return { barcode: null, error: err.message };
//     } finally {
//       try {
//         fs.unlinkSync(tempPath);
//       } catch {}
//     }
//   }

//   /* ------------------------------------------------------------
//      🧩 PRODUCT LOOKUP BY BARCODE
//   -------------------------------------------------------------*/
//   async lookupProductByBarcode(upc: string) {
//     const normalized = upc.padStart(12, '0');
//     try {
//       const res = await fetch(
//         `https://api.upcitemdb.com/prod/trial/lookup?upc=${normalized}`,
//       );
//       const json = await res.json();

//       const item = json?.items?.[0];
//       if (!item) throw new Error('No product data from UPCItemDB');

//       return {
//         name: item.title,
//         brand: item.brand,
//         image: item.images?.[0],
//         category: item.category,
//         source: 'upcitemdb',
//       };
//     } catch (err: any) {
//       console.warn('⚠️ UPCItemDB lookup failed:', err.message);
//       const fallback = await this.lookupFallback(normalized);
//       if (!fallback?.name || fallback.name === 'Unknown product') {
//         return await this.lookupFallbackWithAI(normalized);
//       }
//       return fallback;
//     }
//   }

//   /* ------------------------------------------------------------
//      🔁 RapidAPI or Dummy Fallback
//   -------------------------------------------------------------*/
//   async lookupFallback(upc: string) {
//     try {
//       const res = await fetch(`https://barcodes1.p.rapidapi.com/?upc=${upc}`, {
//         headers: {
//           'X-RapidAPI-Key': process.env.RAPIDAPI_KEY ?? '',
//           'X-RapidAPI-Host': 'barcodes1.p.rapidapi.com',
//         },
//       });

//       const json = await res.json();
//       const product = json?.product ?? {};

//       return {
//         name: product.title || json.title || 'Unknown product',
//         brand: product.brand || json.brand || 'Unknown brand',
//         image: product.image || json.image || null,
//         category: product.category || 'Uncategorized',
//         source: 'rapidapi',
//       };
//     } catch (err: any) {
//       console.error('❌ lookupFallback failed:', err.message);
//       return { name: null, brand: null, image: null, category: null };
//     }
//   }

//   /* ------------------------------------------------------------
//      🤖 AI Fallback Guess
//   -------------------------------------------------------------*/
//   async lookupFallbackWithAI(upc: string) {
//     try {
//       const prompt = `
//       The barcode number is: ${upc}.
//       Guess the product based on global manufacturer codes.
//       Return valid JSON only:
//       {"name":"Example Product","brand":"Brand","category":"Category"}
//       `;

//       const completion = await this.openai.chat.completions.create({
//         model: 'gpt-4o-mini',
//         messages: [{ role: 'user', content: prompt }],
//         max_tokens: 150,
//       });

//       let text = completion.choices?.[0]?.message?.content?.trim() || '{}';
//       text = text.replace(/```json|```/g, '').trim();

//       let parsed: any;
//       try {
//         parsed = JSON.parse(text);
//       } catch {
//         parsed = {
//           name:
//             text.replace(/["{}]/g, '').split(',')[0]?.trim() ||
//             'Unknown product',
//           brand: 'Unknown',
//           category: 'Misc',
//         };
//       }

//       return {
//         name: parsed.name || 'Unknown product',
//         brand: parsed.brand || 'Unknown',
//         category: parsed.category || 'Misc',
//         source: 'ai-fallback',
//       };
//     } catch (err: any) {
//       console.error('❌ AI fallback failed:', err.message);
//       return {
//         name: 'Unknown product',
//         brand: 'Unknown',
//         category: 'Uncategorized',
//         source: 'ai-fallback',
//       };
//     }
//   }
// }

// END REPLACED CHAT WITH LINKS AND SEARCH NET

/////////////////////////////////////

// import { Injectable } from '@nestjs/common';
// import OpenAI from 'openai';
// import { ChatDto } from './dto/chat.dto';
// import { VertexService } from '../vertex/vertex.service'; // 🔹 ADDED
// import { ProductSearchService } from '../product-services/product-search.service';
// import { Pool } from 'pg';
// import { Express } from 'express';

// const pool = new Pool({
//   connectionString: process.env.DATABASE_URL,
//   ssl: { rejectUnauthorized: false },
// });

// import * as fs from 'fs';
// import * as path from 'path';
// import * as dotenv from 'dotenv';

// function loadOpenAISecrets(): {
//   apiKey?: string;
//   project?: string;
//   source: string;
// } {
//   const candidates = [
//     path.join(process.cwd(), '.env'),
//     path.join(process.cwd(), 'apps', 'backend-nest', '.env'),
//     path.join(__dirname, '..', '..', '.env'),
//   ];

//   for (const p of candidates) {
//     try {
//       if (fs.existsSync(p)) {
//         const parsed = dotenv.parse(fs.readFileSync(p));
//         const apiKey = parsed['OPENAI_API_KEY'];
//         const project = parsed['OPENAI_PROJECT_ID'];
//         if (apiKey) return { apiKey, project, source: p };
//       }
//     } catch {
//       // ignore
//     }
//   }

//   return {
//     apiKey: process.env.OPENAI_API_KEY,
//     project: process.env.OPENAI_PROJECT_ID,
//     source: 'process.env',
//   };
// }

// // 🧥 Basic capsule wardrobe templates
// const CAPSULES = {
//   Spring: [
//     { category: 'Outerwear', subcategory: 'Light Jacket', recommended: 2 },
//     { category: 'Tops', subcategory: 'Oxford Shirt', recommended: 3 },
//     { category: 'Bottoms', subcategory: 'Chinos', recommended: 2 },
//     { category: 'Shoes', subcategory: 'Loafers', recommended: 1 },
//     { category: 'Shoes', subcategory: 'Sneakers', recommended: 1 },
//   ],
//   Summer: [
//     { category: 'Tops', subcategory: 'Short Sleeve Shirt', recommended: 4 },
//     { category: 'Tops', subcategory: 'Polo Shirt', recommended: 2 },
//     { category: 'Bottoms', subcategory: 'Linen Trousers', recommended: 2 },
//     { category: 'Shoes', subcategory: 'Loafers', recommended: 1 },
//     { category: 'Shoes', subcategory: 'Sandals', recommended: 1 },
//   ],
//   Fall: [
//     { category: 'Outerwear', subcategory: 'Field Jacket', recommended: 1 },
//     { category: 'Outerwear', subcategory: 'Blazer', recommended: 1 },
//     { category: 'Tops', subcategory: 'Knit Sweater', recommended: 2 },
//     { category: 'Bottoms', subcategory: 'Wool Trousers', recommended: 2 },
//     { category: 'Shoes', subcategory: 'Chelsea Boots', recommended: 1 },
//   ],
//   Winter: [
//     { category: 'Outerwear', subcategory: 'Overcoat', recommended: 1 },
//     { category: 'Outerwear', subcategory: 'Heavy Parka', recommended: 1 },
//     { category: 'Tops', subcategory: 'Heavy Knit Sweater', recommended: 2 },
//     { category: 'Bottoms', subcategory: 'Wool Trousers', recommended: 2 },
//     { category: 'Shoes', subcategory: 'Boots', recommended: 2 },
//   ],
// };

// // 🗓️ Auto-detect season based on month
// function getCurrentSeason(): 'Spring' | 'Summer' | 'Fall' | 'Winter' {
//   const month = new Date().getMonth() + 1;
//   if ([3, 4, 5].includes(month)) return 'Spring';
//   if ([6, 7, 8].includes(month)) return 'Summer';
//   if ([9, 10, 11].includes(month)) return 'Fall';
//   return 'Winter';
// }

// // 🧠 Compare wardrobe to capsule and return simple forecast text
// function generateSeasonalForecast(wardrobe: any[] = []): string | undefined {
//   const season = getCurrentSeason();
//   const capsule = CAPSULES[season];
//   if (!capsule) return;

//   const missing: string[] = [];

//   capsule.forEach((item) => {
//     const owned = wardrobe.filter(
//       (w) =>
//         w.category?.toLowerCase() === item.category.toLowerCase() &&
//         w.subcategory?.toLowerCase() === item.subcategory.toLowerCase(),
//     ).length;

//     if (owned < item.recommended) {
//       const needed = item.recommended - owned;
//       missing.push(`${needed} × ${item.subcategory}`);
//     }
//   });

//   if (missing.length === 0) {
//     return `✅ Your ${season} capsule is complete — you're ready for the season.`;
//   }

//   return `🍂 ${season} is approaching — you're missing: ${missing.join(', ')}.`;
// }

// @Injectable()
// export class AiService {
//   private openai: OpenAI;
//   private useVertex: boolean;
//   private vertexService?: VertexService; // 🔹 optional instance
//   private productSearch: ProductSearchService; // ✅ add this

//   constructor(vertexService?: VertexService) {
//     const { apiKey, project, source } = loadOpenAISecrets();

//     const snippet = apiKey?.slice(0, 20) ?? '';
//     const len = apiKey?.length ?? 0;
//     console.log('🔑 OPENAI key source:', source);
//     console.log('🔑 OPENAI key snippet:', JSON.stringify(snippet));
//     console.log('🔑 OPENAI key length:', len);
//     console.log('📂 CWD:', process.cwd());

//     if (!apiKey) {
//       throw new Error('OPENAI_API_KEY not found in .env or environment.');
//     }
//     if (/^sk-?x{3,}/i.test(apiKey)) {
//       throw new Error(
//         'OPENAI_API_KEY appears masked (e.g., "sk-xxxxx..."). Read from the correct .env instead.',
//       );
//     }
//     if (!apiKey.startsWith('sk-')) {
//       throw new Error('OPENAI_API_KEY is malformed — must start with "sk-".');
//     }

//     this.openai = new OpenAI({ apiKey, project });

//     // 🔹 New: Vertex toggle
//     this.useVertex = process.env.USE_VERTEX === 'true';
//     if (this.useVertex) {
//       this.vertexService = vertexService;
//       console.log('🧠 Vertex/Gemini mode enabled for analyze/recreate');
//     }

//     this.productSearch = new ProductSearchService(); // NEW
//   }

//   //////ANALYZE LOOK

//   async analyze(imageUrl: string) {
//     console.log('🧠 [AI] analyze() called with', imageUrl);
//     if (!imageUrl) throw new Error('Missing imageUrl');

//     // 🔹 Try Vertex first if enabled
//     if (this.useVertex && this.vertexService) {
//       try {
//         const gcsUri = imageUrl.replace(
//           'https://storage.googleapis.com/',
//           'gs://',
//         );
//         const metadata = await this.vertexService.analyzeImage(gcsUri);
//         const tags = [
//           ...(metadata.tags || []),
//           ...(metadata.style_descriptors || []),
//           metadata.main_category,
//           metadata.subcategory,
//         ].filter(Boolean);
//         console.log('🧠 [Vertex] analyze() success:', tags);
//         return { tags };
//       } catch (err: any) {
//         console.warn(
//           '[Vertex] analyze() failed → fallback to OpenAI:',
//           err.message,
//         );
//       }
//     }

//     // 🔸 OpenAI fallback
//     try {
//       const completion = await this.openai.chat.completions.create({
//         model: 'gpt-4o-mini',
//         messages: [
//           {
//             role: 'system',
//             content:
//               'You are a professional fashion classifier. Return only JSON with a "tags" array describing the outfit’s style, color palette, and vibe.',
//           },
//           {
//             role: 'user',
//             content: [
//               { type: 'text', text: 'Describe this outfit as tags only:' },
//               { type: 'image_url', image_url: { url: imageUrl } },
//             ],
//           },
//         ],
//         response_format: { type: 'json_object' },
//       });

//       const raw = completion.choices[0]?.message?.content;
//       console.log('🧠 [AI] analyze() raw response:', raw);

//       if (!raw) throw new Error('Empty response from OpenAI');
//       const parsed = JSON.parse(raw || '{}');
//       return { tags: parsed.tags || [] };
//     } catch (err: any) {
//       console.error('❌ [AI] analyze() failed:', err.message);
//       return { tags: ['casual', 'modern', 'neutral'] };
//     }
//   }

//   /* ------------------------------------------------------------
//      🧩 Weighted Tag Enrichment + Trend Injection
//   -------------------------------------------------------------*/
//   private async enrichTags(tags: string[]): Promise<string[]> {
//     const weightMap: Record<string, number> = {
//       tailored: 3,
//       minimal: 3,
//       neutral: 3,
//       modern: 2,
//       vintage: 2,
//       classic: 2,
//       streetwear: 2,
//       oversized: 2,
//       slim: 2,
//       relaxed: 2,
//       casual: 1,
//       sporty: 1,
//     };

//     // 🧹 Normalize + de-dupe
//     const cleanTags = Array.from(
//       new Set(
//         tags
//           .map((t) => t.toLowerCase().trim())
//           .filter((t) => t && !['outfit', 'style', 'fashion'].includes(t)),
//       ),
//     );

//     // 🧠 Apply weights
//     const weighted = cleanTags
//       .map((t) => ({ tag: t, weight: weightMap[t] || 1 }))
//       .sort((a, b) => b.weight - a.weight);

//     // 🌍 Inject current trend tags
//     const trendTags = await this.fetchTrendTags();
//     const final = Array.from(
//       new Set([...weighted.map((w) => w.tag), ...trendTags.slice(0, 3)]),
//     );

//     console.log('🎯 [AI] Enriched tags →', final);
//     return final;
//   }

//   private async fetchTrendTags(): Promise<string[]> {
//     try {
//       const res = await fetch(
//         'https://trends.google.com/trends/hottrends/visualize/internal/data/en_us',
//       );
//       if (!res.ok) throw new Error(`HTTP ${res.status}`);
//       const json = await res.json().catch(() => []);
//       const trendWords = JSON.stringify(json).toLowerCase();
//       const matched = trendWords.match(
//         /(quiet luxury|monochrome|minimalism|maximalism|italian|tailoring|loafers|neutrals|linen|structured|preppy|flannel|earth tones|autumn layering)/gi,
//       );
//       if (matched?.length) return Array.from(new Set(matched));

//       // 🧭 If Google Trends returned empty, use local backup
//       return [
//         'quiet luxury',
//         'neutral tones',
//         'tailored fit',
//         'autumn layering',
//       ];
//     } catch (err: any) {
//       console.warn('⚠️ Trend fetch fallback triggered:', err.message);
//       return [
//         'quiet luxury',
//         'neutral tones',
//         'tailored fit',
//         'autumn layering',
//       ];
//     }
//   }

//   // RECREATE//////////////
//   async recreate(
//     user_id: string,
//     tags: string[],
//     image_url?: string,
//     user_gender?: string,
//   ) {
//     console.log(
//       '🧥 [AI] recreate() called for user',
//       user_id,
//       'with tags:',
//       tags,
//       'and gender:',
//       user_gender,
//     );

//     if (!user_id) throw new Error('Missing user_id');
//     if (!tags?.length) {
//       console.warn('⚠️ [AI] recreate() empty tags → using defaults.');
//       tags = ['modern', 'neutral', 'tailored'];
//     }

//     // ✅ Weighted + trend-injected tags
//     tags = await this.enrichTags(tags);

//     // 🧠 Fetch gender_presentation if missing
//     if (!user_gender) {
//       try {
//         const result = await pool.query(
//           'SELECT gender_presentation FROM users WHERE id = $1 LIMIT 1',
//           [user_id],
//         );
//         user_gender = result.rows[0]?.gender_presentation || 'neutral';
//       } catch {
//         user_gender = 'neutral';
//       }
//     }

//     // 🧩 Normalize gender
//     const normalizedGender =
//       user_gender?.toLowerCase().includes('female') ||
//       user_gender?.toLowerCase().includes('woman')
//         ? 'female'
//         : user_gender?.toLowerCase().includes('male') ||
//             user_gender?.toLowerCase().includes('man')
//           ? 'male'
//           : process.env.DEFAULT_GENDER || 'neutral';

//     // 🧠 Build stylist prompt (base)
//     let prompt = `
//         You are a world-class AI stylist for ${normalizedGender} fashion.
//         Create a cohesive outfit inspired by an uploaded look.

//         Client: ${user_id}
//         Image: ${image_url || 'N/A'}
//         Detected tags: ${tags.join(', ')}

//         Rules:
//         - Match fabric, color palette, and silhouette.
//         - Use ${normalizedGender}-appropriate pieces.
//         - Output only JSON:
//         {
//           "outfit": [
//             { "category": "Top", "item": "Grey Cotton Tee", "color": "gray" },
//             { "category": "Bottom", "item": "Navy Chinos", "color": "navy" },
//             { "category": "Outerwear", "item": "Beige Overshirt", "color": "beige" },
//             { "category": "Shoes", "item": "White Sneakers", "color": "white" }
//           ],
//           "style_note": "Describe how the look connects to the uploaded image."
//         }
//         `;

//     // 🔹 Pull soft profile context (optional)
//     let profileCtx = '';
//     try {
//       const res = await pool.query(
//         `SELECT favorite_colors, fit_preferences, preferred_brands, disliked_styles
//        FROM style_profiles WHERE user_id::text = $1 LIMIT 1`,
//         [user_id],
//       );
//       const prof = res.rows[0];
//       if (prof) {
//         profileCtx = `
//       # USER STYLE CONTEXT (soft influence)
//       • Preferred colors: ${(prof.favorite_colors || []).join(', ') || '—'}
//       • Fit preferences: ${(prof.fit_preferences || []).join(', ') || '—'}
//       • Favorite brands: ${(prof.preferred_brands || []).join(', ') || '—'}
//       • Disliked styles: ${prof.disliked_styles || '—'}
//       Do NOT override the image’s vibe — just bias tone/material choices if relevant.
//       `;
//       }
//     } catch {
//       /* silent fail */
//     }

//     // ✅ Final prompt (merge only if context exists)
//     // Inside recreate() or personalizedShop() final prompt:
//     const finalPrompt = `
// ${prompt}

// # HARD RULES
// - ALWAYS output a full outfit of at least 4–6 distinct pieces.
// - Include a Top, Bottom, Outerwear (if seasonally appropriate), Shoes, and optionally 1–2 Accessories.
// - NEVER omit items because they already exist in the user’s wardrobe.
// - Each piece should have its own JSON object, even if similar to a wardrobe item.
// - Always include color and fit for every item.
// `;

//     // 🧠 Generate outfit via Vertex or OpenAI
//     let parsed: any;
//     if (this.useVertex && this.vertexService) {
//       try {
//         const result =
//           await this.vertexService.generateReasonedOutfit(finalPrompt);
//         let text = result?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
//         text = text
//           .replace(/^```json\s*/i, '')
//           .replace(/```$/, '')
//           .trim();
//         parsed = JSON.parse(text);
//         console.log('🧠 [Vertex] recreate() success');
//       } catch (err: any) {
//         console.warn('[Vertex] recreate() failed → fallback', err.message);
//       }
//     }

//     if (!parsed) {
//       const completion = await this.openai.chat.completions.create({
//         model: 'gpt-4o-mini',
//         temperature: 0.7,
//         messages: [{ role: 'user', content: finalPrompt }],
//         response_format: { type: 'json_object' },
//       });

//       const raw = completion.choices[0]?.message?.content || '{}';
//       try {
//         parsed = JSON.parse(raw);
//       } catch {
//         parsed = {};
//       }
//     }

//     const outfit = Array.isArray(parsed?.outfit) ? parsed.outfit : [];
//     const style_note =
//       parsed?.style_note || 'Modern outfit inspired by the uploaded look.';

//     // 🛍️ Enrich each item with live products
//     const enriched = await Promise.all(
//       outfit.map(async (o: any) => {
//         const query =
//           `${normalizedGender} ${o.item || o.category || ''} ${o.color || ''}`.trim();
//         let products = await this.productSearch.search(query);
//         let top = products[0];

//         if (!top?.image || top.image.includes('No_image')) {
//           const serp = await this.productSearch.searchSerpApi(query);
//           if (serp?.[0]) top = { ...serp[0], source: 'SerpAPI' };
//         }

//         const materialHint =
//           query.match(/(wool|cotton|linen|leather|denim|polyester)/i)?.[0] ||
//           null;
//         const seasonalityHint =
//           query.match(/(summer|winter|fall|spring)/i)?.[0] ||
//           getCurrentSeason();
//         const fitHint =
//           query.match(/(slim|regular|relaxed|oversized|tailored)/i)?.[0] ||
//           'regular';

//         return {
//           category: o.category,
//           item: o.item,
//           color: o.color,
//           brand: top?.brand || 'Unknown',
//           price: top?.price || '—',
//           image:
//             top?.image && top.image.startsWith('http')
//               ? top.image
//               : 'https://upload.wikimedia.org/wikipedia/commons/a/ac/No_image_available.svg',
//           shopUrl:
//             top?.shopUrl ||
//             `https://www.google.com/search?q=${encodeURIComponent(query)}&tbm=shop`,
//           source: top?.source || 'ASOS / Fallback',
//           material: materialHint,
//           seasonality: seasonalityHint,
//           fit: fitHint,
//         };
//       }),
//     );

//     return { user_id, outfit: enriched, style_note };
//   }

//   // 🧩 Ensure every product object includes a usable image URL
//   private fixProductImages(products: any[] = []): any[] {
//     return products.map((prod) => ({
//       ...prod,
//       image:
//         prod.image ||
//         prod.image_url ||
//         prod.thumbnail ||
//         prod.serpapi_thumbnail || // ✅ added
//         prod.img ||
//         prod.picture ||
//         prod.thumbnail_url ||
//         'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg',
//     }));
//   }

//   // 👔 PERSONALIZED SHOP — image + wardrobe + preferences
//   async personalizedShop(
//     user_id: string,
//     image_url: string,
//     user_gender?: string,
//   ) {
//     if (!user_id || !image_url) throw new Error('Missing user_id or image_url');

//     /** -----------------------------------------------------------
//      * 🧠 buildProfileConstraints(profile)
//      * Converts full style_profiles record into explicit hard rules
//      * ---------------------------------------------------------- */
//     function buildProfileConstraints(profile: any): string {
//       if (!profile) return '';

//       const fit = Array.isArray(profile.fit_preferences)
//         ? profile.fit_preferences.join(', ')
//         : profile.fit_preferences;

//       const colors = Array.isArray(profile.favorite_colors)
//         ? profile.favorite_colors.join(', ')
//         : profile.favorite_colors;

//       const brands = Array.isArray(profile.preferred_brands)
//         ? profile.preferred_brands.join(', ')
//         : profile.preferred_brands;

//       const styles = [
//         ...(profile.style_keywords || []),
//         ...(profile.style_preferences || []),
//       ]
//         .filter(Boolean)
//         .join(', ');

//       const dislikes =
//         typeof profile.disliked_styles === 'string'
//           ? profile.disliked_styles
//           : (profile.disliked_styles || []).join(', ');

//       const climate = profile.climate || 'Temperate';
//       const goals = profile.goals || '';

//       // 🔹 Inject explicit hard “only color” or “except color” rule for the model itself
//       let colorRule = '';
//       if (profile.disliked_styles?.match(/only\s+(\w+)/i)) {
//         const onlyColor = profile.disliked_styles.match(/only\s+(\w+)/i)[1];
//         colorRule = `• Use ONLY ${onlyColor} items — all other colors are forbidden.`;
//       } else if (profile.disliked_styles?.match(/except\s+(\w+)/i)) {
//         const exceptColor = profile.disliked_styles.match(/except\s+(\w+)/i)[1];
//         colorRule = `• Exclude every color except ${exceptColor}.`;
//       }

//       // 🔹 Explicitly enforce fit preferences
//       let fitRule = '';
//       if (profile.fit_preferences?.length) {
//         fitRule = `• Allow ONLY these fits: ${profile.fit_preferences.join(
//           ', ',
//         )}; exclude all others.`;
//       }

//       return `
// # USER PROFILE CONSTRAINTS (Hard Rules)

// ${fitRule}
// ${colorRule}

// • Fit: ${fit || 'Regular fit'} — outfit items must match this silhouette; exclude all opposing fits.
// • Climate: ${climate} — use materials and layers appropriate to this temperature zone.
// • Preferred brands: ${brands || '—'} — bias all product searches toward these or comparable aesthetics.
// • Favorite colors: ${colors || '—'} — bias color palette to these tones; avoid disliked colors.
// • Disliked styles: ${dislikes || '—'} — exclude these aesthetics entirely.
// • Style & vibe keywords: ${styles || '—'} — reflect these qualities in overall tone and accessories.
// • Goals: ${goals}
// • Body & proportions: ${profile.body_type || '—'}, ${
//         profile.proportions || '—'
//       } — ensure silhouette and layering suit these proportions.
// • Skin tone / hair / eyes: ${profile.skin_tone || '—'}, ${
//         profile.hair_color || '—'
//       }, ${profile.eye_color || '—'} — choose tones that complement.
// `;
//     }

//     // 1) Analyze uploaded image
//     const analysis = await this.analyze(image_url);
//     const tags = analysis?.tags || [];

//     //   const { rows: wardrobe } = await pool.query(
//     //     `SELECT name, main_category AS category, subcategory, color, material
//     //  FROM wardrobe_items
//     //  WHERE user_id::text = $1
//     //  ORDER BY updated_at DESC
//     //  LIMIT 50`,
//     //     [user_id],
//     //   );

//     // 🚫 Skip wardrobe entirely for personalized mode
//     const wardrobe: any[] = [];

//     const prefRes = await pool.query(
//       `SELECT gender_presentation
//      FROM users
//      WHERE id = $1
//      LIMIT 1`,
//       [user_id],
//     );
//     const profile = prefRes.rows[0] || {};
//     const gender = user_gender || profile.gender_presentation || 'neutral';
//     // 2️⃣ Fetch user style profile (full data used for personalization)
//     const styleProfileRes = await pool.query(
//       `
//   SELECT
//     body_type,
//     skin_tone,
//     undertone,
//     climate,
//     favorite_colors,
//     disliked_styles,
//     style_keywords,
//     preferred_brands,
//     goals,
//     proportions,
//     hair_color,
//     eye_color,
//     height,
//     waist,
//     fit_preferences,
//     style_preferences
//   FROM style_profiles
//   WHERE user_id::text = $1
//   LIMIT 1
// `,
//       [user_id],
//     );

//     const styleProfile = styleProfileRes.rows[0] || {};

//     // 🔹 Build user filter preferences
//     const { preferFit, bannedWords } = buildUserFilter(styleProfile);

//     /* ------------------------------------------------------------
//    🎛️ VISUAL + STYLE FILTERING HELPERS
// -------------------------------------------------------------*/
//     const FIT_KEYWORDS = {
//       skinny: [/skinny/i, /super[- ]skinny/i, /spray[- ]on/i],
//       slim: [/slim/i],
//       tailored: [/tailored/i, /tapered/i],
//       relaxed: [/relaxed/i, /loose/i, /baggy/i, /wide[- ]leg/i],
//       oversized: [/oversized/i, /boxy/i],
//     };

//     function buildUserFilter(profile: any) {
//       const fitPrefs = (profile.fit_preferences || []).map((x: string) =>
//         x.toLowerCase(),
//       );
//       const disliked = (profile.disliked_styles || '')
//         .toLowerCase()
//         .split(/[,\s]+/)
//         .filter(Boolean);
//       const favColors = (profile.favorite_colors || []).map((x: string) =>
//         x.toLowerCase(),
//       );

//       const preferFit =
//         fitPrefs.find((f) => /(relaxed|loose|baggy|oversized|boxy)/.test(f)) ||
//         fitPrefs.find((f) => /(regular|tailored)/.test(f)) ||
//         fitPrefs[0] ||
//         null;

//       const banFits: string[] = [];
//       if (preferFit?.match(/relaxed|loose|baggy|oversized|boxy/))
//         banFits.push('skinny', 'slim');
//       else if (preferFit?.match(/skinny|slim/))
//         banFits.push('relaxed', 'baggy', 'oversized');

//       const bannedWords = [
//         ...disliked,
//         ...banFits,
//         ...(!favColors.includes('green') ? ['green'] : []),
//       ]
//         .filter(Boolean)
//         .map((x) => new RegExp(x, 'i'));

//       return { preferFit, bannedWords };
//     }

//     function enforceProfileFilters(
//       products: any[] = [],
//       preferFit?: string | null,
//       bannedWords: RegExp[] = [],
//     ) {
//       if (!products.length) return products;

//       return products
//         .filter((p) => {
//           const hay = `${p.title || ''} ${p.name || ''} ${p.description || ''}`;
//           return !bannedWords.some((rx) => rx.test(hay));
//         })
//         .sort((a, b) => {
//           if (!preferFit) return 0;
//           const aHit = FIT_KEYWORDS[preferFit]?.some((rx) =>
//             rx.test(`${a.title} ${a.name}`),
//           )
//             ? 1
//             : 0;
//           const bHit = FIT_KEYWORDS[preferFit]?.some((rx) =>
//             rx.test(`${b.title} ${b.name}`),
//           )
//             ? 1
//             : 0;
//           return bHit - aHit; // boost preferred fits
//         });
//     }

//     // 3) Ask model to split into "owned" vs "missing"

//     const climateNote = styleProfile.climate
//       ? `The user's climate is ${styleProfile.climate}.
//     If it is cold (like Polar or Cold), emphasize insulated materials, coats, layers, scarves, gloves, and boots.
//     If it is hot (like Tropical or Desert), emphasize breathable, lightweight fabrics and open footwear.`
//       : '';

//     // 🔒 Enforced personalization hierarchy
//     const rules = `
//     # PERSONALIZATION ENFORCEMENT
//     Follow these user preferences as *absolute constraints*, not suggestions.
//     `;

//     const profileConstraints = buildProfileConstraints(styleProfile);

//     const prompt = `
// You are a world-class personal stylist generating a personalized recreation of an uploaded look.
// ${rules}
// ${profileConstraints}

// # IMAGE INSPIRATION
// • Use the uploaded image only as an aesthetic anchor (color story, silhouette, or texture).
// • Do NOT reference or reuse the user's wardrobe.
// • Respect all style profile constraints exactly.
// • Maintain the same mood and spirit as the uploaded image, not a literal copy.
// • Preserve one clear visual motif from the source image (e.g., plaid pattern or color tone) unless climate prohibits.

// # OUTPUT RULES
// - ALWAYS output a complete outfit with distinct Top, Bottom, Shoes, and (if seasonally appropriate) Outerwear and Accessories.
// - Each piece must include category, item, color, and fit.

// Return ONLY valid JSON:
// {
//   "recreated_outfit": [
//     { "source":"purchase", "category":"Top", "item":"...", "color":"...", "fit":"..." }
//   ],
//   "suggested_purchases": [
//     { "category":"...", "item":"...", "color":"...", "material":"...", "brand":"...", "shopUrl":"..." }
//   ],
//   "style_note": "Explain how this respects the user's climate, fit, and taste."
// }

// User gender: ${gender}
// Detected tags: ${tags.join(', ')}
// Weighted tags: ${tags.map((t) => `high priority: ${t}`).join(', ')}
// User style profile: ${JSON.stringify(styleProfile, null, 2)}
// ${climateNote}
// `;

//     console.log('🧥 [personalizedShop] profile:', profile);
//     console.log('🧥 [personalizedShop] gender:', gender);
//     console.log('🧥 [personalizedShop] styleProfile:', styleProfile);
//     console.log('🧠 [personalizedShop] Prompt preview:', prompt.slice(0, 800));

//     // 🧠 DEBUG START — prompt verification
//     console.log('─────────────── PROMPT SENT TO MODEL ───────────────');
//     console.log(prompt);
//     console.log('─────────────── END PROMPT ───────────────');

//     const completion = await this.openai.chat.completions.create({
//       model: 'gpt-4o-mini',
//       temperature: 0.7,
//       messages: [{ role: 'user', content: prompt }],
//       response_format: { type: 'json_object' },
//     });

//     // 🧠 DEBUG END — raw model output
//     console.log('─────────────── RAW MODEL RESPONSE ───────────────');
//     console.log(completion.choices[0]?.message?.content);
//     console.log('─────────────── END RESPONSE ───────────────');

//     let parsed: any = {};
//     try {
//       parsed = JSON.parse(completion.choices[0]?.message?.content || '{}');

//       // 🧩 SAFETY GUARD — ensure we keep valid recreated_outfit
//       try {
//         const parsedKeys = Object.keys(parsed);
//         console.log('✅ [personalizedShop] Parsed JSON keys:', parsedKeys);

//         // If model used "outfit" instead of "recreated_outfit", normalize it
//         if (!parsed.recreated_outfit && parsed.outfit) {
//           parsed.recreated_outfit = parsed.outfit;
//           console.log('✅ [personalizedShop] Mapped outfit → recreated_outfit');
//         }

//         // Double-check array validity before fallback clears it
//         if (parsed.recreated_outfit && parsed.recreated_outfit.length > 0) {
//           console.log(
//             '✅ [personalizedShop] Using recreated_outfit from model',
//           );
//         } else {
//           console.warn(
//             '⚠️ [personalizedShop] No recreated_outfit found — fallback may trigger',
//           );
//         }
//       } catch (err) {
//         console.error(
//           '❌ [personalizedShop] JSON structure guard failed:',
//           err,
//         );
//       }

//       // ✅ Final filter fix — keep wardrobe items but still respect banned fits/styles
//       if (parsed?.recreated_outfit?.length) {
//         parsed.recreated_outfit = parsed.recreated_outfit.filter((o: any) => {
//           if (!o) return false;
//           const text =
//             `${o.item} ${o.category} ${o.color} ${o.fit}`.toLowerCase();
//           if (!text.trim() || text.includes('undefined')) return false;
//           // ✅ Always keep wardrobe items regardless of style bans
//           if (o.source === 'wardrobe') return true;

//           const fitBan = preferFit?.match(/relaxed|oversized|boxy|loose/)
//             ? ['skinny']
//             : preferFit?.match(/skinny|slim|tailored/)
//               ? ['relaxed', 'baggy', 'oversized']
//               : [];

//           const styleBan =
//             (styleProfile.disliked_styles || '')
//               .toLowerCase()
//               .split(/[,\s]+/)
//               .filter(Boolean) || [];

//           const banned = [...fitBan, ...styleBan];
//           return !banned.some((b) => text.includes(b));
//         });

//         console.log(
//           '✅ [personalizedShop] Final filtered outfit →',
//           parsed.recreated_outfit,
//         );
//       }

//       console.log(
//         '💎 [personalizedShop] Parsed recreated outfit sample:',
//         parsed?.recreated_outfit?.slice(0, 2),
//       );
//       console.log(
//         '💎 [personalizedShop] Parsed suggested purchases sample:',
//         parsed?.suggested_purchases?.slice(0, 2),
//       );

//       // 🧩 Merge recreated_outfit into suggested_purchases for display
//       if (
//         Array.isArray(parsed?.recreated_outfit) &&
//         parsed.recreated_outfit.length
//       ) {
//         parsed.suggested_purchases = [
//           ...(parsed.suggested_purchases || []),
//           ...parsed.recreated_outfit.map((o: any) => ({
//             ...o,
//             brand: o.brand || '—',
//             previewImage: o.previewImage || o.image || o.image_url || null,
//             source: 'purchase',
//           })),
//         ];
//         console.log(
//           '🧩 [personalizedShop] merged recreated_outfit → suggested_purchases',
//         );
//       }

//       // 🖼️ Ensure every recreated outfit item has a visible preview image
//       if (Array.isArray(parsed?.recreated_outfit)) {
//         parsed.recreated_outfit = parsed.recreated_outfit.map((item: any) => {
//           if (!item.previewImage && item.source === 'wardrobe') {
//             item.previewImage =
//               item.image_url ||
//               item.wardrobe_image ||
//               'https://upload.wikimedia.org/wikipedia/commons/a/ac/No_image_available.svg';
//           }
//           return item;
//         });
//       }

//       // 🎨 Enforce "only <color>" rule from disliked_styles (e.g. "I dislike all colors except pink")
//       // 🎨 Optional color-only enforcement — only if explicit "ONLY <color>" flag exists
//       if (styleProfile?.disliked_styles?.toLowerCase().includes('only')) {
//         const match = styleProfile.disliked_styles.match(/only\s+(\w+)/i);
//         if (match) {
//           const onlyColor = match[1].toLowerCase();
//           const filterColor = (arr: any[]) =>
//             arr.filter((x) =>
//               (x.color || '').toLowerCase().includes(onlyColor),
//             );

//           if (Array.isArray(parsed?.recreated_outfit))
//             parsed.recreated_outfit = filterColor(parsed.recreated_outfit);
//           if (Array.isArray(parsed?.suggested_purchases))
//             parsed.suggested_purchases = filterColor(
//               parsed.suggested_purchases,
//             );

//           console.log(
//             `[personalizedShop] 🎨 Enforcing ONLY-color rule: ${onlyColor}`,
//           );
//         }
//       }
//     } catch {
//       parsed = {};
//     }

//     const purchases = Array.isArray(parsed?.suggested_purchases)
//       ? parsed.suggested_purchases
//       : [];

//     if (parsed?.recreated_outfit?.some((i: any) => i.source === 'wardrobe')) {
//       console.log('🧥 [personalizedShop] ✅ Model reused wardrobe pieces.');
//     } else {
//       console.warn(
//         '🧥 [personalizedShop] ⚠️ Model did NOT reuse wardrobe — fallback to generic recreation.',
//       );
//     }

//     // 🚫 Enforce profile bans in returned outfit
//     const banned = [
//       ...(styleProfile.disliked_styles?.toLowerCase().split(/[,\s]+/) || []),
//       ...(preferFit?.match(/relaxed|oversized|boxy|loose/)
//         ? ['skinny', 'slim']
//         : []),
//       ...(preferFit?.match(/skinny|slim/)
//         ? ['relaxed', 'oversized', 'baggy']
//         : []),
//     ].filter(Boolean);

//     if (parsed?.recreated_outfit?.length) {
//       // ✅ Keep *all* wardrobe and purchase items — only filter garbage entries
//       parsed.recreated_outfit = parsed.recreated_outfit.filter((o: any) => {
//         if (!o || !o.item) return false;
//         const text =
//           `${o.item} ${o.category} ${o.color} ${o.fit}`.toLowerCase();
//         return text.trim().length > 0 && !text.includes('undefined');
//       });

//       // 🧱 Guarantee full outfit completeness (Top, Bottom, Shoes, Optional Outerwear/Accessory)
//       const categories = parsed.recreated_outfit.map((o: any) =>
//         o.category?.toLowerCase(),
//       );
//       const missing: any[] = [];

//       if (!categories.includes('top'))
//         missing.push({
//           source: 'purchase',
//           category: 'Top',
//           item: 'White Oxford Shirt',
//           color: 'White',
//           fit: 'Slim Fit',
//         });
//       if (!categories.includes('bottoms'))
//         missing.push({
//           source: 'purchase',
//           category: 'Bottoms',
//           item: 'Beige Chinos',
//           color: 'Beige',
//           fit: 'Slim Fit',
//         });
//       if (!categories.includes('shoes'))
//         missing.push({
//           source: 'purchase',
//           category: 'Shoes',
//           item: 'White Leather Sneakers',
//           color: 'White',
//           fit: 'Slim Fit',
//         });

//       parsed.recreated_outfit.push(...missing);

//       console.log(
//         '✅ [personalizedShop] Final full outfit →',
//         parsed.recreated_outfit,
//       );
//     }

//     // 🧩 Centralized enforcement for personalizedShop only
//     function applyProfileFilters(products: any[], profile: any) {
//       if (!Array.isArray(products) || !products.length) return [];

//       const favColors = (profile.favorite_colors || []).map((x: string) =>
//         x.toLowerCase(),
//       );
//       const prefBrands = (profile.preferred_brands || []).map((x: string) =>
//         x.toLowerCase(),
//       );
//       const fitPrefs = (profile.fit_preferences || []).map((x: string) =>
//         x.toLowerCase(),
//       );
//       const dislikes = (profile.disliked_styles || '')
//         .toLowerCase()
//         .split(/[,\s]+/);
//       const climate = (profile.climate || '').toLowerCase();

//       const isCold = /(polar|cold|arctic|tundra|winter)/.test(climate);
//       const isHot = /(tropical|desert|hot|humid|summer)/.test(climate);

//       // 🩷 detect "only" or "except" color rule from disliked_styles
//       let onlyColor: string | null = null;
//       let exceptColor: string | null = null;

//       if (profile.disliked_styles?.match(/only\s+(\w+)/i)) {
//         onlyColor = profile.disliked_styles
//           .match(/only\s+(\w+)/i)[1]
//           .toLowerCase();
//       } else if (profile.disliked_styles?.match(/except\s+(\w+)/i)) {
//         exceptColor = profile.disliked_styles
//           .match(/except\s+(\w+)/i)[1]
//           .toLowerCase();
//       }

//       return products
//         .filter((p) => {
//           const t = `${p.name ?? ''} ${p.title ?? ''} ${p.brand ?? ''} ${
//             p.description ?? ''
//           } ${p.color ?? ''} ${p.fit ?? ''}`.toLowerCase();

//           // 🚫 Filter out disliked words/styles
//           if (dislikes.some((d) => d && t.includes(d))) return false;

//           // 🎨 HARD color enforcement from DB rules
//           if (onlyColor) {
//             // Only allow if text or color includes the specified color
//             if (
//               !t.includes(onlyColor) &&
//               !p.color?.toLowerCase().includes(onlyColor)
//             )
//               return false;
//           } else if (exceptColor) {
//             // Exclude everything not matching that color
//             if (
//               !t.includes(exceptColor) &&
//               !p.color?.toLowerCase().includes(exceptColor)
//             )
//               return false;
//           } else {
//             // Normal favorite color bias if no hard rule
//             if (favColors.length && !favColors.some((c) => t.includes(c)))
//               return false;
//           }

//           // 👕 Fit preferences
//           if (fitPrefs.length && !fitPrefs.some((f) => t.includes(f)))
//             return false;

//           // 🌡️ Climate-based filtering
//           if (isCold && /(tank|shorts|sandal)/.test(t)) return false;
//           if (isHot && /(wool|parka|coat|boot|knit)/.test(t)) return false;

//           return true;
//         })
//         .sort((a, b) => {
//           const score = (x: any) => {
//             const txt =
//               `${x.name} ${x.title} ${x.brand} ${x.color} ${x.fit}`.toLowerCase();
//             let s = 0;
//             if (onlyColor && txt.includes(onlyColor)) s += 4;
//             if (exceptColor && txt.includes(exceptColor)) s += 4;
//             if (favColors.some((c) => txt.includes(c))) s += 2;
//             if (prefBrands.some((b) => txt.includes(b))) s += 2;
//             if (fitPrefs.some((f) => txt.includes(f))) s += 1;
//             return s;
//           };
//           return score(b) - score(a);
//         });
//     }

//     // 4️⃣ Attach live shop links to the "missing" items — now honoring user taste
//     let enrichedPurchases = await Promise.all(
//       purchases.map(async (p: any) => {
//         // 🧠 Gender-locked prefix
//         const genderPrefix =
//           gender?.toLowerCase().includes('female') ||
//           gender?.toLowerCase().includes('woman')
//             ? 'women female womens ladies'
//             : 'men male mens masculine -women -womens -female -girls -ladies';

//         // Base query with gender lock
//         let q = [
//           genderPrefix,
//           p.item || p.category || '',
//           p.color || '',
//           p.material || '',
//         ]
//           .filter(Boolean)
//           .join(' ')
//           .trim();

//         // 🔹 Inject personalization bias terms
//         const brandTerms = (styleProfile.preferred_brands || [])
//           .slice(0, 3)
//           .join(' ');
//         const colorTerms = (styleProfile.favorite_colors || [])
//           .slice(0, 2)
//           .join(' ');
//         const fitTerms = Array.isArray(styleProfile.fit_preferences)
//           ? styleProfile.fit_preferences.join(' ')
//           : styleProfile.fit_preferences || '';

//         // 🎨 “Only color” rule (e.g. “I dislike all colors except pink”)
//         const colorMatch =
//           styleProfile.disliked_styles?.match(/except\s+(\w+)/i);
//         if (colorMatch) {
//           const onlyColor = colorMatch[1].toLowerCase();
//           q += ` ${onlyColor}`;
//         }

//         // Combine into final query with brand + color + fit bias
//         q = [q, brandTerms, colorTerms, fitTerms].filter(Boolean).join(' ');

//         // 🔒 Ensure all queries exclude female results explicitly
//         if (
//           !/-(women|female|ladies|girls)/i.test(q) &&
//           /\bmen\b|\bmale\b/i.test(q)
//         ) {
//           q += ' -women -womens -female -girls -ladies';
//         }

//         // Combine into final query with brand + color + fit bias
//         q = [q, brandTerms, colorTerms, fitTerms].filter(Boolean).join(' ');

//         // 🔒 Ensure all queries exclude female results explicitly
//         if (
//           !/-(women|female|ladies|girls)/i.test(q) &&
//           /\bmen\b|\bmale\b/i.test(q)
//         ) {
//           q += ' -women -womens -female -girls -ladies';
//         }

//         // 🧠 Gender-aware product search
//         let products = await this.productSearch.search(
//           q,
//           gender?.toLowerCase() === 'female'
//             ? 'female'
//             : gender?.toLowerCase() === 'male'
//               ? 'male'
//               : 'unisex',
//         );

//         // 🚫 Filter out any accidental female/unisex results
//         products = products.filter(
//           (prod) =>
//             !/women|female|womens|ladies|girls/i.test(
//               `${prod.name ?? ''} ${prod.brand ?? ''} ${prod.title ?? ''}`,
//             ),
//         );

//         // 🩷 Hard visual color filter — ensures displayed products actually match the enforced color rule
//         if (
//           styleProfile?.disliked_styles?.match(/only\s+(\w+)/i) ||
//           styleProfile?.disliked_styles?.match(/except\s+(\w+)/i)
//         ) {
//           const match =
//             styleProfile.disliked_styles.match(/only\s+(\w+)/i) ||
//             styleProfile.disliked_styles.match(/except\s+(\w+)/i);
//           const enforcedColor = match?.[1]?.toLowerCase();
//           if (enforcedColor) {
//             products = products.filter((p) => {
//               const text =
//                 `${p.name ?? ''} ${p.title ?? ''} ${p.color ?? ''}`.toLowerCase();
//               return text.includes(enforcedColor);
//             });
//           }
//         }

//         return {
//           ...p,
//           query: q,
//           products: applyProfileFilters(products, styleProfile),
//         };
//       }),
//     );

//     // 5️⃣ Fallback enrichment if AI returned nothing or products failed
//     if (!enrichedPurchases.length) {
//       console.warn(
//         '⚠️ [personalizedShop] Empty suggested_purchases → fallback.',
//       );

//       const tagSeed = tags.slice(0, 6).join(' ');
//       const season = getCurrentSeason();

//       // 🧠 Gender prefix for fallback with hard lock
//       const genderPrefix =
//         gender?.toLowerCase().includes('female') ||
//         gender?.toLowerCase().includes('woman')
//           ? 'women female womens ladies'
//           : 'men male mens masculine -women -womens -female -girls -ladies';

//       // 🧠 Enrich fallback with style taste as well
//       const brandTerms = (styleProfile.preferred_brands || [])
//         .slice(0, 3)
//         .join(' ');
//       const colorTerms = (styleProfile.favorite_colors || [])
//         .slice(0, 2)
//         .join(' ');
//       const fitTerms = Array.isArray(styleProfile.fit_preferences)
//         ? styleProfile.fit_preferences.join(' ')
//         : styleProfile.fit_preferences || '';

//       const fallbackQuery = `${genderPrefix} ${tagSeed} ${season} fashion ${brandTerms} ${colorTerms} ${fitTerms}`;
//       console.log('🧩 [personalizedShop] fallbackQuery →', fallbackQuery);

//       const products = await this.productSearch.search(
//         fallbackQuery,
//         gender?.toLowerCase() === 'female'
//           ? 'female'
//           : gender?.toLowerCase() === 'male'
//             ? 'male'
//             : 'unisex',
//       );

//       // 🚫 Filter out any accidental female/unisex results
//       const maleProducts = products.filter(
//         (prod) =>
//           !/women|female|womens|ladies|girls/i.test(
//             `${prod.name ?? ''} ${prod.brand ?? ''} ${prod.title ?? ''}`,
//           ),
//       );

//       enrichedPurchases = [
//         {
//           category: 'General',
//           item: 'Curated Outfit Add-Ons',
//           color: 'Mixed',
//           material: null,
//           products: applyProfileFilters(maleProducts.slice(0, 8), styleProfile),
//           query: fallbackQuery,
//           source: 'fallback',
//         },
//       ];
//     }

//     // 🎨 Enforce color-only rule on fallback products too
//     if (styleProfile?.disliked_styles) {
//       const match = styleProfile.disliked_styles.match(/except\s+(\w+)/i);
//       if (match) {
//         const onlyColor = match[1].toLowerCase();
//         enrichedPurchases = enrichedPurchases.map((p) => ({
//           ...p,
//           products: (p.products || []).filter((prod) =>
//             (prod.color || '').toLowerCase().includes(onlyColor),
//           ),
//         }));
//         console.log(
//           `[personalizedShop] 🎨 Enforced fallback color-only rule: ${onlyColor}`,
//         );
//       }
//     }

//     const cleanPurchases = enrichedPurchases.map((p) => ({
//       ...p,
//       products: this.fixProductImages(
//         enforceProfileFilters(p.products || [], preferFit, bannedWords),
//       ),
//     }));

//     // 🎨 FINAL VISUAL CONSISTENCY NORMALIZATION
//     const normalizedPurchases = await Promise.all(
//       enrichedPurchases.map(async (p) => {
//         const validProduct =
//           (p.products || []).find(
//             (x) =>
//               (x.image ||
//                 x.image_url ||
//                 x.thumbnail ||
//                 x.serpapi_thumbnail ||
//                 x.thumbnail_url ||
//                 x.img ||
//                 x.result?.thumbnail ||
//                 x.result?.serpapi_thumbnail) &&
//               /^https?:\/\//.test(
//                 x.image ||
//                   x.image_url ||
//                   x.thumbnail ||
//                   x.serpapi_thumbnail ||
//                   x.thumbnail_url ||
//                   x.img ||
//                   x.result?.thumbnail ||
//                   x.result?.serpapi_thumbnail ||
//                   '',
//               ) &&
//               !/no[_-]?image/i.test(
//                 x.image ||
//                   x.image_url ||
//                   x.thumbnail ||
//                   x.serpapi_thumbnail ||
//                   x.thumbnail_url ||
//                   x.img ||
//                   '',
//               ),
//           ) || p.products?.[0];

//         let previewImage =
//           validProduct?.image ||
//           validProduct?.image_url ||
//           validProduct?.thumbnail ||
//           validProduct?.serpapi_thumbnail ||
//           validProduct?.thumbnail_url ||
//           validProduct?.img ||
//           validProduct?.product_thumbnail ||
//           validProduct?.result?.thumbnail ||
//           validProduct?.result?.serpapi_thumbnail ||
//           null;

//         // 🎯 Gender-aware image guard
//         const userGender = (gender || '').toLowerCase();

//         if (previewImage) {
//           const url = previewImage.toLowerCase();

//           // 🧍‍♂️ If male → block clearly female-coded URLs
//           if (
//             userGender.includes('male') &&
//             /(women|woman|female|ladies|girls|womenswear|femme|skims|shein|fashionnova|princesspolly|revolve|anthropologie)/i.test(
//               url,
//             )
//           ) {
//             previewImage =
//               'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg';
//           }

//           // 🧍‍♀️ If female → block clearly male-coded URLs
//           else if (
//             userGender.includes('female') &&
//             /(men|man|male|menswear|masculine)/i.test(url)
//           ) {
//             previewImage =
//               'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg';
//           }

//           // 🧍 Unisex → allow all images
//         }

//         // 🧠 If still missing, do a quick SerpAPI lookup and cache
//         if (!previewImage && p.query) {
//           const results = await this.productSearch.searchSerpApi(p.query);
//           const r = results?.[0];
//           previewImage =
//             r?.image ||
//             r?.image_url ||
//             r?.thumbnail ||
//             r?.serpapi_thumbnail ||
//             r?.thumbnail_url ||
//             r?.result?.thumbnail ||
//             r?.result?.serpapi_thumbnail ||
//             null;

//           // 🎯 Apply same gender guard to SerpAPI result
//           if (previewImage) {
//             const url = previewImage.toLowerCase();

//             if (
//               userGender.includes('male') &&
//               /(women|woman|female|ladies|girls|womenswear|femme|skims|shein|fashionnova|princesspolly|revolve|anthropologie)/i.test(
//                 url,
//               )
//             ) {
//               previewImage =
//                 'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg';
//             } else if (
//               userGender.includes('female') &&
//               /(men|man|male|menswear|masculine)/i.test(url)
//             ) {
//               previewImage =
//                 'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg';
//             }
//           }
//         }

//         return {
//           ...p,
//           previewImage:
//             previewImage ||
//             'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg',
//           previewBrand: validProduct?.brand || p.brand || 'Unknown',
//           previewPrice: validProduct?.price || '—',
//           previewUrl: validProduct?.shopUrl || p.shopUrl || null,
//         };
//       }),
//     ); // ✅ ← closes Promise.all()

//     // 🧹 remove empty product groups (no valid images)
//     const filteredPurchases = normalizedPurchases.filter(
//       (p) => !!p.previewImage,
//     );

//     // 🧊 Climate sanity check — if Polar but outfit lacks insulation, patch style_note
//     if (
//       styleProfile.climate?.toLowerCase().includes('polar') &&
//       !/coat|jacket|parka|boot|knit|sweater/i.test(
//         JSON.stringify(parsed.recreated_outfit || []),
//       )
//     ) {
//       parsed.style_note +=
//         ' Reinforced with insulated outerwear and cold-weather layering for Polar climates.';
//     }

//     // 🚫 Prevent fallback or secondary recreate() from overwriting personalized flow
//     if (
//       enrichedPurchases?.length > 0 ||
//       parsed?.suggested_purchases?.length > 0
//     ) {
//       console.log(
//         '✅ [personalizedShop] Finalizing personalized results — skipping generic recreate()',
//       );
//       return {
//         user_id,
//         image_url,
//         tags,
//         recreated_outfit: parsed?.recreated_outfit || [],
//         suggested_purchases: normalizedPurchases,
//         style_note:
//           parsed?.style_note ||
//           'Personalized recreation based on your wardrobe, with curated seasonal add-ons.',
//         applied_filters: {
//           preferFit,
//           bannedWords: bannedWords.map((r) => r.source),
//         },
//       };
//     }

//     return {
//       user_id,
//       image_url,
//       tags,
//       recreated_outfit: parsed?.recreated_outfit || [],
//       suggested_purchases: normalizedPurchases,
//       style_note:
//         parsed?.style_note ||
//         'Personalized recreation based on your wardrobe, with curated seasonal add-ons.',
//       applied_filters: {
//         preferFit,
//         bannedWords: bannedWords.map((r) => r.source),
//       },
//     };
//   }

//   ////////END CREATE LOOK

//   //////. START REPLACED CHAT WITH LINKS AND SEARCH NET

//   async chat(dto: ChatDto) {
//     const { messages, user_id } = dto;
//     const lastUserMsg = messages
//       .slice()
//       .reverse()
//       .find((m) => m.role === 'user')?.content;

//     if (!lastUserMsg) {
//       throw new Error('No user message provided');
//     }

//     /* 🧠 --- MEMORY BLOCK START --- */
//     try {
//       // Save the latest user message
//       await pool.query(
//         `INSERT INTO chat_messages (user_id, role, content)
//        VALUES ($1,$2,$3)`,
//         [user_id, 'user', lastUserMsg],
//       );

//       // Fetch the last 10 messages for this user
//       const { rows } = await pool.query(
//         `SELECT role, content
//        FROM chat_messages
//        WHERE user_id = $1
//        ORDER BY created_at DESC
//        LIMIT 10`,
//         [user_id],
//       );

//       // Add them (chronological) to current messages for context
//       const history = rows.reverse();
//       for (const h of history) {
//         if (h.content !== lastUserMsg)
//           messages.unshift({ role: h.role, content: h.content });
//       }

//       // 🧹 Purge older messages beyond last 30
//       await pool.query(
//         `DELETE FROM chat_messages
//        WHERE user_id = $1
//        AND id NOT IN (
//          SELECT id FROM chat_messages
//          WHERE user_id = $1
//          ORDER BY created_at DESC
//          LIMIT 30
//        );`,
//         [user_id],
//       );
//     } catch (err: any) {
//       console.warn('⚠️ chat history retrieval failed:', err.message);
//     }
//     /* 🧠 --- MEMORY BLOCK END --- */

//     /* 🧠 --- LOAD LONG-TERM SUMMARY MEMORY --- */
//     let longTermSummary = '';
//     try {
//       const { rows } = await pool.query(
//         `SELECT summary FROM chat_memory WHERE user_id = $1`,
//         [user_id],
//       );
//       if (rows[0]?.summary) longTermSummary = rows[0].summary;
//     } catch (err: any) {
//       console.warn('⚠️ failed to load long-term summary:', err.message);
//     }

//     // 1️⃣ Generate base text with OpenAI
//     const completion = await this.openai.chat.completions.create({
//       model: 'gpt-4o',
//       temperature: 0.8,
//       messages: [
//         {
//           role: 'system',
//           content: `
// You are a world-class personal fashion stylist.
// Keep in mind the user's previous preferences and style details:
// ${longTermSummary || '(no prior memory yet)'}
// Respond naturally about outfits, wardrobe planning, or styling.
// At the end, return a short JSON block like:
// {"search_terms":["smart casual men","navy blazer outfit","loafers"]}
//         `,
//         },
//         ...messages,
//       ],
//     });

//     const aiReply =
//       completion.choices[0]?.message?.content?.trim() ||
//       'Styled response unavailable.';

//     // 2️⃣ Extract search terms if model provided them
//     let searchTerms: string[] = [];
//     const match = aiReply.match(/\{.*"search_terms":.*\}/s);
//     if (match) {
//       try {
//         const parsed = JSON.parse(match[0]);
//         searchTerms = parsed.search_terms ?? [];
//       } catch {
//         searchTerms = [];
//       }
//     }

//     // 3️⃣ Fallback heuristic: derive terms if none found
//     if (!searchTerms.length) {
//       const lowered = lastUserMsg.toLowerCase();
//       if (lowered.includes('smart')) searchTerms.push('smart casual outfit');
//       if (lowered.includes('summer')) searchTerms.push('summer outfit');
//       if (lowered.includes('work')) searchTerms.push('business casual look');
//       if (!searchTerms.length)
//         searchTerms.push(`${lowered} outfit inspiration`);
//     }

//     // 4️⃣ Fetch Unsplash images
//     const images = await this.fetchUnsplash(searchTerms);

//     // 5️⃣ Build shoppable links
//     const links = searchTerms.map((term) => ({
//       label: `Shop ${term} on ASOS`,
//       url: `https://www.asos.com/search/?q=${encodeURIComponent(term)}`,
//     }));

//     /* 🧠 --- SAVE ASSISTANT REPLY --- */
//     try {
//       await pool.query(
//         `INSERT INTO chat_messages (user_id, role, content)
//        VALUES ($1,$2,$3)`,
//         [user_id, 'assistant', aiReply],
//       );
//     } catch (err: any) {
//       console.warn('⚠️ failed to store assistant reply:', err.message);
//     }

//     /* 🧠 --- UPDATE LONG-TERM SUMMARY MEMORY --- */
//     try {
//       const { rows } = await pool.query(
//         `SELECT summary FROM chat_memory WHERE user_id = $1`,
//         [user_id],
//       );
//       const prevSummary = rows[0]?.summary || '';

//       const { rows: recent } = await pool.query(
//         `SELECT role, content FROM chat_messages
//        WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
//         [user_id],
//       );

//       const context = recent
//         .reverse()
//         .map((r) => `${r.role}: ${r.content}`)
//         .join('\n');

//       const memoryPrompt = `
// You are a memory summarizer for an AI stylist.
// Update this user's long-term fashion memory summary.
// Keep what you've already learned, and merge any new useful insights.

// Previous memory summary:
// ${prevSummary}

// Recent chat history:
// ${context}

// Write a concise, 150-word updated summary focusing on their taste, preferences, and style evolution.
// `;

//       const memCompletion = await this.openai.chat.completions.create({
//         model: 'gpt-4o-mini',
//         temperature: 0.3,
//         messages: [{ role: 'system', content: memoryPrompt }],
//       });

//       const newSummary =
//         memCompletion.choices[0]?.message?.content?.trim() || prevSummary;

//       const trimmedSummary = newSummary.slice(0, 1000).replace(/[*_#`]/g, '');

//       await pool.query(
//         `INSERT INTO chat_memory (user_id, summary, updated_at)
//        VALUES ($1, $2, NOW())
//        ON CONFLICT (user_id)
//        DO UPDATE SET summary = $2, updated_at = NOW();`,
//         [user_id, trimmedSummary],
//       );
//     } catch (err: any) {
//       console.warn('⚠️ failed to update long-term memory:', err.message);
//     }

//     return { reply: aiReply, images, links };
//   }

//   /** 🔍 Lightweight Unsplash fetch helper */
//   private async fetchUnsplash(terms: string[]) {
//     const key = process.env.UNSPLASH_ACCESS_KEY;
//     if (!key || !terms.length) return [];
//     const q = encodeURIComponent(terms[0]);
//     const res = await fetch(
//       `https://api.unsplash.com/search/photos?query=${q}&per_page=5&client_id=${key}`,
//     );
//     if (!res.ok) return [];
//     const json = await res.json();
//     return json.results.map((r) => ({
//       imageUrl: r.urls.small,
//       title: r.description || r.alt_description,
//       sourceLink: r.links.html,
//     }));
//   }

//   /** 🌤️ Suggest daily style plan */
//   async suggest(body: {
//     user?: string;
//     weather?: any;
//     wardrobe?: any[];
//     preferences?: Record<string, any>;
//   }) {
//     const { user, weather, wardrobe, preferences } = body;

//     const temp = weather?.fahrenheit?.main?.temp;
//     const tempDesc = temp
//       ? `${temp}°F and ${temp < 60 ? 'cool' : temp > 85 ? 'warm' : 'mild'} weather`
//       : 'unknown temperature';

//     const wardrobeCount = wardrobe?.length || 0;

//     const systemPrompt = `
// You are a luxury personal stylist.
// Your goal is to provide a daily style briefing that helps the user feel prepared, stylish, and confident.
// Be concise, intelligent, and polished — similar to a stylist at a high-end menswear brand.

// Output must be JSON with:
// - suggestion
// - insight
// - tomorrow
// Optionally include seasonalForecast, lifecycleForecast, styleTrajectory.
// `;

//     const userPrompt = `
// Client: ${user || 'The user'}
// Weather: ${tempDesc}
// Wardrobe items: ${wardrobeCount}
// Preferences: ${JSON.stringify(preferences || {})}
// `;

//     const completion = await this.openai.chat.completions.create({
//       model: 'gpt-4o',
//       temperature: 0.8,
//       messages: [
//         { role: 'system', content: systemPrompt },
//         { role: 'user', content: userPrompt },
//       ],
//       response_format: { type: 'json_object' },
//     });

//     const raw = completion.choices[0]?.message?.content;
//     if (!raw) throw new Error('No suggestion response received from model.');

//     let parsed: {
//       suggestion: string;
//       insight: string;
//       tomorrow: string;
//       seasonalForecast?: string;
//       lifecycleForecast?: string;
//       styleTrajectory?: string;
//     };

//     try {
//       parsed = JSON.parse(raw);
//     } catch {
//       console.error('❌ Failed to parse AI JSON:', raw);
//       throw new Error('AI response was not valid JSON.');
//     }

//     if (!parsed.seasonalForecast) {
//       parsed.seasonalForecast = generateSeasonalForecast(wardrobe);
//     }

//     return parsed;
//   }

//   /* ------------------------------------------------------------
//      🧾 BARCODE / CLOTHING LABEL DECODER
//   -------------------------------------------------------------*/
//   async decodeBarcode(file: {
//     buffer: Buffer;
//     originalname: string;
//     mimetype: string;
//   }) {
//     const tempPath = `/tmp/${Date.now()}-barcode.jpg`;
//     fs.writeFileSync(tempPath, file.buffer);

//     try {
//       const base64 = fs.readFileSync(tempPath).toString('base64');

//       const prompt = `
//       You are analyzing a photo of a product or clothing label.
//       If the image contains a barcode, return ONLY the numeric digits (UPC/EAN).
//       Otherwise, infer structured product info like:
//       {
//         "name": "Uniqlo Linen Shirt",
//         "brand": "Uniqlo",
//         "category": "Shirts",
//         "material": "Linen"
//       }
//       Respond with JSON only. No extra text.
//       `;

//       const completion = await this.openai.chat.completions.create({
//         model: 'gpt-4o-mini',
//         messages: [
//           {
//             role: 'user',
//             content: [
//               { type: 'text', text: prompt },
//               {
//                 type: 'image_url',
//                 image_url: { url: `data:${file.mimetype};base64,${base64}` },
//               },
//             ],
//           },
//         ],
//         max_tokens: 200,
//       });

//       const message = completion.choices?.[0]?.message;

//       let text = '';
//       if (typeof message?.content === 'string') {
//         text = message.content;
//       } else if (Array.isArray(message?.content)) {
//         const parts = message.content as Array<{ text?: string }>;
//         text = parts.map((c) => c.text || '').join(' ');
//       }

//       text = text.trim().replace(/```json|```/g, '');

//       const match = text.match(/\b\d{8,14}\b/);
//       if (match) return { barcode: match[0], raw: text };

//       try {
//         const parsed = JSON.parse(text);
//         if (parsed?.name) return { barcode: null, inferred: parsed };
//       } catch {}

//       return { barcode: null, raw: text };
//     } catch (err: any) {
//       console.error('❌ [AI] decodeBarcode error:', err.message);
//       return { barcode: null, error: err.message };
//     } finally {
//       try {
//         fs.unlinkSync(tempPath);
//       } catch {}
//     }
//   }

//   /* ------------------------------------------------------------
//      🧩 PRODUCT LOOKUP BY BARCODE
//   -------------------------------------------------------------*/
//   async lookupProductByBarcode(upc: string) {
//     const normalized = upc.padStart(12, '0');
//     try {
//       const res = await fetch(
//         `https://api.upcitemdb.com/prod/trial/lookup?upc=${normalized}`,
//       );
//       const json = await res.json();

//       const item = json?.items?.[0];
//       if (!item) throw new Error('No product data from UPCItemDB');

//       return {
//         name: item.title,
//         brand: item.brand,
//         image: item.images?.[0],
//         category: item.category,
//         source: 'upcitemdb',
//       };
//     } catch (err: any) {
//       console.warn('⚠️ UPCItemDB lookup failed:', err.message);
//       const fallback = await this.lookupFallback(normalized);
//       if (!fallback?.name || fallback.name === 'Unknown product') {
//         return await this.lookupFallbackWithAI(normalized);
//       }
//       return fallback;
//     }
//   }

//   /* ------------------------------------------------------------
//      🔁 RapidAPI or Dummy Fallback
//   -------------------------------------------------------------*/
//   async lookupFallback(upc: string) {
//     try {
//       const res = await fetch(`https://barcodes1.p.rapidapi.com/?upc=${upc}`, {
//         headers: {
//           'X-RapidAPI-Key': process.env.RAPIDAPI_KEY ?? '',
//           'X-RapidAPI-Host': 'barcodes1.p.rapidapi.com',
//         },
//       });

//       const json = await res.json();
//       const product = json?.product ?? {};

//       return {
//         name: product.title || json.title || 'Unknown product',
//         brand: product.brand || json.brand || 'Unknown brand',
//         image: product.image || json.image || null,
//         category: product.category || 'Uncategorized',
//         source: 'rapidapi',
//       };
//     } catch (err: any) {
//       console.error('❌ lookupFallback failed:', err.message);
//       return { name: null, brand: null, image: null, category: null };
//     }
//   }

//   /* ------------------------------------------------------------
//      🤖 AI Fallback Guess
//   -------------------------------------------------------------*/
//   async lookupFallbackWithAI(upc: string) {
//     try {
//       const prompt = `
//       The barcode number is: ${upc}.
//       Guess the product based on global manufacturer codes.
//       Return valid JSON only:
//       {"name":"Example Product","brand":"Brand","category":"Category"}
//       `;

//       const completion = await this.openai.chat.completions.create({
//         model: 'gpt-4o-mini',
//         messages: [{ role: 'user', content: prompt }],
//         max_tokens: 150,
//       });

//       let text = completion.choices?.[0]?.message?.content?.trim() || '{}';
//       text = text.replace(/```json|```/g, '').trim();

//       let parsed: any;
//       try {
//         parsed = JSON.parse(text);
//       } catch {
//         parsed = {
//           name:
//             text.replace(/["{}]/g, '').split(',')[0]?.trim() ||
//             'Unknown product',
//           brand: 'Unknown',
//           category: 'Misc',
//         };
//       }

//       return {
//         name: parsed.name || 'Unknown product',
//         brand: parsed.brand || 'Unknown',
//         category: parsed.category || 'Misc',
//         source: 'ai-fallback',
//       };
//     } catch (err: any) {
//       console.error('❌ AI fallback failed:', err.message);
//       return {
//         name: 'Unknown product',
//         brand: 'Unknown',
//         category: 'Uncategorized',
//         source: 'ai-fallback',
//       };
//     }
//   }
// }

// // END REPLACED CHAT WITH LINKS AND SEARCH NET

///////////////////////

// import { Injectable } from '@nestjs/common';
// import OpenAI from 'openai';
// import { ChatDto } from './dto/chat.dto';
// import { VertexService } from '../vertex/vertex.service'; // 🔹 ADDED
// import { ProductSearchService } from '../product-services/product-search.service';
// import { Pool } from 'pg';
// import { Express } from 'express';

// const pool = new Pool({
//   connectionString: process.env.DATABASE_URL,
//   ssl: { rejectUnauthorized: false },
// });

// import * as fs from 'fs';
// import * as path from 'path';
// import * as dotenv from 'dotenv';

// function loadOpenAISecrets(): {
//   apiKey?: string;
//   project?: string;
//   source: string;
// } {
//   const candidates = [
//     path.join(process.cwd(), '.env'),
//     path.join(process.cwd(), 'apps', 'backend-nest', '.env'),
//     path.join(__dirname, '..', '..', '.env'),
//   ];

//   for (const p of candidates) {
//     try {
//       if (fs.existsSync(p)) {
//         const parsed = dotenv.parse(fs.readFileSync(p));
//         const apiKey = parsed['OPENAI_API_KEY'];
//         const project = parsed['OPENAI_PROJECT_ID'];
//         if (apiKey) return { apiKey, project, source: p };
//       }
//     } catch {
//       // ignore
//     }
//   }

//   return {
//     apiKey: process.env.OPENAI_API_KEY,
//     project: process.env.OPENAI_PROJECT_ID,
//     source: 'process.env',
//   };
// }

// // 🧥 Basic capsule wardrobe templates
// const CAPSULES = {
//   Spring: [
//     { category: 'Outerwear', subcategory: 'Light Jacket', recommended: 2 },
//     { category: 'Tops', subcategory: 'Oxford Shirt', recommended: 3 },
//     { category: 'Bottoms', subcategory: 'Chinos', recommended: 2 },
//     { category: 'Shoes', subcategory: 'Loafers', recommended: 1 },
//     { category: 'Shoes', subcategory: 'Sneakers', recommended: 1 },
//   ],
//   Summer: [
//     { category: 'Tops', subcategory: 'Short Sleeve Shirt', recommended: 4 },
//     { category: 'Tops', subcategory: 'Polo Shirt', recommended: 2 },
//     { category: 'Bottoms', subcategory: 'Linen Trousers', recommended: 2 },
//     { category: 'Shoes', subcategory: 'Loafers', recommended: 1 },
//     { category: 'Shoes', subcategory: 'Sandals', recommended: 1 },
//   ],
//   Fall: [
//     { category: 'Outerwear', subcategory: 'Field Jacket', recommended: 1 },
//     { category: 'Outerwear', subcategory: 'Blazer', recommended: 1 },
//     { category: 'Tops', subcategory: 'Knit Sweater', recommended: 2 },
//     { category: 'Bottoms', subcategory: 'Wool Trousers', recommended: 2 },
//     { category: 'Shoes', subcategory: 'Chelsea Boots', recommended: 1 },
//   ],
//   Winter: [
//     { category: 'Outerwear', subcategory: 'Overcoat', recommended: 1 },
//     { category: 'Outerwear', subcategory: 'Heavy Parka', recommended: 1 },
//     { category: 'Tops', subcategory: 'Heavy Knit Sweater', recommended: 2 },
//     { category: 'Bottoms', subcategory: 'Wool Trousers', recommended: 2 },
//     { category: 'Shoes', subcategory: 'Boots', recommended: 2 },
//   ],
// };

// // 🗓️ Auto-detect season based on month
// function getCurrentSeason(): 'Spring' | 'Summer' | 'Fall' | 'Winter' {
//   const month = new Date().getMonth() + 1;
//   if ([3, 4, 5].includes(month)) return 'Spring';
//   if ([6, 7, 8].includes(month)) return 'Summer';
//   if ([9, 10, 11].includes(month)) return 'Fall';
//   return 'Winter';
// }

// // 🧠 Compare wardrobe to capsule and return simple forecast text
// function generateSeasonalForecast(wardrobe: any[] = []): string | undefined {
//   const season = getCurrentSeason();
//   const capsule = CAPSULES[season];
//   if (!capsule) return;

//   const missing: string[] = [];

//   capsule.forEach((item) => {
//     const owned = wardrobe.filter(
//       (w) =>
//         w.category?.toLowerCase() === item.category.toLowerCase() &&
//         w.subcategory?.toLowerCase() === item.subcategory.toLowerCase(),
//     ).length;

//     if (owned < item.recommended) {
//       const needed = item.recommended - owned;
//       missing.push(`${needed} × ${item.subcategory}`);
//     }
//   });

//   if (missing.length === 0) {
//     return `✅ Your ${season} capsule is complete — you're ready for the season.`;
//   }

//   return `🍂 ${season} is approaching — you're missing: ${missing.join(', ')}.`;
// }

// @Injectable()
// export class AiService {
//   private openai: OpenAI;
//   private useVertex: boolean;
//   private vertexService?: VertexService; // 🔹 optional instance
//   private productSearch: ProductSearchService; // ✅ add this

//   constructor(vertexService?: VertexService) {
//     const { apiKey, project, source } = loadOpenAISecrets();

//     const snippet = apiKey?.slice(0, 20) ?? '';
//     const len = apiKey?.length ?? 0;
//     console.log('🔑 OPENAI key source:', source);
//     console.log('🔑 OPENAI key snippet:', JSON.stringify(snippet));
//     console.log('🔑 OPENAI key length:', len);
//     console.log('📂 CWD:', process.cwd());

//     if (!apiKey) {
//       throw new Error('OPENAI_API_KEY not found in .env or environment.');
//     }
//     if (/^sk-?x{3,}/i.test(apiKey)) {
//       throw new Error(
//         'OPENAI_API_KEY appears masked (e.g., "sk-xxxxx..."). Read from the correct .env instead.',
//       );
//     }
//     if (!apiKey.startsWith('sk-')) {
//       throw new Error('OPENAI_API_KEY is malformed — must start with "sk-".');
//     }

//     this.openai = new OpenAI({ apiKey, project });

//     // 🔹 New: Vertex toggle
//     this.useVertex = process.env.USE_VERTEX === 'true';
//     if (this.useVertex) {
//       this.vertexService = vertexService;
//       console.log('🧠 Vertex/Gemini mode enabled for analyze/recreate');
//     }

//     this.productSearch = new ProductSearchService(); // NEW
//   }

//   //////ANALYZE LOOK

//   async analyze(imageUrl: string) {
//     console.log('🧠 [AI] analyze() called with', imageUrl);
//     if (!imageUrl) throw new Error('Missing imageUrl');

//     // 🔹 Try Vertex first if enabled
//     if (this.useVertex && this.vertexService) {
//       try {
//         const gcsUri = imageUrl.replace(
//           'https://storage.googleapis.com/',
//           'gs://',
//         );
//         const metadata = await this.vertexService.analyzeImage(gcsUri);
//         const tags = [
//           ...(metadata.tags || []),
//           ...(metadata.style_descriptors || []),
//           metadata.main_category,
//           metadata.subcategory,
//         ].filter(Boolean);
//         console.log('🧠 [Vertex] analyze() success:', tags);
//         return { tags };
//       } catch (err: any) {
//         console.warn(
//           '[Vertex] analyze() failed → fallback to OpenAI:',
//           err.message,
//         );
//       }
//     }

//     // 🔸 OpenAI fallback
//     try {
//       const completion = await this.openai.chat.completions.create({
//         model: 'gpt-4o-mini',
//         messages: [
//           {
//             role: 'system',
//             content:
//               'You are a professional fashion classifier. Return only JSON with a "tags" array describing the outfit’s style, color palette, and vibe.',
//           },
//           {
//             role: 'user',
//             content: [
//               { type: 'text', text: 'Describe this outfit as tags only:' },
//               { type: 'image_url', image_url: { url: imageUrl } },
//             ],
//           },
//         ],
//         response_format: { type: 'json_object' },
//       });

//       const raw = completion.choices[0]?.message?.content;
//       console.log('🧠 [AI] analyze() raw response:', raw);

//       if (!raw) throw new Error('Empty response from OpenAI');
//       const parsed = JSON.parse(raw || '{}');
//       return { tags: parsed.tags || [] };
//     } catch (err: any) {
//       console.error('❌ [AI] analyze() failed:', err.message);
//       return { tags: ['casual', 'modern', 'neutral'] };
//     }
//   }

//   /* ------------------------------------------------------------
//      🧩 Weighted Tag Enrichment + Trend Injection
//   -------------------------------------------------------------*/
//   private async enrichTags(tags: string[]): Promise<string[]> {
//     const weightMap: Record<string, number> = {
//       tailored: 3,
//       minimal: 3,
//       neutral: 3,
//       modern: 2,
//       vintage: 2,
//       classic: 2,
//       streetwear: 2,
//       oversized: 2,
//       slim: 2,
//       relaxed: 2,
//       casual: 1,
//       sporty: 1,
//     };

//     // 🧹 Normalize + de-dupe
//     const cleanTags = Array.from(
//       new Set(
//         tags
//           .map((t) => t.toLowerCase().trim())
//           .filter((t) => t && !['outfit', 'style', 'fashion'].includes(t)),
//       ),
//     );

//     // 🧠 Apply weights
//     const weighted = cleanTags
//       .map((t) => ({ tag: t, weight: weightMap[t] || 1 }))
//       .sort((a, b) => b.weight - a.weight);

//     // 🌍 Inject current trend tags
//     const trendTags = await this.fetchTrendTags();
//     const final = Array.from(
//       new Set([...weighted.map((w) => w.tag), ...trendTags.slice(0, 3)]),
//     );

//     console.log('🎯 [AI] Enriched tags →', final);
//     return final;
//   }

//   private async fetchTrendTags(): Promise<string[]> {
//     try {
//       const res = await fetch(
//         'https://trends.google.com/trends/hottrends/visualize/internal/data/en_us',
//       );
//       if (!res.ok) throw new Error(`HTTP ${res.status}`);
//       const json = await res.json().catch(() => []);
//       const trendWords = JSON.stringify(json).toLowerCase();
//       const matched = trendWords.match(
//         /(quiet luxury|monochrome|minimalism|maximalism|italian|tailoring|loafers|neutrals|linen|structured|preppy|flannel|earth tones|autumn layering)/gi,
//       );
//       if (matched?.length) return Array.from(new Set(matched));

//       // 🧭 If Google Trends returned empty, use local backup
//       return [
//         'quiet luxury',
//         'neutral tones',
//         'tailored fit',
//         'autumn layering',
//       ];
//     } catch (err: any) {
//       console.warn('⚠️ Trend fetch fallback triggered:', err.message);
//       return [
//         'quiet luxury',
//         'neutral tones',
//         'tailored fit',
//         'autumn layering',
//       ];
//     }
//   }

//   // RECREATE//////////////
//   async recreate(
//     user_id: string,
//     tags: string[],
//     image_url?: string,
//     user_gender?: string,
//   ) {
//     console.log(
//       '🧥 [AI] recreate() called for user',
//       user_id,
//       'with tags:',
//       tags,
//       'and gender:',
//       user_gender,
//     );

//     if (!user_id) throw new Error('Missing user_id');
//     if (!tags?.length) {
//       console.warn('⚠️ [AI] recreate() empty tags → using defaults.');
//       tags = ['modern', 'neutral', 'tailored'];
//     }

//     // ✅ Weighted + trend-injected tags
//     tags = await this.enrichTags(tags);

//     // 🧠 Fetch gender_presentation if missing
//     if (!user_gender) {
//       try {
//         const result = await pool.query(
//           'SELECT gender_presentation FROM users WHERE id = $1 LIMIT 1',
//           [user_id],
//         );
//         user_gender = result.rows[0]?.gender_presentation || 'neutral';
//       } catch {
//         user_gender = 'neutral';
//       }
//     }

//     // 🧩 Normalize gender
//     const normalizedGender =
//       user_gender?.toLowerCase().includes('female') ||
//       user_gender?.toLowerCase().includes('woman')
//         ? 'female'
//         : user_gender?.toLowerCase().includes('male') ||
//             user_gender?.toLowerCase().includes('man')
//           ? 'male'
//           : process.env.DEFAULT_GENDER || 'neutral';

//     // 🧠 Build stylist prompt (base)
//     let prompt = `
//         You are a world-class AI stylist for ${normalizedGender} fashion.
//         Create a cohesive outfit inspired by an uploaded look.

//         Client: ${user_id}
//         Image: ${image_url || 'N/A'}
//         Detected tags: ${tags.join(', ')}

//         Rules:
//         - Match fabric, color palette, and silhouette.
//         - Use ${normalizedGender}-appropriate pieces.
//         - Output only JSON:
//         {
//           "outfit": [
//             { "category": "Top", "item": "Grey Cotton Tee", "color": "gray" },
//             { "category": "Bottom", "item": "Navy Chinos", "color": "navy" },
//             { "category": "Outerwear", "item": "Beige Overshirt", "color": "beige" },
//             { "category": "Shoes", "item": "White Sneakers", "color": "white" }
//           ],
//           "style_note": "Describe how the look connects to the uploaded image."
//         }
//         `;

//     // 🔹 Pull soft profile context (optional)
//     let profileCtx = '';
//     try {
//       const res = await pool.query(
//         `SELECT favorite_colors, fit_preferences, preferred_brands, disliked_styles
//        FROM style_profiles WHERE user_id::text = $1 LIMIT 1`,
//         [user_id],
//       );
//       const prof = res.rows[0];
//       if (prof) {
//         profileCtx = `
//       # USER STYLE CONTEXT (soft influence)
//       • Preferred colors: ${(prof.favorite_colors || []).join(', ') || '—'}
//       • Fit preferences: ${(prof.fit_preferences || []).join(', ') || '—'}
//       • Favorite brands: ${(prof.preferred_brands || []).join(', ') || '—'}
//       • Disliked styles: ${prof.disliked_styles || '—'}
//       Do NOT override the image’s vibe — just bias tone/material choices if relevant.
//       `;
//       }
//     } catch {
//       /* silent fail */
//     }

//     // ✅ Final prompt (merge only if context exists)
//     // Inside recreate() or personalizedShop() final prompt:
//     const finalPrompt = `
// ${prompt}

// # HARD RULES
// - ALWAYS output a full outfit of at least 4–6 distinct pieces.
// - Include a Top, Bottom, Outerwear (if seasonally appropriate), Shoes, and optionally 1–2 Accessories.
// - NEVER omit items because they already exist in the user’s wardrobe.
// - Each piece should have its own JSON object, even if similar to a wardrobe item.
// - Always include color and fit for every item.
// `;

//     // 🧠 Generate outfit via Vertex or OpenAI
//     let parsed: any;
//     if (this.useVertex && this.vertexService) {
//       try {
//         const result =
//           await this.vertexService.generateReasonedOutfit(finalPrompt);
//         let text = result?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
//         text = text
//           .replace(/^```json\s*/i, '')
//           .replace(/```$/, '')
//           .trim();
//         parsed = JSON.parse(text);
//         console.log('🧠 [Vertex] recreate() success');
//       } catch (err: any) {
//         console.warn('[Vertex] recreate() failed → fallback', err.message);
//       }
//     }

//     if (!parsed) {
//       const completion = await this.openai.chat.completions.create({
//         model: 'gpt-4o-mini',
//         temperature: 0.7,
//         messages: [{ role: 'user', content: finalPrompt }],
//         response_format: { type: 'json_object' },
//       });

//       const raw = completion.choices[0]?.message?.content || '{}';
//       try {
//         parsed = JSON.parse(raw);
//       } catch {
//         parsed = {};
//       }
//     }

//     const outfit = Array.isArray(parsed?.outfit) ? parsed.outfit : [];
//     const style_note =
//       parsed?.style_note || 'Modern outfit inspired by the uploaded look.';

//     // 🛍️ Enrich each item with live products
//     const enriched = await Promise.all(
//       outfit.map(async (o: any) => {
//         const query =
//           `${normalizedGender} ${o.item || o.category || ''} ${o.color || ''}`.trim();
//         let products = await this.productSearch.search(query);
//         let top = products[0];

//         if (!top?.image || top.image.includes('No_image')) {
//           const serp = await this.productSearch.searchSerpApi(query);
//           if (serp?.[0]) top = { ...serp[0], source: 'SerpAPI' };
//         }

//         const materialHint =
//           query.match(/(wool|cotton|linen|leather|denim|polyester)/i)?.[0] ||
//           null;
//         const seasonalityHint =
//           query.match(/(summer|winter|fall|spring)/i)?.[0] ||
//           getCurrentSeason();
//         const fitHint =
//           query.match(/(slim|regular|relaxed|oversized|tailored)/i)?.[0] ||
//           'regular';

//         return {
//           category: o.category,
//           item: o.item,
//           color: o.color,
//           brand: top?.brand || 'Unknown',
//           price: top?.price || '—',
//           image:
//             top?.image && top.image.startsWith('http')
//               ? top.image
//               : 'https://upload.wikimedia.org/wikipedia/commons/a/ac/No_image_available.svg',
//           shopUrl:
//             top?.shopUrl ||
//             `https://www.google.com/search?q=${encodeURIComponent(query)}&tbm=shop`,
//           source: top?.source || 'ASOS / Fallback',
//           material: materialHint,
//           seasonality: seasonalityHint,
//           fit: fitHint,
//         };
//       }),
//     );

//     return { user_id, outfit: enriched, style_note };
//   }

//   // 🧩 Ensure every product object includes a usable image URL
//   private fixProductImages(products: any[] = []): any[] {
//     return products.map((prod) => ({
//       ...prod,
//       image:
//         prod.image ||
//         prod.image_url ||
//         prod.thumbnail ||
//         prod.serpapi_thumbnail || // ✅ added
//         prod.img ||
//         prod.picture ||
//         prod.thumbnail_url ||
//         'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg',
//     }));
//   }

//   // 👔 PERSONALIZED SHOP — image + wardrobe + preferences
//   async personalizedShop(
//     user_id: string,
//     image_url: string,
//     user_gender?: string,
//   ) {
//     if (!user_id || !image_url) throw new Error('Missing user_id or image_url');

//     /** -----------------------------------------------------------
//      * 🧠 buildProfileConstraints(profile)
//      * Converts full style_profiles record into explicit hard rules
//      * ---------------------------------------------------------- */
//     function buildProfileConstraints(profile: any): string {
//       if (!profile) return '';

//       const fit = Array.isArray(profile.fit_preferences)
//         ? profile.fit_preferences.join(', ')
//         : profile.fit_preferences;

//       const colors = Array.isArray(profile.favorite_colors)
//         ? profile.favorite_colors.join(', ')
//         : profile.favorite_colors;

//       const brands = Array.isArray(profile.preferred_brands)
//         ? profile.preferred_brands.join(', ')
//         : profile.preferred_brands;

//       const styles = [
//         ...(profile.style_keywords || []),
//         ...(profile.style_preferences || []),
//       ]
//         .filter(Boolean)
//         .join(', ');

//       const dislikes =
//         typeof profile.disliked_styles === 'string'
//           ? profile.disliked_styles
//           : (profile.disliked_styles || []).join(', ');

//       const climate = profile.climate || 'Temperate';
//       const goals = profile.goals || '';

//       // 🔹 Inject explicit hard “only color” or “except color” rule for the model itself
//       let colorRule = '';
//       if (profile.disliked_styles?.match(/only\s+(\w+)/i)) {
//         const onlyColor = profile.disliked_styles.match(/only\s+(\w+)/i)[1];
//         colorRule = `• Use ONLY ${onlyColor} items — all other colors are forbidden.`;
//       } else if (profile.disliked_styles?.match(/except\s+(\w+)/i)) {
//         const exceptColor = profile.disliked_styles.match(/except\s+(\w+)/i)[1];
//         colorRule = `• Exclude every color except ${exceptColor}.`;
//       }

//       // 🔹 Explicitly enforce fit preferences
//       let fitRule = '';
//       if (profile.fit_preferences?.length) {
//         fitRule = `• Allow ONLY these fits: ${profile.fit_preferences.join(
//           ', ',
//         )}; exclude all others.`;
//       }

//       return `
// # USER PROFILE CONSTRAINTS (Hard Rules)

// ${fitRule}
// ${colorRule}

// • Fit: ${fit || 'Regular fit'} — outfit items must match this silhouette; exclude all opposing fits.
// • Climate: ${climate} — use materials and layers appropriate to this temperature zone.
// • Preferred brands: ${brands || '—'} — bias all product searches toward these or comparable aesthetics.
// • Favorite colors: ${colors || '—'} — bias color palette to these tones; avoid disliked colors.
// • Disliked styles: ${dislikes || '—'} — exclude these aesthetics entirely.
// • Style & vibe keywords: ${styles || '—'} — reflect these qualities in overall tone and accessories.
// • Goals: ${goals}
// • Body & proportions: ${profile.body_type || '—'}, ${
//         profile.proportions || '—'
//       } — ensure silhouette and layering suit these proportions.
// • Skin tone / hair / eyes: ${profile.skin_tone || '—'}, ${
//         profile.hair_color || '—'
//       }, ${profile.eye_color || '—'} — choose tones that complement.
// `;
//     }

//     // 1) Analyze uploaded image
//     const analysis = await this.analyze(image_url);
//     const tags = analysis?.tags || [];

//     //   const { rows: wardrobe } = await pool.query(
//     //     `SELECT name, main_category AS category, subcategory, color, material
//     //  FROM wardrobe_items
//     //  WHERE user_id::text = $1
//     //  ORDER BY updated_at DESC
//     //  LIMIT 50`,
//     //     [user_id],
//     //   );

//     // 🚫 Skip wardrobe entirely for personalized mode
//     const wardrobe: any[] = [];

//     const prefRes = await pool.query(
//       `SELECT gender_presentation
//      FROM users
//      WHERE id = $1
//      LIMIT 1`,
//       [user_id],
//     );
//     const profile = prefRes.rows[0] || {};
//     const gender = user_gender || profile.gender_presentation || 'neutral';
//     // 2️⃣ Fetch user style profile (full data used for personalization)
//     const styleProfileRes = await pool.query(
//       `
//   SELECT
//     body_type,
//     skin_tone,
//     undertone,
//     climate,
//     favorite_colors,
//     disliked_styles,
//     style_keywords,
//     preferred_brands,
//     goals,
//     proportions,
//     hair_color,
//     eye_color,
//     height,
//     waist,
//     fit_preferences,
//     style_preferences
//   FROM style_profiles
//   WHERE user_id::text = $1
//   LIMIT 1
// `,
//       [user_id],
//     );

//     const styleProfile = styleProfileRes.rows[0] || {};

//     // 🔹 Build user filter preferences
//     const { preferFit, bannedWords } = buildUserFilter(styleProfile);

//     /* ------------------------------------------------------------
//    🎛️ VISUAL + STYLE FILTERING HELPERS
// -------------------------------------------------------------*/
//     const FIT_KEYWORDS = {
//       skinny: [/skinny/i, /super[- ]skinny/i, /spray[- ]on/i],
//       slim: [/slim/i],
//       tailored: [/tailored/i, /tapered/i],
//       relaxed: [/relaxed/i, /loose/i, /baggy/i, /wide[- ]leg/i],
//       oversized: [/oversized/i, /boxy/i],
//     };

//     function buildUserFilter(profile: any) {
//       const fitPrefs = (profile.fit_preferences || []).map((x: string) =>
//         x.toLowerCase(),
//       );
//       const disliked = (profile.disliked_styles || '')
//         .toLowerCase()
//         .split(/[,\s]+/)
//         .filter(Boolean);
//       const favColors = (profile.favorite_colors || []).map((x: string) =>
//         x.toLowerCase(),
//       );

//       const preferFit =
//         fitPrefs.find((f) => /(relaxed|loose|baggy|oversized|boxy)/.test(f)) ||
//         fitPrefs.find((f) => /(regular|tailored)/.test(f)) ||
//         fitPrefs[0] ||
//         null;

//       const banFits: string[] = [];
//       if (preferFit?.match(/relaxed|loose|baggy|oversized|boxy/))
//         banFits.push('skinny', 'slim');
//       else if (preferFit?.match(/skinny|slim/))
//         banFits.push('relaxed', 'baggy', 'oversized');

//       const bannedWords = [
//         ...disliked,
//         ...banFits,
//         ...(!favColors.includes('green') ? ['green'] : []),
//       ]
//         .filter(Boolean)
//         .map((x) => new RegExp(x, 'i'));

//       return { preferFit, bannedWords };
//     }

//     function enforceProfileFilters(
//       products: any[] = [],
//       preferFit?: string | null,
//       bannedWords: RegExp[] = [],
//     ) {
//       if (!products.length) return products;

//       return products
//         .filter((p) => {
//           const hay = `${p.title || ''} ${p.name || ''} ${p.description || ''}`;
//           return !bannedWords.some((rx) => rx.test(hay));
//         })
//         .sort((a, b) => {
//           if (!preferFit) return 0;
//           const aHit = FIT_KEYWORDS[preferFit]?.some((rx) =>
//             rx.test(`${a.title} ${a.name}`),
//           )
//             ? 1
//             : 0;
//           const bHit = FIT_KEYWORDS[preferFit]?.some((rx) =>
//             rx.test(`${b.title} ${b.name}`),
//           )
//             ? 1
//             : 0;
//           return bHit - aHit; // boost preferred fits
//         });
//     }

//     // 3) Ask model to split into "owned" vs "missing"

//     const climateNote = styleProfile.climate
//       ? `The user's climate is ${styleProfile.climate}.
//     If it is cold (like Polar or Cold), emphasize insulated materials, coats, layers, scarves, gloves, and boots.
//     If it is hot (like Tropical or Desert), emphasize breathable, lightweight fabrics and open footwear.`
//       : '';

//     // 🔒 Enforced personalization hierarchy
//     const rules = `
//     # PERSONALIZATION ENFORCEMENT
//     Follow these user preferences as *absolute constraints*, not suggestions.
//     `;

//     const profileConstraints = buildProfileConstraints(styleProfile);

//     const prompt = `
// You are a world-class personal stylist generating a personalized recreation of an uploaded look.
// ${rules}
// ${profileConstraints}

// # IMAGE INSPIRATION
// • Use the uploaded image only as an aesthetic anchor (color story, silhouette, or texture).
// • Do NOT reference or reuse the user's wardrobe.
// • Respect all style profile constraints exactly.
// • Maintain the same mood and spirit as the uploaded image, not a literal copy.
// • Preserve one clear visual motif from the source image (e.g., plaid pattern or color tone) unless climate prohibits.

// # OUTPUT RULES
// - ALWAYS output a complete outfit with distinct Top, Bottom, Shoes, and (if seasonally appropriate) Outerwear and Accessories.
// - Each piece must include category, item, color, and fit.

// Return ONLY valid JSON:
// {
//   "recreated_outfit": [
//     { "source":"purchase", "category":"Top", "item":"...", "color":"...", "fit":"..." }
//   ],
//   "suggested_purchases": [
//     { "category":"...", "item":"...", "color":"...", "material":"...", "brand":"...", "shopUrl":"..." }
//   ],
//   "style_note": "Explain how this respects the user's climate, fit, and taste."
// }

// User gender: ${gender}
// Detected tags: ${tags.join(', ')}
// Weighted tags: ${tags.map((t) => `high priority: ${t}`).join(', ')}
// User style profile: ${JSON.stringify(styleProfile, null, 2)}
// ${climateNote}
// `;

//     console.log('🧥 [personalizedShop] profile:', profile);
//     console.log('🧥 [personalizedShop] gender:', gender);
//     console.log('🧥 [personalizedShop] styleProfile:', styleProfile);
//     console.log('🧠 [personalizedShop] Prompt preview:', prompt.slice(0, 800));

//     // 🧠 DEBUG START — prompt verification
//     console.log('─────────────── PROMPT SENT TO MODEL ───────────────');
//     console.log(prompt);
//     console.log('─────────────── END PROMPT ───────────────');

//     const completion = await this.openai.chat.completions.create({
//       model: 'gpt-4o-mini',
//       temperature: 0.7,
//       messages: [{ role: 'user', content: prompt }],
//       response_format: { type: 'json_object' },
//     });

//     // 🧠 DEBUG END — raw model output
//     console.log('─────────────── RAW MODEL RESPONSE ───────────────');
//     console.log(completion.choices[0]?.message?.content);
//     console.log('─────────────── END RESPONSE ───────────────');

//     let parsed: any = {};
//     try {
//       parsed = JSON.parse(completion.choices[0]?.message?.content || '{}');

//       // 🧩 SAFETY GUARD — ensure we keep valid recreated_outfit
//       try {
//         const parsedKeys = Object.keys(parsed);
//         console.log('✅ [personalizedShop] Parsed JSON keys:', parsedKeys);

//         // If model used "outfit" instead of "recreated_outfit", normalize it
//         if (!parsed.recreated_outfit && parsed.outfit) {
//           parsed.recreated_outfit = parsed.outfit;
//           console.log('✅ [personalizedShop] Mapped outfit → recreated_outfit');
//         }

//         // Double-check array validity before fallback clears it
//         if (parsed.recreated_outfit && parsed.recreated_outfit.length > 0) {
//           console.log(
//             '✅ [personalizedShop] Using recreated_outfit from model',
//           );
//         } else {
//           console.warn(
//             '⚠️ [personalizedShop] No recreated_outfit found — fallback may trigger',
//           );
//         }
//       } catch (err) {
//         console.error(
//           '❌ [personalizedShop] JSON structure guard failed:',
//           err,
//         );
//       }

//       // ✅ Final filter fix — keep wardrobe items but still respect banned fits/styles
//       if (parsed?.recreated_outfit?.length) {
//         parsed.recreated_outfit = parsed.recreated_outfit.filter((o: any) => {
//           if (!o) return false;
//           const text =
//             `${o.item} ${o.category} ${o.color} ${o.fit}`.toLowerCase();
//           if (!text.trim() || text.includes('undefined')) return false;
//           // ✅ Always keep wardrobe items regardless of style bans
//           if (o.source === 'wardrobe') return true;

//           const fitBan = preferFit?.match(/relaxed|oversized|boxy|loose/)
//             ? ['skinny']
//             : preferFit?.match(/skinny|slim|tailored/)
//               ? ['relaxed', 'baggy', 'oversized']
//               : [];

//           const styleBan =
//             (styleProfile.disliked_styles || '')
//               .toLowerCase()
//               .split(/[,\s]+/)
//               .filter(Boolean) || [];

//           const banned = [...fitBan, ...styleBan];
//           return !banned.some((b) => text.includes(b));
//         });

//         console.log(
//           '✅ [personalizedShop] Final filtered outfit →',
//           parsed.recreated_outfit,
//         );
//       }

//       console.log(
//         '💎 [personalizedShop] Parsed recreated outfit sample:',
//         parsed?.recreated_outfit?.slice(0, 2),
//       );
//       console.log(
//         '💎 [personalizedShop] Parsed suggested purchases sample:',
//         parsed?.suggested_purchases?.slice(0, 2),
//       );

//       // 🧩 Merge recreated_outfit into suggested_purchases for display
//       if (
//         Array.isArray(parsed?.recreated_outfit) &&
//         parsed.recreated_outfit.length
//       ) {
//         parsed.suggested_purchases = [
//           ...(parsed.suggested_purchases || []),
//           ...parsed.recreated_outfit.map((o: any) => ({
//             ...o,
//             brand: o.brand || '—',
//             previewImage: o.previewImage || o.image || o.image_url || null,
//             source: 'purchase',
//           })),
//         ];
//         console.log(
//           '🧩 [personalizedShop] merged recreated_outfit → suggested_purchases',
//         );
//       }

//       // 🖼️ Ensure every recreated outfit item has a visible preview image
//       if (Array.isArray(parsed?.recreated_outfit)) {
//         parsed.recreated_outfit = parsed.recreated_outfit.map((item: any) => {
//           if (!item.previewImage && item.source === 'wardrobe') {
//             item.previewImage =
//               item.image_url ||
//               item.wardrobe_image ||
//               'https://upload.wikimedia.org/wikipedia/commons/a/ac/No_image_available.svg';
//           }
//           return item;
//         });
//       }

//       // 🎨 Enforce "only <color>" rule from disliked_styles (e.g. "I dislike all colors except pink")
//       // 🎨 Optional color-only enforcement — only if explicit "ONLY <color>" flag exists
//       if (styleProfile?.disliked_styles?.toLowerCase().includes('only')) {
//         const match = styleProfile.disliked_styles.match(/only\s+(\w+)/i);
//         if (match) {
//           const onlyColor = match[1].toLowerCase();
//           const filterColor = (arr: any[]) =>
//             arr.filter((x) =>
//               (x.color || '').toLowerCase().includes(onlyColor),
//             );

//           if (Array.isArray(parsed?.recreated_outfit))
//             parsed.recreated_outfit = filterColor(parsed.recreated_outfit);
//           if (Array.isArray(parsed?.suggested_purchases))
//             parsed.suggested_purchases = filterColor(
//               parsed.suggested_purchases,
//             );

//           console.log(
//             `[personalizedShop] 🎨 Enforcing ONLY-color rule: ${onlyColor}`,
//           );
//         }
//       }
//     } catch {
//       parsed = {};
//     }

//     const purchases = Array.isArray(parsed?.suggested_purchases)
//       ? parsed.suggested_purchases
//       : [];

//     if (parsed?.recreated_outfit?.some((i: any) => i.source === 'wardrobe')) {
//       console.log('🧥 [personalizedShop] ✅ Model reused wardrobe pieces.');
//     } else {
//       console.warn(
//         '🧥 [personalizedShop] ⚠️ Model did NOT reuse wardrobe — fallback to generic recreation.',
//       );
//     }

//     // 🚫 Enforce profile bans in returned outfit
//     const banned = [
//       ...(styleProfile.disliked_styles?.toLowerCase().split(/[,\s]+/) || []),
//       ...(preferFit?.match(/relaxed|oversized|boxy|loose/)
//         ? ['skinny', 'slim']
//         : []),
//       ...(preferFit?.match(/skinny|slim/)
//         ? ['relaxed', 'oversized', 'baggy']
//         : []),
//     ].filter(Boolean);

//     if (parsed?.recreated_outfit?.length) {
//       // ✅ Keep *all* wardrobe and purchase items — only filter garbage entries
//       parsed.recreated_outfit = parsed.recreated_outfit.filter((o: any) => {
//         if (!o || !o.item) return false;
//         const text =
//           `${o.item} ${o.category} ${o.color} ${o.fit}`.toLowerCase();
//         return text.trim().length > 0 && !text.includes('undefined');
//       });

//       // 🧱 Guarantee full outfit completeness (Top, Bottom, Shoes, Optional Outerwear/Accessory)
//       const categories = parsed.recreated_outfit.map((o: any) =>
//         o.category?.toLowerCase(),
//       );
//       const missing: any[] = [];

//       if (!categories.includes('top'))
//         missing.push({
//           source: 'purchase',
//           category: 'Top',
//           item: 'White Oxford Shirt',
//           color: 'White',
//           fit: 'Slim Fit',
//         });
//       if (!categories.includes('bottoms'))
//         missing.push({
//           source: 'purchase',
//           category: 'Bottoms',
//           item: 'Beige Chinos',
//           color: 'Beige',
//           fit: 'Slim Fit',
//         });
//       if (!categories.includes('shoes'))
//         missing.push({
//           source: 'purchase',
//           category: 'Shoes',
//           item: 'White Leather Sneakers',
//           color: 'White',
//           fit: 'Slim Fit',
//         });

//       parsed.recreated_outfit.push(...missing);

//       console.log(
//         '✅ [personalizedShop] Final full outfit →',
//         parsed.recreated_outfit,
//       );
//     }

//     // 🧩 Centralized enforcement for personalizedShop only
//     function applyProfileFilters(products: any[], profile: any) {
//       if (!Array.isArray(products) || !products.length) return [];

//       const favColors = (profile.favorite_colors || []).map((x: string) =>
//         x.toLowerCase(),
//       );
//       const prefBrands = (profile.preferred_brands || []).map((x: string) =>
//         x.toLowerCase(),
//       );
//       const fitPrefs = (profile.fit_preferences || []).map((x: string) =>
//         x.toLowerCase(),
//       );
//       const dislikes = (profile.disliked_styles || '')
//         .toLowerCase()
//         .split(/[,\s]+/);
//       const climate = (profile.climate || '').toLowerCase();

//       const isCold = /(polar|cold|arctic|tundra|winter)/.test(climate);
//       const isHot = /(tropical|desert|hot|humid|summer)/.test(climate);

//       // 🩷 detect "only" or "except" color rule from disliked_styles
//       let onlyColor: string | null = null;
//       let exceptColor: string | null = null;

//       if (profile.disliked_styles?.match(/only\s+(\w+)/i)) {
//         onlyColor = profile.disliked_styles
//           .match(/only\s+(\w+)/i)[1]
//           .toLowerCase();
//       } else if (profile.disliked_styles?.match(/except\s+(\w+)/i)) {
//         exceptColor = profile.disliked_styles
//           .match(/except\s+(\w+)/i)[1]
//           .toLowerCase();
//       }

//       return products
//         .filter((p) => {
//           const t = `${p.name ?? ''} ${p.title ?? ''} ${p.brand ?? ''} ${
//             p.description ?? ''
//           } ${p.color ?? ''} ${p.fit ?? ''}`.toLowerCase();

//           // 🚫 Filter out disliked words/styles
//           if (dislikes.some((d) => d && t.includes(d))) return false;

//           // 🎨 HARD color enforcement from DB rules
//           if (onlyColor) {
//             // Only allow if text or color includes the specified color
//             if (
//               !t.includes(onlyColor) &&
//               !p.color?.toLowerCase().includes(onlyColor)
//             )
//               return false;
//           } else if (exceptColor) {
//             // Exclude everything not matching that color
//             if (
//               !t.includes(exceptColor) &&
//               !p.color?.toLowerCase().includes(exceptColor)
//             )
//               return false;
//           } else {
//             // Normal favorite color bias if no hard rule
//             if (favColors.length && !favColors.some((c) => t.includes(c)))
//               return false;
//           }

//           // 👕 Fit preferences
//           if (fitPrefs.length && !fitPrefs.some((f) => t.includes(f)))
//             return false;

//           // 🌡️ Climate-based filtering
//           if (isCold && /(tank|shorts|sandal)/.test(t)) return false;
//           if (isHot && /(wool|parka|coat|boot|knit)/.test(t)) return false;

//           return true;
//         })
//         .sort((a, b) => {
//           const score = (x: any) => {
//             const txt =
//               `${x.name} ${x.title} ${x.brand} ${x.color} ${x.fit}`.toLowerCase();
//             let s = 0;
//             if (onlyColor && txt.includes(onlyColor)) s += 4;
//             if (exceptColor && txt.includes(exceptColor)) s += 4;
//             if (favColors.some((c) => txt.includes(c))) s += 2;
//             if (prefBrands.some((b) => txt.includes(b))) s += 2;
//             if (fitPrefs.some((f) => txt.includes(f))) s += 1;
//             return s;
//           };
//           return score(b) - score(a);
//         });
//     }

//     // 4️⃣ Attach live shop links to the "missing" items — now honoring user taste
//     let enrichedPurchases = await Promise.all(
//       purchases.map(async (p: any) => {
//         // 🧠 Gender-locked prefix
//         const genderPrefix =
//           gender?.toLowerCase().includes('female') ||
//           gender?.toLowerCase().includes('woman')
//             ? 'women female womens ladies'
//             : 'men male mens masculine -women -womens -female -girls -ladies';

//         // Base query with gender lock
//         let q = [
//           genderPrefix,
//           p.item || p.category || '',
//           p.color || '',
//           p.material || '',
//         ]
//           .filter(Boolean)
//           .join(' ')
//           .trim();

//         // 🔹 Inject personalization bias terms
//         const brandTerms = (styleProfile.preferred_brands || [])
//           .slice(0, 3)
//           .join(' ');
//         const colorTerms = (styleProfile.favorite_colors || [])
//           .slice(0, 2)
//           .join(' ');
//         const fitTerms = Array.isArray(styleProfile.fit_preferences)
//           ? styleProfile.fit_preferences.join(' ')
//           : styleProfile.fit_preferences || '';

//         // 🎨 “Only color” rule (e.g. “I dislike all colors except pink”)
//         const colorMatch =
//           styleProfile.disliked_styles?.match(/except\s+(\w+)/i);
//         if (colorMatch) {
//           const onlyColor = colorMatch[1].toLowerCase();
//           q += ` ${onlyColor}`;
//         }

//         // Combine into final query with brand + color + fit bias
//         q = [q, brandTerms, colorTerms, fitTerms].filter(Boolean).join(' ');

//         // 🔒 Ensure all queries exclude female results explicitly
//         if (
//           !/-(women|female|ladies|girls)/i.test(q) &&
//           /\bmen\b|\bmale\b/i.test(q)
//         ) {
//           q += ' -women -womens -female -girls -ladies';
//         }

//         // Combine into final query with brand + color + fit bias
//         q = [q, brandTerms, colorTerms, fitTerms].filter(Boolean).join(' ');

//         // 🔒 Ensure all queries exclude female results explicitly
//         if (
//           !/-(women|female|ladies|girls)/i.test(q) &&
//           /\bmen\b|\bmale\b/i.test(q)
//         ) {
//           q += ' -women -womens -female -girls -ladies';
//         }

//         // 🧠 Gender-aware product search
//         let products = await this.productSearch.search(
//           q,
//           gender?.toLowerCase() === 'female'
//             ? 'female'
//             : gender?.toLowerCase() === 'male'
//               ? 'male'
//               : 'unisex',
//         );

//         // 🚫 Filter out any accidental female/unisex results
//         products = products.filter(
//           (prod) =>
//             !/women|female|womens|ladies|girls/i.test(
//               `${prod.name ?? ''} ${prod.brand ?? ''} ${prod.title ?? ''}`,
//             ),
//         );

//         // 🩷 Hard visual color filter — ensures displayed products actually match the enforced color rule
//         if (
//           styleProfile?.disliked_styles?.match(/only\s+(\w+)/i) ||
//           styleProfile?.disliked_styles?.match(/except\s+(\w+)/i)
//         ) {
//           const match =
//             styleProfile.disliked_styles.match(/only\s+(\w+)/i) ||
//             styleProfile.disliked_styles.match(/except\s+(\w+)/i);
//           const enforcedColor = match?.[1]?.toLowerCase();
//           if (enforcedColor) {
//             products = products.filter((p) => {
//               const text =
//                 `${p.name ?? ''} ${p.title ?? ''} ${p.color ?? ''}`.toLowerCase();
//               return text.includes(enforcedColor);
//             });
//           }
//         }

//         return {
//           ...p,
//           query: q,
//           products: applyProfileFilters(products, styleProfile),
//         };
//       }),
//     );

//     // 5️⃣ Fallback enrichment if AI returned nothing or products failed
//     if (!enrichedPurchases.length) {
//       console.warn(
//         '⚠️ [personalizedShop] Empty suggested_purchases → fallback.',
//       );

//       const tagSeed = tags.slice(0, 6).join(' ');
//       const season = getCurrentSeason();

//       // 🧠 Gender prefix for fallback with hard lock
//       const genderPrefix =
//         gender?.toLowerCase().includes('female') ||
//         gender?.toLowerCase().includes('woman')
//           ? 'women female womens ladies'
//           : 'men male mens masculine -women -womens -female -girls -ladies';

//       // 🧠 Enrich fallback with style taste as well
//       const brandTerms = (styleProfile.preferred_brands || [])
//         .slice(0, 3)
//         .join(' ');
//       const colorTerms = (styleProfile.favorite_colors || [])
//         .slice(0, 2)
//         .join(' ');
//       const fitTerms = Array.isArray(styleProfile.fit_preferences)
//         ? styleProfile.fit_preferences.join(' ')
//         : styleProfile.fit_preferences || '';

//       const fallbackQuery = `${genderPrefix} ${tagSeed} ${season} fashion ${brandTerms} ${colorTerms} ${fitTerms}`;
//       console.log('🧩 [personalizedShop] fallbackQuery →', fallbackQuery);

//       const products = await this.productSearch.search(
//         fallbackQuery,
//         gender?.toLowerCase() === 'female'
//           ? 'female'
//           : gender?.toLowerCase() === 'male'
//             ? 'male'
//             : 'unisex',
//       );

//       // 🚫 Filter out any accidental female/unisex results
//       const maleProducts = products.filter(
//         (prod) =>
//           !/women|female|womens|ladies|girls/i.test(
//             `${prod.name ?? ''} ${prod.brand ?? ''} ${prod.title ?? ''}`,
//           ),
//       );

//       enrichedPurchases = [
//         {
//           category: 'General',
//           item: 'Curated Outfit Add-Ons',
//           color: 'Mixed',
//           material: null,
//           products: applyProfileFilters(maleProducts.slice(0, 8), styleProfile),
//           query: fallbackQuery,
//           source: 'fallback',
//         },
//       ];
//     }

//     // 🎨 Enforce color-only rule on fallback products too
//     if (styleProfile?.disliked_styles) {
//       const match = styleProfile.disliked_styles.match(/except\s+(\w+)/i);
//       if (match) {
//         const onlyColor = match[1].toLowerCase();
//         enrichedPurchases = enrichedPurchases.map((p) => ({
//           ...p,
//           products: (p.products || []).filter((prod) =>
//             (prod.color || '').toLowerCase().includes(onlyColor),
//           ),
//         }));
//         console.log(
//           `[personalizedShop] 🎨 Enforced fallback color-only rule: ${onlyColor}`,
//         );
//       }
//     }

//     const cleanPurchases = enrichedPurchases.map((p) => ({
//       ...p,
//       products: this.fixProductImages(
//         enforceProfileFilters(p.products || [], preferFit, bannedWords),
//       ),
//     }));

//     // 🎨 FINAL VISUAL CONSISTENCY NORMALIZATION
//     const normalizedPurchases = await Promise.all(
//       enrichedPurchases.map(async (p) => {
//         const validProduct =
//           (p.products || []).find(
//             (x) =>
//               (x.image ||
//                 x.image_url ||
//                 x.thumbnail ||
//                 x.serpapi_thumbnail ||
//                 x.thumbnail_url ||
//                 x.img ||
//                 x.result?.thumbnail ||
//                 x.result?.serpapi_thumbnail) &&
//               /^https?:\/\//.test(
//                 x.image ||
//                   x.image_url ||
//                   x.thumbnail ||
//                   x.serpapi_thumbnail ||
//                   x.thumbnail_url ||
//                   x.img ||
//                   x.result?.thumbnail ||
//                   x.result?.serpapi_thumbnail ||
//                   '',
//               ) &&
//               !/no[_-]?image/i.test(
//                 x.image ||
//                   x.image_url ||
//                   x.thumbnail ||
//                   x.serpapi_thumbnail ||
//                   x.thumbnail_url ||
//                   x.img ||
//                   '',
//               ),
//           ) || p.products?.[0];

//         let previewImage =
//           validProduct?.image ||
//           validProduct?.image_url ||
//           validProduct?.thumbnail ||
//           validProduct?.serpapi_thumbnail ||
//           validProduct?.thumbnail_url ||
//           validProduct?.img ||
//           validProduct?.product_thumbnail ||
//           validProduct?.result?.thumbnail ||
//           validProduct?.result?.serpapi_thumbnail ||
//           null;

//         // 🎯 Gender-aware image guard
//         const userGender = (gender || '').toLowerCase();

//         if (previewImage) {
//           const url = previewImage.toLowerCase();

//           // 🧍‍♂️ If male → block clearly female-coded URLs
//           if (
//             userGender.includes('male') &&
//             /(women|woman|female|ladies|girls|womenswear|femme|skims|shein|fashionnova|princesspolly|revolve|anthropologie)/i.test(
//               url,
//             )
//           ) {
//             previewImage =
//               'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg';
//           }

//           // 🧍‍♀️ If female → block clearly male-coded URLs
//           else if (
//             userGender.includes('female') &&
//             /(men|man|male|menswear|masculine)/i.test(url)
//           ) {
//             previewImage =
//               'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg';
//           }

//           // 🧍 Unisex → allow all images
//         }

//         // 🧠 If still missing, do a quick SerpAPI lookup and cache
//         if (!previewImage && p.query) {
//           const results = await this.productSearch.searchSerpApi(p.query);
//           const r = results?.[0];
//           previewImage =
//             r?.image ||
//             r?.image_url ||
//             r?.thumbnail ||
//             r?.serpapi_thumbnail ||
//             r?.thumbnail_url ||
//             r?.result?.thumbnail ||
//             r?.result?.serpapi_thumbnail ||
//             null;

//           // 🎯 Apply same gender guard to SerpAPI result
//           if (previewImage) {
//             const url = previewImage.toLowerCase();

//             if (
//               userGender.includes('male') &&
//               /(women|woman|female|ladies|girls|womenswear|femme|skims|shein|fashionnova|princesspolly|revolve|anthropologie)/i.test(
//                 url,
//               )
//             ) {
//               previewImage =
//                 'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg';
//             } else if (
//               userGender.includes('female') &&
//               /(men|man|male|menswear|masculine)/i.test(url)
//             ) {
//               previewImage =
//                 'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg';
//             }
//           }
//         }

//         return {
//           ...p,
//           previewImage:
//             previewImage ||
//             'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg',
//           previewBrand: validProduct?.brand || p.brand || 'Unknown',
//           previewPrice: validProduct?.price || '—',
//           previewUrl: validProduct?.shopUrl || p.shopUrl || null,
//         };
//       }),
//     ); // ✅ ← closes Promise.all()

//     // 🧹 remove empty product groups (no valid images)
//     const filteredPurchases = normalizedPurchases.filter(
//       (p) => !!p.previewImage,
//     );

//     // 🧊 Climate sanity check — if Polar but outfit lacks insulation, patch style_note
//     if (
//       styleProfile.climate?.toLowerCase().includes('polar') &&
//       !/coat|jacket|parka|boot|knit|sweater/i.test(
//         JSON.stringify(parsed.recreated_outfit || []),
//       )
//     ) {
//       parsed.style_note +=
//         ' Reinforced with insulated outerwear and cold-weather layering for Polar climates.';
//     }

//     // 🚫 Prevent fallback or secondary recreate() from overwriting personalized flow
//     if (
//       enrichedPurchases?.length > 0 ||
//       parsed?.suggested_purchases?.length > 0
//     ) {
//       console.log(
//         '✅ [personalizedShop] Finalizing personalized results — skipping generic recreate()',
//       );
//       return {
//         user_id,
//         image_url,
//         tags,
//         recreated_outfit: parsed?.recreated_outfit || [],
//         suggested_purchases: normalizedPurchases,
//         style_note:
//           parsed?.style_note ||
//           'Personalized recreation based on your wardrobe, with curated seasonal add-ons.',
//         applied_filters: {
//           preferFit,
//           bannedWords: bannedWords.map((r) => r.source),
//         },
//       };
//     }

//     return {
//       user_id,
//       image_url,
//       tags,
//       recreated_outfit: parsed?.recreated_outfit || [],
//       suggested_purchases: normalizedPurchases,
//       style_note:
//         parsed?.style_note ||
//         'Personalized recreation based on your wardrobe, with curated seasonal add-ons.',
//       applied_filters: {
//         preferFit,
//         bannedWords: bannedWords.map((r) => r.source),
//       },
//     };
//   }

//   ////////END CREATE LOOK

//   //////. START REPLACED CHAT WITH LINKS AND SEARCH NET

//   /** 🧠 Conversational fashion chat — now with visuals + links */
//   async chat(dto: ChatDto) {
//     const { messages } = dto;
//     const lastUserMsg = messages
//       .slice()
//       .reverse()
//       .find((m) => m.role === 'user')?.content;

//     if (!lastUserMsg) {
//       throw new Error('No user message provided');
//     }

//     // 1️⃣ Generate base text with OpenAI
//     const completion = await this.openai.chat.completions.create({
//       model: 'gpt-4o',
//       temperature: 0.8,
//       messages: [
//         {
//           role: 'system',
//           content: `
// You are a world-class personal fashion stylist.
// Respond naturally and helpfully about outfits, wardrobe planning, or styling.
// At the end of your reasoning, also return a short JSON block like:
// {"search_terms":["smart casual men","navy blazer outfit","loafers"]}
//         `,
//         },
//         ...messages,
//       ],
//     });

//     const aiReply =
//       completion.choices[0]?.message?.content?.trim() ||
//       'Styled response unavailable.';

//     // 2️⃣ Extract search terms if model provided them
//     let searchTerms: string[] = [];
//     const match = aiReply.match(/\{.*"search_terms":.*\}/s);
//     if (match) {
//       try {
//         const parsed = JSON.parse(match[0]);
//         searchTerms = parsed.search_terms ?? [];
//       } catch {
//         searchTerms = [];
//       }
//     }

//     // 3️⃣ Fallback heuristic: derive terms if none found
//     if (!searchTerms.length) {
//       const lowered = lastUserMsg.toLowerCase();
//       if (lowered.includes('smart')) searchTerms.push('smart casual outfit');
//       if (lowered.includes('summer')) searchTerms.push('summer outfit');
//       if (lowered.includes('work')) searchTerms.push('business casual look');
//       if (!searchTerms.length)
//         searchTerms.push(`${lowered} outfit inspiration`);
//     }

//     // 4️⃣ Fetch Unsplash images
//     const images = await this.fetchUnsplash(searchTerms);

//     // 5️⃣ Build shoppable links
//     const links = searchTerms.map((term) => ({
//       label: `Shop ${term} on ASOS`,
//       url: `https://www.asos.com/search/?q=${encodeURIComponent(term)}`,
//     }));

//     return { reply: aiReply, images, links };
//   }

//   /** 🔍 Lightweight Unsplash fetch helper */
//   private async fetchUnsplash(terms: string[]) {
//     const key = process.env.UNSPLASH_ACCESS_KEY;
//     if (!key || !terms.length) return [];
//     const q = encodeURIComponent(terms[0]);
//     const res = await fetch(
//       `https://api.unsplash.com/search/photos?query=${q}&per_page=5&client_id=${key}`,
//     );
//     if (!res.ok) return [];
//     const json = await res.json();
//     return json.results.map((r) => ({
//       imageUrl: r.urls.small,
//       title: r.description || r.alt_description,
//       sourceLink: r.links.html,
//     }));
//   }

//   /** 🌤️ Suggest daily style plan */
//   async suggest(body: {
//     user?: string;
//     weather?: any;
//     wardrobe?: any[];
//     preferences?: Record<string, any>;
//   }) {
//     const { user, weather, wardrobe, preferences } = body;

//     const temp = weather?.fahrenheit?.main?.temp;
//     const tempDesc = temp
//       ? `${temp}°F and ${temp < 60 ? 'cool' : temp > 85 ? 'warm' : 'mild'} weather`
//       : 'unknown temperature';

//     const wardrobeCount = wardrobe?.length || 0;

//     const systemPrompt = `
// You are a luxury personal stylist.
// Your goal is to provide a daily style briefing that helps the user feel prepared, stylish, and confident.
// Be concise, intelligent, and polished — similar to a stylist at a high-end menswear brand.

// Output must be JSON with:
// - suggestion
// - insight
// - tomorrow
// Optionally include seasonalForecast, lifecycleForecast, styleTrajectory.
// `;

//     const userPrompt = `
// Client: ${user || 'The user'}
// Weather: ${tempDesc}
// Wardrobe items: ${wardrobeCount}
// Preferences: ${JSON.stringify(preferences || {})}
// `;

//     const completion = await this.openai.chat.completions.create({
//       model: 'gpt-4o',
//       temperature: 0.8,
//       messages: [
//         { role: 'system', content: systemPrompt },
//         { role: 'user', content: userPrompt },
//       ],
//       response_format: { type: 'json_object' },
//     });

//     const raw = completion.choices[0]?.message?.content;
//     if (!raw) throw new Error('No suggestion response received from model.');

//     let parsed: {
//       suggestion: string;
//       insight: string;
//       tomorrow: string;
//       seasonalForecast?: string;
//       lifecycleForecast?: string;
//       styleTrajectory?: string;
//     };

//     try {
//       parsed = JSON.parse(raw);
//     } catch {
//       console.error('❌ Failed to parse AI JSON:', raw);
//       throw new Error('AI response was not valid JSON.');
//     }

//     if (!parsed.seasonalForecast) {
//       parsed.seasonalForecast = generateSeasonalForecast(wardrobe);
//     }

//     return parsed;
//   }

//   /* ------------------------------------------------------------
//      🧾 BARCODE / CLOTHING LABEL DECODER
//   -------------------------------------------------------------*/
//   async decodeBarcode(file: {
//     buffer: Buffer;
//     originalname: string;
//     mimetype: string;
//   }) {
//     const tempPath = `/tmp/${Date.now()}-barcode.jpg`;
//     fs.writeFileSync(tempPath, file.buffer);

//     try {
//       const base64 = fs.readFileSync(tempPath).toString('base64');

//       const prompt = `
//       You are analyzing a photo of a product or clothing label.
//       If the image contains a barcode, return ONLY the numeric digits (UPC/EAN).
//       Otherwise, infer structured product info like:
//       {
//         "name": "Uniqlo Linen Shirt",
//         "brand": "Uniqlo",
//         "category": "Shirts",
//         "material": "Linen"
//       }
//       Respond with JSON only. No extra text.
//       `;

//       const completion = await this.openai.chat.completions.create({
//         model: 'gpt-4o-mini',
//         messages: [
//           {
//             role: 'user',
//             content: [
//               { type: 'text', text: prompt },
//               {
//                 type: 'image_url',
//                 image_url: { url: `data:${file.mimetype};base64,${base64}` },
//               },
//             ],
//           },
//         ],
//         max_tokens: 200,
//       });

//       const message = completion.choices?.[0]?.message;

//       let text = '';
//       if (typeof message?.content === 'string') {
//         text = message.content;
//       } else if (Array.isArray(message?.content)) {
//         const parts = message.content as Array<{ text?: string }>;
//         text = parts.map((c) => c.text || '').join(' ');
//       }

//       text = text.trim().replace(/```json|```/g, '');

//       const match = text.match(/\b\d{8,14}\b/);
//       if (match) return { barcode: match[0], raw: text };

//       try {
//         const parsed = JSON.parse(text);
//         if (parsed?.name) return { barcode: null, inferred: parsed };
//       } catch {}

//       return { barcode: null, raw: text };
//     } catch (err: any) {
//       console.error('❌ [AI] decodeBarcode error:', err.message);
//       return { barcode: null, error: err.message };
//     } finally {
//       try {
//         fs.unlinkSync(tempPath);
//       } catch {}
//     }
//   }

//   /* ------------------------------------------------------------
//      🧩 PRODUCT LOOKUP BY BARCODE
//   -------------------------------------------------------------*/
//   async lookupProductByBarcode(upc: string) {
//     const normalized = upc.padStart(12, '0');
//     try {
//       const res = await fetch(
//         `https://api.upcitemdb.com/prod/trial/lookup?upc=${normalized}`,
//       );
//       const json = await res.json();

//       const item = json?.items?.[0];
//       if (!item) throw new Error('No product data from UPCItemDB');

//       return {
//         name: item.title,
//         brand: item.brand,
//         image: item.images?.[0],
//         category: item.category,
//         source: 'upcitemdb',
//       };
//     } catch (err: any) {
//       console.warn('⚠️ UPCItemDB lookup failed:', err.message);
//       const fallback = await this.lookupFallback(normalized);
//       if (!fallback?.name || fallback.name === 'Unknown product') {
//         return await this.lookupFallbackWithAI(normalized);
//       }
//       return fallback;
//     }
//   }

//   /* ------------------------------------------------------------
//      🔁 RapidAPI or Dummy Fallback
//   -------------------------------------------------------------*/
//   async lookupFallback(upc: string) {
//     try {
//       const res = await fetch(`https://barcodes1.p.rapidapi.com/?upc=${upc}`, {
//         headers: {
//           'X-RapidAPI-Key': process.env.RAPIDAPI_KEY ?? '',
//           'X-RapidAPI-Host': 'barcodes1.p.rapidapi.com',
//         },
//       });

//       const json = await res.json();
//       const product = json?.product ?? {};

//       return {
//         name: product.title || json.title || 'Unknown product',
//         brand: product.brand || json.brand || 'Unknown brand',
//         image: product.image || json.image || null,
//         category: product.category || 'Uncategorized',
//         source: 'rapidapi',
//       };
//     } catch (err: any) {
//       console.error('❌ lookupFallback failed:', err.message);
//       return { name: null, brand: null, image: null, category: null };
//     }
//   }

//   /* ------------------------------------------------------------
//      🤖 AI Fallback Guess
//   -------------------------------------------------------------*/
//   async lookupFallbackWithAI(upc: string) {
//     try {
//       const prompt = `
//       The barcode number is: ${upc}.
//       Guess the product based on global manufacturer codes.
//       Return valid JSON only:
//       {"name":"Example Product","brand":"Brand","category":"Category"}
//       `;

//       const completion = await this.openai.chat.completions.create({
//         model: 'gpt-4o-mini',
//         messages: [{ role: 'user', content: prompt }],
//         max_tokens: 150,
//       });

//       let text = completion.choices?.[0]?.message?.content?.trim() || '{}';
//       text = text.replace(/```json|```/g, '').trim();

//       let parsed: any;
//       try {
//         parsed = JSON.parse(text);
//       } catch {
//         parsed = {
//           name:
//             text.replace(/["{}]/g, '').split(',')[0]?.trim() ||
//             'Unknown product',
//           brand: 'Unknown',
//           category: 'Misc',
//         };
//       }

//       return {
//         name: parsed.name || 'Unknown product',
//         brand: parsed.brand || 'Unknown',
//         category: parsed.category || 'Misc',
//         source: 'ai-fallback',
//       };
//     } catch (err: any) {
//       console.error('❌ AI fallback failed:', err.message);
//       return {
//         name: 'Unknown product',
//         brand: 'Unknown',
//         category: 'Uncategorized',
//         source: 'ai-fallback',
//       };
//     }
//   }
// }

// // END REPLACED CHAT WITH LINKS AND SEARCH NET

//////////////////////////

// import { Injectable } from '@nestjs/common';
// import OpenAI from 'openai';
// import { ChatDto } from './dto/chat.dto';
// import { VertexService } from '../vertex/vertex.service'; // 🔹 ADDED
// import { ProductSearchService } from '../product-services/product-search.service';
// import { Pool } from 'pg';
// import { Express } from 'express';

// const pool = new Pool({
//   connectionString: process.env.DATABASE_URL,
//   ssl: { rejectUnauthorized: false },
// });

// import * as fs from 'fs';
// import * as path from 'path';
// import * as dotenv from 'dotenv';

// function loadOpenAISecrets(): {
//   apiKey?: string;
//   project?: string;
//   source: string;
// } {
//   const candidates = [
//     path.join(process.cwd(), '.env'),
//     path.join(process.cwd(), 'apps', 'backend-nest', '.env'),
//     path.join(__dirname, '..', '..', '.env'),
//   ];

//   for (const p of candidates) {
//     try {
//       if (fs.existsSync(p)) {
//         const parsed = dotenv.parse(fs.readFileSync(p));
//         const apiKey = parsed['OPENAI_API_KEY'];
//         const project = parsed['OPENAI_PROJECT_ID'];
//         if (apiKey) return { apiKey, project, source: p };
//       }
//     } catch {
//       // ignore
//     }
//   }

//   return {
//     apiKey: process.env.OPENAI_API_KEY,
//     project: process.env.OPENAI_PROJECT_ID,
//     source: 'process.env',
//   };
// }

// // 🧥 Basic capsule wardrobe templates
// const CAPSULES = {
//   Spring: [
//     { category: 'Outerwear', subcategory: 'Light Jacket', recommended: 2 },
//     { category: 'Tops', subcategory: 'Oxford Shirt', recommended: 3 },
//     { category: 'Bottoms', subcategory: 'Chinos', recommended: 2 },
//     { category: 'Shoes', subcategory: 'Loafers', recommended: 1 },
//     { category: 'Shoes', subcategory: 'Sneakers', recommended: 1 },
//   ],
//   Summer: [
//     { category: 'Tops', subcategory: 'Short Sleeve Shirt', recommended: 4 },
//     { category: 'Tops', subcategory: 'Polo Shirt', recommended: 2 },
//     { category: 'Bottoms', subcategory: 'Linen Trousers', recommended: 2 },
//     { category: 'Shoes', subcategory: 'Loafers', recommended: 1 },
//     { category: 'Shoes', subcategory: 'Sandals', recommended: 1 },
//   ],
//   Fall: [
//     { category: 'Outerwear', subcategory: 'Field Jacket', recommended: 1 },
//     { category: 'Outerwear', subcategory: 'Blazer', recommended: 1 },
//     { category: 'Tops', subcategory: 'Knit Sweater', recommended: 2 },
//     { category: 'Bottoms', subcategory: 'Wool Trousers', recommended: 2 },
//     { category: 'Shoes', subcategory: 'Chelsea Boots', recommended: 1 },
//   ],
//   Winter: [
//     { category: 'Outerwear', subcategory: 'Overcoat', recommended: 1 },
//     { category: 'Outerwear', subcategory: 'Heavy Parka', recommended: 1 },
//     { category: 'Tops', subcategory: 'Heavy Knit Sweater', recommended: 2 },
//     { category: 'Bottoms', subcategory: 'Wool Trousers', recommended: 2 },
//     { category: 'Shoes', subcategory: 'Boots', recommended: 2 },
//   ],
// };

// // 🗓️ Auto-detect season based on month
// function getCurrentSeason(): 'Spring' | 'Summer' | 'Fall' | 'Winter' {
//   const month = new Date().getMonth() + 1;
//   if ([3, 4, 5].includes(month)) return 'Spring';
//   if ([6, 7, 8].includes(month)) return 'Summer';
//   if ([9, 10, 11].includes(month)) return 'Fall';
//   return 'Winter';
// }

// // 🧠 Compare wardrobe to capsule and return simple forecast text
// function generateSeasonalForecast(wardrobe: any[] = []): string | undefined {
//   const season = getCurrentSeason();
//   const capsule = CAPSULES[season];
//   if (!capsule) return;

//   const missing: string[] = [];

//   capsule.forEach((item) => {
//     const owned = wardrobe.filter(
//       (w) =>
//         w.category?.toLowerCase() === item.category.toLowerCase() &&
//         w.subcategory?.toLowerCase() === item.subcategory.toLowerCase(),
//     ).length;

//     if (owned < item.recommended) {
//       const needed = item.recommended - owned;
//       missing.push(`${needed} × ${item.subcategory}`);
//     }
//   });

//   if (missing.length === 0) {
//     return `✅ Your ${season} capsule is complete — you're ready for the season.`;
//   }

//   return `🍂 ${season} is approaching — you're missing: ${missing.join(', ')}.`;
// }

// @Injectable()
// export class AiService {
//   private openai: OpenAI;
//   private useVertex: boolean;
//   private vertexService?: VertexService; // 🔹 optional instance
//   private productSearch: ProductSearchService; // ✅ add this

//   constructor(vertexService?: VertexService) {
//     const { apiKey, project, source } = loadOpenAISecrets();

//     const snippet = apiKey?.slice(0, 20) ?? '';
//     const len = apiKey?.length ?? 0;
//     console.log('🔑 OPENAI key source:', source);
//     console.log('🔑 OPENAI key snippet:', JSON.stringify(snippet));
//     console.log('🔑 OPENAI key length:', len);
//     console.log('📂 CWD:', process.cwd());

//     if (!apiKey) {
//       throw new Error('OPENAI_API_KEY not found in .env or environment.');
//     }
//     if (/^sk-?x{3,}/i.test(apiKey)) {
//       throw new Error(
//         'OPENAI_API_KEY appears masked (e.g., "sk-xxxxx..."). Read from the correct .env instead.',
//       );
//     }
//     if (!apiKey.startsWith('sk-')) {
//       throw new Error('OPENAI_API_KEY is malformed — must start with "sk-".');
//     }

//     this.openai = new OpenAI({ apiKey, project });

//     // 🔹 New: Vertex toggle
//     this.useVertex = process.env.USE_VERTEX === 'true';
//     if (this.useVertex) {
//       this.vertexService = vertexService;
//       console.log('🧠 Vertex/Gemini mode enabled for analyze/recreate');
//     }

//     this.productSearch = new ProductSearchService(); // NEW
//   }

//   //////ANALYZE LOOK

//   async analyze(imageUrl: string) {
//     console.log('🧠 [AI] analyze() called with', imageUrl);
//     if (!imageUrl) throw new Error('Missing imageUrl');

//     // 🔹 Try Vertex first if enabled
//     if (this.useVertex && this.vertexService) {
//       try {
//         const gcsUri = imageUrl.replace(
//           'https://storage.googleapis.com/',
//           'gs://',
//         );
//         const metadata = await this.vertexService.analyzeImage(gcsUri);
//         const tags = [
//           ...(metadata.tags || []),
//           ...(metadata.style_descriptors || []),
//           metadata.main_category,
//           metadata.subcategory,
//         ].filter(Boolean);
//         console.log('🧠 [Vertex] analyze() success:', tags);
//         return { tags };
//       } catch (err: any) {
//         console.warn(
//           '[Vertex] analyze() failed → fallback to OpenAI:',
//           err.message,
//         );
//       }
//     }

//     // 🔸 OpenAI fallback
//     try {
//       const completion = await this.openai.chat.completions.create({
//         model: 'gpt-4o-mini',
//         messages: [
//           {
//             role: 'system',
//             content:
//               'You are a professional fashion classifier. Return only JSON with a "tags" array describing the outfit’s style, color palette, and vibe.',
//           },
//           {
//             role: 'user',
//             content: [
//               { type: 'text', text: 'Describe this outfit as tags only:' },
//               { type: 'image_url', image_url: { url: imageUrl } },
//             ],
//           },
//         ],
//         response_format: { type: 'json_object' },
//       });

//       const raw = completion.choices[0]?.message?.content;
//       console.log('🧠 [AI] analyze() raw response:', raw);

//       if (!raw) throw new Error('Empty response from OpenAI');
//       const parsed = JSON.parse(raw || '{}');
//       return { tags: parsed.tags || [] };
//     } catch (err: any) {
//       console.error('❌ [AI] analyze() failed:', err.message);
//       return { tags: ['casual', 'modern', 'neutral'] };
//     }
//   }

//   /* ------------------------------------------------------------
//      🧩 Weighted Tag Enrichment + Trend Injection
//   -------------------------------------------------------------*/
//   private async enrichTags(tags: string[]): Promise<string[]> {
//     const weightMap: Record<string, number> = {
//       tailored: 3,
//       minimal: 3,
//       neutral: 3,
//       modern: 2,
//       vintage: 2,
//       classic: 2,
//       streetwear: 2,
//       oversized: 2,
//       slim: 2,
//       relaxed: 2,
//       casual: 1,
//       sporty: 1,
//     };

//     // 🧹 Normalize + de-dupe
//     const cleanTags = Array.from(
//       new Set(
//         tags
//           .map((t) => t.toLowerCase().trim())
//           .filter((t) => t && !['outfit', 'style', 'fashion'].includes(t)),
//       ),
//     );

//     // 🧠 Apply weights
//     const weighted = cleanTags
//       .map((t) => ({ tag: t, weight: weightMap[t] || 1 }))
//       .sort((a, b) => b.weight - a.weight);

//     // 🌍 Inject current trend tags
//     const trendTags = await this.fetchTrendTags();
//     const final = Array.from(
//       new Set([...weighted.map((w) => w.tag), ...trendTags.slice(0, 3)]),
//     );

//     console.log('🎯 [AI] Enriched tags →', final);
//     return final;
//   }

//   private async fetchTrendTags(): Promise<string[]> {
//     try {
//       const res = await fetch(
//         'https://trends.google.com/trends/hottrends/visualize/internal/data/en_us',
//       );
//       if (!res.ok) throw new Error(`HTTP ${res.status}`);
//       const json = await res.json().catch(() => []);
//       const trendWords = JSON.stringify(json).toLowerCase();
//       const matched = trendWords.match(
//         /(quiet luxury|monochrome|minimalism|maximalism|italian|tailoring|loafers|neutrals|linen|structured|preppy|flannel|earth tones|autumn layering)/gi,
//       );
//       if (matched?.length) return Array.from(new Set(matched));

//       // 🧭 If Google Trends returned empty, use local backup
//       return [
//         'quiet luxury',
//         'neutral tones',
//         'tailored fit',
//         'autumn layering',
//       ];
//     } catch (err: any) {
//       console.warn('⚠️ Trend fetch fallback triggered:', err.message);
//       return [
//         'quiet luxury',
//         'neutral tones',
//         'tailored fit',
//         'autumn layering',
//       ];
//     }
//   }

//   // RECREATE//////////////
//   async recreate(
//     user_id: string,
//     tags: string[],
//     image_url?: string,
//     user_gender?: string,
//   ) {
//     console.log(
//       '🧥 [AI] recreate() called for user',
//       user_id,
//       'with tags:',
//       tags,
//       'and gender:',
//       user_gender,
//     );

//     if (!user_id) throw new Error('Missing user_id');
//     if (!tags?.length) {
//       console.warn('⚠️ [AI] recreate() empty tags → using defaults.');
//       tags = ['modern', 'neutral', 'tailored'];
//     }

//     // ✅ Weighted + trend-injected tags
//     tags = await this.enrichTags(tags);

//     // 🧠 Fetch gender_presentation if missing
//     if (!user_gender) {
//       try {
//         const result = await pool.query(
//           'SELECT gender_presentation FROM users WHERE id = $1 LIMIT 1',
//           [user_id],
//         );
//         user_gender = result.rows[0]?.gender_presentation || 'neutral';
//       } catch {
//         user_gender = 'neutral';
//       }
//     }

//     // 🧩 Normalize gender
//     const normalizedGender =
//       user_gender?.toLowerCase().includes('female') ||
//       user_gender?.toLowerCase().includes('woman')
//         ? 'female'
//         : user_gender?.toLowerCase().includes('male') ||
//             user_gender?.toLowerCase().includes('man')
//           ? 'male'
//           : process.env.DEFAULT_GENDER || 'neutral';

//     // 🧠 Build stylist prompt (base)
//     let prompt = `
//         You are a world-class AI stylist for ${normalizedGender} fashion.
//         Create a cohesive outfit inspired by an uploaded look.

//         Client: ${user_id}
//         Image: ${image_url || 'N/A'}
//         Detected tags: ${tags.join(', ')}

//         Rules:
//         - Match fabric, color palette, and silhouette.
//         - Use ${normalizedGender}-appropriate pieces.
//         - Output only JSON:
//         {
//           "outfit": [
//             { "category": "Top", "item": "Grey Cotton Tee", "color": "gray" },
//             { "category": "Bottom", "item": "Navy Chinos", "color": "navy" },
//             { "category": "Outerwear", "item": "Beige Overshirt", "color": "beige" },
//             { "category": "Shoes", "item": "White Sneakers", "color": "white" }
//           ],
//           "style_note": "Describe how the look connects to the uploaded image."
//         }
//         `;

//     // 🔹 Pull soft profile context (optional)
//     let profileCtx = '';
//     try {
//       const res = await pool.query(
//         `SELECT favorite_colors, fit_preferences, preferred_brands, disliked_styles
//        FROM style_profiles WHERE user_id::text = $1 LIMIT 1`,
//         [user_id],
//       );
//       const prof = res.rows[0];
//       if (prof) {
//         profileCtx = `
//       # USER STYLE CONTEXT (soft influence)
//       • Preferred colors: ${(prof.favorite_colors || []).join(', ') || '—'}
//       • Fit preferences: ${(prof.fit_preferences || []).join(', ') || '—'}
//       • Favorite brands: ${(prof.preferred_brands || []).join(', ') || '—'}
//       • Disliked styles: ${prof.disliked_styles || '—'}
//       Do NOT override the image’s vibe — just bias tone/material choices if relevant.
//       `;
//       }
//     } catch {
//       /* silent fail */
//     }

//     // ✅ Final prompt (merge only if context exists)
//     // Inside recreate() or personalizedShop() final prompt:
//     const finalPrompt = `
// ${prompt}

// # HARD RULES
// - ALWAYS output a full outfit of at least 4–6 distinct pieces.
// - Include a Top, Bottom, Outerwear (if seasonally appropriate), Shoes, and optionally 1–2 Accessories.
// - NEVER omit items because they already exist in the user’s wardrobe.
// - Each piece should have its own JSON object, even if similar to a wardrobe item.
// - Always include color and fit for every item.
// `;

//     // 🧠 Generate outfit via Vertex or OpenAI
//     let parsed: any;
//     if (this.useVertex && this.vertexService) {
//       try {
//         const result =
//           await this.vertexService.generateReasonedOutfit(finalPrompt);
//         let text = result?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
//         text = text
//           .replace(/^```json\s*/i, '')
//           .replace(/```$/, '')
//           .trim();
//         parsed = JSON.parse(text);
//         console.log('🧠 [Vertex] recreate() success');
//       } catch (err: any) {
//         console.warn('[Vertex] recreate() failed → fallback', err.message);
//       }
//     }

//     if (!parsed) {
//       const completion = await this.openai.chat.completions.create({
//         model: 'gpt-4o-mini',
//         temperature: 0.7,
//         messages: [{ role: 'user', content: finalPrompt }],
//         response_format: { type: 'json_object' },
//       });

//       const raw = completion.choices[0]?.message?.content || '{}';
//       try {
//         parsed = JSON.parse(raw);
//       } catch {
//         parsed = {};
//       }
//     }

//     const outfit = Array.isArray(parsed?.outfit) ? parsed.outfit : [];
//     const style_note =
//       parsed?.style_note || 'Modern outfit inspired by the uploaded look.';

//     // 🛍️ Enrich each item with live products
//     const enriched = await Promise.all(
//       outfit.map(async (o: any) => {
//         const query =
//           `${normalizedGender} ${o.item || o.category || ''} ${o.color || ''}`.trim();
//         let products = await this.productSearch.search(query);
//         let top = products[0];

//         if (!top?.image || top.image.includes('No_image')) {
//           const serp = await this.productSearch.searchSerpApi(query);
//           if (serp?.[0]) top = { ...serp[0], source: 'SerpAPI' };
//         }

//         const materialHint =
//           query.match(/(wool|cotton|linen|leather|denim|polyester)/i)?.[0] ||
//           null;
//         const seasonalityHint =
//           query.match(/(summer|winter|fall|spring)/i)?.[0] ||
//           getCurrentSeason();
//         const fitHint =
//           query.match(/(slim|regular|relaxed|oversized|tailored)/i)?.[0] ||
//           'regular';

//         return {
//           category: o.category,
//           item: o.item,
//           color: o.color,
//           brand: top?.brand || 'Unknown',
//           price: top?.price || '—',
//           image:
//             top?.image && top.image.startsWith('http')
//               ? top.image
//               : 'https://upload.wikimedia.org/wikipedia/commons/a/ac/No_image_available.svg',
//           shopUrl:
//             top?.shopUrl ||
//             `https://www.google.com/search?q=${encodeURIComponent(query)}&tbm=shop`,
//           source: top?.source || 'ASOS / Fallback',
//           material: materialHint,
//           seasonality: seasonalityHint,
//           fit: fitHint,
//         };
//       }),
//     );

//     return { user_id, outfit: enriched, style_note };
//   }

//   // 🧩 Ensure every product object includes a usable image URL
//   private fixProductImages(products: any[] = []): any[] {
//     return products.map((prod) => ({
//       ...prod,
//       image:
//         prod.image ||
//         prod.image_url ||
//         prod.thumbnail ||
//         prod.serpapi_thumbnail || // ✅ added
//         prod.img ||
//         prod.picture ||
//         prod.thumbnail_url ||
//         'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg',
//     }));
//   }

//   // 👔 PERSONALIZED SHOP — image + wardrobe + preferences
//   async personalizedShop(
//     user_id: string,
//     image_url: string,
//     user_gender?: string,
//   ) {
//     if (!user_id || !image_url) throw new Error('Missing user_id or image_url');

//     /** -----------------------------------------------------------
//      * 🧠 buildProfileConstraints(profile)
//      * Converts full style_profiles record into explicit hard rules
//      * ---------------------------------------------------------- */
//     function buildProfileConstraints(profile: any): string {
//       if (!profile) return '';

//       const fit = Array.isArray(profile.fit_preferences)
//         ? profile.fit_preferences.join(', ')
//         : profile.fit_preferences;

//       const colors = Array.isArray(profile.favorite_colors)
//         ? profile.favorite_colors.join(', ')
//         : profile.favorite_colors;

//       const brands = Array.isArray(profile.preferred_brands)
//         ? profile.preferred_brands.join(', ')
//         : profile.preferred_brands;

//       const styles = [
//         ...(profile.style_keywords || []),
//         ...(profile.style_preferences || []),
//       ]
//         .filter(Boolean)
//         .join(', ');

//       const dislikes =
//         typeof profile.disliked_styles === 'string'
//           ? profile.disliked_styles
//           : (profile.disliked_styles || []).join(', ');

//       const climate = profile.climate || 'Temperate';
//       const goals = profile.goals || '';

//       // 🔹 Inject explicit hard “only color” or “except color” rule for the model itself
//       let colorRule = '';
//       if (profile.disliked_styles?.match(/only\s+(\w+)/i)) {
//         const onlyColor = profile.disliked_styles.match(/only\s+(\w+)/i)[1];
//         colorRule = `• Use ONLY ${onlyColor} items — all other colors are forbidden.`;
//       } else if (profile.disliked_styles?.match(/except\s+(\w+)/i)) {
//         const exceptColor = profile.disliked_styles.match(/except\s+(\w+)/i)[1];
//         colorRule = `• Exclude every color except ${exceptColor}.`;
//       }

//       // 🔹 Explicitly enforce fit preferences
//       let fitRule = '';
//       if (profile.fit_preferences?.length) {
//         fitRule = `• Allow ONLY these fits: ${profile.fit_preferences.join(
//           ', ',
//         )}; exclude all others.`;
//       }

//       return `
// # USER PROFILE CONSTRAINTS (Hard Rules)

// ${fitRule}
// ${colorRule}

// • Fit: ${fit || 'Regular fit'} — outfit items must match this silhouette; exclude all opposing fits.
// • Climate: ${climate} — use materials and layers appropriate to this temperature zone.
// • Preferred brands: ${brands || '—'} — bias all product searches toward these or comparable aesthetics.
// • Favorite colors: ${colors || '—'} — bias color palette to these tones; avoid disliked colors.
// • Disliked styles: ${dislikes || '—'} — exclude these aesthetics entirely.
// • Style & vibe keywords: ${styles || '—'} — reflect these qualities in overall tone and accessories.
// • Goals: ${goals}
// • Body & proportions: ${profile.body_type || '—'}, ${
//         profile.proportions || '—'
//       } — ensure silhouette and layering suit these proportions.
// • Skin tone / hair / eyes: ${profile.skin_tone || '—'}, ${
//         profile.hair_color || '—'
//       }, ${profile.eye_color || '—'} — choose tones that complement.
// `;
//     }

//     // 1) Analyze uploaded image
//     const analysis = await this.analyze(image_url);
//     const tags = analysis?.tags || [];

//     //   const { rows: wardrobe } = await pool.query(
//     //     `SELECT name, main_category AS category, subcategory, color, material
//     //  FROM wardrobe_items
//     //  WHERE user_id::text = $1
//     //  ORDER BY updated_at DESC
//     //  LIMIT 50`,
//     //     [user_id],
//     //   );

//     // 🚫 Skip wardrobe entirely for personalized mode
//     const wardrobe: any[] = [];

//     const prefRes = await pool.query(
//       `SELECT gender_presentation
//      FROM users
//      WHERE id = $1
//      LIMIT 1`,
//       [user_id],
//     );
//     const profile = prefRes.rows[0] || {};
//     const gender = user_gender || profile.gender_presentation || 'neutral';
//     // 2️⃣ Fetch user style profile (full data used for personalization)
//     const styleProfileRes = await pool.query(
//       `
//   SELECT
//     body_type,
//     skin_tone,
//     undertone,
//     climate,
//     favorite_colors,
//     disliked_styles,
//     style_keywords,
//     preferred_brands,
//     goals,
//     proportions,
//     hair_color,
//     eye_color,
//     height,
//     waist,
//     fit_preferences,
//     style_preferences
//   FROM style_profiles
//   WHERE user_id::text = $1
//   LIMIT 1
// `,
//       [user_id],
//     );

//     const styleProfile = styleProfileRes.rows[0] || {};

//     // 🔹 Build user filter preferences
//     const { preferFit, bannedWords } = buildUserFilter(styleProfile);

//     /* ------------------------------------------------------------
//    🎛️ VISUAL + STYLE FILTERING HELPERS
// -------------------------------------------------------------*/
//     const FIT_KEYWORDS = {
//       skinny: [/skinny/i, /super[- ]skinny/i, /spray[- ]on/i],
//       slim: [/slim/i],
//       tailored: [/tailored/i, /tapered/i],
//       relaxed: [/relaxed/i, /loose/i, /baggy/i, /wide[- ]leg/i],
//       oversized: [/oversized/i, /boxy/i],
//     };

//     function buildUserFilter(profile: any) {
//       const fitPrefs = (profile.fit_preferences || []).map((x: string) =>
//         x.toLowerCase(),
//       );
//       const disliked = (profile.disliked_styles || '')
//         .toLowerCase()
//         .split(/[,\s]+/)
//         .filter(Boolean);
//       const favColors = (profile.favorite_colors || []).map((x: string) =>
//         x.toLowerCase(),
//       );

//       const preferFit =
//         fitPrefs.find((f) => /(relaxed|loose|baggy|oversized|boxy)/.test(f)) ||
//         fitPrefs.find((f) => /(regular|tailored)/.test(f)) ||
//         fitPrefs[0] ||
//         null;

//       const banFits: string[] = [];
//       if (preferFit?.match(/relaxed|loose|baggy|oversized|boxy/))
//         banFits.push('skinny', 'slim');
//       else if (preferFit?.match(/skinny|slim/))
//         banFits.push('relaxed', 'baggy', 'oversized');

//       const bannedWords = [
//         ...disliked,
//         ...banFits,
//         ...(!favColors.includes('green') ? ['green'] : []),
//       ]
//         .filter(Boolean)
//         .map((x) => new RegExp(x, 'i'));

//       return { preferFit, bannedWords };
//     }

//     function enforceProfileFilters(
//       products: any[] = [],
//       preferFit?: string | null,
//       bannedWords: RegExp[] = [],
//     ) {
//       if (!products.length) return products;

//       return products
//         .filter((p) => {
//           const hay = `${p.title || ''} ${p.name || ''} ${p.description || ''}`;
//           return !bannedWords.some((rx) => rx.test(hay));
//         })
//         .sort((a, b) => {
//           if (!preferFit) return 0;
//           const aHit = FIT_KEYWORDS[preferFit]?.some((rx) =>
//             rx.test(`${a.title} ${a.name}`),
//           )
//             ? 1
//             : 0;
//           const bHit = FIT_KEYWORDS[preferFit]?.some((rx) =>
//             rx.test(`${b.title} ${b.name}`),
//           )
//             ? 1
//             : 0;
//           return bHit - aHit; // boost preferred fits
//         });
//     }

//     // 3) Ask model to split into "owned" vs "missing"

//     const climateNote = styleProfile.climate
//       ? `The user's climate is ${styleProfile.climate}.
//     If it is cold (like Polar or Cold), emphasize insulated materials, coats, layers, scarves, gloves, and boots.
//     If it is hot (like Tropical or Desert), emphasize breathable, lightweight fabrics and open footwear.`
//       : '';

//     // 🔒 Enforced personalization hierarchy
//     const rules = `
//     # PERSONALIZATION ENFORCEMENT
//     Follow these user preferences as *absolute constraints*, not suggestions.
//     `;

//     const profileConstraints = buildProfileConstraints(styleProfile);

//     const prompt = `
// You are a world-class personal stylist generating a personalized recreation of an uploaded look.
// ${rules}
// ${profileConstraints}

// # IMAGE INSPIRATION
// • Use the uploaded image only as an aesthetic anchor (color story, silhouette, or texture).
// • Do NOT reference or reuse the user's wardrobe.
// • Respect all style profile constraints exactly.
// • Maintain the same mood and spirit as the uploaded image, not a literal copy.
// • Preserve one clear visual motif from the source image (e.g., plaid pattern or color tone) unless climate prohibits.

// # OUTPUT RULES
// - ALWAYS output a complete outfit with distinct Top, Bottom, Shoes, and (if seasonally appropriate) Outerwear and Accessories.
// - Each piece must include category, item, color, and fit.

// Return ONLY valid JSON:
// {
//   "recreated_outfit": [
//     { "source":"purchase", "category":"Top", "item":"...", "color":"...", "fit":"..." }
//   ],
//   "suggested_purchases": [
//     { "category":"...", "item":"...", "color":"...", "material":"...", "brand":"...", "shopUrl":"..." }
//   ],
//   "style_note": "Explain how this respects the user's climate, fit, and taste."
// }

// User gender: ${gender}
// Detected tags: ${tags.join(', ')}
// Weighted tags: ${tags.map((t) => `high priority: ${t}`).join(', ')}
// User style profile: ${JSON.stringify(styleProfile, null, 2)}
// ${climateNote}
// `;

//     console.log('🧥 [personalizedShop] profile:', profile);
//     console.log('🧥 [personalizedShop] gender:', gender);
//     console.log('🧥 [personalizedShop] styleProfile:', styleProfile);
//     console.log('🧠 [personalizedShop] Prompt preview:', prompt.slice(0, 800));

//     // 🧠 DEBUG START — prompt verification
//     console.log('─────────────── PROMPT SENT TO MODEL ───────────────');
//     console.log(prompt);
//     console.log('─────────────── END PROMPT ───────────────');

//     const completion = await this.openai.chat.completions.create({
//       model: 'gpt-4o-mini',
//       temperature: 0.7,
//       messages: [{ role: 'user', content: prompt }],
//       response_format: { type: 'json_object' },
//     });

//     // 🧠 DEBUG END — raw model output
//     console.log('─────────────── RAW MODEL RESPONSE ───────────────');
//     console.log(completion.choices[0]?.message?.content);
//     console.log('─────────────── END RESPONSE ───────────────');

//     let parsed: any = {};
//     try {
//       parsed = JSON.parse(completion.choices[0]?.message?.content || '{}');

//       // 🧩 SAFETY GUARD — ensure we keep valid recreated_outfit
//       try {
//         const parsedKeys = Object.keys(parsed);
//         console.log('✅ [personalizedShop] Parsed JSON keys:', parsedKeys);

//         // If model used "outfit" instead of "recreated_outfit", normalize it
//         if (!parsed.recreated_outfit && parsed.outfit) {
//           parsed.recreated_outfit = parsed.outfit;
//           console.log('✅ [personalizedShop] Mapped outfit → recreated_outfit');
//         }

//         // Double-check array validity before fallback clears it
//         if (parsed.recreated_outfit && parsed.recreated_outfit.length > 0) {
//           console.log(
//             '✅ [personalizedShop] Using recreated_outfit from model',
//           );
//         } else {
//           console.warn(
//             '⚠️ [personalizedShop] No recreated_outfit found — fallback may trigger',
//           );
//         }
//       } catch (err) {
//         console.error(
//           '❌ [personalizedShop] JSON structure guard failed:',
//           err,
//         );
//       }

//       // ✅ Final filter fix — keep wardrobe items but still respect banned fits/styles
//       if (parsed?.recreated_outfit?.length) {
//         parsed.recreated_outfit = parsed.recreated_outfit.filter((o: any) => {
//           if (!o) return false;
//           const text =
//             `${o.item} ${o.category} ${o.color} ${o.fit}`.toLowerCase();
//           if (!text.trim() || text.includes('undefined')) return false;
//           // ✅ Always keep wardrobe items regardless of style bans
//           if (o.source === 'wardrobe') return true;

//           const fitBan = preferFit?.match(/relaxed|oversized|boxy|loose/)
//             ? ['skinny']
//             : preferFit?.match(/skinny|slim|tailored/)
//               ? ['relaxed', 'baggy', 'oversized']
//               : [];

//           const styleBan =
//             (styleProfile.disliked_styles || '')
//               .toLowerCase()
//               .split(/[,\s]+/)
//               .filter(Boolean) || [];

//           const banned = [...fitBan, ...styleBan];
//           return !banned.some((b) => text.includes(b));
//         });

//         console.log(
//           '✅ [personalizedShop] Final filtered outfit →',
//           parsed.recreated_outfit,
//         );
//       }

//       console.log(
//         '💎 [personalizedShop] Parsed recreated outfit sample:',
//         parsed?.recreated_outfit?.slice(0, 2),
//       );
//       console.log(
//         '💎 [personalizedShop] Parsed suggested purchases sample:',
//         parsed?.suggested_purchases?.slice(0, 2),
//       );

//       // 🧩 Merge recreated_outfit into suggested_purchases for display
//       if (
//         Array.isArray(parsed?.recreated_outfit) &&
//         parsed.recreated_outfit.length
//       ) {
//         parsed.suggested_purchases = [
//           ...(parsed.suggested_purchases || []),
//           ...parsed.recreated_outfit.map((o: any) => ({
//             ...o,
//             brand: o.brand || '—',
//             previewImage: o.previewImage || o.image || o.image_url || null,
//             source: 'purchase',
//           })),
//         ];
//         console.log(
//           '🧩 [personalizedShop] merged recreated_outfit → suggested_purchases',
//         );
//       }

//       // 🖼️ Ensure every recreated outfit item has a visible preview image
//       if (Array.isArray(parsed?.recreated_outfit)) {
//         parsed.recreated_outfit = parsed.recreated_outfit.map((item: any) => {
//           if (!item.previewImage && item.source === 'wardrobe') {
//             item.previewImage =
//               item.image_url ||
//               item.wardrobe_image ||
//               'https://upload.wikimedia.org/wikipedia/commons/a/ac/No_image_available.svg';
//           }
//           return item;
//         });
//       }

//       // 🎨 Enforce "only <color>" rule from disliked_styles (e.g. "I dislike all colors except pink")
//       // 🎨 Optional color-only enforcement — only if explicit "ONLY <color>" flag exists
//       if (styleProfile?.disliked_styles?.toLowerCase().includes('only')) {
//         const match = styleProfile.disliked_styles.match(/only\s+(\w+)/i);
//         if (match) {
//           const onlyColor = match[1].toLowerCase();
//           const filterColor = (arr: any[]) =>
//             arr.filter((x) =>
//               (x.color || '').toLowerCase().includes(onlyColor),
//             );

//           if (Array.isArray(parsed?.recreated_outfit))
//             parsed.recreated_outfit = filterColor(parsed.recreated_outfit);
//           if (Array.isArray(parsed?.suggested_purchases))
//             parsed.suggested_purchases = filterColor(
//               parsed.suggested_purchases,
//             );

//           console.log(
//             `[personalizedShop] 🎨 Enforcing ONLY-color rule: ${onlyColor}`,
//           );
//         }
//       }
//     } catch {
//       parsed = {};
//     }

//     const purchases = Array.isArray(parsed?.suggested_purchases)
//       ? parsed.suggested_purchases
//       : [];

//     if (parsed?.recreated_outfit?.some((i: any) => i.source === 'wardrobe')) {
//       console.log('🧥 [personalizedShop] ✅ Model reused wardrobe pieces.');
//     } else {
//       console.warn(
//         '🧥 [personalizedShop] ⚠️ Model did NOT reuse wardrobe — fallback to generic recreation.',
//       );
//     }

//     // 🚫 Enforce profile bans in returned outfit
//     const banned = [
//       ...(styleProfile.disliked_styles?.toLowerCase().split(/[,\s]+/) || []),
//       ...(preferFit?.match(/relaxed|oversized|boxy|loose/)
//         ? ['skinny', 'slim']
//         : []),
//       ...(preferFit?.match(/skinny|slim/)
//         ? ['relaxed', 'oversized', 'baggy']
//         : []),
//     ].filter(Boolean);

//     if (parsed?.recreated_outfit?.length) {
//       // ✅ Keep *all* wardrobe and purchase items — only filter garbage entries
//       parsed.recreated_outfit = parsed.recreated_outfit.filter((o: any) => {
//         if (!o || !o.item) return false;
//         const text =
//           `${o.item} ${o.category} ${o.color} ${o.fit}`.toLowerCase();
//         return text.trim().length > 0 && !text.includes('undefined');
//       });

//       // 🧱 Guarantee full outfit completeness (Top, Bottom, Shoes, Optional Outerwear/Accessory)
//       const categories = parsed.recreated_outfit.map((o: any) =>
//         o.category?.toLowerCase(),
//       );
//       const missing: any[] = [];

//       if (!categories.includes('top'))
//         missing.push({
//           source: 'purchase',
//           category: 'Top',
//           item: 'White Oxford Shirt',
//           color: 'White',
//           fit: 'Slim Fit',
//         });
//       if (!categories.includes('bottoms'))
//         missing.push({
//           source: 'purchase',
//           category: 'Bottoms',
//           item: 'Beige Chinos',
//           color: 'Beige',
//           fit: 'Slim Fit',
//         });
//       if (!categories.includes('shoes'))
//         missing.push({
//           source: 'purchase',
//           category: 'Shoes',
//           item: 'White Leather Sneakers',
//           color: 'White',
//           fit: 'Slim Fit',
//         });

//       parsed.recreated_outfit.push(...missing);

//       console.log(
//         '✅ [personalizedShop] Final full outfit →',
//         parsed.recreated_outfit,
//       );
//     }

//     // 🧩 Centralized enforcement for personalizedShop only
//     function applyProfileFilters(products: any[], profile: any) {
//       if (!Array.isArray(products) || !products.length) return [];

//       const favColors = (profile.favorite_colors || []).map((x: string) =>
//         x.toLowerCase(),
//       );
//       const prefBrands = (profile.preferred_brands || []).map((x: string) =>
//         x.toLowerCase(),
//       );
//       const fitPrefs = (profile.fit_preferences || []).map((x: string) =>
//         x.toLowerCase(),
//       );
//       const dislikes = (profile.disliked_styles || '')
//         .toLowerCase()
//         .split(/[,\s]+/);
//       const climate = (profile.climate || '').toLowerCase();

//       const isCold = /(polar|cold|arctic|tundra|winter)/.test(climate);
//       const isHot = /(tropical|desert|hot|humid|summer)/.test(climate);

//       // 🩷 detect "only" or "except" color rule from disliked_styles
//       let onlyColor: string | null = null;
//       let exceptColor: string | null = null;

//       if (profile.disliked_styles?.match(/only\s+(\w+)/i)) {
//         onlyColor = profile.disliked_styles
//           .match(/only\s+(\w+)/i)[1]
//           .toLowerCase();
//       } else if (profile.disliked_styles?.match(/except\s+(\w+)/i)) {
//         exceptColor = profile.disliked_styles
//           .match(/except\s+(\w+)/i)[1]
//           .toLowerCase();
//       }

//       return products
//         .filter((p) => {
//           const t = `${p.name ?? ''} ${p.title ?? ''} ${p.brand ?? ''} ${
//             p.description ?? ''
//           } ${p.color ?? ''} ${p.fit ?? ''}`.toLowerCase();

//           // 🚫 Filter out disliked words/styles
//           if (dislikes.some((d) => d && t.includes(d))) return false;

//           // 🎨 HARD color enforcement from DB rules
//           if (onlyColor) {
//             // Only allow if text or color includes the specified color
//             if (
//               !t.includes(onlyColor) &&
//               !p.color?.toLowerCase().includes(onlyColor)
//             )
//               return false;
//           } else if (exceptColor) {
//             // Exclude everything not matching that color
//             if (
//               !t.includes(exceptColor) &&
//               !p.color?.toLowerCase().includes(exceptColor)
//             )
//               return false;
//           } else {
//             // Normal favorite color bias if no hard rule
//             if (favColors.length && !favColors.some((c) => t.includes(c)))
//               return false;
//           }

//           // 👕 Fit preferences
//           if (fitPrefs.length && !fitPrefs.some((f) => t.includes(f)))
//             return false;

//           // 🌡️ Climate-based filtering
//           if (isCold && /(tank|shorts|sandal)/.test(t)) return false;
//           if (isHot && /(wool|parka|coat|boot|knit)/.test(t)) return false;

//           return true;
//         })
//         .sort((a, b) => {
//           const score = (x: any) => {
//             const txt =
//               `${x.name} ${x.title} ${x.brand} ${x.color} ${x.fit}`.toLowerCase();
//             let s = 0;
//             if (onlyColor && txt.includes(onlyColor)) s += 4;
//             if (exceptColor && txt.includes(exceptColor)) s += 4;
//             if (favColors.some((c) => txt.includes(c))) s += 2;
//             if (prefBrands.some((b) => txt.includes(b))) s += 2;
//             if (fitPrefs.some((f) => txt.includes(f))) s += 1;
//             return s;
//           };
//           return score(b) - score(a);
//         });
//     }

//     // 4️⃣ Attach live shop links to the "missing" items — now honoring user taste
//     let enrichedPurchases = await Promise.all(
//       purchases.map(async (p: any) => {
//         // 🧠 Gender-locked prefix
//         const genderPrefix =
//           gender?.toLowerCase().includes('female') ||
//           gender?.toLowerCase().includes('woman')
//             ? 'women female womens ladies'
//             : 'men male mens masculine -women -womens -female -girls -ladies';

//         // Base query with gender lock
//         let q = [
//           genderPrefix,
//           p.item || p.category || '',
//           p.color || '',
//           p.material || '',
//         ]
//           .filter(Boolean)
//           .join(' ')
//           .trim();

//         // 🔹 Inject personalization bias terms
//         const brandTerms = (styleProfile.preferred_brands || [])
//           .slice(0, 3)
//           .join(' ');
//         const colorTerms = (styleProfile.favorite_colors || [])
//           .slice(0, 2)
//           .join(' ');
//         const fitTerms = Array.isArray(styleProfile.fit_preferences)
//           ? styleProfile.fit_preferences.join(' ')
//           : styleProfile.fit_preferences || '';

//         // 🎨 “Only color” rule (e.g. “I dislike all colors except pink”)
//         const colorMatch =
//           styleProfile.disliked_styles?.match(/except\s+(\w+)/i);
//         if (colorMatch) {
//           const onlyColor = colorMatch[1].toLowerCase();
//           q += ` ${onlyColor}`;
//         }

//         // Combine into final query with brand + color + fit bias
//         q = [q, brandTerms, colorTerms, fitTerms].filter(Boolean).join(' ');

//         // 🔒 Ensure all queries exclude female results explicitly
//         if (
//           !/-(women|female|ladies|girls)/i.test(q) &&
//           /\bmen\b|\bmale\b/i.test(q)
//         ) {
//           q += ' -women -womens -female -girls -ladies';
//         }

//         // Combine into final query with brand + color + fit bias
//         q = [q, brandTerms, colorTerms, fitTerms].filter(Boolean).join(' ');

//         // 🔒 Ensure all queries exclude female results explicitly
//         if (
//           !/-(women|female|ladies|girls)/i.test(q) &&
//           /\bmen\b|\bmale\b/i.test(q)
//         ) {
//           q += ' -women -womens -female -girls -ladies';
//         }

//         // 🧠 Gender-aware product search
//         let products = await this.productSearch.search(
//           q,
//           gender?.toLowerCase() === 'female'
//             ? 'female'
//             : gender?.toLowerCase() === 'male'
//               ? 'male'
//               : 'unisex',
//         );

//         // 🚫 Filter out any accidental female/unisex results
//         products = products.filter(
//           (prod) =>
//             !/women|female|womens|ladies|girls/i.test(
//               `${prod.name ?? ''} ${prod.brand ?? ''} ${prod.title ?? ''}`,
//             ),
//         );

//         // 🩷 Hard visual color filter — ensures displayed products actually match the enforced color rule
//         if (
//           styleProfile?.disliked_styles?.match(/only\s+(\w+)/i) ||
//           styleProfile?.disliked_styles?.match(/except\s+(\w+)/i)
//         ) {
//           const match =
//             styleProfile.disliked_styles.match(/only\s+(\w+)/i) ||
//             styleProfile.disliked_styles.match(/except\s+(\w+)/i);
//           const enforcedColor = match?.[1]?.toLowerCase();
//           if (enforcedColor) {
//             products = products.filter((p) => {
//               const text =
//                 `${p.name ?? ''} ${p.title ?? ''} ${p.color ?? ''}`.toLowerCase();
//               return text.includes(enforcedColor);
//             });
//           }
//         }

//         return {
//           ...p,
//           query: q,
//           products: applyProfileFilters(products, styleProfile),
//         };
//       }),
//     );

//     // 5️⃣ Fallback enrichment if AI returned nothing or products failed
//     if (!enrichedPurchases.length) {
//       console.warn(
//         '⚠️ [personalizedShop] Empty suggested_purchases → fallback.',
//       );

//       const tagSeed = tags.slice(0, 6).join(' ');
//       const season = getCurrentSeason();

//       // 🧠 Gender prefix for fallback with hard lock
//       const genderPrefix =
//         gender?.toLowerCase().includes('female') ||
//         gender?.toLowerCase().includes('woman')
//           ? 'women female womens ladies'
//           : 'men male mens masculine -women -womens -female -girls -ladies';

//       // 🧠 Enrich fallback with style taste as well
//       const brandTerms = (styleProfile.preferred_brands || [])
//         .slice(0, 3)
//         .join(' ');
//       const colorTerms = (styleProfile.favorite_colors || [])
//         .slice(0, 2)
//         .join(' ');
//       const fitTerms = Array.isArray(styleProfile.fit_preferences)
//         ? styleProfile.fit_preferences.join(' ')
//         : styleProfile.fit_preferences || '';

//       const fallbackQuery = `${genderPrefix} ${tagSeed} ${season} fashion ${brandTerms} ${colorTerms} ${fitTerms}`;
//       console.log('🧩 [personalizedShop] fallbackQuery →', fallbackQuery);

//       const products = await this.productSearch.search(
//         fallbackQuery,
//         gender?.toLowerCase() === 'female'
//           ? 'female'
//           : gender?.toLowerCase() === 'male'
//             ? 'male'
//             : 'unisex',
//       );

//       // 🚫 Filter out any accidental female/unisex results
//       const maleProducts = products.filter(
//         (prod) =>
//           !/women|female|womens|ladies|girls/i.test(
//             `${prod.name ?? ''} ${prod.brand ?? ''} ${prod.title ?? ''}`,
//           ),
//       );

//       enrichedPurchases = [
//         {
//           category: 'General',
//           item: 'Curated Outfit Add-Ons',
//           color: 'Mixed',
//           material: null,
//           products: applyProfileFilters(maleProducts.slice(0, 8), styleProfile),
//           query: fallbackQuery,
//           source: 'fallback',
//         },
//       ];
//     }

//     // 🎨 Enforce color-only rule on fallback products too
//     if (styleProfile?.disliked_styles) {
//       const match = styleProfile.disliked_styles.match(/except\s+(\w+)/i);
//       if (match) {
//         const onlyColor = match[1].toLowerCase();
//         enrichedPurchases = enrichedPurchases.map((p) => ({
//           ...p,
//           products: (p.products || []).filter((prod) =>
//             (prod.color || '').toLowerCase().includes(onlyColor),
//           ),
//         }));
//         console.log(
//           `[personalizedShop] 🎨 Enforced fallback color-only rule: ${onlyColor}`,
//         );
//       }
//     }

//     const cleanPurchases = enrichedPurchases.map((p) => ({
//       ...p,
//       products: this.fixProductImages(
//         enforceProfileFilters(p.products || [], preferFit, bannedWords),
//       ),
//     }));

//     // 🎨 FINAL VISUAL CONSISTENCY NORMALIZATION
//     const normalizedPurchases = await Promise.all(
//       enrichedPurchases.map(async (p) => {
//         const validProduct =
//           (p.products || []).find(
//             (x) =>
//               (x.image ||
//                 x.image_url ||
//                 x.thumbnail ||
//                 x.serpapi_thumbnail ||
//                 x.thumbnail_url ||
//                 x.img ||
//                 x.result?.thumbnail ||
//                 x.result?.serpapi_thumbnail) &&
//               /^https?:\/\//.test(
//                 x.image ||
//                   x.image_url ||
//                   x.thumbnail ||
//                   x.serpapi_thumbnail ||
//                   x.thumbnail_url ||
//                   x.img ||
//                   x.result?.thumbnail ||
//                   x.result?.serpapi_thumbnail ||
//                   '',
//               ) &&
//               !/no[_-]?image/i.test(
//                 x.image ||
//                   x.image_url ||
//                   x.thumbnail ||
//                   x.serpapi_thumbnail ||
//                   x.thumbnail_url ||
//                   x.img ||
//                   '',
//               ),
//           ) || p.products?.[0];

//         let previewImage =
//           validProduct?.image ||
//           validProduct?.image_url ||
//           validProduct?.thumbnail ||
//           validProduct?.serpapi_thumbnail ||
//           validProduct?.thumbnail_url ||
//           validProduct?.img ||
//           validProduct?.product_thumbnail ||
//           validProduct?.result?.thumbnail ||
//           validProduct?.result?.serpapi_thumbnail ||
//           null;

//         // 🎯 Gender-aware image guard
//         const userGender = (gender || '').toLowerCase();

//         if (previewImage) {
//           const url = previewImage.toLowerCase();

//           // 🧍‍♂️ If male → block clearly female-coded URLs
//           if (
//             userGender.includes('male') &&
//             /(women|woman|female|ladies|girls|womenswear|femme|skims|shein|fashionnova|princesspolly|revolve|anthropologie)/i.test(
//               url,
//             )
//           ) {
//             previewImage =
//               'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg';
//           }

//           // 🧍‍♀️ If female → block clearly male-coded URLs
//           else if (
//             userGender.includes('female') &&
//             /(men|man|male|menswear|masculine)/i.test(url)
//           ) {
//             previewImage =
//               'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg';
//           }

//           // 🧍 Unisex → allow all images
//         }

//         // 🧠 If still missing, do a quick SerpAPI lookup and cache
//         if (!previewImage && p.query) {
//           const results = await this.productSearch.searchSerpApi(p.query);
//           const r = results?.[0];
//           previewImage =
//             r?.image ||
//             r?.image_url ||
//             r?.thumbnail ||
//             r?.serpapi_thumbnail ||
//             r?.thumbnail_url ||
//             r?.result?.thumbnail ||
//             r?.result?.serpapi_thumbnail ||
//             null;

//           // 🎯 Apply same gender guard to SerpAPI result
//           if (previewImage) {
//             const url = previewImage.toLowerCase();

//             if (
//               userGender.includes('male') &&
//               /(women|woman|female|ladies|girls|womenswear|femme|skims|shein|fashionnova|princesspolly|revolve|anthropologie)/i.test(
//                 url,
//               )
//             ) {
//               previewImage =
//                 'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg';
//             } else if (
//               userGender.includes('female') &&
//               /(men|man|male|menswear|masculine)/i.test(url)
//             ) {
//               previewImage =
//                 'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg';
//             }
//           }
//         }

//         return {
//           ...p,
//           previewImage:
//             previewImage ||
//             'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg',
//           previewBrand: validProduct?.brand || p.brand || 'Unknown',
//           previewPrice: validProduct?.price || '—',
//           previewUrl: validProduct?.shopUrl || p.shopUrl || null,
//         };
//       }),
//     ); // ✅ ← closes Promise.all()

//     // 🧹 remove empty product groups (no valid images)
//     const filteredPurchases = normalizedPurchases.filter(
//       (p) => !!p.previewImage,
//     );

//     // 🧊 Climate sanity check — if Polar but outfit lacks insulation, patch style_note
//     if (
//       styleProfile.climate?.toLowerCase().includes('polar') &&
//       !/coat|jacket|parka|boot|knit|sweater/i.test(
//         JSON.stringify(parsed.recreated_outfit || []),
//       )
//     ) {
//       parsed.style_note +=
//         ' Reinforced with insulated outerwear and cold-weather layering for Polar climates.';
//     }

//     // 🚫 Prevent fallback or secondary recreate() from overwriting personalized flow
//     if (
//       enrichedPurchases?.length > 0 ||
//       parsed?.suggested_purchases?.length > 0
//     ) {
//       console.log(
//         '✅ [personalizedShop] Finalizing personalized results — skipping generic recreate()',
//       );
//       return {
//         user_id,
//         image_url,
//         tags,
//         recreated_outfit: parsed?.recreated_outfit || [],
//         suggested_purchases: normalizedPurchases,
//         style_note:
//           parsed?.style_note ||
//           'Personalized recreation based on your wardrobe, with curated seasonal add-ons.',
//         applied_filters: {
//           preferFit,
//           bannedWords: bannedWords.map((r) => r.source),
//         },
//       };
//     }

//     return {
//       user_id,
//       image_url,
//       tags,
//       recreated_outfit: parsed?.recreated_outfit || [],
//       suggested_purchases: normalizedPurchases,
//       style_note:
//         parsed?.style_note ||
//         'Personalized recreation based on your wardrobe, with curated seasonal add-ons.',
//       applied_filters: {
//         preferFit,
//         bannedWords: bannedWords.map((r) => r.source),
//       },
//     };
//   }

//   ////////END CREATE LOOK

//   //////. START REPLACED CHAT WITH LINKS AND SEARCH NET

//   /** 🧠 Conversational fashion chat — now with visuals + links */
//   async chat(dto: ChatDto) {
//     const { messages } = dto;
//     const lastUserMsg = messages
//       .slice()
//       .reverse()
//       .find((m) => m.role === 'user')?.content;

//     if (!lastUserMsg) {
//       throw new Error('No user message provided');
//     }

//     // 1️⃣ Generate base text with OpenAI
//     const completion = await this.openai.chat.completions.create({
//       model: 'gpt-4o',
//       temperature: 0.8,
//       messages: [
//         {
//           role: 'system',
//           content: `
// You are a world-class personal fashion stylist.
// Respond naturally and helpfully about outfits, wardrobe planning, or styling.
// At the end of your reasoning, also return a short JSON block like:
// {"search_terms":["smart casual men","navy blazer outfit","loafers"]}
//         `,
//         },
//         ...messages,
//       ],
//     });

//     const aiReply =
//       completion.choices[0]?.message?.content?.trim() ||
//       'Styled response unavailable.';

//     // 2️⃣ Extract search terms if model provided them
//     let searchTerms: string[] = [];
//     const match = aiReply.match(/\{.*"search_terms":.*\}/s);
//     if (match) {
//       try {
//         const parsed = JSON.parse(match[0]);
//         searchTerms = parsed.search_terms ?? [];
//       } catch {
//         searchTerms = [];
//       }
//     }

//     // 3️⃣ Fallback heuristic: derive terms if none found
//     if (!searchTerms.length) {
//       const lowered = lastUserMsg.toLowerCase();
//       if (lowered.includes('smart')) searchTerms.push('smart casual outfit');
//       if (lowered.includes('summer')) searchTerms.push('summer outfit');
//       if (lowered.includes('work')) searchTerms.push('business casual look');
//       if (!searchTerms.length)
//         searchTerms.push(`${lowered} outfit inspiration`);
//     }

//     // 4️⃣ Fetch Unsplash images
//     const images = await this.fetchUnsplash(searchTerms);

//     // 5️⃣ Build shoppable links
//     const links = searchTerms.map((term) => ({
//       label: `Shop ${term} on ASOS`,
//       url: `https://www.asos.com/search/?q=${encodeURIComponent(term)}`,
//     }));

//     return { reply: aiReply, images, links };
//   }

//   /** 🔍 Lightweight Unsplash fetch helper */
//   private async fetchUnsplash(terms: string[]) {
//     const key = process.env.UNSPLASH_ACCESS_KEY;
//     if (!key || !terms.length) return [];
//     const q = encodeURIComponent(terms[0]);
//     const res = await fetch(
//       `https://api.unsplash.com/search/photos?query=${q}&per_page=5&client_id=${key}`,
//     );
//     if (!res.ok) return [];
//     const json = await res.json();
//     return json.results.map((r) => ({
//       imageUrl: r.urls.small,
//       title: r.description || r.alt_description,
//       sourceLink: r.links.html,
//     }));
//   }

//   /** 🌤️ Suggest daily style plan */
//   async suggest(body: {
//     user?: string;
//     weather?: any;
//     wardrobe?: any[];
//     preferences?: Record<string, any>;
//   }) {
//     const { user, weather, wardrobe, preferences } = body;

//     const temp = weather?.fahrenheit?.main?.temp;
//     const tempDesc = temp
//       ? `${temp}°F and ${temp < 60 ? 'cool' : temp > 85 ? 'warm' : 'mild'} weather`
//       : 'unknown temperature';

//     const wardrobeCount = wardrobe?.length || 0;

//     const systemPrompt = `
// You are a luxury personal stylist.
// Your goal is to provide a daily style briefing that helps the user feel prepared, stylish, and confident.
// Be concise, intelligent, and polished — similar to a stylist at a high-end menswear brand.

// Output must be JSON with:
// - suggestion
// - insight
// - tomorrow
// Optionally include seasonalForecast, lifecycleForecast, styleTrajectory.
// `;

//     const userPrompt = `
// Client: ${user || 'The user'}
// Weather: ${tempDesc}
// Wardrobe items: ${wardrobeCount}
// Preferences: ${JSON.stringify(preferences || {})}
// `;

//     const completion = await this.openai.chat.completions.create({
//       model: 'gpt-4o',
//       temperature: 0.8,
//       messages: [
//         { role: 'system', content: systemPrompt },
//         { role: 'user', content: userPrompt },
//       ],
//       response_format: { type: 'json_object' },
//     });

//     const raw = completion.choices[0]?.message?.content;
//     if (!raw) throw new Error('No suggestion response received from model.');

//     let parsed: {
//       suggestion: string;
//       insight: string;
//       tomorrow: string;
//       seasonalForecast?: string;
//       lifecycleForecast?: string;
//       styleTrajectory?: string;
//     };

//     try {
//       parsed = JSON.parse(raw);
//     } catch {
//       console.error('❌ Failed to parse AI JSON:', raw);
//       throw new Error('AI response was not valid JSON.');
//     }

//     if (!parsed.seasonalForecast) {
//       parsed.seasonalForecast = generateSeasonalForecast(wardrobe);
//     }

//     return parsed;
//   }

//   /* ------------------------------------------------------------
//    🧾 BARCODE DECODER (no Vision API, uses existing OpenAI)
// -------------------------------------------------------------*/
//   async decodeBarcode(file: {
//     buffer: Buffer;
//     originalname: string;
//     mimetype: string;
//   }) {
//     const tempPath = `/tmp/${Date.now()}-barcode.jpg`;
//     fs.writeFileSync(tempPath, file.buffer);

//     try {
//       const base64 = fs.readFileSync(tempPath).toString('base64');
//       //   const prompt = `
//       //   You are analyzing a close-up photo of a product barcode label.
//       //   Return ONLY the numeric barcode digits (UPC or EAN), usually 12–13 digits.
//       //   If the barcode looks incomplete or OCR produces letters/spaces
//       //   (e.g. "226008 ign345"), infer the correct full numeric code.
//       //   If absolutely no barcode is visible, return "none".
//       //   Do not explain.
//       // `;

//       const prompt = `
//         You are analyzing a product described by its packaging text.
//         The product is likely an article of clothing or accessory.
//         Return structured JSON like:
//         {
//           "name": "Uniqlo Linen Shirt",
//           "brand": "Uniqlo",
//           "category": "Shirts",
//           "material": "Linen"
//         }
// `;

//       const completion = await this.openai.chat.completions.create({
//         model: 'gpt-4o-mini',
//         messages: [
//           {
//             role: 'user',
//             content: [
//               { type: 'text', text: prompt },
//               {
//                 type: 'image_url',
//                 image_url: { url: `data:${file.mimetype};base64,${base64}` },
//               },
//             ],
//           },
//         ],
//         max_tokens: 200,
//       });

//       const message = completion.choices?.[0]?.message;

//       // ✅ Extract text safely
//       let text = '';
//       if (typeof message?.content === 'string') {
//         text = message.content;
//       } else if (Array.isArray(message?.content)) {
//         const parts = message.content as Array<{ text?: string }>;
//         text = parts.map((c) => c.text || '').join(' ');
//       }

//       // ✅ Normalize and detect digits (allow 8–14 just in case)
//       const normalized = text.replace(/\s+/g, '');
//       const match = normalized.match(/\d{8,14}/);

//       return { barcode: match ? match[0] : null, raw: text };
//     } catch (err: any) {
//       console.error('❌ [AI] decodeBarcode error:', err.message);
//       return { barcode: null, error: err.message };
//     } finally {
//       try {
//         fs.unlinkSync(tempPath);
//       } catch {}
//     }
//   }

//   /* ------------------------------------------------------------
//    🧩 PRODUCT LOOKUP BY BARCODE — resilient, multi-layered
// -------------------------------------------------------------*/
//   async lookupProductByBarcode(upc: string) {
//     const normalized = upc.padStart(12, '0'); // ensure 12 digits
//     try {
//       // 🔹 1️⃣ Try UPCItemDB first
//       const res = await fetch(
//         `https://api.upcitemdb.com/prod/trial/lookup?upc=${normalized}`,
//       );
//       const json = await res.json();

//       const item = json?.items?.[0];
//       if (!item) throw new Error('No product data from UPCItemDB');

//       return {
//         name: item.title,
//         brand: item.brand,
//         image: item.images?.[0],
//         category: item.category,
//         source: 'upcitemdb',
//       };
//     } catch (err: any) {
//       console.warn('⚠️ UPCItemDB lookup failed:', err.message);
//       const fallback = await this.lookupFallback(normalized);

//       // ✅ 3️⃣ If still blank → AI fallback guess
//       if (!fallback?.name || fallback.name === 'Unknown product') {
//         const aiGuess = await this.lookupFallbackWithAI(normalized);
//         return aiGuess;
//       }

//       return fallback;
//     }
//   }

//   /* ------------------------------------------------------------
//    🔁 2️⃣ RapidAPI or dummy fallback (if UPCItemDB fails)
// -------------------------------------------------------------*/
//   async lookupFallback(upc: string) {
//     try {
//       const res = await fetch(`https://barcodes1.p.rapidapi.com/?upc=${upc}`, {
//         headers: {
//           'X-RapidAPI-Key': process.env.RAPIDAPI_KEY ?? '',
//           'X-RapidAPI-Host': 'barcodes1.p.rapidapi.com',
//         },
//       });

//       const json = await res.json();
//       const product = json?.product ?? {};

//       return {
//         name: product.title || json.title || 'Unknown product',
//         brand: product.brand || json.brand || 'Unknown brand',
//         image: product.image || json.image || null,
//         category: product.category || 'Uncategorized',
//         source: 'rapidapi',
//       };
//     } catch (err: any) {
//       console.error('❌ lookupFallback failed:', err.message);
//       return { name: null, brand: null, image: null, category: null };
//     }
//   }

//   /* ------------------------------------------------------------
//    🤖 3️⃣ AI Fallback — Smarter parsing of Markdown/JSON outputs
// -------------------------------------------------------------*/
//   async lookupFallbackWithAI(upc: string) {
//     try {
//       const prompt = `
//       You are an expert in global retail and barcodes.
//       The barcode number is: ${upc}.
//       Guess what kind of product or brand this might represent based on common manufacturer prefixes.
//       Return JSON only in this exact format:
//       {"name": "Example Product", "brand": "BrandName", "category": "CategoryName"}
//       Do not include code fences or explanations.
//     `;

//       const completion = await this.openai.chat.completions.create({
//         model: 'gpt-4o-mini',
//         messages: [{ role: 'user', content: prompt }],
//         max_tokens: 150,
//       });

//       let text = completion.choices?.[0]?.message?.content?.trim() || '{}';

//       // 🧹 Remove Markdown wrappers if present (```json ... ```)
//       text = text
//         .replace(/```json/gi, '')
//         .replace(/```/g, '')
//         .trim();

//       // 🧩 Parse JSON safely
//       let parsed: any;
//       try {
//         parsed = JSON.parse(text);
//       } catch {
//         // fallback: extract plausible strings if JSON parse fails
//         parsed = {
//           name:
//             text.replace(/["{}]/g, '').split(',')[0]?.trim() ||
//             'Unknown product',
//           brand: 'Unknown',
//           category: 'Misc',
//         };
//       }

//       return {
//         name: parsed.name || 'Unknown product',
//         brand: parsed.brand || 'Unknown',
//         category: parsed.category || 'Misc',
//         source: 'ai-fallback',
//       };
//     } catch (err: any) {
//       console.error('❌ AI fallback failed:', err.message);
//       return {
//         name: 'Unknown product',
//         brand: 'Unknown',
//         category: 'Uncategorized',
//         source: 'ai-fallback',
//       };
//     }
//   }
// }

// // END REPLACED CHAT WITH LINKS AND SEARCH NET

/////////////////////

// import { Injectable } from '@nestjs/common';
// import OpenAI from 'openai';
// import { ChatDto } from './dto/chat.dto';
// import { VertexService } from '../vertex/vertex.service'; // 🔹 ADDED
// import { ProductSearchService } from '../product-services/product-search.service';
// import { Pool } from 'pg';
// import { Express } from 'express';

// const pool = new Pool({
//   connectionString: process.env.DATABASE_URL,
//   ssl: { rejectUnauthorized: false },
// });

// import * as fs from 'fs';
// import * as path from 'path';
// import * as dotenv from 'dotenv';

// function loadOpenAISecrets(): {
//   apiKey?: string;
//   project?: string;
//   source: string;
// } {
//   const candidates = [
//     path.join(process.cwd(), '.env'),
//     path.join(process.cwd(), 'apps', 'backend-nest', '.env'),
//     path.join(__dirname, '..', '..', '.env'),
//   ];

//   for (const p of candidates) {
//     try {
//       if (fs.existsSync(p)) {
//         const parsed = dotenv.parse(fs.readFileSync(p));
//         const apiKey = parsed['OPENAI_API_KEY'];
//         const project = parsed['OPENAI_PROJECT_ID'];
//         if (apiKey) return { apiKey, project, source: p };
//       }
//     } catch {
//       // ignore
//     }
//   }

//   return {
//     apiKey: process.env.OPENAI_API_KEY,
//     project: process.env.OPENAI_PROJECT_ID,
//     source: 'process.env',
//   };
// }

// // 🧥 Basic capsule wardrobe templates
// const CAPSULES = {
//   Spring: [
//     { category: 'Outerwear', subcategory: 'Light Jacket', recommended: 2 },
//     { category: 'Tops', subcategory: 'Oxford Shirt', recommended: 3 },
//     { category: 'Bottoms', subcategory: 'Chinos', recommended: 2 },
//     { category: 'Shoes', subcategory: 'Loafers', recommended: 1 },
//     { category: 'Shoes', subcategory: 'Sneakers', recommended: 1 },
//   ],
//   Summer: [
//     { category: 'Tops', subcategory: 'Short Sleeve Shirt', recommended: 4 },
//     { category: 'Tops', subcategory: 'Polo Shirt', recommended: 2 },
//     { category: 'Bottoms', subcategory: 'Linen Trousers', recommended: 2 },
//     { category: 'Shoes', subcategory: 'Loafers', recommended: 1 },
//     { category: 'Shoes', subcategory: 'Sandals', recommended: 1 },
//   ],
//   Fall: [
//     { category: 'Outerwear', subcategory: 'Field Jacket', recommended: 1 },
//     { category: 'Outerwear', subcategory: 'Blazer', recommended: 1 },
//     { category: 'Tops', subcategory: 'Knit Sweater', recommended: 2 },
//     { category: 'Bottoms', subcategory: 'Wool Trousers', recommended: 2 },
//     { category: 'Shoes', subcategory: 'Chelsea Boots', recommended: 1 },
//   ],
//   Winter: [
//     { category: 'Outerwear', subcategory: 'Overcoat', recommended: 1 },
//     { category: 'Outerwear', subcategory: 'Heavy Parka', recommended: 1 },
//     { category: 'Tops', subcategory: 'Heavy Knit Sweater', recommended: 2 },
//     { category: 'Bottoms', subcategory: 'Wool Trousers', recommended: 2 },
//     { category: 'Shoes', subcategory: 'Boots', recommended: 2 },
//   ],
// };

// // 🗓️ Auto-detect season based on month
// function getCurrentSeason(): 'Spring' | 'Summer' | 'Fall' | 'Winter' {
//   const month = new Date().getMonth() + 1;
//   if ([3, 4, 5].includes(month)) return 'Spring';
//   if ([6, 7, 8].includes(month)) return 'Summer';
//   if ([9, 10, 11].includes(month)) return 'Fall';
//   return 'Winter';
// }

// // 🧠 Compare wardrobe to capsule and return simple forecast text
// function generateSeasonalForecast(wardrobe: any[] = []): string | undefined {
//   const season = getCurrentSeason();
//   const capsule = CAPSULES[season];
//   if (!capsule) return;

//   const missing: string[] = [];

//   capsule.forEach((item) => {
//     const owned = wardrobe.filter(
//       (w) =>
//         w.category?.toLowerCase() === item.category.toLowerCase() &&
//         w.subcategory?.toLowerCase() === item.subcategory.toLowerCase(),
//     ).length;

//     if (owned < item.recommended) {
//       const needed = item.recommended - owned;
//       missing.push(`${needed} × ${item.subcategory}`);
//     }
//   });

//   if (missing.length === 0) {
//     return `✅ Your ${season} capsule is complete — you're ready for the season.`;
//   }

//   return `🍂 ${season} is approaching — you're missing: ${missing.join(', ')}.`;
// }

// @Injectable()
// export class AiService {
//   private openai: OpenAI;
//   private useVertex: boolean;
//   private vertexService?: VertexService; // 🔹 optional instance
//   private productSearch: ProductSearchService; // ✅ add this

//   constructor(vertexService?: VertexService) {
//     const { apiKey, project, source } = loadOpenAISecrets();

//     const snippet = apiKey?.slice(0, 20) ?? '';
//     const len = apiKey?.length ?? 0;
//     console.log('🔑 OPENAI key source:', source);
//     console.log('🔑 OPENAI key snippet:', JSON.stringify(snippet));
//     console.log('🔑 OPENAI key length:', len);
//     console.log('📂 CWD:', process.cwd());

//     if (!apiKey) {
//       throw new Error('OPENAI_API_KEY not found in .env or environment.');
//     }
//     if (/^sk-?x{3,}/i.test(apiKey)) {
//       throw new Error(
//         'OPENAI_API_KEY appears masked (e.g., "sk-xxxxx..."). Read from the correct .env instead.',
//       );
//     }
//     if (!apiKey.startsWith('sk-')) {
//       throw new Error('OPENAI_API_KEY is malformed — must start with "sk-".');
//     }

//     this.openai = new OpenAI({ apiKey, project });

//     // 🔹 New: Vertex toggle
//     this.useVertex = process.env.USE_VERTEX === 'true';
//     if (this.useVertex) {
//       this.vertexService = vertexService;
//       console.log('🧠 Vertex/Gemini mode enabled for analyze/recreate');
//     }

//     this.productSearch = new ProductSearchService(); // NEW
//   }

//   //////ANALYZE LOOK

//   async analyze(imageUrl: string) {
//     console.log('🧠 [AI] analyze() called with', imageUrl);
//     if (!imageUrl) throw new Error('Missing imageUrl');

//     // 🔹 Try Vertex first if enabled
//     if (this.useVertex && this.vertexService) {
//       try {
//         const gcsUri = imageUrl.replace(
//           'https://storage.googleapis.com/',
//           'gs://',
//         );
//         const metadata = await this.vertexService.analyzeImage(gcsUri);
//         const tags = [
//           ...(metadata.tags || []),
//           ...(metadata.style_descriptors || []),
//           metadata.main_category,
//           metadata.subcategory,
//         ].filter(Boolean);
//         console.log('🧠 [Vertex] analyze() success:', tags);
//         return { tags };
//       } catch (err: any) {
//         console.warn(
//           '[Vertex] analyze() failed → fallback to OpenAI:',
//           err.message,
//         );
//       }
//     }

//     // 🔸 OpenAI fallback
//     try {
//       const completion = await this.openai.chat.completions.create({
//         model: 'gpt-4o-mini',
//         messages: [
//           {
//             role: 'system',
//             content:
//               'You are a professional fashion classifier. Return only JSON with a "tags" array describing the outfit’s style, color palette, and vibe.',
//           },
//           {
//             role: 'user',
//             content: [
//               { type: 'text', text: 'Describe this outfit as tags only:' },
//               { type: 'image_url', image_url: { url: imageUrl } },
//             ],
//           },
//         ],
//         response_format: { type: 'json_object' },
//       });

//       const raw = completion.choices[0]?.message?.content;
//       console.log('🧠 [AI] analyze() raw response:', raw);

//       if (!raw) throw new Error('Empty response from OpenAI');
//       const parsed = JSON.parse(raw || '{}');
//       return { tags: parsed.tags || [] };
//     } catch (err: any) {
//       console.error('❌ [AI] analyze() failed:', err.message);
//       return { tags: ['casual', 'modern', 'neutral'] };
//     }
//   }

//   /* ------------------------------------------------------------
//      🧩 Weighted Tag Enrichment + Trend Injection
//   -------------------------------------------------------------*/
//   private async enrichTags(tags: string[]): Promise<string[]> {
//     const weightMap: Record<string, number> = {
//       tailored: 3,
//       minimal: 3,
//       neutral: 3,
//       modern: 2,
//       vintage: 2,
//       classic: 2,
//       streetwear: 2,
//       oversized: 2,
//       slim: 2,
//       relaxed: 2,
//       casual: 1,
//       sporty: 1,
//     };

//     // 🧹 Normalize + de-dupe
//     const cleanTags = Array.from(
//       new Set(
//         tags
//           .map((t) => t.toLowerCase().trim())
//           .filter((t) => t && !['outfit', 'style', 'fashion'].includes(t)),
//       ),
//     );

//     // 🧠 Apply weights
//     const weighted = cleanTags
//       .map((t) => ({ tag: t, weight: weightMap[t] || 1 }))
//       .sort((a, b) => b.weight - a.weight);

//     // 🌍 Inject current trend tags
//     const trendTags = await this.fetchTrendTags();
//     const final = Array.from(
//       new Set([...weighted.map((w) => w.tag), ...trendTags.slice(0, 3)]),
//     );

//     console.log('🎯 [AI] Enriched tags →', final);
//     return final;
//   }

//   private async fetchTrendTags(): Promise<string[]> {
//     try {
//       const res = await fetch(
//         'https://trends.google.com/trends/hottrends/visualize/internal/data/en_us',
//       );
//       if (!res.ok) throw new Error(`HTTP ${res.status}`);
//       const json = await res.json().catch(() => []);
//       const trendWords = JSON.stringify(json).toLowerCase();
//       const matched = trendWords.match(
//         /(quiet luxury|monochrome|minimalism|maximalism|italian|tailoring|loafers|neutrals|linen|structured|preppy|flannel|earth tones|autumn layering)/gi,
//       );
//       if (matched?.length) return Array.from(new Set(matched));

//       // 🧭 If Google Trends returned empty, use local backup
//       return [
//         'quiet luxury',
//         'neutral tones',
//         'tailored fit',
//         'autumn layering',
//       ];
//     } catch (err: any) {
//       console.warn('⚠️ Trend fetch fallback triggered:', err.message);
//       return [
//         'quiet luxury',
//         'neutral tones',
//         'tailored fit',
//         'autumn layering',
//       ];
//     }
//   }

//   // RECREATE//////////////
//   async recreate(
//     user_id: string,
//     tags: string[],
//     image_url?: string,
//     user_gender?: string,
//   ) {
//     console.log(
//       '🧥 [AI] recreate() called for user',
//       user_id,
//       'with tags:',
//       tags,
//       'and gender:',
//       user_gender,
//     );

//     if (!user_id) throw new Error('Missing user_id');
//     if (!tags?.length) {
//       console.warn('⚠️ [AI] recreate() empty tags → using defaults.');
//       tags = ['modern', 'neutral', 'tailored'];
//     }

//     // ✅ Weighted + trend-injected tags
//     tags = await this.enrichTags(tags);

//     // 🧠 Fetch gender_presentation if missing
//     if (!user_gender) {
//       try {
//         const result = await pool.query(
//           'SELECT gender_presentation FROM users WHERE id = $1 LIMIT 1',
//           [user_id],
//         );
//         user_gender = result.rows[0]?.gender_presentation || 'neutral';
//       } catch {
//         user_gender = 'neutral';
//       }
//     }

//     // 🧩 Normalize gender
//     const normalizedGender =
//       user_gender?.toLowerCase().includes('female') ||
//       user_gender?.toLowerCase().includes('woman')
//         ? 'female'
//         : user_gender?.toLowerCase().includes('male') ||
//             user_gender?.toLowerCase().includes('man')
//           ? 'male'
//           : process.env.DEFAULT_GENDER || 'neutral';

//     // 🧠 Build stylist prompt (base)
//     let prompt = `
//         You are a world-class AI stylist for ${normalizedGender} fashion.
//         Create a cohesive outfit inspired by an uploaded look.

//         Client: ${user_id}
//         Image: ${image_url || 'N/A'}
//         Detected tags: ${tags.join(', ')}

//         Rules:
//         - Match fabric, color palette, and silhouette.
//         - Use ${normalizedGender}-appropriate pieces.
//         - Output only JSON:
//         {
//           "outfit": [
//             { "category": "Top", "item": "Grey Cotton Tee", "color": "gray" },
//             { "category": "Bottom", "item": "Navy Chinos", "color": "navy" },
//             { "category": "Outerwear", "item": "Beige Overshirt", "color": "beige" },
//             { "category": "Shoes", "item": "White Sneakers", "color": "white" }
//           ],
//           "style_note": "Describe how the look connects to the uploaded image."
//         }
//         `;

//     // 🔹 Pull soft profile context (optional)
//     let profileCtx = '';
//     try {
//       const res = await pool.query(
//         `SELECT favorite_colors, fit_preferences, preferred_brands, disliked_styles
//        FROM style_profiles WHERE user_id::text = $1 LIMIT 1`,
//         [user_id],
//       );
//       const prof = res.rows[0];
//       if (prof) {
//         profileCtx = `
//       # USER STYLE CONTEXT (soft influence)
//       • Preferred colors: ${(prof.favorite_colors || []).join(', ') || '—'}
//       • Fit preferences: ${(prof.fit_preferences || []).join(', ') || '—'}
//       • Favorite brands: ${(prof.preferred_brands || []).join(', ') || '—'}
//       • Disliked styles: ${prof.disliked_styles || '—'}
//       Do NOT override the image’s vibe — just bias tone/material choices if relevant.
//       `;
//       }
//     } catch {
//       /* silent fail */
//     }

//     // ✅ Final prompt (merge only if context exists)
//     // Inside recreate() or personalizedShop() final prompt:
//     const finalPrompt = `
// ${prompt}

// # HARD RULES
// - ALWAYS output a full outfit of at least 4–6 distinct pieces.
// - Include a Top, Bottom, Outerwear (if seasonally appropriate), Shoes, and optionally 1–2 Accessories.
// - NEVER omit items because they already exist in the user’s wardrobe.
// - Each piece should have its own JSON object, even if similar to a wardrobe item.
// - Always include color and fit for every item.
// `;

//     // 🧠 Generate outfit via Vertex or OpenAI
//     let parsed: any;
//     if (this.useVertex && this.vertexService) {
//       try {
//         const result =
//           await this.vertexService.generateReasonedOutfit(finalPrompt);
//         let text = result?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
//         text = text
//           .replace(/^```json\s*/i, '')
//           .replace(/```$/, '')
//           .trim();
//         parsed = JSON.parse(text);
//         console.log('🧠 [Vertex] recreate() success');
//       } catch (err: any) {
//         console.warn('[Vertex] recreate() failed → fallback', err.message);
//       }
//     }

//     if (!parsed) {
//       const completion = await this.openai.chat.completions.create({
//         model: 'gpt-4o-mini',
//         temperature: 0.7,
//         messages: [{ role: 'user', content: finalPrompt }],
//         response_format: { type: 'json_object' },
//       });

//       const raw = completion.choices[0]?.message?.content || '{}';
//       try {
//         parsed = JSON.parse(raw);
//       } catch {
//         parsed = {};
//       }
//     }

//     const outfit = Array.isArray(parsed?.outfit) ? parsed.outfit : [];
//     const style_note =
//       parsed?.style_note || 'Modern outfit inspired by the uploaded look.';

//     // 🛍️ Enrich each item with live products
//     const enriched = await Promise.all(
//       outfit.map(async (o: any) => {
//         const query =
//           `${normalizedGender} ${o.item || o.category || ''} ${o.color || ''}`.trim();
//         let products = await this.productSearch.search(query);
//         let top = products[0];

//         if (!top?.image || top.image.includes('No_image')) {
//           const serp = await this.productSearch.searchSerpApi(query);
//           if (serp?.[0]) top = { ...serp[0], source: 'SerpAPI' };
//         }

//         const materialHint =
//           query.match(/(wool|cotton|linen|leather|denim|polyester)/i)?.[0] ||
//           null;
//         const seasonalityHint =
//           query.match(/(summer|winter|fall|spring)/i)?.[0] ||
//           getCurrentSeason();
//         const fitHint =
//           query.match(/(slim|regular|relaxed|oversized|tailored)/i)?.[0] ||
//           'regular';

//         return {
//           category: o.category,
//           item: o.item,
//           color: o.color,
//           brand: top?.brand || 'Unknown',
//           price: top?.price || '—',
//           image:
//             top?.image && top.image.startsWith('http')
//               ? top.image
//               : 'https://upload.wikimedia.org/wikipedia/commons/a/ac/No_image_available.svg',
//           shopUrl:
//             top?.shopUrl ||
//             `https://www.google.com/search?q=${encodeURIComponent(query)}&tbm=shop`,
//           source: top?.source || 'ASOS / Fallback',
//           material: materialHint,
//           seasonality: seasonalityHint,
//           fit: fitHint,
//         };
//       }),
//     );

//     return { user_id, outfit: enriched, style_note };
//   }

//   // 🧩 Ensure every product object includes a usable image URL
//   private fixProductImages(products: any[] = []): any[] {
//     return products.map((prod) => ({
//       ...prod,
//       image:
//         prod.image ||
//         prod.image_url ||
//         prod.thumbnail ||
//         prod.serpapi_thumbnail || // ✅ added
//         prod.img ||
//         prod.picture ||
//         prod.thumbnail_url ||
//         'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg',
//     }));
//   }

//   // 👔 PERSONALIZED SHOP — image + wardrobe + preferences
//   async personalizedShop(
//     user_id: string,
//     image_url: string,
//     user_gender?: string,
//   ) {
//     if (!user_id || !image_url) throw new Error('Missing user_id or image_url');

//     /** -----------------------------------------------------------
//      * 🧠 buildProfileConstraints(profile)
//      * Converts full style_profiles record into explicit hard rules
//      * ---------------------------------------------------------- */
//     function buildProfileConstraints(profile: any): string {
//       if (!profile) return '';

//       const fit = Array.isArray(profile.fit_preferences)
//         ? profile.fit_preferences.join(', ')
//         : profile.fit_preferences;

//       const colors = Array.isArray(profile.favorite_colors)
//         ? profile.favorite_colors.join(', ')
//         : profile.favorite_colors;

//       const brands = Array.isArray(profile.preferred_brands)
//         ? profile.preferred_brands.join(', ')
//         : profile.preferred_brands;

//       const styles = [
//         ...(profile.style_keywords || []),
//         ...(profile.style_preferences || []),
//       ]
//         .filter(Boolean)
//         .join(', ');

//       const dislikes =
//         typeof profile.disliked_styles === 'string'
//           ? profile.disliked_styles
//           : (profile.disliked_styles || []).join(', ');

//       const climate = profile.climate || 'Temperate';
//       const goals = profile.goals || '';

//       // 🔹 Inject explicit hard “only color” or “except color” rule for the model itself
//       let colorRule = '';
//       if (profile.disliked_styles?.match(/only\s+(\w+)/i)) {
//         const onlyColor = profile.disliked_styles.match(/only\s+(\w+)/i)[1];
//         colorRule = `• Use ONLY ${onlyColor} items — all other colors are forbidden.`;
//       } else if (profile.disliked_styles?.match(/except\s+(\w+)/i)) {
//         const exceptColor = profile.disliked_styles.match(/except\s+(\w+)/i)[1];
//         colorRule = `• Exclude every color except ${exceptColor}.`;
//       }

//       // 🔹 Explicitly enforce fit preferences
//       let fitRule = '';
//       if (profile.fit_preferences?.length) {
//         fitRule = `• Allow ONLY these fits: ${profile.fit_preferences.join(
//           ', ',
//         )}; exclude all others.`;
//       }

//       return `
// # USER PROFILE CONSTRAINTS (Hard Rules)

// ${fitRule}
// ${colorRule}

// • Fit: ${fit || 'Regular fit'} — outfit items must match this silhouette; exclude all opposing fits.
// • Climate: ${climate} — use materials and layers appropriate to this temperature zone.
// • Preferred brands: ${brands || '—'} — bias all product searches toward these or comparable aesthetics.
// • Favorite colors: ${colors || '—'} — bias color palette to these tones; avoid disliked colors.
// • Disliked styles: ${dislikes || '—'} — exclude these aesthetics entirely.
// • Style & vibe keywords: ${styles || '—'} — reflect these qualities in overall tone and accessories.
// • Goals: ${goals}
// • Body & proportions: ${profile.body_type || '—'}, ${
//         profile.proportions || '—'
//       } — ensure silhouette and layering suit these proportions.
// • Skin tone / hair / eyes: ${profile.skin_tone || '—'}, ${
//         profile.hair_color || '—'
//       }, ${profile.eye_color || '—'} — choose tones that complement.
// `;
//     }

//     // 1) Analyze uploaded image
//     const analysis = await this.analyze(image_url);
//     const tags = analysis?.tags || [];

//     //   const { rows: wardrobe } = await pool.query(
//     //     `SELECT name, main_category AS category, subcategory, color, material
//     //  FROM wardrobe_items
//     //  WHERE user_id::text = $1
//     //  ORDER BY updated_at DESC
//     //  LIMIT 50`,
//     //     [user_id],
//     //   );

//     // 🚫 Skip wardrobe entirely for personalized mode
//     const wardrobe: any[] = [];

//     const prefRes = await pool.query(
//       `SELECT gender_presentation
//      FROM users
//      WHERE id = $1
//      LIMIT 1`,
//       [user_id],
//     );
//     const profile = prefRes.rows[0] || {};
//     const gender = user_gender || profile.gender_presentation || 'neutral';
//     // 2️⃣ Fetch user style profile (full data used for personalization)
//     const styleProfileRes = await pool.query(
//       `
//   SELECT
//     body_type,
//     skin_tone,
//     undertone,
//     climate,
//     favorite_colors,
//     disliked_styles,
//     style_keywords,
//     preferred_brands,
//     goals,
//     proportions,
//     hair_color,
//     eye_color,
//     height,
//     waist,
//     fit_preferences,
//     style_preferences
//   FROM style_profiles
//   WHERE user_id::text = $1
//   LIMIT 1
// `,
//       [user_id],
//     );

//     const styleProfile = styleProfileRes.rows[0] || {};

//     // 🔹 Build user filter preferences
//     const { preferFit, bannedWords } = buildUserFilter(styleProfile);

//     /* ------------------------------------------------------------
//    🎛️ VISUAL + STYLE FILTERING HELPERS
// -------------------------------------------------------------*/
//     const FIT_KEYWORDS = {
//       skinny: [/skinny/i, /super[- ]skinny/i, /spray[- ]on/i],
//       slim: [/slim/i],
//       tailored: [/tailored/i, /tapered/i],
//       relaxed: [/relaxed/i, /loose/i, /baggy/i, /wide[- ]leg/i],
//       oversized: [/oversized/i, /boxy/i],
//     };

//     function buildUserFilter(profile: any) {
//       const fitPrefs = (profile.fit_preferences || []).map((x: string) =>
//         x.toLowerCase(),
//       );
//       const disliked = (profile.disliked_styles || '')
//         .toLowerCase()
//         .split(/[,\s]+/)
//         .filter(Boolean);
//       const favColors = (profile.favorite_colors || []).map((x: string) =>
//         x.toLowerCase(),
//       );

//       const preferFit =
//         fitPrefs.find((f) => /(relaxed|loose|baggy|oversized|boxy)/.test(f)) ||
//         fitPrefs.find((f) => /(regular|tailored)/.test(f)) ||
//         fitPrefs[0] ||
//         null;

//       const banFits: string[] = [];
//       if (preferFit?.match(/relaxed|loose|baggy|oversized|boxy/))
//         banFits.push('skinny', 'slim');
//       else if (preferFit?.match(/skinny|slim/))
//         banFits.push('relaxed', 'baggy', 'oversized');

//       const bannedWords = [
//         ...disliked,
//         ...banFits,
//         ...(!favColors.includes('green') ? ['green'] : []),
//       ]
//         .filter(Boolean)
//         .map((x) => new RegExp(x, 'i'));

//       return { preferFit, bannedWords };
//     }

//     function enforceProfileFilters(
//       products: any[] = [],
//       preferFit?: string | null,
//       bannedWords: RegExp[] = [],
//     ) {
//       if (!products.length) return products;

//       return products
//         .filter((p) => {
//           const hay = `${p.title || ''} ${p.name || ''} ${p.description || ''}`;
//           return !bannedWords.some((rx) => rx.test(hay));
//         })
//         .sort((a, b) => {
//           if (!preferFit) return 0;
//           const aHit = FIT_KEYWORDS[preferFit]?.some((rx) =>
//             rx.test(`${a.title} ${a.name}`),
//           )
//             ? 1
//             : 0;
//           const bHit = FIT_KEYWORDS[preferFit]?.some((rx) =>
//             rx.test(`${b.title} ${b.name}`),
//           )
//             ? 1
//             : 0;
//           return bHit - aHit; // boost preferred fits
//         });
//     }

//     // 3) Ask model to split into "owned" vs "missing"

//     const climateNote = styleProfile.climate
//       ? `The user's climate is ${styleProfile.climate}.
//     If it is cold (like Polar or Cold), emphasize insulated materials, coats, layers, scarves, gloves, and boots.
//     If it is hot (like Tropical or Desert), emphasize breathable, lightweight fabrics and open footwear.`
//       : '';

//     // 🔒 Enforced personalization hierarchy
//     const rules = `
//     # PERSONALIZATION ENFORCEMENT
//     Follow these user preferences as *absolute constraints*, not suggestions.
//     `;

//     const profileConstraints = buildProfileConstraints(styleProfile);

//     const prompt = `
// You are a world-class personal stylist generating a personalized recreation of an uploaded look.
// ${rules}
// ${profileConstraints}

// # IMAGE INSPIRATION
// • Use the uploaded image only as an aesthetic anchor (color story, silhouette, or texture).
// • Do NOT reference or reuse the user's wardrobe.
// • Respect all style profile constraints exactly.
// • Maintain the same mood and spirit as the uploaded image, not a literal copy.
// • Preserve one clear visual motif from the source image (e.g., plaid pattern or color tone) unless climate prohibits.

// # OUTPUT RULES
// - ALWAYS output a complete outfit with distinct Top, Bottom, Shoes, and (if seasonally appropriate) Outerwear and Accessories.
// - Each piece must include category, item, color, and fit.

// Return ONLY valid JSON:
// {
//   "recreated_outfit": [
//     { "source":"purchase", "category":"Top", "item":"...", "color":"...", "fit":"..." }
//   ],
//   "suggested_purchases": [
//     { "category":"...", "item":"...", "color":"...", "material":"...", "brand":"...", "shopUrl":"..." }
//   ],
//   "style_note": "Explain how this respects the user's climate, fit, and taste."
// }

// User gender: ${gender}
// Detected tags: ${tags.join(', ')}
// Weighted tags: ${tags.map((t) => `high priority: ${t}`).join(', ')}
// User style profile: ${JSON.stringify(styleProfile, null, 2)}
// ${climateNote}
// `;

//     console.log('🧥 [personalizedShop] profile:', profile);
//     console.log('🧥 [personalizedShop] gender:', gender);
//     console.log('🧥 [personalizedShop] styleProfile:', styleProfile);
//     console.log('🧠 [personalizedShop] Prompt preview:', prompt.slice(0, 800));

//     // 🧠 DEBUG START — prompt verification
//     console.log('─────────────── PROMPT SENT TO MODEL ───────────────');
//     console.log(prompt);
//     console.log('─────────────── END PROMPT ───────────────');

//     const completion = await this.openai.chat.completions.create({
//       model: 'gpt-4o-mini',
//       temperature: 0.7,
//       messages: [{ role: 'user', content: prompt }],
//       response_format: { type: 'json_object' },
//     });

//     // 🧠 DEBUG END — raw model output
//     console.log('─────────────── RAW MODEL RESPONSE ───────────────');
//     console.log(completion.choices[0]?.message?.content);
//     console.log('─────────────── END RESPONSE ───────────────');

//     let parsed: any = {};
//     try {
//       parsed = JSON.parse(completion.choices[0]?.message?.content || '{}');

//       // 🧩 SAFETY GUARD — ensure we keep valid recreated_outfit
//       try {
//         const parsedKeys = Object.keys(parsed);
//         console.log('✅ [personalizedShop] Parsed JSON keys:', parsedKeys);

//         // If model used "outfit" instead of "recreated_outfit", normalize it
//         if (!parsed.recreated_outfit && parsed.outfit) {
//           parsed.recreated_outfit = parsed.outfit;
//           console.log('✅ [personalizedShop] Mapped outfit → recreated_outfit');
//         }

//         // Double-check array validity before fallback clears it
//         if (parsed.recreated_outfit && parsed.recreated_outfit.length > 0) {
//           console.log(
//             '✅ [personalizedShop] Using recreated_outfit from model',
//           );
//         } else {
//           console.warn(
//             '⚠️ [personalizedShop] No recreated_outfit found — fallback may trigger',
//           );
//         }
//       } catch (err) {
//         console.error(
//           '❌ [personalizedShop] JSON structure guard failed:',
//           err,
//         );
//       }

//       // ✅ Final filter fix — keep wardrobe items but still respect banned fits/styles
//       if (parsed?.recreated_outfit?.length) {
//         parsed.recreated_outfit = parsed.recreated_outfit.filter((o: any) => {
//           if (!o) return false;
//           const text =
//             `${o.item} ${o.category} ${o.color} ${o.fit}`.toLowerCase();
//           if (!text.trim() || text.includes('undefined')) return false;
//           // ✅ Always keep wardrobe items regardless of style bans
//           if (o.source === 'wardrobe') return true;

//           const fitBan = preferFit?.match(/relaxed|oversized|boxy|loose/)
//             ? ['skinny']
//             : preferFit?.match(/skinny|slim|tailored/)
//               ? ['relaxed', 'baggy', 'oversized']
//               : [];

//           const styleBan =
//             (styleProfile.disliked_styles || '')
//               .toLowerCase()
//               .split(/[,\s]+/)
//               .filter(Boolean) || [];

//           const banned = [...fitBan, ...styleBan];
//           return !banned.some((b) => text.includes(b));
//         });

//         console.log(
//           '✅ [personalizedShop] Final filtered outfit →',
//           parsed.recreated_outfit,
//         );
//       }

//       console.log(
//         '💎 [personalizedShop] Parsed recreated outfit sample:',
//         parsed?.recreated_outfit?.slice(0, 2),
//       );
//       console.log(
//         '💎 [personalizedShop] Parsed suggested purchases sample:',
//         parsed?.suggested_purchases?.slice(0, 2),
//       );

//       // 🧩 Merge recreated_outfit into suggested_purchases for display
//       if (
//         Array.isArray(parsed?.recreated_outfit) &&
//         parsed.recreated_outfit.length
//       ) {
//         parsed.suggested_purchases = [
//           ...(parsed.suggested_purchases || []),
//           ...parsed.recreated_outfit.map((o: any) => ({
//             ...o,
//             brand: o.brand || '—',
//             previewImage: o.previewImage || o.image || o.image_url || null,
//             source: 'purchase',
//           })),
//         ];
//         console.log(
//           '🧩 [personalizedShop] merged recreated_outfit → suggested_purchases',
//         );
//       }

//       // 🖼️ Ensure every recreated outfit item has a visible preview image
//       if (Array.isArray(parsed?.recreated_outfit)) {
//         parsed.recreated_outfit = parsed.recreated_outfit.map((item: any) => {
//           if (!item.previewImage && item.source === 'wardrobe') {
//             item.previewImage =
//               item.image_url ||
//               item.wardrobe_image ||
//               'https://upload.wikimedia.org/wikipedia/commons/a/ac/No_image_available.svg';
//           }
//           return item;
//         });
//       }

//       // 🎨 Enforce "only <color>" rule from disliked_styles (e.g. "I dislike all colors except pink")
//       // 🎨 Optional color-only enforcement — only if explicit "ONLY <color>" flag exists
//       if (styleProfile?.disliked_styles?.toLowerCase().includes('only')) {
//         const match = styleProfile.disliked_styles.match(/only\s+(\w+)/i);
//         if (match) {
//           const onlyColor = match[1].toLowerCase();
//           const filterColor = (arr: any[]) =>
//             arr.filter((x) =>
//               (x.color || '').toLowerCase().includes(onlyColor),
//             );

//           if (Array.isArray(parsed?.recreated_outfit))
//             parsed.recreated_outfit = filterColor(parsed.recreated_outfit);
//           if (Array.isArray(parsed?.suggested_purchases))
//             parsed.suggested_purchases = filterColor(
//               parsed.suggested_purchases,
//             );

//           console.log(
//             `[personalizedShop] 🎨 Enforcing ONLY-color rule: ${onlyColor}`,
//           );
//         }
//       }
//     } catch {
//       parsed = {};
//     }

//     const purchases = Array.isArray(parsed?.suggested_purchases)
//       ? parsed.suggested_purchases
//       : [];

//     if (parsed?.recreated_outfit?.some((i: any) => i.source === 'wardrobe')) {
//       console.log('🧥 [personalizedShop] ✅ Model reused wardrobe pieces.');
//     } else {
//       console.warn(
//         '🧥 [personalizedShop] ⚠️ Model did NOT reuse wardrobe — fallback to generic recreation.',
//       );
//     }

//     // 🚫 Enforce profile bans in returned outfit
//     const banned = [
//       ...(styleProfile.disliked_styles?.toLowerCase().split(/[,\s]+/) || []),
//       ...(preferFit?.match(/relaxed|oversized|boxy|loose/)
//         ? ['skinny', 'slim']
//         : []),
//       ...(preferFit?.match(/skinny|slim/)
//         ? ['relaxed', 'oversized', 'baggy']
//         : []),
//     ].filter(Boolean);

//     if (parsed?.recreated_outfit?.length) {
//       // ✅ Keep *all* wardrobe and purchase items — only filter garbage entries
//       parsed.recreated_outfit = parsed.recreated_outfit.filter((o: any) => {
//         if (!o || !o.item) return false;
//         const text =
//           `${o.item} ${o.category} ${o.color} ${o.fit}`.toLowerCase();
//         return text.trim().length > 0 && !text.includes('undefined');
//       });

//       // 🧱 Guarantee full outfit completeness (Top, Bottom, Shoes, Optional Outerwear/Accessory)
//       const categories = parsed.recreated_outfit.map((o: any) =>
//         o.category?.toLowerCase(),
//       );
//       const missing: any[] = [];

//       if (!categories.includes('top'))
//         missing.push({
//           source: 'purchase',
//           category: 'Top',
//           item: 'White Oxford Shirt',
//           color: 'White',
//           fit: 'Slim Fit',
//         });
//       if (!categories.includes('bottoms'))
//         missing.push({
//           source: 'purchase',
//           category: 'Bottoms',
//           item: 'Beige Chinos',
//           color: 'Beige',
//           fit: 'Slim Fit',
//         });
//       if (!categories.includes('shoes'))
//         missing.push({
//           source: 'purchase',
//           category: 'Shoes',
//           item: 'White Leather Sneakers',
//           color: 'White',
//           fit: 'Slim Fit',
//         });

//       parsed.recreated_outfit.push(...missing);

//       console.log(
//         '✅ [personalizedShop] Final full outfit →',
//         parsed.recreated_outfit,
//       );
//     }

//     // 🧩 Centralized enforcement for personalizedShop only
//     function applyProfileFilters(products: any[], profile: any) {
//       if (!Array.isArray(products) || !products.length) return [];

//       const favColors = (profile.favorite_colors || []).map((x: string) =>
//         x.toLowerCase(),
//       );
//       const prefBrands = (profile.preferred_brands || []).map((x: string) =>
//         x.toLowerCase(),
//       );
//       const fitPrefs = (profile.fit_preferences || []).map((x: string) =>
//         x.toLowerCase(),
//       );
//       const dislikes = (profile.disliked_styles || '')
//         .toLowerCase()
//         .split(/[,\s]+/);
//       const climate = (profile.climate || '').toLowerCase();

//       const isCold = /(polar|cold|arctic|tundra|winter)/.test(climate);
//       const isHot = /(tropical|desert|hot|humid|summer)/.test(climate);

//       // 🩷 detect "only" or "except" color rule from disliked_styles
//       let onlyColor: string | null = null;
//       let exceptColor: string | null = null;

//       if (profile.disliked_styles?.match(/only\s+(\w+)/i)) {
//         onlyColor = profile.disliked_styles
//           .match(/only\s+(\w+)/i)[1]
//           .toLowerCase();
//       } else if (profile.disliked_styles?.match(/except\s+(\w+)/i)) {
//         exceptColor = profile.disliked_styles
//           .match(/except\s+(\w+)/i)[1]
//           .toLowerCase();
//       }

//       return products
//         .filter((p) => {
//           const t = `${p.name ?? ''} ${p.title ?? ''} ${p.brand ?? ''} ${
//             p.description ?? ''
//           } ${p.color ?? ''} ${p.fit ?? ''}`.toLowerCase();

//           // 🚫 Filter out disliked words/styles
//           if (dislikes.some((d) => d && t.includes(d))) return false;

//           // 🎨 HARD color enforcement from DB rules
//           if (onlyColor) {
//             // Only allow if text or color includes the specified color
//             if (
//               !t.includes(onlyColor) &&
//               !p.color?.toLowerCase().includes(onlyColor)
//             )
//               return false;
//           } else if (exceptColor) {
//             // Exclude everything not matching that color
//             if (
//               !t.includes(exceptColor) &&
//               !p.color?.toLowerCase().includes(exceptColor)
//             )
//               return false;
//           } else {
//             // Normal favorite color bias if no hard rule
//             if (favColors.length && !favColors.some((c) => t.includes(c)))
//               return false;
//           }

//           // 👕 Fit preferences
//           if (fitPrefs.length && !fitPrefs.some((f) => t.includes(f)))
//             return false;

//           // 🌡️ Climate-based filtering
//           if (isCold && /(tank|shorts|sandal)/.test(t)) return false;
//           if (isHot && /(wool|parka|coat|boot|knit)/.test(t)) return false;

//           return true;
//         })
//         .sort((a, b) => {
//           const score = (x: any) => {
//             const txt =
//               `${x.name} ${x.title} ${x.brand} ${x.color} ${x.fit}`.toLowerCase();
//             let s = 0;
//             if (onlyColor && txt.includes(onlyColor)) s += 4;
//             if (exceptColor && txt.includes(exceptColor)) s += 4;
//             if (favColors.some((c) => txt.includes(c))) s += 2;
//             if (prefBrands.some((b) => txt.includes(b))) s += 2;
//             if (fitPrefs.some((f) => txt.includes(f))) s += 1;
//             return s;
//           };
//           return score(b) - score(a);
//         });
//     }

//     // 4️⃣ Attach live shop links to the "missing" items — now honoring user taste
//     let enrichedPurchases = await Promise.all(
//       purchases.map(async (p: any) => {
//         // 🧠 Gender-locked prefix
//         const genderPrefix =
//           gender?.toLowerCase().includes('female') ||
//           gender?.toLowerCase().includes('woman')
//             ? 'women female womens ladies'
//             : 'men male mens masculine -women -womens -female -girls -ladies';

//         // Base query with gender lock
//         let q = [
//           genderPrefix,
//           p.item || p.category || '',
//           p.color || '',
//           p.material || '',
//         ]
//           .filter(Boolean)
//           .join(' ')
//           .trim();

//         // 🔹 Inject personalization bias terms
//         const brandTerms = (styleProfile.preferred_brands || [])
//           .slice(0, 3)
//           .join(' ');
//         const colorTerms = (styleProfile.favorite_colors || [])
//           .slice(0, 2)
//           .join(' ');
//         const fitTerms = Array.isArray(styleProfile.fit_preferences)
//           ? styleProfile.fit_preferences.join(' ')
//           : styleProfile.fit_preferences || '';

//         // 🎨 “Only color” rule (e.g. “I dislike all colors except pink”)
//         const colorMatch =
//           styleProfile.disliked_styles?.match(/except\s+(\w+)/i);
//         if (colorMatch) {
//           const onlyColor = colorMatch[1].toLowerCase();
//           q += ` ${onlyColor}`;
//         }

//         // Combine into final query with brand + color + fit bias
//         q = [q, brandTerms, colorTerms, fitTerms].filter(Boolean).join(' ');

//         // 🔒 Ensure all queries exclude female results explicitly
//         if (
//           !/-(women|female|ladies|girls)/i.test(q) &&
//           /\bmen\b|\bmale\b/i.test(q)
//         ) {
//           q += ' -women -womens -female -girls -ladies';
//         }

//         // Combine into final query with brand + color + fit bias
//         q = [q, brandTerms, colorTerms, fitTerms].filter(Boolean).join(' ');

//         // 🔒 Ensure all queries exclude female results explicitly
//         if (
//           !/-(women|female|ladies|girls)/i.test(q) &&
//           /\bmen\b|\bmale\b/i.test(q)
//         ) {
//           q += ' -women -womens -female -girls -ladies';
//         }

//         // 🧠 Gender-aware product search
//         let products = await this.productSearch.search(
//           q,
//           gender?.toLowerCase() === 'female'
//             ? 'female'
//             : gender?.toLowerCase() === 'male'
//               ? 'male'
//               : 'unisex',
//         );

//         // 🚫 Filter out any accidental female/unisex results
//         products = products.filter(
//           (prod) =>
//             !/women|female|womens|ladies|girls/i.test(
//               `${prod.name ?? ''} ${prod.brand ?? ''} ${prod.title ?? ''}`,
//             ),
//         );

//         // 🩷 Hard visual color filter — ensures displayed products actually match the enforced color rule
//         if (
//           styleProfile?.disliked_styles?.match(/only\s+(\w+)/i) ||
//           styleProfile?.disliked_styles?.match(/except\s+(\w+)/i)
//         ) {
//           const match =
//             styleProfile.disliked_styles.match(/only\s+(\w+)/i) ||
//             styleProfile.disliked_styles.match(/except\s+(\w+)/i);
//           const enforcedColor = match?.[1]?.toLowerCase();
//           if (enforcedColor) {
//             products = products.filter((p) => {
//               const text =
//                 `${p.name ?? ''} ${p.title ?? ''} ${p.color ?? ''}`.toLowerCase();
//               return text.includes(enforcedColor);
//             });
//           }
//         }

//         return {
//           ...p,
//           query: q,
//           products: applyProfileFilters(products, styleProfile),
//         };
//       }),
//     );

//     // 5️⃣ Fallback enrichment if AI returned nothing or products failed
//     if (!enrichedPurchases.length) {
//       console.warn(
//         '⚠️ [personalizedShop] Empty suggested_purchases → fallback.',
//       );

//       const tagSeed = tags.slice(0, 6).join(' ');
//       const season = getCurrentSeason();

//       // 🧠 Gender prefix for fallback with hard lock
//       const genderPrefix =
//         gender?.toLowerCase().includes('female') ||
//         gender?.toLowerCase().includes('woman')
//           ? 'women female womens ladies'
//           : 'men male mens masculine -women -womens -female -girls -ladies';

//       // 🧠 Enrich fallback with style taste as well
//       const brandTerms = (styleProfile.preferred_brands || [])
//         .slice(0, 3)
//         .join(' ');
//       const colorTerms = (styleProfile.favorite_colors || [])
//         .slice(0, 2)
//         .join(' ');
//       const fitTerms = Array.isArray(styleProfile.fit_preferences)
//         ? styleProfile.fit_preferences.join(' ')
//         : styleProfile.fit_preferences || '';

//       const fallbackQuery = `${genderPrefix} ${tagSeed} ${season} fashion ${brandTerms} ${colorTerms} ${fitTerms}`;
//       console.log('🧩 [personalizedShop] fallbackQuery →', fallbackQuery);

//       const products = await this.productSearch.search(
//         fallbackQuery,
//         gender?.toLowerCase() === 'female'
//           ? 'female'
//           : gender?.toLowerCase() === 'male'
//             ? 'male'
//             : 'unisex',
//       );

//       // 🚫 Filter out any accidental female/unisex results
//       const maleProducts = products.filter(
//         (prod) =>
//           !/women|female|womens|ladies|girls/i.test(
//             `${prod.name ?? ''} ${prod.brand ?? ''} ${prod.title ?? ''}`,
//           ),
//       );

//       enrichedPurchases = [
//         {
//           category: 'General',
//           item: 'Curated Outfit Add-Ons',
//           color: 'Mixed',
//           material: null,
//           products: applyProfileFilters(maleProducts.slice(0, 8), styleProfile),
//           query: fallbackQuery,
//           source: 'fallback',
//         },
//       ];
//     }

//     // 🎨 Enforce color-only rule on fallback products too
//     if (styleProfile?.disliked_styles) {
//       const match = styleProfile.disliked_styles.match(/except\s+(\w+)/i);
//       if (match) {
//         const onlyColor = match[1].toLowerCase();
//         enrichedPurchases = enrichedPurchases.map((p) => ({
//           ...p,
//           products: (p.products || []).filter((prod) =>
//             (prod.color || '').toLowerCase().includes(onlyColor),
//           ),
//         }));
//         console.log(
//           `[personalizedShop] 🎨 Enforced fallback color-only rule: ${onlyColor}`,
//         );
//       }
//     }

//     const cleanPurchases = enrichedPurchases.map((p) => ({
//       ...p,
//       products: this.fixProductImages(
//         enforceProfileFilters(p.products || [], preferFit, bannedWords),
//       ),
//     }));

//     // 🎨 FINAL VISUAL CONSISTENCY NORMALIZATION
//     const normalizedPurchases = await Promise.all(
//       enrichedPurchases.map(async (p) => {
//         const validProduct =
//           (p.products || []).find(
//             (x) =>
//               (x.image ||
//                 x.image_url ||
//                 x.thumbnail ||
//                 x.serpapi_thumbnail ||
//                 x.thumbnail_url ||
//                 x.img ||
//                 x.result?.thumbnail ||
//                 x.result?.serpapi_thumbnail) &&
//               /^https?:\/\//.test(
//                 x.image ||
//                   x.image_url ||
//                   x.thumbnail ||
//                   x.serpapi_thumbnail ||
//                   x.thumbnail_url ||
//                   x.img ||
//                   x.result?.thumbnail ||
//                   x.result?.serpapi_thumbnail ||
//                   '',
//               ) &&
//               !/no[_-]?image/i.test(
//                 x.image ||
//                   x.image_url ||
//                   x.thumbnail ||
//                   x.serpapi_thumbnail ||
//                   x.thumbnail_url ||
//                   x.img ||
//                   '',
//               ),
//           ) || p.products?.[0];

//         let previewImage =
//           validProduct?.image ||
//           validProduct?.image_url ||
//           validProduct?.thumbnail ||
//           validProduct?.serpapi_thumbnail ||
//           validProduct?.thumbnail_url ||
//           validProduct?.img ||
//           validProduct?.product_thumbnail ||
//           validProduct?.result?.thumbnail ||
//           validProduct?.result?.serpapi_thumbnail ||
//           null;

//         // 🎯 Gender-aware image guard
//         const userGender = (gender || '').toLowerCase();

//         if (previewImage) {
//           const url = previewImage.toLowerCase();

//           // 🧍‍♂️ If male → block clearly female-coded URLs
//           if (
//             userGender.includes('male') &&
//             /(women|woman|female|ladies|girls|womenswear|femme|skims|shein|fashionnova|princesspolly|revolve|anthropologie)/i.test(
//               url,
//             )
//           ) {
//             previewImage =
//               'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg';
//           }

//           // 🧍‍♀️ If female → block clearly male-coded URLs
//           else if (
//             userGender.includes('female') &&
//             /(men|man|male|menswear|masculine)/i.test(url)
//           ) {
//             previewImage =
//               'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg';
//           }

//           // 🧍 Unisex → allow all images
//         }

//         // 🧠 If still missing, do a quick SerpAPI lookup and cache
//         if (!previewImage && p.query) {
//           const results = await this.productSearch.searchSerpApi(p.query);
//           const r = results?.[0];
//           previewImage =
//             r?.image ||
//             r?.image_url ||
//             r?.thumbnail ||
//             r?.serpapi_thumbnail ||
//             r?.thumbnail_url ||
//             r?.result?.thumbnail ||
//             r?.result?.serpapi_thumbnail ||
//             null;

//           // 🎯 Apply same gender guard to SerpAPI result
//           if (previewImage) {
//             const url = previewImage.toLowerCase();

//             if (
//               userGender.includes('male') &&
//               /(women|woman|female|ladies|girls|womenswear|femme|skims|shein|fashionnova|princesspolly|revolve|anthropologie)/i.test(
//                 url,
//               )
//             ) {
//               previewImage =
//                 'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg';
//             } else if (
//               userGender.includes('female') &&
//               /(men|man|male|menswear|masculine)/i.test(url)
//             ) {
//               previewImage =
//                 'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg';
//             }
//           }
//         }

//         return {
//           ...p,
//           previewImage:
//             previewImage ||
//             'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg',
//           previewBrand: validProduct?.brand || p.brand || 'Unknown',
//           previewPrice: validProduct?.price || '—',
//           previewUrl: validProduct?.shopUrl || p.shopUrl || null,
//         };
//       }),
//     ); // ✅ ← closes Promise.all()

//     // 🧹 remove empty product groups (no valid images)
//     const filteredPurchases = normalizedPurchases.filter(
//       (p) => !!p.previewImage,
//     );

//     // 🧊 Climate sanity check — if Polar but outfit lacks insulation, patch style_note
//     if (
//       styleProfile.climate?.toLowerCase().includes('polar') &&
//       !/coat|jacket|parka|boot|knit|sweater/i.test(
//         JSON.stringify(parsed.recreated_outfit || []),
//       )
//     ) {
//       parsed.style_note +=
//         ' Reinforced with insulated outerwear and cold-weather layering for Polar climates.';
//     }

//     // 🚫 Prevent fallback or secondary recreate() from overwriting personalized flow
//     if (
//       enrichedPurchases?.length > 0 ||
//       parsed?.suggested_purchases?.length > 0
//     ) {
//       console.log(
//         '✅ [personalizedShop] Finalizing personalized results — skipping generic recreate()',
//       );
//       return {
//         user_id,
//         image_url,
//         tags,
//         recreated_outfit: parsed?.recreated_outfit || [],
//         suggested_purchases: normalizedPurchases,
//         style_note:
//           parsed?.style_note ||
//           'Personalized recreation based on your wardrobe, with curated seasonal add-ons.',
//         applied_filters: {
//           preferFit,
//           bannedWords: bannedWords.map((r) => r.source),
//         },
//       };
//     }

//     return {
//       user_id,
//       image_url,
//       tags,
//       recreated_outfit: parsed?.recreated_outfit || [],
//       suggested_purchases: normalizedPurchases,
//       style_note:
//         parsed?.style_note ||
//         'Personalized recreation based on your wardrobe, with curated seasonal add-ons.',
//       applied_filters: {
//         preferFit,
//         bannedWords: bannedWords.map((r) => r.source),
//       },
//     };
//   }

//   ////////END CREATE LOOK

//   //////. START REPLACED CHAT WITH LINKS AND SEARCH NET

//   /** 🧠 Conversational fashion chat — now with visuals + links */
//   async chat(dto: ChatDto) {
//     const { messages } = dto;
//     const lastUserMsg = messages
//       .slice()
//       .reverse()
//       .find((m) => m.role === 'user')?.content;

//     if (!lastUserMsg) {
//       throw new Error('No user message provided');
//     }

//     // 1️⃣ Generate base text with OpenAI
//     const completion = await this.openai.chat.completions.create({
//       model: 'gpt-4o',
//       temperature: 0.8,
//       messages: [
//         {
//           role: 'system',
//           content: `
// You are a world-class personal fashion stylist.
// Respond naturally and helpfully about outfits, wardrobe planning, or styling.
// At the end of your reasoning, also return a short JSON block like:
// {"search_terms":["smart casual men","navy blazer outfit","loafers"]}
//         `,
//         },
//         ...messages,
//       ],
//     });

//     const aiReply =
//       completion.choices[0]?.message?.content?.trim() ||
//       'Styled response unavailable.';

//     // 2️⃣ Extract search terms if model provided them
//     let searchTerms: string[] = [];
//     const match = aiReply.match(/\{.*"search_terms":.*\}/s);
//     if (match) {
//       try {
//         const parsed = JSON.parse(match[0]);
//         searchTerms = parsed.search_terms ?? [];
//       } catch {
//         searchTerms = [];
//       }
//     }

//     // 3️⃣ Fallback heuristic: derive terms if none found
//     if (!searchTerms.length) {
//       const lowered = lastUserMsg.toLowerCase();
//       if (lowered.includes('smart')) searchTerms.push('smart casual outfit');
//       if (lowered.includes('summer')) searchTerms.push('summer outfit');
//       if (lowered.includes('work')) searchTerms.push('business casual look');
//       if (!searchTerms.length)
//         searchTerms.push(`${lowered} outfit inspiration`);
//     }

//     // 4️⃣ Fetch Unsplash images
//     const images = await this.fetchUnsplash(searchTerms);

//     // 5️⃣ Build shoppable links
//     const links = searchTerms.map((term) => ({
//       label: `Shop ${term} on ASOS`,
//       url: `https://www.asos.com/search/?q=${encodeURIComponent(term)}`,
//     }));

//     return { reply: aiReply, images, links };
//   }

//   /** 🔍 Lightweight Unsplash fetch helper */
//   private async fetchUnsplash(terms: string[]) {
//     const key = process.env.UNSPLASH_ACCESS_KEY;
//     if (!key || !terms.length) return [];
//     const q = encodeURIComponent(terms[0]);
//     const res = await fetch(
//       `https://api.unsplash.com/search/photos?query=${q}&per_page=5&client_id=${key}`,
//     );
//     if (!res.ok) return [];
//     const json = await res.json();
//     return json.results.map((r) => ({
//       imageUrl: r.urls.small,
//       title: r.description || r.alt_description,
//       sourceLink: r.links.html,
//     }));
//   }

//   /** 🌤️ Suggest daily style plan */
//   async suggest(body: {
//     user?: string;
//     weather?: any;
//     wardrobe?: any[];
//     preferences?: Record<string, any>;
//   }) {
//     const { user, weather, wardrobe, preferences } = body;

//     const temp = weather?.fahrenheit?.main?.temp;
//     const tempDesc = temp
//       ? `${temp}°F and ${temp < 60 ? 'cool' : temp > 85 ? 'warm' : 'mild'} weather`
//       : 'unknown temperature';

//     const wardrobeCount = wardrobe?.length || 0;

//     const systemPrompt = `
// You are a luxury personal stylist.
// Your goal is to provide a daily style briefing that helps the user feel prepared, stylish, and confident.
// Be concise, intelligent, and polished — similar to a stylist at a high-end menswear brand.

// Output must be JSON with:
// - suggestion
// - insight
// - tomorrow
// Optionally include seasonalForecast, lifecycleForecast, styleTrajectory.
// `;

//     const userPrompt = `
// Client: ${user || 'The user'}
// Weather: ${tempDesc}
// Wardrobe items: ${wardrobeCount}
// Preferences: ${JSON.stringify(preferences || {})}
// `;

//     const completion = await this.openai.chat.completions.create({
//       model: 'gpt-4o',
//       temperature: 0.8,
//       messages: [
//         { role: 'system', content: systemPrompt },
//         { role: 'user', content: userPrompt },
//       ],
//       response_format: { type: 'json_object' },
//     });

//     const raw = completion.choices[0]?.message?.content;
//     if (!raw) throw new Error('No suggestion response received from model.');

//     let parsed: {
//       suggestion: string;
//       insight: string;
//       tomorrow: string;
//       seasonalForecast?: string;
//       lifecycleForecast?: string;
//       styleTrajectory?: string;
//     };

//     try {
//       parsed = JSON.parse(raw);
//     } catch {
//       console.error('❌ Failed to parse AI JSON:', raw);
//       throw new Error('AI response was not valid JSON.');
//     }

//     if (!parsed.seasonalForecast) {
//       parsed.seasonalForecast = generateSeasonalForecast(wardrobe);
//     }

//     return parsed;
//   }
//   /* ------------------------------------------------------------
//    🧾 BARCODE DECODER (no Vision API, uses existing OpenAI)
// -------------------------------------------------------------*/
//   async decodeBarcode(file: {
//     buffer: Buffer;
//     originalname: string;
//     mimetype: string;
//   }) {
//     const tempPath = `/tmp/${Date.now()}-barcode.jpg`;
//     fs.writeFileSync(tempPath, file.buffer);

//     try {
//       const base64 = fs.readFileSync(tempPath).toString('base64');
//       const prompt = `
//       You are analyzing a close-up photo of a product barcode label.
//       Return ONLY the numeric barcode digits (UPC or EAN), usually 12–13 digits.
//       If the barcode looks incomplete or OCR produces letters/spaces
//       (e.g. "226008 ign345"), infer the correct full numeric code.
//       If absolutely no barcode is visible, return "none".
//       Do not explain.
//     `;

//       const completion = await this.openai.chat.completions.create({
//         model: 'gpt-4o-mini',
//         messages: [
//           {
//             role: 'user',
//             content: [
//               { type: 'text', text: prompt },
//               {
//                 type: 'image_url',
//                 image_url: { url: `data:${file.mimetype};base64,${base64}` },
//               },
//             ],
//           },
//         ],
//         max_tokens: 200,
//       });

//       const message = completion.choices?.[0]?.message;

//       // ✅ Extract text safely
//       let text = '';
//       if (typeof message?.content === 'string') {
//         text = message.content;
//       } else if (Array.isArray(message?.content)) {
//         const parts = message.content as Array<{ text?: string }>;
//         text = parts.map((c) => c.text || '').join(' ');
//       }

//       // ✅ Normalize and detect digits (allow 8–14 just in case)
//       const normalized = text.replace(/\s+/g, '');
//       const match = normalized.match(/\d{8,14}/);

//       return { barcode: match ? match[0] : null, raw: text };
//     } catch (err: any) {
//       console.error('❌ [AI] decodeBarcode error:', err.message);
//       return { barcode: null, error: err.message };
//     } finally {
//       try {
//         fs.unlinkSync(tempPath);
//       } catch {}
//     }
//   }

//   /* ------------------------------------------------------------
//      🧾  Product lookup by UPC
//   -------------------------------------------------------------*/
//   async lookupProductByBarcode(upc: string) {
//     const normalized = upc.padStart(12, '0'); // ensure proper 12 digits
//     try {
//       const res = await fetch(
//         `https://api.upcitemdb.com/prod/trial/lookup?upc=${normalized}`,
//       );
//       const json = await res.json();

//       const item = json?.items?.[0];
//       if (!item) throw new Error('no product data');

//       return {
//         name: item.title,
//         brand: item.brand,
//         image: item.images?.[0],
//         category: item.category,
//         source: 'upcitemdb',
//       };
//     } catch (err) {
//       console.warn('⚠️ UPCItemDB failed:', (err as Error).message);
//       return await this.lookupFallback(normalized);
//     }
//   }

//   /* ------------------------------------------------------------
//      🔁 Fallback helper (RapidAPI etc.)
//   -------------------------------------------------------------*/
//   private async lookupFallback(upc: string) {
//     try {
//       const fallback = await fetch(
//         `https://barcodes1.p.rapidapi.com/?query=${upc}`,
//         {
//           headers: {
//             'X-RapidAPI-Key': process.env.RAPIDAPI_KEY!,
//             'X-RapidAPI-Host': 'barcodes1.p.rapidapi.com',
//           },
//         },
//       );
//       const data = await fallback.json();
//       return {
//         name: data?.product?.title || 'Unknown Item',
//         brand: data?.product?.brand || 'Unknown Brand',
//         image: data?.product?.image || null,
//         category: data?.product?.category || 'Uncategorized',
//         source: 'rapidapi',
//       };
//     } catch {
//       return null;
//     }
//   }
// }

// // END REPLACED CHAT WITH LINKS AND SEARCH NET

////////////////////

// import { Injectable } from '@nestjs/common';
// import OpenAI from 'openai';
// import { ChatDto } from './dto/chat.dto';
// import { VertexService } from '../vertex/vertex.service'; // 🔹 ADDED
// import { ProductSearchService } from '../product-services/product-search.service';
// import { Pool } from 'pg';

// const pool = new Pool({
//   connectionString: process.env.DATABASE_URL,
//   ssl: { rejectUnauthorized: false },
// });

// import * as fs from 'fs';
// import * as path from 'path';
// import * as dotenv from 'dotenv';

// function loadOpenAISecrets(): {
//   apiKey?: string;
//   project?: string;
//   source: string;
// } {
//   const candidates = [
//     path.join(process.cwd(), '.env'),
//     path.join(process.cwd(), 'apps', 'backend-nest', '.env'),
//     path.join(__dirname, '..', '..', '.env'),
//   ];

//   for (const p of candidates) {
//     try {
//       if (fs.existsSync(p)) {
//         const parsed = dotenv.parse(fs.readFileSync(p));
//         const apiKey = parsed['OPENAI_API_KEY'];
//         const project = parsed['OPENAI_PROJECT_ID'];
//         if (apiKey) return { apiKey, project, source: p };
//       }
//     } catch {
//       // ignore
//     }
//   }

//   return {
//     apiKey: process.env.OPENAI_API_KEY,
//     project: process.env.OPENAI_PROJECT_ID,
//     source: 'process.env',
//   };
// }

// // 🧥 Basic capsule wardrobe templates
// const CAPSULES = {
//   Spring: [
//     { category: 'Outerwear', subcategory: 'Light Jacket', recommended: 2 },
//     { category: 'Tops', subcategory: 'Oxford Shirt', recommended: 3 },
//     { category: 'Bottoms', subcategory: 'Chinos', recommended: 2 },
//     { category: 'Shoes', subcategory: 'Loafers', recommended: 1 },
//     { category: 'Shoes', subcategory: 'Sneakers', recommended: 1 },
//   ],
//   Summer: [
//     { category: 'Tops', subcategory: 'Short Sleeve Shirt', recommended: 4 },
//     { category: 'Tops', subcategory: 'Polo Shirt', recommended: 2 },
//     { category: 'Bottoms', subcategory: 'Linen Trousers', recommended: 2 },
//     { category: 'Shoes', subcategory: 'Loafers', recommended: 1 },
//     { category: 'Shoes', subcategory: 'Sandals', recommended: 1 },
//   ],
//   Fall: [
//     { category: 'Outerwear', subcategory: 'Field Jacket', recommended: 1 },
//     { category: 'Outerwear', subcategory: 'Blazer', recommended: 1 },
//     { category: 'Tops', subcategory: 'Knit Sweater', recommended: 2 },
//     { category: 'Bottoms', subcategory: 'Wool Trousers', recommended: 2 },
//     { category: 'Shoes', subcategory: 'Chelsea Boots', recommended: 1 },
//   ],
//   Winter: [
//     { category: 'Outerwear', subcategory: 'Overcoat', recommended: 1 },
//     { category: 'Outerwear', subcategory: 'Heavy Parka', recommended: 1 },
//     { category: 'Tops', subcategory: 'Heavy Knit Sweater', recommended: 2 },
//     { category: 'Bottoms', subcategory: 'Wool Trousers', recommended: 2 },
//     { category: 'Shoes', subcategory: 'Boots', recommended: 2 },
//   ],
// };

// // 🗓️ Auto-detect season based on month
// function getCurrentSeason(): 'Spring' | 'Summer' | 'Fall' | 'Winter' {
//   const month = new Date().getMonth() + 1;
//   if ([3, 4, 5].includes(month)) return 'Spring';
//   if ([6, 7, 8].includes(month)) return 'Summer';
//   if ([9, 10, 11].includes(month)) return 'Fall';
//   return 'Winter';
// }

// // 🧠 Compare wardrobe to capsule and return simple forecast text
// function generateSeasonalForecast(wardrobe: any[] = []): string | undefined {
//   const season = getCurrentSeason();
//   const capsule = CAPSULES[season];
//   if (!capsule) return;

//   const missing: string[] = [];

//   capsule.forEach((item) => {
//     const owned = wardrobe.filter(
//       (w) =>
//         w.category?.toLowerCase() === item.category.toLowerCase() &&
//         w.subcategory?.toLowerCase() === item.subcategory.toLowerCase(),
//     ).length;

//     if (owned < item.recommended) {
//       const needed = item.recommended - owned;
//       missing.push(`${needed} × ${item.subcategory}`);
//     }
//   });

//   if (missing.length === 0) {
//     return `✅ Your ${season} capsule is complete — you're ready for the season.`;
//   }

//   return `🍂 ${season} is approaching — you're missing: ${missing.join(', ')}.`;
// }

// @Injectable()
// export class AiService {
//   private openai: OpenAI;
//   private useVertex: boolean;
//   private vertexService?: VertexService; // 🔹 optional instance
//   private productSearch: ProductSearchService; // ✅ add this

//   constructor(vertexService?: VertexService) {
//     const { apiKey, project, source } = loadOpenAISecrets();

//     const snippet = apiKey?.slice(0, 20) ?? '';
//     const len = apiKey?.length ?? 0;
//     console.log('🔑 OPENAI key source:', source);
//     console.log('🔑 OPENAI key snippet:', JSON.stringify(snippet));
//     console.log('🔑 OPENAI key length:', len);
//     console.log('📂 CWD:', process.cwd());

//     if (!apiKey) {
//       throw new Error('OPENAI_API_KEY not found in .env or environment.');
//     }
//     if (/^sk-?x{3,}/i.test(apiKey)) {
//       throw new Error(
//         'OPENAI_API_KEY appears masked (e.g., "sk-xxxxx..."). Read from the correct .env instead.',
//       );
//     }
//     if (!apiKey.startsWith('sk-')) {
//       throw new Error('OPENAI_API_KEY is malformed — must start with "sk-".');
//     }

//     this.openai = new OpenAI({ apiKey, project });

//     // 🔹 New: Vertex toggle
//     this.useVertex = process.env.USE_VERTEX === 'true';
//     if (this.useVertex) {
//       this.vertexService = vertexService;
//       console.log('🧠 Vertex/Gemini mode enabled for analyze/recreate');
//     }

//     this.productSearch = new ProductSearchService(); // NEW
//   }

//   //////ANALYZE LOOK

//   async analyze(imageUrl: string) {
//     console.log('🧠 [AI] analyze() called with', imageUrl);
//     if (!imageUrl) throw new Error('Missing imageUrl');

//     // 🔹 Try Vertex first if enabled
//     if (this.useVertex && this.vertexService) {
//       try {
//         const gcsUri = imageUrl.replace(
//           'https://storage.googleapis.com/',
//           'gs://',
//         );
//         const metadata = await this.vertexService.analyzeImage(gcsUri);
//         const tags = [
//           ...(metadata.tags || []),
//           ...(metadata.style_descriptors || []),
//           metadata.main_category,
//           metadata.subcategory,
//         ].filter(Boolean);
//         console.log('🧠 [Vertex] analyze() success:', tags);
//         return { tags };
//       } catch (err: any) {
//         console.warn(
//           '[Vertex] analyze() failed → fallback to OpenAI:',
//           err.message,
//         );
//       }
//     }

//     // 🔸 OpenAI fallback
//     try {
//       const completion = await this.openai.chat.completions.create({
//         model: 'gpt-4o-mini',
//         messages: [
//           {
//             role: 'system',
//             content:
//               'You are a professional fashion classifier. Return only JSON with a "tags" array describing the outfit’s style, color palette, and vibe.',
//           },
//           {
//             role: 'user',
//             content: [
//               { type: 'text', text: 'Describe this outfit as tags only:' },
//               { type: 'image_url', image_url: { url: imageUrl } },
//             ],
//           },
//         ],
//         response_format: { type: 'json_object' },
//       });

//       const raw = completion.choices[0]?.message?.content;
//       console.log('🧠 [AI] analyze() raw response:', raw);

//       if (!raw) throw new Error('Empty response from OpenAI');
//       const parsed = JSON.parse(raw || '{}');
//       return { tags: parsed.tags || [] };
//     } catch (err: any) {
//       console.error('❌ [AI] analyze() failed:', err.message);
//       return { tags: ['casual', 'modern', 'neutral'] };
//     }
//   }

//   /* ------------------------------------------------------------
//      🧩 Weighted Tag Enrichment + Trend Injection
//   -------------------------------------------------------------*/
//   private async enrichTags(tags: string[]): Promise<string[]> {
//     const weightMap: Record<string, number> = {
//       tailored: 3,
//       minimal: 3,
//       neutral: 3,
//       modern: 2,
//       vintage: 2,
//       classic: 2,
//       streetwear: 2,
//       oversized: 2,
//       slim: 2,
//       relaxed: 2,
//       casual: 1,
//       sporty: 1,
//     };

//     // 🧹 Normalize + de-dupe
//     const cleanTags = Array.from(
//       new Set(
//         tags
//           .map((t) => t.toLowerCase().trim())
//           .filter((t) => t && !['outfit', 'style', 'fashion'].includes(t)),
//       ),
//     );

//     // 🧠 Apply weights
//     const weighted = cleanTags
//       .map((t) => ({ tag: t, weight: weightMap[t] || 1 }))
//       .sort((a, b) => b.weight - a.weight);

//     // 🌍 Inject current trend tags
//     const trendTags = await this.fetchTrendTags();
//     const final = Array.from(
//       new Set([...weighted.map((w) => w.tag), ...trendTags.slice(0, 3)]),
//     );

//     console.log('🎯 [AI] Enriched tags →', final);
//     return final;
//   }

//   private async fetchTrendTags(): Promise<string[]> {
//     try {
//       const res = await fetch(
//         'https://trends.google.com/trends/hottrends/visualize/internal/data/en_us',
//       );
//       if (!res.ok) throw new Error(`HTTP ${res.status}`);
//       const json = await res.json().catch(() => []);
//       const trendWords = JSON.stringify(json).toLowerCase();
//       const matched = trendWords.match(
//         /(quiet luxury|monochrome|minimalism|maximalism|italian|tailoring|loafers|neutrals|linen|structured|preppy|flannel|earth tones|autumn layering)/gi,
//       );
//       if (matched?.length) return Array.from(new Set(matched));

//       // 🧭 If Google Trends returned empty, use local backup
//       return [
//         'quiet luxury',
//         'neutral tones',
//         'tailored fit',
//         'autumn layering',
//       ];
//     } catch (err: any) {
//       console.warn('⚠️ Trend fetch fallback triggered:', err.message);
//       return [
//         'quiet luxury',
//         'neutral tones',
//         'tailored fit',
//         'autumn layering',
//       ];
//     }
//   }

//   // RECREATE//////////////
//   async recreate(
//     user_id: string,
//     tags: string[],
//     image_url?: string,
//     user_gender?: string,
//   ) {
//     console.log(
//       '🧥 [AI] recreate() called for user',
//       user_id,
//       'with tags:',
//       tags,
//       'and gender:',
//       user_gender,
//     );

//     if (!user_id) throw new Error('Missing user_id');
//     if (!tags?.length) {
//       console.warn('⚠️ [AI] recreate() empty tags → using defaults.');
//       tags = ['modern', 'neutral', 'tailored'];
//     }

//     // ✅ Weighted + trend-injected tags
//     tags = await this.enrichTags(tags);

//     // 🧠 Fetch gender_presentation if missing
//     if (!user_gender) {
//       try {
//         const result = await pool.query(
//           'SELECT gender_presentation FROM users WHERE id = $1 LIMIT 1',
//           [user_id],
//         );
//         user_gender = result.rows[0]?.gender_presentation || 'neutral';
//       } catch {
//         user_gender = 'neutral';
//       }
//     }

//     // 🧩 Normalize gender
//     const normalizedGender =
//       user_gender?.toLowerCase().includes('female') ||
//       user_gender?.toLowerCase().includes('woman')
//         ? 'female'
//         : user_gender?.toLowerCase().includes('male') ||
//             user_gender?.toLowerCase().includes('man')
//           ? 'male'
//           : process.env.DEFAULT_GENDER || 'neutral';

//     // 🧠 Build stylist prompt (base)
//     let prompt = `
//         You are a world-class AI stylist for ${normalizedGender} fashion.
//         Create a cohesive outfit inspired by an uploaded look.

//         Client: ${user_id}
//         Image: ${image_url || 'N/A'}
//         Detected tags: ${tags.join(', ')}

//         Rules:
//         - Match fabric, color palette, and silhouette.
//         - Use ${normalizedGender}-appropriate pieces.
//         - Output only JSON:
//         {
//           "outfit": [
//             { "category": "Top", "item": "Grey Cotton Tee", "color": "gray" },
//             { "category": "Bottom", "item": "Navy Chinos", "color": "navy" },
//             { "category": "Outerwear", "item": "Beige Overshirt", "color": "beige" },
//             { "category": "Shoes", "item": "White Sneakers", "color": "white" }
//           ],
//           "style_note": "Describe how the look connects to the uploaded image."
//         }
//         `;

//     // 🔹 Pull soft profile context (optional)
//     let profileCtx = '';
//     try {
//       const res = await pool.query(
//         `SELECT favorite_colors, fit_preferences, preferred_brands, disliked_styles
//        FROM style_profiles WHERE user_id::text = $1 LIMIT 1`,
//         [user_id],
//       );
//       const prof = res.rows[0];
//       if (prof) {
//         profileCtx = `
//       # USER STYLE CONTEXT (soft influence)
//       • Preferred colors: ${(prof.favorite_colors || []).join(', ') || '—'}
//       • Fit preferences: ${(prof.fit_preferences || []).join(', ') || '—'}
//       • Favorite brands: ${(prof.preferred_brands || []).join(', ') || '—'}
//       • Disliked styles: ${prof.disliked_styles || '—'}
//       Do NOT override the image’s vibe — just bias tone/material choices if relevant.
//       `;
//       }
//     } catch {
//       /* silent fail */
//     }

//     // ✅ Final prompt (merge only if context exists)
//     // Inside recreate() or personalizedShop() final prompt:
//     const finalPrompt = `
// ${prompt}

// # HARD RULES
// - ALWAYS output a full outfit of at least 4–6 distinct pieces.
// - Include a Top, Bottom, Outerwear (if seasonally appropriate), Shoes, and optionally 1–2 Accessories.
// - NEVER omit items because they already exist in the user’s wardrobe.
// - Each piece should have its own JSON object, even if similar to a wardrobe item.
// - Always include color and fit for every item.
// `;

//     // 🧠 Generate outfit via Vertex or OpenAI
//     let parsed: any;
//     if (this.useVertex && this.vertexService) {
//       try {
//         const result =
//           await this.vertexService.generateReasonedOutfit(finalPrompt);
//         let text = result?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
//         text = text
//           .replace(/^```json\s*/i, '')
//           .replace(/```$/, '')
//           .trim();
//         parsed = JSON.parse(text);
//         console.log('🧠 [Vertex] recreate() success');
//       } catch (err: any) {
//         console.warn('[Vertex] recreate() failed → fallback', err.message);
//       }
//     }

//     if (!parsed) {
//       const completion = await this.openai.chat.completions.create({
//         model: 'gpt-4o-mini',
//         temperature: 0.7,
//         messages: [{ role: 'user', content: finalPrompt }],
//         response_format: { type: 'json_object' },
//       });

//       const raw = completion.choices[0]?.message?.content || '{}';
//       try {
//         parsed = JSON.parse(raw);
//       } catch {
//         parsed = {};
//       }
//     }

//     const outfit = Array.isArray(parsed?.outfit) ? parsed.outfit : [];
//     const style_note =
//       parsed?.style_note || 'Modern outfit inspired by the uploaded look.';

//     // 🛍️ Enrich each item with live products
//     const enriched = await Promise.all(
//       outfit.map(async (o: any) => {
//         const query =
//           `${normalizedGender} ${o.item || o.category || ''} ${o.color || ''}`.trim();
//         let products = await this.productSearch.search(query);
//         let top = products[0];

//         if (!top?.image || top.image.includes('No_image')) {
//           const serp = await this.productSearch.searchSerpApi(query);
//           if (serp?.[0]) top = { ...serp[0], source: 'SerpAPI' };
//         }

//         const materialHint =
//           query.match(/(wool|cotton|linen|leather|denim|polyester)/i)?.[0] ||
//           null;
//         const seasonalityHint =
//           query.match(/(summer|winter|fall|spring)/i)?.[0] ||
//           getCurrentSeason();
//         const fitHint =
//           query.match(/(slim|regular|relaxed|oversized|tailored)/i)?.[0] ||
//           'regular';

//         return {
//           category: o.category,
//           item: o.item,
//           color: o.color,
//           brand: top?.brand || 'Unknown',
//           price: top?.price || '—',
//           image:
//             top?.image && top.image.startsWith('http')
//               ? top.image
//               : 'https://upload.wikimedia.org/wikipedia/commons/a/ac/No_image_available.svg',
//           shopUrl:
//             top?.shopUrl ||
//             `https://www.google.com/search?q=${encodeURIComponent(query)}&tbm=shop`,
//           source: top?.source || 'ASOS / Fallback',
//           material: materialHint,
//           seasonality: seasonalityHint,
//           fit: fitHint,
//         };
//       }),
//     );

//     return { user_id, outfit: enriched, style_note };
//   }

//   // 🧩 Ensure every product object includes a usable image URL
//   private fixProductImages(products: any[] = []): any[] {
//     return products.map((prod) => ({
//       ...prod,
//       image:
//         prod.image ||
//         prod.image_url ||
//         prod.thumbnail ||
//         prod.serpapi_thumbnail || // ✅ added
//         prod.img ||
//         prod.picture ||
//         prod.thumbnail_url ||
//         'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg',
//     }));
//   }

//   // 👔 PERSONALIZED SHOP — image + wardrobe + preferences
//   async personalizedShop(
//     user_id: string,
//     image_url: string,
//     user_gender?: string,
//   ) {
//     if (!user_id || !image_url) throw new Error('Missing user_id or image_url');

//     /** -----------------------------------------------------------
//      * 🧠 buildProfileConstraints(profile)
//      * Converts full style_profiles record into explicit hard rules
//      * ---------------------------------------------------------- */
//     function buildProfileConstraints(profile: any): string {
//       if (!profile) return '';

//       const fit = Array.isArray(profile.fit_preferences)
//         ? profile.fit_preferences.join(', ')
//         : profile.fit_preferences;

//       const colors = Array.isArray(profile.favorite_colors)
//         ? profile.favorite_colors.join(', ')
//         : profile.favorite_colors;

//       const brands = Array.isArray(profile.preferred_brands)
//         ? profile.preferred_brands.join(', ')
//         : profile.preferred_brands;

//       const styles = [
//         ...(profile.style_keywords || []),
//         ...(profile.style_preferences || []),
//       ]
//         .filter(Boolean)
//         .join(', ');

//       const dislikes =
//         typeof profile.disliked_styles === 'string'
//           ? profile.disliked_styles
//           : (profile.disliked_styles || []).join(', ');

//       const climate = profile.climate || 'Temperate';
//       const goals = profile.goals || '';

//       // 🔹 Inject explicit hard “only color” or “except color” rule for the model itself
//       let colorRule = '';
//       if (profile.disliked_styles?.match(/only\s+(\w+)/i)) {
//         const onlyColor = profile.disliked_styles.match(/only\s+(\w+)/i)[1];
//         colorRule = `• Use ONLY ${onlyColor} items — all other colors are forbidden.`;
//       } else if (profile.disliked_styles?.match(/except\s+(\w+)/i)) {
//         const exceptColor = profile.disliked_styles.match(/except\s+(\w+)/i)[1];
//         colorRule = `• Exclude every color except ${exceptColor}.`;
//       }

//       // 🔹 Explicitly enforce fit preferences
//       let fitRule = '';
//       if (profile.fit_preferences?.length) {
//         fitRule = `• Allow ONLY these fits: ${profile.fit_preferences.join(
//           ', ',
//         )}; exclude all others.`;
//       }

//       return `
// # USER PROFILE CONSTRAINTS (Hard Rules)

// ${fitRule}
// ${colorRule}

// • Fit: ${fit || 'Regular fit'} — outfit items must match this silhouette; exclude all opposing fits.
// • Climate: ${climate} — use materials and layers appropriate to this temperature zone.
// • Preferred brands: ${brands || '—'} — bias all product searches toward these or comparable aesthetics.
// • Favorite colors: ${colors || '—'} — bias color palette to these tones; avoid disliked colors.
// • Disliked styles: ${dislikes || '—'} — exclude these aesthetics entirely.
// • Style & vibe keywords: ${styles || '—'} — reflect these qualities in overall tone and accessories.
// • Goals: ${goals}
// • Body & proportions: ${profile.body_type || '—'}, ${
//         profile.proportions || '—'
//       } — ensure silhouette and layering suit these proportions.
// • Skin tone / hair / eyes: ${profile.skin_tone || '—'}, ${
//         profile.hair_color || '—'
//       }, ${profile.eye_color || '—'} — choose tones that complement.
// `;
//     }

//     // 1) Analyze uploaded image
//     const analysis = await this.analyze(image_url);
//     const tags = analysis?.tags || [];

//     //   const { rows: wardrobe } = await pool.query(
//     //     `SELECT name, main_category AS category, subcategory, color, material
//     //  FROM wardrobe_items
//     //  WHERE user_id::text = $1
//     //  ORDER BY updated_at DESC
//     //  LIMIT 50`,
//     //     [user_id],
//     //   );

//     // 🚫 Skip wardrobe entirely for personalized mode
//     const wardrobe: any[] = [];

//     const prefRes = await pool.query(
//       `SELECT gender_presentation
//      FROM users
//      WHERE id = $1
//      LIMIT 1`,
//       [user_id],
//     );
//     const profile = prefRes.rows[0] || {};
//     const gender = user_gender || profile.gender_presentation || 'neutral';
//     // 2️⃣ Fetch user style profile (full data used for personalization)
//     const styleProfileRes = await pool.query(
//       `
//   SELECT
//     body_type,
//     skin_tone,
//     undertone,
//     climate,
//     favorite_colors,
//     disliked_styles,
//     style_keywords,
//     preferred_brands,
//     goals,
//     proportions,
//     hair_color,
//     eye_color,
//     height,
//     waist,
//     fit_preferences,
//     style_preferences
//   FROM style_profiles
//   WHERE user_id::text = $1
//   LIMIT 1
// `,
//       [user_id],
//     );

//     const styleProfile = styleProfileRes.rows[0] || {};

//     // 🔹 Build user filter preferences
//     const { preferFit, bannedWords } = buildUserFilter(styleProfile);

//     /* ------------------------------------------------------------
//    🎛️ VISUAL + STYLE FILTERING HELPERS
// -------------------------------------------------------------*/
//     const FIT_KEYWORDS = {
//       skinny: [/skinny/i, /super[- ]skinny/i, /spray[- ]on/i],
//       slim: [/slim/i],
//       tailored: [/tailored/i, /tapered/i],
//       relaxed: [/relaxed/i, /loose/i, /baggy/i, /wide[- ]leg/i],
//       oversized: [/oversized/i, /boxy/i],
//     };

//     function buildUserFilter(profile: any) {
//       const fitPrefs = (profile.fit_preferences || []).map((x: string) =>
//         x.toLowerCase(),
//       );
//       const disliked = (profile.disliked_styles || '')
//         .toLowerCase()
//         .split(/[,\s]+/)
//         .filter(Boolean);
//       const favColors = (profile.favorite_colors || []).map((x: string) =>
//         x.toLowerCase(),
//       );

//       const preferFit =
//         fitPrefs.find((f) => /(relaxed|loose|baggy|oversized|boxy)/.test(f)) ||
//         fitPrefs.find((f) => /(regular|tailored)/.test(f)) ||
//         fitPrefs[0] ||
//         null;

//       const banFits: string[] = [];
//       if (preferFit?.match(/relaxed|loose|baggy|oversized|boxy/))
//         banFits.push('skinny', 'slim');
//       else if (preferFit?.match(/skinny|slim/))
//         banFits.push('relaxed', 'baggy', 'oversized');

//       const bannedWords = [
//         ...disliked,
//         ...banFits,
//         ...(!favColors.includes('green') ? ['green'] : []),
//       ]
//         .filter(Boolean)
//         .map((x) => new RegExp(x, 'i'));

//       return { preferFit, bannedWords };
//     }

//     function enforceProfileFilters(
//       products: any[] = [],
//       preferFit?: string | null,
//       bannedWords: RegExp[] = [],
//     ) {
//       if (!products.length) return products;

//       return products
//         .filter((p) => {
//           const hay = `${p.title || ''} ${p.name || ''} ${p.description || ''}`;
//           return !bannedWords.some((rx) => rx.test(hay));
//         })
//         .sort((a, b) => {
//           if (!preferFit) return 0;
//           const aHit = FIT_KEYWORDS[preferFit]?.some((rx) =>
//             rx.test(`${a.title} ${a.name}`),
//           )
//             ? 1
//             : 0;
//           const bHit = FIT_KEYWORDS[preferFit]?.some((rx) =>
//             rx.test(`${b.title} ${b.name}`),
//           )
//             ? 1
//             : 0;
//           return bHit - aHit; // boost preferred fits
//         });
//     }

//     // 3) Ask model to split into "owned" vs "missing"

//     const climateNote = styleProfile.climate
//       ? `The user's climate is ${styleProfile.climate}.
//     If it is cold (like Polar or Cold), emphasize insulated materials, coats, layers, scarves, gloves, and boots.
//     If it is hot (like Tropical or Desert), emphasize breathable, lightweight fabrics and open footwear.`
//       : '';

//     // 🔒 Enforced personalization hierarchy
//     const rules = `
//     # PERSONALIZATION ENFORCEMENT
//     Follow these user preferences as *absolute constraints*, not suggestions.
//     `;

//     const profileConstraints = buildProfileConstraints(styleProfile);

//     const prompt = `
// You are a world-class personal stylist generating a personalized recreation of an uploaded look.
// ${rules}
// ${profileConstraints}

// # IMAGE INSPIRATION
// • Use the uploaded image only as an aesthetic anchor (color story, silhouette, or texture).
// • Do NOT reference or reuse the user's wardrobe.
// • Respect all style profile constraints exactly.
// • Maintain the same mood and spirit as the uploaded image, not a literal copy.
// • Preserve one clear visual motif from the source image (e.g., plaid pattern or color tone) unless climate prohibits.

// # OUTPUT RULES
// - ALWAYS output a complete outfit with distinct Top, Bottom, Shoes, and (if seasonally appropriate) Outerwear and Accessories.
// - Each piece must include category, item, color, and fit.

// Return ONLY valid JSON:
// {
//   "recreated_outfit": [
//     { "source":"purchase", "category":"Top", "item":"...", "color":"...", "fit":"..." }
//   ],
//   "suggested_purchases": [
//     { "category":"...", "item":"...", "color":"...", "material":"...", "brand":"...", "shopUrl":"..." }
//   ],
//   "style_note": "Explain how this respects the user's climate, fit, and taste."
// }

// User gender: ${gender}
// Detected tags: ${tags.join(', ')}
// Weighted tags: ${tags.map((t) => `high priority: ${t}`).join(', ')}
// User style profile: ${JSON.stringify(styleProfile, null, 2)}
// ${climateNote}
// `;

//     console.log('🧥 [personalizedShop] profile:', profile);
//     console.log('🧥 [personalizedShop] gender:', gender);
//     console.log('🧥 [personalizedShop] styleProfile:', styleProfile);
//     console.log('🧠 [personalizedShop] Prompt preview:', prompt.slice(0, 800));

//     // 🧠 DEBUG START — prompt verification
//     console.log('─────────────── PROMPT SENT TO MODEL ───────────────');
//     console.log(prompt);
//     console.log('─────────────── END PROMPT ───────────────');

//     const completion = await this.openai.chat.completions.create({
//       model: 'gpt-4o-mini',
//       temperature: 0.7,
//       messages: [{ role: 'user', content: prompt }],
//       response_format: { type: 'json_object' },
//     });

//     // 🧠 DEBUG END — raw model output
//     console.log('─────────────── RAW MODEL RESPONSE ───────────────');
//     console.log(completion.choices[0]?.message?.content);
//     console.log('─────────────── END RESPONSE ───────────────');

//     let parsed: any = {};
//     try {
//       parsed = JSON.parse(completion.choices[0]?.message?.content || '{}');

//       // 🧩 SAFETY GUARD — ensure we keep valid recreated_outfit
//       try {
//         const parsedKeys = Object.keys(parsed);
//         console.log('✅ [personalizedShop] Parsed JSON keys:', parsedKeys);

//         // If model used "outfit" instead of "recreated_outfit", normalize it
//         if (!parsed.recreated_outfit && parsed.outfit) {
//           parsed.recreated_outfit = parsed.outfit;
//           console.log('✅ [personalizedShop] Mapped outfit → recreated_outfit');
//         }

//         // Double-check array validity before fallback clears it
//         if (parsed.recreated_outfit && parsed.recreated_outfit.length > 0) {
//           console.log(
//             '✅ [personalizedShop] Using recreated_outfit from model',
//           );
//         } else {
//           console.warn(
//             '⚠️ [personalizedShop] No recreated_outfit found — fallback may trigger',
//           );
//         }
//       } catch (err) {
//         console.error(
//           '❌ [personalizedShop] JSON structure guard failed:',
//           err,
//         );
//       }

//       // ✅ Final filter fix — keep wardrobe items but still respect banned fits/styles
//       if (parsed?.recreated_outfit?.length) {
//         parsed.recreated_outfit = parsed.recreated_outfit.filter((o: any) => {
//           if (!o) return false;
//           const text =
//             `${o.item} ${o.category} ${o.color} ${o.fit}`.toLowerCase();
//           if (!text.trim() || text.includes('undefined')) return false;
//           // ✅ Always keep wardrobe items regardless of style bans
//           if (o.source === 'wardrobe') return true;

//           const fitBan = preferFit?.match(/relaxed|oversized|boxy|loose/)
//             ? ['skinny']
//             : preferFit?.match(/skinny|slim|tailored/)
//               ? ['relaxed', 'baggy', 'oversized']
//               : [];

//           const styleBan =
//             (styleProfile.disliked_styles || '')
//               .toLowerCase()
//               .split(/[,\s]+/)
//               .filter(Boolean) || [];

//           const banned = [...fitBan, ...styleBan];
//           return !banned.some((b) => text.includes(b));
//         });

//         console.log(
//           '✅ [personalizedShop] Final filtered outfit →',
//           parsed.recreated_outfit,
//         );
//       }

//       console.log(
//         '💎 [personalizedShop] Parsed recreated outfit sample:',
//         parsed?.recreated_outfit?.slice(0, 2),
//       );
//       console.log(
//         '💎 [personalizedShop] Parsed suggested purchases sample:',
//         parsed?.suggested_purchases?.slice(0, 2),
//       );

//       // 🧩 Merge recreated_outfit into suggested_purchases for display
//       if (
//         Array.isArray(parsed?.recreated_outfit) &&
//         parsed.recreated_outfit.length
//       ) {
//         parsed.suggested_purchases = [
//           ...(parsed.suggested_purchases || []),
//           ...parsed.recreated_outfit.map((o: any) => ({
//             ...o,
//             brand: o.brand || '—',
//             previewImage: o.previewImage || o.image || o.image_url || null,
//             source: 'purchase',
//           })),
//         ];
//         console.log(
//           '🧩 [personalizedShop] merged recreated_outfit → suggested_purchases',
//         );
//       }

//       // 🖼️ Ensure every recreated outfit item has a visible preview image
//       if (Array.isArray(parsed?.recreated_outfit)) {
//         parsed.recreated_outfit = parsed.recreated_outfit.map((item: any) => {
//           if (!item.previewImage && item.source === 'wardrobe') {
//             item.previewImage =
//               item.image_url ||
//               item.wardrobe_image ||
//               'https://upload.wikimedia.org/wikipedia/commons/a/ac/No_image_available.svg';
//           }
//           return item;
//         });
//       }

//       // 🎨 Enforce "only <color>" rule from disliked_styles (e.g. "I dislike all colors except pink")
//       // 🎨 Optional color-only enforcement — only if explicit "ONLY <color>" flag exists
//       if (styleProfile?.disliked_styles?.toLowerCase().includes('only')) {
//         const match = styleProfile.disliked_styles.match(/only\s+(\w+)/i);
//         if (match) {
//           const onlyColor = match[1].toLowerCase();
//           const filterColor = (arr: any[]) =>
//             arr.filter((x) =>
//               (x.color || '').toLowerCase().includes(onlyColor),
//             );

//           if (Array.isArray(parsed?.recreated_outfit))
//             parsed.recreated_outfit = filterColor(parsed.recreated_outfit);
//           if (Array.isArray(parsed?.suggested_purchases))
//             parsed.suggested_purchases = filterColor(
//               parsed.suggested_purchases,
//             );

//           console.log(
//             `[personalizedShop] 🎨 Enforcing ONLY-color rule: ${onlyColor}`,
//           );
//         }
//       }
//     } catch {
//       parsed = {};
//     }

//     const purchases = Array.isArray(parsed?.suggested_purchases)
//       ? parsed.suggested_purchases
//       : [];

//     if (parsed?.recreated_outfit?.some((i: any) => i.source === 'wardrobe')) {
//       console.log('🧥 [personalizedShop] ✅ Model reused wardrobe pieces.');
//     } else {
//       console.warn(
//         '🧥 [personalizedShop] ⚠️ Model did NOT reuse wardrobe — fallback to generic recreation.',
//       );
//     }

//     // 🚫 Enforce profile bans in returned outfit
//     const banned = [
//       ...(styleProfile.disliked_styles?.toLowerCase().split(/[,\s]+/) || []),
//       ...(preferFit?.match(/relaxed|oversized|boxy|loose/)
//         ? ['skinny', 'slim']
//         : []),
//       ...(preferFit?.match(/skinny|slim/)
//         ? ['relaxed', 'oversized', 'baggy']
//         : []),
//     ].filter(Boolean);

//     if (parsed?.recreated_outfit?.length) {
//       // ✅ Keep *all* wardrobe and purchase items — only filter garbage entries
//       parsed.recreated_outfit = parsed.recreated_outfit.filter((o: any) => {
//         if (!o || !o.item) return false;
//         const text =
//           `${o.item} ${o.category} ${o.color} ${o.fit}`.toLowerCase();
//         return text.trim().length > 0 && !text.includes('undefined');
//       });

//       // 🧱 Guarantee full outfit completeness (Top, Bottom, Shoes, Optional Outerwear/Accessory)
//       const categories = parsed.recreated_outfit.map((o: any) =>
//         o.category?.toLowerCase(),
//       );
//       const missing: any[] = [];

//       if (!categories.includes('top'))
//         missing.push({
//           source: 'purchase',
//           category: 'Top',
//           item: 'White Oxford Shirt',
//           color: 'White',
//           fit: 'Slim Fit',
//         });
//       if (!categories.includes('bottoms'))
//         missing.push({
//           source: 'purchase',
//           category: 'Bottoms',
//           item: 'Beige Chinos',
//           color: 'Beige',
//           fit: 'Slim Fit',
//         });
//       if (!categories.includes('shoes'))
//         missing.push({
//           source: 'purchase',
//           category: 'Shoes',
//           item: 'White Leather Sneakers',
//           color: 'White',
//           fit: 'Slim Fit',
//         });

//       parsed.recreated_outfit.push(...missing);

//       console.log(
//         '✅ [personalizedShop] Final full outfit →',
//         parsed.recreated_outfit,
//       );
//     }

//     // 🧩 Centralized enforcement for personalizedShop only
//     function applyProfileFilters(products: any[], profile: any) {
//       if (!Array.isArray(products) || !products.length) return [];

//       const favColors = (profile.favorite_colors || []).map((x: string) =>
//         x.toLowerCase(),
//       );
//       const prefBrands = (profile.preferred_brands || []).map((x: string) =>
//         x.toLowerCase(),
//       );
//       const fitPrefs = (profile.fit_preferences || []).map((x: string) =>
//         x.toLowerCase(),
//       );
//       const dislikes = (profile.disliked_styles || '')
//         .toLowerCase()
//         .split(/[,\s]+/);
//       const climate = (profile.climate || '').toLowerCase();

//       const isCold = /(polar|cold|arctic|tundra|winter)/.test(climate);
//       const isHot = /(tropical|desert|hot|humid|summer)/.test(climate);

//       // 🩷 detect "only" or "except" color rule from disliked_styles
//       let onlyColor: string | null = null;
//       let exceptColor: string | null = null;

//       if (profile.disliked_styles?.match(/only\s+(\w+)/i)) {
//         onlyColor = profile.disliked_styles
//           .match(/only\s+(\w+)/i)[1]
//           .toLowerCase();
//       } else if (profile.disliked_styles?.match(/except\s+(\w+)/i)) {
//         exceptColor = profile.disliked_styles
//           .match(/except\s+(\w+)/i)[1]
//           .toLowerCase();
//       }

//       return products
//         .filter((p) => {
//           const t = `${p.name ?? ''} ${p.title ?? ''} ${p.brand ?? ''} ${
//             p.description ?? ''
//           } ${p.color ?? ''} ${p.fit ?? ''}`.toLowerCase();

//           // 🚫 Filter out disliked words/styles
//           if (dislikes.some((d) => d && t.includes(d))) return false;

//           // 🎨 HARD color enforcement from DB rules
//           if (onlyColor) {
//             // Only allow if text or color includes the specified color
//             if (
//               !t.includes(onlyColor) &&
//               !p.color?.toLowerCase().includes(onlyColor)
//             )
//               return false;
//           } else if (exceptColor) {
//             // Exclude everything not matching that color
//             if (
//               !t.includes(exceptColor) &&
//               !p.color?.toLowerCase().includes(exceptColor)
//             )
//               return false;
//           } else {
//             // Normal favorite color bias if no hard rule
//             if (favColors.length && !favColors.some((c) => t.includes(c)))
//               return false;
//           }

//           // 👕 Fit preferences
//           if (fitPrefs.length && !fitPrefs.some((f) => t.includes(f)))
//             return false;

//           // 🌡️ Climate-based filtering
//           if (isCold && /(tank|shorts|sandal)/.test(t)) return false;
//           if (isHot && /(wool|parka|coat|boot|knit)/.test(t)) return false;

//           return true;
//         })
//         .sort((a, b) => {
//           const score = (x: any) => {
//             const txt =
//               `${x.name} ${x.title} ${x.brand} ${x.color} ${x.fit}`.toLowerCase();
//             let s = 0;
//             if (onlyColor && txt.includes(onlyColor)) s += 4;
//             if (exceptColor && txt.includes(exceptColor)) s += 4;
//             if (favColors.some((c) => txt.includes(c))) s += 2;
//             if (prefBrands.some((b) => txt.includes(b))) s += 2;
//             if (fitPrefs.some((f) => txt.includes(f))) s += 1;
//             return s;
//           };
//           return score(b) - score(a);
//         });
//     }

//     // 4️⃣ Attach live shop links to the "missing" items — now honoring user taste
//     let enrichedPurchases = await Promise.all(
//       purchases.map(async (p: any) => {
//         // 🧠 Gender-locked prefix
//         const genderPrefix =
//           gender?.toLowerCase().includes('female') ||
//           gender?.toLowerCase().includes('woman')
//             ? 'women female womens ladies'
//             : 'men male mens masculine -women -womens -female -girls -ladies';

//         // Base query with gender lock
//         let q = [
//           genderPrefix,
//           p.item || p.category || '',
//           p.color || '',
//           p.material || '',
//         ]
//           .filter(Boolean)
//           .join(' ')
//           .trim();

//         // 🔹 Inject personalization bias terms
//         const brandTerms = (styleProfile.preferred_brands || [])
//           .slice(0, 3)
//           .join(' ');
//         const colorTerms = (styleProfile.favorite_colors || [])
//           .slice(0, 2)
//           .join(' ');
//         const fitTerms = Array.isArray(styleProfile.fit_preferences)
//           ? styleProfile.fit_preferences.join(' ')
//           : styleProfile.fit_preferences || '';

//         // 🎨 “Only color” rule (e.g. “I dislike all colors except pink”)
//         const colorMatch =
//           styleProfile.disliked_styles?.match(/except\s+(\w+)/i);
//         if (colorMatch) {
//           const onlyColor = colorMatch[1].toLowerCase();
//           q += ` ${onlyColor}`;
//         }

//         // Combine into final query with brand + color + fit bias
//         q = [q, brandTerms, colorTerms, fitTerms].filter(Boolean).join(' ');

//         // 🔒 Ensure all queries exclude female results explicitly
//         if (
//           !/-(women|female|ladies|girls)/i.test(q) &&
//           /\bmen\b|\bmale\b/i.test(q)
//         ) {
//           q += ' -women -womens -female -girls -ladies';
//         }

//         // Combine into final query with brand + color + fit bias
//         q = [q, brandTerms, colorTerms, fitTerms].filter(Boolean).join(' ');

//         // 🔒 Ensure all queries exclude female results explicitly
//         if (
//           !/-(women|female|ladies|girls)/i.test(q) &&
//           /\bmen\b|\bmale\b/i.test(q)
//         ) {
//           q += ' -women -womens -female -girls -ladies';
//         }

//         // 🧠 Gender-aware product search
//         let products = await this.productSearch.search(
//           q,
//           gender?.toLowerCase() === 'female'
//             ? 'female'
//             : gender?.toLowerCase() === 'male'
//               ? 'male'
//               : 'unisex',
//         );

//         // 🚫 Filter out any accidental female/unisex results
//         products = products.filter(
//           (prod) =>
//             !/women|female|womens|ladies|girls/i.test(
//               `${prod.name ?? ''} ${prod.brand ?? ''} ${prod.title ?? ''}`,
//             ),
//         );

//         // 🩷 Hard visual color filter — ensures displayed products actually match the enforced color rule
//         if (
//           styleProfile?.disliked_styles?.match(/only\s+(\w+)/i) ||
//           styleProfile?.disliked_styles?.match(/except\s+(\w+)/i)
//         ) {
//           const match =
//             styleProfile.disliked_styles.match(/only\s+(\w+)/i) ||
//             styleProfile.disliked_styles.match(/except\s+(\w+)/i);
//           const enforcedColor = match?.[1]?.toLowerCase();
//           if (enforcedColor) {
//             products = products.filter((p) => {
//               const text =
//                 `${p.name ?? ''} ${p.title ?? ''} ${p.color ?? ''}`.toLowerCase();
//               return text.includes(enforcedColor);
//             });
//           }
//         }

//         return {
//           ...p,
//           query: q,
//           products: applyProfileFilters(products, styleProfile),
//         };
//       }),
//     );

//     // 5️⃣ Fallback enrichment if AI returned nothing or products failed
//     if (!enrichedPurchases.length) {
//       console.warn(
//         '⚠️ [personalizedShop] Empty suggested_purchases → fallback.',
//       );

//       const tagSeed = tags.slice(0, 6).join(' ');
//       const season = getCurrentSeason();

//       // 🧠 Gender prefix for fallback with hard lock
//       const genderPrefix =
//         gender?.toLowerCase().includes('female') ||
//         gender?.toLowerCase().includes('woman')
//           ? 'women female womens ladies'
//           : 'men male mens masculine -women -womens -female -girls -ladies';

//       // 🧠 Enrich fallback with style taste as well
//       const brandTerms = (styleProfile.preferred_brands || [])
//         .slice(0, 3)
//         .join(' ');
//       const colorTerms = (styleProfile.favorite_colors || [])
//         .slice(0, 2)
//         .join(' ');
//       const fitTerms = Array.isArray(styleProfile.fit_preferences)
//         ? styleProfile.fit_preferences.join(' ')
//         : styleProfile.fit_preferences || '';

//       const fallbackQuery = `${genderPrefix} ${tagSeed} ${season} fashion ${brandTerms} ${colorTerms} ${fitTerms}`;
//       console.log('🧩 [personalizedShop] fallbackQuery →', fallbackQuery);

//       const products = await this.productSearch.search(
//         fallbackQuery,
//         gender?.toLowerCase() === 'female'
//           ? 'female'
//           : gender?.toLowerCase() === 'male'
//             ? 'male'
//             : 'unisex',
//       );

//       // 🚫 Filter out any accidental female/unisex results
//       const maleProducts = products.filter(
//         (prod) =>
//           !/women|female|womens|ladies|girls/i.test(
//             `${prod.name ?? ''} ${prod.brand ?? ''} ${prod.title ?? ''}`,
//           ),
//       );

//       enrichedPurchases = [
//         {
//           category: 'General',
//           item: 'Curated Outfit Add-Ons',
//           color: 'Mixed',
//           material: null,
//           products: applyProfileFilters(maleProducts.slice(0, 8), styleProfile),
//           query: fallbackQuery,
//           source: 'fallback',
//         },
//       ];
//     }

//     // 🎨 Enforce color-only rule on fallback products too
//     if (styleProfile?.disliked_styles) {
//       const match = styleProfile.disliked_styles.match(/except\s+(\w+)/i);
//       if (match) {
//         const onlyColor = match[1].toLowerCase();
//         enrichedPurchases = enrichedPurchases.map((p) => ({
//           ...p,
//           products: (p.products || []).filter((prod) =>
//             (prod.color || '').toLowerCase().includes(onlyColor),
//           ),
//         }));
//         console.log(
//           `[personalizedShop] 🎨 Enforced fallback color-only rule: ${onlyColor}`,
//         );
//       }
//     }

//     const cleanPurchases = enrichedPurchases.map((p) => ({
//       ...p,
//       products: this.fixProductImages(
//         enforceProfileFilters(p.products || [], preferFit, bannedWords),
//       ),
//     }));

//     // 🎨 FINAL VISUAL CONSISTENCY NORMALIZATION
//     const normalizedPurchases = await Promise.all(
//       enrichedPurchases.map(async (p) => {
//         const validProduct =
//           (p.products || []).find(
//             (x) =>
//               (x.image ||
//                 x.image_url ||
//                 x.thumbnail ||
//                 x.serpapi_thumbnail ||
//                 x.thumbnail_url ||
//                 x.img ||
//                 x.result?.thumbnail ||
//                 x.result?.serpapi_thumbnail) &&
//               /^https?:\/\//.test(
//                 x.image ||
//                   x.image_url ||
//                   x.thumbnail ||
//                   x.serpapi_thumbnail ||
//                   x.thumbnail_url ||
//                   x.img ||
//                   x.result?.thumbnail ||
//                   x.result?.serpapi_thumbnail ||
//                   '',
//               ) &&
//               !/no[_-]?image/i.test(
//                 x.image ||
//                   x.image_url ||
//                   x.thumbnail ||
//                   x.serpapi_thumbnail ||
//                   x.thumbnail_url ||
//                   x.img ||
//                   '',
//               ),
//           ) || p.products?.[0];

//         let previewImage =
//           validProduct?.image ||
//           validProduct?.image_url ||
//           validProduct?.thumbnail ||
//           validProduct?.serpapi_thumbnail ||
//           validProduct?.thumbnail_url ||
//           validProduct?.img ||
//           validProduct?.product_thumbnail ||
//           validProduct?.result?.thumbnail ||
//           validProduct?.result?.serpapi_thumbnail ||
//           null;

//         // 🎯 Gender-aware image guard
//         const userGender = (gender || '').toLowerCase();

//         if (previewImage) {
//           const url = previewImage.toLowerCase();

//           // 🧍‍♂️ If male → block clearly female-coded URLs
//           if (
//             userGender.includes('male') &&
//             /(women|woman|female|ladies|girls|womenswear|femme|skims|shein|fashionnova|princesspolly|revolve|anthropologie)/i.test(
//               url,
//             )
//           ) {
//             previewImage =
//               'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg';
//           }

//           // 🧍‍♀️ If female → block clearly male-coded URLs
//           else if (
//             userGender.includes('female') &&
//             /(men|man|male|menswear|masculine)/i.test(url)
//           ) {
//             previewImage =
//               'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg';
//           }

//           // 🧍 Unisex → allow all images
//         }

//         // 🧠 If still missing, do a quick SerpAPI lookup and cache
//         if (!previewImage && p.query) {
//           const results = await this.productSearch.searchSerpApi(p.query);
//           const r = results?.[0];
//           previewImage =
//             r?.image ||
//             r?.image_url ||
//             r?.thumbnail ||
//             r?.serpapi_thumbnail ||
//             r?.thumbnail_url ||
//             r?.result?.thumbnail ||
//             r?.result?.serpapi_thumbnail ||
//             null;

//           // 🎯 Apply same gender guard to SerpAPI result
//           if (previewImage) {
//             const url = previewImage.toLowerCase();

//             if (
//               userGender.includes('male') &&
//               /(women|woman|female|ladies|girls|womenswear|femme|skims|shein|fashionnova|princesspolly|revolve|anthropologie)/i.test(
//                 url,
//               )
//             ) {
//               previewImage =
//                 'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg';
//             } else if (
//               userGender.includes('female') &&
//               /(men|man|male|menswear|masculine)/i.test(url)
//             ) {
//               previewImage =
//                 'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg';
//             }
//           }
//         }

//         return {
//           ...p,
//           previewImage:
//             previewImage ||
//             'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg',
//           previewBrand: validProduct?.brand || p.brand || 'Unknown',
//           previewPrice: validProduct?.price || '—',
//           previewUrl: validProduct?.shopUrl || p.shopUrl || null,
//         };
//       }),
//     ); // ✅ ← closes Promise.all()

//     // 🧹 remove empty product groups (no valid images)
//     const filteredPurchases = normalizedPurchases.filter(
//       (p) => !!p.previewImage,
//     );

//     // 🧊 Climate sanity check — if Polar but outfit lacks insulation, patch style_note
//     if (
//       styleProfile.climate?.toLowerCase().includes('polar') &&
//       !/coat|jacket|parka|boot|knit|sweater/i.test(
//         JSON.stringify(parsed.recreated_outfit || []),
//       )
//     ) {
//       parsed.style_note +=
//         ' Reinforced with insulated outerwear and cold-weather layering for Polar climates.';
//     }

//     // 🚫 Prevent fallback or secondary recreate() from overwriting personalized flow
//     if (
//       enrichedPurchases?.length > 0 ||
//       parsed?.suggested_purchases?.length > 0
//     ) {
//       console.log(
//         '✅ [personalizedShop] Finalizing personalized results — skipping generic recreate()',
//       );
//       return {
//         user_id,
//         image_url,
//         tags,
//         recreated_outfit: parsed?.recreated_outfit || [],
//         suggested_purchases: normalizedPurchases,
//         style_note:
//           parsed?.style_note ||
//           'Personalized recreation based on your wardrobe, with curated seasonal add-ons.',
//         applied_filters: {
//           preferFit,
//           bannedWords: bannedWords.map((r) => r.source),
//         },
//       };
//     }

//     return {
//       user_id,
//       image_url,
//       tags,
//       recreated_outfit: parsed?.recreated_outfit || [],
//       suggested_purchases: normalizedPurchases,
//       style_note:
//         parsed?.style_note ||
//         'Personalized recreation based on your wardrobe, with curated seasonal add-ons.',
//       applied_filters: {
//         preferFit,
//         bannedWords: bannedWords.map((r) => r.source),
//       },
//     };
//   }

//   ////////END CREATE LOOK

//   //////. START REPLACED CHAT WITH LINKS AND SEARCH NET

//   /** 🧠 Conversational fashion chat — now with visuals + links */
//   async chat(dto: ChatDto) {
//     const { messages } = dto;
//     const lastUserMsg = messages
//       .slice()
//       .reverse()
//       .find((m) => m.role === 'user')?.content;

//     if (!lastUserMsg) {
//       throw new Error('No user message provided');
//     }

//     // 1️⃣ Generate base text with OpenAI
//     const completion = await this.openai.chat.completions.create({
//       model: 'gpt-4o',
//       temperature: 0.8,
//       messages: [
//         {
//           role: 'system',
//           content: `
// You are a world-class personal fashion stylist.
// Respond naturally and helpfully about outfits, wardrobe planning, or styling.
// At the end of your reasoning, also return a short JSON block like:
// {"search_terms":["smart casual men","navy blazer outfit","loafers"]}
//         `,
//         },
//         ...messages,
//       ],
//     });

//     const aiReply =
//       completion.choices[0]?.message?.content?.trim() ||
//       'Styled response unavailable.';

//     // 2️⃣ Extract search terms if model provided them
//     let searchTerms: string[] = [];
//     const match = aiReply.match(/\{.*"search_terms":.*\}/s);
//     if (match) {
//       try {
//         const parsed = JSON.parse(match[0]);
//         searchTerms = parsed.search_terms ?? [];
//       } catch {
//         searchTerms = [];
//       }
//     }

//     // 3️⃣ Fallback heuristic: derive terms if none found
//     if (!searchTerms.length) {
//       const lowered = lastUserMsg.toLowerCase();
//       if (lowered.includes('smart')) searchTerms.push('smart casual outfit');
//       if (lowered.includes('summer')) searchTerms.push('summer outfit');
//       if (lowered.includes('work')) searchTerms.push('business casual look');
//       if (!searchTerms.length)
//         searchTerms.push(`${lowered} outfit inspiration`);
//     }

//     // 4️⃣ Fetch Unsplash images
//     const images = await this.fetchUnsplash(searchTerms);

//     // 5️⃣ Build shoppable links
//     const links = searchTerms.map((term) => ({
//       label: `Shop ${term} on ASOS`,
//       url: `https://www.asos.com/search/?q=${encodeURIComponent(term)}`,
//     }));

//     return { reply: aiReply, images, links };
//   }

//   /** 🔍 Lightweight Unsplash fetch helper */
//   private async fetchUnsplash(terms: string[]) {
//     const key = process.env.UNSPLASH_ACCESS_KEY;
//     if (!key || !terms.length) return [];
//     const q = encodeURIComponent(terms[0]);
//     const res = await fetch(
//       `https://api.unsplash.com/search/photos?query=${q}&per_page=5&client_id=${key}`,
//     );
//     if (!res.ok) return [];
//     const json = await res.json();
//     return json.results.map((r) => ({
//       imageUrl: r.urls.small,
//       title: r.description || r.alt_description,
//       sourceLink: r.links.html,
//     }));
//   }

//   /** 🌤️ Suggest daily style plan */
//   async suggest(body: {
//     user?: string;
//     weather?: any;
//     wardrobe?: any[];
//     preferences?: Record<string, any>;
//   }) {
//     const { user, weather, wardrobe, preferences } = body;

//     const temp = weather?.fahrenheit?.main?.temp;
//     const tempDesc = temp
//       ? `${temp}°F and ${temp < 60 ? 'cool' : temp > 85 ? 'warm' : 'mild'} weather`
//       : 'unknown temperature';

//     const wardrobeCount = wardrobe?.length || 0;

//     const systemPrompt = `
// You are a luxury personal stylist.
// Your goal is to provide a daily style briefing that helps the user feel prepared, stylish, and confident.
// Be concise, intelligent, and polished — similar to a stylist at a high-end menswear brand.

// Output must be JSON with:
// - suggestion
// - insight
// - tomorrow
// Optionally include seasonalForecast, lifecycleForecast, styleTrajectory.
// `;

//     const userPrompt = `
// Client: ${user || 'The user'}
// Weather: ${tempDesc}
// Wardrobe items: ${wardrobeCount}
// Preferences: ${JSON.stringify(preferences || {})}
// `;

//     const completion = await this.openai.chat.completions.create({
//       model: 'gpt-4o',
//       temperature: 0.8,
//       messages: [
//         { role: 'system', content: systemPrompt },
//         { role: 'user', content: userPrompt },
//       ],
//       response_format: { type: 'json_object' },
//     });

//     const raw = completion.choices[0]?.message?.content;
//     if (!raw) throw new Error('No suggestion response received from model.');

//     let parsed: {
//       suggestion: string;
//       insight: string;
//       tomorrow: string;
//       seasonalForecast?: string;
//       lifecycleForecast?: string;
//       styleTrajectory?: string;
//     };

//     try {
//       parsed = JSON.parse(raw);
//     } catch {
//       console.error('❌ Failed to parse AI JSON:', raw);
//       throw new Error('AI response was not valid JSON.');
//     }

//     if (!parsed.seasonalForecast) {
//       parsed.seasonalForecast = generateSeasonalForecast(wardrobe);
//     }

//     return parsed;
//   }
// }

// // END REPLACED CHAT WITH LINKS AND SEARCH NET
