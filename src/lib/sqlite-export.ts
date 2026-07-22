/**
 * D1 数据库导出为 SQLite 文件
 * 使用 sql.js WASM 在 Cloudflare Workers 上创建 db.sqlite3
 */
import initSqlJs, { Database } from 'sql.js';

/**
 * 将 D1 数据库导出为 SQLite 文件的 Uint8Array
 * 与原版 VACUUM INTO 输出格式兼容
 */
export async function exportToSqlite(
  db: D1Database,
  tables: Record<string, unknown[]>
): Promise<Uint8Array> {
  // 初始化 sql.js
  const SQL = await initSqlJs();

  // 创建内存中的 SQLite 数据库
  const sqliteDb = new SQL.Database();

  // 获取 D1 的表结构并创建表
  for (const [tableName, rows] of Object.entries(tables)) {
    if (!rows || rows.length === 0) continue;

    // 从第一行数据推断列名和类型
    const firstRow = rows[0] as Record<string, unknown>;
    const columns = Object.keys(firstRow);

    // 创建表语句
    const columnDefs = columns.map(col => {
      const value = firstRow[col];
      let sqlType = 'TEXT';
      if (typeof value === 'number') {
        sqlType = Number.isInteger(value) ? 'INTEGER' : 'REAL';
      } else if (typeof value === 'boolean') {
        sqlType = 'INTEGER';
      }
      return `"${col}" ${sqlType}`;
    }).join(', ');

    sqliteDb.run(`CREATE TABLE IF NOT EXISTS "${tableName}" (${columnDefs})`);

    // 插入数据
    for (const row of rows) {
      const record = row as Record<string, unknown>;
      const placeholders = columns.map(() => '?').join(', ');
      const values = columns.map(col => {
        const val = record[col];
        if (val === null || val === undefined) return null;
        if (typeof val === 'boolean') return val ? 1 : 0;
        if (typeof val === 'object') return JSON.stringify(val);
        return val;
      });
      sqliteDb.run(`INSERT INTO "${tableName}" VALUES (${placeholders})`, values);
    }
  }

  // 导出为 Uint8Array
  const data = sqliteDb.export();
  sqliteDb.close();

  return new Uint8Array(data);
}

/**
 * 创建包含索引的 SQLite 数据库
 * 与原版 schema 对齐
 */
export async function exportToSqliteWithSchema(
  db: D1Database,
  tables: Record<string, unknown[]>
): Promise<Uint8Array> {
  const SQL = await initSqlJs();
  const sqliteDb = new SQL.Database();

  // 创建与原版对齐的表结构
  const schema = `
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      is_admin BOOLEAN DEFAULT 0 NOT NULL,
      is_enabled BOOLEAN DEFAULT 1 NOT NULL,
      created_at TEXT NOT NULL,
      totp_secret_encrypted TEXT,
      totp_enabled BOOLEAN DEFAULT 0 NOT NULL,
      totp_enabled_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

    CREATE TABLE IF NOT EXISTS user_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT UNIQUE NOT NULL,
      display_name TEXT,
      avatar_file_id TEXT,
      avatar_version INTEGER DEFAULT 0,
      income_is_red BOOLEAN DEFAULT 1,
      theme_primary_color TEXT,
      appearance_json TEXT,
      ai_config_json TEXT,
      updated_at TEXT NOT NULL,
      primary_currency TEXT DEFAULT 'CNY'
    );

    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT DEFAULT 'Unknown Device',
      platform TEXT DEFAULT 'unknown',
      app_version TEXT,
      os_version TEXT,
      device_model TEXT,
      last_ip TEXT,
      last_seen_at TEXT NOT NULL,
      revoked_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ledgers (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      external_id TEXT NOT NULL,
      name TEXT,
      currency TEXT DEFAULT 'CNY' NOT NULL,
      role TEXT DEFAULT 'owner' NOT NULL,
      is_shared BOOLEAN DEFAULT 0 NOT NULL,
      invite_code TEXT,
      invite_expires_at TEXT,
      created_at TEXT NOT NULL,
      month_start_day INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS ledger_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ledger_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT DEFAULT 'editor' NOT NULL,
      joined_at TEXT NOT NULL,
      UNIQUE(ledger_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS ledger_invites (
      id TEXT PRIMARY KEY,
      ledger_id TEXT NOT NULL,
      code TEXT NOT NULL,
      target_role TEXT DEFAULT 'editor' NOT NULL,
      invited_by TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      used_by TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_changes (
      change_id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      ledger_id TEXT,
      entity_type TEXT NOT NULL,
      entity_sync_id TEXT NOT NULL,
      action TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by_device_id TEXT,
      updated_by_user_id TEXT,
      scope TEXT DEFAULT 'ledger'
    );
    CREATE INDEX IF NOT EXISTS idx_sync_changes_user_cursor ON sync_changes(user_id, change_id);

    CREATE TABLE IF NOT EXISTS sync_cursors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      ledger_external_id TEXT NOT NULL,
      last_cursor INTEGER DEFAULT 0 NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, device_id, ledger_external_id)
    );

    CREATE TABLE IF NOT EXISTS attachment_files (
      id TEXT PRIMARY KEY,
      ledger_id TEXT,
      user_id TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      size_bytes INTEGER DEFAULT 0,
      mime_type TEXT,
      file_name TEXT,
      storage_path TEXT NOT NULL,
      attachment_kind TEXT DEFAULT 'transaction' NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS personal_access_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      token_hash TEXT UNIQUE NOT NULL,
      prefix TEXT NOT NULL,
      scopes_json TEXT DEFAULT '[]' NOT NULL,
      expires_at TEXT,
      last_used_at TEXT,
      last_used_ip TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS backup_remotes (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      backend_type TEXT NOT NULL,
      config_summary TEXT NOT NULL,
      encrypted BOOLEAN DEFAULT 0 NOT NULL,
      last_test_at TEXT,
      last_test_ok BOOLEAN,
      last_test_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS backup_schedules (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      user_id TEXT NOT NULL,
      cron_expr TEXT NOT NULL,
      remote_ids TEXT,
      retention_days INTEGER DEFAULT 30,
      include_attachments BOOLEAN DEFAULT 1 NOT NULL,
      enabled BOOLEAN DEFAULT 1 NOT NULL,
      timezone_offset INTEGER DEFAULT 0,
      next_run_at TEXT,
      last_run_at TEXT,
      last_run_status TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS system_settings (
      id TEXT PRIMARY KEY,
      timezone_offset INTEGER DEFAULT 0,
      cloud_config_json TEXT,
      setup_completed BOOLEAN DEFAULT 0 NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recovery_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL
    );
  `;

  sqliteDb.run(schema);

  // 插入数据
  for (const [tableName, rows] of Object.entries(tables)) {
    if (!rows || rows.length === 0) continue;

    const firstRow = rows[0] as Record<string, unknown>;
    const columns = Object.keys(firstRow);

    // 检查表是否存在
    const tableCheck = sqliteDb.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='${tableName}'`);
    if (!tableCheck || tableCheck.length === 0 || tableCheck[0].values.length === 0) {
      // 表不存在，动态创建
      const columnDefs = columns.map(col => {
        const value = firstRow[col];
        let sqlType = 'TEXT';
        if (typeof value === 'number') {
          sqlType = Number.isInteger(value) ? 'INTEGER' : 'REAL';
        } else if (typeof value === 'boolean') {
          sqlType = 'INTEGER';
        }
        return `"${col}" ${sqlType}`;
      }).join(', ');
      sqliteDb.run(`CREATE TABLE IF NOT EXISTS "${tableName}" (${columnDefs})`);
    }

    // 获取实际列名（可能是表已有的列）
    const tableInfo = sqliteDb.exec(`PRAGMA table_info("${tableName}")`);
    const existingColumns = tableInfo.length > 0 ? tableInfo[0].values.map(v => v[1] as string) : columns;

    for (const row of rows) {
      const record = row as Record<string, unknown>;
      // 只插入存在的列
      const insertColumns = existingColumns.filter(col => col in record);
      const placeholders = insertColumns.map(() => '?').join(', ');
      const values = insertColumns.map(col => {
        const val = record[col];
        if (val === null || val === undefined) return null;
        if (typeof val === 'boolean') return val ? 1 : 0;
        if (typeof val === 'object') return JSON.stringify(val);
        return val;
      });
      sqliteDb.run(`INSERT INTO "${tableName}" (${insertColumns.map(c => `"${c}"`).join(', ')}) VALUES (${placeholders})`, values);
    }
  }

  // 创建索引
  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_users_is_admin ON users(is_admin)',
    'CREATE INDEX IF NOT EXISTS idx_users_is_enabled ON users(is_enabled)',
    'CREATE INDEX IF NOT EXISTS idx_user_profiles_user_id ON user_profiles(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_devices_user_id ON devices(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_devices_last_seen_at ON devices(last_seen_at)',
    'CREATE INDEX IF NOT EXISTS idx_devices_revoked_at ON devices(revoked_at)',
    'CREATE INDEX IF NOT EXISTS idx_ledgers_user_id ON ledgers(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_ledgers_external_id ON ledgers(external_id)',
    'CREATE INDEX IF NOT EXISTS idx_ledger_members_ledger_id ON ledger_members(ledger_id)',
    'CREATE INDEX IF NOT EXISTS idx_ledger_members_user_id ON ledger_members(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_ledger_invites_ledger_id ON ledger_invites(ledger_id)',
    'CREATE INDEX IF NOT EXISTS idx_ledger_invites_code ON ledger_invites(code)',
    'CREATE INDEX IF NOT EXISTS idx_sync_changes_ledger_cursor ON sync_changes(ledger_id, change_id)',
    'CREATE INDEX IF NOT EXISTS idx_sync_changes_entity_latest ON sync_changes(ledger_id, entity_type, entity_sync_id, change_id)',
    'CREATE INDEX IF NOT EXISTS idx_attachment_files_sha256 ON attachment_files(sha256)',
    'CREATE INDEX IF NOT EXISTS idx_attachment_files_ledger_created ON attachment_files(ledger_id, created_at)',
    'CREATE INDEX IF NOT EXISTS idx_pats_user_id ON personal_access_tokens(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_pats_token_hash ON personal_access_tokens(token_hash)',
    'CREATE INDEX IF NOT EXISTS idx_recovery_codes_user_id ON recovery_codes(user_id)',
  ];

  for (const idx of indexes) {
    try {
      sqliteDb.run(idx);
    } catch (e) {
      // 忽略索引创建错误
    }
  }

  // 导出为 Uint8Array
  const data = sqliteDb.export();
  sqliteDb.close();

  return new Uint8Array(data);
}
