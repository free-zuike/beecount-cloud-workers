const fs = require('fs');
const zlib = require('zlib');

const buf = fs.readFileSync('backup_latest.tar.gz');

zlib.gunzip(buf, (err, data) => {
  let off = 0;
  while (off < data.length - 512) {
    const name = data.slice(off, off + 100).toString().replace(/\0/g, '');
    if (!name) break;
    const sizeOct = data.slice(off + 124, off + 136).toString().replace(/\0/g, '').trim();
    const sz = parseInt(sizeOct, 8) || 0;
    
    if (name === 'db.json') {
      const json = data.slice(off + 512, off + 512 + sz).toString();
      const db = JSON.parse(json);
      const tables = db.tables || db;
      
      // 检查分类名称
      if (tables.read_category_projection && Array.isArray(tables.read_category_projection)) {
        const cats = tables.read_category_projection;
        const app2web = cats.filter(c => c.name === 'app2web' || c.name === 'web2app');
        console.log('app2web/web2app categories in backup: ' + app2web.length);
        
        // 所有分类的 user_id 分布
        const byUser = {};
        for (const c of cats) {
          const uid = c.user_id || 'null';
          if (!byUser[uid]) byUser[uid] = 0;
          byUser[uid]++;
        }
        console.log('Category distribution by user_id:');
        for (const [uid, count] of Object.entries(byUser)) {
          console.log('  ' + uid + ': ' + count);
        }
        
        // 检查 qq.com 的所有分类名称
        const qqCats = cats.filter(c => c.user_id === '42a48053-d6f2-461f-8f40-6f160e2fe737');
        console.log('\nqq.com categories in backup: ' + qqCats.length);
        for (const c of qqCats.slice(0, 10)) {
          console.log('  ' + c.name + ' (kind=' + c.kind + ')');
        }
      }
      
      // 检查标签名称
      if (tables.read_tag_projection && Array.isArray(tables.read_tag_projection)) {
        const tags = tables.read_tag_projection;
        const byUser = {};
        for (const t of tags) {
          const uid = t.user_id || 'null';
          if (!byUser[uid]) byUser[uid] = 0;
          byUser[uid]++;
        }
        console.log('\nTag distribution by user_id:');
        for (const [uid, count] of Object.entries(byUser)) {
          console.log('  ' + uid + ': ' + count);
        }
      }
      
      break;
    }
    
    off += 512 + Math.ceil(sz / 512) * 512;
  }
});
