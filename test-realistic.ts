const fs = require('fs');
const initSqlJs = require('sql.js');
const { createSqliteWithData } = require('./src/lib/sqlite-writer');

async function t() {
  const SQL = await initSqlJs();
  
  // Test with realistic backup data (long JSON payloads)
  const data = createSqliteWithData({
    users: [
      {id:'user-1', email:'test@example.com', password_hash:'$2b$10$abcdefghijklmnop', is_admin:0, is_enabled:1, created_at:'2026-01-01', totp_secret_encrypted:null, totp_enabled:0, totp_enabled_at:null},
      {id:'user-2', email:'admin@example.com', password_hash:'$2b$10$xyzwvutsrqponmlkjihg', is_admin:1, is_enabled:1, created_at:'2026-06-15', totp_secret_encrypted:null, totp_enabled:1, totp_enabled_at:'2026-06-20'},
    ],
    ledgers: [
      {id:'ledger-1', user_id:'user-1', external_id:'ext-1', name:'My Ledger', currency:'CNY', role:'owner', is_shared:0, invite_code:null, invite_expires_at:null, created_at:'2026-01-01', month_start_day:1},
    ],
    sync_changes: [
      {change_id:1, user_id:'user-1', ledger_id:'ledger-1', entity_type:'transaction', entity_sync_id:'tx-001', action:'upsert', payload_json:'{"amount":100.50,"category_id":"cat-1","account_id":"acc-1","tx_type":"expense","note":"Lunch","details":"Extra long text to trigger multi-byte serial type encoding"}', updated_at:'2026-07-20', updated_by_device_id:'dev-1', updated_by_user_id:'user-1', scope:'ledger'},
    ],
  });
  
  console.log('Size: ' + data.length);
  
  try {
    const db = new SQL.Database(data);
    const tablesResult = db.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    const names = tablesResult[0].values.map(r => r[0]);
    console.log('Tables: ' + names.join(', '));
    let total = 0;
    for (const n of names) {
      const r = db.exec('SELECT COUNT(*) FROM "' + n + '"');
      const c = r[0].values[0][0];
      total += c;
      console.log('  ' + n + ': ' + c + ' rows');
      if (c > 0) {
        const d = db.exec('SELECT * FROM "' + n + '" LIMIT 1');
        console.log('    cols: ' + d[0].columns.join(', '));
      }
    }
    console.log('Total: ' + total + ' rows');
    db.close();
    console.log('\n=== ALL TESTS PASSED ===');
  } catch(e) {
    console.error('\nFAILED: ' + e.message);
  }
}

t();
