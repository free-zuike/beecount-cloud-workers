import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import notificationsRouter from '../src/routes/notifications';
import devicesRouter from '../src/routes/devices';
import moveRouter from '../src/routes/transactions_move';
import { createRealDb, WRITE_PATH_TABLES } from './helpers/realsql-db';

/**
 * 1.10.x 新端点差分：通知中心 / 同步健康 / 跨账本移动。
 * 夹具、归一化口径与 scripts/parity/upstream_dump.py 新增段完全一致；
 * golden 由上游 1.10.1 直接调用路由函数生成（tests/fixtures/upstream-notifications-golden.json /
 * upstream-move-golden.json）。
 */

const NOTIFICATIONS_GOLDEN_PATH = join(process.cwd(), 'tests/fixtures/upstream-notifications-golden.json');
const MOVE_GOLDEN_PATH = join(process.cwd(), 'tests/fixtures/upstream-move-golden.json');
const hasGolden = existsSync(NOTIFICATIONS_GOLDEN_PATH) && existsSync(MOVE_GOLDEN_PATH);

const notificationsGolden = hasGolden
  ? JSON.parse(readFileSync(NOTIFICATIONS_GOLDEN_PATH, 'utf-8'))
  : { notices: [], notices_after_read: [], notices_non_admin: [], sync_health: null };
const moveGolden = hasGolden
  ? JSON.parse(readFileSync(MOVE_GOLDEN_PATH, 'utf-8'))
  : { prepare: [], errors: {}, move: null, replay_matches: false, after_move: {} };

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const NOTICE_ID_RE = /^([a-z_]+):[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function norm(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = norm(x);
    return out;
  }
  if (typeof v === 'string') {
    if (ISO_RE.test(v)) return '<ts>';
    const m = NOTICE_ID_RE.exec(v);
    if (m) return `${m[1]}:<hash>`;
    if (UUID_RE.test(v)) return '<uuid>';
  }
  return v;
}

let sqlite: DatabaseSync;
let db: D1Database;
let app: Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string; scopes: string[] } }>;

const EXTRA_TABLES = `
  CREATE TABLE system_settings (id TEXT PRIMARY KEY, timezone_offset INTEGER DEFAULT 0);
  CREATE TABLE backup_schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, user_id TEXT NOT NULL,
    cron_expr TEXT NOT NULL, retention_days INTEGER DEFAULT 30, include_attachments BOOLEAN DEFAULT 1,
    enabled BOOLEAN DEFAULT 1, next_run_at TEXT, last_run_at TEXT, last_run_status TEXT,
    cron_effective_at TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE backup_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, schedule_id INTEGER, user_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', started_at TEXT, finished_at TEXT
  );
  CREATE TABLE user_notification_reads (
    user_id TEXT NOT NULL, notification_id TEXT NOT NULL, PRIMARY KEY (user_id, notification_id)
  );
  CREATE TABLE device_sync_failures (
    device_id TEXT NOT NULL, direction TEXT NOT NULL, incident_id TEXT NOT NULL,
    failure_count INTEGER NOT NULL, reason TEXT NOT NULL, first_failed_at TEXT NOT NULL,
    last_failed_at TEXT NOT NULL, PRIMARY KEY (device_id, direction)
  );
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

const T0 = '2026-01-15T10:00:00.000Z';
const T1 = '2026-01-16T03:00:00.000Z';
const T2 = '2026-01-17T03:00:00.000Z';

async function request(path: string, init: RequestInit = {}, userId = 'u1', scopes = 'web_read,web_write,app_write') {
  const res = await app.request(
    path,
    {
      ...init,
      headers: { 'Content-Type': 'application/json', 'X-Test-User': userId, 'X-Test-Scopes': scopes, ...(init.headers ?? {}) },
    },
    { DB: db }
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
  sqlite.prepare("INSERT INTO system_settings (id, timezone_offset) VALUES ('default', 0)").run();
  sqlite.prepare("INSERT INTO users (id, email, password_hash, is_admin) VALUES ('u1', 'u1@example.com', 'x', 1)").run();
  sqlite.prepare("INSERT INTO users (id, email, password_hash, is_admin) VALUES ('u2', 'u2@example.com', 'x', 0)").run();

  // 通知场景种子（与 dump 脚本完全一致）
  sqlite.prepare("INSERT INTO devices (id, user_id, name, platform, revoked_at, created_at) VALUES ('d1', 'u1', 'My Phone', 'android', NULL, ?)").run(T0);
  sqlite.prepare(
    "INSERT INTO device_sync_failures (device_id, direction, incident_id, failure_count, reason, first_failed_at, last_failed_at) VALUES ('d1', 'push', 'inc-1', 3, 'changes_rejected', ?, ?)"
  ).run(T0, T1);
  sqlite.prepare(
    "INSERT INTO device_sync_failures (device_id, direction, incident_id, failure_count, reason, first_failed_at, last_failed_at) VALUES ('d1', 'pull', 'inc-2', 1, 'server_error', ?, ?)"
  ).run(T0, T0);
  sqlite.prepare(
    "INSERT INTO user_category_projection (sync_id, user_id, name, kind, level, source_change_id) VALUES ('cat-parent', 'u1', '餐饮', 'expense', 1, 5)"
  ).run();
  sqlite.prepare(
    "INSERT INTO user_category_projection (sync_id, user_id, name, kind, level, parent_sync_id, source_change_id) VALUES ('cat-child-ok', 'u1', '午餐', 'expense', 2, 'cat-parent', 6)"
  ).run();
  sqlite.prepare(
    "INSERT INTO user_category_projection (sync_id, user_id, name, kind, level, parent_sync_id, source_change_id) VALUES ('cat-child-gone', 'u1', '咖啡', 'expense', 2, 'cat-gone', 7)"
  ).run();
  sqlite.prepare(
    "INSERT INTO sync_changes (change_id, user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id, updated_by_device_id, scope) VALUES (10, 'u1', NULL, 'category', 'cat-gone', 'delete', '{}', ?, 'u1', 'd1', 'user')"
  ).run(T0);
  sqlite.prepare(
    "INSERT INTO backup_schedules (id, name, user_id, cron_expr, enabled, cron_effective_at, created_at, updated_at) VALUES (1, '每日备份', 'u1', '0 3 * * *', 1, ?, ?, ?)"
  ).run(T0, T0, T0);
  sqlite.prepare(
    "INSERT INTO backup_runs (id, schedule_id, user_id, status, started_at, finished_at) VALUES (1, 1, 'u1', 'succeeded', '2026-01-14T03:00:00.000Z', '2026-01-14T03:05:00.000Z')"
  ).run();
  sqlite.prepare(
    "INSERT INTO backup_runs (id, schedule_id, user_id, status, started_at, finished_at) VALUES (2, 1, 'u1', 'failed', ?, ?)"
  ).run(T1, T1);
  sqlite.prepare(
    "INSERT INTO backup_runs (id, schedule_id, user_id, status, started_at, finished_at) VALUES (3, 1, 'u1', 'failed', ?, ?)"
  ).run(T2, T2);

  // 移动场景帐本/设备/交易种子（与 dump 脚本一致）
  for (const [lid, ext, name, cur] of [
    ['la', 'A', '账本A', 'CNY'],
    ['lb', 'B', '账本B', 'CNY'],
    ['lu', 'U', '美元账本', 'USD'],
    ['ls', 'S', '共享账本', 'CNY'],
  ]) {
    sqlite.prepare('INSERT INTO ledgers (id, user_id, external_id, name, currency) VALUES (?, ?, ?, ?, ?)').run(lid, 'u1', ext, name, cur);
    sqlite.prepare("INSERT INTO ledger_members (ledger_id, user_id, role, joined_at) VALUES (?, 'u1', 'owner', ?)").run(lid, T0);
  }
  sqlite.prepare("INSERT INTO ledger_members (ledger_id, user_id, role, joined_at) VALUES ('ls', 'u2', 'editor', ?)").run(T0);
  sqlite.prepare(
    `INSERT INTO read_tx_projection
     (ledger_id, sync_id, user_id, tx_type, amount, happened_at, note,
      category_sync_id, category_name, category_kind, tags_csv, tag_sync_ids_json,
      attachments_json, tx_index, source_change_id, exclude_from_stats, exclude_from_budget,
      created_by_user_id, last_edited_by_user_id, currency_code, native_amount)
     VALUES ('la', 'txm1', 'u1', 'expense', 12.5, ?, '午餐',
             'cat1', '餐饮', 'expense', 'tagA', '["tag-1"]',
             NULL, 1, 100, 0, 0, 'u1', 'u1', NULL, NULL)`
  ).run(T0);

  app = new Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string; scopes: string[] } }>();
  app.use('*', async (c, next) => {
    c.set('userId', c.req.header('X-Test-User') ?? 'u1');
    c.set('scopes', (c.req.header('X-Test-Scopes') ?? 'web_read,web_write,app_write').split(','));
    await next();
  });
  app.route('/api/v1/notifications', notificationsRouter);
  app.route('/api/v1/devices', devicesRouter);
  app.route('/api/v1/write', moveRouter);
});

afterEach(() => sqlite.close());

describe.skipIf(!hasGolden)('通知中心 / 同步健康 差分（vs 上游 1.10.1 golden）', () => {
  it('通知列表、标记已读、非管理员、sync-health 全部与上游一致', async () => {
    const listRes = await request('/api/v1/notifications');
    expect(listRes.status).toBe(200);
    expect(norm(listRes.json)).toEqual(notificationsGolden.notices);

    const firstId = listRes.json[0].id;
    const readRes = await request('/api/v1/notifications/read', {
      method: 'POST',
      body: JSON.stringify({ ids: [firstId] }),
    });
    expect(readRes.status).toBe(204);
    const afterRes = await request('/api/v1/notifications');
    expect(norm(afterRes.json)).toEqual(notificationsGolden.notices_after_read);

    const u2Res = await request('/api/v1/notifications', {}, 'u2', 'web_read');
    expect(norm(u2Res.json)).toEqual(notificationsGolden.notices_non_admin);

    const healthRes = await request('/api/v1/devices/d1/sync-health');
    expect(healthRes.status).toBe(200);
    expect(norm(healthRes.json)).toEqual(notificationsGolden.sync_health);
  });
});

describe.skipIf(!hasGolden)('跨账本移动 差分（vs 上游 1.10.1 golden）', () => {
  const OP = '00000000-0000-4000-8000-000000000001';

  async function prepare(target: string, ids: string[]) {
    return request('/api/v1/write/ledgers/A/transactions/batch/move/prepare', {
      method: 'POST',
      body: JSON.stringify({ target_ledger_id: target, transaction_ids: ids }),
    });
  }

  async function move(target: string, revision: number, op: string) {
    return request('/api/v1/write/ledgers/A/transactions/batch/move', {
      method: 'POST',
      headers: { 'X-Device-ID': 'd1', 'Idempotency-Key': op },
      body: JSON.stringify({ target_ledger_id: target, items: [{ sync_id: 'txm1', revision }] }),
    });
  }

  it('prepare 契约与上游一致（条件键 / txIndex / createdByUserId）', async () => {
    const res = await prepare('B', ['txm1']);
    expect(res.status).toBe(200);
    expect(norm(res.json)).toEqual(moveGolden.prepare);
  });

  it('错误分支与上游一致', async () => {
    const same = await request('/api/v1/write/ledgers/B/transactions/batch/move/prepare', {
      method: 'POST',
      body: JSON.stringify({ target_ledger_id: 'B', transaction_ids: ['txm1'] }),
    });
    expect({ status: same.status, detail: same.json.detail }).toEqual(moveGolden.errors.same_ledger);

    const currency = await prepare('U', ['txm1']);
    expect({ status: currency.status, detail: currency.json.detail }).toEqual(moveGolden.errors.currency);

    const shared = await prepare('S', ['txm1']);
    expect({ status: shared.status, detail: shared.json.detail }).toEqual(moveGolden.errors.shared);

    const duplicate = await prepare('B', ['txm1', 'txm1']);
    expect({ status: duplicate.status, detail: duplicate.json.detail }).toEqual(moveGolden.errors.duplicate);

    const missing = await prepare('B', ['nope']);
    expect({ status: missing.status, detail: missing.json.detail }).toEqual(moveGolden.errors.missing);

    const stale = await move('B', 999, '00000000-0000-4000-8000-000000000002');
    expect({ status: stale.status, detail: stale.json.detail }).toEqual(moveGolden.errors.stale_revision);
  });

  it('move 成功 + 幂等重放 + 复用拒绝 + 数据库终态与上游一致', async () => {
    const success = await move('B', 100, OP);
    expect(success.status).toBe(200);
    expect(norm(success.json)).toEqual(moveGolden.move);

    const replay = await move('B', 100, OP);
    expect(replay.status).toBe(200);
    expect(norm(replay.json)).toEqual(norm(success.json));
    expect(norm(success.json)).toEqual(norm(replay.json));
    expect(moveGolden.replay_matches).toBe(true);

    const reused = await move('U', 100, OP);
    expect({ status: reused.status, detail: reused.json.detail }).toEqual(moveGolden.errors.operation_reused);

    const after = moveGolden.after_move;
    const count = (sql: string, ...args: any[]) => (sqlite.prepare(sql).get(...args) as { c: number }).c;
    expect(count("SELECT COUNT(*) c FROM read_tx_projection WHERE ledger_id = 'la'")).toBe(after.source_rows);
    expect(count("SELECT COUNT(*) c FROM read_tx_projection WHERE ledger_id = 'lb'")).toBe(after.target_rows);
    expect(count("SELECT COUNT(*) c FROM read_tx_projection WHERE ledger_id = 'la' AND sync_id = 'txm1'")).toBe(after.source_tx_rows);
    expect(count('SELECT COUNT(*) c FROM transaction_move_retirements')).toBe(after.retirement_rows);
  });
});
