import { describe, it, expect, beforeEach } from 'vitest';
import { createTestEnv, registerTestUser, getAuthToken, TEST_DEVICE_ID } from './helpers/test-env';
import { getTable } from './helpers/mock-db';

let env: Awaited<ReturnType<typeof createTestEnv>>;
let token: string;

beforeEach(async () => {
  env = await createTestEnv();
  await registerTestUser(env.app, 'fxsync@example.com');
  token = await getAuthToken(env.app, 'fxsync@example.com');
});

const authHeaders = () => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${token}`,
  'X-Device-ID': TEST_DEVICE_ID,
});

function ratePayload(syncId: string, base = 'CNY', quote = 'USD', rate = '7.2034'): Record<string, unknown> {
  return { syncId, baseCurrency: base, quoteCurrency: quote, rate, updatedAt: '2026-06-10T00:00:00+00:00' };
}

async function pushRate(
  syncId: string,
  payload: Record<string, unknown>,
  updatedAt: string,
  action: 'upsert' | 'delete' = 'upsert',
) {
  const r = await env.app.request('/api/v1/sync/push', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      device_id: TEST_DEVICE_ID,
      changes: [{
        ledger_id: null,
        entity_type: 'exchange_rate_override',
        entity_sync_id: syncId,
        action,
        payload,
        updated_at: updatedAt,
      }],
    }),
  });
  expect(r.status).toBe(200);
}

const rateRows = () => getTable(env.db, 'user_exchange_rate_projection');
const changeRows = () => getTable(env.db, 'sync_changes');

describe('sync 侧 exchange_rate_override 契约', () => {
  it('push 落 user 投影且 SyncChange scope=user、ledger_id 为 null', async () => {
    await pushRate('rate-1', ratePayload('rate-1'), new Date().toISOString());

    const rows = rateRows().filter(r => r.sync_id === 'rate-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ base_currency: 'CNY', quote_currency: 'USD', rate: '7.2034' });

    const ch = changeRows().find(c => c.entity_type === 'exchange_rate_override' && c.entity_sync_id === 'rate-1');
    expect(ch).toBeDefined();
    expect(ch!.scope).toBe('user');
    expect(ch!.ledger_id).toBeNull();
    expect(ch!.action).toBe('upsert');
  });

  it('push 同 sync_id 先更新后 delete,投影行最终移除', async () => {
    const t0 = new Date().toISOString();
    const t1 = new Date(Date.now() + 61_000).toISOString();
    const t2 = new Date(Date.now() + 122_000).toISOString();

    await pushRate('rate-2', ratePayload('rate-2', 'CNY', 'USD', '7.0'), t0);
    await pushRate('rate-2', ratePayload('rate-2', 'CNY', 'USD', '7.5'), t1);
    const afterUpdate = rateRows().filter(r => r.sync_id === 'rate-2');
    expect(afterUpdate).toHaveLength(1);
    expect(afterUpdate[0].rate).toBe('7.5');

    await pushRate('rate-2', {}, t2, 'delete');
    expect(rateRows().filter(r => r.sync_id === 'rate-2')).toHaveLength(0);
  });

  it('pull 能带出 exchange_rate_override,ledger_id 为 __user_global__ 且 scope=user', async () => {
    await pushRate('rate-3', ratePayload('rate-3'), new Date().toISOString());

    const r = await env.app.request('/api/v1/sync/pull?since=0', { headers: authHeaders() });
    expect(r.status).toBe(200);
    const body = await r.json() as { changes: Array<{ entity_type: string; entity_sync_id: string; ledger_id: string; scope: string; action: string; payload: any }> };
    const types = body.changes.map(c => c.entity_type);
    expect(types).toContain('exchange_rate_override');
    const hit = body.changes.find(c => c.entity_type === 'exchange_rate_override' && c.entity_sync_id === 'rate-3');
    expect(hit).toBeDefined();
    expect(hit!.ledger_id).toBe('__user_global__');
    expect(hit!.scope).toBe('user');
    expect(hit!.payload.baseCurrency).toBe('CNY');
  });

  it('同币对不同 sync_id:两行并存,server 不按币对去重(对齐上游 test_same_pair_two_sync_ids_coexist)', async () => {
    const t0 = new Date().toISOString();
    const t1 = new Date(Date.now() + 61_000).toISOString();

    await pushRate('rate-A', ratePayload('rate-A', 'CNY', 'USD', '7.1'), t0);
    await pushRate('rate-B', ratePayload('rate-B', 'CNY', 'USD', '7.3'), t1);

    const rows = rateRows().filter(r => r.base_currency === 'CNY' && r.quote_currency === 'USD');
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map(r => r.sync_id))).toEqual(new Set(['rate-A', 'rate-B']));
    const rateA = rows.find(r => r.sync_id === 'rate-A');
    const rateB = rows.find(r => r.sync_id === 'rate-B');
    expect(rateA!.rate).toBe('7.1');
    expect(rateB!.rate).toBe('7.3');
  });

  it('push 币对大写归一(对齐上游 upsert_exchange_rate_override 的 .upper())', async () => {
    await pushRate('rate-5', ratePayload('rate-5', 'usd', 'eur', '0.9'), new Date().toISOString());

    const row = rateRows().find(r => r.sync_id === 'rate-5');
    expect(row).toMatchObject({ base_currency: 'USD', quote_currency: 'EUR', rate: '0.9' });

    const list = await env.app.request('/api/v1/read/exchange-rate-overrides', { headers: authHeaders() });
    const rows = await list.json() as Array<{ base_currency: string; quote_currency: string }>;
    expect(rows.some(x => x.base_currency === 'USD' && x.quote_currency === 'EUR')).toBe(true);
  });
});