/**
 * MCP 语义差分（F 试点 #3）：write-tools 的"运行时"语义（写后读回 / 零和转账 / 排除标记 / 幂等）。
 *
 * 与 read/analytics 试点不同，写路径经 selfCall 打到真实 write 路由（bindSelfCall），落库后回读。
 * 锁定的语义：
 *  1) 写后读回字段一致（amount/note/tx_type 原样落库）
 *  2) 转账是单条 transfer 行，余额 transfer_in/out 互抵 → 净财富不变（零和）
 *  3) write 传入 exclude_from_stats=true：被 analytics 排除、但计入余额
 *  4) 同 idempotency_key 重复提交：聚合只反映一笔（不重复计数）
 */
import { describe, expect, it } from 'vitest';
import { makeHarness, mcpCtx, seed, bindSelfCall, type Harness } from './mcp-harness';
import { setSelfCall } from '../src/mcp/transaction-service';
import { createTransaction } from '../src/mcp/tools/write-tools';
import { getTransaction, getAnalyticsSummary } from '../src/mcp/tools/read-tools';
import { getAccountBalances } from '../src/mcp/capability-tools';

function ctx(h: Harness) {
  return mcpCtx(h, 'u1');
}
function accountSlot(res: Record<string, unknown>, id: string): Record<string, unknown> {
  return (res.accounts as Array<Record<string, unknown>>).find((a) => a.account_id === id)!;
}
function cn(res: Record<string, unknown>): Record<string, { assets: number; liabilities: number; net_worth: number }> {
  return res.totals_by_currency as Record<string, { assets: number; liabilities: number; net_worth: number }>;
}

describe('write-tools 语义（写后读回 / 零和转账 / 排除标记 / 幂等）', () => {
  it('写后读回：amount/note/tx_type/category/account 原样落库', async () => {
    const h = makeHarness();
    seed(h);
    bindSelfCall(h, setSelfCall);
    const res = (await createTransaction(ctx(h), {
      amount: 50, tx_type: 'expense', category: '餐饮', account: '现金',
      note: '语义写回', happened_at: '2026-05-20T03:30:00Z', ledger_id: 'L1',
    })) as Record<string, unknown>;
    expect(res.status).toBe('created');
    const sid = String(res.sync_id);
    const tx = (await getTransaction(ctx(h), { sync_id: sid, ledger_id: 'L1' })) as Record<string, unknown> | null;
    expect(tx).not.toBeNull();
    expect(tx!.amount).toBe(50);
    expect(tx!.tx_type).toBe('expense');
    expect(tx!.note).toBe('语义写回');
    expect(String(tx!.category_name ?? tx!.category)).toBe('餐饮');
    expect(String(tx!.account_name ?? tx!.account)).toBe('现金');
  });

  it('零和转账：现金→招行 100 → a1.transfer_out=100, a2.transfer_in=100, 净财富不变(7792)', async () => {
    const h = makeHarness();
    seed(h);
    bindSelfCall(h, setSelfCall);
    const res = (await createTransaction(ctx(h), {
      amount: 100, tx_type: 'transfer', from_account: '现金', to_account: '招行',
      happened_at: '2026-05-20T03:30:00Z', ledger_id: 'L1',
    })) as Record<string, unknown>;
    expect(res.status).toBe('created');
    const bal = (await getAccountBalances(ctx(h), { ledger_id: 'L1' })) as Record<string, unknown>;
    expect(accountSlot(bal, 'a1').transfer_out).toBe(100);
    expect(accountSlot(bal, 'a2').transfer_in).toBe(100);
    // 转账是内部转移：净财富与写前一致（7792）
    expect(cn(bal).CNY.net_worth).toBeCloseTo(7792, 6);
  });

  it('write exclude_from_stats=true：analytics 排除(仍 101.53)，余额计入(a1 支出 208+500)', async () => {
    const h = makeHarness();
    seed(h);
    bindSelfCall(h, setSelfCall);
    await createTransaction(ctx(h), {
      amount: 500, tx_type: 'expense', category: '餐饮', account: '现金',
      exclude_from_stats: true, happened_at: '2026-05-20T03:30:00Z', ledger_id: 'L1',
    });
    const an = (await getAnalyticsSummary(ctx(h), {
      scope: 'month', period: '2026-05', ledger_id: 'L1', tz_offset_minutes: 0,
    })) as Record<string, unknown>;
    // 500 被 exclude_from_stats 排除 → 仍是 101.53
    expect(an.expense).toBeCloseTo(101.53, 6);
    const bal = (await getAccountBalances(ctx(h), { ledger_id: 'L1' })) as Record<string, unknown>;
    // 余额仍计入该笔（208 + 500）
    expect(accountSlot(bal, 'a1').expense).toBe(708);
  });

  it('同 idempotency_key 重复提交：聚合只反映一笔（a1 支出 208+50，非 208+100）', async () => {
    const h = makeHarness();
    seed(h);
    bindSelfCall(h, setSelfCall);
    const args = {
      amount: 50, tx_type: 'expense', category: '餐饮', account: '现金',
      note: '幂等', happened_at: '2026-05-20T03:30:00Z', ledger_id: 'L1',
      idempotency_key: 'idem-pilot-001',
    };
    await createTransaction(ctx(h), args);
    await createTransaction(ctx(h), args); // 重复提交
    const bal = (await getAccountBalances(ctx(h), { ledger_id: 'L1' })) as Record<string, unknown>;
    // 若幂等失效会重复计入 → 258 而非 308
    expect(accountSlot(bal, 'a1').expense).toBe(258);
  });
});
