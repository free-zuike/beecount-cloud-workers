/**
 * profile 端点差分：用上游 golden（upstream-profile-golden.json）作基准，与本地 Hono
 * profile 路由（真实实现）比对。authTokenFor 注册登录拿本地 userId，经 X-Test-User
 * 注入（与 buildReadApp 同法，跳过真实 JWT 校验）。
 *
 * 比对排除：user_id（随机 uuid）、avatar_url（含 host）。其余确定性字段
 * （email / display_name / income_is_red / theme_primary_color / primary_currency 等）逐项比对。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildProfileApp, authTokenFor, routerEnv } from './mcp-harness';

const GOLDEN_PATH = join(process.cwd(), 'tests/fixtures/upstream-profile-golden.json');
const hasGolden = existsSync(GOLDEN_PATH);
const goldenData = hasGolden ? JSON.parse(readFileSync(GOLDEN_PATH, 'utf-8')) : { steps: [] };

// 随机/含 host 的字段，两侧都剔除
const VOLATILE = new Set(['user_id', 'avatar_url']);
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

interface Step {
  name: string;
  request: { method: string; path: string; json?: Record<string, unknown> };
  status: number;
  result: unknown;
}

describe.skipIf(!hasGolden)('profile differential vs upstream', () => {
  const goldenSteps: Step[] = goldenData.steps ?? [];

  goldenSteps.forEach((target) => {
    it(`step: ${target.name}`, async () => {
      const env = routerEnv();
      const { userId } = await authTokenFor(env);
      const app = buildProfileApp();
      const req = target.request;
      const headers: Record<string, string> = { 'X-Test-User': userId };
      if (req.json) headers['content-type'] = 'application/json';
      const resp = await app.request(req.path, {
        method: req.method,
        headers,
        body: req.json ? JSON.stringify(req.json) : undefined,
      }, env as never);
      const status = resp.status;
      let body: unknown = null;
      const text = await resp.text();
      if (text) {
        try { body = JSON.parse(text); } catch { body = text; }
      }
      expect(status).toBe(target.status);
      expect(scrub(body)).toEqual(scrub(target.result));
    });
  });
});
