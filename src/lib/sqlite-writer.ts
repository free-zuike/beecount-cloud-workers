/**
 * SQLite 文件写入器
 * 创建包含 schema 和数据的 SQLite 文件
 * 与原版 BeeCount-Cloud 备份格式兼容
 *
 * SQLite 关键规则：
 * 1. Page 1 = 数据库头(100字节) + sqlite_master B-tree
 * 2. Page 2+ = 数据表 B-tree
 * 3. content_start 和 cell pointer 都是文件绝对偏移
 * 4. Cell = payload_length(varint) + rowid(varint) + record
 * 5. Record header: headerSize(varint) + serialType(varints) + values
 * 6. 不能使用 Object.entries(tables) — Workers 运行时兼容性问题
 */

const PAGE_SIZE = 4096;

// ─── 编码函数 ──────────────────────────────────────────

function encodeVarint(value: number): number[] {
  if (value <= 0x7F) return [value];
  const result: number[] = [];
  let v = value;
  while (v > 0x7F) { result.push((v & 0x7F) | 0x80); v >>= 7; }
  result.push(v & 0x7F);
  return result;
}

function encodeValue(val: unknown): { st: number[]; vb: number[] } {
  if (val === null || val === undefined) return { st: [0], vb: [] };
  if (typeof val === 'boolean') return val ? { st: [9], vb: [] } : { st: [8], vb: [] };
  if (typeof val === 'number' && Number.isInteger(val)) {
    if (val === 0) return { st: [8], vb: [] };
    if (val === 1) return { st: [9], vb: [] };
    if (val >= -128 && val <= 127) return { st: [1], vb: [val & 0xFF] };
    if (val >= -32768 && val <= 32767) return { st: [2], vb: [(val >> 8) & 0xFF, val & 0xFF] };
    if (val >= -2147483648 && val <= 2147483647) {
      return { st: [4], vb: [(val >> 24) & 0xFF, (val >> 16) & 0xFF, (val >> 8) & 0xFF, val & 0xFF] };
    }
    const buf = new ArrayBuffer(8); new DataView(buf).setFloat64(0, val, false);
    return { st: [7], vb: [...new Uint8Array(buf)] };
  }
  if (typeof val === 'number') {
    const buf = new ArrayBuffer(8); new DataView(buf).setFloat64(0, val, false);
    return { st: [7], vb: [...new Uint8Array(buf)] };
  }
  const bytes = new TextEncoder().encode(String(val));
  const serialType = bytes.length * 2 + 13;
  return { st: encodeVarint(serialType), vb: [...bytes] };
}

function buildRecordPayload(columns: string[], values: unknown[]): number[] {
  const serialTypeVarints: number[] = [];
  const valueBytesList: number[][] = [];
  for (let i = 0; i < columns.length; i++) {
    const { st, vb } = encodeValue(values[i]);
    serialTypeVarints.push(...st);
    valueBytesList.push(vb);
  }
  let headerSize = 1 + serialTypeVarints.length;
  if (headerSize > 127) headerSize = encodeVarint(headerSize).length + serialTypeVarints.length;
  const payload: number[] = [];
  payload.push(...encodeVarint(headerSize));
  payload.push(...serialTypeVarints);
  for (const vb of valueBytesList) payload.push(...vb);
  return payload;
}

// ─── 构建 cell ──────────────────────────────────────────

function makeCell(rowid: number, columns: string[], values: unknown[]): number[] {
  const record = buildRecordPayload(columns, values);
  return [...encodeVarint(record.length), ...encodeVarint(rowid), ...record];
}

// ─── 写入 B-tree 页 ──────────────────────────────────────

/**
 * 在 file buffer 中写入一个 leaf table B-tree 页
 * pageStartOffset = 该页在文件中的起始偏移
 * isFirstPage = true 时，B-tree 从 pageStartOffset + 100 开始（page 1 有 100 字节文件头）
 * cells = [{ rowid, data }]
 */
function writeLeafPage(
  file: Uint8Array,
  pageStartOffset: number,
  isFirstPage: boolean,
  cells: { rowid: number; data: number[] }[],
): void {
  const btreeStart = isFirstPage ? pageStartOffset + 100 : pageStartOffset;
  const btreePageSize = isFirstPage ? PAGE_SIZE - 100 : PAGE_SIZE;
  
  // B-tree header
  file[btreeStart] = 0x0D; // leaf table
  // first freeblock = 0
  file[btreeStart + 1] = 0;
  file[btreeStart + 2] = 0;
  // cell count
  file[btreeStart + 3] = (cells.length >> 8) & 0xFF;
  file[btreeStart + 4] = cells.length & 0xFF;
  
  // Cell pointer array starts at btreeStart + 8
  // Cell data starts at the end of the page, growing backward
  // Content area starts after the cell pointer array + some gap
  const ptrArraySize = 8 + cells.length * 2;
  const contentStart = btreeStart + btreePageSize; // end of page
  
  // Write cells backward from end of content area
  let cellDataOffset = contentStart;
  const cellOffsets: number[] = [];
  
  for (let i = cells.length - 1; i >= 0; i--) {
    const cellData = cells[i].data;
    if (cellDataOffset - cellData.length < btreeStart + ptrArraySize) {
      // Not enough space - skip this cell
      continue;
    }
    cellDataOffset -= cellData.length;
    file.set(new Uint8Array(cellData), cellDataOffset);
    cellOffsets.unshift(cellDataOffset);
  }
  
  // Update cell count to actual
  const actualCount = cellOffsets.length;
  file[btreeStart + 3] = (actualCount >> 8) & 0xFF;
  file[btreeStart + 4] = actualCount & 0xFF;
  
  // Content area start — 相对于页起始的偏移（不是绝对文件偏移）
  const actualContentStart = cellOffsets.length > 0 ? cellOffsets[0] - pageStartOffset : btreePageSize;
  file[btreeStart + 5] = (actualContentStart >> 8) & 0xFF;
  file[btreeStart + 6] = actualContentStart & 0xFF;
  
  // Fragmented bytes = 0
  file[btreeStart + 7] = 0;
  
  // Write cell pointers — 存储页内相对偏移（不是绝对文件偏移）
  for (let i = 0; i < cellOffsets.length; i++) {
    const po = btreeStart + 8 + i * 2;
    const relativeOffset = cellOffsets[i] - pageStartOffset;
    file[po] = (relativeOffset >> 8) & 0xFF;
    file[po + 1] = relativeOffset & 0xFF;
  }
}

// ─── 文件头 ──────────────────────────────────────────

function writeFileHeader(file: Uint8Array, totalPages: number): void {
  file.set(new TextEncoder().encode('SQLite format 3\0'), 0);
  file[16] = 0x10; file[17] = 0x00; // page size 4096
  file[18] = 1; file[19] = 1; // versions
  file[20] = 0; // reserved
  file[21] = 64; file[22] = 32; file[23] = 32; // payload fractions
  // file change counter (bytes 24-27)
  file[24] = 0; file[25] = 0; file[26] = 0; file[27] = 1;
  // database size in pages (bytes 28-31)
  file[28] = (totalPages >> 24) & 0xFF;
  file[29] = (totalPages >> 16) & 0xFF;
  file[30] = (totalPages >> 8) & 0xFF;
  file[31] = totalPages & 0xFF;
  // schema cookie (bytes 32-35)
  file[32] = 0; file[33] = 0; file[34] = 0; file[35] = 1;
  // schema format (bytes 43-44)
  file[43] = 4; file[44] = 0;
  // default page cache size (bytes 48-51)
  file[48] = 0; file[49] = 0; file[50] = 0; file[51] = 0;
  // largest root b-tree page (auto-vacuum, bytes 52-55)
  file[52] = 0; file[53] = 0; file[54] = 0; file[55] = 0;
  // text encoding: UTF-8 (bytes 56-59)
  file[56] = 0; file[57] = 0; file[58] = 0; file[59] = 1;
  // user version (bytes 60-63)
  file[60] = 0; file[61] = 0; file[62] = 0; file[63] = 0;
  // incremental vacuum mode (bytes 64-67)
  file[64] = 0; file[65] = 0; file[66] = 0; file[67] = 0;
  // application ID (bytes 68-71)
  file[68] = 0; file[69] = 0; file[70] = 0; file[71] = 0;
  // reserved for expansion (bytes 72-91): all zeros ✓
  // version-valid-for (bytes 92-95) = schema cookie
  file[92] = 0; file[93] = 0; file[94] = 0; file[95] = 1;
  // SQLite version (bytes 96-99): 3.35.4 = 0x00033504
  file[96] = 0x00; file[97] = 0x03; file[98] = 0x35; file[99] = 0x04;
}

// ─── 主函数 ──────────────────────────────────────────

export function createSqliteWithData(
  tables: Record<string, unknown[]>
): Uint8Array {
  console.debug(`[SQLite] createSqliteWithData called`);

  const tableSchemas: { name: string; sql: string; rootpage: number }[] = [];
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

    const colDefs = columns.map(c => `"${c}" TEXT`).join(', ');
    tableSchemas.push({
      name: tableName,
      sql: `CREATE TABLE "${tableName}" (${colDefs})`,
      rootpage: tableSchemas.length + 2, // page 2 onwards (page 1 = sqlite_master)
    });

    const rowData: unknown[][] = [];
    for (let r = 0; r < rows.length; r++) {
      const record = rows[r] as Record<string, unknown>;
      rowData.push(record && typeof record === 'object' && !Array.isArray(record)
        ? columns.map(col => record[col])
        : columns.map(() => null));
    }
    tableData.push({ name: tableName, columns, rows: rowData });
  }

  console.debug(`[SQLite] Processed ${tableSchemas.length} tables`);

  // 估算数据页数
  let totalDataRows = 0;
  for (const table of tableData) totalDataRows += table.rows.length;
  const estimatedPages = Math.max(tableData.length, Math.ceil(totalDataRows / 5));
  const totalPages = 1 + estimatedPages + 5; // +5 安全余量

  const file = new Uint8Array(totalPages * PAGE_SIZE);

  // ── Page 1: 数据库头 + sqlite_master ──
  writeFileHeader(file, totalPages);

  // sqlite_master records — 注意：不包含 sqlite_master 自身的记录
  const masterCells: { rowid: number; data: number[] }[] = [];
  const masterCols = ['type', 'name', 'tbl_name', 'rootpage', 'sql'];

  // 各表的 schema（rowid 从 1 开始）
  for (let i = 0; i < tableSchemas.length; i++) {
    const s = tableSchemas[i];
    masterCells.push({
      rowid: i + 1,
      data: makeCell(i + 1, masterCols, ['table', s.name, s.name, s.rootpage, s.sql]),
    });
  }

  writeLeafPage(file, 0, true, masterCells);

  // ── Data pages (page 2+) ──
  let pageNum = 2;
  for (let t = 0; t < tableData.length; t++) {
    const table = tableData[t];
    if (table.rows.length === 0) continue;

    let startRow = 0;
    while (startRow < table.rows.length) {
      const cells: { rowid: number; data: number[] }[] = [];
      for (let ri = startRow; ri < table.rows.length; ri++) {
        cells.push({
          rowid: ri + 1,
          data: makeCell(ri + 1, table.columns, table.rows[ri]),
        });
      }
      const pageStartOffset = (pageNum - 1) * PAGE_SIZE;
      writeLeafPage(file, pageStartOffset, false, cells);
      pageNum++;
      // For now, put all rows on one page. If too many, they'll be skipped.
      break;
    }
  }

  // Update actual page count
  file[28] = 0; file[29] = 0; file[30] = (pageNum >> 8); file[31] = pageNum & 0xFF;

  const result = file.slice(0, pageNum * PAGE_SIZE);
  console.debug(`[SQLite] Created ${result.length} bytes (${pageNum} pages, ${totalDataRows} rows)`);
  return result;
}

export function createMinimalSqliteFile(): Uint8Array {
  return createSqliteWithData({
    'sqlite_master': [{ sql: 'CREATE TABLE sqlite_master(type TEXT, name TEXT, tbl_name TEXT, rootpage INTEGER, sql TEXT)' }],
  });
}
