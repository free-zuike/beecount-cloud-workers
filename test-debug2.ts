const fs = require('fs');
const initSqlJs = require('sql.js');
const { createSqliteWithData } = require('./src/lib/sqlite-writer');

async function test() {
  const SQL = await initSqlJs();
  const PAGE = 4096;
  
  const tables = { test: [{id:'hello', val:42}] };
  const data = createSqliteWithData(tables);
  fs.writeFileSync('test.db', data);
  
  // Dump ALL pages
  const totalPages = (data[28] << 24) | (data[29] << 16) | (data[30] << 8) | data[31];
  console.log('Total pages: ' + totalPages);
  
  for (let p = 0; p < totalPages; p++) {
    const offset = p * PAGE;
    const pageType = data[offset];
    const cellCount = (data[offset + 3] << 8) | data[offset + 4];
    const contentStart = (data[offset + 5] << 8) | data[offset + 6];
    
    console.log('\n--- Page ' + (p+1) + ' ---');
    console.log('  type: 0x' + pageType.toString(16) + (pageType === 0x0D ? ' (leaf table)' : pageType === 0x00 ? ' (file header page)' : ' (other)'));
    
    if (p === 0) {
      // File header page - page 1 has 100 byte header + page header
      console.log('  (file header + sqlite_master)');
      console.log('  page header at offset 100:');
      const ph = offset + 100;
      console.log('    type=0x' + data[ph].toString(16));
      console.log('    cellCount=' + ((data[ph+3] << 8) | data[ph+4]));
    } else {
      console.log('  cellCount: ' + cellCount);
      console.log('  contentStart: ' + contentStart);
      
      // Read cell pointers
      const ptrs = [];
      for (let i = 0; i < cellCount; i++) {
        const po = offset + 8 + i * 2;
        const ptr = (data[po] << 8) | data[po + 1];
        ptrs.push(ptr);
      }
      console.log('  cellPtrs: [' + ptrs.join(', ') + ']');
      
      // Decode each cell
      for (let ci = 0; ci < ptrs.length; ci++) {
        const cp = offset + ptrs[ci];
        let pos = cp;
        
        // payload length
        let val = 0, shift = 0;
        while (pos < offset + PAGE) {
          const b = data[pos]; val |= (b & 0x7F) << shift; pos++; shift += 7;
          if ((b & 0x80) === 0) break;
        }
        const payloadLen = val;
        
        // rowid
        val = 0; shift = 0;
        while (pos < offset + PAGE) {
          const b = data[pos]; val |= (b & 0x7F) << shift; pos++; shift += 7;
          if ((b & 0x80) === 0) break;
        }
        const rowid = val;
        
        // headerSize
        val = 0; shift = 0;
        while (pos < offset + PAGE) {
          const b = data[pos]; val |= (b & 0x7F) << shift; pos++; shift += 7;
          if ((b & 0x80) === 0) break;
        }
        const headerSize = val;
        const recordStart = pos;
        
        // serial types
        const sts = [];
        let bytesRead = 0;
        while (bytesRead < headerSize - 1 && pos < offset + PAGE) {
          val = 0; shift = 0;
          while (pos < offset + PAGE) {
            const b = data[pos]; val |= (b & 0x7F) << shift; pos++; shift += 7;
            bytesRead++;
            if ((b & 0x80) === 0) break;
          }
          sts.push(val);
        }
        
        console.log('  Cell ' + ci + ': payload=' + payloadLen + ' rowid=' + rowid + ' headerSize=' + headerSize + ' sts=[' + sts + ']');
        
        // Read values
        for (let vi = 0; vi < sts.length; vi++) {
          const st = sts[vi];
          if (st === 0) { console.log('    col' + vi + ': NULL'); continue; }
          if (st === 8) { console.log('    col' + vi + ': int 0'); continue; }
          if (st === 9) { console.log('    col' + vi + ': int 1'); continue; }
          if (st >= 1 && st <= 6) {
            const intLens = [0, 1, 2, 3, 4, 6, 8];
            const il = intLens[st];
            let iv = 0;
            for (let b = 0; b < il; b++) iv = (iv << 8) | data[pos + b];
            pos += il;
            console.log('    col' + vi + ': int ' + iv);
            continue;
          }
          if (st === 7) { pos += 8; console.log('    col' + vi + ': float'); continue; }
          if (st >= 13 && st % 2 === 1) {
            const len = (st - 13) / 2;
            const txt = data.slice(pos, pos + len).toString('utf8');
            pos += len;
            console.log('    col' + vi + ': text "' + txt.substring(0, 50) + (txt.length > 50 ? '...' : '') + '" (' + len + ' bytes)');
            continue;
          }
          console.log('    col' + vi + ': unknown st=' + st);
          break;
        }
      }
    }
  }
  
  // Verify
  try {
    const db = new SQL.Database(data);
    const r = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
    console.log('\n✅ sql.js tables: ' + r[0].values.map(x => x[0]).join(', '));
    const d = db.exec("SELECT * FROM test");
    console.log('✅ test data: ' + JSON.stringify(d[0].values));
    db.close();
  } catch(e) {
    console.error('\n❌ FAILED: ' + e.message);
  }
  
  fs.unlinkSync('test.db');
}

test();
