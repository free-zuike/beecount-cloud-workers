import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import writeRouter from '../../src/routes/write';
import { createRealDb, WRITE_PATH_TABLES } from '../helpers/realsql-db';

// 真实 SQLite 验证 0758b41 等价（#101 category parent identity）：
// parent_sync_id 稳定关联、改名级联子分类、有子分类禁删/禁改 kind。
let sqlite: DatabaseSync;
let db: D1Database;
let app: Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>;

beforeEach(async () => {
  const real = createRealDb();
  sqlite = real.sqlite;
  db = real.db;
  sqlite.exec(WRITE_PATH_TABLES);
  await db.prepare('INSERT INTO ledgers (id, user_id, external_id, name, currency) VALUES (?, ?, ?, ?, ?)')
    .bind('ledger-1', 'user-1', 'ledger-1', 'L1', 'CNY').run();
  await db.prepare('INSERT INTO ledger_members (ledger_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
    .bind('ledger-1', 'user-1', 'owner', '2025-01-01T00:00:00Z').run();
  await db.prepare('INSERT INTO user_category_projection (sync_id, user_id, name, kind, level) VALUES (?, ?, ?, ?, ?)')
    .bind('cat-food', 'user-1', '餐饮', 'expense', 1).run();
  await db.prepare('INSERT INTO user_category_projection (sync_id, user_id, name, kind, level) VALUES (?, ?, ?, ?, ?)')
    .bind('cat-income-food', 'user-1', '餐饮', 'income', 1).run();

  app = new Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>();
  app.use('*', async (c, next) => {
    c.set('userId', 'user-1');
    await next();
  });
  app.route('/api/v1/write', writeRouter);
});

afterEach(() => sqlite.close());

function catRow(syncId: string): Record<string, unknown> {
  return sqlite.prepare(
    'SELECT name, kind, level, parent_name, parent_sync_id FROM user_category_projection WHERE sync_id = ?'
  ).get(syncId) as Record<string, unknown>;
}

describe('分类父级稳定关联（真实 SQLite，0758b41 等价）', () => {
  it('创建子分类按 parent_name 唯一解析父级（同 kind 顶级），歧义时不猜', async () => {
    const res = await app.request('/api/v1/write/ledgers/ledger-1/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '早餐', kind: 'expense', parent_name: '餐饮' }),
    }, { DB: db });
    expect(res.status).toBe(200);
    const body = await res.json() as { entity_id: string };
    expect(catRow(body.entity_id)).toMatchObject({ level: 2, parent_name: '餐饮', parent_sync_id: 'cat-food' });
  });

  it('多个同名不同 kind 的父分类时按 kind 唯一命中', async () => {
    const res = await app.request('/api/v1/write/ledgers/ledger-1/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '工资', kind: 'income', parent_name: '餐饮' }),
    }, { DB: db });
    expect(res.status).toBe(200);
    const body = await res.json() as { entity_id: string };
    expect(catRow(body.entity_id)).toMatchObject({ parent_sync_id: 'cat-income-food' });
  });

  it('父分类改名级联子分类 parent_name 与历史交易投影', async () => {
    const child = await app.request('/api/v1/write/ledgers/ledger-1/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '早餐', kind: 'expense', parent_name: '餐饮' }),
    }, { DB: db });
    const childId = (await child.json() as { entity_id: string }).entity_id;
    await db.prepare(
      "INSERT INTO read_tx_projection (ledger_id, sync_id, user_id, tx_type, amount, happened_at, category_sync_id, category_name, category_kind) VALUES ('ledger-1', 'tx-1', 'user-1', 'expense', 10, '2025-01-01T00:00:00Z', 'cat-food', '餐饮', 'expense')"
    ).run();

    const rename = await app.request('/api/v1/write/ledgers/ledger-1/categories/cat-food', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '伙食' }),
    }, { DB: db });
    expect(rename.status).toBe(200);

    expect(catRow(childId)).toMatchObject({ parent_name: '伙食', parent_sync_id: 'cat-food' });
    const tx = sqlite.prepare("SELECT category_name FROM read_tx_projection WHERE sync_id = 'tx-1'").get() as { category_name: string };
    expect(tx.category_name).toBe('伙食');
  });

  it('有子分类时禁删与禁改 kind', async () => {
    await app.request('/api/v1/write/ledgers/ledger-1/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '早餐', kind: 'expense', parent_name: '餐饮' }),
    }, { DB: db });

    const del = await app.request('/api/v1/write/ledgers/ledger-1/categories/cat-food', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }, { DB: db });
    expect(del.status).toBe(409);

    const kindChange = await app.request('/api/v1/write/ledgers/ledger-1/categories/cat-food', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'income' }),
    }, { DB: db });
    expect(kindChange.status).toBe(409);
  });
});