const initSqlJs = require('sql.js');
const fs = require('fs');
async function main() {
    const SQL = await initSqlJs();
    const buffer = fs.readFileSync('C:\\Users\\张然\\.local\\share\\mimocode\\mimocode.db');
    const db = new SQL.Database(buffer);
    
    const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    console.log('=== TABLES ===');
    if (tables.length > 0) tables[0].values.forEach(r => console.log(r[0]));
    
    const sessions = db.exec("SELECT id, project_id, directory, title, time_created FROM session ORDER BY time_created DESC LIMIT 30");
    console.log('\n=== RECENT SESSIONS (30) ===');
    if (sessions.length > 0) sessions[0].values.forEach(r => console.log(r[0] + ' | ' + r[1] + ' | ' + r[2] + ' | ' + r[3] + ' | ' + r[4]));
    
    db.close();
}
main().catch(e => console.error(e));
