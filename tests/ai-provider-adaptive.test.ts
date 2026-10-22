// 移植上游 tests/test_ai_provider_client_adaptive.py（issue #312）：
// 推理模型锁 temperature → 400 → 摘掉重发，无需真实 key。
// 本地对应实现：src/routes/ai.ts 的 _rejectedParam + callAiChatJson(_postChatAdaptive)。
import { afterEach, describe, expect, it } from 'vitest';
import { _rejectedParam, callAiChatJson } from '../src/routes/ai';

const MOONSHOT_TEMP_ERR =
  '{"error":{"message":"invalid temperature: only 1 is allowed for this model","type":"invalid_request_error"}}';

describe('_rejectedParam 分类（移植上游 test_ai_provider_client_adaptive.py）', () => {
  it('结构化 error.param（OpenAI/o1/o3）', () => {
    const body = '{"error":{"param":"temperature","message":"unsupported value","code":"unsupported_value"}}';
    expect(_rejectedParam({ temperature: 0.2, model: 'o1' }, 400, body)).toBe('temperature');
  });

  it('文案兜底 Moonshot（不给 param，点名了键名）', () => {
    expect(_rejectedParam({ temperature: 0.2, model: 'kimi-k2.5' }, 400, MOONSHOT_TEMP_ERR)).toBe('temperature');
  });

  it('绝不剥离必填键（model not found 含 model，但 model 是必填）', () => {
    expect(_rejectedParam({ model: 'missing', messages: [] }, 404, '{"error":"model not found"}')).toBeNull();
  });

  it('错误没点名可丢键 → null', () => {
    expect(_rejectedParam({ temperature: 0.2, model: 'x' }, 429, '{"error":"rate limited"}')).toBeNull();
  });

  it('成功状态码 → null', () => {
    expect(_rejectedParam({ temperature: 0.2 }, 200, '')).toBeNull();
  });

  it('同一机制覆盖 response_format', () => {
    const body = '{"error":{"message":"response_format is not supported by this model"}}';
    const payload = { model: 'x', messages: [], response_format: { type: 'json_object' } };
    expect(_rejectedParam(payload, 400, body)).toBe('response_format');
  });
});

describe('callAiChatJson 自适应重发（移植上游 call_chat_json）', () => {
  afterEach(() => {
    // @ts-expect-error 恢复全局 fetch（vitest 环境无默认 fetch 时也无妨）
    delete globalThis.fetch;
  });

  it('带温度 → 400 → 摘温度重发 → 返回解析内容', async () => {
    const calls: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push(body);
      if ('temperature' in body) {
        return new Response(MOONSHOT_TEMP_ERR, { status: 400 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok": true}' } }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const content = await callAiChatJson(
      'https://api.moonshot.cn/v1',
      'sk-x',
      'kimi-k2.5',
      [{ role: 'user', content: 'hi' }],
    );

    expect(content).toBe('{"ok": true}');
    expect(calls).toHaveLength(2);
    expect('temperature' in calls[0]).toBe(true);
    expect('temperature' in calls[1]).toBe(false);
  });
});
