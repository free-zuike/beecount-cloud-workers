/**
 * workspace 端点差分：用上游 golden（upstream-workspace-golden.json）作基准，
 * 与本地 Hono workspace 路由（真实实现）比对。
 *
 * 覆盖（只读 GET，种子对齐下确定性）：
 *  - /ledgers/:id/members：成员列表
 *  - /ledgers/:id/invites：邀请列表（需一条有效邀请种子）
 *  - /ledgers/:id/member-stats?scope=all：成员统计（scope=all 绕开 now，金额四舍五入）
 *  - /ledgers/:id/shared-resources：共享资源（分类/账户/标签）
 *
 * 比对排除（canonical 归一）：
 *  - id（本地 invites 独有，上游 InviteListItem 无）、share_url（环境派生）、joined_at（种子未固定）
 *  - income_total/expense_total 四舍五入 2 位（跨 Python/TS 浮点尾差）
 *  - 所有对象列表按 canonical JSON 字符串排序，消除两侧排序差异（本地按 kind/name，上游按 sort_order）
 *
 * 注：写操作（创建/撤销邀请、改角色、转让、加入）不在对拍范围（状态变更，由其它测试覆盖）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeHarness, seed, buildRouterApp } from './mcp-harness';
import workspaceRouter from '../src/routes/workspace';

const GOLDEN_PATH = join(process.cwd(), 'tests/fixtures/upstream-workspace-golden.json');
const hasGolden = existsSync(GOLDEN_PATH);
const goldenData = hasGolden ? JSON.parse(readFileSync(GOLDEN_PATH, 'utf-8')) : { cases: [] };

const goldenCases: Record<string, { status: number; result: unknown }> = {};
for (const c of (goldenData.cases ?? []) as Array<{ name: string; status: number; result: unknown }>) {
  goldenCases[c.name] = { status: c.status, result: c.result };
}

const VOLATILE = new Set(['id', 'share_url', 'joined_at']);
const AMOUNT = new Set(['income_total', 'expense_total']);
/** 规范化：删除易失字段、金额四舍五入、对象键排序、对象数组按 JSON 排序，输出可比字符串 */
function canonical(v: unknown): string {
  if (Array.isArray(v)) {
    const items = v.map(canonical);
    items.sort();
    return '[' + items.join(',') + ']';
  }
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (VOLATILE.has(k)) continue;
      // 上游 AccountProjection(=0) 与 UserAccountProjection(=null) 两表种子值不同，本地合并为单表 user_account_projection；
      // shared-resources 取用户全局投影(null) 而 read/accounts 取账本投影(0)。归一则 null↔0。
      if (k === 'initial_balance') { out[k] = (x === 0 || x === null) ? null : x; continue; }
      if (AMOUNT.has(k) && typeof x === 'number') out[k] = Math.round(x * 100) / 100;
      else out[k] = x;
    }
    const parts = Object.keys(out).sort().map((k) => JSON.stringify(k) + ':' + canonical(out[k]));
    return '{' + parts.join(',') + '}';
  }
  if (typeof v === 'string') return JSON.stringify(normTs(v));
  return JSON.stringify(v);
}

/** 归一化 UTC 时间戳时区后缀：上游 pydantic 输出 +00:00，本地输出 Z；二者等价 */
function normTs(s: string): string {
  return s.replace(/\+00:00$/, 'Z');
}

const CASES = [
  { name: 'members', path: '/api/v1/ledgers/L1/members' },
  { name: 'invites', path: '/api/v1/ledgers/L1/invites' },
  { name: 'member_stats', path: '/api/v1/ledgers/L1/member-stats?scope=all' },
  { name: 'shared_resources', path: '/api/v1/ledgers/L1/shared-resources' },
];

describe.skipIf(!hasGolden)('workspace differential vs upstream', () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const h = makeHarness();
      seed(h);
      const app = buildRouterApp(workspaceRouter as never, '/api/v1', h.db);
      const res = await app.request(c.path, {
        method: 'GET',
        headers: { 'X-Test-User': 'u1' },
      }, { DB: h.db, JWT_SECRET: 'test-secret' } as never);
      expect(res.status).toBe(goldenCases[c.name].status);
      const body = (await res.json()) as unknown;
      const goldenCanon = canonical(goldenCases[c.name].result);
      const localCanon = canonical(body);
      expect(localCanon).toBe(goldenCanon);
    });
  }
});
