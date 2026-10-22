import { describe, expect, it } from 'vitest';
import { analyticsRange, bucketKey } from '../src/routes/workspace';

// 移植上游 tests/test_analytics_month_start_day.py:
// _analytics_range:周期按起始月命名,本地时间起点折算 UTC;12 月跨年;
// 年 = [当年1月起点, 次年1月起点);默认 msd=1 行为不变。
// _bucket_key:year scope 按 msd 切桶回退上一周期标签;month scope 日粒度不变。
describe('analytics month_start_day(移植上游 test_analytics_month_start_day.py)', () => {
  it('month scope 尊重 msd=10 + tz=480', () => {
    const { startAt, endAt, normalizedPeriod } = analyticsRange('month', '2026-06', 480, 10);
    // 本地(UTC+8) 2026-06-10 00:00 → UTC 2026-06-09 16:00
    expect(startAt).toBe('2026-06-09T16:00:00.000Z');
    expect(endAt).toBe('2026-07-09T16:00:00.000Z');
    expect(normalizedPeriod).toBe('2026-06');
  });

  it('month scope 12 月跨年', () => {
    const { startAt, endAt } = analyticsRange('month', '2026-12', 0, 10);
    expect(startAt).toBe('2026-12-10T00:00:00.000Z');
    expect(endAt).toBe('2027-01-10T00:00:00.000Z');
  });

  it('year scope 尊重 msd 起点', () => {
    const { startAt, endAt } = analyticsRange('year', '2026', 0, 10);
    expect(startAt).toBe('2026-01-10T00:00:00.000Z');
    expect(endAt).toBe('2027-01-10T00:00:00.000Z');
  });

  it('默认 msd=1 保持自然月', () => {
    const { startAt, endAt } = analyticsRange('month', '2026-06', 0, 1);
    expect(startAt).toBe('2026-06-01T00:00:00.000Z');
    expect(endAt).toBe('2026-07-01T00:00:00.000Z');
  });

  it('bucket_key year scope 用周期标签(msd=10)', () => {
    // 2027-01-05 属 2026-12 周期;2027-01-10 起属 2027-01
    expect(bucketKey('year', '2027-01-05T12:00:00.000Z', 0, 10)).toBe('2026-12');
    expect(bucketKey('year', '2027-01-10T12:00:00.000Z', 0, 10)).toBe('2027-01');
  });

  it('bucket_key month scope 不变(日粒度)', () => {
    expect(bucketKey('month', '2026-06-05T12:00:00.000Z', 0, 10)).toBe('2026-06-05');
  });
});