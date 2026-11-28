/**
 * 规则/审核/周期调度工具（对齐原版 src/mcp/rule_tools.py，#133）。
 *
 * - save_review_item：审核队列持久化
 * - save_classification_rule / apply / execute：版本化分类规则（预览冻结目标集）
 * - manage_recurring_rule / execute_due_rules：云端周期调度（DST gap/歧义处理，
 *   月末钳位、幂等写键、丢响应保护）
 *
 * DST 消歧：以「naive 时刻当 UTC」为主猜测，加上 ±1h 与二次近似求候选偏移集合，
 * 回代验证固定点（offset(tz, N - o) === o），得到 0/1/2 个候选 → gap/唯一/歧义。
 */
import { requireLedger, runWrite } from './capability-tools';
import { parseDateBoundary, timeZoneOffsetMinutes } from './query-context';
import { prepareTransaction, dictionaryEntry } from './transaction-service';
import { serializeTx } from './tools/read-tools';
import { createTransactions } from './tools/write-tools';
import { loadRecord, saveRecord, recordOut, type MCPStateRow } from './workflow-tools';
import { enumValue, maxItems, optionalInt, optionalNumber, optionalString } from './validation';
import { createHash } from 'node:crypto';
import { RECURRING_SOURCE_PREFIX, uuid5, lastImportedDates, localPeriods, handoffUploadState, handoffReceipt } from '../services/recurring-handoff';
import type { McpContext, LedgerInfo } from './types';

const NAMESPACE_URL_BYTES = new Uint8Array([
  0x6b, 0xa7, 0xb8, 0x11, 0x9d, 0xad, 0x11, 0xd1,
  0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8,
]);

export interface ReviewItem {
  question: string;
  transaction_ids?: string[];
  answer?: string | null;
  status?: 'open' | 'answered' | 'resolved' | 'dismissed';
}

export interface ClassificationRule {
  name: string;
  note_contains?: string | null;
  account_id?: string | null;
  tx_type?: 'income' | 'expense';
  min_amount?: number | null;
  max_amount?: number | null;
  category_id: string;
  tags?: string[] | null;
  except_sync_ids?: string[];
  enabled?: boolean;
  confirmed?: boolean;
}

export interface RecurringRule {
  name: string;
  transaction: Record<string, unknown>;
  frequency: 'daily' | 'weekly' | 'monthly' | 'yearly';
  interval?: number;
  starts_at: string;
  time_zone: string;
  /** v1.11（#148）：周/月/年账单的锚定日（与 anchor 组合出下一次发生） */
  day_of_month?: number | null;
  day_of_week?: number | null;
  month_of_year?: number | null;
  ends_at?: string | null;
  enabled?: boolean;
  allow_backfill?: boolean;
  dst_policy?: 'skip' | 'first' | 'second';
}

export async function saveReviewItem(
  c: McpContext,
  args: { ledger_id: string; data: ReviewItem; record_id?: string | null; expected_revision?: number | null },
): Promise<Record<string, unknown>> {
  // 对齐上游 ReviewItem：question 1..4000、transaction_ids ≤ 200、answer ≤ 8000、status 枚举
  optionalString(args.data.question, 'data.question', { minLength: 1, maxLength: 4000 });
  optionalString(args.data.answer, 'data.answer', { maxLength: 8000 });
  enumValue(args.data.status, ['open', 'answered', 'resolved', 'dismissed'] as const, 'data.status');
  maxItems(args.data.transaction_ids, 200, 'data.transaction_ids');
  const ledger = await requireLedger(c, args.ledger_id, { write: true });
  const ids = args.data.transaction_ids ?? [];
  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    const rows = await c.db.prepare(
      `SELECT sync_id FROM read_tx_projection WHERE ledger_id = ? AND sync_id IN (${placeholders})`
    ).bind(ledger.id, ...ids).all<{ sync_id: string }>();
    const found = new Set(rows.results.map(r => r.sync_id));
    if (found.size !== ids.length || !ids.every(id => found.has(id))) {
      throw new Error('A related transaction was not found in this ledger');
    }
  }
  const data: Record<string, unknown> = {
    question: args.data.question,
    transaction_ids: ids,
    answer: args.data.answer ?? null,
    status: args.data.status ?? 'open',
  };
  return saveRecord(c, ledger, {
    kind: 'review_item',
    data,
    record_id: args.record_id ?? null,
    expected_revision: args.expected_revision ?? null,
    status: args.data.status ?? 'open',
  });
}

export async function saveClassificationRule(
  c: McpContext,
  args: { ledger_id: string; data: ClassificationRule; record_id?: string | null; expected_revision?: number | null; confirm?: boolean },
): Promise<Record<string, unknown>> {
  const r = args.data;
  // 对齐上游 ClassificationRule：name 1..255、note_contains ≤500、金额 ≥0、
  // except_sync_ids ≤1000、tx_type 枚举
  optionalString(r.name, 'data.name', { minLength: 1, maxLength: 255 });
  optionalString(r.note_contains, 'data.note_contains', { maxLength: 500 });
  optionalNumber(r.min_amount, 'data.min_amount', { ge: 0 });
  optionalNumber(r.max_amount, 'data.max_amount', { ge: 0 });
  maxItems(r.except_sync_ids, 1000, 'data.except_sync_ids');
  enumValue(r.tx_type, ['income', 'expense'] as const, 'data.tx_type');
  const rule: ClassificationRule = {
    name: r.name,
    note_contains: r.note_contains ?? null,
    account_id: r.account_id ?? null,
    tx_type: r.tx_type ?? 'expense',
    min_amount: r.min_amount ?? null,
    max_amount: r.max_amount ?? null,
    category_id: r.category_id,
    tags: r.tags ?? null,
    except_sync_ids: r.except_sync_ids ?? [],
    enabled: r.enabled ?? true,
    confirmed: r.confirmed ?? false,
  };
  if (rule.confirmed && !args.confirm) return { status: 'confirmation_required' };
  if (!rule.note_contains && !rule.account_id && (rule.min_amount ?? null) === null && (rule.max_amount ?? null) === null) {
    throw new Error('A rule needs at least one matching condition');
  }
  if ((rule.min_amount ?? null) !== null && (rule.max_amount ?? null) !== null && rule.min_amount! > rule.max_amount!) {
    throw new Error('Invalid amount range');
  }
  const ledger = await requireLedger(c, args.ledger_id, { write: true });
  await dictionaryEntry(c.db, 'user_category_projection', ledger.user_id, { identifier: rule.category_id, kind: rule.tx_type });
  if (rule.account_id) {
    await dictionaryEntry(c.db, 'user_account_projection', ledger.user_id, { identifier: rule.account_id });
  }
  return saveRecord(c, ledger, {
    kind: 'classification_rule',
    data: rule as unknown as Record<string, unknown>,
    record_id: args.record_id ?? null,
    expected_revision: args.expected_revision ?? null,
    status: rule.enabled ? 'active' : 'paused',
  });
}

export async function applyClassificationRule(
  c: McpContext,
  args: { rule_id: string; expected_revision?: number | null; confirm?: boolean },
): Promise<Record<string, unknown>> {
  const { db, userId } = c;
  const [row, ledger] = await loadRecord(c, args.rule_id, { kind: 'classification_rule', write: true });
  if (row.revision !== args.expected_revision) throw new Error('REVISION_CONFLICT: rule changed');
  const rule = row.data_json ? JSON.parse(row.data_json) as ClassificationRule : {} as ClassificationRule;
  if (!rule.confirmed || row.status !== 'active') throw new Error('Rule must be active and user-confirmed');

  let q = 'SELECT * FROM read_tx_projection WHERE ledger_id = ? AND tx_type = ?';
  const p: unknown[] = [ledger.id, rule.tx_type ?? 'expense'];
  if (rule.note_contains) {
    const escaped = rule.note_contains.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    q += ' AND note LIKE ? ESCAPE ?';
    p.push(`%${escaped}%`, '\\');
  }
  if (rule.account_id) { q += ' AND account_sync_id = ?'; p.push(rule.account_id); }
  if (rule.min_amount !== null && rule.min_amount !== undefined) { q += ' AND amount >= ?'; p.push(rule.min_amount); }
  if (rule.max_amount !== null && rule.max_amount !== undefined) { q += ' AND amount <= ?'; p.push(rule.max_amount); }
  if (rule.except_sync_ids && rule.except_sync_ids.length > 0) {
    const ph = rule.except_sync_ids.map(() => '?').join(',');
    q += ` AND sync_id NOT IN (${ph})`;
    p.push(...rule.except_sync_ids);
  }
  q += ' ORDER BY sync_id LIMIT 201';
  const rows = await db.prepare(q).bind(...p).all<Record<string, unknown>>();
  if (rows.results.length > 200) throw new Error('Rule matches more than 200 transactions; narrow the conditions');

  const steps: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  const preview: Array<Record<string, unknown>> = [];
  for (const tx of rows.results) {
    const patch = await prepareTransaction(c, ledger, {
      category_id: rule.category_id, tags: rule.tags ?? undefined, expected_revision: Number(tx.source_change_id ?? 0),
    }, { existing: tx });
    steps.push({
      method: 'PATCH',
      path: `/api/v1/write/ledgers/${ledger.external_id}/transactions/${tx.sync_id}`,
      body: patch,
    });
    preview.push({
      sync_id: tx.sync_id,
      expected_revision: Number(tx.source_change_id ?? 0),
      before: serializeTx(tx as never, (tx.category_name as string | null) ?? null),
      after: patch,
    });
  }
  if (!args.confirm) {
    const saved = await saveRecord(c, ledger, {
      kind: 'classification_preview',
      status: 'ready',
      data: { rule_id: args.rule_id, rule_revision: args.expected_revision, steps, preview },
    });
    return {
      status: 'confirmation_required',
      preview_id: saved.id,
      items: preview,
      message: 'Use execute_classification_preview with this preview_id after user confirmation',
    };
  }
  throw new Error('Apply the persisted preview with execute_classification_preview; do not recompute targets during confirmation');
}

export async function executeClassificationPreview(
  c: McpContext,
  args: { preview_id: string; confirm?: boolean },
): Promise<Record<string, unknown>> {
  if (!args.confirm) return { status: 'confirmation_required' };
  const [row, ledger] = await loadRecord(c, args.preview_id, { kind: 'classification_preview', write: true });
  const data = row.data_json ? JSON.parse(row.data_json) as Record<string, unknown> : {};
  const [rule] = await loadRecord(c, data.rule_id as string, { kind: 'classification_rule' });
  if (rule.revision !== data.rule_revision || rule.status !== 'active') {
    throw new Error('REVISION_CONFLICT: rule changed after preview');
  }
  return runWrite(c, ledger, {
    kind: 'classify',
    request: { preview_id: args.preview_id },
    steps: data.steps as Array<{ method: string; path: string; body: Record<string, unknown> }>,
    idempotency_key: `classify:${args.preview_id}`,
  });
}

// ── 周期调度：DST 消歧 ──

interface NaiveParts { y: number; mo: number; d: number; h: number; mi: number; s: number }

function parseNaiveParts(value: string): NaiveParts {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) throw new Error('Invalid anchor_local');
  return { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +(m[6] ?? 0) };
}

function addDays(p: NaiveParts, days: number): NaiveParts {
  const d = new Date(Date.UTC(p.y, p.mo - 1, p.d + days, p.h, p.mi, p.s));
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() };
}

function addMonths(p: NaiveParts, months: number): NaiveParts {
  const idx = p.y * 12 + (p.mo - 1) + months;
  const y = Math.floor(idx / 12);
  const mo = idx % 12 + 1;
  const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return { y, mo, d: Math.min(p.d, lastDay), h: p.h, mi: p.mi, s: p.s };
}

/** naive 本地时刻 → 候选 UTC 固定点（DST gap → 空集）。 */
function candidateInstants(naiveMs: number, tz: string): number[] {
  const candidates = new Set<number>();
  const o0 = timeZoneOffsetMinutes(tz, new Date(naiveMs));
  candidates.add(o0);
  // 围绕推测的真实 instant（I_guess）±1h 采样，覆盖 DST 切换两档
  const guess = naiveMs - o0 * 60 * 1000;
  for (const delta of [-3600 * 1000, 0, 3600 * 1000]) {
    candidates.add(timeZoneOffsetMinutes(tz, new Date(guess + delta)));
  }
  candidates.add(timeZoneOffsetMinutes(tz, new Date(naiveMs - 3600 * 1000)));
  candidates.add(timeZoneOffsetMinutes(tz, new Date(naiveMs + 3600 * 1000)));
  const fixed: number[] = [];
  for (const o of candidates) {
    const instant = naiveMs - o * 60 * 1000;
    if (timeZoneOffsetMinutes(tz, new Date(instant)) === o) fixed.push(instant);
  }
  return [...new Set(fixed)].sort((a, b) => a - b);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isBeforeDate(a: NaiveParts, b: NaiveParts): boolean {
  const key = (p: NaiveParts) => p.y * 10000 + p.mo * 100 + p.d;
  return key(a) < key(b);
}

/** 规则第 index 次发生（UTC ISO；DST gap/policy=skip → null；日历溢出 → 抛 RangeError）。纯函数。 */
export function occurrence(data: Record<string, unknown>, index: number): string | null {
  const anchor = parseNaiveParts(data.anchor_local as string);
  const rule = data.rule as Record<string, unknown>;
  const interval = Number(rule.interval ?? 1) * index;
  let local: NaiveParts;
  if (rule.frequency === 'daily' || rule.frequency === 'weekly') {
    const weekly = rule.frequency === 'weekly';
    const anchorDow = new Date(Date.UTC(anchor.y, anchor.mo - 1, anchor.d)).getUTCDay() || 7;
    const targetDow = Number(rule.day_of_week ?? anchorDow) || anchorDow;
    const offset = weekly ? ((targetDow - anchorDow) % 7 + 7) % 7 : 0;
    local = addDays(anchor, interval * (weekly ? 7 : 1) + offset);
  } else {
    const yearly = rule.frequency === 'yearly';
    const month = yearly ? (Number(rule.month_of_year ?? anchor.mo) || anchor.mo) : anchor.mo;
    const day = Number(rule.day_of_month ?? anchor.d) || anchor.d;
    const first: NaiveParts = { ...anchor, mo: month, d: Math.min(day, daysInMonth(anchor.y, month)) };
    const step = yearly ? 12 : 1;
    const monthsDiff = interval * step + (isBeforeDate(first, anchor) ? step : 0);
    const idx = anchor.y * 12 + month - 1 + monthsDiff;
    const year = Math.floor(idx / 12);
    const mo = (idx % 12) + 1;
    if (year > 9999) throw new RangeError('End of calendar');
    local = { y: year, mo, d: Math.min(day, daysInMonth(year, mo)), h: anchor.h, mi: anchor.mi, s: anchor.s };
  }
  const naiveMs = Date.UTC(local.y, local.mo - 1, local.d, local.h, local.mi, local.s);
  const instants = candidateInstants(naiveMs, rule.time_zone as string);
  if (instants.length === 0) return null;
  if (instants.length === 2) {
    if (rule.dst_policy === 'skip') return null;
    return new Date(rule.dst_policy === 'second' ? instants[1] : instants[0]).toISOString();
  }
  return new Date(instants[0]).toISOString();
}

/** 下一个到期发生（index,due），ends_at 之后停止；最多搜索 50000 次。 */
export function nextOccurrence(
  data: Record<string, unknown>,
  index: number,
  earliest?: string | null,
): [number, string | null] {
  const rule = data.rule as Record<string, unknown>;
  const end = rule.ends_at
    ? parseDateBoundary(String(rule.ends_at), { end: true, timeZone: rule.time_zone as string }).getTime()
    : null;
  const earliestMs = earliest ? new Date(earliest).getTime() : null;
  let i = index;
  for (let guard = 0; guard < 50000; guard++) {
    let due: string | null = null;
    try {
      due = occurrence(data, i);
    } catch (err) {
      if (err instanceof RangeError) return [i, null]; // 日历溢出 = 无更多发生
      throw err;
    }
    if (due) {
      const dueMs = new Date(due).getTime();
      if (end !== null && dueMs >= end) return [i, null];
      if (earliestMs === null || dueMs >= earliestMs) return [i, due];
    }
    i += 1;
  }
  throw new Error('Recurring schedule exceeds the supported search range');
}

/** tz 本地含偏移 ISO（如 2026-02-28T09:00:00+08:00）。 */
function zoneLocalIso(utcMs: number, tz: string): string {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset',
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(utcMs)).map(p => [p.type, p.value]));
  const name = parts.timeZoneName ?? '';
  const m = name.match(/([+-])(\d{2}):(\d{2})/);
  const off = m ? m[0] : 'Z';
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${off}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function occurrenceKey(recordId: string, dueUtc: Date): string {
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return `recurring:${recordId}:${p(dueUtc.getUTCFullYear(), 4)}${p(dueUtc.getUTCMonth() + 1)}${p(dueUtc.getUTCDate())}T${p(dueUtc.getUTCHours())}${p(dueUtc.getUTCMinutes())}${p(dueUtc.getUTCSeconds())}Z`;
}

// ---------------------------------------------------------------------------
// 周期规则变更（App/Web 共用入口，对齐上游 1.10.1+ change_recurring_rule）
// ---------------------------------------------------------------------------

export interface ChangeRecurringRuleArgs {
  action: 'create' | 'update' | 'pause' | 'resume' | 'delete';
  ledger_id: string;
  data?: RecurringRule | null;
  record_id?: string | null;
  expected_revision?: number | null;
  confirm?: boolean;
  client_id?: string | null;
  consumed_through?: string | null;
  last_generated_date?: string | null;
  migration?: boolean;
  automatic?: boolean;
  distinct?: boolean;
  local_transactions?: Array<{ sync_id: string; date: string }>;
  reviewed_mapping?: string | null;
}

function migrationSignature(rule: Record<string, unknown>): Record<string, unknown> {
  const tx = (rule.transaction ?? {}) as Record<string, unknown>;
  return {
    name: String(rule.name ?? '').trim().toLowerCase(),
    type: tx.tx_type ?? 'expense',
    amount: tx.amount,
    frequency: rule.frequency,
  };
}

function similarSchedule(incoming: Record<string, unknown>, existing: Record<string, unknown>): boolean {
  if (incoming.type !== existing.type) return false;
  const namedMatch = incoming.name !== '' && incoming.name !== 'expense'
    && incoming.name !== 'income' && incoming.name !== 'transfer'
    && incoming.name === existing.name;
  return namedMatch || (incoming.amount === existing.amount && incoming.frequency === existing.frequency);
}

function checkRecurringAccounts(
  db: D1Database, ledger: { user_id: string }, body: Record<string, unknown>
): void {
  const ids = [body.account_id, body.from_account_id, body.to_account_id].filter(Boolean) as string[];
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(
    `SELECT sync_id FROM user_account_projection
     WHERE user_id = ? AND sync_id IN (${placeholders}) AND hidden = 1 LIMIT 1`
  ).bind(ledger.user_id, ...ids).first();
}

function mappingHash(values: Record<string, string>): string {
  const sorted = Object.keys(values).sort()
    .map((k) => `${JSON.stringify(k)}:${JSON.stringify(values[k])}`).join(',');
  return createHash('sha256').update(`{${sorted}}`).digest('hex');
}

function sortKeysJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(sortKeysJson).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${sortKeysJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

function handoffReceiptId(ledgerId: string, userId: string, clientId: string): string {
  return uuid5(
    NAMESPACE_URL_BYTES,
    `beecount:handoff:${ledgerId}:${userId}:${clientId}`
  );
}

async function sourceRules(
  db: D1Database,
  ledgerId: string,
  occurrences: Array<{ sync_id: string; date: string }>
): Promise<Set<string>> {
  const ids = [...new Set(occurrences.map((item) => item.sync_id))];
  const matches = new Set<string>();
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = await db
      .prepare(
        `SELECT DISTINCT source_system FROM mcp_source_references
         WHERE ledger_id = ? AND tx_sync_id IN (${placeholders})
           AND source_system LIKE '${RECURRING_SOURCE_PREFIX}%'`
      )
      .bind(ledgerId, ...chunk)
      .all<{ source_system: string }>();
    for (const row of rows.results ?? []) matches.add(row.source_system.slice(RECURRING_SOURCE_PREFIX.length));
  }
  return matches;
}

export async function changeRecurringRule(
  c: McpContext,
  args: ChangeRecurringRuleArgs
): Promise<Record<string, unknown>> {
  const { db, userId } = c;
  const action = args.action;
  const recordId = args.record_id ?? null;
  if ((action === 'create') !== (recordId === null)) {
    throw new Error('Create requires a new rule; other actions require a record_id');
  }
  const ledger = await requireLedger(c, args.ledger_id, { write: true });
  const handoffKey = args.migration && args.client_id
    ? handoffReceiptId(ledger.id, userId, args.client_id)
    : null;

  // 已提交的交接回执：幂等重放（含丢失响应后的当前准入状态）
  const committed = handoffKey ? await handoffReceipt(db, handoffKey) : null;
  if (committed) return committed;
  if (args.migration && args.local_transactions && args.local_transactions.length > 0) {
    const known = await sourceRules(db, ledger.id, args.local_transactions);
    if (known.size > 0 && !(known.size === 1 && known.has(recordId ?? ''))) {
      if (args.automatic && !recordId && known.size === 1) {
        const linkedId = [...known][0];
        const linked = await db.prepare('SELECT * FROM mcp_state_records WHERE id = ?').bind(linkedId).first<MCPStateRow>();
        if (linked && linked.user_id === userId && linked.status !== 'deleted') {
          if (linked.status === 'executing') return { status: 'operation_pending' };
          if (args.confirm) {
            throw new Error('REVISION_CONFLICT: another device adopted this schedule');
          }
          const out = recordOut(linked);
          return { matched_rule: { ...out, can_edit: true } };
        }
      }
      throw new Error('HISTORY_CONFLICT: some transactions belong to another recurring rule');
    }
  }

  let previous: Record<string, unknown> | null = null;
  let rowStatus: string | null = null;
  let row: MCPStateRow | null = null;
  if (recordId) {
    [row] = await loadRecord(c, recordId, { kind: 'recurring_rule', write: true });
    if (row.ledger_id !== ledger.id || row.user_id !== userId) {
      throw new Error('Only the schedule creator can manage its execution identity');
    }
    if (row.revision !== args.expected_revision) throw new Error('REVISION_CONFLICT: recurring rule changed');
    if (row.status === 'deleted') throw new Error('Record not found');
    if (row.status === 'executing') return { status: 'operation_pending' };
    if (args.action === 'update' && row.next_due_at) {
      // 丢响应保护：到期写入已提交但响应丢失时，规则编辑不得覆盖未确认的发生
      const key = occurrenceKey(row.id, new Date(row.next_due_at));
      const pending = await db
        .prepare('SELECT id FROM mcp_write_operations WHERE user_id = ? AND request_key = ?')
        .bind(userId, key)
        .first<{ id: string }>();
      if (pending) return { status: 'operation_pending' };
    }
    previous = row.data_json ? JSON.parse(row.data_json) as Record<string, unknown> : null;
  } else if (action !== 'create') {
    throw new Error('record_id and expected_revision are required');
  }
  const prevAll = (previous ?? {}) as Record<string, unknown>;
  const prevRule = (prevAll.rule ?? {}) as Record<string, unknown>;

  // App 迁移创建：client_id 派生稳定 ID；fingerprint 幂等防重放
  let createId: string | null = null;
  let fingerprint: string | null = null;
  if (action === 'create' && args.client_id && args.data) {
    createId = uuid5(NAMESPACE_URL_BYTES, `beecount:recurring:${ledger.id}:${userId}:${args.client_id}`);
    fingerprint = createHash('sha256').update(sortKeysJson([args.data, args.consumed_through ?? null])).digest('hex');
    if (args.confirm) {
      const prior = await db
        .prepare('SELECT * FROM mcp_state_records WHERE id = ?')
        .bind(createId)
        .first<MCPStateRow>();
      if (prior) {
        const priorData = prior.data_json ? JSON.parse(prior.data_json) as Record<string, unknown> : {};
        if (priorData.creation_hash !== fingerprint) {
          throw new Error('REVISION_CONFLICT: creation key already used');
        }
        return recordOut(prior);
      }
    }
  }
  // 对齐上游：app_schedule = create_id 存在 或 既有规则带 creation_hash
  const appSchedule = createId !== null || Boolean(prevAll.creation_hash);

  let payload: Record<string, unknown>;
  let index: number;
  let due: string | null;
  let state: string;

  if (action === 'create' || action === 'update') {
    const data = args.data;
    if (!data) throw new Error('data is required');
    optionalString(data.name, 'name', { minLength: 1, maxLength: 255 });
    optionalInt(data.interval, 'interval', { ge: 1, le: 365 });
    enumValue(data.dst_policy, ['skip', 'first', 'second'] as const, 'dst_policy');
    enumValue(data.frequency, ['daily', 'weekly', 'monthly', 'yearly'] as const, 'frequency', { required: true });
    const tz = data.time_zone;
    const anchor = parseDateBoundary(data.starts_at, { timeZone: tz }).getTime();
    if (data.ends_at && parseDateBoundary(data.ends_at, { end: true, timeZone: tz }).getTime() <= anchor) {
      throw new Error('End must follow start');
    }
    await prepareTransaction(c, ledger, { ...data.transaction, happened_at: new Date(anchor).toISOString() });
    const tx = (data.transaction ?? {}) as Record<string, unknown>;
    const txDefaults: Record<string, unknown> = {
      account: null, attachments: null, category: null, currency: null,
      exclude_from_budget: false, exclude_from_stats: false,
      from_account: null, from_account_id: null, native_amount: null,
      tags: null, to_account: null, to_account_id: null,
    };
    const transaction = { ...txDefaults, ...tx };
    const rulePayload: Record<string, unknown> = {
      name: data.name,
      transaction,
      frequency: data.frequency,
      interval: data.interval ?? 1,
      starts_at: data.starts_at,
      time_zone: data.time_zone,
      day_of_month: data.day_of_month ?? null,
      day_of_week: data.day_of_week ?? null,
      month_of_year: data.month_of_year ?? null,
      ends_at: data.ends_at ?? null,
      enabled: data.enabled ?? true,
      allow_backfill: data.allow_backfill ?? false,
      dst_policy: data.dst_policy ?? 'skip',
    };
    payload = { ...prevAll };
    payload.rule = rulePayload;
    payload.anchor_local = zoneLocalIso(anchor, tz);
    payload.execution_owner = 'cloud';
    payload.executed_count = prevAll.executed_count ?? 0;
    if (args.migration && action === 'create') {
      payload.migration_origin = migrationSignature(rulePayload);
    }
    if (fingerprint) {
      payload.creation_hash = fingerprint;
    }

    const scheduleKeys = ['frequency', 'interval', 'starts_at', 'time_zone', 'dst_policy',
      'day_of_month', 'month_of_year', 'day_of_week'];
    const sameSchedule = !!previous && scheduleKeys.every(
      (key) => prevRule[key] === rulePayload[key]
    );
    const startIndex = previous && sameSchedule ? Number(previous.next_index ?? 0) : 0;
    let earliest: number | null = data.allow_backfill || sameSchedule ? null : Date.now();
    // App 迁移创建时 starts_at 是纯日期（无时间）：首个发生对齐到当地零点
    if (appSchedule && earliest !== null && data.starts_at.length === 10) {
      const dayIso = new Date(earliest).toISOString().slice(0, 10);
      earliest = parseDateBoundary(dayIso, { timeZone: tz }).getTime();
    }
    if (args.consumed_through) {
      const boundary = parseDateBoundary(args.consumed_through, { end: true, timeZone: tz }).getTime();
      earliest = Math.max(anchor, boundary);
    }
    // 迁移/换计划：以本地最近生成日与 Cloud 最近入账日的较大者为历史边界
    let last: number | null = null;
    if (args.migration || (previous && !sameSchedule)) {
      let localDay = (payload.last_local_generated_date as string | undefined) ?? null;
      if (recordId && !localDay) {
        const dates = await lastImportedDates(db, ledger.id, recordId);
        localDay = dates[recordId] ?? null;
      }
      if (args.migration) {
        const incomingDay = args.last_generated_date
          ?? args.local_transactions?.reduce<string | null>(
            (acc, item) => (acc && acc >= item.date ? acc : item.date), null)
          ?? null;
        if (incomingDay) localDay = localDay && localDay >= incomingDay ? localDay : incomingDay;
      }
      if (localDay) {
        payload.last_local_generated_date = localDay;
        last = parseDateBoundary(localDay, { timeZone: tz }).getTime();
      }
      const lastDue = (payload.last_due_at as string | undefined) ?? null;
      if (lastDue) {
        const cloudPosting = parseDateBoundary(lastDue, { timeZone: tz }).getTime();
        last = last !== null ? Math.max(last, cloudPosting) : cloudPosting;
      }
    }
    if (last !== null) {
      let boundary = last + 1000; // 上游：last + timedelta(microseconds=1)
      if (!previous || prevRule.frequency === data.frequency) {
        const localDayIso = new Date(last).toISOString().slice(0, 10);
        const midnight = parseDateBoundary(localDayIso, { timeZone: tz }).getTime();
        if (data.frequency === 'monthly') {
          boundary = parseDateBoundary(new Date(midnight + 32 * 86400_000).toISOString().slice(0, 10), { timeZone: tz }).getTime();
        } else if (data.frequency === 'yearly') {
          boundary = parseDateBoundary(`${new Date(last).getUTCFullYear() + 1}-01-01`, { timeZone: tz }).getTime();
        } else if (data.frequency === 'weekly') {
          const dow = new Date(last).getUTCDay() || 7;
          boundary = midnight + (8 - dow) * 86400_000;
        } else {
          boundary = midnight + 86400_000;
        }
      }
      earliest = earliest !== null ? Math.max(earliest, boundary) : boundary;
    }
    const [nextIndex, nextDue] = nextOccurrence(payload, startIndex, earliest === null ? null : new Date(earliest).toISOString());
    index = nextIndex;
    due = nextDue;
    payload.next_index = index;
    state = (data.enabled ?? true) && due ? 'active' : due === null ? 'completed' : 'paused';
  } else {
    payload = { ...prevAll };
    const resumeEarliest = appSchedule && action === 'resume' && rowStatus === 'paused'
      ? new Date().toISOString() : null;
    const [nextIndex, nextDue] = nextOccurrence(payload, Number(payload.next_index ?? 0), resumeEarliest);
    index = nextIndex;
    due = nextDue;
    payload.next_index = index;
    payload.rule = { ...prevRule, enabled: action === 'resume' };
    state = args.action === 'pause' ? 'paused'
      : args.action === 'resume' ? (due ? 'active' : 'completed')
      : 'deleted';
  }

  // ---------- 迁移交接：本地流水与 Cloud 流水的稳定映射 ----------
  let mapping: Record<string, string> = {};
  let deleted: string[] = [];
  if (handoffKey) {
    mapping = await localPeriods(
      db, ledger, { id: userId }, recordId ?? createId ?? '',
      payload.rule as { time_zone: string } & Record<string, unknown>,
      args.local_transactions ?? []
    );
    deleted = (await handoffUploadState(db, ledger.id, mapping)).deleted_transactions;
  }

  const preview: string[] = [];
  let nextIndex = index;
  for (let round = 0; round < 5; round++) {
    const [, nextDue] = nextOccurrence(payload, nextIndex);
    if (!nextDue) break;
    preview.push(zoneLocalIso(new Date(nextDue).getTime(), String((payload.rule as Record<string, unknown>).time_zone)));
    nextIndex += 1;
  }

  if (!args.confirm) {
    return {
      status: 'confirmation_required',
      next_occurrences: preview,
      local_transactions: mapping,
      deleted_transactions: deleted,
      reviewed_mapping: handoffKey ? mappingHash(mapping) : null,
      execution_owner: 'cloud',
      backfill: (payload.rule as Record<string, unknown>).allow_backfill,
      dst_policy: (payload.rule as Record<string, unknown>).dst_policy,
    };
  }

  // 创建前检查（save_record 的 check_create）：迁移冲突检查 + 重放既有创建
  const checkCreate = createId !== null
    ? async (): Promise<Record<string, unknown> | null> => {
      const prior = await db
        .prepare('SELECT * FROM mcp_state_records WHERE id = ?')
        .bind(createId)
        .first<MCPStateRow>();
      if (prior) {
        const priorData = prior.data_json ? JSON.parse(prior.data_json) as Record<string, unknown> : {};
        if (priorData.creation_hash !== fingerprint) {
          throw new Error('REVISION_CONFLICT: creation key already used');
        }
        return recordOut(prior);
      }
      if (args.migration && (await sourceRules(db, ledger.id, args.local_transactions ?? [])).size > 0) {
        throw new Error('REVISION_CONFLICT: another device adopted this schedule');
      }
      if (args.migration && !args.distinct && args.local_transactions && args.local_transactions.length > 0) {
        const origin = migrationSignature((payload.rule as Record<string, unknown>));
        const candidates = await db
          .prepare(
            `SELECT data_json FROM mcp_state_records
             WHERE ledger_id = ? AND kind = 'recurring_rule' AND status != 'deleted'`
          )
          .bind(ledger.id)
          .all<{ data_json: string }>();
        for (const candidate of candidates.results ?? []) {
          let rule: Record<string, unknown> = {};
          try {
            rule = (JSON.parse(candidate.data_json) as Record<string, unknown>).rule as Record<string, unknown> ?? {};
          } catch { continue; }
          const other = migrationSignature(rule);
          const migrationOrigin = (rule.migration_origin as Record<string, unknown> | undefined) ?? other;
          if (similarSchedule(origin, other) || similarSchedule(origin, migrationOrigin)) {
            throw new Error('SIMILAR_RULE: review existing rules before creating another');
          }
        }
      }
      return null;
    }
    : null;

  const result = await saveRecord(c, ledger, {
    kind: 'recurring_rule',
    data: payload,
    record_id: recordId,
    expected_revision: args.expected_revision,
    status: state,
    next_due_at: due,
    create_id: createId,
    check_create: checkCreate,
    after_save: handoffKey
      ? async (row) => {
        const accepted = await localPeriods(
          db, ledger, { id: userId }, String(row.id),
          payload.rule as { time_zone: string } & Record<string, unknown>,
          args.local_transactions ?? [], { commit: true }
        );
        const admission = handoffUploadState(db, ledger.id, accepted);
        if (JSON.stringify(Object.keys(accepted).sort()) !== JSON.stringify(Object.keys(mapping).sort())) {
          throw new Error('REVISION_CONFLICT: another device handed off this period');
        }
        await db.prepare(
          `INSERT INTO mcp_state_records (id, user_id, ledger_id, kind, revision, status, data_json, created_at, updated_at)
           VALUES (?, ?, ?, 'recurring_handoff', 1, 'completed', ?, ?, ?)
           ON CONFLICT(id) DO NOTHING`
        ).bind(
          handoffKey, userId, ledger.id,
          JSON.stringify({ rule_id: String(row.id), transactions: accepted, ...admission }),
          nowIso(), nowIso()
        ).run();
        return { handoff_confirmed: true, local_transactions: accepted, ...admission };
      }
      : null,
  });
  return { ...result, next_occurrences: preview };
}

// MCP 面向工具（对齐上游 manage_recurring_rule：仅透传基础参数）
export async function manageRecurringRule(
  c: McpContext,
  args: { action: 'create' | 'update' | 'pause' | 'resume' | 'delete'; ledger_id?: string | null; data?: RecurringRule | null; record_id?: string | null; expected_revision?: number | null; confirm?: boolean },
): Promise<Record<string, unknown>> {
  return changeRecurringRule(c, {
    action: args.action,
    ledger_id: args.ledger_id!,
    data: args.data ?? null,
    record_id: args.record_id ?? null,
    expected_revision: args.expected_revision ?? null,
    confirm: args.confirm ?? false,
  });
}

// ---------------------------------------------------------------------------
// 到期执行：executing 租约 + 创建哈希感知（对齐上游 1.10.1+ execute_due_rules）
// ---------------------------------------------------------------------------

const RECURRING_LEASE_MS = 5 * 60 * 1000;

export async function executeDueRules(
  c: McpContext,
  args: { now?: string | null; only_record_id?: string | null; limit?: number },
): Promise<Array<Record<string, unknown>>> {
  const db = c.db;
  const now = args.now ? new Date(args.now) : new Date();
  const limit = Math.max(1, Math.min(args.limit ?? 20, 100));
  const leaseCutoff = new Date(now.getTime() - RECURRING_LEASE_MS).toISOString();
  const claimable = `(status = 'active' OR (status = 'executing' AND updated_at < '${leaseCutoff}'))`;
  let q = `SELECT * FROM mcp_state_records WHERE kind = 'recurring_rule' AND ${claimable} AND next_due_at <= ?`;
  const p: unknown[] = [now.toISOString()];
  if (args.only_record_id) { q += ' AND id = ?'; p.push(args.only_record_id); }
  q += ' ORDER BY next_due_at LIMIT ?';
  p.push(limit);
  const rules = await db.prepare(q).bind(...p).all<Record<string, unknown>>();
  const results: Array<Record<string, unknown>> = [];
  for (const rowRaw of rules.results) {
    try {
      const rowId = String(rowRaw.id);
      const row = rowRaw as Record<string, unknown> & {
        id: string; user_id: string; ledger_id: string;
        revision: number; next_due_at: string; data_json: string | null; status: string;
      };
      const userId = String(row.user_id);
      const rowCtx: McpContext = { ...c, userId };
      const ledger = await db.prepare('SELECT id, user_id, external_id, name, currency FROM ledgers WHERE id = ?')
        .bind(String(row.ledger_id)).first<LedgerInfo>();
      if (!ledger) continue;
      const owner = await db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first<Record<string, unknown>>();
      if (!owner || Number(owner.is_enabled ?? 1) === 0) continue;
      try {
        await requireLedger(rowCtx, ledger.external_id, { write: true });
      } catch {
        results.push({ rule_id: row.id, status: 'permission_denied' });
        continue;
      }
      let data: Record<string, unknown> = {};
      if (typeof row.data_json === 'string') data = JSON.parse(row.data_json) as Record<string, unknown>;
      const [idx, due] = nextOccurrence(data, Number(data.next_index ?? 0));
      if (!due || new Date(due).getTime() > now.getTime()) continue;
      const ruleData = data.rule as Record<string, unknown>;
      const txRaw = ruleData.transaction as Record<string, unknown>;
      const raw = { ...txRaw, happened_at: due };
      const key = occurrenceKey(String(row.id), new Date(due));

      // v1.11：executing 租约抢占（崩溃后 5 分钟可重新认领）
      const claimTime = new Date().toISOString();
      const claim = await db.prepare(
        `UPDATE mcp_state_records SET status = 'executing', updated_at = ?
         WHERE id = ? AND revision = ? AND next_due_at = ? AND ${claimable}`
      ).bind(claimTime, String(row.id), Number(row.revision), due).run();
      if (claim.meta.changes === 0) continue;

      try {
        // App 创建的规则（creation_hash）在写入前校验账户可用性
        if (data.creation_hash) {
          const started = await db.prepare(
            'SELECT id FROM mcp_write_operations WHERE user_id = ? AND request_key = ?'
          ).bind(userId, key).first();
          if (!started) {
            const body = await prepareTransaction(rowCtx, ledger, { ...txRaw, happened_at: due }, { add_mcp_tag: false });
            checkRecurringAccounts(db, ledger, body);
          }
        }
        const outcome = await createTransactions(rowCtx, {
          ledger_id: ledger.external_id,
          transactions: [raw],
          idempotency_key: key,
          add_mcp_tag: !data.creation_hash,
        });
        results.push({ rule_id: row.id, due, operation: outcome });
        if (outcome.status !== 'created') {
          await db.prepare(
            `UPDATE mcp_state_records SET status = 'active', updated_at = ?
             WHERE id = ? AND status = 'executing' AND updated_at = ?`
          ).bind(new Date().toISOString(), String(row.id), claimTime).run();
          continue;
        }
        const [nextIndex, nextDue] = nextOccurrence(data, idx + 1);
        await db.prepare(
          `UPDATE mcp_state_records SET data_json = ?, next_due_at = ?, revision = revision + 1,
           status = ?, updated_at = ?
           WHERE id = ? AND revision = ? AND updated_at = ? AND status = 'executing' AND next_due_at = ?`
        ).bind(
          JSON.stringify({ ...data, next_index: nextIndex, executed_count: Number(data.executed_count ?? 0) + 1, last_operation_id: outcome.operation_id, last_due_at: due }),
          nextDue, nextDue ? 'active' : 'completed', new Date().toISOString(),
          String(row.id), Number(row.revision), claimTime, due,
        ).run();
      } catch (exc: unknown) {
        // 无效资源在操作产生之前：放回 active 让创建者修复规则
        await db.prepare(
          `UPDATE mcp_state_records SET status = 'active', updated_at = ?
           WHERE id = ? AND status = 'executing' AND updated_at = ?`
        ).bind(claimTime, String(row.id), claimTime).run();
        const code = exc instanceof Error ? exc.name : 'Error';
        results.push({ rule_id: row.id, status: 'failed', error_code: code });
      }
    } catch (exc: unknown) {
      const code = exc instanceof Error ? exc.name : 'Error';
      results.push({ rule_id: String(rowRaw.id), status: 'failed', error_code: code });
    }
  }
  return results;
}

export async function runDueRecurringRules(c: McpContext, args: { ledger_id: string }): Promise<Record<string, unknown>> {
  const ledger = await requireLedger(c, args.ledger_id, { write: true });
  const rows = await c.db.prepare(
    `SELECT id FROM mcp_state_records
     WHERE ledger_id = ? AND user_id = ? AND kind = 'recurring_rule'
       AND status IN ('active', 'executing') AND next_due_at <= ?
     ORDER BY next_due_at LIMIT 100`
  ).bind(ledger.id, c.userId, new Date().toISOString()).all<{ id: string }>();
  const outcomes: Array<Record<string, unknown>> = [];
  for (const row of rows.results ?? []) {
    outcomes.push(...await executeDueRules(c, { only_record_id: row.id }));
  }
  return { results: outcomes };
}
