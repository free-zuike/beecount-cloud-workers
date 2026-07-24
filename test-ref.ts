const fs = require('fs');
const initSqlJs = require('sql.js');

async function main() {
  const SQL = await initSqlJs();
  const PAGE = 4096;
  
  // Create a simple SQLite DB with sql.js
  const db = new SQL.Database();
  db.run('CREATE TABLE test (id TEXT, val INTEGER)');
  db.run("INSERT INTO test VALUES ('hello', 42)");
  
  const data = db.export();
  fs.writeFileSync('reference.db', data);
  
  console.log('reference.db size: ' + data.length + ' bytes');
  console.log('Pages: ' + (data.length / PAGE));
  
  // Examine page 1
  console.log('\n=== PAGE 1 ===');
  console.log('File header magic: ' + data.slice(0, 16).toString('utf8'));
  console.log('Page size: ' + ((data[16] << 8) | data[17]));
  console.log('Total pages: ' + ((data[28] << 24) | (data[29] << 16) | (data[30] << 8) | data[31]));
  console.log('Text encoding: ' + ((data[56] << 24) | (data[57] << 16) | (data[58] << 8) | data[59]));
  
  // B-tree header at offset 100
  const bh = 100;
  console.log('\nB-tree header at offset 100:');
  console.log('  type: 0x' + data[bh].toString(16) + (data[bh] === 0x0D ? ' (leaf table)' : ''));
  console.log('  first_freeblock: ' + ((data[bh+1] << 8) | data[bh+2]));
  console.log('  cell_count: ' + ((data[bh+3] << 8) | data[bh+4]));
  console.log('  content_area_start: ' + ((data[bh+5] << 8) | data[bh+6]));
  console.log('  fragmented_bytes: ' + data[bh+7]);
  
  // Cell pointers
  const cellCount = ((data[bh+3] << 8) | data[bh+4]);
  console.log('  cell pointers:');
  for (let i = 0; i < cellCount; i++) {
    const po = bh + 8 + i * 2;
    const ptr = (data[po] << 8) | data[po + 1];
    console.log('    [' + i + '] = ' + ptr + ' (0x' + ptr.toString(16) + ')');
  }
  
  // Dump page 1 hex from offset 100 to 140
  console.log('\nPage 1 bytes 100-200:');
  for (let i = 100; i < 200; i += 16) {
    let hex = '', asc = '';
    for (let j = 0; j < 16 && i + j < data.length; j++) {
      const b = data[i + j];
      hex += ('0' + b.toString(16)).slice(-2) + ' ';
      asc += (b >= 32 && b < 127) ? String.fromCharCode(b) : '.';
    }
    console.log('  ' + i.toString().padStart(4) + ': ' + hex + ' ' + asc);
  }
  
  // If there's a page 2, examine it
  if (data.length > PAGE) {
    console.log('\n=== PAGE 2 ===');
    console.log('type: 0x' + data[PAGE].toString(16));
    const bh2 = PAGE;
    console.log('cell_count: ' + ((data[bh2+3] << 8) | data[bh2+4]));
    console.log('content_start: ' + ((data[bh2+5] << 8) | data[bh2+6]));
  }
  
  db.close();
  fs.unlinkSync('reference.db');
}

main();
