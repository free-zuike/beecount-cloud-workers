/**
 * SQLite 文件写入器
 * 创建包含 schema 和数据的 SQLite 文件
 * 与原版 BeeCount-Cloud 备份格式兼容 (VACUUM INTO 等效)
 *
 * ⚠️ 不能使用 Object.entries(tables) — Workers 运行时报错。
 * 始终使用 Object.keys + 索引访问。
 */

const PAGE_SIZE = 4096;

// ─── 编码函数 ──────────────────────────────────────────

/** SQLite 变长整数 */
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
 * 编码值为 SQLite 记录格式
 * 返回 [serialType, ...valueBytes]
 */
function encodeValue(val: unknown): number[] {
  if (val === null || val === undefined) {
    return [0]; // NULL: serial type 0, 0 bytes
  }
  if (typeof val === 'boolean') {
    return val ? [9] : [8]; // integer 1 or 0
  }
  if (typeof val === 'number') {
    if (Number.isInteger(val)) {
      return encodeInteger(val);
    }
    // float64
    const buf = new ArrayBuffer(8);
    new DataView(buf).setFloat64(0, val, false);
    return [7, ...new Uint8Array(buf)];
  }
  // string
  return encodeText(String(val));
}

/**
 * 编码整数 — 使用正确的 SQLite serial types:
 *   8 = int 0, 9 = int 1
 *   1 = 1-byte, 2 = 2-byte, 3 = 3-byte, 4 = 4-byte, 5 = 6-byte, 6 = 8-byte
 */
function encodeInteger(value: number): number[] {
  if (value === 0) return [8];
  if (value === 1) return [9];
  if (value >= -128 && value <= 127) return [1, value & 0xFF];
  if (value >= -32768 && value <= 32767) return [2, (value >> 8) & 0xFF, value & 0xFF];
  if (value >= -8388608 && value <= 8388607) return [3, (value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF];
  if (value >= -2147483648 && value <= 2147483647) {
    return [4, (value >> 24) & 0xFF, (value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF];
  }
  // 大整数 → float64
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, value, false);
  return [7, ...new Uint8Array(buf)];
}

/**
 * 编码文本 — serial type = 2*bytes.length + 13 (odd = text)
 * 对于 <= 119 字节文本，serial type <= 251，单字节
 * 更长文本需要 varint serial type
 */
function encodeText(text: string): number[] {
  const bytes = new TextEncoder().encode(text);
  const serialType = bytes.length * 2 + 13;
  return [...encodeVarint(serialType), ...bytes];
}

/**
 * 构建记录 payload（不含 rowid 和 payload length）
 * 格式: varint(headerSize) + serialTypes... + values...
 */
function buildRecordPayload(columns: string[], values: unknown[]): number[] {
  const payload: number[] = [];

  // 计算每列的 serial type 和 value bytes
  const serialTypes: number[] = [];
  const valueBytes: number[][] = [];

  for (let i = 0; i < columns.length; i++) {
    const encoded = encodeValue(values[i]);
    // encoded[0] = serial type, encoded[1...] = value bytes
    serialTypes.push(encoded[0]);
    valueBytes.push(encoded.slice(1));
  }

  // Header: varint(headerSize) + serialType bytes
  const headerSize = 1 + serialTypes.length; // 1 for the headerSize varint itself
  payload.push(...encodeVarint(headerSize));
  payload.push(...serialTypes);

  // Values
  for (const vb of valueBytes) {
    payload.push(...vb);
  }

  return payload;
}

// ─── 页面构建 ──────────────────────────────────────────

function createFileHeader(tableCount: number, totalPages: number): Uint8Array {
  const header = new Uint8Array(PAGE_SIZE);

  const magic = new TextEncoder().encode('SQLite format 3\0');
  header.set(magic, 0);
  header[16] = 0x10; // page size 4096
  header[17] = 0x00;
  header[18] = 1;
  header[19] = 1;
  header[20] = 0;
  header[21] = 64;
  header[22] = 32;
  header[23] = 32;
  // db size
  header[28] = (totalPages >> 24) & 0xFF;
  header[29] = (totalPages >> 16) & 0xFF;
  header[30] = (totalPages >> 8) & 0xFF;
  header[31] = totalPages & 0xFF;
  header[47] = 4; // schema format
  header[59] = 1; // UTF-8
  header[95] = 1;
  header[96] = 0x00;
  header[97] = 0x03;
  header[98] = 0x35;
  header[99] = 0x04;

  return header;
}

function createMasterPage(tables: { name: string; sql: string }[]): Uint8Array {
  const page = new Uint8Array(PAGE_SIZE);
  page[0] = 0x0D; // leaf table b-tree

  const cellCount = tables.length + 1;
  page[3] = (cellCount >> 8) & 0xFF;
  page[4] = cellCount & 0xFF;

  const contentStart = PAGE_SIZE - 100;
  page[5] = (contentStart >> 8) & 0xFF;
  page[6] = contentStart & 0xFF;

  let cellOffset = contentStart;
  const cellPointers: number[] = [];

  // sqlite_master record (rowid=1)
  const masterPayload = buildRecordPayload(
    ['type', 'name', 'tbl_name', 'rootpage', 'sql'],
    ['table', 'sqlite_master', 'sqlite_master', 1, 'CREATE TABLE sqlite_master(type TEXT, name TEXT, tbl_name TEXT, rootpage INTEGER, sql TEXT)']
  );
  // Cell = payload_length(varint) + rowid(varint) + payload
  const masterCell = [...encodeVarint(masterPayload.length), ...encodeVarint(1), ...masterPayload];
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
    const cell = [...encodeVarint(payload.length), ...encodeVarint(rootpage), ...payload];
    cellOffset -= cell.length;
    if (cellOffset < 100) break;
    page.set(new Uint8Array(cell), cellOffset);
    cellPointers.unshift(cellOffset);
  }

  // Cell pointers
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
 * 创建数据表页 — 支持分页
 */
function createDataTablePage(
  columns: string[],
  rows: unknown[][],
  startRow: number = 0,
): { page: Uint8Array; rowsWritten: number } {
  const page = new Uint8Array(PAGE_SIZE);
  page[0] = 0x0D; // leaf table b-tree

  const contentStart = PAGE_SIZE - 100;
  page[5] = (contentStart >> 8) & 0xFF;
  page[6] = contentStart & 0xFF;

  let cellOffset = contentStart;
  const cellPointers: number[] = [];
  let rowsWritten = 0;

  for (let rowIdx = startRow; rowIdx < rows.length; rowIdx++) {
    const row = rows[rowIdx];
    const rowid = rowIdx + 1;

    const payload = buildRecordPayload(columns, row);
    // Cell = payload_length(varint) + rowid(varint) + payload
    const cell = [...encodeVarint(payload.length), ...encodeVarint(rowid), ...payload];

    if (cellOffset - cell.length < 100) break;
    cellOffset -= cell.length;
    page.set(new Uint8Array(cell), cellOffset);
    cellPointers.unshift(cellOffset);
    rowsWritten++;
  }

  page[3] = (rowsWritten >> 8) & 0xFF;
  page[4] = rowsWritten & 0xFF;

  for (let i = 0; i < cellPointers.length; i++) {
    const ptrOffset = 8 + (i + 1) * 2;
    if (ptrOffset + 1 < 100) {
      page[ptrOffset] = (cellPointers[i] >> 8) & 0xFF;
      page[ptrOffset + 1] = cellPointers[i] & 0xFF;
    }
  }

  return { page, rowsWritten };
}

// ─── 主函数 ──────────────────────────────────────────

export function createSqliteWithData(
  tables: Record<string, unknown[]>
): Uint8Array {
  console.debug(`[SQLite] createSqliteWithData called`);

  const tableSchemas: { name: string; sql: string }[] = [];
  const tableData: { name: string; columns: string[]; rows: unknown[][] }[] = [];

  const tableNames = Object.keys(tables);
  console.debug(`[SQLite] Found ${tableNames.length} tables`);

  for (let t = 0; t < tableNames.length; t++) {
    const tableName = tableNames[t];
    const rows = (tables as Record<string, unknown[]>)[tableName];

    if (!rows || !Array.isArray(rows) || rows.length === 0) continue;

    const firstRow = rows[0];
    if (!firstRow || typeof firstRow !== 'object' || Array.isArray(firstRow)) continue;

    const columns = Object.keys(firstRow);
    if (columns.length === 0) continue;

    // CREATE TABLE 语句
    const colDefs = columns.map(col => {
      const val = (firstRow as Record<string, unknown>)[col];
      let sqlType = 'TEXT';
      if (typeof val === 'number') sqlType = Number.isInteger(val) ? 'INTEGER' : 'REAL';
      else if (typeof val === 'boolean') sqlType = 'INTEGER';
      return `"${col}" ${sqlType}`;
    }).join(', ');

    tableSchemas.push({
      name: tableName,
      sql: `CREATE TABLE "${tableName}" (${colDefs})`,
    });

    // 提取行数据
    const rowData: unknown[][] = [];
    for (let r = 0; r < rows.length; r++) {
      const record = rows[r] as Record<string, unknown>;
      if (record && typeof record === 'object' && !Array.isArray(record)) {
        rowData.push(columns.map(col => record[col]));
      } else {
        rowData.push(columns.map(() => null));
      }
    }
    tableData.push({ name: tableName, columns, rows: rowData });
  }

  console.debug(`[SQLite] Processed ${tableSchemas.length} tables`);

  // 预分配数据页 — 保守估计每页 ~6 行（平均行 ~600 字节）
  let totalDataRows = 0;
  for (const table of tableData) totalDataRows += table.rows.length;
  const estimatedRowsPerPage = 6;
  const estimatedPages = Math.max(1, Math.ceil(totalDataRows / estimatedRowsPerPage));

  const maxFileSize = (1 + estimatedPages + 10) * PAGE_SIZE; // +10 安全余量
  const file = new Uint8Array(maxFileSize);

  const header = createFileHeader(tableSchemas.length, 1 + estimatedPages);
  file.set(header, 0);
  file.set(createMasterPage(tableSchemas), PAGE_SIZE);

  // 写入数据页
  let pageNum = 2;
  for (let t = 0; t < tableData.length; t++) {
    const table = tableData[t];
    if (table.rows.length === 0) continue;

    let startRow = 0;
    while (startRow < table.rows.length) {
      const { page, rowsWritten } = createDataTablePage(table.columns, table.rows, startRow);
      if (rowsWritten === 0) break;
      file.set(page, pageNum * PAGE_SIZE);
      pageNum++;
      startRow += rowsWritten;
    }
  }

  // 更新实际页数
  const actualTotalPages = pageNum;
  file[28] = (actualTotalPages >> 24) & 0xFF;
  file[29] = (actualTotalPages >> 16) & 0xFF;
  file[30] = (actualTotalPages >> 8) & 0xFF;
  file[31] = actualTotalPages & 0xFF;

  const result = file.slice(0, actualTotalPages * PAGE_SIZE);
  console.debug(`[SQLite] Created ${result.length} bytes (${actualTotalPages} pages, ${totalDataRows} rows)`);
  return result;
}

export function createMinimalSqliteFile(): Uint8Array {
  return createSqliteWithData({
    'sqlite_master': [{ sql: 'CREATE TABLE sqlite_master(type TEXT, name TEXT, tbl_name TEXT, rootpage INTEGER, sql TEXT)' }],
  });
}
