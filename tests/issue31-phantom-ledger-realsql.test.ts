import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { createRealDb, WRITE_PATH_TABLES } from './helpers/realsql-db';
import { isLedgerDeleted, resolveLedger, resolveWriteLedger } from '../src/routes/mcp';
import workspaceRouter from '../src/routes/workspace';
import writeRouter from '../src/routes/write';
import readRouter from '../src/routes/read';

// 移植上游 tests/test_issue31_phantom_ledger.py:
// B1 MCP 解析/默认账本排除软删; B2 web 写软删账本(本地无 tombstone 拒绝 → 差异);
// B3 workspace 跨账本读排除软删(即便 projection 残留); B5 多账本写不瞎猜。
let sqlite: DatabaseSync;
let db: D1Database;
let app: Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>;

const USER = 'user-1';

beforeEach(() => {
  const real = createRealDb();
  sqlite = real.sqlite;
  db = real.db;
  sqlite.exec(WRITE_PATH_TABLES);
  // mcp resolveLedger 按 ledgers.created_at 升序选默认账本
  sqlite.exec('ALTER TABLE ledgers ADD COLUMN created_at TEXT');
  sqlite.prepare("INSERT INTO users (id, email, password_hash) VALUES (?, 'ghost@x.com', 'x')").run(USER);

  app = new Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>();
  app.use('*', async (c, next) => {
    c.set('userId', USER);
    await next();
  });
  app.route('/api/v1/read/workspace', workspaceRouter);
  app.route('/api/v1/read', readRouter);
  app.route('/api/v1/write', writeRouter);
});

afterEach(() => sqlite.close());

function insertLedger(internalId: string, externalId: string, order: number) {
  sqlite.prepare('INSERT INTO ledgers (id, user_id, external_id, name, currency, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(internalId, USER, externalId, externalId, 'CNY', `2026-01-0${order}T00:00:00Z`);
  sqlite.prepare("INSERT INTO ledger_members (ledger_id, user_id, role, joined_at) VALUES (?, ?, 'owner', '2026-01-01T00:00:00Z')")
    .run(internalId, USER);
}

function softDeleteLedger(internalId: string, externalSyncId: string) {
  sqlite.prepare(`INSERT INTO sync_changes (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id, updated_by_device_id, scope)
    VALUES (?, ?, 'ledger_snapshot', ?, 'delete', '{}', '2026-02-01T00:00:00Z', ?, 'pytest', 'user')`)
    .run(USER, internalId, externalSyncId, USER);
}

async function addTx(ledgerExt: string, amount: number) {
  return app.request(`/api/v1/write/ledgers/${ledgerExt}/transactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base_change_id: 0, tx_type: 'expense', amount, happened_at: '2026-05-01T00:00:00Z' }),
  }, { DB: db } as any);
}

describe('幽灵/软删账本(移植上游 test_issue31_phantom_ledger.py)', () => {
  it('B1: MCP 解析与默认账本排除软删账本', async () => {
    insertLedger('first', 'First', 1);
    insertLedger('second', 'Second', 2);
    softDeleteLedger('first', 'First');

    expect(await isLedgerDeleted(db, 'first')).toBe(true);
    expect(await isLedgerDeleted(db, 'second')).toBe(false);

    const active = await resolveLedger(db, USER);
    expect(active?.external_id).toBe('Second');

    expect(await resolveLedger(db, USER, 'First')).toBeNull();
    expect(await resolveLedger(db, USER, 'Second')).not.toBeNull();
  });

  it('B2: web 写软删账本 → 404 且投影不复活(对齐上游)', async () => {
    insertLedger('solo', 'Solo', 1);
    softDeleteLedger('solo', 'Solo');

    const res = await addTx('Solo', 10);
    expect(res.status).toBe(404);

    const rows = sqlite.prepare("SELECT COUNT(*) AS c FROM read_tx_projection WHERE ledger_id = 'solo'").get() as { c: number };
    expect(rows.c).toBe(0);
  });

  it('B2-live: 正常账本写入不受影响', async () => {
    insertLedger('live', 'Live', 1);
    const res = await addTx('Live', 12.5);
    expect(res.status).toBe(200);
  });

  it('B3: workspace 跨账本读排除软删账本(即便投影残留)', async () => {
    insertLedger('alive', 'Alive', 1);
    insertLedger('ghost', 'Ghost', 2);
    expect((await addTx('Alive', 11)).status).toBe(200);
    expect((await addTx('Ghost', 22)).status).toBe(200);
    softDeleteLedger('ghost', 'Ghost'); // 投影行残留,仅 tombstone 标记

    // /read/workspace/transactions 跨账本读 + 软删排除（对齐上游 list_workspace_transactions）
    const res = await app.request('/api/v1/read/workspace/transactions', {}, { DB: db } as any);
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<{ amount: number }>; total: number };
    expect(body.total).toBe(1); // 只计 Alive 的 11,Ghost 的 22 被排除
    expect(body.items[0].amount).toBe(11);
  });

  it('B5: resolveWriteLedger 多账本不瞎猜,返回候选', async () => {
    // 0 账本 → no_ledger
    let r = await resolveWriteLedger(db, USER);
    expect(r.status.status).toBe('no_ledger');

    // 1 个 live 账本 → 自动选它
    insertLedger('only', 'Only', 1);
    r = await resolveWriteLedger(db, USER);
    expect(r.status).toBeNull();
    expect(r.ledger?.external_id).toBe('Only');

    // 2 个 live 账本 + 未指定 → ledger_required + 候选
    insertLedger('second', 'Second', 2);
    r = await resolveWriteLedger(db, USER);
    expect(r.ledger).toBeNull();
    expect(r.status.status).toBe('ledger_required');
    expect(new Set(r.status.candidates.map((c: any) => c.id))).toEqual(new Set(['Only', 'Second']));

    // 显式指定软删账本 → ledger_not_found
    softDeleteLedger('only', 'Only');
    r = await resolveWriteLedger(db, USER, 'Only');
    expect(r.ledger).toBeNull();
    expect(r.status.status).toBe('ledger_not_found');

    // 显式指定 live 账本 → 成功
    r = await resolveWriteLedger(db, USER, 'Second');
    expect(r.status).toBeNull();
    expect(r.ledger?.external_id).toBe('Second');
  });
});