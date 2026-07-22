/**
 * 数据清理服务 - 扫描器
 *
 * 与原版 BeeCount-Cloud Python 的 src/services/data_cleanup/scanner.py 对齐。
 * 扫描数据库中的孤立数据（没有对应 sync_changes 的 projection 记录等）。
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { OrphanRecord, ScanReport } from './types';

const MAX_ORPHANS = 100;

/**
 * 扫描 read_tx_projection 中没有对应 sync_changes 的交易记录
 */
async function scanTxMissingSyncChange(db: D1Database): Promise<OrphanRecord[]> {
  const result = await db.prepare(`
    SELECT p.sync_id, p.ledger_id, p.user_id FROM read_tx_projection p
    LEFT JOIN sync_changes c ON p.sync_id = c.entity_sync_id AND c.entity_type = 'transaction'
    WHERE c.change_id IS NULL
    LIMIT ?
  `).bind(MAX_ORPHANS).all<{ sync_id: string; ledger_id: string; user_id: string }>();

  return result.results.map((row) => ({
    type: 'sync_orphan' as const,
    user_id: row.user_id,
    sync_id: row.sync_id,
    ledger_id: row.ledger_id,
    title: `孤立交易投影 ${row.sync_id.substring(0, 8)}...`,
    subtitle: `ledger_id=${row.ledger_id.substring(0, 8)}...`,
    extra: { ledger_id: row.ledger_id },
  }));
}

/**
 * 扫描 read_category_projection 中没有对应 sync_changes 的分类记录
 */
async function scanCategoryMissingSyncChange(db: D1Database): Promise<OrphanRecord[]> {
  const result = await db.prepare(`
    SELECT r.sync_id, r.ledger_id, r.user_id, r.name FROM read_category_projection r
    LEFT JOIN sync_changes c ON r.sync_id = c.entity_sync_id AND c.entity_type = 'category'
    WHERE c.change_id IS NULL
    LIMIT ?
  `).bind(MAX_ORPHANS).all<{ sync_id: string; ledger_id: string; user_id: string; name: string }>();

  return result.results.map((row) => ({
    type: 'sync_orphan' as const,
    user_id: row.user_id,
    sync_id: row.sync_id,
    ledger_id: row.ledger_id,
    title: `孤立分类投影 ${row.name || row.sync_id.substring(0, 8)}`,
    subtitle: `categorySyncId=${row.sync_id.substring(0, 8)}...`,
    extra: { ledger_id: row.ledger_id },
  }));
}

/**
 * 扫描 read_tag_projection 中没有对应 sync_changes 的标签记录
 */
async function scanTagMissingSyncChange(db: D1Database): Promise<OrphanRecord[]> {
  const result = await db.prepare(`
    SELECT r.sync_id, r.ledger_id, r.user_id, r.name FROM read_tag_projection r
    LEFT JOIN sync_changes c ON r.sync_id = c.entity_sync_id AND c.entity_type = 'tag'
    WHERE c.change_id IS NULL
    LIMIT ?
  `).bind(MAX_ORPHANS).all<{ sync_id: string; ledger_id: string; user_id: string; name: string }>();

  return result.results.map((row) => ({
    type: 'sync_orphan' as const,
    user_id: row.user_id,
    sync_id: row.sync_id,
    ledger_id: row.ledger_id,
    title: `孤立标签投影 ${row.name || row.sync_id.substring(0, 8)}`,
    subtitle: `tagSyncId=${row.sync_id.substring(0, 8)}...`,
    extra: { ledger_id: row.ledger_id },
  }));
}

/**
 * 扫描 read_budget_projection 中没有对应 sync_changes 的预算记录
 */
async function scanBudgetMissingSyncChange(db: D1Database): Promise<OrphanRecord[]> {
  const result = await db.prepare(`
    SELECT r.sync_id, r.ledger_id, r.user_id, r.budget_type FROM read_budget_projection r
    LEFT JOIN sync_changes c ON r.sync_id = c.entity_sync_id AND c.entity_type = 'budget'
    WHERE c.change_id IS NULL
    LIMIT ?
  `).bind(MAX_ORPHANS).all<{ sync_id: string; ledger_id: string; user_id: string; budget_type: string }>();

  return result.results.map((row) => ({
    type: 'sync_orphan' as const,
    user_id: row.user_id,
    sync_id: row.sync_id,
    ledger_id: row.ledger_id,
    title: `孤立预算投影 ${row.budget_type} ${row.sync_id.substring(0, 8)}`,
    subtitle: `budgetType=${row.budget_type}, ledgerId=${row.ledger_id.substring(0, 8)}...`,
    extra: { ledger_id: row.ledger_id },
  }));
}

/**
 * 扫描 read_account_projection 中没有对应 sync_changes 的账户记录
 */
async function scanAccountMissingSyncChange(db: D1Database): Promise<OrphanRecord[]> {
  const result = await db.prepare(`
    SELECT r.sync_id, r.ledger_id, r.user_id, r.name FROM read_account_projection r
    LEFT JOIN sync_changes c ON r.sync_id = c.entity_sync_id AND c.entity_type = 'account'
    WHERE c.change_id IS NULL
    LIMIT ?
  `).bind(MAX_ORPHANS).all<{ sync_id: string; ledger_id: string; user_id: string; name: string }>();

  return result.results.map((row) => ({
    type: 'sync_orphan' as const,
    user_id: row.user_id,
    sync_id: row.sync_id,
    ledger_id: row.ledger_id,
    title: `孤立账户投影 ${row.name || row.sync_id.substring(0, 8)}`,
    subtitle: `accountSyncId=${row.sync_id.substring(0, 8)}...`,
    extra: { ledger_id: row.ledger_id },
  }));
}

/**
 * 扫描 sync_changes 中引用了不存在实体的记录
 */
async function scanSyncChangeMissingEntity(db: D1Database): Promise<OrphanRecord[]> {
  // 查找 entity_type=transaction 但在 read_tx_projection 中不存在的 sync_changes
  const result = await db.prepare(`
    SELECT sc.change_id, sc.entity_sync_id, sc.entity_type, sc.ledger_id, sc.user_id
    FROM sync_changes sc
    LEFT JOIN read_tx_projection p ON sc.entity_sync_id = p.sync_id AND sc.entity_type = 'transaction'
    WHERE sc.entity_type = 'transaction' AND p.sync_id IS NULL
    LIMIT ?
  `).bind(MAX_ORPHANS).all<{ change_id: number; entity_sync_id: string; entity_type: string; ledger_id: string; user_id: string }>();

  return result.results.map((row) => ({
    type: 'sync_orphan' as const,
    user_id: row.user_id,
    sync_id: row.entity_sync_id,
    row_id: String(row.change_id),
    ledger_id: row.ledger_id,
    title: `孤立sync_change #${row.change_id}`,
    subtitle: `entity=${row.entity_type}, syncId=${row.entity_sync_id.substring(0, 8)}...`,
    extra: { ledger_id: row.ledger_id, change_id: row.change_id },
  }));
}

/**
 * 扫描所有类型的孤立数据，返回完整的扫描报告。
 * 与原版 scan_all() 对齐。
 */
export async function scanAll(db: D1Database): Promise<ScanReport> {
  const dbOrphans: OrphanRecord[] = [];
  const fileOrphans: OrphanRecord[] = [];
  const syncOrphans: OrphanRecord[] = [];

  // DB 孤立数据
  const txMissingCategory = await scanTxMissingSyncChange(db);
  const accountMissing = await scanAccountMissingSyncChange(db);
  const categoryMissing = await scanCategoryMissingSyncChange(db);
  const tagMissing = await scanTagMissingSyncChange(db);
  const budgetMissing = await scanBudgetMissingSyncChange(db);

  syncOrphans.push(...txMissingCategory, ...accountMissing, ...categoryMissing, ...tagMissing, ...budgetMissing);

  // 同步变更孤立数据
  const syncChangeOrphans = await scanSyncChangeMissingEntity(db);
  syncOrphans.push(...syncChangeOrphans);

  let totalSizeBytes = 0;
  for (const orphan of fileOrphans) {
    totalSizeBytes += orphan.size_bytes ?? 0;
  }

  return {
    db_orphans: dbOrphans,
    file_orphans: fileOrphans,
    sync_orphans: syncOrphans,
    total_count: dbOrphans.length + fileOrphans.length + syncOrphans.length,
    total_size_bytes: totalSizeBytes,
  };
}
