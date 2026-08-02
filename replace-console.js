const fs = require('fs');
const path = require('path');

const routesDir = 'E:\\Code\\beecount-cloud-workers\\src\\routes';
const loggerImport = `import { serverLogger } from '../lib/logger';`;

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

function getLoggerName(msg) {
  // Strip quotes and backticks from template literals
  const clean = msg.trimStart().replace(/^[`'"]/, '').replace(/[`'"]$/, '');
  for (const [prefix, logger] of Object.entries(PREFIX_MAP)) {
    if (clean.startsWith(prefix)) return logger;
  }
  return 'app';
}

function getLevel(consoleFn) {
  if (consoleFn === 'console.error') return 'error';
  if (consoleFn === 'console.warn') return 'warn';
  return 'info';
}

function replaceConsoleCalls(content, filePath) {
  const regex = /(console\.(log|error|warn))\(([\s\S]*?)\)/g;
  let match;
  let replacements = 0;
  let result = content;

  while ((match = regex.exec(content)) !== null) {
    const fullMatch = match[0];
    const consoleFn = match[1];
    const args = match[3].trim();
    const level = getLevel(consoleFn);
    const loggerName = getLoggerName(args);

    // Extract the message from the first argument
    const firstArgEnd = args.indexOf(',');
    const firstArg = firstArgEnd > -1 ? args.substring(0, firstArgEnd).trim() : args;
    const restArgs = firstArgEnd > -1 ? args.substring(firstArgEnd + 1).trim() : '';

    // Build the replacement
    let replacement;
    if (restArgs) {
      replacement = `serverLogger.${level}('${loggerName}', ${firstArg}, ${restArgs})`;
    } else {
      replacement = `serverLogger.${level}('${loggerName}', ${firstArg})`;
    }

    result = result.replace(fullMatch, replacement);
    replacements++;
  }

  return { result, replacements };
}

const files = fs.readdirSync(routesDir).filter(f => f.endsWith('.ts'));
let totalReplacements = 0;

for (const file of files) {
  const filePath = path.join(routesDir, file);
  let content = fs.readFileSync(filePath, 'utf8');

  // Add import if not present
  if (!content.includes(loggerImport) && content.includes('console.')) {
    const firstImport = content.indexOf('import ');
    const firstImportEnd = content.indexOf('\n', firstImport);
    content = content.substring(0, firstImportEnd + 1) + loggerImport + '\n' + content.substring(firstImportEnd + 1);
  }

  const { result, replacements } = replaceConsoleCalls(content, filePath);
  if (replacements > 0) {
    fs.writeFileSync(filePath, result);
    console.log(`${file}: ${replacements} replacements`);
    totalReplacements += replacements;
  }
}

console.log(`Total: ${totalReplacements} replacements across ${files.length} files`);