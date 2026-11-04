/**
 * MCP tools/list 目录差分测试（golden 来自上游 FastMCP 注册表，CI 生成
 * tests/fixtures/upstream-mcp-tools-golden.json）。
 *
 * 上游用官方 FastMCP SDK，其 tools/list 的工具目录由 SDK 注册生成；本地手搓 Streamable
 * transport 的 tools/list 必须与之对齐。比对：工具名集合、每个工具的 name + description、
 * 以及 inputSchema 的顶层属性名集合（schema 生成器差异只比属性名，不比 $defs/附加字段）。
 *
 * 握手/版本协商/header 校验/通知 202 由 tests/mcp-streamable-contract.test.ts 覆盖。
 * 工具「调用结果」已由 tests/mcp-differential.test.ts 对上游 golden 覆盖。
 *
 * 本地无 golden 时 skip（不假装通过）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeHarness, seed, buildRouterApp } from './mcp-harness';
import mcpRouter from '../src/routes/mcp';

const GOLDEN_PATH = join(process.cwd(), 'tests/fixtures/upstream-mcp-tools-golden.json');
const hasGolden = existsSync(GOLDEN_PATH);
const golden: { tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> } =
  hasGolden ? JSON.parse(readFileSync(GOLDEN_PATH, 'utf-8')) : { tools: [] };

const TOKEN = 'bcmcp_test_token_tools_0123456789abcdef';
async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function app(h: ReturnType<typeof makeHarness>) {
  return buildRouterApp(mcpRouter as never, '/api/v1/mcp', h.db);
}

describe.skipIf(!hasGolden)('mcp tools/list catalog differential vs upstream', () => {
  async function seedPat(h: ReturnType<typeof makeHarness>): Promise<string> {
    const hash = await sha256Hex(TOKEN);
    h.sqlite.prepare(
      `INSERT INTO personal_access_tokens (id, user_id, name, token_hash, scopes_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('pat-tools', 'u1', 'test', hash, JSON.stringify(['mcp:read', 'mcp:write']), '2026-05-20T04:00:00Z');
    return TOKEN;
  }

  it('工具名集合与上游一致', async () => {
    const h = makeHarness();
    seed(h);
    const token = await seedPat(h);
    const res = await app(h).request('/api/v1/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token}`,
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/list',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/list',
        params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } },
      }),
    }, { DB: h.db, JWT_SECRET: 'test-secret' } as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { tools: Array<{ name: string }> } };
    const localNames = body.result.tools.map((t) => t.name).sort();
    const goldenNames = golden.tools.map((t) => t.name).sort();
    expect(localNames).toEqual(goldenNames);
  });

  it('每个工具的 name + description + inputSchema 顶层属性名与上游一致', async () => {
    const h = makeHarness();
    seed(h);
    const token = await seedPat(h);
    const res = await app(h).request('/api/v1/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token}`,
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/list',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'tools/list',
        params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } },
      }),
    }, { DB: h.db, JWT_SECRET: 'test-secret' } as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> } };
    const localTools = new Map(body.result.tools.map((t) => [t.name, t]));
    for (const gt of golden.tools) {
      const lt = localTools.get(gt.name);
      expect(lt, `本地缺少工具 ${gt.name}`).toBeDefined();
      expect(lt!.description).toBe(gt.description);
      const lProps = Object.keys((lt!.inputSchema?.properties as Record<string, unknown>) || {}).sort();
      const gProps = Object.keys((gt.inputSchema?.properties as Record<string, unknown>) || {}).sort();
      expect(lProps, `工具 ${gt.name} 的 inputSchema 顶层属性名集合`).toEqual(gProps);
    }
  });
});
