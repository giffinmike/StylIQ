// src/style-profile/style-profile.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { UpdateStyleProfileDto } from './dto/update-style-profile.dto';
import { pool } from '../db/pool';
import { ALLOWED_COLUMNS, TEXT_ARRAY_COLUMNS } from './style-profile.constants';

@Injectable()
export class StyleProfileService {
  async getInternalUserId(auth0Sub: string): Promise<string> {
    const userRes = await pool.query(
      'SELECT id FROM users WHERE auth0_sub = $1',
      [auth0Sub],
    );
    if (userRes.rowCount === 0) {
      throw new NotFoundException(`User not found for sub: ${auth0Sub}`);
    }
    return userRes.rows[0].id;
  }

  async getProfile(userId: string) {
    let profileRes = await pool.query(
      'SELECT * FROM style_profiles WHERE user_id = $1',
      [userId],
    );

    if (profileRes.rowCount === 0) {
      await pool.query('INSERT INTO style_profiles (user_id) VALUES ($1)', [
        userId,
      ]);
      profileRes = await pool.query(
        'SELECT * FROM style_profiles WHERE user_id = $1',
        [userId],
      );
    }

    return profileRes.rows[0];
  }

  // Columns that affect discover recommendations — changes trigger cache invalidation
  private static readonly DISCOVER_RELEVANT_COLUMNS = new Set([
    'preferred_brands', 'color_preferences', 'disliked_styles', 'style_preferences',
    'fit_preferences', 'avoid_colors', 'avoid_materials', 'avoid_patterns',
    'budget_min', 'budget_max', 'body_type', 'silhouette_preference', 'formality_floor',
    'coverage_no_go', 'walkability_requirement',
  ]);

  async updateProfile(userId: string, dto: UpdateStyleProfileDto) {
    const filteredEntries = Object.entries(dto).filter(
      ([key, val]) =>
        val !== undefined && ALLOWED_COLUMNS.has(key),
    );

    // One-way color sync: keep favorite_colors in sync with color_preferences
    const colorPrefEntry = filteredEntries.find(
      ([k]) => k === 'color_preferences',
    );
    if (
      colorPrefEntry &&
      !filteredEntries.find(([k]) => k === 'favorite_colors')
    ) {
      filteredEntries.push(['favorite_colors', colorPrefEntry[1]]);
    }

    if (filteredEntries.length === 0) {
      console.warn('⚠️ No valid fields to update.');
      return;
    }

    const keys = filteredEntries.map(([key]) => key);
    const values = filteredEntries.map(([, val]) => val);
    const setClause = keys
      .map((key, i) =>
        key === 'prefs_jsonb'
          ? `prefs_jsonb = COALESCE(style_profiles.prefs_jsonb, '{}'::jsonb) || $${i + 2}::jsonb`
          : TEXT_ARRAY_COLUMNS.has(key)
            ? `${key} = $${i + 2}::text[]`
            : `${key} = $${i + 2}`,
      )
      .join(', ');

    const query = `
      INSERT INTO style_profiles (user_id, ${keys.join(', ')})
      VALUES ($1, ${values.map((_, i) => `$${i + 2}`).join(', ')})
      ON CONFLICT (user_id)
      DO UPDATE SET ${setClause}, updated_at = now()
      RETURNING *;
    `;

    const result = await pool.query(query, [userId, ...values]);

    // Invalidate discover cache if any recommendation-relevant column changed
    const touchesDiscover = keys.some(k =>
      StyleProfileService.DISCOVER_RELEVANT_COLUMNS.has(k),
    );
    if (touchesDiscover) {
      await pool
        .query(
          'UPDATE users SET last_discover_refresh = NULL WHERE id = $1',
          [userId],
        )
        .catch(() => {}); // non-critical
    }

    return result.rows[0];
  }

  // ✅ Get profile by internal userId (for viewing other users' profiles)
  async getProfileByUserId(userId: string) {
    const profileRes = await pool.query(
      'SELECT * FROM style_profiles WHERE user_id = $1',
      [userId],
    );

    if (profileRes.rowCount === 0) {
      return null;
    }

    return profileRes.rows[0];
  }

  // ✅ NEW: Pull preferred brands column directly
  async getPreferredBrands(userId: string): Promise<string[]> {
    // 🚀 Directly query with userId (skip Auth0 lookup for this route)
    const res = await pool.query(
      'SELECT preferred_brands FROM style_profiles WHERE user_id = $1',
      [userId],
    );

    if (res.rowCount === 0) return [];

    const raw = res.rows[0].preferred_brands;

    // Normalize output
    if (Array.isArray(raw)) {
      return raw;
    } else if (typeof raw === 'string') {
      return raw
        .replace(/[{}"]/g, '')
        .split(',')
        .map((b) => b.trim())
        .filter(Boolean);
    } else if (raw && typeof raw === 'object' && raw.preferred_brands) {
      return String(raw.preferred_brands)
        .replace(/[{}"]/g, '')
        .split(',')
        .map((b) => b.trim())
        .filter(Boolean);
    }

    return [];
  }
}

/////////////////////

// import { Injectable, NotFoundException } from '@nestjs/common';
// import { Pool } from 'pg';
// import { UpdateStyleProfileDto } from './dto/update-style-profile.dto';

// const pool = new Pool({
//   connectionString: process.env.DATABASE_URL,
//   ssl: { rejectUnauthorized: false },
// });

// @Injectable()
// export class StyleProfileService {
//   async getInternalUserId(auth0Sub: string): Promise<string> {
//     const userRes = await pool.query(
//       'SELECT id FROM users WHERE auth0_sub = $1',
//       [auth0Sub],
//     );

//     if (userRes.rowCount === 0) {
//       throw new NotFoundException(`User not found for sub: ${auth0Sub}`);
//     }

//     return userRes.rows[0].id;
//   }

//   async getProfile(auth0Sub: string) {
//     const userId = await this.getInternalUserId(auth0Sub);

//     let profileRes = await pool.query(
//       'SELECT * FROM style_profiles WHERE user_id = $1',
//       [userId],
//     );

//     if (profileRes.rowCount === 0) {
//       await pool.query('INSERT INTO style_profiles (user_id) VALUES ($1)', [
//         userId,
//       ]);

//       profileRes = await pool.query(
//         'SELECT * FROM style_profiles WHERE user_id = $1',
//         [userId],
//       );
//     }

//     return profileRes.rows[0];
//   }

//   async updateProfile(auth0Sub: string, dto: UpdateStyleProfileDto) {
//     const userId = await this.getInternalUserId(auth0Sub);

//     const filteredEntries = Object.entries(dto).filter(
//       ([, val]) => val !== null && val !== undefined,
//     );

//     if (filteredEntries.length === 0) {
//       console.warn('⚠️ No valid fields to update.');
//       return;
//     }

//     const keys = filteredEntries.map(([key]) => key);
//     const values = filteredEntries.map(([, val]) => val);
//     const setClause = keys.map((key, i) => `${key} = $${i + 2}`).join(', ');

//     console.log('👀 Writing values to DB:', {
//       userId,
//       ...Object.fromEntries(filteredEntries),
//     });

//     const query = `
//       INSERT INTO style_profiles (user_id, ${keys.join(', ')})
//       VALUES ($1, ${values.map((_, i) => `$${i + 2}`).join(', ')})
//       ON CONFLICT (user_id)
//       DO UPDATE SET ${setClause}, updated_at = now()
//       RETURNING *;
//     `;

//     const result = await pool.query(query, [userId, ...values]);
//     console.log('✅ Saved to DB:', result.rows[0]);
//     return result.rows[0];
//   }
// }
