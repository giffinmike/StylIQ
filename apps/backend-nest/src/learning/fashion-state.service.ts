/**
 * Fashion State Service
 *
 * Computes and manages the derived user fashion state from learning events.
 *
 * Key features:
 * - Asymmetric decay: negative signals decay faster than positive
 * - Post-aggregation clamping: scores are clamped only after all accumulation
 * - Cold start detection: users with < 10 explicit events are marked
 * - Graceful fallback: returns null on any error
 */

import { Injectable, Logger } from '@nestjs/common';
import { pool } from '../db/pool';
import {
  LEARNING_FLAGS,
  AGGREGATION_CONFIG,
  ELITE_FLAGS,
} from '../config/feature-flags';
import {
  UserFashionState,
  ScoreMap,
  PriceBracket,
  FashionStateSummary,
  createStateSummary,
} from './dto/fashion-state.dto';

interface RawEvent {
  event_type: string;
  event_ts: Date;
  signal_polarity: number;
  signal_weight: number;
  extracted_features: {
    brands?: string[];
    colors?: string[];
    categories?: string[];
    styles?: string[];
    materials?: string[];
    tags?: string[];
  };
  context?: {
    occasion?: string;
  };
}

@Injectable()
export class FashionStateService {
  private readonly logger = new Logger(FashionStateService.name);

  /**
   * Get fashion state for a user with fallback behavior.
   *
   * Returns null if:
   * - Learning state is disabled
   * - User has no state computed
   * - User is in cold start (caller should use style_profiles)
   * - Any error occurs
   *
   * @param userId User ID to fetch state for
   * @param options Optional timeout override
   */
  async getStateWithFallback(
    userId: string,
    options?: { timeoutMs?: number },
  ): Promise<UserFashionState | null> {
    const uid8 = userId.slice(0, 8);
    if (!LEARNING_FLAGS.STATE_ENABLED) {
      if (ELITE_FLAGS.DEBUG)
        this.logger.debug(
          `[FashionState] READ user=${uid8} result=NULL reason=STATE_DISABLED`,
        );
      return null;
    }

    const timeoutMs = options?.timeoutMs ?? 100;

    try {
      const timeoutPromise = new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), timeoutMs),
      );

      const fetchPromise = this.getState(userId);

      const state = await Promise.race([fetchPromise, timeoutPromise]);

      if (!state) {
        if (ELITE_FLAGS.DEBUG)
          this.logger.debug(
            `[FashionState] READ user=${uid8} result=NULL reason=NO_ROW_OR_TIMEOUT`,
          );
        return null;
      }

      // Return null for cold start users - caller should use style_profiles
      if (state.isColdStart) {
        if (ELITE_FLAGS.DEBUG)
          this.logger.debug(
            `[FashionState] READ user=${uid8} result=NULL reason=COLD_START events=${state.eventsProcessedCount}`,
          );
        return null;
      }

      if (ELITE_FLAGS.DEBUG)
        this.logger.debug(
          `[FashionState] READ user=${uid8} result=OK events=${state.eventsProcessedCount} brands=${Object.keys(state.brandScores).length} colors=${Object.keys(state.colorScores).length} styles=${Object.keys(state.styleScores).length}`,
        );
      return state;
    } catch (error) {
      this.logger.warn(
        `[FashionState] READ user=${uid8} result=NULL reason=ERROR err=${error.message}`,
      );
      return null;
    }
  }

  /**
   * Get fashion state summary for AI context injection.
   * Returns null if state is unavailable or user is in cold start.
   */
  async getStateSummary(userId: string): Promise<FashionStateSummary | null> {
    const state = await this.getStateWithFallback(userId);
    if (!state) {
      return null;
    }
    return createStateSummary(state);
  }

  /**
   * Get raw fashion state from database.
   */
  async getState(userId: string): Promise<UserFashionState | null> {
    try {
      const result = await pool.query(
        `SELECT
          user_id,
          brand_scores,
          color_scores,
          category_scores,
          style_scores,
          material_scores,
          tag_scores,
          fit_issues,
          avg_purchase_price,
          price_bracket,
          occasion_frequency,
          events_processed_count,
          is_cold_start,
          last_computed_at,
          state_version
        FROM user_fashion_state
        WHERE user_id = $1`,
        [userId],
      );

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];

      return {
        userId: row.user_id,
        brandScores: row.brand_scores || {},
        colorScores: row.color_scores || {},
        categoryScores: row.category_scores || {},
        styleScores: row.style_scores || {},
        materialScores: row.material_scores || {},
        tagScores: row.tag_scores || {},
        fitIssues: row.fit_issues || {},
        avgPurchasePrice: row.avg_purchase_price
          ? parseFloat(row.avg_purchase_price)
          : null,
        priceBracket: row.price_bracket as PriceBracket,
        occasionFrequency: row.occasion_frequency || {},
        eventsProcessedCount: row.events_processed_count || 0,
        isColdStart: row.is_cold_start ?? true,
        lastComputedAt: new Date(row.last_computed_at),
        stateVersion: row.state_version || 1,
      };
    } catch (error) {
      this.logger.error(`[FashionState] getState failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Check if state is stale and needs recomputation.
   */
  async isStateStale(userId: string): Promise<boolean> {
    try {
      const result = await pool.query(
        `SELECT last_computed_at FROM user_fashion_state WHERE user_id = $1`,
        [userId],
      );

      if (result.rows.length === 0) {
        return true; // No state = stale
      }

      const lastComputed = new Date(result.rows[0].last_computed_at).getTime();
      const now = Date.now();

      return now - lastComputed > AGGREGATION_CONFIG.STALENESS_THRESHOLD_MS;
    } catch (error) {
      this.logger.warn(
        `[FashionState] isStateStale check failed: ${error.message}`,
      );
      return true; // Assume stale on error
    }
  }

  /**
   * Compute and save fashion state for a user.
   * This is called by the cron job and can also be triggered on-demand.
   */
  async computeAndSaveState(userId: string): Promise<UserFashionState> {
    this.logger.log(`[LEARNING INLINE] recompute for ${userId}`);
    const cutoffDate = new Date(
      Date.now() - AGGREGATION_CONFIG.MAX_EVENT_AGE_DAYS * 24 * 60 * 60 * 1000,
    );

    // Fetch events
    const eventsResult = await pool.query(
      `SELECT
        event_type,
        event_ts,
        signal_polarity,
        signal_weight,
        extracted_features,
        context
      FROM user_learning_events
      WHERE user_id = $1 AND event_ts > $2
      ORDER BY event_ts ASC`,
      [userId, cutoffDate],
    );

    const events: RawEvent[] = eventsResult.rows;

    // Accumulate raw scores (no clamping during accumulation)
    const rawScores = {
      brands: new Map<string, number>(),
      colors: new Map<string, number>(),
      categories: new Map<string, number>(),
      styles: new Map<string, number>(),
      materials: new Map<string, number>(),
      tags: new Map<string, number>(),
    };

    const occasionCounts = new Map<string, number>();
    const prices: number[] = [];

    for (const event of events) {
      const ageDays =
        (Date.now() - new Date(event.event_ts).getTime()) /
        (1000 * 60 * 60 * 24);

      // Asymmetric decay: negative signals decay faster
      const halfLife =
        event.signal_polarity < 0
          ? AGGREGATION_CONFIG.NEGATIVE_HALF_LIFE_DAYS
          : AGGREGATION_CONFIG.POSITIVE_HALF_LIFE_DAYS;

      const decay = Math.pow(0.5, ageDays / halfLife);
      const effectiveSignal =
        event.signal_polarity * event.signal_weight * decay;

      const features = event.extracted_features || {};

      // Accumulate scores for each feature type
      this.accumulateScores(rawScores.brands, features.brands, effectiveSignal);
      this.accumulateScores(rawScores.colors, features.colors, effectiveSignal);
      this.accumulateScores(
        rawScores.categories,
        features.categories,
        effectiveSignal,
      );
      this.accumulateScores(rawScores.styles, features.styles, effectiveSignal);
      this.accumulateScores(
        rawScores.materials,
        features.materials,
        effectiveSignal,
      );
      this.accumulateScores(rawScores.tags, features.tags, effectiveSignal);

      // Track occasion frequency
      if (event.context?.occasion) {
        const occasion = event.context.occasion.toLowerCase();
        occasionCounts.set(occasion, (occasionCounts.get(occasion) || 0) + 1);
      }

      // Track purchase prices
      if (
        event.event_type === 'PRODUCT_PURCHASED' &&
        (event as any).context?.price
      ) {
        prices.push((event as any).context.price);
      }
    }

    // Clamp scores ONCE after all accumulation (fixes order-dependent clamping)
    const clamp = (score: number) =>
      Math.max(
        AGGREGATION_CONFIG.SCORE_FLOOR,
        Math.min(AGGREGATION_CONFIG.SCORE_CEILING, score),
      );

    const clampedScores = {
      brandScores: this.mapToObject(rawScores.brands, clamp),
      colorScores: this.mapToObject(rawScores.colors, clamp),
      categoryScores: this.mapToObject(rawScores.categories, clamp),
      styleScores: this.mapToObject(rawScores.styles, clamp),
      materialScores: this.mapToObject(rawScores.materials, clamp),
      tagScores: this.mapToObject(rawScores.tags, clamp),
    };

    // Calculate derived values
    const explicitEventCount = events.filter(
      (e) => e.signal_polarity !== 0,
    ).length;
    const isColdStart =
      explicitEventCount < AGGREGATION_CONFIG.MIN_EVENTS_FOR_ACTIVE;

    const avgPurchasePrice =
      prices.length > 0
        ? prices.reduce((a, b) => a + b, 0) / prices.length
        : null;

    const priceBracket = this.derivePriceBracket(avgPurchasePrice);

    // Build state object
    const state: UserFashionState = {
      userId,
      ...clampedScores,
      fitIssues: {}, // TODO: derive from PRODUCT_RETURNED events
      avgPurchasePrice,
      priceBracket,
      occasionFrequency: Object.fromEntries(occasionCounts),
      eventsProcessedCount: events.length,
      isColdStart,
      lastComputedAt: new Date(),
      stateVersion: 1,
    };

    // Save to database
    await this.saveState(state);

    this.logger.log(
      `[FashionState] Computed state for ${userId}: ${events.length} events, cold_start=${isColdStart}`,
    );

    return state;
  }

  /**
   * Delete state for a user (GDPR/consent revocation).
   */
  async deleteUserState(userId: string): Promise<void> {
    try {
      await pool.query('DELETE FROM user_fashion_state WHERE user_id = $1', [
        userId,
      ]);
      this.logger.log(`[FashionState] Deleted state for user ${userId}`);
    } catch (error) {
      this.logger.error(
        `[FashionState] deleteUserState failed: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Get users with stale state that need recomputation.
   */
  async getStaleUserIds(limit: number = 100): Promise<string[]> {
    const staleThreshold = new Date(
      Date.now() - AGGREGATION_CONFIG.STALENESS_THRESHOLD_MS,
    );

    try {
      // Get users with events but no state, or stale state
      const result = await pool.query(
        `SELECT DISTINCT e.user_id
        FROM user_learning_events e
        LEFT JOIN user_fashion_state s ON e.user_id = s.user_id
        WHERE s.user_id IS NULL
          OR s.last_computed_at < $1
        LIMIT $2`,
        [staleThreshold, limit],
      );

      return result.rows.map((row) => row.user_id);
    } catch (error) {
      this.logger.error(
        `[FashionState] getStaleUserIds failed: ${error.message}`,
      );
      return [];
    }
  }

  /**
   * Accumulate scores into a map.
   */
  private accumulateScores(
    map: Map<string, number>,
    keys: string[] | undefined,
    signal: number,
  ): void {
    if (!keys) return;
    for (const key of keys) {
      if (key) {
        const normalized = key.toLowerCase().trim();
        map.set(normalized, (map.get(normalized) || 0) + signal);
      }
    }
  }

  /**
   * Convert Map to object with optional transform.
   */
  private mapToObject(
    map: Map<string, number>,
    transform?: (v: number) => number,
  ): ScoreMap {
    const obj: ScoreMap = {};
    for (const [key, value] of map) {
      obj[key] = transform ? transform(value) : value;
    }
    return obj;
  }

  /**
   * Derive price bracket from average purchase price.
   */
  private derivePriceBracket(avgPrice: number | null): PriceBracket {
    if (avgPrice === null) return null;
    if (avgPrice < 50) return 'budget';
    if (avgPrice < 150) return 'mid';
    if (avgPrice < 400) return 'premium';
    return 'luxury';
  }

  /**
   * Save state to database (upsert).
   */
  private async saveState(state: UserFashionState): Promise<void> {
    await pool.query(
      `INSERT INTO user_fashion_state (
        user_id,
        brand_scores,
        color_scores,
        category_scores,
        style_scores,
        material_scores,
        tag_scores,
        fit_issues,
        avg_purchase_price,
        price_bracket,
        occasion_frequency,
        events_processed_count,
        is_cold_start,
        last_computed_at,
        state_version,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        brand_scores = EXCLUDED.brand_scores,
        color_scores = EXCLUDED.color_scores,
        category_scores = EXCLUDED.category_scores,
        style_scores = EXCLUDED.style_scores,
        material_scores = EXCLUDED.material_scores,
        tag_scores = EXCLUDED.tag_scores,
        fit_issues = EXCLUDED.fit_issues,
        avg_purchase_price = EXCLUDED.avg_purchase_price,
        price_bracket = EXCLUDED.price_bracket,
        occasion_frequency = EXCLUDED.occasion_frequency,
        events_processed_count = EXCLUDED.events_processed_count,
        is_cold_start = EXCLUDED.is_cold_start,
        last_computed_at = EXCLUDED.last_computed_at,
        state_version = EXCLUDED.state_version,
        updated_at = NOW()`,
      [
        state.userId,
        JSON.stringify(state.brandScores),
        JSON.stringify(state.colorScores),
        JSON.stringify(state.categoryScores),
        JSON.stringify(state.styleScores),
        JSON.stringify(state.materialScores),
        JSON.stringify(state.tagScores),
        JSON.stringify(state.fitIssues),
        state.avgPurchasePrice,
        state.priceBracket,
        JSON.stringify(state.occasionFrequency),
        state.eventsProcessedCount,
        state.isColdStart,
        state.lastComputedAt,
        state.stateVersion,
      ],
    );
  }
}
