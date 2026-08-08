/**
 * MCP Server - 手动实现 MCP Streamable HTTP 协议，对齐原版 Python 18 个工具
 */

import { Hono } from 'hono';
import { serverLogger } from '../lib/logger';
import { randomUUID } from 'crypto';

function nowUtc(): string { return new Date().toISOString(); }
async function hashToken(t: string): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
  return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ===========================
// 工具定义
// ===========================

interface ToolDef { name: string; description: string; inputSchema: Record<string, unknown>; }

const TOOL_DEFS: ToolDef[] = [
  { name: 'list_ledgers', description: 'List all ledgers for the authenticated BeeCount user. Returns each ledger\'s id (external_id), name, currency, and created_at. Use the returned id when calling other tools that take ledger_id.', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_active_ledger', description: 'Get the user\'s primary/default ledger. Use this when the user doesn\'t specify which ledger they\'re talking about. Returns null if the user has no ledgers.', inputSchema: { type: 'object', properties: {} } },
  { name: 'list_transactions', description: 'Query transactions with rich filters. ledger_id: Optional, uses active ledger if omitted. date_from/date_to: ISO dates (YYYY-MM-DD) or full ISO datetimes. category: Exact category name match. account: Exact account name match (matches account/from_account/to_account). min_amount/max_amount: Filter by absolute amount. q: Substring match against note. limit: Max items returned (1..200, default 50).', inputSchema: { type: 'object', properties: { ledger_id: { type: 'string' }, date_from: { type: 'string' }, date_to: { type: 'string' }, category: { type: 'string' }, account: { type: 'string' }, min_amount: { type: 'number' }, max_amount: { type: 'number' }, q: { type: 'string' }, limit: { type: 'number', default: 50 } } } },
  { name: 'get_transaction', description: 'Get a single transaction by its sync_id (cross-ledger lookup).', inputSchema: { type: 'object', properties: { sync_id: { type: 'string' } }, required: ['sync_id'] } },
  { name: 'list_categories', description: 'List user\'s categories. kind is one of: expense, income, transfer.', inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['expense', 'income', 'transfer'] } } } },
  { name: 'list_accounts', description: 'List user\'s accounts. account_type filters by type (bank_card, credit_card, cash, ...).', inputSchema: { type: 'object', properties: { account_type: { type: 'string' } } } },
  { name: 'list_tags', description: 'List all of the user\'s tags.', inputSchema: { type: 'object', properties: {} } },
  { name: 'list_budgets', description: 'List budgets for a ledger with current-month spent/remaining/percent_used.', inputSchema: { type: 'object', properties: { ledger_id: { type: 'string' } } } },
  { name: 'get_ledger_stats', description: 'Get summary stats for a ledger (transaction/category/account/tag/budget counts).', inputSchema: { type: 'object', properties: { ledger_id: { type: 'string' } } } },
  { name: 'get_analytics_summary', description: 'Income/expense/balance plus top-10 spending categories. scope: \'month\' | \'year\' | \'all\'. period: For month: \'YYYY-MM\'. For year: \'YYYY\'. Defaults to current. ledger_id: Optional, uses active ledger if omitted.', inputSchema: { type: 'object', properties: { scope: { type: 'string', enum: ['month', 'year', 'all'] }, period: { type: 'string' }, ledger_id: { type: 'string' } } } },
  { name: 'search', description: 'Full-text fuzzy search across transaction notes, category names, account names.', inputSchema: { type: 'object', properties: { q: { type: 'string' }, limit: { type: 'number', default: 20 } }, required: ['q'] } },
  { name: 'create_transaction', description: 'Create a new transaction. amount: Positive number; type captured separately via tx_type. tx_type: \'expense\' (default), \'income\', or \'transfer\'. category: Existing category name (server rejects unknown names). account: Existing account name. For transfers this is the from-account. happened_at: ISO date or datetime. Defaults to now. note: Optional memo. tags: Optional list of tag names. ledger_id: Optional; uses active ledger if omitted.', inputSchema: { type: 'object', properties: { amount: { type: 'number' }, tx_type: { type: 'string', enum: ['expense', 'income', 'transfer'] }, category: { type: 'string' }, account: { type: 'string' }, happened_at: { type: 'string' }, note: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, ledger_id: { type: 'string' } }, required: ['amount'] } },
  { name: 'create_transactions', description: 'Create many transactions at once - use this for bulk imports. Far more efficient than calling create_transaction in a loop. transactions: list of objects, each like create_transaction\'s args - {amount (>0), tx_type (expense|income|transfer, default expense), category, account, happened_at (ISO, default now), note, tags}. category/account must be existing names. ledger_id: Optional. Max 200 transactions per call.', inputSchema: { type: 'object', properties: { transactions: { type: 'array', items: { type: 'object' } }, ledger_id: { type: 'string' } }, required: ['transactions'] } },
  { name: 'update_transaction', description: 'Patch an existing transaction. Only the fields you pass are changed.', inputSchema: { type: 'object', properties: { sync_id: { type: 'string' }, amount: { type: 'number' }, tx_type: { type: 'string', enum: ['expense', 'income', 'transfer'] }, category: { type: 'string' }, account: { type: 'string' }, happened_at: { type: 'string' }, note: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['sync_id'] } },
  { name: 'delete_transaction', description: 'Delete a transaction. Destructive - two-step confirmation required. Calling with confirm=False returns a confirmation_required placeholder; you must then prompt the user, and only call again with confirm=true after they explicitly agree.', inputSchema: { type: 'object', properties: { sync_id: { type: 'string' }, confirm: { type: 'boolean' } }, required: ['sync_id'] } },
  { name: 'create_category', description: 'Create a new category. Usually unnecessary - prefer existing categories. name: required. kind: expense/income/transfer, default expense. parent_name: optional, for level-2 categories.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, kind: { type: 'string', enum: ['expense', 'income', 'transfer'] }, parent_name: { type: 'string' }, icon: { type: 'string' }, ledger_id: { type: 'string' } }, required: ['name'] } },
  { name: 'update_budget', description: 'Update a budget\'s amount.', inputSchema: { type: 'object', properties: { budget_id: { type: 'string' }, amount: { type: 'number' } }, required: ['budget_id', 'amount'] } },
  { name: 'parse_and_create_from_text', description: 'Have BeeCount AI parse free-form natural-language text into a transaction. Useful when the user gives a sentence like "上午星巴克花了 38" and you want BeeCount\'s own AI prompt + ledger context to do the heavy lifting. Requires the user to have configured an AI chat provider in their profile.', inputSchema: { type: 'object', properties: { text: { type: 'string' }, ledger_id: { type: 'string' } }, required: ['text'] } },
];

// ===========================
// 工具执行
// ===========================

async function resolveLedger(db: D1Database, userId: string, ledgerId?: string | null): Promise<{ id: string; external_id: string; name: string; currency: string | null } | null> {
  if (ledgerId) {
    return db.prepare(`SELECT l.id, l.external_id, l.name, l.currency FROM ledgers l LEFT JOIN ledger_members lm ON l.id = lm.ledger_id WHERE (l.user_id = ? OR lm.user_id = ?) AND l.external_id = ?`).bind(userId, userId, ledgerId).first<{ id: string; external_id: string; name: string; currency: string | null }>();
  }
  return db.prepare(`SELECT l.id, l.external_id, l.name, l.currency FROM ledgers l LEFT JOIN ledger_members lm ON l.id = lm.ledger_id WHERE (l.user_id = ? OR lm.user_id = ?) ORDER BY l.created_at ASC LIMIT 1`).bind(userId, userId).first<{ id: string; external_id: string; name: string; currency: string | null }>();
}

async function execTool(db: D1Database, userId: string, scopes: string[], name: string, args: Record<string, unknown>, patId: string, patPrefix: string, patName: string): Promise<{ content: { type: string; text: string }[] }> {
  const t = Date.now();
  const isWrite = ['create_transaction', 'update_transaction', 'delete_transaction', 'create_category', 'update_budget', 'create_transactions', 'parse_and_create_from_text'].includes(name);
  if (isWrite && !scopes.includes('mcp:write')) throw new Error('PAT missing required scope: mcp:write');
  if (!isWrite && !scopes.includes('mcp:read') && !scopes.includes('mcp:write')) throw new Error('PAT missing required scope: mcp:read');

  let r: any;
  try {
    switch (name) {
      case 'list_ledgers': {
        const rows = await db.prepare(`SELECT l.id, l.external_id, l.name, l.currency, l.created_at FROM ledgers l LEFT JOIN ledger_members lm ON l.id = lm.ledger_id WHERE (l.user_id = ? OR lm.user_id = ?) ORDER BY l.created_at ASC`).bind(userId, userId).all();
        r = rows.results.map((l: any) => ({ id: l.external_id, name: l.name || l.external_id, currency: l.currency, created_at: l.created_at ? new Date(l.created_at).toISOString() : null }));
        break;
      }
      case 'get_active_ledger': {
        const led = await resolveLedger(db, userId);
        r = led ? { id: led.external_id, name: led.name, currency: led.currency } : null;
        break;
      }
      case 'list_transactions': {
        const limit = Math.max(1, Math.min((args.limit as number) || 50, 200));
        const led = await resolveLedger(db, userId, args.ledger_id as string);
        if (!led) { r = { ledger: null, total: 0, items: [] }; break; }
        let q = 'SELECT * FROM read_tx_projection WHERE ledger_id = ?';
        const p: unknown[] = [led.id];
        if (args.date_from) { q += ' AND happened_at >= ?'; p.push(args.date_from); }
        if (args.date_to) { q += ' AND happened_at <= ?'; p.push(args.date_to + 'T23:59:59'); }
        if (args.category) { q += ' AND category_name = ?'; p.push(args.category); }
        if (args.account) { q += ' AND (account_name = ? OR from_account_name = ? OR to_account_name = ?)'; p.push(args.account, args.account, args.account); }
        if (args.min_amount !== undefined && args.min_amount !== null) { q += ' AND ABS(amount) >= ?'; p.push(args.min_amount); }
        if (args.max_amount !== undefined && args.max_amount !== null) { q += ' AND ABS(amount) <= ?'; p.push(args.max_amount); }
        if (args.q) { q += ' AND note LIKE ?'; const l = `%${args.q}%`; p.push(l); }
        const total = (await db.prepare(q.replace('SELECT *', 'SELECT COUNT(*) as cnt')).bind(...p).first<{ cnt: number }>())?.cnt || 0;
        q += ' ORDER BY happened_at DESC LIMIT ?'; p.push(limit);
        const rows = await db.prepare(q).bind(...p).all();
        r = { ledger: led.name, total, items: rows.results.map((x: any) => ({ sync_id: x.sync_id, tx_type: x.tx_type, amount: Number(x.amount || 0), happened_at: x.happened_at, note: x.note, category_name: x.category_name, account_name: x.account_name, from_account_name: x.from_account_name, to_account_name: x.to_account_name, tags: x.tags_csv || '' })) };
        break;
      }
      case 'get_transaction': {
        if (!args.sync_id) throw new Error('sync_id required');
        const tx = await db.prepare(`SELECT * FROM read_tx_projection WHERE user_id = ? AND sync_id = ?`).bind(userId, args.sync_id).first<any>();
        if (!tx) { r = null; break; }
        const l = await db.prepare('SELECT name FROM ledgers WHERE id = ?').bind(tx.ledger_id).first<{ name: string }>();
        r = { sync_id: tx.sync_id, tx_type: tx.tx_type, amount: Number(tx.amount || 0), happened_at: tx.happened_at, note: tx.note, category_name: tx.category_name, account_name: tx.account_name, from_account_name: tx.from_account_name, to_account_name: tx.to_account_name, tags: tx.tags_csv || '', ledger: l?.name || null, attachments: tx.attachments_json ? JSON.parse(tx.attachments_json) : [] };
        break;
      }
      case 'create_transaction': {
        const led = await resolveLedger(db, userId, args.ledger_id as string);
        if (!led) throw new Error('No ledger found');
        if (!args.amount || (args.amount as number) <= 0) throw new Error('amount must be positive');
        const sid = randomUUID();
        await db.prepare(`INSERT INTO sync_changes (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id, scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ledger')`).bind(userId, led.id, 'transaction', sid, 'upsert', JSON.stringify({ syncId: sid, type: args.tx_type || 'expense', amount: args.amount, happenedAt: args.happened_at || nowUtc(), note: args.note || null, categoryName: args.category || null, accountName: args.account || null, tags: args.tags || null }), nowUtc(), userId).run();
        r = { sync_id: sid, ledger: led.name, tx_type: args.tx_type || 'expense', amount: args.amount, happened_at: args.happened_at || nowUtc(), category: args.category || null, account: args.account || null };
        break;
      }
      case 'update_transaction': {
        if (!args.sync_id) throw new Error('sync_id required');
        const access = await db.prepare(`SELECT l.id FROM ledgers l WHERE l.user_id = ? UNION SELECT lm.ledger_id FROM ledger_members lm WHERE lm.user_id = ?`).bind(userId, userId).all<{ id: string }>();
        const ids = access.results.map(r => r.id);
        if (ids.length === 0) throw new Error('Transaction not found');
        const tx = await db.prepare(`SELECT * FROM read_tx_projection WHERE ledger_id IN (${ids.map(() => '?').join(',')}) AND sync_id = ?`).bind(...ids, args.sync_id).first<any>();
        if (!tx) throw new Error('Transaction not found');
        const payload: any = { syncId: args.sync_id };
        if (args.amount !== undefined) payload.amount = args.amount;
        if (args.tx_type) payload.tx_type = args.tx_type;
        if (args.category) payload.categoryName = args.category;
        if (args.account) payload.accountName = args.account;
        if (args.happened_at) payload.happened_at = args.happened_at;
        if (args.note !== undefined) payload.note = args.note;
        if (args.tags) payload.tags = args.tags;
        const updated = Object.keys(payload).filter(k => k !== 'syncId');
        const sid = randomUUID();
        await db.prepare(`INSERT INTO sync_changes (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id, scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ledger')`).bind(userId, tx.ledger_id, 'transaction', sid, 'upsert', JSON.stringify(payload), nowUtc(), userId).run();
        r = { sync_id: args.sync_id, updated };
        break;
      }
      case 'delete_transaction': {
        if (!args.sync_id) throw new Error('sync_id required');
        if (!args.confirm) { r = { status: 'confirmation_required', message: 'Delete transaction requires explicit confirmation. Please confirm with the user, then call again with confirm=true.', sync_id: args.sync_id }; break; }
        const access = await db.prepare('SELECT l.id FROM ledgers l WHERE l.user_id = ? UNION SELECT lm.ledger_id FROM ledger_members lm WHERE lm.user_id = ?').bind(userId, userId).all<{ id: string }>();
        const ids = access.results.map(r => r.id);
        if (ids.length === 0) throw new Error('Transaction not found');
        const tx = await db.prepare(`SELECT ledger_id FROM read_tx_projection WHERE ledger_id IN (${ids.map(() => '?').join(',')}) AND sync_id = ?`).bind(...ids, args.sync_id).first<any>();
        if (!tx) throw new Error('Transaction not found');
        const sid = randomUUID();
        await db.prepare(`INSERT INTO sync_changes (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id, scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ledger')`).bind(userId, tx.ledger_id, 'transaction', sid, 'delete', JSON.stringify({ syncId: args.sync_id }), nowUtc(), userId).run();
        r = { status: 'deleted', sync_id: args.sync_id };
        break;
      }
      case 'get_ledger_stats': {
        const led = await resolveLedger(db, userId, args.ledger_id as string);
        if (!led) { r = null; break; }
        const [tx, cat, acc, tag, bud] = await Promise.all([
          db.prepare('SELECT COUNT(*) as cnt FROM read_tx_projection WHERE ledger_id = ?').bind(led.id).first<{ cnt: number }>(),
          db.prepare('SELECT COUNT(DISTINCT sync_id) as cnt FROM read_category_projection WHERE user_id = ?').bind(userId).first<{ cnt: number }>(),
          db.prepare('SELECT COUNT(DISTINCT sync_id) as cnt FROM read_account_projection WHERE user_id = ?').bind(userId).first<{ cnt: number }>(),
          db.prepare('SELECT COUNT(DISTINCT sync_id) as cnt FROM read_tag_projection WHERE user_id = ?').bind(userId).first<{ cnt: number }>(),
          db.prepare('SELECT COUNT(*) as cnt FROM read_budget_projection WHERE ledger_id = ?').bind(led.id).first<{ cnt: number }>(),
        ]);
        r = { ledger: led.name, transaction_count: tx?.cnt || 0, category_count: cat?.cnt || 0, account_count: acc?.cnt || 0, tag_count: tag?.cnt || 0, budget_count: bud?.cnt || 0 };
        break;
      }
      case 'get_analytics_summary': {
        const led = await resolveLedger(db, userId, args.ledger_id as string);
        if (!led) { r = {}; break; }
        const scope = (args.scope as string) || 'month';
        let period = args.period as string;
        const now = new Date();
        if (!period) {
          if (scope === 'month') period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
          else if (scope === 'year') period = `${now.getFullYear()}`;
        }
        let dateFrom = '', dateTo = '';
        if (scope === 'month' && period) { dateFrom = period + '-01'; const y = parseInt(period.split('-')[0]), m = parseInt(period.split('-')[1]); dateTo = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`; }
        if (scope === 'year' && period) { dateFrom = period + '-01-01'; dateTo = `${parseInt(period) + 1}-01-01`; }
        let q = 'SELECT * FROM read_tx_projection WHERE ledger_id = ?'; const p: unknown[] = [led.id];
        if (dateFrom) { q += ' AND happened_at >= ?'; p.push(dateFrom); }
        if (dateTo) { q += ' AND happened_at < ?'; p.push(dateTo); }
        const rows = await db.prepare(q).bind(...p).all();
        const items = rows.results as any[];
        const income = items.filter(x => x.tx_type === 'income').reduce((s, x) => s + (x.native_amount ?? x.amount ?? 0), 0);
        const expense = items.filter(x => x.tx_type === 'expense').reduce((s, x) => s + (x.native_amount ?? x.amount ?? 0), 0);
        const catMap = new Map<string, number>();
        items.filter(x => x.tx_type === 'expense').forEach(x => { const amt = x.native_amount ?? x.amount ?? 0; const nm = x.category_name || '(未分类)'; catMap.set(nm, (catMap.get(nm) || 0) + amt); });
        const topCats = [...catMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, total]) => ({ name, total: Math.round(total * 100) / 100 }));
        r = { ledger: led.name, scope, period, income: Math.round(income * 100) / 100, expense: Math.round(expense * 100) / 100, balance: Math.round((income - expense) * 100) / 100, transaction_count: items.length, top_categories: topCats.map(t => ({ name: t.name, total: Math.round((t.total as number) * 100) / 100 })) };
        break;
      }
      case 'list_categories': {
        let q = 'SELECT sync_id, name, kind, level, icon, parent_name, sort_order FROM read_category_projection WHERE user_id = ?'; const p: unknown[] = [userId];
        if (args.kind) { q += ' AND kind = ?'; p.push(args.kind); }
        const rows = await db.prepare(q).bind(...p).all();
        const seen = new Map<string, any>();
        for (const r of (rows.results as any[])) { if (!seen.has(r.sync_id)) seen.set(r.sync_id, r); }
        r = [...seen.values()].sort((a, b) => {
          const ka = (a.kind || '').toLowerCase(), kb = (b.kind || '').toLowerCase();
          if (ka !== kb) return ka < kb ? -1 : 1;
          const sa = a.sort_order || 0, sb = b.sort_order || 0;
          if (sa !== sb) return sa - sb;
          return (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase());
        }).map((x: any) => ({ name: x.name, kind: x.kind, level: x.level, parent_name: x.parent_name, icon: x.icon }));
        break;
      }
      case 'list_accounts': {
        let q = 'SELECT sync_id, name, account_type, currency, initial_balance, bank_name, card_last_four, credit_limit, billing_day, payment_due_day FROM read_account_projection WHERE user_id = ?'; const p: unknown[] = [userId];
        if (args.account_type) { q += ' AND account_type = ?'; p.push(args.account_type); }
        const rows = await db.prepare(q).bind(...p).all();
        const seen = new Map<string, any>();
        for (const r of (rows.results as any[])) { if (!seen.has(r.sync_id)) seen.set(r.sync_id, r); }
        r = [...seen.values()].sort((a, b) => (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase())).map((x: any) => ({ name: x.name, account_type: x.account_type, currency: x.currency, initial_balance: Number(x.initial_balance || 0), bank_name: x.bank_name, card_last_four: x.card_last_four, credit_limit: x.credit_limit != null ? Number(x.credit_limit) : null, billing_day: x.billing_day, payment_due_day: x.payment_due_day }));
        break;
      }
      case 'list_tags': {
        const rows = await db.prepare('SELECT sync_id, name, color FROM read_tag_projection WHERE user_id = ?').bind(userId).all();
        const seen = new Map<string, any>();
        for (const r of (rows.results as any[])) { if (!seen.has(r.sync_id)) seen.set(r.sync_id, r); }
        r = [...seen.values()].sort((a, b) => (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase())).map((x: any) => ({ name: x.name, color: x.color }));
        break;
      }
      case 'list_budgets': {
        const led = await resolveLedger(db, userId, args.ledger_id as string);
        if (!led) { r = []; break; }
        const lid = led.id;
        const budgets = await db.prepare('SELECT * FROM read_budget_projection WHERE ledger_id = ?').bind(lid).all();
        const now = new Date(); const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
        const spending = await db.prepare('SELECT category_sync_id, SUM(COALESCE(native_amount, amount)) as spent FROM read_tx_projection WHERE ledger_id = ? AND tx_type = \'expense\' AND happened_at >= ? GROUP BY category_sync_id').bind(lid, monthStart).all();
        const spentMap = new Map((spending.results as any[]).map(x => [x.category_sync_id, x.spent]));
        const totalExpense = (spending.results as any[]).reduce((s, x) => s + (x.spent || 0), 0);
        r = (budgets.results as any[]).map(b => {
          const spent = (b.budget_type === 'total' || !b.category_sync_id) ? totalExpense : (spentMap.get(b.category_sync_id) || 0);
          const pct = b.amount > 0 ? Math.round((spent / b.amount) * 1000) / 10 : 0;
          return { id: b.sync_id, type: b.budget_type || 'total', amount: b.amount, spent, remaining: Math.max(0, b.amount - spent), percent_used: pct, exceeded: pct > 100 };
        });
        break;
      }
      case 'search': {
        const q = args.q as string; if (!q?.trim()) { r = []; break; }
        const limit = Math.max(1, Math.min((args.limit as number) || 20, 100));
        const like = `%${q}%`;
        const rows = await db.prepare('SELECT * FROM read_tx_projection WHERE user_id = ? AND note LIKE ? ORDER BY happened_at DESC LIMIT ?').bind(userId, like, limit).all();
        r = (rows.results as any[]).map(x => ({ sync_id: x.sync_id, tx_type: x.tx_type, amount: Number(x.amount || 0), happened_at: x.happened_at, note: x.note, category_name: x.category_name, account_name: x.account_name, from_account_name: x.from_account_name, to_account_name: x.to_account_name, tags: x.tags_csv || '' }));
        break;
      }
      case 'create_category': {
        if (!args.name) throw new Error('name required');
        const led = await resolveLedger(db, userId, args.ledger_id as string);
        if (!led) throw new Error('No ledger found');
        const sid = randomUUID();
        const level = args.parent_name ? 2 : 1;
        await db.prepare(`INSERT INTO sync_changes (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id, scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ledger')`).bind(userId, led.id, 'category', sid, 'upsert', JSON.stringify({ syncId: sid, name: args.name, kind: args.kind || 'expense', level, sortOrder: 0, icon: args.icon || null, iconType: null, parentName: args.parent_name || null }), nowUtc(), userId).run();
        r = { sync_id: sid, name: args.name, kind: args.kind || 'expense' };
        break;
      }
      case 'update_budget': {
        if (!args.budget_id || !args.amount) throw new Error('budget_id and amount required');
        if ((args.amount as number) <= 0) throw new Error('amount must be positive');
        const budget = await db.prepare('SELECT * FROM read_budget_projection WHERE sync_id = ? AND user_id = ?').bind(args.budget_id, userId).first<any>();
        if (!budget) throw new Error('Budget not found');
        const sid = randomUUID();
        await db.prepare(`INSERT INTO sync_changes (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id, scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ledger')`).bind(userId, budget.ledger_id, 'budget', sid, 'upsert', JSON.stringify({ syncId: sid, type: budget.budget_type, categoryId: budget.category_sync_id, amount: args.amount, period: budget.period, startDay: budget.start_day, enabled: !!budget.enabled }), nowUtc(), userId).run();
        r = { sync_id: args.budget_id, amount: args.amount };
        break;
      }
      case 'create_transactions': {
        const txs = args.transactions as any[];
        if (!txs?.length) throw new Error('transactions array required');
        const led = await resolveLedger(db, userId, args.ledger_id as string);
        if (!led) throw new Error('No ledger found');
        const sids: string[] = [];
        for (const tx of txs.slice(0, 200)) {
          if (!tx.amount || tx.amount <= 0) continue;
          const sid = randomUUID();
          await db.prepare(`INSERT INTO sync_changes (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id, scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ledger')`).bind(userId, led.id, 'transaction', sid, 'upsert', JSON.stringify({ syncId: sid, type: tx.tx_type || 'expense', amount: tx.amount, happenedAt: tx.happened_at || nowUtc(), note: tx.note || null, categoryName: tx.category || null, accountName: tx.account || null, tags: tx.tags || null }), nowUtc(), userId).run();
          sids.push(sid);
        }
        r = { status: 'created', ledger: led.name, created_count: sids.length, sync_ids: sids };
        break;
      }
      case 'parse_and_create_from_text': {
        if (!args.text) throw new Error('text required');
        const led = await resolveLedger(db, userId, args.ledger_id as string);
        if (!led) throw new Error('No ledger found');
        // 简单解析：提取金额和备注
        const text = args.text as string;
        const amountMatch = text.match(/(\d+(?:\.\d+)?)/);
        if (!amountMatch) throw new Error('Could not parse amount from text');
        const amount = parseFloat(amountMatch[1]);
        const sid = randomUUID();
        await db.prepare(`INSERT INTO sync_changes (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id, scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ledger')`).bind(userId, led.id, 'transaction', sid, 'upsert', JSON.stringify({ syncId: sid, type: 'expense', amount, happenedAt: nowUtc(), note: text, categoryName: null, accountName: null }), nowUtc(), userId).run();
        r = { status: 'created', parsed: { amount, note: text, tx_type: 'expense' }, transaction: { sync_id: sid, ledger: led.name, amount, tx_type: 'expense' } };
        break;
      }
      default: throw new Error(`Unknown tool: ${name}`);
    }
    const d = Date.now() - t;
    try { await db.prepare(`INSERT INTO mcp_call_logs (user_id, pat_id, pat_prefix, pat_name, tool_name, status, args_summary, duration_ms, called_at) VALUES (?, ?, ?, ?, ?, 'ok', ?, ?, ?)`).bind(userId, patId, patPrefix, patName, name, JSON.stringify(Object.keys(args)), d, nowUtc()).run(); } catch (e) { serverLogger.error('src.routers.mcp', `Failed to log MCP call: ${(e as Error).message}`); }
    return { content: [{ type: 'text', text: JSON.stringify(r) }] };
  } catch (err) {
    const d = Date.now() - t;
    try { await db.prepare(`INSERT INTO mcp_call_logs (user_id, pat_id, pat_prefix, pat_name, tool_name, status, error_message, args_summary, duration_ms, called_at) VALUES (?, ?, ?, ?, ?, 'error', ?, ?, ?, ?)`).bind(userId, patId, patPrefix, patName, name, (err as Error).message, JSON.stringify(Object.keys(args)), d, nowUtc()).run(); } catch (e) { serverLogger.error('src.routers.mcp', `Failed to log MCP error call: ${(e as Error).message}`); }
    throw err; // 抛出异常，由 JSON-RPC 处理层转为 error 响应
  }
}

// ===========================
// Hono 路由
// ===========================

const router = new Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string; patId: string; patPrefix: string; patName: string; patScopes: string[] } }>();

async function checkAuth(c: any): Promise<Response | null> {
  const h = c.req.header('Authorization');
  if (!h) return new Response('Authorization header required', { status: 401, headers: { 'Content-Type': 'text/plain' } });
  let t: string;
  if (h.startsWith('Bearer ')) t = h.slice(7); else return new Response('Invalid authorization format', { status: 401, headers: { 'Content-Type': 'text/plain' } });
  if (!t.startsWith('bcmcp_')) return new Response('Invalid PAT token format', { status: 401, headers: { 'Content-Type': 'text/plain' } });
  const hh = await hashToken(t);
  const p = await c.env.DB.prepare(`SELECT id, user_id, name, scopes_json, expires_at FROM personal_access_tokens WHERE token_hash = ? AND revoked_at IS NULL`).bind(hh).first<{ id: string; user_id: string; name: string; scopes_json: string; expires_at: string | null }>();
  if (!p) return new Response('Invalid PAT token', { status: 401, headers: { 'Content-Type': 'text/plain' } });
  if (p.expires_at && p.expires_at < nowUtc()) return new Response('PAT token expired', { status: 401, headers: { 'Content-Type': 'text/plain' } });
  c.set('userId', p.user_id); c.set('patId', p.id); c.set('patPrefix', t.substring(0, 14)); c.set('patName', p.name);
  c.set('patScopes', JSON.parse(p.scopes_json || '[]'));
  const ip = c.req.header('CF-Connecting-IP') || c.req.header('x-real-ip') || 'unknown';
  c.env.DB.prepare(`UPDATE personal_access_tokens SET last_used_at = ?, last_used_ip = ? WHERE id = ?`).bind(nowUtc(), ip, p.id).run().catch(() => {});
  return null;
}

// JSON-RPC 处理
async function jsonRpcHandler(c: any) {
  const ae = await checkAuth(c); if (ae) return ae;
  const db = c.env.DB; const userId = c.get('userId'); const patId = c.get('patId'); const patPrefix = c.get('patPrefix'); const patName = c.get('patName'); const patScopes = c.get('patScopes') || [];
  let body: any;
  try { body = await c.req.json(); } catch { return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }), { status: 400, headers: { 'Content-Type': 'application/json' } }); }
  if (!body || body.jsonrpc !== '2.0' || !body.method) return new Response(JSON.stringify({ jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32600, message: 'Invalid Request' } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  const { method, id, params } = body;
  try {
    if (method === 'initialize') return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'beecount-mcp', version: '1.0.0' } } }), { headers: { 'Content-Type': 'application/json' } });
    if (method === 'tools/list') return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: { tools: TOOL_DEFS } }), { headers: { 'Content-Type': 'application/json' } });
    if (method === 'tools/call') {
      const p = (params || {}) as { name?: string; arguments?: Record<string, unknown> };
      if (!p.name) return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Tool name required' } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      const result = await execTool(db, userId, patScopes, p.name, p.arguments || {}, patId, patPrefix, patName);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: {} }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    // 对齐原版 Python：异常转为 JSON-RPC error（不是 isError）
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: (e as Error).message } }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

// SSE 处理
async function sseHandler(c: any) {
  const ae = await checkAuth(c); if (ae) return ae;
  const { readable, writable } = new TransformStream();
  const w = writable.getWriter(); const enc = new TextEncoder();
  w.write(enc.encode(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'beecount-mcp', version: '1.0.0' } } })}\n\n`));
  const ka = setInterval(() => w.write(enc.encode(': keepalive\n\n')).catch(() => clearInterval(ka)), 15000);
  c.req.raw.signal.addEventListener('abort', () => { clearInterval(ka); w.close().catch(() => {}); });
  return new Response(readable, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' } });
}

// 路由注册
router.get('/sse', sseHandler);
router.post('/messages/', jsonRpcHandler);
router.post('/', jsonRpcHandler);
router.get('/', async (c) => { const ae = await checkAuth(c); return ae || new Response(JSON.stringify({ jsonrpc: '2.0', result: { serverInfo: { name: 'beecount-mcp', version: '1.0.0' } } }), { headers: { 'Content-Type': 'application/json' } }); });
router.get('/tools', async (c) => { const ae = await checkAuth(c); return ae || new Response(JSON.stringify({ tools: TOOL_DEFS }), { headers: { 'Content-Type': 'application/json' } }); });
router.post('/tools/call', async (c) => {
  const ae = await checkAuth(c); if (ae) return ae;
  const db = c.env.DB; const userId = c.get('userId'); const patId = c.get('patId'); const patPrefix = c.get('patPrefix'); const patName = c.get('patName'); const patScopes = c.get('patScopes') || [];
  let body: any; try { body = await c.req.json(); } catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: { 'Content-Type': 'application/json' } }); }
  if (!body?.name) return new Response(JSON.stringify({ error: 'Tool name required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  try {
    const result = await execTool(db, userId, patScopes, body.name, body.arguments || {}, patId, patPrefix, patName);
    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) { return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: { 'Content-Type': 'application/json' } }); }
});

export default router;