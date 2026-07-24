const fs = require('fs');
const initSqlJs = require('sql.js');
const { createSqliteWithData } = require('./src/lib/sqlite-writer');

async function t() {
  const SQL = await initSqlJs();
  
  // Test 1: single table
  let data = createSqliteWithData({ users: [{id:'u1', email:'a@b.com'}] });
  try {
    const db = new SQL.Database(data);
    const r = db.exec("SELECT * FROM users");
    console.log('1 table: ' + JSON.stringify(r[0].values));
    db.close();
  } catch(e) { console.log('1 table FAILED: ' + e.message); }
  
  // Test 2: two tables  
  data = createSqliteWithData({
    users: [{id:'u1', email:'a@b.com'}],
    devices: [{id:'d1', name:'Phone'}],
  });
  try {
    const db = new SQL.Database(data);
    const r = db.exec("SELECT * FROM users");
    const r2 = db.exec("SELECT * FROM devices");
    console.log('2 tables: users=' + JSON.stringify(r[0].values) + ' devices=' + JSON.stringify(r2[0].values));
    db.close();
  } catch(e) { console.log('2 tables FAILED: ' + e.message); }
}

t();
