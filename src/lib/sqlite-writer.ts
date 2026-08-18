/**
 * SQLite 备份文件生成器（已禁用——Workers 免费版 CPU 时间限制 10ms）
 *
 * sql.js 无论 WASM 还是 asm.js 变体，初始化即超过 10ms CPU 限制，
 * 无法在 Workflow 中使用。备份改用 db.json 格式。
 *
 * 此文件仅保留 readSqliteToTables（恢复端读取原版 db.sqlite3 用，
 * 运行在普通 API 请求中，有 30s CPU 时间）。
 *
 * 如需重新启用 db.sqlite3 生成，方案：
 * 1. 升级 Workers 付费计划（30s CPU 限制）
 * 2. 改用 D1 Export API（需配置 API token）
 */

/** 备份默认排除的"运维类"表（对齐原版 db_snapshot.py）：保留 schema、清数据 */
export const DEFAULT_EXCLUDED_TABLES = [
  'backup_runs',
  'backup_run_targets',
  'sync_push_idempotency',
  'audit_logs',
  'refresh_tokens',
  'mcp_call_logs',
];

/** 导出 D1 到 SQLite 二进制 — 禁用（Workers 免费版 CPU 限制） */
export async function exportD1ToSqlite(
  _db: D1Database,
  _excludeTables?: string[],
  _logFn?: (msg: string) => void,
): Promise<Uint8Array> {
  throw new Error('db.sqlite3 generation disabled: CPU time limit exceeded in Workers free plan');
}

/** sqlite_master 里属 SQLite/D1 内部实现的对象前缀，恢复时跳过 */
function isInternalObject(name: string): boolean {
  return name.startsWith('sqlite_') || name.startsWith('_cf_') || name === 'd1_meta' || name === 'd1_migrations';
}

/**
 * 读取 sqlite 二进制 → 逐表行数据（恢复端用）。
 * 仅在恢复 API 中调用（有 30s CPU 时间），可在 Worker 中运行 sql.js。
 */
export async function readSqliteToTables(
  data: Uint8Array,
  skipTables: string[] = DEFAULT_EXCLUDED_TABLES,
  logFn?: (msg: string) => void,
): Promise<{ tables: Record<string, unknown[]>; skippedTables: string[] }> {
  const log = logFn || (() => {});
  // 动态延迟加载，仅在恢复时触发（CPU 时间充足）
  const initSqlJs = (await import('sql.js/dist/sql-asm.js')).default;
  // Workflows 环境可能缺少 self.location
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
          for (let i = 0; i < columns.length; i++) {
            row[columns[i]] = vals[i];
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