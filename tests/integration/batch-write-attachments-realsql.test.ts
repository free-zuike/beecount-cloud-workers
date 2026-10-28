import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import batchWriteRouter from '../../src/routes/batch_write';
import { createRealDb, WRITE_PATH_TABLES } from '../helpers/realsql-db';

// 真实 SQLite 全链路验证批量创建的附件解析与排除标记（对齐原版 #133：
// transactions_batch.py 的 resolve_transaction_attachments + exclude_from_stats/budget）。
let sqlite: DatabaseSync;
let db: D1Database;
let app: Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>;

const ATTACHMENT_TABLE = `
  CREATE TABLE IF NOT EXISTS attachment_files (
    id TEXT PRIMARY KEY, ledger_id TEXT, user_id TEXT, sha256 TEXT, size_bytes INTEGER,
    mime_type TEXT, file_name TEXT, storage_path TEXT, attachment_kind TEXT, created_at TEXT
  );
`;

beforeEach(() => {
  const real = createRealDb();
  sqlite = real.sqlite;
  db = real.db;
  sqlite.exec(WRITE_PATH_TABLES);
  sqlite.exec(ATTACHMENT_TABLE);
  sqlite.prepare("INSERT INTO users (id, email, password_hash) VALUES ('user-1', 'b@x.com', 'x')").run();
  sqlite.prepare("INSERT INTO ledgers (id, user_id, external_id, name, currency) VALUES ('ledger-1', 'user-1', 'ledger-1', 'B', 'CNY')").run();
  sqlite.prepare("INSERT INTO devices (id, user_id, name, platform, created_at) VALUES ('dev-1', 'user-1', 't', 't', '2025-01-01T00:00:00Z')").run();
  sqlite.prepare(
    `INSERT INTO attachment_files (id, ledger_id, user_id, sha256, size_bytes, mime_type, file_name, storage_path, attachment_kind, created_at)
     VALUES ('file-1', 'ledger-1', 'user-1', 'sha-1', 123, 'image/png', 'a.png', 'beecount/x', 'transaction', '2025-01-01T00:00:00Z')`
  ).run();

  app = new Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>();
  app.use('*', async (c, next) => {
    c.set('userId', 'user-1');
    await next();
  });
  app.route('/api/v1/write', batchWriteRouter);
});

afterEach(() => sqlite.close());

async function batchPost(transactions: Record<string, unknown>[]) {
  const res = await app.request('/api/v1/write/transactions/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-ID': 'dev-1' },
    body: JSON.stringify({ ledger_id: 'ledger-1', device_id: 'dev-1', transactions }),
  }, { DB: db });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}

function changePayload(syncId: string): Record<string, unknown> {
  const row = sqlite.prepare('SELECT payload_json FROM sync_changes WHERE entity_sync_id = ?').get(syncId) as { payload_json: string };
  return JSON.parse(row.payload_json) as Record<string, unknown>;
}

describe('batchWriteRouter 附件解析与排除标记（真实 SQLite，对齐原版 #133）', () => {
  it('显式 attachments 按 cloudFileId 解析为权威引用，同步 payload 与投影一致', async () => {
    const { status, json } = await batchPost([{
      tx_type: 'expense', amount: 20, happened_at: '2025-01-15T10:00:00Z',
      attachments: [{ cloudFileId: 'file-1' }],
    }]);
    expect(status).toBe(200);
    const syncId = (json.created_sync_ids as string[])[0];

    const att = JSON.parse(
      (sqlite.prepare('SELECT attachments_json FROM read_tx_projection WHERE sync_id = ?').get(syncId) as { attachments_json: string }).attachments_json
    ) as Array<Record<string, unknown>>;
    expect(att).toHaveLength(1);
    expect(att[0].cloudFileId).toBe('file-1');
    expect(att[0].fileName).toBe('file-1_a.png');
    expect(att[0].originalName).toBe('a.png');
    expect(att[0].fileSize).toBe(123);
    expect(att[0].mimeType).toBe('image/png');
    expect(att[0].cloudSha256).toBe('sha-1');
    expect(att[0].sortOrder).toBe(0);
    // 同步事件同口径（设备增量拉取也拿到解析后的引用）
    expect(changePayload(syncId).attachments).toEqual(att);
  });

  it('未知/跨账本 fileId → 400 BATCH_TX_INVALID 并带 failed_index，整批不落库', async () => {
    const { status, json } = await batchPost([
      { tx_type: 'expense', amount: 1, happened_at: '2025-01-15T10:00:00Z' },
      { tx_type: 'expense', amount: 2, happened_at: '2025-01-15T10:00:00Z', attachments: [{ cloudFileId: 'ghost' }] },
    ]);
    expect(status).toBe(400);
    expect(json.error_code).toBe('BATCH_TX_INVALID');
    expect(json.failed_index).toBe(1);
    const count = sqlite.prepare("SELECT COUNT(*) AS c FROM sync_changes WHERE entity_type = 'transaction'").get() as { c: number };
    expect(count.c).toBe(0);
  });

  it('exclude_from_stats/budget 同时写入同步 payload 与投影', async () => {
    const { status, json } = await batchPost([{
      tx_type: 'expense', amount: 30, happened_at: '2025-01-15T10:00:00Z',
      exclude_from_stats: true, exclude_from_budget: true,
    }]);
    expect(status).toBe(200);
    const syncId = (json.created_sync_ids as string[])[0];
    expect(changePayload(syncId).excludeFromStats).toBe(true);
    expect(changePayload(syncId).excludeFromBudget).toBe(true);
    const row = sqlite.prepare('SELECT exclude_from_stats, exclude_from_budget FROM read_tx_projection WHERE sync_id = ?').get(syncId) as Record<string, number>;
    expect(row.exclude_from_stats).toBe(1);
    expect(row.exclude_from_budget).toBe(1);
  });
});
