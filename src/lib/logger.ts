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
  debug: (logger: string, message: string, meta?: { user_id?: string; ledger_id?: string }) =>
    writeLog({ level: 'DEBUG', logger, message, ...meta }),
  info: (logger: string, message: string, meta?: { user_id?: string; ledger_id?: string }) =>
    writeLog({ level: 'INFO', logger, message, ...meta }),
  warn: (logger: string, message: string, meta?: { user_id?: string; ledger_id?: string }) =>
    writeLog({ level: 'WARNING', logger, message, ...meta }),
  error: (logger: string, message: string, meta?: { user_id?: string; ledger_id?: string }) =>
    writeLog({ level: 'ERROR', logger, message, ...meta }),
};