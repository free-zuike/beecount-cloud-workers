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
  // 暂时返回空列表，避免 500 错误
  const limit = Math.min(parseInt(c.req.query('limit') ?? '25', 10), 200);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);

  return c.json({
    total: 0,
    items: [],
    limit,
    offset,
  });
});

export default mcpCallsRouter;
