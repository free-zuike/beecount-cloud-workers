const fs = require('fs');
const initSqlJs = require('sql.js');

async function t() {
  const SQL = await initSqlJs();
  
  // Create ref
  const refDb = new SQL.Database();
  refDb.run('CREATE TABLE users (id TEXT, data TEXT)');
  refDb.run("INSERT INTO users VALUES ('u1', '" + 'x'.repeat(200) + "')");
  const refData = refDb.export();
  refDb.close();
  
  // Check page 2 more carefully
  const ptr = (refData[4104] << 8) | refData[4105];
  const cellStart = 4096 + ptr;
  
  // Maybe the cell doesn't start at content_start?
  // Try: cell pointer should point to start of cell
  // Cell = payload_len(varint) + rowid(varint) + record
  
  // Try interpreting first byte as something else
  console.log('First bytes at cell:');
  for (let i = 0; i < 10; i++) {
    console.log('  [' + i + '] = 0x' + refData[cellStart + i].toString(16) + ' (' + refData[cellStart + i] + ')');
  }
  
  // Try: 0x81 could be a single byte with high bit = 1 meaning something else?
  // In SQLite, the first byte of a leaf table cell is the payload length as a varint
  // But what if the first two bytes encode differently?
  
  // Actually, let me try: what if the encoding is:
  // payload_length = 2 bytes (big endian): 0x814E = 33102? No...
  
  // Or: what if 0x81 is NOT a varint continuation but a special marker?
  // Let me check what happens if I skip the first byte and try 0x4E:
  // 0x4E = 78 as a single-byte varint (MSB=0, value=78)
  
  // Try: skip 0x81, treat 0x4E as payload length = 78
  console.log('\nTrying skip-81 interpretation:');
  let pos = cellStart + 1; // skip 0x81
  let val = refData[pos]; // 0x4E = 78
  console.log('  payload_length = ' + val + ' (from 0x4e)');
  pos++; // 7985
  val = refData[pos]; // 0x01 = 1
  console.log('  rowid = ' + val);
  pos++; // 7986
  val = refData[pos]; // 0x04 = 4
  console.log('  headerSize = ' + val);
  pos++; // 7987
  
  // serial types
  const hs = val;
  let br = 0;
  while (br < hs - 1) {
    let st = 0, sh = 0;
    while (true) {
      const b = refData[pos];
      st |= (b & 0x7F) << sh;
      pos++; sh++; br++;
      if ((b & 0x80) === 0) break;
    }
    console.log('  serialType: ' + st + ' → ' + (st >= 13 && st % 2 === 1 ? 'text ' + ((st-13)/2) + 'B' : 'other'));
  }
  // Now read body
  console.log('  body at: ' + pos);
  // col0: text of len from st[0]
  // st[0] was 17 → 2 bytes
  // col1: text of len from st[1]
  // st[1] was...
  
  // Let me just re-run the serial type decode properly
  pos = cellStart + 3; // skip payload_len(0x81) + rowid(0x01) + headerSize(0x04)
  br = 0;
  const sts2 = [];
  while (br < 3) { // headerSize-1 = 3
    let st = 0, sh = 0;
    while (true) {
      const b = refData[pos];
      st |= (b & 0x7F) << sh;
      pos++; sh++; br++;
      if ((b & 0x80) === 0) break;
    }
    sts2.push(st);
  }
  console.log('\nSerial types: [' + sts2.join(', ') + ']');
  
  // Wait, I might be confused about the first byte. Let me try:
  // Cell = varint(payload_length) + varint(rowid) + record
  // Try: maybe 81 is the first byte of payload_length, but it's a MULTI-BYTE varint
  // 0x81 0x4E → (0x81 & 0x7F) | (0x4E << 7) = 1 | 9984 = 9985
  // That's too large.
  
  // OR: maybe the first byte is NOT part of the cell format.
  // What if the "content_start" includes the cell pointer area?
  
  // Let me try: what if ptr (3887) is not the start of cell data,
  // but the cell is at a different offset?
  
  // The cell count is 1, and ptr is 3887. In SQLite, the cell pointer
  // points directly to the cell data. So the cell SHOULD start at 3887.
  
  // Let me try yet another interpretation:
  // What if 0x81 means "payload length follows in next 2 bytes"?
  // Then payload = bytes[1..2] = 0x4E01 = 19969? No...
  
  // OR: what if 0x81 is NOT a varint but something else?
  
  // Actually, let me just check: what does the cell look like if I
  // treat the payload_length as varint 206 (0xCE 0x01)?
  // That's NOT what's in the file.
  
  // Let me check what's really at offset 7983:
  console.log('\nFull cell bytes:');
  for (let i = 0; i < 210; i++) {
    if (cellStart + i >= refData.length) break;
    const b = refData[cellStart + i];
    if (i % 20 === 0) process.stdout.write('\n  [' + i + ']: ');
    process.stdout.write(('0' + b.toString(16)).slice(-2) + ' ');
  }
  console.log();
}

t();
