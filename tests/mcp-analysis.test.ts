/**
 * analyze_transactions 语义契约（对齐上游 analysis_tools.analyze_transactions）。
 *
 * 锁住几条容易漂的口径：金额区间校验、tag_ids 子集匹配、
 * 外币转账不混入 income/expense、group_by 本地日历分桶。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createLedger, makeHarness, mcpCtx, registerDevice, registerUser, type Harness } from './mcp-harness';
import { analyzeTransactions } from '../src/mcp/analysis-tools';

let h: Harness;

afterEach(() => { h?.sqlite.close(); });

function setup(currency = 'CNY'): ReturnType<typeof mcpCtx> {
  h = makeHarness();
  registerUser(h, 'u1', 'u1@example.com');
  registerDevice(h, 'u1');
  createLedger(h, 'u1', 'L1-i', 'L1', '主账本');
  h.sqlite.prepare('UPDATE ledgers SET currency = ? WHERE id = ?').run(currency, 'L1-i');
  return mcpCtx(h, 'u1');
}

function seedTx(
  syncId: string, happenedAt: string, txType: string, amount: number,
  extra: { native_amount?: number | null; currency_code?: string | null; tags?: string[] } = {},
): void {
  h.sqlite.prepare(
    `INSERT INTO read_tx_projection (ledger_id, sync_id, user_id, tx_type, amount, happened_at, note,
     category_sync_id, category_name, account_sync_id, account_name, from_account_sync_id, from_account_name,
     to_account_sync_id, to_account_name, tag_sync_ids_json, currency_code, native_amount,
     exclude_from_stats, exclude_from_budget)
     VALUES ('L1-i', ?, 'u1', ?, ?, ?, 'n', 'c1', '餐饮', 'a1', '现金', NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?)`,
  ).run(
    syncId, txType, amount, happenedAt,
    JSON.stringify(extra.tags ?? []),
    extra.currency_code ?? null,
    extra.native_amount ?? null,
    0, 0,
  );
}

describe('analyze_transactions 语义', () => {
  it('min_amount > max_amount → Invalid amount range', async () => {
    const c = setup();
    await expect(analyzeTransactions(c, {
      ledger_id: 'L1',
      filters: { min_amount: 100, max_amount: 10 },
    })).rejects.toThrow(/Invalid amount range/);
  });

  it('tag_ids 是子集匹配（两个标签都满足才命中）', async () => {
    const c = setup();
    seedTx('t1', '2026-05-01T10:00:00Z', 'expense', 10, { tags: ['a', 'b'] });
    seedTx('t2', '2026-05-01T10:00:00Z', 'expense', 20, { tags: ['a'] });
    const both = await analyzeTransactions(c, { ledger_id: 'L1', filters: { tag_ids: ['a', 'b'] } }) as {
      totals: { transaction_count: number; expense: number };
    };
    expect(both.totals.transaction_count).toBe(1);
    expect(both.totals.expense).toBe(10);
  });

  it('外币转账无 native_amount → 不计入 income/expense，只进 transfer_by_currency', async () => {
    const c = setup('CNY');
    seedTx('t1', '2026-05-01T10:00:00Z', 'transfer', 100, { currency_code: 'JPY', native_amount: null });
    seedTx('t2', '2026-05-01T10:00:00Z', 'expense', 30);
    const out = await analyzeTransactions(c, { ledger_id: 'L1' }) as {
      totals: { expense: number; transfer: number; transfer_by_currency: Record<string, number> };
    };
    expect(out.totals.expense).toBe(30);
    expect(out.totals.transfer).toBe(0);
    expect(out.totals.transfer_by_currency.JPY).toBe(100);
  });

  it('group_by=month 按 time_zone 的本地日历分桶', async () => {
    const c = setup();
    // UTC 2026-05-31T20:00Z → 上海时间 2026-06-01
    seedTx('t1', '2026-05-31T20:00:00Z', 'expense', 10);
    const sh = await analyzeTransactions(c, { ledger_id: 'L1', group_by: 'month', time_zone: 'Asia/Shanghai' }) as {
      groups: Array<{ key: string }>;
    };
    const utc = await analyzeTransactions(c, { ledger_id: 'L1', group_by: 'month', time_zone: 'UTC' }) as {
      groups: Array<{ key: string }>;
    };
    expect(sh.groups[0].key).toBe('2026-06');
    expect(utc.groups[0].key).toBe('2026-05');
  });
});
