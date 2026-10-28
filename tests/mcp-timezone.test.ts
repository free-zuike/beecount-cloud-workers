/**
 * 时区与 DST 对齐（上游 src/mcp/datetime_utils.py + query_context.date_boundary）。
 *
 * - 裸时间按 Cloud 配置时区解释，其次才是调用方 time_zone；都没有 → 报错并给指引
 * - DST 回拨（歧义）/ 跳时（不存在）不再静默取一个候选，要求显式 UTC 偏移
 * - 查询边界同样做消歧
 */
import { describe, expect, it } from 'vitest';
import { parseDateBoundary, wallTimeCandidates } from '../src/mcp/query-context';
import { parseTxDatetime } from '../src/mcp/transaction-service';

describe('交易时间解析（对齐上游 parse_transaction_datetime）', () => {
  it('显式偏移优先，直接转 UTC', () => {
    expect(parseTxDatetime('2026-01-01T08:00:00+08:00')).toBe('2026-01-01T00:00:00.000Z');
    expect(parseTxDatetime('2026-01-01T00:00:00Z')).toBe('2026-01-01T00:00:00.000Z');
  });

  it('裸时间 + 无时区来源 → 报错并给出可执行指引（不静默按 UTC）', () => {
    expect(() => parseTxDatetime('2026-01-01T00:00:00')).toThrow(/Timezone required for happened_at without an offset/);
    expect(() => parseTxDatetime('2026-01-01T00:00:00')).toThrow(/Do not append Z to local time/);
    expect(() => parseTxDatetime('   ')).toThrow(/happened_at must be a non-empty ISO date or datetime/);
    expect(() => parseTxDatetime('not-a-date')).toThrow(/happened_at must be an ISO date or datetime/);
  });

  it('裸时间按 time_zone 解释（Asia/Shanghai = UTC+8）', () => {
    expect(parseTxDatetime('2026-01-01T00:00:00', 'Asia/Shanghai')).toBe('2025-12-31T16:00:00.000Z');
    expect(parseTxDatetime('2026-06-01T12:00:00', 'Asia/Shanghai')).toBe('2026-06-01T04:00:00.000Z');
  });

  it('Cloud 配置时区优先于调用方 time_zone', () => {
    expect(parseTxDatetime('2026-01-01T00:00:00', 'UTC', 'Asia/Shanghai')).toBe('2025-12-31T16:00:00.000Z');
  });

  it('非法时区 → Invalid IANA time zone', () => {
    expect(() => parseTxDatetime('2026-01-01T00:00:00', 'Mars/Olympus')).toThrow(/Invalid IANA time zone/);
  });

  it('DST 回拨造成的歧义时间 → 要求真实偏移', () => {
    // 2026-11-01 01:30 在 America/New_York 出现两次
    expect(() => parseTxDatetime('2026-11-01T01:30:00', 'America/New_York')).toThrow(/happened_at is ambiguous in America\/New_York/);
    expect(wallTimeCandidates(new Date(Date.UTC(2026, 10, 1, 1, 30)), 'America/New_York')).toHaveLength(2);
  });

  it('DST 跳时造成的不存在时间 → 要求真实偏移', () => {
    // 2026-03-08 02:30 在 America/New_York 不存在
    expect(() => parseTxDatetime('2026-03-08T02:30:00', 'America/New_York')).toThrow(/happened_at is nonexistent in America\/New_York/);
    expect(wallTimeCandidates(new Date(Date.UTC(2026, 2, 8, 2, 30)), 'America/New_York')).toHaveLength(0);
  });

  it('非歧义时间正常解析（含 DST 生效期）', () => {
    expect(parseTxDatetime('2026-07-01T12:00:00', 'America/New_York')).toBe('2026-07-01T16:00:00.000Z');
  });
});

describe('查询边界（对齐上游 date_boundary）', () => {
  it('裸日期按查询时区折算，end 包尾', () => {
    expect(parseDateBoundary('2026-05-13', { timeZone: 'Asia/Shanghai' }).toISOString()).toBe('2026-05-12T16:00:00.000Z');
    expect(parseDateBoundary('2026-05-13', { end: true, timeZone: 'Asia/Shanghai' }).toISOString()).toBe('2026-05-13T16:00:00.000Z');
  });

  it('带偏移直接转 UTC；默认 UTC 时裸日期即 UTC', () => {
    expect(parseDateBoundary('2026-05-13T00:00:00+08:00').toISOString()).toBe('2026-05-12T16:00:00.000Z');
    expect(parseDateBoundary('2026-05-13').toISOString()).toBe('2026-05-13T00:00:00.000Z');
  });

  it('歧义/不存在的边界 → 要求显式偏移', () => {
    expect(() => parseDateBoundary('2026-11-01T01:30:00', { timeZone: 'America/New_York' }))
      .toThrow(/Ambiguous or nonexistent query boundary; supply an explicit UTC offset/);
    expect(() => parseDateBoundary('2026-03-08T02:30:00', { timeZone: 'America/New_York' }))
      .toThrow(/Ambiguous or nonexistent query boundary/);
  });

  it('非法时区 → Invalid IANA time zone', () => {
    expect(() => parseDateBoundary('2026-05-13', { timeZone: 'Not/AZone' })).toThrow(/Invalid IANA time zone/);
  });
});
