/**
 * MCP 写工具（对齐原版 src/mcp/tools/write_tools.py + #133）。
 * 统一走 transaction-service 的 create_many / update_one，支持幂等键与乐观修订。
 * selfCall 默认用 HTTP 自调用生产 write 路由；测试可通过 setSelfCall 注入。
 */
import { createMany, updateOne, selfCallAdapter, setSelfCall, type SelfCallFn } from '../transaction-service';
import type { McpContext } from '../types';

export { setSelfCall };
export type { SelfCallFn };

/** 单笔创建（对齐上游 create_transaction） */
export async function createTransaction(
  c: McpContext,
  args: {
    amount: number;
    tx_type?: string;
    category?: string | null;
    account?: string | null;
    happened_at?: string | null;
    note?: string | null;
    tags?: string[] | null;
    ledger_id?: string | null;
    currency?: string | null;
    time_zone?: string | null;
    attachments?: string[] | null;
    category_id?: string | null;
    account_id?: string | null;
    from_account_id?: string | null;
    to_account_id?: string | null;
    from_account?: string | null;
    to_account?: string | null;
    native_amount?: number | null;
    exclude_from_stats?: boolean;
    exclude_from_budget?: boolean;
    idempotency_key?: string | null;
  },
): Promise<Record<string, unknown>> {
  const { amount, tx_type, category, account, happened_at, note, tags, ledger_id, currency,
    time_zone, attachments, category_id, account_id, from_account_id, to_account_id,
    from_account, to_account, native_amount, exclude_from_stats, exclude_from_budget, idempotency_key } = args;
  return createMany(c, {
    transactions: [{
      amount, tx_type: tx_type ?? 'expense', category, account, happened_at, note, tags,
      currency, attachments, category_id, account_id, from_account_id, to_account_id,
      from_account, to_account, native_amount,
      // 对齐上游 create_transaction：创建时排除标记默认 False（更新才是三态 None）
      exclude_from_stats: exclude_from_stats ?? false,
      exclude_from_budget: exclude_from_budget ?? false,
    }],
    ledger_id,
    time_zone,
    idempotency_key,
    single: true,
  });
}

/** 批量创建（对齐上游 create_transactions） */
export async function createTransactions(
  c: McpContext,
  args: {
    transactions: Array<Record<string, unknown>>;
    ledger_id?: string | null;
    time_zone?: string | null;
    idempotency_key?: string | null;
  },
): Promise<Record<string, unknown>> {
  return createMany(c, {
    transactions: args.transactions,
    ledger_id: args.ledger_id,
    time_zone: args.time_zone,
    idempotency_key: args.idempotency_key,
    single: false,
  });
}

/** 更新单笔（对齐上游 update_transaction，支持 expected_revision） */
export async function updateTransaction(
  c: McpContext,
  args: {
    sync_id: string;
    amount?: number | null;
    tx_type?: string | null;
    category?: string | null;
    account?: string | null;
    happened_at?: string | null;
    note?: string | null;
    tags?: string[] | null;
    time_zone?: string | null;
    attachments?: string[] | null;
    ledger_id?: string | null;
    category_id?: string | null;
    account_id?: string | null;
    from_account_id?: string | null;
    to_account_id?: string | null;
    from_account?: string | null;
    to_account?: string | null;
    currency?: string | null;
    native_amount?: number | null;
    exclude_from_stats?: boolean | null;
    exclude_from_budget?: boolean | null;
    expected_revision?: number | null;
  },
): Promise<Record<string, unknown>> {
  return updateOne(c, { ...args });
}

/** 删除单笔（对齐上游 delete_transaction：confirm 两步） */
export async function deleteTransaction(
  c: McpContext,
  args: { sync_id: string; confirm?: boolean; ledger_id?: string | null; expected_revision?: number | null },
): Promise<Record<string, unknown>> {
  if (!args.confirm) {
    return {
      status: 'confirmation_required', sync_id: args.sync_id,
      message: 'Confirm deletion with the user, then call with confirm=true',
    };
  }
  const { db, userId } = c;
  const { transactionRow } = await import('../transaction-service');
  const [, ledger] = await transactionRow(db, userId, args.sync_id, args.ledger_id);
  const body: Record<string, unknown> = { base_change_id: 0 };
  if (args.expected_revision !== undefined && args.expected_revision !== null) body.expected_revision = args.expected_revision;
  await selfCallAdapter(c)('DELETE', `/api/v1/write/ledgers/${ledger.external_id}/transactions/${args.sync_id}`, userId, body, {});
  return { status: 'deleted', sync_id: args.sync_id, ledger_id: ledger.external_id };
}

/** 创建分类（对齐上游 create_category） */
export async function createCategory(
  c: McpContext,
  args: { name: string; kind?: string; parent_name?: string | null; icon?: string | null; ledger_id?: string | null },
): Promise<Record<string, unknown>> {
  const { db, userId } = c;
  const kind = args.kind ?? 'expense';
  if (!['expense', 'income', 'transfer'].includes(kind)) throw new Error(`Invalid kind: ${kind}`);
  const { resolveWriteLedger } = await import('../transaction-service');
  const { ledger, status } = await resolveWriteLedger(c, args.ledger_id);
  if (status) return status;
  if (!ledger) return { status: 'no_ledger', message: 'You have no ledger yet.' };
  const body: Record<string, unknown> = { base_change_id: 0, name: args.name, kind };
  if (args.parent_name) body.parent_name = args.parent_name;
  if (args.icon) body.icon = args.icon;
  const result = await selfCallAdapter(c)('POST', `/api/v1/write/ledgers/${ledger.external_id}/categories`, userId, body, {});
  return { status: 'created', category_id: (result as Record<string, unknown>).entity_id ?? null };
}

/** 更新预算（对齐上游 update_budget） */
export async function updateBudget(
  c: McpContext,
  args: { budget_id: string; amount: number; ledger_id?: string | null },
): Promise<Record<string, unknown>> {
  const { db, userId } = c;
  const { resolveWriteLedger } = await import('../transaction-service');
  const { ledger, status } = await resolveWriteLedger(c, args.ledger_id);
  if (status) return status;
  if (!ledger) return { status: 'no_ledger', message: 'You have no ledger yet.' };
  const result = await selfCallAdapter(c)(
    'PATCH', `/api/v1/write/ledgers/${ledger.external_id}/budgets/${args.budget_id}`,
    userId, { base_change_id: 0, amount: args.amount }, {},
  );
  return { status: 'updated', budget_id: args.budget_id, _meta: result };
}
