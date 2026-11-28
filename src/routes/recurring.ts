/**
 * 周期规则 REST 路由（对齐上游 1.10.1+ routers/recurring.py，#148）。
 *
 * 挂载在 /api/v1 根下（与上游 app.include_router(recurring.router, prefix=api_prefix) 一致，
 * 路由自带 /ledgers/{ledger_id}/recurring-rules 前缀）：
 * - GET  /api/v1/ledgers/:ledgerId/recurring-rules       — 列表（含 next_local/can_edit）
 * - POST /api/v1/ledgers/:ledgerId/recurring-rules       — 创建/更新/暂停/恢复/删除（含迁移交接）
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

import { allowAppRwScopes, requireAnyScopes } from '../middleware/scope';
import { lastImportedDates } from '../services/recurring-handoff';
import { changeRecurringRule, type RecurringRule } from '../mcp/rule-tools';
import { recordOut } from '../mcp/workflow-tools';
import type { McpContext } from '../mcp/types';

type Bindings = {
  DB: D1Database;
  JWT_SECRET: string;
};

type Variables = {
  userId: string;
  scopes?: string[];
};

const recurringRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

function mcpContext(c: { env: { DB: D1Database; JWT_SECRET: string }; get(key: string): unknown }): McpContext {
  return {
    db: c.env.DB,
    userId: c.get('userId') as string,
    jwtSecret: c.env.JWT_SECRET,
    baseUrl: '',
    scopes: (c.get('scopes') as string[]) ?? [],
  } as McpContext;
}

const LocalOccurrenceSchema = z.object({
  sync_id: z.string().min(1).max(255),
  date: z.string().min(8),
});

const RuleChangeSchema = z.object({
  action: z.enum(['create', 'update', 'pause', 'resume', 'delete']),
  data: z.unknown().nullable().optional(),
  record_id: z.string().uuid().nullable().optional(),
  expected_revision: z.number().int().min(1).nullable().optional(),
  client_id: z.string().uuid().nullable().optional(),
  confirm: z.boolean().default(false),
  migrate: z.boolean().default(false),
  automatic: z.boolean().default(false),
  consumed_through: z.string().nullable().optional(),
  last_generated_date: z.string().nullable().optional(),
  distinct: z.boolean().default(false),
  local_transactions: z.array(LocalOccurrenceSchema).max(50000).default([]),
  reviewed_mapping: z.string().nullable().optional(),
});

/** 错误消息 → HTTP 状态码（对齐上游 routers/recurring.py except ValueError 映射）。 */
function errorStatus(message: string): number {
  if (
    message.startsWith('REVISION_CONFLICT')
    || message.startsWith('SIMILAR_RULE')
    || message.startsWith('HISTORY_CONFLICT')
    || message.startsWith('Already synchronized copies')
  ) return 409;
  if (message === 'Record not found' || message === 'Ledger not found') return 404;
  if (message.startsWith('Only the schedule creator') || message.startsWith('Insufficient ledger role')) return 403;
  return 422;
}

// ---------------------------------------------------------------------------
// GET /write/ledgers/:ledgerId/recurring-rules - 列表
// ---------------------------------------------------------------------------

recurringRouter.get('/ledgers/:ledgerId/recurring-rules', async (c) => {
  const denied = requireAnyScopes(c, ['app_write', 'web_read'], allowAppRwScopes(c) ? ['app_write'] : []);
  if (denied) return denied;

  const userId = c.get('userId');
  const db = c.env.DB;
  const ledgerExternalId = c.req.param('ledgerId');

  const ledger = await db
    .prepare(
      `SELECT l.id, l.user_id, l.external_id FROM ledgers l
       JOIN ledger_members lm ON l.id = lm.ledger_id
       WHERE l.external_id = ? AND lm.user_id = ?`
    )
    .bind(ledgerExternalId, userId)
    .first<{ id: string; user_id: string; external_id: string }>();
  if (!ledger) return c.json({ detail: 'Ledger not found' }, 404);

  // 确定角色（owner/editor）
  const member = await db
    .prepare('SELECT role FROM ledger_members WHERE ledger_id = ? AND user_id = ?')
    .bind(ledger.id, userId)
    .first<{ role: string }>();
  const role = member?.role ?? 'owner';
  const writableRoles = new Set(['owner', 'editor']);

  const rows = await db
    .prepare(
      `SELECT id, data_json, next_due_at, status, user_id, created_at FROM mcp_state_records
       WHERE ledger_id = ? AND kind = 'recurring_rule' AND status != 'deleted'
       ORDER BY created_at, id`
    )
    .bind(ledger.id)
    .all<{ id: string; data_json: string; next_due_at: string | null; status: string; user_id: string; created_at: string }>();

  // 对齐上游 last_imported_dates + last_generated_local_date + next_local
  const imported = await lastImportedDates(db, ledger.id);

  const schedulerEnabled = (c.env as Record<string, unknown>).MCP_RECURRING_ENABLED !== 'false';
  const timeZone = (c.env as Record<string, unknown>).TZ ?? 'UTC';

  const items = (rows.results ?? []).map((row) => {
    const out = recordOut(row as never);
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(row.data_json) as Record<string, unknown>; } catch { /* ignore */ }
    const rule = (data.rule ?? {}) as Record<string, unknown>;

    const importedDate = imported[row.id] ?? null;
    const localDate = (data.last_local_generated_date as string | undefined) ?? importedDate;
    const lastDue = (data.last_due_at as string | undefined) ?? null;
    let lastGeneratedLocalDate: string | null = localDate;
    if (lastDue && rule.time_zone) {
      try {
        const cloudDate = new Date(lastDue).toLocaleDateString('sv-SE', { timeZone: rule.time_zone as string });
        lastGeneratedLocalDate = localDate && localDate >= cloudDate ? localDate : cloudDate;
      } catch { /* invalid date */ }
    }

    let nextLocal: string | null = null;
    if (row.next_due_at && rule.time_zone) {
      try {
        nextLocal = new Date(row.next_due_at).toLocaleString('sv-SE', { timeZone: rule.time_zone as string });
      } catch { /* invalid date */ }
    }

    return {
      ...out,
      can_edit: writableRoles.has(role) && row.user_id === userId,
      last_generated_local_date: lastGeneratedLocalDate,
      next_local: nextLocal,
    };
  });

  return c.json({
    items,
    can_create: writableRoles.has(role),
    scheduler_enabled: schedulerEnabled,
    time_zone: timeZone,
  });
});

// ---------------------------------------------------------------------------
// POST /write/ledgers/:ledgerId/recurring-rules - 变更规则
// ---------------------------------------------------------------------------

recurringRouter.post(
  '/ledgers/:ledgerId/recurring-rules',
  zValidator('json', RuleChangeSchema),
  async (c) => {
    const denied = requireAnyScopes(
      c,
      ['web_write'],
      allowAppRwScopes(c) ? ['app_write'] : [],
    );
    if (denied) return denied;

    const userId = c.get('userId');
    const args = c.req.valid('json');
    const ledgerExternalId = c.req.param('ledgerId');

    const ctx = mcpContext(c);
    try {
      const result = await changeRecurringRule(ctx, {
        action: args.action,
        ledger_id: ledgerExternalId,
        data: (args.data ?? null) as RecurringRule | null,
        record_id: args.record_id ?? null,
        expected_revision: args.expected_revision ?? null,
        confirm: args.confirm,
        client_id: args.client_id ?? null,
        consumed_through: args.consumed_through ?? null,
        last_generated_date: args.last_generated_date ?? null,
        migration: args.migrate,
        automatic: args.automatic,
        distinct: args.distinct,
        local_transactions: args.local_transactions ?? [],
        reviewed_mapping: args.reviewed_mapping ?? null,
      });
      if ((result as Record<string, unknown>).status === 'operation_pending') {
        return c.json({ detail: 'OCCURRENCE_PENDING' }, 409);
      }
      return c.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const status = (err as { status?: number }).status;
      if (status) return c.json({ detail: message }, status as 403);
      return c.json({ detail: message }, errorStatus(message) as 422);
    }
  }
);

export default recurringRouter;
