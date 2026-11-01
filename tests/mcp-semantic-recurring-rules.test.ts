/**
 * MCP 语义差分（F 试点 #7）：runDueRecurringRules 的"周期规则执行"语义。
 *
 * 不依赖 golden，直接调 workers 工具 + 真实 write 路由（bindSelfCall），断言：
 *  1) 到期规则（allow_backfill + 过去 starts_at → 首期立即到期）执行后生成一笔交易，
 *     其 amount/note/happened_at 与规则模板一致（经 selfCall 真实落库到投影）
 *  2) 规则按 nextOccurrence 推进：next_index +1、executed_count +1、next_due_at 推进一天
 */
import { describe, expect, it } from 'vitest';
import { makeHarness, mcpCtx, seed, bindSelfCall, type Harness } from './mcp-harness';
import { setSelfCall } from '../src/mcp/transaction-service';
import { manageRecurringRule, runDueRecurringRules } from '../src/mcp/rule-tools';

function ctx(h: Harness) {
  return mcpCtx(h, 'u1');
}

describe('runDueRecurringRules 语义（到期执行/真实落账/规则推进）', () => {
  it('每日规则首期立即到期：执行生成 9.9 周期交易，并推进 next_index/executed_count/next_due_at', async () => {
    const h = makeHarness();
    seed(h);
    bindSelfCall(h, setSelfCall);

    const created = (await manageRecurringRule(ctx(h), {
      action: 'create', ledger_id: 'L1', confirm: true,
      data: {
        name: '每日咖啡', frequency: 'daily', interval: 1,
        starts_at: '2026-05-01T09:00:00Z', time_zone: 'UTC', allow_backfill: true,
        transaction: {
          amount: 9.9, tx_type: 'expense', category: '餐饮',
          account: '现金', note: '周期',
        },
      },
    })) as Record<string, unknown>;
    expect(created.status).toBe('active');

    const run = (await runDueRecurringRules(ctx(h), { ledger_id: 'L1' })) as Record<string, unknown>;
    expect((run.results as unknown[]).length).toBe(1);

    // 真实落库：投影里出现一笔 note='周期'、amount=9.9、发生于首期 2026-05-01 的交易
    const rows = await h.db.prepare(
      `SELECT amount, note, happened_at FROM read_tx_projection WHERE note = ?`,
    ).bind('周期').all<{ amount: number; note: string; happened_at: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0].amount).toBe(9.9);
    expect(rows.results[0].happened_at).toContain('2026-05-01');

    // 规则推进：next_index=1、executed_count=1、next_due_at 推后一天
    const rec = await h.db.prepare(
      `SELECT data_json, next_due_at FROM mcp_state_records WHERE kind = 'recurring_rule' AND status = 'active'`,
    ).first<{ data_json: string; next_due_at: string }>();
    const data = JSON.parse(rec!.data_json) as Record<string, unknown>;
    expect(data.next_index).toBe(1);
    expect(data.executed_count).toBe(1);
    expect(rec!.next_due_at).toContain('2026-05-02T09:00:00');
  });
});
