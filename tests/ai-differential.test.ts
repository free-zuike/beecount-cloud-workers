/**
 * ai 端点差分测试（golden 来自上游，CI 生成 tests/fixtures/upstream-ai-golden.json）。
 *
 * 上游 golden：test_provider(text) 的 _test_text 被 monkeypatch 成固定 "hi-reply"，
 * 记录 { success, preview }（latency_ms 已 scrub）。
 * 本地侧同步 stub 全局 fetch 返回相同 preview，确保确定性，再与 golden 逐字段比对。
 *
 * 这校验本地 test_provider 的「校验 + 响应信封 + preview 截断」与上游一致。
 * 比对排除 latency_ms（计时，非语义）。
 * parse_tx_text / ask 走流式 + 向量检索，依赖外部 embedding，不在对拍范围
 * （其字段契约已由 write-contract-differential 对上游覆盖）。
 *
 * 本地无 golden 时 skip（不假装通过）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { makeHarness, seed, buildRouterApp } from './mcp-harness';
import aiRouter from '../src/routes/ai';

const GOLDEN_PATH = join(process.cwd(), 'tests/fixtures/upstream-ai-golden.json');
const hasGolden = existsSync(GOLDEN_PATH);
const golden: { cases: Array<{ name: string; status: number; result?: Record<string, unknown> }> } =
  hasGolden ? JSON.parse(readFileSync(GOLDEN_PATH, 'utf-8')) : { cases: [] };

afterEach(() => { vi.unstubAllGlobals(); });

function app(h: ReturnType<typeof makeHarness>) {
  return buildRouterApp(aiRouter as never, '/api/v1/ai', h.db);
}

describe.skipIf(!hasGolden)('ai differential vs upstream', () => {
  it('test_provider(text) 与上游 golden 一致', async () => {
    const h = makeHarness();
    seed(h);
    // 本地同步 stub：返回与上游 monkeypatch 相同的 preview，保证确定性。
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
    const body = (await res.json()) as Record<string, unknown>;
    // 排除本地计时字段
    const { latency_ms: _omit, ...local } = body;
    const g = golden.cases.find((c) => c.name === 'test_provider_text');
    expect(g).toBeDefined();
    expect(local).toEqual(g!.result);
  });
});
