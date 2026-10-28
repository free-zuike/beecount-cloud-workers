/**
 * 账户资产历史（对齐原版 src/mcp/asset_history.py）。
 * 按账户原始币种生成月度余额序列，折算 base 币种并标注缺失汇率；
 * 缺失日历月用前值填充（余额是存量而非流量）。
 */
import { revision as calcRevision } from './query-context';
import { listLiveLedgers } from './transaction-service';
import type { McpContext } from './types';

interface AccountRow {
  sync_id: string;
  user_id: string;
  name: string;
  account_type: string | null;
  currency: string | null;
  initial_balance: number | null;
}

interface TxRowLite {
  ledger_id: string;
  sync_id: string;
  tx_type: string;
  amount: number;
  happened_at: string;
  account_sync_id: string | null;
  from_account_sync_id: string | null;
  to_account_sync_id: string | null;
}

export async function history(
  c: McpContext,
  args: { ledger_id?: string | null; time_zone?: string | null; tz_offset_minutes?: number; base_currency?: string | null } = {},
): Promise<Record<string, unknown>> {
  const { db, userId } = c;
  const tzOffset = args.tz_offset_minutes ?? 0;
  if (!Number.isInteger(tzOffset) || tzOffset < -720 || tzOffset > 840) {
    throw new Error('Invalid timezone offset');
  }
  // 对齐上游 asset_history.history：给了 time_zone 就按该 IANA 时区归月（覆盖固定偏移）
  const timeZone = args.time_zone ?? null;
  if (timeZone) {
    try { new Intl.DateTimeFormat('en-US', { timeZone }); }
    catch { throw new Error(`Invalid IANA time zone: ${JSON.stringify(timeZone)}`); }
  }
  const ledgers = args.ledger_id
    ? [await requireLedgerLocal(c, args.ledger_id)]
    : (await listLiveLedgers(db, userId)).filter(l => l.user_id === userId);
  if (ledgers.length === 0) {
    return { ledgers: [], series: [], base_currency: null, revision: 0, coverage: {} };
  }
  const owners = [...new Set(ledgers.map(l => l.user_id))];
  const ownersSet = owners.length > 0 ? owners : [userId];
  const accPlaceholders = ownersSet.map(() => '?').join(',');
  const accounts = await db.prepare(
    `SELECT sync_id, user_id, name, account_type, currency, initial_balance
     FROM user_account_projection WHERE user_id IN (${accPlaceholders})`
  ).bind(...ownersSet).all<AccountRow>();
  const accountMap = new Map(accounts.results.map(a => [`${a.user_id}:${a.sync_id}`, a]));
  const balances = new Map<string, number>();
  for (const a of accounts.results) balances.set(`${a.user_id}:${a.sync_id}`, Number(a.initial_balance ?? 0));
  const currencies = new Set(accounts.results.map(a => (a.currency || 'CNY').toUpperCase()));

  const baselineOwner = ownersSet.length === 1 ? ownersSet[0] : userId;
  const ledgerPlaceholders = ledgers.map(() => '?').join(',');
  const txs = await db.prepare(
    `SELECT ledger_id, sync_id, tx_type, amount, happened_at, account_sync_id, from_account_sync_id, to_account_sync_id
     FROM read_tx_projection WHERE ledger_id IN (${ledgerPlaceholders})
     ORDER BY happened_at, sync_id`
  ).bind(...ledgers.map(l => l.id)).all<TxRowLite>();
  const baseRev = await calcRevision(db, ledgers.map(l => l.id), baselineOwner);

  const owner = ownersSet.length === 1 ? ownersSet[0] : userId;
  const profile = await db.prepare('SELECT primary_currency FROM user_profiles WHERE user_id = ?').bind(owner).first<{ primary_currency: string | null }>();
  const base = (args.base_currency || profile?.primary_currency || (currencies.size === 1 ? [...currencies][0] : '') || '').toUpperCase();

  // 汇率：base=1 + cache + override
  const rates: Record<string, number> = base ? { [base]: 1.0 } : {};
  if (base) {
    const cached = await db.prepare('SELECT payload_json FROM exchange_rate_cache WHERE base_currency = ?').bind(base).first<{ payload_json: string }>();
    if (cached?.payload_json) {
      try {
        const payload = JSON.parse(cached.payload_json) as Record<string, string>;
        for (const [cur, raw] of Object.entries(payload)) {
          const rate = parseFloat(raw);
          if (rate > 0) rates[cur.toUpperCase()] = 1.0 / rate;
        }
      } catch { /* ignore */ }
    }
    const overrides = await db.prepare(
      'SELECT quote_currency, rate FROM user_exchange_rate_projection WHERE user_id = ? AND base_currency = ?'
    ).bind(owner, base).all<{ quote_currency: string; rate: string }>();
    for (const o of overrides.results) {
      const rate = parseFloat(o.rate);
      if (rate > 0) rates[o.quote_currency.toUpperCase()] = rate;
    }
  }

  const ledgerOwners = new Map(ledgers.map(l => [l.id, l.user_id]));
  const rawSeries: Array<{ bucket: string; by_currency: Record<string, { assets: number; liabilities: number; net_worth: number }> }> = [];

  const snapshot = (bucket: string) => {
    const totals: Record<string, { assets: number; liabilities: number; net_worth: number }> = {};
    for (const [key, balance] of balances) {
      const account = accountMap.get(key);
      if (!account) continue;
      const cur = (account.currency || 'CNY').toUpperCase();
      const slot = totals[cur] ?? (totals[cur] = { assets: 0, liabilities: 0, net_worth: 0 });
      if (account.account_type === 'credit_card' || account.account_type === 'loan') {
        slot.assets += Math.max(0, balance);
        slot.liabilities += Math.max(0, -balance);
      } else {
        slot.assets += balance;
      }
      slot.net_worth = slot.assets - slot.liabilities;
    }
    rawSeries.push({ bucket, by_currency: totals });
  };

  let bucket: string | null = null;
  for (const tx of txs.results) {
    const current = monthOf(tx.happened_at, tzOffset, timeZone);
    if (bucket && current !== bucket) snapshot(bucket);
    const txOwner = ledgerOwners.get(tx.ledger_id);
    if (txOwner) {
      const amount = Number(tx.amount ?? 0);
      const effects: Array<[string | null, number]> = tx.tx_type === 'transfer'
        ? [[tx.from_account_sync_id, -amount], [tx.to_account_sync_id, amount]]
        : [[tx.account_sync_id, tx.tx_type === 'income' ? amount : -amount]];
      for (const [aid, delta] of effects) {
        if (!aid) continue;
        const key = `${txOwner}:${aid}`;
        if (balances.has(key)) balances.set(key, balances.get(key)! + delta);
      }
    }
    bucket = current;
  }
  snapshot(bucket ?? monthOf(new Date().toISOString(), tzOffset, timeZone));

  // 缺失月填充（前值）
  const sparse = new Map(rawSeries.map(item => [item.bucket, item]));
  const first = [...sparse.keys()].sort()[0];
  const nowBucket = monthOf(new Date().toISOString(), tzOffset, timeZone);
  const lastBucket = [nowBucket, ...sparse.keys()].sort().pop()!;
  const [fy, fm] = first.split('-').map(Number);
  const filled: Array<{ bucket: string; by_currency: Record<string, { assets: number; liabilities: number; net_worth: number }> }> = [];
  let previous: Record<string, { assets: number; liabilities: number; net_worth: number }> | null = null;
  let y = fy, m = fm;
  while (`${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}` <= lastBucket) {
    const key = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`;
    const item = sparse.get(key);
    if (item) previous = item.by_currency;
    filled.push({ bucket: key, by_currency: previous ?? {} });
    m++;
    if (m > 12) { m = 1; y++; }
  }

  // 按 base 折算（仅当全部币种都有汇率）
  let valued: Array<Record<string, unknown>> | null = null;
  if (base) {
    const missing = [...currencies].filter(cur => rates[cur] === undefined);
    if (missing.length === 0) {
      valued = filled.map(item => {
        let assets = 0, liabilities = 0;
        for (const [cur, slot] of Object.entries(item.by_currency)) {
          const rate = rates[cur.toUpperCase()] ?? 1;
          assets += slot.assets * rate;
          liabilities += slot.liabilities * rate;
        }
        return { bucket: item.bucket, assets, liabilities, net_worth: assets - liabilities };
      });
    }
  }

  const currenciesSorted = [...currencies].map(cur => cur.toUpperCase()).sort();
  const missingConversion = base
    ? currenciesSorted.filter(cur => rates[cur] === undefined)
    : currenciesSorted;

  // 对齐上游：计算期间数据变更 → REVISION_CONFLICT，避免给出不一致的资产负债序列
  if ((await calcRevision(db, ledgers.map(l => l.id), baselineOwner)) !== baseRev) {
    throw new Error('REVISION_CONFLICT: data changed during history calculation');
  }

  return {
    ledgers: ledgers.map(l => l.external_id),
    base_currency: base || null,
    multi_currency: currenciesSorted.length > 1,
    missing_conversion_currencies: missingConversion,
    conversion_coverage: base ? [...currencies].map(cur => ({ currency: cur.toUpperCase(), rate: rates[cur.toUpperCase()] ?? null })) : [],
    valued_in_base_currency: valued,
    series: valued ?? [],
    series_by_currency: filled.map(item => ({ ...item, bucket: item.bucket })),
    revision: baseRev,
    coverage: {
      ledger_ids: ledgers.map(l => l.external_id),
      partial: Boolean(args.ledger_id),
      scope: 'personal',
    },
  };
}

async function requireLedgerLocal(c: McpContext, ledgerId: string): Promise<{ id: string; user_id: string; external_id: string; name: string | null; currency: string | null }> {
  const ledgers = await listLiveLedgers(c.db, c.userId, ledgerId);
  if (ledgers.length === 0) throw new Error('Ledger not found');
  return ledgers[0];
}

/** 月份分桶：给了 time_zone 就按该时区真实日历（含 DST），否则按固定偏移 */
function monthOf(iso: string, tzOffsetMinutes: number, timeZone?: string | null): string {
  const d = new Date(iso);
  if (!timeZone) {
    const shifted = new Date(d.getTime() + tzOffsetMinutes * 60 * 1000);
    return `${String(shifted.getUTCFullYear()).padStart(4, '0')}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit',
  }).formatToParts(d);
  const y = parts.find(p => p.type === 'year')?.value ?? '1970';
  const m = parts.find(p => p.type === 'month')?.value ?? '01';
  return `${y}-${m}`;
}
