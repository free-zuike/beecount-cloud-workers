/**
 * SQLite 备份文件生成器 — 使用 D1 Export API 导出标准 SQLite 二进制
 *
 * 通过 Cloudflare REST API 从 D1 服务端直接导出完整 SQLite 文件，
 * 不消耗 Worker CPU 时间（API 调用为 I/O 操作），等效原版 VACUUM INTO。
 *
 * 需要配置：
 *   - CLOUDFLARE_ACCOUNT_ID（wrangler.toml [vars]）
 *   - CLOUDFLARE_API_TOKEN（Cloudflare Dashboard → Secrets，D1.Read 权限）
 *   - D1_DATABASE_ID（wrangler.toml [vars]）
 */

// wrangler.toml [vars] 注入的全局变量
declare var CLOUDFLARE_ACCOUNT_ID: string | undefined;
declare var D1_DATABASE_ID: string | undefined;
declare var CLOUDFLARE_API_TOKEN: string | undefined;

/** 备份默认排除的"运维类"表（对齐原版 db_snapshot.py）：保留 schema、清数据 */
export const DEFAULT_EXCLUDED_TABLES = [
  'backup_runs',
  'backup_run_targets',
  'sync_push_idempotency',
  'audit_logs',
  'refresh_tokens',
  'mcp_call_logs',
];

/** sqlite_master 里属 SQLite/D1 内部实现的对象前缀，恢复时跳过 */
function isInternalObject(name: string): boolean {
  return name.startsWith('sqlite_') || name.startsWith('_cf_') || name === 'd1_meta' || name === 'd1_migrations';
}

/**
 * 通过 D1 Export API 导出标准 SQLite 二进制文件（等效原版 VACUUM INTO）。
 * 不消耗 Worker CPU 时间（API 调用为 I/O 操作）。
 */
export async function exportD1ToSqlite(
  _db: D1Database,
  _excludeTables?: string[],
  logFn?: (msg: string) => void,
): Promise<Uint8Array> {
  const log = logFn || (() => {});

  const accountId = typeof CLOUDFLARE_ACCOUNT_ID !== 'undefined' ? (CLOUDFLARE_ACCOUNT_ID as string) : undefined;
  const databaseId = typeof D1_DATABASE_ID !== 'undefined' ? (D1_DATABASE_ID as string) : undefined;
  const apiToken = typeof CLOUDFLARE_API_TOKEN !== 'undefined' ? (CLOUDFLARE_API_TOKEN as string) : undefined;

  if (!accountId) throw new Error('D1 Export: CLOUDFLARE_ACCOUNT_ID not configured');
  if (!databaseId) throw new Error('D1 Export: D1_DATABASE_ID not configured');
  if (!apiToken) throw new Error('D1 Export: CLOUDFLARE_API_TOKEN not configured in Secrets');

  log(`[D1 Export] Starting export of database ${databaseId}`);

  // 1. 发起导出请求
  const exportUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/export`;
  const exportRes = await fetch(exportUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  });

  if (!exportRes.ok) {
    const errText = await exportRes.text().catch(() => '');
    throw new Error(`D1 Export API error: ${exportRes.status} ${errText.slice(0, 200)}`);
  }

  const exportData = await exportRes.json() as any;
  log(`[D1 Export] Initiated: ${JSON.stringify(exportData).slice(0, 300)}`);

  // 2. 获取下载 URL（D1 Export API 返回的 result 中包含 download_url 或 upload_url）
  const result = exportData?.result;
  const downloadUrl = result?.download_url || result?.upload_url || result?.url;

  if (downloadUrl) {
    // 直接下载
    const fileRes = await fetch(downloadUrl);
    if (!fileRes.ok) throw new Error(`D1 Export download failed: ${fileRes.status}`);
    const buffer = await fileRes.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    log(`[D1 Export] Downloaded: ${bytes.length} bytes`);
    return bytes;
  }

  // 3. 异步模式：轮询导出状态
  const statusUrl = result?.status_url || exportUrl + '?current=1';
  const maxAttempts = 30;
  for (let i = 0; i < maxAttempts; i++) {
    log(`[D1 Export] Polling status (${i + 1}/${maxAttempts})...`);
    await new Promise(resolve => setTimeout(resolve, 2000));
    const statusRes = await fetch(statusUrl, {
      headers: { 'Authorization': `Bearer ${apiToken}` },
    });
    if (!statusRes.ok) continue;
    const statusData = await statusRes.json() as any;
    const statusResult = statusData?.result;
    if (statusResult?.download_url || statusResult?.upload_url || statusResult?.url) {
      const fileUrl = statusResult.download_url || statusResult.upload_url || statusResult.url;
      const fileRes = await fetch(fileUrl);
      if (!fileRes.ok) throw new Error(`D1 Export download failed: ${fileRes.status}`);
      const buffer = await fileRes.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      log(`[D1 Export] Downloaded: ${bytes.length} bytes`);
      return bytes;
    }
    if (statusResult?.status === 'error' || statusData?.errors?.length > 0) {
      throw new Error(`D1 Export failed: ${JSON.stringify(statusData.errors || statusResult)}`);
    }
  }

  throw new Error('D1 Export timed out waiting for download URL');
}

/**
 * 读取 sqlite 二进制 → 逐表行数据（恢复端用）。
 * 仅在恢复 API 中调用（有 30s CPU 时间），动态加载 sql.js asm.js。
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