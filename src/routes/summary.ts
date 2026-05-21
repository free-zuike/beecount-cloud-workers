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

  const ledger = await db
    .prepare('SELECT id, external_id FROM ledgers WHERE user_id = ? AND external_id = ?')
    .bind(userId, ledgerExternalId)
    .first<{ id: string; external_id: string }>();

  if (!ledger) {
    return c.json({ error: 'Ledger not found' }, 404);
  }

  const stats = await db
    .prepare(
      `SELECT
         COUNT(*) as tx_count,
         COALESCE(SUM(CASE WHEN tx_type = 'income' THEN amount ELSE 0 END), 0) as income_total,
         COALESCE(SUM(CASE WHEN tx_type = 'expense' THEN amount ELSE 0 END), 0) as expense_total,
         MIN(happened_at) as first_tx_at,
         MAX(happened_at) as last_tx_at
       FROM read_tx_projection
       WHERE ledger_id = ?`
    )
    .bind(ledger.id)
    .first<{
      tx_count: number;
      income_total: number;
      expense_total: number;
      first_tx_at: string | null;
      last_tx_at: string | null;
    }>();

  const incomeTotal = stats?.income_total ?? 0;
  const expenseTotal = stats?.expense_total ?? 0;

  return c.json({
    ledger_id: ledger.external_id,
    tx_count: stats?.tx_count ?? 0,
    income_total: incomeTotal,
    expense_total: expenseTotal,
    balance: incomeTotal - expenseTotal,
    first_tx_at: stats?.first_tx_at ?? null,
    last_tx_at: stats?.last_tx_at ?? null,
  });
});

/**
 * GET /read/summary/workspace/ledger-counts - 获取账本统计（年度报告使用）
 */
async function ensureTxProjectionSynced(db: D1Database, userId: string): Promise<void> {
  const sample = await db
    .prepare('SELECT COUNT(*) as cnt FROM read_tx_projection WHERE user_id = ?')
    .bind(userId)
    .first<{ cnt: number }>();
  
  if (sample && sample.cnt > 0) return;
  
  console.log('[SUMMARY] read_tx_projection is empty, syncing from sync_changes...');
  
  const ledgers = await db
    .prepare('SELECT id FROM ledgers WHERE user_id = ?')
    .bind(userId)
    .all<{ id: string }>();
  
  for (const ledger of ledgers.results) {
    const changes = await db
      .prepare(
        `SELECT change_id, entity_type, entity_sync_id, action, payload_json, user_id, updated_at, updated_by_user_id
         FROM sync_changes 
         WHERE ledger_id = ? AND entity_type = 'transaction' AND action != 'delete'
         ORDER BY change_id ASC`
      )
      .bind(ledger.id)
      .all<{
        change_id: number;
        entity_type: string;
        entity_sync_id: string;
        action: string;
        payload_json: string;
        user_id: string;
        updated_at: string;
        updated_by_user_id: string | null;
      }>();
    
    for (const change of changes.results) {
      try {
        const payload = JSON.parse(change.payload_json);
        
        await db
          .prepare(
            `INSERT OR REPLACE INTO read_tx_projection
             (ledger_id, sync_id, user_id, tx_type, amount, happened_at, note,
              category_sync_id, category_name, category_kind,
              account_sync_id, account_name,
              from_account_sync_id, from_account_name,
              to_account_sync_id, to_account_name,
              tags_csv, tag_sync_ids_json, attachments_json, tx_index, source_change_id,
              created_at, created_by, created_by_user_id, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            ledger.id,
            change.entity_sync_id,
            change.user_id,
            payload.tx_type || 'expense',
            Math.round((payload.amount || 0) * 100),
            payload.happened_at || change.updated_at,
            payload.note || null,
            payload.category_sync_id || null,
            payload.category_name || null,
            payload.category_kind || null,
            payload.account_sync_id || null,
            payload.account_name || null,
            payload.from_account_sync_id || null,
            payload.from_account_name || null,
            payload.to_account_sync_id || null,
            payload.to_account_name || null,
            payload.tags ? payload.tags.join(',') : null,
            payload.tag_sync_ids ? JSON.stringify(payload.tag_sync_ids) : null,
            payload.attachments ? JSON.stringify(payload.attachments) : null,
            payload.tx_index ?? 0,
            change.change_id,
            change.updated_at,
            null,
            change.updated_by_user_id,
            change.updated_at,
          )
          .run();
      } catch (err) {
        console.error('[SUMMARY] Error syncing transaction:', change.entity_sync_id, err);
      }
    }
  }
  
  console.log('[SUMMARY] Sync completed');
}

summaryRouter.get('/workspace/ledger-counts', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const ledgerExternalId = c.req.query('ledger_id');

  console.log('[SUMMARY] /workspace/ledger-counts called, ledgerId:', ledgerExternalId, 'userId:', userId);

  if (!ledgerExternalId) {
    // 没有指定账本，返回当前年份作为默认选项
    return c.json({
      ledger_id: null,
      tx_count: 0,
      first_tx_at: null,
      last_tx_at: null,
    });
  }

  const ledger = await db
    .prepare('SELECT id, external_id FROM ledgers WHERE user_id = ? AND external_id = ?')
    .bind(userId, ledgerExternalId)
    .first<{ id: string; external_id: string }>();

  if (!ledger) {
    console.log('[SUMMARY] Ledger not found:', ledgerExternalId);
    // 找不到账本，也返回默认选项
    return c.json({
      ledger_id: null,
      tx_count: 0,
      first_tx_at: null,
      last_tx_at: null,
    });
  }

  console.log('[SUMMARY] Found ledger:', ledger.id);

  await ensureTxProjectionSynced(db, userId);

  const stats = await db
    .prepare(
      `SELECT
         COUNT(*) as tx_count,
         MIN(happened_at) as first_tx_at,
         MAX(happened_at) as last_tx_at
       FROM read_tx_projection
       WHERE ledger_id = ?`
    )
    .bind(ledger.id)
    .first<{
      tx_count: number;
      first_tx_at: string | null;
      last_tx_at: string | null;
    }>();

  console.log('[SUMMARY] Stats:', stats);

  return c.json({
    ledger_id: ledger.external_id,
    tx_count: stats?.tx_count ?? 0,
    first_tx_at: stats?.first_tx_at ?? null,
    last_tx_at: stats?.last_tx_at ?? null,
  });
});

export default summaryRouter;
