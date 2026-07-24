const initSqlJs = require('sql.js');
const { createSqliteWithData } = require('./src/lib/sqlite-writer');

async function t() {
  const SQL = await initSqlJs();
  const data = createSqliteWithData({ users: [{id:'u1', data: 'x'.repeat(200)}] });
  
  // Page 2
  const p2 = 4096;
  const cc2 = (data[p2+3] << 8) | data[p2+4];
  const cs2 = (data[p2+5] << 8) | data[p2+6];
  console.log('Page 2: cells=' + cc2 + ' cs=' + cs2);
  
  const ptr2 = (data[p2+8] << 8) | data[p2+9];
  console.log('Cell ptr: ' + ptr2);
  
  // Decode cell
  let pos = p2 + ptr2;
  let val = 0, shift = 0;
  while (true) { const b = data[pos]; val |= (b & 0x7F) << shift; pos++; shift += 7; if (!(b & 0x80)) break; }
  console.log('payload_length: ' + val);
  val = 0; shift = 0;
  while (true) { const b = data[pos]; val |= (b & 0x7F) << shift; pos++; shift += 7; if (!(b & 0x80)) break; }
  console.log('rowid: ' + val);
  val = 0; shift = 0;
  while (true) { const b = data[pos]; val |= (b & 0x7F) << shift; pos++; shift += 7; if (!(b & 0x80)) break; }
  console.log('headerSize: ' + val);
  
  const hs = val;
  let bytesRead = 0;
  const sts = [];
  while (bytesRead < hs - 1) {
    val = 0; shift = 0;
    while (true) { const b = data[pos]; val |= (b & 0x7F) << shift; pos++; shift += 7; bytesRead++; if (!(b & 0x80)) break; }
    sts.push(val);
  }
  console.log('serialTypes: [' + sts.join(', ') + ']');
  console.log('Expected: [17, 413] for 2 columns (id="u1", data="xxx...")');
  
  // Check if 413 is correct
  // text serial type = 2*len + 13
  // For "u1" (2 bytes): 2*2+13 = 17 ✓
  // For "x".repeat(200) (200 bytes): 2*200+13 = 413 ✓
  
  // Check varint for 413
  console.log('413 varint: ' + ((413 & 0x7F) | 0x80) + ' ' + (413 >> 7) + ' = [' + ((413 & 0x7F) | 0x80) + ', ' + (413 >> 7) + ']');
  
  // What's actually there?
  const serialTypeStart = pos;
  console.log('Bytes at serial type position:');
  for (let i = 0; i < 10; i++) {
    console.log('  [' + i + '] = 0x' + data[serialTypeStart + i].toString(16) + ' (' + data[serialTypeStart + i] + ')');
  }
  
  try {
    const db = new SQL.Database(data);
    db.exec("SELECT * FROM users");
    db.close();
    console.log('\nPASSED');
  } catch(e) {
    console.error('\nFAILED: ' + e.message);
  }
}

t();
