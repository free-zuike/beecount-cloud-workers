/**
 * MCP 参数校验层（对齐上游 pydantic 契约）回归。
 *
 * 覆盖：金额拒绝 boolean / 未知键拒绝 / 长度与区间 / 枚举 / 数量上限。
 * 均走工具入口（不是内部函数），确保生产分发路径也受校验保护。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createLedger, makeHarness, registerDevice, registerUser, mcpCtx, type Harness } from './mcp-harness';
import { manageAccount, manageBudget, manageLedger } from '../src/mcp/capability-tools';
import { previewImport } from '../src/mcp/workflow-tools';
import { saveReviewItem } from '../src/mcp/rule-tools';
import { positiveAmount } from '../src/mcp/transaction-service';

let h: Harness;

afterEach(() => h?.sqlite.close());

function setup(): ReturnType<typeof mcpCtx> {
  h = makeHarness();
  registerUser(h, 'u1', 'u1@example.com');
  registerDevice(h, 'u1');
  createLedger(h, 'u1', 'L1-i', 'L1', '主账本');
  return mcpCtx(h, 'u1');
}

describe('MCP 参数校验（对齐上游 pydantic）', () => {
  it('金额拒绝 boolean（Number(true)=1 不能伪装成 1 元）', () => {
    expect(() => positiveAmount(true)).toThrow(/amount must be a number, not a boolean/);
    expect(() => positiveAmount(0)).toThrow(/positive finite/);
    expect(() => positiveAmount(Number.NaN)).toThrow(/positive finite/);
    expect(positiveAmount(12.5)).toBe(12.5);
  });

  it('manage_account：未知键按 extra="forbid" 拒绝', async () => {
    const c = setup();
    await expect(
      manageAccount(c, { action: 'create', ledger_id: 'L1', data: { name: '招行', nickname: 'x' } }),
    ).rejects.toThrow(/unknown field: nickname/);
  });

  it('manage_account：billing_day/payment_due_day 必须 1..31，credit_limit >= 0', async () => {
    const c = setup();
    await expect(
      manageAccount(c, { action: 'create', ledger_id: 'L1', data: { name: '招行', billing_day: 32 } }),
    ).rejects.toThrow(/billing_day must be <= 31/);
    await expect(
      manageAccount(c, { action: 'create', ledger_id: 'L1', data: { name: '招行', payment_due_day: 0 } }),
    ).rejects.toThrow(/payment_due_day must be >= 1/);
    await expect(
      manageAccount(c, { action: 'create', ledger_id: 'L1', data: { name: '招行', credit_limit: -1 } }),
    ).rejects.toThrow(/credit_limit must be >= 0/);
  });

  it('manage_account：name 长度 1..255、card_last_four <= 8', async () => {
    const c = setup();
    await expect(
      manageAccount(c, { action: 'create', ledger_id: 'L1', data: { name: '' } }),
    ).rejects.toThrow(/name must be at least 1/);
    await expect(
      manageAccount(c, { action: 'create', ledger_id: 'L1', data: { name: '招行', card_last_four: '123456789' } }),
    ).rejects.toThrow(/card_last_four must be at most 8/);
  });

  it('manage_budget：amount 必须为正、period 枚举、未知键拒绝', async () => {
    const c = setup();
    await expect(
      manageBudget(c, { action: 'create', ledger_id: 'L1', data: { type: 'total', amount: 0 } }),
    ).rejects.toThrow(/amount must be a positive finite number/);
    await expect(
      manageBudget(c, { action: 'create', ledger_id: 'L1', data: { type: 'total', amount: 10, period: 'daily' } }),
    ).rejects.toThrow(/period must be one of/);
    await expect(
      manageBudget(c, { action: 'create', ledger_id: 'L1', data: { type: 'total', amount: 10, start_day: 5 } }),
    ).rejects.toThrow(/unknown field: start_day/);
  });

  it('manage_ledger：month_start_day 必须 1..28、ledger_name 1..255', async () => {
    const c = setup();
    await expect(
      manageLedger(c, { action: 'update', ledger_id: 'L1', data: { month_start_day: 29 } }),
    ).rejects.toThrow(/month_start_day must be <= 28/);
    await expect(
      manageLedger(c, { action: 'update', ledger_id: 'L1', data: { ledger_name: '' } }),
    ).rejects.toThrow(/ledger_name must be at least 1/);
  });

  it('preview_import：sources <= 20、file_sha256 定长 64、action 枚举', async () => {
    const c = setup();
    const manySources = Array.from({ length: 21 }, (_, i) => ({ source_system: 'bank', source_id: `s${i}` }));
    await expect(
      previewImport(c, {
        ledger_id: 'L1',
        candidates: [{ transaction: { amount: 10, tx_type: 'expense' }, sources: manySources }],
      }),
    ).rejects.toThrow(/sources accepts at most 20 items/);

    await expect(
      previewImport(c, {
        ledger_id: 'L1',
        candidates: [{
          transaction: { amount: 10, tx_type: 'expense' },
          sources: [{ source_system: 'bank', source_id: 's1', file_sha256: 'abc' }],
        }],
      }),
    ).rejects.toThrow(/file_sha256 must be exactly 64 characters/);

    await expect(
      previewImport(c, {
        ledger_id: 'L1',
        candidates: [{ transaction: { amount: 10, tx_type: 'expense' }, action: 'merge' as never }],
      }),
    ).rejects.toThrow(/action must be one of/);

    await expect(
      previewImport(c, {
        ledger_id: 'L1',
        candidates: [{ transaction: { amount: 10, tx_type: 'expense' }, sources: [{ source_system: '', source_id: 's1' }] }],
      }),
    ).rejects.toThrow(/source_system must be at least 1/);
  });

  it('save_review_item：question 1..4000、transaction_ids <= 200、status 枚举', async () => {
    const c = setup();
    await expect(saveReviewItem(c, { ledger_id: 'L1', question: '' }))
      .rejects.toThrow(/question must be at least 1/);
    await expect(saveReviewItem(c, { ledger_id: 'L1', question: 'q'.repeat(4001) }))
      .rejects.toThrow(/question must be at most 4000/);
    await expect(
      saveReviewItem(c, { ledger_id: 'L1', question: 'q', transaction_ids: Array.from({ length: 201 }, (_, i) => `t${i}`) }),
    ).rejects.toThrow(/transaction_ids accepts at most 200/);
    await expect(saveReviewItem(c, { ledger_id: 'L1', question: 'q', status: 'closed' as never }))
      .rejects.toThrow(/status must be one of/);
  });
});
