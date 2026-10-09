import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import { initializeDatabase } from '../../src/db/schema';
import { createRealDb } from '../helpers/realsql-db';

// 全新库初始化必须在真实 SQLite 上完整成功（schema.ts 曾含引用已删列的
// 死索引 idx_audit_logs_entity → no such column → 外层 catch 吞掉 → 后续
// DDL 全跳 → 版本号写不进 → 每次冷启动重跑必挂。已移除，本测试锁住此回归）。
describe('新库初始化（真实 SQLite）', () => {
  it('initializeDatabase 全新库完整建表并写入 schema_version=3', async () => {
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
    expect(v.value).toBe('3');
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