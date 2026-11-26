import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import moveRouter from '../../src/routes/transactions_move';
import syncRouter from '../../src/routes/sync';
import { createRealDb, WRITE_PATH_TABLES } from '../helpers/realsql-db';

/**
 * 对齐上游 1.10.x push.py：已被跨账本移动（retirement）的源交易，
 * 迟到 upsert 必须被拒绝并从冲突样本里报告 transaction_moved；
 * 且「全部拒绝都来自移动冲突」不得计入 device_sync_failures。
 */

let sqlite: DatabaseSync;
let db: D1Database;
let app: Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>;

const EXTRA_TABLES = `
  CREATE TABLE attachment_files (
    id TEXT PRIMARY KEY, ledger_id TEXT, user_id TEXT, sha256 TEXT, size_bytes INTEGER,
    mime_type TEXT, file_name TEXT, storage_path TEXT, attachment_kind TEXT, created_at TEXT
  );
  CREATE TABLE transaction_move_receipts (
    user_id TEXT NOT NULL, operation_id TEXT NOT NULL, request_hash TEXT NOT NULL,
    result_json TEXT NOT NULL, PRIMARY KEY (user_id, operation_id)
  );
  CREATE TABLE transaction_move_retirements (
    ledger_id TEXT NOT NULL, sync_id TEXT NOT NULL, PRIMARY KEY (ledger_id, sync_id)
  );
  CREATE TABLE device_sync_failures (
    device_id TEXT NOT NULL, direction TEXT NOT NULL, incident_id TEXT NOT NULL,
    failure_count INTEGER NOT NULL, reason TEXT NOT NULL, first_failed_at TEXT NOT NULL,
    last_failed_at TEXT NOT NULL, PRIMARY KEY (device_id, direction)
  );
`;

beforeEach(() => {
  const real = createRealDb();
  sqlite = real.sqlite;
  db = real.db;
  sqlite.exec(WRITE_PATH_TABLES);
  sqlite.exec(EXTRA_TABLES);
  sqlite.prepare("INSERT INTO users (id, email, password_hash) VALUES ('user-1', 's@example.com', 'x')").run();
  sqlite.prepare("INSERT INTO ledgers (id, user_id, external_id, name, currency) VALUES ('la', 'user-1', 'A', '账本A', 'CNY')").run();
  sqlite.prepare("INSERT INTO ledgers (id, user_id, external_id, name, currency) VALUES ('lb', 'user-1', 'B', '账本B', 'CNY')").run();
  sqlite.prepare("INSERT INTO ledger_members (ledger_id, user_id, role, joined_at) VALUES ('la', 'user-1', 'owner', '2025-01-01T00:00:00Z')").run();
  sqlite.prepare("INSERT INTO ledger_members (ledger_id, user_id, role, joined_at) VALUES ('lb', 'user-1', 'owner', '2025-01-01T00:00:00Z')").run();
  sqlite.prepare("INSERT INTO devices (id, user_id, name, platform, revoked_at, created_at) VALUES ('dev-1', 'user-1', 't', 't', NULL, '2025-01-01T00:00:00Z')").run();

  app = new Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>();
  app.use('*', async (c, next) => {
    c.set('userId', 'user-1');
    await next();
  });
  app.route('/api/v1/write', moveRouter);
  app.route('/api/v1/sync', syncRouter as any);
});

afterEach(() => sqlite.close());

describe('sync push 拒绝已移动交易的迟到 upsert（真实 SQLite，对齐上游 1.10.x）', () => {
  it('retirement 命中 → conflict_sample=transaction_moved 且不计入同步健康失败', async () => {
    // 直接构造「已移动」终态：源账本 retirement + tombstone
    const changeId = Number(
      (sqlite
        .prepare(
          `INSERT INTO sync_changes
           (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at,
            updated_by_user_id, updated_by_device_id, scope)
           VALUES ('user-1', 'la', 'transaction', 'tx-old', 'delete', '{}', '2025-01-15T10:00:00Z',
                   'user-1', 'server-transaction-move', 'ledger')`
        )
        .run()
        .lastInsertRowid ?? 0)
    );
    sqlite.prepare("INSERT INTO transaction_move_retirements (ledger_id, sync_id) VALUES ('la', 'tx-old')").run();

    const res = await app.request(
      '/api/v1/sync/push',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device_id: 'dev-1',
          changes: [
            {
              entity_type: 'transaction',
              ledger_id: 'A',
              entity_sync_id: 'tx-old',
              action: 'upsert',
              payload: {
                syncId: 'tx-old', type: 'expense', amount: 5,
                happenedAt: '2025-01-15T10:00:00Z', note: 'stale',
              },
              updated_at: new Date(Date.now() + 60_000).toISOString(),
            },
          ],
        }),
      },
      { DB: db }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.accepted).toBe(0);
    expect(body.rejected).toBe(1);
    expect(body.conflict_count).toBe(1);
    expect(body.conflict_samples?.[0]?.reason).toBe('transaction_moved');

    // 全部拒绝都来自移动冲突 → 不记同步失败
    const failures = sqlite.prepare('SELECT COUNT(*) c FROM device_sync_failures').get() as { c: number };
    expect(failures.c).toBe(0);

    // 迟到的 upsert 不得落库/复活投影
    const upserts = sqlite.prepare("SELECT COUNT(*) c FROM sync_changes WHERE entity_sync_id = 'tx-old' AND action = 'upsert'").get() as { c: number };
    expect(upserts.c).toBe(0);
    expect(sqlite.prepare("SELECT COUNT(*) c FROM read_tx_projection WHERE sync_id = 'tx-old'").get()).toMatchObject({ c: 0 });
    expect(changeId).toBeGreaterThan(0);
  });
});
