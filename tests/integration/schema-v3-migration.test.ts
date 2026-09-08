import { describe, it, expect } from 'vitest';
import { createMockDB, getTable } from '../helpers/mock-db';
import { initializeDatabase } from '../../src/db/schema';

// SCHEMA v3 迁移（对齐原版 Alembic 最终结构）：验证存量库(v2 结构)迁移后数据不丢
// 旧结构表用显式 CREATE TABLE 建（mock 注册表结构），模拟真实 v2 库
const V2_LEDGER_MEMBERS = `CREATE TABLE ledger_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT DEFAULT 'editor' NOT NULL,
  joined_at TEXT NOT NULL,
  UNIQUE(ledger_id, user_id)
)`;
const V2_LEDGER_INVITES = `CREATE TABLE ledger_invites (
  id TEXT PRIMARY KEY,
  ledger_id TEXT NOT NULL,
  code TEXT UNIQUE NOT NULL,
  target_role TEXT DEFAULT 'editor' NOT NULL,
  invited_by TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  used_by TEXT,
  created_at TEXT NOT NULL
)`;
const V2_BACKUP_REMOTES = `CREATE TABLE backup_remotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  backend_type TEXT NOT NULL,
  config_summary TEXT NOT NULL,
  encrypted BOOLEAN DEFAULT 0 NOT NULL,
  last_test_at TEXT,
  last_test_ok BOOLEAN,
  last_test_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;
const V2_BACKUP_RUNS = `CREATE TABLE backup_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id INTEGER,
  user_id TEXT,
  ledger_id TEXT NOT NULL,
  remote_id INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  log_text TEXT,
  bytes_total INTEGER,
  backup_filename TEXT,
  backup_path TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
)`;

async function seedTable(db: any, createSql: string, rows: Record<string, unknown>[]) {
  await db.prepare(createSql).run();
  const t = getTable(db, (createSql.match(/CREATE TABLE\s+(\w+)/) as RegExpMatchArray)[1]);
  t.push(...rows);
}

describe('SCHEMA v3 对齐原版迁移（数据安全）', () => {
  it('v2 库迁移：ledger_members/ledger_invites 重建保留数据 + invited_by 回填 + 主键改造', async () => {
    const db = createMockDB();
    getTable(db, 'users').push(
      { id: 'u-admin', email: 'a@x.com', is_admin: 1 },
      { id: 'u-owner', email: 'o@x.com', is_admin: 0 },
      { id: 'u-member', email: 'm@x.com', is_admin: 0 },
    );
    getTable(db, 'ledgers').push({ id: 'l1', user_id: 'u-owner', external_id: 'l1', name: 'L', currency: 'CNY' });
    await seedTable(db, V2_LEDGER_MEMBERS, [
      { id: 1, ledger_id: 'l1', user_id: 'u-owner', role: 'owner', joined_at: '2025-01-01T00:00:00Z' },
      { id: 2, ledger_id: 'l1', user_id: 'u-member', role: 'editor', joined_at: '2025-01-02T00:00:00Z' },
    ]);
    await seedTable(db, V2_LEDGER_INVITES, [{
      id: 'inv-1', ledger_id: 'l1', code: 'ABC123', target_role: 'editor',
      invited_by: 'u-owner', expires_at: '2030-01-01T00:00:00Z',
      used_at: '2025-01-02T00:00:00Z', used_by: 'u-member', created_at: '2025-01-01T00:00:00Z',
    }]);

    await initializeDatabase(db as any);

    // 成员数据保留 + 复合主键结构（无 id 列）
    const members = getTable(db, 'ledger_members');
    expect(members).toHaveLength(2);
    const byUser = Object.fromEntries(members.map(m => [m.user_id, m]));
    expect(byUser['u-member']).toMatchObject({ ledger_id: 'l1', role: 'editor' });
    // invited_by 从 ledger_invites 回填（u-member 由 u-owner 邀请）
    expect(byUser['u-member'].invited_by).toBe('u-owner');
    expect(members[0].id).toBeUndefined();

    // 邀请数据保留 + code 主键（无 id 列）
    const invites = getTable(db, 'ledger_invites');
    expect(invites).toHaveLength(1);
    expect(invites[0]).toMatchObject({ code: 'ABC123', ledger_id: 'l1', invited_by: 'u-owner', used_by: 'u-member' });
    expect(invites[0].id).toBeUndefined();
  });

  it('v2 库迁移：backup_remotes 加 user_id 回填管理员 + backup_runs R2 key 回填 backup_artifacts（幂等）', async () => {
    const db = createMockDB();
    getTable(db, 'users').push({ id: 'u-admin', email: 'a@x.com', is_admin: 1 });
    await seedTable(db, V2_BACKUP_REMOTES, [
      { id: 1, name: 'r2-main', backend_type: 'r2', config_summary: '{}', encrypted: 0 },
      { id: 2, name: 'webdav-a', backend_type: 'webdav', config_summary: '{}', encrypted: 0 },
    ]);
    await seedTable(db, V2_BACKUP_RUNS, [
      { id: 10, user_id: 'u-admin', ledger_id: 'l1', status: 'succeeded', bytes_total: 100, backup_filename: 'x.tar.gz', backup_path: 'beecount/backups/u-admin/folder/20250101-x.tar.gz' },
      { id: 11, user_id: 'u-admin', ledger_id: 'l1', status: 'succeeded', bytes_total: 200, backup_filename: 'y.tar.gz', backup_path: null },
    ]);

    await initializeDatabase(db as any);

    // remotes 全部回填给管理员
    const remotes = getTable(db, 'backup_remotes');
    expect(remotes).toHaveLength(2);
    expect(remotes.every(r => r.user_id === 'u-admin')).toBe(true);

    // 有 backup_path 的 run 的 R2 key 进 backup_artifacts.storage_path（删列后恢复仍可定位）
    const artifacts = getTable(db, 'backup_artifacts');
    const withKey = artifacts.filter(a => a.storage_path);
    expect(withKey).toHaveLength(1);
    expect(withKey[0]).toMatchObject({
      user_id: 'u-admin',
      kind: 'db',
      file_name: 'x.tar.gz',
      storage_path: 'beecount/backups/u-admin/folder/20250101-x.tar.gz',
    });
  });

  it('全新库初始化直接得到 v3 结构，不触发迁移，版本号=3', async () => {
    const db = createMockDB();
    await initializeDatabase(db as any);
    expect(getTable(db, 'ledger_members')).toHaveLength(0);
    expect(getTable(db, 'ledger_invites')).toHaveLength(0);
    expect(getTable(db, 'backup_remotes')).toHaveLength(0);
    expect(getTable(db, 'app_metadata').some(r => r.key === 'schema_version' && r.value === '3')).toBe(true);
  });
});
