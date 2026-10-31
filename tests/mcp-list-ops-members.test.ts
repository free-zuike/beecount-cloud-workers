/**
 * list_operations / list_ledger_members 输出契约差分（对齐上游）。
 *
 * 这两个工具此前是"读面"盲点：实现已与上游一致，但没有任何一致性测试锁死。
 * 这里用与 parity golden 同源的 harness 夹具，钉死：
 *  - list_operations：返回 { operations:[...] }，逐字段对齐上游 operation_out
 *    （9 个键、completed_steps/total_steps 由 plan/results 长度推导、transaction_boundary
 *    原文、sync_ids 从 results 提取、error 透传）。
 *  - list_ledger_members：返回成员数组，字段集对齐上游 MemberOut（9 个键）、按
 *    joined_at 升序、is_self 按 caller 计算、role/email/avatar 取值正确。
 *
 * 注：listOperations 工具内部读 c.env.DB，而 mcpCtx 只给 c.db，故测试手动补 env.DB。
 */
import { describe, it, expect } from 'vitest';
import { createLedger, insertRow, makeHarness, mcpCtx, registerUser, seed } from './mcp-harness';
import { listLedgerMembers, listOperations } from '../src/mcp/capability-tools';

const MEMBER_KEYS = [
  'avatar_url', 'avatar_version', 'display_name', 'email', 'invited_by_user_id',
  'is_self', 'joined_at', 'role', 'user_id',
].sort();

describe('list_operations 输出契约（对齐上游 operation_out）', () => {
  it('返回 operations 数组，字段/计数/sync_ids 提取与上游一致', async () => {
    const h = makeHarness();
    seed(h);
    insertRow(h.sqlite, 'mcp_write_operations', {
      id: 'op-1', user_id: 'u1', ledger_id: 'L1-i', request_key: 'k1', request_hash: 'h1',
      kind: 'import_plan', status: 'completed',
      plan_json: JSON.stringify([{ a: 1 }, { b: 2 }]),
      results_json: JSON.stringify([
        { created_sync_ids: ['tx_aaa111', 'tx_bbb222'] },
        { entity_id: 'acc_ccc333' },
      ]),
      error_json: null, created_at: '2026-05-20T04:00:00Z', updated_at: '2026-05-20T04:01:00Z',
    });
    const c = mcpCtx(h, 'u1');
    (c as unknown as { env: { DB: unknown } }).env = { DB: h.db };
    const res = (await listOperations(c, { ledger_id: 'L1', limit: 10 })) as unknown as { operations: Record<string, unknown>[] };

    expect(Array.isArray(res.operations)).toBe(true);
    expect(res.operations).toHaveLength(1);
    const op = res.operations[0];
    expect(op.operation_id).toBe('op-1');
    expect(op.status).toBe('completed');
    expect(op.kind).toBe('import_plan');
    expect(op.completed_steps).toBe(2); // len(results_json)
    expect(op.total_steps).toBe(2); // len(plan_json)
    expect(op.transaction_boundary).toBe(
      'Each step commits independently; completed steps are retained on failure',
    );
    expect(op.sync_ids).toEqual(['tx_aaa111', 'tx_bbb222', 'acc_ccc333']);
    expect(op.results).toEqual([
      { created_sync_ids: ['tx_aaa111', 'tx_bbb222'] },
      { entity_id: 'acc_ccc333' },
    ]);
    expect(op.error).toBeNull();
    // 字段集合严格等于上游 operation_out 的 9 个键
    expect(Object.keys(op).sort()).toEqual([
      'completed_steps', 'error', 'kind', 'operation_id', 'results',
      'sync_ids', 'status', 'total_steps', 'transaction_boundary',
    ].sort());
  });

  it('limit 越界被钳制到 [1,100]，且空结果返回 []（不报错）', async () => {
    const h = makeHarness();
    seed(h);
    const c = mcpCtx(h, 'u1');
    (c as unknown as { env: { DB: unknown } }).env = { DB: h.db };
    const res = (await listOperations(c, { ledger_id: 'L1', limit: 999 })) as unknown as { operations: unknown[] };
    expect(Array.isArray(res.operations)).toBe(true);
    expect(res.operations).toHaveLength(0);
  });
});

describe('list_ledger_members 输出契约（对齐上游 MemberOut）', () => {
  it('返回成员数组，字段集/排序/is_self 与上游一致', async () => {
    const h = makeHarness();
    registerUser(h, 'u1', 'u1@example.com');
    registerUser(h, 'u2', 'u2@example.com');
    // 直接用 insertRow 建 ledger + owner 成员（避免 createLedger 的参绑定问题）
    insertRow(h.sqlite, 'ledgers', {
      id: 'L1-i', user_id: 'u1', external_id: 'L1', name: 'L1', currency: 'CNY',
      month_start_day: 1, created_at: '2026-01-01T00:00:00Z',
    });
    insertRow(h.sqlite, 'ledger_members', {
      ledger_id: 'L1-i', user_id: 'u1', role: 'owner', joined_at: '2026-01-01T00:00:00Z',
    });
    // 补 u2 为 editor，joined_at 晚于 u1（2026-01-01），用于验证升序排序
    insertRow(h.sqlite, 'ledger_members', {
      ledger_id: 'L1-i', user_id: 'u2', role: 'editor',
      joined_at: '2026-02-01T00:00:00Z', invited_by_user_id: 'u1',
    });
    h.sqlite.prepare('UPDATE users SET display_name=?, avatar_url=?, avatar_version=? WHERE id=?')
      .run('张三', 'https://x/a.png', 3, 'u1');
    h.sqlite.prepare('UPDATE users SET display_name=?, avatar_url=?, avatar_version=? WHERE id=?')
      .run('李四', 'https://x/b.png', 1, 'u2');

    const c = mcpCtx(h, 'u1');
    const res = (await listLedgerMembers(c, { ledger_id: 'L1' })) as Record<string, unknown>[];

    expect(Array.isArray(res)).toBe(true);
    expect(res).toHaveLength(2);
    // 按 joined_at 升序：u1(2026-01-01) 先于 u2(2026-02-01)
    expect(res[0].user_id).toBe('u1');
    expect(res[1].user_id).toBe('u2');

    const u1m = res.find((m) => m.user_id === 'u1')!;
    const u2m = res.find((m) => m.user_id === 'u2')!;
    expect(u1m.role).toBe('owner');
    expect(u2m.role).toBe('editor');
    expect(u1m.is_self).toBe(true);
    expect(u2m.is_self).toBe(false);
    expect(u1m.email).toBe('u1@example.com');
    expect(u1m.display_name).toBe('张三');
    expect(u1m.avatar_url).toBe('https://x/a.png');
    expect(u1m.avatar_version).toBe(3);
    expect(u1m.invited_by_user_id).toBeNull();
    expect(u2m.invited_by_user_id).toBe('u1');
    expect(u2m.avatar_url).toBe('https://x/b.png');
    expect(u2m.avatar_version).toBe(1);
    expect(typeof u1m.joined_at).toBe('string');
    // 字段集合严格等于上游 MemberOut 的 9 个键
    for (const m of res) expect(Object.keys(m).sort()).toEqual(MEMBER_KEYS);
  });
});
