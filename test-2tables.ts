const fs = require('fs');
const initSqlJs = require('sql.js');
const { createSqliteWithData } = require('./src/lib/sqlite-writer');

async function t() {
  const SQL = await initSqlJs();
  const myData = createSqliteWithData({
    users: [{id:'u1', email:'a@b.com'}],
    sync_changes: [{change_id:1, payload_json:'{}'}],
  });
  
  fs.writeFileSync('test.db', myData);
  
  const cellCount1 = (myData[103] << 8) | myData[104];
  console.log('Page 1 cells: ' + cellCount1);
  for (let i = 0; i < cellCount1; i++) {
    const ptr = (myData[108+i*2] << 8) | myData[108+i*2+1];
    console.log('  Cell ' + i + ' ptr=' + ptr + ' rowid=' + (i+1));
  }
  
  try {
    const db = new SQL.Database(myData);
    const r = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
    console.log('Tables: ' + r[0].values.map(x=>x[0]).join(', '));
    for (const [name] of r[0].values) {
      const c = db.exec('SELECT COUNT(*) FROM "' + name + '"');
      console.log('  ' + name + ': ' + c[0].values[0][0] + ' rows');
    }
    db.close();
    console.log('PASSED');
  } catch(e) {
    console.error('FAILED: ' + e.message);
    
    // Check page 2 and 3
    for (let p = 1; p <= 2; p++) {
      const off = p * 4096;
      const cc = (myData[off+3] << 8) | myData[off+4];
      const cs = (myData[off+5] << 8) | myData[off+6];
      console.log('Page ' + (p+1) + ': cells=' + cc + ' cs=' + cs);
      if (cc > 0) {
        const ptr = (myData[off+8] << 8) | myData[off+9];
        console.log('  ptr[0]=' + ptr);
      }
    }
  }
  
  fs.unlinkSync('test.db');
}
t();
