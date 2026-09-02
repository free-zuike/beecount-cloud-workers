/**
 * Backup & Data Management Routes
 * 
 * Implements data export/import and data cleanup endpoints
 */
import { serverLogger } from '../lib/logger';
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

type Bindings = {
  DB: D1Database;
  JWT_SECRET: string;
  R2?: R2Bucket;
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
 * 为指定用户创建 sync_changes 记录（restore 后自动调用）
 * 这样 App 的 sync/pull 就能获取到投影数据
 */
export async function createSyncChangesForUser(db: D1Database, targetUserId: string): Promise<void> {
  const projectionTables: Array<{ table: string; entityType: string }> = [
    { table: 'user_category_projection', entityType: 'category' },
    { table: 'user_tag_projection', entityType: 'tag' },
    { table: 'read_budget_projection', entityType: 'budget' },
    { table: 'user_account_projection', entityType: 'account' },
    { table: 'read_tx_projection', entityType: 'transaction' },
  ];

  const maxChangeId = await db.prepare('SELECT MAX(change_id) as max_id FROM sync_changes').first<{ max_id: number | null }>();
  let currentId = (maxChangeId?.max_id ?? 0);

  for (const pt of projectionTables) {
    const rows = await db.prepare(`SELECT sync_id, ledger_id FROM "${pt.table}" WHERE user_id = ? AND sync_id IS NOT NULL AND sync_id != ''`).bind(targetUserId).all<{ sync_id: string; ledger_id: string | null }>();
    for (const row of (rows.results || [])) {
      currentId++;
      const fullRow = await db.prepare(`SELECT * FROM "${pt.table}" WHERE sync_id = ?`).bind(row.sync_id).first<Record<string, unknown>>();
      if (!fullRow) continue;
      const payload: Record<string, unknown> = {};
      const BOOL_KEYS = ['enabled', 'exclude_from_stats', 'exclude_from_budget', 'is_default', 'hidden', 'income_is_red'];
      for (const [k, v] of Object.entries(fullRow)) {
        if (k === 'id' || k === 'rowid') continue;
        if (BOOL_KEYS.includes(k) && typeof v === 'number') { payload[k] = v === 1; } else { payload[k] = v; }
      }
      if (payload.ledger_id && typeof payload.ledger_id === 'string') {
        const ledger = await db.prepare('SELECT external_id FROM ledgers WHERE id = ?').bind(payload.ledger_id).first<{ external_id: string }>();
        if (ledger) payload.ledger_id = ledger.external_id;
      }
      try {
        await db.prepare(`INSERT INTO sync_changes (change_id, user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, scope) VALUES (?, ?, ?, ?, ?, 'upsert', ?, ?, ?)`)
          .bind(currentId, targetUserId, row.ledger_id || null, pt.entityType, row.sync_id, JSON.stringify(payload), new Date().toISOString(), pt.entityType === 'account' || pt.entityType === 'category' || pt.entityType === 'tag' ? 'user' : 'ledger').run();
      } catch {}
    }
  }
}

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
      .prepare('SELECT * FROM user_account_projection WHERE user_id = ?')
      .bind(userId)
      .all();

    const categories = await db
      .prepare('SELECT * FROM user_category_projection WHERE user_id = ?')
      .bind(userId)
      .all();

    const tags = await db
      .prepare('SELECT * FROM user_tag_projection WHERE user_id = ?')
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
    serverLogger.error('src.routers.admin', '[BACKUP] Export error:', error);
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
    serverLogger.info('src.routers.admin', '[BACKUP] Starting data clear for user:', userId);

    // 1. 先提取账户数据（保留）
    const accounts = await db
      .prepare('SELECT * FROM user_account_projection WHERE user_id = ?')
      .bind(userId)
      .all();

    serverLogger.info('src.routers.admin', '[BACKUP] Found', accounts.results.length, 'accounts to preserve');

    // 2. 删除所有账本（会通过外键级联删除大部分数据）
    const ledgers = await db
      .prepare('SELECT id FROM ledgers WHERE user_id = ?')
      .bind(userId)
      .all();

    serverLogger.info('src.routers.admin', '[BACKUP] Deleting', ledgers.results.length, 'ledgers');

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

    serverLogger.info('src.routers.admin', '[BACKUP] Deleted sync_changes');

    // 4. 直接清理投影表（确保彻底删除）
    await db.prepare('DELETE FROM read_tx_projection WHERE user_id = ?').bind(userId).run();
    await db.prepare('DELETE FROM user_category_projection WHERE user_id = ?').bind(userId).run();
    await db.prepare('DELETE FROM user_tag_projection WHERE user_id = ?').bind(userId).run();
    await db.prepare('DELETE FROM read_budget_projection WHERE user_id = ?').bind(userId).run();

    // 5. 清理附件文件（按 user_id 或 ledger_id）
    await db
      .prepare('DELETE FROM attachment_files WHERE user_id = ?')
      .bind(userId)
      .run();

    serverLogger.info('src.routers.admin', '[BACKUP] Cleared projections and attachments');

    // 6. 恢复账户（如果之前有账户的话）
    for (const account of accounts.results) {
      // 检查账本是否还存在，如果不存在则不恢复
      const ledgerExists = await db
        .prepare('SELECT id FROM ledgers WHERE id = ?')
        .bind(account.ledger_id)
        .first();

      if (!ledgerExists) {
        serverLogger.info('src.routers.admin', '[BACKUP] Skipping account', account.sync_id, 'because ledger was deleted');
        continue;
      }

      // 恢复账户
      await db
        .prepare(
          `INSERT OR IGNORE INTO user_account_projection 
           (sync_id, user_id, name, account_type, currency, initial_balance, 
            note, credit_limit, billing_day, payment_due_day, bank_name, card_last_four, hidden, source_change_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
        )
        .bind(
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

    serverLogger.info('src.routers.admin', '[BACKUP] Data clear completed, restored', accounts.results.length, 'accounts');

    return c.json({
      success: true,
      message: 'All data cleared except accounts',
      preserved_accounts: accounts.results.length,
      cleared_at: serverNow,
    });
  } catch (error) {
    serverLogger.error('src.routers.admin', '[BACKUP] Clear data error:', error);
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
  const fixes: Record<string, unknown> = {};

  // 诊断：sync_changes 中各 entity_type 的数量
  const typeCounts = await db.prepare(`SELECT entity_type, COUNT(*) as cnt FROM sync_changes GROUP BY entity_type`).all<{ entity_type: string; cnt: number }>();
  fixes['sync_changes_by_type'] = Object.fromEntries((typeCounts.results || []).map(r => [r.entity_type, r.cnt]));

  // 诊断：投影表行数
  const projCounts: Record<string, number> = {};
  for (const t of ['read_budget_projection', 'user_account_projection', 'user_category_projection', 'user_tag_projection', 'read_tx_projection']) {
    try {
      const r = await db.prepare(`SELECT COUNT(*) as cnt FROM "${t}"`).first<{ cnt: number }>();
      projCounts[t] = r?.cnt ?? 0;
    } catch { projCounts[t] = -1; }
  }
  fixes['projection_counts'] = projCounts;

  // 1. 修复 sync_id 为空的投影记录
  const tables = ['user_account_projection', 'user_category_projection', 'user_tag_projection', 'read_tx_projection', 'read_budget_projection'];
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
    { table: 'user_account_projection', entityType: 'account', ledgerIdCol: '', userCol: 'user_id' },
    { table: 'user_category_projection', entityType: 'category', ledgerIdCol: '', userCol: 'user_id' },
    { table: 'user_tag_projection', entityType: 'tag', ledgerIdCol: '', userCol: 'user_id' },
  ];

  for (const pt of projectionTables) {
    try {
      // 先删除该 entity_type 的所有 sync_changes，然后重建
      const deleted = await db.prepare(`DELETE FROM sync_changes WHERE entity_type = ?`).bind(pt.entityType).run();
      if (deleted.meta?.changes && deleted.meta.changes > 0) {
        fixes[`deleted_${pt.entityType}`] = deleted.meta.changes;
      }

      // 查找投影表中所有有 sync_id 的记录
      const ledgerSelect = pt.ledgerIdCol ? `p.${pt.ledgerIdCol} as ledger_id,` : `NULL as ledger_id,`;
      const missing = await db.prepare(`
        SELECT p.sync_id, p.${pt.userCol} as user_id, ${ledgerSelect} p.source_change_id
        FROM "${pt.table}" p
        WHERE p.sync_id IS NOT NULL AND p.sync_id != ''
      `).all<{ sync_id: string; user_id: string; ledger_id: string | null; source_change_id: number | null }>();

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

          // 将 payload 中的 ledger_id 从内部 D1 ID 转换为 external_id（Flutter 期望 external_id）
          if (payload.ledger_id && typeof payload.ledger_id === 'string') {
            const ledger = await db.prepare('SELECT external_id FROM ledgers WHERE id = ?').bind(payload.ledger_id).first<{ external_id: string }>();
            if (ledger) payload.ledger_id = ledger.external_id;
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
            serverLogger.error('src.routers.admin', `[FixData] Failed to insert sync_changes for ${pt.entityType} ${row.sync_id}:`, (err as Error).message);
          }
        }
        fixes[`sync_changes_${pt.entityType}`] = insertedCount;
      }
    } catch (err) {
      serverLogger.error('src.routers.admin', `[FixData] Failed processing ${pt.table}:`, (err as Error).message);
    }
  }

  return c.json({ fixes, message: 'Fixed sync_id and created missing sync_changes records' });
});

/**
 * GET /backup/restore-from-r2/list - 列出 R2 备份文件 + 内容概览（仅限管理员）
 */
backupRouter.get('/restore-from-r2/list', async (c) => {
  const db = c.env.DB;
  const userId = c.get('userId');
  const r2 = c.env.R2;
  if (!r2) return c.json({ error: 'R2 not configured' }, 400);

  const user = await db.prepare('SELECT is_admin FROM users WHERE id = ?').bind(userId).first<{ is_admin: number }>();
  if (!user || !user.is_admin) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const allObjects: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const listing = await r2.list({ prefix: 'beecount/backups/', limit: 100, cursor });
    allObjects.push(...listing.objects);
    cursor = listing.truncated ? listing.objects[listing.objects.length - 1].key : undefined;
  } while (cursor);

  const backupFiles = allObjects
    .filter(function(o) { return o.key.endsWith('.tar.gz'); })
    .sort(function(a, b) { return b.uploaded.getTime() - a.uploaded.getTime(); });

  // 检查前 10 个备份的内容摘要
  const backups: Record<string, unknown>[] = [];
  for (const obj of backupFiles.slice(0, 10)) {
    const entry: Record<string, unknown> = {
      key: obj.key,
      size: obj.size,
      uploaded: obj.uploaded.toISOString(),
    };

    try {
      const resp = await r2.get(obj.key);
      if (resp) {
        const ab = await resp.arrayBuffer();
        const raw = new Uint8Array(ab);
        const ds = new DecompressionStream('gzip');
        const w = ds.writable.getWriter();
        w.write(raw); w.close();
        const reader = ds.readable.getReader();
        const chunks: Uint8Array[] = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
        let totalLen = 0;
        for (const ch of chunks) totalLen += ch.length;
        const decompressed = new Uint8Array(totalLen);
        let off = 0;
        for (const ch of chunks) { decompressed.set(ch, off); off += ch.length; }

        // 解析 tar，找 db.json
        let tarOff = 0;
        while (tarOff < decompressed.length - 512) {
          const hdr = decompressed.slice(tarOff, tarOff + 512);
          const name = new TextDecoder().decode(hdr.slice(0, 100)).replace(/\0/g, '');
          if (!name) break;
          const sizeOct = new TextDecoder().decode(hdr.slice(124, 136)).replace(/\0/g, '').trim();
          const sz = parseInt(sizeOct, 8) || 0;
          const contentOff = tarOff + 512;

          if (name === 'db.json') {
            const jsonText = new TextDecoder().decode(decompressed.slice(contentOff, contentOff + sz));
            const dbJson = JSON.parse(jsonText);
            const tables = dbJson.tables || {};
            const summary: Record<string, number> = {};
            for (const [t, rows] of Object.entries(tables)) {
              summary[t] = Array.isArray(rows) ? rows.length : 0;
            }
            entry.summary = summary;
            entry.totalRows = Object.values(summary).reduce(function(s, n) { return s + n; }, 0);
          }
          tarOff = contentOff + Math.ceil(sz / 512) * 512;
        }
      }
    } catch (e) {
      entry.error = (e as Error).message;
    }

    backups.push(entry);
  }

  return c.json({ backups: backups });
});

/**
 * POST /backup/restore-from-r2 - 从 R2 备份恢复数据（仅限管理员）
 */
backupRouter.post('/restore-from-r2', async (c) => {
  const db = c.env.DB;
  const userId = c.get('userId');
  const r2 = c.env.R2;

  // 仅限管理员（与原版一致：恢复是管理员操作）
  const user = await db.prepare('SELECT is_admin FROM users WHERE id = ?').bind(userId).first<{ is_admin: number }>();
  if (!user || !user.is_admin) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  if (!r2) {
    return c.json({ error: 'R2 not configured' }, 400);
  }

  let body: { backupPath?: string; password?: string } = {};
  try { body = await c.req.json(); } catch {}
  const backupPath = body.backupPath;
  const password = body.password;

  let selectedPath = backupPath;
  if (!selectedPath) {
    // 先找当前用户的备份，没有则找全部
    let listing = await r2.list({ prefix: 'beecount/backups/' + userId + '/' });
    if (!listing.objects || listing.objects.length === 0) {
      listing = await r2.list({ prefix: 'beecount/backups/' });
    }
    if (!listing.objects || listing.objects.length === 0) {
      return c.json({ error: 'No backups found' }, 404);
    }
    selectedPath = listing.objects.sort(function(a, b) { return b.uploaded.getTime() - a.uploaded.getTime(); })[0].key;
  }

  try {
    var { performRestore } = await import('../lib/restore-service');
    var result = await performRestore(db, r2, selectedPath, function(progress) {
      console.debug('[Restore] ' + progress.phase + ': ' + progress.bytesTransferred + '/' + progress.bytesTotal);
    }, password);

    return c.json({
      success: result.success,
      message: result.message,
      backupFile: selectedPath,
      tablesImported: result.tablesImported,
      rowsImported: result.rowsImported,
      attachmentsUploaded: result.attachmentsUploaded,
    }, 200);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

export default backupRouter;