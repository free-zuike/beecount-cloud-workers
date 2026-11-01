/**
 * MCP 语义差分（F 试点 #5）：get_net_worth_history 的"存量时序"语义。
 *
 * 不依赖 golden，直接调 workers 工具，断言从上游 asset_history.py 推导的精确结果。
 * 锁定的语义：
 *  1) 按月分桶（happened_at 归月）+ 缺失日历月用前值填充（余额是存量非流量）
 *  2) 不过滤 exclude_from_stats 标志（t4 的 100 计入净资产），且用 amount 原值（t6 USD 计 7.5，非 native 1.03）
 *  3) 多币种按各自币种计、base=CNY 时折算序列与其一致
 *  4) 与 analytics 故意不同：analytics 排除 t4 且 t6 用 native → balance=7898.47；history 含 t4 且原值 → 7792
 */
import { describe, expect, it } from 'vitest';
import { makeHarness, mcpCtx, seed, type Harness } from './mcp-harness';
import { getNetWorthHistory } from '../src/mcp/capability-tools';
import { getAnalyticsSummary } from '../src/mcp/tools/read-tools';

function ctx(h: Harness) {
  return mcpCtx(h, 'u1');
}

describe('get_net_worth_history 语义（存量时序/分桶/缺失月前值/exclude 不过滤/原值不换算）', () => {
  it('L1：首桶 2026-05、末桶当前月、每点 CNY net_worth=7792（含 t4、t6 原值 7.5）', async () => {
    const h = makeHarness();
    seed(h);
    const res = (await getNetWorthHistory(ctx(h), {
      ledger_id: 'L1', tz_offset_minutes: 0, base_currency: 'CNY',
    })) as Record<string, unknown>;
    expect(res.currency).toBe('CNY');
    expect(res.multi_currency).toBe(false);
    expect(res.conversion_complete).toBe(true);

    const series = res.series as Array<Record<string, unknown>>;
    const sc = res.series_by_currency as Array<Record<string, unknown>>;

    // 从 2026-05 到当前月（含）逐月，缺失月用前值填充
    const now = new Date();
    const endKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    let y = 2026, m = 5, count = 0;
    while (`${y}-${String(m).padStart(2, '0')}` <= endKey) {
      count++;
      m++;
      if (m > 12) { m = 1; y++; }
    }
    expect(series).toHaveLength(count);
    expect(sc).toHaveLength(count);
    expect(series[0].bucket).toBe('2026-05');
    expect(series[count - 1].bucket).toBe(endKey);

    // 全部交易都在 5 月 → 所有月份净财富相同 = -208 + 8000 = 7792
    for (const pt of series) {
      expect(pt.net_worth).toBe(7792);
      expect(pt.assets).toBe(7792);
      expect(pt.liabilities).toBe(0);
    }
    for (const pt of sc) {
      const cn = (pt.by_currency as Record<string, { net_worth: number }>).CNY;
      expect(cn.net_worth).toBe(7792);
    }
  });

  it('exclude_from_stats 不过滤历史（t4 计入）→ 7792，区别于 analytics 排除后的 7898.47', async () => {
    const h = makeHarness();
    seed(h);
    const hist = (await getNetWorthHistory(ctx(h), {
      ledger_id: 'L1', tz_offset_minutes: 0, base_currency: 'CNY',
    })) as Record<string, unknown>;
    const last = (hist.series as Array<Record<string, unknown>>).slice(-1)[0];
    // 若 history 错误地按 exclude_from_stats 过滤 t4，净资产会是 7892；实际应为 7792（含 t4）
    expect(last.net_worth).toBe(7792);

    const an = (await getAnalyticsSummary(ctx(h), {
      scope: 'month', period: '2026-05', ledger_id: 'L1', tz_offset_minutes: 0,
    })) as Record<string, unknown>;
    // analytics 排除 t4 + t6 用 native 1.03 → balance 7898.47；与 history 的 7792 形成工具间语义分歧（F 要锁死）
    expect(an.balance).toBeCloseTo(7898.47, 6);
  });
});
