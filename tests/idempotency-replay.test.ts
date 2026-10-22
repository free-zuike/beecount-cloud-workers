// 移植上游 tests/test_account_hidden_sync.py::test_web_update_account_hidden_idempotent_replay
// + Idempotency-Key 哈希冲突契约(对齐 routers/write/_shared.py _load_idempotent_response):
// - 同 key 同 payload 重发 → replay 第一份响应(不重复推进 change_id,idempotency_replayed=true);
// - 同 key 不同 payload → 409 "Idempotency key reused with different payload"。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { createRealDb, WRITE_PATH_TABLES } from './helpers/realsql-db';
import writeRouter from '../src/routes/write';
import batchWriteRouter from '../src/routes/batch_write';

let sqlite: DatabaseSync;
let db: D1Database;
let app: Hono<{ Bindings: any; Variables: { userId: string } }>;

const USER = 'u1';

beforeEach(() => {
  const real = createRealDb();
  sqlite = real.sqlite;
  db = real.db;
  sqlite.exec(WRITE_PATH_TABLES);
  sqlite.prepare("INSERT INTO users (id, email, password_hash) VALUES (?, 'idem@x.com', 'x')").run(USER);
  sqlite.prepare("INSERT INTO ledgers (id, user_id, external_id, name, currency) VALUES ('lg1', ?, 'L1', 'L1', 'CNY')").run(USER);
  sqlite.prepare("INSERT INTO ledger_members (ledger_id, user_id, role, joined_at) VALUES ('lg1', ?, 'owner', '2026-01-01T00:00:00Z')").run(USER);
  sqlite.prepare(
    `INSERT INTO user_account_projection (sync_id, user_id, name, account_type, currency, initial_balance, hidden)
     VALUES ('acc-w4', ?, '旧卡', 'cash', 'CNY', 0, 0)`
  ).run(USER);

  app = new Hono<{ Bindings: any; Variables: { userId: string } }>();
  app.use('*', async (c, next) => {
    c.set('userId', USER);
    await next();
  });
  app.route('/api/v1/write', writeRouter);
  app.route('/api/v1/write', batchWriteRouter);
});

afterEach(() => sqlite.close());

function patchAccount(body: unknown, idemKey?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Device-ID': 'd-web' };
  if (idemKey) headers['Idempotency-Key'] = idemKey;
  return app.request('/api/v1/write/ledgers/L1/accounts/acc-w4', {
    method: 'PATCH',
    headers,
    body: JSON.stringify(body),
  }, { DB: db } as any);
}

describe('web 写 Idempotency-Key 幂等(对齐上游 test_web_update_account_hidden_idempotent_replay)', () => {
  it('同 key 重放 PATCH → 不重复推进 change_id,replay 原响应', async () => {
    const body = { base_change_id: 0, hidden: true };
    const r1 = await patchAccount(body, 'idem-hidden-1');
    expect(r1.status).toBe(200);
    const b1 = await r1.json() as any;
    expect(b1.idempotency_replayed).toBe(false);
    const firstChangeId = b1.new_change_id as number;
    expect(firstChangeId).toBeGreaterThan(0);

    const r2 = await patchAccount(body, 'idem-hidden-1');
    expect(r2.status).toBe(200);
    const b2 = await r2.json() as any;
    expect(b2.idempotency_replayed).toBe(true);
    expect(b2.new_change_id).toBe(firstChangeId);

    const row = sqlite.prepare('SELECT hidden FROM user_account_projection WHERE sync_id = ?').get('acc-w4') as { hidden: number };
    expect(row.hidden).toBe(1);
    // 只写了一次 account upsert 变更
    const changes = sqlite.prepare(`SELECT COUNT(*) AS c FROM sync_changes WHERE entity_type = 'account' AND entity_sync_id = 'acc-w4' AND action != 'delete'`).get() as { c: number };
    expect(changes.c).toBe(1);
  });

  it('同 key 不同 payload → 409(对齐上游 IDEMPOTENCY_KEY_REUSED)', async () => {
    const r1 = await patchAccount({ base_change_id: 0, hidden: true }, 'idem-conflict-1');
    expect(r1.status).toBe(200);

    const r2 = await patchAccount({ base_change_id: 0, hidden: false }, 'idem-conflict-1');
    expect(r2.status).toBe(409);
    const body = await r2.json() as any;
    expect(JSON.stringify(body)).toContain('reused with different payload');
  });

  it('不同 key 各自独立,均正常执行', async () => {
    const r1 = await patchAccount({ base_change_id: 0, hidden: true }, 'idem-key-a');
    const r2 = await patchAccount({ base_change_id: 0, hidden: true }, 'idem-key-b');
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const b1 = await r1.json() as any;
    const b2 = await r2.json() as any;
    expect(b1.idempotency_replayed).toBe(false);
    expect(b2.idempotency_replayed).toBe(false);
  });
});

describe('batch create Idempotency-Key 幂等', () => {
  it('同 key 重发 batch create → new_change_id 相同,created_sync_ids 相同', async () => {
    const body = {
      ledger_id: 'L1',
      base_change_id: 0,
      transactions: [{ tx_type: 'expense', amount: 10, happened_at: '2026-05-01T00:00:00Z', note: 'x' }],
    };
    const call = (idemKey: string) => app.request('/api/v1/write/ledgers/L1/transactions/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-ID': 'd-web', 'Idempotency-Key': idemKey },
      body: JSON.stringify(body),
    }, { DB: db } as any);

    const r1 = await call('batch-idem-1');
    expect(r1.status).toBe(200);
    const b1 = await r1.json() as any;
    expect(b1.created_sync_ids).toHaveLength(1);

    const r2 = await call('batch-idem-1');
    expect(r2.status).toBe(200);
    const b2 = await r2.json() as any;
    expect(b2.new_change_id).toBe(b1.new_change_id);
    expect(b2.created_sync_ids).toEqual(b1.created_sync_ids);
    // 投影只有 1 行交易
    const cnt = sqlite.prepare('SELECT COUNT(*) AS c FROM read_tx_projection WHERE ledger_id = ?').get('lg1') as { c: number };
    expect(cnt.c).toBe(1);
  });
});