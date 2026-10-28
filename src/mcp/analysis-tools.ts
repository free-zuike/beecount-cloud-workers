/**
 * 组合聚合分析工具（对齐原版 src/mcp/analysis_tools.py，#133）。
 *
 * - 金额口径：优先 native_amount（账本结算币），否则 amount
 * - transfer 单独统计：transfer_by_currency 保留原始币金额；本币小计仅含
 *   「已知基础币」的转账（外币无 native_amount 时记 0，绝不混入 income/expense）
 * - 分组：day/week/month 按查询时区本地日历；tag 分组可重叠
 * - comparison：同一查询跑两个 filter，输出差值
 */
import { requireLedger } from './capability-tools';
import { revision, parseDateBoundary } from './query-context';
import { listLiveLedgers } from './transaction-service';
import type { McpContext } from './types';

export interface TransactionFilter {
  date_from?: string | null;
  date_to?: string | null;
  tx_type?: 'income' | 'expense' | 'transfer' | null;
  category_ids?: string[];
  account_ids?: string[];
  tag_ids?: string[];
  member_user_ids?: string[];
  note_contains?: string | null;
  min_amount?: number | null;
  max_amount?: number | null;
  include_excluded?: boolean;
}

interface AnalyzeArgs {
  ledger_id: string;
  filters?: TransactionFilter | null;
  group_by?: 'none' | 'day' | 'week' | 'month' | 'category' | 'account' | 'tag' | 'member' | 'type';
  time_zone?: string | null;
  comparison?: TransactionFilter | null;
  top_n?: number;
}

function conditionsSql(filters: TransactionFilter, ledgerId: string, tz: string): { sql: string; params: unknown[] } {
  let sql = ' WHERE ledger_id = ?';
  const params: unknown[] = [ledgerId];
  if (filters.date_from) {
    sql += ' AND happened_at >= ?';
    params.push(parseDateBoundary(filters.date_from, { timeZone: tz }).toISOString());
  }
  if (filters.date_to) {
    sql += ' AND happened_at < ?';
    params.push(parseDateBoundary(filters.date_to, { end: true, timeZone: tz }).toISOString());
  }
  if (filters.tx_type) { sql += ' AND tx_type = ?'; params.push(filters.tx_type); }
  if (filters.category_ids && filters.category_ids.length > 0) {
    const ph = filters.category_ids.map(() => '?').join(',');
    sql += ` AND category_sync_id IN (${ph})`;
    params.push(...filters.category_ids);
  }
  if (filters.account_ids && filters.account_ids.length > 0) {
    const ph = filters.account_ids.map(() => '?').join(',');
    sql += ` AND (account_sync_id IN (${ph}) OR from_account_sync_id IN (${ph}) OR to_account_sync_id IN (${ph}))`;
    params.push(...filters.account_ids, ...filters.account_ids, ...filters.account_ids);
  }
  if (filters.member_user_ids && filters.member_user_ids.length > 0) {
    const ph = filters.member_user_ids.map(() => '?').join(',');
    sql += ` AND created_by_user_id IN (${ph})`;
    params.push(...filters.member_user_ids);
  }
  if (filters.note_contains) {
    const escaped = filters.note_contains.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    sql += ' AND note LIKE ? ESCAPE ?';
    params.push(`%${escaped}%`, '\\');
  }
  if (filters.min_amount !== null && filters.min_amount !== undefined) { sql += ' AND amount >= ?'; params.push(filters.min_amount); }
  if (filters.max_amount !== null && filters.max_amount !== undefined) { sql += ' AND amount <= ?'; params.push(filters.max_amount); }
  // 对齐上游 analysis_tools._apply_filters：exclude_from_stats is False（NULL 视为计入，与本地口径相反）
  if (!filters.include_excluded) sql += ' AND exclude_from_stats = 0';
  return { sql, params };
}

interface TxRowLike {
  sync_id: string;
  ledger_id: string;
  tx_type: string;
  amount: number;
  happened_at: string;
  note: string | null;
  category_sync_id: string | null;
  category_name: string | null;
  account_sync_id: string | null;
  from_account_sync_id: string | null;
  created_by_user_id: string | null;
  tag_sync_ids_json: string | null;
  currency_code: string | null;
  native_amount: number | null;
}

function localParts(utcIso: string, tz: string): { y: number; m: number; d: number; h: number; mi: number; s: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(utcIso)).map(p => [p.type, p.value]));
  return { y: +parts.year, m: +parts.month, d: +parts.day, h: +parts.hour, mi: +parts.minute, s: +parts.second };
}

function localIso(utcIso: string, tz: string): string {
  const p = localParts(utcIso, tz);
  const pad = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${pad(p.y, 4)}-${pad(p.m)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}${tzOffsetSuffix(tz, utcIso)}`;
}

function tzOffsetSuffix(tz: string, utcIso: string): string {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset', hour12: false });
  const name = fmt.formatToParts(new Date(utcIso)).find(p => p.type === 'timeZoneName')?.value ?? '';
  const m = name.match(/([+-]\d{2}):?(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : 'Z';
}

function isoWeekKey(d: Date): string {
  const dayNum = d.getUTCDay() || 7;
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 4 - dayNum));
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((thursday.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${String(thursday.getUTCFullYear()).padStart(4, '0')}-W${String(weekNo).padStart(2, '0')}`;
}

export async function analyzeTransactions(c: McpContext, args: AnalyzeArgs): Promise<Record<string, unknown>> {
  const { db, userId } = c;
  const filters: TransactionFilter = args.filters ?? {};
  const groupBy = args.group_by ?? 'month';
  const tz = args.time_zone || 'UTC';
  const topN = Math.max(1, Math.min(args.top_n ?? 100, 500));
  if ((filters.min_amount ?? null) !== null && (filters.max_amount ?? null) !== null && filters.min_amount! > filters.max_amount!) {
    throw new Error('Invalid amount range');
  }
  const ledger = await requireLedger(c, args.ledger_id);
  const baseline = await revision(db, [ledger.id], ledger.user_id);
  const accRows = await db.prepare('SELECT sync_id, currency FROM user_account_projection WHERE user_id = ?')
    .bind(ledger.user_id).all<{ sync_id: string; currency: string | null }>();
  const accountCurrencies = new Map(accRows.results.map(r => [r.sync_id, r.currency]));

  const collect = async (criteria: TransactionFilter): Promise<Record<string, unknown>> => {
    const cond = conditionsSql(criteria, ledger.id, tz);
    let sql = `SELECT * FROM read_tx_projection${cond.sql} ORDER BY happened_at, sync_id`;
    let rows = (await db.prepare(sql).bind(...cond.params).all<TxRowLike>()).results;
    if (criteria.tag_ids && criteria.tag_ids.length > 0) {
      rows = rows.filter(row => {
        let ids: string[] = [];
        try { ids = JSON.parse(row.tag_sync_ids_json || '[]'); } catch { ids = []; }
        return criteria.tag_ids!.every(id => ids.includes(id));
      });
    }
    const totals: Record<string, unknown> = { income: 0, expense: 0, transfer: 0, transaction_count: rows.length, transfer_by_currency: {} as Record<string, number> };
    const groups = new Map<string, Record<string, unknown>>();
    let first: string | null = null;
    let last: string | null = null;
    for (const row of rows) {
      let amount = row.native_amount !== null && row.native_amount !== undefined ? Number(row.native_amount) : Number(row.amount || 0);
      const transferCurrency = String(
        row.currency_code || accountCurrencies.get(row.from_account_sync_id ?? '') || ledger.currency || 'CNY',
      );
      if (row.tx_type === 'transfer') {
        const tbc = totals.transfer_by_currency as Record<string, number>;
        tbc[transferCurrency] = (tbc[transferCurrency] ?? 0) + Number(row.amount || 0);
        if (transferCurrency !== (ledger.currency || 'CNY').toUpperCase() && row.native_amount === null) {
          amount = 0;
        }
      }
      if (row.tx_type === 'income' || row.tx_type === 'expense' || row.tx_type === 'transfer') {
        totals[row.tx_type] = Number(totals[row.tx_type]) + amount;
      }
      const local = localParts(row.happened_at, tz);
      const localDate = new Date(Date.UTC(local.y, local.m - 1, local.d, local.h, local.mi, local.s));
      const localIsoStr = localIso(row.happened_at, tz);
      first = first || localIsoStr;
      last = localIsoStr;
      let keys: string[];
      if (groupBy === 'day') keys = [`${String(local.y).padStart(4, '0')}-${String(local.m).padStart(2, '0')}-${String(local.d).padStart(2, '0')}`];
      else if (groupBy === 'week') keys = [isoWeekKey(localDate)];
      else if (groupBy === 'month') keys = [`${String(local.y).padStart(4, '0')}-${String(local.m).padStart(2, '0')}`];
      else if (groupBy === 'category') keys = [row.category_sync_id || '(uncategorized)'];
      else if (groupBy === 'account') keys = [row.account_sync_id || row.from_account_sync_id || '(unassigned)'];
      else if (groupBy === 'tag') {
        let tagIds: string[] = [];
        try { tagIds = JSON.parse(row.tag_sync_ids_json || '[]'); } catch { tagIds = []; }
        keys = tagIds.length > 0 ? tagIds : ['(untagged)'];
      } else if (groupBy === 'member') keys = [row.created_by_user_id || ledger.user_id];
      else if (groupBy === 'type') keys = [row.tx_type];
      else keys = ['all'];
      for (const key of keys) {
        let slot = groups.get(key);
        if (!slot) {
          slot = {
            key,
            income: 0, expense: 0, transfer: 0, transfer_by_currency: {} as Record<string, number>,
            transaction_count: 0, sample_sync_ids: [] as string[],
            category_name: groupBy === 'category' ? row.category_name : null,
          };
          groups.set(key, slot);
        }
        slot.transaction_count = Number(slot.transaction_count) + 1;
        if (row.tx_type === 'transfer') {
          const sbc = slot.transfer_by_currency as Record<string, number>;
          sbc[transferCurrency] = (sbc[transferCurrency] ?? 0) + Number(row.amount || 0);
        }
        if (row.tx_type === 'income' || row.tx_type === 'expense' || row.tx_type === 'transfer') {
          slot[row.tx_type] = Number(slot[row.tx_type]) + amount;
        }
        const samples = slot.sample_sync_ids as string[];
        if (samples.length < 10) samples.push(row.sync_id);
      }
    }
    totals.balance = Number(totals.income) - Number(totals.expense);
    const values = [...groups.values()];
    if (['day', 'week', 'month'].includes(groupBy)) {
      values.sort((a, b) => String(a.key).localeCompare(String(b.key)));
    } else {
      values.sort((a, b) => (Number(b.expense) - Number(a.expense)) || String(a.key).localeCompare(String(b.key)));
    }
    return {
      totals,
      groups: values.slice(0, topN),
      total_groups: groups.size,
      groups_truncated: values.length > topN,
      recorded_coverage: {
        first_transaction: first,
        last_transaction: last,
        completeness: 'Only recorded data; source/checkpoint coverage is separate',
      },
    };
  };

  const result = await collect(filters);
  if (args.comparison) {
    const other = await collect(args.comparison);
    result.comparison = other;
    result.difference = {};
    for (const key of ['income', 'expense', 'balance', 'transfer', 'transaction_count']) {
      (result.difference as Record<string, number>)[key] = Number((result.totals as Record<string, unknown>)[key]) - Number((other.totals as Record<string, unknown>)[key]);
    }
  }
  if (await revision(db, [ledger.id], ledger.user_id) !== baseline) {
    throw new Error('REVISION_CONFLICT: data changed during analysis; retry');
  }
  return {
    ...result,
    ledger_id: args.ledger_id,
    currency: ledger.currency,
    revision: baseline,
    filters: filters,
    time_zone: tz,
    group_by: groupBy,
    calculation: {
      amount: 'native_amount or amount in ledger base currency',
      transfer: 'excluded from income/expense; transfer numeric subtotal includes known base-currency amounts only, transfer_by_currency preserves every original amount',
      refunds: 'no automatic pairing or netting across months',
      tag_groups: 'overlap when a transaction has several tags',
      date_to: 'local dates inclusive; timestamp boundaries exclusive',
    },
    drill_down: {
      tool: 'list_transactions',
      ledger_id: args.ledger_id,
      date_from: filters.date_from ?? null,
      date_to: filters.date_to ?? null,
      time_zone: tz,
      revision: baseline,
    },
  };
}