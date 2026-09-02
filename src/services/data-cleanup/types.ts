/**
 * 数据清理服务 - 类型定义
 *
 * 与原版 BeeCount-Cloud Python 的 src/services/data_cleanup/models.py 对齐。
 * OrphanType 枚举值跟原版 plan A1..A5 / B1..B4 一一对应。
 */

export type OrphanType =
  // A 类：DB 引用断链（实体引用已删）
  | 'tx_missing_category'        // A1: 交易 category_sync_id 已删
  | 'tx_missing_account'         // A2: 交易 account_sync_id 已删
  | 'tx_missing_from_account'    // A3a: 转账 from_account_sync_id 已删
  | 'tx_missing_to_account'      // A3b: 转账 to_account_sync_id 已删
  | 'budget_missing_category'    // A4: 预算 category_sync_id 已删
  | 'sync_change_missing_entity' // A5/C1: sync_changes 引用实体不存在
  // B 类：附件 / 文件
  | 'attachment_no_ref'          // B1: AttachmentFile 行无 tx/category 引用
  | 'attachment_file_missing'    // B2: storage_path 指向的 R2 对象不存在
  | 'disk_file_no_row'           // B3: R2 有对象但 attachment_files 无行
  | 'tx_ref_broken_attachment';  // B4: tx.attachments_json 引用 fileId 不存在

export interface OrphanRecord {
  type: OrphanType;
  title: string;    // UI 主标题
  subtitle: string; // UI 副标题
  user_id?: string;
  row_id?: string;  // 主表行 id（DB 类）— str 兼容 UUID / int
  sync_id?: string;
  file_path?: string; // B 类（R2 key / storage_path）
  size_bytes?: number;
  extra?: Record<string, unknown>; // cleaner 内部用
}

export interface ScanReport {
  db_orphans: OrphanRecord[];   // A 类
  file_orphans: OrphanRecord[]; // B 类
  sync_orphans: OrphanRecord[]; // C 类（A5/C1 归这里，与原版 scan_all 一致）
  total_count: number;
  total_size_bytes: number;
}

export interface CleanupRecord {
  type: OrphanType;
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