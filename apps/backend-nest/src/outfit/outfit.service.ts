import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SuggestOutfitDto } from './dto/suggest-outfit.dto';
import { OutfitFeedbackDto } from './dto/outfit-feedback.dto';
import { FavoriteOutfitDto } from './dto/favorite-outfit.dto';
import { pool } from '../db/pool';
import { LearningEventsService } from '../learning/learning-events.service';
import { FashionStateService } from '../learning/fashion-state.service';
import { LEARNING_FLAGS } from '../config/feature-flags';
import { extractOutfitFeatures } from '../learning/extract-outfit-features';

@Injectable()
export class OutfitService {
  private readonly logger = new Logger(OutfitService.name);

  constructor(
    private readonly learningEvents: LearningEventsService,
    private readonly fashionStateService: FashionStateService,
  ) {}

  async suggestOutfit(dto: SuggestOutfitDto) {
    const {
      user_id,
      prompt,
      name,
      thumbnail_url,
      top_id,
      bottom_id,
      shoes_id,
      accessory_ids,
      weather_data,
      location,
    } = dto;

    // 🔍 Debug log to verify input (you can remove later)
    // console.log('🧠 SuggestOutfit incoming IDs:', {
    //   top_id,
    //   bottom_id,
    //   shoes_id,
    // });

    // 🚨 Enforce presence of required wardrobe IDs
    if (!top_id || !bottom_id || !shoes_id) {
      throw new Error(
        `Missing required wardrobe IDs. Received: top_id=${top_id}, bottom_id=${bottom_id}, shoes_id=${shoes_id}`,
      );
    }

    const res = await pool.query(
      `INSERT INTO outfit_suggestions (
      user_id, prompt, name, thumbnail_url,
      top_id, bottom_id, shoes_id,
      accessory_ids, weather_data, location
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING *`,
      [
        user_id,
        prompt,
        name,
        thumbnail_url,
        top_id,
        bottom_id,
        shoes_id,
        accessory_ids,
        weather_data,
        location,
      ],
    );

    return res.rows[0];
  }

  async getSuggestions(userId: string) {
    // Ensure occasion column exists
    await pool.query(`
      ALTER TABLE outfit_suggestions ADD COLUMN IF NOT EXISTS occasion TEXT
    `);

    const res = await pool.query(
      `
      SELECT
        o.*,
        so.scheduled_for,
        t.id AS top_id, t.name AS top_name, COALESCE(NULLIF(t.touched_up_image_url, ''), NULLIF(t.processed_image_url, ''), t.image_url) AS top_image_url,
        b.id AS bottom_id, b.name AS bottom_name, COALESCE(NULLIF(b.touched_up_image_url, ''), NULLIF(b.processed_image_url, ''), b.image_url) AS bottom_image_url,
        s.id AS shoes_id, s.name AS shoes_name, COALESCE(NULLIF(s.touched_up_image_url, ''), NULLIF(s.processed_image_url, ''), s.image_url) AS shoes_image_url
      FROM outfit_suggestions o
      LEFT JOIN wardrobe_items t ON o.top_id = t.id
      LEFT JOIN wardrobe_items b ON o.bottom_id = b.id
      LEFT JOIN wardrobe_items s ON o.shoes_id = s.id
      LEFT JOIN (
        SELECT DISTINCT ON (ai_outfit_id)
          ai_outfit_id, scheduled_for
        FROM scheduled_outfits
        WHERE user_id = $1
        ORDER BY ai_outfit_id, scheduled_for DESC
      ) so ON so.ai_outfit_id = o.id
      WHERE o.user_id = $1
      ORDER BY o.suggested_at DESC
      `,
      [userId],
    );

    return res.rows.map((row) => ({
      id: row.id,
      name: row.name ?? '',
      createdAt: row.suggested_at,
      plannedDate: row.scheduled_for ?? null,
      notes: row.notes ?? '',
      rating: row.rating ?? null,
      thumbnailUrl: row.thumbnail_url ?? '',
      prompt: row.prompt ?? '',
      occasion: row.occasion ?? null,
      top: {
        id: row.top_id,
        name: row.top_name,
        image: row.top_image_url,
      },
      bottom: {
        id: row.bottom_id,
        name: row.bottom_name,
        image: row.bottom_image_url,
      },
      shoes: {
        id: row.shoes_id,
        name: row.shoes_name,
        image: row.shoes_image_url,
      },
    }));
  }

  async getSuggestionById(id: string) {
    const res = await pool.query(
      'SELECT * FROM outfit_suggestions WHERE id = $1',
      [id],
    );
    return res.rows[0] ?? { message: 'Not found' };
  }

  async submitFeedback(dto: OutfitFeedbackDto) {
    const { user_id, outfit_id, rating, notes } = dto;
    const res = await pool.query(
      `INSERT INTO outfit_feedback (
        user_id, outfit_id, rating, notes
      ) VALUES ($1, $2, $3, $4)
      RETURNING *`,
      [user_id, outfit_id, rating, notes],
    );

    // Emit OUTFIT_RATED learning event + inline recompute
    if (LEARNING_FLAGS.EVENTS_ENABLED && rating != null) {
      const isPositive = rating >= 4;
      const isNegative = rating <= 2;

      if (isPositive || isNegative) {
        try {
          const features = await extractOutfitFeatures(outfit_id);
          await this.learningEvents.logEvent({
            userId: user_id,
            eventType: isPositive
              ? 'OUTFIT_RATED_POSITIVE'
              : 'OUTFIT_RATED_NEGATIVE',
            entityType: 'outfit',
            entityId: outfit_id,
            signalPolarity: isPositive ? 1 : -1,
            signalWeight: 0.6,
            extractedFeatures: features,
            sourceFeature: 'outfits',
            clientEventId: `outfit_rated:${user_id}:${outfit_id}:${rating}`,
          });
          this.fashionStateService
            .computeAndSaveState(user_id)
            .catch((err) =>
              this.logger.error('[LEARNING INLINE] recompute failed', err),
            );
        } catch (err) {
          this.logger.error('[LEARNING] outfit rated event failed', err);
        }
      }
    }

    return res.rows[0];
  }

  async favoriteOutfit(dto: FavoriteOutfitDto) {
    const { user_id, outfit_id, outfit_type } = dto;
    const normalizedType = outfit_type === 'custom' ? 'custom' : 'suggestion';
    await pool.query(
      `INSERT INTO outfit_favorites (user_id, outfit_id, outfit_type)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [user_id, outfit_id, normalizedType],
    );
    return { message: 'Favorited' };
  }

  async unfavoriteOutfit(dto: FavoriteOutfitDto) {
    const { user_id, outfit_id } = dto;
    await pool.query(
      `DELETE FROM outfit_favorites WHERE user_id = $1 AND outfit_id = $2`,
      [user_id, outfit_id],
    );
    return { message: 'Unfavorited' };
  }

  async getFavorites(userId: string) {
    const res = await pool.query(
      `SELECT o.*
       FROM outfit_suggestions o
       JOIN outfit_favorites f ON o.id = f.outfit_id
       WHERE f.user_id = $1
       ORDER BY o.suggested_at DESC`,
      [userId],
    );
    return res.rows;
  }

  async getCustomOutfits(userId: string) {
    // Ensure required columns exist
    await pool.query(`
      ALTER TABLE custom_outfits ADD COLUMN IF NOT EXISTS occasion TEXT;
      ALTER TABLE custom_outfits ADD COLUMN IF NOT EXISTS canvas_data JSONB;
      ALTER TABLE custom_outfits ADD COLUMN IF NOT EXISTS thumbnail_url TEXT;
    `);

    const res = await pool.query(
      `
    SELECT
      co.id,
      co.name,
      co.created_at,
      co.notes,
      co.rating,
      co.occasion,
      co.canvas_data,
      co.thumbnail_url,
      co.accessory_ids,

      t.id AS top_id,
      t.name AS top_name,
      COALESCE(NULLIF(t.touched_up_image_url, ''), NULLIF(t.processed_image_url, ''), t.image_url) AS top_image_url,

      b.id AS bottom_id,
      b.name AS bottom_name,
      COALESCE(NULLIF(b.touched_up_image_url, ''), NULLIF(b.processed_image_url, ''), b.image_url) AS bottom_image_url,

      s.id AS shoes_id,
      s.name AS shoes_name,
      COALESCE(NULLIF(s.touched_up_image_url, ''), NULLIF(s.processed_image_url, ''), s.image_url) AS shoes_image_url

    FROM custom_outfits co
    LEFT JOIN wardrobe_items t ON co.top_id = t.id
    LEFT JOIN wardrobe_items b ON co.bottom_id = b.id
    LEFT JOIN wardrobe_items s ON co.shoes_id = s.id
    WHERE co.user_id = $1
    ORDER BY co.created_at DESC
    `,
      [userId],
    );

    // For canvas-based outfits, we need to resolve wardrobe item images
    const results: any[] = [];
    for (const row of res.rows) {
      const outfit: any = {
        id: row.id,
        name: row.name ?? '',
        createdAt: new Date(row.created_at).toISOString(),
        notes: row.notes ?? '',
        rating: row.rating ?? null,
        thumbnailUrl: row.thumbnail_url ?? '',
        occasion: row.occasion ?? null,
        top: null,
        bottom: null,
        shoes: null,
      };

      // Check if this is a canvas-based outfit
      if (row.canvas_data?.placedItems?.length > 0) {
        // Get wardrobe item IDs from canvas_data
        const wardrobeIds = row.canvas_data.placedItems.map(
          (item: any) => item.wardrobeItemId,
        );

        // Fetch wardrobe items with ALL image URL fields (let frontend pick best one like canvas does)
        const itemsRes = await pool.query(
          `SELECT id, name, image_url, touched_up_image_url, processed_image_url
           FROM wardrobe_items
           WHERE id = ANY($1)`,
          [wardrobeIds],
        );

        const itemsMap = new Map<string, any>(
          itemsRes.rows.map((i: any) => [i.id, i]),
        );

        // // 🔍 DEBUG: Log what the database returns for each wardrobe item
        // console.log(
        //   '🖼️ getCustomOutfits - wardrobe items from DB:',
        //   itemsRes.rows.map((i: any) => ({
        //     id: i.id,
        //     name: i.name,
        //     image_url: i.image_url?.substring(0, 50) + '...',
        //     touched_up_image_url: i.touched_up_image_url
        //       ? i.touched_up_image_url.substring(0, 50) + '...'
        //       : i.touched_up_image_url,
        //     processed_image_url: i.processed_image_url
        //       ? i.processed_image_url.substring(0, 50) + '...'
        //       : i.processed_image_url,
        //   })),
        // );

        // Create items array for ALL canvas items - return all image URLs for frontend resolution
        const allCanvasItems = row.canvas_data.placedItems
          .map((placed: any) => {
            const item = itemsMap.get(placed.wardrobeItemId);
            if (!item) return null;

            // Normalize empty strings to null for proper || fallback
            const touchedUp =
              item.touched_up_image_url &&
              item.touched_up_image_url.trim() !== ''
                ? item.touched_up_image_url
                : null;
            const processed =
              item.processed_image_url && item.processed_image_url.trim() !== ''
                ? item.processed_image_url
                : null;
            const original =
              item.image_url && item.image_url.trim() !== ''
                ? item.image_url
                : '';

            // Return all image URLs - frontend will pick best one using same logic as canvas
            const image = touchedUp || processed || original;

            // console.log(
            //   `🖼️ Item ${item.id} (${item.name}): touchedUp=${!!touchedUp}, processed=${!!processed}, original=${!!original}, selected=${image?.substring(0, 40)}`,
            // );

            return {
              id: item.id,
              name: item.name,
              image,
              // Also include individual fields for frontend flexibility
              touchedUpImageUrl: touchedUp || '',
              processedImageUrl: processed || '',
              imageUrl: original,
            };
          })
          .filter(Boolean);

        // Assign first 3 to top/bottom/shoes slots for compatibility
        if (allCanvasItems[0]) outfit.top = allCanvasItems[0];
        if (allCanvasItems[1]) outfit.bottom = allCanvasItems[1];
        if (allCanvasItems[2]) outfit.shoes = allCanvasItems[2];

        // Include ALL items for full grid display
        outfit.allItems = allCanvasItems;

        // // 🔍 DEBUG: Log what we're returning
        // console.log(
        //   '🖼️ getCustomOutfits - allCanvasItems returned:',
        //   allCanvasItems.map((i: any) => ({
        //     id: i.id,
        //     name: i.name,
        //     image: i.image?.substring(0, 60) + '...',
        //     touchedUpImageUrl: i.touchedUpImageUrl?.substring(0, 50) + '...',
        //     processedImageUrl: i.processedImageUrl?.substring(0, 50) + '...',
        //   })),
        // );

        // Also include canvas_data for full reconstruction
        outfit.canvas_data = row.canvas_data;
      } else {
        // Legacy format with top_id, bottom_id, shoes_id
        outfit.top = row.top_id
          ? { id: row.top_id, name: row.top_name, image: row.top_image_url }
          : null;
        outfit.bottom = row.bottom_id
          ? {
              id: row.bottom_id,
              name: row.bottom_name,
              image: row.bottom_image_url,
            }
          : null;
        outfit.shoes = row.shoes_id
          ? {
              id: row.shoes_id,
              name: row.shoes_name,
              image: row.shoes_image_url,
            }
          : null;

        // Build allItems array for legacy outfits (same format as canvas-based)
        const legacyItems: any[] = [];
        if (outfit.top) legacyItems.push(outfit.top);
        if (outfit.bottom) legacyItems.push(outfit.bottom);
        if (outfit.shoes) legacyItems.push(outfit.shoes);

        // Fetch accessory items if any
        const accessoryIds = row.accessory_ids || [];
        if (accessoryIds.length > 0) {
          const accessoryRes = await pool.query(
            `SELECT id, name,
              COALESCE(NULLIF(touched_up_image_url, ''), NULLIF(processed_image_url, ''), image_url) AS image
             FROM wardrobe_items
             WHERE id = ANY($1)`,
            [accessoryIds],
          );
          for (const acc of accessoryRes.rows) {
            legacyItems.push({ id: acc.id, name: acc.name, image: acc.image });
          }
        }

        outfit.allItems = legacyItems;
      }

      results.push(outfit);
    }

    return results;
  }

  async deleteOutfit(id: string, userId: string) {
    // Delete from AI-generated outfits (ownership enforced)
    const suggestionsResult = await pool.query(
      `DELETE FROM outfit_suggestions WHERE id = $1 AND user_id = $2 RETURNING id`,
      [id, userId],
    );

    // Delete from custom outfits (ownership enforced)
    const customResult = await pool.query(
      `DELETE FROM custom_outfits WHERE id = $1 AND user_id = $2 RETURNING id`,
      [id, userId],
    );

    // If neither table had a matching row owned by this user, throw 404
    if (suggestionsResult.rowCount === 0 && customResult.rowCount === 0) {
      throw new NotFoundException('Outfit not found');
    }

    // Clean up related data (these are scoped by outfit_id, not user-owned directly)
    await pool.query(`DELETE FROM outfit_feedback WHERE outfit_id = $1`, [id]);
    await pool.query(`DELETE FROM outfit_favorites WHERE outfit_id = $1`, [id]);

    return { message: 'Deleted from database' };
  }

  async updateOutfitName(
    table: 'custom' | 'suggestions',
    id: string,
    name: string,
  ) {
    const tableName =
      table === 'custom' ? 'custom_outfits' : 'outfit_suggestions';

    await pool.query(`UPDATE ${tableName} SET name = $1 WHERE id = $2`, [
      name,
      id,
    ]);

    return { message: 'Outfit name updated' };
  }

  async updateOutfit(
    table: 'custom' | 'suggestions',
    id: string,
    userId: string,
    name?: string,
    occasion?: string,
  ) {
    const tableName =
      table === 'custom' ? 'custom_outfits' : 'outfit_suggestions';

    // Ensure occasion column exists (migration)
    await pool.query(`
      ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS occasion TEXT
    `);

    // Build dynamic update query
    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (name !== undefined) {
      updates.push(`name = $${paramIndex}`);
      values.push(name);
      paramIndex++;
    }

    if (occasion !== undefined) {
      updates.push(`occasion = $${paramIndex}`);
      values.push(occasion || null);
      paramIndex++;
    }

    if (updates.length === 0) {
      return { message: 'Nothing to update' };
    }

    values.push(id);
    const idParamIndex = paramIndex;
    paramIndex++;
    values.push(userId);
    const userIdParamIndex = paramIndex;

    const result = await pool.query(
      `UPDATE ${tableName} SET ${updates.join(', ')} WHERE id = $${idParamIndex} AND user_id = $${userIdParamIndex} RETURNING id`,
      values,
    );

    if (result.rowCount === 0) {
      throw new NotFoundException('Outfit not found');
    }

    return { message: 'Outfit updated' };
  }

  async markAsWorn(
    outfitId: string,
    outfitType: 'custom' | 'ai',
    userId: string,
  ) {
    const columnName =
      outfitType === 'custom' ? 'custom_outfit_id' : 'ai_outfit_id';

    // Insert a worn record with scheduled_for set to epoch (1970-01-01) so it doesn't appear on calendar
    // Only worn_at matters for the count
    // Also set notified_at to NOW() so the notification cron job skips this manual entry
    const { rows } = await pool.query(
      `
      INSERT INTO scheduled_outfits (user_id, ${columnName}, scheduled_for, worn_at, notified_at)
      VALUES ($1, $2, '1970-01-01'::timestamptz, NOW(), NOW())
      RETURNING *
      `,
      [userId, outfitId],
    );

    // Emit OUTFIT_WORN learning event
    if (LEARNING_FLAGS.EVENTS_ENABLED) {
      const today = new Date().toISOString().split('T')[0];
      extractOutfitFeatures(outfitId)
        .then((features) =>
          this.learningEvents.logEvent({
            userId,
            eventType: 'OUTFIT_WORN',
            entityType: 'outfit',
            entityId: outfitId,
            signalPolarity: 1,
            signalWeight: 0.6,
            extractedFeatures: features,
            sourceFeature: 'calendar',
            clientEventId: `outfit_worn:${userId}:${outfitId}:${today}`,
          }),
        )
        .catch(() => {});
    }

    return rows[0];
  }

  async unmarkWorn(
    outfitId: string,
    outfitType: 'custom' | 'ai',
    userId: string,
  ) {
    const columnName =
      outfitType === 'custom' ? 'custom_outfit_id' : 'ai_outfit_id';

    // Delete the most recent worn record for this outfit
    const { rows } = await pool.query(
      `
      DELETE FROM scheduled_outfits
      WHERE id = (
        SELECT id FROM scheduled_outfits
        WHERE user_id = $1 AND ${columnName} = $2 AND worn_at IS NOT NULL
        ORDER BY worn_at DESC
        LIMIT 1
      )
      RETURNING *
      `,
      [userId, outfitId],
    );

    return rows[0] ?? { message: 'No worn record to remove' };
  }
}
