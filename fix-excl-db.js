const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

const sql = [
  "UPDATE read_tx_projection SET exclude_from_stats = 1, exclude_from_budget = 1 WHERE sync_id = 'aba93b30-be83-4e0e-b9f9-54954734fec5'",
  "UPDATE read_tx_projection SET exclude_from_stats = 1, exclude_from_budget = 1 WHERE sync_id = '88745b01-f452-4c73-84de-8f6bcaee31d6'",
  "UPDATE read_tx_projection SET exclude_from_stats = 1 WHERE sync_id = 'b8ed65b5-5dba-4757-b50a-6fe322f8dfc8'",
  "UPDATE read_tx_projection SET exclude_from_stats = 1 WHERE sync_id = '6a062978-33e2-4ac8-b1b8-18815d2c77fa'"
].join(';\n');

const tempFile = path.join(require('os').tmpdir(), 'fix_excl_db.sql');
fs.writeFileSync(tempFile, sql, 'utf8');
const result = execSync('npx wrangler d1 execute beecount-cloud --remote --file "' + tempFile + '"', {
  encoding: 'utf8', cwd: 'E:\\Code\\beecount-cloud-workers', shell: 'powershell.exe', timeout: 60000
});
console.log(result);