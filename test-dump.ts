const fs = require('fs');
const initSqlJs = require('sql.js');
const { createSqliteWithData } = require('./src/lib/sqlite-writer');

async function t() {
  const SQL = await initSqlJs();
  const myData = createSqliteWithData({
    users: [{id:'u1', email:'a@b.com'}],
    sync_changes: [{change_id:1, payload_json:'{}'}],
  });
  
  // Dump page 2 cell
  const ptr2 = (myData[4104] << 8) | myData[4105];
  const abs2 = 4096 + ptr2;
  console.log('Page 2 cell at abs=' + abs2 + ':');
  console.log(Array.from(myData.slice(abs2, abs2+30)).map(b=>('0'+b.toString(16)).slice(-2)).join(' '));
  
  // Dump page 3 cell
  const ptr3 = (myData[8200] << 8) | myData[8201];
  const abs3 = 8192 + ptr3;
  console.log('Page 3 cell at abs=' + abs3 + ':');
  console.log(Array.from(myData.slice(abs3, abs3+30)).map(b=>('0'+b.toString(16)).slice(-2)).join(' '));
  
  // Try writing file and using sql.js to verify
  fs.writeFileSync('test.db', myData);
  try {
    const db = new SQL.Database(myData);
    db.exec("SELECT * FROM users");
    db.close();
    console.log('PASSED');
  } catch(e) {
    console.error('FAILED: ' + e.message);
  }
  fs.unlinkSync('test.db');
}
t();
