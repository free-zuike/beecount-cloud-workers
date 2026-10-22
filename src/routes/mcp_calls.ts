/**
 * MCP 调用日志路由模块 - 实现 MCP 工具调用历史查询接口
 *
 * 参考原版 BeeCount-Cloud (Python/FastAPI) 的 /mcp-calls 端点：
 * - GET /mcp-calls - 查询 MCP tool 调用历史（分页、过滤）
 *
 * 功能说明：
 * - 记录 PAT 调用 MCP 工具的日志
 * - 用于审计和安全排查
 * - 支持按 tool_name / status / 时间过滤
 * - client_label / client_active 由 LEFT JOIN PAT 实时解析
 *   （PAT 还在 → 当前 name；PAT 已删 → 降级到日志缓存 pat_name；都没有 → prefix）
 *
 * @module routes/mcp_calls
 */

import { Hono } from 'hono';

type Bindings = {
  DB: D1Database;
  JWT_SECRET: string;
};

type Variables = {
  userId: string;
};

const mcpCallsRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

/**
 * GET /mcp-calls - 查询 MCP 调用日志
 *
 * 查询参数：
 * - tool_name: 按工具名过滤
 * - status: 按状态过滤（ok / error）
 * - pat_id: 按 PAT ID 过滤
 * - limit: 每页条数（默认 50，最大 200）
 * - offset: 偏移量
 *
 * 响应字段：
 * - items: 日志条目数组（含 client_label / client_active）
 * - total: 总数
 */
mcpCallsRouter.get('/', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;

  const toolName = c.req.query('tool_name') ?? null;
  const status = c.req.query('status') ?? null;
  const patId = c.req.query('pat_id') ?? null;
  // 对齐上游 Query(ge=1, le=200) / Query(ge=0)
  const limitRaw = parseInt(c.req.query('limit') ?? '50', 10);
  const offset = Math.max(parseInt(c.req.query('offset') ?? '0', 10), 0);
  const limit = Math.min(Math.max(limitRaw, 1), 200);
  if (status !== null && status !== 'ok' && status !== 'error') {
    return c.json({ error: 'status must be ok or error' }, 422);
  }

  // 构建查询（对齐上游 outerjoin PAT 拿当前 name）
  const conditions: string[] = ['l.user_id = ?'];
  const params: (string | number)[] = [userId];

  if (toolName) {
    conditions.push('l.tool_name = ?');
    params.push(toolName);
  }
  if (status) {
    conditions.push('l.status = ?');
    params.push(status);
  }
  if (patId) {
    conditions.push('l.pat_id = ?');
    params.push(patId);
  }
  const whereClause = conditions.join(' AND ');

  const rows = await db
    .prepare(
      `SELECT l.id, l.pat_id, l.pat_prefix, l.pat_name, l.tool_name, l.status,
              l.error_message, l.args_summary, l.duration_ms, l.client_ip, l.called_at,
              t.name AS pat_current_name
       FROM mcp_call_logs l
       LEFT JOIN personal_access_tokens t ON l.pat_id = t.id
       WHERE ${whereClause}
       ORDER BY l.called_at DESC
       LIMIT ? OFFSET ?`
    )
    .bind(...params, limit, offset)
    .all<{
      id: number;
      pat_id: string | null;
      pat_prefix: string | null;
      pat_name: string | null;
      tool_name: string;
      status: string;
      error_message: string | null;
      args_summary: string | null;
      duration_ms: number;
      client_ip: string | null;
      called_at: string;
      pat_current_name: string | null;
    }>();

  const totalRow = await db
    .prepare(`SELECT COUNT(*) as cnt FROM mcp_call_logs l WHERE ${whereClause}`)
    .bind(...params)
    .first<{ cnt: number }>();

  // 对齐上游：client_active = JOIN 拿到当前名；label = current_name or pat_name or pat_prefix
  const items = rows.results.map((row) => {
    const clientActive = row.pat_current_name !== null;
    const clientLabel = row.pat_current_name ?? row.pat_name ?? row.pat_prefix;
    return {
      id: row.id,
      pat_id: row.pat_id,
      pat_prefix: row.pat_prefix,
      pat_name: row.pat_name,
      tool_name: row.tool_name,
      status: row.status,
      error_message: row.error_message,
      args_summary: row.args_summary,
      duration_ms: row.duration_ms,
      client_label: clientLabel,
      client_active: clientActive,
      client_ip: row.client_ip,
      called_at: row.called_at,
    };
  });

  return c.json({
    items,
    total: totalRow?.cnt ?? 0,
  });
});

export default mcpCallsRouter;