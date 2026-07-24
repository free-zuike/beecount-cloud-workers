const fs = require('fs');
const initSqlJs = require('sql.js');
const { createSqliteWithData } = require('./src/lib/sqlite-writer');

async function t() {
  const SQL = await initSqlJs();
  
  // 3 simple tables
  const data = createSqliteWithData({
    users: [{id:'u1', name:'Alice'}],
    devices: [{id:'d1', name:'Phone'}],
    ledgers: [{id:'l1', name:'Main'}],
  });
  
  try {
    const db = new SQL.Database(data);
    const r = db.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    console.log('Tables: ' + r[0].values.map(x=>x[0]).join(', '));
    db.close();
    console.log('PASSED');
  } catch(e) {
    console.error('FAILED: ' + e.message);
    
    // Debug: check each page
    const totalPages = (data[28] << 24) | (data[29] << 16) | (data[30] << 8) | data[31];
    console.log('Pages: ' + totalPages);
    for (let p = 0; p < totalPages; p++) {
      const off = p * 4096;
      const type = data[off];
      const cc = (data[off+3] << 8) | data[off+4];
      const cs = (data[off+5] << 8) | data[off+6];
      console.log('  Page ' + (p+1) + ': type=0x' + type.toString(16) + ' cells=' + cc + ' cs=' + cs);
      for (let i = 0; i < cc; i++) {
        const ptr = (data[off+8+i*2] << 8) | data[off+8+i*2+1];
        const abs = off + ptr;
        let hex = '';
        for (let j = 0; j < 20; j++) hex += ('0' + data[abs+j].toString(16)).slice(-2) + ' ';
        console.log('    Cell ' + i + ': ptr=' + ptr + ' abs=' + abs + ': ' + hex);
      }
    }
  }
}

t();
