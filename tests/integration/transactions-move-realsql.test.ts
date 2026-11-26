import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import moveRouter from '../../src/routes/transactions_move';
import { createRealDb, WRITE_PATH_TABLES } from '../helpers/realsql-db';

/**
 * 跨账本移动（对齐上游 1.10.x transactions_move.py）真实 SQLite 全链路验证：
 * prepare 契约、原子移动、幂等回执重放、MOVE_* 错误码、retirement 落库。
 */

let sqlite: DatabaseSync;
let db: D1Database;
let app: Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>;

const MOVE_TABLES = `
  CREATE TABLE attachment_files (
    id TEXT PRIMARY KEY, ledger_id TEXT, user_id TEXT, sha256 TEXT, size_bytes INTEGER,
    mime_type TEXT, file_name TEXT, storage_path TEXT, attachment_kind TEXT, created_at TEXT
  );
  CREATE TABLE transaction_move_receipts (
    user_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    result_json TEXT NOT NULL,
    PRIMARY KEY (user_id, operation_id)
  );
  CREATE TABLE transaction_move_retirements (
    ledger_id TEXT NOT NULL,
    sync_id TEXT NOT NULL,
    PRIMARY KEY (ledger_id, sync_id)
  );
`;

const SOURCE_SYNC_ID = 'tx-source-1';

function projectTx(ledgerInternalId: string, syncId: string, changeId: number, note = '午餐') {
  sqlite
    .prepare(
      `INSERT INTO read_tx_projection
       (ledger_id, sync_id, user_id, tx_type, amount, happened_at, note,
        tags_csv, tag_sync_ids_json, attachments_json, tx_index, source_change_id,
        exclude_from_stats, exclude_from_budget, created_by_user_id, last_edited_by_user_id)
       VALUES (?, ?, 'user-1', 'expense', 12.5, '2025-01-15T10:00:00Z', ?,
               'tagA', '["tag-1"]', '[]', 1, ?,
               0, 0, 'user-1', 'user-1')`
    )
    .run(ledgerInternalId, syncId, note, changeId);
}

function seedSourceEvent(syncId: string, ledgerInternalId: string): number {
  sqlite
    .prepare(
      `INSERT INTO sync_changes
       (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at,
        updated_by_user_id, updated_by_device_id, scope)
       VALUES ('user-1', ?, 'transaction', ?, 'upsert', '{}', '2025-01-15T10:00:00Z',
               'user-1', 'dev-1', 'ledger')`
    )
    .run(ledgerInternalId, syncId);
  return Number((sqlite.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id);
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await app.request(
    `/api/v1/write${path}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-ID': 'dev-1', ...headers },
      body: JSON.stringify(body),
    },
    { DB: db }
  );
  return { status: res.status, json: (await res.json()) as any };
}

beforeEach(() => {
  const real = createRealDb();
  sqlite = real.sqlite;
  db = real.db;
  sqlite.exec(WRITE_PATH_TABLES);
  sqlite.exec(MOVE_TABLES);
  sqlite.prepare("INSERT INTO users (id, email, password_hash) VALUES ('user-1', 'm@example.com', 'x')").run();
  sqlite.prepare("INSERT INTO users (id, email, password_hash) VALUES ('user-2', 'o@example.com', 'x')").run();
  // 私有账本 A / B（CNY）、USD 账本、带其他成员的共享账本
  sqlite.prepare("INSERT INTO ledgers (id, user_id, external_id, name, currency) VALUES ('la', 'user-1', 'A', '账本A', 'CNY')").run();
  sqlite.prepare("INSERT INTO ledgers (id, user_id, external_id, name, currency) VALUES ('lb', 'user-1', 'B', '账本B', 'CNY')").run();
  sqlite.prepare("INSERT INTO ledgers (id, user_id, external_id, name, currency) VALUES ('lu', 'user-1', 'U', '美元账本', 'USD')").run();
  sqlite.prepare("INSERT INTO ledgers (id, user_id, external_id, name, currency) VALUES ('ls', 'user-1', 'S', '共享账本', 'CNY')").run();
  for (const [lid, uid] of [
    ['la', 'user-1'], ['lb', 'user-1'], ['lu', 'user-1'], ['ls', 'user-1'], ['ls', 'user-2'],
  ]) {
    sqlite.prepare("INSERT INTO ledger_members (ledger_id, user_id, role, joined_at) VALUES (?, ?, 'owner', '2025-01-01T00:00:00Z')").run(lid, uid);
  }
  sqlite.prepare("INSERT INTO devices (id, user_id, name, platform, revoked_at, created_at) VALUES ('dev-1', 'user-1', 't', 't', NULL, '2025-01-01T00:00:00Z')").run();
  const changeId = seedSourceEvent(SOURCE_SYNC_ID, 'la');
  projectTx('la', SOURCE_SYNC_ID, changeId);

  app = new Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>();
  app.use('*', async (c, next) => {
    c.set('userId', 'user-1');
    await next();
  });
  app.route('/api/v1/write', moveRouter);
});

afterEach(() => sqlite.close());

describe('跨账本移动（真实 SQLite，对齐上游 1.10.x）', () => {
  it('prepare 返回交易当前 payload 与 revision', async () => {
    const { status, json } = await post('/ledgers/A/transactions/batch/move/prepare', {
      target_ledger_id: 'B',
      transaction_ids: [SOURCE_SYNC_ID],
    });
    expect(status).toBe(200);
    expect(json).toHaveLength(1);
    expect(json[0].sync_id).toBe(SOURCE_SYNC_ID);
    expect(json[0].revision).toBeGreaterThan(0);
    expect(json[0].transaction.amount).toBe(12.5);
    expect(json[0].transaction.note).toBe('午餐');
    expect(json[0].transaction.tagIds).toEqual(['tag-1']);
  });

  it('move 原子移动：目标 upsert + 源 tombstone + retirement + 回执，重复请求重放', async () => {
    const operationId = crypto.randomUUID();
    const body = { target_ledger_id: 'B', items: [{ sync_id: SOURCE_SYNC_ID, revision: 1 }] };
    const first = await post('/ledgers/A/transactions/batch/move', body, { 'Idempotency-Key': operationId });
    expect(first.status).toBe(200);
    const newSyncId = first.json.items[0].target_sync_id;
    expect(newSyncId).toBeTruthy();
    expect(first.json.items[0].source_sync_id).toBe(SOURCE_SYNC_ID);
    expect(first.json.operation_id).toBe(operationId);

    // 目标投影：新 sync_id、payload 同步字段、txIndex 顺延
    const targetRow = sqlite
      .prepare('SELECT sync_id, amount, note, tx_index, ledger_id FROM read_tx_projection WHERE sync_id = ?')
      .get(newSyncId) as { sync_id: string; amount: number; note: string; tx_index: number; ledger_id: string };
    expect(targetRow.ledger_id).toBe('lb');
    expect(targetRow.amount).toBe(12.5);
    expect(targetRow.note).toBe('午餐');
    expect(targetRow.tx_index).toBeGreaterThan(0);

    // 目标 upsert 事件 payload 完整性
    const targetEvent = sqlite
      .prepare("SELECT payload_json, action FROM sync_changes WHERE ledger_id = 'lb' AND entity_sync_id = ?")
      .get(newSyncId) as { payload_json: string; action: string };
    expect(targetEvent.action).toBe('upsert');
    const payload = JSON.parse(targetEvent.payload_json);
    expect(payload.syncId).toBe(newSyncId);
    expect(payload.ledgerSyncId).toBe('B');
    expect(payload.amount).toBe(12.5);

    // 源投影已删、tombstone + retirement 落库
    expect(sqlite.prepare('SELECT COUNT(*) c FROM read_tx_projection WHERE ledger_id = ? AND sync_id = ?').get('la', SOURCE_SYNC_ID)).toMatchObject({ c: 0 });
    const tombstone = sqlite
      .prepare("SELECT action, updated_by_device_id FROM sync_changes WHERE ledger_id = 'la' AND entity_sync_id = ? ORDER BY change_id DESC LIMIT 1")
      .get(SOURCE_SYNC_ID) as { action: string; updated_by_device_id: string };
    expect(tombstone.action).toBe('delete');
    expect(tombstone.updated_by_device_id).toBe('server-transaction-move');
    expect(sqlite.prepare('SELECT COUNT(*) c FROM transaction_move_retirements WHERE ledger_id = ? AND sync_id = ?').get('la', SOURCE_SYNC_ID)).toMatchObject({ c: 1 });

    // 同 operation + 同 payload → 重放同一结果，不产生新变更
    const eventCountBefore = (sqlite.prepare('SELECT COUNT(*) c FROM sync_changes').get() as { c: number }).c;
    const replay = await post('/ledgers/A/transactions/batch/move', body, { 'Idempotency-Key': operationId });
    expect(replay.status).toBe(200);
    expect(replay.json.items[0].target_sync_id).toBe(newSyncId);
    expect((sqlite.prepare('SELECT COUNT(*) c FROM sync_changes').get() as { c: number }).c).toBe(eventCountBefore);
  });

  it('同 operation 换了 payload → MOVE_OPERATION_REUSED', async () => {
    const operationId = crypto.randomUUID();
    await post('/ledgers/A/transactions/batch/move',
      { target_ledger_id: 'B', items: [{ sync_id: SOURCE_SYNC_ID, revision: 1 }] },
      { 'Idempotency-Key': operationId });
    const second = await post('/ledgers/A/transactions/batch/move',
      { target_ledger_id: 'U', items: [{ sync_id: SOURCE_SYNC_ID, revision: 1 }] },
      { 'Idempotency-Key': operationId });
    expect(second.status).toBe(409);
    expect(second.json.detail).toBe('MOVE_OPERATION_REUSED');
  });

  it('MOVE_SAME_LEDGER', async () => {
    const { status, json } = await post('/ledgers/A/transactions/batch/move',
      { target_ledger_id: 'A', items: [{ sync_id: SOURCE_SYNC_ID, revision: 1 }] },
      { 'Idempotency-Key': crypto.randomUUID() });
    expect(status).toBe(409);
    expect(json.detail).toBe('MOVE_SAME_LEDGER');
  });

  it('MOVE_REQUIRES_SAME_CURRENCY', async () => {
    const { status, json } = await post('/ledgers/A/transactions/batch/move',
      { target_ledger_id: 'U', items: [{ sync_id: SOURCE_SYNC_ID, revision: 1 }] },
      { 'Idempotency-Key': crypto.randomUUID() });
    expect(status).toBe(409);
    expect(json.detail).toBe('MOVE_REQUIRES_SAME_CURRENCY');
  });

  it('MOVE_REQUIRES_PRIVATE_LEDGERS', async () => {
    const { status, json } = await post('/ledgers/A/transactions/batch/move',
      { target_ledger_id: 'S', items: [{ sync_id: SOURCE_SYNC_ID, revision: 1 }] },
      { 'Idempotency-Key': crypto.randomUUID() });
    expect(status).toBe(409);
    expect(json.detail).toBe('MOVE_REQUIRES_PRIVATE_LEDGERS');
  });

  it('revision 过期 → MOVE_SOURCE_CHANGED', async () => {
    const { status, json } = await post('/ledgers/A/transactions/batch/move',
      { target_ledger_id: 'B', items: [{ sync_id: SOURCE_SYNC_ID, revision: 999 }] },
      { 'Idempotency-Key': crypto.randomUUID() });
    expect(status).toBe(409);
    expect(json.detail).toBe('MOVE_SOURCE_CHANGED');
  });

  it('缺 Idempotency-Key / X-Device-ID → 422', async () => {
    const res = await app.request('/api/v1/write/ledgers/A/transactions/batch/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target_ledger_id: 'B', items: [{ sync_id: SOURCE_SYNC_ID, revision: 1 }] }),
    }, { DB: db });
    expect(res.status).toBe(422);
  });

  it('prepare 重复选择 → MOVE_DUPLICATE_SELECTION', async () => {
    const { status, json } = await post('/ledgers/A/transactions/batch/move/prepare', {
      target_ledger_id: 'B',
      transaction_ids: [SOURCE_SYNC_ID, SOURCE_SYNC_ID],
    });
    expect(status).toBe(422);
    expect(json.detail).toBe('MOVE_DUPLICATE_SELECTION');
  });

  it('prepare 缺交易 → MOVE_SOURCE_CHANGED', async () => {
    const { status, json } = await post('/ledgers/A/transactions/batch/move/prepare', {
      target_ledger_id: 'B',
      transaction_ids: ['not-exist'],
    });
    expect(status).toBe(409);
    expect(json.detail).toBe('MOVE_SOURCE_CHANGED');
  });
});
