/**
 * SQLite 文件写入器
 * 创建包含 schema 和数据的 SQLite 文件
 * 与原版 BeeCount-Cloud 备份格式兼容
 */

const PAGE_SIZE = 4096;

/**
 * 编码 SQLite 变长整数
 */
function encodeVarint(value: number): number[] {
  if (value <= 0x7F) return [value];
  const result: number[] = [];
  let v = value;
  while (v > 0x7F) {
    result.push((v & 0x7F) | 0x80);
    v >>= 7;
  }
  result.push(v & 0x7F);
  return result;
}

/**
 * 编码文本为 SQLite 格式
 */
function encodeText(text: string | null): number[] {
  if (text === null || text === undefined) return [0]; // NULL
  const bytes = new TextEncoder().encode(text);
  if (bytes.length === 0) return [1]; // empty text
  if (bytes.length <= 127) return [bytes.length + 13, ...bytes];
  // 长文本: type = 252 + length bytes
  const lenBytes = encodeVarint(bytes.length);
  return [252, ...lenBytes, ...bytes];
}

/**
 * 编码整数为 SQLite 格式
 */
function encodeInteger(value: number | null): number[] {
  if (value === null || value === undefined) return [0]; // NULL
  if (value === 0) return [8]; // 0
  if (value === 1) return [9]; // 1
  if (value === -1) return [10]; // -1
  if (value >= -128 && value <= 127) return [11, value & 0xFF];
  if (value >= -32768 && value <= 32767) return [12, (value >> 8) & 0xFF, value & 0xFF];
  if (value >= -8388608 && value <= 8388607) return [13, (value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF];
  if (value >= -2147483648 && value <= 2147483647) return [14, (value >> 24) & 0xFF, (value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF];
  // 作为浮点数
  return encodeFloat(value);
}

/**
 * 编码浮点数为 SQLite 格式
 */
function encodeFloat(value: number): number[] {
  const buffer = new ArrayBuffer(8);
  new DataView(buffer).setFloat64(0, value, false);
  const bytes = new Uint8Array(buffer);
  return [7, ...bytes];
}

/**
 * 构建记录 payload
 */
function buildRecordPayload(columns: string[], values: any[]): number[] {
  const payload: number[] = [];
  
  // 计算 serial types
  const serialTypes: number[] = [];
  for (let i = 0; i < columns.length; i++) {
    const val = values[i];
    if (val === null || val === undefined) {
      serialTypes.push(0);
    } else if (typeof val === 'number') {
      if (Number.isInteger(val)) {
        serialTypes.push(...encodeInteger(val).slice(0, 1)); // 只取 serial type
      } else {
        serialTypes.push(7); // float64
      }
    } else if (typeof val === 'boolean') {
      serialTypes.push(8); // integer 0 or 1
    } else {
      const str = String(val);
      const bytes = new TextEncoder().encode(str);
      if (bytes.length <= 127) {
        serialTypes.push(bytes.length + 13);
      } else {
        serialTypes.push(252);
      }
    }
  }
  
  // Header size varint
  const headerSize = 1 + serialTypes.length;
  payload.push(...encodeVarint(headerSize));
  payload.push(...serialTypes);
  
  // Column values
  for (let i = 0; i < columns.length; i++) {
    const val = values[i];
    if (val === null || val === undefined) {
      // NULL - no bytes
    } else if (typeof val === 'number') {
      if (Number.isInteger(val)) {
        payload.push(...encodeInteger(val).slice(1)); // skip serial type byte
      } else {
        const buffer = new ArrayBuffer(8);
        new DataView(buffer).setFloat64(0, val, false);
        payload.push(...new Uint8Array(buffer));
      }
    } else if (typeof val === 'boolean') {
      payload.push(val ? 1 : 0);
    } else {
      const bytes = new TextEncoder().encode(String(val));
      payload.push(...bytes);
    }
  }
  
  return payload;
}

/**
 * 创建 SQLite 文件头
 */
function createFileHeader(tableCount: number, totalPages: number): Uint8Array {
  const header = new Uint8Array(PAGE_SIZE);
  
  // Magic: "SQLite format 3\0"
  const magic = new TextEncoder().encode('SQLite format 3\0');
  header.set(magic, 0);
  
  // Page size: 4096
  header[16] = 0x10;
  header[17] = 0x00;
  
  // File format versions
  header[18] = 1; // write
  header[19] = 1; // read
  
  // Reserved space
  header[20] = 0;
  
  // Payload fractions
  header[21] = 64;
  header[22] = 32;
  header[23] = 32;
  
  // Database size in pages
  header[28] = (totalPages >> 24) & 0xFF;
  header[29] = (totalPages >> 16) & 0xFF;
  header[30] = (totalPages >> 8) & 0xFF;
  header[31] = totalPages & 0xFF;
  
  // Schema format: 4
  header[47] = 4;
  
  // Text encoding: UTF-8
  header[59] = 1;
  
  // Version valid for: 1
  header[95] = 1;
  
  // SQLite version: 3.35.4
  header[96] = 0x00;
  header[97] = 0x03;
  header[98] = 0x35;
  header[99] = 0x04;
  
  return header;
}

/**
 * 创建 sqlite_master 表页
 */
function createMasterPage(tables: { name: string; sql: string }[]): Uint8Array {
  const page = new Uint8Array(PAGE_SIZE);
  
  // Leaf table b-tree page
  page[0] = 0x0D;
  
  // Cell count
  const cellCount = tables.length + 1;
  page[3] = (cellCount >> 8) & 0xFF;
  page[4] = cellCount & 0xFF;
  
  // Content start
  const contentStart = PAGE_SIZE - 100;
  page[5] = (contentStart >> 8) & 0xFF;
  page[6] = contentStart & 0xFF;
  
  // Build cells from bottom up
  let cellOffset = contentStart;
  const cellPointers: number[] = [];
  
  // sqlite_master record (rowid=1)
  const masterPayload = buildRecordPayload(
    ['type', 'name', 'tbl_name', 'rootpage', 'sql'],
    ['table', 'sqlite_master', 'sqlite_master', 1, 'CREATE TABLE sqlite_master(type TEXT, name TEXT, tbl_name TEXT, rootpage INTEGER, sql TEXT)']
  );
  const masterCell = [...encodeVarint(1), ...masterPayload];
  cellOffset -= masterCell.length;
  page.set(new Uint8Array(masterCell), cellOffset);
  cellPointers.unshift(cellOffset);
  
  // Table schema records
  for (let i = 0; i < tables.length; i++) {
    const table = tables[i];
    const rootpage = i + 2;
    const payload = buildRecordPayload(
      ['type', 'name', 'tbl_name', 'rootpage', 'sql'],
      ['table', table.name, table.name, rootpage, table.sql]
    );
    const cell = [...encodeVarint(rootpage), ...payload];
    cellOffset -= cell.length;
    if (cellOffset < 100) break;
    page.set(new Uint8Array(cell), cellOffset);
    cellPointers.unshift(cellOffset);
  }
  
  // Write cell pointers
  for (let i = 0; i < cellPointers.length && i < cellCount; i++) {
    const ptrOffset = 8 + (i + 1) * 2;
    if (ptrOffset + 1 < 100) {
      page[ptrOffset] = (cellPointers[i] >> 8) & 0xFF;
      page[ptrOffset + 1] = cellPointers[i] & 0xFF;
    }
  }
  
  return page;
}

/**
 * 创建数据表页
 */
function createDataTablePage(tableName: string, columns: string[], rows: any[][], startRow: number = 0): { page: Uint8Array; rowsWritten: number } {
  const page = new Uint8Array(PAGE_SIZE);
  
  // Leaf table b-tree page
  page[0] = 0x0D;
  
  // Content start
  const contentStart = PAGE_SIZE - 100;
  page[5] = (contentStart >> 8) & 0xFF;
  page[6] = contentStart & 0xFF;
  
  // Build cells from bottom up
  let cellOffset = contentStart;
  const cellPointers: number[] = [];
  let rowsWritten = 0;
  
  for (let rowIdx = startRow; rowIdx < rows.length; rowIdx++) {
    const row = rows[rowIdx];
    const rowid = rowIdx + 1;
    
    const payload = buildRecordPayload(columns, row);
    const cell = [...encodeVarint(rowid), ...payload];
    
    if (cellOffset - cell.length < 100) break; // Not enough space
    cellOffset -= cell.length;
    page.set(new Uint8Array(cell), cellOffset);
    cellPointers.unshift(cellOffset);
    rowsWritten++;
  }
  
  // Cell count
  const cellCount = rowsWritten;
  page[3] = (cellCount >> 8) & 0xFF;
  page[4] = cellCount & 0xFF;
  
  // Write cell pointers
  for (let i = 0; i < cellPointers.length; i++) {
    const ptrOffset = 8 + (i + 1) * 2;
    if (ptrOffset + 1 < 100) {
      page[ptrOffset] = (cellPointers[i] >> 8) & 0xFF;
      page[ptrOffset + 1] = cellPointers[i] & 0xFF;
    }
  }
  
  return page;
}

/**
 * 创建包含 schema 和数据的 SQLite 文件
 */
export function createSqliteWithData(
  tables: Record<string, unknown[]>
): Uint8Array {
  // 1. 构建表 schema
  const tableSchemas: { name: string; sql: string }[] = [];
  const tableData: { name: string; columns: string[]; rows: any[][] }[] = [];
  
  for (const [tableName, rows] of Object.entries(tables)) {
    if (!rows || rows.length === 0) continue;
    
    const firstRow = rows[0] as Record<string, unknown>;
    if (!firstRow) {
      console.warn(`[SQLite] Skipping table ${tableName}: first row is undefined`);
      continue;
    }
    const columns = Object.keys(firstRow);
    
    if (columns.length === 0) {
      console.warn(`[SQLite] Skipping table ${tableName}: no columns found`);
      continue;
    }
    
    // 创建 CREATE TABLE 语句
    const colDefs = columns.map(col => {
      const val = firstRow[col];
      let sqlType = 'TEXT';
      if (typeof val === 'number') {
        sqlType = Number.isInteger(val) ? 'INTEGER' : 'REAL';
      } else if (typeof val === 'boolean') {
        sqlType = 'INTEGER';
      }
      return `"${col}" ${sqlType}`;
    }).join(', ');
    
    const sql = `CREATE TABLE "${tableName}" (${colDefs})`;
    tableSchemas.push({ name: tableName, sql });
    
    // 提取行数据
    const rowData = rows.map(row => {
      const record = row as Record<string, unknown>;
      return columns.map(col => record[col]);
    });
    
    tableData.push({ name: tableName, columns, rows: rowData });
  }
  
  // 2. 计算总页数
  // Page 1: header + sqlite_master
  // Page 2+: data pages
  let dataPages = 0;
  for (const table of tableData) {
    // 估算每个表需要的页数
    const avgRowSize = table.rows.length > 0 
      ? JSON.stringify(table.rows[0]).length 
      : 100;
    const estimatedSize = table.rows.length * avgRowSize;
    const pages = Math.max(1, Math.ceil(estimatedSize / (PAGE_SIZE - 200)));
    dataPages += pages;
  }
  
  const totalPages = 1 + dataPages; // 1 for header page
  
  // 3. 创建文件
  const fileSize = totalPages * PAGE_SIZE;
  const file = new Uint8Array(fileSize);
  
  // 写入文件头
  const header = createFileHeader(tableSchemas.length, totalPages);
  file.set(header, 0);
  
  // 写入 sqlite_master 页
  const masterPage = createMasterPage(tableSchemas);
  file.set(masterPage, PAGE_SIZE);
  
  // 写入数据页
  let pageNum = 2;
  for (const table of tableData) {
    if (table.rows.length === 0) continue;
    
    // 处理多页表格
    let startRow = 0;
    while (startRow < table.rows.length) {
      const { page, rowsWritten } = createDataTablePage(table.name, table.columns, table.rows, startRow);
      if (rowsWritten === 0) break; // 没有更多行可以写入
      file.set(page, pageNum * PAGE_SIZE);
      pageNum++;
      startRow += rowsWritten;
    }
  }
  
  return file;
}

/**
 * 创建最小化 SQLite 文件（仅 schema）
 */
export function createMinimalSqliteFile(): Uint8Array {
  const tables = {
    'sqlite_master': [{ sql: 'CREATE TABLE sqlite_master(type TEXT, name TEXT, tbl_name TEXT, rootpage INTEGER, sql TEXT)' }],
  };
  return createSqliteWithData(tables);
}
