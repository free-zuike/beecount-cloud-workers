/**
 * ai 端点契约测试（本地，不依赖上游 golden）。
 *
 * 上游 parity venv 未装 sentence-transformers，故 ai 不生成 golden（会静默 skip）。
 * 本文件覆盖 test_provider 的「LLM mock」路径：stub 全局 fetch（对齐上游 _test_text
 * 的 monkeypatch），验证本地路由返回成功 + 固定 preview；并验证缺字段时的失败契约。
 *
 * 字段级契约（provider 结构）已由 write-contract-differential.test.ts 对上游覆盖。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeHarness, seed, buildRouterApp } from './mcp-harness';
import aiRouter from '../src/routes/ai';

afterEach(() => { vi.unstubAllGlobals(); });

function app(h: ReturnType<typeof makeHarness>) {
  return buildRouterApp(aiRouter as never, '/api/v1/ai', h.db);
}

describe('ai test_provider contract (LLM mock)', () => {
  it('text 连通性：LLM mock 返回固定 preview', async () => {
    const h = makeHarness();
    seed(h);
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'hi-reply' } }] }), { status: 200 })
    );
    const res = await app(h).request('/api/v1/ai/test-provider', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Test-User': 'u1' },
      body: JSON.stringify({
        provider: { apiKey: 'sk-test', baseUrl: 'https://api.openai.com', textModel: 'test-model' },
        capability: 'text',
      }),
    }, { DB: h.db, JWT_SECRET: 'test-secret' } as never);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.preview).toBe('hi-reply');
    expect(body.error_code).toBeUndefined();
  });

  it('缺 apiKey → success=false 且 error_code=AI_TEST_MISSING_FIELDS', async () => {
    const h = makeHarness();
    seed(h);
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'x' } }] }), { status: 200 })
    );
    const res = await app(h).request('/api/v1/ai/test-provider', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Test-User': 'u1' },
      body: JSON.stringify({
        provider: { apiKey: '', baseUrl: 'https://fake.local', textModel: 'test-model' },
        capability: 'text',
      }),
    }, { DB: h.db, JWT_SECRET: 'test-secret' } as never);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(false);
    expect(body.error_code).toBe('AI_TEST_MISSING_FIELDS');
  });
});
