/**
 * MCP Server - 手动实现 MCP Streamable HTTP 协议
 * 端点: GET /mcp/sse, POST /mcp/messages/, POST /mcp, GET /mcp, GET /mcp/tools, POST /mcp/tools/call
 */

import { Hono } from 'hono';
import { serverLogger } from '../lib/logger';
import { randomUUID } from 'crypto';

function nowUtc(): string { return new Date().toISOString(); }

async function hashToken(token: string): Promise<string> {
  const e = new TextEncoder();
  const h = await crypto.subtle.digest('SHA-256', e.encode(token));
  return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join('');
}

const TOOLS = [
  { name: 'list_ledgers', description: '列出用户的所有账本', inputSchema: { type: 'object', properties: {} } },
  { name: 'list_transactions', description: '查询交易记录', inputSchema: { type: 'object', properties: { ledger_id: { type: 'string' }, tx_type: { type: 'string', enum: ['expense', 'income', 'transfer'] }, start_at: { type: 'string' }, end_at: { type: 'string' }, limit: { type: 'number' }, offset: { type: 'number' } } } },
  { name: 'create_transaction', description: '创建一笔新交易', inputSchema: { type: 'object', properties: { ledger_id: { type: 'string' }, tx_type: { type: 'string', enum: ['expense', 'income', 'transfer'] }, amount: { type: 'number' }, happened_at: { type: 'string' }, note: { type: 'string' }, category_name: { type: 'string' }, account_name: { type: 'string' } }, required: ['tx_type', 'amount', 'happened_at'] } },
  { name: 'get_summary', description: '获取指定账本的汇总统计', inputSchema: { type: 'object', properties: { ledger_id: { type: 'string' } }, required: ['ledger_id'] } },
  { name: 'list_categories', description: '列出所有分类', inputSchema: { type: 'object', properties: {} } },
  { name: 'list_accounts', description: '列出所有账户', inputSchema: { type: 'object', properties: {} } },
];

async function execTool(db: D1Database, userId: string, name: string, args: Record<string, unknown>, patId: string, patPrefix: string, patName: string) {
  const t = Date.now();
  try {
    let r: any;
    switch (name) {
      case 'list_ledgers': {
        const rows = await db.prepare(`SELECT l.id, l.external_id, l.name, l.currency FROM ledgers l LEFT JOIN ledger_members lm ON l.id = lm.ledger_id WHERE (l.user_id = ? OR lm.user_id = ?)`).bind(userId, userId).all();
        r = { content: [{ type: 'text', text: JSON.stringify(rows.results.map((l: any) => ({ id: l.external_id, name: l.name || l.external_id, currency: l.currency }))) }] };
        break;
      }
      case 'list_transactions': {
        const limit = Math.min((args.limit as number) || 20, 200);
        const offset = (args.offset as number) || 0;
        let q = 'SELECT * FROM read_tx_projection WHERE user_id = ?';
        const p: unknown[] = [userId];
        if (args.ledger_id) { q += ' AND ledger_id = (SELECT id FROM ledgers WHERE external_id = ?)'; p.push(args.ledger_id); }
        if (args.tx_type) { q += ' AND tx_type = ?'; p.push(args.tx_type); }
        if (args.start_at) { q += ' AND happened_at >= ?'; p.push(args.start_at); }
        if (args.end_at) { q += ' AND happened_at <= ?'; p.push(args.end_at); }
        q += ' ORDER BY happened_at DESC LIMIT ? OFFSET ?'; p.push(limit, offset);
        r = { content: [{ type: 'text', text: JSON.stringify((await db.prepare(q).bind(...p).all()).results) }] };
        break;
      }
      case 'create_transaction': {
        let lr = args.ledger_id ? await db.prepare(`SELECT l.id FROM ledgers l LEFT JOIN ledger_members lm ON l.id = lm.ledger_id WHERE (l.user_id = ? OR lm.user_id = ?) AND l.external_id = ?`).bind(userId, userId, args.ledger_id).first<{ id: string }>() : await db.prepare(`SELECT l.id FROM ledgers l LEFT JOIN ledger_members lm ON l.id = lm.ledger_id WHERE (l.user_id = ? OR lm.user_id = ?) ORDER BY l.created_at ASC LIMIT 1`).bind(userId, userId).first<{ id: string }>();
        if (!lr) r = { content: [{ type: 'text', text: JSON.stringify({ error: 'No ledger found' }) }], isError: true };
        else {
          const sid = randomUUID();
          await db.prepare(`INSERT INTO sync_changes (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id, scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ledger')`).bind(userId, lr.id, 'transaction', sid, 'upsert', JSON.stringify({ syncId: sid, tx_type: args.tx_type, amount: args.amount, happened_at: args.happened_at, note: args.note || null, categoryName: args.category_name || null, accountName: args.account_name || null }), nowUtc(), userId).run();
          r = { content: [{ type: 'text', text: JSON.stringify({ success: true, sync_id: sid }) }] };
        }
        break;
      }
      case 'get_summary': {
        if (!args.ledger_id) r = { content: [{ type: 'text', text: JSON.stringify({ error: 'ledger_id required' }) }], isError: true };
        else {
          const lr = await db.prepare(`SELECT l.id, l.name FROM ledgers l LEFT JOIN ledger_members lm ON l.id = lm.ledger_id WHERE (l.user_id = ? OR lm.user_id = ?) AND l.external_id = ?`).bind(userId, userId, args.ledger_id).first<{ id: string; name: string | null }>();
          if (!lr) r = { content: [{ type: 'text', text: JSON.stringify({ error: 'Ledger not found' }) }], isError: true };
          else {
            const s = await db.prepare(`SELECT COUNT(*) as c, SUM(CASE WHEN tx_type='income' THEN amount ELSE 0 END) as inc, SUM(CASE WHEN tx_type='expense' THEN amount ELSE 0 END) as exp FROM read_tx_projection WHERE ledger_id = ?`).bind(lr.id).first<{ c: number; inc: number; exp: number }>();
            r = { content: [{ type: 'text', text: JSON.stringify({ ledger: lr.name || args.ledger_id, transactions: s?.c || 0, income: s?.inc || 0, expense: s?.exp || 0 }) }] };
          }
        }
        break;
      }
      case 'list_categories': {
        const rows = await db.prepare('SELECT sync_id, name, kind, level, icon FROM read_category_projection WHERE user_id = ? ORDER BY sort_order ASC').bind(userId).all();
        r = { content: [{ type: 'text', text: JSON.stringify(rows.results) }] };
        break;
      }
      case 'list_accounts': {
        const rows = await db.prepare('SELECT sync_id, name, account_type, currency, initial_balance, note FROM read_account_projection WHERE user_id = ?').bind(userId).all();
        r = { content: [{ type: 'text', text: JSON.stringify(rows.results) }] };
        break;
      }
      default: r = { content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${name}` }) }], isError: true };
    }
    const d = Date.now() - t;
    db.prepare(`INSERT INTO mcp_call_logs (user_id, pat_id, pat_prefix, pat_name, tool_name, status, args_summary, duration_ms, called_at) VALUES (?, ?, ?, ?, ?, 'success', ?, ?, ?)`).bind(userId, patId, patPrefix, patName, name, JSON.stringify(Object.keys(args)), d, nowUtc()).run().catch(() => {});
    return r;
  } catch (err) {
    const d = Date.now() - t;
    db.prepare(`INSERT INTO mcp_call_logs (user_id, pat_id, pat_prefix, pat_name, tool_name, status, error_message, args_summary, duration_ms, called_at) VALUES (?, ?, ?, ?, ?, 'error', ?, ?, ?, ?)`).bind(userId, patId, patPrefix, patName, name, (err as Error).message, JSON.stringify(Object.keys(args)), d, nowUtc()).run().catch(() => {});
    return { content: [{ type: 'text', text: JSON.stringify({ error: (err as Error).message }) }], isError: true };
  }
}

// ===========================
// Hono 路由
// ===========================

const router = new Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string; patId: string; patPrefix: string; patName: string } }>();

router.use('/*', async (c, next) => {
  const h = c.req.header('Authorization');
  if (!h) return c.json({ error: 'Authorization header required' }, 401);
  let t: string;
  if (h.startsWith('Bearer ')) t = h.slice(7); else return c.json({ error: 'Invalid authorization format' }, 401);
  if (!t.startsWith('bcmcp_')) return c.json({ error: 'Invalid PAT token format' }, 401);
  const hh = await hashToken(t);
  const d = c.env.DB;
  const p = await d.prepare(`SELECT id, user_id, name, scopes, expires_at FROM personal_access_tokens WHERE token_hash = ? AND revoked_at IS NULL`).bind(hh).first<{ id: string; user_id: string; name: string; scopes: string; expires_at: string | null }>();
  if (!p) return c.json({ error: 'Invalid PAT token' }, 401);
  if (p.expires_at && p.expires_at < nowUtc()) return c.json({ error: 'PAT token expired' }, 401);
  c.set('userId', p.user_id); c.set('patId', p.id); c.set('patPrefix', t.substring(0, 14)); c.set('patName', p.name);
  await next();
});

// 处理 JSON-RPC 请求
async function handleRpc(c: any) {
  const db = c.env.DB as D1Database;
  const userId = c.get('userId') as string;
  const patId = c.get('patId') as string;
  const patPrefix = c.get('patPrefix') as string;
  const patName = c.get('patName') as string;

  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400); }
  if (!body || body.jsonrpc !== '2.0' || !body.method) return c.json({ jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32600, message: 'Invalid Request' } }, 400);

  const { method, id, params } = body;
  try {
    if (method === 'initialize') return c.json({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'beecount-mcp', version: '1.0.0' } } });
    if (method === 'tools/list') return c.json({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    if (method === 'tools/call') {
      const p = (params || {}) as { name?: string; arguments?: Record<string, unknown> };
      if (!p.name) return c.json({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Tool name required' } }, 400);
      const r = await execTool(db, userId, p.name, p.arguments || {}, patId, patPrefix, patName);
      return c.json({ jsonrpc: '2.0', id, result: r });
    }
    return c.json({ jsonrpc: '2.0', id, result: {} });
  } catch (e) { return c.json({ jsonrpc: '2.0', id, error: { code: -32603, message: (e as Error).message } }, 500); }
}

// 处理 SSE 请求
async function handleSse(c: any) {
  const { readable, writable } = new TransformStream();
  const w = writable.getWriter();
  const enc = new TextEncoder();
  w.write(enc.encode(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'beecount-mcp', version: '1.0.0' } } })}\n\n`));
  const ka = setInterval(() => w.write(enc.encode(': keepalive\n\n')).catch(() => clearInterval(ka)), 15000);
  c.req.raw.signal.addEventListener('abort', () => { clearInterval(ka); w.close().catch(() => {}); });
  return new Response(readable, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' } });
}

// 路由注册
router.get('/sse', handleSse);
router.post('/messages/', handleRpc);
router.post('/', handleRpc);
router.get('/', (c) => c.json({ jsonrpc: '2.0', result: { serverInfo: { name: 'beecount-mcp', version: '1.0.0' } } }));
router.get('/tools', (c) => c.json({ tools: TOOLS }));
router.post('/tools/call', async (c) => {
  const db = c.env.DB; const userId = c.get('userId'); const patId = c.get('patId'); const patPrefix = c.get('patPrefix'); const patName = c.get('patName');
  let body: any; try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  if (!body?.name) return c.json({ error: 'Tool name required' }, 400);
  try { return c.json(await execTool(db, userId, body.name, body.arguments || {}, patId, patPrefix, patName)); }
  catch (e) { return c.json({ error: (e as Error).message }, 500); }
});

export default router;