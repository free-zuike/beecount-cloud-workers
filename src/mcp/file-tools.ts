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
import { previewImport, type ImportCandidate } from './workflow-tools';
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

export async function listAttachments(
  c: McpContext,
  args: { ledger_id: string; q?: string | null; limit?: number; offset?: number },
): Promise<Record<string, unknown>> {
  const ledger = await requireLedger(c, args.ledger_id);
  let q = 'SELECT * FROM attachment_files WHERE ledger_id = ?';
  const p: unknown[] = [ledger.id];
  if (args.q) { q += ' AND (file_name LIKE ? OR mime_type LIKE ?)'; p.push(`%${args.q}%`, `%${args.q}%`); }
  const total = (await c.db.prepare(q.replace('SELECT *', 'SELECT COUNT(*) AS c')).bind(...p).first<{ c: number }>())?.c ?? 0;
  // 对齐上游 list_attachments：limit 上限 100、offset 非负
  const limit = Math.max(1, Math.min(args.limit ?? 40, 100));
  const offset = Math.max(0, args.offset ?? 0);
  q += ' ORDER BY created_at DESC, id LIMIT ? OFFSET ?';
  p.push(limit, offset);
  const rows = await c.db.prepare(q).bind(...p).all<AttachmentRow>();
  return {
    items: rows.results.map(r => ({
      file_id: r.id,
      file_name: r.file_name,
      mime_type: r.mime_type,
      size_bytes: Number(r.size_bytes),
      sha256: r.sha256,
      created_at: new Date(r.created_at).toISOString(),
    })),
    total,
  };
}

export async function parseReceipt(c: McpContext, args: { file_id: string; locale?: string }): Promise<Record<string, unknown>> {
  // 对齐上游 parse_receipt：不对 mime/大小设限，交给用户配置的视觉模型判断
  const { metadata, bytes } = await attachmentBytes(c, { file_id: args.file_id });
  const mime = metadata.mime_type.toLowerCase();
  const locale = args.locale ?? 'zh';
  const { parseAiConfig, findProvider, loadLedgerContext, callAiChatJson, normalizeDrafts, extractJson, SchemaInvalidError } = await import('../routes/ai');
  const { buildParseTxImageMessages } = await import('../services/ai/prompts');
  const { bytesToBase64 } = await import('../lib/base64');
  const profile = await c.db.prepare('SELECT ai_config_json FROM user_profiles WHERE user_id = ?').bind(c.userId).first<{ ai_config_json: string | null }>();
  const aiConfig = parseAiConfig(profile?.ai_config_json ?? null);
  const provider = findProvider(aiConfig, 'vision');
  if (!provider || !provider.visionModel) {
    throw new Error('Vision AI provider not configured. Please configure AI provider with vision model.');
  }
  const { categories, accounts, ledgerCurrency } = await loadLedgerContext(c.db, c.userId, metadata.ledger_id);
  const imageDataUrl = `data:${mime};base64,${bytesToBase64(bytes)}`;
  const messages = buildParseTxImageMessages({
    categories,
    accounts,
    ledgerCurrency,
    now: new Date(),
    locale,
    imageDataUrl,
    customPromptTemplate: (aiConfig as Record<string, unknown>).parseTxImagePrompt as string | null,
  });
  let drafts: Array<Record<string, unknown>>;
  try {
    const content = await callAiChatJson(provider.baseUrl, provider.apiKey, provider.visionModel, messages);
    drafts = normalizeDrafts(extractJson(content));
  } catch (err) {
    if (err instanceof SchemaInvalidError) throw new Error(`AI schema invalid: ${(err as Error).message}`);
    throw new Error(`AI parsing failed: ${err instanceof Error ? err.message.slice(0, 200) : 'unknown'}`);
  }
  return {
    tx_drafts: drafts,
    image_id: metadata.file_id,
    file_id: args.file_id,
    ledger_id: metadata.ledger_id,
    writes_performed: false,
    attachments: [args.file_id],
  };
}

export async function previewTextTransactions(c: McpContext, args: { ledger_id: string; text: string; locale?: string }): Promise<Record<string, unknown>> {
  await requireLedger(c, args.ledger_id);
  const locale = args.locale ?? 'zh';
  const { parseAiConfig, findProvider, loadLedgerContext, callAiChatJson, normalizeDrafts, extractJson, SchemaInvalidError } = await import('../routes/ai');
  const { buildParseTxTextMessages } = await import('../services/ai/prompts');
  const profile = await c.db.prepare('SELECT ai_config_json FROM user_profiles WHERE user_id = ?').bind(c.userId).first<{ ai_config_json: string | null }>();
  const aiConfig = parseAiConfig(profile?.ai_config_json ?? null);
  const provider = findProvider(aiConfig, 'text');
  if (!provider || !provider.textModel) {
    throw new Error('AI provider not configured. Please configure AI provider in settings.');
  }
  const { categories, accounts, ledgerCurrency } = await loadLedgerContext(c.db, c.userId, args.ledger_id);
  const messages = buildParseTxTextMessages({
    text: args.text,
    categories,
    accounts,
    ledgerCurrency,
    now: new Date(),
    locale,
    customPromptTemplate: (aiConfig as Record<string, unknown>).parseTxTextPrompt as string | null,
  });
  let drafts: Array<Record<string, unknown>>;
  try {
    const content = await callAiChatJson(provider.baseUrl, provider.apiKey, provider.textModel, messages);
    drafts = normalizeDrafts(extractJson(content));
  } catch (err) {
    if (err instanceof SchemaInvalidError) throw new Error(`AI schema invalid: ${(err as Error).message}`);
    throw new Error(`AI parsing failed: ${err instanceof Error ? err.message.slice(0, 200) : 'unknown'}`);
  }
  return { tx_drafts: drafts, writes_performed: false, ledger_id: args.ledger_id };
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
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('Import file is empty or has no data rows');
  const headers = rows[0];
  const mapping = args.mapping ?? {};
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
  const candidates: ImportCandidate[] = [];
  const errors: Array<Record<string, unknown>> = [];
  for (let i = 0; i < dataRows.length; i++) {
    const r = dataRows[i];
    const transaction: Record<string, unknown> = {};
    if (txTypeCol !== null) {
      const v = (r[txTypeCol] ?? '').trim().toLowerCase();
      if (v && ['expense', 'income', 'transfer'].includes(v)) transaction.tx_type = v;
      else transaction.tx_type = mapping.expense_is_negative ? 'income' : 'expense';
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
      errors.push({ row: offset + i + 2, code: 'INVALID_TRANSACTION', message: 'amount column missing or unparsable' });
    }
  }
  // 对齐上游：有错误或无候选 → mapping_or_data_errors，不生成 plan
  if (errors.length > 0 || candidates.length === 0) {
    return {
      file_id: args.file_id,
      file_sha256: metadata.sha256,
      headers,
      suggested_mapping: {},
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
    suggested_mapping: {},
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
  q += ' ORDER BY happened_at, sync_id LIMIT ?';
  p.push(50001);
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
  ).bind(exportId, c.userId, ledger.id, JSON.stringify({ csv, sha256: sha, row_count: matched.length }), now, now).run();
  return {
    export_id: exportId,
    row_count: matched.length,
    revision: await revision(c.db, [ledger.id], ledger.user_id),
    sha256: sha,
    resource_uri: `beecount://exports/${exportId}`,
  };
}