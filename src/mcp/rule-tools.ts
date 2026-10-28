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
import { loadRecord, saveRecord } from './workflow-tools';
import { enumValue, maxItems, optionalInt, optionalNumber, optionalString } from './validation';
import type { McpContext, LedgerInfo } from './types';

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
  ends_at?: string | null;
  enabled?: boolean;
  allow_backfill?: boolean;
  dst_policy?: 'skip' | 'first' | 'second';
}

export async function saveReviewItem(
  c: McpContext,
  args: { ledger_id: string; question: string; transaction_ids?: string[]; answer?: string | null; status?: 'open' | 'answered' | 'resolved' | 'dismissed'; record_id?: string | null; expected_revision?: number | null },
): Promise<Record<string, unknown>> {
  // 对齐上游 ReviewItem：question 1..4000、transaction_ids ≤ 200、answer ≤ 8000、status 枚举
  optionalString(args.question, 'question', { minLength: 1, maxLength: 4000 });
  optionalString(args.answer, 'answer', { maxLength: 8000 });
  enumValue(args.status, ['open', 'answered', 'resolved', 'dismissed'] as const, 'status');
  maxItems(args.transaction_ids, 200, 'transaction_ids');
  const ledger = await requireLedger(c, args.ledger_id, { write: true });
  const ids = args.transaction_ids ?? [];
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
    question: args.question,
    transaction_ids: ids,
    answer: args.answer ?? null,
    status: args.status ?? 'open',
  };
  return saveRecord(c, ledger, {
    kind: 'review_item',
    data,
    record_id: args.record_id ?? null,
    expected_revision: args.expected_revision ?? null,
    status: args.status ?? 'open',
  });
}

export async function saveClassificationRule(
  c: McpContext,
  args: { ledger_id: string; name: string; note_contains?: string | null; account_id?: string | null; tx_type?: 'income' | 'expense'; min_amount?: number | null; max_amount?: number | null; category_id: string; tags?: string[] | null; except_sync_ids?: string[]; enabled?: boolean; confirmed?: boolean; record_id?: string | null; expected_revision?: number | null; confirm?: boolean },
): Promise<Record<string, unknown>> {
  // 对齐上游 ClassificationRule：name 1..255、note_contains ≤500、金额 ≥0、
  // except_sync_ids ≤1000、tx_type 枚举
  optionalString(args.name, 'name', { minLength: 1, maxLength: 255 });
  optionalString(args.note_contains, 'note_contains', { maxLength: 500 });
  optionalNumber(args.min_amount, 'min_amount', { ge: 0 });
  optionalNumber(args.max_amount, 'max_amount', { ge: 0 });
  maxItems(args.except_sync_ids, 1000, 'except_sync_ids');
  enumValue(args.tx_type, ['income', 'expense'] as const, 'tx_type');
  const rule: ClassificationRule = {
    name: args.name,
    note_contains: args.note_contains ?? null,
    account_id: args.account_id ?? null,
    tx_type: args.tx_type ?? 'expense',
    min_amount: args.min_amount ?? null,
    max_amount: args.max_amount ?? null,
    category_id: args.category_id,
    tags: args.tags ?? null,
    except_sync_ids: args.except_sync_ids ?? [],
    enabled: args.enabled ?? true,
    confirmed: args.confirmed ?? false,
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

/** 规则第 index 次发生（UTC ISO；DST gap/policy=skip → null）。纯函数。 */
export function occurrence(data: Record<string, unknown>, index: number): string | null {
  const anchor = parseNaiveParts(data.anchor_local as string);
  const rule = data.rule as Record<string, unknown>;
  const interval = Number(rule.interval ?? 1) * index;
  let local: NaiveParts;
  if (rule.frequency === 'daily' || rule.frequency === 'weekly') {
    local = addDays(anchor, interval * (rule.frequency === 'weekly' ? 7 : 1));
  } else {
    const months = interval * (rule.frequency === 'yearly' ? 12 : 1);
    local = addMonths(anchor, months);
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
    const due = occurrence(data, i);
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

function occurrenceKey(recordId: string, dueUtc: Date): string {
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return `recurring:${recordId}:${p(dueUtc.getUTCFullYear(), 4)}${p(dueUtc.getUTCMonth() + 1)}${p(dueUtc.getUTCDate())}T${p(dueUtc.getUTCHours())}${p(dueUtc.getUTCMinutes())}${p(dueUtc.getUTCSeconds())}Z`;
}

export async function manageRecurringRule(
  c: McpContext,
  args: { action: 'create' | 'update' | 'pause' | 'resume' | 'delete'; ledger_id?: string | null; data?: RecurringRule | null; record_id?: string | null; expected_revision?: number | null; confirm?: boolean },
): Promise<Record<string, unknown>> {
  const { db, userId } = c;
  const ledger = await requireLedger(c, args.ledger_id!, { write: true });
  let previous: Record<string, unknown> | null = null;
  if (args.record_id) {
    const [row] = await loadRecord(c, args.record_id, { kind: 'recurring_rule', write: true });
    if (row.ledger_id !== ledger.id || row.user_id !== userId) {
      throw new Error('Only the schedule creator can manage its execution identity');
    }
    if (row.revision !== args.expected_revision) throw new Error('REVISION_CONFLICT: recurring rule changed');
    previous = row.data_json ? JSON.parse(row.data_json) as Record<string, unknown> : null;
    if (args.action === 'update' && row.next_due_at) {
      const key = occurrenceKey(row.id, new Date(row.next_due_at));
      const pending = await db.prepare(
        'SELECT * FROM mcp_write_operations WHERE user_id = ? AND request_key = ?'
      ).bind(row.user_id, key).first<{ id: string }>();
      if (pending) {
        return {
          status: 'operation_pending',
          operation_id: pending.id,
          message: 'Resume the original occurrence with run_due_recurring_rules before changing its schedule payload; pause/delete remain available',
        };
      }
    }
  } else if (args.action !== 'create') {
    throw new Error('record_id and expected_revision are required');
  }

  let payload: Record<string, unknown>;
  let index: number;
  let due: string | null;
  let state: string;
  if (args.action === 'create' || args.action === 'update') {
    const data = args.data;
    if (!data) throw new Error('data is required');
    // 对齐上游 RecurringRule：name 1..255、interval 1..365、dst_policy 枚举
    optionalString(data.name, 'name', { minLength: 1, maxLength: 255 });
    optionalInt(data.interval, 'interval', { ge: 1, le: 365 });
    enumValue(data.dst_policy, ['skip', 'first', 'second'] as const, 'dst_policy');
    enumValue(data.frequency, ['daily', 'weekly', 'monthly', 'yearly'] as const, 'frequency', { required: true });
    const tz = data.time_zone;
    const anchorUtc = parseDateBoundary(data.starts_at, { timeZone: tz }).getTime();
    // 校验完整交易契约（时间由 Cloud 提供）
    await prepareTransaction(c, ledger, { ...data.transaction, happened_at: new Date(anchorUtc).toISOString() });
    const rulePayload: Record<string, unknown> = {
      name: data.name,
      transaction: { ...data.transaction },
      frequency: data.frequency,
      interval: data.interval ?? 1,
      starts_at: data.starts_at,
      time_zone: data.time_zone,
      ends_at: data.ends_at ?? null,
      enabled: data.enabled ?? true,
      allow_backfill: data.allow_backfill ?? false,
      dst_policy: data.dst_policy ?? 'skip',
    };
    payload = {
      rule: rulePayload,
      anchor_local: zoneLocalIso(anchorUtc, tz),
      execution_owner: 'cloud',
      executed_count: (previous?.executed_count as number | undefined) ?? 0,
    };
    const sameSchedule = !!previous && ['frequency', 'interval', 'starts_at', 'time_zone', 'dst_policy']
      .every(key => (previous!.rule as Record<string, unknown>)[key] === (payload.rule as Record<string, unknown>)[key]);
    const startIndex = sameSchedule ? ((previous?.next_index as number | undefined) ?? 0) : 0;
    const earliest = data.allow_backfill || sameSchedule ? null : new Date().toISOString();
    const [nextIndex, nextDue] = nextOccurrence(payload, startIndex, earliest);
    index = nextIndex;
    due = nextDue;
    payload.next_index = index;
    state = (data.enabled ?? true) && due ? 'active' : due === null ? 'completed' : 'paused';
  } else {
    payload = { ...(previous ?? {}) };
    const [nextIndex, nextDue] = nextOccurrence(payload, (payload.next_index as number | undefined) ?? 0);
    index = nextIndex;
    due = nextDue;
    state = args.action === 'pause' ? 'paused'
      : args.action === 'resume' ? (due ? 'active' : 'completed')
      : 'deleted';
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
      execution_owner: 'cloud',
      backfill: (payload.rule as Record<string, unknown>).allow_backfill,
      dst_policy: (payload.rule as Record<string, unknown>).dst_policy,
      id: args.record_id ?? undefined,
      revision: args.expected_revision ?? undefined,
    };
  }
  const result = await saveRecord(c, ledger, {
    kind: 'recurring_rule',
    data: payload,
    record_id: args.record_id ?? null,
    expected_revision: args.expected_revision ?? null,
    status: state,
    next_due_at: due,
  });
  return { ...result, next_occurrences: preview };
}

export async function executeDueRules(
  c: McpContext,
  args: { now?: string | null; only_record_id?: string | null; limit?: number },
): Promise<Array<Record<string, unknown>>> {
  const db = c.db;
  const now = args.now ? new Date(args.now) : new Date();
  const limit = Math.max(1, Math.min(args.limit ?? 20, 100));
  let q = `SELECT * FROM mcp_state_records WHERE kind = 'recurring_rule' AND status = 'active' AND next_due_at <= ?`;
  const p: unknown[] = [now.toISOString()];
  if (args.only_record_id) { q += ' AND id = ?'; p.push(args.only_record_id); }
  q += ' ORDER BY next_due_at LIMIT ?';
  p.push(limit);
  const rules = await db.prepare(q).bind(...p).all<Record<string, unknown>>();
  const results: Array<Record<string, unknown>> = [];
  for (const row of rules.results) {
    try {
      const userId = String(row.user_id);
      // 按行用户构造上下文（对齐上游 execute_due_rules 用 row.user_id 重新鉴权）
      const rowCtx: McpContext = { ...c, userId };
      const ledger = await db.prepare('SELECT id, user_id, external_id, name, currency FROM ledgers WHERE id = ?')
        .bind(String(row.ledger_id)).first<LedgerInfo>();
      if (!ledger) continue;
      // 对齐上游 execute_due_rules：每次触发重新校验用户启用状态，禁用账号不再落账
      const owner = await db.prepare('SELECT * FROM users WHERE id = ?')
        .bind(userId).first<Record<string, unknown>>();
      if (owner && Number(owner.is_enabled ?? 1) === 0) continue;
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
      const outcome = await createTransactions(rowCtx, {
        ledger_id: ledger.external_id,
        transactions: [raw],
        idempotency_key: key,
      });
      results.push({ rule_id: row.id, due, operation: outcome });
      if (outcome.status !== 'created') continue;
      const [nextIndex, nextDue] = nextOccurrence(data, idx + 1);
      const updated = await db.prepare(
        `UPDATE mcp_state_records SET data_json = ?, next_due_at = ?, revision = revision + 1,
         status = ?, updated_at = ?
         WHERE id = ? AND revision = ? AND status = 'active' AND next_due_at = ?`
      ).bind(
        JSON.stringify({ ...data, next_index: nextIndex, executed_count: Number(data.executed_count ?? 0) + 1, last_operation_id: outcome.operation_id, last_due_at: due }),
        nextDue, nextDue ? 'active' : 'completed', new Date().toISOString(),
        String(row.id), Number(row.revision), due,
      ).run();
      if (updated.meta.changes === 0) {
        // 并发修改（例如暂停/编辑）：不覆盖，记录失败以允许重试
        results.push({ rule_id: row.id, status: 'failed', error_code: 'REVISION_CONFLICT' });
      }
    } catch (exc: unknown) {
      const code = exc instanceof Error ? exc.name : 'Error';
      results.push({ rule_id: row.id, status: 'failed', error_code: code });
    }
  }
  return results;
}

export async function runDueRecurringRules(c: McpContext, args: { ledger_id: string }): Promise<Record<string, unknown>> {
  const ledger = await requireLedger(c, args.ledger_id, { write: true });
  const rows = await c.db.prepare(
    `SELECT id FROM mcp_state_records WHERE ledger_id = ? AND user_id = ? AND kind = 'recurring_rule' AND status = 'active' LIMIT 100`
  ).bind(ledger.id, c.userId).all<{ id: string }>();
  const outcomes: Array<Record<string, unknown>> = [];
  for (const row of rows.results) {
    outcomes.push(...await executeDueRules(c, { only_record_id: row.id }));
  }
  return { results: outcomes };
}