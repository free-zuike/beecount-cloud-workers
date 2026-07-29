/**
 * 通用 CSV 解析器 — 对齐原版 Python parsers/generic.py
 * fuzzy match 列名，全集 alias 表（合并支付宝/微信/通用）
 */

import type { ImportFieldMapping } from '../schema';
import { makeDefaultMapping } from '../schema';

// 全集 alias 表 — 合并了原 alipay / wechat / generic 三套规则
const PATTERNS: Record<string, RegExp> = {
  txType: /^(类型|type|kind|收[/／]?支|收支)$/i,
  amount: /(金额|amount|amt|价格|price|总金额|发生额|sum|total)/i,
  currency: /^(币种|幣種|货币|貨幣|currency|currency\s*code)$/i,
  happenedAt: /(交易时间|交易创建时间|创建时间|发生时间|happened|时间|日期|date|when)/i,
  categoryName: /(分类|交易类型|类别|商品类目|主类目|顶级分类|父类|category|cat$)/i,
  subcategoryName: /(二级分类|子分类|子类目|subcategory|sub.?cat)/i,
  accountName: /(账户|账号|account|支付方式|付款方式|收[/／]?付款方式|来源|出处)/i,
  fromAccountName: /(转出|from.?account|source.?account|出账)/i,
  toAccountName: /(转入|to.?account|dest.?account|target.?account|入账)/i,
  note: /(商品说明|商品|商家|对方|交易对方|备注|note|description|说明|memo)/i,
  tags: /(标签|tag|label)/i,
};

function matchHeader(headers: string[], pattern: RegExp, taken?: Set<string>): string | null {
  for (const h of headers) {
    if (taken?.has(h)) continue;
    if (pattern.test(h || '')) return h;
  }
  return null;
}

export class GenericParser {
  name = 'generic';

  sniff(_sampleLower: string): boolean {
    return false; // generic 是 fallback，让其它 parser 优先
  }

  findHeaderRow(rows: string[][]): number {
    if (!rows.length) return -1;
    const maxCheck = Math.min(30, rows.length);
    for (let i = 0; i < maxCheck; i++) {
      const candCols = rows[i].length;
      if (candCols < 3) continue;
      const checkEnd = Math.min(i + 10, rows.length);
      let consistent = 0;
      for (let j = i + 1; j < checkEnd; j++) {
        if (rows[j].length === candCols) consistent++;
      }
      if (consistent >= 5) return i;
    }
    return 0;
  }

  suggestMapping(headers: string[]): ImportFieldMapping {
    const nonEmpty = headers.filter(h => (h || '').trim());
    const taken = new Set<string>();

    const grab = (field: string): string | null => {
      const m = matchHeader(nonEmpty, PATTERNS[field], taken);
      if (m) taken.add(m);
      return m;
    };

    return {
      ...makeDefaultMapping(),
      txType: grab('txType'),
      amount: grab('amount'),
      currency: grab('currency'),
      happenedAt: grab('happenedAt'),
      categoryName: grab('categoryName'),
      subcategoryName: grab('subcategoryName'),
      accountName: grab('accountName'),
      fromAccountName: grab('fromAccountName'),
      toAccountName: grab('toAccountName'),
      note: grab('note'),
      tags: grab('tags') ? [grab('tags')!] : [],
    };
  }
}