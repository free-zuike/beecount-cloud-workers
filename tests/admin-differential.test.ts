/**
 * admin 端点差分：用上游 golden（upstream-admin-golden.json）作基准，
 * 与本地 Hono admin 路由（真实实现）比对。
 *
 * 覆盖（只读聚合，种子对齐下确定性）：
 *  - /overview：各表计数（users/ledgers/transactions/accounts/categories/tags）
 *  - /users：用户列表（scrub id / created_at，items 顺序非契约）
 *
 * 比对排除：users 的 id（随机 uuid）、created_at（时间相关）。其余字段
 * （email / is_admin / is_enabled / display_name / avatar_url / avatar_version / total）逐项比对。
 *
 * 注：/health 需 request.app.state.ws_manager、/users(POST) 等写操作不在对拍范围
 * （属平台适配 / 写路径，已由其它测试覆盖其本地行为）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeHarness, seed, buildRouterApp } from './mcp-harness';
import adminRouter from '../src/routes/admin';

const GOLDEN_PATH = join(process.cwd(), 'tests/fixtures/upstream-admin-golden.json');
const hasGolden = existsSync(GOLDEN_PATH);
const goldenData = hasGolden ? JSON.parse(readFileSync(GOLDEN_PATH, 'utf-8')) : { cases: [] };

const goldenCases: Record<string, { status: number; result: unknown }> = {};
for (const c of (goldenData.cases ?? []) as Array<{ name: string; status: number; result: unknown }>) {
  goldenCases[c.name] = { status: c.status, result: c.result };
}

const VOLATILE = new Set(['id', 'created_at']);
function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (VOLATILE.has(k)) continue;
      out[k] = scrub(v);
    }
    return out;
  }
  return value;
}

function sortItems(x: unknown): unknown {
  if (Array.isArray(x)) return [...x].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return x;
}

describe.skipIf(!hasGolden)('admin differential vs upstream', () => {
  it('overview', async () => {
    const h = makeHarness();
    seed(h);
    h.sqlite.prepare('UPDATE users SET is_admin=1 WHERE id=?').run('u1');
    const app = buildRouterApp(adminRouter as never, '/api/v1/admin', h.db);
    const res = await app.request('/api/v1/admin/overview', {
      method: 'GET',
      headers: { 'X-Test-User': 'u1' },
    }, { DB: h.db, JWT_SECRET: 'test-secret' } as never);
    expect(res.status).toBe(goldenCases['overview'].status);
    const body = scrub(await res.json());
    expect(body).toEqual(scrub(goldenCases['overview'].result));
  });

  it('users', async () => {
    const h = makeHarness();
    seed(h);
    h.sqlite.prepare('UPDATE users SET is_admin=1 WHERE id=?').run('u1');
    const app = buildRouterApp(adminRouter as never, '/api/v1/admin', h.db);
    const res = await app.request('/api/v1/admin/users?limit=100&offset=0', {
      method: 'GET',
      headers: { 'X-Test-User': 'u1' },
    }, { DB: h.db, JWT_SECRET: 'test-secret' } as never);
    expect(res.status).toBe(goldenCases['users'].status);
    const body = (await res.json()) as { total: number; items: unknown[] };
    const want = goldenCases['users'].result as { total: number; items: unknown[] };
    expect(body.total).toBe(want.total);
    const left = sortItems(scrub(body.items));
    const right = sortItems(scrub(want.items));
    expect(left).toEqual(right);
  });
});
