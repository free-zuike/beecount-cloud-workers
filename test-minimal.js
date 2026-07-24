// Minimal SQLite test - just sqlite_master with one table, no data
const fs = require('fs');
const initSqlJs = require('sql.js');

async function test() {
  const SQL = await initSqlJs();
  const PAGE_SIZE = 4096;

  function encodeVarint(v) {
    if (v <= 0x7F) return [v];
    const r = [];
    while (v > 0x7F) { r.push((v & 0x7F) | 0x80); v >>= 7; }
    r.push(v & 0x7F);
    return r;
  }

  function encodeText(text) {
    const bytes = new TextEncoder().encode(text);
    const serialType = bytes.length * 2 + 13;
    return [...encodeVarint(serialType), ...bytes];
  }

  function encodeInt(val) {
    if (val === 0) return [8];
    if (val === 1) return [9];
    if (val >= -128 && val <= 127) return [1, val & 0xFF];
    if (val >= -32768 && val <= 32767) return [2, (val >> 8) & 0xFF, val & 0xFF];
    return [4, (val >> 24) & 0xFF, (val >> 16) & 0xFF, (val >> 8) & 0xFF, val & 0xFF];
  }

  function makeRecord(values) {
    const serialTypes = [];
    const valueBytes = [];
    for (const val of values) {
      let encoded;
      if (val === null || val === undefined) encoded = [0];
      else if (typeof val === 'number' && Number.isInteger(val)) encoded = encodeInt(val);
      else if (typeof val === 'string') encoded = encodeText(val);
      else encoded = encodeText(String(val));
      serialTypes.push(encoded[0]);
      valueBytes.push(encoded.slice(1));
    }

    // Build serial type varints
    const stVarints = [];
    for (const st of serialTypes) stVarints.push(...encodeVarint(st));

    // headerSize = total bytes of header
    const rawSize = 1 + stVarints.length;
    const headerSizeVarint = encodeVarint(rawSize);

    const header = [...headerSizeVarint, ...stVarints];
    const body = valueBytes.flat();
    return [...header, ...body];
  }

  function makeCell(rowid, values) {
    const record = makeRecord(values);
    return [...encodeVarint(record.length), ...encodeVarint(rowid), ...record];
  }

  // Build a simple file: page 1 (header + master), page 2 (one table with one row)
  const file = new Uint8Array(PAGE_SIZE * 3);

  // === PAGE 1: header + sqlite_master ===
  // File header (first 100 bytes)
  const magic = new TextEncoder().encode('SQLite format 3\0');
  file.set(magic, 0);
  file[16] = 0x10; file[17] = 0x00; // page size 4096
  file[18] = 1; file[19] = 1; // versions
  file[20] = 0; // reserved
  file[21] = 64; file[22] = 32; file[23] = 32; // payload fractions
  file[28] = 0; file[29] = 0; file[30] = 0; file[31] = 3; // 3 pages total
  file[47] = 4; // schema format
  file[56] = 0; file[57] = 0; file[58] = 1; file[59] = 0x3F; // text encoding UTF-8
  file[95] = 1;
  file[96] = 0; file[97] = 3; file[98] = 0x35; file[99] = 4;

  // Wait, text encoding should be at offset 56-59, not just 59
  // Actually: bytes 56-59 are "text encoding" as a 4-byte big-endian int
  // value 1 = UTF-8
  file[56] = 0; file[57] = 0; file[58] = 0; file[59] = 1;

  // sqlite_master page header (starts at byte 100 of page 1)
  const page1 = file.slice(0, PAGE_SIZE);
  page1[0] = 0x0D; // leaf table b-tree
  const contentStart = PAGE_SIZE - 100;
  page1[5] = (contentStart >> 8) & 0xFF;
  page1[6] = contentStart & 0xFF;

  // Build cells from bottom up
  const cells = [];

  // Cell 1: users table (rowid=2)
  const usersSql = 'CREATE TABLE "users" ("id" TEXT, "email" TEXT, "name" TEXT)';
  cells.push(makeCell(2, ['table', 'users', 'users', 2, usersSql]));

  // Cell 0: sqlite_master itself (rowid=1)
  cells.push(makeCell(1, ['table', 'sqlite_master', 'sqlite_master', 1,
    'CREATE TABLE sqlite_master(type TEXT, name TEXT, tbl_name TEXT, rootpage INTEGER, sql TEXT)']));

  // Place cells bottom-up
  let cellPtr = contentStart;
  const cellOffsets = [];
  for (const cell of cells) {
    cellPtr -= cell.length;
    page1.set(new Uint8Array(cell), cellPtr);
    cellOffsets.push(cellPtr);
  }
  cellOffsets.reverse(); // Now in rowid order

  // Write cell count
  page1[3] = 0; page1[4] = cellOffsets.length;

  // Write cell pointers
  for (let i = 0; i < cellOffsets.length; i++) {
    const po = 8 + i * 2;
    page1[po] = (cellOffsets[i] >> 8) & 0xFF;
    page1[po + 1] = cellOffsets[i] & 0xFF;
  }

  file.set(page1, 0);

  // === PAGE 2: users data ===
  const page2 = file.slice(PAGE_SIZE, PAGE_SIZE * 2);
  page2[0] = 0x0D;
  page2[5] = (contentStart >> 8) & 0xFF;
  page2[6] = contentStart & 0xFF;

  const dataCells = [
    makeCell(1, ['user-1', 'alice@test.com', 'Alice']),
    makeCell(2, ['user-2', 'bob@test.com', 'Bob']),
  ];

  let dataPtr = contentStart;
  const dataOffsets = [];
  for (const cell of dataCells) {
    dataPtr -= cell.length;
    page2.set(new Uint8Array(cell), dataPtr);
    dataOffsets.push(dataPtr);
  }
  dataOffsets.reverse();

  page2[3] = 0; page2[4] = dataOffsets.length;
  for (let i = 0; i < dataOffsets.length; i++) {
    const po = 8 + i * 2;
    page2[po] = (dataOffsets[i] >> 8) & 0xFF;
    page2[po + 1] = dataOffsets[i] & 0xFF;
  }

  fs.writeFileSync('test.db', file);
  console.log('Wrote test.db: ' + file.length + ' bytes');

  // Verify
  try {
    const db = new SQL.Database(file);
    const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
    console.log('Tables:', tables[0].values.map(r => r[0]));
    for (const [name] of tables[0].values) {
      const r = db.exec('SELECT * FROM "' + name + '"');
      console.log(name + ':', r[0].values);
    }
    db.close();
    console.log('\n=== PASSED ===');
  } catch(e) {
    console.error('FAILED:', e.message);
    
    // Debug: dump page 1 cell area
    console.log('\nPage 1 cell area:');
    for (let i = contentStart; i < PAGE_SIZE; i += 16) {
      let hex = '';
      for (let j = 0; j < 16 && i + j < PAGE_SIZE; j++) {
        hex += ('0' + page1[i + j].toString(16)).slice(-2) + ' ';
      }
      console.log('  ' + i.toString(16) + ': ' + hex);
    }
    
    console.log('\nCell pointers:');
    for (let i = 0; i < cellOffsets.length * 2 + 8; i += 2) {
      const po = 8 + i;
      const val = (page1[po] << 8) | page1[po + 1];
      console.log('  ptr[' + (i/2) + '] at ' + po + ': 0x' + val.toString(16) + ' (' + val + ')');
    }
    
    // Dump cell contents
    console.log('\nCell contents:');
    for (let ci = 0; ci < cellOffsets.length; ci++) {
      const start = cellOffsets[ci];
      console.log('  Cell ' + ci + ' at offset ' + start + ':');
      let hex = '';
      for (let j = 0; j < 60 && start + j < PAGE_SIZE; j++) {
        hex += ('0' + page1[start + j].toString(16)).slice(-2) + ' ';
      }
      console.log('    ' + hex);
    }
  }
  fs.unlinkSync('test.db');
}

test();
