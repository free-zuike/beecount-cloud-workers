const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

const sql = "SELECT change_id, entity_sync_id, substr(payload_json, 1, 200) as payload FROM sync_changes WHERE payload_json LIKE '%\"tags\":[%' AND entity_type = 'transaction' ORDER BY change_id";
const sqlFile = path.join(require('os').tmpdir(), 'find_bad_tags.sql');
fs.writeFileSync(sqlFile, sql, 'utf8');

const result = execSync('npx wrangler d1 execute beecount-cloud --remote --file "' + sqlFile + '"', {
  encoding: 'utf8', cwd: 'E:\\Code\\beecount-cloud-workers', shell: 'powershell.exe', timeout: 60000
});
console.log(result);