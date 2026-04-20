/**
 * Regression test: updateItem() builds dynamic UPDATE SQL from Object.entries(dto).
 * The ALLOWED_UPDATE_KEYS allowlist must block ANY unknown key from reaching SQL.
 *
 * Root cause: UpdateWardrobeItemDto is a TS type alias (not a class), so
 * NestJS whitelist:true cannot strip unknown keys. Any extra key the frontend
 * sends (e.g. "category") becomes SET category = $N → Postgres crash.
 */

jest.mock('../db/pool', () => ({
  pool: {
    query: jest
      .fn()
      .mockResolvedValue({ rows: [{ id: 'item-1' }], rowCount: 1 }),
  },
}));

jest.mock('../pinecone/pinecone-upsert', () => ({
  upsertItemNs: jest.fn(),
  deleteItemNs: jest.fn(),
}));
jest.mock('../pinecone/pinecone-query', () => ({
  queryUserNs: jest.fn(),
  hybridQueryUserNs: jest.fn(),
}));
jest.mock('../config/secrets', () => ({
  getSecret: jest.fn().mockReturnValue('fake'),
  secretExists: jest.fn().mockReturnValue(false),
}));
jest.mock('../utils/redisClient', () => ({
  getRedisClient: jest.fn().mockReturnValue(null),
}));

import { pool } from '../db/pool';

describe('updateItem — ALLOWED_UPDATE_KEYS allowlist', () => {
  let service: any;

  beforeAll(async () => {
    const mod = await import('./wardrobe.service');
    service = new (mod.WardrobeService as any)(null, null, null);
  });

  beforeEach(() => {
    (pool.query as jest.Mock).mockClear();
    (pool.query as jest.Mock).mockResolvedValue({
      rows: [{ id: 'item-1', main_category: 'Tops' }],
      rowCount: 1,
    });
  });

  // Case 1: { category: 'Tops', main_category: 'Tops' }
  // SQL must NOT include category =, MUST include main_category =
  it('blocks "category" but passes "main_category"', async () => {
    try {
      await service.updateItem('item-1', 'user-1', {
        category: 'Tops',
        main_category: 'Tops',
      } as any);
    } catch {
      // expected — vertex is null downstream
    }

    const sql: string = (pool.query as jest.Mock).mock.calls[0][0];
    expect(sql).not.toMatch(/\bcategory\s*=/);
    expect(sql).toMatch(/\bmain_category\s*=/);
  });

  // Case 2: { __proto__: 'x', randomField: 'y', color: 'black' }
  // SQL must NOT include randomField, MUST include color
  it('blocks arbitrary unknown keys but passes valid columns', async () => {
    try {
      await service.updateItem('item-1', 'user-1', {
        randomField: 'y',
        color: 'black',
      } as any);
    } catch {
      // expected — vertex is null downstream
    }

    const sql: string = (pool.query as jest.Mock).mock.calls[0][0];
    expect(sql).not.toMatch(/\brandomField\s*=/);
    expect(sql).toMatch(/\bcolor\s*=/);
  });

  // Case 3: dto with ONLY unknown keys → throws 'No fields provided'
  it('throws when dto contains only unknown keys', async () => {
    await expect(
      service.updateItem('item-1', 'user-1', {
        category: 'Tops',
        randomField: 'y',
        __proto__: 'x',
      } as any),
    ).rejects.toThrow('No fields provided for update.');
  });
});
