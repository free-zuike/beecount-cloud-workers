import { describe, it, expect, beforeEach } from 'vitest';
import { createTestEnv, registerTestUser, getAuthToken, createTestLedger, TEST_DEVICE_ID } from '../helpers/test-env';

// 镜像原版 tests/test_balance_adjustment.py：账户平账使用普通收支交易和固定「平账」分类，
// 且不设置不计入收支/不计入预算标记。
let env: Awaited<ReturnType<typeof createTestEnv>>;
let token: string;
let ledgerId: string;

beforeEach(async () => {
  env = await createTestEnv();
  await registerTestUser(env.app, 'balance@example.com');
  token = await getAuthToken(env.app, 'balance@example.com');
  ledgerId = await createTestLedger(env.app, token, 'Balance Test Ledger');
});

function pushHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    'X-Device-ID': TEST_DEVICE_ID,
  };
}

async function pushSettlementCategory(catSyncId: string, kind: 'income' | 'expense') {
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
          payload: { name: '平账', kind, level: 1, sort_order: 99 },
          updated_at: new Date().toISOString(),
        },
      ],
    }),
  });
  expect(res.status).toBe(200);
}

async function pushSettlementTx(
  txSyncId: string,
  catSyncId: string,
  payload: { tx_type: 'income' | 'expense'; amount: number },
) {
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
            ...payload,
            accountId: 'acc-1',
            accountName: 'Cash',
            categoryId: catSyncId,
            categoryName: '平账',
            categoryKind: payload.tx_type,
          },
          updated_at: new Date().toISOString(),
        },
      ],
    }),
  });
  expect(res.status).toBe(200);
}

async function getSnapshotTx(txSyncId: string) {
  const res = await env.app.request(`/api/v1/sync/full?ledger_id=${ledgerId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  const content = JSON.parse(body.snapshot.payload.content);
  return content.items.find((item: any) => item.syncId === txSyncId);
}

describe('Balance settlement', () => {
  it('uses a regular income transaction and the 平账 category', async () => {
    const catSyncId = crypto.randomUUID();
    const txSyncId = crypto.randomUUID();
    await pushSettlementCategory(catSyncId, 'income');
    await pushSettlementTx(txSyncId, catSyncId, { tx_type: 'income', amount: 12.5 });

    const item = await getSnapshotTx(txSyncId);
    expect(item).toBeDefined();
    expect(item.type).toBe('income');
    expect(item.amount).toBe(12.5);
    expect(item.categoryId).toBe(catSyncId);
    expect(item.categoryName).toBe('平账');
    expect(item.categoryKind).toBe('income');
    expect(item.excludeFromStats).toBe(false);
    expect(item.excludeFromBudget).toBe(false);
  });

  it('uses a regular expense transaction and the 平账 category for negative differences', async () => {
    const catSyncId = crypto.randomUUID();
    const txSyncId = crypto.randomUUID();
    await pushSettlementCategory(catSyncId, 'expense');
    await pushSettlementTx(txSyncId, catSyncId, { tx_type: 'expense', amount: 7.5 });

    const item = await getSnapshotTx(txSyncId);
    expect(item).toBeDefined();
    expect(item.type).toBe('expense');
    expect(item.amount).toBe(7.5);
    expect(item.categoryId).toBe(catSyncId);
    expect(item.categoryName).toBe('平账');
    expect(item.categoryKind).toBe('expense');
    expect(item.excludeFromStats).toBe(false);
    expect(item.excludeFromBudget).toBe(false);
  });
});
