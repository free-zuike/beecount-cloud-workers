const fs = require('fs');
const initSqlJs = require('sql.js');
const { createSqliteWithData } = require('./src/lib/sqlite-writer');

async function t() {
  const SQL = await initSqlJs();
  const data = createSqliteWithData({ users: [{id:'u1', data: 'x'.repeat(200)}] });
  
  // Dump page 1 B-tree header
  console.log('Page 1 header (100-116):');
  console.log(Array.from(data.slice(100, 116)).map(b=>('0'+b.toString(16)).slice(-2)).join(' '));
  
  const cellCount = (data[103] << 8) | data[104];
  const cs = (data[105] << 8) | data[106];
  console.log('cells=' + cellCount + ' cs=' + cs);
  
  const ptr = (data[108] << 8) | data[109];
  console.log('Cell at ' + ptr + ':');
  const hex = Array.from(data.slice(ptr, ptr+50)).map(b=>('0'+b.toString(16)).slice(-2)).join(' ');
  console.log(hex);
  
  // Decode cell
  let pos = ptr;
  let val = 0, shift = 0;
  while (true) { const b = data[pos]; val |= (b & 0x7F) << shift; pos++; shift += 7; if (!(b & 0x80)) break; }
  console.log('payload_length: ' + val);
  val = 0; shift = 0;
  while (true) { const b = data[pos]; val |= (b & 0x7F) << shift; pos++; shift += 7; if (!(b & 0x80)) break; }
  console.log('rowid: ' + val);
  val = 0; shift = 0;
  while (true) { const b = data[pos]; val |= (b & 0x7F) << shift; pos++; shift += 7; if (!(b & 0x80)) break; }
  console.log('headerSize: ' + val);
  
  // Read serial types
  const hs = val;
  let bytesRead = 0;
  const sts = [];
  while (bytesRead < hs - 1) {
    val = 0; shift = 0;
    while (true) { const b = data[pos]; val |= (b & 0x7F) << shift; pos++; shift += 7; bytesRead++; if (!(b & 0x80)) break; }
    sts.push(val);
  }
  console.log('serialTypes: [' + sts.join(', ') + ']');
  console.log('Expected: [17, ' + (200*2+13) + '] = [17, 413]');
  
  // Verify: 413 varint should be [0x9D, 0x03]
  console.log('413 as varint: [' + ((413 & 0x7F) | 0x80) + ', ' + (413 >> 7) + '] = 2 bytes');
  
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
