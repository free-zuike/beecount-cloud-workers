/**
 * Backup & Data Management Routes
 * 
 * Implements data export/import and data cleanup endpoints
 */
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

type Bindings = {
  DB: D1Database;
  JWT_SECRET: string;
};

type Variables = {
  userId: string;
};

const backupRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// ===========================
// 辅助函数
// ===========================

function nowUtc(): string {
  return new Date().toISOString();
}

// ===========================
// 备份路由
// ===========================

/**
 * GET /backup/export
 * 导出用户所有数据
 */
backupRouter.get('/export', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;

  try {
    const ledgers = await db
      .prepare('SELECT * FROM ledgers WHERE user_id = ?')
      .bind(userId)
      .all();

    const transactions = await db
      .prepare('SELECT * FROM read_tx_projection WHERE user_id = ?')
      .bind(userId)
      .all();

    const accounts = await db
      .prepare('SELECT * FROM read_account_projection WHERE user_id = ?')
      .bind(userId)
      .all();

    const categories = await db
      .prepare('SELECT * FROM read_category_projection WHERE user_id = ?')
      .bind(userId)
      .all();

    const tags = await db
      .prepare('SELECT * FROM read_tag_projection WHERE user_id = ?')
      .bind(userId)
      .all();

    const budgets = await db
      .prepare('SELECT * FROM read_budget_projection WHERE user_id = ?')
      .bind(userId)
      .all();

    const syncChanges = await db
      .prepare('SELECT * FROM sync_changes WHERE user_id = ? ORDER BY change_id ASC')
      .bind(userId)
      .all();

    return c.json({
      export_time: nowUtc(),
      user_id: userId,
      data: {
        ledgers: ledgers.results,
        transactions: transactions.results,
        accounts: accounts.results,
        categories: categories.results,
        tags: tags.results,
        budgets: budgets.results,
        sync_changes: syncChanges.results,
      },
    });
  } catch (error) {
    console.error('[BACKUP] Export error:', error);
    return c.json({ error: 'Export failed' }, 500);
  }
});

/**
 * DELETE /backup/clear-data
 * 清空用户所有数据（保留账户）
 */
backupRouter.delete('/clear-data', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const serverNow = nowUtc();

  try {
    console.log('[BACKUP] Starting data clear for user:', userId);

    // 1. 先提取账户数据（保留）
    const accounts = await db
      .prepare('SELECT * FROM read_account_projection WHERE user_id = ?')
      .bind(userId)
      .all();

    console.log('[BACKUP] Found', accounts.results.length, 'accounts to preserve');

    // 2. 删除所有账本（会通过外键级联删除大部分数据）
    const ledgers = await db
      .prepare('SELECT id FROM ledgers WHERE user_id = ?')
      .bind(userId)
      .all();

    console.log('[BACKUP] Deleting', ledgers.results.length, 'ledgers');

    for (const ledger of ledgers.results) {
      await db
        .prepare('DELETE FROM ledgers WHERE id = ?')
        .bind(ledger.id)
        .run();
    }

    // 3. 清理 sync_changes（按 user_id 删除）
    const syncDeleteResult = await db
      .prepare('DELETE FROM sync_changes WHERE user_id = ?')
      .bind(userId)
      .run();

    console.log('[BACKUP] Deleted sync_changes');

    // 4. 直接清理投影表（确保彻底删除）
    await db.prepare('DELETE FROM read_tx_projection WHERE user_id = ?').bind(userId).run();
    await db.prepare('DELETE FROM read_category_projection WHERE user_id = ?').bind(userId).run();
    await db.prepare('DELETE FROM read_tag_projection WHERE user_id = ?').bind(userId).run();
    await db.prepare('DELETE FROM read_budget_projection WHERE user_id = ?').bind(userId).run();

    // 5. 清理附件文件（按 user_id 或 ledger_id）
    await db
      .prepare('DELETE FROM attachment_files WHERE user_id = ?')
      .bind(userId)
      .run();

    console.log('[BACKUP] Cleared projections and attachments');

    // 6. 恢复账户（如果之前有账户的话）
    for (const account of accounts.results) {
      // 检查账本是否还存在，如果不存在则不恢复
      const ledgerExists = await db
        .prepare('SELECT id FROM ledgers WHERE id = ?')
        .bind(account.ledger_id)
        .first();

      if (!ledgerExists) {
        console.log('[BACKUP] Skipping account', account.sync_id, 'because ledger was deleted');
        continue;
      }

      // 恢复账户
      await db
        .prepare(
          `INSERT OR IGNORE INTO read_account_projection 
           (ledger_id, sync_id, user_id, name, account_type, currency, initial_balance, 
            note, credit_limit, billing_day, payment_due_day, bank_name, card_last_four, source_change_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          account.ledger_id,
          account.sync_id,
          userId,
          account.name,
          account.account_type,
          account.currency,
          account.initial_balance,
          account.note,
          account.credit_limit,
          account.billing_day,
          account.payment_due_day,
          account.bank_name,
          account.card_last_four,
          0,
        )
        .run();
    }

    console.log('[BACKUP] Data clear completed, restored', accounts.results.length, 'accounts');

    return c.json({
      success: true,
      message: 'All data cleared except accounts',
      preserved_accounts: accounts.results.length,
      cleared_at: serverNow,
    });
  } catch (error) {
    console.error('[BACKUP] Clear data error:', error);
    return c.json({ 
      error: 'Clear data failed',
      message: error instanceof Error ? error.message : String(error)
    }, 500);
  }
});

/**
 * POST /backup/fix-data - 修复恢复数据：补充缺失的 sync_changes 记录
 */
backupRouter.post('/fix-data', async (c) => {
  const db = c.env.DB;
  const fixes: Record<string, number> = {};

  // 1. 修复 sync_id 为空的投影记录
  const tables = ['read_account_projection', 'read_category_projection', 'read_tag_projection', 'read_tx_projection', 'read_budget_projection'];
  for (const tableName of tables) {
    try {
      const empty = await db.prepare(`SELECT rowid FROM "${tableName}" WHERE sync_id IS NULL OR sync_id = ''`).all<{ rowid: number }>();
      if (empty.results && empty.results.length > 0) {
        for (const row of empty.results) {
          const newSyncId = crypto.randomUUID();
          await db.prepare(`UPDATE "${tableName}" SET sync_id = ? WHERE rowid = ?`).bind(newSyncId, row.rowid).run();
        }
        fixes[`${tableName}_sync_id`] = empty.results.length;
      }
    } catch {}
  }

  // 2. 为投影表中有数据但 sync_changes 中缺失的记录补充 sync_changes
  // 这样 sync/pull 才能把数据推送给 App
  const projectionTables: Array<{ table: string; entityType: string; ledgerIdCol: string; userCol: string }> = [
    { table: 'read_budget_projection', entityType: 'budget', ledgerIdCol: 'ledger_id', userCol: 'user_id' },
    { table: 'read_account_projection', entityType: 'account', ledgerIdCol: 'ledger_id', userCol: 'user_id' },
    { table: 'read_category_projection', entityType: 'category', ledgerIdCol: 'ledger_id', userCol: 'user_id' },
    { table: 'read_tag_projection', entityType: 'tag', ledgerIdCol: 'ledger_id', userCol: 'user_id' },
  ];

  for (const pt of projectionTables) {
    try {
      // 查找投影表中有数据但 sync_changes 中没有对应记录的行
      const missing = await db.prepare(`
        SELECT p.sync_id, p.${pt.userCol} as user_id, p.${pt.ledgerIdCol} as ledger_id, p.source_change_id
        FROM "${pt.table}" p
        WHERE p.sync_id IS NOT NULL AND p.sync_id != ''
        AND NOT EXISTS (
          SELECT 1 FROM sync_changes sc
          WHERE sc.entity_type = ? AND sc.entity_sync_id = p.sync_id
        )
      `).bind(pt.entityType).all<{ sync_id: string; user_id: string; ledger_id: string | null; source_change_id: number | null }>();

      if (missing.results && missing.results.length > 0) {
        let insertedCount = 0;
        for (const row of missing.results) {
          // 从投影表中获取完整数据构建 payload
          const fullRow = await db.prepare(`SELECT * FROM "${pt.table}" WHERE sync_id = ?`).bind(row.sync_id).first<Record<string, unknown>>();
          if (!fullRow) continue;

          const payload: Record<string, unknown> = {};
          const BOOLEAN_FIELDS = new Set(['enabled', 'exclude_from_stats', 'exclude_from_budget', 'is_default', 'hidden', 'income_is_red']);
          for (const [k, v] of Object.entries(fullRow)) {
            if (k === 'id' || k === 'rowid') continue;
            // SQLite 用 0/1 存储布尔值，Flutter 期望 bool
            if (BOOLEAN_FIELDS.has(k) && typeof v === 'number') {
              payload[k] = v === 1;
            } else {
              payload[k] = v;
            }
          }

          const maxChangeId = await db.prepare('SELECT MAX(change_id) as max_id FROM sync_changes').first<{ max_id: number | null }>();
          const newChangeId = (maxChangeId?.max_id ?? 0) + 1;

          try {
            await db.prepare(`
              INSERT INTO sync_changes (change_id, user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_device_id, scope)
              VALUES (?, ?, ?, ?, ?, 'upsert', ?, ?, NULL, ?)
            `).bind(
              newChangeId,
              row.user_id,
              row.ledger_id || null,
              pt.entityType,
              row.sync_id,
              JSON.stringify(payload),
              new Date().toISOString(),
              pt.entityType === 'account' || pt.entityType === 'category' || pt.entityType === 'tag' ? 'user' : 'ledger'
            ).run();
            insertedCount++;
          } catch (err) {
            console.error(`[FixData] Failed to insert sync_changes for ${pt.entityType} ${row.sync_id}:`, (err as Error).message);
          }
        }
        fixes[`sync_changes_${pt.entityType}`] = insertedCount;
      }
    } catch (err) {
      console.error(`[FixData] Failed processing ${pt.table}:`, (err as Error).message);
    }
  }

  return c.json({ fixes, message: 'Fixed sync_id and created missing sync_changes records' });
});

export default backupRouter;