/**
 * REST 只读计算的差分测试：本地 read/summary 路由 vs 上游 Python 实现的 golden。
 *
 * golden 由 scripts/parity/upstream_dump.py 额外产出（upstream-rest-golden.json），
 * 调用上游 routers/read 里的 get_summary / list_budgets_usage / list_exchange_rate_overrides。
 * 本地侧用 buildReadApp() 挂载真实 read + summary 路由，发 HTTP 请求比对完整 JSON。
 *
 * 为什么重要：workers 在 routes/summary.ts / routes/read.ts 里**独立重写**了这些统计 SQL，
 * 带"对齐上游"注释——正是 MCP 层那几类早期错误对齐最易重演的地方，且此前无任何测试盯着。
 *
 * 文件缺失时 skip（见 parity.yml 先生成再测试）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildReadApp, makeHarness, seed, type Harness } from './mcp-harness';
import { diffJson, formatDiffs, normalize, type Json } from './parity-compare';

const GOLDEN_PATH = join(process.cwd(), 'tests/fixtures/upstream-rest-golden.json');

interface RestCase { tool: string; args: Record<string, unknown>; result?: Json; error?: string }

const hasGolden = existsSync(GOLDEN_PATH);
const golden: { cases: RestCase[] } = hasGolden
  ? JSON.parse(readFileSync(GOLDEN_PATH, 'utf-8'))
  : { cases: [] };

/** 这些返回数组：exchange-rate-overrides、budgets/usage 的项顺序非契约，按多重集合比。 */
const ORDER_UNDEFINED = new Set(['list_exchange_rate_overrides', 'list_budgets_usage']);

function sortTop(value: Json): Json {
  if (!Array.isArray(value)) return value;
  const key = (v: Json) => JSON.stringify(v);
  return [...value].sort((a, b) => key(a).localeCompare(key(b)));
}

/** 把 golden 的工具名 + 参数映射成本地 REST 路由请求。 */
function toRequest(tool: string, args: Record<string, unknown>): { method: string; path: string } {
  switch (tool) {
    case 'get_summary':
      return { method: 'GET', path: `/api/v1/read/summary?ledger_id=${args.ledger_id}` };
    case 'list_budgets_usage':
      return { method: 'GET', path: `/api/v1/read/ledgers/${args.ledger_external_id}/budgets/usage` };
    case 'list_exchange_rate_overrides':
      return { method: 'GET', path: '/api/v1/read/exchange-rate-overrides' };
    default:
      throw new Error(`REST 差分未映射工具: ${tool}`);
  }
}

function statusErrorCode(text: string): string {
  // 上游 400/404/409 等错误体可能是 {"detail":"..."} 或 {"error":"..."}
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    return String(j.detail ?? j.error ?? '');
  } catch {
    return text.slice(0, 200);
  }
}

describe.skipIf(!hasGolden)('REST 只读计算 vs 上游 golden', () => {
  it('fixtures 已生成', () => {
    expect(golden.cases.length).toBeGreaterThan(0);
  });

  for (const kase of golden.cases) {
    it(`[${kase.tool}] ${JSON.stringify(kase.args)}`, async () => {
      const h: Harness = makeHarness();
      seed(h);
      const userId = 'u1';
      const app = buildReadApp();
      const { method, path } = toRequest(kase.tool, kase.args);

      const res = await app.request(path, {
        method,
        headers: { 'X-Test-User': userId },
      }, { DB: h.db, JWT_SECRET: 'test-secret' });

      if (kase.error) {
        expect(res.status).toBeGreaterThanOrEqual(400);
        const got = statusErrorCode(await res.text());
        // 去掉 Python 传输层前缀（见 mcp 差分），只比消息文本
        const expected = kase.error.replace(/^[A-Za-z_][A-Za-z0-9_.]*(?::\s*\d{3})?:\s*/, '');
        expect(got).toContain(expected);
        return;
      }

      expect(res.status).toBe(200);
      const body = normalize(JSON.parse(await res.text()) as Json);
      const want = normalize(kase.result as Json);
      const left = ORDER_UNDEFINED.has(kase.tool) ? sortTop(body) : body;
      const right = ORDER_UNDEFINED.has(kase.tool) ? sortTop(want) : want;
      const diffs = diffJson(left, right);
      expect(diffs.length ? formatDiffs(kase.tool, diffs) : '').toBe('');
    });
  }
});
