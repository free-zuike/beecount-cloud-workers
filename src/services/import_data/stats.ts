/**
 * 导入统计 — 对齐原版 Python services/import_data/stats.py
 * 对照 target ledger 计算 dedup / new vs match
 */

import type { ParsedRow, ImportFieldMapping, ImportTransaction } from './schema';

export interface ImportStats {
  totalRows: number;
  newCount: number;
  duplicateCount: number;
  matchedCount: number;
  categoryCount: number;
  accountCount: number;
  tagCount: number;
}

export interface ExistingSets {
  txKeys: Set<string>;         // "amount|happened_at" for dedup
  categoryNames: Set<string>;
  accountNames: Set<string>;
  tagNames: Set<string>;
}

export async function buildExistingSets(
  db: D1Database,
  userId: string,
  ledgerId: string,
): Promise<ExistingSets> {
  const ledger = await db
    .prepare('SELECT l.id FROM ledgers l INNER JOIN ledger_members lm ON lm.ledger_id = l.id WHERE l.external_id = ? AND lm.user_id = ?')
    .bind(ledgerId, userId)
    .first<{ id: string }>();

  if (!ledger) {
    return { txKeys: new Set(), categoryNames: new Set(), accountNames: new Set(), tagNames: new Set() };
  }

  const [txRows, catRows, acctRows, tagRows] = await Promise.all([
    db.prepare('SELECT amount, happened_at FROM read_tx_projection WHERE ledger_id = ?').bind(ledger.id).all<{ amount: number; happened_at: string }>(),
    db.prepare('SELECT name FROM read_category_projection WHERE user_id = ?').bind(userId).all<{ name: string }>(),
    db.prepare('SELECT name FROM read_account_projection WHERE ledger_id = ?').bind(ledger.id).all<{ name: string }>(),
    db.prepare('SELECT name FROM read_tag_projection WHERE user_id = ?').bind(userId).all<{ name: string }>(),
  ]);

  return {
    txKeys: new Set(txRows.results.map(r => `${r.amount}|${(r.happened_at || '').slice(0, 10)}`)),
    categoryNames: new Set(catRows.results.map(r => r.name)),
    accountNames: new Set(acctRows.results.map(r => r.name)),
    tagNames: new Set(tagRows.results.map(r => r.name)),
  };
}

export function computeStats(
  txs: ImportTransaction[],
  existing: ExistingSets,
  _rows: ParsedRow[],
  _mapping: ImportFieldMapping,
): ImportStats {
  let newCount = 0;
  let duplicateCount = 0;
  let matchedCount = 0;
  const catSet = new Set<string>();
  const acctSet = new Set<string>();
  const tagSet = new Set<string>();

  for (const tx of txs) {
    const key = `${tx.amount}|${(tx.happenedAt || '').slice(0, 10)}`;
    if (existing.txKeys.has(key)) {
      duplicateCount++;
    } else {
      newCount++;
    }
    if (tx.categoryName && existing.categoryNames.has(tx.categoryName)) matchedCount++;
    if (tx.categoryName) catSet.add(tx.categoryName);
    if (tx.accountName) acctSet.add(tx.accountName);
    if (tx.fromAccountName) acctSet.add(tx.fromAccountName);
    if (tx.toAccountName) acctSet.add(tx.toAccountName);
    for (const t of tx.tagNames) tagSet.add(t);
  }

  return {
    totalRows: txs.length,
    newCount,
    duplicateCount,
    matchedCount,
    categoryCount: catSet.size,
    accountCount: acctSet.size,
    tagCount: tagSet.size,
  };
}