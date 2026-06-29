/**
 * 导入路由模块 - 实现 CSV/Excel 导入接口
 *
 * 参考原版 BeeCount-Cloud (Python/FastAPI) 的 /import 端点：
 * - POST /import/upload                       - 上传文件，解析行列，返回预览
 * - GET  /import/{token}/preview            - 字段映射预览
 * - POST /import/{token}/execute             - 执行导入（SSE 进度流）
 * - DELETE /import/{token}                  - 取消导入 token
 *
 * 功能说明：
 * - 导入 token 有效期 30 分钟
 * - 支持 CSV / XLSX / XLS 格式
 * - 字段自动映射（amount / happened_at / tx_type / note / category）
 * - 支持 dedup（按 amount + happened_at 去重）
 * - 使用 Cloudflare KV 存储导入会话
 *
 * @module routes/import_data
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { randomUUID } from 'crypto';

function nowUtc(): string {
  return new Date().toISOString();
}

function safeJsonStringify(obj: unknown): string {
  return JSON.stringify(obj);
}

function parseDate(dateStr: string): string | null {
  if (!dateStr) return null;
  
  const cleaned = dateStr.trim();
  
  // 尝试常见日期格式
  const formats = [
    // ISO 8601
    (s: string) => {
      const match = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (match) return `${match[1]}-${match[2]}-${match[3]}`;
      return null;
    },
    // YYYY/MM/DD
    (s: string) => {
      const match = s.match(/^(\d{4})\/(\d{2})\/(\d{2})/);
      if (match) return `${match[1]}-${match[2]}-${match[3]}`;
      return null;
    },
    // DD/MM/YYYY
    (s: string) => {
      const match = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
      if (match) return `${match[3]}-${match[2]}-${match[1]}`;
      return null;
    },
    // MM/DD/YYYY
    (s: string) => {
      const match = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
      if (match) return `${match[3]}-${match[1]}-${match[2]}`;
      return null;
    },
    // YYYYMMDD
    (s: string) => {
      const match = s.match(/^(\d{4})(\d{2})(\d{2})/);
      if (match) return `${match[1]}-${match[2]}-${match[3]}`;
      return null;
    },
  ];
  
  for (const format of formats) {
    const result = format(cleaned);
    if (result) {
      const date = new Date(result);
      if (!isNaN(date.getTime())) {
        return result;
      }
    }
  }
  
  return null;
}

function parseAmount(amountStr: string): number {
  if (!amountStr) return 0;
  
  let cleaned = amountStr.trim();
  // 移除货币符号和千位分隔符
  cleaned = cleaned.replace(/[￥¥$€,，]/g, '');
  // 处理负数或括号表示的负数
  if (cleaned.startsWith('(') && cleaned.endsWith(')')) {
    cleaned = '-' + cleaned.slice(1, -1);
  }
  // 处理中文的正负号
  if (cleaned.startsWith('+')) cleaned = cleaned.slice(1);
  if (cleaned.startsWith('-') || cleaned.startsWith('负')) {
    cleaned = cleaned.replace(/^-|^负/, '-');
  }
  
  const amount = parseFloat(cleaned);
  return isNaN(amount) ? 0 : amount;
}

function parseTxType(typeStr: string, amount?: number): 'expense' | 'income' | 'transfer' {
  if (!typeStr) {
    // 根据金额判断
    if (amount !== undefined && amount > 0) return 'income';
    if (amount !== undefined && amount < 0) return 'expense';
    return 'expense';
  }
  
  const lower = typeStr.toLowerCase().trim();
  if (/收|income|in|revenue|deposit/.test(lower)) return 'income';
  if (/转|transfer|trans/.test(lower)) return 'transfer';
  if (/支|出|expense|out|spend|payment|withdraw/.test(lower)) return 'expense';
  
  return 'expense';
}

function splitTags(tagsStr: string): string[] {
  if (!tagsStr) return [];
  return tagsStr
    .split(/[,，;；\s]/)
    .map(t => t.trim())
    .filter(Boolean);
}

interface ImportSession {
  token: string;
  user_id: string;
  file_name: string;
  mime_type: string;
  row_count: number;
  rows: string[][];
  headers: string[];
  status: 'pending' | 'previewing' | 'executing' | 'done' | 'cancelled';
  created_at: string;
  expires_at: string;
}

const ImportPreviewSchema = z.object({
  mapping: z.record(z.string()).optional(),
  target_ledger_id: z.string().nullable().optional(),
  dedup_strategy: z.enum(['skip_duplicates', 'insert_all']).optional(),
  auto_tag_names: z.array(z.string()).optional(),
});

const ImportExecuteSchema = z.object({
  field_mapping: z.record(z.string()),
  ledger_id: z.string().optional(),
  deduplicate: z.boolean().default(true),
  auto_tag_names: z.array(z.string()).optional(),
});

type Bindings = {
  DB: D1Database;
  JWT_SECRET: string;
  IMPORT_SESSIONS: KVNamespace;
};

type Variables = {
  userId: string;
};

const importRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const KV_PREFIX = 'import_';

async function getSession(kv: KVNamespace, token: string): Promise<ImportSession | null> {
  const data = await kv.get(KV_PREFIX + token);
  if (!data) return null;
  try {
    return JSON.parse(data) as ImportSession;
  } catch {
    return null;
  }
}

async function saveSession(kv: KVNamespace, session: ImportSession): Promise<void> {
  await kv.put(KV_PREFIX + session.token, JSON.stringify(session), {
    expirationTtl: 1800,
  });
}

async function deleteSession(kv: KVNamespace, token: string): Promise<void> {
  await kv.delete(KV_PREFIX + token);
}

function detectSourceFormat(fileName: string, headers: string[], firstRow: string[]): 'beecount' | 'alipay' | 'wechat' | 'generic' {
  const lowerHeaders = headers.map(h => h.toLowerCase().trim());
  const lowerFileName = fileName.toLowerCase();

  if (lowerFileName.includes('alipay') || lowerFileName.includes('支付宝')) {
    return 'alipay';
  }

  if (lowerFileName.includes('wechat') || lowerFileName.includes('微信')) {
    return 'wechat';
  }

  if (lowerFileName.includes('beecount')) {
    return 'beecount';
  }

  if (lowerHeaders.some(h => h.includes('交易号') || h.includes('transaction id')) &&
      lowerHeaders.some(h => h.includes('订单号') || h.includes('order id'))) {
    return 'alipay';
  }

  if (lowerHeaders.some(h => h.includes('交易单号') || h.includes('transaction id')) &&
      lowerHeaders.some(h => h.includes('商户单号'))) {
    return 'wechat';
  }

  return 'generic';
}

type FieldMappingRule = {
  target: string;
  patterns: string[];
  aliases?: string[];
  required?: boolean;
};

const mappingRules: FieldMappingRule[] = [
  { target: 'amount', patterns: ['金额', 'amount', 'amt', '钱', '数额', '支出', '收入', 'price', 'value', 'sum'], required: true },
  { target: 'happened_at', patterns: ['时间', '日期', 'happened_at', 'date', 'datetime', '交易时间', '发生时间', 'created_at', 'time'], required: true },
  { target: 'tx_type', patterns: ['类型', 'type', 'tx_type', '交易类型', '收支', 'type_name', 'status', 'kind'] },
  { target: 'note', patterns: ['备注', 'note', '描述', 'description', 'memo', '说明', 'detail', 'info'] },
  { target: 'category_name', patterns: ['分类', 'category', '分类名称', 'cat', '一级分类', 'category name'] },
  { target: 'subcategory_name', patterns: ['子分类', 'subcategory', '二级分类', 'sub-category', '子分类名称'] },
  { target: 'account_name', patterns: ['账户', 'account', 'account_name', '账户名称', 'payment method', '支付方式'] },
  { target: 'from_account_name', patterns: ['转出账户', 'from_account', 'from_account_name', '源账户', 'from'] },
  { target: 'to_account_name', patterns: ['转入账户', 'to_account', 'to_account_name', '目标账户', 'to'] },
  { target: 'tags', patterns: ['标签', 'tags', 'tag', 'label'] },
];

function generateSuggestedMapping(headers: string[]): Record<string, string | null> {
  const mapping: Record<string, string | null> = {
    tx_type: null,
    amount: null,
    happened_at: null,
    category_name: null,
    subcategory_name: null,
    account_name: null,
    from_account_name: null,
    to_account_name: null,
    note: null,
  };
  const lowerHeaders = headers.map(h => h.toLowerCase().trim());

  for (let i = 0; i < headers.length; i++) {
    const header = lowerHeaders[i];
    const originalHeader = headers[i];

    if (!mapping.amount && (header.includes('金额') || header.includes('amount') || header.includes('amt'))) {
      mapping.amount = originalHeader;
    } else if (!mapping.happened_at && (header.includes('时间') || header.includes('日期') || header.includes('happened_at') || header.includes('date'))) {
      mapping.happened_at = originalHeader;
    } else if (!mapping.tx_type && (header.includes('类型') || header.includes('tx_type') || header.includes('收支'))) {
      mapping.tx_type = originalHeader;
    } else if (!mapping.note && (header.includes('备注') || header.includes('note') || header.includes('描述'))) {
      mapping.note = originalHeader;
    } else if (!mapping.category_name && (header.includes('分类') || header.includes('category') || header.includes('商品'))) {
      mapping.category_name = originalHeader;
    } else if (!mapping.account_name && (header.includes('账户') || header.includes('account') || header.includes('支付方式'))) {
      mapping.account_name = originalHeader;
    }
  }

  return mapping;
}

importRouter.post('/upload', async (c) => {
  const userId = c.get('userId');
  const kv = c.env.IMPORT_SESSIONS;
  const serverNow = nowUtc();

  try {
    const formData = await c.req.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return c.json({ error: 'No file provided' }, 400);
    }

    const mimeType = file.type;
    const fileName = file.name || 'import.csv';

    const text = await file.text();
    const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);

    if (lines.length < 2) {
      return c.json({ error: 'File must have at least a header and one data row' }, 400);
    }

    const firstLine = lines[0];
    let delimiter = ',';
    if (firstLine.split('\t').length > firstLine.split(',').length) {
      delimiter = '\t';
    }

    const headers = parseCSVLine(firstLine, delimiter);
    const rows: string[][] = [];

    for (let i = 1; i < lines.length; i++) {
      const row = parseCSVLine(lines[i], delimiter);
      if (row.length > 0) {
        rows.push(row);
      }
    }

    const token = randomUUID();
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

    const session: ImportSession = {
      token,
      user_id: userId,
      file_name: fileName,
      mime_type: mimeType,
      row_count: rows.length,
      rows,
      headers,
      status: 'pending',
      created_at: serverNow,
      expires_at: expiresAt,
    };

    await saveSession(kv, session);

    const sourceFormat = detectSourceFormat(fileName, headers, rows[0] || []);
    const suggestedMapping = generateSuggestedMapping(headers);

    return c.json({
      import_token: token,
      expires_at: expiresAt,
      source_format: sourceFormat,
      headers,
      suggested_mapping: suggestedMapping,
      current_mapping: suggestedMapping,
      target_ledger_id: null,
      dedup_strategy: 'skip_duplicates',
      auto_tag_names: [],
      stats: {
        total_rows: rows.length,
        time_range_start: null,
        time_range_end: null,
        total_signed_amount: '0',
        by_type: {
          expense_count: 0,
          expense_total: '0',
          income_count: 0,
          income_total: '0',
          transfer_count: 0,
        },
        accounts: { new_names: [], matched_names: [] },
        categories: { new_names: [], matched_names: [] },
        tags: { new_names: [], matched_names: [] },
        skipped_dedup: 0,
        parse_errors: [],
        parse_errors_total: 0,
        parse_warnings: [],
        parse_warnings_total: 0,
      },
      sample_rows: rows.slice(0, 10),
      sample_transactions: [],
    });
  } catch (err) {
    return c.json({ error: 'Failed to parse file' }, 400);
  }
});

importRouter.get('/:token/preview', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const token = c.req.param('token');
  const kv = c.env.IMPORT_SESSIONS;

  const session = await getSession(kv, token);
  if (!session) {
    return c.json({ error: 'Import token not found or expired' }, 404);
  }

  if (session.status === 'cancelled') {
    return c.json({ error: 'Import cancelled' }, 400);
  }

  const sourceFormat = detectSourceFormat(session.file_name, session.headers, session.rows[0] || []);
  const suggestedMapping = generateSuggestedMapping(session.headers);

  const defaultLedger = await db
    .prepare('SELECT id, external_id FROM ledgers WHERE user_id = ? LIMIT 1')
    .bind(userId)
    .first<{ id: string; external_id: string }>();

  return c.json({
    import_token: token,
    expires_at: session.expires_at,
    source_format: sourceFormat,
    headers: session.headers,
    suggested_mapping: suggestedMapping,
    current_mapping: suggestedMapping,
    target_ledger_id: defaultLedger?.external_id || null,
    dedup_strategy: 'skip_duplicates',
    auto_tag_names: [],
    stats: {
      total_rows: session.row_count,
      time_range_start: null,
      time_range_end: null,
      total_signed_amount: '0',
      by_type: {
        expense_count: 0,
        expense_total: '0',
        income_count: 0,
        income_total: '0',
        transfer_count: 0,
      },
      accounts: { new_names: [], matched_names: [] },
      categories: { new_names: [], matched_names: [] },
      tags: { new_names: [], matched_names: [] },
      skipped_dedup: 0,
      parse_errors: [],
      parse_errors_total: 0,
      parse_warnings: [],
      parse_warnings_total: 0,
    },
    sample_rows: session.rows.slice(0, 10),
    sample_transactions: [],
  });
});

importRouter.post('/:token/preview', zValidator('json', ImportPreviewSchema), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const kv = c.env.IMPORT_SESSIONS;
  const token = c.req.param('token');
  const req = c.req.valid('json');

  const session = await getSession(kv, token);
  if (!session) {
    return c.json({ error: 'Import token not found or expired' }, 404);
  }

  if (session.status === 'cancelled') {
    return c.json({ error: 'Import cancelled' }, 400);
  }

  const fieldMapping = req.mapping || {};
  const targetLedgerId = req.target_ledger_id;
  const dedupStrategy = req.dedup_strategy || 'skip_duplicates';
  const autoTagNames = req.auto_tag_names || [];

  let ledgerId: string | null = null;
  if (targetLedgerId) {
    const ledger = await db
      .prepare('SELECT id FROM ledgers WHERE user_id = ? AND external_id = ?')
      .bind(userId, targetLedgerId)
      .first<{ id: string }>();
    if (ledger) {
      ledgerId = ledger.id;
    }
  } else {
    const defaultLedger = await db
      .prepare('SELECT id FROM ledgers WHERE user_id = ? LIMIT 1')
      .bind(userId)
      .first<{ id: string }>();
    if (defaultLedger) {
      ledgerId = defaultLedger.id;
    }
  }

  const colIndex: Record<string, number> = {};
  for (const [colName, fieldName] of Object.entries(fieldMapping)) {
    const idx = session.headers.indexOf(colName);
    if (idx >= 0) {
      colIndex[fieldName] = idx;
    }
  }

  const sampleTransactions: Array<{
    tx_type: 'expense' | 'income' | 'transfer';
    amount: string;
    happened_at: string;
    note: string | null;
    category_name: string | null;
    parent_category_name: string | null;
    account_name: string | null;
    from_account_name: string | null;
    to_account_name: string | null;
    tag_names: string[];
    source_row_number: number;
  }> = [];

  const parseErrors: Array<{ code: string; row_number: number; message: string; field_name: string | null }> = [];
  const parseWarnings: Array<{ code: string; row_number: number; message: string }> = [];

  let timeRangeStart: string | null = null;
  let timeRangeEnd: string | null = null;
  let expenseCount = 0;
  let expenseTotal = 0;
  let incomeCount = 0;
  let incomeTotal = 0;
  let transferCount = 0;
  const accountNames = new Set<string>();
  const categoryNames = new Set<string>();
  const tagNames = new Set<string>();
  const allDates = new Set<string>();

  const existingAccounts = new Set<string>();
  const existingCategories = new Set<string>();
  const existingTags = new Set<string>();

  if (ledgerId) {
    const [acctRows, catRows, tagRows] = await Promise.all([
      db.prepare('SELECT name FROM read_account_projection WHERE ledger_id = ?')
        .bind(ledgerId)
        .all<{ name: string }>(),
      db.prepare('SELECT name FROM read_category_projection WHERE ledger_id = ?')
        .bind(ledgerId)
        .all<{ name: string }>(),
      db.prepare('SELECT name FROM read_tag_projection WHERE ledger_id = ?')
        .bind(ledgerId)
        .all<{ name: string }>(),
    ]);

    acctRows.results?.forEach(r => existingAccounts.add(r.name));
    catRows.results?.forEach(r => existingCategories.add(r.name));
    tagRows.results?.forEach(r => existingTags.add(r.name));
  }

  for (let i = 0; i < session.rows.length; i++) {
    const row = session.rows[i];
    const rowNumber = i + 2;

    try {
      const amountStr = colIndex['amount'] !== undefined ? row[colIndex['amount']] ?? '' : '';
      const amount = parseAmount(amountStr);
      const happenedAtRaw = colIndex['happened_at'] !== undefined ? row[colIndex['happened_at']] ?? '' : '';
      const happenedAt = parseDate(happenedAtRaw);
      const txTypeRaw = colIndex['tx_type'] !== undefined ? row[colIndex['tx_type']] ?? '' : '';
      const note = colIndex['note'] !== undefined ? row[colIndex['note']] ?? '' : '';
      const categoryName = colIndex['category_name'] !== undefined ? row[colIndex['category_name']] ?? '' : '';
      const accountName = colIndex['account_name'] !== undefined ? row[colIndex['account_name']] ?? '' : '';
      const tagsStr = colIndex['tags'] !== undefined ? row[colIndex['tags']] ?? '' : '';
      const tags = splitTags(tagsStr);

      const txType = parseTxType(txTypeRaw, amount);
      const absAmount = Math.abs(amount);

      if (!happenedAt) {
        parseErrors.push({
          code: 'invalid_date',
          row_number: rowNumber,
          message: '无法解析日期',
          field_name: 'happened_at',
        });
      } else {
        allDates.add(happenedAt);
      }

      if (isNaN(amount)) {
        parseErrors.push({
          code: 'invalid_amount',
          row_number: rowNumber,
          message: '无法解析金额',
          field_name: 'amount',
        });
      }

      if (txType === 'expense') {
        expenseCount++;
        expenseTotal += absAmount;
      } else if (txType === 'income') {
        incomeCount++;
        incomeTotal += absAmount;
      } else if (txType === 'transfer') {
        transferCount++;
      }

      if (accountName) accountNames.add(accountName);
      if (categoryName) categoryNames.add(categoryName);
      tags.forEach(t => tagNames.add(t));

      if (i < 10) {
        sampleTransactions.push({
          tx_type: txType,
          amount: absAmount.toString(),
          happened_at: happenedAt || new Date().toISOString().slice(0, 10),
          note: note || null,
          category_name: categoryName || null,
          parent_category_name: null,
          account_name: accountName || null,
          from_account_name: null,
          to_account_name: null,
          tag_names: tags,
          source_row_number: rowNumber,
        });
      }
    } catch (e) {
      parseErrors.push({
        code: 'parse_error',
        row_number: rowNumber,
        message: e instanceof Error ? e.message : '解析错误',
        field_name: null,
      });
    }
  }

  if (allDates.size > 0) {
    const dates = Array.from(allDates).sort();
    timeRangeStart = dates[0];
    timeRangeEnd = dates[dates.length - 1];
  }

  const matchedAccounts: string[] = [];
  const newAccounts: string[] = [];
  accountNames.forEach(name => {
    if (existingAccounts.has(name)) matchedAccounts.push(name);
    else newAccounts.push(name);
  });

  const matchedCategories: string[] = [];
  const newCategories: string[] = [];
  categoryNames.forEach(name => {
    if (existingCategories.has(name)) matchedCategories.push(name);
    else newCategories.push(name);
  });

  const matchedTags: string[] = [];
  const newTagsFromData: string[] = [];
  tagNames.forEach(name => {
    if (existingTags.has(name)) matchedTags.push(name);
    else newTagsFromData.push(name);
  });

  const allNewTags = new Set([...newTagsFromData, ...autoTagNames]);

  const totalSignedAmount = incomeTotal - expenseTotal;

  const sourceFormat = detectSourceFormat(session.file_name, session.headers, session.rows[0] || []);

  return c.json({
    import_token: token,
    expires_at: session.expires_at,
    source_format: sourceFormat,
    headers: session.headers,
    suggested_mapping: generateSuggestedMapping(session.headers),
    current_mapping: fieldMapping,
    target_ledger_id: targetLedgerId || null,
    dedup_strategy: dedupStrategy,
    auto_tag_names: autoTagNames,
    stats: {
      total_rows: session.row_count,
      time_range_start: timeRangeStart,
      time_range_end: timeRangeEnd,
      total_signed_amount: totalSignedAmount.toString(),
      by_type: {
        expense_count: expenseCount,
        expense_total: expenseTotal.toString(),
        income_count: incomeCount,
        income_total: incomeTotal.toString(),
        transfer_count: transferCount,
      },
      accounts: { new_names: newAccounts, matched_names: matchedAccounts },
      categories: { new_names: newCategories, matched_names: matchedCategories },
      tags: { new_names: Array.from(allNewTags), matched_names: matchedTags },
      skipped_dedup: 0,
      parse_errors: parseErrors,
      parse_errors_total: parseErrors.length,
      parse_warnings: parseWarnings,
      parse_warnings_total: parseWarnings.length,
    },
    sample_rows: session.rows.slice(0, 10),
    sample_transactions: sampleTransactions,
  });
});

importRouter.post('/:token/execute', zValidator('json', ImportExecuteSchema), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const kv = c.env.IMPORT_SESSIONS;
  const token = c.req.param('token');
  const req = c.req.valid('json');

  const session = await getSession(kv, token);
  if (!session) {
    return c.json({ error: 'Import token not found or expired' }, 404);
  }

  if (session.status === 'done') {
    return c.json({ error: 'Import already completed' }, 400);
  }

  if (session.status === 'executing') {
    return c.json({ error: 'Import already in progress' }, 400);
  }

  let ledgerId: string | null = null;
  let ledgerExternalId = req.ledger_id ?? 'default';

  if (req.ledger_id) {
    const ledger = await db
      .prepare('SELECT id, external_id FROM ledgers WHERE user_id = ? AND external_id = ?')
      .bind(userId, req.ledger_id)
      .first<{ id: string; external_id: string }>();

    if (ledger) {
      ledgerId = ledger.id;
      ledgerExternalId = ledger.external_id;
    }
  } else {
    const defaultLedger = await db
      .prepare('SELECT id, external_id FROM ledgers WHERE user_id = ? LIMIT 1')
      .bind(userId)
      .first<{ id: string; external_id: string }>();

    if (defaultLedger) {
      ledgerId = defaultLedger.id;
      ledgerExternalId = defaultLedger.external_id;
    }
  }

  if (!ledgerId) {
    return c.json({ error: 'No ledger found' }, 400);
  }

  session.status = 'executing';
  await saveSession(kv, session);

  const fieldMapping = req.field_mapping;
  const deduplicate = req.deduplicate;
  const autoTagNames = req.auto_tag_names || [];
  const encoder = new TextEncoder();

  // 缓存已创建的实体，避免重复查询和创建
  const createdTags = new Map<string, string>(); // name -> sync_id
  const createdAccounts = new Map<string, string>(); // name -> sync_id
  const createdCategories = new Map<string, string>(); // name -> sync_id

  // 自动创建 auto_tag_names 中指定的标签（如果不存在）
  const autoTagSyncIds: string[] = [];
  for (const tagName of autoTagNames) {
    if (!tagName.trim()) continue;
    
    const existingTag = await db
      .prepare('SELECT sync_id FROM read_tag_projection WHERE ledger_id = ? AND name = ? LIMIT 1')
      .bind(ledgerId, tagName)
      .first<{ sync_id: string }>();

    if (existingTag) {
      autoTagSyncIds.push(existingTag.sync_id);
      createdTags.set(tagName, existingTag.sync_id);
    } else {
      // 自动创建标签
      const tagSyncId = randomUUID();
      const serverNow = nowUtc();

      await db
        .prepare(
          `INSERT INTO sync_changes
           (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(userId, ledgerId, 'tag', tagSyncId, 'upsert', safeJsonStringify({ name: tagName, color: null }), serverNow, userId)
        .run();

      await db
        .prepare(
          `INSERT INTO read_tag_projection
           (ledger_id, sync_id, user_id, name, color, source_change_id)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(ledgerId, tagSyncId, userId, tagName, null, 0)
        .run();

      autoTagSyncIds.push(tagSyncId);
      createdTags.set(tagName, tagSyncId);
    }
  }

  const stream = new ReadableStream({
    async start(controller) {
      let success = 0;
      let failed = 0;
      const total = session.rows.length;

      const colIndex: Record<string, number> = {};
      for (const [colName, fieldName] of Object.entries(fieldMapping)) {
        const idx = session.headers.indexOf(colName);
        if (idx >= 0) {
          colIndex[fieldName] = idx;
        }
      }

      // 统计需要创建的实体数量
      const allAccountNames = new Set<string>();
      const allCategoryNames = new Set<string>();
      const allTagNames = new Set<string>();
      
      for (const row of session.rows) {
        const categoryName = colIndex['category_name'] !== undefined ? row[colIndex['category_name']] ?? '' : '';
        const accountName = colIndex['account_name'] !== undefined ? row[colIndex['account_name']] ?? '' : '';
        const tags = colIndex['tags'] !== undefined ? row[colIndex['tags']] ?? '' : '';
        
        if (categoryName.trim()) allCategoryNames.add(categoryName.trim());
        if (accountName.trim()) allAccountNames.add(accountName.trim());
        splitTags(tags).forEach(t => t.trim() && allTagNames.add(t.trim()));
      }
      
      // 添加自动标签
      autoTagNames.forEach(t => t.trim() && allTagNames.add(t.trim()));

      // 阶段1: 创建账户
      const accountNamesArray = Array.from(allAccountNames);
      controller.enqueue(encoder.encode(`event: stage\ndata: ${JSON.stringify({ stage: 'accounts', done: 0, total: accountNamesArray.length })}\n\n`));
      
      for (let i = 0; i < accountNamesArray.length; i++) {
        const accountName = accountNamesArray[i];
        if (!createdAccounts.has(accountName)) {
          const existingAccount = await db
            .prepare('SELECT sync_id FROM read_account_projection WHERE ledger_id = ? AND name = ? LIMIT 1')
            .bind(ledgerId, accountName)
            .first<{ sync_id: string }>();
            
          if (existingAccount) {
            createdAccounts.set(accountName, existingAccount.sync_id);
          } else {
            const accountSyncId = randomUUID();
            const serverNow = nowUtc();
            const payload: Record<string, unknown> = {
              name: accountName,
              account_type: null,
              currency: null,
              initial_balance: 0,
              note: null,
              credit_limit: null,
              billing_day: null,
              payment_due_day: null,
              bank_name: null,
              card_last_four: null,
            };
            
            await db
              .prepare(
                `INSERT INTO sync_changes
                 (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
              )
              .bind(userId, ledgerId, 'account', accountSyncId, 'upsert', safeJsonStringify(payload), serverNow, userId)
              .run();

            await db
              .prepare(
                `INSERT INTO read_account_projection
                 (ledger_id, sync_id, user_id, name, account_type, currency, initial_balance,
                  note, credit_limit, billing_day, payment_due_day, bank_name, card_last_four, source_change_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
              )
              .bind(ledgerId, accountSyncId, userId, accountName, null, null, 0, null, null, null, null, null, null, 0)
              .run();
            
            createdAccounts.set(accountName, accountSyncId);
          }
        }
        controller.enqueue(encoder.encode(`event: stage\ndata: ${JSON.stringify({ stage: 'accounts', done: i + 1, total: accountNamesArray.length })}\n\n`));
      }

      // 阶段2: 创建分类
      const categoryNamesArray = Array.from(allCategoryNames);
      controller.enqueue(encoder.encode(`event: stage\ndata: ${JSON.stringify({ stage: 'categories', done: 0, total: categoryNamesArray.length })}\n\n`));
      
      for (let i = 0; i < categoryNamesArray.length; i++) {
        const categoryName = categoryNamesArray[i];
        if (!createdCategories.has(categoryName)) {
          const existingCategory = await db
            .prepare('SELECT sync_id, kind FROM read_category_projection WHERE ledger_id = ? AND name = ? LIMIT 1')
            .bind(ledgerId, categoryName)
            .first<{ sync_id: string; kind: string }>();
            
          if (existingCategory) {
            createdCategories.set(categoryName, existingCategory.sync_id);
          } else {
            const categorySyncId = randomUUID();
            const serverNow = nowUtc();
            const payload: Record<string, unknown> = {
              name: categoryName,
              kind: 'expense',
              level: null,
              sort_order: null,
              icon: null,
              icon_type: null,
              custom_icon_path: null,
              icon_cloud_file_id: null,
              icon_cloud_sha256: null,
              parent_name: null,
            };
            
            await db
              .prepare(
                `INSERT INTO sync_changes
                 (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
              )
              .bind(userId, ledgerId, 'category', categorySyncId, 'upsert', safeJsonStringify(payload), serverNow, userId)
              .run();

            await db
              .prepare(
                `INSERT INTO read_category_projection
                 (ledger_id, sync_id, user_id, name, kind, level, sort_order,
                  icon, icon_type, custom_icon_path, icon_cloud_file_id, icon_cloud_sha256,
                  parent_name, source_change_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
              )
              .bind(ledgerId, categorySyncId, userId, categoryName, 'expense', null, null, null, null, null, null, null, null, 0)
              .run();
            
            createdCategories.set(categoryName, categorySyncId);
          }
        }
        controller.enqueue(encoder.encode(`event: stage\ndata: ${JSON.stringify({ stage: 'categories', done: i + 1, total: categoryNamesArray.length })}\n\n`));
      }

      // 阶段3: 创建标签
      const tagNamesArray = Array.from(allTagNames);
      controller.enqueue(encoder.encode(`event: stage\ndata: ${JSON.stringify({ stage: 'tags', done: 0, total: tagNamesArray.length })}\n\n`));
      
      for (let i = 0; i < tagNamesArray.length; i++) {
        const tagName = tagNamesArray[i];
        if (!createdTags.has(tagName)) {
          const existingTag = await db
            .prepare('SELECT sync_id FROM read_tag_projection WHERE ledger_id = ? AND name = ? LIMIT 1')
            .bind(ledgerId, tagName)
            .first<{ sync_id: string }>();
            
          if (existingTag) {
            createdTags.set(tagName, existingTag.sync_id);
          } else {
            const tagSyncId = randomUUID();
            const serverNow = nowUtc();
            
            await db
              .prepare(
                `INSERT INTO sync_changes
                 (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
              )
              .bind(userId, ledgerId, 'tag', tagSyncId, 'upsert', safeJsonStringify({ name: tagName, color: null }), serverNow, userId)
              .run();

            await db
              .prepare(
                `INSERT INTO read_tag_projection
                 (ledger_id, sync_id, user_id, name, color, source_change_id)
                 VALUES (?, ?, ?, ?, ?, ?)`
              )
              .bind(ledgerId, tagSyncId, userId, tagName, null, 0)
              .run();
            
            createdTags.set(tagName, tagSyncId);
          }
        }
        controller.enqueue(encoder.encode(`event: stage\ndata: ${JSON.stringify({ stage: 'tags', done: i + 1, total: tagNamesArray.length })}\n\n`));
      }

      // 阶段4: 创建交易
      controller.enqueue(encoder.encode(`event: stage\ndata: ${JSON.stringify({ stage: 'transactions', done: 0, total: total, skipped: 0 })}\n\n`));
      
      let skippedCount = 0;
      let lastChangeId = 0;
      
      try {
        for (let i = 0; i < total; i++) {
          const row = session.rows[i];

          try {
            const amount = colIndex['amount'] !== undefined ? parseAmount(row[colIndex['amount']] ?? '') : 0;
            const happenedAtRaw = colIndex['happened_at'] !== undefined ? row[colIndex['happened_at']] ?? '' : '';
            const happenedAt = parseDate(happenedAtRaw) || new Date().toISOString().split('T')[0];
            const txTypeRaw = colIndex['tx_type'] !== undefined ? row[colIndex['tx_type']] ?? '' : '';
            const note = colIndex['note'] !== undefined ? row[colIndex['note']] ?? '' : '';
            const categoryName = colIndex['category_name'] !== undefined ? row[colIndex['category_name']] ?? '' : '';
            const accountName = colIndex['account_name'] !== undefined ? row[colIndex['account_name']] ?? '' : '';
            const tags = colIndex['tags'] !== undefined ? row[colIndex['tags']] ?? '' : '';

            const txType = parseTxType(txTypeRaw, amount);

            let finalAmount = Math.abs(amount);
            let finalTxType = txType;
            let categoryKind: 'expense' | 'income' | 'transfer' = 'expense';
            
            if (amount < 0 && txType === 'income') {
              finalTxType = 'expense';
            } else if (amount > 0 && txType === 'expense') {
              // 支出保持正数
            } else if (txType === 'transfer') {
              finalAmount = amount;
            }
            
            categoryKind = finalTxType === 'income' ? 'income' : 'expense';

            let skip = false;
            if (deduplicate) {
              const existing = await db
                .prepare('SELECT sync_id FROM read_tx_projection WHERE ledger_id = ? AND amount = ? AND happened_at LIKE ? LIMIT 1')
                .bind(ledgerId, finalAmount, `${happenedAt}%`)
                .first();

              if (existing) {
                skip = true;
                skippedCount++;
              }
            }

            if (!skip) {
              const syncId = randomUUID();
              const serverNow = nowUtc();

              const rowTagNames = splitTags(tags);
              const allTagSyncIds: string[] = [];
              
              for (const tagName of rowTagNames) {
                if (!tagName.trim()) continue;
                const tagSyncId = createdTags.get(tagName);
                if (tagSyncId && !allTagSyncIds.includes(tagSyncId)) {
                  allTagSyncIds.push(tagSyncId);
                }
              }
              
              for (const tagName of autoTagNames) {
                if (!tagName.trim()) continue;
                const tagSyncId = createdTags.get(tagName);
                if (tagSyncId && !allTagSyncIds.includes(tagSyncId)) {
                  allTagSyncIds.push(tagSyncId);
                }
              }
              
              const tagsCsv = allTagSyncIds.length > 0 ? allTagSyncIds.join(',') : null;
              
              const accountSyncId = accountName.trim() ? createdAccounts.get(accountName.trim()) || null : null;
              const categorySyncId = categoryName.trim() ? createdCategories.get(categoryName.trim()) || null : null;

              const payload: Record<string, unknown> = {
                tx_type: finalTxType,
                amount: finalAmount,
                happened_at: happenedAt,
                note: note || null,
                category_name: categoryName || null,
                category_kind: categoryKind,
                account_name: accountName || null,
                account_id: accountSyncId,
                category_id: categorySyncId,
                tags: tagsCsv,
                tag_ids: allTagSyncIds.length > 0 ? allTagSyncIds : null,
              };

              const changeResult = await db
                .prepare(
                  `INSERT INTO sync_changes
                   (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
                )
                .bind(userId, ledgerId, 'transaction', syncId, 'upsert', safeJsonStringify(payload), serverNow, userId)
                .run();

              lastChangeId = changeResult.meta.last_row_id as number;

              await db
                .prepare(
                  `INSERT INTO read_tx_projection
                   (ledger_id, sync_id, user_id, tx_type, amount, happened_at, note,
                    category_sync_id, category_name, category_kind,
                    account_sync_id, account_name,
                    tags_csv, tag_sync_ids_json, source_change_id)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                )
                .bind(ledgerId, syncId, userId, finalTxType, finalAmount, happenedAt, note || null,
                      categorySyncId, categoryName || null, categoryKind,
                      accountSyncId, accountName || null,
                      tagsCsv, allTagSyncIds.length > 0 ? safeJsonStringify(allTagSyncIds) : null, lastChangeId)
                .run();

              success++;
            }
            
            if (i % 10 === 0 || i === total - 1) {
              controller.enqueue(encoder.encode(`event: stage\ndata: ${JSON.stringify({ stage: 'transactions', done: success + skippedCount, total: total, skipped: skippedCount })}\n\n`));
            }
          } catch (rowErr) {
            failed++;
            const errorMsg = rowErr instanceof Error ? rowErr.message : 'Unknown error';
            controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ code: 'ROW_ERROR', row_number: i + 2, field_name: null, message: errorMsg })}\n\n`));
          }
        }

        session.status = 'done';
        await saveSession(kv, session);

        controller.enqueue(encoder.encode(`event: complete\ndata: ${JSON.stringify({ created_tx_count: success, skipped_count: skippedCount, new_change_id: lastChangeId })}\n\n`));
        controller.close();
      } catch (err) {
        session.status = 'cancelled';
        await saveSession(kv, session);
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ code: 'IMPORT_ERROR', row_number: null, field_name: null, message: errorMsg })}\n\n`));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
});

importRouter.delete('/:token', async (c) => {
  const token = c.req.param('token');
  const kv = c.env.IMPORT_SESSIONS;

  const session = await getSession(kv, token);
  if (!session) {
    return c.json({ error: 'Import token not found' }, 404);
  }

  if (session.status === 'executing') {
    return c.json({ error: 'Cannot cancel while executing' }, 400);
  }

  session.status = 'cancelled';
  await saveSession(kv, session);

  return c.json({ cancelled: true });
});

function parseCSVLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === delimiter && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  result.push(current.trim());
  return result;
}

export default importRouter;
