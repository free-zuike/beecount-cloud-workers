/**
 * MCP 工具注册表（对齐原版 #133 的 READ/WRITE_FUNCTIONS 注册面）。
 *
 * routes/mcp.ts 的 execTool 查此表执行模块工具；身份/账本上下文由
 * server 层注入 McpContext（user 绝不来自工具参数）。
 *
 * scope: 'read' | 'write' —— 对应 PAT 的 mcp:read / mcp:write 强制。
 */
import type { McpContext } from './types';
import {
  previewImport, executeImportPlan, undoImportPlan,
  linkTransactionSource, unlinkTransactionSource, listTransactionSources,
  reconcileAccount, saveReconciliationCheckpoint, getWorkflowRecord, listWorkflowRecords,
} from './workflow-tools';
import {
  saveReviewItem, saveClassificationRule, applyClassificationRule,
  executeClassificationPreview, manageRecurringRule, runDueRecurringRules,
} from './rule-tools';
import {
  readAttachment, listAttachments, previewImportFile, exportTransactions,
  parseReceipt, previewTextTransactions,
} from './file-tools';
import { analyzeTransactions } from './analysis-tools';
import {
  manageAccount, manageCategory, manageTag, manageBudget, manageLedger,
  getBookkeepingContext, getOperation, retryOperation, listOperations,
  listChanges, getAccountBalances, getNetWorthHistory, listLedgerMembers,
} from './capability-tools';

export interface RegisteredTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  scope: 'read' | 'write';
  handler: (c: McpContext, args: Record<string, unknown>) => Promise<unknown>;
}

const obj = { type: 'object' as const, properties: {} as Record<string, unknown> };

function tools(items: Array<Omit<RegisteredTool, 'handler'> & { handler: (c: McpContext, args: Record<string, unknown>) => Promise<unknown> }>): RegisteredTool[] {
  return items as RegisteredTool[];
}

export const REGISTERED_TOOLS: RegisteredTool[] = tools([
  // ── 账本管理（capability，旧 server 未暴露的写面）──
  {
    name: 'manage_account', scope: 'write',
    description: 'Create/update/delete an account (dictionary CRUD). action: create|update|delete. data: {name, account_type, currency, initial_balance, credit_limit, ...}. Delete requires confirm=true. Returns a durable operation with sync_ids.',
    inputSchema: { ...obj, properties: { action: { type: 'string', enum: ['create', 'update', 'delete'] }, ledger_id: { type: 'string' }, data: { type: 'object' }, account_id: { type: 'string' }, confirm: { type: 'boolean' }, idempotency_key: { type: 'string' } }, required: ['action', 'ledger_id'] },
    handler: (c, a) => manageAccount(c, a as never),
  },
  {
    name: 'manage_category', scope: 'write',
    description: 'Create/update/delete a category. data: {name, kind (expense|income|transfer), parent_name, icon}. Delete requires confirm=true.',
    inputSchema: { ...obj, properties: { action: { type: 'string', enum: ['create', 'update', 'delete'] }, ledger_id: { type: 'string' }, data: { type: 'object' }, category_id: { type: 'string' }, confirm: { type: 'boolean' }, idempotency_key: { type: 'string' } }, required: ['action', 'ledger_id'] },
    handler: (c, a) => manageCategory(c, a as never),
  },
  {
    name: 'manage_tag', scope: 'write',
    description: 'Create/update/delete a tag. data: {name, color}. Delete requires confirm=true.',
    inputSchema: { ...obj, properties: { action: { type: 'string', enum: ['create', 'update', 'delete'] }, ledger_id: { type: 'string' }, data: { type: 'object' }, tag_id: { type: 'string' }, confirm: { type: 'boolean' }, idempotency_key: { type: 'string' } }, required: ['action', 'ledger_id'] },
    handler: (c, a) => manageTag(c, a as never),
  },
  {
    name: 'manage_budget', scope: 'write',
    description: 'Create/update/delete a budget. data: {type (total|category), amount, period, start_day, category_id}. Delete requires confirm=true.',
    inputSchema: { ...obj, properties: { action: { type: 'string', enum: ['create', 'update', 'delete'] }, ledger_id: { type: 'string' }, data: { type: 'object' }, budget_id: { type: 'string' }, confirm: { type: 'boolean' }, idempotency_key: { type: 'string' } }, required: ['action', 'ledger_id'] },
    handler: (c, a) => manageBudget(c, a as never),
  },
  {
    name: 'manage_ledger', scope: 'write',
    description: 'Create/update/delete a ledger. create: {ledger_id (external id), ledger_name, currency}; update: {ledger_name, month_start_day}; delete requires confirm=true.',
    inputSchema: { ...obj, properties: { action: { type: 'string', enum: ['create', 'update', 'delete'] }, data: { type: 'object' }, ledger_id: { type: 'string' }, confirm: { type: 'boolean' }, idempotency_key: { type: 'string' } }, required: ['action'] },
    handler: (c, a) => manageLedger(c, a as never),
  },
  {
    name: 'get_bookkeeping_context', scope: 'read',
    description: 'Return the selected ledger and the server capability list (transfers, revision-bound pagination, durable operations, dictionary CRUD, imports, rules, analysis, files).',
    inputSchema: { ...obj, properties: { ledger_id: { type: 'string' } } },
    handler: (c, a) => getBookkeepingContext(c, a as never),
  },
  {
    name: 'get_operation', scope: 'read',
    description: 'Read a durable write operation by operation_id (idempotent replay state, sync_ids, error).',
    inputSchema: { ...obj, properties: { operation_id: { type: 'string' } }, required: ['operation_id'] },
    handler: (c, a) => getOperation(c, a as never),
  },
  {
    name: 'list_operations', scope: 'read',
    description: 'List recent durable write operations for a ledger.',
    inputSchema: { ...obj, properties: { ledger_id: { type: 'string' }, limit: { type: 'number' } }, required: ['ledger_id'] },
    handler: (c, a) => listOperations(c, a as never),
  },
  {
    name: 'retry_operation', scope: 'write',
    description: 'Resume a failed/partial durable operation (same idempotency key, replay of remaining steps).',
    inputSchema: { ...obj, properties: { operation_id: { type: 'string' } }, required: ['operation_id'] },
    handler: (c, a) => retryOperation(c, a as never),
  },
  {
    name: 'list_changes', scope: 'read',
    description: 'Incremental change feed for a ledger (transactions/accounts/categories/tags/budgets/ledger), signed cursor pagination.',
    inputSchema: { ...obj, properties: { ledger_id: { type: 'string' }, cursor: { type: 'string' }, limit: { type: 'number' } }, required: ['ledger_id'] },
    handler: (c, a) => listChanges(c, a as never),
  },
  {
    name: 'get_account_balances', scope: 'read',
    description: 'Account balances (initial + movements) with per-currency totals; scope personal (default) or visible (shared).',
    inputSchema: { ...obj, properties: { ledger_id: { type: 'string' }, at: { type: 'string' }, time_zone: { type: 'string' }, scope: { type: 'string', enum: ['personal', 'visible'] } } },
    handler: (c, a) => getAccountBalances(c, a as never),
  },
  {
    name: 'get_net_worth_history', scope: 'read',
    description: 'Monthly net-worth series per currency (missing conversion rates reported); base_currency optional.',
    inputSchema: { ...obj, properties: { ledger_id: { type: 'string' }, base_currency: { type: 'string' }, time_zone: { type: 'string' } } },
    handler: (c, a) => getNetWorthHistory(c, a as never),
  },
  {
    name: 'list_ledger_members', scope: 'read',
    description: 'List ledger members and their roles.',
    inputSchema: { ...obj, properties: { ledger_id: { type: 'string' } }, required: ['ledger_id'] },
    handler: (c, a) => listLedgerMembers(c, a as never),
  },

  // ── 导入/对账工作流（workflow_tools）──
  {
    name: 'preview_import', scope: 'write',
    description: 'Versioned dry-run of 1..200 import candidates. Exact source identities mark existing entries; same-day/same-amount matches are review candidates only. No writes. Returns an import_plan record {id, revision, status, data}.',
    inputSchema: { ...obj, properties: { ledger_id: { type: 'string' }, candidates: { type: 'array', items: { type: 'object' }, description: 'Each: {transaction: {...BatchTransactionItem fields}, sources: [{source_system, source_id, order_id?, file_sha256?, row_number?}], action?, existing_sync_id?, allow_similar?}' }, time_zone: { type: 'string' }, plan_id: { type: 'string' }, expected_revision: { type: 'number' } }, required: ['ledger_id', 'candidates'] },
    handler: (c, a) => previewImport(c, a as never),
  },
  {
    name: 'execute_import_plan', scope: 'write',
    description: 'Execute a saved import preview after confirmation; restart/response-loss retries reuse the original operation. Returns {status, operation_id, sync_ids, plan_id}.',
    inputSchema: { ...obj, properties: { plan_id: { type: 'string' }, expected_revision: { type: 'number' }, confirm: { type: 'boolean' } }, required: ['plan_id', 'expected_revision'] },
    handler: (c, a) => executeImportPlan(c, a as never),
  },
  {
    name: 'undo_import_plan', scope: 'write',
    description: 'Remove only transactions created by an import (revision checks protect later user edits). Confirmation required.',
    inputSchema: { ...obj, properties: { plan_id: { type: 'string' }, expected_revision: { type: 'number' }, confirm: { type: 'boolean' } }, required: ['plan_id', 'expected_revision'] },
    handler: (c, a) => undoImportPlan(c, a as never),
  },
  {
    name: 'link_transaction_source', scope: 'write',
    description: 'Attach a source receipt/order/bank entry to an existing transaction. One source identity can refer to only one transaction in a ledger.',
    inputSchema: { ...obj, properties: { ledger_id: { type: 'string' }, sync_id: { type: 'string' }, source: { type: 'object', properties: { source_system: { type: 'string' }, source_id: { type: 'string' }, order_id: { type: 'string' }, file_sha256: { type: 'string' }, row_number: { type: 'number' } }, required: ['source_system', 'source_id'] } }, required: ['ledger_id', 'sync_id', 'source'] },
    handler: (c, a) => linkTransactionSource(c, a as never),
  },
  {
    name: 'unlink_transaction_source', scope: 'write',
    description: 'Remove an incorrect source association (reserved active-import sources cannot be removed). Confirmation required.',
    inputSchema: { ...obj, properties: { ledger_id: { type: 'string' }, reference_id: { type: 'string' }, confirm: { type: 'boolean' } }, required: ['ledger_id', 'reference_id'] },
    handler: (c, a) => unlinkTransactionSource(c, a as never),
  },
  {
    name: 'list_transaction_sources', scope: 'read',
    description: 'List all source identities proving a transaction.',
    inputSchema: { ...obj, properties: { ledger_id: { type: 'string' }, sync_id: { type: 'string' } }, required: ['ledger_id', 'sync_id'] },
    handler: (c, a) => listTransactionSources(c, a as never),
  },
  {
    name: 'reconcile_account', scope: 'read',
    description: 'Compare an actual statement balance with opening balance plus all account movements through a date; reports unassigned candidates. Never writes.',
    inputSchema: { ...obj, properties: { ledger_id: { type: 'string' }, account_id: { type: 'string' }, at: { type: 'string' }, actual_balance: { type: 'number' }, time_zone: { type: 'string' } }, required: ['ledger_id', 'account_id', 'at', 'actual_balance'] },
    handler: (c, a) => reconcileAccount(c, a as never),
  },
  {
    name: 'save_reconciliation_checkpoint', scope: 'write',
    description: 'Save a user-confirmed account/source coverage checkpoint (statement difference + dataset revision) for another Agent to continue. Confirmation required.',
    inputSchema: { ...obj, properties: { ledger_id: { type: 'string' }, account_id: { type: 'string' }, at: { type: 'string' }, actual_balance: { type: 'number' }, source_system: { type: 'string' }, coverage_from: { type: 'string' }, time_zone: { type: 'string' }, confirm: { type: 'boolean' } }, required: ['ledger_id', 'account_id', 'at', 'actual_balance', 'source_system'] },
    handler: (c, a) => saveReconciliationCheckpoint(c, a as never),
  },
  {
    name: 'get_workflow_record', scope: 'read',
    description: 'Read a saved import/reconciliation/rule/review record by ID (checks current ledger membership).',
    inputSchema: { ...obj, properties: { record_id: { type: 'string' } }, required: ['record_id'] },
    handler: (c, a) => getWorkflowRecord(c, a as never),
  },
  {
    name: 'list_workflow_records', scope: 'read',
    description: 'List persistent workflow records for a ledger by kind (import_plan|checkpoint|review_item|classification_rule|recurring_rule|export) with optimistic revisions.',
    inputSchema: { ...obj, properties: { ledger_id: { type: 'string' }, kind: { type: 'string', enum: ['import_plan', 'checkpoint', 'review_item', 'classification_rule', 'recurring_rule', 'export'] }, status: { type: 'string' }, limit: { type: 'number' }, offset: { type: 'number' } }, required: ['ledger_id', 'kind'] },
    handler: (c, a) => listWorkflowRecords(c, a as never),
  },

  // ── 规则/审核/周期（rule_tools）──
  {
    name: 'save_review_item', scope: 'write',
    description: 'Save a question, related transaction IDs, user answer and resolution state so another Agent can continue. Updates require record_id + expected_revision.',
    inputSchema: { ...obj, properties: { ledger_id: { type: 'string' }, question: { type: 'string' }, transaction_ids: { type: 'array', items: { type: 'string' } }, answer: { type: 'string' }, status: { type: 'string', enum: ['open', 'answered', 'resolved', 'dismissed'] }, record_id: { type: 'string' }, expected_revision: { type: 'number' } }, required: ['ledger_id', 'question'] },
    handler: (c, a) => saveReviewItem(c, a as never),
  },
  {
    name: 'save_classification_rule', scope: 'write',
    description: 'Save a versioned categorization rule (note_contains/account/min-max amount → category). Confirmed rules require explicit confirm=true; inferred rules are never applied automatically.',
    inputSchema: { ...obj, properties: { ledger_id: { type: 'string' }, name: { type: 'string' }, note_contains: { type: 'string' }, account_id: { type: 'string' }, tx_type: { type: 'string', enum: ['income', 'expense'] }, min_amount: { type: 'number' }, max_amount: { type: 'number' }, category_id: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, except_sync_ids: { type: 'array', items: { type: 'string' } }, enabled: { type: 'boolean' }, confirmed: { type: 'boolean' }, record_id: { type: 'string' }, expected_revision: { type: 'number' }, confirm: { type: 'boolean' } }, required: ['ledger_id', 'name', 'category_id'] },
    handler: (c, a) => saveClassificationRule(c, a as never),
  },
  {
    name: 'apply_classification_rule', scope: 'write',
    description: 'Compute and persist a preview of a confirmed rule\'s matching transactions (before/after, frozen revisions). Apply via execute_classification_preview.',
    inputSchema: { ...obj, properties: { rule_id: { type: 'string' }, expected_revision: { type: 'number' }, confirm: { type: 'boolean' } }, required: ['rule_id'] },
    handler: (c, a) => applyClassificationRule(c, a as never),
  },
  {
    name: 'execute_classification_preview', scope: 'write',
    description: 'Apply exactly the saved classification preview; stale transaction revisions fail without overwriting user edits. Confirmation required.',
    inputSchema: { ...obj, properties: { preview_id: { type: 'string' }, confirm: { type: 'boolean' } }, required: ['preview_id'] },
    handler: (c, a) => executeClassificationPreview(c, a as never),
  },
  {
    name: 'manage_recurring_rule', scope: 'write',
    description: 'Create/update/pause/resume/delete a Cloud-owned recurring rule (daily/weekly/monthly/yearly, month-end clamped, DST-aware, opt-in backfill). Confirmation required. Returns next_occurrences preview.',
    inputSchema: { ...obj, properties: { action: { type: 'string', enum: ['create', 'update', 'pause', 'resume', 'delete'] }, ledger_id: { type: 'string' }, data: { type: 'object', description: '{name, transaction: {...}, frequency, interval?, starts_at, time_zone, ends_at?, enabled?, allow_backfill?, dst_policy?}' }, record_id: { type: 'string' }, expected_revision: { type: 'number' }, confirm: { type: 'boolean' } }, required: ['action'] },
    handler: (c, a) => manageRecurringRule(c, a as never),
  },
  {
    name: 'run_due_recurring_rules', scope: 'write',
    description: 'Process currently due Cloud schedules owned by this user in one ledger. Never generates future transactions; repeated runs are idempotent.',
    inputSchema: { ...obj, properties: { ledger_id: { type: 'string' } }, required: ['ledger_id'] },
    handler: (c, a) => runDueRecurringRules(c, a as never),
  },

  // ── 文件/导入导出（file_tools）──
  {
    name: 'read_attachment', scope: 'read',
    description: 'Read an attachment\'s metadata and raw bytes (base64) for the current user\'s ledger.',
    inputSchema: { ...obj, properties: { file_id: { type: 'string' } }, required: ['file_id'] },
    handler: (c, a) => readAttachment(c, a as never),
  },
  {
    name: 'list_attachments', scope: 'read',
    description: 'List attachment files of a ledger.',
    inputSchema: { ...obj, properties: { ledger_id: { type: 'string' }, q: { type: 'string' }, limit: { type: 'number' }, offset: { type: 'number' } }, required: ['ledger_id'] },
    handler: (c, a) => listAttachments(c, a as never),
  },
  {
    name: 'preview_import_file', scope: 'write',
    description: 'Parse a CSV/XLSX attachment into import candidates and produce a persisted preview_import plan (mapping columns to fields).',
    inputSchema: { ...obj, properties: { file_id: { type: 'string' }, mapping: { type: 'object', description: '{tx_type, amount, happened_at, category_name, account_name, note, currency, ...}' }, source_system: { type: 'string' }, source_id_column: { type: 'string' }, time_zone: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } }, required: ['file_id'] },
    handler: (c, a) => previewImportFile(c, a as never),
  },
  {
    name: 'export_transactions', scope: 'read',
    description: 'Export transactions to CSV (BOM, formula-injection escaped); returns export_id, row_count, revision, sha256.',
    inputSchema: { ...obj, properties: { ledger_id: { type: 'string' }, date_from: { type: 'string' }, date_to: { type: 'string' }, tx_type: { type: 'string' }, account_id: { type: 'string' }, category_id: { type: 'string' }, tag_id: { type: 'string' }, time_zone: { type: 'string' } }, required: ['ledger_id'] },
    handler: (c, a) => exportTransactions(c, a as never),
  },
  {
    name: 'parse_receipt', scope: 'write',
    description: 'Parse a receipt image into a transaction draft using the configured AI provider. Currently requires the local AI parsing channel.',
    inputSchema: { ...obj, properties: { file_id: { type: 'string' }, locale: { type: 'string' } }, required: ['file_id'] },
    handler: (c, a) => parseReceipt(c, a as never),
  },
  {
    name: 'preview_text_transactions', scope: 'write',
    description: 'Parse free-form text into transaction drafts using the configured AI provider. Currently requires the local AI parsing channel.',
    inputSchema: { ...obj, properties: { ledger_id: { type: 'string' }, text: { type: 'string' }, locale: { type: 'string' } }, required: ['ledger_id', 'text'] },
    handler: (c, a) => previewTextTransactions(c, a as never),
  },

  // ── 聚合分析（analysis_tools）──
  {
    name: 'analyze_transactions', scope: 'read',
    description: 'Composable aggregation by local calendar/category/account/tag/member/type with optional comparison filters and exact drill-down context. Transfers separate from income/expense.',
    inputSchema: { ...obj, properties: { ledger_id: { type: 'string' }, filters: { type: 'object', description: '{date_from, date_to, tx_type, category_ids, account_ids, tag_ids, member_user_ids, note_contains, min_amount, max_amount, include_excluded}' }, group_by: { type: 'string', enum: ['none', 'day', 'week', 'month', 'category', 'account', 'tag', 'member', 'type'] }, time_zone: { type: 'string' }, comparison: { type: 'object' }, top_n: { type: 'number' } }, required: ['ledger_id'] },
    handler: (c, a) => analyzeTransactions(c, a as never),
  },
]);

export function getRegisteredTool(name: string): RegisteredTool | undefined {
  return REGISTERED_TOOLS.find(t => t.name === name);
}