// 移植上游 tests/test_ai_ask.py：
// POST /api/v1/ai/ask — mock RAG service + embedding + provider fetch，验证：
// 无 chat provider → 400 / 索引空 → 503 / embedding 未配置 → 503 /
// happy path SSE chunk/sources/done / hybrid 检索参数传递 / provider 错误 → SSE error。
// 注：上游 test_ask_requires_auth 依赖完整 auth 链，本地测试层无真实鉴权中间件，
// 该例不移植（等价覆盖在 middleware-auth.test.ts / security-scopes.test.ts）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import aiRouter from '../src/routes/ai';
import { authMiddleware } from '../src/middleware/auth';

vi.mock('../src/services/rag-refresh', () => {
  class MockEmbeddingNotConfiguredError extends Error {}
  return {
    EmbeddingNotConfiguredError: MockEmbeddingNotConfiguredError,
    embedQuery: vi.fn(),
    getRagService: vi.fn(),
  };
});

import { embedQuery, getRagService, EmbeddingNotConfiguredError } from '../src/services/rag-refresh';
import type { DocsRefreshService } from '../src/services/rag-refresh';

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

interface MockIndex {
  is_empty: boolean;
  retrieve: ReturnType<typeof vi.fn>;
}

function makeService(index: MockIndex) {
  return {
    init: vi.fn(async () => {}),
    getIndex: vi.fn(() => index),
    retrieve: index.retrieve,
    statusValue: vi.fn(() => ({})),
    checkLatest: vi.fn(async () => ({})),
  } as unknown as DocsRefreshService;
}

const fakeChunks = [
  {
    chunk: {
      doc_path: 'security/two-factor.md#0', doc_title: '2FA 启用', section: 'section-0',
      content: 'chunk 0 content about 2FA setup step 0', url: 'https://count.beejz.com/docs/security/two-factor#0',
    },
  },
  {
    chunk: {
      doc_path: 'security/two-factor.md#1', doc_title: '2FA 启用', section: 'section-1',
      content: 'chunk 1 content about 2FA setup step 1', url: 'https://count.beejz.com/docs/security/two-factor#1',
    },
  },
  {
    chunk: {
      doc_path: 'security/two-factor.md#2', doc_title: '2FA 启用', section: 'section-2',
      content: 'chunk 2 content about 2FA setup step 2', url: 'https://count.beejz.com/docs/security/two-factor#2',
    },
  },
];

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL); CREATE TABLE user_profiles (user_id TEXT PRIMARY KEY, ai_config_json TEXT);');
  db = makeD1(sqlite);
  sqlite.prepare("INSERT INTO users (id, email, password_hash) VALUES (?, 'ask@x.com', 'x')").run(USER);
  vi.clearAllMocks();

  app = new Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>();
  app.use('*', async (c, next) => { c.set('userId', USER); await next(); });
  app.route('/api/v1/ai', aiRouter);
});

afterEach(() => {
  sqlite.close();
  // @ts-expect-error 清理全局 fetch
  delete globalThis.fetch;
});

function env() {
  return { DB: db } as any;
}

function seedProfile(aiConfig: Record<string, unknown>) {
  sqlite.prepare('INSERT OR REPLACE INTO user_profiles (user_id, ai_config_json) VALUES (?, ?)').run(USER, JSON.stringify(aiConfig));
}

function configWithChat() {
  return {
    providers: [{ id: 'zhipu_glm', apiKey: 'sk-x', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', textModel: 'glm-4-flash' }],
    binding: { textProviderId: 'zhipu_glm' },
  };
}

async function ask(body: Record<string, unknown>) {
  return app.request('/api/v1/ai/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '127.0.0.1' },
    body: JSON.stringify(body),
  }, env());
}

function parseSse(text: string): Array<Record<string, unknown>> {
  return text.split('\n\n')
    .filter(line => line.startsWith('data: '))
    .map(line => JSON.parse(line.slice('data: '.length)));
}

describe('ask 错误路径（移植上游 test_ai_ask.py）', () => {
  it('无 token → 401（requires_auth，对齐上游）', async () => {
    // 生产经 index.ts 的 /api/v1/* authMiddleware 保护，这里用同款中间件复现
    const authApp = new Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>();
    authApp.use('/api/v1/*', authMiddleware);
    authApp.route('/api/v1/ai', aiRouter);
    const res = await authApp.request('/api/v1/ai/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '127.0.0.1' },
      body: JSON.stringify({ query: 'hi' }),
    }, env());
    expect([401, 403]).toContain(res.status);
  });

  it('用户没配 chat provider → 400 AI_NO_CHAT_PROVIDER', async () => {
    vi.mocked(getRagService).mockReturnValue(makeService({ is_empty: false, retrieve: vi.fn(() => []) }));
    const res = await ask({ query: '怎么开 2FA', locale: 'zh' });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error_code).toBe('AI_NO_CHAT_PROVIDER');
  });

  it('索引为空 → 503 AI_DOCS_INDEX_EMPTY', async () => {
    seedProfile(configWithChat());
    vi.mocked(getRagService).mockReturnValue(makeService({ is_empty: true, retrieve: vi.fn(() => []) }));
    const res = await ask({ query: '怎么开 2FA', locale: 'zh' });
    expect(res.status).toBe(503);
    const body = await res.json() as any;
    expect(body.error_code).toBe('AI_DOCS_INDEX_EMPTY');
  });

  it('embedding 未配置 → 503 AI_EMBEDDING_UNAVAILABLE', async () => {
    seedProfile(configWithChat());
    vi.mocked(getRagService).mockReturnValue(makeService({ is_empty: false, retrieve: vi.fn(() => []) }));
    (embedQuery as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new EmbeddingNotConfiguredError('embedding not configured'));
    const res = await ask({ query: '怎么开 2FA', locale: 'zh' });
    expect(res.status).toBe(503);
    const body = await res.json() as any;
    expect(body.error_code).toBe('AI_EMBEDDING_UNAVAILABLE');
  });
});

describe('ask happy path + 检索 + provider 错误（移植上游 test_ai_ask.py）', () => {
  it('配齐 → SSE chunk/sources/done 事件序列', async () => {
    seedProfile(configWithChat());
    vi.mocked(getRagService).mockReturnValue(makeService({ is_empty: false, retrieve: vi.fn(() => fakeChunks) }));
    (embedQuery as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1]);

    globalThis.fetch = (async () => {
      const sse = [
        'data: {"choices":[{"delta":{"content":"在"}}]}',
        'data: {"choices":[{"delta":{"content":"个人资料页"}}]}',
        'data: {"choices":[{"delta":{"content":"点开 2FA。"}}]}',
        'data: [DONE]',
        '',
      ].join('\n\n');
      return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }) as unknown as typeof fetch;

    const res = await ask({ query: '怎么开 2FA', locale: 'zh' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')?.startsWith('text/event-stream')).toBe(true);
    const events = parseSse(await res.text());
    const types = events.map(e => e.type);
    expect(types).toEqual(['chunk', 'chunk', 'chunk', 'sources', 'done']);
    const full = events.filter(e => e.type === 'chunk').map(e => e.text).join('');
    expect(full).toBe('在个人资料页点开 2FA。');
    const sources = events.find(e => e.type === 'sources')!.items as Array<{ url: string }>;
    expect(sources).toHaveLength(3);
    expect(sources.every(s => s.url.startsWith('https://count.beejz.com/docs/'))).toBe(true);
  });

  it('检索走 hybrid_search：query + embedding + k 传到 retrieve', async () => {
    seedProfile(configWithChat());
    const retrieve = vi.fn(() => [] as typeof fakeChunks);
    vi.mocked(getRagService).mockReturnValue(makeService({ is_empty: false, retrieve }));
    (embedQuery as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([0.25, 0.75]);

    globalThis.fetch = (async () => {
      const sse = ['data: {"choices":[{"delta":{"content":"文档中没有更多说明。"}}]}', 'data: [DONE]', ''].join('\n\n');
      return new Response(sse, { status: 200 });
    }) as unknown as typeof fetch;

    const res = await ask({ query: '删除附件', locale: 'zh' });
    expect(res.status).toBe(200);
    expect(retrieve).toHaveBeenCalledWith('zh', '删除附件', [0.25, 0.75], 4);
  });

  it('provider 报错 → SSE error event（AI_PROVIDER_ERROR）', async () => {
    seedProfile(configWithChat());
    vi.mocked(getRagService).mockReturnValue(makeService({ is_empty: false, retrieve: vi.fn(() => fakeChunks) }));
    (embedQuery as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1]);
    globalThis.fetch = (async () => {
      throw new Error('provider returned 401: invalid api_key');
    }) as unknown as typeof fetch;

    const res = await ask({ query: 'test', locale: 'zh' });
    expect(res.status).toBe(200);
    const events = parseSse(await res.text());
    const types = events.map(e => e.type);
    expect(types).toContain('error');
    const err = events.find(e => e.type === 'error')!;
    expect(err.error_code).toBe('AI_PROVIDER_ERROR');
    expect(String(err.message)).toContain('401');
  });
});
