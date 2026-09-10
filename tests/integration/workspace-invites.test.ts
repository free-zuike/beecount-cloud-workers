import { describe, it, expect, beforeEach } from 'vitest';
import { createTestEnv, registerTestUser, getAuthToken, createTestLedger } from '../helpers/test-env';
import { initializeDatabase } from '../../src/db/schema';

// 防回归：共享账本（invites/members/join/transfer）在 v3 结构下必须可用。
// 先 initializeDatabase 注册 v3 schema —— mock 会按注册结构校验 SELECT 列，
// 任何对已删列（ledger_invites.id / ledger_members.id）的引用都会在这里炸出来。
let env: Awaited<ReturnType<typeof createTestEnv>>;
let token: string;
let ledgerId: string;
const email = 'owner@example.com';

beforeEach(async () => {
  env = await createTestEnv();
  await initializeDatabase(env.db as any);
  await registerTestUser(env.app, email);
  token = await getAuthToken(env.app, email);
  ledgerId = await createTestLedger(env.app, token, 'Workspace Ledger');
});

const authHeaders = (t: string) => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${t}`,
});

describe('共享账本 v3 防回归（invites/members/join/transfer）', () => {
  it('创建邀请 + 列表（列表不再查 ledger_invites.id）', async () => {
    const create = await env.app.request(`/api/v1/ledgers/${ledgerId}/invites`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ expires_in_hours: 24, target_role: 'editor' }),
    });
    expect(create.status).toBe(200);
    const created = await create.json() as any;
    expect(created.code).toBeDefined();

    const list = await env.app.request(`/api/v1/ledgers/${ledgerId}/invites`, { headers: authHeaders(token) });
    expect(list.status).toBe(200);
    const items = await list.json() as any[];
    expect(items.length).toBe(1);
    expect(items[0].code).toBe(created.code);
    expect(items[0].id).toBe(created.code); // id 字段兼容（值=code）
  });

  it('成员列表 200（ledger_members 按 v3 结构查询）', async () => {
    const res = await env.app.request(`/api/v1/ledgers/${ledgerId}/members`, { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    expect(await res.json()).toBeInstanceOf(Array);
  });

  it('受邀用户 join 成功（UPDATE ledger_invites 按 code 定位）', async () => {
    // 建邀请
    const create = await env.app.request(`/api/v1/ledgers/${ledgerId}/invites`, {
      method: 'POST', headers: authHeaders(token),
      body: JSON.stringify({ expires_in_hours: 24, target_role: 'editor' }),
    });
    const { code } = await create.json() as any;

    // 第二个用户 join
    const otherToken = await getAuthToken(env.app, 'member@example.com');
    const join = await env.app.request('/api/v1/ledgers/join', {
      method: 'POST', headers: authHeaders(otherToken),
      body: JSON.stringify({ invite_code: code }),
    });
    expect(join.status).toBe(200);

    // owner 的成员列表应含新成员（role=editor）
    const members = await (await env.app.request(`/api/v1/ledgers/${ledgerId}/members`, { headers: authHeaders(token) })).json() as any[];
    expect(members.some(m => m.role === 'editor')).toBe(true);
  });

  it('转移 owner 200（transfer 不再查 ledger_members.id）', async () => {
    // 邀请并加入一个成员
    const create = await env.app.request(`/api/v1/ledgers/${ledgerId}/invites`, {
      method: 'POST', headers: authHeaders(token),
      body: JSON.stringify({ expires_in_hours: 24, target_role: 'editor' }),
    });
    const { code } = await create.json() as any;
    const otherToken = await getAuthToken(env.app, 'member2@example.com');
    await env.app.request('/api/v1/ledgers/join', {
      method: 'POST', headers: authHeaders(otherToken),
      body: JSON.stringify({ invite_code: code }),
    });

    // 获取 member 的 user_id（从 owner 的 members 列表）
    const members = await (await env.app.request(`/api/v1/ledgers/${ledgerId}/members`, { headers: authHeaders(token) })).json() as any[];
    const member = members.find(m => m.role === 'editor');
    expect(member).toBeDefined();

    const transfer = await env.app.request(`/api/v1/ledgers/${ledgerId}/transfer`, {
      method: 'POST', headers: authHeaders(token),
      body: JSON.stringify({ target_user_id: member.user_id }),
    });
    expect(transfer.status).toBe(200);
  });
});
