// 上游 tests/test_backup_restore.py 针对 restore_runner(status.json 状态机:
// read_status/is_running/list_restores/cleanup_restore/cleanup_old_restores)编写。
// 本地无对应模块(恢复走 R2 下载 + backup_restores 表,没有 status.json 状态机),
// 全文件无对口实现可移植,保留此占位以便运行计数可见。
import { describe, expect, it } from 'vitest';

describe('backup restore 移植说明', () => {
  it('上游 restore_runner 状态机在本地无对应模块,本文件跳过', () => {
    expect(true).toBe(true);
  });
});