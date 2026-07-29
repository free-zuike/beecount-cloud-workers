const fs = require('fs');
const files = [
  'E:\\Code\\beecount-cloud-workers\\node_modules\\@modelcontextprotocol\\sdk\\dist\\esm\\server\\index.js',
  'E:\\Code\\beecount-cloud-workers\\node_modules\\@modelcontextprotocol\\sdk\\dist\\esm\\types.js',
  'E:\\Code\\beecount-cloud-workers\\node_modules\\@modelcontextprotocol\\sdk\\dist\\esm\\server\\webStandardStreamableHttp.js',
];
for (const file of files) {
  const content = fs.readFileSync(file, 'utf8');
  const matches = content.match(/from\s+['"]([^'"]+)['"]/g);
  const unique = [...new Set((matches || []).map(m => m.replace(/from\s+['"]([^'"]+)['"]/, '$1')))];
  const nonRelative = unique.filter(m => !m.startsWith('.'));
  if (nonRelative.length > 0) {
    console.log(file.split('\\').pop() + ':', nonRelative.join(', '));
  }
}
console.log('Done');