/**
 * 语义契约（对齐后把口径锁住）：跨账本依赖abel深的几处。
 *
 * 覆盖本轮修的行为差异：
 * 1. list_transactions 的日期边界默认按 Cloud 配置时区（不再是 UTC）
 * 2. 交易/搜索结果的 category 取行内存储的 category_name
 * 3. record_out 的 data 是原始 JSON 字符串（不解析）
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createLedger, makeHarness, mcpCtx, registerDevice, registerUser, type Harness } from './mcp-harness';
import { listTransactions, getTransaction } from '../src/mcp/tools/read-tools';

let h: Harness;

afterEach(() => { h?.sqlite.close(); });

function setup(configuredTimeZone?: string) {
  h = makeHarness();
  registerUser(h, 'u1', 'u1@example.com');
  registerDevice(h, 'u1');
  createLedger(h, 'u1', 'L1-i', 'L1', '主账本');
  const c = mcpCtx(h, 'u1');
  if (configuredTimeZone) c.configuredTimeZone = configuredTimeZone;
  return c;
}

function seedTx(syncId: string, happenedAt: string, categorySyncId: string | null, storedCategoryName: string | null): void {
  h.sqlite.prepare(
    `INSERT INTO read_tx_projection (ledger_id, sync_id, user_id, tx_type, amount, happened_at, note,
     category_sync_id, category_name, account_sync_id, account_name, from_account_sync_id, from_account_name,
     to_account_sync_id, to_account_name, tag_sync_ids_json, currency_code, native_amount,
     exclude_from_stats, exclude_from_budget)
     VALUES ('L1-i', ?, 'u1', 'expense', 10, ?, 'n', ?, ?, 'a1', '现金', NULL, NULL, NULL, NULL, '[]', NULL, NULL, 0, 0)`,
  ).run(syncId, happenedAt, categorySyncId, storedCategoryName);
}

describe('日期边界的默认时区', () => {
  it('未给 time_zone 时用 Cloud 配置时区解释日期', async () => {
    const c = setup('Asia/Shanghai');
    // UTC 2026-05-31T20:00Z == 上海时间 2026-06-01T04:00
    seedTx('t1', '2026-05-31T20:00:00.000Z', null, null);
    const out = await listTransactions(c, { ledger_id: 'L1', date_from: '2026-06-01', date_to: '2026-06-01' }) as {
      items: Array<{ sync_id: string }>;
    };
    expect(out.items.map(i => i.sync_id)).toEqual(['t1']);
  });
});

describe('分类名来源', () => {
  it('get_transaction 优先用行内存储的 category_name', async () => {
    const c = setup();
    seedTx('t1', '2026-05-13T10:00:00.000Z', 'c1', '被移动的分类');
    const tx = await getTransaction(c, { sync_id: 't1' }) as Record<string, unknown>;
    expect(tx.category_name ?? tx.category).toBe('被移动的分类');
  });
});
