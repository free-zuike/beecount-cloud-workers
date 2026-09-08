import { describe, it, expect, beforeEach } from 'vitest';
import { createTestEnv, registerTestUser, getAuthToken } from '../helpers/test-env';
import { getTable } from '../helpers/mock-db';
import { initializeDatabase } from '../../src/db/schema';

let env: Awaited<ReturnType<typeof createTestEnv>>;
let token: string;
const email = 'fx@example.com';

beforeEach(async () => {
  env = await createTestEnv();
  await registerTestUser(env.app, email);
  token = await getAuthToken(env.app, email);
});

const authHeaders = (t: string) => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${t}`,
});

describe('exchange_rate_overrides → user_exchange_rate_projection 对齐', () => {
  it('PUT /write/exchange-rate-overrides 写入新投影表 + sync_changes；GET 能列出', async () => {
    const put = await env.app.request('/api/v1/write/exchange-rate-overrides', {
      method: 'PUT',
      headers: authHeaders(token),
      body: JSON.stringify({ base_currency: 'USD', quote_currency: 'JPY', rate: 150 }),
    });
    expect(put.status).toBe(200);
    const putBody = await put.json() as any;
    expect(putBody.sync_id).toBeDefined();

    const rows = getTable(env.db, 'user_exchange_rate_projection');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sync_id: putBody.sync_id,
      base_currency: 'USD',
      quote_currency: 'JPY',
      rate: '150',
    });

    const changes = getTable(env.db, 'sync_changes');
    expect(changes.some(c => c.entity_type === 'exchange_rate_override' && c.action === 'upsert')).toBe(true);

    const get = await env.app.request('/api/v1/read/exchange-rate-overrides', { headers: authHeaders(token) });
    const list = await get.json() as any[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ base_currency: 'USD', quote_currency: 'JPY', rate: '150' });
  });

  it('重复 PUT 复用同一 sync_id（upsert 不产生新行）', async () => {
    const first = await (await env.app.request('/api/v1/write/exchange-rate-overrides', {
      method: 'PUT', headers: authHeaders(token),
      body: JSON.stringify({ base_currency: 'USD', quote_currency: 'JPY', rate: 150 }),
    })).json() as any;
    const second = await (await env.app.request('/api/v1/write/exchange-rate-overrides', {
      method: 'PUT', headers: authHeaders(token),
      body: JSON.stringify({ base_currency: 'USD', quote_currency: 'JPY', rate: 152 }),
    })).json() as any;

    expect(second.sync_id).toBe(first.sync_id);
    const rows = getTable(env.db, 'user_exchange_rate_projection');
    expect(rows).toHaveLength(1);
    expect(rows[0].rate).toBe('152');
  });

  it('DELETE 删除覆盖并写 delete 同步记录', async () => {
    await env.app.request('/api/v1/write/exchange-rate-overrides', {
      method: 'PUT', headers: authHeaders(token),
      body: JSON.stringify({ base_currency: 'USD', quote_currency: 'JPY', rate: 150 }),
    });
    const del = await env.app.request('/api/v1/write/exchange-rate-overrides?base_currency=USD&quote_currency=JPY', {
      method: 'DELETE', headers: authHeaders(token),
    });
    expect(del.status).toBe(200);
    expect(getTable(env.db, 'user_exchange_rate_projection')).toHaveLength(0);
    expect(getTable(env.db, 'sync_changes').some(c => c.entity_type === 'exchange_rate_override' && c.action === 'delete')).toBe(true);
  });

  it('sync/push exchange_rate_override 应用到投影表（sync_id 必须写入，rate 存字符串）', async () => {
    const push = await env.app.request('/api/v1/sync/push', {
      method: 'POST',
      headers: { ...authHeaders(token), 'X-Device-ID': 'test-device-001' },
      body: JSON.stringify({
        device_id: 'test-device-001',
        changes: [{
          ledger_id: null,
          entity_type: 'exchange_rate_override',
          entity_sync_id: 'fx-sync-1',
          action: 'upsert',
          payload: { baseCurrency: 'USD', quoteCurrency: 'EUR', rate: 0.9 },
          updated_at: new Date().toISOString(),
        }],
      }),
    });
    expect(push.status).toBe(200);

    const rows = getTable(env.db, 'user_exchange_rate_projection');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sync_id: 'fx-sync-1',
      base_currency: 'USD',
      quote_currency: 'EUR',
      rate: '0.9',
    });

    // delete 变更 → 行被移除
    const del = await env.app.request('/api/v1/sync/push', {
      method: 'POST',
      headers: { ...authHeaders(token), 'X-Device-ID': 'test-device-001' },
      body: JSON.stringify({
        device_id: 'test-device-001',
        changes: [{
          ledger_id: null,
          entity_type: 'exchange_rate_override',
          entity_sync_id: 'fx-sync-1',
          action: 'delete',
          payload: {},
          updated_at: new Date().toISOString(),
        }],
      }),
    });
    expect(del.status).toBe(200);
    expect(getTable(env.db, 'user_exchange_rate_projection')).toHaveLength(0);
  });

  it('老表 exchange_rate_overrides 数据迁移到新表并删除老表', async () => {
    // 模拟老库：已有 exchange_rate_overrides 数据 + sqlite_master 记录
    const legacy = getTable(env.db, 'exchange_rate_overrides');
    legacy.push({ id: 1, user_id: 'u-legacy', sync_id: 'fx-old-1', base_currency: 'USD', quote_currency: 'CNY', rate: '7.2', updated_at: '2025-01-01T00:00:00Z' });
    legacy.push({ id: 2, user_id: 'u-legacy', sync_id: 'fx-old-2', base_currency: 'EUR', quote_currency: 'CNY', rate: '7.8', updated_at: '2025-01-01T00:00:00Z' });
    getTable(env.db, 'sqlite_master').push({ type: 'table', name: 'exchange_rate_overrides' });

    await initializeDatabase(env.db as any);

    const rows = getTable(env.db, 'user_exchange_rate_projection');
    expect(rows).toHaveLength(2);
    const byPair = Object.fromEntries(rows.map(r => [`${r.base_currency}/${r.quote_currency}`, r]));
    expect(byPair['USD/CNY']).toMatchObject({ sync_id: 'fx-old-1', rate: '7.2', source_change_id: 0 });
    expect(byPair['EUR/CNY']).toMatchObject({ sync_id: 'fx-old-2', rate: '7.8', source_change_id: 0 });

    // 老表不再有数据引用（DROP 后查询为空）
    const legacyAfter = getTable(env.db, 'exchange_rate_overrides');
    expect(legacyAfter).toHaveLength(0);
  });
});
