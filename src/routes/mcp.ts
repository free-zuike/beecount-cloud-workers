/**
 * MCP Server 路由模块 - 使用 @modelcontextprotocol/sdk 实现完整 MCP 协议
 *
 * 参考原版 BeeCount-Cloud (Python/FastAPI) 的 FastMCP 实现：
 * - GET  /mcp/sse - SSE 端点（Streamable HTTP）
 * - POST /mcp/messages/ - 消息端点
 *
 * 工具列表：
 * - list_ledgers, list_transactions, create_transaction,
 *   get_summary, list_categories, list_accounts
 */

import { Hono } from 'hono';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { serverLogger } from '../lib/logger';
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
  return Array.from(hashArray).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ===========================
// 工具实现
// ===========================

async function handleListLedgers(db: D1Database, userId: string) {
  const ledgers = await db.prepare(
    `SELECT l.id, l.external_id, l.name, l.currency, l.created_at
     FROM ledgers l
     LEFT JOIN ledger_members lm ON l.id = lm.ledger_id
     WHERE (l.user_id = ? OR lm.user_id = ?)`
  ).bind(userId, userId).all<{ id: string; external_id: string; name: string | null; currency: string; created_at: string }>();

  return {
    content: [{
      type: 'text',
      text: JSON.stringify(ledgers.results.map(l => ({
        id: l.external_id,
        name: l.name || l.external_id,
        currency: l.currency,
        created_at: l.created_at,
      }))),
    }],
  };
}

async function handleListTransactions(db: D1Database, userId: string, args: Record<string, unknown>) {
  const limit = Math.min((args.limit as number) || 20, 200);
  const offset = (args.offset as number) || 0;
  let query = `SELECT * FROM read_tx_projection WHERE user_id = ?`;
  const params: unknown[] = [userId];

  if (args.ledger_id) {
    query += ` AND ledger_id = (SELECT id FROM ledgers WHERE external_id = ?)`;
    params.push(args.ledger_id);
  }
  if (args.tx_type) {
    query += ` AND tx_type = ?`;
    params.push(args.tx_type);
  }
  if (args.start_at) {
    query += ` AND happened_at >= ?`;
    params.push(args.start_at);
  }
  if (args.end_at) {
    query += ` AND happened_at <= ?`;
    params.push(args.end_at);
  }
  query += ` ORDER BY happened_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const rows = await db.prepare(query).bind(...params).all();
  return {
    content: [{ type: 'text', text: JSON.stringify(rows.results) }],
  };
}

async function handleCreateTransaction(db: D1Database, userId: string, args: Record<string, unknown>) {
  const ledgerId = args.ledger_id as string || null;
  let ledgerRow: { id: string } | null = null;
  if (ledgerId) {
    ledgerRow = await db.prepare(
      `SELECT l.id FROM ledgers l LEFT JOIN ledger_members lm ON l.id = lm.ledger_id
       WHERE (l.user_id = ? OR lm.user_id = ?) AND l.external_id = ?`
    ).bind(userId, userId, ledgerId).first<{ id: string }>();
  } else {
    ledgerRow = await db.prepare(
      `SELECT l.id FROM ledgers l LEFT JOIN ledger_members lm ON l.id = lm.ledger_id
       WHERE (l.user_id = ? OR lm.user_id = ?) ORDER BY l.created_at ASC LIMIT 1`
    ).bind(userId, userId).first<{ id: string }>();
  }
  if (!ledgerRow) return { content: [{ type: 'text', text: JSON.stringify({ error: 'No ledger found' }) }], isError: true };

  const syncId = randomUUID();
  const changeId = randomUUID();
  await db.prepare(
    `INSERT INTO sync_changes (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id, scope)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ledger')`
  ).bind(userId, ledgerRow.id, 'transaction', syncId, 'upsert', JSON.stringify({
    syncId, tx_type: args.tx_type, amount: args.amount, happened_at: args.happened_at,
    note: args.note || null, categoryName: args.category_name || null, accountName: args.account_name || null,
  }), nowUtc(), userId).run();

  return { content: [{ type: 'text', text: JSON.stringify({ success: true, sync_id: syncId }) }] };
}

async function handleGetSummary(db: D1Database, userId: string, args: Record<string, unknown>) {
  const ledgerId = args.ledger_id as string;
  if (!ledgerId) return { content: [{ type: 'text', text: JSON.stringify({ error: 'ledger_id required' }) }], isError: true };

  const ledger = await db.prepare(
    `SELECT l.id, l.external_id, l.name FROM ledgers l
     LEFT JOIN ledger_members lm ON l.id = lm.ledger_id
     WHERE (l.user_id = ? OR lm.user_id = ?) AND l.external_id = ?`
  ).bind(userId, userId, ledgerId).first<{ id: string; external_id: string; name: string | null }>();
  if (!ledger) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Ledger not found' }) }], isError: true };

  const stats = await db.prepare(
    `SELECT COUNT(*) as tx_count, SUM(CASE WHEN tx_type='income' THEN amount ELSE 0 END) as income,
            SUM(CASE WHEN tx_type='expense' THEN amount ELSE 0 END) as expense
     FROM read_tx_projection WHERE ledger_id = ?`
  ).bind(ledger.id).first<{ tx_count: number; income: number; expense: number }>();

  return {
    content: [{ type: 'text', text: JSON.stringify({
      ledger: ledger.name || ledger.external_id,
      transactions: stats?.tx_count || 0,
      income: stats?.income || 0,
      expense: stats?.expense || 0,
    }) }],
  };
}

async function handleListCategories(db: D1Database, userId: string) {
  const rows = await db.prepare(
    'SELECT sync_id, name, kind, level, icon FROM read_category_projection WHERE user_id = ? ORDER BY sort_order ASC'
  ).bind(userId).all();
  return { content: [{ type: 'text', text: JSON.stringify(rows.results) }] };
}

async function handleListAccounts(db: D1Database, userId: string) {
  const rows = await db.prepare(
    'SELECT sync_id, name, account_type, currency, initial_balance, note FROM read_account_projection WHERE user_id = ?'
  ).bind(userId).all();
  return { content: [{ type: 'text', text: JSON.stringify(rows.results) }] };
}

// ===========================
// 工具定义
// ===========================

const TOOL_HANDLERS: Record<string, (db: D1Database, userId: string, args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>> = {
  list_ledgers: (db, userId) => handleListLedgers(db, userId),
  list_transactions: (db, userId, args) => handleListTransactions(db, userId, args),
  create_transaction: (db, userId, args) => handleCreateTransaction(db, userId, args),
  get_summary: (db, userId, args) => handleGetSummary(db, userId, args),
  list_categories: (db, userId) => handleListCategories(db, userId),
  list_accounts: (db, userId) => handleListAccounts(db, userId),
};

// ===========================
// 创建 MCP Server
// ===========================

function createMcpServer(db: D1Database, userId: string, patId: string, patPrefix: string, patName: string): Server {
  const server = new Server(
    { name: 'beecount-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: 'list_ledgers', description: '列出用户的所有账本', inputSchema: { type: 'object', properties: {} } },
      { name: 'list_transactions', description: '查询交易记录', inputSchema: { type: 'object', properties: { ledger_id: { type: 'string' }, tx_type: { type: 'string', enum: ['expense', 'income', 'transfer'] }, start_at: { type: 'string' }, end_at: { type: 'string' }, limit: { type: 'number' }, offset: { type: 'number' } } } },
      { name: 'create_transaction', description: '创建一笔新交易', inputSchema: { type: 'object', properties: { ledger_id: { type: 'string' }, tx_type: { type: 'string', enum: ['expense', 'income', 'transfer'] }, amount: { type: 'number' }, happened_at: { type: 'string' }, note: { type: 'string' }, category_name: { type: 'string' }, account_name: { type: 'string' } }, required: ['tx_type', 'amount', 'happened_at'] } },
      { name: 'get_summary', description: '获取指定账本的汇总统计', inputSchema: { type: 'object', properties: { ledger_id: { type: 'string' } }, required: ['ledger_id'] } },
      { name: 'list_categories', description: '列出所有分类', inputSchema: { type: 'object', properties: {} } },
      { name: 'list_accounts', description: '列出所有账户', inputSchema: { type: 'object', properties: {} } },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const startTime = Date.now();
    try {
      const handler = TOOL_HANDLERS[name];
      if (!handler) {
        serverLogger.warn('src.routers.mcp', `[MCP] Unknown tool: ${name}`);
        return { content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${name}` }) }], isError: true };
      }
      const result = await handler(db, userId, args || {});
      const duration = Date.now() - startTime;
      db.prepare(
        `INSERT INTO mcp_call_logs (user_id, pat_id, pat_prefix, pat_name, tool_name, status, args_summary, duration_ms, called_at)
         VALUES (?, ?, ?, ?, ?, 'success', ?, ?, ?)`
      ).bind(userId, patId, patPrefix, patName, name, JSON.stringify(Object.keys(args || {})), duration, nowUtc()).run().catch(() => {});
      return result;
    } catch (err) {
      const duration = Date.now() - startTime;
      db.prepare(
        `INSERT INTO mcp_call_logs (user_id, pat_id, pat_prefix, pat_name, tool_name, status, error_message, args_summary, duration_ms, called_at)
         VALUES (?, ?, ?, ?, ?, 'error', ?, ?, ?, ?)`
      ).bind(userId, patId, patPrefix, patName, name, (err as Error).message, JSON.stringify(Object.keys(args || {})), duration, nowUtc()).run().catch(() => {});
      return { content: [{ type: 'text', text: JSON.stringify({ error: (err as Error).message }) }], isError: true };
    }
  });

  return server;
}

// ===========================
// Hono 路由
// ===========================

const mcpRouter = new Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string; patId: string; patPrefix: string; patName: string } }>();

// PAT 认证中间件
mcpRouter.use('/*', async (c, next) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader) return c.json({ error: 'Authorization header required' }, 401);
  let token: string;
  if (authHeader.startsWith('Bearer ')) token = authHeader.slice(7);
  else return c.json({ error: 'Invalid authorization format' }, 401);
  if (!token.startsWith('bcmcp_')) return c.json({ error: 'Invalid PAT token format' }, 401);

  const tokenHash = await hashToken(token);
  const db = c.env.DB;
  const pat = await db.prepare(
    `SELECT id, user_id, name, scopes, expires_at FROM personal_access_tokens WHERE token_hash = ? AND revoked_at IS NULL`
  ).bind(tokenHash).first<{ id: string; user_id: string; name: string; scopes: string; expires_at: string | null }>();
  if (!pat) return c.json({ error: 'Invalid PAT token' }, 401);
  if (pat.expires_at && pat.expires_at < nowUtc()) return c.json({ error: 'PAT token expired' }, 401);

  c.set('userId', pat.user_id);
  c.set('patId', pat.id);
  c.set('patPrefix', token.substring(0, 14));
  c.set('patName', pat.name);
  await next();
});

// Streamable HTTP 端点
mcpRouter.all('/', async (c) => {
  const db = c.env.DB;
  const userId = c.get('userId');
  const patId = c.get('patId');
  const patPrefix = c.get('patPrefix');
  const patName = c.get('patName');

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless mode
    enableJsonResponse: true,
  });
  const server = createMcpServer(db, userId, patId, patPrefix, patName);

  try {
    await server.connect(transport);
    const response = await transport.handleRequest(c.req.raw);
    return response;
  } catch (err) {
    serverLogger.error('src.routers.mcp', `[MCP] Streamable HTTP error: ${(err as Error).message}`);
    return c.json({ error: 'MCP protocol error' }, 500);
  }
});

// 保留旧 REST API 端点（向后兼容）
mcpRouter.get('/tools', (c) => {
  const toolList = [
    { name: 'list_ledgers', description: '列出用户的所有账本', input_schema: { type: 'object', properties: {} } },
    { name: 'list_transactions', description: '查询交易记录', input_schema: { type: 'object', properties: { ledger_id: { type: 'string' }, tx_type: { type: 'string', enum: ['expense', 'income', 'transfer'] }, start_at: { type: 'string' }, end_at: { type: 'string' }, limit: { type: 'number' }, offset: { type: 'number' } } } },
    { name: 'create_transaction', description: '创建一笔新交易', input_schema: { type: 'object', properties: { ledger_id: { type: 'string' }, tx_type: { type: 'string', enum: ['expense', 'income', 'transfer'] }, amount: { type: 'number' }, happened_at: { type: 'string' }, note: { type: 'string' }, category_name: { type: 'string' }, account_name: { type: 'string' } }, required: ['tx_type', 'amount', 'happened_at'] } },
    { name: 'get_summary', description: '获取指定账本的汇总统计', input_schema: { type: 'object', properties: { ledger_id: { type: 'string' } }, required: ['ledger_id'] } },
    { name: 'list_categories', description: '列出所有分类', input_schema: { type: 'object', properties: {} } },
    { name: 'list_accounts', description: '列出所有账户', input_schema: { type: 'object', properties: {} } },
  ];
  return c.json({ tools: toolList });
});

mcpRouter.post('/tools/call', async (c) => {
  const db = c.env.DB;
  const userId = c.get('userId');
  const patId = c.get('patId');
  const patPrefix = c.get('patPrefix');
  const patName = c.get('patName');
  const startTime = Date.now();

  let body: { name?: string; arguments?: Record<string, unknown> };
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON body' }, 400); }
  if (!body.name) return c.json({ error: 'Tool name required' }, 400);

  const handler = TOOL_HANDLERS[body.name];
  if (!handler) return c.json({ error: `Unknown tool: ${body.name}` }, 404);

  try {
    const result = await handler(db, userId, body.arguments || {});
    const duration = Date.now() - startTime;
    db.prepare(
      `INSERT INTO mcp_call_logs (user_id, pat_id, pat_prefix, pat_name, tool_name, status, args_summary, duration_ms, called_at)
       VALUES (?, ?, ?, ?, ?, 'success', ?, ?, ?)`
    ).bind(userId, patId, patPrefix, patName, body.name, JSON.stringify(Object.keys(body.arguments || {})), duration, nowUtc()).run().catch(() => {});
    return c.json(result);
  } catch (err) {
    const duration = Date.now() - startTime;
    db.prepare(
      `INSERT INTO mcp_call_logs (user_id, pat_id, pat_prefix, pat_name, tool_name, status, error_message, args_summary, duration_ms, called_at)
       VALUES (?, ?, ?, ?, ?, 'error', ?, ?, ?, ?)`
    ).bind(userId, patId, patPrefix, patName, body.name, (err as Error).message, JSON.stringify(Object.keys(body.arguments || {})), duration, nowUtc()).run().catch(() => {});
    return c.json({ error: (err as Error).message }, 500);
  }
});

export default mcpRouter;