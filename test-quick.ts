const fs = require('fs');
const initSqlJs = require('sql.js');
const { createSqliteWithData } = require('./src/lib/sqlite-writer');

async function test() {
  const SQL = await initSqlJs();
  
  const tables = {
    users: [
      {id:'user-1', email:'test@test.com', name:'Test'},
      {id:'user-2', email:'admin@test.com', name:'Admin'},
    ],
    sync_changes: [
      {change_id:1, user_id:'u1', payload_json:'{"amount":100.50,"note":"Lunch"}', updated_at:'2026-07-20'},
    ],
  };
  
  const data = createSqliteWithData(tables);
  fs.writeFileSync('test.db', data);
  console.log('Size: ' + data.length);
  
  try {
    const db = new SQL.Database(data);
    const tablesResult = db.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    const names = tablesResult[0].values.map(r => r[0]);
    console.log('Tables: ' + names.join(', '));
    let total = 0;
    for (const n of names) {
      const r = db.exec('SELECT COUNT(*) FROM "' + n + '"');
      const c = r[0].values[0][0];
      total += c;
      console.log('  ' + n + ': ' + c + ' rows');
      if (c > 0) {
        const d = db.exec('SELECT * FROM "' + n + '" LIMIT 1');
        console.log('    cols: ' + d[0].columns.join(', '));
      }
    }
    console.log('Total: ' + total + ' rows');
    db.close();
    console.log('\n=== PASSED ===');
  } catch(e) {
    console.error('FAILED: ' + e.message);
  }
  fs.unlinkSync('test.db');
}
test();
