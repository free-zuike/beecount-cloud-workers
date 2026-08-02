const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Test the buildExistingSets query
const sql = [
  "SELECT id, user_id FROM ledgers WHERE external_id = 'ledger_1785423175411_7d9fb18b524f'",
  "SELECT name FROM read_account_projection WHERE user_id = '42a48053-d6f2-461f-8f40-6f160e2fe737'",
  "SELECT name FROM read_category_projection WHERE user_id = '42a48053-d6f2-461f-8f40-6f160e2fe737'",
  "SELECT name FROM read_tag_projection WHERE user_id = '42a48053-d6f2-461f-8f40-6f160e2fe737'",
].join(';\n');

const sqlFile = path.join(require('os').tmpdir(), 'test_bes.sql');
fs.writeFileSync(sqlFile, sql, 'utf8');
const result = execSync('npx wrangler d1 execute beecount-cloud --remote --file "' + sqlFile + '"', {
  encoding: 'utf8', cwd: 'E:\\Code\\beecount-cloud-workers', timeout: 30000
});
console.log(result);