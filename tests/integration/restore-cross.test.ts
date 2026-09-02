// 端到端互恢复测试：构造"原版格式"备份（附件路径 attachments/<user>/<ledger>/<sha>/<uuid>.jpg
// + attachment_files.storage_path 为原版绝对路径 /data/attachments/...），跑 worker 的
// performRestore 全链路，断言恢复后 storage_path 被改写为 R2 key、附件已上传到对应 key。
import { describe, it, expect, beforeAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createTarGz } from '../../src/lib/tar';
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