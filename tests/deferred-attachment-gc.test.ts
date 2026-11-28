import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'crypto';
import { Hono } from 'hono';
import syncRouter from '../src/routes/sync';
import { expirePendingAttachmentGc } from '../src/services/attachment-gc';

// 移植上游 tests/test_attachment_gc.py::
// test_incomplete_manifest_expires_unrelated_files_and_clears_last_real_reference
// （#150 延迟附件 GC）：分批上传的草稿 manifest（无 cloudFileId 占位条目）期间，
// 被移除的附件挂起 1 天不回收；到期 sweeper 按 sha256/文件名判定 —— 仍在上传中的
// 保留，其余回收；持久上传失败不延长宽限期；随后完整 manifest 触发立即 GC。
let sqlite: DatabaseSync;
let db: D1Database;
let app: Hono<{ Bindings: { DB: D1Database; JWT_SECRET: string }; Variables: { userId: string } }>;

const SHA_A = createHash('sha256').update('first receipt').digest('hex');
const SHA_B = createHash('sha256').update('different receipt').digest('hex');

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, is_admin BOOLEAN DEFAULT 0);
    CREATE TABLE ledgers (id TEXT PRIMARY KEY, user_id TEXT, external_id TEXT, name TEXT, currency TEXT, month_start_day INTEGER DEFAULT 1, created_at TEXT);
    CREATE TABLE ledger_members (ledger_id TEXT, user_id TEXT, role TEXT, joined_at TEXT);
    CREATE TABLE devices (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, platform TEXT, app_version TEXT, os_version TEXT, device_model TEXT, last_ip TEXT, last_seen_at TEXT, revoked_at TEXT, created_at TEXT);
    CREATE TABLE sync_operation_receipts (device_id TEXT NOT NULL, operation_id TEXT NOT NULL, change_id INTEGER NOT NULL, ledger_id TEXT, entity_type TEXT NOT NULL, entity_sync_id TEXT NOT NULL, action TEXT NOT NULL, PRIMARY KEY (device_id, operation_id));
    CREATE TABLE transaction_move_retirements (ledger_id TEXT, sync_id TEXT, PRIMARY KEY (ledger_id, sync_id));
    CREATE TABLE attachment_files (
      id TEXT PRIMARY KEY, ledger_id TEXT, user_id TEXT, sha256 TEXT,
      size_bytes INTEGER, mime_type TEXT, file_name TEXT, storage_path TEXT,
      attachment_kind TEXT, created_at TEXT
    );
    CREATE TABLE sync_changes (
      change_id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, ledger_id TEXT, entity_type TEXT,
      entity_sync_id TEXT, action TEXT, payload_json TEXT, updated_at TEXT,
      updated_by_user_id TEXT, updated_by_device_id TEXT, scope TEXT
    );
    CREATE TABLE read_tx_projection (
      ledger_id TEXT, sync_id TEXT, user_id TEXT, tx_type TEXT, amount REAL, happened_at TEXT, note TEXT,
      category_sync_id TEXT, category_name TEXT, category_kind TEXT,
      account_sync_id TEXT, account_name TEXT,
      from_account_sync_id TEXT, from_account_name TEXT,
      to_account_sync_id TEXT, to_account_name TEXT,
      tags_csv TEXT, tag_sync_ids_json TEXT, attachments_json TEXT, tx_index INTEGER,
      created_by_user_id TEXT, last_edited_by_user_id TEXT, source_change_id INTEGER,
      currency_code TEXT, native_amount REAL,
      exclude_from_stats INTEGER DEFAULT 0, exclude_from_budget INTEGER DEFAULT 0,
      pending_attachment_gc_json TEXT, attachment_gc_after TEXT,
      PRIMARY KEY (ledger_id, sync_id)
    );
    CREATE TABLE read_budget_projection (ledger_id TEXT, sync_id TEXT, user_id TEXT, budget_type TEXT, category_sync_id TEXT, amount REAL, period TEXT, start_day INTEGER, enabled INTEGER DEFAULT 1, source_change_id INTEGER DEFAULT 0);
    CREATE TABLE user_account_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, account_type TEXT, currency TEXT, initial_balance REAL DEFAULT 0, note TEXT, credit_limit REAL, billing_day INTEGER, payment_due_day INTEGER, bank_name TEXT, card_last_four TEXT, hidden INTEGER DEFAULT 0, source_change_id INTEGER DEFAULT 0);
    CREATE TABLE user_category_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, kind TEXT, level INTEGER, sort_order INTEGER, icon TEXT, icon_type TEXT, custom_icon_path TEXT, icon_cloud_file_id TEXT, icon_cloud_sha256 TEXT, parent_name TEXT, parent_sync_id TEXT, source_change_id INTEGER DEFAULT 0);
    CREATE TABLE user_tag_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, color TEXT, source_change_id INTEGER);
    CREATE TABLE user_exchange_rate_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, base_currency TEXT, quote_currency TEXT, rate REAL);
    CREATE TABLE audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, ledger_id TEXT, action TEXT, metadata_json TEXT, created_at TEXT);
    CREATE TABLE backup_remotes (id TEXT PRIMARY KEY, backend_type TEXT, config_summary TEXT);
  `);

  db = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      const normalize = (v: unknown): unknown => (typeof v === 'boolean' ? (v ? 1 : 0) : v);
      let params: unknown[] = [];
      return {
        bind(...values: unknown[]) { params = values.map(normalize); return this; },
        async run() {
          const r = statement.run(...params as never[]);
          return { meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } };
        },
        async first<T = unknown>() {
          const row = statement.get(...params as never[]) as T | undefined;
          return row ?? null;
        },
        async all<T = unknown>() {
          return { results: statement.all(...params as never[]) as T[] };
        },
      };
    },
    async batch(stmts: { run(): Promise<unknown> }[]) {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
  } as unknown as D1Database;

  sqlite.prepare("INSERT INTO users (id, email, password_hash, is_admin) VALUES ('user-1', 'gc@x.com', 'x', 0)").run();
  sqlite.prepare("INSERT INTO devices (id, user_id, name, platform, app_version, created_at) VALUES ('d1', 'user-1', 'p', 'ios', '4.1.0', '2025-01-01')").run();
  sqlite.prepare("INSERT INTO ledgers (id, user_id, external_id, name, currency, created_at) VALUES ('ledger-1', 'user-1', 'L1', 'L', 'CNY', '2025-01-01')").run();
  sqlite.prepare("INSERT INTO ledger_members (ledger_id, user_id, role, joined_at) VALUES ('ledger-1', 'user-1', 'owner', '2025-01-01')").run();
  sqlite.prepare("INSERT INTO attachment_files (id, ledger_id, user_id, sha256, storage_path, attachment_kind) VALUES ('held-a', 'ledger-1', 'user-1', ?, 'a.bin', 'transaction')").run(SHA_A);
  sqlite.prepare("INSERT INTO attachment_files (id, ledger_id, user_id, sha256, storage_path, attachment_kind) VALUES ('held-b', 'ledger-1', 'user-1', ?, 'b.bin', 'transaction')").run(SHA_B);

  app = new Hono<{ Bindings: { DB: D1Database; JWT_SECRET: string }; Variables: { userId: string } }>();
  app.use('*', async (c, next) => {
    c.set('userId', 'user-1');
    await next();
  });
  app.route('/api/v1/sync', syncRouter);
});

afterEach(() => sqlite.close());

async function editAttachments(refs: unknown[]): Promise<void> {
  const res = await app.request('/api/v1/sync/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      device_id: 'd1',
      changes: [{
        ledger_id: 'L1', entity_type: 'transaction', entity_sync_id: 'bill',
        action: 'upsert', updated_at: new Date().toISOString(),
        payload: { syncId: 'bill', type: 'expense', amount: 1, happenedAt: '2026-01-01T00:00:00Z', attachments: refs },
      }],
    }),
  }, { DB: db, JWT_SECRET: 'x' });
  expect(res.status).toBe(200);
}

function gcRow(): { pending_attachment_gc_json: string | null; attachment_gc_after: string | null; attachments_json: string | null } {
  return sqlite.prepare("SELECT pending_attachment_gc_json, attachment_gc_after, attachments_json FROM read_tx_projection WHERE ledger_id = 'ledger-1' AND sync_id = 'bill'").get() as never;
}

function attachmentIds(): string[] {
  return (sqlite.prepare('SELECT id FROM attachment_files ORDER BY id').all() as Array<{ id: string }>).map(r => r.id);
}

describe('延迟附件 GC（移植上游 incomplete manifest 场景）', () => {
  it('草稿 manifest 挂起回收 → sweeper 按 sha 保留在传附件 → 完整批次立即 GC', async () => {
    // v1：完整 manifest（都带 cloudFileId）→ 建立引用基线，无挂起
    await editAttachments([
      { fileName: `sha_${SHA_A}.png`, cloudFileId: 'held-a', originalName: 'receipt.png' },
      { fileName: 'other-local.png', cloudFileId: 'held-b', originalName: 'receipt.png' },
    ]);
    expect(gcRow().attachment_gc_after).toBeNull();
    expect(attachmentIds()).toEqual(['held-a', 'held-b']);

    // v2：草稿 manifest（无 cloudFileId 占位）→ a/b 都被移除 → 全部挂起 1 天
    const pending = [{ fileName: `sha_${SHA_A}.png`, originalName: 'receipt.png' }];
    await editAttachments(pending);
    const row2 = gcRow();
    expect(row2.attachment_gc_after).toBeTruthy();
    expect(Object.keys(JSON.parse(row2.pending_attachment_gc_json ?? '{}')).sort()).toEqual(['held-a', 'held-b']);
    expect(attachmentIds()).toEqual(['held-a', 'held-b']);

    // v3：持久上传失败不延长宽限期（deadline 保持）
    const deadline = gcRow().attachment_gc_after;
    await editAttachments(pending);
    expect(gcRow().attachment_gc_after).toBe(deadline);

    // 到期 sweeper：a 的 sha 命中仍在上传的占位条目 → 保留；b 无匹配 → 回收
    sqlite.prepare("UPDATE read_tx_projection SET attachment_gc_after = ? WHERE ledger_id = 'ledger-1' AND sync_id = 'bill'")
      .run(new Date(Date.now() - 1000).toISOString());
    const r2Deletes: string[] = [];
    const r2Stub = { delete: async (key: string) => { r2Deletes.push(key); } } as unknown as R2Bucket;
    const processed = await expirePendingAttachmentGc(db, { R2: r2Stub });
    expect(processed).toBe(1);
    const row4 = gcRow();
    expect(row4.attachment_gc_after).toBeNull();
    expect(Object.keys(JSON.parse(row4.pending_attachment_gc_json ?? '{}'))).toEqual(['held-a']);
    expect(attachmentIds()).toEqual(['held-a']);

    // v4：完整空 manifest → 立即 GC 掉最后一个真实引用
    await editAttachments([]);
    expect(attachmentIds()).toEqual([]);
  });
});
