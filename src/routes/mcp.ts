/**
 * MCP Server 路由模块 - 手动实现 MCP Streamable HTTP 协议（无需 SDK）
 *
 * 参考原版 BeeCount-Cloud (Python/FastAPI) 的 FastMCP 实现：
 * - GET  /mcp - SSE 端点
 * - POST /mcp - JSON-RPC 消息端点
 * - 支持 list_ledgers, list_transactions, create_transaction,
 *   get_summary, list_categories, list_accounts
 */

import { Hono } from 'hono';
import { serverLogger } from '../lib/logger';
import { randomUUID } from 'crypto';

function nowUtc(): string { return new Date().toISOString(); }

async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ===========================
// 工具实现
// ===========================

const TOOL_DEFS = [
  { name: 'list_ledgers', description: '列出用户的所有账本', inputSchema: { type: 'object', properties: {} } },
  { name: 'list_transactions', description: '查询交易记录', inputSchema: { type: 'object', properties: { ledger_id: { type: 'string' }, tx_type: { type: 'string', enum: ['expense', 'income', 'transfer'] }, start_at: { type: 'string' }, end_at: { type: 'string' }, limit: { type: 'number' }, offset: { type: 'number' } } } },
  { name: 'create_transaction', description: '创建一笔新交易', inputSchema: { type: 'object', properties: { ledger_id: { type: 'string' }, tx_type: { type: 'string', enum: ['expense', 'income', 'transfer'] }, amount: { type: 'number' }, happened_at: { type: 'string' }, note: { type: 'string' }, category_name: { type: 'string' }, account_name: { type: 'string' } }, required: ['tx_type', 'amount', 'happened_at'] } },
  { name: 'get_summary', description: '获取指定账本的汇总统计', inputSchema: { type: 'object', properties: { ledger_id: { type: 'string' } }, required: ['ledger_id'] } },
  { name: 'list_categories', description: '列出所有分类', inputSchema: { type: 'object', properties: {} } },
  { name: 'list_accounts', description: '列出所有账户', inputSchema: { type: 'object', properties: {} } },
];

async function handleTool(db: D1Database, userId: string, toolName: string, args: Record<string, unknown>, patId: string, patPrefix: string, patName: string) {
  const startTime = Date.now();
  try {
    let result: { content: { type: string; text: string }[]; isError?: boolean };
    switch (toolName) {
      case 'list_ledgers': {
        const ledgers = await db.prepare(
          `SELECT l.id, l.external_id, l.name, l.currency, l.created_at FROM ledgers l
           LEFT JOIN ledger_members lm ON l.id = lm.ledger_id WHERE (l.user_id = ? OR lm.user_id = ?)`
        ).bind(userId, userId).all();
        result = { content: [{ type: 'text', text: JSON.stringify(ledgers.results.map(l => ({ id: l.external_id, name: l.name || l.external_id, currency: l.currency }))) }] };
        break;
      }
      case 'list_transactions': {
        const limit = Math.min((args.limit as number) || 20, 200);
        const offset = (args.offset as number) || 0;
        let query = 'SELECT * FROM read_tx_projection WHERE user_id = ?';
        const params: unknown[] = [userId];
        if (args.ledger_id) { query += ' AND ledger_id = (SELECT id FROM ledgers WHERE external_id = ?)'; params.push(args.ledger_id); }
        if (args.tx_type) { query += ' AND tx_type = ?'; params.push(args.tx_type); }
        if (args.start_at) { query += ' AND happened_at >= ?'; params.push(args.start_at); }
        if (args.end_at) { query += ' AND happened_at <= ?'; params.push(args.end_at); }
        query += ' ORDER BY happened_at DESC LIMIT ? OFFSET ?'; params.push(limit, offset);
        const rows = await db.prepare(query).bind(...params).all();
        result = { content: [{ type: 'text', text: JSON.stringify(rows.results) }] };
        break;
      }
      case 'create_transaction': {
        const ledgerId = args.ledger_id as string || null;
        let ledgerRow: { id: string } | null = null;
        if (ledgerId) {
          ledgerRow = await db.prepare(`SELECT l.id FROM ledgers l LEFT JOIN ledger_members lm ON l.id = lm.ledger_id WHERE (l.user_id = ? OR lm.user_id = ?) AND l.external_id = ?`).bind(userId, userId, ledgerId).first<{ id: string }>();
        } else {
          ledgerRow = await db.prepare(`SELECT l.id FROM ledgers l LEFT JOIN ledger_members lm ON l.id = lm.ledger_id WHERE (l.user_id = ? OR lm.user_id = ?) ORDER BY l.created_at ASC LIMIT 1`).bind(userId, userId).first<{ id: string }>();
        }
        if (!ledgerRow) result = { content: [{ type: 'text', text: JSON.stringify({ error: 'No ledger found' }) }], isError: true };
        else {
          const syncId = randomUUID();
          await db.prepare(`INSERT INTO sync_changes (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id, scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ledger')`).bind(userId, ledgerRow.id, 'transaction', syncId, 'upsert', JSON.stringify({ syncId, tx_type: args.tx_type, amount: args.amount, happened_at: args.happened_at, note: args.note || null, categoryName: args.category_name || null, accountName: args.account_name || null }), nowUtc(), userId).run();
          result = { content: [{ type: 'text', text: JSON.stringify({ success: true, sync_id: syncId }) }] };
        }
        break;
      }
      case 'get_summary': {
        if (!args.ledger_id) result = { content: [{ type: 'text', text: JSON.stringify({ error: 'ledger_id required' }) }], isError: true };
        else {
          const ledger = await db.prepare(`SELECT l.id, l.external_id, l.name FROM ledgers l LEFT JOIN ledger_members lm ON l.id = lm.ledger_id WHERE (l.user_id = ? OR lm.user_id = ?) AND l.external_id = ?`).bind(userId, userId, args.ledger_id).first<{ id: string; external_id: string; name: string | null }>();
          if (!ledger) result = { content: [{ type: 'text', text: JSON.stringify({ error: 'Ledger not found' }) }], isError: true };
          else {
            const stats = await db.prepare(`SELECT COUNT(*) as tx_count, SUM(CASE WHEN tx_type='income' THEN amount ELSE 0 END) as income, SUM(CASE WHEN tx_type='expense' THEN amount ELSE 0 END) as expense FROM read_tx_projection WHERE ledger_id = ?`).bind(ledger.id).first<{ tx_count: number; income: number; expense: number }>();
            result = { content: [{ type: 'text', text: JSON.stringify({ ledger: ledger.name || ledger.external_id, transactions: stats?.tx_count || 0, income: stats?.income || 0, expense: stats?.expense || 0 }) }] };
          }
        }
        break;
      }
      case 'list_categories': {
        const rows = await db.prepare('SELECT sync_id, name, kind, level, icon FROM read_category_projection WHERE user_id = ? ORDER BY sort_order ASC').bind(userId).all();
        result = { content: [{ type: 'text', text: JSON.stringify(rows.results) }] };
        break;
      }
      case 'list_accounts': {
        const rows = await db.prepare('SELECT sync_id, name, account_type, currency, initial_balance, note FROM read_account_projection WHERE user_id = ?').bind(userId).all();
        result = { content: [{ type: 'text', text: JSON.stringify(rows.results) }] };
        break;
      }
      default:
        result = { content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${toolName}` }) }], isError: true };
    }
    const duration = Date.now() - startTime;
    db.prepare(`INSERT INTO mcp_call_logs (user_id, pat_id, pat_prefix, pat_name, tool_name, status, args_summary, duration_ms, called_at) VALUES (?, ?, ?, ?, ?, 'success', ?, ?, ?)`).bind(userId, patId, patPrefix, patName, toolName, JSON.stringify(Object.keys(args)), duration, nowUtc()).run().catch(() => {});
    return result;
  } catch (err) {
    const duration = Date.now() - startTime;
    db.prepare(`INSERT INTO mcp_call_logs (user_id, pat_id, pat_prefix, pat_name, tool_name, status, error_message, args_summary, duration_ms, called_at) VALUES (?, ?, ?, ?, ?, 'error', ?, ?, ?, ?)`).bind(userId, patId, patPrefix, patName, toolName, (err as Error).message, JSON.stringify(Object.keys(args)), duration, nowUtc()).run().catch(() => {});
    return { content: [{ type: 'text', text: JSON.stringify({ error: (err as Error).message }) }], isError: true };
  }
}

// ===========================
// MCP JSON-RPC 处理
// ===========================

function jsonRpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } };
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
  const pat = await db.prepare(`SELECT id, user_id, name, scopes, expires_at FROM personal_access_tokens WHERE token_hash = ? AND revoked_at IS NULL`).bind(tokenHash).first<{ id: string; user_id: string; name: string; scopes: string; expires_at: string | null }>();
  if (!pat) return c.json({ error: 'Invalid PAT token' }, 401);
  if (pat.expires_at && pat.expires_at < nowUtc()) return c.json({ error: 'PAT token expired' }, 401);

  c.set('userId', pat.user_id);
  c.set('patId', pat.id);
  c.set('patPrefix', token.substring(0, 14));
  c.set('patName', pat.name);
  await next();
});

// GET /mcp - SSE 端点（MCP Streamable HTTP 协议）
mcpRouter.get('/', async (c) => {
  const db = c.env.DB;
  const userId = c.get('userId');
  const patId = c.get('patId');
  const patPrefix = c.get('patPrefix');
  const patName = c.get('patName');

  // 创建 SSE 流
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  // 发送初始化事件
  const initMsg = {
    jsonrpc: '2.0',
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'beecount-mcp', version: '1.0.0' },
    },
  };
  writer.write(encoder.encode(`event: message\ndata: ${JSON.stringify(initMsg)}\n\n`));

  // 保持连接（每 15 秒发送心跳）
  const keepAlive = setInterval(() => {
    writer.write(encoder.encode(': keepalive\n\n')).catch(() => clearInterval(keepAlive));
  }, 15000);

  // 客户端断开时清理
  c.req.raw.signal.addEventListener('abort', () => {
    clearInterval(keepAlive);
    writer.close().catch(() => {});
  });

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
});

// POST /mcp - JSON-RPC 消息端点
mcpRouter.post('/', async (c) => {
  const db = c.env.DB;
  const userId = c.get('userId');
  const patId = c.get('patId');
  const patPrefix = c.get('patPrefix');
  const patName = c.get('patName');

  let body: { jsonrpc?: string; id?: unknown; method?: string; params?: unknown };
  try { body = await c.req.json(); } catch {
    return c.json(jsonRpcError(null, -32700, 'Parse error'), 400);
  }

  if (body.jsonrpc !== '2.0' || !body.method) {
    return c.json(jsonRpcError(body.id ?? null, -32600, 'Invalid Request'), 400);
  }

  const method = body.method;
  const id = body.id ?? null;
  const params = (body.params || {}) as Record<string, unknown>;

  // 处理 MCP 方法
  try {
    if (method === 'initialize') {
      return c.json({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'beecount-mcp', version: '1.0.0' },
        },
      });
    }

    if (method === 'tools/list') {
      return c.json({ jsonrpc: '2.0', id, result: { tools: TOOL_DEFS } });
    }

    if (method === 'tools/call') {
      const toolParams = params as { name?: string; arguments?: Record<string, unknown> };
      if (!toolParams.name) return c.json(jsonRpcError(id, -32602, 'Tool name required'), 400);
      const result = await handleTool(db, userId, toolParams.name, toolParams.arguments || {}, patId, patPrefix, patName);
      return c.json({ jsonrpc: '2.0', id, result });
    }

    // 其他方法返回空结果
    return c.json({ jsonrpc: '2.0', id, result: {} });
  } catch (err) {
    return c.json(jsonRpcError(id, -32603, (err as Error).message), 500);
  }
});

// 保留旧 REST API 端点（向后兼容）
mcpRouter.get('/tools', (c) => c.json({ tools: TOOL_DEFS }));

mcpRouter.post('/tools/call', async (c) => {
  const db = c.env.DB;
  const userId = c.get('userId');
  const patId = c.get('patId');
  const patPrefix = c.get('patPrefix');
  const patName = c.get('patName');
  let body: { name?: string; arguments?: Record<string, unknown> };
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON body' }, 400); }
  if (!body.name) return c.json({ error: 'Tool name required' }, 400);
  try {
    const result = await handleTool(db, userId, body.name, body.arguments || {}, patId, patPrefix, patName);
    return c.json(result);
  } catch (err) { return c.json({ error: (err as Error).message }, 500); }
});

export default mcpRouter;