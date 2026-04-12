import {
  Controller,
  Post,
  Body,
  Req,
  Res,
  BadRequestException,
  Get,
  Query,
  UseGuards,
  Delete,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import { FastifyRequest } from 'fastify';
import { AiService } from './ai.service';
import { DatabaseService } from '../db/database.service';
import { ChatDto } from './dto/chat.dto';
import { Readable } from 'stream';
import { getSecret } from '../config/secrets';

@Throttle({ default: { limit: 15, ttl: 60000 } }) // 15 requests per minute for AI endpoints
@UseGuards(AuthGuard('jwt')) // All AI endpoints require authentication
@Controller('ai')
export class AiController {
  aiService: any;
  constructor(
    private readonly service: AiService,
    private readonly db: DatabaseService,
  ) {}

  @Post('chat')
  async chat(
    @Req() req: FastifyRequest & { user: { userId: string } },
    @Body() dto: ChatDto,
  ) {
    const userId = req.user.userId;
    try {
      // Enforce per-user quota (15 AI calls per minute already via Throttle, but add user tracking)
      return await this.service.chat({ ...dto, user_id: userId });
    } catch (err) {
      console.error('❌ [AI Controller] chat() failed:', err);
      throw err;
    }
  }

  @Post('suggest')
  suggest(
    @Req() req: FastifyRequest & { user: { userId: string } },
    @Body() body: any,
  ) {
    const userId = req.user.userId;
    return this.service.suggest({ ...body, user_id: userId });
  }

  @Post('analyze')
  analyze(@Body() body: { imageUrl: string }) {
    // User authenticated via class-level guard
    return this.service.analyze(body.imageUrl);
  }

  @Post('recreate')
  recreate(
    @Req() req: FastifyRequest & { user: { userId: string } },
    @Body()
    body: {
      tags: string[];
      image_url?: string;
      user_gender?: string;
    },
  ) {
    const userId = req.user.userId;
    return this.service.recreate(
      userId,
      body.tags,
      body.image_url,
      body.user_gender,
    );
  }

  @Post('personalized-shop')
  personalizedShop(
    @Req() req: FastifyRequest & { user: { userId: string } },
    @Body() body: { image_url: string; gender?: string },
  ) {
    const userId = req.user.userId;
    return this.service.personalizedShop(userId, body.image_url, body.gender);
  }

  @Post('recreate-visual')
  recreateVisual(
    @Req() req: FastifyRequest & { user: { userId: string } },
    @Body()
    body: {
      image_url: string;
      user_gender?: string;
    },
  ) {
    const userId = req.user.userId;
    return this.service.recreateVisual(
      userId,
      body.image_url,
      body.user_gender,
    );
  }

  @Post('similar-looks')
  async findSimilar(@Body('imageUrl') rawUrl: string) {
    console.log('🔍 [similar-looks] Received request with imageUrl:', rawUrl);
    if (!rawUrl) throw new Error('Missing imageUrl');
    let imageUrl = rawUrl;

    if (imageUrl.includes('_next/image') && imageUrl.includes('?url=')) {
      const extracted = decodeURIComponent(
        imageUrl.split('?url=')[1].split('&')[0],
      );
      imageUrl = extracted;
    }

    const serpUrl = `https://serpapi.com/search.json?engine=google_lens&url=${encodeURIComponent(
      imageUrl,
    )}&hl=en&gl=us&api_key=${getSecret('SERPAPI_KEY')}`;

    console.log('🔍 [similar-looks] Calling SerpAPI with URL:', imageUrl);

    try {
      const res = await fetch(serpUrl);
      console.log('🔍 [similar-looks] SerpAPI response status:', res.status);
      if (!res.ok) throw new Error(`SerpAPI failed (${res.status})`);
      const json = await res.json();

      console.log(
        '🔍 [similar-looks] SerpAPI response keys:',
        Object.keys(json || {}),
      );

      // Try multiple result fields - Google Lens returns different structures
      const matches =
        json?.visual_matches ||
        json?.shopping_results ||
        json?.inline_images ||
        json?.image_results ||
        json?.knowledge_graph?.similar_items ||
        [];

      console.log('🔍 [similar-looks] Found', matches.length, 'matches');

      if (!matches.length) {
        console.warn('🔍 [similar-looks] No matches found for:', imageUrl);
        return [];
      }

      return matches.slice(0, 12).map((m: any) => {
        // 🏷️ Normalize Price
        let price: string | null = null;

        if (m.price) {
          if (typeof m.price === 'string') {
            price = m.price;
          } else if (typeof m.price === 'object') {
            const val = m.price.value || m.price.extracted_value;
            const cur = m.price.currency || '';
            if (val) {
              const hasSymbol =
                typeof val === 'string' && val.trim().startsWith('$');
              price = hasSymbol
                ? val
                : `${cur && !val.toString().includes(cur) ? cur : ''}${val}`;
            }
          }
        } else if (m.priceText) {
          price = m.priceText;
        }

        // ✅ Cleanup duplicate or malformed symbols
        if (price) {
          price = price
            .replace(/\*/g, '') // ← removes all asterisks
            .replace(/\s+/g, ' ')
            .replace(/^\$\$/, '$')
            .replace(/^(\$ )/, '$')
            .trim();
        }

        // 🏢 Normalize brand/source
        const link = m.link || m.source || '';
        const hostname = (() => {
          try {
            return link ? new URL(link).hostname.replace(/^www\./, '') : '';
          } catch {
            return '';
          }
        })();

        const brand =
          m.merchant ||
          m.store ||
          m.source ||
          (hostname ? hostname.split('.')[0].toUpperCase() : 'Online Store');

        return {
          title: m.title || m.source || 'Similar Look',
          image: m.thumbnail || m.original || m.image,
          link,
          brand,
          price,
          source: hostname || brand,
        };
      });
    } catch (err: any) {
      console.error('❌ [AI] similar-looks error:', err.message, err.stack);
      throw new BadRequestException(
        `Similar looks search failed: ${err.message}`,
      );
    }
  }

  /**
   * 👗 Recreate Full Outfit - Analyzes outfit image, identifies each piece,
   * and searches Google Shopping for matching items for each piece
   */
  @Post('recreate-outfit')
  async recreateOutfit(
    @Req() req: FastifyRequest & { user: { userId: string } },
    @Body() body: { imageUrl: string; gender?: string },
  ) {
    const { imageUrl, gender } = body;
    console.log('[recreate-outfit] RECEIVED imageUrl:', imageUrl);
    // console.log('👗 [recreate-outfit] Starting outfit recreation for:', imageUrl);

    if (!imageUrl) throw new BadRequestException('Missing imageUrl');

    const detectedPresentation =
      await this.service.classifyProductPresentation(imageUrl);

    let targetPresentation: 'masculine' | 'feminine';

    if (detectedPresentation === 'masculine') {
      targetPresentation = 'masculine';
    } else if (detectedPresentation === 'feminine') {
      targetPresentation = 'feminine';
    } else {
      // HARD FAIL CLOSED
      throw new BadRequestException('Unable to determine gender from image');
    }

    try {
      // Step 1: Use AI to analyze the image and identify each clothing piece
      // console.log('👗 [recreate-outfit] Step 1: Analyzing outfit with AI...');
      if (
        typeof imageUrl !== 'string' ||
        !imageUrl.startsWith('http') ||
        imageUrl.includes('farfetch-contents.com')
      ) {
        throw new BadRequestException('Invalid recreate imageUrl');
      }

      const outfitPieces = await this.service.analyzeOutfitPieces(
        imageUrl,
        undefined,
      );
      // console.log('👗 [recreate-outfit] Identified pieces:', outfitPieces);

      if (!outfitPieces || outfitPieces.length === 0) {
        return { pieces: [], error: 'Could not identify outfit pieces' };
      }

      // Step 2: Search Google Shopping for each piece
      // console.log('👗 [recreate-outfit] Step 2: Searching for each piece...');
      const results = await Promise.all(
        outfitPieces.map(async (piece: any) => {
          // Build search query - prioritize brand/logo if available
          const brandPart = piece.brand ? `${piece.brand} ` : '';
          const searchQuery =
            `${brandPart}${piece.color || ''} ${piece.item} ${piece.style || ''}`.trim();
          // console.log(`👗 [recreate-outfit] Searching for: "${searchQuery}" (brand: ${piece.brand || 'none'})`);

          try {
            let products = await this.searchGoogleShopping(
              searchQuery,
              undefined,
            );

            const textFiltered = products.filter((p: any) => {
              const text = `${p.title ?? ''} ${p.name ?? ''} ${p.product_title ?? ''}`
                .toLowerCase();

              if (targetPresentation === 'masculine') {
                return !/(women|woman|female|ladies|girls|girl|womens|women's|junior|juniors|kids|kid|toddler|youth)/i.test(text);
              }

              if (targetPresentation === 'feminine') {
                return !/(men|man|male|mens|men's|boys|boy|youth|junior|juniors|kids|kid|toddler)/i.test(text);
              }

              return true;
            });

            let filteredProducts: any[] = textFiltered;

            if (targetPresentation === 'masculine' || targetPresentation === 'feminine') {
              const classified = await Promise.all(
                textFiltered.map(async (product: any) => {
                  const candidate =
                    typeof product.image === 'string' && product.image.startsWith('http')
                      ? product.image
                      : typeof product.thumbnail === 'string' && product.thumbnail.startsWith('http')
                      ? product.thumbnail
                      : null;

                  if (!candidate) {
                    return { product, keep: false };
                  }

                  try {
                    const presentation =
                      await this.service.classifyProductPresentation(candidate);

                    if (presentation === 'unknown') {
                      return { product, keep: false };
                    }

                    if (
                      targetPresentation === 'masculine' &&
                      presentation === 'feminine'
                    ) {
                      return { product, keep: false };
                    }

                    if (
                      targetPresentation === 'feminine' &&
                      presentation === 'masculine'
                    ) {
                      return { product, keep: false };
                    }

                    return { product, keep: true };
                  } catch {
                    return { product, keep: false };
                  }
                }),
              );

              filteredProducts = classified
                .filter(c => c.keep)
                .map(c => c.product);
            }

            return {
              category: piece.category,
              item: piece.item,
              color: piece.color,
              material: piece.material,
              style: piece.style,
              brand: piece.brand,
              searchQuery,
              products: filteredProducts.slice(0, 6),
            };
          } catch (err) {
            console.error(
              `👗 [recreate-outfit] Search failed for ${piece.item}:`,
              err,
            );
            return {
              category: piece.category,
              item: piece.item,
              color: piece.color,
              brand: piece.brand,
              products: [],
            };
          }
        }),
      );

      // console.log('👗 [recreate-outfit] Complete! Found products for', results.filter(r => r.products.length > 0).length, 'pieces');

      return {
        pieces: results,
        totalPieces: outfitPieces.length,
      };
    } catch (err: any) {
      console.error('❌ [recreate-outfit] Error:', err.message, err.stack);
      throw new BadRequestException(`Outfit recreation failed: ${err.message}`);
    }
  }

  /**
   * Helper: Search Google Shopping via SerpAPI
   */
  private async searchGoogleShopping(
    query: string,
    gender?: string,
  ): Promise<any[]> {
    const genderQuery = gender ? ` ${gender}'s` : '';
    const fullQuery = `${query}${genderQuery}`;

    const serpUrl = `https://serpapi.com/search.json?engine=google_shopping&q=${encodeURIComponent(
      fullQuery,
    )}&hl=en&gl=us&api_key=${getSecret('SERPAPI_KEY')}`;

    const res = await fetch(serpUrl);
    if (!res.ok)
      throw new Error(`Google Shopping search failed (${res.status})`);

    const json = await res.json();
    const results = json?.shopping_results || [];

    return results.map((item: any) => {
      let price: string | null = null;
      if (item.price) {
        price =
          typeof item.price === 'string'
            ? item.price
            : `$${item.extracted_price || item.price}`;
      }

      return {
        title: item.title || 'Product',
        image: item.thumbnail || null,
        link: item.link || item.product_link || '',
        price,
        brand: item.source || item.merchant?.name || 'Shop',
        source: item.source || '',
        rating: item.rating || null,
        reviews: item.reviews || null,
      };
    });
  }

  /* 🧾 Decode Barcode or Clothing Label */
  @Post('decode-barcode')
  async decodeBarcode(
    @Req() req: FastifyRequest & { file: () => Promise<any> },
  ) {
    const mp = await (req as any).file?.();
    if (!mp) throw new BadRequestException('No file uploaded');

    const chunks: Buffer[] = [];
    for await (const chunk of mp.file) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);

    const result = await this.service.decodeBarcode({
      originalname: mp.filename,
      mimetype: mp.mimetype,
      buffer,
    } as any);

    return { success: true, ...result };
  }

  /* 🔍 Lookup product details by barcode */
  @Post('lookup-barcode')
  async lookupBarcode(@Body('upc') upc: string) {
    if (!upc) throw new BadRequestException('Missing UPC');
    return this.service.lookupProductByBarcode(upc);
  }

  @Delete('chat/clear')
  async clearChat(@Req() req: FastifyRequest & { user: { userId: string } }) {
    const userId = req.user.userId;
    return this.service.clearChatHistory(userId);
  }

  /* 🧹 Soft reset (keep long-term memory but remove short-term messages) */
  @Delete('chat/soft-reset')
  async softReset(@Req() req: FastifyRequest & { user: { userId: string } }) {
    const userId = req.user.userId;
    return this.service.softResetChat(userId);
  }

  /* 🔊 Text-to-Speech — returns MP3 buffer (Alloy voice) */
  @Post('tts')
  async textToSpeech(@Body('text') text: string, @Res() res: any) {
    if (!text) throw new BadRequestException('Missing text');
    try {
      const buffer = await this.service.generateSpeechBuffer(text);

      res.raw.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Content-Length': buffer.length,
      });
      res.raw.end(buffer);
    } catch (err: any) {
      console.error('❌ [AI Controller] TTS error stack:', err);
      const fallback = Buffer.from([0x49, 0x44, 0x33]); // "ID3"
      res.raw.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Content-Length': fallback.length,
      });
      res.raw.end(fallback);
    }
  }

  // @Get('tts')
  // async textToSpeechGet(@Query('text') text: string, @Res() res: any) {
  //   if (!text) throw new BadRequestException('Missing text');
  //   const buffer = await this.service.generateSpeechBuffer(text);
  //   res.raw.writeHead(200, {
  //     'Content-Type': 'audio/mpeg',
  //     'Content-Length': buffer.length,
  //   });
  //   res.raw.end(buffer);
  // }

  @Get('tts')
  async streamTts(@Query('text') text: string, @Res() res: any) {
    console.log(`🎙️ [TTS CALLED] "${text}" at`, new Date().toISOString());
    if (!text?.trim()) throw new BadRequestException('Missing text');

    try {
      console.log('🟡 [TTS] Generating speech stream for text:', text);
      const webStream = await this.service.generateSpeechStream(text);
      console.log('🟢 [TTS] Stream response type:', typeof webStream);

      if (!webStream) {
        console.error('❌ [TTS] No stream returned from service');
        res.raw.writeHead(500);
        res.raw.end('No stream returned');
        return;
      }

      const nodeStream = Readable.fromWeb(webStream as any);

      res.raw.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });

      nodeStream.on('data', (chunk: Buffer) => {
        res.raw.write(chunk);
        if (res.raw.flush) res.raw.flush();
      });

      nodeStream.on('end', () => {
        res.raw.end();
        console.log('✅ [TTS] Stream finished');
      });

      nodeStream.on('error', (err: any) => {
        console.error('❌ [TTS] Node stream error:', err);
        if (!res.raw.headersSent) res.raw.writeHead(500);
        res.raw.end();
      });
    } catch (err: any) {
      console.error('❌ [AI Controller] TTS stream error:', err);
      if (!res.raw.headersSent) {
        res.raw.writeHead(500);
        res.raw.end();
      }
    }
  }
}

///////////////

// import {
//   Controller,
//   Post,
//   Body,
//   Req,
//   Res,
//   BadRequestException,
//   Get,
//   Query,
// } from '@nestjs/common';
// import { FastifyRequest } from 'fastify';
// import { AiService } from './ai.service';
// import { ChatDto } from './dto/chat.dto';
// import { Delete, Param } from '@nestjs/common';
// import { Readable } from 'stream';

// @Controller('ai')
// export class AiController {
//   aiService: any;
//   constructor(private readonly service: AiService) {}

//   @Post('chat')
//   chat(@Body() dto: ChatDto) {
//     return this.service.chat(dto);
//   }

//   @Post('suggest')
//   suggest(@Body() body: any) {
//     return this.service.suggest(body);
//   }

//   @Post('analyze')
//   analyze(@Body() body: { imageUrl: string }) {
//     return this.service.analyze(body.imageUrl);
//   }

//   @Post('recreate')
//   recreate(
//     @Body()
//     body: {
//       user_id: string;
//       tags: string[];
//       image_url?: string;
//       user_gender?: string;
//     },
//   ) {
//     return this.service.recreate(
//       body.user_id,
//       body.tags,
//       body.image_url,
//       body.user_gender,
//     );
//   }

//   @Post('personalized-shop')
//   personalizedShop(
//     @Body() body: { user_id: string; image_url: string; gender?: string },
//   ) {
//     return this.service.personalizedShop(
//       body.user_id,
//       body.image_url,
//       body.gender,
//     );
//   }

//   @Post('similar-looks')
//   async findSimilar(@Body('imageUrl') rawUrl: string) {
//     if (!rawUrl) throw new Error('Missing imageUrl');
//     let imageUrl = rawUrl;

//     if (imageUrl.includes('_next/image') && imageUrl.includes('?url=')) {
//       const extracted = decodeURIComponent(
//         imageUrl.split('?url=')[1].split('&')[0],
//       );
//       imageUrl = extracted;
//     }

//     const serpUrl = `https://serpapi.com/search.json?engine=google_lens&url=${encodeURIComponent(
//       imageUrl,
//     )}&hl=en&gl=us&api_key=${process.env.SERPAPI_KEY}`;

//     try {
//       const res = await fetch(serpUrl);
//       if (!res.ok) throw new Error(`SerpAPI failed (${res.status})`);
//       const json = await res.json();

//       const matches =
//         json?.visual_matches ||
//         json?.inline_images ||
//         json?.image_results ||
//         [];

//       if (!matches.length) return [];

//       return matches.slice(0, 12).map((m: any) => {
//         // 🏷️ Normalize Price
//         let price: string | null = null;

//         if (m.price) {
//           if (typeof m.price === 'string') {
//             price = m.price;
//           } else if (typeof m.price === 'object') {
//             const val = m.price.value || m.price.extracted_value;
//             const cur = m.price.currency || '';
//             if (val) {
//               const hasSymbol =
//                 typeof val === 'string' && val.trim().startsWith('$');
//               price = hasSymbol
//                 ? val
//                 : `${cur && !val.toString().includes(cur) ? cur : ''}${val}`;
//             }
//           }
//         } else if (m.priceText) {
//           price = m.priceText;
//         }

//         // ✅ Cleanup duplicate or malformed symbols
//         if (price) {
//           price = price
//             .replace(/\*/g, '') // ← removes all asterisks
//             .replace(/\s+/g, ' ')
//             .replace(/^\$\$/, '$')
//             .replace(/^(\$ )/, '$')
//             .trim();
//         }

//         // 🏢 Normalize brand/source
//         const link = m.link || m.source || '';
//         const hostname = (() => {
//           try {
//             return link ? new URL(link).hostname.replace(/^www\./, '') : '';
//           } catch {
//             return '';
//           }
//         })();

//         const brand =
//           m.merchant ||
//           m.store ||
//           m.source ||
//           (hostname ? hostname.split('.')[0].toUpperCase() : 'Online Store');

//         return {
//           title: m.title || m.source || 'Similar Look',
//           image: m.thumbnail || m.original || m.image,
//           link,
//           brand,
//           price,
//           source: hostname || brand,
//         };
//       });
//     } catch (err: any) {
//       console.error('❌ [AI] similar-looks error:', err.message);
//       return [];
//     }
//   }

//   /* 🧾 Decode Barcode or Clothing Label */
//   @Post('decode-barcode')
//   async decodeBarcode(
//     @Req() req: FastifyRequest & { file: () => Promise<any> },
//   ) {
//     const mp = await (req as any).file?.();
//     if (!mp) throw new BadRequestException('No file uploaded');

//     const chunks: Buffer[] = [];
//     for await (const chunk of mp.file) chunks.push(chunk);
//     const buffer = Buffer.concat(chunks);

//     const result = await this.service.decodeBarcode({
//       originalname: mp.filename,
//       mimetype: mp.mimetype,
//       buffer,
//     } as any);

//     return { success: true, ...result };
//   }

//   /* 🔍 Lookup product details by barcode */
//   @Post('lookup-barcode')
//   async lookupBarcode(@Body('upc') upc: string) {
//     if (!upc) throw new BadRequestException('Missing UPC');
//     return this.service.lookupProductByBarcode(upc);
//   }

//   @Delete('chat/clear/:user_id')
//   async clearChat(@Param('user_id') user_id: string) {
//     return this.service.clearChatHistory(user_id);
//   }

//   /* 🧹 Soft reset (keep long-term memory but remove short-term messages) */
//   @Delete('chat/soft-reset/:user_id')
//   async softReset(@Param('user_id') user_id: string) {
//     return this.service.softResetChat(user_id);
//   }

//   /* 🔊 Text-to-Speech — returns MP3 buffer (Alloy voice) */
//   @Post('tts')
//   async textToSpeech(@Body('text') text: string, @Res() res: any) {
//     if (!text) throw new BadRequestException('Missing text');
//     try {
//       const buffer = await this.service.generateSpeechBuffer(text);

//       res.raw.writeHead(200, {
//         'Content-Type': 'audio/mpeg',
//         'Content-Length': buffer.length,
//       });
//       res.raw.end(buffer);
//     } catch (err: any) {
//       console.error('❌ [AI Controller] TTS error stack:', err);
//       const fallback = Buffer.from([0x49, 0x44, 0x33]); // "ID3"
//       res.raw.writeHead(200, {
//         'Content-Type': 'audio/mpeg',
//         'Content-Length': fallback.length,
//       });
//       res.raw.end(fallback);
//     }
//   }

//   // @Get('tts')
//   // async textToSpeechGet(@Query('text') text: string, @Res() res: any) {
//   //   if (!text) throw new BadRequestException('Missing text');
//   //   const buffer = await this.service.generateSpeechBuffer(text);
//   //   res.raw.writeHead(200, {
//   //     'Content-Type': 'audio/mpeg',
//   //     'Content-Length': buffer.length,
//   //   });
//   //   res.raw.end(buffer);
//   // }

//   @Get('tts')
//   async streamTts(@Query('text') text: string, @Res() res: any) {
//     console.log(`🎙️ [TTS CALLED] "${text}" at`, new Date().toISOString());
//     if (!text?.trim()) throw new BadRequestException('Missing text');

//     try {
//       console.log('🟡 [TTS] Generating speech stream for text:', text);
//       const webStream = await this.service.generateSpeechStream(text);
//       console.log('🟢 [TTS] Stream response type:', typeof webStream);

//       if (!webStream) {
//         console.error('❌ [TTS] No stream returned from service');
//         res.raw.writeHead(500);
//         res.raw.end('No stream returned');
//         return;
//       }

//       const nodeStream = Readable.fromWeb(webStream as any);

//       res.raw.writeHead(200, {
//         'Content-Type': 'audio/mpeg',
//         'Transfer-Encoding': 'chunked',
//         'Cache-Control': 'no-cache, no-transform',
//         Connection: 'keep-alive',
//       });

//       nodeStream.on('data', (chunk: Buffer) => {
//         res.raw.write(chunk);
//         if (res.raw.flush) res.raw.flush();
//       });

//       nodeStream.on('end', () => {
//         res.raw.end();
//         console.log('✅ [TTS] Stream finished');
//       });

//       nodeStream.on('error', (err: any) => {
//         console.error('❌ [TTS] Node stream error:', err);
//         if (!res.raw.headersSent) res.raw.writeHead(500);
//         res.raw.end();
//       });
//     } catch (err: any) {
//       console.error('❌ [AI Controller] TTS stream error:', err);
//       if (!res.raw.headersSent) {
//         res.raw.writeHead(500);
//         res.raw.end();
//       }
//     }
//   }
// }

///////////////////

// import {
//   Controller,
//   Post,
//   Body,
//   Req,
//   BadRequestException,
// } from '@nestjs/common';
// import { FastifyRequest } from 'fastify';
// import { AiService } from './ai.service';
// import { ChatDto } from './dto/chat.dto';
// import { Delete, Param } from '@nestjs/common';

// @Controller('ai')
// export class AiController {
//   constructor(private readonly service: AiService) {}

//   @Post('chat')
//   chat(@Body() dto: ChatDto) {
//     return this.service.chat(dto);
//   }

//   @Post('suggest')
//   suggest(@Body() body: any) {
//     return this.service.suggest(body);
//   }

//   @Post('analyze')
//   analyze(@Body() body: { imageUrl: string }) {
//     return this.service.analyze(body.imageUrl);
//   }

//   @Post('recreate')
//   recreate(
//     @Body()
//     body: {
//       user_id: string;
//       tags: string[];
//       image_url?: string;
//       user_gender?: string;
//     },
//   ) {
//     return this.service.recreate(
//       body.user_id,
//       body.tags,
//       body.image_url,
//       body.user_gender,
//     );
//   }

//   @Post('personalized-shop')
//   personalizedShop(
//     @Body() body: { user_id: string; image_url: string; gender?: string },
//   ) {
//     return this.service.personalizedShop(
//       body.user_id,
//       body.image_url,
//       body.gender,
//     );
//   }

//   @Post('similar-looks')
//   async findSimilar(@Body('imageUrl') rawUrl: string) {
//     if (!rawUrl) throw new Error('Missing imageUrl');
//     let imageUrl = rawUrl;

//     if (imageUrl.includes('_next/image') && imageUrl.includes('?url=')) {
//       const extracted = decodeURIComponent(
//         imageUrl.split('?url=')[1].split('&')[0],
//       );
//       imageUrl = extracted;
//     }

//     const serpUrl = `https://serpapi.com/search.json?engine=google_lens&url=${encodeURIComponent(
//       imageUrl,
//     )}&hl=en&gl=us&api_key=${process.env.SERPAPI_KEY}`;

//     try {
//       const res = await fetch(serpUrl);
//       if (!res.ok) throw new Error(`SerpAPI failed (${res.status})`);
//       const json = await res.json();

//       const matches =
//         json?.visual_matches ||
//         json?.inline_images ||
//         json?.image_results ||
//         [];

//       if (!matches.length) return [];

//       return matches.slice(0, 12).map((m: any) => {
//         // 🏷️ Normalize Price
//         let price: string | null = null;

//         if (m.price) {
//           if (typeof m.price === 'string') {
//             price = m.price;
//           } else if (typeof m.price === 'object') {
//             const val = m.price.value || m.price.extracted_value;
//             const cur = m.price.currency || '';
//             if (val) {
//               const hasSymbol =
//                 typeof val === 'string' && val.trim().startsWith('$');
//               price = hasSymbol
//                 ? val
//                 : `${cur && !val.toString().includes(cur) ? cur : ''}${val}`;
//             }
//           }
//         } else if (m.priceText) {
//           price = m.priceText;
//         }

//         // ✅ Cleanup duplicate or malformed symbols
//         if (price) {
//           price = price
//             .replace(/\*/g, '') // ← removes all asterisks
//             .replace(/\s+/g, ' ')
//             .replace(/^\$\$/, '$')
//             .replace(/^(\$ )/, '$')
//             .trim();
//         }

//         // 🏢 Normalize brand/source
//         const link = m.link || m.source || '';
//         const hostname = (() => {
//           try {
//             return link ? new URL(link).hostname.replace(/^www\./, '') : '';
//           } catch {
//             return '';
//           }
//         })();

//         const brand =
//           m.merchant ||
//           m.store ||
//           m.source ||
//           (hostname ? hostname.split('.')[0].toUpperCase() : 'Online Store');

//         return {
//           title: m.title || m.source || 'Similar Look',
//           image: m.thumbnail || m.original || m.image,
//           link,
//           brand,
//           price,
//           source: hostname || brand,
//         };
//       });
//     } catch (err: any) {
//       console.error('❌ [AI] similar-looks error:', err.message);
//       return [];
//     }
//   }

//   /* 🧾 Decode Barcode or Clothing Label */
//   @Post('decode-barcode')
//   async decodeBarcode(
//     @Req() req: FastifyRequest & { file: () => Promise<any> },
//   ) {
//     const mp = await (req as any).file?.();
//     if (!mp) throw new BadRequestException('No file uploaded');

//     const chunks: Buffer[] = [];
//     for await (const chunk of mp.file) chunks.push(chunk);
//     const buffer = Buffer.concat(chunks);

//     const result = await this.service.decodeBarcode({
//       originalname: mp.filename,
//       mimetype: mp.mimetype,
//       buffer,
//     } as any);

//     return { success: true, ...result };
//   }

//   /* 🔍 Lookup product details by barcode */
//   @Post('lookup-barcode')
//   async lookupBarcode(@Body('upc') upc: string) {
//     if (!upc) throw new BadRequestException('Missing UPC');
//     return this.service.lookupProductByBarcode(upc);
//   }

//   @Delete('chat/clear/:user_id')
//   async clearChat(@Param('user_id') user_id: string) {
//     return this.service.clearChatHistory(user_id);
//   }

//   /* 🧹 Soft reset (keep long-term memory but remove short-term messages) */
//   @Delete('chat/soft-reset/:user_id')
//   async softReset(@Param('user_id') user_id: string) {
//     return this.service.softResetChat(user_id);
//   }
// }

//////////////////

// import {
//   Controller,
//   Post,
//   Body,
//   Req,
//   BadRequestException,
// } from '@nestjs/common';
// import { FastifyRequest } from 'fastify';
// import { AiService } from './ai.service';
// import { ChatDto } from './dto/chat.dto';
// import { Delete, Param } from '@nestjs/common';

// @Controller('ai')
// export class AiController {
//   constructor(private readonly service: AiService) {}

//   @Post('chat')
//   chat(@Body() dto: ChatDto) {
//     return this.service.chat(dto);
//   }

//   @Post('suggest')
//   suggest(@Body() body: any) {
//     return this.service.suggest(body);
//   }

//   @Post('analyze')
//   analyze(@Body() body: { imageUrl: string }) {
//     return this.service.analyze(body.imageUrl);
//   }

//   @Post('recreate')
//   recreate(
//     @Body()
//     body: {
//       user_id: string;
//       tags: string[];
//       image_url?: string;
//       user_gender?: string;
//     },
//   ) {
//     return this.service.recreate(
//       body.user_id,
//       body.tags,
//       body.image_url,
//       body.user_gender,
//     );
//   }

//   @Post('personalized-shop')
//   personalizedShop(
//     @Body() body: { user_id: string; image_url: string; gender?: string },
//   ) {
//     return this.service.personalizedShop(
//       body.user_id,
//       body.image_url,
//       body.gender,
//     );
//   }

//   @Post('similar-looks')
//   async findSimilar(@Body('imageUrl') rawUrl: string) {
//     if (!rawUrl) throw new Error('Missing imageUrl');
//     let imageUrl = rawUrl;

//     if (imageUrl.includes('_next/image') && imageUrl.includes('?url=')) {
//       const extracted = decodeURIComponent(
//         imageUrl.split('?url=')[1].split('&')[0],
//       );
//       imageUrl = extracted;
//     }

//     const serpUrl = `https://serpapi.com/search.json?engine=google_lens&url=${encodeURIComponent(
//       imageUrl,
//     )}&hl=en&gl=us&api_key=${process.env.SERPAPI_KEY}`;

//     try {
//       const res = await fetch(serpUrl);
//       if (!res.ok) throw new Error(`SerpAPI failed (${res.status})`);
//       const json = await res.json();

//       const matches =
//         json?.visual_matches ||
//         json?.inline_images ||
//         json?.image_results ||
//         [];

//       if (!matches.length) return [];

//       return matches.slice(0, 12).map((m: any) => {
//         // 🏷️ Normalize Price
//         let price: string | null = null;

//         if (m.price) {
//           if (typeof m.price === 'string') {
//             price = m.price;
//           } else if (typeof m.price === 'object') {
//             const val = m.price.value || m.price.extracted_value;
//             const cur = m.price.currency || '';
//             if (val) {
//               const hasSymbol =
//                 typeof val === 'string' && val.trim().startsWith('$');
//               price = hasSymbol
//                 ? val
//                 : `${cur && !val.toString().includes(cur) ? cur : ''}${val}`;
//             }
//           }
//         } else if (m.priceText) {
//           price = m.priceText;
//         }

//         // ✅ Cleanup duplicate or malformed symbols
//         if (price) {
//           price = price
//             .replace(/\*/g, '') // ← removes all asterisks
//             .replace(/\s+/g, ' ')
//             .replace(/^\$\$/, '$')
//             .replace(/^(\$ )/, '$')
//             .trim();
//         }

//         // 🏢 Normalize brand/source
//         const link = m.link || m.source || '';
//         const hostname = (() => {
//           try {
//             return link ? new URL(link).hostname.replace(/^www\./, '') : '';
//           } catch {
//             return '';
//           }
//         })();

//         const brand =
//           m.merchant ||
//           m.store ||
//           m.source ||
//           (hostname ? hostname.split('.')[0].toUpperCase() : 'Online Store');

//         return {
//           title: m.title || m.source || 'Similar Look',
//           image: m.thumbnail || m.original || m.image,
//           link,
//           brand,
//           price,
//           source: hostname || brand,
//         };
//       });
//     } catch (err: any) {
//       console.error('❌ [AI] similar-looks error:', err.message);
//       return [];
//     }
//   }

//   /* 🧾 Decode Barcode or Clothing Label */
//   @Post('decode-barcode')
//   async decodeBarcode(
//     @Req() req: FastifyRequest & { file: () => Promise<any> },
//   ) {
//     const mp = await (req as any).file?.();
//     if (!mp) throw new BadRequestException('No file uploaded');

//     const chunks: Buffer[] = [];
//     for await (const chunk of mp.file) chunks.push(chunk);
//     const buffer = Buffer.concat(chunks);

//     const result = await this.service.decodeBarcode({
//       originalname: mp.filename,
//       mimetype: mp.mimetype,
//       buffer,
//     } as any);

//     return { success: true, ...result };
//   }

//   /* 🔍 Lookup product details by barcode */
//   @Post('lookup-barcode')
//   async lookupBarcode(@Body('upc') upc: string) {
//     if (!upc) throw new BadRequestException('Missing UPC');
//     return this.service.lookupProductByBarcode(upc);
//   }

//   @Delete('chat/clear/:user_id')
//   async clearChat(@Param('user_id') user_id: string) {
//     return this.service.clearChatHistory(user_id);
//   }

//   /* 🧹 Soft reset (keep long-term memory but remove short-term messages) */
//   @Delete('chat/soft-reset/:user_id')
//   async softReset(@Param('user_id') user_id: string) {
//     return this.service.softResetChat(user_id);
//   }
// }

//////////////////////

// import {
//   Controller,
//   Post,
//   Body,
//   Req,
//   BadRequestException,
// } from '@nestjs/common';
// import { FastifyRequest } from 'fastify';
// import { AiService } from './ai.service';
// import { ChatDto } from './dto/chat.dto';

// @Controller('ai')
// export class AiController {
//   constructor(private readonly service: AiService) {}

//   @Post('chat')
//   chat(@Body() dto: ChatDto) {
//     return this.service.chat(dto);
//   }

//   @Post('suggest')
//   suggest(@Body() body: any) {
//     return this.service.suggest(body);
//   }

//   @Post('analyze')
//   analyze(@Body() body: { imageUrl: string }) {
//     return this.service.analyze(body.imageUrl);
//   }

//   @Post('recreate')
//   recreate(
//     @Body()
//     body: {
//       user_id: string;
//       tags: string[];
//       image_url?: string;
//       user_gender?: string;
//     },
//   ) {
//     return this.service.recreate(
//       body.user_id,
//       body.tags,
//       body.image_url,
//       body.user_gender,
//     );
//   }

//   @Post('personalized-shop')
//   personalizedShop(
//     @Body() body: { user_id: string; image_url: string; gender?: string },
//   ) {
//     return this.service.personalizedShop(
//       body.user_id,
//       body.image_url,
//       body.gender,
//     );
//   }

//   // @Post('similar-looks')
//   // async findSimilar(@Body('imageUrl') rawUrl: string) {
//   //   if (!rawUrl) throw new Error('Missing imageUrl');
//   //   let imageUrl = rawUrl;

//   //   if (imageUrl.includes('_next/image') && imageUrl.includes('?url=')) {
//   //     const extracted = decodeURIComponent(
//   //       imageUrl.split('?url=')[1].split('&')[0],
//   //     );
//   //     imageUrl = extracted;
//   //   }

//   //   const serpUrl = `https://serpapi.com/search.json?engine=google_lens&url=${encodeURIComponent(
//   //     imageUrl,
//   //   )}&hl=en&gl=us&api_key=${process.env.SERPAPI_KEY}`;

//   //   try {
//   //     const res = await fetch(serpUrl);
//   //     if (!res.ok) throw new Error(`SerpAPI failed (${res.status})`);
//   //     const json = await res.json();
//   //     const matches =
//   //       json?.visual_matches ||
//   //       json?.inline_images ||
//   //       json?.image_results ||
//   //       [];

//   //     if (!matches.length) return [];

//   //     return matches.slice(0, 10).map((m: any) => ({
//   //       title: m.title || m.source || 'Similar look',
//   //       image: m.thumbnail || m.original || m.image,
//   //       link: m.link || m.source,
//   //     }));
//   //   } catch (err: any) {
//   //     console.error('❌ [AI] similar-looks error:', err.message);
//   //     return [];
//   //   }
//   // }

//   @Post('similar-looks')
//   async findSimilar(@Body('imageUrl') rawUrl: string) {
//     if (!rawUrl) throw new Error('Missing imageUrl');
//     let imageUrl = rawUrl;

//     if (imageUrl.includes('_next/image') && imageUrl.includes('?url=')) {
//       const extracted = decodeURIComponent(
//         imageUrl.split('?url=')[1].split('&')[0],
//       );
//       imageUrl = extracted;
//     }

//     const serpUrl = `https://serpapi.com/search.json?engine=google_lens&url=${encodeURIComponent(
//       imageUrl,
//     )}&hl=en&gl=us&api_key=${process.env.SERPAPI_KEY}`;

//     try {
//       const res = await fetch(serpUrl);
//       if (!res.ok) throw new Error(`SerpAPI failed (${res.status})`);
//       const json = await res.json();

//       const matches =
//         json?.visual_matches ||
//         json?.inline_images ||
//         json?.image_results ||
//         [];

//       if (!matches.length) return [];

//       return matches.slice(0, 12).map((m: any) => {
//         // 🏷️ Normalize Price
//         let price: string | null = null;

//         if (m.price) {
//           if (typeof m.price === 'string') {
//             price = m.price;
//           } else if (typeof m.price === 'object') {
//             const val = m.price.value || m.price.extracted_value;
//             const cur = m.price.currency || '';
//             if (val) {
//               const hasSymbol =
//                 typeof val === 'string' && val.trim().startsWith('$');
//               price = hasSymbol
//                 ? val
//                 : `${cur && !val.toString().includes(cur) ? cur : ''}${val}`;
//             }
//           }
//         } else if (m.priceText) {
//           price = m.priceText;
//         }

//         // ✅ Cleanup duplicate or malformed symbols
//         if (price) {
//           price = price
//             .replace(/\*/g, '') // ← removes all asterisks
//             .replace(/\s+/g, ' ')
//             .replace(/^\$\$/, '$')
//             .replace(/^(\$ )/, '$')
//             .trim();
//         }

//         // 🏢 Normalize brand/source
//         const link = m.link || m.source || '';
//         const hostname = (() => {
//           try {
//             return link ? new URL(link).hostname.replace(/^www\./, '') : '';
//           } catch {
//             return '';
//           }
//         })();

//         const brand =
//           m.merchant ||
//           m.store ||
//           m.source ||
//           (hostname ? hostname.split('.')[0].toUpperCase() : 'Online Store');

//         return {
//           title: m.title || m.source || 'Similar Look',
//           image: m.thumbnail || m.original || m.image,
//           link,
//           brand,
//           price,
//           source: hostname || brand,
//         };
//       });
//     } catch (err: any) {
//       console.error('❌ [AI] similar-looks error:', err.message);
//       return [];
//     }
//   }

//   /* 🧾 Decode Barcode or Clothing Label */
//   @Post('decode-barcode')
//   async decodeBarcode(
//     @Req() req: FastifyRequest & { file: () => Promise<any> },
//   ) {
//     const mp = await (req as any).file?.();
//     if (!mp) throw new BadRequestException('No file uploaded');

//     const chunks: Buffer[] = [];
//     for await (const chunk of mp.file) chunks.push(chunk);
//     const buffer = Buffer.concat(chunks);

//     const result = await this.service.decodeBarcode({
//       originalname: mp.filename,
//       mimetype: mp.mimetype,
//       buffer,
//     } as any);

//     return { success: true, ...result };
//   }

//   /* 🔍 Lookup product details by barcode */
//   @Post('lookup-barcode')
//   async lookupBarcode(@Body('upc') upc: string) {
//     if (!upc) throw new BadRequestException('Missing UPC');
//     return this.service.lookupProductByBarcode(upc);
//   }
// }

///////////////////

// import {
//   Controller,
//   Post,
//   Body,
//   Req,
//   BadRequestException,
// } from '@nestjs/common';
// import { FastifyRequest } from 'fastify';
// import { AiService } from './ai.service';
// import { ChatDto } from './dto/chat.dto';

// @Controller('ai')
// export class AiController {
//   constructor(private readonly service: AiService) {}

//   @Post('chat')
//   chat(@Body() dto: ChatDto) {
//     return this.service.chat(dto);
//   }

//   @Post('suggest')
//   suggest(@Body() body: any) {
//     return this.service.suggest(body);
//   }

//   @Post('analyze')
//   analyze(@Body() body: { imageUrl: string }) {
//     return this.service.analyze(body.imageUrl);
//   }

//   @Post('recreate')
//   recreate(
//     @Body()
//     body: {
//       user_id: string;
//       tags: string[];
//       image_url?: string;
//       user_gender?: string;
//     },
//   ) {
//     return this.service.recreate(
//       body.user_id,
//       body.tags,
//       body.image_url,
//       body.user_gender,
//     );
//   }

//   @Post('personalized-shop')
//   personalizedShop(
//     @Body() body: { user_id: string; image_url: string; gender?: string },
//   ) {
//     return this.service.personalizedShop(
//       body.user_id,
//       body.image_url,
//       body.gender,
//     );
//   }

//   @Post('similar-looks')
//   async findSimilar(@Body('imageUrl') rawUrl: string) {
//     if (!rawUrl) throw new Error('Missing imageUrl');
//     let imageUrl = rawUrl;

//     if (imageUrl.includes('_next/image') && imageUrl.includes('?url=')) {
//       const extracted = decodeURIComponent(
//         imageUrl.split('?url=')[1].split('&')[0],
//       );
//       imageUrl = extracted;
//     }

//     const serpUrl = `https://serpapi.com/search.json?engine=google_lens&url=${encodeURIComponent(
//       imageUrl,
//     )}&hl=en&gl=us&api_key=${process.env.SERPAPI_KEY}`;

//     try {
//       const res = await fetch(serpUrl);
//       if (!res.ok) throw new Error(`SerpAPI failed (${res.status})`);
//       const json = await res.json();
//       const matches =
//         json?.visual_matches ||
//         json?.inline_images ||
//         json?.image_results ||
//         [];

//       if (!matches.length) return [];

//       return matches.slice(0, 10).map((m: any) => ({
//         title: m.title || m.source || 'Similar look',
//         image: m.thumbnail || m.original || m.image,
//         link: m.link || m.source,
//       }));
//     } catch (err: any) {
//       console.error('❌ [AI] similar-looks error:', err.message);
//       return [];
//     }
//   }

//   /* 🧾 Decode Barcode — Fastify-safe version (no Multer) */
//   @Post('decode-barcode')
//   async decodeBarcode(
//     @Req() req: FastifyRequest & { file: () => Promise<any> },
//   ) {
//     const mp = await (req as any).file?.(); // ✅ Safely call file()
//     if (!mp) throw new BadRequestException('No file uploaded');

//     const chunks: Buffer[] = [];
//     for await (const chunk of mp.file) chunks.push(chunk);
//     const buffer = Buffer.concat(chunks);

//     return this.service.decodeBarcode({
//       originalname: mp.filename,
//       mimetype: mp.mimetype,
//       buffer,
//     } as any);
//   }

//   @Post('lookup-barcode')
//   async lookupBarcode(@Body('upc') upc: string) {
//     if (!upc) throw new Error('Missing UPC');
//     return this.service.lookupProductByBarcode(upc);
//   }
// }

//////////////////

// import {
//   Controller,
//   Post,
//   Body,
//   Req,
//   BadRequestException,
// } from '@nestjs/common';
// import { FastifyRequest } from 'fastify';
// import { AiService } from './ai.service';
// import { ChatDto } from './dto/chat.dto';

// @Controller('ai')
// export class AiController {
//   constructor(private readonly service: AiService) {}

//   @Post('chat')
//   chat(@Body() dto: ChatDto) {
//     return this.service.chat(dto);
//   }

//   @Post('suggest')
//   suggest(@Body() body: any) {
//     return this.service.suggest(body);
//   }

//   @Post('analyze')
//   analyze(@Body() body: { imageUrl: string }) {
//     return this.service.analyze(body.imageUrl);
//   }

//   @Post('recreate')
//   recreate(
//     @Body()
//     body: {
//       user_id: string;
//       tags: string[];
//       image_url?: string;
//       user_gender?: string;
//     },
//   ) {
//     return this.service.recreate(
//       body.user_id,
//       body.tags,
//       body.image_url,
//       body.user_gender,
//     );
//   }

//   @Post('personalized-shop')
//   personalizedShop(
//     @Body() body: { user_id: string; image_url: string; gender?: string },
//   ) {
//     return this.service.personalizedShop(
//       body.user_id,
//       body.image_url,
//       body.gender,
//     );
//   }

//   @Post('similar-looks')
//   async findSimilar(@Body('imageUrl') rawUrl: string) {
//     if (!rawUrl) throw new Error('Missing imageUrl');
//     let imageUrl = rawUrl;

//     if (imageUrl.includes('_next/image') && imageUrl.includes('?url=')) {
//       const extracted = decodeURIComponent(
//         imageUrl.split('?url=')[1].split('&')[0],
//       );
//       imageUrl = extracted;
//     }

//     const serpUrl = `https://serpapi.com/search.json?engine=google_lens&url=${encodeURIComponent(
//       imageUrl,
//     )}&hl=en&gl=us&api_key=${process.env.SERPAPI_KEY}`;

//     try {
//       const res = await fetch(serpUrl);
//       if (!res.ok) throw new Error(`SerpAPI failed (${res.status})`);
//       const json = await res.json();
//       const matches =
//         json?.visual_matches ||
//         json?.inline_images ||
//         json?.image_results ||
//         [];

//       if (!matches.length) return [];

//       return matches.slice(0, 10).map((m: any) => ({
//         title: m.title || m.source || 'Similar look',
//         image: m.thumbnail || m.original || m.image,
//         link: m.link || m.source,
//       }));
//     } catch (err: any) {
//       console.error('❌ [AI] similar-looks error:', err.message);
//       return [];
//     }
//   }

//   /* 🧾 Decode Barcode — Fastify-safe version (no Multer) */
//   @Post('decode-barcode')
//   async decodeBarcode(
//     @Req() req: FastifyRequest & { file: () => Promise<any> },
//   ) {
//     const mp = await (req as any).file?.(); // ✅ Safely call file()
//     if (!mp) throw new BadRequestException('No file uploaded');

//     const chunks: Buffer[] = [];
//     for await (const chunk of mp.file) chunks.push(chunk);
//     const buffer = Buffer.concat(chunks);

//     return this.service.decodeBarcode({
//       originalname: mp.filename,
//       mimetype: mp.mimetype,
//       buffer,
//     } as any);
//   }

//   @Post('lookup-barcode')
//   async lookupBarcode(@Body('upc') upc: string) {
//     if (!upc) throw new BadRequestException('Missing UPC');
//     return this.service.lookupProductByBarcode(upc);
//   }
// }

/////////////////

// import { Controller, Post, Body } from '@nestjs/common';
// import { AiService } from './ai.service';
// import { ChatDto } from './dto/chat.dto';

// @Controller('ai')
// export class AiController {
//   constructor(private readonly service: AiService) {}

//   @Post('chat')
//   chat(@Body() dto: ChatDto) {
//     return this.service.chat(dto);
//   }

//   // 🧠 New endpoint for AI stylist suggestions
//   @Post('suggest')
//   suggest(@Body() body: any) {
//     return this.service.suggest(body);
//   }

//   // 🧠 Analyze and Recreate endpoints for Inspiration Hub
//   @Post('analyze')
//   analyze(@Body() body: { imageUrl: string }) {
//     return this.service.analyze(body.imageUrl);
//   }

//   @Post('recreate')
//   recreate(
//     @Body()
//     body: {
//       user_id: string;
//       tags: string[];
//       image_url?: string;
//       user_gender?: string; // ✅ add gender param
//     },
//   ) {
//     // ✅ now pass it through
//     return this.service.recreate(
//       body.user_id,
//       body.tags,
//       body.image_url,
//       body.user_gender,
//     );
//   }

//   @Post('personalized-shop')
//   personalizedShop(
//     @Body() body: { user_id: string; image_url: string; gender?: string },
//   ) {
//     return this.service.personalizedShop(
//       body.user_id,
//       body.image_url,
//       body.gender,
//     );
//   }

//   @Post('similar-looks')
//   async findSimilar(@Body('imageUrl') rawUrl: string) {
//     if (!rawUrl) throw new Error('Missing imageUrl');

//     // 🧼 Clean _next/image URLs → extract the real image
//     let imageUrl = rawUrl;
//     if (imageUrl.includes('_next/image') && imageUrl.includes('?url=')) {
//       const extracted = decodeURIComponent(
//         imageUrl.split('?url=')[1].split('&')[0],
//       );
//       imageUrl = extracted;
//     }

//     const serpUrl = `https://serpapi.com/search.json?engine=google_lens&url=${encodeURIComponent(
//       imageUrl,
//     )}&hl=en&gl=us&api_key=${process.env.SERPAPI_KEY}`;

//     try {
//       const res = await fetch(serpUrl);
//       if (!res.ok) throw new Error(`SerpAPI failed (${res.status})`);
//       const json = await res.json();

//       const matches =
//         json?.visual_matches ||
//         json?.inline_images ||
//         json?.image_results ||
//         [];

//       if (!matches.length) {
//         console.warn('⚠️ [AI] No visual matches found for', imageUrl);
//         return [];
//       }

//       return matches.slice(0, 10).map((m: any) => ({
//         title: m.title || m.source || 'Similar look',
//         image: m.thumbnail || m.original || m.image,
//         link: m.link || m.source,
//       }));
//     } catch (err: any) {
//       console.error('❌ [AI] similar-looks error:', err.message);
//       return [];
//     }
//   }
// }
