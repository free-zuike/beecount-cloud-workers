/**
 * SQLite 备份文件生成器 — 基于 sql.js（asm.js 变体，纯 JS 无需 WASM）
 * 把 D1 数据导出为标准 SQLite 二进制文件（db.sqlite3），与原版 Python
 * 的 VACUUM INTO 等效：
 *  - schema 完整保留（原样执行 sqlite_master 里的 DDL，含索引/触发器）
 *  - 运维类表只留 schema、清数据（对齐原版 db_snapshot.py DEFAULT_EXCLUDED_TABLES）
 *  - 输出 SQLite format 3 文件，原版（Python sqlite3）可直接打开恢复
 */

import initSqlJs from 'sql.js/dist/sql-asm.js';

/** 备份默认排除的"运维类"表（对齐原版 db_snapshot.py）：保留 schema、清数据 */
export const DEFAULT_EXCLUDED_TABLES = [
  'backup_runs',
  'backup_run_targets',
  'sync_push_idempotency',
  'audit_logs',
  'refresh_tokens',
  'mcp_call_logs',
];

/** sqlite_master 里属 SQLite/D1 内部实现的对象前缀，不进入备份 */
function isInternalObject(name: string): boolean {
  return name.startsWith('sqlite_') || name.startsWith('_cf_') || name === 'd1_meta' || name === 'd1_migrations';
}

const D1_BATCH_SIZE = 1000;

let sqlJsPromise: Promise<import('sql.js').SqlJsStatic> | null = null;

async function getSqlJs(): Promise<import('sql.js').SqlJsStatic> {
  if (!sqlJsPromise) {
    // sql.js 的 Emscripten loader 在 Workflows 环境可能缺少 self.location
    if (typeof self !== 'undefined' && !(self as any).location) {
      (self as any).location = { href: 'http://localhost/', origin: 'http://localhost', protocol: 'http:', host: 'localhost', hostname: 'localhost', port: '80', pathname: '/', search: '', hash: '' };
    }
    // 使用 sql-asm.js（纯 JS 实现，无需 WASM 编译，兼容 Cloudflare Workers）
    sqlJsPromise = initSqlJs();
  }
  return sqlJsPromise;
}

/** D1 值 → sql.js bind 可接受的值（BLOB 是 ArrayBuffer，转成 Uint8Array） */
function toBindable(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return v;
}

/**
 * 把 D1 全库导出为标准 SQLite 二进制（与原版 VACUUM INTO 等效）。
 * excludeTables 里的表保留 schema、不导数据。返回 db.sqlite3 的字节。
 */
export async function exportD1ToSqlite(
  db: D1Database,
  excludeTables: string[] = DEFAULT_EXCLUDED_TABLES,
  logFn?: (msg: string) => void,
): Promise<Uint8Array> {
  const log = logFn || (() => {});
  const SQL = await getSqlJs();
  const out = new SQL.Database();

  // 1. 原样执行全部 DDL（表/索引/视图/触发器），跳过内部对象
  const schemaResult = await db
    .prepare(`SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid`)
    .all<{ type: string; name: string; sql: string }>();
  const objects = (schemaResult.results || []).filter(o => o.name && !isInternalObject(o.name));
  let ddlFailed = 0;
  for (const obj of objects) {
    // CREATE INDEX/TRIGGER/VIEW 必须在引用的表创建之后执行——按 sqlite_master
    // rowid 顺序即建表在前，直接顺序执行即可
    try {
      out.run(obj.sql);
    } catch (e) {
      ddlFailed++;
      log(`[SQLite] DDL skipped ${obj.type} ${obj.name}: ${(e as Error).message}`);
    }
  }

  // 2. 逐表导数据（exclude 表只建 schema 不导数据；空表也跳过）
  const excludeSet = new Set(excludeTables);
  const dataTables = objects.filter(o => o.type === 'table' && !excludeSet.has(o.name));
  let totalRows = 0;
  let tableFailed = 0;

  for (const t of dataTables) {
    try {
      // 列清单（PRAGMA 保证空表也能拿到列）
      const colsResult = await db.prepare(`PRAGMA table_info("${t.name}")`).all<{ name: string }>();
      const columns = (colsResult.results || []).map(c => c.name);
      if (columns.length === 0) continue;

      const qmarks = columns.map(() => '?').join(',');
      const quoted = columns.map(c => `"${c}"`).join(',');
      let offset = 0;
      let tableCount = 0;
      while (true) {
        const rows = await db.prepare(`SELECT * FROM "${t.name}" LIMIT ? OFFSET ?`).bind(D1_BATCH_SIZE, offset).all<Record<string, unknown>>();
        const batch = rows.results || [];
        if (batch.length === 0) break;
        const stmt = out.prepare(`INSERT INTO "${t.name}" (${quoted}) VALUES (${qmarks})`);
        try {
          for (const row of batch) {
            stmt.run(columns.map(c => toBindable(row[c])));
          }
        } finally {
          stmt.free();
        }
        tableCount += batch.length;
        totalRows += batch.length;
        offset += batch.length;
        if (batch.length < D1_BATCH_SIZE) break;
      }
      log(`[SQLite] ${t.name}: ${tableCount} rows`);
    } catch (e) {
      tableFailed++;
      log(`[SQLite] Table ${t.name} failed, skipped: ${(e as Error).message}`);
    }
  }

  const bytes = out.export();
  out.close();
  log(`[SQLite] db.sqlite3 built: ${bytes.length} bytes, ${dataTables.length} tables, ${totalRows} rows (${ddlFailed} DDL / ${tableFailed} table failures)`);
  return bytes;
}

/**
 * 读取 sqlite 二进制 → 逐表行数据（恢复端用）。
 * 返回 { tables, skippedTables }，与原版"解包后直接用 sqlite3 读"等效。
 */
export async function readSqliteToTables(
  data: Uint8Array,
  skipTables: string[] = DEFAULT_EXCLUDED_TABLES,
  logFn?: (msg: string) => void,
): Promise<{ tables: Record<string, unknown[]>; skippedTables: string[] }> {
  const log = logFn || (() => {});
  const SQL = await getSqlJs();
  const src = new SQL.Database(data);
  const tables: Record<string, unknown[]> = {};
  const skippedTables: string[] = [];

  try {
    const list = src.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'`);
    const names = (list[0]?.values || []).map(v => String(v[0]));
    for (const name of names) {
      if (skipTables.includes(name)) { skippedTables.push(name); continue; }
      try {
        const res = src.exec(`SELECT * FROM "${name}"`);
        const columns = res[0]?.columns || [];
        const values = res[0]?.values || [];
        tables[name] = values.map(vals => {
          const row: Record<string, unknown> = {};
          for (let i = 0; i < columns.length; i++) {
            const val = vals[i];
            // sql.js 把 BLOB 读成 Uint8Array——D1 用 ArrayBuffer 语义，保持原样
            row[columns[i]] = val;
          }
          return row;
        });
        log(`[SQLite] read ${name}: ${tables[name].length} rows`);
      } catch (e) {
        log(`[SQLite] read ${name} failed, skipped: ${(e as Error).message}`);
      }
    }
  } finally {
    src.close();
  }
  return { tables, skippedTables };
}