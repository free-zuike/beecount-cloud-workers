/**
 * MCP 交易服务（对齐原版 src/mcp/transaction_service.py）。
 *
 * - prepare_transaction：统一规范化单笔交易（分类/标签/币种/附件/转账校验）
 * - create_many：批量创建 1..200 条，50/批拆步骤，持久化操作计划，支持幂等键
 * - update_one：单笔更新，保留历史结算比率，支持 expected_revision 乐观锁
 * - transaction_row / dictionary_entry：跨账本定位与字典消歧
 */
import { uuid4, fingerprint, wallTimeCandidates } from './query-context';
import { getRateSnapshot } from './exchange-rate';
import { enumValue } from './validation';
import { saveOperation, executeOperation, findOperation, type OperationOut, type OperationStep } from './operations';
import type { McpContext, LedgerInfo } from './types';
import { McpToolError } from './types';

/** 正数金额校验（对齐上游 positive_amount：拒绝 boolean/NaN/Inf/<=0） */
export function positiveAmount(value: unknown): number {
  // 与 validation.positiveAmount 同口径（上游 pydantic 文案）
  if (typeof value === 'boolean') {
    throw new McpToolError('amount must be a number, not a boolean');
  }
  let raw: unknown = value;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t || !Number.isFinite(Number(t))) throw new McpToolError('Input should be a valid number');
    raw = Number(t);
  }
  if (raw === null || raw === undefined || typeof raw !== 'number') {
    throw new McpToolError('Input should be a valid number');
  }
  if (!Number.isFinite(raw)) throw new McpToolError('Input should be a finite number');
  if (raw <= 0) throw new McpToolError('Input should be greater than 0');
  return raw;
}

/** 按名/ID 解析字典项（账户/分类），歧义或不存在 → 报错（对齐上游 dictionary_entry） */
export async function dictionaryEntry(
  db: D1Database,
  table: 'user_account_projection' | 'user_category_projection',
  ownerUserId: string,
  opts: { name?: string | null; identifier?: string | null; kind?: string | null },
): Promise<Record<string, unknown> | null> {
  const { name, identifier, kind } = opts;
  if (!name && !identifier) return null;
  const where: string[] = ['user_id = ?'];
  const params: unknown[] = [ownerUserId];
  if (identifier) {
    where.push('sync_id = ?');
    params.push(identifier);
  } else {
    where.push('name = ?');
    params.push(name);
  }
  if (kind && table === 'user_category_projection') {
    where.push('kind = ?');
    params.push(kind);
  }
  // 对齐上游 dictionary_entry：文案用模型类名、歧义时带 repr 引号、LIMIT 2
  const label = table === 'user_account_projection' ? 'UserAccountProjection' : 'UserCategoryProjection';
  const rows = await db.prepare(`SELECT * FROM ${table} WHERE ${where.join(' AND ')} LIMIT 2`).bind(...params).all<Record<string, unknown>>();
  if (rows.results.length === 0) {
    throw new McpToolError(`${label} not found: ${identifier || name}`);
  }
  if (rows.results.length !== 1) {
    throw new McpToolError(`Ambiguous ${label}: ${JSON.stringify(name || identifier)}; use its id`);
  }
  if (name && rows.results[0].name !== name) {
    throw new McpToolError('Name and identifier refer to different entities');
  }
  return rows.results[0];
}

/** 跨账本定位交易（对齐上游 transaction_row），返回 [投影行, 账本] */
export async function transactionRow(
  db: D1Database,
  userId: string,
  syncId: string,
  ledgerId?: string | null,
): Promise<[{ [k: string]: unknown }, LedgerInfo]> {
  const ledgers = await listLiveLedgers(db, userId, ledgerId);
  if (ledgers.length === 0) throw new McpToolError('Transaction not found or identifier is ambiguous; specify ledger_id');
  const placeholders = ledgers.map(() => '?').join(',');
  const rows = await db.prepare(
    `SELECT * FROM read_tx_projection WHERE ledger_id IN (${placeholders}) AND sync_id = ? LIMIT 3`
  ).bind(...ledgers.map(l => l.id), syncId).all<Record<string, unknown>>();
  if (rows.results.length !== 1) {
    throw new McpToolError('Transaction not found or identifier is ambiguous; specify ledger_id');
  }
  const ledger = ledgers.find(l => l.id === rows.results[0].ledger_id)!;
  return [rows.results[0], ledger];
}

/** 可见账本（自有 + 共享成员，排除软删），可过滤 external_id */
export async function listLiveLedgers(
  db: D1Database,
  userId: string,
  externalId?: string | null,
): Promise<LedgerInfo[]> {
  const own = await db.prepare(
    'SELECT id, user_id, external_id, name, currency, month_start_day, created_at FROM ledgers WHERE user_id = ?'
  ).bind(userId).all<LedgerInfo>();
  const shared = await db.prepare(
    `SELECT l.id, l.user_id, l.external_id, l.name, l.currency, l.month_start_day, l.created_at FROM ledgers l
     JOIN ledger_members lm ON l.id = lm.ledger_id WHERE lm.user_id = ? AND l.user_id != ?`
  ).bind(userId, userId).all<LedgerInfo>();
  const byId = new Map<string, LedgerInfo>();
  for (const r of [...own.results, ...shared.results]) byId.set(r.id, r);
  const out: LedgerInfo[] = [];
  for (const row of byId.values()) {
    if (await isLedgerDeleted(db, row.id)) continue;
    if (externalId && row.external_id !== externalId) continue;
    out.push(row);
  }
  // 对齐上游 visible_ledgers：按 created_at 升序（"第一个账本"= 最早创建的）
  out.sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')) || a.id.localeCompare(b.id));
  return out;
}

async function isLedgerDeleted(db: D1Database, ledgerId: string): Promise<boolean> {
  const row = await db.prepare(
    `SELECT action FROM sync_changes WHERE ledger_id = ? AND entity_type = 'ledger_snapshot' AND action = 'delete' ORDER BY change_id DESC LIMIT 1`
  ).bind(ledgerId).first<{ action: string }>();
  return row?.action === 'delete';
}

/** ISO 日期/日期时间 → 以 UTC 分量承载的墙钟字面值（带偏移时返回 null） */
function wallClockLiteral(raw: string): Date | null {
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return new Date(Date.UTC(+y, +mo - 1, +d, h ? +h : 0, h ? +mi : 0, h ? +(s ?? 0) : 0));
}

/**
 * 解析交易时间（对齐上游 parse_transaction_datetime）：
 * - 显式偏移优先 → 直接转 UTC
 * - 裸时间按 Cloud 配置时区（CLOUD_TIMEZONE/TZ）解释，其次才是调用方 time_zone
 * - 两者都没有 → 报错并给出可执行指引（不静默按 UTC 猜测）
 * - DST 回拨（歧义）/ 跳时（不存在）→ 要求给出真实偏移
 */
export function parseTxDatetime(
  value: string,
  timeZone?: string | null,
  configuredTimeZone?: string | null,
): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new McpToolError('happened_at must be a non-empty ISO date or datetime');
  }
  // 对齐上游 datetime.fromisoformat 的宽容度：去掉小数秒；+08 → +08:00
  const raw = value.trim().replace(' ', 'T')
    .replace(/\.\d+/, '')
    .replace(/([+-]\d{2})$/, '$1:00');
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/.test(raw);
  if (hasOffset) {
    const d = new Date(raw.replace('Z', '+00:00'));
    if (isNaN(d.getTime())) throw new McpToolError('happened_at must be an ISO date or datetime');
    return d.toISOString();
  }
  const wall = wallClockLiteral(raw);
  if (!wall) throw new McpToolError('happened_at must be an ISO date or datetime');

  const zone = (configuredTimeZone ?? '').trim() || (timeZone ?? '').trim();
  if (!zone) {
    throw new McpToolError(
      'Timezone required for happened_at without an offset. Use an ISO timestamp with its actual offset (e.g. +08:00), '
      + 'configure Cloud SCHEDULER_TIMEZONE/TZ, or pass time_zone (e.g. Asia/Shanghai) after confirming the source timezone. '
      + 'Do not append Z to local time.',
    );
  }
  const candidates = wallTimeCandidates(wall, zone);
  if (candidates.length !== 1) {
    const reason = candidates.length ? 'ambiguous' : 'nonexistent';
    throw new McpToolError(
      `happened_at is ${reason} in ${zone}; provide its actual ISO UTC offset`,
    );
  }
  return candidates[0].toISOString();
}

/** 账本币种 + 账户币种 + currency 参数 → 折算字段（对齐上游 _build_currency_fields） */
export async function buildCurrencyFields(
  db: D1Database,
  userId: string,
  ledgerBase: string,
  accountCurrency: string | null | undefined,
  currencyArg: string | null | undefined,
  amount: number,
  env?: Record<string, unknown> | null,
): Promise<{ currency_code?: string; native_amount?: number }> {
  const base = (ledgerBase || 'CNY').trim().toUpperCase();
  const cc = ((currencyArg || accountCurrency || base) || 'CNY').trim().toUpperCase();
  if (cc === base) return {};
  const ov = await db.prepare(
    'SELECT rate FROM user_exchange_rate_projection WHERE user_id = ? AND base_currency = ? AND quote_currency = ?'
  ).bind(userId, base, cc).first<{ rate: string }>();
  let native: number | null = null;
  if (ov) {
    const r = parseFloat(ov.rate);
    if (r > 0) native = amount * r;
  }
  if (native === null) {
    const cache = await db.prepare('SELECT payload_json FROM exchange_rate_cache WHERE base_currency = ?').bind(base).first<{ payload_json: string }>();
    if (cache) {
      try {
        const payload = JSON.parse(cache.payload_json) as Record<string, string>;
        const raw = payload[cc] ?? payload[cc.toLowerCase()];
        const x = parseFloat(raw ?? '');
        native = x > 0 ? amount / x : amount;
      } catch { native = amount; }
    } else {
      // 对齐上游：无缓存时走取价链（配置上游 → jsDelivr 镜像 → frankfurter），
      // 不再静默按 1:1 折算
      const snap = await getRateSnapshot(db, base, env);
      const x = snap?.rates?.[cc] ?? 0;
      native = x > 0 ? amount / x : amount;
    }
  }
  return { currency_code: cc, native_amount: native };
}

/** 批量创建交易（对齐上游 create_many）。返回与上游一致的结构。 */
export async function createMany(
  c: McpContext,
  opts: {
    transactions: Array<Record<string, unknown>>;
    ledger_id?: string | null;
    time_zone?: string | null;
    idempotency_key?: string | null;
    single?: boolean;
  },
): Promise<Record<string, unknown>> {
  const { db, userId } = c;
  const transactions = opts.transactions;
  if (!Array.isArray(transactions) || transactions.length === 0 || transactions.length > 200) {
    throw new McpToolError('transactions must contain 1..200 entries');
  }
  const rawRequest = { transactions, ledger_id: opts.ledger_id ?? null, time_zone: opts.time_zone ?? null, single: opts.single ?? false };
  const key = opts.idempotency_key || uuid4();
  if (typeof key !== 'string' || !key.trim() || key.length > 128) {
    throw new McpToolError('idempotency_key must be a non-empty string of at most 128 characters');
  }
  const kind = opts.single ? 'create_transaction' : 'create_transactions';

  const prior = await findOperation(db, { user_id: userId, key, request: rawRequest, kind, ledger_id: null });
  const { ledger, status } = await resolveWriteLedger(c, opts.ledger_id);
  if (status) return status;
  if (!ledger) return { status: 'no_ledger', message: 'You have no ledger yet.' };
  if (prior) {
    if (prior.ledger_id !== ledger.id) throw new McpToolError('Operation ledger no longer matches');
    const outcome = await executeOperation(db, prior, userId, selfCallAdapter(c));
    return finalizeCreateMany(c, outcome, ledger, opts);
  }

  // 校验名称存在
  await validateNamesExist(c, ledger, transactions);

  const normalized: Array<Record<string, unknown>> = [];
  for (let index = 0; index < transactions.length; index++) {
    try {
      // 对齐上游 BatchTransactionItem：extra="forbid" + amount>0 + tx_type 枚举 + native_amount>0
      validateBatchItem(transactions[index], index);
      normalized.push(await prepareTransaction(c, ledger, transactions[index], { time_zone: opts.time_zone }));
    } catch (exc: unknown) {
      throw new McpToolError(`transactions[${index}]: ${exc instanceof Error ? exc.message : String(exc)}`);
    }
  }

  // 默认标签（owner 自己）
  if (ledger.user_id === userId) {
    await ensureMcpTag(c, ledger.external_id);
    for (const body of normalized) {
      const names = (body.tags as string[] | undefined) || [];
      body.tag_ids = await lookupTagSyncIds(c, ledger, names);
    }
  }

  const root = `/api/v1/write/ledgers/${ledger.external_id}/transactions`;
  let steps: OperationStep[];
  if (opts.single) {
    steps = [{ method: 'POST', path: root, body: normalized[0] }];
  } else {
    const items = normalized.map(b => {
      const { base_change_id, ...rest } = b;
      return rest;
    });
    steps = [];
    for (let start = 0; start < items.length; start += 50) {
      steps.push({
        method: 'POST',
        path: root + '/batch',
        body: { base_change_id: 0, transactions: items.slice(start, start + 50), auto_ai_tag: false },
      });
    }
  }

  const row = await saveOperation(db, {
    user_id: userId, ledger_id: ledger.id, key, kind, request: rawRequest, steps,
  });
  const outcome = await executeOperation(db, row, userId, selfCallAdapter(c));
  return finalizeCreateMany(c, outcome, ledger, opts);
}

/**
 * 批量条目校验（对齐上游 schemas.BatchTransactionItem：extra="forbid"）。
 * 原版靠 pydantic 在入口拦住非法条目，TS 侧此前零校验。
 */
const BATCH_ITEM_KEYS = [
  'amount', 'tx_type', 'happened_at', 'note', 'category', 'account', 'tags', 'currency',
  'category_id', 'account_id', 'from_account_id', 'to_account_id', 'from_account', 'to_account',
  'native_amount', 'exclude_from_stats', 'exclude_from_budget', 'attachments',
] as const;

function validateBatchItem(item: Record<string, unknown>, index: number): void {
  if (!item || typeof item !== 'object') {
    throw new McpToolError(`transactions[${index}] must be an object`);
  }
  for (const key of Object.keys(item)) {
    if (!BATCH_ITEM_KEYS.includes(key as typeof BATCH_ITEM_KEYS[number])) {
      throw new McpToolError(`transactions[${index}] received an unknown field: ${key}`);
    }
  }
  const bad = (key: string, expected: string) => `transactions[${index}].${key} must be ${expected}`;
  if (item.amount !== undefined && item.amount !== null) positiveAmount(item.amount);
  if (item.native_amount !== undefined && item.native_amount !== null) positiveAmount(item.native_amount);
  if (item.tx_type !== undefined && item.tx_type !== null) {
    enumValue(item.tx_type, ['expense', 'income', 'transfer'] as const, 'tx_type');
  }
  // 上游靠 pydantic 做强类型校验（extra=forbid + 各字段类型），这里补齐标量类型
  for (const key of ['note', 'category', 'account', 'from_account', 'to_account',
    'category_id', 'account_id', 'from_account_id', 'to_account_id', 'currency', 'happened_at'] as const) {
    const v = item[key];
    if (v !== undefined && v !== null && typeof v !== 'string') throw new McpToolError(bad(key, 'a string'));
  }
  for (const key of ['exclude_from_stats', 'exclude_from_budget'] as const) {
    const v = item[key];
    if (v !== undefined && v !== null && typeof v !== 'boolean') throw new McpToolError(bad(key, 'a boolean'));
  }
  if (item.tags !== undefined && item.tags !== null) {
    if (!Array.isArray(item.tags) || item.tags.some(t => typeof t !== 'string')) {
      throw new McpToolError(bad('tags', 'an array of strings'));
    }
  }
  if (item.attachments !== undefined && item.attachments !== null) {
    if (!Array.isArray(item.attachments) || item.attachments.some(t => typeof t !== 'string')) {
      throw new McpToolError(bad('attachments', 'an array of file id strings'));
    }
  }
}

async function finalizeCreateMany(
  c: McpContext,
  outcome: OperationOut,
  ledger: LedgerInfo,
  opts: { single?: boolean; transactions: Array<Record<string, unknown>> },
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { ...outcome, ledger: ledger.name, ledger_id: ledger.external_id, created_count: outcome.sync_ids.length };
  if (out.status === 'completed') out.status = 'created';
  if (opts.single && outcome.sync_ids.length > 0) {
    const sid = outcome.sync_ids[0];
    out.sync_id = sid;
    // 对齐上游 create_many(single=true)：从投影读回 amount/tx_type/happened_at/attachments
    const row = await c.db
      .prepare('SELECT amount, tx_type, happened_at, attachments_json FROM read_tx_projection WHERE ledger_id = ? AND sync_id = ?')
      .bind(ledger.id, sid)
      .first<{ amount: number | null; tx_type: string | null; happened_at: string | null; attachments_json: string | null }>();
    if (row) {
      out.amount = Number(row.amount ?? 0);
      out.tx_type = row.tx_type ?? null;
      out.happened_at = row.happened_at ? `${new Date(row.happened_at).toISOString().slice(0, 19)}+00:00` : null;
      if (opts.transactions[0]?.attachments !== null && opts.transactions[0]?.attachments !== undefined) {
        try { out.attachments = JSON.parse(row.attachments_json || '[]'); } catch { out.attachments = []; }
      }
    }
  }
  return out;
}

/** 更新单笔交易（对齐上游 update_one）：保留历史结算比率 + expected_revision。 */
export async function updateOne(
  c: McpContext,
  opts: { sync_id: string; ledger_id?: string | null; [k: string]: unknown },
): Promise<Record<string, unknown>> {
  const { db, userId } = c;
  const { sync_id, ledger_id } = opts;
  const [existing, ledger] = await transactionRow(db, userId, sync_id, ledger_id);
  const raw = { ...opts };
  const body = await prepareTransaction(c, ledger, raw, { time_zone: (raw.time_zone as string | undefined) ?? null, existing });
  const path = `/api/v1/write/ledgers/${ledger.external_id}/transactions/${sync_id}`;
  const result = await selfCallAdapter(c)('PATCH', path, userId, body, {});
  const updated = Object.keys(body).filter(k => k !== 'base_change_id' && k !== 'expected_revision');
  // 对齐上游 update_one：回显实际更新的字段、attachments（若本次设置）与 self-call 原始响应
  const status: Record<string, unknown> = {
    sync_id,
    ledger_id: ledger.external_id,
    updated,
    ...(Object.prototype.hasOwnProperty.call(body, 'attachments') ? { attachments: body.attachments } : {}),
    // 对齐上游 update_one：_meta 直接是 self-call 响应（无响应时为 null，不是 {}）
    _meta: result ?? null,
  };
  return status;
}

/** 规范化单笔交易 body（对齐上游 prepare_transaction）。 */
export async function prepareTransaction(
  c: McpContext,
  ledger: LedgerInfo,
  raw: Record<string, unknown>,
  opts: { time_zone?: string | null; existing?: Record<string, unknown> | null } = {},
): Promise<Record<string, unknown>> {
  const { db, userId } = c;
  const partial = opts.existing !== undefined && opts.existing !== null;
  const existing = opts.existing;
  const kind = (raw.tx_type as string | undefined) || (partial ? existing!.tx_type as string : 'expense');
  if (!['expense', 'income', 'transfer'].includes(kind)) throw new McpToolError('Invalid tx_type');
  const body: Record<string, unknown> = { base_change_id: 0 };
  if (!partial || (raw.tx_type !== undefined && raw.tx_type !== null)) body.tx_type = kind;
  // 对齐上游：显式 None（null）表示"未设置"，不当成有值
  if (!partial || (raw.amount !== undefined && raw.amount !== null)) body.amount = positiveAmount(raw.amount);
  if (raw.happened_at !== undefined && raw.happened_at !== null) {
    body.happened_at = parseTxDatetime(String(raw.happened_at), opts.time_zone, c.configuredTimeZone ?? null);
  } else if (!partial) {
    body.happened_at = new Date().toISOString();
  }
  if (raw.note !== undefined && raw.note !== null) body.note = raw.note;
  // 对齐上游：创建时排除标记默认 False（写入 0 而非 NULL）；
  // 更新时只有显式给了 true/false 才改（None 表示不改），绝不强制清零
  for (const flag of ['exclude_from_stats', 'exclude_from_budget']) {
    if (!partial) {
      body[flag] = raw[flag] === true;
    } else if (raw[flag] !== undefined && raw[flag] !== null) {
      body[flag] = Boolean(raw[flag]);
    }
  }

  let accountCurrency: string | null | undefined;
  const category = await dictionaryEntry(db, 'user_category_projection', ledger.user_id, {
    name: raw.category as string | null | undefined,
    identifier: raw.category_id as string | null | undefined,
    kind,
  });
  if (category) {
    body.category_id = category.sync_id;
    body.category_name = category.name;
    body.category_kind = kind;
  }

  if (kind === 'transfer') {
    let fromId = (raw.from_account_id as string | undefined) || (raw.account_id as string | undefined);
    let fromName = (raw.from_account as string | undefined) || (raw.account as string | undefined);
    let toId = raw.to_account_id as string | undefined;
    let toName = raw.to_account as string | undefined;
    if (partial && existing!.tx_type === 'transfer') {
      if (!fromId && !fromName) fromId = existing!.from_account_sync_id as string | undefined;
      if (!toId && !toName) toId = existing!.to_account_sync_id as string | undefined;
    }
    const source = await dictionaryEntry(db, 'user_account_projection', ledger.user_id, { name: fromName, identifier: fromId });
    const target = await dictionaryEntry(db, 'user_account_projection', ledger.user_id, { name: toName, identifier: toId });
    if (!source || !target) {
      throw new McpToolError('Complete transfer requires both from_account_id/from_account and to_account_id/to_account');
    }
    if (source.sync_id === target.sync_id) throw new McpToolError('Transfer accounts must be different');
    const sCur = (source.currency as string | null) || ledger.currency;
    const tCur = (target.currency as string | null) || ledger.currency;
    // 对齐上游：原样比较（不归一化大小写），"cny" 与 "CNY" 视为不同币种
    if ((sCur || 'CNY') !== (tCur || 'CNY')) {
      throw new McpToolError('Transfer accounts must have the same currency');
    }
    body.from_account_id = source.sync_id;
    body.from_account_name = source.name;
    body.to_account_id = target.sync_id;
    body.to_account_name = target.name;
    body.currency_code = ((source.currency as string | null) || ledger.currency || 'CNY').toUpperCase();
  } else {
    const account = await dictionaryEntry(db, 'user_account_projection', ledger.user_id, {
      name: raw.account as string | null | undefined,
      identifier: raw.account_id as string | null | undefined,
    });
    if (account) {
      body.account_id = account.sync_id;
      body.account_name = account.name;
      accountCurrency = account.currency as string | null | undefined;
    } else if (partial && existing!.account_sync_id) {
      const prev = await db.prepare(
        'SELECT currency FROM user_account_projection WHERE user_id = ? AND sync_id = ?'
      ).bind(ledger.user_id, existing!.account_sync_id).first<{ currency: string | null }>();
      accountCurrency = prev?.currency ?? null;
    }
  }

  if (raw.attachments !== undefined && raw.attachments !== null) {
    body.attachments = await resolveTransactionAttachmentsRef(c, ledger.id, raw.attachments as string[]);
  }

  if (!partial || (raw.tags !== undefined && raw.tags !== null)) {
    const tags = !partial ? mergeDefaultTag(raw.tags as string[] | null | undefined) : (raw.tags as string[] | undefined || []);
    body.tags = tags;
    body.tag_ids = await lookupTagSyncIds(c, ledger, tags);
  }

  // 对齐上游：显式 null 视为未设置；空串 currency 回落到原币种（raw.get("currency") or existing）
  const touchedCurrency = raw.amount !== undefined && raw.amount !== null
    || raw.currency !== undefined && raw.currency !== null
    || raw.native_amount !== undefined && raw.native_amount !== null;
  if (kind !== 'transfer' && (!partial || touchedCurrency)) {
    const amount = (body.amount as number | undefined) ?? (partial ? existing!.amount as number : undefined);
    const currency = (raw.currency as string | undefined) || (partial ? (existing!.currency_code as string | null | undefined) : undefined);
    if (raw.native_amount !== undefined && raw.native_amount !== null) {
      body.currency_code = ((currency || accountCurrency || ledger.currency || 'CNY') as string).toUpperCase();
      body.native_amount = positiveAmount(raw.native_amount);
    } else if (partial && existing!.native_amount !== null && existing!.native_amount !== undefined && existing!.amount && !raw.currency) {
      body.currency_code = existing!.currency_code;
      body.native_amount = Number(existing!.native_amount) * Number(amount) / Number(existing!.amount);
    } else {
      const cf = await buildCurrencyFields(db, userId, ledger.currency || 'CNY', accountCurrency, currency, Number(amount), c.env ?? null);
      if (cf.currency_code !== undefined) body.currency_code = cf.currency_code;
      if (cf.native_amount !== undefined) body.native_amount = cf.native_amount;
    }
  }

  if (partial && raw.expected_revision !== undefined && raw.expected_revision !== null) {
    body.expected_revision = raw.expected_revision;
  }
  return body;
}// ── write-tools 依赖的本地 helper（由 tools/write-tools 提供实现）──

export type SelfCallFn = (
  method: string, path: string, userId: string, body: Record<string, unknown>, headers: Record<string, string>,
) => Promise<Record<string, unknown>>;

let selfCallImpl: SelfCallFn | null = null;

/** 注入自调用实现（默认由 tools/write-tools 设置；测试可替换模拟丢响应/失败） */
export function setSelfCall(fn: SelfCallFn | null): void {
  selfCallImpl = fn;
}

export function selfCallAdapter(c: McpContext): SelfCallFn {
  if (selfCallImpl) return selfCallImpl;
  throw new Error('selfCall not configured; call setSelfCall first');
}

export async function resolveWriteLedger(
  c: McpContext,
  ledgerId?: string | null,
): Promise<{ ledger: LedgerInfo | null; status: Record<string, unknown> | null }> {
  const { db, userId } = c;
  if (ledgerId) {
    const led = await listLiveLedgers(db, userId, ledgerId);
    if (led.length === 0) return { ledger: null, status: { status: 'ledger_not_found', message: `Ledger not found or has been deleted: ${ledgerId}`, ledger_id: ledgerId } };
    return { ledger: led[0], status: null };
  }
  const live = await listLiveLedgers(db, userId);
  if (live.length === 0) return { ledger: null, status: { status: 'no_ledger', message: 'You have no ledger yet. Create one in BeeCount first.' } };
  if (live.length === 1) return { ledger: live[0], status: null };
  return {
    ledger: null,
    status: {
      status: 'ledger_required',
      // 对齐上游 ledger_required 文案：提示用候选里的 id 字段
    message: 'You have multiple ledgers — refusing to guess which one to write to. '
      + 'Re-call this tool with an explicit `ledger_id` (the `id` field of one of the candidates below).',
      candidates: live.map(l => ({ id: l.external_id, name: l.name })),
    },
  };
}

export async function validateNamesExist(
  c: McpContext,
  ledger: LedgerInfo,
  transactions: Array<Record<string, unknown>>,
): Promise<void> {
  const { db } = c;
  const categories = new Set<string>();
  const accounts = new Set<string>();
  for (const item of transactions) {
    if (item.category) categories.add(String(item.category));
    for (const k of ['account', 'from_account', 'to_account']) {
      if (item[k]) accounts.add(String(item[k]));
    }
  }
  if (categories.size > 0) {
    const placeholders = [...categories].map(() => '?').join(',');
    const rows = await db.prepare(
      `SELECT name FROM user_category_projection WHERE user_id = ? AND name IN (${placeholders})`
    ).bind(ledger.user_id, ...[...categories]).all<{ name: string }>();
    const found = new Set(rows.results.map(r => r.name));
    const missing = [...categories].filter(n => !found.has(n)).sort();
    // 对齐上游 _validate_names_exist：一次性报全部缺失名（排序），而不是逐条报错
    if (missing.length) {
      throw new McpToolError(
        `Unknown categories: ${JSON.stringify(missing).replace(/"/g, "'")}. `
        + 'Use existing category names (call list_categories) or create them first.',
      );
    }
  }
  if (accounts.size > 0) {
    const placeholders = [...accounts].map(() => '?').join(',');
    const rows = await db.prepare(
      `SELECT name FROM user_account_projection WHERE user_id = ? AND name IN (${placeholders})`
    ).bind(ledger.user_id, ...[...accounts]).all<{ name: string }>();
    const found = new Set(rows.results.map(r => r.name));
    const missing = [...accounts].filter(n => !found.has(n)).sort();
    // 对齐上游 _validate_names_exist：一次性报全部缺失名（排序）
    if (missing.length) {
      throw new McpToolError(
        `Unknown accounts: ${JSON.stringify(missing).replace(/"/g, "'")}. `
        + 'Use existing account names (call list_accounts).',
      );
    }
  }
}

/** 对齐上游 _MCP_DEFAULT_TAG：MCP 记录自动打 "MCP" 标签（与 mobile 的"AI记账"区分） */
export const MCP_DEFAULT_TAG = 'MCP';
export const MCP_DEFAULT_TAG_COLOR = '#00BCD4';

/** 对齐上游 _merge_default_tag：strip 并丢弃空串（避免 tags_csv 里出现空白项） */
export function mergeDefaultTag(tags: string[] | null | undefined): string[] {
  const out: string[] = [];
  for (const t of tags ?? []) {
    const s = String(t ?? '').trim();
    if (s && !out.includes(s)) out.push(s);
  }
  if (!out.includes(MCP_DEFAULT_TAG)) out.push(MCP_DEFAULT_TAG);
  return out;
}

export async function ensureMcpTag(c: McpContext, ledgerExternalId: string): Promise<void> {
  const { db, userId } = c;
  const existing = await db.prepare(
    'SELECT sync_id FROM user_tag_projection WHERE user_id = ? AND name = ?'
  ).bind(userId, MCP_DEFAULT_TAG).first<{ sync_id: string }>();
  if (existing) return;
  try {
    await selfCallAdapter(c)(
      'POST',
      `/api/v1/write/ledgers/${ledgerExternalId}/tags`,
      userId,
      { base_change_id: 0, name: MCP_DEFAULT_TAG, color: MCP_DEFAULT_TAG_COLOR },
      {},
    );
  } catch {
    // 对齐上游 _ensure_mcp_tag：标签已存在/并发建标签时忽略，不让整批创建失败
  }
}

export async function lookupTagSyncIds(
  c: McpContext,
  ledger: LedgerInfo,
  names: string[],
): Promise<string[] | null> {
  const { db } = c;
  // 对齐上游 _lookup_tag_sync_ids：空名返回 []（不是 null）
  if (!names || names.length === 0) return [];
  // 按输入顺序去重（上游保持调用方顺序）
  const wanted = [...new Set(names)];
  const placeholders = wanted.map(() => '?').join(',');
  const rows = await db.prepare(
    `SELECT name, sync_id FROM user_tag_projection WHERE user_id = ? AND name IN (${placeholders})`
  ).bind(ledger.user_id, ...wanted).all<{ name: string; sync_id: string }>();
  const byName = new Map(rows.results.map(r => [r.name, r.sync_id]));
  return wanted.map(n => byName.get(n)).filter((v): v is string => Boolean(v));
}

async function resolveTransactionAttachmentsRef(
  c: McpContext,
  ledgerId: string,
  fileIds: string[],
): Promise<Array<Record<string, unknown>>> {
  const { db } = c;
  if (fileIds.some(v => typeof v !== 'string' || !v.trim())) {
    throw new McpToolError('attachments must contain non-empty uploaded file IDs');
  }
  const ids = fileIds.map(v => v.trim());
  if (new Set(ids).size !== ids.length) throw new McpToolError('Duplicate attachment file IDs are not allowed');
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = await db.prepare(
    `SELECT id, file_name, size_bytes, mime_type, sha256 FROM attachment_files
     WHERE id IN (${placeholders}) AND ledger_id = ? AND attachment_kind = 'transaction'`
  ).bind(...ids, ledgerId).all<{ id: string; file_name: string | null; size_bytes: number; mime_type: string | null; sha256: string }>();
  const byId = new Map(rows.results.map(row => [row.id, row]));
  if (byId.size !== ids.length) throw new McpToolError('Attachment not found in the target ledger; upload it there first');
  return ids.map((fileId, index) => {
    const row = byId.get(fileId)!;
    return {
      // 对齐上游 attachments.py：fileName = "<id>_<原文件名>"，originalName 回落 attachment.bin
      fileName: `${row.id}_${row.file_name || 'attachment.bin'}`,
      originalName: row.file_name || 'attachment.bin',
      fileSize: row.size_bytes,
      // 对齐上游 attachments.resolve_transaction_attachments：mimeType 原样（无则为 null）
      mimeType: row.mime_type ?? null,
      cloudFileId: row.id,
      cloudSha256: row.sha256,
      sortOrder: index,
    };
  });
}

function extFromName(name: string | null): string {
  const m = name?.match(/\.([a-zA-Z0-9]+)$/);
  return m ? m[1] : 'jpg';
}