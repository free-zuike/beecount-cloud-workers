import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { createRealDb, WRITE_PATH_TABLES } from './helpers/realsql-db';
import writeRouter from '../src/routes/write';
import batchWriteRouter from '../src/routes/batch_write';
import syncRouter from '../src/routes/sync';
import readRouter from '../src/routes/read';

// 移植上游 tests/test_issue31_write_perf.py:
// A1b 单笔 create fast-path 读回 + pull 可拉 upsert change;
// A3 batch 端点 50 笔一次 commit(created_sync_ids/new_change_id);
// 批量 tag 实体:batch 路径按名字物化 tag(对齐上游「MCP tag 实体建出来了」)
let sqlite: DatabaseSync;
let db: D1Database;
let app: Hono<{ Bindings: any; Variables: { userId: string } }>;

const USER = 'user-1';

beforeEach(() => {
  const real = createRealDb();
  sqlite = real.sqlite;
  db = real.db;
  sqlite.exec(WRITE_PATH_TABLES);
  sqlite.exec(`CREATE TABLE IF NOT EXISTS sync_cursors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    ledger_external_id TEXT NOT NULL,
    last_cursor INTEGER DEFAULT 0 NOT NULL,
    updated_at TEXT,
    UNIQUE(user_id, device_id, ledger_external_id)
  )`);
  sqlite.prepare("INSERT INTO users (id, email, password_hash) VALUES (?, 'perf@x.com', 'x')").run(USER);
  sqlite.prepare("INSERT INTO devices (id, user_id, name, platform, created_at) VALUES ('dev-1', ?, 'dev', 'web', '2026-01-01T00:00:00Z')").run(USER);
  sqlite.prepare("INSERT INTO ledgers (id, user_id, external_id, name, currency) VALUES ('lg1', ?, 'L1', '账本', 'CNY')").run(USER);
  sqlite.prepare("INSERT INTO ledger_members (ledger_id, user_id, role, joined_at) VALUES ('lg1', ?, 'owner', '2026-01-01T00:00:00Z')").run(USER);

  app = new Hono<{ Bindings: any; Variables: { userId: string } }>();
  app.use('*', async (c, next) => {
    c.set('userId', USER);
    await next();
  });
  app.route('/api/v1/write', writeRouter);
  app.route('/api/v1/write', batchWriteRouter);
  app.route('/api/v1/sync', syncRouter);
  app.route('/api/v1/read', readRouter);
});

afterEach(() => sqlite.close());

describe('issue31 写入性能路径(移植上游 test_issue31_write_perf.py)', () => {
  it('A1b: 单笔 create fast-path 读回字段正确', async () => {
    const create = await app.request('/api/v1/write/ledgers/L1/transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_change_id: 0, tx_type: 'expense', amount: 12.5, happened_at: '2026-05-01T00:00:00Z', note: 'coffee' }),
    }, { DB: db } as any);
    expect(create.status).toBe(200);
    const syncId = (await create.json() as any).entity_id as string;
    expect(syncId).toBeTruthy();

    const read = await app.request('/api/v1/read/ledgers/L1/transactions', {}, { DB: db } as any);
    expect(read.status).toBe(200);
    const body = await read.json() as any;
    const items = Array.isArray(body) ? body : body.items;
    const row = items.find((it: any) => it.id === syncId);
    expect(row).toBeDefined();
    expect(row.amount).toBe(12.5);
    expect(row.note).toBe('coffee');
    expect(row.tx_type).toBe('expense');
  });

  it('A1b: fast-path 产出可增量 pull 的 transaction upsert change', async () => {
    const create = await app.request('/api/v1/write/ledgers/L1/transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-ID': 'dev-1' },
      body: JSON.stringify({ base_change_id: 0, tx_type: 'income', amount: 9, happened_at: '2026-05-02T00:00:00Z' }),
    }, { DB: db } as any);
    expect(create.status).toBe(200);
    const syncId = (await create.json() as any).entity_id as string;

    const pull = await app.request('/api/v1/sync/pull?since=0&limit=500&device_id=dev-1', {
      headers: { 'X-Device-ID': 'dev-1' },
    }, { DB: db } as any);
    expect(pull.status).toBe(200);
    const pullBody = await pull.json() as { changes: Array<{ entity_type: string; entity_sync_id: string; action: string }> };
    const txChanges = pullBody.changes.filter(c =>
      c.entity_type === 'transaction' && c.entity_sync_id === syncId && c.action === 'upsert');
    expect(txChanges.length).toBe(1);
  });

  it('A3: batch 端点 50 笔一次 commit', async () => {
    const txns = Array.from({ length: 50 }, (_, i) => ({
      tx_type: 'expense', amount: 1 + i, happened_at: '2026-05-01T00:00:00Z', tags: ['MCP'],
    }));
    const batch = await app.request('/api/v1/write/ledgers/L1/transactions/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-ID': 'dev-1' },
      body: JSON.stringify({ base_change_id: 0, transactions: txns, auto_ai_tag: false }),
    }, { DB: db } as any);
    expect(batch.status).toBe(200);
    const body = await batch.json() as { created_sync_ids: string[]; new_change_id: number };
    expect(body.created_sync_ids.length).toBe(50);
    expect(body.new_change_id).toBeGreaterThan(0);

    const read = await app.request('/api/v1/read/ledgers/L1/transactions?limit=200', {}, { DB: db } as any);
    expect(read.status).toBe(200);
    const readBody = await read.json() as any;
    const items = Array.isArray(readBody) ? readBody : readBody.items;
    expect(items.length).toBe(50);

    // tag 实体:batch 路径按名字物化 tag(对齐上游「MCP tag 实体建出来了」)
    const tagRows = sqlite.prepare("SELECT name FROM user_tag_projection WHERE user_id = ?").all(USER) as { name: string }[];
    expect(tagRows.some(t => t.name === 'MCP')).toBe(true);
  });
});