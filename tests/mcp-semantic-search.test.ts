/**
 * MCP 语义差分（F 试点 #4）：search 的"跨字段模糊匹配 + 空查询守卫 + limit 钳制"。
 *
 * 不依赖 golden，直接调 workers search 工具，断言从种子数据推导的精确结果。
 * 锁定：空查询返回 []（不退化成"最近 N 笔"）、note/account/category 三类字段都能命中、
 * limit 越界被钳制到 [1,100]。
 */
import { describe, expect, it } from 'vitest';
import { makeHarness, mcpCtx, seed, type Harness } from './mcp-harness';
import { search } from '../src/mcp/tools/read-tools';

function ctx(h: Harness) {
  return mcpCtx(h, 'u1');
}
function ids(rows: Array<Record<string, unknown>>): string[] {
  return rows.map((r) => String(r.sync_id ?? r.id));
}

describe('search 语义（跨字段匹配 / 空查询守卫 / limit 钳制）', () => {
  it('空查询（含纯空白）返回 []，不退化成"最近 N 笔"', async () => {
    const h = makeHarness();
    seed(h);
    expect(await search(ctx(h), { q: '' })).toEqual([]);
    expect(await search(ctx(h), { q: '   ' })).toEqual([]);
  });

  it('note 匹配：星巴克 → 仅 t1', async () => {
    const h = makeHarness();
    seed(h);
    const rows = await search(ctx(h), { q: '星巴克' });
    expect(rows).toHaveLength(1);
    expect(ids(rows)).toEqual(['t1']);
  });

  it('account 匹配：现金 → t1,t2,t4,t5,t6,t7（不含 a2 的 t3）', async () => {
    const h = makeHarness();
    seed(h);
    const rows = await search(ctx(h), { q: '现金' });
    expect(rows).toHaveLength(6);
    expect(new Set(ids(rows))).toEqual(new Set(['t1', 't2', 't4', 't5', 't6', 't7']));
    expect(ids(rows)).not.toContain('t3');
  });

  it('category 匹配：餐饮 → t1,t2,t4,t5,t7（5 笔）', async () => {
    const h = makeHarness();
    seed(h);
    const rows = await search(ctx(h), { q: '餐饮' });
    expect(rows).toHaveLength(5);
    expect(new Set(ids(rows))).toEqual(new Set(['t1', 't2', 't4', 't5', 't7']));
  });

  it('limit 越界钳制：limit=0 → 返回 1 条（钳制下限 1）', async () => {
    const h = makeHarness();
    seed(h);
    const rows = await search(ctx(h), { q: '现金', limit: 0 });
    expect(rows).toHaveLength(1);
  });
});
