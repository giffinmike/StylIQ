// apps/backend-nest/src/feedback/feedback.service.ts

import { Injectable, Logger } from '@nestjs/common';
import { RateFeedbackDto } from './dto/rate-feedback.dto';
import { pool } from '../db/pool';
import { LearningEventsService } from '../learning/learning-events.service';
import { FashionStateService } from '../learning/fashion-state.service';
import { LEARNING_FLAGS } from '../config/feature-flags';
import { extractOutfitFeatures } from '../learning/extract-outfit-features';

@Injectable()
export class FeedbackService {
  private readonly logger = new Logger(FeedbackService.name);

  constructor(
    private readonly learningEvents: LearningEventsService,
    private readonly fashionStateService: FashionStateService,
  ) {}

  async rate(dto: RateFeedbackDto) {
    const { user_id, outfit_id, rating, notes, item_ids = [], outfit } = dto;
    const numeric = rating === 'like' ? 1 : -1;

    // main feedback table (now includes outfit_json)
    await pool.query(
      `CREATE TABLE IF NOT EXISTS outfit_feedback(
         id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
         user_id UUID NOT NULL,
         outfit_id UUID NOT NULL,
         rating INT CHECK (rating IN (1, -1)),
         notes TEXT,
         outfit_json JSONB,
         created_at TIMESTAMPTZ DEFAULT now()
       );`,
    );

    await pool.query(
      `INSERT INTO outfit_feedback (user_id, outfit_id, rating, notes, outfit_json)
       VALUES ($1::uuid,$2::uuid,$3,$4,$5::jsonb);`,
      [
        user_id,
        outfit_id,
        numeric,
        notes ?? null,
        outfit ? JSON.stringify(outfit) : null,
      ],
    );

    // per-item preferences
    await pool.query(
      `CREATE TABLE IF NOT EXISTS user_pref_item(
         user_id TEXT NOT NULL,
         item_id TEXT NOT NULL,
         score REAL NOT NULL DEFAULT 0,
         updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         PRIMARY KEY (user_id, item_id)
       );`,
    );

    for (const id of item_ids) {
      await pool.query(
        `INSERT INTO user_pref_item (user_id, item_id, score)
         VALUES ($1,$2,$3)
         ON CONFLICT (user_id, item_id) DO UPDATE
           SET score = LEAST(5, GREATEST(-5, user_pref_item.score + $3)),
               updated_at = now();`,
        [user_id, id, numeric * 2],
      );
    }

    // Emit OUTFIT_RATED learning event + inline recompute
    if (LEARNING_FLAGS.EVENTS_ENABLED) {
      const isPositive = rating === 'like';
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

    return { ok: true };
  }
}

////////////////

// import { Injectable } from '@nestjs/common';
// import { Pool } from 'pg';
// import { RateFeedbackDto } from './dto/rate-feedback.dto';

// const pool = new Pool({
//   connectionString: process.env.DATABASE_URL,
//   ssl: { rejectUnauthorized: false },
// });

// @Injectable()
// export class FeedbackService {
//   async rate(dto: RateFeedbackDto) {
//     const { user_id, outfit_id, rating, notes, item_ids = [] } = dto;
//     const numeric = rating === 'like' ? 1 : -1;

//     // main feedback table
//     await pool.query(
//       `CREATE TABLE IF NOT EXISTS outfit_feedback(
//      id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
//      user_id UUID NOT NULL,
//      outfit_id UUID NOT NULL,
//      rating INT CHECK (rating IN (1, -1)),
//      notes TEXT,
//      created_at TIMESTAMPTZ DEFAULT now()
//    );`,
//     );

//     await pool.query(
//       `INSERT INTO outfit_feedback (user_id, outfit_id, rating, notes)
//    VALUES ($1::uuid,$2::uuid,$3,$4);`,
//       [user_id, outfit_id, numeric, notes ?? null],
//     );

//     // per-item preferences
//     await pool.query(
//       `CREATE TABLE IF NOT EXISTS user_pref_item(
//          user_id TEXT NOT NULL,
//          item_id TEXT NOT NULL,
//          score REAL NOT NULL DEFAULT 0,
//          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
//          PRIMARY KEY (user_id, item_id)
//        );`,
//     );

//     for (const id of item_ids) {
//       await pool.query(
//         `INSERT INTO user_pref_item (user_id, item_id, score)
//          VALUES ($1,$2,$3)
//          ON CONFLICT (user_id, item_id) DO UPDATE
//            SET score = LEAST(5, GREATEST(-5, user_pref_item.score + $3)),
//                updated_at = now();`,
//         [user_id, id, numeric * 2],
//       );
//     }

//     return { ok: true };
//   }
// }

///////////////

// import { Injectable } from '@nestjs/common';
// import { Pool } from 'pg';
// import { RateFeedbackDto } from './dto/rate-feedback.dto';

// const pool = new Pool({
//   connectionString: process.env.DATABASE_URL,
//   ssl: { rejectUnauthorized: false },
// });

// @Injectable()
// export class FeedbackService {
//   async rate(dto: RateFeedbackDto) {
//     if (!dto?.request_id || !dto?.user_id || !dto?.outfit?.item_ids?.length) {
//       return { ok: false, error: 'invalid_body' };
//     }
//     // Map UI like/dislike to numeric if needed
//     const rating = dto.rating;

//     // Single entry point handles DB writes + pref updates
//     const { recordFeedbackAndUpdatePrefs } = await import(
//       '../personalization/log'
//     );
//     await recordFeedbackAndUpdatePrefs(pool, {
//       request_id: dto.request_id,
//       user_id: dto.user_id,
//       outfit: dto.outfit,
//       rating,
//       tags: dto.tags ?? [],
//       notes: dto.notes ?? undefined,
//     });

//     return { ok: true };
//   }
// }

////////////////

// import { Injectable } from '@nestjs/common';
// import { Pool } from 'pg';
// import { CreateFeedbackDto } from './dto/create-feedback.dto';

// const pool = new Pool({
//   connectionString: process.env.DATABASE_URL,
//   ssl: { rejectUnauthorized: false },
// });

// @Injectable()
// export class FeedbackService {
//   async rate(dto: CreateFeedbackDto) {
//     const { user_id, outfit_id, rating, notes } = dto;

//     const numericRating = rating === 'like' ? 5 : 1; // or whatever scale you want

//     const res = await pool.query(
//       `INSERT INTO outfit_feedback (user_id, outfit_id, rating, notes)
//      VALUES ($1, $2, $3, $4) RETURNING *`,
//       [user_id, outfit_id, numericRating, notes],
//     );

//     return res.rows[0];
//   }
// }
