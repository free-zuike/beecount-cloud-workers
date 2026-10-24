// 移植上游 tests/test_data_cleanup.py(14 例可移植):
// A 类孤儿扫描/清理(tx 失主 category/account/from/to、budget 失主 category、
// sync_change 失主实体、delete action 不算孤儿);B 类附件孤儿(no_ref/file_missing/
// disk_file_no_row/tx_ref_broken)与清理;空记录 no-op。
// 差异:上游 B 类基于本地磁盘(tmp_path + attachment_storage_dir),本地基于
// R2(storage-adapter)——测试用 mock R2 head/list/delete;上游父目录 rmdir 清理
// 2 例本地无本地磁盘模型,不移植。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { scanAll } from '../src/services/data-cleanup/scanner';
import { clean } from '../src/services/data-cleanup/cleaner';
import { OrphanType } from '../src/services/data-cleanup/types';

let sqlite: DatabaseSync;
let db: D1Database;

const DDL = `
  CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL);
  CREATE TABLE ledgers (id TEXT PRIMARY KEY, user_id TEXT, external_id TEXT, name TEXT, currency TEXT);
  CREATE TABLE read_tx_projection (
    ledger_id TEXT, sync_id TEXT, user_id TEXT, tx_type TEXT, amount REAL DEFAULT 0,
    happened_at TEXT, note TEXT,
    category_sync_id TEXT, category_name TEXT, category_kind TEXT,
    account_sync_id TEXT, account_name TEXT,
    from_account_sync_id TEXT, from_account_name TEXT,
    to_account_sync_id TEXT, to_account_name TEXT,
    tags_csv TEXT, tag_sync_ids_json TEXT, attachments_json TEXT, tx_index INTEGER DEFAULT 0,
    created_by_user_id TEXT, last_edited_by_user_id TEXT, source_change_id INTEGER DEFAULT 0,
    PRIMARY KEY (ledger_id, sync_id)
  );
  CREATE TABLE read_budget_projection (ledger_id TEXT, sync_id TEXT, user_id TEXT, budget_type TEXT, category_sync_id TEXT, amount REAL, period TEXT, start_day INTEGER, enabled INTEGER DEFAULT 1, PRIMARY KEY (ledger_id, sync_id));
  CREATE TABLE user_account_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, account_type TEXT, currency TEXT);
  CREATE TABLE user_category_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, kind TEXT, level INTEGER, icon_cloud_file_id TEXT, icon_cloud_sha256 TEXT, parent_name TEXT, parent_sync_id TEXT);
  CREATE TABLE user_tag_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, color TEXT, source_change_id INTEGER);
  CREATE TABLE attachment_files (
    id TEXT PRIMARY KEY, ledger_id TEXT, user_id TEXT, sha256 TEXT, size_bytes INTEGER,
    mime_type TEXT, file_name TEXT, storage_path TEXT, attachment_kind TEXT, created_at TEXT
  );
  CREATE TABLE sync_changes (
    change_id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, ledger_id TEXT, entity_type TEXT,
    entity_sync_id TEXT, action TEXT, payload_json TEXT, updated_at TEXT,
    updated_by_user_id TEXT, updated_by_device_id TEXT, scope TEXT
  );
`;

function makeD1(s: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      const statement = s.prepare(sql);
      let params: unknown[] = [];
      return {
        bind(...values: unknown[]) { params = values; return this; },
        async run() {
          const r = statement.run(...(params as never[]));
          return { meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } };
        },
        async first<T = unknown>() {
          const row = statement.get(...(params as never[])) as T | undefined;
          return row ?? null;
        },
        async all<T = unknown>() {
          return { results: statement.all(...(params as never[])) as T[] };
        },
      };
    },
    async batch(stmts: { run(): Promise<unknown> }[]) {
      s.exec('BEGIN');
      try {
        const out = [];
        for (const st of stmts) out.push(await st.run());
        s.exec('COMMIT');
        return out;
      } catch (e) {
        s.exec('ROLLBACK');
        throw e;
      }
    },
  } as unknown as D1Database;
}

function seedUserLedger(ledgerId = 'L1') {
  sqlite.prepare("INSERT INTO users (id, email, password_hash) VALUES ('U1', 'U1@x.com', 'h')").run();
  sqlite.prepare("INSERT INTO ledgers (id, user_id, external_id, name, currency) VALUES (?, 'U1', ?, 'L', 'CNY')").run(ledgerId, `ext-${ledgerId}`);
}

function addTx(overrides: Partial<Record<string, unknown>> = {}) {
  const row = {
    ledger_id: 'L1', sync_id: 'tx-1', user_id: 'U1', tx_type: 'expense', amount: 10,
    happened_at: '2026-01-01T00:00:00Z',
    category_sync_id: null, account_sync_id: null,
    from_account_sync_id: null, to_account_sync_id: null,
    attachments_json: null,
    ...overrides,
  };
  sqlite.prepare(
    `INSERT INTO read_tx_projection (ledger_id, sync_id, user_id, tx_type, amount, happened_at,
      category_sync_id, account_sync_id, from_account_sync_id, to_account_sync_id, attachments_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(row.ledger_id, row.sync_id, row.user_id, row.tx_type, row.amount, row.happened_at,
    row.category_sync_id, row.account_sync_id, row.from_account_sync_id, row.to_account_sync_id,
    row.attachments_json);
}

function addCategory(syncId: string) {
  sqlite.prepare("INSERT INTO user_category_projection (sync_id, user_id, name, kind) VALUES (?, 'U1', 'c', 'expense')").run(syncId);
}

function addAccount(syncId: string) {
  sqlite.prepare("INSERT INTO user_account_projection (sync_id, user_id, name) VALUES (?, 'U1', 'acc')").run(syncId);
}

function addAttachment(overrides: Partial<Record<string, unknown>> = {}) {
  const row = {
    id: 'att-1', ledger_id: 'L1', user_id: 'U1', sha256: 'aaa', size_bytes: 4,
    file_name: 'a.png', storage_path: 'attachments/a.png', attachment_kind: 'transaction',
    ...overrides,
  };
  sqlite.prepare(
    `INSERT INTO attachment_files (id, ledger_id, user_id, sha256, size_bytes, file_name, storage_path, attachment_kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(row.id, row.ledger_id, row.user_id, row.sha256, row.size_bytes, row.file_name, row.storage_path, row.attachment_kind);
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec(DDL);
  db = makeD1(sqlite);
});

afterEach(() => sqlite.close());

describe('A 类:DB 引用断链扫描(移植上游 test_data_cleanup.py)', () => {
  it('A1:tx category_sync_id 指向已删分类 → tx_missing_category', async () => {
    seedUserLedger();
    addTx({ category_sync_id: 'ghost-cat' });
    const report = await scanAll(db);
    expect(report.db_orphans.some(r => r.type === 'tx_missing_category')).toBe(true);
  });

  it('A2:tx account_sync_id 指向已删账户 → tx_missing_account', async () => {
    seedUserLedger();
    addTx({ account_sync_id: 'ghost-acc' });
    const report = await scanAll(db);
    expect(report.db_orphans.some(r => r.type === 'tx_missing_account')).toBe(true);
  });

  it('A3:转账 to_account 已删 → tx_missing_to_account;from 有效不命中', async () => {
    seedUserLedger();
    addAccount('valid-from');
    addTx({ from_account_sync_id: 'valid-from', to_account_sync_id: 'ghost-to' });
    const report = await scanAll(db);
    const types = new Set(report.db_orphans.map(r => r.type));
    expect(types.has('tx_missing_to_account')).toBe(true);
    expect(types.has('tx_missing_from_account')).toBe(false);
  });

  it('A4:budget category_sync_id 指向已删分类 → budget_missing_category', async () => {
    seedUserLedger();
    sqlite.prepare(
      `INSERT INTO read_budget_projection (ledger_id, sync_id, user_id, budget_type, category_sync_id, amount)
       VALUES ('L1', 'b-1', 'U1', 'category', 'ghost-cat', 100)`
    ).run();
    const report = await scanAll(db);
    expect(report.db_orphans.some(r => r.type === 'budget_missing_category')).toBe(true);
  });

  it('A5:sync_change 引用不存在的实体 → sync_change_missing_entity', async () => {
    seedUserLedger();
    sqlite.prepare(
      `INSERT INTO sync_changes (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at)
       VALUES ('U1', 'L1', 'transaction', 'ghost-tx', 'update', '{}', '2026-01-01T00:00:00Z')`
    ).run();
    const report = await scanAll(db);
    expect(report.sync_orphans.some(r => r.type === 'sync_change_missing_entity')).toBe(true);
  });

  it('sync_change action=delete 不算孤儿(即使实体不存在)', async () => {
    seedUserLedger();
    sqlite.prepare(
      `INSERT INTO sync_changes (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at)
       VALUES ('U1', 'L1', 'transaction', 'ghost-tx', 'delete', '{}', '2026-01-01T00:00:00Z')`
    ).run();
    const report = await scanAll(db);
    expect(report.sync_orphans.some(r => r.type === 'sync_change_missing_entity')).toBe(false);
  });
});

describe('B 类:附件孤儿扫描(本地 R2 模型,对齐上游语义)', () => {
  it('B1:attachment 无任何引用 → attachment_no_ref', async () => {
    seedUserLedger();
    addAttachment({ id: 'att-orphan', file_name: 'orphan.png', storage_path: 'attachments/orphan.png' });
    const report = await scanAll(db);
    expect(report.file_orphans.some(r => r.type === 'attachment_no_ref')).toBe(true);
  });

  it('B1:被 tx attachments_json 引用的附件不算孤儿', async () => {
    seedUserLedger();
    addAttachment({ id: 'att-used', sha256: 'used' });
    addTx({ attachments_json: JSON.stringify([{ fileName: 'a.png', cloudFileId: 'att-used' }]) });
    const report = await scanAll(db);
    expect(report.file_orphans.some(r => r.type === 'attachment_no_ref')).toBe(false);
  });

  it('B2:R2 对象缺失但 DB 有行 → attachment_file_missing', async () => {
    seedUserLedger();
    addAttachment({ id: 'att-missing', storage_path: 'attachments/missing.png' });
    const r2 = {
      head: async () => null,
      list: async () => ({ objects: [], truncated: false }),
      delete: async () => {},
    } as unknown as R2Bucket;
    const report = await scanAll(db, r2);
    expect(report.file_orphans.some(r => r.type === 'attachment_file_missing')).toBe(true);
  });

  it('B2:R2 对象存在 → 不算 attachment_file_missing', async () => {
    seedUserLedger();
    addAttachment({ id: 'att-ok', storage_path: 'attachments/ok.png' });
    const r2 = {
      head: async (key: string) => (key === 'attachments/ok.png' ? { key } : null),
      list: async () => ({ objects: [], truncated: false }),
      delete: async () => {},
    } as unknown as R2Bucket;
    const report = await scanAll(db, r2);
    expect(report.file_orphans.some(r => r.type === 'attachment_file_missing')).toBe(false);
  });

  it('B3:R2 有对象但 DB 无行 → disk_file_no_row', async () => {
    seedUserLedger();
    const r2 = {
      head: async () => null,
      list: async (opts: any) => ({
        objects: [{ key: 'attachments/u1/stray.png', size: 1 }],
        truncated: false,
      }),
      delete: async () => {},
    } as unknown as R2Bucket;
    const report = await scanAll(db, r2);
    expect(report.file_orphans.some(r => r.type === 'disk_file_no_row')).toBe(true);
  });

  it('B4:tx attachments_json 引用不存在的 fileId → tx_ref_broken_attachment', async () => {
    seedUserLedger();
    addTx({ attachments_json: JSON.stringify([{ fileName: 'a.jpg', cloudFileId: 'ghost-file' }]) });
    const report = await scanAll(db);
    expect(report.file_orphans.some(r => r.type === 'tx_ref_broken_attachment')).toBe(true);
  });
});

describe('cleaner(移植上游 test_data_cleanup.py)', () => {
  it('clean A1:清空 category_sync_id 但保留 tx 行,重扫无孤儿', async () => {
    seedUserLedger();
    addTx({ category_sync_id: 'ghost-cat' });
    const report = await scanAll(db);
    const records = report.db_orphans.filter(r => r.type === 'tx_missing_category');
    const result = await clean(db, records as any);
    expect(result.success_count).toBe(records.length);

    const tx = sqlite.prepare('SELECT * FROM read_tx_projection WHERE ledger_id = ? AND sync_id = ?').get('L1', 'tx-1') as any;
    expect(tx).toBeDefined();
    expect(tx.category_sync_id).toBeNull();

    const report2 = await scanAll(db);
    expect(report2.db_orphans.some(r => r.type === 'tx_missing_category')).toBe(false);
  });

  it('clean B1:删 DB 行 + R2 对象(带 beecount/ 前缀,与 storage-adapter 实际 key 一致)', async () => {
    seedUserLedger();
    addAttachment({ id: 'att-orphan', file_name: 'orphan.png', storage_path: 'attachments/orphan.png' });
    const deleted: string[] = [];
    const r2 = {
      head: async () => null,
      list: async () => ({ objects: [], truncated: false }),
      delete: async (key: string) => { deleted.push(key); },
    } as unknown as R2Bucket;
    const report = await scanAll(db, r2);
    const records = report.file_orphans.filter(r => r.type === 'attachment_no_ref');
    expect(records.length).toBeGreaterThan(0);
    const result = await clean(db, records as any, r2);
    expect(result.success_count).toBe(records.length);
    expect(sqlite.prepare('SELECT 1 FROM attachment_files WHERE id = ?').get('att-orphan')).toBeUndefined();
    // 统一删除入口加 beecount/ 前缀：直接 r2.delete(storage_path) 会漏删实际对象
    expect(deleted).toContain('beecount/attachments/orphan.png');
  });

  it('clean B4:剥离 broken attachments,保留有效项与 tx 本体', async () => {
    seedUserLedger();
    addAttachment({ id: 'valid-file', file_name: 'ok.jpg', storage_path: 'attachments/ok.jpg', sha256: 'vv' });
    addTx({ attachments_json: JSON.stringify([
      { fileName: 'ok.jpg', cloudFileId: 'valid-file' },
      { fileName: 'bad.jpg', cloudFileId: 'ghost-file' },
    ]) });
    const report = await scanAll(db);
    const records = report.file_orphans.filter(r => r.type === 'tx_ref_broken_attachment');
    expect(records.length).toBeGreaterThan(0);
    const result = await clean(db, records as any);
    expect(result.success_count).toBe(records.length);

    const tx = sqlite.prepare('SELECT * FROM read_tx_projection WHERE ledger_id = ? AND sync_id = ?').get('L1', 'tx-1') as any;
    expect(tx).toBeDefined();
    const kept = JSON.parse(tx.attachments_json) as Array<{ cloudFileId: string }>;
    expect(kept).toHaveLength(1);
    expect(kept[0].cloudFileId).toBe('valid-file');
  });

  it('clean 空记录 no-op', async () => {
    seedUserLedger();
    const result = await clean(db, []);
    expect(result.success_count).toBe(0);
    expect(result.failures).toEqual([]);
  });

  it('scan/clean B5:同 sha 多行被引用 → 迁移引用+写 sync_changes+删次行', async () => {
    seedUserLedger();
    addAttachment({ id: 'dup-A', sha256: 'SSS', storage_path: 'attachments/a.png' });
    addAttachment({ id: 'dup-B', sha256: 'SSS', storage_path: 'attachments/b.png' });
    addTx({ sync_id: 'tx-keep', attachments_json: JSON.stringify([{ cloudFileId: 'dup-A', fileName: 'sha_SSS.jpg' }]) });
    addTx({ sync_id: 'tx-move', attachments_json: JSON.stringify([{ cloudFileId: 'dup-B', fileName: 'sha_SSS.jpg' }]) });

    const report = await scanAll(db);
    const recs = report.file_orphans.filter(r => r.type === 'attachment_dup_ref');
    expect(recs).toHaveLength(1);
    expect(recs[0].row_id).toBe('dup-B');
    expect(recs[0].extra?.keep_id).toBe('dup-A');

    const deleted: string[] = [];
    const r2 = {
      head: async () => null,
      list: async () => ({ objects: [], truncated: false }),
      delete: async (k: string) => { deleted.push(k); },
    } as unknown as R2Bucket;
    const result = await clean(db, recs as any, r2);
    expect(result.success_count).toBe(1);
    expect(result.failures).toEqual([]);

    // 交易引用迁移到保留行；保留行交易不受影响
    const moved = JSON.parse(String((sqlite.prepare("SELECT attachments_json FROM read_tx_projection WHERE sync_id = 'tx-move'").get() as any).attachments_json)) as Array<{ cloudFileId: string }>;
    expect(moved[0].cloudFileId).toBe('dup-A');
    const kept = JSON.parse(String((sqlite.prepare("SELECT attachments_json FROM read_tx_projection WHERE sync_id = 'tx-keep'").get() as any).attachments_json)) as Array<{ cloudFileId: string }>;
    expect(kept[0].cloudFileId).toBe('dup-A');
    // 次行删除、保留行保留
    expect(sqlite.prepare('SELECT 1 FROM attachment_files WHERE id = ?').get('dup-B')).toBeUndefined();
    expect(sqlite.prepare('SELECT 1 FROM attachment_files WHERE id = ?').get('dup-A')).toBeDefined();
    // sync_changes 写入（merge payload、scope=ledger、device NULL 放行）
    const ch = sqlite.prepare("SELECT * FROM sync_changes WHERE entity_sync_id = 'tx-move'").get() as any;
    expect(ch).toBeDefined();
    expect(ch.scope).toBe('ledger');
    expect(ch.updated_by_device_id).toBeNull();
    expect(ch.action).toBe('upsert');
    const pl = JSON.parse(ch.payload_json);
    expect(pl.attachments[0].cloudFileId).toBe('dup-A');
    // R2 对象删除（统一入口带 beecount/ 前缀）
    expect(deleted).toContain('beecount/attachments/b.png');
    // 重扫无重复引用
    const report2 = await scanAll(db);
    expect(report2.file_orphans.some(r => r.type === 'attachment_dup_ref')).toBe(false);
  });
});