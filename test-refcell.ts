const fs = require('fs');
const initSqlJs = require('sql.js');
const { createSqliteWithData } = require('./src/lib/sqlite-writer');

async function t() {
  const SQL = await initSqlJs();
  
  const refDb = new SQL.Database();
  refDb.run('CREATE TABLE users (id TEXT, data TEXT)');
  refDb.run("INSERT INTO users VALUES ('u1', '" + 'x'.repeat(200) + "')");
  const refData = refDb.export();
  refDb.close();
  
  // Dump ref page 2 from content_start
  const cs = (refData[4101] << 8) | refData[4102];
  const ptr = (refData[4104] << 8) | refData[4105];
  console.log('Ref page 2: cs=' + cs + ' ptr=' + ptr);
  
  // The cell starts at offset 4096 + ptr
  const cellOffset = 4096 + ptr;
  console.log('Ref cell at offset ' + cellOffset + ':');
  
  // Read varint: payload_length
  let pos = cellOffset;
  let val = 0, shift = 0;
  while (true) {
    const b = refData[pos];
    console.log('  byte[' + pos + '] = 0x' + b.toString(16) + ' (' + b + ')');
    val |= (b & 0x7F) << shift;
    pos++;
    shift += 7;
    if ((b & 0x80) === 0) break;
  }
  console.log('  payload_length = ' + val);
  
  // Read varint: rowid
  val = 0; shift = 0;
  while (true) {
    const b = refData[pos];
    console.log('  byte[' + pos + '] = 0x' + b.toString(16) + ' (' + b + ')');
    val |= (b & 0x7F) << shift;
    pos++;
    shift += 7;
    if ((b & 0x80) === 0) break;
  }
  console.log('  rowid = ' + val);
  
  // Read header
  val = 0; shift = 0;
  while (true) {
    const b = refData[pos];
    val |= (b & 0x7F) << shift;
    pos++;
    shift += 7;
    if ((b & 0x80) === 0) break;
  }
  console.log('  headerSize = ' + val);
  console.log('  header at offset ' + pos + ' (relative: ' + (pos - cellOffset) + ')');
  
  // Read serial types
  let bytesRead = 0;
  const hs = val;
  while (bytesRead < hs - 1) {
    val = 0; shift = 0;
    while (true) {
      const b = refData[pos];
      val |= (b & 0x7F) << shift;
      pos++;
      shift += 7;
      bytesRead++;
      if ((b & 0x80) === 0) break;
    }
    console.log('  serialType: ' + val);
  }
  
  // Now read the body
  console.log('  body starts at offset ' + pos);
  
  // Read first value (id = "u1")
  const st1Len = 2; // 17 → (17-13)/2 = 2
  console.log('  col0: ' + refData.slice(pos, pos + st1Len).toString('utf8'));
  pos += st1Len;
  
  // Read second value (data = "xxx...x")
  const st2Len = 200; // 413 → (413-13)/2 = 200
  console.log('  col1 length: ' + refData.slice(pos, pos + st2Len).length);
  pos += st2Len;
  
  console.log('  cell end at offset ' + pos + ' (cell length: ' + (pos - cellOffset) + ')');
  
  // Expected: payload_length = 4 (header) + 2 + 200 (body) = 206
  // Actual: payload_length from varint was...
  // But the first varint was `81 4e` = 9985??
  
  // Actually let me check: maybe the first byte at cellOffset is NOT a varint
  console.log('\nRaw bytes at cell:');
  for (let i = 0; i < 15; i++) {
    console.log('  [' + i + '] = 0x' + refData[cellOffset + i].toString(16) + ' (' + refData[cellOffset + i] + ')');
  }
}

t();
