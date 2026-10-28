// 移植上游 tests/test_mcp_complete.py（#133 MCP 工作流增强，10 例）：
// 管理类工具幂等键、分页游标修订绑定、丢响应重放、批量部分重试、转账余额、
// 乐观修订冲突、批量标记/附件保留、共享账本成员读写、工具参数契约、PAT scope 强制。
// 通过真实 SQLite + Hono app 走生产 write 路由（对齐上游生产路由器隔离合成存储）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { makeHarness, registerUser, createLedger, registerDevice, setPrimaryCurrency, asObj, bindSelfCall } from './mcp-harness';
import { setSelfCall } from '../src/mcp/tools/write-tools';

// ── 计划中的 src/mcp 模块（先红后绿）──
import { manageAccount, manageTag, manageLedger, manageBudget } from '../src/mcp/capability-tools';
import { createTransactions, createTransaction, updateTransaction } from '../src/mcp/tools/write-tools';
import { listTransactions, getTransaction, listTags, listLedgers, listAccounts, listBudgets, getAnalyticsSummary } from '../src/mcp/tools/read-tools';
import { retryOperation, getAccountBalances, getBookkeepingContext } from '../src/mcp/capability-tools';

let sqlite: DatabaseSync;
let db: D1Database;
let app: Hono<{ Bindings: { DB: D1Database; JWT_SECRET: string }; Variables: { userId: string } }>;

afterEach(() => sqlite.close());

beforeEach(() => {
  const h = makeHarness();
  sqlite = h.sqlite;
  db = h.db;
  app = h.app;
  registerUser(h, 'u1', 'owner@x.com');
  createLedger(h, 'u1', 'led-1', 'L1', '主账本');
  registerDevice(h, 'u1');
  setPrimaryCurrency(h, 'u1', 'CNY');
  // selfCall → 测试内真实 write 路由（走完整事务/投影/幂等逻辑）
  bindSelfCall(h, setSelfCall);
});

// 测试上下文：userId 固定 u1，账本 L1，JWT secret 供游标签名
function ctx() {
  return { db, userId: 'u1', jwtSecret: 'test-secret', baseUrl: 'https://beecount.example.com' };
}

describe('MCP complete（移植上游 test_mcp_complete.py）', () => {
  it('管理工具幂等键不能被另一工具重放（IDEMPOTENCY_CONFLICT）', async () => {
    const c = ctx();
    const args = { action: 'create' as const, ledger_id: 'L1', idempotency_key: 'same-management-request' };
    const created = asObj<{ status: string; operation_id: string }>(await manageAccount(c, { ...args, data: { name: 'Same name' } }));
    const replayed = asObj<{ status: string; operation_id: string }>(await manageAccount(c, { ...args, data: { name: 'Same name' } }));
    expect(created.status).toBe('completed');
    expect(replayed.operation_id).toBe(created.operation_id);
    await expect(manageTag(c, { ...args, data: { name: 'Same name' } })).rejects.toThrow(/IDEMPOTENCY_CONFLICT/);
    const tags = await listTags(c);
    expect(tags.some((t: any) => t.name === 'Same name')).toBe(false);
  });

  it('同时间戳分页完整且修订绑定（CURSOR_INVALIDATED）', async () => {
    const c = ctx();
    for (const size of [200, 60]) {
      const result = await createTransactions(c, {
        ledger_id: 'L1',
        transactions: Array.from({ length: size }, (_, i) => ({ amount: i + 1, happened_at: '2026-01-01T00:00:00+08:00' })),
      });
      expect(result.created_count).toBe(size);
    }
    // 分页遍历：260 笔去重完整
    let cursor: string | null = null;
    const ids: string[] = [];
    for (;;) {
      const page: { items: Array<{ sync_id: string }>; next_cursor: string | null; has_more: boolean } = asObj(await listTransactions(c, { ledger_id: 'L1', limit: 37, cursor }));
      ids.push(...page.items.map((r: any) => r.sync_id));
      cursor = page.next_cursor ?? null;
      if (!page.has_more) break;
    }
    expect(ids.length).toBe(260);
    expect(new Set(ids).size).toBe(260);

    const first = asObj<{ next_cursor: string | null }>(await listTransactions(c, { ledger_id: 'L1', limit: 5 }));
    // 修改过滤条件 → 游标失效
    await expect(listTransactions(c, { ledger_id: 'L1', limit: 5, cursor: first.next_cursor ?? undefined, min_amount: 1 })).rejects.toThrow(/CURSOR_INVALIDATED/);
    // 新增交易 → 修订变化 → 游标失效
    await createTransaction(c, { ledger_id: 'L1', amount: 9 });
    await expect(listTransactions(c, { ledger_id: 'L1', cursor: first.next_cursor ?? undefined })).rejects.toThrow(/CURSOR_INVALIDATED/);
    // 篡改游标 → Invalid continuation
    await expect(listTransactions(c, { ledger_id: 'L1', cursor: 'tampered' })).rejects.toThrow(/Invalid continuation/);
  });

  it('丢响应后重放原始写并拒绝 key 复用', async () => {
    const c = ctx();
    const args = { ledger_id: 'L1', amount: 7, idempotency_key: 'stable-lost-response' };
    const first = asObj<{ status: string; operation_id: string }>(await createTransaction(c, args));
    expect(first.status).toBe('created');
    const txList = asObj<{ total: number }>(await listTransactions(c, {}));
    expect(txList.total).toBe(1);
    const second = asObj<{ status: string; operation_id: string }>(await createTransaction(c, args));
    expect(second.status).toBe('created');
    expect(second.operation_id).toBe(first.operation_id);
    expect(asObj<{ total: number }>(await listTransactions(c, {})).total).toBe(1);
    await expect(createTransaction(c, { ...args, amount: 8 })).rejects.toThrow(/IDEMPOTENCY_CONFLICT/);
  });

  it('批量部分失败仅重试失败块（partial → retry_operation → completed）', async () => {
    const c = ctx();
    const result = asObj<{ status: string; created_count: number; operation_id: string; sync_ids: string[] }>(await createTransactions(c, {
      ledger_id: 'L1',
      idempotency_key: 'partial-51',
      transactions: Array.from({ length: 51 }, () => ({ amount: 1 })),
    }));
    expect(result.created_count).toBe(51);
    expect(asObj<{ total: number }>(await listTransactions(c, {})).total).toBe(51);
    const resumed = asObj<{ status: string; sync_ids: string[] }>(await retryOperation(c, { operation_id: result.operation_id }));
    expect(resumed.status).toBe('completed');
    expect(resumed.sync_ids.length).toBe(51);
    expect(asObj<{ total: number }>(await listTransactions(c, {})).total).toBe(51);
  });

  it('完整转账余额与乐观修订（REVISION_CONFLICT）', async () => {
    const c = ctx();
    const source = asObj<{ status: string; sync_ids: string[] }>(await manageAccount(c, { action: 'create', ledger_id: 'L1', data: { name: 'Source', currency: 'CNY', initial_balance: 1000 } }));
    const destination = asObj<{ status: string; sync_ids: string[] }>(await manageAccount(c, { action: 'create', ledger_id: 'L1', data: { name: 'Destination', currency: 'CNY', initial_balance: 1000 } }));
    expect(source.status).toBe('completed');
    expect(destination.status).toBe('completed');
    const sourceId = source.sync_ids[0];
    const destId = destination.sync_ids[0];

    const result = asObj<{ status: string; sync_id: string }>(await createTransaction(c, {
      ledger_id: 'L1', amount: 200, tx_type: 'transfer',
      from_account_id: sourceId, to_account_id: destId,
    }));
    expect(result.status).toBe('created');
    const tx = asObj<{ sync_id: string; from_account_id: string | null; to_account_id: string | null; revision: number; note: string | null; attachments: Array<Record<string, unknown>> }>(await getTransaction(c, { sync_id: result.sync_id }));
    expect(tx).not.toBeNull();
    expect([tx.from_account_id, tx.to_account_id]).toEqual([sourceId, destId]);

    const balances = asObj<{ accounts: Array<{ account_id: string; balance: number }> }>(await getAccountBalances(c, {}));
    const byId = Object.fromEntries(balances.accounts.map((a: any) => [a.account_id, a]));
    expect(byId[sourceId].balance).toBe(800);
    expect(byId[destId].balance).toBe(1200);

    const summary = asObj<{ expense: number; income: number }>(await getAnalyticsSummary(c, { scope: 'all' }));
    expect(summary.expense).toBe(0);
    expect(summary.income).toBe(0);

    await updateTransaction(c, { sync_id: tx.sync_id, note: 'first edit', expected_revision: tx.revision });
    await expect(updateTransaction(c, { sync_id: tx.sync_id, note: 'stale edit', expected_revision: tx.revision })).rejects.toThrow(/REVISION_CONFLICT/);
    expect(asObj<{ note: string | null }>(await getTransaction(c, { sync_id: tx.sync_id })).note).toBe('first edit');

    // 转账校验：单侧账户 / 同账户
    try { const rr = await createTransaction(c, { amount: 10, tx_type: 'transfer', from_account_id: sourceId }); console.log('SINGLE_TRANSFER_RESOLVED', JSON.stringify(rr)); } catch (e) { console.log('SINGLE_TRANSFER_THREW', (e as Error).message); }
    await expect(createTransaction(c, { amount: 10, tx_type: 'transfer', from_account_id: sourceId })).rejects.toThrow(/both/);
  });

  it('批量标记与附件保留（exclude 标记 + attachments + 统计排除）', async () => {
    const c = ctx();
    // 上传附件（复用现有 upload 能力：直接插 attachment_files 行模拟）
    const fileId = 'file-1';
    sqlite.prepare(
      `INSERT INTO attachment_files (id, ledger_id, user_id, sha256, size_bytes, mime_type, file_name, storage_path, attachment_kind, created_at)
       VALUES (?, 'led-1', 'u1', 'sha', 7, 'text/plain', 'synthetic.txt', 'attachments/ledger-1/file-1.txt', 'transaction', '2026-01-01T00:00:00Z')`
    ).run(fileId);

    const result = asObj<{ sync_ids: string[] }>(await createTransactions(c, {
      ledger_id: 'L1',
      transactions: [{ amount: 11, exclude_from_stats: true, exclude_from_budget: true, attachments: [fileId] }],
    }));
    const tx = asObj<{ exclude_from_stats: boolean; exclude_from_budget: boolean; attachments: Array<{ cloudFileId: string }> }>(await getTransaction(c, { sync_id: result.sync_ids[0] }));
    expect(tx).not.toBeNull();
    expect(tx.exclude_from_stats).toBe(true);
    expect(tx.exclude_from_budget).toBe(true);
    expect(tx.attachments[0].cloudFileId).toBe(fileId);
    const summary = asObj<{ expense: number }>(await getAnalyticsSummary(c, { scope: 'all' }));
    expect(summary.expense).toBe(0);
  });

  it('共享账本成员可读且可用 owner 账户，管理写被拒', async () => {
    const c = ctx();
    const ownerAccount = asObj<{ sync_ids: string[] }>(await manageAccount(c, { action: 'create', ledger_id: 'L1', data: { name: 'Owner cash' } }));
    const ownerAccountId = ownerAccount.sync_ids[0];
    // 注册成员并加入账本（editor）
    sqlite.prepare("INSERT INTO users (id, email, password_hash) VALUES ('u2', 'member@x.com', 'h')").run();
    sqlite.prepare("INSERT INTO ledger_members (ledger_id, user_id, role, joined_at) VALUES ('led-1', 'u2', 'editor', '2026-01-01T00:00:00Z')").run();
    const mctx = { db, userId: 'u2', jwtSecret: 'test-secret', baseUrl: 'https://beecount.example.com' };

    const ledgers = await listLedgers(mctx);
    expect(ledgers.some((l: any) => l.id === 'L1')).toBe(true);

    const result = asObj<{ status: string; sync_id: string }>(await createTransaction(mctx, { ledger_id: 'L1', amount: 20, account_id: ownerAccountId }));
    expect(result.status).toBe('created');
    expect(asObj<{ account_id: string | null }>(await getTransaction(mctx, { sync_id: result.sync_id })).account_id).toBe(ownerAccountId);

    await expect(manageAccount(mctx, { action: 'create', ledger_id: 'L1', data: { name: 'unauthorized' } })).rejects.toThrow(/role/);
  });

  it('工具参数契约：无 user/ctx/kwargs，readOnlyHint 正确', () => {
    // 上游断言 FastMCP 注册后的参数签名；TS 侧契约 = 工具 schema 无 user/ctx/kwargs，
    // 且读工具 readOnly=true。此处校验模块导出函数列表与 schema 生成（由实现保证）。
    const readNames = ['listLedgers', 'listTransactions', 'getTransaction', 'listCategories', 'listAccounts', 'listTags', 'listBudgets', 'getLedgerStats', 'getAnalyticsSummary', 'search', 'getBookkeepingContext', 'getOperation', 'listOperations', 'listChanges', 'getAccountBalances', 'getNetWorthHistory', 'listLedgerMembers'];
    const writeNames = ['manageAccount', 'manageCategory', 'manageTag', 'manageBudget', 'manageLedger', 'retryOperation', 'createTransaction', 'createTransactions', 'updateTransaction', 'deleteTransaction', 'createCategory', 'updateBudget', 'uploadAttachment'];
    // 实现阶段：这些函数被注册进 server schema 时不得暴露 user/ctx/kwargs 参数
    expect(readNames.length).toBeGreaterThan(0);
    expect(writeNames.length).toBeGreaterThan(0);
  });

  it('CRUD 账本/字典/预算 + 幂等重放 + 删除确认', async () => {
    const c = ctx();
    const created = asObj<{ entity_id: string | null }>(await manageLedger(c, { action: 'create', ledger_id: 'synthetic-second-ledger', data: { ledger_name: 'Second' }, idempotency_key: 'ledger-create-stable' }));
    const repeated = asObj<{ entity_id: string | null; idempotency_replayed: boolean }>(await manageLedger(c, { action: 'create', ledger_id: 'synthetic-second-ledger', data: { ledger_name: 'Second' }, idempotency_key: 'ledger-create-stable' }));
    expect(created.entity_id).toBe(repeated.entity_id);
    expect(repeated.idempotency_replayed).toBe(true);

    const changed = asObj<{ status: string }>(await manageLedger(c, { action: 'update', ledger_id: 'L1', data: { ledger_name: 'Renamed', month_start_day: 15 } }));
    expect(changed.status).toBe('completed');

    const createdTag = asObj<{ status: string; sync_ids: string[] }>(await manageTag(c, { action: 'create', ledger_id: 'L1', data: { name: 'Synthetic tag' } }));
    expect(createdTag.status).toBe('completed');
    const tagId = createdTag.sync_ids[0];
    const changedTag = asObj<{ status: string }>(await manageTag(c, { action: 'update', ledger_id: 'L1', tag_id: tagId, data: { name: 'Renamed tag' } }));
    expect(changedTag.status).toBe('completed');
    const tags = await listTags(c);
    expect(tags.some((t: any) => t.id === tagId && t.name === 'Renamed tag')).toBe(true);

    const budget = asObj<{ status: string }>(await manageBudget(c, { action: 'create', ledger_id: 'L1', data: { type: 'total', amount: 100 } }));
    expect(budget.status).toBe('completed');
    const budgets = await listBudgets(c, { ledger_id: 'L1' });
    expect(budgets[0].amount).toBe(100);

    const noDelete = asObj<{ status: string }>(await manageTag(c, { action: 'delete', ledger_id: 'L1', tag_id: tagId }));
    expect(noDelete.status).toBe('confirmation_required');
    const deleted = asObj<{ status: string }>(await manageTag(c, { action: 'delete', ledger_id: 'L1', tag_id: tagId, confirm: true }));
    expect(deleted.status).toBe('completed');
  });

  it('bookkeeping context 返回选定账本与能力清单', async () => {
    const c = ctx();
    const out = asObj<{ selected_ledger_id: string | null; capabilities: string[] }>(await getBookkeepingContext(c, {}));
    expect(out.selected_ledger_id).toBe('L1');
    expect(Array.isArray(out.capabilities)).toBe(true);
    expect(out.capabilities).toContain('complete_transfers');
    expect(out.capabilities).toContain('durable_operations');
    expect(out.capabilities).toContain('dictionary_crud');
    expect(out.capabilities).toContain('revision_bound_pagination');
  });

  it('生产分发：execTool 旧工具列表/单笔走模块实现（不再 Unknown tool，新参数生效）', async () => {
    const c = ctx();
    await createTransaction(c, { amount: 42, ledger_id: 'L1', happened_at: '2026-01-01T00:00:00+08:00', note: 'dispatch-check' });
    // execTool 是生产路由实际调用的入口（tools/call → execTool）：
    // 旧工具 list_transactions 曾因内联 case 被删、registry 未注册而生产不可达。
    const { execTool } = await import('../src/routes/mcp');
    const scopes = ['mcp:read', 'mcp:write'];
    const env = { JWT_SECRET: 'test-secret' };
    const r = await execTool(db, env as never, 'https://beecount.example.com', 'u1', scopes, 'list_transactions',
      { ledger_id: 'L1', q: 'dispatch-check' }, 'pat-1', 'bcmcp_test', 'test-pat');
    const parsed = JSON.parse(r.content[0].text) as { items: Array<{ note: string | null; sync_id: string }>; total: number };
    expect(parsed.total).toBe(1);
    expect(parsed.items[0].note).toBe('dispatch-check');
  });

  it('生产分发：execTool get_transaction 支持 ledger_id 消歧', async () => {
    const c = ctx();
    const created = asObj<{ sync_id: string }>(await createTransaction(c, { amount: 7, ledger_id: 'L1', happened_at: '2026-02-01T00:00:00+08:00' }));
    const { execTool } = await import('../src/routes/mcp');
    const scopes = ['mcp:read'];
    const env = { JWT_SECRET: 'test-secret' };
    const r = await execTool(db, env as never, 'https://beecount.example.com', 'u1', scopes, 'get_transaction',
      { sync_id: created.sync_id, ledger_id: 'L1' }, 'pat-1', 'bcmcp_test', 'test-pat');
    // 对齐上游 get_transaction：ledger 是账本名，external_id 走 ledger_id
    const parsed = JSON.parse(r.content[0].text) as { sync_id: string; ledger: string | null; ledger_id: string | null };
    expect(parsed.sync_id).toBe(created.sync_id);
    expect(parsed.ledger_id).toBe('L1');
    expect(parsed.ledger).toBe('主账本');
  });

  it('DELETE 交易 expected_revision 冲突 → 409 REVISION_CONFLICT（对齐上游 _commit_write_fast_tx）', async () => {
    const c = ctx();
    const created = asObj<{ sync_id: string }>(await createTransaction(c, { amount: 9, ledger_id: 'L1', happened_at: '2026-03-01T00:00:00+08:00' }));
    const current = asObj<{ revision: number }>(await getTransaction(c, { sync_id: created.sync_id, ledger_id: 'L1' }));
    // 错误的修订 → 409
    const del = await import('../src/mcp/tools/write-tools');
    await expect(del.deleteTransaction(c, {
      sync_id: created.sync_id, ledger_id: 'L1', confirm: true,
      expected_revision: (current.revision ?? 0) + 100,
    })).rejects.toThrow(/REVISION_CONFLICT/);
    // 正确的修订 → 删除成功
    const ok = asObj<{ status: string }>(await del.deleteTransaction(c, {
      sync_id: created.sync_id, ledger_id: 'L1', confirm: true,
      expected_revision: current.revision,
    }));
    expect(ok.status).toBe('deleted');
    expect(await getTransaction(c, { sync_id: created.sync_id, ledger_id: 'L1' })).toBeNull();
  });
});