const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

const findSql = "SELECT change_id, payload_json FROM sync_changes WHERE payload_json LIKE '%\"tags\":[%' AND entity_type = 'transaction'";
const findFile = path.join(require('os').tmpdir(), 'debug_output.sql');
fs.writeFileSync(findFile, findSql, 'utf8');

const raw = execSync('npx wrangler d1 execute beecount-cloud --remote --file "' + findFile + '"', {
  encoding: 'utf8', cwd: 'E:\\Code\\beecount-cloud-workers', timeout: 60000
});

console.log('RAW OUTPUT:');
console.log(raw);
console.log('---END---');