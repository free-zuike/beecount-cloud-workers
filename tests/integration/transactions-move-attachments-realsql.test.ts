import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import moveRouter from '../../src/routes/transactions_move';
import { createRealDb, WRITE_PATH_TABLES } from '../helpers/realsql-db';

/**
 * 跨账本移动的附件路径（mock R2）：下载源对象 → 校验 sha256 → 复制到目标账本目录 →
 * 目标交易 payload 的 cloudFileId 改写；同 sha256 去重复用同一附件行。
 */

const T0 = '2026-01-15T10:00:00.000Z';
const SHA_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'; // sha256("abc")

let sqlite: DatabaseSync;
let db: D1Database;
let objects: Map<string, Uint8Array>;
let r2: R2Bucket;
let app: Hono<{ Bindings: { DB: D1Database; R2: R2Bucket }; Variables: { userId: string } }>;

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
`;

function makeMockR2(): R2Bucket {
  objects = new Map<string, Uint8Array>();
  return {
    async get(key: string) {
      const body = objects.get(key);
      if (!body) return null;
      return {
        async arrayBuffer() {
          return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
        },
        size: body.byteLength,
      };
    },
    async put(key: string, body: Uint8Array) {
      objects.set(key, body instanceof Uint8Array ? body : new Uint8Array(body as ArrayBuffer));
      return { key } as unknown;
    },
    async delete(key: string) {
      objects.delete(key);
    },
    async head(key: string) {
      return objects.has(key) ? ({ size: objects.get(key)!.byteLength } as unknown) : null;
    },
  } as unknown as R2Bucket;
}

async function request(path: string, init: RequestInit) {
  const res = await app.request(
    path,
    {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    },
    { DB: db, R2: r2 }
  );
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
}

beforeEach(() => {
  const real = createRealDb();
  sqlite = real.sqlite;
  db = real.db;
  sqlite.exec(WRITE_PATH_TABLES);
  sqlite.exec(EXTRA_TABLES);
  r2 = makeMockR2();

  sqlite.prepare("INSERT INTO users (id, email, password_hash) VALUES ('u1', 'a@example.com', 'x')").run();
  for (const [lid, ext] of [['la', 'A'], ['lb', 'B']]) {
    sqlite.prepare("INSERT INTO ledgers (id, user_id, external_id, name, currency) VALUES (?, 'u1', ?, ?, 'CNY')").run(lid, ext, ext);
    sqlite.prepare("INSERT INTO ledger_members (ledger_id, user_id, role, joined_at) VALUES (?, 'u1', 'owner', ?)").run(lid, T0);
  }
  sqlite.prepare("INSERT INTO devices (id, user_id, name, platform, revoked_at, created_at) VALUES ('d1', 'u1', 't', 't', NULL, ?)").run(T0);

  // 源账本两个交易，各自引用同一附件（测去重）
  sqlite.prepare(
    `INSERT INTO read_tx_projection
     (ledger_id, sync_id, user_id, tx_type, amount, happened_at, note, attachments_json,
      tx_index, source_change_id, exclude_from_stats, exclude_from_budget, created_by_user_id, last_edited_by_user_id)
     VALUES ('la', 'tx1', 'u1', 'expense', 10, ?, 'n1', '[{"cloudFileId":"f1","fileName":"f1_a.png"}]', 1, 100, 0, 0, 'u1', 'u1')`
  ).run(T0);
  sqlite.prepare(
    `INSERT INTO read_tx_projection
     (ledger_id, sync_id, user_id, tx_type, amount, happened_at, note, attachments_json,
      tx_index, source_change_id, exclude_from_stats, exclude_from_budget, created_by_user_id, last_edited_by_user_id)
     VALUES ('la', 'tx2', 'u1', 'expense', 20, ?, 'n2', '[{"cloudFileId":"f1","fileName":"f1_a.png"}]', 2, 101, 0, 0, 'u1', 'u1')`
  ).run(T0);
  sqlite.prepare(
    `INSERT INTO attachment_files (id, ledger_id, user_id, sha256, size_bytes, mime_type, file_name, storage_path, attachment_kind, created_at)
     VALUES ('f1', 'la', 'u1', ?, 3, 'image/png', 'a.png', 'attachments/A/f1_a.png', 'transaction', ?)`
  ).run(SHA_ABC, T0);
  objects.set('beecount/attachments/A/f1_a.png', new TextEncoder().encode('abc'));

  app = new Hono<{ Bindings: { DB: D1Database; R2: R2Bucket }; Variables: { userId: string } }>();
  app.use('*', async (c, next) => {
    c.set('userId', 'u1');
    await next();
  });
  app.route('/api/v1/write', moveRouter);
});

afterEach(() => sqlite.close());

describe('跨账本移动 · 附件复制（mock R2）', () => {
  it('prepare 校验附件存在；move 复制对象、改写 cloudFileId、同 sha256 去重', async () => {
    const prep = await request('/api/v1/write/ledgers/A/transactions/batch/move/prepare', {
      method: 'POST',
      body: JSON.stringify({ target_ledger_id: 'B', transaction_ids: ['tx1', 'tx2'] }),
    });
    expect(prep.status).toBe(200);
    expect(prep.json).toHaveLength(2);

    const move = await request('/api/v1/write/ledgers/A/transactions/batch/move', {
      method: 'POST',
      headers: { 'X-Device-ID': 'd1', 'Idempotency-Key': '00000000-0000-4000-8000-0000000000aa' },
      body: JSON.stringify({
        target_ledger_id: 'B',
        items: [
          { sync_id: 'tx1', revision: 100 },
          { sync_id: 'tx2', revision: 101 },
        ],
      }),
    });
    expect(move.status).toBe(200);
    const payload = move.json as {
      items: Array<{ source_sync_id: string; target_sync_id: string }>;
      attachment_ids: Record<string, string>;
    };
    expect(payload.items).toHaveLength(2);
    expect(Object.keys(payload.attachment_ids)).toEqual(['f1']);
    const newFileId = payload.attachment_ids.f1;
    expect(newFileId).toBeTruthy();

    // 目标账本只新增一行附件；R2 只有一份新对象
    const targetRows = sqlite
      .prepare("SELECT id, ledger_id, storage_path FROM attachment_files WHERE ledger_id = 'lb'")
      .all() as Array<{ id: string; ledger_id: string; storage_path: string }>;
    expect(targetRows).toHaveLength(1);
    expect(targetRows[0].id).toBe(newFileId);
    expect(targetRows[0].storage_path).toContain(`attachments/B/${newFileId}_`);
    const r2Keys = [...objects.keys()].filter((k) => k.startsWith('beecount/attachments/B/'));
    expect(r2Keys).toHaveLength(1);

    // 两条目标交易的 payload 都指向新 fileId
    for (const item of payload.items) {
      const row = sqlite
        .prepare('SELECT attachments_json FROM read_tx_projection WHERE sync_id = ?')
        .get(item.target_sync_id) as { attachments_json: string };
      const atts = JSON.parse(row.attachments_json) as Array<{ cloudFileId: string }>;
      expect(atts[0].cloudFileId).toBe(newFileId);
    }

    // 源账本投影清空、retirement 两条
    expect(sqlite.prepare("SELECT COUNT(*) c FROM read_tx_projection WHERE ledger_id = 'la'").get()).toMatchObject({ c: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) c FROM transaction_move_retirements').get()).toMatchObject({ c: 2 });
  });

  it('R2 源对象缺失 → MOVE_ATTACHMENT_MISSING（prepare 通过校验但 move 失败）', async () => {
    objects.clear();
    const move = await request('/api/v1/write/ledgers/A/transactions/batch/move', {
      method: 'POST',
      headers: { 'X-Device-ID': 'd1', 'Idempotency-Key': '00000000-0000-4000-8000-0000000000bb' },
      body: JSON.stringify({ target_ledger_id: 'B', items: [{ sync_id: 'tx1', revision: 100 }] }),
    });
    expect(move.status).toBe(409);
    expect(move.json.detail).toBe('MOVE_ATTACHMENT_MISSING');
    // 失败不留半成品：源投影仍在
    expect(sqlite.prepare("SELECT COUNT(*) c FROM read_tx_projection WHERE ledger_id = 'la'").get()).toMatchObject({ c: 2 });
  });
});
