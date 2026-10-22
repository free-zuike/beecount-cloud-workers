import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { createRealDb } from './helpers/realsql-db';
import batchWriteRouter from '../src/routes/batch_write';

// 移植上游 tests/test_tx_batch_delete.py(按本地真实行为断言):
// deleted_tx_ids 契约已修复(batch_write.ts: deleteIndices 按投影存在性区分
// deleted / not_found),伪造 ID 不落变更;同 Idempotency-Key 重放 → replay 原响应。
let sqlite: DatabaseSync;
let db: D1Database;
let app: Hono<{ Bindings: any; Variables: { userId: string } }>;

const USER = 'user-1';

const TABLES = `
  CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL);
  CREATE TABLE ledgers (id TEXT PRIMARY KEY, user_id TEXT, external_id TEXT, name TEXT, currency TEXT);
  CREATE TABLE ledger_members (ledger_id TEXT, user_id TEXT, role TEXT, PRIMARY KEY (ledger_id, user_id));
  CREATE TABLE sync_changes (
    change_id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, ledger_id TEXT, entity_type TEXT,
    entity_sync_id TEXT, action TEXT, payload_json TEXT, updated_at TEXT,
    updated_by_user_id TEXT, updated_by_device_id TEXT, scope TEXT
  );
  CREATE TABLE read_tx_projection (
    ledger_id TEXT, sync_id TEXT, user_id TEXT, tx_type TEXT, amount REAL DEFAULT 0,
    happened_at TEXT, note TEXT, PRIMARY KEY (ledger_id, sync_id)
  );
  CREATE TABLE audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, ledger_id TEXT, action TEXT, metadata_json TEXT, created_at TEXT);
  CREATE TABLE sync_push_idempotency (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, device_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, response_json TEXT NOT NULL,
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
    UNIQUE(user_id, device_id, idempotency_key)
  );
`;

function seedLedger(internalId: string, externalId: string) {
  sqlite.prepare("INSERT INTO ledgers (id, user_id, external_id, name, currency) VALUES (?, ?, ?, ?, 'CNY')").run(internalId, USER, externalId, externalId);
  sqlite.prepare("INSERT INTO ledger_members (ledger_id, user_id, role) VALUES (?, ?, 'owner')").run(internalId, USER);
}

function seedTx(ledgerInternal: string, syncId: string, amount: number) {
  sqlite.prepare(`INSERT INTO read_tx_projection (ledger_id, sync_id, user_id, tx_type, amount, happened_at)
    VALUES (?, ?, ?, 'expense', ?, '2026-05-01T00:00:00Z')`).run(ledgerInternal, syncId, USER, amount);
  sqlite.prepare(`INSERT INTO sync_changes (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id, scope)
    VALUES (?, ?, 'transaction', ?, 'upsert', '{}', '2026-05-01T00:00:00Z', ?, 'ledger')`).run(USER, ledgerInternal, syncId, USER);
}

beforeEach(() => {
  const real = createRealDb();
  sqlite = real.sqlite;
  db = real.db;
  sqlite.exec(TABLES);
  sqlite.prepare("INSERT INTO users (id, email, password_hash) VALUES (?, 'bd@x.com', 'x')").run(USER);

  app = new Hono<{ Bindings: any; Variables: { userId: string } }>();
  app.use('*', async (c, next) => {
    c.set('userId', USER);
    await next();
  });
  app.route('/api/v1/write', batchWriteRouter);
});

afterEach(() => sqlite.close());

async function batchDelete(ledgerExt: string, txIds: string[], opts: { idempotencyKey?: string } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  return app.request(`/api/v1/write/ledgers/${ledgerExt}/transactions/batch/delete`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ tx_ids: txIds, base_change_id: 0 }),
  }, { DB: db } as any);
}

function projectionCount(ledgerInternal: string, syncIds: string[]): number {
  const rows = sqlite.prepare(`SELECT COUNT(*) AS c FROM read_tx_projection WHERE ledger_id = ? AND sync_id IN (${syncIds.map(() => '?').join(',')})`)
    .all(ledgerInternal, ...syncIds) as unknown as { c: number }[];
  return rows[0]?.c ?? 0;
}

function deleteChangeCount(syncIds: string[]): number {
  const rows = sqlite.prepare(`SELECT COUNT(*) AS c FROM sync_changes WHERE entity_type = 'transaction' AND action = 'delete' AND entity_sync_id IN (${syncIds.map(() => '?').join(',')})`)
    .all(...syncIds) as unknown as { c: number }[];
  return rows[0]?.c ?? 0;
}

describe('批量删除交易(移植上游 test_tx_batch_delete.py)', () => {
  it('happy path:deleted_tx_ids 全返,投影行删除 + 3 条 delete 变更', async () => {
    seedLedger('lg1', 'L1');
    for (const tx of ['tx-a', 'tx-b', 'tx-c']) seedTx('lg1', tx, 10);

    const res = await batchDelete('L1', ['tx-a', 'tx-b', 'tx-c']);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect((body.deleted_tx_ids as string[]).sort()).toEqual(['tx-a', 'tx-b', 'tx-c']);
    expect(body.failed).toEqual([]);
    expect(body.new_change_id).toBeGreaterThan(0);

    expect(projectionCount('lg1', ['tx-a', 'tx-b', 'tx-c'])).toBe(0);
    expect(deleteChangeCount(['tx-a', 'tx-b', 'tx-c'])).toBe(3);
  });

  it('混伪造 ID:真实 ID 删除,failed 含 not_found,伪造 ID 不落变更', async () => {
    seedLedger('lg1', 'L1');
    seedTx('lg1', 'tx-real-1', 10);
    seedTx('lg1', 'tx-real-2', 20);
    const fakeIds = ['tx_missing_1', 'tx_missing_2'];

    const res = await batchDelete('L1', ['tx-real-1', 'tx-real-2', ...fakeIds]);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect((body.deleted_tx_ids as string[]).sort()).toEqual(['tx-real-1', 'tx-real-2']);
    expect(body.failed).toHaveLength(2);
    for (const f of body.failed) {
      expect(f.reason).toBe('not_found');
      expect(fakeIds).toContain((f as { tx_id: string }).tx_id);
    }

    expect(projectionCount('lg1', ['tx-real-1', 'tx-real-2'])).toBe(0);
    expect(deleteChangeCount(['tx-real-1', 'tx-real-2'])).toBe(2); // 伪造 ID 不写变更
  });

  it('跨 ledger:从 A 提交 B 的 ids → 全部 not_found,B 数据完好', async () => {
    seedLedger('lg-a', 'A');
    seedLedger('lg-b', 'B');
    seedTx('lg-b', 'b-1', 5);
    seedTx('lg-b', 'b-2', 6);

    const res = await batchDelete('A', ['b-1', 'b-2']);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.deleted_tx_ids).toEqual([]);
    expect(body.failed).toHaveLength(2);
    expect(body.failed.every((f: any) => f.reason === 'not_found')).toBe(true);

    expect(projectionCount('lg-b', ['b-1', 'b-2'])).toBe(2);
  });

  it('超过 200 条 → 400(本地 zValidator;上游 422)', async () => {
    seedLedger('lg1', 'L1');
    const tooMany = Array.from({ length: 201 }, (_, i) => `tx_${i}`);
    const res = await batchDelete('L1', tooMany);
    expect(res.status).toBe(400);
  });

  it('同 Idempotency-Key 重放 → replay 第一份响应,不重复删、change_id 不前进(对齐上游 test_batch_delete_idempotency_replay)', async () => {
    seedLedger('lg1', 'L1');
    seedTx('lg1', 'tx-i1', 10);
    seedTx('lg1', 'tx-i2', 20);
    const idemKey = 'test-idem-1';

    const r1 = await batchDelete('L1', ['tx-i1', 'tx-i2'], { idempotencyKey: idemKey });
    expect(r1.status).toBe(200);
    const b1 = await r1.json() as any;
    expect((b1.deleted_tx_ids as string[]).sort()).toEqual(['tx-i1', 'tx-i2']);
    expect(b1.idempotency_replayed).toBe(false);
    const firstChangeId = b1.new_change_id as number;
    expect(firstChangeId).toBeGreaterThan(0);
    expect(projectionCount('lg1', ['tx-i1', 'tx-i2'])).toBe(0);

    // 重发同 key → replay 原响应(new_change_id 相同),不再执行删除
    const r2 = await batchDelete('L1', ['tx-i1', 'tx-i2'], { idempotencyKey: idemKey });
    expect(r2.status).toBe(200);
    const b2 = await r2.json() as any;
    expect(b2.new_change_id).toBe(firstChangeId);
    expect(b2.idempotency_replayed).toBe(true);
    expect((b2.deleted_tx_ids as string[]).sort()).toEqual(['tx-i1', 'tx-i2']);
    expect(deleteChangeCount(['tx-i1', 'tx-i2'])).toBe(2); // 不重复写变更
  });
});