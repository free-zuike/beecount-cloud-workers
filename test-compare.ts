const fs = require('fs');
const initSqlJs = require('sql.js');
const { createSqliteWithData } = require('./src/lib/sqlite-writer');

async function test() {
  const SQL = await initSqlJs();
  
  // Create reference with sql.js
  const refDb = new SQL.Database();
  refDb.run('CREATE TABLE t (a TEXT)');
  refDb.run("INSERT INTO t VALUES ('hi')");
  const refData = refDb.export();
  refDb.close();
  
  // Create with our writer
  const myData = createSqliteWithData({ t: [{a:'hi'}] });
  
  // Compare byte by byte
  console.log('Ref size: ' + refData.length);
  console.log('My size: ' + myData.length);
  
  // Compare page 1 B-tree headers
  console.log('\n--- Page 1 B-tree header ---');
  console.log('Ref[100-115]:', Array.from(refData.slice(100, 116)).map(b => ('0'+b.toString(16)).slice(-2)).join(' '));
  console.log('My[100-115]:', Array.from(myData.slice(100, 116)).map(b => ('0'+b.toString(16)).slice(-2)).join(' '));
  
  // For page 2
  console.log('\n--- Page 2 B-tree header ---');
  console.log('Ref[4096-4111]:', Array.from(refData.slice(4096, 4112)).map(b => ('0'+b.toString(16)).slice(-2)).join(' '));
  console.log('My[4096-4111]:', Array.from(myData.slice(4096, 4112)).map(b => ('0'+b.toString(16)).slice(-2)).join(' '));
  
  // Compare cell data on page 2
  const refCs2 = (refData[4101] << 8) | refData[4102];
  const myCs2 = (myData[4101] << 8) | myData[4102];
  console.log('\nPage 2 content_start: ref=' + refCs2 + ' my=' + myCs2);
  
  const refPtr2 = (refData[4104] << 8) | refData[4105];
  const myPtr2 = (myData[4104] << 8) | myData[4105];
  console.log('Page 2 cell ptr[0]: ref=' + refPtr2 + ' my=' + myPtr2);
  
  console.log('\nPage 2 cell data (ref):');
  console.log(Array.from(refData.slice(refPtr2, refPtr2+10)).map(b => ('0'+b.toString(16)).slice(-2)).join(' '));
  console.log('Page 2 cell data (my):');
  console.log(Array.from(myData.slice(myPtr2, myPtr2+10)).map(b => ('0'+b.toString(16)).slice(-2)).join(' '));
  
  // Try to read my file
  try {
    const db = new SQL.Database(myData);
    const r = db.exec("SELECT * FROM t");
    console.log('\n=== MY FILE READABLE ===');
    console.log(JSON.stringify(r[0].values));
    db.close();
  } catch(e) {
    console.error('\n=== MY FILE FAILED: ' + e.message + ' ===');
  }
}

test();
