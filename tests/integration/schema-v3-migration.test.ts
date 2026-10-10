import { describe, it, expect } from 'vitest';
import { createRealDb } from '../helpers/realsql-db';
import { initializeDatabase } from '../../src/db/schema';

// SCHEMA v3/v4 迁移（对齐原版 Alembic）：用真实 SQLite 验证存量库(v2 结构)
// 迁移后数据不丢——mock-db 的 getTable 直接改内存数组，不求值真实 SQL，
// 回填 UPDATE / INSERT SELECT / 重建 RENAME 的语义必须由真实引擎验证。
const V2_TABLES = `
  CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, is_admin INTEGER DEFAULT 0, is_enabled INTEGER DEFAULT 1, created_at TEXT);
  CREATE TABLE ledgers (id TEXT PRIMARY KEY, user_id TEXT, external_id TEXT, name TEXT, currency TEXT);
  CREATE TABLE ledger_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ledger_id TEXT NOT NULL, user_id TEXT NOT NULL,
    role TEXT DEFAULT 'editor' NOT NULL, joined_at TEXT NOT NULL,
    UNIQUE(ledger_id, user_id)
  );
  CREATE TABLE ledger_invites (
    id TEXT PRIMARY KEY, ledger_id TEXT NOT NULL, code TEXT UNIQUE NOT NULL,
    target_role TEXT DEFAULT 'editor' NOT NULL, invited_by TEXT NOT NULL,
    expires_at TEXT NOT NULL, used_at TEXT, used_by TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE backup_remotes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, backend_type TEXT NOT NULL,
    config_summary TEXT NOT NULL, encrypted INTEGER DEFAULT 0 NOT NULL,
    last_test_at TEXT, last_test_ok INTEGER, last_test_error TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE backup_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, schedule_id INTEGER, user_id TEXT,
    ledger_id TEXT NOT NULL, remote_id INTEGER, status TEXT NOT NULL DEFAULT 'pending',
    error_message TEXT, log_text TEXT, bytes_total INTEGER, backup_filename TEXT,
    backup_path TEXT, started_at TEXT NOT NULL, finished_at TEXT
  );
`;

function freshV2Db(seed: (sqlite: any) => void) {
  const { sqlite, db } = createRealDb();
  sqlite.exec(V2_TABLES);
  seed(sqlite);
  return { sqlite, db };
}

function colNames(sqlite: any, table: string): string[] {
  return (sqlite.prepare(`PRAGMA table_info(${table})`).all() as any[]).map((c) => c.name);
}

describe('SCHEMA v3/v4 迁移（真实 SQLite 数据安全）', () => {
  it('v2 库迁移：ledger_members/ledger_invites 重建保留数据 + invited_by 回填 + 主键改造', async () => {
    const { sqlite, db } = freshV2Db((s) => {
      s.exec(`
        INSERT INTO users (id, email, password_hash, is_admin, created_at) VALUES
          ('u-admin', 'a@x.com', 'x', 1, '2025-01-01T00:00:00Z'),
          ('u-owner', 'o@x.com', 'x', 0, '2025-01-01T00:00:00Z'),
          ('u-member', 'm@x.com', 'x', 0, '2025-01-01T00:00:00Z');
        INSERT INTO ledgers (id, user_id, external_id, name, currency) VALUES ('l1', 'u-owner', 'l1', 'L', 'CNY');
        INSERT INTO ledger_members (id, ledger_id, user_id, role, joined_at) VALUES
          (1, 'l1', 'u-owner', 'owner', '2025-01-01T00:00:00Z'),
          (2, 'l1', 'u-member', 'editor', '2025-01-02T00:00:00Z');
        INSERT INTO ledger_invites (id, ledger_id, code, target_role, invited_by, expires_at, used_at, used_by, created_at) VALUES
          ('inv-1', 'l1', 'ABC123', 'editor', 'u-owner', '2030-01-01T00:00:00Z', '2025-01-02T00:00:00Z', 'u-member', '2025-01-01T00:00:00Z');
      `);
    });

    await initializeDatabase(db as any);
    // 幂等：再次初始化（模拟中途失败后的重试/冷启动）不报错、不重复迁移
    await initializeDatabase(db as any);

    // 成员数据保留 + 复合主键结构（无自增 id 列）
    const memberCols = colNames(sqlite, 'ledger_members');
    expect(memberCols).not.toContain('id');
    const members = sqlite.prepare('SELECT ledger_id, user_id, role, invited_by FROM ledger_members ORDER BY user_id').all() as any[];
    expect(members).toHaveLength(2);
    const byUser = Object.fromEntries(members.map((m) => [m.user_id, m]));
    expect(byUser['u-member']).toMatchObject({ ledger_id: 'l1', role: 'editor' });
    // invited_by 由真实 SQL 子查询从 ledger_invites 回填（u-member 由 u-owner 邀请）
    expect(byUser['u-member'].invited_by).toBe('u-owner');

    // 邀请数据保留 + code 主键（无 id 列）
    const inviteCols = colNames(sqlite, 'ledger_invites');
    expect(inviteCols).not.toContain('id');
    const invites = sqlite.prepare('SELECT code, ledger_id, invited_by, used_by FROM ledger_invites').all() as any[];
    expect(invites).toHaveLength(1);
    expect(invites[0]).toMatchObject({ code: 'ABC123', ledger_id: 'l1', invited_by: 'u-owner', used_by: 'u-member' });
  });

  it('v2 库迁移：backup_remotes 加 user_id 回填管理员 + backup_runs R2 key 回填 backup_artifacts（幂等）', async () => {
    const { sqlite, db } = freshV2Db((s) => {
      s.exec(`
        INSERT INTO users (id, email, password_hash, is_admin, created_at) VALUES ('u-admin', 'a@x.com', 'x', 1, '2025-01-01T00:00:00Z');
        INSERT INTO ledgers (id, user_id, external_id, name, currency) VALUES ('l1', 'u-admin', 'l1', 'L', 'CNY');
        INSERT INTO backup_remotes (id, name, backend_type, config_summary, encrypted, created_at, updated_at) VALUES
          (1, 'r2-main', 'r2', '{}', 0, '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z'),
          (2, 'webdav-a', 'webdav', '{}', 0, '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z');
        INSERT INTO backup_runs (id, user_id, ledger_id, status, bytes_total, backup_filename, backup_path, started_at) VALUES
          (10, 'u-admin', 'l1', 'succeeded', 100, 'x.tar.gz', 'beecount/backups/u-admin/folder/20250101-x.tar.gz', '2025-01-01T00:00:00Z'),
          (11, 'u-admin', 'l1', 'succeeded', 200, 'y.tar.gz', NULL, '2025-01-01T00:00:00Z');
      `);
    });

    await initializeDatabase(db as any);
    await initializeDatabase(db as any);

    // remotes 全部回填给管理员（真实 ALTER TABLE ADD COLUMN + UPDATE，幂等）
    const remotes = sqlite.prepare('SELECT name, user_id FROM backup_remotes ORDER BY id').all() as any[];
    expect(remotes).toHaveLength(2);
    expect(remotes.every((r) => r.user_id === 'u-admin')).toBe(true);

    // 有 backup_path 的 run 的 R2 key 进 backup_artifacts.storage_path（删列后恢复仍可定位）
    const artifacts = sqlite.prepare('SELECT user_id, kind, file_name, storage_path FROM backup_artifacts').all() as any[];
    const withKey = artifacts.filter((a) => a.storage_path);
    expect(withKey).toHaveLength(1);
    expect(withKey[0]).toMatchObject({
      user_id: 'u-admin',
      kind: 'db',
      file_name: 'x.tar.gz',
      storage_path: 'beecount/backups/u-admin/folder/20250101-x.tar.gz',
    });
    // 无 backup_path 的 run 不产生 artifact
    expect(artifacts).toHaveLength(1);
  });

  it('全新库初始化直接得到 v4 结构，不触发迁移，版本号=4', async () => {
    const { sqlite, db } = createRealDb();
    await initializeDatabase(db as any);
    expect(sqlite.prepare('SELECT COUNT(*) c FROM ledger_members').get().c).toBe(0);
    expect(sqlite.prepare('SELECT COUNT(*) c FROM ledger_invites').get().c).toBe(0);
    expect(sqlite.prepare('SELECT COUNT(*) c FROM backup_remotes').get().c).toBe(0);
    const meta = sqlite.prepare("SELECT value FROM app_metadata WHERE key = 'schema_version'").get() as any;
    expect(meta.value).toBe('4');
  });
});
