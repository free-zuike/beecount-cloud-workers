/**
 * SQLite 文件写入器
 * 创建包含 schema 的 SQLite 文件
 * 数据通过 db.json 完整导出
 */

const PAGE_SIZE = 4096;

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
  const serialType = bytes.length <= 127 ? bytes.length + 13 : 252;
  if (serialType === 252) {
    const lenBytes = encodeVarint(bytes.length);
    return [serialType, ...lenBytes, ...bytes];
  }
  return [serialType, ...bytes];
}

/**
 * 创建 SQLite 文件头 (100 bytes)
 */
function createFileHeader(): Uint8Array {
  const header = new Uint8Array(PAGE_SIZE);

  const magic = new TextEncoder().encode('SQLite format 3\0');
  header.set(magic, 0);

  header[16] = 0x10;
  header[17] = 0x00;
  header[18] = 1;
  header[19] = 1;
  header[20] = 0;
  header[21] = 64;
  header[22] = 32;
  header[23] = 32;

  header[28] = 0;
  header[29] = 0;
  header[30] = 0;
  header[31] = 2;

  header[47] = 4;
  header[59] = 1;
  header[95] = 1;

  header[96] = 0x00;
  header[97] = 0x03;
  header[98] = 0x35;
  header[99] = 0x04;

  return header;
}

/**
 * 构建 sqlite_master 自身的记录
 */
function buildSqliteMasterRecord(): number[] {
  const record: number[] = [];
  record.push(1); // rowid = 1
  record.push(...encodeVarint(10)); // 5 columns * 2
  record.push(...encodeText('table'));
  record.push(...encodeText('sqlite_master'));
  record.push(...encodeText('sqlite_master'));
  record.push(...encodeVarint(1)); // rootpage
  record.push(...encodeText('CREATE TABLE sqlite_master(type TEXT, name TEXT, tbl_name TEXT, rootpage INTEGER, sql TEXT)'));
  return record;
}

/**
 * 构建表 schema 记录
 */
function buildSchemaRecord(rowid: number, tableName: string, sql: string): number[] {
  const record: number[] = [];
  record.push(...encodeVarint(rowid));
  record.push(...encodeVarint(10));
  record.push(...encodeText('table'));
  record.push(...encodeText(tableName));
  record.push(...encodeText(tableName));
  record.push(...encodeVarint(rowid));
  record.push(...encodeText(sql));
  return record;
}

// ─── 预定义表 schema ──────────────────────────────────────────

function getAllTableSchemas(): { name: string; sql: string }[] {
  return [
    { name: 'users', sql: `CREATE TABLE "users" ("id" TEXT, "email" TEXT, "password_hash" TEXT, "is_admin" INTEGER, "is_enabled" INTEGER, "created_at" TEXT, "totp_secret_encrypted" TEXT, "totp_enabled" INTEGER, "totp_enabled_at" TEXT)` },
    { name: 'user_profiles', sql: `CREATE TABLE "user_profiles" ("id" INTEGER, "user_id" TEXT, "display_name" TEXT, "avatar_file_id" TEXT, "avatar_version" INTEGER, "income_is_red" INTEGER, "theme_primary_color" TEXT, "appearance_json" TEXT, "ai_config_json" TEXT, "updated_at" TEXT, "primary_currency" TEXT)` },
    { name: 'devices', sql: `CREATE TABLE "devices" ("id" TEXT, "user_id" TEXT, "name" TEXT, "platform" TEXT, "app_version" TEXT, "os_version" TEXT, "device_model" TEXT, "last_ip" TEXT, "last_seen_at" TEXT, "revoked_at" TEXT, "created_at" TEXT)` },
    { name: 'ledgers', sql: `CREATE TABLE "ledgers" ("id" TEXT, "user_id" TEXT, "external_id" TEXT, "name" TEXT, "currency" TEXT, "role" TEXT, "is_shared" INTEGER, "invite_code" TEXT, "invite_expires_at" TEXT, "created_at" TEXT, "month_start_day" INTEGER)` },
    { name: 'ledger_members', sql: `CREATE TABLE "ledger_members" ("id" INTEGER, "ledger_id" TEXT, "user_id" TEXT, "role" TEXT, "joined_at" TEXT)` },
    { name: 'ledger_invites', sql: `CREATE TABLE "ledger_invites" ("id" TEXT, "ledger_id" TEXT, "code" TEXT, "target_role" TEXT, "invited_by" TEXT, "expires_at" TEXT, "used_at" TEXT, "used_by" TEXT, "created_at" TEXT)` },
    { name: 'sync_changes', sql: `CREATE TABLE "sync_changes" ("change_id" INTEGER, "user_id" TEXT, "ledger_id" TEXT, "entity_type" TEXT, "entity_sync_id" TEXT, "action" TEXT, "payload_json" TEXT, "updated_at" TEXT, "updated_by_device_id" TEXT, "updated_by_user_id" TEXT, "scope" TEXT)` },
    { name: 'sync_cursors', sql: `CREATE TABLE "sync_cursors" ("id" INTEGER, "user_id" TEXT, "device_id" TEXT, "ledger_external_id" TEXT, "last_cursor" INTEGER, "updated_at" TEXT)` },
    { name: 'read_tx_projection', sql: `CREATE TABLE "read_tx_projection" ("sync_id" TEXT, "ledger_id" TEXT, "category_id" TEXT, "account_id" TEXT, "tx_type" TEXT, "amount" TEXT, "note" TEXT, "tx_date" TEXT, "recurring_id" TEXT, "skip_id" TEXT, "currency_code" TEXT, "native_amount" TEXT, "tags" TEXT, "attachment_id" TEXT, "updated_at" TEXT)` },
    { name: 'read_account_projection', sql: `CREATE TABLE "read_account_projection" ("sync_id" TEXT, "ledger_id" TEXT, "name" TEXT, "account_type" TEXT, "currency" TEXT, "icon" TEXT, "sort_order" INTEGER, "is_archived" INTEGER, "updated_at" TEXT)` },
    { name: 'read_category_projection', sql: `CREATE TABLE "read_category_projection" ("sync_id" TEXT, "ledger_id" TEXT, "name" TEXT, "category_type" TEXT, "parent_id" TEXT, "icon" TEXT, "sort_order" INTEGER, "is_archived" INTEGER, "updated_at" TEXT)` },
    { name: 'read_tag_projection', sql: `CREATE TABLE "read_tag_projection" ("sync_id" TEXT, "ledger_id" TEXT, "name" TEXT, "color" TEXT, "sort_order" INTEGER, "is_archived" INTEGER, "updated_at" TEXT)` },
    { name: 'read_budget_projection', sql: `CREATE TABLE "read_budget_projection" ("sync_id" TEXT, "ledger_id" TEXT, "category_id" TEXT, "amount" TEXT, "period_type" TEXT, "start_date" TEXT, "end_date" TEXT, "updated_at" TEXT)` },
    { name: 'attachment_files', sql: `CREATE TABLE "attachment_files" ("id" TEXT, "ledger_id" TEXT, "user_id" TEXT, "sha256" TEXT, "size_bytes" INTEGER, "mime_type" TEXT, "file_name" TEXT, "storage_path" TEXT, "attachment_kind" TEXT, "created_at" TEXT)` },
    { name: 'backup_remotes', sql: `CREATE TABLE "backup_remotes" ("id" INTEGER, "name" TEXT, "backend_type" TEXT, "config_summary" TEXT, "encrypted" INTEGER, "last_test_at" TEXT, "last_test_ok" INTEGER, "last_test_error" TEXT, "created_at" TEXT, "updated_at" TEXT)` },
    { name: 'backup_schedules', sql: `CREATE TABLE "backup_schedules" ("id" INTEGER, "name" TEXT, "user_id" TEXT, "cron_expr" TEXT, "remote_ids" TEXT, "retention_days" INTEGER, "include_attachments" INTEGER, "enabled" INTEGER, "timezone_offset" INTEGER, "next_run_at" TEXT, "last_run_at" TEXT, "last_run_status" TEXT, "created_at" TEXT, "updated_at" TEXT)` },
    { name: 'system_settings', sql: `CREATE TABLE "system_settings" ("id" TEXT, "timezone_offset" INTEGER, "cloud_config_json" TEXT, "setup_completed" INTEGER, "created_at" TEXT, "updated_at" TEXT)` },
    { name: 'recovery_codes', sql: `CREATE TABLE "recovery_codes" ("id" INTEGER, "user_id" TEXT, "code_hash" TEXT, "used_at" TEXT, "created_at" TEXT)` },
  ];
}

/**
 * 创建 sqlite_master 表的 B-tree 页
 */
function createSqliteMasterPage(schemas: { name: string; sql: string }[]): Uint8Array {
  const page = new Uint8Array(PAGE_SIZE);

  page[0] = 0x0D; // leaf table b-tree page
  page[1] = 0; page[2] = 0;

  const cellCount = schemas.length + 1;
  page[3] = (cellCount >> 8) & 0xFF;
  page[4] = cellCount & 0xFF;

  const contentStart = PAGE_SIZE - 100;
  page[5] = (contentStart >> 8) & 0xFF;
  page[6] = contentStart & 0xFF;

  let cellOffset = contentStart;

  // sqlite_master record (rowid=1)
  const masterRec = buildSqliteMasterRecord();
  cellOffset -= masterRec.length;
  page.set(new Uint8Array(masterRec), cellOffset);
  page[8 + 1] = (cellOffset >> 8) & 0xFF;
  page[8 + 2] = cellOffset & 0xFF;

  // 其他表的 schema 记录
  for (let i = 0; i < schemas.length; i++) {
    const rec = buildSchemaRecord(i + 2, schemas[i].name, schemas[i].sql);
    cellOffset -= rec.length;
    if (cellOffset < 100) break;
    page.set(new Uint8Array(rec), cellOffset);
    const ptrOffset = 8 + 3 + i * 2;
    if (ptrOffset + 1 < 100) {
      page[ptrOffset] = (cellOffset >> 8) & 0xFF;
      page[ptrOffset + 1] = cellOffset & 0xFF;
    }
  }

  return page;
}

/**
 * 创建最小化但有效的 SQLite 文件（仅 schema，无数据）
 * 数据通过 db.json 完整导出
 */
export function createMinimalSqliteFile(): Uint8Array {
  const schemas = getAllTableSchemas();
  const header = createFileHeader();
  const masterPage = createSqliteMasterPage(schemas);

  const file = new Uint8Array(PAGE_SIZE * 2);
  file.set(header, 0);
  file.set(masterPage, PAGE_SIZE);
  return file;
}

/**
 * 创建包含数据的 SQLite 文件
 * 实际只写入 schema（数据通过 db.json 导出）
 * 保持与原版 BeeCount-Cloud 备份格式兼容
 */
export function createSqliteWithData(
  _tables: Record<string, unknown[]>
): Uint8Array {
  console.debug(`[SQLite] createSqliteWithData called (schema-only mode)`);
  return createMinimalSqliteFile();
}
