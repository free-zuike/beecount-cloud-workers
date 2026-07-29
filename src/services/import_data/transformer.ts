/**
 * 字段映射转换器 — 对齐原版 Python services/import_data/transformer.py
 * 将 ParsedRow + ImportFieldMapping → ImportTransaction[]
 */

import type { ParsedRow, ImportFieldMapping, ImportTransaction } from './schema';

function parseAmount(value: string, stripCurrency: boolean, expenseIsNegative: boolean): number {
  let cleaned = (value || '').trim();
  if (!cleaned) return 0;
  if (stripCurrency) {
    cleaned = cleaned.replace(/[￥¥$€,，\s]/g, '');
  }
  // 括号负数
  if (cleaned.startsWith('(') && cleaned.endsWith(')')) {
    cleaned = '-' + cleaned.slice(1, -1);
  }
  const num = parseFloat(cleaned);
  if (isNaN(num)) return 0;
  if (expenseIsNegative && num < 0) return Math.abs(num);
  return num;
}

function parseDate(value: string, format?: string | null, tzOffset?: number | null): string {
  const cleaned = (value || '').trim();
  if (!cleaned) return new Date().toISOString();

  // ISO format
  const isoMatch = cleaned.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    const d = new Date(cleaned);
    if (!isNaN(d.getTime())) {
      if (tzOffset && !cleaned.includes('Z') && !cleaned.includes('+')) {
        return new Date(d.getTime() - (tzOffset || 0) * 60000).toISOString();
      }
      return d.toISOString();
    }
  }

  // YYYY/MM/DD
  const slashMatch = cleaned.match(/^(\d{4})\/(\d{2})\/(\d{2})/);
  if (slashMatch) {
    const d = new Date(`${slashMatch[1]}-${slashMatch[2]}-${slashMatch[3]}`);
    if (!isNaN(d.getTime())) return d.toISOString();
  }

  // DD/MM/YYYY or MM/DD/YYYY
  const dmMatch = cleaned.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (dmMatch) {
    // Try DD/MM first
    let d = new Date(`${dmMatch[3]}-${dmMatch[2]}-${dmMatch[1]}`);
    if (isNaN(d.getTime())) {
      d = new Date(`${dmMatch[3]}-${dmMatch[1]}-${dmMatch[2]}`);
    }
    if (!isNaN(d.getTime())) return d.toISOString();
  }

  // YYYYMMDD
  const compactMatch = cleaned.match(/^(\d{4})(\d{2})(\d{2})/);
  if (compactMatch) {
    const d = new Date(`${compactMatch[1]}-${compactMatch[2]}-${compactMatch[3]}`);
    if (!isNaN(d.getTime())) return d.toISOString();
  }

  return new Date(cleaned).toISOString();
}

function inferTxType(value: string): 'expense' | 'income' | 'transfer' {
  const lower = (value || '').trim().toLowerCase();
  if (['收入', 'income', 'in', '收入', '入账', '收款', '转入'].some(s => lower.includes(s))) return 'income';
  if (['转账', 'transfer', '转出', '转帐'].some(s => lower.includes(s))) return 'transfer';
  return 'expense';
}

export function applyMapping(rows: ParsedRow[], mapping: ImportFieldMapping): ImportTransaction[] {
  return rows.map(row => {
    const cells = row.cells;
    const get = (field: string | null) => field ? (cells[field] ?? '') : '';

    const txType = mapping.txType ? inferTxType(get(mapping.txType)) : 'expense';
    const amount = mapping.amount ? parseAmount(get(mapping.amount), mapping.stripCurrencySymbols, mapping.expenseIsNegative) : 0;
    const happenedAt = mapping.happenedAt ? parseDate(get(mapping.happenedAt), mapping.datetimeFormat, mapping.tzOffsetMinutes) : new Date().toISOString();
    const categoryName = mapping.categoryName ? get(mapping.categoryName) || null : null;
    const parentCategoryName = mapping.subcategoryName ? get(mapping.subcategoryName) || null : null;
    const accountName = mapping.accountName ? get(mapping.accountName) || null : null;
    const fromAccountName = mapping.fromAccountName ? get(mapping.fromAccountName) || null : null;
    const toAccountName = mapping.toAccountName ? get(mapping.toAccountName) || null : null;
    const note = mapping.note ? get(mapping.note) || null : null;
    const currencyCode = mapping.currency ? get(mapping.currency) || null : null;

    // Tags: 可以多列合并
    const tagNames: string[] = [];
    for (const tagField of mapping.tags) {
      const val = get(tagField);
      if (val) {
        tagNames.push(...val.split(/[,，、;；]/).map(t => t.trim()).filter(Boolean));
      }
    }

    // 如果设置了 subcategoryName 但没有 categoryName，则 sub 作为 category
    const finalCategory = categoryName || parentCategoryName;
    const finalParent = categoryName && parentCategoryName ? parentCategoryName : null;

    // 转账时优先使用 from/to
    const finalFrom = txType === 'transfer' ? (fromAccountName || accountName) : null;
    const finalTo = txType === 'transfer' ? toAccountName : null;
    const finalAccount = txType !== 'transfer' ? accountName : null;

    return {
      txType,
      amount,
      happenedAt,
      currencyCode: currencyCode,
      note: note || undefined,
      categoryName: finalCategory || undefined,
      parentCategoryName: finalParent || undefined,
      accountName: finalAccount || undefined,
      fromAccountName: finalFrom || undefined,
      toAccountName: finalTo || undefined,
      tagNames,
      sourceRowNumber: row.rowNumber,
      sourceRawLine: row.rawLine,
    };
  });
}