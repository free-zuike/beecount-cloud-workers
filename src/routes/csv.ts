/**
 * CSV 导出路由模块 - 交易 CSV 导出（对齐原版 Python workspace.py）
 *
 * 端点：
 * - GET /workspace/transactions.csv - 导出交易为 CSV（UTF-8 BOM）
 *
 * 12 列：Type, Category, SubCategory, Amount, Currency, Account,
 *        FromAccount, ToAccount, Note, Time, Tags, Attachments
 *
 * @module routes/csv
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';

type Bindings = { DB: D1Database };
type Variables = { userId: string };

const csvRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// ===========================
// CSV 辅助（对齐原版 _csv_field / _sanitize_filename）
// ===========================

function csvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (s === '') return '';
  if (/[,"\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function sanitizeFilename(name: string | null, maxLen = 64): string {
  const safe = (name ?? '').replace(/[\\/:*?"<>|\r\n]/g, '_').trim() || 'ledger';
  return safe.replace(/^[ .]+|[ .]+$/g, '').slice(0, maxLen) || 'ledger';
}

function tagsList(raw: string | null): string[] {
  if (!raw) return [];
  return raw.split(',').map(t => t.trim()).filter(Boolean);
}

function attachmentNames(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item: Record<string, unknown>) =>
      String(item.fileName ?? item.file_name ?? item.name ?? '')
    ).filter(Boolean);
  } catch {
    return [];
  }
}

function normalizeLang(lang: string | null): string {
  if (!lang) return 'en';
  const s = lang.trim().toLowerCase().replace(/_/g, '-');
  if (s.startsWith('zh-tw') || ['zh-hant', 'zh-hk', 'zh-mo'].includes(s)) return 'zh-TW';
  if (s.startsWith('zh')) return 'zh-CN';
  return 'en';
}

// ===========================
// 多语言表头 / 类型标签（对齐原版 _CSV_HEADERS_BY_LANG）
// ===========================

const CSV_HEADERS: Record<string, string[]> = {
  'zh-CN': ['类型', '分类', '二级分类', '金额', '币种', '账户', '转出账户', '转入账户', '备注', '时间', '标签', '附件'],
  'zh-TW': ['類型', '分類', '二級分類', '金額', '幣種', '帳戶', '轉出帳戶', '轉入帳戶', '備註', '時間', '標籤', '附件'],
  'en':    ['Type', 'Category', 'Subcategory', 'Amount', 'Currency', 'Account', 'From Account', 'To Account', 'Note', 'Time', 'Tags', 'Attachments'],
};

const TX_TYPE_LABELS: Record<string, Record<string, string>> = {
  'zh-CN': { income: '收入', expense: '支出', transfer: '转账' },
  'zh-TW': { income: '收入', expense: '支出', transfer: '轉帳' },
  'en':    { income: 'Income', expense: 'Expense', transfer: 'Transfer' },
};

// ===========================
// 查询参数 Schema（对齐原版 export_workspace_transactions_csv）
// ===========================

const ExportQuerySchema = z.object({
  ledger_id: z.string().optional(),
  user_id: z.string().optional(),
  tx_type: z.enum(['income', 'expense', 'transfer']).optional(),
  account_name: z.string().optional(),
  q: z.string().optional(),
  tag_sync_id: z.string().optional(),
  category_sync_id: z.string().optional(),
  account_sync_id: z.string().optional(),
  amount_min: z.coerce.number().optional(),
  amount_max: z.coerce.number().optional(),
  date_from: z.string().optional(),
  date_to: z.string().optional(),
  tz_offset_minutes: z.coerce.number().default(0),
  lang: z.string().optional(),
});

// ===========================
// GET /workspace/transactions.csv
// ===========================

csvRouter.get('/workspace/transactions.csv', zValidator('query', ExportQuerySchema), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const q = c.req.valid('query');

  const langKey = normalizeLang(q.lang);
  const headers = CSV_HEADERS[langKey];
  const typeLabels = TX_TYPE_LABELS[langKey];

  // 1. 查询可见账本（含共享账本，与原版 _visible_workspace_ledgers 对齐）
  let ledgerQuery = `
    SELECT l.id, l.external_id, l.name, l.currency, l.user_id
    FROM ledgers l
    INNER JOIN ledger_members lm ON lm.ledger_id = l.id
    WHERE lm.user_id = ? AND l.deleted_at IS NULL
  `;
  const ledgerParams: string[] = [userId];
  if (q.ledger_id) {
    ledgerQuery += ' AND l.external_id = ?';
    ledgerParams.push(q.ledger_id);
  }

  const ledgers = await db.prepare(ledgerQuery).bind(...ledgerParams).all<{
    id: string; external_id: string; name: string | null;
    currency: string | null; user_id: string;
  }>();

  if (ledgers.results.length === 0) {
    // 返回空 CSV（含 BOM + 表头，与原版行为一致）
    const bom = '\uFEFF';
    const emptyCsv = bom + headers.join(',') + '\r\n';
    return new Response(emptyCsv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="beecount-empty.csv"',
      },
    });
  }

  const ledgerInternalIds = ledgers.results.map(l => l.id);
  const primaryName = sanitizeFilename(ledgers.results[0]?.name ?? ledgers.results[0]?.external_id ?? 'ledger');
  const ledgerCurrencyMap = new Map(ledgers.results.map(l => [l.id, l.currency || 'CNY']));

  // 2. 构建查询
  const placeholders = ledgerInternalIds.map(() => '?').join(',');
  let txQuery = `
    SELECT tx.*, cp.level AS cat_level, cp.parent_name AS cat_parent_name
    FROM read_tx_projection tx
    LEFT JOIN read_category_projection cp ON cp.user_id = tx.user_id AND cp.sync_id = tx.category_sync_id
    WHERE tx.ledger_id IN (${placeholders})
  `;
  const txParams: (string | number)[] = [...ledgerInternalIds];

  if (q.tx_type) {
    txQuery += ' AND tx.tx_type = ?';
    txParams.push(q.tx_type);
  }
  if (q.account_name) {
    const pattern = `%${q.account_name}%`;
    txQuery += ' AND (tx.account_name LIKE ? OR tx.from_account_name LIKE ? OR tx.to_account_name LIKE ?)';
    txParams.push(pattern, pattern, pattern);
  }
  if (q.q) {
    const pattern = `%${q.q}%`;
    txQuery += ' AND (tx.note LIKE ? OR tx.category_name LIKE ? OR tx.account_name LIKE ? OR tx.from_account_name LIKE ? OR tx.to_account_name LIKE ? OR tx.tags_csv LIKE ?)';
    txParams.push(pattern, pattern, pattern, pattern, pattern, pattern);
  }
  if (q.tag_sync_id) {
    txQuery += ' AND tx.tag_sync_ids_json LIKE ?';
    txParams.push(`%"${q.tag_sync_id}"%`);
  }
  if (q.category_sync_id) {
    txQuery += ' AND tx.category_sync_id = ?';
    txParams.push(q.category_sync_id);
  }
  if (q.account_sync_id) {
    txQuery += ' AND (tx.account_sync_id = ? OR tx.from_account_sync_id = ? OR tx.to_account_sync_id = ?)';
    txParams.push(q.account_sync_id, q.account_sync_id, q.account_sync_id);
  }
  if (q.amount_min !== undefined) {
    txQuery += ' AND tx.amount >= ?';
    txParams.push(q.amount_min);
  }
  if (q.amount_max !== undefined) {
    txQuery += ' AND tx.amount <= ?';
    txParams.push(q.amount_max);
  }
  if (q.date_from) {
    txQuery += ' AND tx.happened_at >= ?';
    txParams.push(q.date_from);
  }
  if (q.date_to) {
    txQuery += ' AND tx.happened_at < ?';
    txParams.push(q.date_to);
  }

  txQuery += ' ORDER BY tx.happened_at DESC, tx.tx_index DESC';

  const txRows = await db.prepare(txQuery).bind(...txParams).all<Record<string, unknown>>();

  // 3. 生成 CSV
  const tzOffset = q.tz_offset_minutes || 0;
  const rows: string[] = [];

  for (const tx of txRows.results) {
    const isTransfer = tx.tx_type === 'transfer';
    const catLevel = tx.cat_level as number | null;
    const catParentName = tx.cat_parent_name as string | null;

    // 分类拆分
    let categoryCol = '';
    let subCategoryCol = '';
    if (!isTransfer) {
      if (catLevel === 2 && catParentName) {
        categoryCol = catParentName;
        subCategoryCol = String(tx.category_name ?? '');
      } else {
        categoryCol = String(tx.category_name ?? '');
      }
    }

    // 类型标签（本地化）
    const typeLabel = typeLabels[String(tx.tx_type ?? '')] ?? String(tx.tx_type ?? '');

    // 金额格式化
    const amount = tx.amount != null
      ? Number(tx.amount).toFixed(2)
      : '';

    // 币种
    const rawCurrency: string = (String(tx.currency_code ?? '') ||
      ledgerCurrencyMap.get(String(tx.ledger_id ?? '')) ||
      'CNY') as string;
    const currency = rawCurrency.toUpperCase();

    // 时间（带时区偏移）
    const happenedAt = tx.happened_at as string | null;
    let timeStr = '';
    if (happenedAt) {
      const d = new Date(happenedAt);
      if (!isNaN(d.getTime())) {
        const local = new Date(d.getTime() + tzOffset * 60000);
        const pad = (n: number) => String(n).padStart(2, '0');
        timeStr = `  ${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())} ${pad(local.getHours())}:${pad(local.getMinutes())}:${pad(local.getSeconds())}  `;
      }
    }

    // 标签
    const tagList = tagsList(tx.tags_csv as string | null);

    // 附件
    const attachList = attachmentNames(tx.attachments_json as string | null);

    const row = [
      csvField(typeLabel),
      csvField(categoryCol),
      csvField(subCategoryCol),
      amount,
      csvField(currency),
      csvField(isTransfer ? '' : (tx.account_name as string)),
      csvField(isTransfer ? (tx.from_account_name as string) : ''),
      csvField(isTransfer ? (tx.to_account_name as string) : ''),
      csvField(tx.note as string),
      csvField(timeStr),
      csvField(tagList.join(',')),
      csvField(attachList.join(',')),
    ].join(',');

    rows.push(row);
  }

  // 4. 构建响应
  const csvContent = '\uFEFF' + headers.join(',') + '\r\n' + rows.join('\r\n');

  // 文件名（对齐原版 RFC 5987）
  const now = new Date();
  const periodFrom = q.date_from ? q.date_from.slice(0, 10) : 'all';
  const periodTo = q.date_to ? q.date_to.slice(0, 10) : 'all';
  const periodSegment = !q.date_from && !q.date_to
    ? `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`
    : `${periodFrom}_${periodTo}`;
  const filename = `beecount-${primaryName}-${periodSegment}.csv`;

  // 简单 ASCII fallback + UTF-8 编码
  const asciiFilename = filename.replace(/[^\x20-\x7e]/g, '_');
  const encodedFilename = encodeURIComponent(filename);

  return new Response(csvContent, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodedFilename}`,
      'Cache-Control': 'no-store',
    },
  });
});

export default csvRouter;