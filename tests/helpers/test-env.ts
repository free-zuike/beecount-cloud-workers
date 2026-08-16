import { createMockDB, resetDB, getTable } from './mock-db';
import { createTestApp } from './test-app';

export const TEST_JWT_SECRET = 'test-secret-key-for-testing';
export const TEST_DEVICE_ID = 'test-device-001';

export async function createTestEnv() {
  const db = createMockDB();
  const app = createTestApp(db, TEST_JWT_SECRET);
  return { db, app, jwtSecret: TEST_JWT_SECRET };
}

export async function registerTestUser(
  app: ReturnType<typeof createTestApp>,
  email: string = 'test@example.com',
  password: string = 'password123',
  deviceId: string = TEST_DEVICE_ID
) {
  return await app.request('/api/v1/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, device_id: deviceId, device_name: 'Test Device', platform: 'test' }),
  });
}

export async function loginTestUser(
  app: ReturnType<typeof createTestApp>,
  email: string = 'test@example.com',
  password: string = 'password123',
  deviceId: string = TEST_DEVICE_ID
) {
  const res = await app.request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, device_id: deviceId, device_name: 'Test Device', platform: 'test' }),
  });
  const body = await res.json() as any;
  return { res, body };
}

export async function getAuthToken(
  app: ReturnType<typeof createTestApp>,
  email: string = 'test@example.com',
  password: string = 'password123'
) {
  await registerTestUser(app, email, password);
  const { body } = await loginTestUser(app, email, password);
  return body.access_token;
}

export async function createTestLedger(
  app: ReturnType<typeof createTestApp>,
  token: string,
  name: string = 'Test Ledger',
  currency: string = 'CNY'
): Promise<string> {
  const res = await app.request('/api/v1/write/ledgers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ ledger_name: name, currency }),
  });
  const body = await res.json() as any;
  const ledgerId = body.ledger_id;
  // push 一条最小 sync_change 使 sync/ledgers 能识别到该账本
  await app.request('/api/v1/sync/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Device-ID': 'test-device-001' },
    body: JSON.stringify({ device_id: 'test-device-001', changes: [{
      ledger_id: ledgerId, entity_type: 'ledger', entity_sync_id: ledgerId,
      action: 'upsert', payload: { name, currency },
      updated_at: new Date().toISOString(),
    }] }),
  });
  return ledgerId;
}

export { createMockDB, resetDB, getTable };
