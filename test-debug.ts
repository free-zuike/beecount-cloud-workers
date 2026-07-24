const fs = require('fs');
const initSqlJs = require('sql.js');
const { createSqliteWithData } = require('./src/lib/sqlite-writer');

async function test() {
  const SQL = await initSqlJs();
  
  // Minimal test: just 1 table with 1 row
  const tables = {
    test: [{id:'hello', val:42}],
  };
  
  console.log('Creating SQLite...');
  const sqliteData = createSqliteWithData(tables);
  console.log('Size: ' + sqliteData.length);
  
  // Dump first 100 bytes of page 2
  const PAGE = 4096;
  console.log('\nPage 2 header:');
  for (let i = 0; i < 20; i++) {
    process.stdout.write(('0' + sqliteData[PAGE + i].toString(16)).slice(-2) + ' ');
  }
  console.log();
  
  // Dump first cell in page 2
  const cellCount = (sqliteData[PAGE + 3] << 8) | sqliteData[PAGE + 4];
  console.log('Cell count: ' + cellCount);
  
  if (cellCount > 0) {
    const ptr0 = (sqliteData[PAGE + 8] << 8) | sqliteData[PAGE + 9];
    console.log('Cell 0 ptr: ' + ptr0);
    console.log('Cell 0 data (' + Math.min(60, 4096 - ptr0) + ' bytes):');
    let hex = '';
    for (let i = 0; i < 60 && PAGE + ptr0 + i < sqliteData.length; i++) {
      hex += ('0' + sqliteData[PAGE + ptr0 + i].toString(16)).slice(-2) + ' ';
    }
    console.log(hex);
    
    // Decode the cell
    let pos = PAGE + ptr0;
    // payload length
    let val = 0, shift = 0;
    while (true) {
      const b = sqliteData[pos];
      val |= (b & 0x7F) << shift;
      pos++;
      shift += 7;
      if ((b & 0x80) === 0) break;
    }
    console.log('payload_length: ' + val);
    
    // rowid
    val = 0; shift = 0;
    while (true) {
      const b = sqliteData[pos];
      val |= (b & 0x7F) << shift;
      pos++;
      shift += 7;
      if ((b & 0x80) === 0) break;
    }
    console.log('rowid: ' + val);
    
    // record header
    val = 0; shift = 0;
    while (true) {
      const b = sqliteData[pos];
      val |= (b & 0x7F) << shift;
      pos++;
      shift += 7;
      if ((b & 0x80) === 0) break;
    }
    console.log('headerSize: ' + val);
    console.log('header starts at offset: ' + (pos - PAGE));
    
    // Read serial types
    const headerEnd = PAGE + ptr0 + 2 + val; // approximate
    const serialTypes = [];
    let headerBytesRead = 0;
    while (headerBytesRead < val - 1) { // -1 for headerSize varint
      let st = 0; shift = 0;
      while (true) {
        const b = sqliteData[pos];
        st |= (b & 0x7F) << shift;
        pos++;
        shift += 7;
        headerBytesRead++;
        if ((b & 0x80) === 0) break;
      }
      serialTypes.push(st);
    }
    console.log('serialTypes: [' + serialTypes.join(', ') + ']');
    console.log('expected: [17, 1] for (text "hello", int 42)');
  }
  
  try {
    const db = new SQL.Database(sqliteData);
    const r = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
    console.log('\nTables: ' + r[0].values.map(x => x[0]).join(', '));
    db.close();
    console.log('=== PASSED ===');
  } catch(e) {
    console.error('\nFAILED: ' + e.message);
  }
}

test();
