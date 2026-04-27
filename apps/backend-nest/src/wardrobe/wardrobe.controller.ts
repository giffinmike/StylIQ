// apps/backend-nest/src/wardrobe/wardrobe.controller.ts

import {
  Controller,
  Post,
  Body,
  Get,
  Param,
  Delete,
  Put,
  Req,
  UseGuards,
  NotFoundException,
} from '@nestjs/common';
import { WardrobeService } from './wardrobe.service';
import { CreateWardrobeItemDto } from './dto/create-wardrobe-item.dto';
import { UpdateWardrobeItemDto } from './dto/update-wardrobe-item.dto';
import { DeleteItemDto } from './dto/delete-item.dto';
import { VertexService } from '../vertex/vertex.service';
import { randomUUID } from 'crypto';
import {
  AnalyzeImageRequestDto,
  AnalyzeImageResponseDto,
} from './dto/analyze-image.dto';
import { GenerateOutfitsDto } from './dto/generate-outfits.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Storage } from '@google-cloud/storage';
import { getSecret, getSecretJson, secretExists } from '../config/secrets';
import { AiOutfitStudioFacade } from './aiOutfitStudio/aiOutfitStudio.facade';

type GCPServiceAccount = {
  project_id: string;
  client_email: string;
  private_key: string;
  [key: string]: any;
};

// ─────────────────────────────────────────────────────────────
// Normalizer: coerce whatever the client sends into UserStyle
// ─────────────────────────────────────────────────────────────
function normalizeUserStyle(
  input: any,
): import('./logic/style').UserStyle | undefined {
  if (!input || typeof input !== 'object') return undefined;

  const asArr = (v: any) =>
    Array.isArray(v)
      ? v
          .map(String)
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
  const lc = (v: any) =>
    v == null ? undefined : String(v).trim().toLowerCase();

  const out: import('./logic/style').UserStyle = {};

  const preferredColors = asArr(input.preferredColors ?? input.favorite_colors);
  const avoidColors = asArr(input.avoidColors);
  const preferredCategories = asArr(input.preferredCategories);
  const avoidSubcategories = asArr(
    input.avoidSubcategories ?? input.disliked_styles,
  );
  const favoriteBrands = asArr(input.favoriteBrands ?? input.preferred_brands);

  if (preferredColors?.length) out.preferredColors = preferredColors;
  if (avoidColors?.length) out.avoidColors = avoidColors;
  if (preferredCategories?.length)
    out.preferredCategories = preferredCategories;
  if (avoidSubcategories?.length) out.avoidSubcategories = avoidSubcategories;
  if (favoriteBrands?.length) out.favoriteBrands = favoriteBrands;

  // Pass through dressBias if provided (already correct union on the type)
  if (input.dressBias) out.dressBias = input.dressBias;

  // Forward approved style-profile signals for Studio LLM prompt
  const styleKeywords = asArr(input.styleKeywords ?? input.style_keywords);
  const fitPreferences = asArr(input.fitPreferences ?? input.fit_preferences);
  const fabricPreferences = asArr(
    input.fabricPreferences ?? input.fabric_preferences,
  );
  const stylePreferences = asArr(
    input.stylePreferences ?? input.style_preferences,
  );
  const occasions = asArr(input.occasions);
  if (styleKeywords?.length) out.styleKeywords = styleKeywords;
  if (fitPreferences?.length) out.fitPreferences = fitPreferences;
  if (fabricPreferences?.length) out.fabricPreferences = fabricPreferences;
  if (stylePreferences?.length) out.stylePreferences = stylePreferences;
  if (occasions?.length) out.occasions = occasions;
  if (input.climate) out.climate = String(input.climate).trim();

  return Object.keys(out).length ? out : undefined;
}

@UseGuards(JwtAuthGuard)
@Controller('wardrobe')
export class WardrobeController {
  constructor(
    private readonly service: WardrobeService,
    private readonly vertex: VertexService,
    private readonly aiOutfitStudio: AiOutfitStudioFacade,
  ) {}

  @Post()
  create(@Req() req, @Body() dto: Omit<CreateWardrobeItemDto, 'user_id'>) {
    const user_id = req.user.userId;
    return this.service.createItem({ user_id, ...dto });
  }

  @Get()
  getByUserQuery(@Req() req) {
    return this.service.getItemsByUser(req.user.userId);
  }

  @Get('brands')
  getBrands(@Req() req) {
    return this.service.getWardrobeBrands(req.user.userId);
  }

  @Put(':item_id')
  async update(
    @Req() req,
    @Param('item_id') itemId: string,
    @Body() dto: UpdateWardrobeItemDto,
  ) {
    const result = await this.service.updateItem(itemId, req.user.userId, dto);
    if (!result) {
      throw new NotFoundException('Wardrobe item not found');
    }
    return result;
  }

  @Delete()
  delete(@Req() req, @Body() dto: Omit<DeleteItemDto, 'user_id'>) {
    const user_id = req.user.userId;
    return this.service.deleteItem({ user_id, ...dto });
  }

  @Post('suggest')
  suggest(@Req() req, @Body() body: { queryVec: number[] }) {
    return this.service.suggestOutfits(req.user.userId, body.queryVec);
  }

  @Post('search-text')
  searchText(@Req() req, @Body() b: { q: string; topK?: number }) {
    return this.service.searchText(req.user.userId, b.q, b.topK);
  }

  @Post('search-image')
  searchImage(@Req() req, @Body() b: { gcs_uri: string; topK?: number }) {
    return this.service.searchImage(req.user.userId, b.gcs_uri, b.topK);
  }

  @Post('search-hybrid')
  searchHybrid(
    @Req() req,
    @Body() b: { q?: string; gcs_uri?: string; topK?: number },
  ) {
    return this.service.searchHybrid(req.user.userId, b.q, b.gcs_uri, b.topK);
  }

  @Post('outfits')
  async generateOutfits(@Req() req, @Body() body: GenerateOutfitsDto) {
    const userId = req.user.userId;

    // ── STUDIO CONTAINMENT: force legacy generateOutfits() pipeline for all
    //    standard generation requests. Every fast-path branch in this handler
    //    gates on `body.useFastMode && !body.aaaaMode`, so forcing useFastMode
    //    to false makes them unreachable without modifying any shared logic.
    body.useFastMode = false;

    const weatherArg = body.useWeather === false ? undefined : body.weather;
    const userStyle = normalizeUserStyle(body.style_profile);

    // console.log('🚀 [OUTFITS] useFastMode:', body.useFastMode);
    // console.log('🚀 [OUTFITS] refinementPrompt:', body.refinementPrompt);
    // console.log('🚀 [OUTFITS] original query:', body.query);

    const requestId = randomUUID();
    console.log(`🔥 ROUTE DECISION: useFastMode=${body.useFastMode} aaaaMode=${body.aaaaMode}`);

    if (process.env.DEBUG_STUDIO === 'true') {
      const mode = body.useFastMode && !body.aaaaMode ? 'FAST' : 'SLOW';
      console.log(
        `🎯 [Studio] mode=${mode} reqId=${requestId} handler=generateOutfits`,
      );
    }

    // ── SWAP FAST PATH: detect "Replace ONLY the {slot}" swap requests ──
    // Routes to deterministic recomposition (~100ms) instead of full LLM (~50s)
    const swapMatch = body.refinementPrompt?.match(
      /^Replace ONLY the (top|bottom|shoes|outerwear|accessories)\b/i,
    );
    const locked = body.lockedItemIds ?? [];

    // ── LEARNING ACCEPT: pure logging, no generation ──
    if ((body as any).learning_accept === true && locked.length >= 2) {
      return this.aiOutfitStudio.mutateOutfit(userId, {
        currentItemIds: locked,
        refinementPrompt: '',
        weather: weatherArg,
        requestId,
        learning_accept: true,
      } as any);
    }

    if (
      swapMatch &&
      locked.length >= 2 &&
      body.useFastMode &&
      !body.aaaaMode
    ) {
      const swapSlot = swapMatch[1].toLowerCase();
      const newItemId = locked[locked.length - 1];
      const keptItemIds = locked.slice(0, -1);

      console.log(`⚡ [SWAP] Detected swap request: slot=${swapSlot} newItem=${newItemId} kept=${keptItemIds.length}`);

      const swapResult = await this.aiOutfitStudio.recomposeOutfitSlot(userId, {
        outfitItems: keptItemIds.map((id) => ({ id })),
        swapSlot,
        newItemId,
        weather: weatherArg,
        requestId,
      });

      // If recompose succeeds, return it; otherwise fall through to full generation
      if (swapResult) return swapResult;
      console.log('⚡ [SWAP] recomposeOutfitSlot returned null, falling through to full generation');
    }

    // ── REFINE FAST PATH: detect natural language slot refinements ──
    // "Keep the shirt and slacks but give me brown shoes instead"
    // Routes to deterministic mutation (~200ms) instead of full LLM (~50s)
    const isRefineCandidate = !swapMatch && !!body.refinementPrompt && locked.length >= 2 && !!body.useFastMode && !body.aaaaMode;
    // console.log(`REFINE_ROUTE_CHECK { reason: "swapMatch=${!!swapMatch} refinementPrompt=${!!body.refinementPrompt} locked=${locked.length} fastMode=${!!body.useFastMode} aaaaMode=${!!body.aaaaMode} => ${isRefineCandidate}" }`);

    if (isRefineCandidate) {
      console.log(`REFINE_ROUTE_ENTERED { reason: "prompt=${body.refinementPrompt} lockedCount=${locked.length}" }`);

      const mutateResult = await this.aiOutfitStudio.mutateOutfit(userId, {
        currentItemIds: locked,
        refinementPrompt: body.refinementPrompt!, // guarded by isRefineCandidate check
        weather: weatherArg,
        requestId,
      });

      if (mutateResult) return mutateResult;
      // mutateOutfit already logged MUTATE_OUTFIT_NULL with reason
    }

    // aaaaMode forces standard mode (overrides useFastMode)
    // Use fast mode if explicitly requested (and not aaaaMode)
    if (body.useFastMode && !body.aaaaMode) {
      if (body.refinementPrompt) {
        // console.log(`FALLBACK_TO_GENERATE_OUTFITS_FAST { reason: "refine attempted but mutateOutfit returned null or refine gate failed, falling through to LLM generation" }`);
      }

      // If there's a refinement prompt, append it to the query
      const queryWithRefinement = body.refinementPrompt
        ? `${body.query}. IMPORTANT REFINEMENT: User specifically requested: "${body.refinementPrompt}". You MUST incorporate this into ALL outfits.`
        : body.query;

      // console.log('🚀 [OUTFITS] queryWithRefinement:', queryWithRefinement);

      return this.aiOutfitStudio.generateOutfitsFast(userId, queryWithRefinement, {
        userStyle,
        weather: weatherArg,
        styleAgent: body.styleAgent,
        lockedItemIds: body.lockedItemIds ?? [],
        requestId,
      });
    }

    console.log('🔥 SLOW PATH EXECUTED');
    return this.aiOutfitStudio.generateOutfits(userId, body.query, body.topK || 5, {
      userStyle,
      weather: weatherArg,
      weights: body.weights as
        | import('./logic/scoring').ContextWeights
        | undefined,
      useWeather: body.useWeather ?? true,
      useFeedback: body.useFeedback,
      styleAgent: body.styleAgent,
      sessionId: body.session_id || (body as any).sessionId,
      refinementPrompt: body.refinementPrompt,
      lockedItemIds: body.lockedItemIds ?? [],
      requestId,
      aaaaMode: body.aaaaMode,
    });
  }

  /**
   * FAST Outfit Generation (New Architecture)
   * - Uses Gemini Flash for plan generation (no catalog in prompt)
   * - Backend queries Pinecone directly with Vertex embeddings
   * - ~90% cost reduction, ~95% latency reduction (1-2s vs 20-30s)
   */
  @Post('outfits/fast')
  generateOutfitsFast(
    @Req() req,
    @Body()
    body: {
      query: string;
      style_profile?: any;
      weather?: import('./logic/weather').WeatherContext;
      styleAgent?: string;
      lockedItemIds?: string[];
    },
  ) {
    const userId = req.user.userId;
    const userStyle = normalizeUserStyle(body.style_profile);

    return this.aiOutfitStudio.generateOutfitsFast(userId, body.query, {
      userStyle,
      weather: body.weather,
      styleAgent: body.styleAgent,
      lockedItemIds: body.lockedItemIds ?? [],
      requestId: randomUUID(),
    });
  }

  // ------- NEW: AI endpoints -------
  @Post('analyze')
  async analyze(
    @Body() dto: AnalyzeImageRequestDto,
  ): Promise<AnalyzeImageResponseDto> {
    const draft = await this.vertex.analyzeImage(dto.gsutil_uri, {
      dressCode: dto.dressCode,
      season: dto.season,
    });
    return { draft };
  }

  @Post('auto-create')
  async autoCreate(
    @Req() req,
    @Body()
    dto: Partial<CreateWardrobeItemDto> & {
      image_url: string;
      gsutil_uri?: string;
      object_key?: string;
      name?: string;
    },
  ) {
    // Run AI analysis and garment segmentation in parallel (independent I/O)
    const [draft, bgResult] = await Promise.all([
      dto.gsutil_uri
        ? this.vertex.analyzeImage(dto.gsutil_uri)
        : Promise.resolve({}),
      dto.object_key
        ? (async () => {
            console.log('[GarmentSegmentation] start', {
              user_id: req.user.userId,
              object_key: dto.object_key,
            });
            try {
              const credentials = getSecretJson<GCPServiceAccount>(
                'GCP_SERVICE_ACCOUNT_JSON',
              );
              const storage = new Storage({
                projectId: credentials.project_id,
                credentials,
              });
              const bucketName = secretExists('GCS_BUCKET_NAME')
                ? getSecret('GCS_BUCKET_NAME')
                : 'stylhelpr-prod-bucket';

              const bucket = storage.bucket(bucketName);
              const file = bucket.file(dto.object_key!);
              const [imageBuffer] = await file.download();

              const result = await this.vertex.removeBackground(
                imageBuffer,
                req.user.userId,
                dto.object_key!,
              );

              if (result) {
                console.log('[GarmentSegmentation] success', {
                  processed_object_key: result.processedGcsUri,
                });
              } else {
                console.log(
                  '[GarmentSegmentation] skipped (no result returned)',
                );
              }
              return result;
            } catch (err) {
              console.error('[GarmentSegmentation] failed', err);
              return null; // Non-blocking: continue without processed image
            }
          })()
        : Promise.resolve(null),
    ]);

    const payload: CreateWardrobeItemDto = this.service.composeFromAiDraft(
      { ...dto, user_id: req.user.userId } as any,
      draft,
    );

    if (bgResult) {
      payload.processed_image_url = bgResult.processedPublicUrl;
      payload.processed_gsutil_uri = bgResult.processedGcsUri;
    }

    return this.service.createItem(payload);
  }

  @Put('favorite/:item_id')
  async updateFavorite(
    @Req() req,
    @Param('item_id') itemId: string,
    @Body() body: { favorite: boolean },
  ) {
    const result = await this.service.updateFavorite(
      itemId,
      req.user.userId,
      body.favorite,
    );
    if (!result) {
      throw new NotFoundException('Wardrobe item not found');
    }
    return result;
  }

  @Post(':item_id/touch-up')
  async touchUp(@Req() req, @Param('item_id') itemId: string) {
    const userId = req.user.userId;
    const result = await this.service.touchUpItem(itemId, userId);
    if (!result) {
      throw new NotFoundException('Wardrobe item not found or touch-up failed');
    }
    return result;
  }

  @Post(':item_id/remove-background')
  async removeBackground(@Req() req, @Param('item_id') itemId: string) {
    const userId = req.user.userId;
    const result = await this.service.removeBackgroundItem(itemId, userId);
    if (!result) {
      throw new NotFoundException(
        'Wardrobe item not found or background removal failed',
      );
    }
    return result;
  }
}

/////////////////////

// // apps/backend-nest/src/wardrobe/wardrobe.controller.ts

// import {
//   Controller,
//   Post,
//   Body,
//   Get,
//   Param,
//   Delete,
//   Put,
//   Query,
// } from '@nestjs/common';
// import { WardrobeService } from './wardrobe.service';
// import { CreateWardrobeItemDto } from './dto/create-wardrobe-item.dto';
// import { UpdateWardrobeItemDto } from './dto/update-wardrobe-item.dto';
// import { DeleteItemDto } from './dto/delete-item.dto';
// import { VertexService } from '../vertex/vertex.service';
// import {
//   AnalyzeImageRequestDto,
//   AnalyzeImageResponseDto,
// } from './dto/analyze-image.dto';

// // ─────────────────────────────────────────────────────────────
// // Normalizer: coerce whatever the client sends into UserStyle
// // ─────────────────────────────────────────────────────────────
// function normalizeUserStyle(
//   input: any,
// ): import('./logic/style').UserStyle | undefined {
//   if (!input || typeof input !== 'object') return undefined;

//   const asArr = (v: any) =>
//     Array.isArray(v)
//       ? v
//           .map(String)
//           .map((s) => s.trim())
//           .filter(Boolean)
//       : undefined;
//   const lc = (v: any) =>
//     v == null ? undefined : String(v).trim().toLowerCase();

//   const out: import('./logic/style').UserStyle = {};

//   const preferredColors = asArr(input.preferredColors ?? input.favorite_colors);
//   const avoidColors = asArr(input.avoidColors);
//   const preferredCategories = asArr(input.preferredCategories);
//   const avoidSubcategories = asArr(
//     input.avoidSubcategories ?? input.disliked_styles,
//   );
//   const favoriteBrands = asArr(input.favoriteBrands ?? input.preferred_brands);

//   if (preferredColors?.length) out.preferredColors = preferredColors;
//   if (avoidColors?.length) out.avoidColors = avoidColors;
//   if (preferredCategories?.length)
//     out.preferredCategories = preferredCategories;
//   if (avoidSubcategories?.length) out.avoidSubcategories = avoidSubcategories;
//   if (favoriteBrands?.length) out.favoriteBrands = favoriteBrands;

//   // Pass through dressBias if provided (already correct union on the type)
//   if (input.dressBias) out.dressBias = input.dressBias;

//   return Object.keys(out).length ? out : undefined;
// }

// @Controller('wardrobe')
// export class WardrobeController {
//   constructor(
//     private readonly service: WardrobeService,
//     private readonly vertex: VertexService,
//   ) {}

//   @Post()
//   create(@Body() dto: CreateWardrobeItemDto) {
//     return this.service.createItem(dto);
//   }

//   @Get(':user_id')
//   getByUser(@Param('user_id') userId: string) {
//     return this.service.getItemsByUser(userId);
//   }

//   @Get()
//   getByUserQuery(@Query('user_id') userId: string) {
//     return this.service.getItemsByUser(userId);
//   }

//   @Put(':item_id')
//   update(@Param('item_id') itemId: string, @Body() dto: UpdateWardrobeItemDto) {
//     return this.service.updateItem(itemId, dto);
//   }

//   @Delete()
//   delete(@Body() dto: DeleteItemDto) {
//     return this.service.deleteItem(dto);
//   }

//   // ------- Vector search / outfits (existing) -------
//   @Post('suggest')
//   suggest(@Body() body: { user_id: string; queryVec: number[] }) {
//     return this.service.suggestOutfits(body.user_id, body.queryVec);
//   }

//   @Post('search-text')
//   searchText(@Body() b: { user_id: string; q: string; topK?: number }) {
//     return this.service.searchText(b.user_id, b.q, b.topK);
//   }

//   @Post('search-image')
//   searchImage(@Body() b: { user_id: string; gcs_uri: string; topK?: number }) {
//     return this.service.searchImage(b.user_id, b.gcs_uri, b.topK);
//   }

//   @Post('search-hybrid')
//   searchHybrid(
//     @Body() b: { user_id: string; q?: string; gcs_uri?: string; topK?: number },
//   ) {
//     return this.service.searchHybrid(b.user_id, b.q, b.gcs_uri, b.topK);
//   }

//   @Post('outfits')
//   generateOutfits(
//     @Body()
//     body: {
//       user_id: string;
//       query: string;
//       topK?: number;
//       style_profile?: any;
//       weather?: import('./logic/weather').WeatherContext;
//       useWeather?: boolean;
//       useFeedback?: boolean;
//       weights?: import('./logic/scoring').ContextWeights;
//       styleAgent?: 'agent1' | 'agent2' | 'agent3';
//       session_id?: string;
//       refinementPrompt?: string;
//       lockedItemIds?: string[]; // 👈 add this
//     },
//   ) {
//     const weatherArg = body.useWeather === false ? undefined : body.weather;
//     const userStyle = normalizeUserStyle(body.style_profile);

//     if (process.env.NODE_ENV !== 'production') {
//       console.log('[CTRL] raw style_profile =', body.style_profile);
//       console.log('[CTRL] useFeedback =', body.useFeedback);
//       console.log('[CTRL] styleAgent =', body.styleAgent);
//       console.log('[CTRL] session_id =', body.session_id);
//       console.log('[CTRL] refinementPrompt =', body.refinementPrompt);
//       console.log('[CTRL] lockedItemIds =', body.lockedItemIds); // 👈 add this
//     }

//     return this.service.generateOutfits(
//       body.user_id,
//       body.query,
//       body.topK || 5,
//       {
//         userStyle,
//         weather: weatherArg,
//         weights: body.weights,
//         useWeather: body.useWeather ?? true,
//         useFeedback: body.useFeedback,
//         styleAgent: body.styleAgent,
//         sessionId: body.session_id || (body as any).sessionId,
//         refinementPrompt: body.refinementPrompt,
//         lockedItemIds: body.lockedItemIds ?? [], // 👈 forward to service
//       },
//     );
//   }

//   // ------- NEW: AI endpoints -------
//   @Post('analyze')
//   async analyze(
//     @Body() dto: AnalyzeImageRequestDto,
//   ): Promise<AnalyzeImageResponseDto> {
//     const draft = await this.vertex.analyzeImage(dto.gsutil_uri, {
//       dressCode: dto.dressCode,
//       season: dto.season,
//     });
//     return { draft };
//   }

//   @Post('auto-create')
//   async autoCreate(
//     @Body()
//     dto: Partial<CreateWardrobeItemDto> & {
//       user_id: string;
//       image_url: string;
//       gsutil_uri?: string;
//       name?: string;
//     },
//   ) {
//     const draft = dto.gsutil_uri
//       ? await this.vertex.analyzeImage(dto.gsutil_uri)
//       : {};
//     const payload: CreateWardrobeItemDto = this.service.composeFromAiDraft(
//       dto as any,
//       draft,
//     );
//     return this.service.createItem(payload);
//   }

//   @Put('favorite/:item_id')
//   updateFavorite(
//     @Param('item_id') itemId: string,
//     @Body() body: { favorite: boolean },
//   ) {
//     return this.service.updateFavorite(itemId, body.favorite);
//   }
// }
