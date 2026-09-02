/**
 * 数据清理服务 - 清理器
 *
 * 与原版 BeeCount-Cloud Python 的 src/services/data_cleanup/cleaner.py 对齐。
 * 逐条清理孤立数据，避免长事务持锁。
 */

import type { CleanupRecord, CleanupResult } from './types';

/**
 * 清理孤立数据记录。
 * 按 type 分发清理操作，与原版 _dispatch 对齐。
 * [r2] 可选：附件孤儿清理时删除 R2 物理文件（对齐原版 file_ops）。
 */
export async function clean(
  db: D1Database,
  records: CleanupRecord[],
  r2?: R2Bucket
): Promise<CleanupResult> {
  let successCount = 0;
  const failures: Array<{ record_key: string; error: string }> = [];

  for (const record of records) {
    try {
      const recordKey = record.sync_id || record.row_id || record.file_path || 'unknown';
      const extra = record.extra || {};

      if (record.type === 'tx_missing_category') {
        // A1: 清空交易的分类引用（保留交易本体）
        await clearTxField(db, record, 'category_sync_id', 'category_name');
        successCount++;
      } else if (record.type === 'tx_missing_account') {
        // A2: 清空交易的账户引用
        await clearTxField(db, record, 'account_sync_id', 'account_name');
        successCount++;
      } else if (record.type === 'tx_from_account') {
        // A3a: 清空转账转出账户引用
        await clearTxField(db, record, 'from_account_sync_id', 'from_account_name');
        successCount++;
      } else if (record.type === 'tx_to_account') {
        // A3b: 清空转账转入账户引用
        await clearTxField(db, record, 'to_account_sync_id', 'to_account_name');
        successCount++;
      } else if (record.type === 'budget_missing_category') {
        // A4: 清空预算的分类引用（保留预算本体）
        const ledgerId = String(extra.ledger_id || '');
        const syncId = record.sync_id || String(extra.sync_id || '');
        await db.prepare(
          `UPDATE read_budget_projection SET category_sync_id = NULL WHERE ledger_id = ? AND sync_id = ?`
        ).bind(ledgerId, syncId).run();
        successCount++;
      } else if (record.type === 'sync_orphan' || record.type === 'sync_change_missing_entity') {
        // C1: 删除孤立 sync_change
        if (record.row_id) {
          const changeId = Number(record.row_id);
          await db.prepare('DELETE FROM sync_changes WHERE change_id = ?').bind(changeId).run();
          successCount++;
        } else {
          failures.push({ record_key: recordKey, error: 'sync_change record 缺 row_id' });
        }
      } else if (record.type === 'transaction') {
        // Workers 特有：投影无 sync_changes → 删除投影行
        if (record.sync_id) {
          await db.prepare('DELETE FROM read_tx_projection WHERE sync_id = ?').bind(record.sync_id).run();
          successCount++;
        } else {
          failures.push({ record_key: recordKey, error: 'transaction record 缺 sync_id' });
        }
      } else if (record.type === 'category') {
        if (record.sync_id) {
          await db.prepare('DELETE FROM user_category_projection WHERE sync_id = ?').bind(record.sync_id).run();
          successCount++;
        } else {
          failures.push({ record_key: recordKey, error: 'category record 缺 sync_id' });
        }
      } else if (record.type === 'tag') {
        if (record.sync_id) {
          await db.prepare('DELETE FROM user_tag_projection WHERE sync_id = ?').bind(record.sync_id).run();
          successCount++;
        } else {
          failures.push({ record_key: recordKey, error: 'tag record 缺 sync_id' });
        }
      } else if (record.type === 'budget') {
        if (record.sync_id) {
          await db.prepare('DELETE FROM read_budget_projection WHERE sync_id = ?').bind(record.sync_id).run();
          successCount++;
        } else {
          failures.push({ record_key: recordKey, error: 'budget record 缺 sync_id' });
        }
      } else if (record.type === 'account') {
        if (record.sync_id) {
          await db.prepare('DELETE FROM user_account_projection WHERE sync_id = ?').bind(record.sync_id).run();
          successCount++;
        } else {
          failures.push({ record_key: recordKey, error: 'account record 缺 sync_id' });
        }
      } else if (record.type === 'attachment_no_ref') {
        // B1: 删 AttachmentFile 行 + R2 物理文件（best-effort）。对齐原版
        // _delete_attachment_with_file：DB 行删除是事实，R2 unlink 失败不阻塞。
        if (record.row_id) {
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
          successCount++;
        } else {
          failures.push({ record_key: recordKey, error: 'attachment record 缺 row_id' });
        }
      } else {
        failures.push({
          record_key: recordKey,
          error: `Unsupported cleanup type: ${record.type}`,
        });
      }
    } catch (err) {
      failures.push({
        record_key: record.sync_id || record.row_id || 'unknown',
        error: (err as Error).message,
      });
    }
  }

  return { success_count: successCount, failures };
}

/**
 * 清空交易的指定引用字段（与原版 _clear_tx_field 对齐）
 */
async function clearTxField(
  db: D1Database,
  record: CleanupRecord,
  syncIdCol: string,
  nameCol: string,
): Promise<void> {
  const extra = record.extra || {};
  const ledgerId = String(extra.ledger_id || '');
  const syncId = record.sync_id || String(extra.sync_id || '');

  if (!ledgerId || !syncId) {
    throw new Error(`record 缺 ledger_id/sync_id`);
  }

  await db.prepare(
    `UPDATE read_tx_projection SET ${syncIdCol} = NULL, ${nameCol} = NULL WHERE ledger_id = ? AND sync_id = ?`
  ).bind(ledgerId, syncId).run();
}
