import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { createRealDb } from './helpers/realsql-db';
import readRouter from '../src/routes/read';
import { createAccessToken } from '../src/auth';

// 对齐上游 tests/test_attachment_gallery.py（#129 票据墙）：
// - 展开交易 attachments_json，按 file_key 去重分组、按最近时间排序分页；
// - status：无 cloudFileId=pending；有且 attachment_files 存在=ready；否则=missing；
// - 每项含全部关联交易（去重）。
const TABLES = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
    is_admin INTEGER DEFAULT 0, is_enabled INTEGER DEFAULT 1,
    totp_enabled INTEGER DEFAULT 0, totp_secret_encrypted TEXT, created_at TEXT
  );
  CREATE TABLE ledgers (
    id TEXT PRIMARY KEY, external_id TEXT, user_id TEXT, name TEXT, currency TEXT, created_at TEXT
  );
  CREATE TABLE ledger_members (
    ledger_id TEXT, user_id TEXT, role TEXT, PRIMARY KEY (ledger_id, user_id)
  );
  CREATE TABLE read_tx_projection (
    ledger_id TEXT, sync_id TEXT, user_id TEXT, tx_type TEXT, amount REAL DEFAULT 0,
    happened_at TEXT, note TEXT, category_sync_id TEXT, category_name TEXT,
    account_sync_id TEXT, account_name TEXT, from_account_sync_id TEXT, to_account_sync_id TEXT,
    currency_code TEXT, native_amount REAL, attachments_json TEXT, PRIMARY KEY (ledger_id, sync_id)
  );
  CREATE TABLE attachment_files (
    id TEXT PRIMARY KEY, ledger_id TEXT, user_id TEXT, sha256 TEXT,
    size_bytes INTEGER, mime_type TEXT, file_name TEXT, storage_path TEXT,
    attachment_kind TEXT, created_at TEXT
  );
`;

const SECRET = 'test-secret';

function buildApp(db: D1Database) {
  const app = new Hono<{ Bindings: { DB: D1Database; JWT_SECRET: string } }>();
  app.use('/read/*', async (c, next) => {
    const auth = c.req.header('Authorization');
    if (!auth?.startsWith('Bearer ')) return c.json({ error: 'Unauthorized' }, 401);
    const token = auth.slice(7);
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
      c.set('userId' as never, payload.sub as string);
    } catch {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return next();
  });
  app.route('/read', readRouter);
  return app;
}

function ref(cloudFileId: string | null, fileName: string, extra: Record<string, unknown> = {}) {
  return { cloudFileId, fileName, originalName: fileName, fileSize: 1024, ...extra };
}

describe('票据墙 GET /read/workspace/attachments（对齐 #129）', () => {
  it('按文件去重分组、share 引用多交易、status 三态、按最近时间排序分页', async () => {
    const { sqlite, db } = createRealDb();
    sqlite.exec(TABLES);
    // 3 笔交易：tx-1 有文件 f1（ready）+ local（pending）；tx-2 引用同一 f1（共享）
    // 与 f2（missing，有 cloudFileId 但 attachment_files 无记录）；tx-3 日期更早、引用 f3。
    sqlite.exec(`
      INSERT INTO users (id, email, password_hash, is_admin, is_enabled, created_at)
      VALUES ('u1', 'gal@x.com', 'x', 0, 1, '2026-01-01T00:00:00Z');
      INSERT INTO ledgers (id, external_id, user_id, name, currency, created_at)
      VALUES ('lg1', 'lg1', 'u1', '票据账本', 'CNY', '2026-01-01T00:00:00Z');
      INSERT INTO attachment_files (id, ledger_id, user_id, sha256, size_bytes, mime_type, file_name, storage_path, attachment_kind, created_at)
      VALUES ('f1', 'lg1', 'u1', 'sha1', 100, 'image/jpeg', 'receipt.jpg', 'attachments/lg1/f1_receipt.jpg', 'transaction', '2026-01-01T00:00:00Z');
      INSERT INTO read_tx_projection (ledger_id, sync_id, user_id, tx_type, amount, happened_at, note, category_sync_id, category_name, account_sync_id, attachments_json)
      VALUES
        ('lg1', 'tx-1', 'u1', 'expense', 50, '2026-03-10T00:00:00Z', '午餐', 'cat-food', '餐饮', 'acc-cash',
         '${JSON.stringify([ref('f1', 'receipt.jpg'), ref(null, 'draft.png')])}'),
        ('lg1', 'tx-2', 'u1', 'expense', 30, '2026-03-12T00:00:00Z', '咖啡', 'cat-food', '餐饮', 'acc-cash',
         '${JSON.stringify([ref('f1', 'receipt.jpg'), ref('f2', 'missing.png')])}'),
        ('lg1', 'tx-3', 'u1', 'expense', 20, '2026-02-01T00:00:00Z', '旧单据', 'cat-other', '其他', 'acc-cash',
         '${JSON.stringify([ref('f3', 'old.jpg')])}');
    `);
    const token = await createAccessToken('u1', SECRET, ['app_write']);
    const app = buildApp(db);

    const res = await app.request('/read/workspace/attachments?ledger_id=lg1&limit=10&offset=0', {
      headers: { Authorization: `Bearer ${token}` },
    }, { DB: db, JWT_SECRET: SECRET } as any);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      items: Array<{ key: string; attachment: Record<string, unknown>; happened_at: string; mime_type: string | null; status: string; transactions: Array<{ id: string }> }>;
      total: number; transaction_total: number;
    };

    expect(body.total).toBe(4); // f1, local:tx-1:1, f2, f3
    expect(body.transaction_total).toBe(3);
    // 排序：按最近 happened_at 降序 → f1(03-12) → f2(03-12) → local(03-10) → f3(02-01)
    const byKey = Object.fromEntries(body.items.map((i) => [i.key, i]));
    expect(body.items[0].key).toBe('f1');
    expect(body.items[0].status).toBe('ready');
    expect(body.items[0].mime_type).toBe('image/jpeg');
    // f1 被 tx-1/tx-2 引用 → 关联 2 笔交易
    expect(byKey['f1'].transactions.map((t) => t.id).sort()).toEqual(['tx-1', 'tx-2']);
    // local 附件（无 cloudFileId）→ pending
    const localKey = Object.keys(byKey).find((k) => k.startsWith('local:'));
    expect(localKey).toBeDefined();
    expect(byKey[localKey!].status).toBe('pending');
    // f2 有 cloudFileId 但存储缺 → missing
    expect(byKey['f2']).toBeDefined();
    expect(byKey['f2'].status).toBe('missing');
    expect(byKey['f3'].status).toBe('missing');
  });

  it('账本无权限返回空且不报错', async () => {
    const { sqlite, db } = createRealDb();
    sqlite.exec(TABLES);
    sqlite.exec(`
      INSERT INTO users (id, email, password_hash, is_admin, is_enabled, created_at)
      VALUES ('u1', 'gal2@x.com', 'x', 0, 1, '2026-01-01T00:00:00Z'),
             ('other', 'other@x.com', 'x', 0, 1, '2026-01-01T00:00:00Z');
      INSERT INTO ledgers (id, external_id, user_id, name, currency, created_at)
      VALUES ('lg1', 'lg1', 'other', '别人账本', 'CNY', '2026-01-01T00:00:00Z');
    `);
    const token = await createAccessToken('u1', SECRET, ['app_write']);
    const app = buildApp(db);
    const res = await app.request('/read/workspace/attachments?ledger_id=lg1', {
      headers: { Authorization: `Bearer ${token}` },
    }, { DB: db, JWT_SECRET: SECRET } as any);
    expect(res.status).toBe(200);
    const body = await res.json() as { items: unknown[]; total: number };
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
  });
});