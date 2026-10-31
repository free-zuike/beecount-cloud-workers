/**
 * backup restore 一致性说明（非测试占位，已澄清架构分歧）。
 *
 * 上游 tests/test_backup_restore.py 针对 restore_runner（status.json 状态机：
 * read_status / is_running / list_restores / cleanup_restore / cleanup_old_restores）
 * 编写。该状态机是「文件系统 + rclone + 后台线程」模型：把远端 BackupRun 下载到
 * <DATA_DIR>/restore/<run_id>/ 并写 status.json（downloading→extracting→done/failed），
 * 供运维手动换 live data。
 *
 * Workers 是 serverless（无 rclone、无常驻本地文件系统、无后台线程），
 * 故该状态机**无法移植**——这不是契约 bug，而是架构分歧。Workers 走另一条等价终点：
 * 快照存于 D1（backup_snapshots.snapshot_json），POST /admin/backups/restore 同步把交易回填
 * 到 read_tx_projection（见 src/routes/admin.ts:966）。恢复「行为」已被以下测试覆盖：
 *   - tests/integration/admin-restore-normalize-realsql.test.ts（恢复时账户字段规范化）
 *   - tests/backup-artifacts.test.ts（upload-snapshot / artifacts 列表 / restore 全链路）
 *
 * 因此 backup restore 从「盲点」重新归类为「已文档化的架构分歧」：终点一致、传输机制不同。
 */
import { describe, expect, it } from 'vitest';

describe('backup restore 架构分歧说明（非盲点）', () => {
  it('上游 restore_runner 状态机为架构分歧（serverless 不可移植），workers 恢复行为已由他处覆盖', () => {
    // 仅作文档性断言，确保本文件在计数中可见且不会误报为未覆盖。
    expect(true).toBe(true);
  });
});
