/**
 * 日志记录器 — 与原版 Python 的 logging.getLogger(__name__) 对齐
 * 同时输出到 console 和 audit_logs 表，供 /admin/logs 端点和前端过滤使用
 */

let _db: D1Database | null = null;

export function initLogger(db: D1Database) {
  _db = db;
}

interface LogEntry {
  level: string;
  logger: string;
  message: string;
  user_id?: string;
  ledger_id?: string;
  device_id?: string;
}

function writeLog(entry: LogEntry) {
  const prefix = `[${entry.level}] [${entry.logger}]`;
  switch (entry.level) {
    case 'ERROR': case 'CRITICAL': console.error(prefix, entry.message); break;
    case 'WARNING': console.warn(prefix, entry.message); break;
    default: console.log(prefix, entry.message);
  }
  if (_db) {
    _db.prepare(
      `INSERT INTO audit_logs (user_id, ledger_id, action, level, logger, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      entry.user_id ?? null,
      entry.ledger_id ?? null,
      entry.message.substring(0, 500),
      entry.level,
      entry.logger,
      null,
      new Date().toISOString(),
    ).run().catch(() => {});
  }
}

export const serverLogger = {
  debug: (...args: unknown[]) => writeLog({ level: 'DEBUG', logger: String(args[0] ?? ''), message: restToMessage(args) }),
  info: (...args: unknown[]) => writeLog({ level: 'INFO', logger: String(args[0] ?? ''), message: restToMessage(args) }),
  warn: (...args: unknown[]) => writeLog({ level: 'WARNING', logger: String(args[0] ?? ''), message: restToMessage(args) }),
  error: (...args: unknown[]) => {
    const logger = String(args[0] ?? '');
    const body = args.slice(1);
    const last = body[body.length - 1];
    const meta = last && typeof last === 'object' && !(last instanceof Error) ? last as { user_id?: string; ledger_id?: string } : undefined;
    const message = last && (last instanceof Error || typeof last === 'object') && meta === undefined ? body.map(stringifyArg).join(' ') : args.slice(1, meta ? -1 : undefined).map(stringifyArg).join(' ');
    writeLog({ level: 'ERROR', logger, message, ...(meta ?? {}) });
  },
};

function stringifyArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.message;
  try { return JSON.stringify(arg); } catch { return String(arg); }
}

/** console.log 风格变参 → 拼接字符串（保持与调用处行为一致）。 */
function restToMessage(args: unknown[], startIdx = 1): string {
  return args.slice(startIdx).map(stringifyArg).join(' ');
}