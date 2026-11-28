import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import syncRouter from '../src/routes/sync';
import { app as fullApp } from '../src/index';
import { createRealDb } from './helpers/realsql-db';
import { parseSemver, isVersionBelow, resolveVersionPolicy } from '../src/version';

// 移植上游 tests/test_version_compatibility.py（#151）：
// - parse_semver / is_version_below 纯函数语义;
// - /version 公开端点下发 min_app_version / recommended_app_version;
// - 同步接口从 X-BeeCount-App-Version 头刷新 Device.app_version;
// - 低于 MIN_APP_VERSION 的 App 端 push/pull/full 全部 426;
// - 无 header 的移动端按落库 app_version 拦截;web 平台永不拦截。
let sqlite: DatabaseSync;
let db: D1Database;
let app: Hono<{ Bindings: { DB: D1Database; JWT_SECRET: string }; Variables: { userId: string } }>;

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, is_admin BOOLEAN DEFAULT 0);
    CREATE TABLE ledgers (id TEXT PRIMARY KEY, user_id TEXT, external_id TEXT, name TEXT, currency TEXT, month_start_day INTEGER DEFAULT 1, created_at TEXT);
    CREATE TABLE ledger_members (ledger_id TEXT, user_id TEXT, role TEXT, joined_at TEXT);
    CREATE TABLE devices (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, platform TEXT, app_version TEXT, os_version TEXT, device_model TEXT, last_ip TEXT, last_seen_at TEXT, revoked_at TEXT, created_at TEXT);
    CREATE TABLE device_sync_failures (
      device_id TEXT, direction TEXT, incident_id TEXT, failure_count INTEGER,
      reason TEXT, first_failed_at TEXT, last_failed_at TEXT, PRIMARY KEY (device_id, direction)
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
      tags_csv TEXT, tag_sync_ids_json TEXT, attachments_json TEXT, pending_attachment_gc_json TEXT, attachment_gc_after TEXT, tx_index INTEGER,
      created_by_user_id TEXT, last_edited_by_user_id TEXT, source_change_id INTEGER,
      currency_code TEXT, native_amount REAL,
      exclude_from_stats INTEGER DEFAULT 0, exclude_from_budget INTEGER DEFAULT 0,
      PRIMARY KEY (ledger_id, sync_id)
    );
    CREATE TABLE read_budget_projection (ledger_id TEXT, sync_id TEXT, user_id TEXT, budget_type TEXT, category_sync_id TEXT, amount REAL, period TEXT, start_day INTEGER, enabled INTEGER DEFAULT 1, source_change_id INTEGER DEFAULT 0);
    CREATE TABLE user_account_projection (
      sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, account_type TEXT, currency TEXT,
      initial_balance REAL DEFAULT 0, note TEXT, credit_limit REAL, billing_day INTEGER, payment_due_day INTEGER,
      bank_name TEXT, card_last_four TEXT, hidden INTEGER DEFAULT 0, source_change_id INTEGER DEFAULT 0
    );
    CREATE TABLE user_category_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, kind TEXT, level INTEGER, sort_order INTEGER, icon TEXT, icon_type TEXT, custom_icon_path TEXT, icon_cloud_file_id TEXT, icon_cloud_sha256 TEXT, parent_name TEXT, parent_sync_id TEXT, source_change_id INTEGER DEFAULT 0);
    CREATE TABLE user_tag_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, color TEXT, source_change_id INTEGER);
    CREATE TABLE user_exchange_rate_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, base_currency TEXT, quote_currency TEXT, rate REAL);
    CREATE TABLE audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, ledger_id TEXT, action TEXT, metadata_json TEXT, created_at TEXT);
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

  sqlite.prepare("INSERT INTO users (id, email, password_hash, is_admin) VALUES ('user-1', 'vc@x.com', 'x', 0)").run();
  sqlite.prepare("INSERT INTO devices (id, user_id, name, platform, app_version, created_at) VALUES ('d1', 'user-1', 'phone', 'ios', '4.0.1', '2025-01-01T00:00:00Z')").run();
  sqlite.prepare("INSERT INTO ledgers (id, user_id, external_id, name, currency, created_at) VALUES ('ledger-1', 'user-1', 'lg1', 'L', 'CNY', '2025-01-01T00:00:00Z')").run();
  sqlite.prepare("INSERT INTO ledger_members (ledger_id, user_id, role, joined_at) VALUES ('ledger-1', 'user-1', 'owner', '2025-01-01T00:00:00Z')").run();

  app = new Hono<{ Bindings: { DB: D1Database; JWT_SECRET: string }; Variables: { userId: string } }>();
  app.use('*', async (c, next) => {
    c.set('userId', 'user-1');
    await next();
  });
  app.route('/api/v1/sync', syncRouter);
});

afterEach(() => sqlite.close());

function deviceRow(id: string): { app_version: string | null } | undefined {
  return sqlite.prepare('SELECT app_version FROM devices WHERE id = ?').get(id) as { app_version: string | null } | undefined;
}

describe('版本解析(移植上游 test_parse_semver_and_comparison)', () => {
  it('parseSemver 解析前导 X.Y.Z', () => {
    expect(parseSemver('4.1.0')).toEqual([4, 1, 0]);
    expect(parseSemver('v4.1.0+123')).toEqual([4, 1, 0]);
    expect(parseSemver('4.1.0 (123)')).toEqual([4, 1, 0]);
    expect(parseSemver('4.1.0-beta.2')).toEqual([4, 1, 0]);
    expect(parseSemver('web-1.11.0')).toBeNull();
    expect(parseSemver('')).toBeNull();
    expect(parseSemver(null)).toBeNull();
    expect(parseSemver(undefined)).toBeNull();
  });

  it('isVersionBelow 仅在两侧可解析、major>0 且 current<required 时为真', () => {
    expect(isVersionBelow('3.9.9', '4.0.0')).toBe(true);
    expect(isVersionBelow('0.0.1', '4.0.0')).toBe(false);
    expect(isVersionBelow('4.0.0+1', '4.0.0')).toBe(false);
    expect(isVersionBelow('4.1.0', '4.0.0')).toBe(false);
    expect(isVersionBelow('web-1.0.0', '4.0.0')).toBe(false);
    expect(isVersionBelow(null, '4.0.0')).toBe(false);
  });

  it('resolveVersionPolicy 支持 env 覆盖并有默认值', () => {
    expect(resolveVersionPolicy().minAppVersion).toBe('4.0.0');
    expect(resolveVersionPolicy().recommendedAppVersion).toBe('4.1.0');
    expect(resolveVersionPolicy({ MIN_APP_VERSION: '4.1.0', RECOMMENDED_APP_VERSION: '4.2.0' }).minAppVersion).toBe('4.1.0');
    expect(resolveVersionPolicy({ APP_VERSION: '1.11.0' }).version).toBe('1.11.0');
  });
});

describe('/version 公开端点(移植上游 test_public_version_exposes_app_compatibility_policy)', () => {
  it('下发 min_app_version / recommended_app_version + capabilities', async () => {
    // fullApp 的全局中间件会跑 ensureInitialized，需要真实 D1 适配器
    const real = createRealDb();
    const res = await fullApp.request('/api/v1/version', {}, {
      DB: real.db,
      JWT_SECRET: 'x',
      APP_VERSION: '1.11.0',
      MIN_APP_VERSION: '4.0.0',
      RECOMMENDED_APP_VERSION: '4.1.0',
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.version).toBe('1.11.0');
    expect(body.min_app_version).toBe('4.0.0');
    expect(body.recommended_app_version).toBe('4.1.0');
    expect(body.capabilities).toContain('recurring_rules_v1');
  });
});

describe('同步从请求头刷新 App 版本(移植上游 test_sync_refreshes_device_app_version_from_header)', () => {
  it('pull 命中 header → 落库;push 再次刷新', async () => {
    const pullRes = await app.request('/api/v1/sync/pull?since=0&device_id=d1', {
      headers: { 'X-BeeCount-App-Version': '4.1.0+410' },
    }, { DB: db, JWT_SECRET: 'x' });
    expect(pullRes.status).toBe(200);
    expect(deviceRow('d1')?.app_version).toBe('4.1.0+410');

    const pushRes = await app.request('/api/v1/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-BeeCount-App-Version': '4.1.1' },
      body: JSON.stringify({ device_id: 'd1', changes: [] }),
    }, { DB: db, JWT_SECRET: 'x' });
    expect(pushRes.status).toBe(200);
    expect(deviceRow('d1')?.app_version).toBe('4.1.1');
  });
});

describe('低于最低版本的 App 被拦截(移植上游 test_sync_rejects_app_below_min_version_with_426)', () => {
  const env = {
    DB: null as unknown as D1Database,
    JWT_SECRET: 'x',
    APP_VERSION: '1.12.0',
    MIN_APP_VERSION: '4.1.0',
    RECOMMENDED_APP_VERSION: '4.2.0',
  };

  beforeEach(() => {
    env.DB = db;
  });

  it('1. header 低于 min → push/pull/full 全部 426,响应体含完整策略字段', async () => {
    const pushRes = await app.request('/api/v1/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-BeeCount-App-Version': '4.0.1' },
      body: JSON.stringify({ device_id: 'd1', changes: [] }),
    }, env);
    expect(pushRes.status).toBe(426);
    const body = await pushRes.json() as Record<string, any>;
    expect(body.error.code).toBe('APP_UPGRADE_REQUIRED');
    expect(body.code).toBe('app_upgrade_required');
    expect(body.min_app_version).toBe('4.1.0');
    expect(body.recommended_app_version).toBe('4.2.0');
    expect(body.server_version).toBe('1.12.0');
    expect(body.client_app_version).toBe('4.0.1');

    // 2. 无 header 的移动端 → 回退用落库的 app_version 拦截
    const pullRes = await app.request('/api/v1/sync/pull?since=0&device_id=d1', {}, env);
    expect(pullRes.status).toBe(426);

    const fullRes = await app.request('/api/v1/sync/full?ledger_id=ledger-1', {
      headers: { 'X-BeeCount-App-Version': '4.0.1' },
    }, env);
    expect(fullRes.status).toBe(426);
  });

  it('3. 升级到 >= min 后恢复同步,且 Device.app_version 被刷新', async () => {
    const upgraded = await app.request('/api/v1/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-BeeCount-App-Version': '4.1.0' },
      body: JSON.stringify({ device_id: 'd1', changes: [] }),
    }, env);
    expect(upgraded.status).toBe(200);
    expect(deviceRow('d1')?.app_version).toBe('4.1.0');
  });

  it('4. web 平台设备不受移动端最低版本约束', async () => {
    sqlite.prepare("INSERT INTO devices (id, user_id, name, platform, app_version, created_at) VALUES ('d2', 'user-1', 'browser', 'web', '1.12.0', '2025-01-01T00:00:00Z')").run();
    const webPull = await app.request('/api/v1/sync/pull?since=0&device_id=d2', {}, env);
    expect(webPull.status).toBe(200);
  });
});
