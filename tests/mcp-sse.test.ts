import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import mcpRouter from '../src/routes/mcp';

// 简化 D1 模拟：PAT 查询返回有效记录，其余返回空
class MockD1Database {
  prepare(sql: string) {
    return {
      bind: (..._params: unknown[]) => ({
        first: async () => {
          if (sql.includes('FROM personal_access_tokens')) {
            return {
              id: 'pat-1',
              user_id: 'user-1',
              name: 'test-pat',
              scopes_json: JSON.stringify(['mcp:read', 'mcp:write']),
              expires_at: null,
            };
          }
          return null;
        },
        all: async () => ({ results: [] }),
        run: async () => ({ success: true }),
      }),
    };
  }
}

// 与 src/index.ts 相同的方式挂载 /mcp 子应用
const createApp = () => {
  const app = new Hono();
  app.route('/mcp', mcpRouter);
  return app;
};

const createEnv = () => ({ DB: new MockD1Database(), JWT_SECRET: 'test-secret' });

const AUTH = 'Bearer bcmcp_abcdefghijklmnopqrstuvwxyz123456';

describe('MCP SSE 兼容端点', () => {
  it('GET /mcp/sse 应返回 SSE 流并发送 endpoint 事件（官方 SDK 握手）', async () => {
    const app = createApp();
    const controller = new AbortController();

    const res = await app.request(
      '/mcp/sse',
      {
        method: 'GET',
        headers: { Accept: 'text/event-stream', Authorization: AUTH },
        signal: controller.signal,
      },
      createEnv()
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');

    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const chunk = new TextDecoder().decode(value);

    expect(chunk).toContain('event: endpoint');
    expect(chunk).toContain('/mcp/messages/');

    controller.abort();
  });

  it('GET /mcp 带 Accept: text/event-stream 也应返回 SSE 握手', async () => {
    const app = createApp();
    const controller = new AbortController();

    const res = await app.request(
      '/mcp',
      {
        method: 'GET',
        headers: { Accept: 'text/event-stream', Authorization: AUTH },
        signal: controller.signal,
      },
      createEnv()
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');

    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const chunk = new TextDecoder().decode(value);
    expect(chunk).toContain('event: endpoint');
    expect(chunk).toContain('/mcp/messages/');

    controller.abort();
  });

  it('GET /mcp 普通请求仍返回 JSON 服务器信息', async () => {
    const app = createApp();
    const res = await app.request(
      '/mcp',
      { method: 'GET', headers: { Authorization: AUTH } },
      createEnv()
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/json');
  });

  it('POST /mcp/messages/ initialize 返回 200 结果', async () => {
    const app = createApp();
    const res = await app.request(
      '/mcp/messages/',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: AUTH },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {},
        }),
      },
      createEnv()
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jsonrpc: string; result?: { serverInfo?: { name?: string } } };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.result?.serverInfo?.name).toBe('beecount-mcp');
  });

  it('POST /mcp/messages/ tools/list 返回 18 个工具', async () => {
    const app = createApp();
    const res = await app.request(
      '/mcp/messages/',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: AUTH },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
          params: {},
        }),
      },
      createEnv()
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jsonrpc: string; result?: { tools?: unknown[] } };
    expect(body.result?.tools?.length).toBe(18);
  });
});