const fs = require('fs');
const initSqlJs = require('sql.js');
const { createSqliteWithData } = require('./src/lib/sqlite-writer');

async function t() {
  const SQL = await initSqlJs();
  
  // Reference: sql.js creates same data
  const refDb = new SQL.Database();
  refDb.run('CREATE TABLE users (id TEXT, data TEXT)');
  refDb.run("INSERT INTO users VALUES ('u1', '" + 'x'.repeat(200) + "')");
  const refData = refDb.export();
  refDb.close();
  
  // My version
  const myData = createSqliteWithData({ users: [{id:'u1', data: 'x'.repeat(200)}] });
  
  fs.writeFileSync('ref.db', refData);
  fs.writeFileSync('my.db', myData);
  
  // Compare page 2 B-tree headers
  console.log('Ref page 2 (' + refData.length + ' bytes):');
  console.log('  ' + Array.from(refData.slice(4096, 4112)).map(b=>('0'+b.toString(16)).slice(-2)).join(' '));
  console.log('My page 2 (' + myData.length + ' bytes):');
  console.log('  ' + Array.from(myData.slice(4096, 4112)).map(b=>('0'+b.toString(16)).slice(-2)).join(' '));
  
  // Page 2 cell count and content_start
  const rCs = (refData[4101] << 8) | refData[4102];
  const mCs = (myData[4101] << 8) | myData[4102];
  const rPtr = (refData[4104] << 8) | refData[4105];
  const mPtr = (myData[4104] << 8) | myData[4105];
  console.log('  ref: cs=' + rCs + ' ptr=' + rPtr);
  console.log('  my:  cs=' + mCs + ' ptr=' + mPtr);
  
  // Ref cell data
  console.log('\nRef cell at ' + (4096+rPtr) + ':');
  console.log(Array.from(refData.slice(4096+rPtr, 4096+rPtr+30)).map(b=>('0'+b.toString(16)).slice(-2)).join(' '));
  
  // My cell data
  console.log('My cell at ' + (4096+mPtr) + ':');
  console.log(Array.from(myData.slice(4096+mPtr, 4096+mPtr+30)).map(b=>('0'+b.toString(16)).slice(-2)).join(' '));
  
  // Full hex diff on page 2
  console.log('\nPage 2 hex diff (first 50 bytes from content start):');
  for (let i = 0; i < 50; i++) {
    const ri = 4096 + rPtr + i;
    const mi = 4096 + mPtr + i;
    const r = refData[ri] || 0;
    const m = myData[mi] || 0;
    if (r !== m) console.log('  DIFF at +' + i + ': ref=0x' + r.toString(16) + ' my=0x' + m.toString(16));
  }
  
  // Verify both
  try { const db = new SQL.Database(refData); db.exec("SELECT * FROM users"); db.close(); console.log('\nRef: OK'); } catch(e) { console.log('\nRef: ' + e.message); }
  try { const db = new SQL.Database(myData); db.exec("SELECT * FROM users"); db.close(); console.log('My: OK'); } catch(e) { console.log('My: ' + e.message); }
  
  fs.unlinkSync('ref.db');
  fs.unlinkSync('my.db');
}

t();
