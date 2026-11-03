/**
 * workspace 写操作差分：用上游 golden（upstream-workspace-write-golden.json）作基准，
 * 与本地 Hono workspace 路由（真实实现）比对。
 *
 * 覆盖（写操作，种子对齐下确定性）：
 *  - POST   /ledgers/:id/invites           创建邀请（状态码 201；scrub 随机 code/时间戳/share_url）
 *  - POST   /invites/:code/preview         预览邀请（只读；scrub code/expires_at）
 *  - POST   /invites/:code/accept          接受邀请（确定性：ledger_external_id/name/currency/role/member_count）
 *  - DELETE /ledgers/:id/invites/:code     撤销邀请（状态码 204）
 *  - PATCH  /ledgers/:id/members/:userId   改角色（返回完整 MemberOut；scrub joined_at）
 *  - DELETE /ledgers/:id/members/:userId   移除成员（状态码 204；需 u2 已是成员）
 *  - POST   /ledgers/:id/transfer          转让所有权（返回 list[MemberOut]；需 u2 已是成员）
 *
 * 比对排除（canonical 归一）：
 *  - code/formatted_code/expires_at/created_at/share_url/id/joined_at（随机/时间/环境派生）
 *  - 时间戳 +00:00 ↔ Z 归一
 *
 * 注：本地 transfer 请求体字段为 target_user_id（上游为 new_owner_user_id），属请求契约分歧，
 *     本测试按本地契约发 body，仅对响应做差分。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeHarness, seed, buildRouterApp } from './mcp-harness';
import workspaceRouter from '../src/routes/workspace';

const GOLDEN_PATH = join(process.cwd(), 'tests/fixtures/upstream-workspace-write-golden.json');
const hasGolden = existsSync(GOLDEN_PATH);
const goldenData = hasGolden ? JSON.parse(readFileSync(GOLDEN_PATH, 'utf-8')) : { cases: [] };

const goldenCases: Record<string, { status: number; result: unknown }> = {};
for (const c of (goldenData.cases ?? []) as Array<{ name: string; status: number; result: unknown }>) {
  goldenCases[c.name] = { status: c.status, result: c.result };
}

const VOLATILE = new Set(['code', 'formatted_code', 'expires_at', 'created_at', 'share_url', 'id', 'joined_at']);

/** 归一化 UTC 时间戳时区后缀：上游 pydantic 输出 +00:00，本地输出 Z */
function normTs(s: string): string {
  return s.replace(/\+00:00$/, 'Z');
}

/** 规范化：删除易失字段、对象键排序、对象数组按 JSON 排序，输出可比字符串 */
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
      out[k] = x;
    }
    const parts = Object.keys(out).sort().map((k) => JSON.stringify(k) + ':' + canonical(out[k]));
    return '{' + parts.join(',') + '}';
  }
  if (typeof v === 'string') return JSON.stringify(normTs(v));
  return JSON.stringify(v);
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
interface CaseDef {
  name: string;
  method: Method;
  path: string;
  body?: unknown;
  user: string;
  /** 主请求前先让 u2 通过 ABC234 接受邀请成为 L1 成员（change-role/remove/transfer 需要） */
  prepAccept?: boolean;
}

const CASES: CaseDef[] = [
  { name: 'create_invite', method: 'POST', path: '/api/v1/ledgers/L1/invites', body: { target_role: 'editor', expires_in_hours: 24 }, user: 'u1' },
  { name: 'preview_invite', method: 'POST', path: '/api/v1/invites/ABC234/preview', user: 'u2' },
  { name: 'accept_invite', method: 'POST', path: '/api/v1/invites/ABC234/accept', user: 'u2' },
  { name: 'revoke_invite', method: 'DELETE', path: '/api/v1/ledgers/L1/invites/ABC234', user: 'u1' },
  { name: 'change_member_role', method: 'PATCH', path: '/api/v1/ledgers/L1/members/u2', body: { role: 'editor' }, user: 'u1', prepAccept: true },
  { name: 'remove_member', method: 'DELETE', path: '/api/v1/ledgers/L1/members/u2', user: 'u1', prepAccept: true },
  { name: 'transfer_ownership', method: 'POST', path: '/api/v1/ledgers/L1/transfer', body: { target_user_id: 'u2' }, user: 'u1', prepAccept: true },
];

describe.skipIf(!hasGolden)('workspace write differential vs upstream', () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const h = makeHarness();
      seed(h);
      const app = buildRouterApp(workspaceRouter as never, '/api/v1', h.db);
      const env = { DB: h.db, JWT_SECRET: 'test-secret' } as never;

      if (c.prepAccept) {
        await app.request('/api/v1/invites/ABC234/accept', {
          method: 'POST',
          headers: { 'X-Test-User': 'u2' },
        }, env);
      }

      const res = await app.request(c.path, {
        method: c.method,
        headers: { 'X-Test-User': c.user, 'Content-Type': 'application/json' },
        body: c.body === undefined ? undefined : JSON.stringify(c.body),
      }, env);

      expect(res.status).toBe(goldenCases[c.name].status);
      const body = res.status === 204 ? null : ((await res.json()) as unknown);
      const goldenCanon = canonical(goldenCases[c.name].result);
      const localCanon = canonical(body);
      expect(localCanon).toBe(goldenCanon);
    });
  }
});
