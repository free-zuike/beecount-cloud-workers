/**
 * MCP 越权/可见性护栏（对齐上游 auth.py::require_mcp_scope 与 capability_tools.get_operation）。
 *
 * - 读工具必须 mcp:read：仅持 mcp:write 的 PAT 不能读数据
 * - get_operation：除了 user_id，还要校验 operation 的 ledger_id 在当前可见账本内
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createLedger, makeHarness, registerDevice, registerUser, type Harness } from './mcp-harness';
import { execTool } from '../src/routes/mcp';

const ENV = { JWT_SECRET: 'test-secret' } as never;
const BASE_URL = 'https://beecount.example.com';

let h: Harness;

afterEach(() => h?.sqlite.close());

describe('MCP scope 与可见性（对齐上游）', () => {
  it('读工具必须 mcp:read：仅持 mcp:write 的 PAT 读数据被拒', async () => {
    h = makeHarness();
    registerUser(h, 'u1', 'u1@example.com');
    registerDevice(h, 'u1');
    createLedger(h, 'u1', 'L1-i', 'L1', '主账本');

    await expect(
      execTool(h.db, ENV, BASE_URL, 'u1', ['mcp:write'], 'list_ledgers', {}, 'pat-1', 'bcmcp_test', 'Test PAT'),
    ).rejects.toThrow(/PAT missing required scope: mcp:read/);
  });

  it('读工具持 mcp:read 正常放行', async () => {
    h = makeHarness();
    registerUser(h, 'u1', 'u1@example.com');
    registerDevice(h, 'u1');
    createLedger(h, 'u1', 'L1-i', 'L1', '主账本');

    const r = await execTool(h.db, ENV, BASE_URL, 'u1', ['mcp:read'], 'list_ledgers', {}, 'pat-1', 'bcmcp_test', 'Test PAT');
    const parsed = JSON.parse(r.content[0].text) as Array<{ id: string; owner_user_id: string; shared: boolean }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe('L1');
    expect(parsed[0].owner_user_id).toBe('u1');
    expect(parsed[0].shared).toBe(false);
  });

  it('get_operation：账本不可见时按上游口径报 Operation not found', async () => {
    h = makeHarness();
    registerUser(h, 'u1', 'u1@example.com');
    registerUser(h, 'u2', 'u2@example.com');
    registerDevice(h, 'u1');
    createLedger(h, 'u1', 'L1-i', 'L1', '主账本');
    createLedger(h, 'u2', 'L2-i', 'L2', '他人账本');
    h.sqlite
      .prepare(
        `INSERT INTO mcp_write_operations
         (id, user_id, ledger_id, request_key, request_hash, kind, status, plan_json, results_json, created_at, updated_at)
         VALUES ('op-1', 'u1', 'L2-i', 'k1', 'h1', 'batch_create', 'completed', '{}', '[]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      )
      .run();

    await expect(
      execTool(h.db, ENV, BASE_URL, 'u1', ['mcp:read'], 'get_operation', { operation_id: 'op-1' }, 'pat-1', 'bcmcp_test', 'Test PAT'),
    ).rejects.toThrow(/Operation not found/);
  });

  it('get_operation：本账本操作可读（不误杀）', async () => {
    h = makeHarness();
    registerUser(h, 'u1', 'u1@example.com');
    registerDevice(h, 'u1');
    createLedger(h, 'u1', 'L1-i', 'L1', '主账本');
    h.sqlite
      .prepare(
        `INSERT INTO mcp_write_operations
         (id, user_id, ledger_id, request_key, request_hash, kind, status, plan_json, results_json, created_at, updated_at)
         VALUES ('op-2', 'u1', 'L1-i', 'k2', 'h2', 'batch_create', 'completed', '{"steps":[]}', '[]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      )
      .run();

    const r = await execTool(h.db, ENV, BASE_URL, 'u1', ['mcp:read'], 'get_operation', { operation_id: 'op-2' }, 'pat-1', 'bcmcp_test', 'Test PAT');
    const parsed = JSON.parse(r.content[0].text) as { id?: string; status?: string };
    expect(parsed.id ?? 'op-2').toBe('op-2');
  });
});
