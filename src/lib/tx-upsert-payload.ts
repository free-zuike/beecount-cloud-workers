/**
 * 从 read_tx_projection 行构造「完整交易 upsert payload」。
 *
 * 设备端对增量变更做覆盖式应用：payload 缺字段会被清成默认值（0 元/空日期），
 * 因此任何写 sync_changes 的服务端流程（write 路由、B5 附件收敛、同步自愈）
 * 都必须携带完整字段。本模块是唯一构造点，避免多处漂移（#B5 补偿事故教训）。
 */

/** read_tx_projection 行的最小字段集（payload 构造所需） */
export interface TxProjectionRow {
  sync_id: string;
  user_id: string;
  tx_type: string;
  amount: number;
  happened_at: string;
  note: string | null;
  category_sync_id: string | null;
  category_name: string | null;
  category_kind: string | null;
  account_sync_id: string | null;
  account_name: string | null;
  from_account_sync_id: string | null;
  from_account_name: string | null;
  to_account_sync_id: string | null;
  to_account_name: string | null;
  tags_csv: string | null;
  tag_sync_ids_json: string | null;
  attachments_json: string;
  created_by_user_id: string | null;
  last_edited_by_user_id: string | null;
  exclude_from_stats: number | null;
  exclude_from_budget: number | null;
  currency_code: string | null;
  native_amount: number | null;
}

/** 查询 read_tx_projection 完整 payload 字段的 SELECT 片段（cleaner / sync 共用） */
export const TX_PROJECTION_COLS = `sync_id, user_id, tx_type, amount, happened_at, note,
  category_sync_id, category_name, category_kind,
  account_sync_id, account_name,
  from_account_sync_id, from_account_name,
  to_account_sync_id, to_account_name,
  tags_csv, tag_sync_ids_json, attachments_json,
  created_by_user_id, last_edited_by_user_id,
  exclude_from_stats, exclude_from_budget, currency_code, native_amount`;

/** 将投影行转为完整 upsert payload（序列化字符串）。
 * 字段集合与 write 路由创建交易的 payload 完全一致（契约：tests/tx-upsert-payload.test.ts
 * 锁定「write 路由 23 键 ⇔ 本构造函数 23 键」双向一致，防止再次漂移）。 */
export function buildTxUpsertPayload(
  tx: TxProjectionRow,
): string {
  let tagIds: string[] | null = null;
  if (tx.tag_sync_ids_json) {
    try {
      const parsed = JSON.parse(tx.tag_sync_ids_json);
      if (Array.isArray(parsed)) tagIds = parsed as string[];
    } catch {
      tagIds = null;
    }
  }
  let attachments: unknown;
  try {
    attachments = tx.attachments_json ? JSON.parse(tx.attachments_json) : [];
  } catch {
    attachments = [];
  }
  const payload = {
    syncId: tx.sync_id,
    type: tx.tx_type,
    amount: tx.amount,
    happenedAt: tx.happened_at,
    note: tx.note,
    excludeFromStats: Boolean(tx.exclude_from_stats),
    excludeFromBudget: Boolean(tx.exclude_from_budget),
    // 与 write 路由一致：无值时为 null，不做默认兜底
    currencyCode: tx.currency_code ?? null,
    nativeAmount: tx.native_amount ?? null,
    categoryName: tx.category_name,
    categoryKind: tx.category_kind,
    categoryId: tx.category_sync_id,
    accountName: tx.account_name,
    accountId: tx.account_sync_id,
    fromAccountName: tx.from_account_name,
    fromAccountId: tx.from_account_sync_id,
    toAccountName: tx.to_account_name,
    toAccountId: tx.to_account_sync_id,
    tags: tx.tags_csv,
    tagIds,
    attachments,
    updatedByUserId: tx.last_edited_by_user_id ?? tx.user_id,
    createdByUserId: tx.created_by_user_id ?? tx.user_id,
  };
  return JSON.stringify(payload);
}