import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import { initializeDatabase, SCHEMA_VERSION } from '../../src/db/schema';
import { createRealDb } from '../helpers/realsql-db';

// 全新库初始化必须在真实 SQLite 上完整成功（schema.ts 曾含引用已删列的
// 死索引 idx_audit_logs_entity → no such column → 外层 catch 吞掉 → 后续
// DDL 全跳 → 版本号写不进 → 每次冷启动重跑必挂。已移除，本测试锁住此回归）。
describe('新库初始化（真实 SQLite）', () => {
  // 版本号随 SCHEMA_VERSION 联动（当前 v8 = 0025/0026/0027 + 旧规则 revision 回填）
  it('initializeDatabase 全新库完整建表并写入 schema_version=5', async () => {
    const sqlite = new DatabaseSync(':memory:');
    const db: D1Database = {
      prepare(sql: string) {
        const statement = sqlite.prepare(sql);
        let params: SQLInputValue[] = [];
        return {
          bind(...values: SQLInputValue[]) { params = values; return this; },
          async run() {
            const r = statement.run(...params);
            return { meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } };
          },
          async first<T = unknown>() {
            const row = statement.get(...params) as T | undefined;
            return row ?? null;
          },
          async all<T = unknown>() {
            return { results: statement.all(...params) as T[] };
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

    await initializeDatabase(db as unknown as D1Database);

    const tables = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
    for (const required of ['users', 'ledgers', 'ledger_members', 'sync_changes', 'read_tx_projection', 'audit_logs', 'backup_runs', 'app_metadata']) {
      expect(tables).toContain(required);
    }
    const v = sqlite.prepare("SELECT value FROM app_metadata WHERE key = 'schema_version'").get() as { value: string };
    expect(v.value).toBe(String(SCHEMA_VERSION));
    // #133 MCP 工作流三张新表
    for (const t of ['mcp_write_operations', 'mcp_state_records', 'mcp_source_references']) {
      const got = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t) as { name: string } | undefined;
      expect(got?.name).toBe(t);
    }
    // v6 上游 1.10.x：通知已读 / 设备同步失败 / 跨账本移动回执与退休标记
    for (const t of ['user_notification_reads', 'device_sync_failures', 'transaction_move_receipts', 'transaction_move_retirements']) {
      const got = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t) as { name: string } | undefined;
      expect(got?.name).toBe(t);
    }
    // v6 备份计划新增 cron 生效边界列
    const schedCols = (sqlite.prepare('PRAGMA table_info(backup_schedules)').all() as { name: string }[]).map((c) => c.name);
    expect(schedCols).toContain('cron_effective_at');
    sqlite.close();
  });

  it('v8 数据修复：旧周期规则行 revision NULL/0 回填为 1', async () => {
    const sqlite = new DatabaseSync(':memory:');
    const db: D1Database = {
      prepare(sql: string) {
        const statement = sqlite.prepare(sql);
        let params: SQLInputValue[] = [];
        return {
          bind(...values: SQLInputValue[]) { params = values; return this; },
          async run() { const r = statement.run(...(params as never[])); return { meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } }; },
          async first<T = unknown>() { const row = statement.get(...(params as never[])) as T | undefined; return row ?? null; },
          async all<T = unknown>() { return { results: statement.all(...(params as never[])) as T[] }; },
        };
      },
      async batch(stmts: { run(): Promise<unknown> }[]) { const out = []; for (const s of stmts) out.push(await s.run()); return out; },
    } as unknown as D1Database;

    // 先建最小结构并插入脏数据，再跑 initializeDatabase 触发 v8 回填
    sqlite.exec(`
      CREATE TABLE app_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT 'x');
      CREATE TABLE mcp_state_records (
        id TEXT PRIMARY KEY, user_id TEXT, ledger_id TEXT, kind TEXT, revision INTEGER,
        status TEXT, data_json TEXT, next_due_at TEXT, created_at TEXT DEFAULT 'x', updated_at TEXT DEFAULT 'x'
      );
      INSERT INTO mcp_state_records (id, user_id, ledger_id, kind, revision, status, data_json) VALUES
        ('r-null', 'u', 'l', 'recurring_rule', NULL, 'active', '{}'),
        ('r-zero', 'u', 'l', 'recurring_rule', 0, 'active', '{}'),
        ('r-ok', 'u', 'l', 'recurring_rule', 5, 'active', '{}'),
        ('r-other-kind', 'u', 'l', 'review_item', NULL, 'active', '{}');
      INSERT INTO app_metadata (key, value) VALUES ('schema_version', '0');
    `);
    await initializeDatabase(db);

    const rows = sqlite.prepare("SELECT id, revision FROM mcp_state_records WHERE kind='recurring_rule' ORDER BY id").all() as Array<{ id: string; revision: number | null }>;
    const byId = Object.fromEntries(rows.map(r => [r.id, r.revision]));
    expect(byId['r-null']).toBe(1);
    expect(byId['r-zero']).toBe(1);
    expect(byId['r-ok']).toBe(5);
    // 非 recurring_rule 的行不受影响（该 kind 行保持 NULL）
    const other = sqlite.prepare("SELECT revision FROM mcp_state_records WHERE id='r-other-kind'").get() as { revision: number | null };
    expect(other.revision).toBeNull();
    sqlite.close();
  });


  it('近期迁移失败处于退避期时拒绝继续服务', async () => {
    const { sqlite, db } = createRealDb();
    await initializeDatabase(db);
    sqlite.prepare("UPDATE app_metadata SET value = '2' WHERE key = 'schema_version'").run();
    sqlite.prepare("INSERT OR REPLACE INTO app_metadata (key, value, updated_at) VALUES ('schema_migration_error', ?, datetime('now'))").run(new Date().toISOString());

    await expect(initializeDatabase(db)).rejects.toThrow('Schema migration retry backoff active');
    sqlite.close();
  });
});