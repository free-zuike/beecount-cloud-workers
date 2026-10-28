import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTestEnv, registerTestUser, getAuthToken, TEST_JWT_SECRET } from './helpers/test-env';
import { getTable } from './helpers/mock-db';
import readRouter from '../src/routes/read';

let env: Awaited<ReturnType<typeof createTestEnv>>;
let token: string;

beforeEach(async () => {
  env = await createTestEnv();
  await registerTestUser(env.app, 'proxy@example.com');
  token = await getAuthToken(env.app, 'proxy@example.com');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const authHeaders = () => ({
  Authorization: `Bearer ${token}`,
});

/** 取价链是「jsDelivr 镜像(fawazahmed0) → frankfurter」，mock 按 URL 返回对应形状 */
function stubFetchOk(rates: Record<string, string>, date = '2026-06-10') {
  const fn = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes('jsdelivr')) {
      const base = (u.match(/currencies\/([a-z0-9]+)\.min\.json/) ?? [, 'cny'])[1];
      // fawazahmed0 形状：data[base] = { QUOTE: rate }
      const inner: Record<string, number> = {};
      for (const [k, v] of Object.entries(rates)) inner[k.toUpperCase()] = Number(v);
      return { ok: true, status: 200, json: async () => ({ date, [base]: inner }) };
    }
    return { ok: true, status: 200, json: async () => ({ rates, date }) };
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function stubFetchFail() {
  const fn = vi.fn(async () => ({ ok: false, status: 502 }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('GET /read/exchange-rates 汇率代理契约', () => {
  it('命中缓存第二次不再打上游,base 归一大写,rates 返回字符串', async () => {
    const fetchMock = stubFetchOk({ USD: '0.1477', JPY: '21.65' });

    const r1 = await env.app.request('/api/v1/read/exchange-rates?base=cny', { headers: authHeaders() });
    expect(r1.status).toBe(200);
    const b1 = await r1.json() as any;
    expect(b1.base).toBe('CNY');
    expect(b1.stale).toBe(false);
    expect(typeof b1.rates).toBe('object');
    expect(b1.rates.USD).toBe('0.1477');
    // 取价链第一个源就是 jsDelivr 镜像，命中即停
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('jsdelivr');

    const r2 = await env.app.request('/api/v1/read/exchange-rates?base=CNY', { headers: authHeaders() });
    expect(r2.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('缓存过期且上游全挂时回 stale 并返回旧 rates', async () => {
    stubFetchOk({ USD: '0.1400', JPY: '20.00' }, '2026-06-08');
    const r1 = await env.app.request('/api/v1/read/exchange-rates?base=CNY', { headers: authHeaders() });
    expect(r1.status).toBe(200);

    const cache = getTable(env.db, 'exchange_rate_cache');
    expect(cache).toHaveLength(1);
    cache[0].fetched_at = new Date(Date.now() - 48 * 3600 * 1000).toISOString();

    stubFetchFail();
    const r2 = await env.app.request('/api/v1/read/exchange-rates?base=CNY', { headers: authHeaders() });
    expect(r2.status).toBe(200);
    const b2 = await r2.json() as any;
    expect(b2.stale).toBe(true);
    // 缓存按数值存（对齐上游 fetcher），输出转字符串
    expect(b2.rates.USD).toBe('0.14');
  });

  it('无缓存且上游挂掉时返回 503', async () => {
    stubFetchFail();
    const r = await env.app.request('/api/v1/read/exchange-rates?base=CNY', { headers: authHeaders() });
    expect(r.status).toBe(503);
  });

  it('EXCHANGE_RATE_PROXY_ENABLED=false 时返回 404', async () => {
    const fn = stubFetchOk({ USD: '0.1477' });
    const r = await readRouter.request(
      '/exchange-rates?base=CNY',
      {},
      { DB: env.db, JWT_SECRET: TEST_JWT_SECRET, EXCHANGE_RATE_PROXY_ENABLED: 'false' } as any,
    );
    expect(r.status).toBe(404);
    expect(fn).not.toHaveBeenCalled();
  });

  it('非法 base 在打上游前被 pattern 拦截,返回 400', async () => {
    const fn = vi.fn(async () => {
      throw new Error('fetcher 不该被非法 base 触达');
    });
    vi.stubGlobal('fetch', fn);

    for (const bad of ['../x', 'us d', 'ZZZZZZZZZ', 'x', 'C/N', 'A'.repeat(500)]) {
      const r = await env.app.request(`/api/v1/read/exchange-rates?base=${encodeURIComponent(bad)}`, { headers: authHeaders() });
      expect(r.status).toBe(400);
    }
    expect(fn).not.toHaveBeenCalled();
  });
});