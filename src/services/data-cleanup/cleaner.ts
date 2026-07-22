/**
 * 数据清理服务 - 清理器
 *
 * 与原版 BeeCount-Cloud Python 的 src/services/data_cleanup/cleaner.py 对齐。
 * 逐条清理孤立数据，避免长事务持锁。
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { CleanupRecord, CleanupResult } from './types';

/**
 * 清理孤立数据记录。
 * 每条记录独立事务提交/回滚，与原版对齐。
 */
export async function clean(
  db: D1Database,
  records: CleanupRecord[]
): Promise<CleanupResult> {
  let successCount = 0;
  const failures: Array<{ record_key: string; error: string }> = [];

  for (const record of records) {
    try {
      const recordKey = record.sync_id || record.row_id || record.file_path || 'unknown';

      if (record.sync_id && record.type === 'transaction') {
        // 清理孤立交易投影
        await db.prepare('DELETE FROM read_tx_projection WHERE sync_id = ?')
          .bind(record.sync_id).run();
        successCount++;
      } else if (record.sync_id && record.type === 'category') {
        // 清理孤立分类投影
        await db.prepare('DELETE FROM read_category_projection WHERE sync_id = ?')
          .bind(record.sync_id).run();
        successCount++;
      } else if (record.sync_id && record.type === 'tag') {
        // 清理孤立标签投影
        await db.prepare('DELETE FROM read_tag_projection WHERE sync_id = ?')
          .bind(record.sync_id).run();
        successCount++;
      } else if (record.sync_id && record.type === 'budget') {
        // 清理孤立预算投影
        await db.prepare('DELETE FROM read_budget_projection WHERE sync_id = ?')
          .bind(record.sync_id).run();
        successCount++;
      } else if (record.sync_id && record.type === 'account') {
        // 清理孤立账户投影
        await db.prepare('DELETE FROM read_account_projection WHERE sync_id = ?')
          .bind(record.sync_id).run();
        successCount++;
      } else if (record.row_id && record.type === 'sync_orphan') {
        // 清理孤立 sync_change
        await db.prepare('DELETE FROM sync_changes WHERE change_id = ?')
          .bind(Number(record.row_id)).run();
        successCount++;
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
