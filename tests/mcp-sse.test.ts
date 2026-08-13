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

// 回归测试：标准 SDK 客户端常配置带尾斜杠的 URL，Hono 挂载必须同时匹配
// /mcp 与 /mcp/（同 index.ts 的双挂载方式），否则客户端收到 404 连不上。
describe('MCP trailing-slash mount (index.ts dual-mount)', () => {
  const buildApp = () => {
    const app = new Hono();
    app.route('/mcp', mcpRouter);
    app.route('/mcp/', mcpRouter);
    return app;
  };

  const INIT_BODY = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const post = (app: Hono, path: string) =>
    app.request(
      path,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer bcmcp_abcdefghijklmnopqrstuvwxyz123456' },
        body: INIT_BODY,
      },
      createEnv()
    );

  it('POST /mcp (no slash) returns 200', async () => {
    const app = buildApp();
    const res = await post(app, '/mcp');
    expect(res.status).toBe(200);
  });

  it('POST /mcp/ (trailing slash) returns 200', async () => {
    const app = buildApp();
    const res = await post(app, '/mcp/');
    expect(res.status).toBe(200);
    const j = (await res.json()) as { result: { serverInfo: { name: string } } };
    expect(j.result.serverInfo.name).toBe('beecount-mcp');
  });

  it('POST /mcp// double-slash does NOT match (no silent fallthrough)', async () => {
    const app = buildApp();
    const res = await post(app, '/mcp//');
    expect(res.status).toBe(404);
  });

  it('GET /mcp (no slash) with event-stream returns SSE handshake', async () => {
    const app = buildApp();
    const controller = new AbortController();
    const res = await app.request(
      '/mcp',
      {
        method: 'GET',
        headers: { Accept: 'text/event-stream', Authorization: 'Bearer bcmcp_abcdefghijklmnopqrstuvwxyz123456' },
        signal: controller.signal,
      },
      createEnv()
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');
    controller.abort();
  });

  // 关键回归：现代 SDK 客户端 Accept 是 "application/json, text/event-stream"，
  // GET 探测必须返回 JSON（而非永不结束的 SSE 流），否则客户端挂起 30s。
  it('GET /mcp with modern Accept (application/json, text/event-stream) returns JSON, not SSE', async () => {
    const app = buildApp();
    const res = await app.request(
      '/mcp',
      {
        method: 'GET',
        headers: { Accept: 'application/json, text/event-stream', Authorization: 'Bearer bcmcp_abcdefghijklmnopqrstuvwxyz123456' },
      },
      createEnv()
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    const j = (await res.json()) as { result: { serverInfo: { name: string } } };
    expect(j.result.serverInfo.name).toBe('beecount-mcp');
  });

  it('GET /mcp with default Accept also returns JSON', async () => {
    const app = buildApp();
    const res = await app.request(
      '/mcp',
      { method: 'GET', headers: { Authorization: 'Bearer bcmcp_abcdefghijklmnopqrstuvwxyz123456' } },
      createEnv()
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/json');
  });
});