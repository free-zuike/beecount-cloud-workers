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

export { createMockDB, resetDB, getTable };
