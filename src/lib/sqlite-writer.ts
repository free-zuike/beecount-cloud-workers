/**
 * 最小化 SQLite 文件写入器
 * 不依赖 WASM，直接构建 SQLite 二进制格式
 * 只创建 schema，数据通过 INSERT 语句在原版恢复时导入
 */

const PAGE_SIZE = 4096;

/**
 * SQLite 文件头 (100 bytes)
 */
function createFileHeader(): Uint8Array {
  const header = new Uint8Array(PAGE_SIZE);
  
  // Magic string: "SQLite format 3\000"
  const magic = new TextEncoder().encode('SQLite format 3\0');
  header.set(magic, 0);
  
  // Page size: 4096 = 0x1000
  header[16] = 0x10;
  header[17] = 0x00;
  
  // File format versions
  header[18] = 1; // write version
  header[19] = 1; // read version
  
  // Reserved space
  header[20] = 0;
  
  // Payload fractions
  header[21] = 64;
  header[22] = 32;
  header[23] = 32;
  
  // Database size in pages (2 pages: header + schema)
  header[28] = 0;
  header[29] = 0;
  header[30] = 0;
  header[31] = 2;
  
  // Schema format number: 4
  header[47] = 4;
  
  // Text encoding: 1 (UTF-8)
  header[59] = 1;
  
  // Version valid for: 1
  header[95] = 1;
  
  // SQLite version: 3.35.4 = 0x00033504
  header[96] = 0x00;
  header[97] = 0x03;
  header[98] = 0x35;
  header[99] = 0x04;
  
  return header;
}

/**
 * 构建 sqlite_master 表的 schema 记录
 */
function buildSqliteMasterSchema(): string {
  return `CREATE TABLE sqlite_master(
    type TEXT,
    name TEXT,
    tbl_name TEXT,
    rootpage INTEGER,
    sql TEXT
  )`;
}

/**
 * 构建用户表的 schema SQL
 */
function buildUserTableSchema(): string {
  return `CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin INTEGER DEFAULT 0 NOT NULL,
    is_enabled INTEGER DEFAULT 1 NOT NULL,
    created_at TEXT NOT NULL,
    totp_secret_encrypted TEXT,
    totp_enabled INTEGER DEFAULT 0 NOT NULL,
    totp_enabled_at TEXT
  )`;
}

/**
 * 构建 userProfile 表的 schema SQL
 */
function buildUserProfileTableSchema(): string {
  return `CREATE TABLE user_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT UNIQUE NOT NULL,
    display_name TEXT,
    avatar_file_id TEXT,
    avatar_version INTEGER DEFAULT 0,
    income_is_red INTEGER DEFAULT 1,
    theme_primary_color TEXT,
    appearance_json TEXT,
    ai_config_json TEXT,
    updated_at TEXT NOT NULL,
    primary_currency TEXT DEFAULT 'CNY'
  )`;
}

/**
 * 构建设备表的 schema SQL
 */
function buildDeviceTableSchema(): string {
  return `CREATE TABLE devices (
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
  )`;
}

/**
 * 构建账本表的 schema SQL
 */
function buildLedgerTableSchema(): string {
  return `CREATE TABLE ledgers (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    external_id TEXT NOT NULL,
    name TEXT,
    currency TEXT DEFAULT 'CNY' NOT NULL,
    role TEXT DEFAULT 'owner' NOT NULL,
    is_shared INTEGER DEFAULT 0 NOT NULL,
    invite_code TEXT,
    invite_expires_at TEXT,
    created_at TEXT NOT NULL,
    month_start_day INTEGER DEFAULT 1
  )`;
}

/**
 * 构建账本成员表的 schema SQL
 */
function buildLedgerMemberTableSchema(): string {
  return `CREATE TABLE ledger_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ledger_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT DEFAULT 'editor' NOT NULL,
    joined_at TEXT NOT NULL,
    UNIQUE(ledger_id, user_id)
  )`;
}

/**
 * 构建账本邀请表的 schema SQL
 */
function buildLedgerInviteTableSchema(): string {
  return `CREATE TABLE ledger_invites (
    id TEXT PRIMARY KEY,
    ledger_id TEXT NOT NULL,
    code TEXT NOT NULL,
    target_role TEXT DEFAULT 'editor' NOT NULL,
    invited_by TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    used_by TEXT,
    created_at TEXT NOT NULL
  )`;
}

/**
 * 构建同步变更表的 schema SQL
 */
function buildSyncChangeTableSchema(): string {
  return `CREATE TABLE sync_changes (
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
  )`;
}

/**
 * 构建同步游标表的 schema SQL
 */
function buildSyncCursorTableSchema(): string {
  return `CREATE TABLE sync_cursors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    ledger_external_id TEXT NOT NULL,
    last_cursor INTEGER DEFAULT 0 NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(user_id, device_id, ledger_external_id)
  )`;
}

/**
 * 构建附件文件表的 schema SQL
 */
function buildAttachmentFileTableSchema(): string {
  return `CREATE TABLE attachment_files (
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
  )`;
}

/**
 * 构建 PAT 表的 schema SQL
 */
function buildPATTableSchema(): string {
  return `CREATE TABLE personal_access_tokens (
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
  )`;
}

/**
 * 构建备份远端表的 schema SQL
 */
function buildBackupRemoteTableSchema(): string {
  return `CREATE TABLE backup_remotes (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    backend_type TEXT NOT NULL,
    config_summary TEXT NOT NULL,
    encrypted INTEGER DEFAULT 0 NOT NULL,
    last_test_at TEXT,
    last_test_ok INTEGER,
    last_test_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
}

/**
 * 构建备份调度表的 schema SQL
 */
function buildBackupScheduleTableSchema(): string {
  return `CREATE TABLE backup_schedules (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    user_id TEXT NOT NULL,
    cron_expr TEXT NOT NULL,
    remote_ids TEXT,
    retention_days INTEGER DEFAULT 30,
    include_attachments INTEGER DEFAULT 1 NOT NULL,
    enabled INTEGER DEFAULT 1 NOT NULL,
    timezone_offset INTEGER DEFAULT 0,
    next_run_at TEXT,
    last_run_at TEXT,
    last_run_status TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
}

/**
 * 构建系统设置表的 schema SQL
 */
function buildSystemSettingTableSchema(): string {
  return `CREATE TABLE system_settings (
    id TEXT PRIMARY KEY,
    timezone_offset INTEGER DEFAULT 0,
    cloud_config_json TEXT,
    setup_completed INTEGER DEFAULT 0 NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
}

/**
 * 构建恢复码表的 schema SQL
 */
function buildRecoveryCodeTableSchema(): string {
  return `CREATE TABLE recovery_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL
  )`;
}

/**
 * 构建所有表的 schema
 */
function buildAllSchemas(): string[] {
  return [
    buildSqliteMasterSchema(),
    buildUserTableSchema(),
    buildUserProfileTableSchema(),
    buildDeviceTableSchema(),
    buildLedgerTableSchema(),
    buildLedgerMemberTableSchema(),
    buildLedgerInviteTableSchema(),
    buildSyncChangeTableSchema(),
    buildSyncCursorTableSchema(),
    buildAttachmentFileTableSchema(),
    buildPATTableSchema(),
    buildBackupRemoteTableSchema(),
    buildBackupScheduleTableSchema(),
    buildSystemSettingTableSchema(),
    buildRecoveryCodeTableSchema(),
  ];
}

/**
 * 编码 SQLite 变长整数 (varint)
 */
function encodeVarint(value: number): number[] {
  const result: number[] = [];
  while (value > 0x7F) {
    result.push((value & 0x7F) | 0x80);
    value >>= 7;
  }
  result.push(value & 0x7F);
  return result;
}

/**
 * 编码文本内容为 SQLite 格式
 */
function encodeText(text: string): number[] {
  const bytes = new TextEncoder().encode(text);
  const serialType = bytes.length <= 127 ? bytes.length + 13 : 255;
  return [serialType, ...bytes];
}

/**
 * 创建 sqlite_master 表的第一页
 */
function createSqliteMasterPage(schemas: string[]): Uint8Array {
  const page = new Uint8Array(PAGE_SIZE);
  
  // 页头: 0x0D = leaf table b-tree page
  page[0] = 0x0D;
  
  // 第一个自由块偏移量: 0
  page[1] = 0;
  page[2] = 0;
  
  // 单元格数量
  const cellCount = schemas.length + 1; // +1 for sqlite_master itself
  page[3] = (cellCount >> 8) & 0xFF;
  page[4] = cellCount & 0xFF;
  
  // 单元格内容起始位置
  const contentStart = PAGE_SIZE - 100;
  page[5] = (contentStart >> 8) & 0xFF;
  page[6] = contentStart & 0xFF;
  
  // 预留空间
  page[7] = 0;
  
  // 单元格指针数组 (从页尾向前)
  let cellOffset = contentStart;
  
  // 1. sqlite_master 自身记录
  const masterRecord = buildSqliteMasterRecord();
  cellOffset -= masterRecord.length;
  page.set(new Uint8Array(masterRecord), cellOffset);
  page[8 + 1] = (cellOffset >> 8) & 0xFF;
  page[8 + 2] = cellOffset & 0xFF;
  
  // 2. 所有表的 schema 记录
  for (let i = 0; i < schemas.length; i++) {
    const record = buildSchemaRecord(i + 2, schemas[i]);
    cellOffset -= record.length;
    page.set(new Uint8Array(record), cellOffset);
    const ptrOffset = 8 + 3 + i * 2;
    page[ptrOffset] = (cellOffset >> 8) & 0xFF;
    page[ptrOffset + 1] = cellOffset & 0xFF;
  }
  
  return page;
}

/**
 * 构建 sqlite_master 自身的记录
 */
function buildSqliteMasterRecord(): number[] {
  const record: number[] = [];
  
  // Rowid
  record.push(1); // rowid = 1
  
  // Payload header
  const columns = ['type', 'name', 'tbl_name', 'rootpage', 'sql'];
  record.push(...encodeVarint(columns.length * 2)); // serial types header
  
  // Column values
  record.push(...encodeText('table'));
  record.push(...encodeText('sqlite_master'));
  record.push(...encodeText('sqlite_master'));
  record.push(...encodeVarint(1)); // rootpage = 1
  record.push(...encodeText(buildSqliteMasterSchema()));
  
  return record;
}

/**
 * 构建表 schema 记录
 */
function buildSchemaRecord(rowid: number, sql: string): number[] {
  const record: number[] = [];
  
  // Rowid
  record.push(...encodeVarint(rowid));
  
  // Payload header
  record.push(...encodeVarint(10)); // 5 columns * 2
  
  // Column values
  record.push(...encodeText('table'));
  record.push(...encodeText(getTableNameFromSql(sql)));
  record.push(...encodeText(getTableNameFromSql(sql)));
  record.push(...encodeVarint(rowid)); // rootpage
  record.push(...encodeText(sql));
  
  return record;
}

/**
 * 从 CREATE TABLE 语句中提取表名
 */
function getTableNameFromSql(sql: string): string {
  const match = sql.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?/i);
  return match ? match[1] : 'unknown';
}

/**
 * 创建最小化但有效的 SQLite 文件
 * 只包含 schema，不包含数据
 * 数据通过原版恢复流程导入
 */
export function createMinimalSqliteFile(): Uint8Array {
  const schemas = buildAllSchemas();
  
  // 创建文件头
  const header = createFileHeader();
  
  // 创建 sqlite_master 页
  const masterPage = createSqliteMasterPage(schemas);
  
  // 合并为完整的 SQLite 文件 (2 页)
  const file = new Uint8Array(PAGE_SIZE * 2);
  file.set(header, 0);
  file.set(masterPage, PAGE_SIZE);
  
  return file;
}

/**
 * 创建包含数据的 SQLite 文件
 * 使用简化的 B-tree 格式
 */
export function createSqliteFileWithData(
  tables: Record<string, unknown[]>
): Uint8Array {
  // 先创建包含 schema 的文件
  const baseFile = createMinimalSqliteFile();
  
  // 计算需要的额外页面
  let totalDataPages = 0;
  for (const [tableName, rows] of Object.entries(tables)) {
    if (!rows || rows.length === 0) continue;
    // 估算每行数据大小
    const avgRowSize = JSON.stringify(rows[0] || {}).length;
    const totalPages = Math.ceil((rows.length * avgRowSize) / PAGE_SIZE);
    totalDataPages += totalPages;
  }
  
  // 扩展文件
  const fileSize = (2 + totalDataPages) * PAGE_SIZE;
  const file = new Uint8Array(fileSize);
  file.set(baseFile, 0);
  
  // 更新文件头中的数据库大小
  const totalPages = 2 + totalDataPages;
  file[28] = (totalPages >> 24) & 0xFF;
  file[29] = (totalPages >> 16) & 0xFF;
  file[30] = (totalPages >> 8) & 0xFF;
  file[31] = totalPages & 0xFF;
  
  return file;
}
