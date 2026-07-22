/**
 * 数据清理服务 - 类型定义
 *
 * 与原版 BeeCount-Cloud Python 的 src/services/data_cleanup/models.py 对齐。
 */

export type OrphanType =
  | 'db_orphan'
  | 'file_orphan'
  | 'sync_orphan'
  | 'tx_missing_category'
  | 'tx_missing_account'
  | 'tx_from_account'
  | 'tx_to_account'
  | 'budget_missing_category'
  | 'attachment_no_ref'
  | 'attachment_file_missing'
  | 'tx_ref_broken_attachment'
  | 'sync_change_missing_entity';

export interface OrphanRecord {
  type: OrphanType;
  user_id: string;
  row_id?: string;
  sync_id?: string;
  title: string;
  subtitle: string;
  file_path?: string;
  size_bytes?: number;
  extra?: Record<string, unknown>;
}

export interface ScanReport {
  db_orphans: OrphanRecord[];
  file_orphans: OrphanRecord[];
  sync_orphans: OrphanRecord[];
  total_count: number;
  total_size_bytes: number;
}

export interface CleanupRecord {
  type: string;
  title?: string;
  subtitle?: string;
  user_id?: string;
  row_id?: string;
  sync_id?: string;
  file_path?: string;
  size_bytes?: number;
  extra?: Record<string, unknown>;
}

export interface CleanupResult {
  success_count: number;
  failures: Array<{ record_key: string; error: string }>;
}
