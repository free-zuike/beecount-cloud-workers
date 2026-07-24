const fs = require('fs');
const initSqlJs = require('sql.js');
const { createSqliteWithData } = require('./src/lib/sqlite-writer');

async function test() {
  const SQL = await initSqlJs();
  
  // Minimal: just one table, one row
  const data = createSqliteWithData({
    t: [{a:'hi'}],
  });
  
  fs.writeFileSync('test.db', data);
  console.log('Size: ' + data.length);
  
  // Hex dump page 1 from offset 100
  console.log('\nPage 1 B-tree (offset 100-160):');
  for (let i = 100; i < 160; i += 16) {
    let hex = '';
    for (let j = 0; j < 16 && i + j < 200; j++) hex += ('0' + data[i + j].toString(16)).slice(-2) + ' ';
    console.log('  ' + i + ': ' + hex);
  }
  
  // Read B-tree header
  const b1 = 100;
  const cellCount1 = (data[b1+3] << 8) | data[b1+4];
  const cs1 = (data[b1+5] << 8) | data[b1+6];
  console.log('\nPage 1: cellCount=' + cellCount1 + ' contentStart=' + cs1);
  
  for (let i = 0; i < cellCount1; i++) {
    const ptr = (data[b1 + 8 + i*2] << 8) | data[b1 + 8 + i*2 + 1];
    console.log('  Cell ' + i + ' ptr=' + ptr);
    // Dump cell data
    let hex = '';
    for (let j = 0; j < 40; j++) hex += ('0' + data[ptr + j].toString(16)).slice(-2) + ' ';
    console.log('    ' + hex);
  }
  
  // Page 2
  if (data.length > 4096) {
    const b2 = 4096;
    const cellCount2 = (data[b2+3] << 8) | data[b2+4];
    const cs2 = (data[b2+5] << 8) | data[b2+6];
    console.log('\nPage 2: cellCount=' + cellCount2 + ' contentStart=' + cs2);
    
    for (let i = 0; i < cellCount2; i++) {
      const ptr = (data[b2 + 8 + i*2] << 8) | data[b2 + 8 + i*2 + 1];
      console.log('  Cell ' + i + ' ptr=' + ptr);
      let hex = '';
      for (let j = 0; j < 40; j++) hex += ('0' + data[ptr + j].toString(16)).slice(-2) + ' ';
      console.log('    ' + hex);
    }
  }
  
  try {
    const db = new SQL.Database(data);
    const r = db.exec("SELECT * FROM t");
    console.log('\nResult: ' + JSON.stringify(r[0].values));
    db.close();
    console.log('=== PASSED ===');
  } catch(e) {
    console.error('\nFAILED: ' + e.message);
  }
  fs.unlinkSync('test.db');
}
test();
