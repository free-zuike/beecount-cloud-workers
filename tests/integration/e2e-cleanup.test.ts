// 端到端复核：scanner.ts + cleaner.ts 全链路（真实 SQLite）
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { scanAll } from '../../src/services/data-cleanup/scanner';
import { clean } from '../../src/services/data-cleanup/cleaner';

describe('data-cleanup e2e', () => {
  it('scanner finds orphans, cleaner fixes them', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, password_hash TEXT, is_admin INTEGER DEFAULT 0, is_enabled INTEGER DEFAULT 1, created_at TEXT DEFAULT '', totp_secret_encrypted TEXT, totp_enabled INTEGER DEFAULT 0, totp_enabled_at TEXT);
      CREATE TABLE ledgers (id TEXT PRIMARY KEY, user_id TEXT, external_id TEXT, name TEXT);
      CREATE TABLE sync_changes (change_id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, ledger_id TEXT, entity_type TEXT NOT NULL, entity_sync_id TEXT NOT NULL, action TEXT NOT NULL, payload_json TEXT, updated_at TEXT, updated_by_user_id TEXT, updated_by_device_id TEXT, scope TEXT DEFAULT 'ledger');
      CREATE TABLE user_account_projection (sync_id TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT, account_type TEXT, currency TEXT, initial_balance REAL, note TEXT, credit_limit REAL, billing_day INTEGER, payment_due_day INTEGER, bank_name TEXT, card_last_four TEXT, hidden INTEGER NOT NULL DEFAULT 0, source_change_id INTEGER DEFAULT 0, PRIMARY KEY (user_id, sync_id));
      CREATE TABLE user_category_projection (sync_id TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT, kind TEXT, level INTEGER, sort_order INTEGER, icon TEXT, icon_type TEXT, custom_icon_path TEXT, icon_cloud_file_id TEXT, icon_cloud_sha256 TEXT, parent_name TEXT, parent_sync_id TEXT, source_change_id INTEGER DEFAULT 0, PRIMARY KEY (user_id, sync_id));
      CREATE TABLE user_tag_projection (sync_id TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT, color TEXT, source_change_id INTEGER DEFAULT 0, PRIMARY KEY (user_id, sync_id));
      CREATE TABLE read_budget_projection (ledger_id TEXT, sync_id TEXT NOT NULL, user_id TEXT NOT NULL, budget_type TEXT, category_sync_id TEXT, amount REAL, period TEXT, start_day INTEGER, enabled INTEGER DEFAULT 1, source_change_id INTEGER DEFAULT 0);
      CREATE TABLE read_tx_projection (ledger_id TEXT, sync_id TEXT NOT NULL, user_id TEXT NOT NULL, tx_type TEXT NOT NULL, amount REAL DEFAULT 0, happened_at TEXT NOT NULL, note TEXT, category_sync_id TEXT, account_sync_id TEXT, from_account_sync_id TEXT, to_account_sync_id TEXT, category_name TEXT, account_name TEXT, from_account_name TEXT, to_account_name TEXT, attachments_json TEXT, source_change_id INTEGER DEFAULT 0);
      CREATE TABLE attachment_files (id TEXT PRIMARY KEY, user_id TEXT, size_bytes INTEGER, file_name TEXT, storage_path TEXT NOT NULL, attachment_kind TEXT DEFAULT 'transaction', sha256 TEXT);
    `);

    class S {
      stmt: ReturnType<DatabaseSync['prepare']>;
      args: unknown[];
      constructor(stmt: ReturnType<DatabaseSync['prepare']>) { this.stmt = stmt; this.args = []; }
      bind(...a: unknown[]) { this.args = a; return this; }
      async run() { const r = this.stmt.run(...this.args as never[]); return { success: true, meta: { changes: r.changes, last_row_id: r.lastInsertRowid }, results: [] }; }
      async first() { return this.stmt.get(...this.args as never[]) ?? null; }
      async all() { return { results: this.stmt.all(...this.args as never[]) }; }
    }
    const d1 = {
      prepare(sql: string) { return new S(db.prepare(sql)); },
      async batch(s: Array<{ run(): Promise<unknown> }>) { const o = []; for (const x of s) o.push(await x.run()); return o; },
    } as unknown as D1Database;

    db.prepare("INSERT INTO users (id,email,password_hash) VALUES ('u1','a@b.com','x')").run();
    db.prepare("INSERT INTO ledgers (id,user_id,external_id,name) VALUES ('L1','u1','led-1','L1')").run();
    db.prepare("INSERT INTO user_category_projection (sync_id,user_id,name) VALUES ('cat1','u1','餐饮')").run();
    db.prepare("INSERT INTO user_account_projection (sync_id,user_id,name) VALUES ('acc1','u1','钱包')").run();
    db.prepare(`INSERT INTO read_tx_projection (ledger_id,sync_id,user_id,tx_type,amount,happened_at,category_sync_id,account_sync_id,category_name,account_name) VALUES ('L1','tx1','u1','expense',25,'2025-01-01','cat1','acc1','餐饮','钱包')`).run();
    db.prepare(`INSERT INTO read_tx_projection (ledger_id,sync_id,user_id,tx_type,amount,happened_at,category_sync_id,account_sync_id,from_account_sync_id,to_account_sync_id,category_name,account_name,from_account_name,to_account_name) VALUES ('L1','tx2','u1','transfer',10,'2025-01-01','catX','accY','accZ','acc1','已删','已删','已删','钱包')`).run();
    db.prepare(`INSERT INTO read_budget_projection (ledger_id,sync_id,user_id,amount,budget_type,category_sync_id) VALUES ('L1','b1','u1',100,'monthly','catX')`).run();
    db.prepare(`INSERT INTO sync_changes (user_id,ledger_id,entity_type,entity_sync_id,action,payload_json,updated_at,scope) VALUES ('u1','L1','transaction','tx3','upsert','{}','2025-01-01','ledger')`).run();
    db.prepare(`INSERT INTO read_tx_projection (ledger_id,sync_id,user_id,tx_type,amount,happened_at,attachments_json) VALUES ('L1','tx4','u1','expense',1,'2025-01-01','[{"cloudFileId":"f9","fileName":"x.jpg"}]')`).run();
    db.prepare(`INSERT INTO attachment_files (id,user_id,file_name,storage_path) VALUES ('f1','u1','x.jpg','beecount/attachments/x.jpg')`).run();

    // 1. scanAll
    const report = await scanAll(d1, undefined);
    expect(report.db_orphans.some(o => o.type === 'tx_missing_category' && o.sync_id === 'tx2')).toBe(true);
    expect(report.db_orphans.some(o => o.type === 'tx_missing_account' && o.sync_id === 'tx2')).toBe(true);
    expect(report.db_orphans.some(o => o.type === 'tx_missing_from_account' && o.sync_id === 'tx2')).toBe(true);
    expect(report.db_orphans.some(o => o.type === 'budget_missing_category' && o.sync_id === 'b1')).toBe(true);
    expect(report.sync_orphans.some(o => o.type === 'sync_change_missing_entity' && String(o.row_id) === '1')).toBe(true);
    expect(report.file_orphans.some(o => o.type === 'attachment_no_ref' && o.row_id === 'f1')).toBe(true);
    expect(report.file_orphans.some(o => o.type === 'tx_ref_broken_attachment' && o.sync_id === 'tx4')).toBe(true);
    expect(report.db_orphans.some(o => o.sync_id === 'tx1')).toBe(false); // 正常 tx1 不误报

    // 2. clean 全部
    const allRecords = [...report.db_orphans, ...report.file_orphans, ...report.sync_orphans].map(o => ({
      type: o.type, row_id: o.row_id, sync_id: o.sync_id, file_path: o.file_path, extra: o.extra,
    }));
    const cleanResult = await clean(d1, allRecords, undefined);
    expect(cleanResult.failures.length).toBe(0);
    expect(cleanResult.success_count).toBe(allRecords.length);

    // 3. 清理效果断言
    const tx2 = db.prepare(`SELECT * FROM read_tx_projection WHERE sync_id='tx2'`).get() as Record<string, unknown>;
    expect(tx2.category_sync_id).toBeNull();
    expect(tx2.account_sync_id).toBeNull();
    expect(tx2.from_account_sync_id).toBeNull();
    expect(tx2.to_account_sync_id).toBe('acc1'); // 正常引用未误清
    const b1 = db.prepare(`SELECT * FROM read_budget_projection WHERE sync_id='b1'`).get() as Record<string, unknown>;
    expect(b1.category_sync_id).toBeNull();
    expect((db.prepare(`SELECT COUNT(*) c FROM sync_changes`).get() as Record<string, unknown>).c).toBe(0);
    expect((db.prepare(`SELECT COUNT(*) c FROM attachment_files WHERE id='f1'`).get() as Record<string, unknown>).c).toBe(0);
    const tx4 = db.prepare(`SELECT attachments_json FROM read_tx_projection WHERE sync_id='tx4'`).get() as Record<string, unknown>;
    expect(JSON.parse(String(tx4.attachments_json ?? '[]'))).toEqual([]);
    const tx1 = db.prepare(`SELECT * FROM read_tx_projection WHERE sync_id='tx1'`).get() as Record<string, unknown>;
    expect(tx1.category_sync_id).toBe('cat1'); // 正常 tx1 未误改
    expect(tx1.account_sync_id).toBe('acc1');
  });
});