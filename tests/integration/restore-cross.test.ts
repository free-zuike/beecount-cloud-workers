// 端到端互恢复测试：构造"原版格式"备份（附件路径 attachments/<user>/<ledger>/<sha>/<uuid>.jpg
// + attachment_files.storage_path 为原版绝对路径 /data/attachments/...），跑 worker 的
// performRestore 全链路，断言恢复后 storage_path 被改写为 R2 key、附件已上传到对应 key。
import { describe, it, expect, beforeAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createTarGz, type TarEntrySource } from '../../src/lib/tar';
import { performRestore } from '../../src/lib/restore-service';

// ---- 简易 D1 兼容层（基于 node:sqlite） ----
class D1Stmt {
  stmt: any; args: unknown[];
  constructor(stmt: any) { this.stmt = stmt; this.args = []; }
  bind(...a: unknown[]) { this.args = a; return this; }
  async run() { const r = this.stmt.run(...this.args as never[]); return { success: true, meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) }, results: [] }; }
  async first() { return this.stmt.get(...this.args as never[]) ?? null; }
  async all() { return { results: this.stmt.all(...this.args as never[]) }; }
}
function makeD1(db: DatabaseSync): D1Database {
  return {
    prepare(sql: string) { return new D1Stmt(db.prepare(sql)) as any; },
    async batch(stmts: any[]) { const o = []; for (const s of stmts) o.push(await s.run()); return o; },
    async exec() { return { success: true } as any; },
    async dump() { return new ArrayBuffer(0) as any; },
  } as unknown as D1Database;
}

// ---- R2 stub：get/put/list ----
class R2Stub {
  objects = new Map<string, Uint8Array>();
  async get(key: string) {
    const data = this.objects.get(key);
    if (!data) return null;
    return {
      body: new Blob([data]).stream(),
      size: data.byteLength,
      httpMetadata: null,
      async arrayBuffer() { return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer; },
    } as any;
  }
  async put(key: string, data: Uint8Array) { this.objects.set(key, data); return {} as any; }
  async list(opts: { prefix: string; cursor?: string; limit?: number }) {
    const keys = [...this.objects.keys()].filter(k => k.startsWith(opts.prefix)).sort();
    return { objects: keys.map(k => ({ key: k, size: this.objects.get(k)!.byteLength, uploaded: new Date() })), truncated: false, cursor: undefined } as any;
  }
  async delete(key: string) { this.objects.delete(key); return {} as any; }
}

// 构造"原版格式"备份 tar：附件路径 attachments/<user>/<ledger>/<sha>/<uuid>.jpg
async function buildOriginalBackup(): Promise<Uint8Array> {
  const originalAttachmentPath = '/data/attachments/u1/L1/ab/abc12345_photo.jpg';
  const tarPath = 'attachments/u1/L1/ab/abc12345_photo.jpg';
  const fileData = new TextEncoder().encode('FAKE_IMAGE_BYTES_原版附件');

  // 原版 db.json：attachment_files 表（storage_path 为原版绝对路径）
  const tables = {
    attachment_files: [
      { id: 'att-1', ledger_id: 'L1', user_id: 'u1', sha256: 'sha256val', size_bytes: fileData.byteLength, mime_type: 'image/jpeg', file_name: 'abc12345_photo.jpg', storage_path: originalAttachmentPath, attachment_kind: 'transaction', created_at: '2025-01-01T00:00:00Z' },
    ],
    users: [{ id: 'u1', email: 'u1@x.com' }],
    ledgers: [{ id: 'L1', user_id: 'u1', external_id: 'led-1', name: 'L1', currency: 'CNY' }],
  };
  const dbJson = JSON.stringify({ backup_time: '2025-01-01T00:00:00Z', version: '1.0', schema_version: 1, user_id: 'u1', tables }, null, 2);

  const entries = [
    { name: 'meta.json', data: new TextEncoder().encode('{}') },
    { name: 'db.json', data: new TextEncoder().encode(dbJson) },
    { name: tarPath, data: fileData },
  ];
  return await createTarGz(entries);
}

describe('Restore - cross-side attachment path alignment', () => {
  it('remaps original absolute storage_path to R2 key and uploads attachment', async () => {
    // 1. 目标 D1（worker 侧，已有 users/ledgers）
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT);
      CREATE TABLE ledgers (id TEXT PRIMARY KEY, user_id TEXT, external_id TEXT, name TEXT, currency TEXT);
      CREATE TABLE attachment_files (id TEXT PRIMARY KEY, ledger_id TEXT, user_id TEXT, sha256 TEXT, size_bytes INTEGER, mime_type TEXT, file_name TEXT, storage_path TEXT, attachment_kind TEXT, created_at TEXT);`);
    db.prepare("INSERT INTO users (id, email) VALUES ('u1','u1@x.com')").run();
    db.prepare("INSERT INTO ledgers (id, user_id, external_id, name, currency) VALUES ('L1','u1','led-1','L1','CNY')").run();
    const d1 = makeD1(db);

    // 2. R2 stub
    const r2 = new R2Stub();

    // 3. 构造原版备份并放入 R2
    const backupBytes = await buildOriginalBackup();
    r2.objects.set('beecount/backups/u1/test/original.tar.gz', backupBytes);

    // 4. 跑 performRestore
    const result = await performRestore(d1, r2 as any, 'beecount/backups/u1/test/original.tar.gz');

    // 5. 断言
    expect(result.success).toBe(true);

    // 附件应上传到 beecount/attachments/<user>/<ledger>/<sha>/<uuid>.jpg
    const expectedR2Key = 'beecount/attachments/u1/L1/ab/abc12345_photo.jpg';
    expect(r2.objects.has(expectedR2Key)).toBe(true);

    // attachment_files.storage_path 应被改写为 R2 key（不再保留原版绝对路径）
    const row = db.prepare(`SELECT storage_path FROM attachment_files WHERE id = 'att-1'`).get() as { storage_path: string };
    expect(row.storage_path).toBe(expectedR2Key);
  });
});

// 构建一份“原版格式”的备份归档：真实 db.sqlite3（VACUUM 式的完整 SQLite 库）+ meta.json，
// 用上游同款归档结构（tar.gz）。这里用 node:sqlite 按与原版一致的表/列名造库，
// 再交由真实的 performRestore（内部经 sql.js 读 db.sqlite3 → 列名匹配 → INSERT OR REPLACE）导入。
// 说明：本地无 Python，无法用原版 runner 逐字节产出；但归档结构与列名与原版一致，
// 且走的是真实的文件级恢复代码路径（之前 restore-cross 只覆盖了旧 db.json 路径，未覆盖真 db.sqlite3）。
const ENTITY_TABLES_DDL = `
  CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT);
  CREATE TABLE ledgers (id TEXT PRIMARY KEY, user_id TEXT, external_id TEXT, name TEXT, currency TEXT);
  CREATE TABLE user_account_projection (sync_id TEXT, user_id TEXT, name TEXT, account_type TEXT, currency TEXT, initial_balance REAL, hidden INTEGER);
  CREATE TABLE user_category_projection (sync_id TEXT, user_id TEXT, name TEXT, kind TEXT, level INTEGER, sort_order INTEGER, icon TEXT, icon_type TEXT);
  CREATE TABLE user_tag_projection (sync_id TEXT, user_id TEXT, name TEXT, color TEXT);
  CREATE TABLE read_budget_projection (ledger_id TEXT, sync_id TEXT, user_id TEXT, budget_type TEXT, category_sync_id TEXT, amount REAL, period TEXT, start_day INTEGER, enabled INTEGER);
  CREATE TABLE read_tx_projection (ledger_id TEXT, sync_id TEXT, user_id TEXT, tx_type TEXT, amount REAL, happened_at TEXT, note TEXT, category_sync_id TEXT, category_name TEXT, category_kind TEXT, account_sync_id TEXT, account_name TEXT, tags_csv TEXT, tag_sync_ids_json TEXT, currency_code TEXT, native_amount REAL, tx_index INTEGER, source_change_id INTEGER, exclude_from_stats INTEGER, exclude_from_budget INTEGER, created_by_user_id TEXT);
`;

function buildUpstreamFormatDb(): Uint8Array {
  const p = path.join(os.tmpdir(), `upstream-backup-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const src = new DatabaseSync(p);
  src.exec(ENTITY_TABLES_DDL);
  src.prepare("INSERT INTO users (id, email) VALUES ('u1','u1@x.com')").run();
  src.prepare("INSERT INTO ledgers (id, user_id, external_id, name, currency) VALUES ('L1-i','u1','L1','L1','CNY')").run();
  src.prepare("INSERT INTO user_account_projection VALUES ('a1','u1','现金','asset','CNY',0,0)").run();
  src.prepare("INSERT INTO user_category_projection VALUES ('c1','u1','餐饮','expense',0,1,'🍜','emoji')").run();
  src.prepare("INSERT INTO user_tag_projection VALUES ('g1','u1','出差','#00bcf2')").run();
  src.prepare("INSERT INTO read_budget_projection VALUES ('L1-i','b1','u1','monthly','c1',100,'monthly',1,1)").run();
  src.prepare("INSERT INTO read_tx_projection VALUES ('L1-i','t1','u1','expense',38.0,'2026-05-02T03:30:00Z','星巴克','c1','餐饮','expense','a1','现金',NULL,NULL,'CNY',38.0,0,1,0,0,'u1')").run();
  src.close();
  const buf = fs.readFileSync(p);
  fs.unlinkSync(p);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

async function buildUpstreamFormatBackup(): Promise<Uint8Array> {
  const dbBytes = buildUpstreamFormatDb();
  const entries: TarEntrySource[] = [
    { name: 'meta.json', data: new TextEncoder().encode('{"schemaVersion":1,"appVersion":"1.9.0","createdAt":"2026-05-20T04:00:00Z","userId":"u1"}') },
    { name: 'db.sqlite3', data: dbBytes },
  ];
  return createTarGz(entries);
}

describe('Restore - genuine upstream-format db.sqlite3 archive', () => {
  it('从真实 db.sqlite3 tar.gz 完整导入账户/分类/标签/预算/交易', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec(ENTITY_TABLES_DDL);
    db.prepare("INSERT INTO users (id, email) VALUES ('u1','u1@x.com')").run();
    db.prepare("INSERT INTO ledgers (id, user_id, external_id, name, currency) VALUES ('L1-i','u1','L1','L1','CNY')").run();
    const d1 = makeD1(db);
    const r2 = new R2Stub();
    const backupBytes = await buildUpstreamFormatBackup();
    const result = await performRestore(d1, r2 as unknown as R2Bucket, 'beecount/backups/u1/test/upstream.tar.gz', undefined, undefined, backupBytes);
    expect(result.success).toBe(true);
    expect(result.tablesImported).toBeGreaterThanOrEqual(5);
    expect(db.prepare("SELECT sync_id FROM user_account_projection WHERE sync_id='a1'").get()).toBeTruthy();
    expect(db.prepare("SELECT sync_id FROM user_category_projection WHERE sync_id='c1'").get()).toBeTruthy();
    expect(db.prepare("SELECT sync_id FROM user_tag_projection WHERE sync_id='g1'").get()).toBeTruthy();
    expect(db.prepare("SELECT sync_id FROM read_budget_projection WHERE sync_id='b1'").get()).toBeTruthy();
    expect(db.prepare("SELECT sync_id FROM read_tx_projection WHERE sync_id='t1'").get()).toBeTruthy();
  });
});