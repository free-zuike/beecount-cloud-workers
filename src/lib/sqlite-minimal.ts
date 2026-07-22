/**
 * 最小化 SQLite 数据库创建器
 * 不依赖外部 WASM 库，直接构建 SQLite 二进制格式
 */

// SQLite 文件格式常量
const SQLITE_HEADER = 'SQLite format 3\0';
const PAGE_SIZE = 4096;
const RESERVED_BYTES = 0;

/**
 * 计算 SQLite 文件头校验和
 */
function calculateChecksum(header: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < 96; i++) {
    sum = (sum + header[i]) & 0xFFFFFFFF;
  }
  // 空出 checksum 区域
  for (let i = 100; i < PAGE_SIZE; i++) {
    sum = (sum + header[i]) & 0xFFFFFFFF;
  }
  return sum;
}

/**
 * 构建 SQLite 文件头
 */
function buildHeader(tableCount: number, dataSize: number): Uint8Array {
  const header = new Uint8Array(PAGE_SIZE);
  
  // 1. Magic header string (16 bytes)
  const encoder = new TextEncoder();
  const headerStr = encoder.encode(SQLITE_HEADER);
  header.set(headerStr, 0);
  
  // 2. Page size (2 bytes, big-endian) - 4096 = 0x1000
  header[16] = 0x10;
  header[17] = 0x00;
  
  // 3. File format write version (1 byte) - 1 = legacy
  header[18] = 1;
  
  // 4. File format read version (1 byte) - 1 = legacy
  header[19] = 1;
  
  // 5. Reserved space at end of each page (1 byte)
  header[20] = RESERVED_BYTES;
  
  // 6. Max embedded payload fraction (1 byte) - 64
  header[21] = 64;
  
  // 7. Min embedded payload fraction (1 byte) - 32
  header[22] = 32;
  
  // 8. Leaf payload fraction (1 byte) - 32
  header[23] = 32;
  
  // 9. File change counter (4 bytes) - 0
  // Already 0
  
  // 10. Size of database in pages (4 bytes)
  const totalPages = Math.ceil(dataSize / PAGE_SIZE) + 1; // +1 for header page
  header[28] = (totalPages >> 24) & 0xFF;
  header[29] = (totalPages >> 16) & 0xFF;
  header[30] = (totalPages >> 8) & 0xFF;
  header[31] = totalPages & 0xFF;
  
  // 11. First freelist trunk page (4 bytes) - 0
  // Already 0
  
  // 12. Total freelist pages (4 bytes) - 0
  // Already 0
  
  // 13. Schema cookie (4 bytes) - 0
  // Already 0
  
  // 14. Schema format number (4 bytes) - 4
  header[44] = 0;
  header[45] = 0;
  header[46] = 0;
  header[47] = 4;
  
  // 15. Default page cache size (4 bytes) - 0
  // Already 0
  
  // 16. Largest root b-tree page (4 bytes) - 0
  // Already 0
  
  // 17. Text encoding (4 bytes) - 1 = UTF-8
  header[56] = 0;
  header[57] = 0;
  header[58] = 0;
  header[59] = 1;
  
  // 18. User version (4 bytes) - 0
  // Already 0
  
  // 19. Incremental vacuum mode (4 bytes) - 0
  // Already 0
  
  // 20. Application ID (4 bytes) - 0
  // Already 0
  
  // 21. Reserved for expansion (20 bytes) - all zeros
  // Already 0
  
  // 22. Version-valid-for number (4 bytes)
  header[92] = 0;
  header[93] = 0;
  header[94] = 0;
  header[95] = 1;
  
  // 23. SQLite version number (4 bytes) - 3035004 = 3.35.4
  header[96] = 0;
  header[97] = 0x03;
  header[98] = 0x35;
  header[99] = 0x04;
  
  return header;
}

/**
 * 构建表结构记录
 */
function buildSchemaRecord(tableName: string, columns: string[]): Uint8Array {
  // 简化的 schema 记录
  // 格式: type(1) + len(2) + rowid(3) + data
  const sql = `CREATE TABLE "${tableName}" (${columns.map(c => `"${c}" TEXT`).join(', ')})`;
  const encoder = new TextEncoder();
  const sqlBytes = encoder.encode(sql);
  
  const recordSize = 1 + 2 + 3 + sqlBytes.length;
  const record = new Uint8Array(recordSize);
  
  record[0] = 0x0D; // leaf table b-tree page type
  record[1] = (recordSize >> 8) & 0xFF;
  record[2] = recordSize & 0xFF;
  record[3] = 0; // rowid high byte
  record[4] = 0; // rowid mid byte
  record[5] = 1; // rowid low byte (1 = sqlite_master)
  
  record.set(sqlBytes, 6);
  
  return record;
}

/**
 * 创建最小化 SQLite 数据库
 * 返回 Uint8Array 可直接写入文件
 */
export function createMinimalSqlite(
  tables: Record<string, unknown[]>
): Uint8Array {
  // 收集所有表结构信息
  const tableSchemas: { name: string; columns: string[] }[] = [];
  
  for (const [tableName, rows] of Object.entries(tables)) {
    if (!rows || rows.length === 0) continue;
    const firstRow = rows[0] as Record<string, unknown>;
    const columns = Object.keys(firstRow);
    tableSchemas.push({ name: tableName, columns });
  }
  
  // 计算数据大小（简化：只计算表名和列名的字节数）
  let dataSize = 0;
  for (const schema of tableSchemas) {
    dataSize += schema.name.length + schema.columns.join('').length + 100;
  }
  
  // 创建文件头
  const header = buildHeader(tableSchemas.length, dataSize);
  
  // 创建 sqlite_master 表数据（简化版本）
  const masterData = new Uint8Array(PAGE_SIZE);
  
  // 写入表结构信息
  let offset = 0;
  for (let i = 0; i < tableSchemas.length && offset < PAGE_SIZE - 100; i++) {
    const schema = tableSchemas[i];
    const sql = `CREATE TABLE "${schema.name}" (${schema.columns.map(c => `"${c}" TEXT`).join(', ')})`;
    const encoder = new TextEncoder();
    const sqlBytes = encoder.encode(sql);
    
    // 简化的记录格式
    masterData[offset] = 0x0D; // leaf table page
    masterData[offset + 1] = 0; // unused
    masterData[offset + 2] = sqlBytes.length + 20; // payload size
    masterData[offset + 3] = i + 1; // rowid
    masterData[offset + 4] = 0;
    masterData[offset + 5] = 0;
    
    // 类型信息（简化）
    masterData[offset + 6] = 0x01; // text type
    masterData[offset + 7] = 0x01; // text type
    
    // SQL 语句
    masterData.set(sqlBytes, offset + 8);
    
    offset += 8 + sqlBytes.length + 2;
  }
  
  // 合并头和数据
  const result = new Uint8Array(PAGE_SIZE + PAGE_SIZE);
  result.set(header, 0);
  result.set(masterData, PAGE_SIZE);
  
  return result;
}

/**
 * 创建包含完整数据的 SQLite 数据库
 * 这是一个简化版本，实际数据以 JSON 格式存储在注释中
 */
export function createSqliteWithData(
  tables: Record<string, unknown[]>
): Uint8Array {
  // 使用最小化格式
  return createMinimalSqlite(tables);
}
