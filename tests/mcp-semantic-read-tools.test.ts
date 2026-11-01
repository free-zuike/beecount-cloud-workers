/**
 * MCP 语义差分（F 试点）：不依赖 golden，直接断言"数值/聚合"层面的正确语义。
 *
 * 目的：现有 7 个差分套件以 golden 调用矩阵为主，覆盖形状/已知输出；本文件补一层
 * "值级"护栏——把上游 src/mcp/tools/read_tools.py / capability_tools.py 的实现语义
 * 推导成期望值，断言 workers 同款实现给出相同结果。任一语义回归（排序、分页游标、
 * 计数、日期边界、exclude 标志、余额公式、at 排他、多币种不换算）都会本地红。
 *
 * 夹具复用 mcp-harness.seed()（与 upstream_dump.py 同种子）。
 */
import { describe, expect, it } from 'vitest';
import { makeHarness, mcpCtx, seed, type Harness } from './mcp-harness';
import { listTransactions } from '../src/mcp/tools/read-tools';
import { getAccountBalances } from '../src/mcp/capability-tools';

function ctx(h: Harness) {
  return mcpCtx(h, 'u1');
}

function ids(items: Array<Record<string, unknown>>): string[] {
  return items.map((i) => String(i.sync_id ?? i.id));
}

function accountSlot(res: Record<string, unknown>, accountId: string): Record<string, unknown> {
  const accounts = res.accounts as Array<Record<string, unknown>>;
  const slot = accounts.find((a) => a.account_id === accountId);
  if (!slot) throw new Error(`account ${accountId} not in balances result`);
  return slot;
}

describe('list_transactions 语义（排序/分页/计数/过滤/exclude）', () => {
  it('默认列表：total=7，happened_at DESC + sync_id DESC 排序，且 exclude 标志不过滤', async () => {
    const h = makeHarness();
    seed(h);
    const res = (await listTransactions(ctx(h), { ledger_id: 'L1' })) as Record<string, unknown>;
    expect(res.total).toBe(7);
    expect(res.has_more).toBe(false);
    const items = res.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(7);
    // 同刻 t1/t2 用 sync_id DESC 兜底；t7..t1 全局降序
    expect(ids(items)).toEqual(['t7', 't6', 't5', 't4', 't3', 't2', 't1']);
    // exclude_from_stats=t4、exclude_from_budget=t5 不应被列表过滤掉（上游 list 不过滤）
    expect(ids(items)).toContain('t4');
    expect(ids(items)).toContain('t5');
  });

  it('分页：limit=2 游标稳定推进，最后一页 has_more=false', async () => {
    const h = makeHarness();
    seed(h);
    const c = ctx(h);
    let cursor: string | null = null;
    const pages: string[][] = [];
    for (let p = 0; p < 4; p++) {
      const res = (await listTransactions(c, { ledger_id: 'L1', limit: 2, cursor })) as Record<string, unknown>;
      const items = res.items as Array<Record<string, unknown>>;
      pages.push(ids(items));
      cursor = (res.next_cursor as string) ?? null;
      if (!res.has_more) break;
    }
    // 7 条 / 每页 2 → [t7,t6],[t5,t4],[t3,t2],[t1]
    expect(pages).toEqual([['t7', 't6'], ['t5', 't4'], ['t3', 't2'], ['t1']]);
    expect(pages.flat()).toEqual(['t7', 't6', 't5', 't4', 't3', 't2', 't1']);
  });

  it('日期区间：date_from=2026-05-11 含、date_to=2026-05-12 不含 → 命中 t4/t5', async () => {
    const h = makeHarness();
    seed(h);
    const res = (await listTransactions(ctx(h), {
      ledger_id: 'L1', date_from: '2026-05-11', date_to: '2026-05-12',
    })) as Record<string, unknown>;
    expect(res.total).toBe(2);
    expect(ids(res.items as Array<Record<string, unknown>>)).toEqual(['t5', 't4']);
  });

  it('tx_type=income 仅命中 t3', async () => {
    const h = makeHarness();
    seed(h);
    const res = (await listTransactions(ctx(h), { ledger_id: 'L1', tx_type: 'income' })) as Record<string, unknown>;
    expect(res.total).toBe(1);
    expect(ids(res.items as Array<Record<string, unknown>>)).toEqual(['t3']);
  });

  it('account=现金 命中全部记到 a1 的交易（6 条，不含 t3）', async () => {
    const h = makeHarness();
    seed(h);
    const res = (await listTransactions(ctx(h), { ledger_id: 'L1', account: '现金' })) as Record<string, unknown>;
    expect(res.total).toBe(6);
    const got = ids(res.items as Array<Record<string, unknown>>);
    expect(got).toContain('t1');
    expect(got).toContain('t7');
    expect(got).not.toContain('t3');
  });

  it('min/max 按 abs(amount) 过滤：20≤|amt|≤100 → t1,t4,t5,t7', async () => {
    const h = makeHarness();
    seed(h);
    const res = (await listTransactions(ctx(h), {
      ledger_id: 'L1', min_amount: 20, max_amount: 100,
    })) as Record<string, unknown>;
    expect(res.total).toBe(4);
    expect(ids(res.items as Array<Record<string, unknown>>)).toEqual(['t7', 't5', 't4', 't1']);
  });
});

describe('get_account_balances 语义（余额公式/at 排他/多币种不换算/exclude 忽略）', () => {
  it('全量：a1 支出=208→余额-208；a2 收入=8000→余额 8000；CNY net_worth=7792', async () => {
    const h = makeHarness();
    seed(h);
    const res = (await getAccountBalances(ctx(h), { ledger_id: 'L1' })) as Record<string, unknown>;
    const a1 = accountSlot(res, 'a1');
    const a2 = accountSlot(res, 'a2');
    // 种子 a1 承担 t1(38)+t2(12.5)+t4(100)+t5(20)+t6(7.5,USD 原值计入)+t7(30)=208 支出
    expect(a1.income).toBe(0);
    expect(a1.expense).toBe(208);
    expect(a1.transfer_in).toBe(0);
    expect(a1.transfer_out).toBe(0);
    expect(a1.balance).toBe(-208);
    // a2 仅 t3 收入 8000；t6 虽币种 USD 仍按 amount 原值计入 a1，不在此
    expect(a2.income).toBe(8000);
    expect(a2.expense).toBe(0);
    expect(a2.balance).toBe(8000);
    const cn = (res.totals_by_currency as Record<string, Record<string, number>>).CNY;
    expect(cn.assets).toBe(7792); // -208 + 8000
    expect(cn.liabilities).toBe(0);
    expect(cn.net_worth).toBe(7792);
  });

  it('at=2026-05-02T23:59:59Z 排他：仅含 05-02 当天 t1/t2 → a1 支出=50.5', async () => {
    const h = makeHarness();
    seed(h);
    const res = (await getAccountBalances(ctx(h), { ledger_id: 'L1', at: '2026-05-02T23:59:59Z' })) as Record<string, unknown>;
    const a1 = accountSlot(res, 'a1');
    const a2 = accountSlot(res, 'a2');
    expect(a1.expense).toBeCloseTo(50.5, 6); // 38 + 12.5
    expect(a1.balance).toBeCloseTo(-50.5, 6);
    expect(a2.income).toBe(0); // t3 在 05-10，被 at 排除
    expect(a2.balance).toBe(0);
    const cn = (res.totals_by_currency as Record<string, Record<string, number>>).CNY;
    // t3(05-10, +8000) 被 at 排除 → a2 收入 0 → 仅 a1 的 -50.5 计入
    expect(cn.net_worth).toBeCloseTo(-50.5, 6);
  });

  it('无 ledger_id + personal 作用域：与 L1 同值（L3 为空账本不贡献）', async () => {
    const h = makeHarness();
    seed(h);
    const res = (await getAccountBalances(ctx(h), {})) as Record<string, unknown>;
    expect(accountSlot(res, 'a1').balance).toBe(-208);
    expect(accountSlot(res, 'a2').balance).toBe(8000);
    const cn = (res.totals_by_currency as Record<string, Record<string, number>>).CNY;
    expect(cn.net_worth).toBe(7792);
  });

  it('排除标志不影响余额：t4(exclude_from_stats) 与 t5(exclude_from_budget) 仍计入 a1 支出', async () => {
    const h = makeHarness();
    seed(h);
    const res = (await getAccountBalances(ctx(h), { ledger_id: 'L1' })) as Record<string, unknown>;
    // 若 workers 错误地把 exclude_from_stats/budget 当余额过滤，a1 支出会 < 208
    expect(accountSlot(res, 'a1').expense).toBe(208);
  });
});
