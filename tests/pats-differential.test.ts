/**
 * pats（Personal Access Token）差分：对齐 /api/v1/profile/pats 的 create/list/update/delete。
 *
 * PAT 的 token/id/prefix/created_at/expires_at 等字段随机或时间相关，golden 中已 scrub，
 * 本地测试自建相同流程逐步骤比对「状态码 + 响应结构」。scrub 掉的字段不参与比对。
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { routerEnv, authTokenFor, buildPatsApp } from './mcp-harness';

const GOLDEN_PATH = join(process.cwd(), 'tests/fixtures/upstream-pats-golden.json');
const golden = existsSync(GOLDEN_PATH) ? JSON.parse(readFileSync(GOLDEN_PATH, 'utf-8')) : null;

type Json = Record<string, any>;
const run = golden ? it : it.skip;
const step = (n: string) => (golden as Json).steps.find((s: Json) => s.name === n);

function scrub(v: Json): Json {
  if (Array.isArray(v)) return v.map((x) => scrub(x as Json));
  if (v && typeof v === 'object') {
    const out: Json = {};
    for (const k of Object.keys(v)) {
      if (['token', 'id', 'prefix', 'created_at', 'expires_at', 'last_used_at', 'revoked_at', 'last_used_ip'].includes(k)) continue;
      out[k] = scrub(v[k]);
    }
    return out;
  }
  return v;
}

describe('pats differential (align /api/v1/profile/pats)', () => {
  run('create PAT (201, name + scopes)', async () => {
    const env = routerEnv();
    const { userId } = await authTokenFor(env);
    const app = buildPatsApp();
    const h = { 'X-Test-User': userId };
    const resp = await app.request(
      '/api/v1/profile/pats',
      { method: 'POST', headers: h, body: JSON.stringify({ name: 'ci-pat', scopes: ['mcp:read'], expires_in_days: null }) },
      env as never,
    );
    expect(resp.status).toBe(step('create').status);
    expect(scrub(await resp.json())).toEqual(scrub(step('create').result));
  });

  run('list PATs (after create)', async () => {
    const env = routerEnv();
    const { userId } = await authTokenFor(env);
    const app = buildPatsApp();
    const h = { 'X-Test-User': userId };
    const create = await app.request(
      '/api/v1/profile/pats',
      { method: 'POST', headers: h, body: JSON.stringify({ name: 'ci-pat', scopes: ['mcp:read'], expires_in_days: null }) },
      env as never,
    );
    await create.json();
    const resp = await app.request('/api/v1/profile/pats', { method: 'GET', headers: h }, env as never);
    expect(resp.status).toBe(step('list').status);
    expect(scrub(await resp.json())).toEqual(scrub(step('list').result));
  });

  run('update PAT (rename)', async () => {
    const env = routerEnv();
    const { userId } = await authTokenFor(env);
    const app = buildPatsApp();
    const h = { 'X-Test-User': userId };
    const create = await app.request(
      '/api/v1/profile/pats',
      { method: 'POST', headers: h, body: JSON.stringify({ name: 'ci-pat', scopes: ['mcp:read'], expires_in_days: null }) },
      env as never,
    );
    const id = (await create.json() as { id: string }).id;
    const resp = await app.request(
      `/api/v1/profile/pats/${id}`,
      { method: 'PATCH', headers: h, body: JSON.stringify({ name: 'ci-pat-renamed' }) },
      env as never,
    );
    expect(resp.status).toBe(step('update').status);
    expect(scrub(await resp.json())).toEqual(scrub(step('update').result));
  });

  run('delete PAT (204)', async () => {
    const env = routerEnv();
    const { userId } = await authTokenFor(env);
    const app = buildPatsApp();
    const h = { 'X-Test-User': userId };
    const create = await app.request(
      '/api/v1/profile/pats',
      { method: 'POST', headers: h, body: JSON.stringify({ name: 'ci-pat', scopes: ['mcp:read'], expires_in_days: null }) },
      env as never,
    );
    const id = (await create.json() as { id: string }).id;
    const resp = await app.request(`/api/v1/profile/pats/${id}`, { method: 'DELETE', headers: h }, env as never);
    expect(resp.status).toBe(step('delete').status);
  });
});

// 本地行为锁定（对齐上游）：上游 delete_pat 是物理删除（行直接移除），
// 因此「删除后再编辑」与「编辑不存在」均返回 404；PATCH 对已撤销 PAT 的 409
// 分支与上游防御性代码一致（revoked_at 置位时触发），但经 DELETE 不可达。
describe('pats 边界（对齐上游，无需 golden）', () => {
  it('物理删除后编辑 PAT 返回 404', async () => {
    const env = routerEnv();
    const { userId } = await authTokenFor(env);
    const app = buildPatsApp();
    const h = { 'X-Test-User': userId };
    const create = await app.request(
      '/api/v1/profile/pats',
      { method: 'POST', headers: h, body: JSON.stringify({ name: 'rev', scopes: ['mcp:read'], expires_in_days: null }) },
      env as never,
    );
    const id = (await create.json() as { id: string }).id;
    await app.request(`/api/v1/profile/pats/${id}`, { method: 'DELETE', headers: h }, env as never);
    const upd = await app.request(
      `/api/v1/profile/pats/${id}`,
      { method: 'PATCH', headers: h, body: JSON.stringify({ name: 'x' }) },
      env as never,
    );
    expect(upd.status).toBe(404);
  });

  it('编辑不存在 PAT 返回 404', async () => {
    const env = routerEnv();
    const { userId } = await authTokenFor(env);
    const app = buildPatsApp();
    const h = { 'X-Test-User': userId };
    const upd = await app.request(
      '/api/v1/profile/pats/nope',
      { method: 'PATCH', headers: h, body: JSON.stringify({ name: 'x' }) },
      env as never,
    );
    expect(upd.status).toBe(404);
  });
});
