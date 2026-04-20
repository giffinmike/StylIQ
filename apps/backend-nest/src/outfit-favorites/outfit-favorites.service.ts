import { Injectable, Logger } from '@nestjs/common';
import { AddFavoriteDto } from './dto/add-favorite.dto';
import { RemoveFavoriteDto } from './dto/remove-favorite.dto';
import { pool } from '../db/pool';
import { LearningEventsService } from '../learning/learning-events.service';
import { FashionStateService } from '../learning/fashion-state.service';
import { LEARNING_FLAGS } from '../config/feature-flags';
import { extractOutfitFeatures } from '../learning/extract-outfit-features';

@Injectable()
export class OutfitFavoritesService {
  private readonly logger = new Logger(OutfitFavoritesService.name);

  constructor(
    private readonly learningEvents: LearningEventsService,
    private readonly fashionStateService: FashionStateService,
  ) {}

  async addFavorite(dto: AddFavoriteDto) {
    const { user_id, outfit_id, outfit_type } = dto;

    try {
      const result = await pool.query(
        `
  INSERT INTO outfit_favorites (user_id, outfit_id, outfit_type)
  VALUES ($1, $2, $3)
  ON CONFLICT (user_id, outfit_id, outfit_type) DO NOTHING
  RETURNING *
  `,
        [user_id, outfit_id, outfit_type],
      );

      if (result.rows.length === 0) {
        console.log('⚠️ Favorite already exists:', { user_id, outfit_id });
        return { message: 'Already favorited' };
      }

      // Emit OUTFIT_FAVORITED learning event
      if (LEARNING_FLAGS.EVENTS_ENABLED) {
        extractOutfitFeatures(outfit_id)
          .then((features) =>
            this.learningEvents.logEvent({
              userId: user_id,
              eventType: 'OUTFIT_FAVORITED',
              entityType: 'outfit',
              entityId: outfit_id,
              signalPolarity: 1,
              signalWeight: 0.3,
              extractedFeatures: features,
              sourceFeature: 'outfits',
              clientEventId: `outfit_favorited:${user_id}:${outfit_id}`,
            }),
          )
          .catch(() => {});
      }

      return { message: 'Favorited' };
    } catch (err) {
      console.error('❌ addFavorite failed:', err);
      throw err;
    }
  }

  async getUserFavoritesCount(userId: string) {
    const result = await pool.query(
      `SELECT COUNT(*) FROM outfit_favorites WHERE user_id = $1`,
      [userId],
    );
    return { count: parseInt(result.rows[0].count, 10) };
  }

  async removeFavorite(dto: RemoveFavoriteDto) {
    const { user_id, outfit_id } = dto;

    await pool.query(
      `
      DELETE FROM outfit_favorites
      WHERE user_id = $1 AND outfit_id = $2
    `,
      [user_id, outfit_id],
    );

    // Emit OUTFIT_UNFAVORITED learning event + inline recompute
    if (LEARNING_FLAGS.EVENTS_ENABLED) {
      try {
        const features = await extractOutfitFeatures(outfit_id);
        await this.learningEvents.logEvent({
          userId: user_id,
          eventType: 'OUTFIT_UNFAVORITED',
          entityType: 'outfit',
          entityId: outfit_id,
          signalPolarity: -1,
          signalWeight: 0.2,
          extractedFeatures: features,
          sourceFeature: 'outfits',
          clientEventId: `outfit_unfavorited:${user_id}:${outfit_id}`,
        });
        this.fashionStateService
          .computeAndSaveState(user_id)
          .catch((err) =>
            this.logger.error('[LEARNING INLINE] recompute failed', err),
          );
      } catch (err) {
        this.logger.error('[LEARNING] outfit unfavorited event failed', err);
      }
    }

    return { message: 'Unfavorited' };
  }

  async getFavorites(user_id: string) {
    const result = await pool.query(
      `
    SELECT 
      o.id,
      o.name,
      f.saved_at::timestamptz AS favorited_on,
      NULL AS image_url,
      'suggestion' AS source
    FROM outfit_favorites f
    JOIN outfit_suggestions o ON o.id = f.outfit_id
    WHERE f.user_id = $1 AND f.outfit_type = 'suggestion'

    UNION ALL

    SELECT 
      c.id,
      c.name,
      f.saved_at::timestamptz AS favorited_on,
      NULL AS image_url,
      'custom' AS source
    FROM outfit_favorites f
    JOIN custom_outfits c ON c.id = f.outfit_id
    WHERE f.user_id = $1 AND f.outfit_type = 'custom'

    ORDER BY favorited_on DESC
    `,
      [user_id],
    );

    return result.rows;
  }
}
