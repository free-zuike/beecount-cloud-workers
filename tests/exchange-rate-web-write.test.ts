import { describe, it, expect, beforeEach } from 'vitest';
import { createTestEnv, registerTestUser, getAuthToken } from './helpers/test-env';
import { getTable } from './helpers/mock-db';

let env: Awaited<ReturnType<typeof createTestEnv>>;
let token: string;

beforeEach(async () => {
  env = await createTestEnv();
  await registerTestUser(env.app, 'wr@example.com');
  token = await getAuthToken(env.app, 'wr@example.com');
});

const authHeaders = () => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${token}`,
});

const rateRows = () => getTable(env.db, 'user_exchange_rate_projection');
const changeRows = () => getTable(env.db, 'sync_changes');

describe('web 写 exchange-rate-overrides 契约', () => {
  it('PUT 币对大小写归一:小写 cny/usd → 返回大写;再以大写 PUT 复用同一 sync_id(对齐上游)', async () => {
    const r1 = await env.app.request('/api/v1/write/exchange-rate-overrides', {
      method: 'PUT', headers: authHeaders(),
      body: JSON.stringify({ base_currency: 'cny', quote_currency: 'usd', rate: '7.20' }),
    });
    expect(r1.status).toBe(200);
    const b1 = await r1.json() as any;
    const syncId1 = b1.sync_id;
    expect(b1.base_currency).toBe('CNY');
    expect(b1.quote_currency).toBe('USD');
    expect(b1.rate).toBe('7.20');

    const r2 = await env.app.request('/api/v1/write/exchange-rate-overrides', {
      method: 'PUT', headers: authHeaders(),
      body: JSON.stringify({ base_currency: 'CNY', quote_currency: 'USD', rate: '7.50' }),
    });
    expect(r2.status).toBe(200);
    const b2 = await r2.json() as any;
    expect(b2.sync_id).toBe(syncId1); // 同币对复用 sync_id

    expect(rateRows()).toHaveLength(1);
    expect(rateRows()[0].rate).toBe('7.50');

    const upserts = changeRows().filter(c => c.entity_type === 'exchange_rate_override' && c.action === 'upsert');
    expect(upserts).toHaveLength(2);
    for (const ch of upserts) {
      expect(ch.scope).toBe('user');
      expect(ch.ledger_id).toBeNull();
    }
  });

  it('DELETE 移除投影并写 delete 变更,变更的 entity_sync_id 复用写入时的 sync_id', async () => {
    const put = await env.app.request('/api/v1/write/exchange-rate-overrides', {
      method: 'PUT', headers: authHeaders(),
      body: JSON.stringify({ base_currency: 'JPY', quote_currency: 'CNY', rate: '0.046' }),
    });
    expect(put.status).toBe(200);
    const putBody = await put.json() as any;
    const putSyncId = putBody.sync_id;

    const del = await env.app.request('/api/v1/write/exchange-rate-overrides?base_currency=JPY&quote_currency=CNY', {
      method: 'DELETE', headers: authHeaders(),
    });
    expect(del.status).toBe(200);
    const delBody = await del.json() as any;
    expect(delBody.base_currency).toBe('JPY');
    expect(delBody.quote_currency).toBe('CNY');

    expect(rateRows()).toHaveLength(0);

    const delChange = changeRows().find(c =>
      c.entity_type === 'exchange_rate_override' && c.action === 'delete' && c.entity_sync_id === putSyncId);
    expect(delChange).toBeDefined();
    expect(delChange!.scope).toBe('user');
    expect(delChange!.ledger_id).toBeNull();
  });

  it('DELETE 不存在的币对 → 404(对齐上游)', async () => {
    const del = await env.app.request('/api/v1/write/exchange-rate-overrides?base_currency=EUR&quote_currency=CNY', {
      method: 'DELETE', headers: authHeaders(),
    });
    expect(del.status).toBe(404);

    expect(rateRows()).toHaveLength(0);
  });

  it('PUT rate 校验:非数字/零/≥1e9/特殊值/base==quote 均 422(对齐上游)', async () => {
    for (const bad of ['not-a-number', '0', '1000000000', 'inf', 'nan', '-inf', 'Infinity', 'NaN']) {
      const r = await env.app.request('/api/v1/write/exchange-rate-overrides', {
        method: 'PUT', headers: authHeaders(),
        body: JSON.stringify({ base_currency: 'CNY', quote_currency: 'USD', rate: bad }),
      });
      expect(r.status, `rate=${bad}`).toBe(422);
    }

    const same = await env.app.request('/api/v1/write/exchange-rate-overrides', {
      method: 'PUT', headers: authHeaders(),
      body: JSON.stringify({ base_currency: 'CNY', quote_currency: 'CNY', rate: '1.0' }),
    });
    expect(same.status).toBe(422);

    const ok = await env.app.request('/api/v1/write/exchange-rate-overrides', {
      method: 'PUT', headers: authHeaders(),
      body: JSON.stringify({ base_currency: 'CNY', quote_currency: 'USD', rate: '7.20' }),
    });
    expect(ok.status).toBe(200);
  });
});