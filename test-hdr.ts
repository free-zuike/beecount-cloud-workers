const fs = require('fs');
const initSqlJs = require('sql.js');
const { createSqliteWithData } = require('./src/lib/sqlite-writer');

async function t() {
  const SQL = await initSqlJs();
  const myData = createSqliteWithData({ t: [{a:'hi'}] });
  const refDb = new SQL.Database();
  refDb.run('CREATE TABLE t (a TEXT)');
  refDb.run("INSERT INTO t VALUES ('hi')");
  const refData = refDb.export();
  refDb.close();
  
  console.log('File header comparison:');
  let diffs = 0;
  for (let i = 0; i < 100; i++) {
    if (refData[i] !== myData[i]) {
      console.log('  DIFF at ' + i + ': ref=0x' + refData[i].toString(16) + ' my=0x' + myData[i].toString(16));
      diffs++;
    }
  }
  if (diffs === 0) console.log('  No differences in first 100 bytes');
  
  console.log('Reserved (byte 20): ref=' + refData[20] + ' my=' + myData[20]);
  console.log('Encoding (bytes 56-59): ref=' + refData.slice(56,60) + ' my=' + myData.slice(56,60));
  console.log('DB size (bytes 28-31): ref=' + ((refData[28]<<24)|(refData[29]<<16)|(refData[30]<<8)|refData[31]) + ' my=' + ((myData[28]<<24)|(myData[29]<<16)|(myData[30]<<8)|myData[31]));
  
  // Compare page 1 in detail
  console.log('\nPage 1 B-tree:');
  console.log('  Ref cells: ' + ((refData[103]<<8)|refData[104]) + ' content_start: ' + ((refData[105]<<8)|refData[106]));
  console.log('  My  cells: ' + ((myData[103]<<8)|myData[104]) + ' content_start: ' + ((myData[105]<<8)|myData[106]));
  
  // What's at the ref content_start?
  const refCs = (refData[105]<<8)|refData[106];
  console.log('\nRef cell at offset ' + refCs + ':');
  console.log(Array.from(refData.slice(refCs, refCs+40)).map(b=>('0'+b.toString(16)).slice(-2)).join(' '));
  
  // What about the file header reserved area?
  // Check if bytes 100-115 of ref have different content
  console.log('\nRef page 1 header bytes 100-115:');
  console.log(Array.from(refData.slice(100, 116)).map(b=>('0'+b.toString(16)).slice(-2)).join(' '));
  
  try {
    const db = new SQL.Database(myData);
    db.exec('SELECT * FROM t');
    db.close();
    console.log('\nMy file: OK');
  } catch(e) { console.log('\nMy file: ' + e.message); }
}

t();
