const fs = require('fs');
const zlib = require('zlib');
const initSqlJs = require('sql.js');

async function main() {
  const SQL = await initSqlJs();
  
  const data = fs.readFileSync('verify_backup.tar.gz');
  const decompressed = zlib.gunzipSync(data);
  
  let offset = 0;
  const entries = [];
  while (offset < decompressed.length - 512) {
    const header = decompressed.slice(offset, offset + 512);
    const name = header.slice(0, 100).toString('utf8').replace(/\0/g, '');
    if (!name) break;
    const size = parseInt(header.slice(124, 136).toString('utf8').replace(/\0/g, '').trim(), 8);
    entries.push({ name, size, offset: offset + 512 });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  
  console.log('=== Backup entries ===');
  entries.forEach(e => console.log('  ' + e.size.toLocaleString().padStart(12) + ' bytes  ' + e.name));
  console.log('  Compressed: ' + data.length.toLocaleString());
  
  const sqliteEntry = entries.find(e => e.name === 'db.sqlite3');
  const sqliteData = decompressed.slice(sqliteEntry.offset, sqliteEntry.offset + sqliteEntry.size);
  console.log('\ndb.sqlite3: ' + sqliteData.length.toLocaleString() + ' bytes');
  
  try {
    const db = new SQL.Database(sqliteData);
    
    const tablesResult = db.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    const tableNames = tablesResult.length > 0 ? tablesResult[0].values.map(r => r[0]) : [];
    console.log('  Tables: ' + tableNames.length);
    
    let totalRows = 0;
    const sqliteCounts = {};
    for (const name of tableNames) {
      const r = db.exec('SELECT COUNT(*) FROM "' + name + '"');
      const count = r[0].values[0][0];
      sqliteCounts[name] = count;
      totalRows += count;
      console.log('  ' + name.padEnd(30) + count + ' rows');
    }
    console.log('  Total: ' + totalRows + ' rows');
    
    // Sample data
    console.log('\n=== Sample: users ===');
    try {
      const r = db.exec('SELECT id, email FROM users LIMIT 2');
      r[0].values.forEach(row => console.log('  ' + row.join(' | ')));
    } catch(e) { console.log('  ' + e.message); }
    
    // Compare with db.json
    const dbJsonEntry = entries.find(e => e.name === 'db.json');
    const dbJson = JSON.parse(decompressed.slice(dbJsonEntry.offset, dbJsonEntry.offset + dbJsonEntry.size).toString('utf8'));
    
    console.log('\n=== COMPARISON ===');
    let allMatch = true;
    for (const [name, rows] of Object.entries(dbJson.tables)) {
      const jsonCount = Array.isArray(rows) ? rows.length : 0;
      const sqliteCount = sqliteCounts[name];
      if (sqliteCount !== undefined) {
        const match = jsonCount === sqliteCount;
        if (!match) allMatch = false;
        console.log('  ' + name.padEnd(30) + 'json=' + String(jsonCount).padStart(5) + '  sql=' + String(sqliteCount).padStart(5) + '  ' + (match ? 'OK' : 'MISMATCH'));
      } else {
        allMatch = false;
        console.log('  ' + name.padEnd(30) + 'json=' + String(jsonCount).padStart(5) + '  sql=N/A  MISSING');
      }
    }
    
    console.log('\n' + (allMatch ? '✅ ALL TABLES MATCH' : '❌ SOME MISMATCHES'));
    db.close();
  } catch(e) {
    console.error('❌ FAILED: ' + e.message);
  }
}

main().catch(e => console.error('FATAL:', e.message));
