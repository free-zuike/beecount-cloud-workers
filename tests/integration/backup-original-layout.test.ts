// 端到端：worker 备份 tar 附件按原版路径结构 + db.json/db.sqlite3 storage_path 改写为原版绝对路径
// 构造 worker 侧数据（attachment_files + ledgers + R2 附件），调 generateBackupBytes，
// 断言解包后的 tar：附件路径是 attachments/<user>/<ledger>/<sha[:2]>/<id>_<name>，db.json 表行已改写。
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createTarGz } from '../../src/lib/tar';
import { generateBackupBytes } from '../../src/services/backup-executor';

// D1 兼容层（node:sqlite）
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

// R2 stub
class R2Stub {
  objects = new Map<string, Uint8Array>();
  async get(key: string) {
    const data = this.objects.get(key);
    if (!data) return null;
    return { body: new Blob([data]).stream(), size: data.byteLength, httpMetadata: null, async arrayBuffer() { return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer; } } as any;
  }
  async put(key: string, data: Uint8Array) { this.objects.set(key, data); return {} as any; }
  async list(opts: { prefix: string }) {
    const keys = [...this.objects.keys()].filter(k => k.startsWith(opts.prefix)).sort();
    return { objects: keys.map(k => ({ key: k, size: this.objects.get(k)!.byteLength, uploaded: new Date() })), truncated: false } as any;
  }
}

// 简易 tar 解析（复用 restore-service 逻辑）
function parseTar(data: Uint8Array): { name: string; size: number; data: Uint8Array }[] {
  const entries = []; let offset = 0;
  while (offset < data.length - 512) {
    const header = data.slice(offset, offset + 512);
    const name = new TextDecoder().decode(header.slice(0, 100)).replace(/\0/g, '');
    if (!name) break;
    const sizeOctal = new TextDecoder().decode(header.slice(124, 136)).replace(/\0/g, '').trim();
    const size = parseInt(sizeOctal, 8) || 0;
    const contentOffset = offset + 512;
    entries.push({ name, size, data: data.slice(contentOffset, contentOffset + size) });
    offset = contentOffset + Math.ceil(size / 512) * 512;
  }
  return entries;
}

describe('Backup - worker tar uses original attachment layout', () => {
  it('remaps attachment paths + rewrites storage_path in db.json', async () => {
    // 1. worker 侧 D1
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT);
      CREATE TABLE ledgers (id TEXT PRIMARY KEY, user_id TEXT, external_id TEXT, name TEXT, currency TEXT);
      CREATE TABLE attachment_files (id TEXT PRIMARY KEY, ledger_id TEXT, user_id TEXT, sha256 TEXT, size_bytes INTEGER, mime_type TEXT, file_name TEXT, storage_path TEXT, attachment_kind TEXT, created_at TEXT);`);
    db.prepare("INSERT INTO users (id, email) VALUES ('u1','u1@x.com')").run();
    db.prepare("INSERT INTO ledgers (id, user_id, external_id, name, currency) VALUES ('L1','u1','led-1','L1','CNY')").run();
    // worker 附件：storage_path 是 R2 key（带 beecount/ 前缀）
    db.prepare(`INSERT INTO attachment_files (id, ledger_id, user_id, sha256, size_bytes, mime_type, file_name, storage_path, attachment_kind, created_at)
      VALUES ('att-1','L1','u1','abc123def456',10,'image/jpeg','photo.jpg','beecount/attachments/led-1/att-1_photo.jpg','transaction','2025-01-01T00:00:00Z')`).run();
    const d1 = makeD1(db);

    // 2. R2 里放附件（worker 实际 key）
    const r2 = new R2Stub();
    r2.objects.set('beecount/attachments/led-1/att-1_photo.jpg', new TextEncoder().encode('FAKE_IMG'));

    // 3. 预生成 db.sqlite3（真实 sqlite，含 attachment_files 表原 storage_path）
    const sqliteBytes = await (async () => {
      // 用 sql.js 生成（与 worker exportD1ToSqlite 产物一致）
      const initSqlJs = (await import('sql.js/dist/sql-asm.js')).default;
      if (typeof self !== 'undefined' && !(self as any).location) {
        (self as any).location = { href: 'http://localhost/', origin: 'http://localhost', protocol: 'http:', host: 'localhost', hostname: 'localhost', port: '80', pathname: '/', search: '', hash: '' };
      }
      const SQL = await initSqlJs();
      const sq = new SQL.Database();
      sq.run(`CREATE TABLE attachment_files (id TEXT PRIMARY KEY, ledger_id TEXT, user_id TEXT, sha256 TEXT, size_bytes INTEGER, mime_type TEXT, file_name TEXT, storage_path TEXT, attachment_kind TEXT, created_at TEXT);`);
      sq.run(`CREATE TABLE ledgers (id TEXT PRIMARY KEY, user_id TEXT, external_id TEXT, name TEXT, currency TEXT);`);
      sq.run(`INSERT INTO attachment_files (id, ledger_id, user_id, sha256, size_bytes, mime_type, file_name, storage_path, attachment_kind, created_at) VALUES ('att-1','L1','u1','abc123def456',10,'image/jpeg','photo.jpg','beecount/attachments/led-1/att-1_photo.jpg','transaction','2025-01-01T00:00:00Z')`);
      const out = sq.export();
      sq.close();
      return out;
    })();

    // 4. 跑 generateBackupBytes（避开 D1 Export API，用 preSqliteBytes）
    const result = await generateBackupBytes(d1, 'u1', 'L1', r2 as any, undefined, undefined, sqliteBytes, null);

    // 5. 解包 tar 断言（createTarGz 输出是 gzip 压缩，先解压再 parse）
    const decompressed = await new Response(result.backupBytes).arrayBuffer();
    const gunzipped = new Uint8Array(await new Response(
      new Blob([decompressed]).stream().pipeThrough(new DecompressionStream('gzip'))
    ).arrayBuffer());
    const entries = parseTar(gunzipped);
    const attEntry = entries.find(e => e.name.includes('att-1_photo.jpg'));
    expect(attEntry).toBeDefined();
    // 附件路径应是原版结构 attachments/<user>/<ledger_ext>/<sha[:2]>/<id>_<name>
    expect(attEntry!.name).toBe('attachments/u1/led-1/ab/att-1_photo.jpg');

    // db.json 里 attachment_files.storage_path 被改写为原版绝对路径
    const dbJsonEntry = entries.find(e => e.name === 'db.json');
    const dbJson = JSON.parse(new TextDecoder().decode(dbJsonEntry!.data));
    const afRow = dbJson.tables.attachment_files.find((r: any) => r.id === 'att-1');
    expect(afRow.storage_path).toBe('/data/attachments/u1/led-1/ab/att-1_photo.jpg');

    // db.sqlite3 里 storage_path 同样改写（用 sql.js 读，与改写工具同引擎）
    const sqliteEntry = entries.find(e => e.name === 'db.sqlite3');
    expect(sqliteEntry).toBeDefined();
    const initSqlJs2 = (await import('sql.js/dist/sql-asm.js')).default;
    if (typeof self !== 'undefined' && !(self as any).location) {
      (self as any).location = { href: 'http://localhost/', origin: 'http://localhost', protocol: 'http:', host: 'localhost', hostname: 'localhost', port: '80', pathname: '/', search: '', hash: '' };
    }
    const SQL2 = await initSqlJs2();
    const sdb = new SQL2.Database(sqliteEntry!.data as any);
    const res = sdb.exec(`SELECT storage_path FROM attachment_files WHERE id='att-1'`);
    const storagePath = res[0]?.values?.[0]?.[0];
    expect(storagePath).toBe('/data/attachments/u1/led-1/ab/att-1_photo.jpg');
    sdb.close();
  });
});