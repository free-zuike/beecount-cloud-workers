/** MCP 模块共用类型 */

/** MCP 工具调用上下文（由 server 层组装；user 身份绝不来自工具参数） */
export interface McpContext {
  db: D1Database;
  userId: string;
  jwtSecret: string;
  baseUrl: string;
  scopes?: string[];
  /** Cloud 配置时区（上游 settings.scheduler_timezone / cloud_timezone，对应 CLOUD_TIMEZONE/TZ） */
  configuredTimeZone?: string | null;
}

export interface LedgerInfo {
  id: string;
  user_id: string;
  external_id: string;
  name: string | null;
  currency: string | null;
  month_start_day?: number | null;
  created_at?: string | null;
}

export interface TxRow {
  ledger_id: string;
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
  attachments_json: string | null;
  tx_index: number | null;
  created_by_user_id: string | null;
  last_edited_by_user_id: string | null;
  source_change_id: number | null;
  currency_code: string | null;
  native_amount: number | null;
  exclude_from_stats: number | null;
  exclude_from_budget: number | null;
}

/** 通用错误结构（给 LLM 看） */
export class McpToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValueError';
  }
}
