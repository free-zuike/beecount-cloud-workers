// 移植上游 tests/test_ai_test_provider.py：
// POST /api/v1/ai/test-provider — mock 上游 LLM fetch，验证：
// text/vision/speech happy path、401→AUTH、404→MODEL_NOT_FOUND、timeout、
// 速率限制(60s 31 次→429)、temperature 重试、vision 空模型→MISSING_FIELDS。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import aiRouter, { resetRateLimitsForTest } from '../src/routes/ai';

let sqlite: DatabaseSync;
let db: D1Database;
let app: Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>;

const USER = 'user-1';

function makeD1(s: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      const statement = s.prepare(sql);
      let params: unknown[] = [];
      return {
        bind(...values: unknown[]) { params = values; return this; },
        async run() {
          const r = statement.run(...(params as never[]));
          return { meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } };
        },
        async first<T = unknown>() {
          const row = statement.get(...(params as never[])) as T | undefined;
          return row ?? null;
        },
        async all<T = unknown>() {
          return { results: statement.all(...(params as never[])) as T[] };
        },
      };
    },
    async batch(stmts: { run(): Promise<unknown> }[]) {
      s.exec('BEGIN');
      try {
        const out = [];
        for (const st of stmts) out.push(await st.run());
        s.exec('COMMIT');
        return out;
      } catch (e) {
        s.exec('ROLLBACK');
        throw e;
      }
    },
  } as unknown as D1Database;
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL); CREATE TABLE user_profiles (user_id TEXT PRIMARY KEY, ai_config_json TEXT);');
  db = makeD1(sqlite);
  sqlite.prepare("INSERT INTO users (id, email, password_hash) VALUES (?, 'tp@x.com', 'x')").run(USER);
  resetRateLimitsForTest();

  app = new Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>();
  app.use('*', async (c, next) => { c.set('userId', USER); await next(); });
  app.route('/api/v1/ai', aiRouter);
});

afterEach(() => {
  sqlite.close();
  resetRateLimitsForTest();
  // @ts-expect-error 清理全局 fetch
  delete globalThis.fetch;
});

function env() {
  return { DB: db } as any;
}

function stubFetch(handler: (init: RequestInit) => Response) {
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => handler(init ?? {})) as unknown as typeof fetch;
}

function provider(overrides: Record<string, unknown> = {}) {
  return {
    provider: { apiKey: 'sk-xx', baseUrl: 'https://example.com/v1', textModel: 'gpt-test', ...overrides },
  };
}

async function testProvider(payload: Record<string, unknown>) {
  return app.request('/api/v1/ai/test-provider', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '127.0.0.1' },
    body: JSON.stringify(payload),
  }, env());
}

describe('test-provider happy path（移植上游 test_ai_test_provider.py）', () => {
  it('text capability', async () => {
    stubFetch(() => new Response(JSON.stringify({ choices: [{ message: { content: 'Hi! How can I help?' } }] }), { status: 200 }));
    const res = await testProvider({ ...provider(), capability: 'text' });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.preview).toContain('Hi');
    expect(body.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it('vision capability：调用方传了 image_url', async () => {
    stubFetch((init) => {
      const payload = JSON.parse(String(init.body)) as any;
      const msg = payload.messages[0].content;
      expect(msg.some((part: any) => part.type === 'image_url')).toBe(true);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'a red square' } }] }), { status: 200 });
    });
    const res = await testProvider({ ...provider({ visionModel: 'gpt-vision' }), capability: 'vision' });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.preview).toContain('red');
  });

  it('speech capability：静音 WAV 返空 text 也算成功', async () => {
    stubFetch(() => new Response(JSON.stringify({ text: '' }), { status: 200 }));
    const res = await testProvider({ ...provider({ audioModel: 'whisper-1' }), capability: 'speech' });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.preview).toBe('');
  });
});

describe('test-provider 错误归类（移植上游）', () => {
  it('401 → AI_TEST_AUTH', async () => {
    stubFetch(() => new Response('{"error":"Invalid API key"}', { status: 401 }));
    const res = await testProvider({ ...provider(), capability: 'text' });
    const body = await res.json() as any;
    expect(body.success).toBe(false);
    expect(body.error_code).toBe('AI_TEST_AUTH');
    expect(body.error_message).toContain('401');
  });

  it('404 model not found → AI_TEST_MODEL_NOT_FOUND', async () => {
    stubFetch(() => new Response('{"error":"model not found"}', { status: 404 }));
    const res = await testProvider({ ...provider({ textModel: 'missing-model' }), capability: 'text' });
    const body = await res.json() as any;
    expect(body.success).toBe(false);
    expect(body.error_code).toBe('AI_TEST_MODEL_NOT_FOUND');
  });

  it('timeout → AI_TEST_TIMEOUT', async () => {
    stubFetch(() => { throw new Error('connect timeout'); });
    const res = await testProvider({ ...provider(), capability: 'text' });
    const body = await res.json() as any;
    expect(body.success).toBe(false);
    expect(body.error_code).toBe('AI_TEST_TIMEOUT');
  });
});

describe('test-provider 速率限制 + 参数自适应（移植上游）', () => {
  it('60s 内第 31 次 → 429 AI_TEST_RATE_LIMITED', async () => {
    stubFetch(() => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }));
    const payload = { ...provider(), capability: 'text' };
    for (let i = 0; i < 30; i++) {
      const r = await testProvider(payload);
      expect(r.status).toBe(200);
    }
    const r = await testProvider(payload);
    expect(r.status).toBe(429);
    const body = await r.json() as any;
    expect(body.error_code).toBe('AI_TEST_RATE_LIMITED');
  });

  it('temperature 被拒 → 摘掉重发 → 成功（Moonshot kimi-k2.5）', async () => {
    const calls: Array<Record<string, unknown> | null> = [];
    stubFetch((init) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push(body);
      if ('temperature' in body) {
        return new Response(
          '{"error":{"message":"invalid temperature: only 1 is allowed for this model","type":"invalid_request_error"}}',
          { status: 400 },
        );
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }), { status: 200 });
    });
    const res = await testProvider({ ...provider({ baseUrl: 'https://api.moonshot.cn/v1', textModel: 'kimi-k2.5' }), capability: 'text' });
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(calls).toHaveLength(2);
    expect('temperature' in calls[0]!).toBe(true);
    expect('temperature' in calls[1]!).toBe(false);
  });

  it('vision 空模型 → AI_TEST_MISSING_FIELDS', async () => {
    const res = await testProvider({ ...provider({ visionModel: '' }), capability: 'vision' });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(false);
    expect(body.error_code).toBe('AI_TEST_MISSING_FIELDS');
  });
});
