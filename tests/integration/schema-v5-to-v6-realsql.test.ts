import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { initializeDatabase, SCHEMA_VERSION } from '../../src/db/schema';
import { createRealDb } from '../helpers/realsql-db';

/**
 * v5 → v6 迁移演练（真实 SQLite）：
 * - 旧库已有 backup_schedules（无 cron_effective_at 列）与历史审计
 * - initializeDatabase 必须：版本升到 6、安全加列、按 alembic/0024 语义回填
 *   （有编辑审计 → 最近一次编辑时间；否则 created_at）
 * - 4 张 1.10.x 新表必须创建
 */

let sqlite: DatabaseSync;
let db: D1Database;

beforeEach(() => {
  const real = createRealDb();
  sqlite = real.sqlite;
  db = real.db;

  // 最小旧库（v5）：仅保留迁移涉及的表
  sqlite.exec(`
    CREATE TABLE app_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
    );
    CREATE TABLE users (
      id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      is_admin BOOLEAN DEFAULT 0 NOT NULL, is_enabled BOOLEAN DEFAULT 1 NOT NULL,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
      totp_secret_encrypted TEXT, totp_enabled BOOLEAN DEFAULT 0 NOT NULL, totp_enabled_at TEXT
    );
    CREATE TABLE audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, ledger_id TEXT, action TEXT NOT NULL,
      metadata_json TEXT NOT NULL, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
    );
    CREATE TABLE backup_schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      user_id TEXT NOT NULL,
      cron_expr TEXT NOT NULL,
      retention_days INTEGER DEFAULT 30 NOT NULL,
      include_attachments BOOLEAN DEFAULT 1 NOT NULL,
      enabled BOOLEAN DEFAULT 1 NOT NULL,
      next_run_at TEXT,
      last_run_at TEXT,
      last_run_status TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  sqlite.prepare("INSERT INTO app_metadata (key, value) VALUES ('schema_version', '5')").run();
  sqlite.prepare("INSERT INTO users (id, email, password_hash) VALUES ('u1', 'v5@example.com', 'x')").run();
  sqlite.prepare(
    `INSERT INTO backup_schedules (id, name, user_id, cron_expr, created_at, updated_at)
     VALUES (1, '有编辑审计', 'u1', '0 3 * * *', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
  ).run();
  sqlite.prepare(
    `INSERT INTO backup_schedules (id, name, user_id, cron_expr, created_at, updated_at)
     VALUES (2, '无编辑审计', 'u1', '0 4 * * *', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`
  ).run();
  sqlite.prepare(
    `INSERT INTO audit_logs (user_id, action, metadata_json, created_at)
     VALUES ('u1', 'backup_schedule_update', '{"scheduleId":1}', '2026-02-01T08:00:00.000Z')`
  ).run();
  sqlite.prepare(
    `INSERT INTO audit_logs (user_id, action, metadata_json, created_at)
     VALUES ('u1', 'backup_schedule_update', '{"scheduleId":1}', '2026-03-15T09:30:00.000Z')`
  ).run();
});

afterEach(() => sqlite.close());

describe('schema v5 → v6 迁移（真实 SQLite）', () => {
  it('版本升级、cron_effective_at 加列与回填、新表创建全部正确', async () => {
    await initializeDatabase(db);

    const version = sqlite
      .prepare("SELECT value FROM app_metadata WHERE key = 'schema_version'")
      .get() as { value: string };
    expect(version.value).toBe(String(SCHEMA_VERSION));
    expect(SCHEMA_VERSION).toBe(6);

    const columns = (sqlite.prepare('PRAGMA table_info(backup_schedules)').all() as Array<{ name: string }>)
      .map((c) => c.name);
    expect(columns).toContain('cron_effective_at');

    const rows = sqlite
      .prepare('SELECT id, cron_effective_at FROM backup_schedules ORDER BY id')
      .all() as Array<{ id: number; cron_effective_at: string }>;
    // 有编辑审计 → 取最近一次编辑时间（不是 created_at）
    expect(rows[0].cron_effective_at).toBe('2026-03-15T09:30:00.000Z');
    // 无编辑审计 → 退回 created_at
    expect(rows[1].cron_effective_at).toBe('2026-01-02T00:00:00.000Z');

    const tables = (sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>).map((t) => t.name);
    for (const t of [
      'user_notification_reads',
      'device_sync_failures',
      'transaction_move_receipts',
      'transaction_move_retirements',
    ]) {
      expect(tables).toContain(t);
    }
  });

  it('迁移幂等：再次初始化不改动已回填的值', async () => {
    await initializeDatabase(db);
    const before = sqlite
      .prepare('SELECT id, cron_effective_at FROM backup_schedules ORDER BY id')
      .all();

    // 强制版本回退到 5，模拟重复迁移
    sqlite.prepare("UPDATE app_metadata SET value = '5' WHERE key = 'schema_version'").run();
    await initializeDatabase(db);

    const after = sqlite
      .prepare('SELECT id, cron_effective_at FROM backup_schedules ORDER BY id')
      .all();
    expect(after).toEqual(before);
    const version = sqlite
      .prepare("SELECT value FROM app_metadata WHERE key = 'schema_version'")
      .get() as { value: string };
    expect(version.value).toBe('6');
  });
});
