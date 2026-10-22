// 移植上游 tests/test_backup_retention.py
// 保留策略纯函数测试:文件名解析、备份文件筛选、按 retention_days 计算待删列表。
import { describe, expect, it } from 'vitest';
import {
  parseBackupFilename,
  filterBackupFiles,
  computeRetentionDeletes,
  type RemoteFile,
} from '../src/services/backup-retention';

function t(spec: string): Date {
  return new Date(`${spec}T00:00:00.000Z`);
}

describe('备份保留策略', () => {
  it('解析合法 tar 文件名', () => {
    const parsed = parseBackupFilename('20260612-040000Z.tar.gz');
    expect(parsed).not.toBeNull();
    expect(parsed!.toISOString()).toBe('2026-06-12T04:00:00.000Z');
  });

  it('解析非法文件名返回 null', () => {
    expect(parseBackupFilename('not-a-backup.txt')).toBeNull();
    expect(parseBackupFilename('backup-20260612.tar.gz')).toBeNull();
    expect(parseBackupFilename('20260612-040000Z.tar')).toBeNull();
  });

  it('筛选备份文件时跳过目录与未知文件', () => {
    const files = filterBackupFiles([
      { Name: '20260610-040000Z.tar.gz', IsDir: false },
      { Name: '20260611-040000Z.tar.gz', IsDir: false },
      { Name: 'subdir', IsDir: true },
      { Name: 'README.md', IsDir: false },
    ]);
    expect(files.length).toBe(2);
    expect(new Set(files.map((f) => f.name))).toEqual(
      new Set(['20260610-040000Z.tar.gz', '20260611-040000Z.tar.gz'])
    );
  });

  it('按保留天数计算基本待删列表', () => {
    const files: RemoteFile[] = [
      { name: '20260601-040000Z.tar.gz', timestamp: t('2026-06-01') },
      { name: '20260605-040000Z.tar.gz', timestamp: t('2026-06-05') },
      { name: '20260612-040000Z.tar.gz', timestamp: t('2026-06-12') },
    ];
    const toDelete = computeRetentionDeletes(files, 7, t('2026-06-15'));
    expect(new Set(toDelete.map((f) => f.name))).toEqual(
      new Set(['20260601-040000Z.tar.gz', '20260605-040000Z.tar.gz'])
    );
  });

  it('保留期极短时至少保留一份', () => {
    const files: RemoteFile[] = [
      { name: '20260101-040000Z.tar.gz', timestamp: t('2026-01-01') },
      { name: '20260102-040000Z.tar.gz', timestamp: t('2026-01-02') },
      { name: '20260103-040000Z.tar.gz', timestamp: t('2026-01-03') },
    ];
    const toDelete = computeRetentionDeletes(files, 1, t('2026-06-15'), 1);
    const deletedNames = new Set(toDelete.map((f) => f.name));
    expect(deletedNames.has('20260103-040000Z.tar.gz')).toBe(false);
    expect(toDelete.length).toBe(2);
  });

  it('空输入返回空列表', () => {
    expect(computeRetentionDeletes([], 30)).toEqual([]);
  });

  it('全部在保留期内时无待删项', () => {
    const files: RemoteFile[] = [
      { name: '20260610-040000Z.tar.gz', timestamp: t('2026-06-10') },
      { name: '20260611-040000Z.tar.gz', timestamp: t('2026-06-11') },
    ];
    expect(computeRetentionDeletes(files, 30, t('2026-06-15'))).toEqual([]);
  });

  it('retention_days 为 0 或负数时夹到 1,不能删光备份', () => {
    const files: RemoteFile[] = [
      { name: '20260610-040000Z.tar.gz', timestamp: t('2026-06-10') },
      { name: '20260614-040000Z.tar.gz', timestamp: t('2026-06-14') },
    ];
    const toDelete = computeRetentionDeletes(files, 0, t('2026-06-15'), 1);
    expect(toDelete.map((f) => f.name)).not.toContain('20260614-040000Z.tar.gz');
  });
});