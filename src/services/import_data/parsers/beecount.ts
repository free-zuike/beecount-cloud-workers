/**
 * BeeCount 自家格式解析器 — 对齐原版 Python parsers/beecount.py
 *
 * 关键对齐点（早期重写走了样，已按 1.9.0 实测更正）：
 * - sniff：11+ 列里至少识别 8 个才算 beecount，不是「有类型+分类两列」就误判；
 * - 别名表与上游 _HEADER_ALIASES 完全一致——**没有** currency / attachments 键，
 *   subcategory 仅含「子分类」（不含「二级分类」）；
 * - suggest_mapping：**不映射 currency**（上游 _HEADER_ALIASES 没有 currency 键），
 *   且 BeeCount 导出不含币种符号 → strip_currency_symbols=False。
 */

import type { ImportFieldMapping } from '../schema';
import { makeDefaultMapping } from '../schema';

// 对齐上游 _HEADER_ALIASES（大小写不敏感；注意没有 currency / attachments 键）
const ALIASES: Record<string, string[]> = {
  type: ['type', '类型', '類型'],
  category: ['category', '分类', '分類'],
  subcategory: ['subcategory', '子分类', '子分類'],
  amount: ['amount', '金额', '金額'],
  account: ['account', '账户', '帳戶'],
  fromAccount: ['from_account', 'from account', '转出账户', '轉出帳戶'],
  toAccount: ['to_account', 'to account', '转入账户', '轉入帳戶'],
  note: ['note', '备注', '備註'],
  time: ['time', '时间', '時間'],
  tags: ['tags', '标签', '標籤'],
};

function headerAliasHit(headers: string[], aliases: string[]): string | null {
  const lowerAliases = aliases.map(a => a.toLowerCase());
  for (const h of headers) {
    if (lowerAliases.includes((h || '').trim().toLowerCase())) return h;
  }
  return null;
}

export class BeeCountParser {
  name = 'beecount';

  sniff(sampleLower: string): boolean {
    // 对齐上游 parsers/beecount.py：11+ 列里至少能识别 8 个才算 beecount，
    // 否则任何带「类型/分类」表头的普通 CSV 都会被误判。
    const lower = sampleLower.toLowerCase();
    let score = 0;
    for (const aliases of Object.values(ALIASES)) {
      if (aliases.some(a => lower.includes(a.toLowerCase()))) score++;
    }
    return score >= 8;
  }

  findHeaderRow(rows: string[][]): number {
    // BeeCount 导出 header 一定在第 0 行（没有顶部说明文字）。
    if (!rows.length) return -1;
    const firstRow = rows[0].map(h => h.trim().toLowerCase());
    const typeAliases = ALIASES.type.map(v => v.toLowerCase());
    if (firstRow.some(h => typeAliases.includes(h))) return 0;
    return -1;
  }

  suggestMapping(headers: string[]): ImportFieldMapping {
    const mapping = makeDefaultMapping();
    mapping.txType = headerAliasHit(headers, ALIASES.type);
    mapping.amount = headerAliasHit(headers, ALIASES.amount);
    mapping.happenedAt = headerAliasHit(headers, ALIASES.time);
    mapping.categoryName = headerAliasHit(headers, ALIASES.category);
    mapping.subcategoryName = headerAliasHit(headers, ALIASES.subcategory);
    mapping.accountName = headerAliasHit(headers, ALIASES.account);
    mapping.fromAccountName = headerAliasHit(headers, ALIASES.fromAccount);
    mapping.toAccountName = headerAliasHit(headers, ALIASES.toAccount);
    mapping.note = headerAliasHit(headers, ALIASES.note);
    const tag = headerAliasHit(headers, ALIASES.tags);
    mapping.tags = tag ? [tag] : [];
    // 对齐上游 beecount suggest_mapping：不映射 currency（上游别名表无 currency 键），
    // BeeCount 导出不含币种符号 → stripCurrencySymbols=False。
    mapping.datetimeFormat = null;
    mapping.stripCurrencySymbols = false;
    mapping.expenseIsNegative = false;
    return mapping;
  }
}
