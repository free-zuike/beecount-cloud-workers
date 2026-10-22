/**
 * 字段映射转换器 — 对齐原版 Python services/import_data/transformer.py
 * 将 ParsedRow + ImportFieldMapping → ImportTransaction[]
 */

import type { ParsedRow, ImportFieldMapping, ImportTransaction } from './schema';
import { isMappingComplete } from './schema';

function parseAmount(value: string, stripCurrency: boolean): number {
  let cleaned = (value || '').trim();
  if (!cleaned) return 0;
  if (stripCurrency) {
    cleaned = cleaned.replace(/[￥¥$€£,，\s]/g, '');
  }
  // 括号负数
  if (cleaned.startsWith('(') && cleaned.endsWith(')')) {
    cleaned = '-' + cleaned.slice(1, -1);
  }
  cleaned = cleaned.replace(/−/g, '-'); // U+2212 → ASCII '-'
  const num = parseFloat(cleaned);
  if (isNaN(num)) return 0;
  return num;
}

// 候选时间格式 — 对齐原版 transformer.py _DATETIME_CANDIDATES
const AUTO_DATETIME_FORMATS = [
  'YYYY-MM-DD HH:mm:ss',
  'YYYY-MM-DD HH:mm',
  'YYYY-MM-DDTHH:mm:ss',
  'YYYY-MM-DDTHH:mm:ssZ',
  'YYYY/MM/DD HH:mm:ss',
  'YYYY/MM/DD HH:mm',
  'YYYY-MM-DD',
  'YYYY/MM/DD',
  'DD/MM/YYYY HH:mm',
  'DD/MM/YYYY',
  'MM/DD/YYYY HH:mm',
  'MM/DD/YYYY',
];

interface DateParts {
  y: number;
  m: number;
  d: number;
  h: number;
  min: number;
  s: number;
  tzMinutes: number | null;
}

const TOKEN_RE = /(YYYY|YY|MM|DD|HH|mm|ss)/g;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Python strptime 格式(%m/%d/%Y)与人类可读格式(MM/DD/YYYY)统一成 token 格式
function normalizeFormat(fmt: string): string {
  return fmt
    .replace(/%M/g, 'mm') // 分钟先于 %m(月),避免误替换
    .replace(/%m/g, 'MM')
    .replace(/%Y/g, 'YYYY')
    .replace(/%y/g, 'YY')
    .replace(/%d/g, 'DD')
    .replace(/%H/g, 'HH')
    .replace(/%S/g, 'ss');
}

function parseWithFormat(s: string, fmt: string): DateParts | null {
  let f = normalizeFormat(fmt);
  let tzMinutes: number | null = null;
  if (f.includes('Z')) {
    f = f.replace(/Z/g, '');
    tzMinutes = 0;
  }
  const caps: Array<'y' | 'm' | 'd' | 'h' | 'min' | 's'> = [];
  let re = '';
  let last = 0;
  for (const m of f.matchAll(TOKEN_RE)) {
    re += escapeRegExp(f.slice(last, m.index));
    const tok = m[0];
    if (tok === 'YYYY') {
      re += '(\\d{4})';
      caps.push('y');
    } else if (tok === 'YY') {
      re += '(\\d{2})';
      caps.push('y');
    } else {
      re += '(\\d{1,2})';
      caps.push(tok === 'MM' ? 'm' : tok === 'DD' ? 'd' : tok === 'HH' ? 'h' : tok === 'mm' ? 'min' : 's');
    }
    last = m.index + tok.length;
  }
  re += escapeRegExp(f.slice(last));
  const m = s.match(new RegExp('^' + re + '$'));
  if (!m) return null;
  const num = (name: 'y' | 'm' | 'd' | 'h' | 'min' | 's') => {
    const idx = caps.indexOf(name);
    return idx >= 0 ? parseInt(m[idx + 1], 10) : (name === 'y' || name === 'm' || name === 'd' ? NaN : 0);
  };
  const y = num('y');
  const mo = num('m');
  const d = num('d');
  const h = num('h');
  const min = num('min');
  const sec = num('s');
  // 非法日期(如 2 月 30 日)校验 — Date.UTC 会 rollover,须还原比对
  const dt = new Date(Date.UTC(y, mo - 1, d, h, min, sec));
  if (isNaN(dt.getTime())) return null;
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return { y, m: mo, d, h, min, s: sec, tzMinutes };
}

// 把墙钟组件换算成 UTC:格式自带时区用自带;naive 按客户端 offset(东为正)减偏移;
// offset 为 null(老客户端)→ 当 UTC,向后兼容
function toIso(p: DateParts, tzOffset: number | null | undefined): string {
  const tz = p.tzMinutes ?? tzOffset ?? 0;
  const ms = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - tz * 60000;
  return new Date(ms).toISOString();
}

function parseDate(value: string, format?: string | null, tzOffset?: number | null): string {
  const cleaned = (value || '').trim();
  if (!cleaned) return new Date().toISOString();

  if (format) {
    const p = parseWithFormat(cleaned, format);
    if (p) return toIso(p, tzOffset);
  } else {
    for (const f of AUTO_DATETIME_FORMATS) {
      const p = parseWithFormat(cleaned, f);
      if (p) return toIso(p, tzOffset);
    }
  }
  // 兜底:fromisoformat 变体(如带 +08:00 偏移的完整 ISO)
  try {
    const d = new Date(cleaned);
    if (!isNaN(d.getTime())) return d.toISOString();
  } catch { /* ignore */ }
  return new Date(cleaned).toISOString();
}

function inferTxType(value: string): 'expense' | 'income' | 'transfer' {
  const lower = (value || '').trim().toLowerCase();
  if (['收入', 'income', 'in', '收入', '入账', '收款', '转入'].some(s => lower.includes(s))) return 'income';
  if (['转账', 'transfer', '转出', '转帐'].some(s => lower.includes(s))) return 'transfer';
  return 'expense';
}

export function applyMapping(rows: ParsedRow[], mapping: ImportFieldMapping): ImportTransaction[] {
  // 必填字段没全 map → 所有行失败,返回空(对齐原版 required_complete 检查)
  if (!isMappingComplete(mapping)) return [];

  return rows.map(row => {
    const cells = row.cells;
    const get = (field: string | null) => field ? (cells[field] ?? '') : '';

    let txType = mapping.txType ? inferTxType(get(mapping.txType)) : 'expense';
    let amount = mapping.amount ? parseAmount(get(mapping.amount), mapping.stripCurrencySymbols) : 0;
    // 对齐原版符号语义:expense_is_negative 时负数→expense + 取绝对值;
    // 未开启时负数一律视为支出并取绝对值(transfer 除外)
    if (mapping.expenseIsNegative) {
      if (amount < 0) { txType = 'expense'; amount = -amount; }
    } else if (amount < 0) {
      amount = -amount;
      if (txType !== 'transfer') txType = 'expense';
    }
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
