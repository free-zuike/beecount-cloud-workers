/**
 * BeeCount 自家格式解析器 — 对齐原版 Python parsers/beecount.py
 * 跟 web/mobile export 严格对齐（11 列 + header 在 row 0 + 表头本地化）
 */

import type { ImportFieldMapping } from '../schema';
import { makeDefaultMapping } from '../schema';

// BeeCount 导出格式的 12 列表头（多语言）
const HEADER_VARIANTS: Record<string, string[]> = {
  type: ['类型', '類型', 'Type'],
  category: ['分类', '分類', 'Category'],
  subcategory: ['二级分类', '二級分類', 'Subcategory'],
  amount: ['金额', '金額', 'Amount'],
  currency: ['币种', '幣種', 'Currency'],
  account: ['账户', '帳戶', 'Account'],
  fromAccount: ['转出账户', '轉出帳戶', 'From Account'],
  toAccount: ['转入账户', '轉入帳戶', 'To Account'],
  note: ['备注', '備註', 'Note'],
  time: ['时间', '時間', 'Time'],
  tags: ['标签', '標籤', 'Tags'],
  attachments: ['附件', '附件', 'Attachments'],
};

function headerMatch(col: string, variants: string[]): boolean {
  const trimmed = col.trim().toLowerCase();
  return variants.some(v => v.toLowerCase() === trimmed);
}

export class BeeCountParser {
  name = 'beecount';

  sniff(sampleLower: string): boolean {
    // BeeCount 格式第一行是表头，检查是否包含所有关键列
    const firstLine = sampleLower.split('\n')[0] || '';
    return (
      headerMatch(firstLine.split(',')[0] || '', HEADER_VARIANTS.type) &&
      HEADER_VARIANTS.category.some(v => firstLine.includes(v.toLowerCase()))
    );
  }

  findHeaderRow(rows: string[][]): number {
    // BeeCount 格式表头总是在第 0 行
    if (!rows.length) return -1;
    const firstRow = rows[0].map(h => h.trim().toLowerCase());
    const typeVariants = HEADER_VARIANTS.type.map(v => v.toLowerCase());
    if (firstRow.some(h => typeVariants.includes(h))) return 0;
    // 不在第 0 行则 fallback 到 generic 查找
    return -1;
  }

  suggestMapping(headers: string[]): ImportFieldMapping {
    const mapping = makeDefaultMapping();
    const lower = headers.map(h => h.trim().toLowerCase());

    for (let i = 0; i < headers.length; i++) {
      const h = lower[i];
      if (HEADER_VARIANTS.type.some(v => v.toLowerCase() === h)) mapping.txType = headers[i];
      else if (HEADER_VARIANTS.amount.some(v => v.toLowerCase() === h)) mapping.amount = headers[i];
      else if (HEADER_VARIANTS.currency.some(v => v.toLowerCase() === h)) mapping.currency = headers[i];
      else if (HEADER_VARIANTS.time.some(v => v.toLowerCase() === h)) mapping.happenedAt = headers[i];
      else if (HEADER_VARIANTS.category.some(v => v.toLowerCase() === h)) mapping.categoryName = headers[i];
      else if (HEADER_VARIANTS.subcategory.some(v => v.toLowerCase() === h)) mapping.subcategoryName = headers[i];
      else if (HEADER_VARIANTS.account.some(v => v.toLowerCase() === h)) mapping.accountName = headers[i];
      else if (HEADER_VARIANTS.fromAccount.some(v => v.toLowerCase() === h)) mapping.fromAccountName = headers[i];
      else if (HEADER_VARIANTS.toAccount.some(v => v.toLowerCase() === h)) mapping.toAccountName = headers[i];
      else if (HEADER_VARIANTS.note.some(v => v.toLowerCase() === h)) mapping.note = headers[i];
      else if (HEADER_VARIANTS.tags.some(v => v.toLowerCase() === h)) mapping.tags = [headers[i]];
    }

    return mapping;
  }
}