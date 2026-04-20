/**
 * Learning Controller
 *
 * API endpoints for:
 * - User consent management
 * - Data deletion (GDPR)
 * - Learning data transparency (optional)
 * - Admin/debug endpoints
 */

import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { pool } from '../db/pool';
import { ConsentCache } from './consent-cache';
import { LearningEventsService } from './learning-events.service';
import { FashionStateService } from './fashion-state.service';
import { LEARNING_FLAGS } from '../config/feature-flags';
import {
  LearningEventType,
  EntityType,
  ExtractedFeatures,
  EVENT_SIGNAL_DEFAULTS,
} from './dto/learning-event.dto';

@Controller('learning')
@UseGuards(JwtAuthGuard)
export class LearningController {
  private readonly logger = new Logger(LearningController.name);

  constructor(
    private readonly consentCache: ConsentCache,
    private readonly eventsService: LearningEventsService,
    private readonly fashionStateService: FashionStateService,
  ) {}

  /**
   * Log a learning event from the frontend.
   * Fire-and-forget: returns 202 immediately, event is persisted best-effort.
   */
  @Post('events')
  @HttpCode(HttpStatus.ACCEPTED)
  async logEvent(
    @Req() req,
    @Body()
    body: {
      eventType: LearningEventType;
      entityType: EntityType;
      entityId?: string;
      extractedFeatures?: ExtractedFeatures;
      sourceFeature: string;
    },
  ): Promise<{ accepted: boolean }> {
    const userId = req.user.userId;

    this.logger.log('[Learning] EVENT RECEIVED', {
      userId,
      eventType: body.eventType,
      entityType: body.entityType,
      sourceFeature: body.sourceFeature,
    });

    const defaults = EVENT_SIGNAL_DEFAULTS[body.eventType];
    if (!defaults) {
      return { accepted: false };
    }

    await this.eventsService.logEvent({
      userId,
      eventType: body.eventType,
      entityType: body.entityType,
      entityId: body.entityId,
      signalPolarity: defaults.polarity,
      signalWeight: defaults.weight,
      extractedFeatures: body.extractedFeatures ?? {},
      sourceFeature: body.sourceFeature,
    });

    return { accepted: true };
  }

  /**
   * Get current learning consent status.
   */
  @Get('consent')
  async getConsent(
    @Req() req,
  ): Promise<{ enabled: boolean; enabledAt?: string }> {
    const userId = req.user.userId;

    const result = await pool.query(
      'SELECT learning_consent, learning_consent_ts FROM users WHERE id = $1',
      [userId],
    );

    const row = result.rows[0];
    return {
      enabled: row?.learning_consent === true,
      enabledAt: row?.learning_consent_ts?.toISOString(),
    };
  }

  /**
   * Enable learning consent.
   */
  @Post('consent/enable')
  @HttpCode(HttpStatus.OK)
  async enableConsent(@Req() req): Promise<{ enabled: boolean }> {
    const userId = req.user.userId;

    await pool.query(
      `UPDATE users
       SET learning_consent = true, learning_consent_ts = NOW()
       WHERE id = $1`,
      [userId],
    );

    // Invalidate cache to pick up new consent
    this.consentCache.invalidate(userId);

    return { enabled: true };
  }

  /**
   * Disable learning consent and delete all learning data.
   */
  @Post('consent/disable')
  @HttpCode(HttpStatus.OK)
  async disableConsent(
    @Req() req,
  ): Promise<{ enabled: boolean; deletedEvents: number }> {
    const userId = req.user.userId;

    // Update consent flag
    await pool.query(
      `UPDATE users
       SET learning_consent = false, learning_consent_ts = NOW()
       WHERE id = $1`,
      [userId],
    );

    // Invalidate cache immediately
    this.consentCache.invalidate(userId);

    // Delete all learning data
    const deletedEvents = await this.eventsService.deleteUserEvents(userId);
    await this.fashionStateService.deleteUserState(userId);

    return { enabled: false, deletedEvents };
  }

  /**
   * Delete all learning data (GDPR right to be forgotten).
   * Does NOT change consent status.
   */
  @Delete('data')
  @HttpCode(HttpStatus.OK)
  async deleteAllData(@Req() req): Promise<{ deletedEvents: number }> {
    const userId = req.user.userId;

    const deletedEvents = await this.eventsService.deleteUserEvents(userId);
    await this.fashionStateService.deleteUserState(userId);

    return { deletedEvents };
  }

  /**
   * Get summary of learning data (transparency).
   */
  @Get('summary')
  async getSummary(@Req() req): Promise<{
    eventsCount: number;
    hasState: boolean;
    isColdStart: boolean;
    topPreferences?: {
      brands: string[];
      colors: string[];
      styles: string[];
    };
    negativePreferences?: {
      brands: string[];
      colors: string[];
      styles: string[];
    };
  }> {
    const userId = req.user.userId;

    const eventsCount = await this.eventsService.getEventCount(userId);
    const state = await this.fashionStateService.getState(userId);

    // Fetch profile-level avoid_colors (fail-open)
    let profileAvoidColors: string[] = [];
    try {
      const spResult = await pool.query(
        'SELECT avoid_colors FROM style_profiles WHERE user_id = $1 LIMIT 1',
        [userId],
      );
      const raw = spResult.rows[0]?.avoid_colors;
      profileAvoidColors = Array.isArray(raw) ? raw : [];
    } catch (e) {
      this.logger.warn(
        `[Learning] summary: failed to fetch style_profiles avoid_colors: ${e.message}`,
      );
    }

    if (!state) {
      // Even without fashion state, surface profile avoid_colors
      const merged = [
        ...new Set(profileAvoidColors.map((c) => c.toLowerCase())),
      ];
      return {
        eventsCount,
        hasState: merged.length > 0,
        isColdStart: true,
        negativePreferences:
          merged.length > 0
            ? { brands: [], colors: merged, styles: [] }
            : undefined,
      };
    }

    const summary = await this.fashionStateService.getStateSummary(userId);

    // Merge profile avoid_colors + learned avoid_colors, dedupe case-insensitive
    const learnedAvoidColors = summary?.avoidColors ?? [];
    const mergedAvoidColors = [
      ...new Set(
        [...profileAvoidColors, ...learnedAvoidColors].map((c) =>
          c.toLowerCase(),
        ),
      ),
    ];

    return {
      eventsCount,
      hasState: true,
      isColdStart: state.isColdStart,
      topPreferences: summary
        ? {
            brands: summary.topBrands,
            colors: summary.topColors,
            styles: summary.topStyles,
          }
        : undefined,
      // T4 PATCH: expose negative learning signals for capsule engine
      // T5 PATCH: merge style_profiles.avoid_colors into learned avoid_colors
      negativePreferences: summary
        ? {
            brands: summary.avoidBrands,
            colors: mergedAvoidColors,
            styles: summary.avoidStyles,
          }
        : mergedAvoidColors.length > 0
          ? { brands: [], colors: mergedAvoidColors, styles: [] }
          : undefined,
    };
  }

  /**
   * Get feature flag status (for debugging).
   */
  @Get('status')
  async getStatus(): Promise<{
    eventsEnabled: boolean;
    stateEnabled: boolean;
    shadowMode: boolean;
    circuitBreaker: {
      isOpen: boolean;
      consecutiveFailures: number;
    };
  }> {
    const circuitStatus = this.eventsService.getCircuitBreakerStatus();

    return {
      eventsEnabled: LEARNING_FLAGS.EVENTS_ENABLED,
      stateEnabled: LEARNING_FLAGS.STATE_ENABLED,
      shadowMode: LEARNING_FLAGS.SHADOW_MODE,
      circuitBreaker: {
        isOpen: circuitStatus.isOpen,
        consecutiveFailures: circuitStatus.consecutiveFailures,
      },
    };
  }
}
