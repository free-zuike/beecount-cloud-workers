// 契约测试（#B5 补偿事故的第二道防线）：
// 写进 sync_changes 的 transaction upsert，无论来自 write 路由创建还是
// B5 收敛 / 同步自愈补写，payload 字段集合必须完全一致——设备端覆盖式应用，
// 缺一个字段就是一次数据事故（amount 归零 / 日期丢失）。
//
// 本测试锁定两个方向的等价：
//   a) buildTxUpsertPayload 输出的 key 集合 === write 路由创建交易 payload 的 key 集合
//   b) 字段级映射正确（投影行 → camelCase payload）
import { describe, expect, it } from 'vitest';
import { buildTxUpsertPayload, type TxProjectionRow } from '../src/lib/tx-upsert-payload';

/**
 * write 路由创建交易（src/routes/write.ts POST /ledgers/:ledgerId/transactions）
 * payload 构造的 key 列表（851-875 行对象字面量）。若 write 路由增删字段，
 * 此列表与 buildTxUpsertPayload 必须同步更新，否则测试红。
 */
const WRITE_ROUTE_PAYLOAD_KEYS = [
  'syncId', 'type', 'amount', 'happenedAt', 'note',
  'categoryId', 'categoryName', 'categoryKind',
  'accountId', 'accountName',
  'fromAccountId', 'fromAccountName',
  'toAccountId', 'toAccountName',
  'tags', 'tagIds', 'attachments',
  'excludeFromStats', 'excludeFromBudget',
  'createdByUserId', 'updatedByUserId',
  'currencyCode', 'nativeAmount',
];

function makeRow(overrides: Partial<TxProjectionRow> = {}): TxProjectionRow {
  return {
    sync_id: 'tx-1',
    user_id: 'u-1',
    tx_type: 'expense',
    amount: 12.5,
    happened_at: '2026-09-01T12:00:00.000Z',
    note: '买花',
    category_sync_id: 'cat-1',
    category_name: '鲜花',
    category_kind: 'expense',
    account_sync_id: 'acc-1',
    account_name: '微信',
    from_account_sync_id: null,
    from_account_name: null,
    to_account_sync_id: null,
    to_account_name: null,
    tags_csv: '图片记账,AI记账',
    tag_sync_ids_json: JSON.stringify(['tag-1', 'tag-2']),
    attachments_json: JSON.stringify([{ fileName: 'a.jpg', cloudFileId: 'f-1' }]),
    created_by_user_id: 'u-1',
    last_edited_by_user_id: 'u-2',
    exclude_from_stats: 1,
    exclude_from_budget: 0,
    currency_code: 'CNY',
    native_amount: 12.5,
    ...overrides,
  };
}

describe('transaction upsert payload 契约（write 路由 ⇔ 补写路径）', () => {
  it('键集合与 write 路由创建交易 payload 完全一致（双向相等）', () => {
    const payload = JSON.parse(buildTxUpsertPayload(makeRow())) as Record<string, unknown>;
    const keys = Object.keys(payload).sort();
    const expected = [...WRITE_ROUTE_PAYLOAD_KEYS].sort();
    expect(keys).toEqual(expected);
    // 无额外 key，无缺失 key
    expect(keys.length).toBe(expected.length);
  });

  it('字段映射正确：投影行 → camelCase payload', () => {
    const payload = JSON.parse(buildTxUpsertPayload(makeRow())) as Record<string, unknown>;
    expect(payload.syncId).toBe('tx-1');
    expect(payload.type).toBe('expense');
    expect(payload.amount).toBe(12.5);
    expect(payload.happenedAt).toBe('2026-09-01T12:00:00.000Z');
    expect(payload.note).toBe('买花');
    expect(payload.categoryId).toBe('cat-1');
    expect(payload.categoryName).toBe('鲜花');
    expect(payload.categoryKind).toBe('expense');
    expect(payload.accountId).toBe('acc-1');
    expect(payload.accountName).toBe('微信');
    expect(payload.fromAccountId).toBeNull();
    expect(payload.fromAccountName).toBeNull();
    expect(payload.toAccountId).toBeNull();
    expect(payload.toAccountName).toBeNull();
    expect(payload.tags).toBe('图片记账,AI记账');
    expect(payload.tagIds).toEqual(['tag-1', 'tag-2']);
    expect(payload.attachments).toEqual([{ fileName: 'a.jpg', cloudFileId: 'f-1' }]);
    expect(payload.excludeFromStats).toBe(true);
    expect(payload.excludeFromBudget).toBe(false);
    expect(payload.createdByUserId).toBe('u-1');
    expect(payload.updatedByUserId).toBe('u-2');
    expect(payload.currencyCode).toBe('CNY');
    expect(payload.nativeAmount).toBe(12.5);
  });

  it('空值语义与 write 路由一致：无值字段为 null，不做默认兜底', () => {
    const payload = JSON.parse(buildTxUpsertPayload(makeRow({
      note: null,
      category_sync_id: null,
      category_name: null,
      category_kind: null,
      account_sync_id: null,
      account_name: null,
      tags_csv: null,
      tag_sync_ids_json: null,
      attachments_json: '[]',
      exclude_from_stats: 0,
      exclude_from_budget: 0,
      currency_code: null,
      native_amount: null,
    }))) as Record<string, unknown>;
    expect(payload.note).toBeNull();
    expect(payload.categoryId).toBeNull();
    expect(payload.categoryName).toBeNull();
    expect(payload.categoryKind).toBeNull();
    expect(payload.accountId).toBeNull();
    expect(payload.accountName).toBeNull();
    expect(payload.tags).toBeNull();
    expect(payload.tagIds).toBeNull();
    expect(payload.attachments).toEqual([]);
    expect(payload.excludeFromStats).toBe(false);
    expect(payload.excludeFromBudget).toBe(false);
    expect(payload.currencyCode).toBeNull();
    expect(payload.nativeAmount).toBeNull();
  });

  it('user 兜底：last_edited/created 缺失时回退投影 user_id', () => {
    const payload = JSON.parse(buildTxUpsertPayload(makeRow({
      created_by_user_id: null,
      last_edited_by_user_id: null,
    }))) as Record<string, unknown>;
    expect(payload.createdByUserId).toBe('u-1');
    expect(payload.updatedByUserId).toBe('u-1');
  });

  it('坏 JSON 防御：tag_sync_ids_json / attachments_json 解析失败不抛', () => {
    const payload = JSON.parse(buildTxUpsertPayload(makeRow({
      tag_sync_ids_json: '{broken',
      attachments_json: '{broken',
    }))) as Record<string, unknown>;
    expect(payload.tagIds).toBeNull();
    expect(payload.attachments).toEqual([]);
  });
});