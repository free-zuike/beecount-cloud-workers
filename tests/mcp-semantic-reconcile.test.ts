/**
 * MCP 语义差分（F 试点 #6）：reconcile_account 的"对账匹配"语义。
 *
 * 不依赖 golden，直接调 workers 工具，断言从上游 workflow_tools.py 推导的精确结果。
 * 锁定：calculated_balance 取自余额聚合（与 get_account_balances 一致）、对账阈值 0.005、
 * cutoff_exclusive 格式（无毫秒 +00:00 对齐上游 isoformat）、无孤立交易候选。
 */
import { describe, expect, it } from 'vitest';
import { makeHarness, mcpCtx, seed, type Harness } from './mcp-harness';
import { reconcileAccount } from '../src/mcp/workflow-tools';

function ctx(h: Harness) {
  return mcpCtx(h, 'u1');
}

describe('reconcile_account 语义（对账匹配/余额校验/时间戳格式）', () => {
  // a1(现金) 在 2026-06-01 排他边界下含全部 5 月交易 → 计算余额 = -208
  const at = '2026-06-01T00:00:00Z';

  it('a1 计算余额=-208：actual=-208 成功；actual=-200 失败(差8)；actual=-208.004 仍阈值内', async () => {
    const h = makeHarness();
    seed(h);
    const ok = (await reconcileAccount(ctx(h), {
      ledger_id: 'L1', account_id: 'a1', at, actual_balance: -208,
    })) as Record<string, unknown>;
    expect(ok.calculated_balance).toBe(-208);
    expect(ok.difference).toBe(0);
    expect(ok.reconciled).toBe(true);

    const bad = (await reconcileAccount(ctx(h), {
      ledger_id: 'L1', account_id: 'a1', at, actual_balance: -200,
    })) as Record<string, unknown>;
    expect(bad.calculated_balance).toBe(-208);
    expect(bad.difference).toBe(8);
    expect(bad.reconciled).toBe(false);

    const near = (await reconcileAccount(ctx(h), {
      ledger_id: 'L1', account_id: 'a1', at, actual_balance: -208.004,
    })) as Record<string, unknown>;
    expect(near.reconciled).toBe(true); // |−0.004| < 0.005
  });

  it('cutoff_exclusive 格式：无毫秒、+00:00 结尾（对齐上游 isoformat）', async () => {
    const h = makeHarness();
    seed(h);
    const r = (await reconcileAccount(ctx(h), {
      ledger_id: 'L1', account_id: 'a1', at, actual_balance: -208,
    })) as Record<string, unknown>;
    expect(String(r.cutoff_exclusive)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/);
  });

  it('无孤立交易：unassigned_candidates 为空（种子交易都有关联账户）', async () => {
    const h = makeHarness();
    seed(h);
    const r = (await reconcileAccount(ctx(h), {
      ledger_id: 'L1', account_id: 'a1', at, actual_balance: -208,
    })) as Record<string, unknown>;
    expect((r.unassigned_candidates as unknown[]).length).toBe(0);
  });
});
