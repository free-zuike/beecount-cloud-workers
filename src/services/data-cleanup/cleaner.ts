/**
 * 数据清理服务 - 清理器
 *
 * 与原版 BeeCount-Cloud Python 的 src/services/data_cleanup/cleaner.py 对齐。
 * 逐条清理孤立数据，避免长事务持锁。
 */

import type { CleanupRecord, CleanupResult } from './types';

/**
 * 清理孤立数据记录。按 type 分发清理操作，与原版 _dispatch 对齐。
 * [r2] 可选：附件/文件类孤儿清理时删除 R2 物理对象（对齐原版 file_ops）。
 */
export async function clean(
  db: D1Database,
  records: CleanupRecord[],
  r2?: R2Bucket
): Promise<CleanupResult> {
  let successCount = 0;
  const failures: Array<{ record_key: string; error: string }> = [];

  for (const record of records) {
    const recordKey = record.sync_id || record.row_id || record.file_path || 'unknown';
    try {
      const extra = record.extra || {};

      switch (record.type) {
        case 'tx_missing_category':
          // A1: 清空交易的分类引用（保留交易本体）
          await clearTxField(db, record, 'category_sync_id', 'category_name');
          break;
        case 'tx_missing_account':
          // A2: 清空交易的账户引用
          await clearTxField(db, record, 'account_sync_id', 'account_name');
          break;
        case 'tx_missing_from_account':
          // A3a: 清空转账转出账户引用
          await clearTxField(db, record, 'from_account_sync_id', 'from_account_name');
          break;
        case 'tx_missing_to_account':
          // A3b: 清空转账转入账户引用
          await clearTxField(db, record, 'to_account_sync_id', 'to_account_name');
          break;
        case 'budget_missing_category':
          // A4: 清空预算的分类引用（保留预算本体）
          await clearBudgetCategory(db, record);
          break;
        case 'sync_change_missing_entity': {
          // A5/C1: 删除孤立 sync_change
          if (record.row_id) {
            await db.prepare('DELETE FROM sync_changes WHERE change_id = ?').bind(Number(record.row_id)).run();
          } else {
            throw new Error('sync_change record 缺 row_id');
          }
          break;
        }
        case 'attachment_no_ref':
          // B1: 删 AttachmentFile 行 + R2 物理对象（best-effort）。对齐原版
          // _delete_attachment_with_file：DB 行删除是事实，R2 unlink 失败不阻塞。
          await deleteAttachmentWithFile(db, record, r2);
          break;
        case 'attachment_file_missing':
          // B2: R2 对象已丢，只删 DB 行
          await deleteAttachmentRowOnly(db, record);
          break;
        case 'disk_file_no_row':
          // B3: DB 没记录，只删 R2 对象
          await deleteR2FileOnly(db, r2, record);
          break;
        case 'tx_ref_broken_attachment':
          // B4: 从 read_tx_projection.attachments_json 剥离失效附件
          await stripBrokenAttachments(db, record);
          break;
        default:
          throw new Error(`Unsupported cleanup type: ${record.type}`);
      }
      successCount++;
    } catch (err) {
      failures.push({
        record_key: recordKey,
        error: (err as Error).message,
      });
    }
  }

  return { success_count: successCount, failures };
}

/** 从 record.extra 解析 (ledger_id, sync_id)，缺则抛错（对齐原版 _ledger_sync_from_record） */
function ledgerSyncFromRecord(record: CleanupRecord): { ledgerId: string; syncId: string } {
  const extra = record.extra || {};
  const ledgerId = String(extra.ledger_id || '');
  const syncId = record.sync_id || String(extra.sync_id || '');
  if (!ledgerId || !syncId) {
    throw new Error(`record ${record.sync_id || record.row_id || 'unknown'} 缺 ledger_id/sync_id`);
  }
  return { ledgerId, syncId };
}

/** A1/A2/A3: 把 ReadTxProjection 的 *_sync_id 和 *_name 字段置 NULL，保留交易本体 */
async function clearTxField(
  db: D1Database,
  record: CleanupRecord,
  syncIdCol: string,
  nameCol: string,
): Promise<void> {
  const { ledgerId, syncId } = ledgerSyncFromRecord(record);
  await db.prepare(
    `UPDATE read_tx_projection SET ${syncIdCol} = NULL, ${nameCol} = NULL WHERE ledger_id = ? AND sync_id = ?`
  ).bind(ledgerId, syncId).run();
}

/** A4: ReadBudgetProjection.category_sync_id 置 NULL */
async function clearBudgetCategory(db: D1Database, record: CleanupRecord): Promise<void> {
  const { ledgerId, syncId } = ledgerSyncFromRecord(record);
  await db.prepare(
    `UPDATE read_budget_projection SET category_sync_id = NULL WHERE ledger_id = ? AND sync_id = ?`
  ).bind(ledgerId, syncId).run();
}

/** B1: 删 AttachmentFile 行（同事务）+ R2 对象（best-effort），对齐原版 _delete_attachment_with_file */
async function deleteAttachmentWithFile(
  db: D1Database,
  record: CleanupRecord,
  r2?: R2Bucket,
): Promise<void> {
  if (!record.row_id) throw new Error('attachment record 缺 row_id');
  const att = await db.prepare(
    'SELECT storage_path FROM attachment_files WHERE id = ?'
  ).bind(record.row_id).first<{ storage_path: string }>();
  await db.prepare('DELETE FROM attachment_files WHERE id = ?').bind(record.row_id).run();
  if (att?.storage_path && r2) {
    try {
      await r2.delete(att.storage_path);
    } catch {
      // R2 unlink 失败不阻塞（对齐原版 warn 不抛）
    }
  }
}

/** B2: R2 对象已丢，只删 DB 行 */
async function deleteAttachmentRowOnly(db: D1Database, record: CleanupRecord): Promise<void> {
  if (!record.row_id) throw new Error('attachment record 缺 row_id');
  await db.prepare('DELETE FROM attachment_files WHERE id = ?').bind(record.row_id).run();
}

/** B3: DB 没记录，只删 R2 对象 */
async function deleteR2FileOnly(
  db: D1Database,
  r2: R2Bucket | undefined,
  record: CleanupRecord,
): Promise<void> {
  if (!r2) throw new Error('R2 not configured for disk_file_no_row cleanup');
  if (!record.file_path) throw new Error('disk file record 缺 file_path');
  try {
    await r2.delete(record.file_path);
  } catch {
    // R2 删除失败不阻断当前 record（对齐原版 file_ops best-effort）
  }
}

/** B4: 从 ReadTxProjection.attachments_json 移除指向不存在 fileId 的项，保留 tx 本体 */
async function stripBrokenAttachments(db: D1Database, record: CleanupRecord): Promise<void> {
  const { ledgerId, syncId } = ledgerSyncFromRecord(record);
  const broken = (record.extra || {}).broken_file_ids;
  const brokenSet = Array.isArray(broken) ? new Set<string>(broken as string[]) : new Set<string>();
  if (brokenSet.size === 0) return;

  const row = await db.prepare(
    `SELECT attachments_json FROM read_tx_projection WHERE ledger_id = ? AND sync_id = ?`
  ).bind(ledgerId, syncId).first<{ attachments_json: string | null }>();
  if (!row || !row.attachments_json) return;

  let atts: unknown;
  try {
    atts = JSON.parse(row.attachments_json);
  } catch {
    return;
  }
  if (!Array.isArray(atts)) return;

  const kept = atts.filter(
    (a) => !(a && typeof a === 'object' && (a as Record<string, unknown>).cloudFileId
      && brokenSet.has(String((a as Record<string, unknown>).cloudFileId)))
  );
  if (kept.length === atts.length) return; // 没有可移除项

  await db.prepare(
    `UPDATE read_tx_projection SET attachments_json = ? WHERE ledger_id = ? AND sync_id = ?`
  ).bind(JSON.stringify(kept), ledgerId, syncId).run();
}