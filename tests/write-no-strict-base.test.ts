import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { createTestEnv, registerTestUser, getAuthToken, TEST_DEVICE_ID } from './helpers/test-env';
import { createRealDb, WRITE_PATH_TABLES } from './helpers/realsql-db';
import writeRouter from '../src/routes/write';

// 移植上游 tests/test_write_no_strict_base.py:
// 默认(STRICT_BASE_CHANGE_ID 关)base_change_id 过期不 409;
// 开启后 stale base_change_id → 409,且 base=最新不误伤。
let env: Awaited<ReturnType<typeof createTestEnv>>;
let token: string;

beforeEach(async () => {
  env = await createTestEnv();
  await registerTestUser(env.app, 'nobase@example.com');
  token = await getAuthToken(env.app, 'nobase@example.com');
});

const authHeaders = () => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${token}`,
  'X-Device-ID': TEST_DEVICE_ID,
});

describe('base_change_id 语义(移植上游 test_write_no_strict_base.py)', () => {
  it('web 带过期 base_change_id 写账户默认仍成功,不触发 409', async () => {
    const now = new Date().toISOString();
    for (let i = 0; i < 3; i++) {
      const r = await env.app.request('/api/v1/sync/push', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          device_id: TEST_DEVICE_ID,
          changes: [{
            ledger_id: 'L1',
            entity_type: 'transaction',
            entity_sync_id: `mtx${i}`,
            action: 'upsert',
            payload: { syncId: `mtx${i}`, type: 'expense', amount: 5.0 + i, happenedAt: now, categoryName: 'Food', categoryKind: 'expense', accountName: 'Cash' },
            updated_at: new Date(Date.now() + i * 1000).toISOString(),
          }],
        }),
      });
      expect(r.status).toBe(200);
    }

    const accRes = await env.app.request('/api/v1/write/ledgers/L1/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        base_change_id: 1,
        name: 'WebAcct',
        account_type: 'cash',
        currency: 'CNY',
        initial_balance: 100,
      }),
    });
    expect(accRes.status).toBe(200);
    const meta = await accRes.json() as any;
    expect(meta.ledger_id).toBe('L1');
    expect(meta.new_change_id).toBeGreaterThan(0);
    expect(meta.entity_id).toBeTruthy();
  });

  it('STRICT_BASE_CHANGE_ID 开启:stale base_change_id → 409;base=最新正常写入', async () => {
    const real = createRealDb();
    const sqlite = real.sqlite;
    const db = real.db;
    sqlite.exec(WRITE_PATH_TABLES);
    sqlite.prepare("INSERT INTO users (id, email, password_hash) VALUES ('u1', 'strict@x.com', 'x')").run();
    sqlite.prepare("INSERT INTO ledgers (id, user_id, external_id, name, currency) VALUES ('lg1', 'u1', 'L1', 'L1', 'CNY')").run();
    sqlite.prepare("INSERT INTO ledger_members (ledger_id, user_id, role, joined_at) VALUES ('lg1', 'u1', 'owner', '2026-01-01T00:00:00Z')").run();
    // 造 5 条 sync_changes,使最新 change_id = 5
    for (let i = 1; i <= 5; i++) {
      sqlite.prepare(`INSERT INTO sync_changes (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, scope)
        VALUES ('u1', 'lg1', 'transaction', 't${i}', 'upsert', '{}', '2026-05-01T00:00:00Z', 'ledger')`).run();
    }

    const app = new Hono<{ Bindings: any; Variables: { userId: string } }>();
    app.use('*', async (c, next) => {
      c.set('userId', 'u1');
      await next();
    });
    app.route('/api/v1/write', writeRouter);
    const strictEnv = { DB: db, STRICT_BASE_CHANGE_ID: 'true' } as any;

    const stale = await app.request('/api/v1/write/ledgers/L1/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        base_change_id: 1,
        name: 'WebAcct',
        account_type: 'cash',
        currency: 'CNY',
        initial_balance: 0,
      }),
    }, strictEnv);
    expect(stale.status).toBe(409);

    const current = await app.request('/api/v1/write/ledgers/L1/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        base_change_id: 5,
        name: 'WebAcct2',
        account_type: 'cash',
        currency: 'CNY',
        initial_balance: 0,
      }),
    }, strictEnv);
    expect(current.status).toBe(200);

    sqlite.close();
  });
});