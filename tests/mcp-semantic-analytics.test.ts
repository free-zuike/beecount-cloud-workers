/**
 * MCP 语义差分（F 试点 #2）：get_analytics_summary 的"值级"聚合语义。
 *
 * 直接调 workers 工具，断言从上游 analysis_tools.py / read-tools.ts 推导出的精确数值，
 * 不依赖 golden。锁定两个最易"形状对、数值错"的口径：
 *  1) 金额用 COALESCE(native_amount, amount)（t6 是 USD，按 native 1.03 计，而非 amount 7.5）
 *  2) exclude_from_stats=True 的交易不计入（t4 的 100 被排除）
 */
import { describe, expect, it } from 'vitest';
import { makeHarness, mcpCtx, seed, type Harness } from './mcp-harness';
import { getAnalyticsSummary } from '../src/mcp/tools/read-tools';

function ctx(h: Harness) {
  return mcpCtx(h, 'u1');
}

describe('get_analytics_summary 语义（native 兜底 / exclude_from_stats 排除）', () => {
  it('period=2026-05：expense=101.53(含 native 兜底且排除 t4)、income=8000、count=6', async () => {
    const h = makeHarness();
    seed(h);
    const res = (await getAnalyticsSummary(ctx(h), {
      scope: 'month', period: '2026-05', ledger_id: 'L1', tz_offset_minutes: 0,
    })) as Record<string, unknown>;

    // t6(USD, native 1.03) 按 native 计入；t4(exclude_from_stats) 的 100 被排除：
    // 支出 = 38 + 12.5 + 20 + 1.03 + 30 = 101.53（若用 raw amount 会是 108；若含 t4 会是 201.53）
    expect(res.expense).toBeCloseTo(101.53, 6);
    expect(res.income).toBe(8000);
    expect(res.balance).toBeCloseTo(7898.47, 6); // 8000 - 101.53
    expect(res.transaction_count).toBe(6); // t1..t7 除 t4(excluded)
    expect(res.scope).toBe('month');

    // top_categories 的 expense 总和必须等于 expense 总额（无遗漏/无重复）
    const tops = res.top_categories as Array<{ name: string; total: number }>;
    const sum = tops.reduce((s, c) => s + c.total, 0);
    expect(sum).toBeCloseTo(101.53, 6);
  });

  it('period=2026-11（空月）：全部为 0，证明周期过滤生效（不退化成默认当前月）', async () => {
    const h = makeHarness();
    seed(h);
    const res = (await getAnalyticsSummary(ctx(h), {
      scope: 'month', period: '2026-11', ledger_id: 'L1', tz_offset_minutes: 0,
    })) as Record<string, unknown>;
    expect(res.income).toBe(0);
    expect(res.expense).toBe(0);
    expect(res.balance).toBe(0);
    expect(res.transaction_count).toBe(0);
  });
});
