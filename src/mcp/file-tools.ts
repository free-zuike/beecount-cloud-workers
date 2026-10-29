/**
 * 附件/文件导入导出工具（对齐原版 src/mcp/file_tools.py，#133）。
 *
 * - attachment_bytes / read_attachment / list_attachments：附件字节与元数据
 * - preview_import_file：CSV → 导入候选 → preview_import（映射可配置）
 * - export_transactions：交易导出 CSV（含 BOM、防公式注入，落 export 记录）
 *
 * 存储字节源通过 setAttachmentBytesSource 注入（生产默认 R2，测试注入内存）。
 * parse_receipt / preview_text_transactions 依赖本地 AI 解析通道，暂标记未实现。
 */
import { createHash } from 'node:crypto';
import { requireLedger } from './capability-tools';
import { uuid4, revision, parseDateBoundary } from './query-context';
import { parseXlsx } from './xlsx';
import { previewImport, type ImportCandidate } from './workflow-tools';
import { selfCallAdapter } from './transaction-service';
import type { McpContext } from './types';

export interface ImportMapping {
  tx_type?: string | null;
  amount?: string | null;
  happened_at?: string | null;
  category_name?: string | null;
  subcategory_name?: string | null;
  account_name?: string | null;
  from_account_name?: string | null;
  to_account_name?: string | null;
  note?: string | null;
  currency?: string | null;
  tags?: string[];
  datetime_format?: string | null;
  strip_currency_symbols?: boolean;
  expense_is_negative?: boolean;
  tz_offset_minutes?: number | null;
}

export interface AttachmentMetadata {
  file_id: string;
  ledger_id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  resource_uri: string;
}

export type AttachmentBytesSource = (c: McpContext, fileId: string) => Promise<Uint8Array>;

let bytesSource: AttachmentBytesSource | null = null;

/** 测试注入存储字节源（对齐 selfCall 模式；生产实现默认从 R2 读） */
export function setAttachmentBytesSource(fn: AttachmentBytesSource | null): void {
  bytesSource = fn;
}

/** 注册生产默认字节源（从 storage_adapter 的 R2/备份远端读取）；已注入源时跳过。 */
export async function ensureProductionBytesSource(
  db: D1Database,
  env: { R2?: R2Bucket },
): Promise<void> {
  if (bytesSource) return;
  const { downloadFromStorage } = await import('../lib/storage-adapter');
  setAttachmentBytesSource(async (c, fileId) => {
    const row = await c.db.prepare('SELECT storage_path FROM attachment_files WHERE id = ?')
      .bind(fileId).first<{ storage_path: string | null }>();
    if (!row?.storage_path) throw new Error('Attachment storage unavailable');
    const bytes = await downloadFromStorage(db, env, row.storage_path);
    if (!bytes) throw new Error('Attachment storage unavailable');
    return bytes;
  });
}

interface AttachmentRow {
  id: string;
  ledger_id: string;
  user_id: string;
  sha256: string;
  size_bytes: number;
  mime_type: string | null;
  file_name: string | null;
  storage_path: string | null;
  attachment_kind: string | null;
  created_at: string;
}

export async function attachmentBytes(
  c: McpContext,
  args: { file_id: string },
): Promise<{ metadata: AttachmentMetadata; bytes: Uint8Array }> {
  const row = await c.db.prepare('SELECT * FROM attachment_files WHERE id = ?').bind(args.file_id).first<AttachmentRow>();
  // 对齐上游 attachment_bytes：只认 transaction 附件、必须有 ledger_id
  if (!row || !row.ledger_id || row.attachment_kind !== 'transaction') throw new Error('Attachment not found');
  const ledger = await c.db.prepare('SELECT id, user_id, external_id, name, currency FROM ledgers WHERE id = ?')
    .bind(row.ledger_id).first<{ id: string; user_id: string; external_id: string; name: string | null; currency: string | null }>();
  if (!ledger) throw new Error('Attachment not found');
  await requireLedger(c, ledger.external_id);
  if (!bytesSource) throw new Error('Attachment storage unavailable');
  const bytes = await bytesSource(c, args.file_id);
  // 对齐上游 attachment_bytes：读取前先按配置上限判大小
  const maxBytes = Number(c.env?.ATTACHMENT_MAX_UPLOAD_BYTES ?? c.env?.MAX_ATTACHMENT_BYTES ?? 64 * 1024 * 1024);
  if (bytes.length > maxBytes) throw new Error('Attachment exceeds configured size limit');
  // 大小 + sha256 双重完整性校验（原版 hashlib.sha256(raw).hexdigest() != row.sha256）
  if (bytes.length !== Number(row.size_bytes)) {
    throw new Error('Attachment integrity check failed');
  }
  if (createHash('sha256').update(bytes).digest('hex') !== row.sha256) {
    throw new Error('Attachment integrity check failed');
  }
  const metadata: AttachmentMetadata = {
    file_id: row.id,
    ledger_id: ledger.external_id,
    file_name: row.file_name ?? row.id,
    mime_type: row.mime_type ?? 'application/octet-stream',
    size_bytes: Number(row.size_bytes),
    sha256: row.sha256,
    resource_uri: `beecount://attachments/${row.id}`,
  };
  return { metadata, bytes };
}

/**
 * 读取原始附件（对齐上游 read_attachment）：
 * - 图片（png/jpeg/webp/gif）且 ≤ 8 MiB → 直接给 ImageContent（不做缩放/转码）
 * - 文本/JSON 且 ≤ 64 KiB → 给文本内容（utf-8-sig 解码）
 * - 其他 → 只给认证过的 MCP 资源链接（beecount://attachments/<id>）
 */
export async function readAttachment(c: McpContext, args: { file_id: string }): Promise<Record<string, unknown>> {
  const { metadata, bytes } = await attachmentBytes(c, { file_id: args.file_id });
  const content: Array<Record<string, unknown>> = [
    { type: 'text', text: JSON.stringify(metadata) },
  ];
  const mime = metadata.mime_type.toLowerCase();
  const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
  if (IMAGE_MIMES.has(mime) && bytes.length <= 8 * 1024 * 1024) {
    content.push({ type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType: metadata.mime_type });
  } else if (bytes.length <= 65536 && (mime.startsWith('text/') || mime === 'application/json')) {
    const text = Buffer.from(bytes).toString('utf8').replace(/^\uFEFF/, '');
    content.push({ type: 'text', text });
  } else {
    content.push({
      type: 'resource_link',
      uri: metadata.resource_uri,
      name: metadata.file_name || metadata.file_id,
      mimeType: metadata.mime_type,
    });
  }
  return { content };
}

/**
 * 附件画廊（对齐上游 list_attachments → routers/read/attachment_gallery.py）：
 * 数据源是**交易里的 attachments_json 引用**，不是 attachment_files 表；
 * 按 file_key（cloudFileId，否则 local:{sync_id}:{下标}）聚合并带上关联交易。
 *
 * 返回 items[{key, attachment, happened_at, mime_type, status, transactions[]}]
 * + total（文件数）+ transaction_total（交易数）+ limit + offset
 */
export async function listAttachments(
  c: McpContext,
  args: {
    ledger_id: string;
    q?: string | null;
    category_id?: string | null;
    date_from?: string | null;
    date_to?: string | null;
    limit?: number;
    offset?: number;
    time_zone?: string | null;
  },
): Promise<Record<string, unknown>> {
  const ledger = await requireLedger(c, args.ledger_id);
  const limit = Math.max(1, Math.min(args.limit ?? 40, 100));
  const offset = Math.max(0, args.offset ?? 0);

  // 引用子查询：json_each 展开 attachments_json，只保留有 fileName 的条目
  let sql = `SELECT
      COALESCE(NULLIF(json_extract(je.value, '$.cloudFileId'), ''), 'local:' || t.sync_id || ':' || je.key) AS file_key,
      NULLIF(json_extract(je.value, '$.cloudFileId'), '') AS cloud_file_id,
      je.value AS ref,
      json_extract(je.value, '$.originalName') AS original_name,
      json_extract(je.value, '$.fileName') AS file_name,
      t.sync_id, t.happened_at, t.note, t.category_name, t.category_sync_id,
      t.amount, t.tx_type, t.currency_code, t.native_amount, t.account_name
    FROM read_tx_projection t, json_each(t.attachments_json) je
    WHERE t.ledger_id = ? AND json_extract(je.value, '$.fileName') IS NOT NULL`;
  const p: unknown[] = [ledger.id];
  if (args.date_from) { sql += ' AND t.happened_at >= ?'; p.push(parseDateBoundary(args.date_from, { timeZone: args.time_zone ?? undefined }).toISOString()); }
  if (args.date_to) { sql += ' AND t.happened_at < ?'; p.push(parseDateBoundary(args.date_to, { end: true, timeZone: args.time_zone ?? undefined }).toISOString()); }
  if (args.category_id) { sql += ' AND t.category_sync_id = ?'; p.push(args.category_id); }
  if (args.q && args.q.trim()) {
    const like = `%${args.q.trim().replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
    sql += ` AND (original_name LIKE ? ESCAPE '\\' OR file_name LIKE ? ESCAPE '\\' OR t.note LIKE ? ESCAPE '\\'
             OR t.category_name LIKE ? ESCAPE '\\' OR t.account_name LIKE ? ESCAPE '\\' OR CAST(t.amount AS TEXT) LIKE ? ESCAPE '\\')`;
    p.push(like, like, like, like, like, like);
  }

  const refs = await c.db.prepare(sql).bind(...p).all<Record<string, unknown>>();
  const byKey = new Map<string, { happenedAt: string; refs: Array<Record<string, unknown>> }>();
  const syncIds = new Set<string>();
  for (const r of refs.results) {
    const key = String(r.file_key ?? '');
    const bucket = byKey.get(key) ?? { happenedAt: String(r.happened_at ?? ''), refs: [] };
    if (String(r.happened_at ?? '') > bucket.happenedAt) bucket.happenedAt = String(r.happened_at ?? '');
    bucket.refs.push(r);
    byKey.set(key, bucket);
    syncIds.add(String(r.sync_id ?? ''));
  }
  const total = byKey.size;
  const transactionTotal = syncIds.size;

  // 排序：最近发生时间优先，其次 file_key 升序（对齐上游）
  const pageKeys = [...byKey.entries()]
    .sort(([ka, a], [kb, b]) => b.happenedAt.localeCompare(a.happenedAt) || ka.localeCompare(kb))
    .slice(offset, offset + limit)
    .map(([k]) => k);

  const cloudIds = [...new Set(pageKeys.flatMap(k => byKey.get(k)!.refs
    .map(r => r.cloud_file_id).filter((v): v is string => typeof v === 'string' && v !== '')))];
  const stored = new Map<string, { mime_type: string | null }>();
  if (cloudIds.length) {
    const rows = await c.db.prepare(
      `SELECT id, mime_type FROM attachment_files WHERE id IN (${cloudIds.map(() => '?').join(',')})
       AND ledger_id = ? AND attachment_kind = 'transaction'`,
    ).bind(...cloudIds, ledger.id).all<{ id: string; mime_type: string | null }>();
    for (const r of rows.results) stored.set(r.id, { mime_type: r.mime_type });
  }

  const items = pageKeys.map(key => {
    const bucket = byKey.get(key)!;
    const first = bucket.refs[0];
    const cloudId = typeof first.cloud_file_id === 'string' && first.cloud_file_id ? first.cloud_file_id : null;
    const file = cloudId ? stored.get(cloudId) : undefined;
    let attachment: unknown = null;
    try { attachment = typeof first.ref === 'string' ? JSON.parse(first.ref) : first.ref; } catch { attachment = null; }
    const transactions: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    for (const r of [...bucket.refs].sort((a, b) => String(b.happened_at ?? '').localeCompare(String(a.happened_at ?? ''))
      || String(a.sync_id ?? '').localeCompare(String(b.sync_id ?? '')))) {
      const sid = String(r.sync_id ?? '');
      if (seen.has(sid)) continue;
      seen.add(sid);
      transactions.push({
        id: sid,
        ledger_id: ledger.external_id,
        note: r.note ?? null,
        category_name: r.category_name ?? null,
        category_id: r.category_sync_id ?? null,
        amount: r.amount ?? null,
        tx_type: r.tx_type ?? null,
        currency_code: r.currency_code ?? null,
        native_amount: r.native_amount ?? null,
        happened_at: r.happened_at ? `${new Date(String(r.happened_at)).toISOString().slice(0, 19)}+00:00` : null,
      });
    }
    return {
      key,
      attachment,
      happened_at: bucket.happenedAt ? `${new Date(bucket.happenedAt).toISOString().slice(0, 19)}+00:00` : null,
      mime_type: file?.mime_type ?? null,
      status: !cloudId ? 'pending' : file ? 'ready' : 'missing',
      transactions,
    };
  });

  return { items, total, transaction_total: transactionTotal, limit, offset };
}

export async function parseReceipt(c: McpContext, args: { file_id: string; locale?: string }): Promise<Record<string, unknown>> {
  // 对齐上游 parse_receipt：不对 mime/大小设限，交给用户配置的视觉模型判断
  const { metadata, bytes } = await attachmentBytes(c, { file_id: args.file_id });
  const mime = metadata.mime_type.toLowerCase();
  const locale = args.locale ?? 'zh';
  // 对齐上游 parse_receipt：self-call 生产 /api/v1/ai/parse-tx-image（multipart）
  // 复用服务端视觉 prompt 与账本上下文，不在 MCP 侧自己拼 messages
  const form = new FormData();
  form.set('ledger_id', String(metadata.ledger_id ?? ''));
  form.set('locale', locale);
  form.set('image', new Blob([bytes], { type: mime }), String(metadata.file_name ?? 'receipt'));
  const result = await selfCallAdapter(c)('POST', '/api/v1/ai/parse-tx-image', c.userId, form, {});
  return {
    ...(result as Record<string, unknown> ?? {}),
    file_id: args.file_id,
    ledger_id: metadata.ledger_id,
    writes_performed: false,
    attachments: [args.file_id],
  };
}

export async function previewTextTransactions(c: McpContext, args: { ledger_id: string; text: string; locale?: string }): Promise<Record<string, unknown>> {
  await requireLedger(c, args.ledger_id);
  const locale = args.locale ?? 'zh';
  // 对齐上游 preview_text_transactions：self-call 生产 /api/v1/ai/parse-tx-text
  // （复用服务端 prompt、字典与账本上下文，跟 parse_and_create_from_text 同一条链路）
  const result = await selfCallAdapter(c)(
    'POST', '/api/v1/ai/parse-tx-text', c.userId,
    { ledger_id: args.ledger_id, text: args.text, locale },
    {},
  );
  return { ...(result as Record<string, unknown> ?? {}), writes_performed: false };
}

/**
 * 列名别名表（对齐上游 services/import_data/parsers/generic.py 的 _PATTERNS）。
 * 顺序即抢占优先级：tx_type → amount → currency → happened_at → category_name →
 * subcategory_name → account_name → from/to account → note → tags，一列只服务一个字段。
 */
const SUGGEST_PATTERNS: Array<[keyof ImportMapping, RegExp]> = [
  ['tx_type', /^(类型|type|kind|收[/／]?支|收支)$/i],
  ['amount', /(金额|amount|amt|价格|price|总金额|发生额|sum|total)/i],
  ['currency', /^(币种|幣種|货币|貨幣|currency|currency\s*code)$/i],
  ['happened_at', /(交易时间|交易创建时间|创建时间|发生时间|happened|时间|日期|date|when)/i],
  ['category_name', /(分类|交易类型|类别|商品类目|主类目|顶级分类|父类|category|cat$)/i],
  ['subcategory_name', /(二级分类|子分类|子类目|subcategory|sub.?cat)/i],
  ['account_name', /(账户|账号|account|支付方式|付款方式|收[/／]?付款方式|来源|出处)/i],
  ['from_account_name', /(转出|from.?account|source.?account|出账)/i],
  ['to_account_name', /(转入|to.?account|dest.?account|target.?account|入账)/i],
  ['note', /(商品说明|商品|商家|对方|交易对方|备注|note|description|说明|memo)/i],
  ['tags', /(标签|tag|label)/i],
];

/**
 * 推断建议映射（对齐上游 GenericParser.suggest_mapping）：跳过空列名，
 * 按优先级匹配且一列只被一个字段占用。
 */
// 对齐上游 transformer 的收支类型关键字表（含中文）
const TYPE_EXPENSE = new Set(['expense', '支出', '消费', '出', '-', '支']);
const TYPE_INCOME = new Set(['income', '收入', '收', '+', '入']);
const TYPE_TRANSFER = new Set(['transfer', '转账', '转出转入', '转']);

/**
 * 对齐上游 _parse_tx_type：精确匹配优先，未命中再做子串匹配。
 * 空值：上游在 expense_is_negative 时返 'expense'，否则 None（由调用方记错误）。
 */
export function parseTxType(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  if (TYPE_EXPENSE.has(s)) return 'expense';
  if (TYPE_INCOME.has(s)) return 'income';
  if (TYPE_TRANSFER.has(s)) return 'transfer';
  for (const kw of ['支出', 'expense', '消费']) if (s.includes(kw)) return 'expense';
  for (const kw of ['收入', 'income']) if (s.includes(kw)) return 'income';
  return null;
}

export function suggestMapping(headers: string[]): ImportMapping {
  const nonEmpty = headers.filter(h => (h ?? '').trim() !== '');
  const taken = new Set<string>();
  const grab = (pattern: RegExp): string | null => {
    for (const h of nonEmpty) {
      if (taken.has(h)) continue;
      if (pattern.test(h)) { taken.add(h); return h; }
    }
    return null;
  };
  const out: ImportMapping = {};
  for (const [field, pattern] of SUGGEST_PATTERNS) {
    const hit = grab(pattern);
    if (field === 'tags') out.tags = hit ? [hit] : [];
    else (out as Record<string, unknown>)[field] = hit;
  }
  out.datetime_format = null;
  out.strip_currency_symbols = true;
  out.expense_is_negative = false;
  // 上游 ImportFieldMapping 有该字段（默认 None），必须显式带上，
  // 否则 golden 比对会出现"上游有 null、本地缺键"
  out.tz_offset_minutes = null;
  return out;
}

/** CSV 基础解析（对齐上游最小解析面：逗号分隔、引号包裹、回车忽略）。 */
function parseCsv(raw: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inQuotes) {
      if (ch === '"') {
        if (raw[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && raw[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(f => f.trim() !== ''));
}

export async function previewImportFile(
  c: McpContext,
  args: { file_id: string; mapping?: ImportMapping | null; source_system?: string; source_id_column?: string | null; time_zone?: string | null; offset?: number; limit?: number },
): Promise<Record<string, unknown>> {
  const { metadata, bytes } = await attachmentBytes(c, { file_id: args.file_id });
  // 对齐上游：导入文件 ≤ 16 MiB；utf-8-sig 解码，失败回落 GBK
  if (bytes.length > 16 * 1024 * 1024) throw new Error('Import files must be at most 16 MiB');
  let text: string;
  try {
    text = Buffer.from(bytes).toString('utf8').replace(/^\uFEFF/, '');
  } catch {
    text = new TextDecoder('gbk').decode(bytes);
  }
  // 对齐上游：按扩展名/mime 选择解析器（csv/tsv → 文本解析；xlsx → 工作簿解析）
  // 对齐上游：扩展名 / mime / ZIP 本地文件头(PK\x03\x04) 任一命中即按工作簿解析
  const isXlsx = /\.xlsx$/i.test(metadata.file_name ?? '')
    || metadata.mime_type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    || (bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04);
  const rows = isXlsx ? await parseXlsx(bytes) : parseCsv(text);
  if (rows.length < 2) throw new Error('Import file is empty or has no data rows');
  const headers = rows[0];
  // 对齐上游：未给 mapping 时用解析器的建议映射（不再空映射导致全行报错）
  const suggested = suggestMapping(headers);
  const mapping: ImportMapping = args.mapping ?? suggested;
  const lookup = (col: string | null | undefined): { index: number; header: string } | null => {
    if (!col) return null;
    const index = headers.indexOf(col);
    return index >= 0 ? { index, header: col } : null;
  };
  const col = (m: string | null | undefined): number | null => lookup(m)?.index ?? null;
  const txTypeCol = col(mapping.tx_type);
  const amountCol = col(mapping.amount);
  const happenedAtCol = col(mapping.happened_at);
  const categoryCol = col(mapping.category_name) ?? col(mapping.subcategory_name);
  const accountCol = col(mapping.account_name);
  const fromCol = col(mapping.from_account_name);
  const toCol = col(mapping.to_account_name);
  const noteCol = col(mapping.note);
  const currencyCol = col(mapping.currency);
  const sourceIdCol = args.source_id_column ? col(args.source_id_column) : null;

  const offset = Math.max(0, args.offset ?? 0);
  // 对齐上游：单个 plan 最多 200 行；文件总行数上限 50000
  const limit = Math.max(1, Math.min(args.limit ?? 200, 200));
  if (rows.length - 1 > 50000) throw new Error('Import files may contain at most 50000 rows');
  const dataRows = rows.slice(offset + 1, offset + 1 + limit);
  // 对齐上游 transformer.apply_mapping：required_complete 不成立时**不逐行转换**，
  // 只报一条 PARSE_MAPPING_INCOMPLETE 节省体积。
  // required_complete = tx_type & amount & happened_at & category_name
  // （是 category_name 本身，不含 subcategory 兜底）
  const missing: string[] = [];
  if (!mapping.tx_type) missing.push('tx_type');
  if (!mapping.amount) missing.push('amount');
  if (!mapping.happened_at) missing.push('happened_at');
  if (!mapping.category_name) missing.push('category_name');
  if (missing.length > 0) {
    return {
      file_id: args.file_id,
      file_sha256: metadata.sha256,
      headers,
      suggested_mapping: suggested,
      total_rows: rows.length - 1,
      offset,
      next_offset: offset + dataRows.length < rows.length - 1 ? offset + dataRows.length : null,
      errors: [{
        row_number: 0,
        code: 'PARSE_MAPPING_INCOMPLETE',
        field_name: null,
        raw_line: '',
        message: `required mapping fields missing: ${missing.join(', ')}`,
      }],
      warnings: [],
      status: 'mapping_or_data_errors',
      plan: null,
    };
  }

  const candidates: ImportCandidate[] = [];
  const errors: Array<Record<string, unknown>> = [];
  for (let i = 0; i < dataRows.length; i++) {
    const r = dataRows[i];
    const transaction: Record<string, unknown> = {};
    if (txTypeCol !== null) {
      // 对齐上游 services/import_data/transformer._parse_tx_type：
      // 中文类型词必须识别，否则"收入"行会被当成支出（资损级）
      const parsed = parseTxType(String(r[txTypeCol] ?? '').trim());
      transaction.tx_type = parsed ?? (mapping.expense_is_negative ? 'expense' : 'expense');
    }
    if (amountCol !== null) {
      let v = String(r[amountCol] ?? '').trim();
      if (mapping.strip_currency_symbols !== false) v = v.replace(/[^\d.\-+]/g, '');
      const n = parseFloat(v);
      if (!isNaN(n)) {
        transaction.amount = mapping.expense_is_negative && n < 0 ? -n : Math.abs(n);
      }
    }
    if (happenedAtCol !== null && (r[happenedAtCol] ?? '').trim()) transaction.happened_at = String(r[happenedAtCol]).trim();
    if (categoryCol !== null && (r[categoryCol] ?? '').trim()) transaction.category = String(r[categoryCol]).trim();
    if (accountCol !== null && (r[accountCol] ?? '').trim()) transaction.account = String(r[accountCol]).trim();
    if (fromCol !== null && (r[fromCol] ?? '').trim()) transaction.from_account = String(r[fromCol]).trim();
    if (toCol !== null && (r[toCol] ?? '').trim()) transaction.to_account = String(r[toCol]).trim();
    if (noteCol !== null && (r[noteCol] ?? '').trim()) transaction.note = String(r[noteCol]).trim();
    if (currencyCol !== null && (r[currencyCol] ?? '').trim()) transaction.currency = String(r[currencyCol]).trim();
    if (mapping.tags && mapping.tags.length > 0) transaction.tags = mapping.tags;
    const sourceId = sourceIdCol !== null ? String(r[sourceIdCol] ?? '').trim() : null;
    // 对齐上游：空 source_id 记错误并跳过该行（不中断整批）
    if (sourceId !== null && sourceId === '') {
      errors.push({ row_number: offset + i + 2, code: 'EMPTY_SOURCE_ID' });
      continue;
    }
    candidates.push({
      transaction,
      sources: [{
        source_system: args.source_system ?? 'file',
        // 对齐上游：默认 source_id 带行号，避免同一文件多行撞 DUPLICATE_SOURCE_IN_PLAN
        source_id: sourceId ?? `${metadata.sha256}:${offset + i + 2}`,
        file_sha256: metadata.sha256,
        row_number: offset + i + 2,
      }],
    });
  }
  const warnings: Array<Record<string, unknown>> = [];
  for (let i = 0; i < candidates.length; i++) {
    if (candidates[i].transaction.amount === undefined) {
      // 对齐上游 ImportError 的字段集合：row_number / code / field_name / raw_line / message
      errors.push({
        row_number: offset + i + 2,
        code: 'INVALID_TRANSACTION',
        field_name: 'amount',
        raw_line: '',
        message: 'amount column missing or unparsable',
      });
    }
  }
  // 对齐上游：有错误或无候选 → mapping_or_data_errors，不生成 plan
  if (errors.length > 0 || candidates.length === 0) {
    return {
      file_id: args.file_id,
      file_sha256: metadata.sha256,
      headers,
      suggested_mapping: suggested,
      total_rows: rows.length - 1,
      offset,
      next_offset: offset + dataRows.length < rows.length - 1 ? offset + dataRows.length : null,
      errors,
      warnings,
      status: 'mapping_or_data_errors',
      plan: null,
    };
  }
  const plan = await previewImport(c, { ledger_id: metadata.ledger_id, candidates, time_zone: args.time_zone ?? null });
  const out: Record<string, unknown> = {
    file_id: args.file_id,
    file_sha256: metadata.sha256,
    headers,
    suggested_mapping: suggested,
    total_rows: rows.length - 1,
    offset,
    next_offset: offset + dataRows.length < rows.length - 1 ? offset + dataRows.length : null,
    errors,
    warnings,
    status: errors.length > 0 ? 'mapping_or_data_errors' : (plan.status ?? 'ready'),
    plan: plan,
  };
  return out;
}

/** 对齐上游 export_transactions 的列集合（含 *_id，便于外部系统回链） */
const EXPORT_HEADERS = [
  'sync_id', 'tx_type', 'amount', 'happened_at', 'note',
  'category_id', 'category_name',
  'account_id', 'account_name',
  'from_account_id', 'from_account_name',
  'to_account_id', 'to_account_name',
  'tags', 'currency_code', 'native_amount',
  'exclude_from_stats', 'exclude_from_budget',
];

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  // 对齐原版 csv 契约：只对字符串做公式注入防护，数字（含负数）原样输出
  if (typeof value !== 'string') return String(value);
  let s = value;
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export async function exportTransactions(
  c: McpContext,
  args: { ledger_id: string; date_from?: string | null; date_to?: string | null; tx_type?: string | null; account_id?: string | null; category_id?: string | null; tag_id?: string | null; time_zone?: string | null },
): Promise<Record<string, unknown>> {
  const ledger = await requireLedger(c, args.ledger_id);
  const baseline = await revision(c.db, [ledger.id], ledger.user_id);
  let q = 'SELECT * FROM read_tx_projection WHERE ledger_id = ?';
  const p: unknown[] = [ledger.id];
  // 对齐上游：日期边界走 date_boundary（裸日期按查询时区折算，包尾）
  const tzForBoundary = args.time_zone ?? undefined;
  if (args.date_from) { q += ' AND happened_at >= ?'; p.push(parseDateBoundary(args.date_from, { timeZone: tzForBoundary }).toISOString()); }
  if (args.date_to) { q += ' AND happened_at < ?'; p.push(parseDateBoundary(args.date_to, { end: true, timeZone: tzForBoundary }).toISOString()); }
  if (args.tx_type) {
    if (!['income', 'expense', 'transfer'].includes(args.tx_type)) throw new Error('Invalid tx_type');
    q += ' AND tx_type = ?'; p.push(args.tx_type);
  }
  if (args.account_id) { q += ' AND (account_sync_id = ? OR from_account_sync_id = ? OR to_account_sync_id = ?)'; p.push(args.account_id, args.account_id, args.account_id); }
  if (args.category_id) { q += ' AND category_sync_id = ?'; p.push(args.category_id); }
  q += ' ORDER BY happened_at, sync_id';
  // 对齐上游：只有不带 tag_id 时才用 LIMIT 50001 提前截断（带 tag_id 需内存筛选，不能先截断）
  if (!args.tag_id) { q += ' LIMIT ?'; p.push(50001); }
  const rows = await c.db.prepare(q).bind(...p).all<Record<string, unknown>>();
  // 对齐上游：tag_id 用 JSON 成员精确匹配（不做通配符插值），其余场景直接用查询结果
  const matched = args.tag_id
    ? rows.results.filter(r => {
        try { return (JSON.parse(String(r.tag_sync_ids_json ?? '[]')) as string[]).includes(args.tag_id!); } catch { return false; }
      })
    : rows.results;
  if (matched.length > 50000) throw new Error('Export exceeds 50000 rows; narrow the date range');

  const lines = [EXPORT_HEADERS.map(csvEscape).join(',')];
  for (const r of matched) {
    const item: Record<string, unknown> = { ...r };
    // 对齐上游：非空币种时回落到账本币种
    if (!item.currency_code) item.currency_code = ledger.currency;
    // 对齐上游：happened_at 输出 ...+00:00（原版 isoformat）
    if (item.happened_at) item.happened_at = `${new Date(String(item.happened_at)).toISOString().slice(0, 19)}+00:00`;
    lines.push(EXPORT_HEADERS.map(h => csvEscape(item[h as string] ?? '')).join(','));
  }
  const csv = '\uFEFF' + lines.join('\r\n');
  // 对齐上游：导出期间数据变更 → REVISION_CONFLICT，避免给出不一致快照
  if ((await revision(c.db, [ledger.id], ledger.user_id)) !== baseline) {
    throw new Error('REVISION_CONFLICT: data changed during export; retry');
  }
  const sha = createHash('sha256').update(csv, 'utf8').digest('hex');
  const exportId = uuid4();
  const now = new Date().toISOString();
  // 导出记录 id 与返回的 export_id 一致（供 beecount://exports/<id> 资源寻址）
  await c.db.prepare(
    `INSERT INTO mcp_state_records (id, user_id, ledger_id, kind, revision, status, data_json, next_due_at, created_at, updated_at)
     VALUES (?, ?, ?, 'export', 1, 'ready', ?, NULL, ?, ?)`
  ).bind(exportId, c.userId, ledger.id, JSON.stringify({ csv, sha256: sha, row_count: matched.length, dataset_revision: baseline }), now, now).run();
  return {
    export_id: exportId,
    row_count: matched.length,
    // 对齐上游：返回导出快照的基线 revision（不重算，重算会与 CSV 内容不一致）
    dataset_revision: baseline,
    revision: baseline,
    sha256: sha,
    resource_uri: `beecount://exports/${exportId}`,
  };
}