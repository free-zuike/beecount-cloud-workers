// 移植上游 tests/test_ai_parse_tx.py 的 batch 部分（B2/B3 AI 记账）：
// - auto_ai_tag + extra_tag_name → 自动建 tag 实体 + tag_sync_ids_json 完整
// - attach_image_id → 转正式 attachment 并返回 attachment_id
// - issue #5:batch 路径按 tags 名字反查已有 tag 的 sync_id
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import batchWriteRouter from '../src/routes/batch_write';

let sqlite: DatabaseSync;
let db: D1Database;
let app: Hono<{ Bindings: { DB: D1Database; R2?: unknown }; Variables: { userId: string } }>;

const USER = 'user-1';

function makeD1(s: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      const statement = s.prepare(sql);
      let params: unknown[] = [];
      return {
        bind(...values: unknown[]) { params = values; return this; },
        async run() {
          const r = statement.run(...(params as never[]));
          return { meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } };
        },
        async first<T = unknown>() {
          const row = statement.get(...(params as never[])) as T | undefined;
          return row ?? null;
        },
        async all<T = unknown>() {
          return { results: statement.all(...(params as never[])) as T[] };
        },
      };
    },
    async batch(stmts: { run(): Promise<unknown> }[]) {
      s.exec('BEGIN');
      try {
        const out = [];
        for (const st of stmts) out.push(await st.run());
        s.exec('COMMIT');
        return out;
      } catch (e) {
        s.exec('ROLLBACK');
        throw e;
      }
    },
  } as unknown as D1Database;
}

const DDL = `
  CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL);
  CREATE TABLE ledgers (id TEXT PRIMARY KEY, user_id TEXT, external_id TEXT, name TEXT, currency TEXT, month_start_day INTEGER DEFAULT 1, created_at TEXT);
  CREATE TABLE sync_changes (
    change_id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, ledger_id TEXT, entity_type TEXT,
    entity_sync_id TEXT, action TEXT, payload_json TEXT, updated_at TEXT,
    updated_by_user_id TEXT, updated_by_device_id TEXT, scope TEXT
  );
  CREATE TABLE read_tx_projection (
    ledger_id TEXT, sync_id TEXT, user_id TEXT, tx_type TEXT, amount REAL DEFAULT 0, happened_at TEXT, note TEXT,
    category_sync_id TEXT, category_name TEXT, category_kind TEXT,
    account_sync_id TEXT, account_name TEXT,
    from_account_sync_id TEXT, from_account_name TEXT,
    to_account_sync_id TEXT, to_account_name TEXT,
    tags_csv TEXT, tag_sync_ids_json TEXT, attachments_json TEXT, tx_index INTEGER DEFAULT 0,
    created_by_user_id TEXT, last_edited_by_user_id TEXT, source_change_id INTEGER DEFAULT 0,
    currency_code TEXT, native_amount REAL,
    exclude_from_stats INTEGER DEFAULT 0, exclude_from_budget INTEGER DEFAULT 0,
    PRIMARY KEY (ledger_id, sync_id)
  );
  CREATE TABLE user_account_projection (
    sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, account_type TEXT, currency TEXT,
    initial_balance REAL DEFAULT 0, note TEXT, credit_limit REAL, billing_day INTEGER, payment_due_day INTEGER,
    bank_name TEXT, card_last_four TEXT, hidden INTEGER DEFAULT 0, source_change_id INTEGER DEFAULT 0
  );
  CREATE TABLE user_category_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, kind TEXT, level INTEGER, sort_order INTEGER, icon TEXT, icon_type TEXT, custom_icon_path TEXT, icon_cloud_file_id TEXT, icon_cloud_sha256 TEXT, parent_name TEXT, parent_sync_id TEXT, source_change_id INTEGER DEFAULT 0);
  CREATE TABLE user_tag_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, color TEXT, source_change_id INTEGER);
  CREATE TABLE ai_image_cache (
    image_id TEXT PRIMARY KEY, user_id TEXT, mime_type TEXT, size_bytes INTEGER, r2_key TEXT, created_at TEXT
  );
  CREATE TABLE attachment_files (
    id TEXT PRIMARY KEY, ledger_id TEXT, user_id TEXT, sha256 TEXT,
    size_bytes INTEGER, mime_type TEXT, file_name TEXT, storage_path TEXT,
    attachment_kind TEXT, created_at TEXT
  );
  CREATE TABLE backup_remotes (id TEXT PRIMARY KEY, backend_type TEXT, config_summary TEXT);
  CREATE TABLE audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, ledger_id TEXT, action TEXT, metadata_json TEXT, created_at TEXT);
`;

function makeMockR2(): unknown {
  return {
    put: async () => ({}) as never,
    get: async (_key: string) => ({ arrayBuffer: async () => new TextEncoder().encode('fakejpegbytes').buffer }) as never,
    delete: async () => ({}) as never,
  };
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec(DDL);
  db = makeD1(sqlite);
  sqlite.prepare("INSERT INTO users (id, email, password_hash) VALUES (?, 'b@x.com', 'x')").run(USER);
  sqlite.prepare("INSERT INTO ledgers (id, user_id, external_id, name, currency, created_at) VALUES ('lg1', ?, 'L1', 'imp', 'CNY', '2025-01-01T00:00:00Z')").run(USER);

  app = new Hono<{ Bindings: { DB: D1Database; R2?: unknown }; Variables: { userId: string } }>();
  app.use('*', async (c, next) => { c.set('userId', USER); await next(); });
  app.route('/api/v1/write', batchWriteRouter);
});

afterEach(() => sqlite.close());

function env(r2?: unknown) {
  return { DB: db, R2: r2 ?? makeMockR2() } as any;
}

async function batchCreate(body: Record<string, unknown>, r2?: unknown) {
  return app.request('/api/v1/write/ledgers/L1/transactions/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-ID': 'd-web', 'CF-Connecting-IP': '127.0.0.1' },
    body: JSON.stringify(body),
  }, env(r2));
}

describe('batch create auto tag + extra tag（移植上游 test_batch_create_with_ai_tag_and_extra_tag）', () => {
  it('N 笔创建 + auto_ai_tag + extra_tag_name', async () => {
    const res = await batchCreate({
      base_change_id: 0,
      transactions: [
        { tx_type: 'expense', amount: 35.0, happened_at: '2026-05-06T12:30:00Z', note: '星巴克', tags: [] },
        { tx_type: 'expense', amount: 28.0, happened_at: '2026-05-06T18:00:00Z', note: '滴滴', tags: [] },
      ],
      auto_ai_tag: true,
      extra_tag_name: '图片记账',
      locale: 'zh',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.created_sync_ids).toHaveLength(2);
    expect(body.new_change_id).toBeGreaterThan(0);
  });
});

describe('batch materializes auto tag entities（移植上游 test_batch_create_materializes_auto_tag_entities）', () => {
  it('UserTagProjection 有 AI记账 + 文字记账，tag_sync_ids_json 完整', async () => {
    const res = await batchCreate({
      base_change_id: 0,
      transactions: [
        { tx_type: 'expense', amount: 20.0, happened_at: '2026-05-21T09:47:00Z', note: '买菜', tags: [] },
      ],
      auto_ai_tag: true,
      extra_tag_name: '文字记账',
      locale: 'zh',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const txSyncId = body.created_sync_ids[0];

    const tagRows = sqlite.prepare('SELECT sync_id, name FROM user_tag_projection WHERE user_id = ?').all(USER) as { sync_id: string; name: string }[];
    const tagNames = new Set(tagRows.map(t => t.name));
    expect(tagNames.has('AI记账')).toBe(true);
    expect(tagNames.has('文字记账')).toBe(true);
    const nameToSyncId = new Map(tagRows.map(t => [t.name, t.sync_id]));

    const tx = sqlite.prepare('SELECT tags_csv, tag_sync_ids_json FROM read_tx_projection WHERE sync_id = ?').get(txSyncId) as { tags_csv: string | null; tag_sync_ids_json: string | null };
    expect(tx.tags_csv).toContain('AI记账');
    expect(tx.tags_csv).toContain('文字记账');
    expect(tx.tag_sync_ids_json).not.toBeNull();
    const syncIds = JSON.parse(tx.tag_sync_ids_json!) as string[];
    expect(syncIds).toContain(nameToSyncId.get('AI记账'));
    expect(syncIds).toContain(nameToSyncId.get('文字记账'));
  });
});

describe('batch fills tag_sync_ids for existing tags（移植上游 test_batch_create_fills_tag_sync_ids_for_existing_tags）', () => {
  it('issue #5 根因：已有 tag 只传名字，tag_sync_ids_json 被 lookup 填充', async () => {
    // 预先创建 tag「旅行」
    const travelTagSyncId = 'tag-travel';
    sqlite.prepare('INSERT INTO user_tag_projection (sync_id, user_id, name) VALUES (?, ?, ?)').run(travelTagSyncId, USER, '旅行');

    const res = await batchCreate({
      base_change_id: 0,
      transactions: [
        { tx_type: 'expense', amount: 1280.0, happened_at: '2026-05-21T12:00:00Z', note: '酒店', tags: ['旅行'] },
      ],
      auto_ai_tag: false,
      locale: 'zh',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const txSyncId = body.created_sync_ids[0];

    const tx = sqlite.prepare('SELECT tags_csv, tag_sync_ids_json FROM read_tx_projection WHERE sync_id = ?').get(txSyncId) as { tags_csv: string | null; tag_sync_ids_json: string | null };
    expect(tx.tags_csv).toBe('旅行');
    expect(tx.tag_sync_ids_json).not.toBeNull();
    const syncIds = JSON.parse(tx.tag_sync_ids_json!) as string[];
    expect(syncIds).toContain(travelTagSyncId);
  });
});

describe('batch attach_image_id（移植上游 test_batch_create_with_image_attachment）', () => {
  it('consume ai_image_cache → 转正式 attachment → 返回 attachment_id', async () => {
    // 模拟 parse-tx-image 缓存（image_id → 字节在 mock R2）
    sqlite.prepare(
      "INSERT INTO ai_image_cache (image_id, user_id, mime_type, size_bytes, r2_key, created_at) VALUES ('img-1', ?, 'image/jpeg', 13, 'ai-tmp/user-1/img-1', '2026-05-06T00:00:00Z')"
    ).run(USER);

    const res = await batchCreate({
      base_change_id: 0,
      transactions: [
        { tx_type: 'expense', amount: 35.0, happened_at: '2026-05-06T12:30:00Z', note: '星巴克' },
      ],
      auto_ai_tag: false,
      attach_image_id: 'img-1',
      locale: 'zh',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.attachment_id).toBeTruthy();
    expect(body.created_sync_ids).toHaveLength(1);

    // 缓存行被 consume（一次性），附件落库
    const cacheLeft = sqlite.prepare('SELECT COUNT(*) AS c FROM ai_image_cache WHERE image_id = ?').get('img-1') as { c: number };
    expect(cacheLeft.c).toBe(0);
    const att = sqlite.prepare('SELECT COUNT(*) AS c FROM attachment_files WHERE id = ?').get(body.attachment_id) as { c: number };
    expect(att.c).toBe(1);
    // 共享附件挂到 tx 的 attachments_json
    const tx = sqlite.prepare('SELECT attachments_json FROM read_tx_projection WHERE sync_id = ?').get(body.created_sync_ids[0]) as { attachments_json: string | null };
    expect(tx.attachments_json).toContain(body.attachment_id);
  });
});
