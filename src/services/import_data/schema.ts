/**
 * 导入数据 Schema — 对齐原版 Python services/import_data/schema.py
 */

export type SourceFormat = 'beecount' | 'generic';
export type DedupStrategy = 'skip_duplicates' | 'insert_all';

export const SUPPORTED_FORMATS: SourceFormat[] = ['beecount', 'generic'];
export const DEFAULT_DEDUP_STRATEGY: DedupStrategy = 'skip_duplicates';

export interface ParseWarning {
  code: string;
  rowNumber: number;
  message: string;
  rawLine?: string;
}

export interface ImportError {
  code: string;
  rowNumber: number;
  message: string;
  rawLine?: string;
  fieldName?: string;
}

export interface ParsedRow {
  rowNumber: number;
  cells: Record<string, string>;
  rawLine: string;
}

export interface ImportFieldMapping {
  txType: string | null;
  amount: string | null;
  happenedAt: string | null;
  categoryName: string | null;
  subcategoryName: string | null;
  accountName: string | null;
  fromAccountName: string | null;
  toAccountName: string | null;
  note: string | null;
  currency: string | null;
  tags: string[];
  datetimeFormat: string | null;
  stripCurrencySymbols: boolean;
  expenseIsNegative: boolean;
  tzOffsetMinutes: number | null;
}

export function makeDefaultMapping(): ImportFieldMapping {
  return {
    txType: null, amount: null, happenedAt: null,
    categoryName: null, subcategoryName: null,
    accountName: null, fromAccountName: null, toAccountName: null,
    note: null, currency: null, tags: [],
    datetimeFormat: null, stripCurrencySymbols: true,
    expenseIsNegative: false, tzOffsetMinutes: null,
  };
}

export function isMappingComplete(m: ImportFieldMapping): boolean {
  return !!(m.txType && m.amount && m.happenedAt && m.categoryName);
}

export interface ImportAccount {
  name: string;
  type?: string | null;
  currency?: string | null;
}

export interface ImportCategory {
  name: string;
  kind: 'expense' | 'income' | 'transfer';
  parentName?: string | null;
  level?: number;
}

export interface ImportTag {
  name: string;
  color?: string | null;
}

export interface ImportTransaction {
  txType: 'expense' | 'income' | 'transfer';
  amount: number;
  happenedAt: string; // ISO datetime
  currencyCode?: string | null;
  note?: string | null;
  categoryName?: string | null;
  parentCategoryName?: string | null;
  accountName?: string | null;
  fromAccountName?: string | null;
  toAccountName?: string | null;
  tagNames: string[];
  sourceRowNumber: number;
  sourceRawLine: string;
  // 下方字段由导入流程后阶段填充，类型定义为可选避免早期步骤报错
  categoryId?: string | null;
  categoryKind?: string | null;
  accountId?: string | null;
  fromAccountId?: string | null;
  toAccountId?: string | null;
  tagIds?: string[];
  excludeFromStats?: boolean | null;
  excludeFromBudget?: boolean | null;
  nativeAmount?: number | null;
}

export interface ImportData {
  sourceFormat: SourceFormat;
  headers: string[];
  rows: ParsedRow[];
  suggestedMapping: ImportFieldMapping;
  parseWarnings: ParseWarning[];
}