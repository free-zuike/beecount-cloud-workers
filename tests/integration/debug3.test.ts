import { describe, it, expect } from 'vitest';
import { createTestEnv, registerTestUser, getAuthToken } from '../helpers/test-env';

describe('SQL Debug', () => {
  it('pull query with JOIN', async () => {
    const env = await createTestEnv();
    await registerTestUser(env.app, 'sql@example.com');
    const token = await getAuthToken(env.app, 'sql@example.com');

    const ledgerRes = await env.app.request('/api/v1/sync/ledgers', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const ledgerBody = await ledgerRes.json() as any;
    const ledgerId = ledgerBody[0].ledger_id;

    // Push a change
    await env.app.request('/api/v1/sync/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'X-Device-ID': 'test-device-001',
      },
      body: JSON.stringify({
        device_id: 'test-device-001',
        changes: [{
          ledger_id: ledgerId,
          entity_type: 'transaction',
          entity_sync_id: crypto.randomUUID(),
          action: 'upsert',
          payload: { tx_type: 'expense', amount: 100, happened_at: '2025-01-15T10:00:00.000Z' },
          updated_at: new Date().toISOString(),
        }],
      }),
    });

    // Direct DB check
    const { getTable } = await import('../helpers/mock-db');
    const changesTable = getTable(env.db as any, 'sync_changes');
    const ledgersTable = getTable(env.db as any, 'ledgers');
    console.log('sync_changes rows:', changesTable.length);
    console.log('ledgers rows:', ledgersTable.length);

    // Pull
    const pullRes = await env.app.request('/api/v1/sync/pull?cursor=0', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const pullBody = await pullRes.json() as any;
    console.log('pull result:', JSON.stringify(pullBody));
  });

  it('categories read query', async () => {
    const env = await createTestEnv();
    await registerTestUser(env.app, 'cat@example.com');
    const token = await getAuthToken(env.app, 'cat@example.com');

    const ledgerRes = await env.app.request('/api/v1/sync/ledgers', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const ledgerBody = await ledgerRes.json() as any;
    const ledgerId = ledgerBody[0].ledger_id;

    // Check projection table
    const { getTable } = await import('../helpers/mock-db');
    const catProj = getTable(env.db as any, 'read_category_projection');
    console.log('category_projection rows:', catProj.length);
    if (catProj.length > 0) {
      console.log('first cat:', JSON.stringify(catProj[0]));
    }

    const readRes = await env.app.request(`/api/v1/read/ledgers/${ledgerId}/categories`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const readBody = await readRes.json() as any;
    console.log('categories result:', JSON.stringify(readBody).substring(0, 200));
  });

  it('account read query', async () => {
    const env = await createTestEnv();
    await registerTestUser(env.app, 'acct@example.com');
    const token = await getAuthToken(env.app, 'acct@example.com');

    const ledgerRes = await env.app.request('/api/v1/sync/ledgers', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const ledgerBody = await ledgerRes.json() as any;
    const ledgerId = ledgerBody[0].ledger_id;

    // Create account via write endpoint
    const createRes = await env.app.request('/api/v1/write/accounts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        name: '测试账户',
        account_type: 'debit',
        initial_balance: 10000,
      }),
    });
    const createBody = await createRes.json() as any;
    console.log('create account result:', JSON.stringify(createBody));

    // Check projection table
    const { getTable } = await import('../helpers/mock-db');
    const acctProj = getTable(env.db as any, 'read_account_projection');
    console.log('account_projection rows:', acctProj.length);
    if (acctProj.length > 0) {
      console.log('first acct:', JSON.stringify(acctProj[0]));
    }

    // Read
    const readRes = await env.app.request(`/api/v1/read/ledgers/${ledgerId}/accounts`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const readBody = await readRes.json() as any;
    console.log('accounts result:', JSON.stringify(readBody).substring(0, 500));
  });
});
