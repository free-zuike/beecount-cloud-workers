/**
 * preview_import 本地行为测试（不进 golden、不污染写路径场景）。
 *
 * 上游把 preview_import 刻意移出 golden 差分（它会写 import_plan，污染写路径的 list_workflow_records 断言）。
 * 这里在本地直接调工具，覆盖其最关键的行为契约：
 *   1) 成功预览返回 plan + items，且仅落 import_plan 记录，绝不真正创建交易；
 *   2) 候选含重复 source → 报 DUPLICATE_SOURCE_IN_PLAN，plan 存为 needs_review，仍不写交易；
 *   3) action=skip 的候选保持 skip 状态且不写交易。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { makeHarness, mcpCtx, seed, type Harness } from './mcp-harness';
import { previewImport } from '../src/mcp/workflow-tools';

let h: Harness;

afterEach(() => h?.sqlite.close());

function setup(): ReturnType<typeof mcpCtx> {
  h = makeHarness();
  seed(h);
  return mcpCtx(h, 'u1');
}

function txCount(): number {
  const row = h.sqlite.prepare("SELECT COUNT(*) AS n FROM read_tx_projection WHERE ledger_id = 'L1-i'").get() as { n: number };
  return row.n;
}

function planCount(): number {
  const row = h.sqlite.prepare("SELECT COUNT(*) AS n FROM mcp_state_records WHERE kind = 'import_plan'").get() as { n: number };
  return row.n;
}

describe('preview_import 本地行为（不进 golden）', () => {
  it('成功预览：返回 plan + items，且仅落 import_plan、不创建交易', async () => {
    const c = setup();
    const before = txCount();
    const res = (await previewImport(c, {
      ledger_id: 'L1',
      candidates: [{
        transaction: { amount: 99.9, tx_type: 'expense', happened_at: '2026-06-01T00:00:00Z', category_id: 'c1', account_id: 'a1' },
      }],
    })) as any;

    expect(res.id).toBeTruthy();
    expect(typeof res.revision).toBe('number');
    expect(res.status).toBe('ready');
    expect(res.data.base_revision).toBeDefined();
    expect(Array.isArray(res.data.items)).toBe(true);
    expect(res.data.items.length).toBe(1);

    const item = res.data.items[0];
    expect(item.index).toBe(0);
    expect(item.status).toBe('ready');
    expect(res.data.ready).toBe(true);
    // 仅落 import_plan，绝不写交易
    expect(planCount()).toBe(1);
    expect(txCount()).toBe(before);
  });

  it('候选含重复 source → DUPLICATE_SOURCE_IN_PLAN，plan 存为 needs_review，仍不写交易', async () => {
    const c = setup();
    const before = txCount();
    const res = (await previewImport(c, {
      ledger_id: 'L1',
      candidates: [
        {
          transaction: { amount: 5, tx_type: 'expense', happened_at: '2026-06-02T00:00:00Z', category_id: 'c1', account_id: 'a1' },
          sources: [{ source_system: 'bank', source_id: 'dup' }],
        },
        {
          transaction: { amount: 6, tx_type: 'expense', happened_at: '2026-06-03T00:00:00Z', category_id: 'c1', account_id: 'a1' },
          sources: [{ source_system: 'bank', source_id: 'dup' }],
        },
      ],
    })) as any;

    expect(res.data.errors.some((e: any) => e.code === 'DUPLICATE_SOURCE_IN_PLAN')).toBe(true);
    expect(res.data.ready).toBe(false);
    expect(res.status).toBe('needs_review');
    expect(planCount()).toBe(1);
    expect(txCount()).toBe(before);
  });

  it('action=skip 的候选保持 skip 状态且不写交易', async () => {
    const c = setup();
    const before = txCount();
    const res = (await previewImport(c, {
      ledger_id: 'L1',
      candidates: [{
        action: 'skip',
        transaction: { amount: 7, tx_type: 'expense', happened_at: '2026-06-04T00:00:00Z', category_id: 'c1', account_id: 'a1' },
      }],
    })) as any;

    expect(res.data.items[0].status).toBe('skip');
    expect(planCount()).toBe(1);
    expect(txCount()).toBe(before);
  });
});
