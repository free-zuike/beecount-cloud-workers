const { createSqliteWithData } = require('./src/lib/sqlite-writer');
const initSqlJs = require('sql.js');

async function t() {
  const SQL = await initSqlJs();
  const data = createSqliteWithData({
    users: [{id:'u1',email:'a@b.com'},{id:'u2',email:'c@d.com'}],
    sync_changes: Array.from({length: 100}, (_,i) => ({change_id:i+1, user_id:'u1', payload_json:'{"a":'+i+'}', updated_at:'2026-07-20'})),
    read_category_projection: Array.from({length: 50}, (_,i) => ({sync_id:'c'+i, ledger_id:'l1', name:'cat'+i})),
  });
  console.log('Size: ' + data.length);
  const db = new SQL.Database(data);
  const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
  let total = 0;
  for (const [n] of tables[0].values) {
    const r = db.exec('SELECT COUNT(*) FROM "' + n + '"');
    total += r[0].values[0][0];
    console.log('  ' + n + ': ' + r[0].values[0][0]);
  }
  console.log('Total: ' + total);
  db.close();
  console.log('PASSED');
}
t().catch(e => console.error('FAILED: ' + e.message));
