/**
 * SQLite 备份文件生成器 — 拆分原子操作用于 Workflow step.do 串联
 *
 * 每个函数独立、轻量，可在 Workflow 的 step.do 中单独调用，每步独立 CPU 预算。
 * 调用方（workflows/backup.ts）负责串联步骤：
 *   1. exportD1Init  → 初始化 sql.js + 执行 DDL
 *   2. exportD1InsertBatch  → 逐批插数据（循环调用）
 *   3. 最终 state 就是 db.sqlite3 字节
 */

// wrangler.toml [vars] 注入的全局变量
declare var CLOUDFLARE_ACCOUNT_ID: string | undefined;
declare var D1_DATABASE_ID: string | undefined;

/** 备份默认排除的"运维类"表（对齐原版 db_snapshot.py）：保留 schema、清数据 */
export const DEFAULT_EXCLUDED_TABLES = [
  'backup_runs', 'backup_run_targets', 'sync_push_idempotency',
  'audit_logs', 'refresh_tokens', 'mcp_call_logs',
];

function isInternalObject(name: string): boolean {
  return name.startsWith('sqlite_') || name.startsWith('_cf_') || name === 'd1_meta' || name === 'd1_migrations';
}

/**
 * Step 1: 初始化 sql.js + 执行 DDL，返回空库 state。
 * 每个 step.do 独立 CPU 预算，此步只做初始化+DDL。
 */
export async function exportD1Init(
  db: D1Database,
  logFn?: (msg: string) => void,
): Promise<Uint8Array> {
  const log = logFn || (() => {});
  const initSqlJs = (await import('sql.js/dist/sql-asm.js')).default;
  if (typeof self !== 'undefined' && !(self as any).location) {
    (self as any).location = { href: 'http://localhost/', origin: 'http://localhost', protocol: 'http:', host: 'localhost', hostname: 'localhost', port: '80', pathname: '/', search: '', hash: '' };
  }
  const SQL = await initSqlJs();
  const out = new SQL.Database();
  out.run('PRAGMA synchronous = OFF');
  out.run('PRAGMA journal_mode = MEMORY');
  out.run('PRAGMA cache_size = -64000');

  const schema = await db.prepare(`SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid`).all<{ type: string; name: string; sql: string }>();
  const objects = (schema.results || []).filter(o => o.name && !isInternalObject(o.name));
  let failed = 0;
  for (const obj of objects) {
    try { out.run(obj.sql); } catch (e) { failed++; log(`[SQLite] DDL skipped ${obj.type} ${obj.name}`); }
  }
  const bytes = out.export();
  out.close();
  log(`[SQLite] Init done: ${objects.filter(o => o.type === 'table').length} tables, ${failed} DDL failures`);
  return bytes;
}

/**
 * Step 2-N: 加载 state，插入一批表的数据，返回新 state。
 * @param state 上一步导出的 sql.js 二进制
 * @param tableNames 本次要插入数据的表名列表
 * @returns 新 state；tables 为空时直接返回原 state
 */
export async function exportD1InsertBatch(
  db: D1Database,
  state: Uint8Array,
  tableNames: string[],
  logFn?: (msg: string) => void,
): Promise<Uint8Array> {
  const log = logFn || (() => {});
  if (!tableNames.length) return state;

  const initSqlJs = (await import('sql.js/dist/sql-asm.js')).default;
  if (typeof self !== 'undefined' && !(self as any).location) {
    (self as any).location = { href: 'http://localhost/', origin: 'http://localhost', protocol: 'http:', host: 'localhost', hostname: 'localhost', port: '80', pathname: '/', search: '', hash: '' };
  }
  const SQL = await initSqlJs();
  const out = new SQL.Database(state);
  out.run('PRAGMA synchronous = OFF');
  out.run('PRAGMA journal_mode = MEMORY');
  out.run('PRAGMA cache_size = -64000');

  const excludeSet = new Set(DEFAULT_EXCLUDED_TABLES);
  let totalRows = 0;
  for (const name of tableNames) {
    if (excludeSet.has(name)) continue;
    try {
      const cols = await db.prepare(`PRAGMA table_info("${name}")`).all<{ name: string }>();
      const columns = (cols.results || []).map(c => c.name);
      if (!columns.length) continue;
      const qmarks = columns.map(() => '?').join(',');
      const quoted = columns.map(c => `"${c}"`).join(',');
      let offset = 0;
      let count = 0;
      out.run('BEGIN');
      while (true) {
        const rows = await db.prepare(`SELECT * FROM "${name}" LIMIT ? OFFSET ?`).bind(1000, offset).all<Record<string, unknown>>();
        const batch = rows.results || [];
        if (!batch.length) break;
        const stmt = out.prepare(`INSERT INTO "${name}" (${quoted}) VALUES (${qmarks})`);
        for (const row of batch) {
          const vals = columns.map(c => {
            const v = row[c];
            if (v === null || v === undefined) return null;
            if (typeof v === 'boolean') return v ? 1 : 0;
            if (v instanceof ArrayBuffer) return new Uint8Array(v);
            return v;
          });
          stmt.run(vals);
        }
        stmt.free();
        count += batch.length;
        offset += batch.length;
        if (batch.length < 1000) break;
      }
      out.run('COMMIT');
      totalRows += count;
      log(`[SQLite] ${name}: ${count} rows`);
    } catch (e) {
      log(`[SQLite] ${name} failed, skipped: ${(e as Error).message}`);
    }
  }
  const bytes = out.export();
  out.close();
  log(`[SQLite] Insert batch done: ${tableNames.length} tables, ${totalRows} rows`);
  return bytes;
}

/**
 * 导出 SQLite 二进制文件，优先级：
 *   1. D1 binding dump() — 最快，无需 token
 *   2. D1 Export API — I/O 操作，不耗 CPU，需 CLOUDFLARE_API_TOKEN
 *   3. sql.js 逐表导出 — CPU 密集型，免费版不可用，Workers Paid 可用
 */
export async function exportD1ToSqlite(
  db: D1Database,
  _excludeTables?: string[],
  logFn?: (msg: string) => void,
  apiToken?: string | null, // 从 Workflow env 传入，避免 Secret 无法作为全局变量
): Promise<Uint8Array> {
  const log = logFn || (() => {});

  // 方案 A: db.dump() — 最快路径
  try {
    const buffer = await db.dump();
    const bytes = new Uint8Array(buffer);
    log(`[SQLite] dump() succeeded: ${bytes.length} bytes`);
    return bytes;
  } catch (e) {
    log(`[SQLite] dump() failed: ${(e as Error).message}`);
  }

  // 方案 B: D1 Export API — I/O 操作，不耗 CPU
  const accountId = typeof CLOUDFLARE_ACCOUNT_ID !== 'undefined' ? (CLOUDFLARE_ACCOUNT_ID as string) : undefined;
  const databaseId = typeof D1_DATABASE_ID !== 'undefined' ? (D1_DATABASE_ID as string) : undefined;
  log(`[SQLite] Export API check: token=${!!apiToken} account=${!!accountId} db=${!!databaseId}`);
  if (apiToken && accountId && databaseId) {
    log(`[SQLite] Using D1 Export API...`);
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/export`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
    });
    if (res.ok) {
      const data = await res.json() as any;
      const downloadUrl = data?.result?.download_url || data?.result?.upload_url || data?.result?.url;
      if (downloadUrl) {
        const fileRes = await fetch(downloadUrl);
        if (fileRes.ok) {
          const buffer = await fileRes.arrayBuffer();
          const bytes = new Uint8Array(buffer);
          log(`[SQLite] Export API: ${bytes.length} bytes`);
          return bytes;
        }
      }
    }
    log(`[SQLite] Export API failed: ${res.status}`);
  }

  // 方案 C: sql.js 逐表导出（CPU 密集型，免费版可能超时）
  log(`[SQLite] Falling back to sql.js (CPU-intensive)`);
  let state = await exportD1Init(db, log);
  const allTables = await db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' ORDER BY name`).all<{ name: string }>();
  const names = ((allTables.results || []).map(x => x.name)).filter(n => !DEFAULT_EXCLUDED_TABLES.includes(n));
  const BATCH = 5;
  for (let i = 0; i < names.length; i += BATCH) {
    state = await exportD1InsertBatch(db, state, names.slice(i, i + BATCH), log);
  }
  log(`[SQLite] sql.js fallback: ${state.length} bytes`);
  return state;
}

/**
 * 读取 sqlite 二进制 → 逐表行数据（恢复端用）。
 */
export async function readSqliteToTables(
  data: Uint8Array,
  skipTables: string[] = DEFAULT_EXCLUDED_TABLES,
  logFn?: (msg: string) => void,
): Promise<{ tables: Record<string, unknown[]>; skippedTables: string[] }> {
  const log = logFn || (() => {});
  const initSqlJs = (await import('sql.js/dist/sql-asm.js')).default;
  if (typeof self !== 'undefined' && !(self as any).location) {
    (self as any).location = { href: 'http://localhost/', origin: 'http://localhost', protocol: 'http:', host: 'localhost', hostname: 'localhost', port: '80', pathname: '/', search: '', hash: '' };
  }
  const SQL = await initSqlJs();
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
          for (let i = 0; i < columns.length; i++) row[columns[i]] = vals[i];
          return row;
        });
        log(`[SQLite] read ${name}: ${tables[name].length} rows`);
      } catch (e) {
        log(`[SQLite] read ${name} failed, skipped: ${(e as Error).message}`);
      }
    }
  } finally { src.close(); }
  return { tables, skippedTables };
}