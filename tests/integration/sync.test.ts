import { describe, it, expect, beforeEach } from 'vitest';
import { createTestEnv, registerTestUser, getAuthToken, createTestLedger, TEST_JWT_SECRET, TEST_DEVICE_ID } from '../helpers/test-env';

let env: Awaited<ReturnType<typeof createTestEnv>>;
let token: string;
let ledgerId: string;

beforeEach(async () => {
  env = await createTestEnv();
  await registerTestUser(env.app, 'sync@example.com');
  token = await getAuthToken(env.app, 'sync@example.com');
  ledgerId = await createTestLedger(env.app, token, 'Sync Test Ledger');
});

function pushHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    'X-Device-ID': TEST_DEVICE_ID,
  };
}

describe('Sync - Ledgers', () => {
  it('should list user ledgers', async () => {
    const res = await env.app.request('/api/v1/sync/ledgers', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json() as any;
    expect(res.status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(1);
    expect(body[0].ledger_id).toBe(ledgerId);
    expect(body[0].role).toBe('owner');
  });
});

describe('Sync - Push', () => {
  it('should push a new transaction', async () => {
    const txSyncId = crypto.randomUUID();
    const res = await env.app.request('/api/v1/sync/push', {
      method: 'POST',
      headers: pushHeaders(),
      body: JSON.stringify({
        device_id: TEST_DEVICE_ID,
        changes: [
          {
            ledger_id: ledgerId,
            entity_type: 'transaction',
            entity_sync_id: txSyncId,
            action: 'upsert',
            payload: {
              tx_type: 'expense',
              amount: 25.50,
              happened_at: '2025-01-15T10:30:00.000Z',
              note: '午餐',
              category_name: '餐饮',
            },
            updated_at: new Date().toISOString(),
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.accepted).toBe(1);
    expect(body.rejected).toBe(0);
    expect(body.server_cursor).toBeGreaterThan(0);
  });

  it('should push multiple changes', async () => {
    const changes = [];
    for (let i = 0; i < 5; i++) {
      changes.push({
        ledger_id: ledgerId,
        entity_type: 'transaction',
        entity_sync_id: crypto.randomUUID(),
        action: 'upsert' as const,
        payload: {
          tx_type: 'expense',
          amount: 10 * (i + 1),
          happened_at: `2025-01-${15 + i}T10:00:00.000Z`,
          note: `交易${i + 1}`,
        },
        updated_at: new Date().toISOString(),
      });
    }

    const res = await env.app.request('/api/v1/sync/push', {
      method: 'POST',
      headers: pushHeaders(),
      body: JSON.stringify({ device_id: TEST_DEVICE_ID, changes }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.accepted).toBe(5);
    expect(body.rejected).toBe(0);
  });

  it('should push a category', async () => {
    const catSyncId = crypto.randomUUID();
    const res = await env.app.request('/api/v1/sync/push', {
      method: 'POST',
      headers: pushHeaders(),
      body: JSON.stringify({
        device_id: TEST_DEVICE_ID,
        changes: [
          {
            ledger_id: ledgerId,
            entity_type: 'category',
            entity_sync_id: catSyncId,
            action: 'upsert',
            payload: {
              name: '同步测试分类',
              kind: 'expense',
              level: 1,
              sort_order: 99,
              icon: '🎯',
            },
            updated_at: new Date().toISOString(),
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.accepted).toBe(1);
  });

  it('should push an account', async () => {
    const acctSyncId = crypto.randomUUID();
    const res = await env.app.request('/api/v1/sync/push', {
      method: 'POST',
      headers: pushHeaders(),
      body: JSON.stringify({
        device_id: TEST_DEVICE_ID,
        changes: [
          {
            ledger_id: ledgerId,
            entity_type: 'account',
            entity_sync_id: acctSyncId,
            action: 'upsert',
            payload: {
              name: '同步测试账户',
              account_type: 'debit',
              currency: 'CNY',
              initial_balance: 1000,
            },
            updated_at: new Date().toISOString(),
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.accepted).toBe(1);
  });
});

describe('Sync - Pull', () => {
  it('should pull changes after push', async () => {
    const txSyncId = crypto.randomUUID();
    await env.app.request('/api/v1/sync/push', {
      method: 'POST',
      headers: pushHeaders(),
      body: JSON.stringify({
        device_id: TEST_DEVICE_ID,
        changes: [{
          ledger_id: ledgerId,
          entity_type: 'transaction',
          entity_sync_id: txSyncId,
          action: 'upsert',
          payload: { tx_type: 'expense', amount: 25.5, happened_at: '2025-01-15T10:30:00.000Z', note: '午餐' },
          updated_at: new Date().toISOString(),
        }],
      }),
    });

    // 不传 device_id（跳过设备校验；无 device 过滤时能拉到所有变更）
    const res = await env.app.request(`/api/v1/sync/pull`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(Array.isArray(body.changes)).toBe(true);
    expect(body.changes.length).toBeGreaterThanOrEqual(1);
    const pushed = body.changes.find((c: any) => c.entity_sync_id === txSyncId);
    expect(pushed).toBeDefined();
    expect(pushed.entity_type).toBe('transaction');
    expect(pushed.action).toBe('upsert');
    expect(body.server_cursor).toBeDefined();
    expect(typeof body.has_more).toBe('boolean');
  });

  it('should return empty when no new changes', async () => {
    const res = await env.app.request(`/api/v1/sync/pull?device_id=${TEST_DEVICE_ID}&since=999999999`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.changes).toEqual([]);
  });

  it('should filter by ledger_id', async () => {
    const txSyncId = crypto.randomUUID();
    await env.app.request('/api/v1/sync/push', {
      method: 'POST',
      headers: pushHeaders(),
      body: JSON.stringify({
        device_id: TEST_DEVICE_ID,
        changes: [{
          ledger_id: ledgerId,
          entity_type: 'transaction',
          entity_sync_id: txSyncId,
          action: 'upsert',
          payload: { tx_type: 'expense', amount: 10, happened_at: '2025-01-15T10:00:00.000Z' },
          updated_at: new Date().toISOString(),
        }],
      }),
    });

    // 不传 device_id，拉取指定账本的变化
    const res = await env.app.request(`/api/v1/sync/pull?ledger_id=${ledgerId}&since=0`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(Array.isArray(body.changes)).toBe(true);
    const pushed = body.changes.find((c: any) => c.entity_sync_id === txSyncId);
    expect(pushed).toBeDefined();
    expect(pushed.ledger_id).toBe(ledgerId);
  });
});

describe('Sync - Full sync', () => {
  it('should return full sync snapshot', async () => {
    const txSyncId = crypto.randomUUID();
    await env.app.request('/api/v1/sync/push', {
      method: 'POST',
      headers: pushHeaders(),
      body: JSON.stringify({
        device_id: TEST_DEVICE_ID,
        changes: [
          {
            ledger_id: ledgerId,
            entity_type: 'transaction',
            entity_sync_id: txSyncId,
            action: 'upsert',
            payload: {
              tx_type: 'income',
              amount: 5000,
              happened_at: '2025-01-15T10:00:00.000Z',
              note: '工资',
            },
            updated_at: new Date().toISOString(),
          },
        ],
      }),
    });

    const res = await env.app.request(`/api/v1/sync/full?ledger_id=${ledgerId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ledger_id).toBe(ledgerId);
    expect(body.latest_cursor).toBeDefined();
    expect(body.snapshot).toBeDefined();
    expect(body.snapshot.entity_sync_id).toBe(ledgerId);
    // ledgerSyncId 在 payload.content（JSON 字符串）内
    const content = JSON.parse(body.snapshot.payload.content);
    expect(content.ledgerSyncId).toBe(ledgerId);
  });
});
