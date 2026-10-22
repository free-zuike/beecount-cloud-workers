/**
 * 账本摘要路由模块 - 实现单账本快速统计接口
 *
 * 参考原版 BeeCount-Cloud (Python/FastAPI) 的 /read/summary 端点：
 * - GET /read/summary - 单账本快速统计
 *
 * 功能说明：
 * - 用于 mobile 的首页/概览页
 * - 快速返回 tx_count / income / expense / balance
 * - 比完整 ledger 查询更轻量
 *
 * @module routes/summary
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

const summaryRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

/**
 * GET /read/summary - 单账本快速统计
 *
 * 查询参数：
 * - ledger_id: 账本外部 ID（必填）
 *
 * 响应字段：
 * - tx_count: 交易总数
 * - income_total: 收入总额
 * - expense_total: 支出总额
 * - balance: 余额（income - expense）
 * - first_tx_at: 首笔交易时间
 * - last_tx_at: 最后一笔交易时间
 */
summaryRouter.get('/', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const ledgerExternalId = c.req.query('ledger_id');

  if (!ledgerExternalId) {
    return c.json({ error: 'ledger_id is required' }, 400);
  }

  let ledger = await db
    .prepare('SELECT id, external_id FROM ledgers WHERE user_id = ? AND external_id = ?')
    .bind(userId, ledgerExternalId)
    .first<{ id: string; external_id: string }>();

  if (!ledger) {
    // 支持共享账本成员(对齐上游 _require_ledger)
    ledger = await db
      .prepare('SELECT l.id, l.external_id FROM ledgers l JOIN ledger_members lm ON l.id = lm.ledger_id WHERE lm.user_id = ? AND l.external_id = ?')
      .bind(userId, ledgerExternalId)
      .first<{ id: string; external_id: string }>();
  }

  if (!ledger) {
    return c.json({ error: 'Ledger not found' }, 404);
  }

  // 对齐上游 _projection_totals(_shared.py:429):
  // tx_count/latest 不过滤标记笔;income/expense 排除 exclude_from_stats;
  // balance 用全部收支差(native_amount 回退 amount,「余额=钱的位置」口径)
  const stats = await db
    .prepare(
      `SELECT
         COUNT(*) as tx_count,
         COALESCE(SUM(CASE WHEN tx_type = 'income' AND (exclude_from_stats IS NULL OR exclude_from_stats = 0 OR exclude_from_stats = false) THEN COALESCE(native_amount, amount) ELSE 0 END), 0) as income_total,
         COALESCE(SUM(CASE WHEN tx_type = 'expense' AND (exclude_from_stats IS NULL OR exclude_from_stats = 0 OR exclude_from_stats = false) THEN COALESCE(native_amount, amount) ELSE 0 END), 0) as expense_total,
         COALESCE(SUM(CASE WHEN tx_type = 'income' THEN COALESCE(native_amount, amount) WHEN tx_type = 'expense' THEN -COALESCE(native_amount, amount) ELSE 0 END), 0) as balance_all,
         MAX(happened_at) as last_tx_at
       FROM read_tx_projection
       WHERE ledger_id = ?`
    )
    .bind(ledger.id)
    .first<{
      tx_count: number;
      income_total: number;
      expense_total: number;
      balance_all: number;
      last_tx_at: string | null;
    }>();

  return c.json({
    ledger_id: ledger.external_id,
    transaction_count: stats?.tx_count ?? 0,
    income_total: stats?.income_total ?? 0,
    expense_total: stats?.expense_total ?? 0,
    balance: stats?.balance_all ?? 0,
    latest_happened_at: stats?.last_tx_at ?? null,
  });
});

export default summaryRouter;
