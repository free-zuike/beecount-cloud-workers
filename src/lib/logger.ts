/**
 * 日志记录器 — 与原版 Python 的 logging.getLogger(__name__) 对齐
 * 同时输出到 console 和 audit_logs 表，供 /admin/logs 端点和前端过滤使用
 */

let _db: D1Database | null = null;
let _logBuffer: DurableObjectNamespace | null = null;

export function initLogger(db: D1Database, logBuffer?: DurableObjectNamespace) {
  _db = db;
  _logBuffer = logBuffer ?? null;
}

interface LogEntry {
  level: string;
  logger: string;
  message: string;
  user_id?: string;
  ledger_id?: string;
  device_id?: string;
}

function writeLog(entry: LogEntry): Promise<void> {
  const prefix = `[${entry.level}] [${entry.logger}]`;
  switch (entry.level) {
    case 'ERROR': case 'CRITICAL': console.error(prefix, entry.message); break;
    case 'WARNING': console.warn(prefix, entry.message); break;
    default: console.log(prefix, entry.message);
  }
  // 普通日志进内存 ring buffer（LogBuffer DO），不落 D1 —— 对齐原版
  // "内存 ring buffer,服务重启后清零"。D1 只存审计事件（insertAuditLog）。
  if (_logBuffer) {
    try {
      const doId = _logBuffer.idFromName('log-global');
      const stub = _logBuffer.get(doId);
      return stub.fetch(new URL('/log/add', 'http://do'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level: entry.level, source: entry.logger, message: entry.message }),
      }).then(() => {}).catch(() => {});
    } catch {
      return Promise.resolve();
    }
  }
  return Promise.resolve();
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
    return writeLog({ level: 'ERROR', logger, message, ...(meta ?? {}) });
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