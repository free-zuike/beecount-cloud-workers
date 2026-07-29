const fs = require('fs');
const path = require('path');

const routesDir = 'E:\\Code\\beecount-cloud-workers\\src\\routes';

const PREFIX_MAP = {
  '[SYNC]': 'src.routers.sync',
  '[WRITE]': 'src.routers.write',
  '[AUTH]': 'src.routers.auth',
  '[2FA]': 'src.routers.auth',
  '[Backup ': 'src.routers.admin',
  '[BACKUP]': 'src.routers.admin',
  '[Restore]': 'src.routers.admin',
  '[backup-executor]': 'src.routers.admin',
  '[PROFILE]': 'src.routers.profile',
  '[WS]': 'src.routers.ws',
  '[ATTACH]': 'src.routers.attachments',
  '[READ]': 'src.routers.read',
  '[DEVICE]': 'src.routers.profile',
  '[AUDIT]': 'src.routers.admin',
  '[INTEGRITY]': 'src.routers.admin',
  '[FIXDATA]': 'src.routers.admin',
  '[FixData]': 'src.routers.admin',
  '[CRON]': 'src.routers.admin',
  '[Schedule]': 'src.routers.admin',
  '[Ai]': 'src.routers.ai',
  '[AI]': 'src.routers.ai',
  '[MCP]': 'src.routers.mcp',
  '[IMPORT]': 'src.routers.admin',
  '[EXPORT]': 'src.routers.admin',
  '[CLEAR]': 'src.routers.admin',
  '[RESTORE]': 'src.routers.admin',
  '[rclone-config]': 'src.routers.admin',
  '[AUTH-MW]': 'src.routers.auth',
  '[REFRESH]': 'src.routers.auth',
  '[DEBUG]': 'app',
  '[Backup]': 'src.routers.admin',
  '[backup]': 'src.routers.admin',
};

function getLoggerNameFromMessage(msg) {
  const clean = msg.trimStart().replace(/^[`'"]/, '').replace(/[`'"]$/, '');
  for (const [prefix, logger] of Object.entries(PREFIX_MAP)) {
    if (clean.startsWith(prefix)) return logger;
  }
  return null;
}

const files = fs.readdirSync(routesDir).filter(f => f.endsWith('.ts'));
let totalFixes = 0;

for (const file of files) {
  const filePath = path.join(routesDir, file);
  let content = fs.readFileSync(filePath, 'utf8');
  let changed = false;

  // Find all serverLogger calls with 'app' as the logger name
  const regex = /serverLogger\.(info|warn|error)\('app',\s*([^)]+)\)/g;
  content = content.replace(regex, (match, level, args) => {
    const argsStr = args.trim();
    // Extract the first argument (message) to determine the logger name
    const firstArgEnd = argsStr.indexOf(',');
    const firstArg = firstArgEnd > -1 ? argsStr.substring(0, firstArgEnd).trim() : argsStr;
    const loggerName = getLoggerNameFromMessage(firstArg);
    if (loggerName) {
      changed = true;
      totalFixes++;
      return `serverLogger.${level}('${loggerName}', ${argsStr})`;
    }
    return match;
  });

  if (changed) {
    fs.writeFileSync(filePath, content);
    console.log(`${file}: fixed`);
  }
}

console.log(`Total: ${totalFixes} fixes across ${files.length} files`);