// 移植上游 tests/test_mcp_workflows.py（#133 导入/对账/周期/分类规则/文件/分析工作流，17 例）：
// 导入计划预览→执行→来源链接→安全撤销、相似度审查、过期预览拒绝、修订乐观锁、
// 对账与检查点、CSV 文件导入导出与权限、组合分析本地日期/标记、月末周期规则幂等、
// 失效规则不阻塞、DST 间隙/歧义策略、分类规则冻结版本、保留来源互斥、净资产多币种、
// 共享账本字典/AI 上下文、外币转账、丢响应后规则编辑保护。
// 当前阶段：测试先行——4 个工具模块为签名骨架，全部用例应红（MCP_TODO）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {
  makeHarness, registerUser, createLedger, registerDevice, setPrimaryCurrency,
  asObj, bindSelfCall, type Harness,
} from './mcp-harness';
import * as workflows from '../src/mcp/workflow-tools';
import * as rules from '../src/mcp/rule-tools';
import * as files from '../src/mcp/file-tools';
import * as analysis from '../src/mcp/analysis-tools';
import {
  manageAccount, manageCategory, listChanges, getAccountBalances, getNetWorthHistory,
} from '../src/mcp/capability-tools';
import {
  listTransactions, getTransaction, listAccounts,
} from '../src/mcp/tools/read-tools';
import { createTransaction, createTransactions, updateTransaction, setSelfCall, type SelfCallFn } from '../src/mcp/tools/write-tools';
import { loadLedgerContext } from '../src/routes/ai';

let sqlite: DatabaseSync;
let db: D1Database;
let h: Harness;
let selfCallReal: SelfCallFn;

function ctx(userId = 'u1'): { db: D1Database; userId: string; jwtSecret: string; baseUrl: string } {
  return { db, userId, jwtSecret: 'test-secret', baseUrl: 'https://beecount.example.com' };
}

function sha256Hex(b: Uint8Array): string {
  return createHash('sha256').update(Buffer.from(b)).digest('hex');
}

/** 创建账户 helper（对齐上游 test_mcp_complete.account：initial_balance=1000） */
async function account(name: string, opts: { currency?: string; initial_balance?: number; account_type?: string } = {}): Promise<string> {
  const out = asObj<{ status: string; sync_ids: string[] }>(await manageAccount(ctx(), {
    action: 'create', ledger_id: 'L1',
    data: { name, currency: opts.currency ?? 'CNY', initial_balance: opts.initial_balance ?? 1000, ...(opts.account_type ? { account_type: opts.account_type } : {}) },
  }));
  expect(out.status).toBe('completed');
  return out.sync_ids[0];
}

/** 导入候选 helper（对齐上游 candidate()） */
function candidate(amount = 10, source = 'source-1', extra: Record<string, unknown> = {}): workflows.ImportCandidate {
  return {
    transaction: { amount, happened_at: '2026-01-02T12:00:00+08:00', ...extra },
    sources: [{ source_system: 'synthetic-bank', source_id: source }],
  };
}

beforeEach(() => {
  h = makeHarness();
  sqlite = h.sqlite;
  db = h.db;
  registerUser(h, 'u1', 'owner@x.com');
  createLedger(h, 'u1', 'led-1', 'L1', '主账本');
  registerDevice(h, 'u1');
  setPrimaryCurrency(h, 'u1', 'CNY');
  selfCallReal = bindSelfCall(h, setSelfCall);
});

afterEach(() => sqlite.close());

describe('MCP workflows（移植上游 test_mcp_workflows.py）', () => {
  it('导入预览→执行→来源链接→安全撤销（编辑后 undo 冲突）', async () => {
    const plan = asObj<{ status: string; id: string; revision: number }>(await workflows.previewImport(ctx(), { ledger_id: 'L1', candidates: [candidate()] }));
    expect(plan.status).toBe('ready');
    expect(asObj<{ total: number }>(await listTransactions(ctx(), {})).total).toBe(0);
    const outcome = asObj<{ status: string; operation_id: string; sync_ids: string[] }>(
      await workflows.executeImportPlan(ctx(), { plan_id: plan.id, expected_revision: plan.revision, confirm: true }),
    );
    expect(outcome.status).toBe('completed');
    const sid = outcome.sync_ids[0];
    const sources = await workflows.listTransactionSources(ctx(), { ledger_id: 'L1', sync_id: sid });
    expect(sources[0].source_id).toBe('source-1');

    const repeated = asObj<{ operation_id: string }>(
      await workflows.executeImportPlan(ctx(), { plan_id: plan.id, expected_revision: plan.revision, confirm: true }),
    );
    expect(repeated.operation_id).toBe(outcome.operation_id);
    expect(asObj<{ total: number }>(await listTransactions(ctx(), {})).total).toBe(1);

    await updateTransaction(ctx(), { sync_id: sid, note: 'later manual edit' });
    const undo = asObj<{ status: string }>(await workflows.undoImportPlan(ctx(), { plan_id: plan.id, expected_revision: plan.revision, confirm: true }));
    expect(undo.status).toBe('conflict');
    expect(asObj<{ note: string | null }>(await getTransaction(ctx(), { sync_id: sid })).note).toBe('later manual edit');

    await expect(workflows.previewImport(ctx(), { ledger_id: 'L1', candidates: [candidate(20)], plan_id: plan.id, expected_revision: plan.revision }))
      .rejects.toThrow(/cannot be edited/);
  });

  it('导入撤销只删本次创建的条目与来源链接', async () => {
    const plan = asObj<{ id: string; revision: number }>(await workflows.previewImport(ctx(), { ledger_id: 'L1', candidates: [candidate()] }));
    const result = asObj<{ sync_ids: string[] }>(await workflows.executeImportPlan(ctx(), { plan_id: plan.id, expected_revision: plan.revision, confirm: true }));
    const sid = result.sync_ids[0];
    const undone = asObj<{ status: string }>(await workflows.undoImportPlan(ctx(), { plan_id: plan.id, expected_revision: plan.revision, confirm: true }));
    expect(undone.status).toBe('completed');
    expect(await getTransaction(ctx(), { sync_id: sid })).toBeNull();
    expect(await workflows.listTransactionSources(ctx(), { ledger_id: 'L1', sync_id: sid })).toEqual([]);
    const changes = asObj<{ items: Array<{ sync_id: string; action: string }> }>(await listChanges(ctx(), { ledger_id: 'L1' }));
    expect(changes.items.some((item) => item.sync_id === sid && item.action === 'delete')).toBe(true);
  });

  it('相似导入需审查，精确来源复用后跳过', async () => {
    const original = asObj<{ sync_id: string }>(await createTransaction(ctx(), { amount: 10, happened_at: '2026-01-02T12:00:00+08:00' }));
    const plan = asObj<{ status: string; id: string; revision: number; data: string }>(
      await workflows.previewImport(ctx(), { ledger_id: 'L1', candidates: [candidate()] }),
    );
    expect(plan.status).toBe('needs_review');
    expect((plan.data as unknown as { items: Array<{ status: string }> }).items[0].status).toBe('review_required');
    await expect(workflows.executeImportPlan(ctx(), { plan_id: plan.id, expected_revision: plan.revision, confirm: true }))
      .rejects.toThrow(/unresolved/);
    await workflows.linkTransactionSource(ctx(), { ledger_id: 'L1', sync_id: original.sync_id, source: { source_system: 'synthetic-bank', source_id: 'source-1' } });
    const repeated = asObj<{ id: string; revision: number; data: string }>(
      await workflows.previewImport(ctx(), { ledger_id: 'L1', candidates: [candidate()] }),
    );
    expect((repeated.data as unknown as { items: Array<{ status: string }> }).items[0].status).toBe('existing');
    const outcome = asObj<{ status: string; sync_ids: string[] }>(
      await workflows.executeImportPlan(ctx(), { plan_id: repeated.id, expected_revision: repeated.revision, confirm: true }),
    );
    expect(outcome.status).toBe('completed');
    expect(outcome.sync_ids).toEqual([]);
    expect(asObj<{ total: number }>(await listTransactions(ctx(), {})).total).toBe(1);
  });

  it('过期导入预览在执行前被拒（REVISION_CONFLICT）', async () => {
    const plan = asObj<{ id: string; revision: number }>(await workflows.previewImport(ctx(), { ledger_id: 'L1', candidates: [candidate()] }));
    await createTransaction(ctx(), { amount: 99 });
    await expect(workflows.executeImportPlan(ctx(), { plan_id: plan.id, expected_revision: plan.revision, confirm: true }))
      .rejects.toThrow(/REVISION_CONFLICT/);
    expect(asObj<{ total: number }>(await listTransactions(ctx(), {})).total).toBe(1);
  });

  it('记录修订/对账检查点/用户隔离', async () => {
    const aid = await account('Checkpoint cash');
    await createTransaction(ctx(), { amount: 20, account_id: aid, happened_at: '2026-01-01T12:00:00Z' });
    const result = asObj<{ reconciled: boolean; difference: number }>(
      await workflows.reconcileAccount(ctx(), { ledger_id: 'L1', account_id: aid, at: '2026-01-02', actual_balance: 980, time_zone: 'UTC' }),
    );
    expect(result.reconciled).toBe(true);
    expect(result.difference).toBe(0);
    const saved = asObj<{ kind: string; id: string; revision: number }>(
      await workflows.saveReconciliationCheckpoint(ctx(), { ledger_id: 'L1', account_id: aid, at: '2026-01-02', actual_balance: 980, source_system: 'synthetic-bank', coverage_from: '2026-01-01', time_zone: 'UTC', confirm: true }),
    );
    expect(saved.kind).toBe('checkpoint');

    const review = asObj<{ id: string; revision: number }>(await rules.saveReviewItem(ctx(), { ledger_id: 'L1', question: 'Which receipt?' }));
    const changed = asObj<{ revision: number }>(await rules.saveReviewItem(ctx(), {
      ledger_id: 'L1', question: 'Which receipt?', answer: 'Confirmed by user', status: 'answered',
      record_id: review.id, expected_revision: review.revision,
    }));
    expect(changed.revision).toBe(2);
    await expect(rules.saveReviewItem(ctx(), { ledger_id: 'L1', question: 'stale', record_id: review.id, expected_revision: review.revision }))
      .rejects.toThrow(/REVISION_CONFLICT/);

    registerUser(h, 'u2', 'stranger@example.com');
    await expect(workflows.getWorkflowRecord({ db, userId: 'u2', jwtSecret: 'test-secret', baseUrl: 'https://beecount.example.com' }, { record_id: review.id }))
      .rejects.toThrow(/Ledger not found/);
  });

  it('CSV 文件预览/原字节/导出与权限', async () => {
    const category = asObj<{ status: string }>(await manageCategory(ctx(), { action: 'create', ledger_id: 'L1', data: { name: 'Meals', kind: 'expense' } }));
    expect(category.status).toBe('completed');
    const raw = Buffer.from('Type,Amount,Time,Category,Note\nexpense,12,2026-01-02T12:00:00+08:00,Meals,synthetic\n');
    // 测试环境无 R2：旁路落 attachment_files + 注入字节源（对齐上游 tmp 存储 fixture）
    const fileId = 'file-csv-1';
    sqlite.prepare(
      `INSERT INTO attachment_files (id, ledger_id, user_id, sha256, size_bytes, mime_type, file_name, storage_path, attachment_kind, created_at)
       VALUES (?, 'led-1', 'u1', ?, ?, 'text/csv', 'synthetic.csv', 'attachments/L1/file-csv-1_synthetic.csv', 'transaction', ?)`
    ).run(fileId, sha256Hex(raw), raw.length, '2026-01-01T00:00:00Z');
    files.setAttachmentBytesSource(async (_c, fid) => {
      if (fid !== fileId) throw new Error('Attachment storage unavailable');
      return new Uint8Array(raw);
    });
    const readBytes = await files.attachmentBytes(ctx(), { file_id: fileId });
    expect(Buffer.from(readBytes.bytes)).toEqual(raw);
    const preview = asObj<{ status: string; plan: { id: string; revision: number } }>(
      await files.previewImportFile(ctx(), { file_id: fileId, mapping: { tx_type: 'Type', amount: 'Amount', happened_at: 'Time', category_name: 'Category', note: 'Note' } }),
    );
    expect(preview.status).toBe('ready');
    const result = asObj<{ status: string }>(
      await workflows.executeImportPlan(ctx(), { plan_id: preview.plan.id, expected_revision: preview.plan.revision, confirm: true }),
    );
    expect(result.status).toBe('completed');
    const exported = asObj<{ row_count: number; export_id: string }>(await files.exportTransactions(ctx(), { ledger_id: 'L1' }));
    expect(exported.row_count).toBe(1);
    const row = sqlite.prepare('SELECT data_json FROM mcp_state_records WHERE id = ?').get(exported.export_id) as { data_json: string } | undefined;
    expect(row).toBeDefined();
    const data = JSON.parse(row!.data_json) as { csv?: string };
    expect(data.csv).toContain('synthetic');
    expect(data.csv).toContain('currency_code');

    registerUser(h, 'u3', 'no-files@example.com');
    await expect(files.attachmentBytes({ db, userId: 'u3', jwtSecret: 'test-secret', baseUrl: 'https://beecount.example.com' }, { file_id: fileId }))
      .rejects.toThrow(/Ledger not found/);
  });

  it('组合分析：本地日期/排除标记/对比区间', async () => {
    await createTransactions(ctx(), {
      transactions: [
        { amount: 10, happened_at: '2025-12-31T20:00:00Z' },
        { amount: 20, happened_at: '2026-01-01T02:00:00Z' },
        { amount: 99, happened_at: '2026-01-01T02:00:00Z', exclude_from_stats: true },
      ],
    });
    const result = asObj<{ totals: { expense: number; transaction_count: number }; groups: Array<{ key: string }>; comparison: { totals: { expense: number } } }>(
      await analysis.analyzeTransactions(ctx(), {
        ledger_id: 'L1',
        filters: { date_from: '2026-01-01', date_to: '2026-01-01' },
        group_by: 'day',
        time_zone: 'Asia/Shanghai',
        comparison: { date_from: '2025-12-31', date_to: '2025-12-31' },
      }),
    );
    expect(result.totals.expense).toBe(30);
    expect(result.totals.transaction_count).toBe(2);
    expect(result.groups[0].key).toBe('2026-01-01');
    expect(result.comparison.totals.expense).toBe(0);
  });

  it('月末周期规则：追赶/暂停/重试幂等', async () => {
    const schedule: rules.RecurringRule = {
      name: 'Synthetic subscription',
      transaction: { amount: 7 },
      frequency: 'monthly',
      starts_at: '2026-01-31T09:00:00',
      time_zone: 'Asia/Shanghai',
      allow_backfill: true,
    };
    const saved = asObj<{ id: string; revision: number; next_occurrences: string[] }>(
      await rules.manageRecurringRule(ctx(), { action: 'create', ledger_id: 'L1', data: schedule, confirm: true }),
    );
    expect(saved.next_occurrences.slice(0, 3)).toEqual([
      '2026-01-31T09:00:00+08:00',
      '2026-02-28T09:00:00+08:00',
      '2026-03-31T09:00:00+08:00',
    ]);
    const first = asObj<Array<{ operation: { created_count: number } }>>(await rules.executeDueRules(ctx(), { now: '2026-02-28T02:00:00Z' }));
    const second = asObj<Array<{ operation: { created_count: number } }>>(await rules.executeDueRules(ctx(), { now: '2026-02-28T02:00:00Z' }));
    expect(first[0].operation.created_count).toBe(second[0].operation.created_count);
    expect(first[0].operation.created_count).toBe(1);
    expect(asObj<Array<unknown>>(await rules.executeDueRules(ctx(), { now: '2026-02-28T02:00:00Z' }))).toEqual([]);
    expect(asObj<{ total: number }>(await listTransactions(ctx(), {})).total).toBe(2);
    const current = asObj<{ data: string }>(await workflows.getWorkflowRecord(ctx(), { record_id: saved.id }));
    expect((JSON.parse(current.data as string) as { executed_count: number }).executed_count).toBe(2);
    await rules.manageRecurringRule(ctx(), {
      action: 'pause', ledger_id: 'L1', record_id: saved.id,
      expected_revision: asObj<{ revision: number }>(current).revision, confirm: true,
    });
    expect(asObj<Array<unknown>>(await rules.executeDueRules(ctx(), { now: '2026-04-01T00:00:00Z' }))).toEqual([]);
  });

  it('失效周期规则不阻塞后续规则', async () => {
    const deletedAccount = await account('Account removed after scheduling');
    const saved: Array<{ id: string }> = [];
    for (const [day, tx] of [
      [1, { amount: 7, account_id: deletedAccount }],
      [2, { amount: 9 }],
    ] as Array<[number, Record<string, unknown>]>) {
      saved.push(asObj<{ id: string }>(await rules.manageRecurringRule(ctx(), {
        action: 'create', ledger_id: 'L1',
        data: { name: `Independent schedule ${day}`, transaction: tx, frequency: 'daily', starts_at: `2026-01-0${day}T00:00:00Z`, time_zone: 'UTC', allow_backfill: true } as rules.RecurringRule,
        confirm: true,
      })));
    }
    const removed = asObj<{ status: string }>(await manageAccount(ctx(), { action: 'delete', ledger_id: 'L1', account_id: deletedAccount, confirm: true }));
    expect(removed.status).toBe('completed');
    const outcomes = asObj<Array<{ rule_id: string; status?: string; error_code?: string; operation?: { status: string } }>>(
      await rules.executeDueRules(ctx(), { now: '2026-01-02T01:00:00Z' }),
    );
    const byRule = new Map(outcomes.map((item) => [item.rule_id, item]));
    expect(byRule.get(saved[0].id)?.status).toBe('failed');
    expect(byRule.get(saved[0].id)?.error_code).toBe('ValueError');
    expect(byRule.get(saved[1].id)?.operation?.status).toBe('created');
    expect(asObj<{ total: number }>(await listTransactions(ctx(), {})).total).toBe(1);
    expect(asObj<{ items: Array<{ amount: number }> }>(await listTransactions(ctx(), {})).items[0].amount).toBe(9);
  });

  it('周期规则 DST 间隙跳过与歧义策略显式', () => {
    const gapData: Record<string, unknown> = {
      anchor_local: '2026-03-07T02:30:00-05:00',
      rule: { frequency: 'daily', interval: 1, time_zone: 'America/New_York', dst_policy: 'skip' },
    };
    expect(rules.occurrence(gapData, 1)).toBeNull();
    expect(new Date(rules.occurrence(gapData, 2)!).getUTCHours()).toBe(6);
    const ambiguous: Record<string, unknown> = {
      anchor_local: '2026-10-31T01:30:00-04:00',
      rule: { frequency: 'daily', interval: 1, time_zone: 'America/New_York', dst_policy: 'first' },
    };
    const first = rules.occurrence(ambiguous, 1);
    asObj<{ rule: Record<string, unknown> }>(ambiguous).rule.dst_policy = 'second';
    const second = rules.occurrence(ambiguous, 1);
    expect((new Date(second!).getTime() - new Date(first!).getTime()) / 1000).toBe(3600);
  });

  it('分类规则预览冻结版本并保护用户编辑', async () => {
    const createdCategory = asObj<{ sync_ids: string[] }>(await manageCategory(ctx(), { action: 'create', ledger_id: 'L1', data: { name: 'Synthetic coffee', kind: 'expense' } }));
    const cid = createdCategory.sync_ids[0];
    const tx = asObj<{ sync_id: string }>(await createTransaction(ctx(), { ledger_id: 'L1', amount: 9, note: 'Coffee receipt' }));
    const saved = asObj<{ id: string; revision: number }>(await rules.saveClassificationRule(ctx(), {
      ledger_id: 'L1', name: 'Coffee mapping', note_contains: 'Coffee', category_id: cid, confirmed: true, confirm: true,
    }));
    const preview = asObj<{ preview_id: string; items: Array<{ before: { category_id: string | null } }> }>(
      await rules.applyClassificationRule(ctx(), { rule_id: saved.id, expected_revision: saved.revision }),
    );
    expect(preview.items[0].before.category_id).toBeNull();
    await updateTransaction(ctx(), { sync_id: tx.sync_id, note: 'Manual correction' });
    const attempted = asObj<{ status: string; error: { code: string; retryable: boolean } }>(
      await rules.executeClassificationPreview(ctx(), { preview_id: preview.preview_id, confirm: true }),
    );
    expect(attempted.status).toBe('failed');
    expect(attempted.error.code).toBe('REVISION_CONFLICT');
    expect(attempted.error.retryable).toBe(false);
    expect(asObj<{ category_id: string | null }>(await getTransaction(ctx(), { sync_id: tx.sync_id })).category_id).toBeNull();
  });

  it('保留来源阻止竞争导入计划', async () => {
    const first = asObj<{ id: string; revision: number }>(await workflows.previewImport(ctx(), { ledger_id: 'L1', candidates: [candidate()] }));
    const second = asObj<{ id: string; revision: number }>(await workflows.previewImport(ctx(), { ledger_id: 'L1', candidates: [candidate()] }));
    setSelfCall(async (method, path, userId, body, headers) => {
      if (path.endsWith('/transactions/batch')) throw new Error('synthetic service failure before writes');
      return selfCallReal(method, path, userId, body, headers);
    });
    const failed = asObj<{ status: string }>(
      await workflows.executeImportPlan(ctx(), { plan_id: first.id, expected_revision: first.revision, confirm: true }),
    );
    expect(failed.status).toBe('failed');
    await expect(workflows.executeImportPlan(ctx(), { plan_id: second.id, expected_revision: second.revision, confirm: true }))
      .rejects.toThrow(/SOURCE_CONFLICT/);
    setSelfCall(selfCallReal);
    const resumed = asObj<{ status: string }>(
      await workflows.executeImportPlan(ctx(), { plan_id: first.id, expected_revision: first.revision, confirm: true }),
    );
    expect(resumed.status).toBe('completed');
    expect(asObj<{ total: number }>(await listTransactions(ctx(), {})).total).toBe(1);
  });

  it('净资产多币种分离并报告缺失汇率', async () => {
    await account('RMB cash', { currency: 'CNY' });
    await account('Dollar cash', { currency: 'USD' });
    const history = asObj<{ multi_currency: boolean; missing_conversion_currencies: string[]; series: unknown[]; series_by_currency: Array<{ by_currency: Record<string, { net_worth: number }> }> }>(
      await getNetWorthHistory(ctx(), { base_currency: 'CNY' }),
    );
    expect(history.multi_currency).toBe(true);
    expect(history.missing_conversion_currencies).toEqual(['USD']);
    expect(history.series).toEqual([]);
    const last = history.series_by_currency[history.series_by_currency.length - 1];
    expect(last.by_currency.CNY.net_worth).toBe(1000);
    expect(last.by_currency.USD.net_worth).toBe(1000);
  });

  it('净资产信用/债务/溢付使用符号余额', async () => {
    const created = asObj<{ sync_ids: string[] }>(await manageAccount(ctx(), {
      action: 'create', ledger_id: 'L1',
      data: { name: 'Synthetic credit', account_type: 'credit_card', currency: 'CNY', initial_balance: -100 },
    }));
    const aid = created.sync_ids[0];
    const before = asObj<{ series: Array<{ liabilities: number; net_worth: number }> }>(await getNetWorthHistory(ctx()));
    expect(before.series[before.series.length - 1].liabilities).toBe(100);
    expect(before.series[before.series.length - 1].net_worth).toBe(-100);
    await createTransaction(ctx(), { ledger_id: 'L1', amount: 150, tx_type: 'income', account_id: aid });
    const after = asObj<{ series: Array<{ assets: number; liabilities: number }> }>(await getNetWorthHistory(ctx()));
    expect(after.series[after.series.length - 1].liabilities).toBe(0);
    expect(after.series[after.series.length - 1].assets).toBe(50);
  });

  it('共享账本字典读取与 AI 上下文使用账本 owner（#133 修复点）', async () => {
    const aid = await account('Shared owner cash');
    registerUser(h, 'u2', 'shared-dictionary@example.com');
    h.sqlite.prepare("INSERT INTO ledger_members (ledger_id, user_id, role, joined_at) VALUES ('led-1', 'u2', 'editor', '2026-01-01T00:00:00Z')").run();
    const memberCtx = { db, userId: 'u2', jwtSecret: 'test-secret', baseUrl: 'https://beecount.example.com' };
    const ledgerCtx = await loadLedgerContext(db, 'u2', 'L1');
    expect(ledgerCtx.accounts.some(([name]) => name === 'Shared owner cash')).toBe(true);
    const accounts = await listAccounts(memberCtx, { ledger_id: 'L1' });
    expect(accounts.some((a: any) => a.id === aid)).toBe(true);
    const balances = asObj<{ accounts: Array<{ account_id: string }> }>(await getAccountBalances(memberCtx, {}));
    expect(balances.accounts.some((a) => a.account_id === aid)).toBe(false);
    const sharedHistory = asObj<{ series: Array<{ net_worth: number }>; coverage: { partial: boolean } }>(
      await getNetWorthHistory(memberCtx, { ledger_id: 'L1' }),
    );
    expect(sharedHistory.series[sharedHistory.series.length - 1].net_worth).toBe(1000);
    expect(sharedHistory.coverage.partial).toBe(true);
  });

  it('外币转账金额不计入基础币汇总', async () => {
    const source = await account('USD source', { currency: 'USD' });
    const destination = await account('USD destination', { currency: 'USD' });
    const result = asObj<{ status: string }>(await createTransaction(ctx(), {
      ledger_id: 'L1', amount: 5, tx_type: 'transfer', from_account_id: source, to_account_id: destination,
    }));
    expect(result.status).toBe('created');
    const report = asObj<{ totals: { transfer_by_currency: Record<string, number>; transfer: number; expense: number } }>(
      await analysis.analyzeTransactions(ctx(), { ledger_id: 'L1' }),
    );
    expect(report.totals.transfer_by_currency).toEqual({ USD: 5 });
    expect(report.totals.transfer).toBe(0);
    expect(report.totals.expense).toBe(0);
  });

  it('周期规则丢响应后不可被规则编辑覆盖', async () => {
    const schedule: rules.RecurringRule = {
      name: 'Lost response rule',
      transaction: { amount: 7 },
      frequency: 'daily',
      starts_at: '2026-01-01T00:00:00Z',
      time_zone: 'UTC',
      allow_backfill: true,
    };
    const saved = asObj<{ id: string; revision: number }>(await rules.manageRecurringRule(ctx(), { action: 'create', ledger_id: 'L1', data: schedule, confirm: true }));
    setSelfCall(async (method, path, userId, body, headers) => {
      const result = await selfCallReal(method, path, userId, body, headers);
      if (path.endsWith('/transactions/batch')) throw new Error('synthetic lost response after commit');
      return result;
    });
    const now = '2026-01-01T01:00:00Z';
    const failed = asObj<Array<{ operation: { status: string } }>>(await rules.executeDueRules(ctx(), { now }));
    expect(failed[0].operation.status).toBe('failed');
    const blocked = asObj<{ status: string }>(await rules.manageRecurringRule(ctx(), {
      action: 'update', ledger_id: 'L1', record_id: saved.id, expected_revision: saved.revision,
      data: { ...schedule, transaction: { amount: 9 } }, confirm: true,
    }));
    expect(blocked.status).toBe('operation_pending');
    setSelfCall(selfCallReal);
    const resumed = asObj<Array<{ operation: { status: string } }>>(await rules.executeDueRules(ctx(), { now }));
    expect(resumed[0].operation.status).toBe('created');
    expect(asObj<{ total: number }>(await listTransactions(ctx(), {})).total).toBe(1);
    expect(asObj<{ items: Array<{ amount: number }> }>(await listTransactions(ctx(), {})).items[0].amount).toBe(7);
  });
});


