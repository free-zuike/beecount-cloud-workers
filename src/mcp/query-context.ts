/**
 * MCP 共享可见性、日历边界与防篡改续传令牌（对齐原版 src/mcp/query_context.py）。
 *
 * - visible_ledgers：自有 + 共享成员账本，排除软删
 * - revision：账本+user-global 的最大 change_id（乐观修订基准）
 * - zone / date_boundary：可选的查询时区，DST 消歧
 * - encode_cursor / decode_cursor：HMAC 签名续传令牌
 * - fingerprint：幂等请求指纹（SHA-256）
 */
import { createHmac, createHash, randomBytes } from 'node:crypto';

export interface CursorPayload {
  ledgerIds?: string[];
  userGlobal?: boolean;
  minChangeId?: number;
  filters?: Record<string, unknown>;
  filter?: string;
  after?: number;
  offset?: number;
  revision?: number;
  filters_fp?: string;
  [k: string]: unknown;
}

function nowUtcIso(): string {
  return new Date().toISOString();
}

/** 可见账本（自有 + 共享成员，排除软删）。返回内部 id 列表，按 created_at,id 排序。 */
export async function visibleLedgers(
  db: D1Database,
  userId: string,
  isLedgerDeleted: (db: D1Database, ledgerId: string) => Promise<boolean>,
): Promise<Array<{ id: string; user_id: string; external_id: string; created_at: string }>> {
  const own = await db.prepare('SELECT id, user_id, external_id, created_at FROM ledgers WHERE user_id = ?')
    .bind(userId).all<{ id: string; user_id: string; external_id: string; created_at: string }>();
  const shared = await db.prepare(
    `SELECT l.id, l.user_id, l.external_id, l.created_at FROM ledgers l
     JOIN ledger_members lm ON l.id = lm.ledger_id
     WHERE lm.user_id = ? AND l.user_id != ?`
  ).bind(userId, userId).all<{ id: string; user_id: string; external_id: string; created_at: string }>();

  const byId = new Map<string, { id: string; user_id: string; external_id: string; created_at: string }>();
  for (const row of [...own.results, ...shared.results]) byId.set(row.id, row);

  const out: Array<{ id: string; user_id: string; external_id: string; created_at: string }> = [];
  for (const row of byId.values()) {
    if (await isLedgerDeleted(db, row.id)) continue;
    out.push(row);
  }
  out.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1));
  return out;
}

/** 乐观修订基准：给定账本 + 当前用户的 user-global 变更最大 change_id。 */
export async function revision(
  db: D1Database,
  ledgerIds: string[],
  userId: string,
): Promise<number> {
  let max = 0;
  if (ledgerIds.length > 0) {
    const placeholders = ledgerIds.map(() => '?').join(',');
    const row = await db.prepare(
      `SELECT MAX(change_id) AS m FROM sync_changes WHERE ledger_id IN (${placeholders})`
    ).bind(...ledgerIds).first<{ m: number | null }>();
    max = Math.max(max, row?.m ?? 0);
  }
  const userRow = await db.prepare(
    `SELECT MAX(change_id) AS m FROM sync_changes WHERE user_id = ? AND scope = 'user'`
  ).bind(userId).first<{ m: number | null }>();
  return Math.max(max, userRow?.m ?? 0);
}

/**
 * 解析日期边界为 UTC。行为对齐上游 date_boundary：
 * - 裸日期（YYYY-MM-DD）且 end=true → 加一天（含当天）
 * - 无时区 → 按查询时区解析，DST 消歧（fold 0/1 均尝试，唯一解才接受）
 * - 带时区 → 转 UTC
 */
export function parseDateBoundary(
  value: string,
  opts: { end?: boolean; timeZone?: string; isAmbiguousCheck?: (localIso: string) => boolean } = {},
): Date {
  const end = opts.end ?? false;
  let raw = value.trim();
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const hasOffset = /(Z|[+-]\d{2}:?\d{2})$/.test(raw);
  let parsed: Date;
  if (hasOffset) {
    parsed = new Date(raw.replace(' ', 'T').replace('Z', '+00:00'));
  } else {
    // 无时区的墙上时间按 UTC 构造（避免 V8 按本机时区解析造成锚点漂移），
    // 之后由查询时区折算；DST 消歧在调用侧（occurrence）二次求候选。
    const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (!m) throw new Error('Invalid date boundary');
    const hasTime = m[4] !== undefined;
    parsed = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], hasTime ? +m[4] : 0, hasTime ? +m[5] : 0, hasTime ? +(m[6] ?? 0) : 0));
  }
  if (isNaN(parsed.getTime())) throw new Error('Invalid date boundary');
  if (isDateOnly && end) {
    parsed = new Date(parsed.getTime() + 24 * 3600 * 1000);
  }
  if (parsed.toISOString().endsWith('Z') && /Z$/.test(raw)) return parsed;
  // 无显式时区：按查询时区（默认 UTC）解析墙钟时间，并做 DST 消歧
  // （对齐上游 date_boundary：唯一解才接受，否则要求显式 UTC 偏移）
  const tz = opts.timeZone || 'UTC';
  if (!/Z|[+-]\d{2}:?\d{2}$/.test(raw)) {
    return wallTimeToUtc(parsed, tz);
  }
  return parsed;
}

/** IANA 时区合法性：非法时抛上游同款错误（上游 ZoneInfoNotFoundError → ValueError） */
export function ianaZoneOrThrow(timeZone: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone;
  } catch {
    throw new Error(`Invalid IANA time zone: ${JSON.stringify(timeZone)}`);
  }
}

/** 把「某时区墙钟时刻」格式化回该时区的 Y/M/D/H/M/S（用于回代校验） */
function zonedParts(utc: Date, timeZone: string): number[] {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(utc);
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value ?? '0');
  return [get('year'), get('month'), get('day'), get('hour'), get('minute'), get('second')];
}

/**
 * 墙钟时间 → UTC（对齐上游 date_boundary / parse_transaction_datetime 的 DST 消歧）：
 * 对 fold 0/1 两个候选分别回代，只有唯一解才接受；0 个 = 不存在（跳时），2 个 = 歧义（回拨）。
 */
export function wallTimeCandidates(wall: Date, timeZone: string): Date[] {
  ianaZoneOrThrow(timeZone);
  const wallMs = wall.getTime(); // 以 UTC 分量承载的墙钟字面值
  const offsets = new Set<number>();
  // 取前后各 24h 的偏移，覆盖 DST 切换两侧（再补上按字面值求得的偏移）
  for (const delta of [-24 * 3600_000, 0, 24 * 3600_000]) {
    offsets.add(timeZoneOffsetMinutes(timeZone, new Date(wallMs + delta)));
  }
  const candidates = new Set<number>();
  for (const offsetMinutes of offsets) {
    const candidate = wallMs - offsetMinutes * 60_000;
    const [y, mo, d, h, mi, s] = zonedParts(new Date(candidate), timeZone);
    const roundTrip = Date.UTC(y, mo - 1, d, h, mi, s);
    if (roundTrip === wallMs) candidates.add(candidate);
  }
  return [...candidates].sort((a, b) => a - b).map(ms => new Date(ms));
}

export function wallTimeToUtc(
  wall: Date,
  timeZone: string,
  opts: { errorMessage?: string } = {},
): Date {
  const candidates = wallTimeCandidates(wall, timeZone);
  if (candidates.length !== 1) {
    throw new Error(opts.errorMessage ?? 'Ambiguous or nonexistent query boundary; supply an explicit UTC offset');
  }
  return candidates[0];
}

/** 时区偏移（分钟），失败回退 0（UTC）。用于 date_boundary 的 DST 近似。 */
export function timeZoneOffsetMinutes(tz: string, at: Date): number {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'longOffset',
      hour12: false,
    });
    const parts = fmt.formatToParts(at);
    const name = parts.find(p => p.type === 'timeZoneName')?.value ?? '';
    const m = name.match(/([+-])(\d{2}):(\d{2})/);
    if (!m) return 0;
    const sign = m[1] === '-' ? -1 : 1;
    return sign * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
  } catch {
    return 0;
  }
}

/** HMAC-SHA256 签名续传令牌（sig || payload，base64url 去 padding）。 */
export function encodeCursor(payload: CursorPayload, jwtSecret: string): string {
  // 对齐上游 encode_cursor：json.dumps(sort_keys=True, separators=(",",":")) → 规范 JSON
  const data = Buffer.from(stableStringify(payload), 'utf8');
  const sig = createHmac('sha256', jwtSecret).update(data).digest();
  return Buffer.concat([sig, data]).toString('base64url').replace(/=+$/, '');
}

/** 校验并解码续传令牌；签名不符/结构损坏 → throw ValueError("Invalid continuation cursor")。 */
export function decodeCursor(value: string, jwtSecret: string): CursorPayload {
  try {
    // base64url → 标准 base64：Node 的 Buffer.from(...,'base64') 不识别 -/_，必须替换
    const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
    const pad = (4 - (b64.length % 4)) % 4;
    const raw = Buffer.from(b64 + '='.repeat(pad), 'base64');
    if (raw.length < 32) throw new Error('too short');
    const sig = raw.subarray(0, 32);
    const data = raw.subarray(32);
    const expected = createHmac('sha256', jwtSecret).update(data).digest();
    if (sig.length !== expected.length || !sig.equals(expected)) {
      throw new Error('bad signature');
    }
    const payload = JSON.parse(data.toString('utf8')) as CursorPayload;
    if (!payload || typeof payload !== 'object') throw new Error('bad payload');
    return payload;
  } catch {
    throw new Error('Invalid continuation cursor');
  }
}

/** 幂等请求指纹：sort_keys + 紧凑 JSON + sha256 hex（对齐上游 fingerprint）。 */
export function fingerprint(value: unknown): string {
  const json = JSON.stringify(value, (k, v) => v === undefined ? null : v);
  // 稳定键序
  const sorted = stableStringify(value);
  return createHash('sha256').update(sorted, 'utf8').digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    // 对齐上游 default=str：Date 等非 JSON 标量序列化为其字符串形式
    if (value instanceof Date) return JSON.stringify(value.toISOString());
    return JSON.stringify(value ?? null);
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${parts.join(',')}}`;
}

/** 生成 UUID（对齐 Python uuid4） */
export function uuid4(): string {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export { nowUtcIso };
