// 移植上游 tests/test_ai_parse_currency.py：
// 智能记账多币种 — draft 币种解析 + prompt 上下文单测。
// 单币种用户的零回归是最重要的断言：prompt 字符串与账户清单在
// 「所有账户都是账本主币种」时必须与加多币种之前逐字相同。
import { describe, expect, it } from 'vitest';
import { normalizeCurrency, normalizeDrafts } from '../src/routes/ai';
import {
  buildParseTxTextMessages,
  formatAccountsHint,
  formatCurrencyHint,
} from '../src/services/ai/prompts';

describe('normalizeCurrency（移植上游 _norm_currency）', () => {
  const cases: Array<[unknown, string]> = [
    ['USD', 'USD'],
    ['usd', 'USD'],
    ['  jpy  ', 'JPY'],
    ['美元', ''],      // server 不做中文别名映射（交给 prompt 直出 ISO）
    ['$', 'USD'],      // 唯一例外：实测 LLM 常把「45 美元」的 currency 回成 "$"
    [' $ ', 'USD'],
    ['¥', ''],         // 真歧义（CNY/JPY 都写裸 ¥）→ 退回账本主币种
    ['US', ''],        // 长度不对
    ['USDD', ''],
    ['U$D', ''],
    ['', ''],
    [null, ''],
    [123, ''],         // 非字符串
  ];
  for (const [raw, expected] of cases) {
    it(`_norm_currency(${JSON.stringify(raw)}) == ${JSON.stringify(expected)}`, () => {
      expect(normalizeCurrency(raw)).toBe(expected);
    });
  }
});

describe('normalizeDrafts 币种白名单放行（移植上游 _normalize_drafts）', () => {
  it('币种透传 + 大写', () => {
    const out = normalizeDrafts({ tx_drafts: [{ amount: 45, currency: 'usd' }] });
    expect(out[0].currency).toBe('USD');
  });

  it('非法币种降级成空串而不是丢弃整笔', () => {
    const out = normalizeDrafts({ tx_drafts: [{ amount: 45, currency: '美元' }] });
    expect(out).toHaveLength(1);
    expect(out[0].currency).toBe('');
    expect(out[0].amount).toBe(45);
  });

  it('无 currency 键 → 默认空串（老 LLM 输出回归锁）', () => {
    const out = normalizeDrafts({ tx_drafts: [{ amount: 10, type: 'income' }] });
    expect(out[0].currency).toBe('');
    expect(out[0].type).toBe('income');
  });

  it('币种不干扰其它字段', () => {
    const out = normalizeDrafts({
      tx_drafts: [{
        amount: -30,
        type: 'expense',
        currency: 'JPY',
        category_name: '餐饮',
        account_name: '现金',
        note: '拉面',
        tags: ['旅行'],
        confidence: 'high',
      }],
    });
    const d = out[0];
    expect([d.amount, d.type, d.currency]).toEqual([30, 'expense', 'JPY']);
    expect([d.category_name, d.account_name, d.note]).toEqual(['餐饮', '现金', '拉面']);
    expect(d.tags).toEqual(['旅行']);
    expect(d.confidence).toBe('high');
  });
});

describe('账户清单：单币种零噪声（移植上游 _format_accounts_hint）', () => {
  it('单币种账本：输出与加多币种之前逐字相同', () => {
    expect(formatAccountsHint([['微信', 'CNY'], ['支付宝', 'CNY']], 'CNY')).toBe('微信, 支付宝');
  });

  it('只标注外币账户', () => {
    expect(formatAccountsHint([['微信', 'CNY'], ['Chase', 'USD']], 'CNY')).toBe('微信, Chase(USD)');
  });

  it('币种缺失的账户不标注', () => {
    expect(formatAccountsHint([['旧账户', null]], 'CNY')).toBe('旧账户');
  });

  it('空账户清单 → 提示文案含 none', () => {
    expect(formatAccountsHint([], 'CNY')).toContain('none');
  });
});

describe('币种提示行（移植上游 _format_currency_hint）', () => {
  it('单币种只有一行极短提示', () => {
    expect(formatCurrencyHint([['微信', 'CNY']], 'CNY', true)).toBe('账本主币种:CNY');
  });

  it('有外币账户时列出', () => {
    const hint = formatCurrencyHint([['微信', 'CNY'], ['Chase', 'USD']], 'CNY', true);
    expect(hint.startsWith('账本主币种:CNY')).toBe(true);
    expect(hint).toContain('USD');
  });

  it('英文提示', () => {
    const hint = formatCurrencyHint([['Chase', 'USD']], 'CNY', false);
    expect(hint.startsWith('Ledger base currency: CNY')).toBe(true);
    expect(hint).toContain('USD');
  });
});

describe('自定义 prompt 兼容（移植上游 A7/A8）', () => {
  it('自定义模板不含 {CURRENCY_HINT} 时忽略该 kwarg，不报错', () => {
    const content = buildParseTxTextMessages({
      text: '午饭 35',
      categories: ['餐饮'],
      accounts: [['微信', 'CNY']],
      ledgerCurrency: 'CNY',
      now: new Date('2026-08-12T00:00:00Z'),
      customPromptTemplate: '只提取金额:{TEXT}\n{SCHEMA}',
    })[0].content;
    expect(content).toContain('午饭 35');
    expect(content).not.toContain('账本主币种:CNY');
    expect(content).toContain('`currency`');
  });

  it('默认模板包含币种提示行和 schema 字段说明', () => {
    const content = buildParseTxTextMessages({
      text: '在东京吃拉面 1200 日元',
      categories: ['餐饮'],
      accounts: [['微信', 'CNY']],
      ledgerCurrency: 'CNY',
      now: new Date('2026-08-12T00:00:00Z'),
    })[0].content;
    expect(content).toContain('账本主币种:CNY');
    expect(content).toContain('`currency`');
  });
});
