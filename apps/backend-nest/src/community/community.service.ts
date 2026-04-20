import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  OnModuleInit,
} from '@nestjs/common';
import { NotificationsService } from '../notifications/notifications.service';
import { VertexService } from '../vertex/vertex.service';
import {
  upsertPostEmbedding,
  querySimilarPosts,
  deletePostEmbedding,
  fetchPostEmbeddings,
} from './community-vectors';
import { pool } from '../db/pool';
import { LearningEventsService } from '../learning/learning-events.service';
import { LEARNING_FLAGS } from '../config/feature-flags';

@Injectable()
export class CommunityService implements OnModuleInit {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly vertex: VertexService,
    private readonly learningEvents: LearningEventsService,
  ) {}

  async onModuleInit() {
    // Run table init safely during boot
    try {
      await this.initTables();
      console.log('✅ Community tables ready');
    } catch (e: any) {
      // IMPORTANT: don’t crash the whole service just because DB is momentarily unavailable
      console.error('❌ Community initTables failed:', e?.message || e);
    }
  }

  // One-time migration to fix tables with TEXT user_id columns to UUID
  private async migrateToUuidUserIds() {
    // SAFETY: never drop tables automatically in production
    if (process.env.NODE_ENV === 'production') {
      console.warn('⚠️ Skipping migrateToUuidUserIds in production');
      return;
    }

    const columnCheck = await pool.query(`
      SELECT data_type FROM information_schema.columns
      WHERE table_name = 'post_likes' AND column_name = 'user_id'
    `);

    if (
      columnCheck.rows.length === 0 ||
      columnCheck.rows[0].data_type === 'uuid'
    ) {
      return;
    }

    console.log(
      '🔄 Migrating community tables from TEXT to UUID user_id columns...',
    );

    await pool.query('DROP TABLE IF EXISTS post_reports CASCADE');
    await pool.query('DROP TABLE IF EXISTS muted_users CASCADE');
    await pool.query('DROP TABLE IF EXISTS blocked_users CASCADE');
    await pool.query('DROP TABLE IF EXISTS saved_posts CASCADE');
    await pool.query('DROP TABLE IF EXISTS user_follows CASCADE');
    await pool.query('DROP TABLE IF EXISTS comment_likes CASCADE');
    await pool.query('DROP TABLE IF EXISTS post_comments CASCADE');
    await pool.query('DROP TABLE IF EXISTS post_likes CASCADE');
    await pool.query('DROP TABLE IF EXISTS community_posts CASCADE');

    console.log(
      '✅ Community tables dropped, will be recreated with UUID columns',
    );
  }

  private async initTables() {
    // Drop and recreate tables to fix UUID column types (one-time migration)
    // The tables were originally created with TEXT user_id but need UUID
    await this.migrateToUuidUserIds();

    // Community posts table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS community_posts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL,
        image_url TEXT,
        top_image TEXT,
        bottom_image TEXT,
        shoes_image TEXT,
        accessory_image TEXT,
        description TEXT,
        tags TEXT[] DEFAULT '{}',
        likes_count INT DEFAULT 0,
        comments_count INT DEFAULT 0,
        views_count INT DEFAULT 0,
        is_demo BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Add views_count column if it doesn't exist (migration)
    await pool.query(`
      ALTER TABLE community_posts ADD COLUMN IF NOT EXISTS views_count INT DEFAULT 0
    `);

    // Add name column if it doesn't exist (migration)
    await pool.query(`
      ALTER TABLE community_posts ADD COLUMN IF NOT EXISTS name TEXT
    `);

    // Add bio column to users if it doesn't exist
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT
    `);

    // Post likes table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS post_likes (
        user_id UUID NOT NULL,
        post_id UUID NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (user_id, post_id)
      )
    `);

    // Post comments table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS post_comments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        post_id UUID NOT NULL,
        user_id UUID NOT NULL,
        content TEXT NOT NULL,
        reply_to_id UUID,
        reply_to_user TEXT,
        likes_count INT DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Comment likes table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS comment_likes (
        user_id UUID NOT NULL,
        comment_id UUID NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (user_id, comment_id)
      )
    `);

    // User follows table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_follows (
        follower_id UUID NOT NULL,
        following_id UUID NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (follower_id, following_id)
      )
    `);

    // Saved posts table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS saved_posts (
        user_id UUID NOT NULL,
        post_id UUID NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (user_id, post_id)
      )
    `);

    // Blocked users table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS blocked_users (
        blocker_id UUID NOT NULL,
        blocked_id UUID NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (blocker_id, blocked_id)
      )
    `);

    // Muted users table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS muted_users (
        muter_id UUID NOT NULL,
        muted_id UUID NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (muter_id, muted_id)
      )
    `);

    // Post reports table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS post_reports (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        reporter_id UUID NOT NULL,
        post_id UUID NOT NULL,
        reason TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // User preference vectors for recommendations
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_preference_vectors (
        user_id UUID PRIMARY KEY,
        vector FLOAT8[] NOT NULL,
        interaction_count INT DEFAULT 0,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Post views table for dedupe
    await pool.query(`
      CREATE TABLE IF NOT EXISTS post_views (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        post_id UUID NOT NULL,
        user_id UUID,
        viewed_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT unique_post_view UNIQUE (post_id, user_id)
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_post_views_post_id ON post_views(post_id)
    `);

    // Seed demo posts if table is empty
    await this.seedDemoPosts();
  }

  private async seedDemoPosts() {
    // Guard: skip if ANY posts exist (user or demo) to prevent duplicate seeding
    const countRes = await pool.query('SELECT COUNT(*) FROM community_posts');
    if (parseInt(countRes.rows[0].count) > 0) return;

    // Double-check: also skip if demo posts specifically already exist
    const demoRes = await pool.query(
      'SELECT COUNT(*) FROM community_posts WHERE is_demo = true',
    );
    if (parseInt(demoRes.rows[0].count) > 0) return;

    const demoPosts = [
      {
        image_url:
          'https://images.unsplash.com/photo-1507680434567-5739c80be1ac?w=400',
        tags: ['casual', 'summer'],
        description: 'Summer vibes',
      },
      {
        image_url:
          'https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?w=400',
        tags: ['elegant', 'evening'],
        description: 'Evening elegance',
      },
      {
        image_url:
          'https://images.unsplash.com/photo-1509631179647-0177331693ae?w=400',
        tags: ['streetwear', 'urban'],
        description: 'Street style',
      },
      {
        image_url:
          'https://images.unsplash.com/photo-1496747611176-843222e1e57c?w=400',
        tags: ['minimal', 'clean'],
        description: 'Minimal look',
      },
      {
        image_url:
          'https://images.unsplash.com/photo-1485968579169-51d62cf4b8e6?w=400',
        tags: ['professional', 'smart'],
        description: 'Office ready',
      },
      {
        image_url:
          'https://images.unsplash.com/photo-1469334031218-e382a71b716b?w=400',
        tags: ['boho', 'relaxed'],
        description: 'Boho vibes',
      },
      {
        top_image:
          'https://images.unsplash.com/photo-1564257631407-4deb1f99d992?w=400',
        bottom_image:
          'https://images.unsplash.com/photo-1541099649105-f69ad21f3246?w=400',
        shoes_image:
          'https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=400',
        accessory_image:
          'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=400',
        tags: ['casual', 'summer'],
        description: 'Complete summer outfit',
      },
      {
        top_image:
          'https://images.unsplash.com/photo-1618354691373-d851c5c3a990?w=400',
        bottom_image:
          'https://images.unsplash.com/photo-1624378439575-d8705ad7ae80?w=400',
        shoes_image:
          'https://images.unsplash.com/photo-1595950653106-6c9ebd614d3a?w=400',
        accessory_image:
          'https://images.unsplash.com/photo-1553062407-98eeb64c6a62?w=400',
        tags: ['elegant', 'evening'],
        description: 'Evening outfit combo',
      },
    ];

    for (const post of demoPosts) {
      await pool.query(
        `INSERT INTO community_posts (user_id, image_url, top_image, bottom_image, shoes_image, accessory_image, tags, description, likes_count, is_demo)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, true)`,
        [
          post.image_url || null,
          post.top_image || null,
          post.bottom_image || null,
          post.shoes_image || null,
          post.accessory_image || null,
          post.tags,
          post.description,
          Math.floor(Math.random() * 500) + 100,
        ],
      );
    }
  }

  // ==================== POSTS ====================

  async createPost(
    userId: string,
    data: {
      imageUrl?: string;
      topImage?: string;
      bottomImage?: string;
      shoesImage?: string;
      accessoryImage?: string;
      name?: string;
      description?: string;
      tags?: string[];
    },
  ) {
    const res = await pool.query(
      `INSERT INTO community_posts (user_id, image_url, top_image, bottom_image, shoes_image, accessory_image, name, description, tags)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        userId,
        data.imageUrl || null,
        data.topImage || null,
        data.bottomImage || null,
        data.shoesImage || null,
        data.accessoryImage || null,
        data.name || null,
        data.description || null,
        data.tags || [],
      ],
    );

    const post = res.rows[0];

    // Generate embedding asynchronously (non-blocking)
    this.embedPostAsync(post).catch((err) => {
      console.error(`⚠️ Failed to embed post ${post.id}:`, err.message);
    });

    return post;
  }

  /**
   * Generate and store embedding for a community post.
   * Uses the primary image or combines text from description + tags.
   */
  private async embedPostAsync(post: any) {
    try {
      const imageUrl = post.image_url || post.top_image;

      let vector: number[];

      if (imageUrl && imageUrl.startsWith('gs://')) {
        // If image is in GCS, use image embedding
        vector = await this.vertex.embedImage(imageUrl);
      } else if (post.description || (post.tags && post.tags.length > 0)) {
        // Fall back to text embedding from description + tags
        const textContent = [post.description || '', ...(post.tags || [])]
          .join(' ')
          .trim();

        if (!textContent) {
          console.log(`ℹ️ Post ${post.id} has no embeddable content, skipping`);
          return;
        }

        vector = await this.vertex.embedText(textContent);
      } else {
        console.log(
          `ℹ️ Post ${post.id} has no image or text to embed, skipping`,
        );
        return;
      }

      await upsertPostEmbedding({
        postId: post.id,
        vector,
        metadata: {
          userId: post.user_id,
          tags: post.tags || [],
          description: post.description || '',
          createdAt: post.created_at,
        },
      });
    } catch (err: any) {
      console.error(`⚠️ embedPostAsync error for ${post.id}:`, err.message);
    }
  }

  /**
   * Update user's preference vector based on a post they liked/saved.
   * Uses exponential moving average to blend new preferences with existing ones.
   */
  private async updateUserPreference(userId: string, postId: string) {
    try {
      // Fetch the post's embedding from Pinecone
      const embeddings = await fetchPostEmbeddings([postId]);
      const postEmbedding = embeddings[postId];

      if (!postEmbedding?.values || postEmbedding.values.length === 0) {
        // console.log(
        //   `ℹ️ Post ${postId} has no embedding yet, skipping preference update`,
        // );
        return;
      }

      const postVector = postEmbedding.values as number[];

      // Get user's current preference vector
      const existing = await pool.query(
        `SELECT vector, interaction_count FROM user_preference_vectors WHERE user_id = $1`,
        [userId],
      );

      let newVector: number[];
      let newCount: number;

      if (existing.rows.length === 0) {
        // First interaction - use post vector directly
        newVector = postVector;
        newCount = 1;
      } else {
        // Blend with existing preference using exponential moving average
        const currentVector = existing.rows[0].vector as number[];
        const count = existing.rows[0].interaction_count || 1;

        // Weight new interactions more heavily for fresh users, less for established
        const alpha = Math.max(0.1, 1 / (count + 1));

        newVector = currentVector.map(
          (v, i) => v * (1 - alpha) + postVector[i] * alpha,
        );
        newCount = count + 1;
      }

      // Upsert the preference vector
      await pool.query(
        `INSERT INTO user_preference_vectors (user_id, vector, interaction_count, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (user_id) DO UPDATE SET
           vector = $2,
           interaction_count = $3,
           updated_at = NOW()`,
        [userId, newVector, newCount],
      );

      // console.log(
      //   `✅ Updated preference vector for user ${userId} (${newCount} interactions)`,
      // );
    } catch (err: any) {
      console.error(`⚠️ updateUserPreference error:`, err.message);
    }
  }

  async getPosts(
    filter: string = 'all',
    currentUserId?: string,
    limit: number = 20,
    offset: number = 0,
  ) {
    // console.log('📥 getPosts called:', { filter, currentUserId, limit, offset });

    // Handle 'foryou' filter separately - uses Pinecone vector search
    if (filter === 'foryou' && currentUserId) {
      return this.getForYouPosts(currentUserId, limit, offset);
    }

    let orderBy = 'ORDER BY cp.created_at DESC';
    let whereClause = 'WHERE 1=1';

    if (filter === 'trending') {
      // Trending: engagement weighted by recency (time decay)
      orderBy = `ORDER BY
        (cp.likes_count + cp.comments_count * 2 + COALESCE(cp.views_count, 0) * 0.1) /
        POWER(EXTRACT(EPOCH FROM (NOW() - cp.created_at)) / 3600 + 2, 1.5) DESC`;
    } else if (filter === 'new') {
      orderBy = 'ORDER BY cp.created_at DESC';
    } else if (filter === 'following' && currentUserId) {
      whereClause = `WHERE cp.user_id IN (SELECT following_id FROM user_follows WHERE follower_id = $3)`;
    }

    // Exclude posts from blocked/muted users for current user
    if (currentUserId) {
      whereClause += ` AND cp.user_id NOT IN (SELECT blocked_id FROM blocked_users WHERE blocker_id = $3)`;
      whereClause += ` AND cp.user_id NOT IN (SELECT muted_id FROM muted_users WHERE muter_id = $3)`;
    }

    const query = `
      SELECT
        cp.id,
        cp.user_id,
        cp.image_url,
        cp.top_image,
        cp.bottom_image,
        cp.shoes_image,
        cp.accessory_image,
        cp.name,
        cp.description,
        cp.tags,
        cp.likes_count,
        cp.comments_count,
        cp.views_count,
        cp.is_demo,
        cp.created_at,
        COALESCE(u.first_name, 'StylHelpr') || ' ' || COALESCE(u.last_name, 'User') as user_name,
        COALESCE(u.profile_picture, 'https://i.pravatar.cc/100?u=' || cp.user_id) as user_avatar,
        ${currentUserId ? `EXISTS(SELECT 1 FROM post_likes WHERE post_id = cp.id AND user_id = $3) as is_liked_by_me` : 'false as is_liked_by_me'},
        ${currentUserId ? `EXISTS(SELECT 1 FROM saved_posts WHERE post_id = cp.id AND user_id = $3) as is_saved_by_me` : 'false as is_saved_by_me'},
        ${currentUserId ? `EXISTS(SELECT 1 FROM user_follows WHERE follower_id = $3 AND following_id = cp.user_id) as is_following_author` : 'false as is_following_author'}
      FROM community_posts cp
      LEFT JOIN users u ON cp.user_id = u.id
      ${whereClause}
      ${orderBy}
      LIMIT $1 OFFSET $2
    `;

    const params = currentUserId
      ? [limit, offset, currentUserId]
      : [limit, offset];
    const res = await pool.query(query, params);

    // Deduplicate by post ID (preserves original ordering)
    const seen = new Set<string>();
    return res.rows.filter((row: any) => {
      if (seen.has(row.id)) return false;
      seen.add(row.id);
      return true;
    });
  }

  /**
   * Get personalized "For You" posts using vector similarity.
   * Falls back to trending if user has no preference vector yet.
   */
  private async getForYouPosts(userId: string, limit: number, offset: number) {
    // Get user's preference vector
    const prefResult = await pool.query(
      `SELECT vector FROM user_preference_vectors WHERE user_id = $1`,
      [userId],
    );

    // If no preference vector, fall back to trending
    if (prefResult.rows.length === 0 || !prefResult.rows[0].vector) {
      console.log(
        `ℹ️ User ${userId} has no preference vector, falling back to trending`,
      );
      return this.getPosts('trending', userId, limit, offset);
    }

    const userVector = prefResult.rows[0].vector as number[];

    // Get posts user has already liked/saved (to exclude)
    const interactedResult = await pool.query(
      `SELECT post_id FROM post_likes WHERE user_id = $1
       UNION
       SELECT post_id FROM saved_posts WHERE user_id = $1`,
      [userId],
    );
    const excludePostIds = interactedResult.rows.map((r: any) => r.post_id);

    // Get users the current user follows (to exclude - those go in Following feed)
    const followingResult = await pool.query(
      `SELECT following_id FROM user_follows WHERE follower_id = $1`,
      [userId],
    );
    const followingUserIds = followingResult.rows.map(
      (r: any) => r.following_id,
    );

    // Get blocked/muted users
    const blockedResult = await pool.query(
      `SELECT blocked_id FROM blocked_users WHERE blocker_id = $1
       UNION
       SELECT muted_id FROM muted_users WHERE muter_id = $1`,
      [userId],
    );
    const excludeUserIds = [
      ...followingUserIds,
      ...blockedResult.rows.map((r: any) => r.blocked_id || r.muted_id),
      userId, // Exclude own posts
    ];

    // Query Pinecone for similar posts
    const similarPosts = await querySimilarPosts({
      vector: userVector,
      topK: limit + offset,
      excludePostIds,
      excludeUserIds,
    });

    if (similarPosts.length === 0) {
      // console.log(`ℹ️ No similar posts found for user ${userId}, falling back to trending`);
      return this.getPosts('trending', userId, limit, offset);
    }

    // Get post IDs from Pinecone results (apply offset)
    const postIds = similarPosts.slice(offset, offset + limit).map((p) => p.id);

    if (postIds.length === 0) {
      return [];
    }

    // Fetch full post data from PostgreSQL
    const query = `
      SELECT
        cp.id,
        cp.user_id,
        cp.image_url,
        cp.top_image,
        cp.bottom_image,
        cp.shoes_image,
        cp.accessory_image,
        cp.name,
        cp.description,
        cp.tags,
        cp.likes_count,
        cp.comments_count,
        cp.views_count,
        cp.is_demo,
        cp.created_at,
        COALESCE(u.first_name, 'StylHelpr') || ' ' || COALESCE(u.last_name, 'User') as user_name,
        COALESCE(u.profile_picture, 'https://i.pravatar.cc/100?u=' || cp.user_id) as user_avatar,
        EXISTS(SELECT 1 FROM post_likes WHERE post_id = cp.id AND user_id = $2) as is_liked_by_me,
        EXISTS(SELECT 1 FROM saved_posts WHERE post_id = cp.id AND user_id = $2) as is_saved_by_me,
        EXISTS(SELECT 1 FROM user_follows WHERE follower_id = $2 AND following_id = cp.user_id) as is_following_author
      FROM community_posts cp
      LEFT JOIN users u ON cp.user_id = u.id
      WHERE cp.id = ANY($1)
    `;

    const res = await pool.query(query, [postIds, userId]);

    // Sort results to match Pinecone ranking order
    const postMap = new Map(res.rows.map((p: any) => [p.id, p]));
    return postIds.map((id) => postMap.get(id)).filter(Boolean);
  }

  async searchPosts(query: string, currentUserId?: string, limit: number = 20) {
    const searchPattern = `%${query.toLowerCase()}%`;

    const postColumns = `
      cp.id,
      cp.user_id,
      cp.image_url,
      cp.top_image,
      cp.bottom_image,
      cp.shoes_image,
      cp.accessory_image,
      cp.name,
      cp.description,
      cp.tags,
      cp.likes_count,
      cp.comments_count,
      cp.views_count,
      cp.is_demo,
      cp.created_at`;

    const sqlQuery = currentUserId
      ? `SELECT
          ${postColumns},
          COALESCE(u.first_name, 'StylHelpr') || ' ' || COALESCE(u.last_name, 'User') as user_name,
          COALESCE(u.profile_picture, 'https://i.pravatar.cc/100?u=' || cp.user_id) as user_avatar,
          EXISTS(SELECT 1 FROM post_likes WHERE post_id = cp.id AND user_id = $3) as is_liked_by_me,
          EXISTS(SELECT 1 FROM saved_posts WHERE post_id = cp.id AND user_id = $3) as is_saved_by_me,
          EXISTS(SELECT 1 FROM user_follows WHERE follower_id = $3 AND following_id = cp.user_id) as is_following_author
        FROM community_posts cp
        LEFT JOIN users u ON cp.user_id = u.id
        WHERE
          LOWER(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) LIKE $1
          OR $2 = ANY(SELECT LOWER(unnest(cp.tags)))
        ORDER BY cp.created_at DESC
        LIMIT $4`
      : `SELECT
          ${postColumns},
          COALESCE(u.first_name, 'StylHelpr') || ' ' || COALESCE(u.last_name, 'User') as user_name,
          COALESCE(u.profile_picture, 'https://i.pravatar.cc/100?u=' || cp.user_id) as user_avatar,
          false as is_liked_by_me,
          false as is_saved_by_me,
          false as is_following_author
        FROM community_posts cp
        LEFT JOIN users u ON cp.user_id = u.id
        WHERE
          LOWER(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) LIKE $1
          OR $2 = ANY(SELECT LOWER(unnest(cp.tags)))
        ORDER BY cp.created_at DESC
        LIMIT $3`;

    const params = currentUserId
      ? [searchPattern, query.toLowerCase(), currentUserId, limit]
      : [searchPattern, query.toLowerCase(), limit];

    const res = await pool.query(sqlQuery, params);

    // Deduplicate by post ID (preserves original ordering)
    const seen = new Set<string>();
    return res.rows.filter((row: any) => {
      if (seen.has(row.id)) return false;
      seen.add(row.id);
      return true;
    });
  }

  async getPostById(postId: string, currentUserId?: string) {
    const res = await pool.query(
      `SELECT
        cp.id,
        cp.user_id,
        cp.image_url,
        cp.top_image,
        cp.bottom_image,
        cp.shoes_image,
        cp.accessory_image,
        cp.name,
        cp.description,
        cp.tags,
        cp.likes_count,
        cp.comments_count,
        cp.views_count,
        cp.is_demo,
        cp.created_at,
        COALESCE(u.first_name, 'StylHelpr') || ' ' || COALESCE(u.last_name, 'User') as user_name,
        COALESCE(u.profile_picture, 'https://i.pravatar.cc/100?u=' || cp.user_id) as user_avatar,
        ${currentUserId ? `EXISTS(SELECT 1 FROM post_likes WHERE post_id = cp.id AND user_id = $2) as is_liked_by_me` : 'false as is_liked_by_me'},
        ${currentUserId ? `EXISTS(SELECT 1 FROM saved_posts WHERE post_id = cp.id AND user_id = $2) as is_saved_by_me` : 'false as is_saved_by_me'}
      FROM community_posts cp
      LEFT JOIN users u ON cp.user_id = u.id
      WHERE cp.id = $1`,
      currentUserId ? [postId, currentUserId] : [postId],
    );

    if (res.rows.length === 0) {
      throw new NotFoundException('Post not found');
    }
    return res.rows[0];
  }

  async deletePost(postId: string, userId: string) {
    const post = await pool.query(
      'SELECT user_id FROM community_posts WHERE id = $1',
      [postId],
    );
    if (post.rows.length === 0) {
      throw new NotFoundException('Post not found');
    }
    if (post.rows[0].user_id !== userId) {
      throw new ForbiddenException('You can only delete your own posts');
    }

    await pool.query('DELETE FROM post_likes WHERE post_id = $1', [postId]);
    await pool.query('DELETE FROM post_comments WHERE post_id = $1', [postId]);
    await pool.query('DELETE FROM saved_posts WHERE post_id = $1', [postId]);
    await pool.query('DELETE FROM community_posts WHERE id = $1', [postId]);

    // Delete embedding from Pinecone asynchronously
    deletePostEmbedding(postId).catch((err: any) => {
      console.error(
        `⚠️ Failed to delete embedding for post ${postId}:`,
        err.message,
      );
    });

    return { message: 'Post deleted' };
  }

  async updatePost(
    postId: string,
    userId: string,
    name?: string,
    description?: string,
    tags?: string[],
  ) {
    const post = await pool.query(
      'SELECT user_id FROM community_posts WHERE id = $1',
      [postId],
    );
    if (post.rows.length === 0) {
      throw new NotFoundException('Post not found');
    }
    if (post.rows[0].user_id !== userId) {
      throw new ForbiddenException('You can only edit your own posts');
    }

    const updates: string[] = [];
    const params: any[] = [postId];
    let paramIndex = 2;

    if (name !== undefined) {
      updates.push(`name = $${paramIndex}`);
      params.push(name);
      paramIndex++;
    }

    if (description !== undefined) {
      updates.push(`description = $${paramIndex}`);
      params.push(description);
      paramIndex++;
    }

    if (tags !== undefined) {
      updates.push(`tags = $${paramIndex}`);
      params.push(tags);
      paramIndex++;
    }

    if (updates.length === 0) {
      return { message: 'Nothing to update' };
    }

    await pool.query(
      `UPDATE community_posts SET ${updates.join(', ')} WHERE id = $1`,
      params,
    );

    return { message: 'Post updated' };
  }

  // ==================== LIKES ====================

  async likePost(postId: string, userId: string) {
    // Check if already liked to avoid duplicate notifications
    const existing = await pool.query(
      `SELECT 1 FROM post_likes WHERE user_id = $1 AND post_id = $2`,
      [userId, postId],
    );
    const alreadyLiked = existing.rows.length > 0;

    if (!alreadyLiked) {
      await pool.query(
        `INSERT INTO post_likes (user_id, post_id)
         VALUES ($1, $2)
         ON CONFLICT (user_id, post_id) DO NOTHING`,
        [userId, postId],
      );

      // Emit POST_LIKED learning event (shadow mode - no behavior change)
      if (LEARNING_FLAGS.EVENTS_ENABLED) {
        pool
          .query(`SELECT tags FROM community_posts WHERE id = $1`, [postId])
          .then((res) => {
            const tags: string[] = res.rows[0]?.tags || [];
            this.learningEvents
              .logEvent({
                userId,
                eventType: 'POST_LIKED',
                entityType: 'post',
                entityId: postId,
                signalPolarity: 1,
                signalWeight: 0.3,
                extractedFeatures: { tags },
                sourceFeature: 'community',
                clientEventId: `post_liked:${userId}:${postId}`,
              })
              .catch(() => {});
          })
          .catch(() => {});
      }
    }

    // Always sync likes_count with actual count
    await pool.query(
      `UPDATE community_posts
       SET likes_count = (SELECT COUNT(*) FROM post_likes WHERE post_id = $1)
       WHERE id = $1`,
      [postId],
    );

    if (alreadyLiked) {
      return { message: 'Already liked' };
    }

    // Send push notification to post owner (don't notify yourself)
    try {
      const postOwner = await pool.query(
        `SELECT cp.user_id, cp.name, COALESCE(u.first_name, 'Someone') as liker_name
         FROM community_posts cp
         LEFT JOIN users u ON u.id = $2
         WHERE cp.id = $1`,
        [postId, userId],
      );
      const ownerId = postOwner.rows[0]?.user_id;
      const likerName = postOwner.rows[0]?.liker_name || 'Someone';
      const postName = postOwner.rows[0]?.name;
      if (ownerId && ownerId !== userId) {
        const title = 'New Like';
        const message = postName
          ? `${likerName} liked your post "${postName.slice(0, 50)}${postName.length > 50 ? '...' : ''}"`
          : `${likerName} liked your post`;
        this.notifications.sendPushToUser(ownerId, title, message, {
          type: 'like',
          postId,
          category: 'message',
        });
        // Save to inbox for Community Messages section
        this.notifications.saveInboxItem({
          id: `like-${postId}-${userId}-${Date.now()}`,
          user_id: ownerId,
          title,
          message,
          timestamp: new Date().toISOString(),
          category: 'message',
          data: { type: 'like', postId, likerId: userId },
        });
      }
    } catch (e) {
      console.error('Failed to send like notification:', e);
    }

    // Update user preference vector asynchronously
    this.updateUserPreference(userId, postId).catch((err: any) => {
      console.error(
        `⚠️ Failed to update preference for user ${userId}:`,
        err.message,
      );
    });

    return { message: 'Post liked' };
  }

  async unlikePost(postId: string, userId: string) {
    await pool.query(
      'DELETE FROM post_likes WHERE user_id = $1 AND post_id = $2',
      [userId, postId],
    );

    await pool.query(
      `UPDATE community_posts
       SET likes_count = (SELECT COUNT(*) FROM post_likes WHERE post_id = $1)
       WHERE id = $1`,
      [postId],
    );

    return { message: 'Post unliked' };
  }

  // ==================== COMMENTS ====================

  async getComments(postId: string, currentUserId?: string) {
    const res = await pool.query(
      `SELECT
        pc.id,
        pc.post_id,
        pc.user_id,
        pc.content,
        pc.reply_to_id,
        pc.reply_to_user,
        pc.likes_count,
        pc.created_at,
        COALESCE(u.first_name, 'StylHelpr') || ' ' || COALESCE(u.last_name, 'User') as user_name,
        COALESCE(u.profile_picture, 'https://i.pravatar.cc/100?u=' || pc.user_id) as user_avatar,
        ${currentUserId ? `EXISTS(SELECT 1 FROM comment_likes WHERE comment_id = pc.id AND user_id = $2) as is_liked_by_me` : 'false as is_liked_by_me'}
      FROM post_comments pc
      LEFT JOIN users u ON pc.user_id = u.id
      WHERE pc.post_id = $1
      ORDER BY pc.created_at ASC`,
      currentUserId ? [postId, currentUserId] : [postId],
    );
    return res.rows;
  }

  async addComment(
    postId: string,
    userId: string,
    content: string,
    replyToId?: string,
    replyToUser?: string,
  ) {
    // console.log('📥 addComment called:', {
    //   postId,
    //   userId,
    //   content,
    //   replyToId,
    //   replyToUser,
    // });

    try {
      const res = await pool.query(
        `INSERT INTO post_comments (post_id, user_id, content, reply_to_id, reply_to_user)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, post_id, user_id, content, reply_to_id, reply_to_user, likes_count, created_at`,
        [postId, userId, content, replyToId || null, replyToUser || null],
      );
      // console.log('📥 Comment inserted:', res.rows[0]);

      await pool.query(
        `UPDATE community_posts
         SET comments_count = (SELECT COUNT(*) FROM post_comments WHERE post_id = $1)
         WHERE id = $1`,
        [postId],
      );

      // Get user info for response
      const userRes = await pool.query(
        `SELECT
          COALESCE(first_name, 'StylHelpr') || ' ' || COALESCE(last_name, 'User') as user_name,
          COALESCE(first_name, 'Someone') as commenter_first_name,
          COALESCE(profile_picture, 'https://i.pravatar.cc/100?u=' || $1) as user_avatar
        FROM users WHERE id = $1::uuid`,
        [userId],
      );

      // Send push notification to post owner (non-blocking)
      this.sendCommentNotification(
        postId,
        userId,
        content,
        userRes.rows[0]?.commenter_first_name,
      ).catch((e) => {
        console.error('Failed to send comment notification:', e);
      });

      return {
        ...res.rows[0],
        user_name: userRes.rows[0]?.user_name || 'You',
        user_avatar:
          userRes.rows[0]?.user_avatar ||
          `https://i.pravatar.cc/100?u=${userId}`,
        is_liked_by_me: false,
      };
    } catch (error: any) {
      console.error('❌ addComment error:', error.message, error.stack);
      throw error;
    }
  }

  private async sendCommentNotification(
    postId: string,
    commenterId: string,
    content: string,
    commenterName?: string,
  ) {
    const postOwner = await pool.query(
      `SELECT user_id, name FROM community_posts WHERE id = $1`,
      [postId],
    );
    const ownerId = postOwner.rows[0]?.user_id;
    const postName = postOwner.rows[0]?.name;
    if (ownerId && ownerId !== commenterId) {
      const title = postName
        ? `${commenterName || 'Someone'} commented on "${postName.slice(0, 30)}${postName.length > 30 ? '...' : ''}"`
        : `${commenterName || 'Someone'} commented`;
      this.notifications.sendPushToUser(ownerId, title, content, {
        type: 'comment',
        postId,
        category: 'message',
      });
      this.notifications.saveInboxItem({
        id: `comment-${postId}-${commenterId}-${Date.now()}`,
        user_id: ownerId,
        title,
        message: content,
        timestamp: new Date().toISOString(),
        category: 'message',
        data: { type: 'comment', postId, commenterId },
      });
    }
  }

  async deleteComment(commentId: string, userId: string) {
    const comment = await pool.query(
      'SELECT user_id, post_id FROM post_comments WHERE id = $1',
      [commentId],
    );
    if (comment.rows.length === 0) {
      throw new NotFoundException('Comment not found');
    }
    if (comment.rows[0].user_id !== userId) {
      throw new ForbiddenException('You can only delete your own comments');
    }

    const postId = comment.rows[0].post_id;

    await pool.query('DELETE FROM comment_likes WHERE comment_id = $1', [
      commentId,
    ]);
    await pool.query('DELETE FROM post_comments WHERE id = $1', [commentId]);

    await pool.query(
      `UPDATE community_posts
       SET comments_count = (SELECT COUNT(*) FROM post_comments WHERE post_id = $1)
       WHERE id = $1`,
      [postId],
    );

    return { message: 'Comment deleted' };
  }

  async likeComment(commentId: string, userId: string) {
    await pool.query(
      `INSERT INTO comment_likes (user_id, comment_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id, comment_id) DO NOTHING`,
      [userId, commentId],
    );

    await pool.query(
      `UPDATE post_comments
       SET likes_count = (SELECT COUNT(*) FROM comment_likes WHERE comment_id = $1)
       WHERE id = $1`,
      [commentId],
    );

    return { message: 'Comment liked' };
  }

  async unlikeComment(commentId: string, userId: string) {
    await pool.query(
      'DELETE FROM comment_likes WHERE user_id = $1 AND comment_id = $2',
      [userId, commentId],
    );

    await pool.query(
      `UPDATE post_comments
       SET likes_count = (SELECT COUNT(*) FROM comment_likes WHERE comment_id = $1)
       WHERE id = $1`,
      [commentId],
    );

    return { message: 'Comment unliked' };
  }

  // ==================== FOLLOWS ====================

  async followUser(followerId: string, followingId: string) {
    // console.log('📥 followUser called:', { followerId, followingId });
    if (!followerId || !followingId) {
      throw new ForbiddenException('User IDs are required');
    }
    if (followerId === followingId) {
      throw new ForbiddenException('You cannot follow yourself');
    }

    // Check if already following to avoid duplicate notifications
    const existing = await pool.query(
      `SELECT 1 FROM user_follows WHERE follower_id = $1 AND following_id = $2`,
      [followerId, followingId],
    );
    if (existing.rows.length > 0) {
      return { message: 'Already following' };
    }

    await pool.query(
      `INSERT INTO user_follows (follower_id, following_id)
       VALUES ($1, $2)
       ON CONFLICT (follower_id, following_id) DO NOTHING`,
      [followerId, followingId],
    );
    // console.log('✅ Follow saved to database');

    // Send push notification to the user being followed
    try {
      const followerInfo = await pool.query(
        `SELECT COALESCE(first_name, 'Someone') as follower_name, COALESCE(profile_picture, '') as follower_avatar FROM users WHERE id = $1`,
        [followerId],
      );
      const followerName = followerInfo.rows[0]?.follower_name || 'Someone';
      const followerAvatar = followerInfo.rows[0]?.follower_avatar || '';
      const title = 'New Follower';
      const message = `${followerName} started following you`;
      const notificationId = `follow-${followerId}-${followingId}-${Date.now()}`;
      const notificationData = {
        type: 'follow',
        senderId: followerId,
        senderName: followerName,
        senderAvatar: followerAvatar,
        category: 'message',
        notificationId, // Include ID so frontend uses the same ID
      };
      this.notifications.sendPushToUser(
        followingId,
        title,
        message,
        notificationData,
      );
      // Save to inbox for Community Messages section
      this.notifications.saveInboxItem({
        id: notificationId,
        user_id: followingId,
        title,
        message,
        timestamp: new Date().toISOString(),
        category: 'message',
        data: notificationData,
      });
    } catch (e) {
      console.error('Failed to send follow notification:', e);
    }

    return { message: 'User followed' };
  }

  async unfollowUser(followerId: string, followingId: string) {
    await pool.query(
      'DELETE FROM user_follows WHERE follower_id = $1 AND following_id = $2',
      [followerId, followingId],
    );

    return { message: 'User unfollowed' };
  }

  async isFollowing(followerId: string, followingId: string) {
    const res = await pool.query(
      'SELECT 1 FROM user_follows WHERE follower_id = $1 AND following_id = $2',
      [followerId, followingId],
    );
    return res.rows.length > 0;
  }

  // ==================== SAVES ====================

  async savePost(userId: string, postId: string) {
    await pool.query(
      `INSERT INTO saved_posts (user_id, post_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id, post_id) DO NOTHING`,
      [userId, postId],
    );

    // Emit POST_SAVED learning event (shadow mode - no behavior change)
    if (LEARNING_FLAGS.EVENTS_ENABLED) {
      pool
        .query(`SELECT tags FROM community_posts WHERE id = $1`, [postId])
        .then((res) => {
          const tags: string[] = res.rows[0]?.tags || [];
          this.learningEvents
            .logEvent({
              userId,
              eventType: 'POST_SAVED',
              entityType: 'post',
              entityId: postId,
              signalPolarity: 1,
              signalWeight: 0.5,
              extractedFeatures: { tags },
              sourceFeature: 'community',
              clientEventId: `post_saved:${userId}:${postId}`,
            })
            .catch(() => {});
        })
        .catch(() => {});
    }

    // Update user preference vector asynchronously (saves indicate strong interest)
    this.updateUserPreference(userId, postId).catch((err: any) => {
      console.error(
        `⚠️ Failed to update preference for user ${userId}:`,
        err.message,
      );
    });

    return { message: 'Post saved' };
  }

  async unsavePost(userId: string, postId: string) {
    await pool.query(
      'DELETE FROM saved_posts WHERE user_id = $1 AND post_id = $2',
      [userId, postId],
    );

    return { message: 'Post unsaved' };
  }

  async getSavedPosts(userId: string, limit: number = 20, offset: number = 0) {
    const res = await pool.query(
      `SELECT
        cp.id,
        cp.user_id,
        cp.image_url,
        cp.top_image,
        cp.bottom_image,
        cp.shoes_image,
        cp.accessory_image,
        cp.name,
        cp.description,
        cp.tags,
        cp.likes_count,
        cp.comments_count,
        cp.views_count,
        cp.is_demo,
        cp.created_at,
        COALESCE(u.first_name, 'StylHelpr') || ' ' || COALESCE(u.last_name, 'User') as user_name,
        COALESCE(u.profile_picture, 'https://i.pravatar.cc/100?u=' || cp.user_id) as user_avatar,
        EXISTS(SELECT 1 FROM post_likes WHERE post_id = cp.id AND user_id = $1) as is_liked_by_me,
        true as is_saved_by_me
      FROM community_posts cp
      LEFT JOIN users u ON cp.user_id = u.id
      INNER JOIN saved_posts sp ON cp.id = sp.post_id
      WHERE sp.user_id = $1
      ORDER BY sp.created_at DESC
      LIMIT $2 OFFSET $3`,
      [userId, limit, offset],
    );

    // Deduplicate by post ID (preserves original ordering)
    const seen = new Set<string>();
    return res.rows.filter((row: any) => {
      if (seen.has(row.id)) return false;
      seen.add(row.id);
      return true;
    });
  }

  async getPostsByUser(
    authorId: string,
    limit: number = 20,
    offset: number = 0,
  ) {
    const res = await pool.query(
      `SELECT
        cp.id,
        cp.user_id,
        cp.image_url,
        cp.top_image,
        cp.bottom_image,
        cp.shoes_image,
        cp.accessory_image,
        cp.name,
        cp.description,
        cp.tags,
        cp.likes_count,
        cp.comments_count,
        cp.views_count,
        cp.is_demo,
        cp.created_at,
        COALESCE(u.first_name, 'StylHelpr') || ' ' || COALESCE(u.last_name, 'User') as user_name,
        COALESCE(u.profile_picture, 'https://i.pravatar.cc/100?u=' || cp.user_id) as user_avatar
      FROM community_posts cp
      LEFT JOIN users u ON cp.user_id = u.id
      WHERE cp.user_id = $1
      ORDER BY cp.created_at DESC
      LIMIT $2 OFFSET $3`,
      [authorId, limit, offset],
    );
    return res.rows;
  }

  // ==================== BLOCK/MUTE ====================

  async blockUser(blockerId: string, blockedId: string) {
    if (blockerId === blockedId) {
      throw new ForbiddenException('You cannot block yourself');
    }

    await pool.query(
      `INSERT INTO blocked_users (blocker_id, blocked_id)
       VALUES ($1, $2)
       ON CONFLICT (blocker_id, blocked_id) DO NOTHING`,
      [blockerId, blockedId],
    );

    // Also unfollow them
    await pool.query(
      'DELETE FROM user_follows WHERE (follower_id = $1 AND following_id = $2) OR (follower_id = $2 AND following_id = $1)',
      [blockerId, blockedId],
    );

    return { message: 'User blocked' };
  }

  async unblockUser(blockerId: string, blockedId: string) {
    await pool.query(
      'DELETE FROM blocked_users WHERE blocker_id = $1 AND blocked_id = $2',
      [blockerId, blockedId],
    );

    return { message: 'User unblocked' };
  }

  async muteUser(muterId: string, mutedId: string) {
    if (muterId === mutedId) {
      throw new ForbiddenException('You cannot mute yourself');
    }

    await pool.query(
      `INSERT INTO muted_users (muter_id, muted_id)
       VALUES ($1, $2)
       ON CONFLICT (muter_id, muted_id) DO NOTHING`,
      [muterId, mutedId],
    );

    return { message: 'User muted' };
  }

  async unmuteUser(muterId: string, mutedId: string) {
    await pool.query(
      'DELETE FROM muted_users WHERE muter_id = $1 AND muted_id = $2',
      [muterId, mutedId],
    );

    return { message: 'User unmuted' };
  }

  // ==================== REPORTS ====================

  async reportPost(reporterId: string, postId: string, reason: string) {
    await pool.query(
      `INSERT INTO post_reports (reporter_id, post_id, reason)
       VALUES ($1, $2, $3)`,
      [reporterId, postId, reason],
    );

    return { message: 'Post reported' };
  }

  // ==================== VIEW TRACKING ====================

  async trackView(postId: string, userId: string) {
    // Insert only if not already viewed (dedupe by user)
    const result = await pool.query(
      `INSERT INTO post_views (post_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT (post_id, user_id) DO NOTHING
       RETURNING id`,
      [postId, userId],
    );

    // Only increment views_count if this is a new view
    if (result.rows.length > 0) {
      await pool.query(
        `UPDATE community_posts SET views_count = COALESCE(views_count, 0) + 1 WHERE id = $1`,
        [postId],
      );
    }

    return { message: 'View tracked' };
  }

  // ==================== USER SEARCH ====================

  /**
   * Search users by first_name, last_name, or combined name.
   * Supports prefix and partial (ILIKE) matching with stable ordering.
   * Returns paginated results with hasMore indicator.
   */
  async searchUsers(query: string, limit: number = 20, offset: number = 0) {
    if (!query || query.trim().length === 0) {
      return { users: [], hasMore: false };
    }

    const trimmedQuery = query.trim();
    const searchPattern = `%${trimmedQuery.toLowerCase()}%`;
    const prefixPattern = `${trimmedQuery.toLowerCase()}%`;

    // Fetch one extra to determine hasMore
    const fetchLimit = limit + 1;

    const res = await pool.query(
      `SELECT
        id,
        first_name,
        last_name,
        COALESCE(first_name, '') || ' ' || COALESCE(last_name, '') as display_name,
        profile_picture as profile_picture_url,
        bio
      FROM users
      WHERE
        LOWER(COALESCE(first_name, '')) LIKE $1
        OR LOWER(COALESCE(last_name, '')) LIKE $1
        OR LOWER(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')) LIKE $1
      ORDER BY
        CASE
          WHEN LOWER(COALESCE(first_name, '')) LIKE $2 THEN 0
          WHEN LOWER(COALESCE(last_name, '')) LIKE $2 THEN 1
          WHEN LOWER(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')) LIKE $2 THEN 2
          ELSE 3
        END,
        first_name ASC NULLS LAST,
        last_name ASC NULLS LAST
      LIMIT $3 OFFSET $4`,
      [searchPattern, prefixPattern, fetchLimit, offset],
    );

    const hasMore = res.rows.length > limit;
    const users = hasMore ? res.rows.slice(0, limit) : res.rows;

    return { users, hasMore };
  }

  // ==================== USER BIO ====================

  async updateBio(userId: string, bio: string, actorId: string) {
    // Ownership check
    if (userId !== actorId) {
      throw new ForbiddenException('You can only update your own bio');
    }

    await pool.query(`UPDATE users SET bio = $2 WHERE id = $1`, [userId, bio]);

    return { message: 'Bio updated' };
  }

  async getBio(userId: string) {
    const res = await pool.query(`SELECT bio FROM users WHERE id = $1`, [
      userId,
    ]);
    return { bio: res.rows[0]?.bio || null };
  }

  // ==================== USER PROFILE HELPERS ====================

  async getUserProfile(userId: string, currentUserId?: string) {
    const userRes = await pool.query(
      `SELECT
        id,
        COALESCE(first_name, 'StylHelpr') || ' ' || COALESCE(last_name, 'User') as user_name,
        profile_picture as user_avatar,
        bio,
        (SELECT COUNT(*) FROM user_follows uf JOIN users u ON u.id = uf.follower_id WHERE uf.following_id = $1) as followers_count,
        (SELECT COUNT(*) FROM user_follows uf JOIN users u ON u.id = uf.following_id WHERE uf.follower_id = $1) as following_count,
        (SELECT COUNT(*) FROM community_posts WHERE user_id = $1) as posts_count
      FROM users WHERE id = $1`,
      [userId],
    );

    if (userRes.rows.length === 0) {
      throw new NotFoundException('User not found');
    }

    const user = userRes.rows[0];

    if (currentUserId) {
      const isFollowing = await this.isFollowing(currentUserId, userId);
      const isBlocked = await pool.query(
        'SELECT 1 FROM blocked_users WHERE blocker_id = $1 AND blocked_id = $2',
        [currentUserId, userId],
      );
      const isMuted = await pool.query(
        'SELECT 1 FROM muted_users WHERE muter_id = $1 AND muted_id = $2',
        [currentUserId, userId],
      );

      return {
        ...user,
        is_following: isFollowing,
        is_blocked: isBlocked.rows.length > 0,
        is_muted: isMuted.rows.length > 0,
      };
    }

    return user;
  }

  // ==================== FOLLOWERS / FOLLOWING LISTS ====================

  async getFollowers(userId: string, currentUserId?: string) {
    const res = await pool.query(
      `SELECT
        u.id,
        COALESCE(u.first_name, 'StylHelpr') || ' ' || COALESCE(u.last_name, 'User') as user_name,
        u.profile_picture as user_avatar,
        u.bio,
        uf.created_at as followed_at
      FROM user_follows uf
      JOIN users u ON u.id = uf.follower_id
      WHERE uf.following_id = $1
      ORDER BY uf.created_at DESC`,
      [userId],
    );

    // If currentUserId provided, add is_following status for each user
    if (currentUserId) {
      const followingRes = await pool.query(
        `SELECT following_id FROM user_follows WHERE follower_id = $1`,
        [currentUserId],
      );
      const followingSet = new Set(
        followingRes.rows.map((r) => r.following_id),
      );

      return res.rows.map((user) => ({
        ...user,
        is_following: followingSet.has(user.id),
      }));
    }

    return res.rows;
  }

  async getFollowing(userId: string, currentUserId?: string) {
    const res = await pool.query(
      `SELECT
        u.id,
        COALESCE(u.first_name, 'StylHelpr') || ' ' || COALESCE(u.last_name, 'User') as user_name,
        u.profile_picture as user_avatar,
        u.bio,
        uf.created_at as followed_at
      FROM user_follows uf
      JOIN users u ON u.id = uf.following_id
      WHERE uf.follower_id = $1
      ORDER BY uf.created_at DESC`,
      [userId],
    );

    // If currentUserId provided, add is_following status for each user
    if (currentUserId) {
      const followingRes = await pool.query(
        `SELECT following_id FROM user_follows WHERE follower_id = $1`,
        [currentUserId],
      );
      const followingSet = new Set(
        followingRes.rows.map((r) => r.following_id),
      );

      return res.rows.map((user) => ({
        ...user,
        is_following: followingSet.has(user.id),
      }));
    }

    return res.rows;
  }

  // ==================== USER SUGGESTIONS ====================

  /**
   * Get suggested users to follow based on:
   * 1. Mutual connections (people followed by people you follow)
   * 2. Fallback: Popular users with most followers
   */
  async getSuggestedUsers(userId: string, limit: number = 10) {
    // First try: mutual connections
    const mutualRes = await pool.query(
      `SELECT
        u.id,
        COALESCE(u.first_name, 'StylHelpr') || ' ' || COALESCE(u.last_name, 'User') as user_name,
        u.profile_picture as user_avatar,
        u.bio,
        COUNT(DISTINCT f2.follower_id) as mutual_count,
        (SELECT COUNT(*) FROM user_follows WHERE following_id = u.id) as followers_count
      FROM user_follows f1
      JOIN user_follows f2 ON f1.following_id = f2.follower_id
      JOIN users u ON f2.following_id = u.id
      WHERE f1.follower_id = $1
        AND f2.following_id != $1
        AND f2.following_id NOT IN (SELECT following_id FROM user_follows WHERE follower_id = $1)
        AND f2.following_id NOT IN (SELECT blocked_id FROM blocked_users WHERE blocker_id = $1)
        AND f2.following_id NOT IN (SELECT muted_id FROM muted_users WHERE muter_id = $1)
      GROUP BY u.id, u.first_name, u.last_name, u.profile_picture, u.bio
      ORDER BY mutual_count DESC, followers_count DESC
      LIMIT $2`,
      [userId, limit],
    );

    const suggestions = mutualRes.rows;

    // If not enough suggestions, fill with popular users
    if (suggestions.length < limit) {
      const remaining = limit - suggestions.length;
      const existingIds = suggestions.map((s: any) => s.id);

      const popularRes = await pool.query(
        `SELECT
          u.id,
          COALESCE(u.first_name, 'StylHelpr') || ' ' || COALESCE(u.last_name, 'User') as user_name,
          u.profile_picture as user_avatar,
          u.bio,
          0 as mutual_count,
          (SELECT COUNT(*) FROM user_follows WHERE following_id = u.id) as followers_count
        FROM users u
        WHERE u.id != $1
          AND u.id NOT IN (SELECT following_id FROM user_follows WHERE follower_id = $1)
          AND u.id NOT IN (SELECT blocked_id FROM blocked_users WHERE blocker_id = $1)
          AND u.id NOT IN (SELECT muted_id FROM muted_users WHERE muter_id = $1)
          ${existingIds.length > 0 ? `AND u.id NOT IN (${existingIds.map((_, i) => `$${i + 3}`).join(',')})` : ''}
        ORDER BY (SELECT COUNT(*) FROM user_follows WHERE following_id = u.id) DESC
        LIMIT $2`,
        [userId, remaining, ...existingIds],
      );

      suggestions.push(...popularRes.rows);
    }

    return suggestions;
  }

  // ==================== GDPR DELETE ====================

  async deleteUserData(userId: string, actorId: string) {
    // Ownership check
    if (userId !== actorId) {
      throw new ForbiddenException('You can only delete your own data');
    }

    // Delete all community tracking/analytics data for user
    await pool.query('DELETE FROM post_views WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM post_likes WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM comment_likes WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM saved_posts WHERE user_id = $1', [userId]);
    await pool.query(
      'DELETE FROM user_follows WHERE follower_id = $1 OR following_id = $1',
      [userId],
    );
    await pool.query(
      'DELETE FROM blocked_users WHERE blocker_id = $1 OR blocked_id = $1',
      [userId],
    );
    await pool.query(
      'DELETE FROM muted_users WHERE muter_id = $1 OR muted_id = $1',
      [userId],
    );
    await pool.query('DELETE FROM post_reports WHERE reporter_id = $1', [
      userId,
    ]);
    await pool.query('DELETE FROM user_preference_vectors WHERE user_id = $1', [
      userId,
    ]);

    // Anonymize comments (keep for thread integrity)
    await pool.query(
      `UPDATE post_comments SET content = '[deleted]' WHERE user_id = $1`,
      [userId],
    );

    return { message: 'Community data deleted' };
  }
}
