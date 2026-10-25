// 自愈回归测试（#B5 补偿事故）：
// B5 附件收敛写入缺字段（只含 attachments）的 transaction upsert change，
// 设备端覆盖式应用会把 amount/日期清成默认值（0 元/空日期）。
// 修复: pull 时检测最新 upsert 缺 amount 的坏变更，自动补写完整 payload 变更，
// 设备端正常同步即恢复，无需任何手动操作。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import syncRouter from '../src/routes/sync';

let sqlite: DatabaseSync;
let db: D1Database;
let app: Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>;

function createTables() {
  sqlite.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL);
    CREATE TABLE ledgers (id TEXT PRIMARY KEY, user_id TEXT, external_id TEXT, name TEXT, currency TEXT);
    CREATE TABLE ledger_members (ledger_id TEXT, user_id TEXT, role TEXT, joined_at TEXT);
    CREATE TABLE devices (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, platform TEXT, last_seen_at TEXT, last_ip TEXT, revoked_at TEXT, created_at TEXT);
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
      PRIMARY KEY (ledger_id, sync_id)
    );
    CREATE TABLE user_account_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, account_type TEXT, currency TEXT);
    CREATE TABLE user_category_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, kind TEXT, level INTEGER);
    CREATE TABLE user_tag_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, color TEXT, source_change_id INTEGER);
    CREATE TABLE user_exchange_rate_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, base_currency TEXT, quote_currency TEXT, rate REAL);
    CREATE TABLE read_budget_projection (ledger_id TEXT, sync_id TEXT, user_id TEXT, budget_type TEXT, category_sync_id TEXT, amount REAL, period TEXT, start_day INTEGER, enabled INTEGER DEFAULT 1);
    CREATE TABLE sync_cursors (user_id TEXT, device_id TEXT, ledger_external_id TEXT, last_cursor INTEGER, updated_at TEXT, PRIMARY KEY (user_id, device_id, ledger_external_id));
    CREATE TABLE audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, ledger_id TEXT, action TEXT, metadata_json TEXT, created_at TEXT);
  `);
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  createTables();
  db = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      let params: unknown[] = [];
      return {
        bind(...values: unknown[]) { params = values; return this; },
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
      sqlite.exec('BEGIN');
      try {
        const out = [];
        for (const s of stmts) out.push(await s.run());
        sqlite.exec('COMMIT');
        return out;
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
    },
  } as unknown as D1Database;

  sqlite.prepare("INSERT INTO users (id, email, password_hash) VALUES ('user-1', 'heal@x.com', 'x')").run();
  sqlite.prepare("INSERT INTO ledgers (id, user_id, external_id, name, currency) VALUES ('ledger-1', 'user-1', 'L_HEAL', 'L', 'CNY')").run();
  sqlite.prepare("INSERT INTO ledger_members (ledger_id, user_id, role, joined_at) VALUES ('ledger-1', 'user-1', 'owner', '2025-01-01T00:00:00Z')").run();
  sqlite.prepare("INSERT INTO devices (id, user_id, name, platform, created_at) VALUES ('m-device', 'user-1', 'm', 'app', '2025-01-01T00:00:00Z')").run();

  app = new Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>();
  app.use('*', async (c, next) => {
    c.set('userId', 'user-1');
    await next();
  });
  app.route('/api/v1/sync', syncRouter);
});

afterEach(() => sqlite.close());

/** 插入一笔完整的投影交易（与真实数据一致） */
function seedProjectionTx(overrides: Record<string, unknown> = {}) {
  const row = {
    ledger_id: 'ledger-1', sync_id: 'tx-heal-1', user_id: 'user-1', tx_type: 'expense',
    amount: 12.5, happened_at: '2026-09-01T12:00:00.000Z', note: '买花',
    category_sync_id: null, category_name: '鲜花', category_kind: 'expense',
    account_sync_id: null, account_name: null,
    from_account_sync_id: null, from_account_name: null,
    to_account_sync_id: null, to_account_name: null,
    tags_csv: '图片记账,AI记账', tag_sync_ids_json: null,
    attachments_json: JSON.stringify([{ fileName: 'a.jpg', cloudFileId: 'f1' }]),
    created_by_user_id: 'user-1', last_edited_by_user_id: 'user-1',
    currency_code: 'CNY', native_amount: 12.5,
    exclude_from_stats: 0, exclude_from_budget: 0,
    ...overrides,
  };
  sqlite.prepare(
    `INSERT INTO read_tx_projection
     (ledger_id, sync_id, user_id, tx_type, amount, happened_at, note,
      category_sync_id, category_name, category_kind,
      account_sync_id, account_name, from_account_sync_id, from_account_name,
      to_account_sync_id, to_account_name,
      tags_csv, tag_sync_ids_json, attachments_json,
      created_by_user_id, last_edited_by_user_id,
      exclude_from_stats, exclude_from_budget, currency_code, native_amount)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.ledger_id, row.sync_id, row.user_id, row.tx_type, row.amount, row.happened_at, row.note,
    row.category_sync_id, row.category_name, row.category_kind,
    row.account_sync_id, row.account_name, row.from_account_sync_id, row.from_account_name,
    row.to_account_sync_id, row.to_account_name,
    row.tags_csv, row.tag_sync_ids_json, row.attachments_json,
    row.created_by_user_id, row.last_edited_by_user_id,
    row.exclude_from_stats, row.exclude_from_budget, row.currency_code, row.native_amount,
  );
}

/** 插入 B5 坏变更（payload 只含 attachments，缺 amount/happenedAt/note 等） */
function seedBrokenChange(syncId = 'tx-heal-1') {
  sqlite.prepare(
    `INSERT INTO sync_changes
     (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id, updated_by_device_id, scope)
     VALUES ('user-1', 'ledger-1', 'transaction', ?, 'upsert', ?, '2026-10-24T11:36:00.000Z', 'user-1', NULL, 'ledger')`
  ).run(syncId, JSON.stringify({ attachments: [{ fileName: 'a.jpg', cloudFileId: 'f1' }] }));
}

describe('sync self-heal (#B5 compensation): pull auto-fills broken changes', () => {
  it('pull 命中坏变更 → 补写完整 payload upsert，响应包含完整字段', async () => {
    seedProjectionTx();
    seedBrokenChange();
    // 补一笔无关变更确保游标推进
    sqlite.prepare(
      `INSERT INTO sync_changes
       (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id, updated_by_device_id, scope)
       VALUES ('user-1', 'ledger-1', 'transaction', 'other-1', 'upsert', '{"syncId":"other-1","type":"expense","amount":1}', '2026-10-24T11:36:00.000Z', 'user-1', NULL, 'ledger')`
    ).run();

    const res = await app.request('/api/v1/sync/pull?since=0&device_id=m-device', {
      headers: { 'Content-Type': 'application/json' },
    }, { DB: db });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { changes: Array<{ entity_sync_id: string; payload: Record<string, unknown> }> };

    // 坏变更实体被补写：响应里该实体的最新变更 payload 完整
    const healed = body.changes.filter(c => c.entity_sync_id === 'tx-heal-1');
    expect(healed.length).toBeGreaterThanOrEqual(2); // 坏变更 + 补写变更
    const last = healed[healed.length - 1]; // 最新一条（补写的）应完整
    expect(last.payload.amount).toBe(12.5);
    expect(last.payload.happenedAt).toBe('2026-09-01T12:00:00.000Z');
    expect(last.payload.note).toBe('买花');
    expect(last.payload.categoryName).toBe('鲜花');
    expect(last.payload.tags).toBe('图片记账,AI记账');
    expect(last.payload.syncId).toBe('tx-heal-1');

    // DB 里确实有一条补写的完整 upsert（最新一条 upsert 完整 → 幂等）
    const rows = sqlite.prepare(
      `SELECT payload_json FROM sync_changes WHERE entity_sync_id = 'tx-heal-1' AND action = 'upsert' ORDER BY change_id`
    ).all() as Array<{ payload_json: string }>;
    const lastDb = JSON.parse(rows[rows.length - 1].payload_json);
    expect(lastDb.amount).toBe(12.5);
    expect(lastDb.attachments[0].cloudFileId).toBe('f1');
  });

  it('再次 pull 不重复补写（幂等）', async () => {
    seedProjectionTx();
    seedBrokenChange();
    await app.request('/api/v1/sync/pull?since=0&device_id=m-device', {}, { DB: db });
    const before = sqlite.prepare(`SELECT COUNT(*) AS n FROM sync_changes WHERE entity_sync_id = 'tx-heal-1'`).get() as { n: number };

    await app.request('/api/v1/sync/pull?since=0&device_id=m-device', {}, { DB: db });
    const after = sqlite.prepare(`SELECT COUNT(*) AS n FROM sync_changes WHERE entity_sync_id = 'tx-heal-1'`).get() as { n: number };
    expect(after.n).toBe(before.n);
  });

  it('投影已删的坏变更不补写（交易已删除）', async () => {
    // 只有坏变更，无投影行
    seedBrokenChange('tx-gone');
    await app.request('/api/v1/sync/pull?since=0&device_id=m-device', {}, { DB: db });
    const rows = sqlite.prepare(`SELECT COUNT(*) AS n FROM sync_changes WHERE entity_sync_id = 'tx-gone'`).get() as { n: number };
    expect(rows.n).toBe(1); // 只有原始坏变更，无补写
  });

  it('正常完整变更不受影响（无坏变更时不写任何东西）', async () => {
    seedProjectionTx();
    // 投影 + 完整 upsert（无坏变更）
    sqlite.prepare(
      `INSERT INTO sync_changes
       (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id, updated_by_device_id, scope)
       VALUES ('user-1', 'ledger-1', 'transaction', 'tx-heal-1', 'upsert', '{"syncId":"tx-heal-1","type":"expense","amount":12.5,"happenedAt":"2026-09-01T12:00:00.000Z"}', '2026-10-24T11:36:00.000Z', 'user-1', NULL, 'ledger')`
    ).run();
    const before = sqlite.prepare(`SELECT COUNT(*) AS n FROM sync_changes`).get() as { n: number };

    await app.request('/api/v1/sync/pull?since=0&device_id=m-device', {}, { DB: db });
    const after = sqlite.prepare(`SELECT COUNT(*) AS n FROM sync_changes`).get() as { n: number };
    expect(after.n).toBe(before.n);
  });
});