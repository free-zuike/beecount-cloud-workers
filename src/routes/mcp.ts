/**
 * MCP Server 路由模块 - 实现 Model Protocol 工具端点
 *
 * 参考原版 BeeCount-Cloud (Python/FastAPI) 的 MCP 端点：
 * - POST /mcp/tools/call - 调用 MCP 工具
 * - GET  /mcp/tools      - 列出可用工具
 *
 * 功能说明：
 * - 使用 PAT (Personal Access Token) 认证而非 JWT
 * - 支持的工具：list_ledgers, list_transactions, create_transaction,
 *   get_summary, list_categories, list_accounts
 * - 每个工具从现有路由逻辑复用核心数据库查询
 *
 * @module routes/mcp
 */

import { Hono } from 'hono';
import { randomUUID } from 'crypto';

// ===========================
// 辅助函数
// ===========================

function nowUtc(): string {
  return new Date().toISOString();
}

async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ===========================
// PAT 认证中间件
// ===========================

async function patAuthMiddleware(c: { req: any; env: { DB: D1Database }; json: any; set: any; get: any }, next: any): Promise<Response | void> {
  const authHeader = c.req.header('Authorization');
  if (!authHeader) {
    return c.json({ error: 'Authorization header required' }, 401);
  }

  let token: string;
  if (authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else {
    return c.json({ error: 'Invalid authorization format. Use: Bearer <pat_token>' }, 401);
  }

  if (!token.startsWith('bcmcp_')) {
    return c.json({ error: 'Invalid PAT token format' }, 401);
  }

  const db = c.env.DB;
  const tokenHash = await hashToken(token);

  const pat = await db
    .prepare(
      `SELECT id, user_id, name, prefix, scopes_json, expires_at
       FROM personal_access_tokens
       WHERE token_hash = ? AND revoked_at IS NULL`
    )
    .bind(tokenHash)
    .first<{
      id: string;
      user_id: string;
      name: string;
      prefix: string;
      scopes_json: string;
      expires_at: string | null;
    }>();

  if (!pat) {
    return c.json({ error: 'Invalid or revoked PAT token' }, 401);
  }

  if (pat.expires_at && new Date(pat.expires_at) < new Date()) {
    return c.json({ error: 'PAT token has expired' }, 401);
  }

  const scopes = JSON.parse(pat.scopes_json || '[]');
  c.set('userId', pat.user_id);
  c.set('patId', pat.id);
  c.set('patPrefix', pat.prefix);
  c.set('patName', pat.name);
  c.set('patScopes', scopes);

  await next();
}

// ===========================
// 工具定义
// ===========================

interface McpTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

const MCP_TOOLS: McpTool[] = [
  {
    name: 'list_ledgers',
    description: '列出用户的所有账本',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'list_transactions',
    description: '查询交易记录（支持按账本、类型、时间范围筛选）',
    input_schema: {
      type: 'object',
      properties: {
        ledger_id: { type: 'string', description: '账本外部 ID（可选，默认使用第一个账本）' },
        tx_type: { type: 'string', enum: ['expense', 'income', 'transfer'], description: '交易类型过滤' },
        start_at: { type: 'string', description: '开始时间（ISO 格式）' },
        end_at: { type: 'string', description: '结束时间（ISO 格式）' },
        limit: { type: 'number', description: '返回条数（默认 20，最大 200）' },
        offset: { type: 'number', description: '偏移量（默认 0）' },
      },
      required: [],
    },
  },
  {
    name: 'create_transaction',
    description: '创建一笔新交易',
    input_schema: {
      type: 'object',
      properties: {
        ledger_id: { type: 'string', description: '账本外部 ID（可选，默认使用第一个账本）' },
        tx_type: { type: 'string', enum: ['expense', 'income', 'transfer'], description: '交易类型' },
        amount: { type: 'number', description: '金额' },
        happened_at: { type: 'string', description: '交易时间（ISO 格式）' },
        note: { type: 'string', description: '备注' },
        category_name: { type: 'string', description: '分类名称' },
        account_name: { type: 'string', description: '账户名称' },
      },
      required: ['tx_type', 'amount', 'happened_at'],
    },
  },
  {
    name: 'get_summary',
    description: '获取指定账本的汇总统计（交易数、收入、支出、余额）',
    input_schema: {
      type: 'object',
      properties: {
        ledger_id: { type: 'string', description: '账本外部 ID（必填）' },
      },
      required: ['ledger_id'],
    },
  },
  {
    name: 'list_categories',
    description: '列出所有分类',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'list_accounts',
    description: '列出所有账户',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];

// ===========================
// 工具处理函数
// ===========================

async function handleListLedgers(db: D1Database, userId: string): Promise<unknown> {
  const ledgers = await db
    .prepare(
      `SELECT l.id, l.external_id, l.name, l.currency, l.created_at
       FROM ledgers l
       WHERE l.user_id = ?
       ORDER BY l.created_at DESC`
    )
    .bind(userId)
    .all<{
      id: string;
      external_id: string;
      name: string | null;
      currency: string;
      created_at: string;
    }>();

  const result = [];
  for (const ledger of ledgers.results) {
    const tombstone = await db
      .prepare(
        `SELECT action FROM sync_changes
         WHERE ledger_id = ? AND entity_type = 'ledger_snapshot' AND action = 'delete'
         ORDER BY change_id DESC LIMIT 1`
      )
      .bind(ledger.id)
      .first<{ action: string }>();

    if (tombstone?.action === 'delete') continue;

    const totals = await db
      .prepare(
        `SELECT
           COUNT(*) as tx_count,
           COALESCE(SUM(CASE WHEN tx_type = 'income' THEN COALESCE(native_amount, amount) ELSE 0 END), 0) as income_total,
           COALESCE(SUM(CASE WHEN tx_type = 'expense' THEN COALESCE(native_amount, amount) ELSE 0 END), 0) as expense_total
         FROM read_tx_projection
         WHERE ledger_id = ?
         AND (exclude_from_stats IS NULL OR exclude_from_stats = 0 OR exclude_from_stats = false)`
      )
      .bind(ledger.id)
      .first<{
        tx_count: number;
        income_total: number;
        expense_total: number;
      }>();

    result.push({
      ledger_id: ledger.external_id,
      ledger_name: ledger.name ?? ledger.external_id,
      currency: ledger.currency || 'CNY',
      transaction_count: totals?.tx_count ?? 0,
      income_total: totals?.income_total ?? 0,
      expense_total: totals?.expense_total ?? 0,
      balance: (totals?.income_total ?? 0) - (totals?.expense_total ?? 0),
    });
  }

  return result;
}

async function handleListTransactions(
  db: D1Database,
  userId: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const ledgerId = args.ledger_id as string | undefined;
  const txType = args.tx_type as string | undefined;
  const startAt = args.start_at as string | undefined;
  const endAt = args.end_at as string | undefined;
  const limit = Math.min(Number(args.limit) || 20, 200);
  const offset = Number(args.offset) || 0;

  let ledger;
  if (ledgerId) {
    ledger = await db
      .prepare('SELECT id, external_id FROM ledgers WHERE user_id = ? AND external_id = ?')
      .bind(userId, ledgerId)
      .first<{ id: string; external_id: string }>();
  } else {
    ledger = await db
      .prepare('SELECT id, external_id FROM ledgers WHERE user_id = ?')
      .bind(userId)
      .first<{ id: string; external_id: string }>();
  }

  if (!ledger) {
    return { error: 'No ledger found' };
  }

  let query = 'SELECT * FROM read_tx_projection WHERE ledger_id = ?';
  const bindings: (string | number)[] = [ledger.id];

  if (txType) {
    query += ' AND tx_type = ?';
    bindings.push(txType);
  }
  if (startAt) {
    query += ' AND happened_at >= ?';
    bindings.push(startAt);
  }
  if (endAt) {
    query += ' AND happened_at < ?';
    bindings.push(endAt);
  }

  query += ' ORDER BY happened_at DESC, tx_index DESC LIMIT ? OFFSET ?';
  bindings.push(limit, offset);

  const rows = await db.prepare(query).bind(...bindings).all<Record<string, unknown>>();

  const items = rows.results.map((row) => ({
    id: row.sync_id as string,
    tx_type: row.tx_type as string,
    amount: row.amount as number,
    happened_at: row.happened_at as string,
    note: row.note as string | null,
    category_name: row.category_name as string | null,
    account_name: row.account_name as string | null,
    tags: row.tags_csv as string | null,
  }));

  return {
    ledger_id: ledger.external_id,
    items,
    count: items.length,
  };
}

async function handleCreateTransaction(
  db: D1Database,
  userId: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const txType = args.tx_type as string;
  const amount = Number(args.amount);
  const happenedAt = args.happened_at as string;
  const note = (args.note as string) ?? null;
  const categoryName = (args.category_name as string) ?? null;
  const accountName = (args.account_name as string) ?? null;
  const ledgerExternalId = (args.ledger_id as string) ?? null;

  if (!txType || isNaN(amount) || !happenedAt) {
    return { error: 'tx_type, amount, and happened_at are required' };
  }

  let ledger;
  if (ledgerExternalId) {
    ledger = await db
      .prepare('SELECT id, external_id FROM ledgers WHERE user_id = ? AND external_id = ?')
      .bind(userId, ledgerExternalId)
      .first<{ id: string; external_id: string }>();
  } else {
    ledger = await db
      .prepare('SELECT id, external_id FROM ledgers WHERE user_id = ?')
      .bind(userId)
      .first<{ id: string; external_id: string }>();
  }

  if (!ledger) {
    return { error: 'No ledger found' };
  }

  const syncId = randomUUID();
  const serverNow = nowUtc();

  const payload: Record<string, unknown> = {
    tx_type: txType,
    amount,
    happened_at: happenedAt,
    note,
    category_name: categoryName,
    account_name: accountName,
    category_kind: txType,
  };

  const changeResult = await db
    .prepare(
      `INSERT INTO sync_changes
       (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(userId, ledger.id, 'transaction', syncId, 'upsert', JSON.stringify(payload), serverNow, userId)
    .run();

  const newChangeId = changeResult.meta.last_row_id as number;

  await db
    .prepare(
      `INSERT INTO read_tx_projection
       (ledger_id, sync_id, user_id, tx_type, amount, happened_at, note,
        category_sync_id, category_name, category_kind,
        account_sync_id, account_name,
        from_account_sync_id, from_account_name,
        to_account_sync_id, to_account_name,
        tags_csv, tag_sync_ids_json, attachments_json, tx_index, source_change_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      ledger.id, syncId, userId, txType, amount, happenedAt, note,
      null, categoryName, txType,
      null, accountName,
      null, null,
      null, null,
      null, null, null, 0, newChangeId,
    )
    .run();

  await db
    .prepare(
      `INSERT INTO mcp_call_logs (user_id, pat_id, pat_prefix, pat_name, tool_name, status, args_summary, duration_ms, called_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(userId, null, null, null, 'create_transaction', 'success', JSON.stringify({ tx_type: txType, amount }), 0, serverNow)
    .run();

  return {
    transaction_id: syncId,
    ledger_id: ledger.external_id,
    tx_type: txType,
    amount,
    happened_at: happenedAt,
    note,
    created_at: serverNow,
  };
}

async function handleGetSummary(
  db: D1Database,
  userId: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const ledgerExternalId = args.ledger_id as string;
  if (!ledgerExternalId) {
    return { error: 'ledger_id is required' };
  }

  const ledger = await db
    .prepare('SELECT id, external_id, name FROM ledgers WHERE user_id = ? AND external_id = ?')
    .bind(userId, ledgerExternalId)
    .first<{ id: string; external_id: string; name: string | null }>();

  if (!ledger) {
    return { error: 'Ledger not found' };
  }

  const stats = await db
    .prepare(
      `SELECT
         COUNT(*) as tx_count,
         COALESCE(SUM(CASE WHEN tx_type = 'income' THEN COALESCE(native_amount, amount) ELSE 0 END), 0) as income_total,
         COALESCE(SUM(CASE WHEN tx_type = 'expense' THEN COALESCE(native_amount, amount) ELSE 0 END), 0) as expense_total,
         MIN(happened_at) as first_tx_at,
         MAX(happened_at) as last_tx_at
       FROM read_tx_projection
       WHERE ledger_id = ?
       AND (exclude_from_stats IS NULL OR exclude_from_stats = 0 OR exclude_from_stats = false)`
    )
    .bind(ledger.id)
    .first<{
      tx_count: number;
      income_total: number;
      expense_total: number;
      first_tx_at: string | null;
      last_tx_at: string | null;
    }>();

  return {
    ledger_id: ledger.external_id,
    ledger_name: ledger.name,
    tx_count: stats?.tx_count ?? 0,
    income_total: stats?.income_total ?? 0,
    expense_total: stats?.expense_total ?? 0,
    balance: (stats?.income_total ?? 0) - (stats?.expense_total ?? 0),
    first_tx_at: stats?.first_tx_at ?? null,
    last_tx_at: stats?.last_tx_at ?? null,
  };
}

async function handleListCategories(db: D1Database, userId: string): Promise<unknown> {
  const rows = await db
    .prepare(
      `SELECT DISTINCT r.sync_id, r.name, r.kind, r.level, r.sort_order,
              r.icon, r.icon_type, r.parent_name
       FROM read_category_projection r
       WHERE r.user_id = ?
       ORDER BY r.kind, r.sort_order, LOWER(r.name)`
    )
    .bind(userId)
    .all<Record<string, unknown>>();

  return rows.results.map((row) => ({
    id: row.sync_id as string,
    name: (row.name as string) ?? '',
    kind: (row.kind as string) ?? '',
    level: row.level as number | null,
    sort_order: row.sort_order as number | null,
    icon: row.icon as string | null,
    parent_name: row.parent_name as string | null,
  }));
}

async function handleListAccounts(db: D1Database, userId: string): Promise<unknown> {
  const rows = await db
    .prepare(
      `SELECT DISTINCT r.sync_id, r.name, r.account_type, r.currency, r.initial_balance,
              r.note, r.bank_name, r.card_last_four
       FROM read_account_projection r
       WHERE r.user_id = ?
       ORDER BY LOWER(r.name) ASC`
    )
    .bind(userId)
    .all<Record<string, unknown>>();

  return rows.results.map((row) => ({
    id: row.sync_id as string,
    name: (row.name as string) ?? '',
    account_type: row.account_type as string | null,
    currency: row.currency as string | null,
    initial_balance: row.initial_balance as number | null,
    note: row.note as string | null,
    bank_name: row.bank_name as string | null,
    card_last_four: row.card_last_four as string | null,
  }));
}

// ===========================
// 路由定义
// ===========================

type Bindings = {
  DB: D1Database;
  JWT_SECRET: string;
};

type Variables = {
  userId: string;
  patId: string;
  patPrefix: string;
  patName: string;
  patScopes: string[];
};

const mcpRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

mcpRouter.use('/*', patAuthMiddleware);

/**
 * GET /mcp/tools - 列出可用工具
 */
mcpRouter.get('/tools', (c) => {
  return c.json({
    tools: MCP_TOOLS,
  });
});

/**
 * POST /mcp/tools/call - 调用 MCP 工具
 */
mcpRouter.post('/tools/call', async (c) => {
  const userId = c.get('userId');
  const patId = c.get('patId');
  const patPrefix = c.get('patPrefix');
  const patName = c.get('patName');
  const db = c.env.DB;
  const startTime = Date.now();

  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const toolName = body.name as string;
  const toolArgs = (body.arguments as Record<string, unknown>) || {};

  if (!toolName) {
    return c.json({ error: 'Tool name is required' }, 400);
  }

  const tool = MCP_TOOLS.find((t) => t.name === toolName);
  if (!tool) {
    return c.json({ error: `Unknown tool: ${toolName}` }, 400);
  }

  try {
    let result: unknown;

    switch (toolName) {
      case 'list_ledgers':
        result = await handleListLedgers(db, userId);
        break;
      case 'list_transactions':
        result = await handleListTransactions(db, userId, toolArgs);
        break;
      case 'create_transaction':
        result = await handleCreateTransaction(db, userId, toolArgs);
        break;
      case 'get_summary':
        result = await handleGetSummary(db, userId, toolArgs);
        break;
      case 'list_categories':
        result = await handleListCategories(db, userId);
        break;
      case 'list_accounts':
        result = await handleListAccounts(db, userId);
        break;
      default:
        return c.json({ error: `Tool not implemented: ${toolName}` }, 500);
    }

    const durationMs = Date.now() - startTime;

    // Log the call
    try {
      await db
        .prepare(
          `INSERT INTO mcp_call_logs (user_id, pat_id, pat_prefix, pat_name, tool_name, status, args_summary, duration_ms, called_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          userId, patId, patPrefix, patName, toolName, 'success',
          JSON.stringify(toolArgs).slice(0, 500), durationMs, nowUtc(),
        )
        .run();
    } catch (logErr) {
      console.error('[MCP] Failed to log call:', logErr);
    }

    return c.json({
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    });
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';

    try {
      await db
        .prepare(
          `INSERT INTO mcp_call_logs (user_id, pat_id, pat_prefix, pat_name, tool_name, status, error_message, args_summary, duration_ms, called_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          userId, patId, patPrefix, patName, toolName, 'error', errorMsg.slice(0, 500),
          JSON.stringify(toolArgs).slice(0, 500), durationMs, nowUtc(),
        )
        .run();
    } catch (logErr) {
      console.error('[MCP] Failed to log error call:', logErr);
    }

    return c.json({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ error: errorMsg }),
        },
      ],
      isError: true,
    });
  }
});

export default mcpRouter;
