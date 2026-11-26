import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import notificationsRouter from '../../src/routes/notifications';
import devicesRouter from '../../src/routes/devices';
import { createRealDb, WRITE_PATH_TABLES } from '../helpers/realsql-db';

/**
 * 个人通知中心 + 设备同步健康（对齐上游 1.10.x），真实 SQLite 全链路。
 */

let sqlite: DatabaseSync;
let db: D1Database;
let app: Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string; scopes: string[] } }>;

const NOTIFICATION_TABLES = `
  CREATE TABLE system_settings (id TEXT PRIMARY KEY, timezone_offset INTEGER DEFAULT 0);
  CREATE TABLE backup_schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, user_id TEXT NOT NULL,
    cron_expr TEXT NOT NULL, retention_days INTEGER DEFAULT 30, include_attachments BOOLEAN DEFAULT 1,
    enabled BOOLEAN DEFAULT 1, next_run_at TEXT, last_run_at TEXT, last_run_status TEXT,
    cron_effective_at TEXT,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
    updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
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
`;

function sqliteQuery<T>(sql: string, ...args: any[]): T[] {
  return sqlite.prepare(sql).all(...args) as T[];
}

async function getNotifications(extraHeaders: Record<string, string> = {}) {
  const res = await app.request('/api/v1/notifications', {
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  }, { DB: db });
  return { status: res.status, json: (await res.json()) as any };
}

async function markRead(ids: string[]) {
  const res = await app.request('/api/v1/notifications/read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  }, { DB: db });
  return res.status;
}

beforeEach(() => {
  const real = createRealDb();
  sqlite = real.sqlite;
  db = real.db;
  sqlite.exec(WRITE_PATH_TABLES);
  sqlite.exec(NOTIFICATION_TABLES);
  // is_admin 列在 WRITE_PATH_TABLES 里已存在（BOOLEAN DEFAULT 0）
  sqlite.prepare("INSERT INTO users (id, email, password_hash, is_admin) VALUES ('user-1', 'n@example.com', 'x', 1)").run();
  sqlite.prepare("INSERT INTO users (id, email, password_hash, is_admin) VALUES ('user-2', 'plain@example.com', 'x', 0)").run();
  sqlite.prepare("INSERT INTO system_settings (id, timezone_offset) VALUES ('default', 0)").run();
  sqlite.prepare("INSERT INTO devices (id, user_id, name, platform, revoked_at, created_at) VALUES ('dev-1', 'user-1', 'My Phone', 'android', NULL, '2025-01-01T00:00:00Z')").run();
  sqlite.prepare("INSERT INTO devices (id, user_id, name, platform, revoked_at, created_at) VALUES ('dev-2', 'user-2', 'Other', 'ios', NULL, '2025-01-01T00:00:00Z')").run();

  app = new Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string; scopes: string[] } }>();
  app.use('*', async (c, next) => {
    c.set('userId', c.req.header('X-Test-User') ?? 'user-1');
    c.set('scopes', (c.req.header('X-Test-Scopes') ?? 'web_read,web_write').split(','));
    await next();
  });
  app.route('/api/v1/notifications', notificationsRouter);
  app.route('/api/v1/devices', devicesRouter);
});

afterEach(() => sqlite.close());

describe('通知中心（真实 SQLite，对齐上游 1.10.x）', () => {
  it('无任何异常 → 空数组', async () => {
    const { status, json } = await getNotifications();
    expect(status).toBe(200);
    expect(json).toEqual([]);
  });

  it('分类缺父级 → category_missing_parent 通知，标记已读后 unread=false', async () => {
    sqlite.prepare(
      `INSERT INTO user_category_projection
       (sync_id, user_id, name, kind, level, sort_order, parent_name, parent_sync_id, source_change_id)
       VALUES ('cat-child', 'user-1', '咖啡', 'expense', 2, 1, NULL, 'missing-parent', 12)`
    ).run();

    const first = await getNotifications();
    expect(first.status).toBe(200);
    expect(first.json).toHaveLength(1);
    const notice = first.json[0];
    expect(notice.type).toBe('category_missing_parent');
    expect(notice.count).toBe(1);
    expect(notice.categories[0]).toEqual({ id: 'cat-child', name: '咖啡', parent_name: null });
    expect(notice.unread).toBe(true);

    expect(await markRead([notice.id])).toBe(204);
    const second = await getNotifications();
    expect(second.json[0].unread).toBe(false);
  });

  it('管理员：备份计划逾期 → backup_schedule_issue(overdue)', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    sqlite.prepare(
      `INSERT INTO backup_schedules (name, user_id, cron_expr, enabled, cron_effective_at)
       VALUES ('每日备份', 'user-1', '* * * * *', 1, ?)`
    ).run(twoHoursAgo);

    const { json } = await getNotifications();
    expect(json).toHaveLength(1);
    expect(json[0].type).toBe('backup_schedule_issue');
    expect(json[0].reason).toBe('overdue');
    expect(json[0].schedule_name).toBe('每日备份');
    expect(json[0].run_id).toBeNull();
  });

  it('管理员：连续两次失败 → backup_schedule_issue(failed, count=2)', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    sqlite.prepare(
      `INSERT INTO backup_schedules (id, name, user_id, cron_expr, enabled, cron_effective_at)
       VALUES (1, '每日备份', 'user-1', '0 3 * * *', 1, ?)`
    ).run(twoHoursAgo);
    const now = new Date().toISOString();
    sqlite.prepare(
      `INSERT INTO backup_runs (schedule_id, user_id, status, started_at, finished_at)
       VALUES (1, 'user-1', 'failed', ?, ?), (1, 'user-1', 'failed', ?, ?)`
    ).run(now, now, now, now);

    const { json } = await getNotifications();
    expect(json).toHaveLength(1);
    expect(json[0].type).toBe('backup_schedule_issue');
    expect(json[0].reason).toBe('failed');
    expect(json[0].count).toBe(2);
    expect(json[0].run_id).toBeGreaterThan(0);
  });

  it('非管理员不产生备份通知', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    sqlite.prepare(
      `INSERT INTO backup_schedules (name, user_id, cron_expr, enabled, cron_effective_at)
       VALUES ('每日备份', 'user-2', '* * * * *', 1, ?)`
    ).run(twoHoursAgo);

    const { json } = await getNotifications({ 'X-Test-User': 'user-2' });
    expect(json).toEqual([]);
  });

  it('设备同步连续失败 ≥3 → device_sync_failure，带 direction/count/receipt_ids', async () => {
    const t = new Date().toISOString();
    sqlite.prepare(
      `INSERT INTO device_sync_failures (device_id, direction, incident_id, failure_count, reason, first_failed_at, last_failed_at)
       VALUES ('dev-1', 'push', 'inc-1', 3, 'changes_rejected', ?, ?)`
    ).run(t, t);

    const { json } = await getNotifications();
    expect(json).toHaveLength(1);
    expect(json[0].type).toBe('device_sync_failure');
    expect(json[0].device_id).toBe('dev-1');
    expect(json[0].device_name).toBe('My Phone');
    expect(json[0].failures[0].direction).toBe('push');
    expect(json[0].failures[0].count).toBe(3);
    // 上游 Notice.receipt_ids 标记 exclude=True：回执键只在服务端内部使用，响应不输出
    expect(json[0]).not.toHaveProperty('receipt_ids');
  });

  it('失败计数 2 次（未达阈值）不产生通知', async () => {
    const t = new Date().toISOString();
    sqlite.prepare(
      `INSERT INTO device_sync_failures (device_id, direction, incident_id, failure_count, reason, first_failed_at, last_failed_at)
       VALUES ('dev-1', 'pull', 'inc-2', 2, 'server_error', ?, ?)`
    ).run(t, t);

    const { json } = await getNotifications();
    expect(json).toEqual([]);
  });

  it('devices/:id/sync-health 返回失败明细；他人设备 404', async () => {
    const t = new Date().toISOString();
    sqlite.prepare(
      `INSERT INTO device_sync_failures (device_id, direction, incident_id, failure_count, reason, first_failed_at, last_failed_at)
       VALUES ('dev-1', 'push', 'inc-1', 4, 'changes_rejected', ?, ?)`
    ).run(t, t);

    const res = await app.request('/api/v1/devices/dev-1/sync-health', { headers: {} }, { DB: db });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.device_id).toBe('dev-1');
    expect(body.device_name).toBe('My Phone');
    expect(body.failures).toHaveLength(1);
    expect(body.failures[0]).toMatchObject({ direction: 'push', count: 4, reason: 'changes_rejected' });

    const other = await app.request('/api/v1/devices/dev-2/sync-health', { headers: {} }, { DB: db });
    expect(other.status).toBe(404);
  });

  it('宽松模式（默认）：app_write 令牌可读通知（兼容老会话）', async () => {
    const { status, json } = await getNotifications({ 'X-Test-Scopes': 'app_write' });
    expect(status).toBe(200);
    expect(Array.isArray(json)).toBe(true);
  });

  it('严格模式（ALLOW_APP_RW_SCOPES=false）：app_write 令牌 → 403', async () => {
    const res = await app.request('/api/v1/notifications', {
      headers: { 'X-Test-Scopes': 'app_write' },
    }, { DB: db, ALLOW_APP_RW_SCOPES: 'false' } as any);
    expect(res.status).toBe(403);
  });
});
