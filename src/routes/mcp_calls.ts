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
 *
 * @module routes/mcp_calls
 */

import { Hono } from 'hono';

function nowUtc(): string {
  return new Date().toISOString();
}

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
 * - status: 按状态过滤（success / error / partial）
 * - start_at / end_at: 时间范围
 * - pat_id: 按 PAT ID 过滤
 * - limit: 每页条数（默认 50，最大 200）
 * - offset: 偏移量
 *
 * 响应字段：
 * - items: 日志条目数组
 * - total: 总数
 */
mcpCallsRouter.get('/', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;

  const toolName = c.req.query('tool_name') ?? null;
  const status = c.req.query('status') ?? null;
  const startAt = c.req.query('start_at') ?? null;
  const endAt = c.req.query('end_at') ?? null;
  const patId = c.req.query('pat_id') ?? null;
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 200);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);

  // 构建查询
  const conditions: string[] = ['user_id = ?'];
  const params: (string | number)[] = [userId];

  if (toolName) {
    conditions.push('tool_name = ?');
    params.push(toolName);
  }

  if (status) {
    conditions.push('status = ?');
    params.push(status);
  }

  if (startAt) {
    conditions.push('called_at >= ?');
    params.push(startAt);
  }

  if (endAt) {
    conditions.push('called_at <= ?');
    params.push(endAt);
  }

  if (patId) {
    conditions.push('pat_id = ?');
    params.push(patId);
  }

  const whereClause = conditions.join(' AND ');

  const rows = await db
    .prepare(
      `SELECT id, pat_id, pat_prefix, pat_name, tool_name, status,
              error_message, args_summary, duration_ms, client_ip, called_at
       FROM mcp_call_logs
       WHERE ${whereClause}
       ORDER BY called_at DESC
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
    }>();

  const totalRow = await db
    .prepare(`SELECT COUNT(*) as cnt FROM mcp_call_logs WHERE ${whereClause}`)
    .bind(...params)
    .first<{ cnt: number }>();

  const items = rows.results.map((row) => ({
    id: row.id,
    pat_id: row.pat_id,
    pat_prefix: row.pat_prefix,
    pat_name: row.pat_name,
    tool_name: row.tool_name,
    status: row.status,
    error_message: row.error_message,
    args_summary: row.args_summary,
    duration_ms: row.duration_ms,
    client_ip: row.client_ip,
    called_at: row.called_at,
  }));

  return c.json({
    items,
    total: totalRow?.cnt ?? 0,
    limit,
    offset,
  });
});

export default mcpCallsRouter;
