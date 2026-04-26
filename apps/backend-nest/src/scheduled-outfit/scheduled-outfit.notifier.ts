// apps/backend-nest/src/scheduled-outfit/scheduled-outfit.notifier.ts
import { Injectable } from '@nestjs/common';
import { NotificationsService } from '../notifications/notifications.service';
import { pool } from '../db/pool';

@Injectable()
export class ScheduledOutfitNotifier {
  constructor(private readonly notifications: NotificationsService) {}

  async run() {
    const { rows: due } = await pool.query(
      `
      SELECT
        so.id,
        so.user_id,
        so.scheduled_for,
        COALESCE(co.name, ai.name, 'Your planned outfit') AS outfit_name
      FROM scheduled_outfits so
      LEFT JOIN custom_outfits co ON so.custom_outfit_id = co.id
      LEFT JOIN outfit_suggestions ai ON so.ai_outfit_id = ai.id
      WHERE so.notified_at IS NULL
        AND so.scheduled_for <= now()
      ORDER BY so.scheduled_for ASC
      LIMIT 100;
      `,
    );

    if (!due.length) return;

    for (const d of due) {
      const payloadData: Record<string, string> = {
        type: 'scheduled_outfit',
        scheduled_outfit_id: String(d.id ?? ''),
        scheduled_for: d.scheduled_for
          ? new Date(d.scheduled_for).toISOString()
          : '',
        outfit_name: String(d.outfit_name ?? ''),
      };

      await this.notifications.sendPushToUser(
        d.user_id,
        '📅 Outfit Reminder',
        `It's time to wear: ${d.outfit_name}`,
        payloadData,
      );
    }

    await pool.query(
      `UPDATE scheduled_outfits SET notified_at = now() WHERE id = ANY($1::uuid[])`,
      [due.map((d) => d.id)],
    );

    // console.log(`✅ Sent ${due.length} scheduled outfit notifications`);
  }
}

/////////////////////////

// // apps/backend-nest/src/scheduled-outfit/scheduled-outfit.notifier.ts
// import { Injectable } from '@nestjs/common';
// import { Pool } from 'pg';
// import { NotificationsService } from '../notifications/notifications.service';

// const pool = new Pool({
//   connectionString: process.env.DATABASE_URL,
//   ssl: { rejectUnauthorized: false },
// });

// @Injectable()
// export class ScheduledOutfitNotifier {
//   constructor(private readonly notifications: NotificationsService) {}

//   async run() {
//     const { rows: due } = await pool.query(
//       `
//       SELECT
//         so.id,
//         so.user_id,
//         so.scheduled_for,
//         COALESCE(co.name, ai.name, 'Your planned outfit') AS outfit_name
//       FROM scheduled_outfits so
//       LEFT JOIN custom_outfits co ON so.custom_outfit_id = co.id
//       LEFT JOIN outfit_suggestions ai ON so.ai_outfit_id = ai.id
//       WHERE so.notified_at IS NULL
//         AND so.scheduled_for <= now()
//       ORDER BY so.scheduled_for ASC
//       LIMIT 100;
//       `,
//     );

//     if (!due.length) return;

//     for (const d of due) {
//       const payloadData: Record<string, string> = {
//         type: 'scheduled_outfit',
//         scheduled_outfit_id: String(d.id ?? ''),
//         scheduled_for: d.scheduled_for
//           ? new Date(d.scheduled_for).toISOString()
//           : '',
//         outfit_name: String(d.outfit_name ?? ''),
//       };

//       await this.notifications.sendPushToUser(
//         d.user_id,
//         '📅 Outfit Reminder',
//         `It's time to wear: ${d.outfit_name}`,
//         payloadData,
//       );
//     }

//     await pool.query(
//       `UPDATE scheduled_outfits SET notified_at = now() WHERE id = ANY($1::uuid[])`,
//       [due.map((d) => d.id)],
//     );

//     console.log(`✅ Sent ${due.length} scheduled outfit notifications`);
//   }
// }

////////////////////

// // apps/backend-nest/src/scheduled-outfit/scheduled-outfit.notifier.ts
// import { Injectable } from '@nestjs/common';
// import { Pool } from 'pg';
// import { NotificationsService } from '../notifications/notifications.service';

// const pool = new Pool({
//   connectionString: process.env.DATABASE_URL,
//   ssl: { rejectUnauthorized: false },
// });

// @Injectable()
// export class ScheduledOutfitNotifier {
//   constructor(private readonly notifications: NotificationsService) {}

//   async run() {
//     const { rows: due } = await pool.query(
//       `
//       SELECT
//         so.id,
//         so.user_id,
//         so.scheduled_for,
//         COALESCE(co.name, ai.name, 'Your planned outfit') AS outfit_name
//       FROM scheduled_outfits so
//       LEFT JOIN custom_outfits co ON so.custom_outfit_id = co.id
//       LEFT JOIN outfit_suggestions ai ON so.ai_outfit_id = ai.id
//       WHERE so.notified_at IS NULL
//         AND so.scheduled_for <= now()
//       ORDER BY so.scheduled_for ASC
//       LIMIT 100;
//       `,
//     );

//     if (!due.length) return;

//     for (const d of due) {
//       await this.notifications.sendPushToUser(
//         d.user_id,
//         '📅 Outfit Reminder',
//         `It's time to wear: ${d.outfit_name}`,
//         { type: 'scheduled_outfit', scheduled_for: d.scheduled_for },
//       );
//     }

//     await pool.query(
//       `UPDATE scheduled_outfits SET notified_at = now() WHERE id = ANY($1::uuid[])`,
//       [due.map((d) => d.id)],
//     );

//     console.log(`✅ Sent ${due.length} scheduled outfit notifications`);
//   }
// }
