const initSqlJs = require('sql.js');
async function t() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run('CREATE TABLE t (a TEXT)');
  db.run("INSERT INTO t VALUES ('hi')");
  
  // Check what's actually in sqlite_master
  const r = db.exec("SELECT * FROM sqlite_master");
  console.log('sqlite_master rows:');
  for (const row of r[0].values) {
    console.log('  type=' + row[0] + ' name=' + row[1] + ' tbl_name=' + row[2] + ' rootpage=' + row[3]);
  }
  
  // Export and check raw file
  const data = db.export();
  
  // Check page 1 cell count
  const cellCount = (data[103] << 8) | data[104];
  const cs = (data[105] << 8) | data[106];
  console.log('\nPage 1: cells=' + cellCount + ' content_start=' + cs);
  
  // Check all cell pointers
  for (let i = 0; i < cellCount; i++) {
    const ptr = (data[108 + i*2] << 8) | data[108 + i*2 + 1];
    console.log('  Cell ' + i + ' ptr=' + ptr + ' data: ' + 
      Array.from(data.slice(ptr, ptr+20)).map(b=>('0'+b.toString(16)).slice(-2)).join(' '));
  }
  
  // Also check: does sql.js store sqlite_master entry for itself?
  // Run VACUUM INTO to get a clean file
  db.run("VACUUM INTO '/tmp/test_vacuum.db'");
  
  db.close();
}

t().catch(e => console.error(e));
