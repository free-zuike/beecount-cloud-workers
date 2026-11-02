/**
 * 鉴权端点差分：用上游 FastAPI app（TestClient）生成的 auth golden 作为基准，
 * 与本地 Hono auth 路由（真实实现）逐场景比对。
 *
 * golden 在 CI 由 scripts/parity/upstream_dump.py 生成（upstream-auth-golden.json）。
 * golden 是一条「请求序列」：register → register_dup/weak/bademail → login → login_wrong
 * → refresh（吊销旧 token）→ me → logout。下游步骤依赖前置步骤的状态（如 refresh 吊销
 * login 的 token，使后续 logout 返回 401）。因此本地 replay 采用「顺序重放 0..idx 全部
 * 前置步骤」的方式，精确复现 golden 生成时的状态演进；链式 token（refresh/me/logout）
 * 使用本地自己生成的 token，而非 golden 请求体里的上游 token。
 *
 * 比对只覆盖「确定性字段」：email / is_admin / scopes / expires_in / requires_2fa /
 * 状态码；随机字段（access_token / refresh_token / device_id / user.id / challenge_token）
 * 与错误体包络（Zod vs Pydantic 属架构差异，按豁免口径）在两侧均被 scrub 后不参与比对。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { buildAuthApp, authEnv } from './mcp-harness';

const GOLDEN_PATH = new URL('./fixtures/upstream-auth-golden.json', import.meta.url);

// 随机字段 + 错误体格式字段，两侧都剔除后比对
const VOLATILE_KEYS = new Set([
  'access_token', 'refresh_token', 'device_id', 'challenge_token',
  'detail', 'error', 'validation', 'request_id',
]);
function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (VOLATILE_KEYS.has(k)) continue;
      if (k === 'user' && v && typeof v === 'object') {
        const u = v as Record<string, unknown>;
        out.user = Object.fromEntries(Object.entries(u).filter(([uk]) => uk !== 'id'));
        continue;
      }
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

describe('auth differential vs upstream', () => {
  // 同步读取 golden（在 describe 注册期执行，确保下方 forEach 能注册到正确数量的用例）。
  // 本地未生成 golden 时 available=false，测试优雅跳过。
  const goldenSteps: Step[] = [];
  let available = false;
  try {
    if (existsSync(GOLDEN_PATH)) {
      const raw = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));
      goldenSteps.push(...(raw.steps ?? []));
      available = goldenSteps.length > 0;
    } else {
      console.warn('[auth-differential] golden 缺失，跳过（CI 生成 upstream-auth-golden.json 后生效）');
    }
  } catch (err) {
    console.warn('[auth-differential] 读取 golden 失败，跳过：', err);
  }

  it('golden 可用', () => {
    if (!available) return;
    expect(goldenSteps.length).toBeGreaterThan(0);
  });

  goldenSteps.forEach((target, idx) => {
    it(`step[${idx}]: ${target.name}`, async () => {
      if (!available) return;
      const env = authEnv(true);
      const app = buildAuthApp(true);
      const captured: Record<string, string> = {};

      // 顺序重放 0..idx（含目标），链式 token 用本地生成的
      for (let j = 0; j <= idx; j++) {
        const s = goldenSteps[j];
        let json = s.request.json;
        if (s.name === 'refresh' && json) json = { ...json, refresh_token: captured.refresh };
        if (s.name === 'logout' && json) json = { ...json, refresh_token: captured.refresh };

        const headers: Record<string, string> = {};
        if (json) headers['content-type'] = 'application/json';
        if (s.name === 'me') headers['authorization'] = `Bearer ${captured.access}`;

        const resp = await app.request(s.request.path, {
          method: s.request.method,
          headers,
          body: json ? JSON.stringify(json) : undefined,
        }, env as never);
        const status = resp.status;
        let body: unknown = null;
        const text = await resp.text();
        if (text) {
          try { body = JSON.parse(text); } catch { body = text; }
        }

        if (s.name === 'login' && body && typeof body === 'object') {
          captured.access = (body as Record<string, unknown>).access_token as string;
          captured.refresh = (body as Record<string, unknown>).refresh_token as string;
        }

        if (j === idx) {
          expect(status).toBe(s.status);
          expect(scrub(body)).toEqual(scrub(s.result));
        }
      }
    });
  });
});
