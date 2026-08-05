const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'src', 'services', 'backup-executor.ts');
let content = fs.readFileSync(filePath, 'utf8');

const oldMarker = '// 3. 并行上传到所有远端';
const newBlock = `// 3. 解析 alias 远端
  let effectiveConfigs = remoteConfigs;
  const hasAlias = remoteConfigs.some(rc => rc.config.backend_type === 'alias');
  if (hasAlias) {
    effectiveConfigs = await Promise.all(remoteConfigs.map(async (rc) => {
      if (rc.config.backend_type !== 'alias') return rc;
      const resolved = await resolveAliasRemote(db, rc.config);
      if (resolved.error) {
        logWrap(\`[Backup] Alias resolution failed: \${resolved.error}\`);
        return { ...rc, config: { ...rc.config, backend_type: 'local' } };
      }
      return { ...rc, config: resolved };
    }));
  }

  // 4. 并行上传到所有远端`;

if (content.includes(oldMarker)) {
  content = content.replace(oldMarker, newBlock);
  fs.writeFileSync(filePath, content, 'utf8');
  console.log('Done - alias resolution added');
} else {
  console.log('Marker not found');
}