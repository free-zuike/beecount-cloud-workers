const initSqlJs = require('sql.js');
const { createSqliteWithData } = require('./src/lib/sqlite-writer');

async function t() {
  const SQL = await initSqlJs();
  
  // Table with a long text field (> 119 bytes, triggers multi-byte serial type)
  const longPayload = 'x'.repeat(200);
  const data = createSqliteWithData({
    users: [{id:'u1', data: longPayload}],
  });
  
  try {
    const db = new SQL.Database(data);
    const r = db.exec("SELECT id, length(data) FROM users");
    console.log('Result: ' + JSON.stringify(r[0].values));
    db.close();
    console.log('PASSED');
  } catch(e) {
    console.error('FAILED: ' + e.message);
  }
}

t();
