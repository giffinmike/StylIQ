import { Injectable, NotFoundException } from '@nestjs/common';
import { pool } from '../db/pool';
import { CreateTripDto } from './dto/create-trip.dto';
import { UpdateTripItemsDto } from './dto/update-trip-items.dto';

function normalizeActivities(raw: any): string[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function mapRow(row: any) {
  return {
    id: row.id,
    destination: row.destination,
    startDate: row.start_date,
    endDate: row.end_date,
    activities: normalizeActivities(row.activities),
    presentation: row.presentation ?? null,
    weather: row.weather ?? [],
    capsule: row.capsule ?? null,
    startingLocationId: row.starting_location_id ?? null,
    startingLocationLabel: row.starting_location_label ?? null,
    items: row.items ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

@Injectable()
export class TripsService {
  async create(userId: string, dto: CreateTripDto) {
    console.log('🔥 [TripsService] create() hit');
    const {
      destination,
      startDate,
      endDate,
      activities,
      presentation,
      weather,
      capsule,
      startingLocationId,
      startingLocationLabel,
      items,
    } = dto;

    // Insert trip — stringify JS objects for JSONB columns
    const activitiesJson = activities ? JSON.stringify(activities) : null;
    const weatherJson = weather ? JSON.stringify(weather) : null;
    const capsuleJson = capsule ? JSON.stringify(capsule) : null;

    const tripRes = await pool.query(
      `INSERT INTO trips
         (user_id, destination, start_date, end_date, activities, presentation,
          weather, capsule, starting_location_id, starting_location_label)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8::jsonb, $9, $10)
       RETURNING *`,
      [
        userId,
        destination,
        startDate,
        endDate,
        activitiesJson,
        presentation ?? null,
        weatherJson,
        capsuleJson,
        startingLocationId ?? null,
        startingLocationLabel ?? null,
      ],
    );
    const trip = tripRes.rows[0];
    console.log('🔥 [TripsService] INSERT complete', trip?.id);

    // Bulk insert trip_items
    if (items.length > 0) {
      const values: any[] = [];
      const placeholders = items.map((item, i) => {
        const offset = i * 3;
        values.push(trip.id, item.wardrobeItemId, item.role ?? null);
        return `($${offset + 1}, $${offset + 2}, $${offset + 3})`;
      });

      await pool.query(
        `INSERT INTO trip_items (trip_id, wardrobe_item_id, role)
         VALUES ${placeholders.join(', ')}`,
        values,
      );
    }

    return mapRow({
      ...trip,
      items: items.map((it) => ({
        wardrobeItemId: it.wardrobeItemId,
        role: it.role ?? null,
      })),
    });
  }

  async findAll(userId: string) {
    const res = await pool.query(
      `SELECT
         t.id,
         t.destination,
         t.start_date,
         t.end_date,
         t.activities,
         t.presentation,
         t.weather,
         t.capsule,
         t.starting_location_id,
         t.starting_location_label,
         t.created_at,
         t.updated_at,
         COALESCE(
           json_agg(
             json_build_object(
               'wardrobe_item_id', ti.wardrobe_item_id,
               'role', ti.role
             )
           ) FILTER (WHERE ti.id IS NOT NULL),
           '[]'::json
         ) AS items
       FROM trips t
       LEFT JOIN trip_items ti ON ti.trip_id = t.id
       WHERE t.user_id = $1
       GROUP BY t.id
       ORDER BY t.start_date DESC`,
      [userId],
    );
    return res.rows.map(mapRow);
  }

  async findOne(tripId: string, userId: string) {
    const res = await pool.query(
      `SELECT
         t.*,
         COALESCE(
           json_agg(
             json_build_object(
               'id', ti.id,
               'wardrobeItemId', ti.wardrobe_item_id,
               'role', ti.role,
               'name', wi.name,
               'main_category', wi.main_category,
               'subcategory', wi.subcategory,
               'color', wi.color,
               'image_url', wi.image_url,
               'brand', wi.brand
             )
           ) FILTER (WHERE ti.id IS NOT NULL),
           '[]'::json
         ) AS items
       FROM trips t
       LEFT JOIN trip_items ti ON ti.trip_id = t.id
       LEFT JOIN wardrobe_items wi ON wi.id = ti.wardrobe_item_id
       WHERE t.id = $1 AND t.user_id = $2
       GROUP BY t.id`,
      [tripId, userId],
    );

    if (res.rows.length === 0) {
      throw new NotFoundException('Trip not found');
    }

    return mapRow(res.rows[0]);
  }

  async remove(tripId: string, userId: string) {
    console.log('🔥 [TripsService] delete() hit');
    console.log('🔥 [TripsService] tripId:', tripId, 'userId:', userId);

    // Delete trip_items first as safety (in case cascade not set)
    await pool.query(`DELETE FROM trip_items WHERE trip_id = $1`, [tripId]);

    const res = await pool.query(
      `DELETE FROM trips WHERE id = $1 AND user_id = $2 RETURNING id`,
      [tripId, userId],
    );

    console.log('🔥 [TripsService] DELETE rowCount:', res.rowCount);

    if (res.rowCount === 0) {
      throw new NotFoundException('Trip not found');
    }

    return { deleted: true };
  }

  async replaceItems(tripId: string, userId: string, dto: UpdateTripItemsDto) {
    // console.log('[TripsService][REPLACE_ITEMS] tripId:', tripId, 'userId:', userId);
    // console.log('[TripsService][REPLACE_ITEMS] items count:', dto.items?.length, 'capsule:', dto.capsule ? 'present' : 'null');

    try {
      // Verify ownership
      const tripRes = await pool.query(
        `SELECT id FROM trips WHERE id = $1 AND user_id = $2`,
        [tripId, userId],
      );
      if (tripRes.rows.length === 0) {
        throw new NotFoundException('Trip not found');
      }

      // Delete existing items
      await pool.query(`DELETE FROM trip_items WHERE trip_id = $1`, [tripId]);

      // Insert new items
      const { items, capsule } = dto;
      if (items.length > 0) {
        const values: any[] = [];
        const placeholders = items.map((item, i) => {
          const offset = i * 3;
          values.push(tripId, item.wardrobeItemId, item.role ?? null);
          return `($${offset + 1}, $${offset + 2}, $${offset + 3})`;
        });

        await pool.query(
          `INSERT INTO trip_items (trip_id, wardrobe_item_id, role)
           VALUES ${placeholders.join(', ')}`,
          values,
        );
      }

      // Persist capsule snapshot if provided
      if (capsule !== undefined) {
        await pool.query(
          `UPDATE trips SET capsule = $1, updated_at = NOW() WHERE id = $2`,
          [capsule ? JSON.stringify(capsule) : null, tripId],
        );
      }

      return { tripId, items };
    } catch (err) {
      console.error('[TripsService][UPDATE_ERROR]', err);
      console.error(
        '[TripsService][UPDATE_PAYLOAD]',
        JSON.stringify(dto).slice(0, 1000),
      );
      throw err;
    }
  }
}
