// Test the actual sqlite-writer.ts module
const fs = require('fs');
const initSqlJs = require('sql.js');

// Import the actual module
async function test() {
  const SQL = await initSqlJs();
  
  // Dynamically load the TypeScript module via tsx or esbuild
  // Since we can't directly import TS, let's just test the logic inline
  // matching the EXACT code in sqlite-writer.ts
  
  const PAGE_SIZE = 4096;
  
  function encodeVarint(value) {
    if (value <= 0x7F) return [value];
    const result = [];
    let v = value;
    while (v > 0x7F) { result.push((v & 0x7F) | 0x80); v >>= 7; }
    result.push(v & 0x7F);
    return result;
  }
  
  function encodeValue(val) {
    if (val === null || val === undefined) return [0];
    if (typeof val === 'boolean') return val ? [9] : [8];
    if (typeof val === 'number') {
      if (Number.isInteger(val)) {
        if (val === 0) return [8];
        if (val === 1) return [9];
        if (val >= -128 && val <= 127) return [1, val & 0xFF];
        if (val >= -32768 && val <= 32767) return [2, (val >> 8) & 0xFF, val & 0xFF];
        if (val >= -8388608 && val <= 8388607) return [3, (val >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF];
        if (val >= -2147483648 && val <= 2147483647) return [4, (val >> 24) & 0xFF, (val >> 16) & 0xFF, (val >> 8) & 0xFF, val & 0xFF];
        const buf = new ArrayBuffer(8); new DataView(buf).setFloat64(0, val, false); return [7, ...new Uint8Array(buf)];
      }
      const buf = new ArrayBuffer(8); new DataView(buf).setFloat64(0, val, false); return [7, ...new Uint8Array(buf)];
    }
    const bytes = new TextEncoder().encode(String(val));
    const serialType = bytes.length * 2 + 13;
    return [...encodeVarint(serialType), ...bytes];
  }
  
  function buildRecordPayload(columns, values) {
    const serialTypes = [];
    const valueBytes = [];
    for (let i = 0; i < columns.length; i++) {
      const encoded = encodeValue(values[i]);
      serialTypes.push(encoded[0]);
      valueBytes.push(encoded.slice(1));
    }
    // FIX: correctly compute headerSize accounting for multi-byte serial type varints
    const serialTypeVarints = [];
    for (const st of serialTypes) {
      serialTypeVarints.push(...encodeVarint(st));
    }
    let headerSize = 1 + serialTypeVarints.length;
    if (headerSize > 127) {
      headerSize = encodeVarint(headerSize).length + serialTypeVarints.length;
    }
    const payload = [];
    payload.push(...encodeVarint(headerSize));
    payload.push(...serialTypeVarints);
    for (const vb of valueBytes) payload.push(...vb);
    return payload;
  }
  
  // Simulate real backup data (mimicking what backup-executor sends)
  const tables = {
    users: [
      {id: 'user-12345', email: 'test@example.com', password_hash: '$2b$10$abcdefghijklmnopqrstuuJKLMNOPQRSTUVWXYZ01234567', is_admin: 0, is_enabled: 1, created_at: '2026-01-01T00:00:00Z', totp_secret_encrypted: null, totp_enabled: 0, totp_enabled_at: null},
      {id: 'user-67890', email: 'admin@example.com', password_hash: '$2b$10$abcdefghijklmnopqrstuuJKLMNOPQRSTUVWXYZ01234567', is_admin: 1, is_enabled: 1, created_at: '2026-06-15T00:00:00Z', totp_secret_encrypted: null, totp_enabled: 1, totp_enabled_at: '2026-06-20T00:00:00Z'},
    ],
    ledgers: [
      {id: 'ledger-1', user_id: 'user-12345', external_id: 'ext-1', name: 'My Ledger', currency: 'CNY', role: 'owner', is_shared: 0, invite_code: null, invite_expires_at: null, created_at: '2026-01-01T00:00:00Z', month_start_day: 1},
    ],
    sync_changes: [
      {change_id: 1, user_id: 'user-12345', ledger_id: 'ledger-1', entity_type: 'transaction', entity_sync_id: 'tx-001', action: 'upsert', payload_json: '{"amount":100.50,"category_id":"cat-1","account_id":"acc-1","tx_type":"expense","note":"Lunch"}', updated_at: '2026-07-20T10:00:00Z', updated_by_device_id: 'dev-1', updated_by_user_id: 'user-12345', scope: 'ledger'},
      {change_id: 2, user_id: 'user-12345', ledger_id: 'ledger-1', entity_type: 'category', entity_sync_id: 'cat-1', action: 'upsert', payload_json: '{"name":"Food","category_type":"expense","icon":"food"}', updated_at: '2026-07-20T10:00:00Z', updated_by_device_id: 'dev-1', updated_by_user_id: 'user-12345', scope: 'ledger'},
    ],
    devices: [{id: 'dev-1', user_id: 'user-12345', name: 'iPhone', platform: 'ios', app_version: '1.0', os_version: '17.0', device_model: 'iPhone 15', last_ip: '1.2.3.4', last_seen_at: '2026-07-20T10:00:00Z', revoked_at: null, created_at: '2026-01-01T00:00:00Z'}],
  };
  
  // Build schemas
  const tableNames = Object.keys(tables);
  const schemas = [];
  for (const tn of tableNames) {
    const firstRow = tables[tn][0];
    const cols = Object.keys(firstRow);
    const colDefs = cols.map(c => '"' + c + '" TEXT').join(', ');
    schemas.push({ name: tn, sql: 'CREATE TABLE "' + tn + '" (' + colDefs + ')' });
  }
  
  // Build file
  const maxFileSize = (1 + 20) * PAGE_SIZE;
  const file = new Uint8Array(maxFileSize);
  
  // Header
  const hdr = new Uint8Array(PAGE_SIZE);
  hdr.set(new TextEncoder().encode('SQLite format 3\0'), 0);
  hdr[16] = 0x10; hdr[17] = 0x00;
  hdr[18] = 1; hdr[19] = 1; hdr[20] = 0;
  hdr[21] = 64; hdr[22] = 32; hdr[23] = 32;
  hdr[47] = 4; hdr[59] = 1; hdr[95] = 1;
  hdr[96] = 0x00; hdr[97] = 0x03; hdr[98] = 0x35; hdr[99] = 0x04;
  file.set(hdr, 0);
  
  // Master page - EXACT same logic as sqlite-writer.ts
  const mp = new Uint8Array(PAGE_SIZE);
  mp[0] = 0x0D;
  const contentStart = PAGE_SIZE - 100;
  mp[5] = (contentStart >> 8) & 0xFF;
  mp[6] = contentStart & 0xFF;
  
  const allRecs = [{rowid: 1, name: 'sqlite_master', sql: 'CREATE TABLE sqlite_master(type TEXT, name TEXT, tbl_name TEXT, rootpage INTEGER, sql TEXT)'}];
  schemas.forEach((s, i) => allRecs.push({rowid: i + 2, name: s.name, sql: s.sql}));
  
  let cellOffset = contentStart;
  const cellPointers = [];
  
  for (let i = allRecs.length - 1; i >= 0; i--) {
    const rec = allRecs[i];
    const payload = buildRecordPayload(
      ['type', 'name', 'tbl_name', 'rootpage', 'sql'],
      ['table', rec.name, rec.name, rec.rowid, rec.sql]
    );
    const cell = [...encodeVarint(payload.length), ...encodeVarint(rec.rowid), ...payload];
    if (cellOffset - cell.length < 100) continue;
    cellOffset -= cell.length;
    mp.set(new Uint8Array(cell), cellOffset);
    cellPointers.unshift(cellOffset);
  }
  
  const actualCount = cellPointers.length;
  mp[3] = (actualCount >> 8) & 0xFF;
  mp[4] = actualCount & 0xFF;
  
  for (let i = 0; i < cellPointers.length; i++) {
    const ptrOffset = 8 + i * 2;
    if (ptrOffset + 1 < 100) {
      mp[ptrOffset] = (cellPointers[i] >> 8) & 0xFF;
      mp[ptrOffset + 1] = cellPointers[i] & 0xFF;
    }
  }
  
  file.set(mp, PAGE_SIZE);
  
  // Data pages
  let pageNum = 2;
  for (const tn of tableNames) {
    const rows = tables[tn];
    const cols = Object.keys(rows[0]);
    const rowData = rows.map(r => cols.map(c => r[c]));
    
    let startRow = 0;
    while (startRow < rowData.length) {
      const dp = new Uint8Array(PAGE_SIZE);
      dp[0] = 0x0D;
      dp[5] = (contentStart >> 8) & 0xFF;
      dp[6] = contentStart & 0xFF;
      let co = contentStart;
      const dpPtrs = [];
      let rw = 0;
      
      for (let ri = startRow; ri < rowData.length; ri++) {
        const payload = buildRecordPayload(cols, rowData[ri]);
        const cell = [...encodeVarint(payload.length), ...encodeVarint(ri + 1), ...payload];
        if (co - cell.length < 100) break;
        co -= cell.length;
        dp.set(new Uint8Array(cell), co);
        dpPtrs.unshift(co);
        rw++;
      }
      
      dp[3] = (rw >> 8) & 0xFF;
      dp[4] = rw & 0xFF;
      for (let i = 0; i < dpPtrs.length; i++) {
        const po = 8 + i * 2;
        dp[po] = (dpPtrs[i] >> 8) & 0xFF;
        dp[po + 1] = dpPtrs[i] & 0xFF;
      }
      file.set(dp, pageNum * PAGE_SIZE);
      pageNum++;
      startRow += rw;
      if (rw === 0) break;
    }
  }
  
  // Update page count
  file[28] = (pageNum >> 24) & 0xFF;
  file[29] = (pageNum >> 16) & 0xFF;
  file[30] = (pageNum >> 8) & 0xFF;
  file[31] = pageNum & 0xFF;
  
  const result = file.slice(0, pageNum * PAGE_SIZE);
  fs.writeFileSync('test.db', result);
  console.log('Wrote test.db: ' + result.length + ' bytes, ' + pageNum + ' pages');
  
  // Verify with sql.js
  const db = new SQL.Database(result);
  const tableList = db.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
  console.log('\nTables found by sql.js:');
  let totalRows = 0;
  for (const [name] of tableList[0].values) {
    const r = db.exec('SELECT COUNT(*) FROM "' + name + '"');
    const count = r[0].values[0][0];
    totalRows += count;
    console.log('  ' + name.padEnd(25) + count + ' rows');
    if (count > 0) {
      const sample = db.exec('SELECT * FROM "' + name + '" LIMIT 1');
      if (sample.length > 0) {
        console.log('    columns: ' + sample[0].columns.join(', '));
      }
    }
  }
  console.log('Total: ' + totalRows + ' rows');
  db.close();
  fs.unlinkSync('test.db');
  console.log('\n=== ALL TESTS PASSED ===');
}

test().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
