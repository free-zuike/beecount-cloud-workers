// 移植上游 tests/test_ai_parse_tx.py 的端点部分（B2 截图 / B3 文本）：
// - parse-tx-image:无 vision → 400；happy path(mock LLM)→ tx_drafts + image_id；6MB → 413
// - parse-tx-text:无 chat → 400；happy path(mock LLM)
// LLM 上游通过全局 fetch mock（本地 callAiChatJson 内部 fetch）。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import aiRouter from '../src/routes/ai';

let sqlite: DatabaseSync;
let db: D1Database;
let app: Hono<{ Bindings: { DB: D1Database; R2?: unknown }; Variables: { userId: string } }>;

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

const DDL = `
  CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL);
  CREATE TABLE user_profiles (user_id TEXT PRIMARY KEY, ai_config_json TEXT, primary_currency TEXT);
  CREATE TABLE ledgers (id TEXT PRIMARY KEY, user_id TEXT, external_id TEXT, name TEXT, currency TEXT, month_start_day INTEGER DEFAULT 1, created_at TEXT);
  CREATE TABLE user_category_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, kind TEXT, level INTEGER, sort_order INTEGER, icon TEXT, icon_type TEXT, custom_icon_path TEXT, icon_cloud_file_id TEXT, icon_cloud_sha256 TEXT, parent_name TEXT, parent_sync_id TEXT, source_change_id INTEGER DEFAULT 0);
  CREATE TABLE user_account_projection (
    sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, account_type TEXT, currency TEXT,
    initial_balance REAL DEFAULT 0, note TEXT, credit_limit REAL, billing_day INTEGER, payment_due_day INTEGER,
    bank_name TEXT, card_last_four TEXT, hidden INTEGER DEFAULT 0, source_change_id INTEGER DEFAULT 0
  );
  CREATE TABLE ai_image_cache (
    image_id TEXT PRIMARY KEY, user_id TEXT, mime_type TEXT, size_bytes INTEGER, r2_key TEXT, created_at TEXT
  );
`;

function seedProfile(aiConfig: Record<string, unknown>) {
  sqlite.prepare('INSERT OR REPLACE INTO user_profiles (user_id, ai_config_json) VALUES (?, ?)').run(USER, JSON.stringify(aiConfig));
}

function configWith(vision: boolean, text: boolean = true) {
  return {
    providers: [{
      id: 'p1',
      apiKey: 'sk-test',
      baseUrl: 'https://example.com/v1',
      textModel: text ? 'glm-4-flash' : '',
      visionModel: vision ? 'glm-4v-flash' : '',
    }],
    binding: { textProviderId: 'p1', visionProviderId: vision ? 'p1' : null },
  };
}

const mockR2 = {
  put: async () => ({}) as never,
  get: async () => null as never,
  delete: async () => ({}) as never,
};

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec(DDL);
  db = makeD1(sqlite);
  sqlite.prepare("INSERT INTO users (id, email, password_hash) VALUES (?, 'a@x.com', 'x')").run(USER);
  sqlite.prepare("INSERT INTO ledgers (id, user_id, external_id, name, currency, created_at) VALUES ('lg1', ?, 'L1', 'imp', 'CNY', '2025-01-01T00:00:00Z')").run(USER);
  sqlite.prepare("INSERT INTO user_category_projection (sync_id, user_id, name, kind, level) VALUES ('cat-food', ?, '餐饮', 'expense', 1)").run(USER);
  sqlite.prepare("INSERT INTO user_account_projection (sync_id, user_id, name, account_type, currency) VALUES ('acc-wx', ?, '微信', 'debit', 'CNY')").run(USER);

  app = new Hono<{ Bindings: { DB: D1Database; R2?: unknown }; Variables: { userId: string } }>();
  app.use('*', async (c, next) => { c.set('userId', USER); await next(); });
  app.route('/api/v1/ai', aiRouter);
});

afterEach(() => {
  sqlite.close();
  // @ts-expect-error 清理全局 fetch
  delete globalThis.fetch;
});

function env() {
  return { DB: db, R2: mockR2 } as any;
}

function stubLlm(txDrafts: unknown) {
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ tx_drafts: txDrafts }) } }],
    }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe('parse-tx-image（移植上游 test_ai_parse_tx.py）', () => {
  it('用户没绑 vision provider → 400 AI_NO_VISION_PROVIDER', async () => {
    seedProfile(configWith(false));
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }), 'test.jpg');
    form.append('locale', 'zh');
    const res = await app.request('/api/v1/ai/parse-tx-image', {
      method: 'POST',
      headers: { 'CF-Connecting-IP': '127.0.0.1' },
      body: form,
    }, env());
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.code).toBe('AI_NO_VISION_PROVIDER');
  });

  it('happy path：mock LLM 返合规 tx_drafts → normalized + image_id', async () => {
    seedProfile(configWith(true));
    stubLlm([
      {
        type: 'expense', amount: 35.0, happened_at: '2026-05-06T12:30:00Z',
        category_name: '餐饮', account_name: '微信', note: '星巴克', tags: ['商务'], confidence: 'high',
      },
      {
        type: 'expense', amount: 28.0, happened_at: '2026-05-06T18:00:00Z',
        category_name: '交通', account_name: '', note: '滴滴', confidence: 'medium',
      },
    ]);
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }), 'test.jpg');
    form.append('locale', 'zh');
    const res = await app.request('/api/v1/ai/parse-tx-image', {
      method: 'POST',
      headers: { 'CF-Connecting-IP': '127.0.0.1' },
      body: form,
    }, env());
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.tx_drafts).toHaveLength(2);
    expect(body.tx_drafts[0].amount).toBe(35);
    expect(body.tx_drafts[0].confidence).toBe('high');
    expect(body.image_id).toBeTruthy();
    // 缓存落库
    const cnt = sqlite.prepare('SELECT COUNT(*) AS c FROM ai_image_cache WHERE user_id = ?').get(USER) as { c: number };
    expect(cnt.c).toBe(1);
  });

  it('6MB 超限 → 413 AI_IMAGE_TOO_LARGE', async () => {
    seedProfile(configWith(true));
    const big = new Uint8Array(6 * 1024 * 1024);
    const form = new FormData();
    form.append('image', new Blob([big], { type: 'image/jpeg' }), 'big.jpg');
    const res = await app.request('/api/v1/ai/parse-tx-image', {
      method: 'POST',
      headers: { 'CF-Connecting-IP': '127.0.0.1' },
      body: form,
    }, env());
    expect(res.status).toBe(413);
    const body = await res.json() as any;
    expect(body.error.code).toBe('AI_IMAGE_TOO_LARGE');
  });
});

describe('parse-tx-text（移植上游 test_ai_parse_tx.py）', () => {
  it('用户没配 chat provider → 400 AI_NO_CHAT_PROVIDER', async () => {
    const res = await app.request('/api/v1/ai/parse-tx-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '127.0.0.1' },
      body: JSON.stringify({ text: '昨天打车 30', locale: 'zh' }),
    }, env());
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.code).toBe('AI_NO_CHAT_PROVIDER');
  });

  it('happy path：mock LLM → 1 笔 draft', async () => {
    seedProfile(configWith(true));
    stubLlm([
      {
        type: 'expense', amount: 30.0, happened_at: '2026-05-06T18:00:00Z',
        category_name: '交通', note: '打车', confidence: 'high',
      },
    ]);
    const res = await app.request('/api/v1/ai/parse-tx-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '127.0.0.1' },
      body: JSON.stringify({ text: '昨天打车 30 块', locale: 'zh' }),
    }, env());
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.tx_drafts).toHaveLength(1);
    expect(body.tx_drafts[0].note).toBe('打车');
  });
});
