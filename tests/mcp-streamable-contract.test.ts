/**
 * MCP Streamable HTTP 传输层契约测试（本地，不依赖上游 golden）。
 *
 * 现有 mcp-differential.test.ts 已覆盖「工具调用」对上游 golden 的逐字段差分；
 * 本文件覆盖 Streamable 传输层本身（本地手搓实现，对齐上游 FastMCP 行为）：
 *  - initialize 握手：协议版本协商（取客户端请求版本，若支持则原样返回）
 *  - 不支持的协议版本 → -32022
 *  - 2026-07-28 现代协议：缺少 Mcp-Method 头 → -32020
 *  - tools/list（现代头）→ 返回非空的 tools 数组
 *  - 通知（无 id）→ 202 空 body
 *
 * 注：上游使用官方 MCP Python SDK（FastMCP），且 parity golden harness 直接调用函数、
 * 绕过 HTTP 传输，故此处采用传输层契约断言而非函数级 golden 差分。
 * 工具定义/调用内容已由 mcp-differential 对上游 golden 覆盖。
 */
import { describe, it, expect } from 'vitest';
import { makeHarness, seed, buildRouterApp } from './mcp-harness';
import mcpRouter from '../src/routes/mcp';

const TOKEN = 'bcmcp_test_token_0123456789abcdef';

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function app(h: ReturnType<typeof makeHarness>) {
  return buildRouterApp(mcpRouter as never, '/api/v1/mcp', h.db);
}

describe('mcp streamable transport contract', () => {
  async function seedPat(h: ReturnType<typeof makeHarness>): Promise<string> {
    const hash = await sha256Hex(TOKEN);
    h.sqlite.prepare(
      `INSERT INTO personal_access_tokens (id, user_id, name, token_hash, scopes_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('pat-test', 'u1', 'test', hash, JSON.stringify(['mcp:read', 'mcp:write']), '2026-05-20T04:00:00Z');
    return TOKEN;
  }

  it('initialize 协商客户端已支持的协议版本', async () => {
    const h = makeHarness();
    seed(h);
    const token = await seedPat(h);
    const res = await app(h).request('/api/v1/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {} },
      }),
    }, { DB: h.db, JWT_SECRET: 'test-secret' } as never);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(1);
    expect(body.result.protocolVersion).toBe('2025-11-25');
    expect(body.result.capabilities).toBeDefined();
    expect(body.result.serverInfo).toBeDefined();
  });

  it('不支持的协议版本 → -32022', async () => {
    const h = makeHarness();
    seed(h);
    const token = await seedPat(h);
    const res = await app(h).request('/api/v1/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'initialize',
        params: { protocolVersion: '1999-01-01', capabilities: {} },
      }),
    }, { DB: h.db, JWT_SECRET: 'test-secret' } as never);
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.code).toBe(-32022);
  });

  it('现代协议缺少 Mcp-Method 头 → -32020', async () => {
    const h = makeHarness();
    seed(h);
    const token = await seedPat(h);
    const res = await app(h).request('/api/v1/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 3, method: 'tools/list',
        params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } },
      }),
    }, { DB: h.db, JWT_SECRET: 'test-secret' } as never);
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.code).toBe(-32020);
  });

  it('tools/list（现代头）→ 非空 tools 数组', async () => {
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
        jsonrpc: '2.0', id: 4, method: 'tools/list',
        params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } },
      }),
    }, { DB: h.db, JWT_SECRET: 'test-secret' } as never);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(Array.isArray(body.result.tools)).toBe(true);
    expect(body.result.tools.length).toBeGreaterThan(0);
  });

  it('通知（无 id）→ 202 空 body', async () => {
    const h = makeHarness();
    seed(h);
    const token = await seedPat(h);
    const res = await app(h).request('/api/v1/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    }, { DB: h.db, JWT_SECRET: 'test-secret' } as never);
    expect(res.status).toBe(202);
  });

  it('缺少 Authorization → 401', async () => {
    const h = makeHarness();
    seed(h);
    const res = await app(h).request('/api/v1/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} }),
    }, { DB: h.db, JWT_SECRET: 'test-secret' } as never);
    expect(res.status).toBe(401);
  });
});
