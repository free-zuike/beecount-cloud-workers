/**
 * 数据清理服务 - 扫描器
 *
 * 与原版 BeeCount-Cloud Python 的 src/services/data_cleanup/scanner.py 对齐。
 * 扫描数据库中的孤立数据（没有对应 sync_changes 的 projection 记录等）。
 */

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
    type: 'transaction' as const,
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
    type: 'category' as const,
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
    type: 'tag' as const,
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
    type: 'budget' as const,
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
    type: 'account' as const,
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
 * 扫描 AttachmentFile 行没被任何 tx (attachments_json) 或 category
 * (icon_cloud_file_id) 引用 — 对齐原版 _scan_attachment_no_ref (B1)。
 * 上传附件后未保存交易 / AI 草稿放弃 等场景会产生这类孤儿。
 */
async function scanAttachmentNoRef(db: D1Database): Promise<OrphanRecord[]> {
  const rows = await db.prepare(
    `SELECT id, user_id, size_bytes, file_name, storage_path, attachment_kind, sha256
     FROM attachment_files
     LIMIT ?`
  ).bind(MAX_ORPHANS).all<{
    id: string;
    user_id: string;
    size_bytes: number | null;
    file_name: string | null;
    storage_path: string;
    attachment_kind: string;
    sha256: string | null;
  }>();

  const orphans: OrphanRecord[] = [];
  for (const row of rows.results) {
    // 判定是否仍被引用（对齐原版 _fileid_still_referenced：tx 的 attachments_json
    // 两种空格变体 + category 图标的 icon_cloud_file_id；INSTR 避免 LIKE 模式复杂度限制）
    const patNoSpace = `"cloudFileId":"${row.id}"`;
    const patWithSpace = `"cloudFileId": "${row.id}"`;
    // App 端（Flutter）attachments_json 用 fileName（sha 哈希）而非 cloudFileId，
    // 格式：{"fileName":"sha_<sha256>.jpg"}，需同时检查
    const shaPat = row.sha256 ? `sha_${row.sha256}.jpg` : null;
    const txHit = await db.prepare(
      `SELECT COUNT(*) as cnt FROM read_tx_projection
       WHERE user_id = ? AND (INSTR(attachments_json, ?) > 0 OR INSTR(attachments_json, ?) > 0${shaPat ? ' OR INSTR(attachments_json, ?) > 0' : ''})`
    ).bind(row.user_id, patNoSpace, patWithSpace, ...(shaPat ? [shaPat] : [])).first<{ cnt: number }>();

    let stillReferenced = txHit && txHit.cnt > 0;
    if (!stillReferenced) {
      const catHit = await db.prepare(
        `SELECT COUNT(*) as cnt FROM read_category_projection
         WHERE user_id = ? AND icon_cloud_file_id = ?`
      ).bind(row.user_id, row.id).first<{ cnt: number }>();
      stillReferenced = catHit && catHit.cnt > 0;
    }

    if (stillReferenced) continue;

    orphans.push({
      type: 'attachment_no_ref' as const,
      user_id: row.user_id,
      row_id: row.id,
      title: row.file_name || row.id.slice(0, 12),
      subtitle: `附件无引用 · ${row.attachment_kind}`,
      file_path: row.storage_path,
      size_bytes: row.size_bytes ?? 0,
    });
  }

  return orphans;
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

  // 文件类孤立数据：附件行无任何引用（对齐原版 B1）
  const attachmentNoRef = await scanAttachmentNoRef(db);
  fileOrphans.push(...attachmentNoRef);

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
