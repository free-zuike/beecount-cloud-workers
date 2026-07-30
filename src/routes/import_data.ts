/**
 * 导入路由模块 - 对齐原版 Python routers/import_data/endpoints.py
 *
 * 端点：
 * - POST /import/upload             - 上传文件，解析行列，返回预览
 * - POST /import/{token}/preview    - 字段映射预览
 * - POST /import/{token}/execute    - 执行导入（SSE 进度流）
 * - DELETE /import/{token}          - 取消导入 token
 *
 * 支持格式：CSV / TSV / XLSX
 * 来源识别：BeeCount 自家格式 / 通用（支付宝/微信/银行账单等）
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { parseCsvText, detectSourceFormat, suggestMapping } from '../services/import_data/parser';
import { applyMapping } from '../services/import_data/transformer';
import { buildExistingSets, computeStats } from '../services/import_data/stats';
import type { ImportFieldMapping, ImportData, ImportTransaction } from '../services/import_data/schema';
import { makeDefaultMapping, isMappingComplete } from '../services/import_data/schema';

function nowUtc(): string { return new Date().toISOString(); }

type Bindings = { DB: D1Database; IMPORT_SESSIONS: KVNamespace; JWT_SECRET: string };
type Variables = { userId: string };

const importRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// ==================== KV Session Helpers ====================

interface ImportSession {
  token: string;
  userId: string;
  fileName: string;
  data: ImportData;
  mapping: ImportFieldMapping;
  targetLedgerId: string | null;
  dedupStrategy: string;
  autoTagNames: string[];
  status: 'pending' | 'previewed' | 'executing' | 'done' | 'cancelled';
  createdAt: string;
  expiresAt: string;
}

async function saveSession(kv: KVNamespace, session: ImportSession): Promise<void> {
  await kv.put(`import:${session.token}`, JSON.stringify(session), {
    expirationTtl: 1800, // 30 min
  });
}

async function getSession(kv: KVNamespace, token: string): Promise<ImportSession | null> {
  const raw = await kv.get(`import:${token}`);
  if (!raw) return null;
  return JSON.parse(raw) as ImportSession;
}

async function deleteSession(kv: KVNamespace, token: string): Promise<void> {
  await kv.delete(`import:${token}`);
}

// ==================== Schemas ====================

const FieldMappingSchema = z.object({
  tx_type: z.string().nullable().optional(),
  amount: z.string().nullable().optional(),
  happened_at: z.string().nullable().optional(),
  category_name: z.string().nullable().optional(),
  subcategory_name: z.string().nullable().optional(),
  account_name: z.string().nullable().optional(),
  from_account_name: z.string().nullable().optional(),
  to_account_name: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  currency: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  datetime_format: z.string().nullable().optional(),
  strip_currency_symbols: z.boolean().optional(),
  expense_is_negative: z.boolean().optional(),
  tz_offset_minutes: z.number().nullable().optional(),
});

const ImportPreviewSchema = z.object({
  mapping: FieldMappingSchema,
  target_ledger_id: z.string().nullable().optional(),
  dedup_strategy: z.enum(['skip_duplicates', 'insert_all']).optional(),
  auto_tag_names: z.array(z.string()).optional(),
});

const ImportExecuteSchema = z.object({
  mapping: FieldMappingSchema,
  target_ledger_id: z.string(),
  dedup_strategy: z.enum(['skip_duplicates', 'insert_all']).optional(),
  auto_tag_names: z.array(z.string()).optional(),
});

// ==================== Helpers ====================

function mappingToInternal(m: Record<string, unknown>): ImportFieldMapping {
  return {
    txType: (m.tx_type as string) ?? null,
    amount: (m.amount as string) ?? null,
    happenedAt: (m.happened_at as string) ?? null,
    categoryName: (m.category_name as string) ?? null,
    subcategoryName: (m.subcategory_name as string) ?? null,
    accountName: (m.account_name as string) ?? null,
    fromAccountName: (m.from_account_name as string) ?? null,
    toAccountName: (m.to_account_name as string) ?? null,
    note: (m.note as string) ?? null,
    currency: (m.currency as string) ?? null,
    tags: (m.tags as string[]) ?? [],
    datetimeFormat: (m.datetime_format as string) ?? null,
    stripCurrencySymbols: (m.strip_currency_symbols as boolean) ?? true,
    expenseIsNegative: (m.expense_is_negative as boolean) ?? false,
    tzOffsetMinutes: (m.tz_offset_minutes as number) ?? null,
  };
}

function mappingToPayload(m: ImportFieldMapping): Record<string, unknown> {
  return {
    tx_type: m.txType,
    amount: m.amount,
    happened_at: m.happenedAt,
    category_name: m.categoryName,
    subcategory_name: m.subcategoryName,
    account_name: m.accountName,
    from_account_name: m.fromAccountName,
    to_account_name: m.toAccountName,
    note: m.note,
    currency: m.currency,
    tags: m.tags,
    datetime_format: m.datetimeFormat,
    strip_currency_symbols: m.stripCurrencySymbols,
    expense_is_negative: m.expenseIsNegative,
    tz_offset_minutes: m.tzOffsetMinutes,
  };
}

function buildTxPayload(tx: ImportTransaction, autoTags: string[]): Record<string, unknown> {
  const allTags = [...new Set([...tx.tagNames, ...autoTags])];
  return {
    tx_type: tx.txType,
    amount: tx.amount,
    happened_at: tx.happenedAt.slice(0, 10),
    note: tx.note ?? null,
    category_name: tx.categoryName ?? null,
    parent_category_name: tx.parentCategoryName ?? null,
    account_name: tx.accountName ?? null,
    from_account_name: tx.fromAccountName ?? null,
    to_account_name: tx.toAccountName ?? null,
    currency_code: tx.currencyCode ?? null,
    tags: allTags.length ? allTags : undefined,
  };
}

// ==================== POST /upload ====================

importRouter.post('/upload', async (c) => {
  const userId = c.get('userId');
  const kv = c.env.IMPORT_SESSIONS;

  try {
    const formData = await c.req.formData();
    const file = formData.get('file') as File | null;
    if (!file) return c.json({ error: 'No file provided' }, 400);

    const fileName = file.name || 'import.csv';
    const fileBuffer = await file.arrayBuffer();
    const bytes = new Uint8Array(fileBuffer);

    if (bytes.length > 10 * 1024 * 1024) {
      return c.json({ error: 'File too large (max 10MB)', error_code: 'IMPORT_FILE_TOO_LARGE', limit_bytes: 10 * 1024 * 1024 }, 413);
    }

    const isXlsx = fileName.toLowerCase().endsWith('.xlsx') ||
      (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04);

    let importData: ImportData;
    if (isXlsx) {
      return c.json({ error: 'XLSX import not yet supported in Workers', error_code: 'IMPORT_XLSX_UNSUPPORTED' }, 400);
    } else {
      // Try UTF-8 first, then GBK
      let text: string;
      try {
        text = new TextDecoder('utf-8').decode(bytes);
        // 验证是否为有效 UTF-8（含有非法替换字符则 fallback 到 GBK）
        if (text.includes('\uFFFD')) throw new Error('invalid utf-8');
      } catch {
        try {
          text = new TextDecoder('gbk').decode(bytes);
        } catch {
          return c.json({ error: 'Failed to decode file', error_code: 'IMPORT_DECODE_FAILED' }, 400);
        }
      }
      importData = parseCsvText(text);
    }

    if (!importData.rows.length) {
      return c.json({ error: 'No rows found in file', error_code: 'IMPORT_NO_ROWS' }, 400);
    }

    if (importData.rows.length > 50000) {
      return c.json({ error: 'Too many rows (max 50000)', error_code: 'IMPORT_TOO_MANY_ROWS', limit_rows: 50000 }, 413);
    }

    const token = randomUUID();
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

    const session: ImportSession = {
      token, userId, fileName,
      data: importData,
      mapping: importData.suggestedMapping,
      targetLedgerId: null,
      dedupStrategy: 'skip_duplicates',
      autoTagNames: [],
      status: 'pending',
      createdAt: nowUtc(),
      expiresAt,
    };

    await saveSession(kv, session);

    // Apply mapping to get sample transactions
    const sampleTxs = applyMapping(importData.rows, importData.suggestedMapping);

    return c.json({
      import_token: token,
      expires_at: expiresAt,
      source_format: importData.sourceFormat,
      headers: importData.headers,
      suggested_mapping: mappingToPayload(importData.suggestedMapping),
      current_mapping: mappingToPayload(importData.suggestedMapping),
      target_ledger_id: null,
      dedup_strategy: 'skip_duplicates',
      auto_tag_names: [],
      stats: {
        total_rows: importData.rows.length,
        parse_warnings: importData.parseWarnings,
        parse_warnings_total: importData.parseWarnings.length,
      },
      sample_rows: importData.rows.slice(0, 10).map(r => r.cells),
      sample_transactions: sampleTxs.slice(0, 10),
    });
  } catch (err) {
    return c.json({ error: 'Failed to parse file', error_code: 'IMPORT_PARSE_FAILED' }, 400);
  }
});

// ==================== POST /{token}/preview ====================

importRouter.post('/:token/preview', zValidator('json', ImportPreviewSchema), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const kv = c.env.IMPORT_SESSIONS;
  const token = c.req.param('token');
  const req = c.req.valid('json');

  const session = await getSession(kv, token);
  if (!session) return c.json({ error: 'Import token not found or expired', error_code: 'IMPORT_TOKEN_EXPIRED' }, 404);
  if (session.status === 'cancelled') return c.json({ error: 'Import cancelled' }, 400);

  const mapping = req.mapping ? mappingToInternal(req.mapping as Record<string, unknown>) : session.mapping;
  const targetLedgerId = req.target_ledger_id ?? session.targetLedgerId;
  const dedupStrategy = req.dedup_strategy ?? session.dedupStrategy;
  const autoTagNames = req.auto_tag_names ?? session.autoTagNames;

  // Apply mapping
  const txs = applyMapping(session.data.rows, mapping);

  // Compute stats
  let existing = { txKeys: new Set<string>(), categoryNames: new Set<string>(), accountNames: new Set<string>(), tagNames: new Set<string>() };
  if (targetLedgerId) {
    existing = await buildExistingSets(db, userId, targetLedgerId);
  }
  const stats = computeStats(txs, existing, session.data.rows, mapping);

  // Update session
  session.mapping = mapping;
  session.targetLedgerId = targetLedgerId;
  session.dedupStrategy = dedupStrategy;
  session.autoTagNames = autoTagNames;
  session.status = 'previewed';
  await saveSession(kv, session);

  return c.json({
    import_token: token,
    expires_at: session.expiresAt,
    source_format: session.data.sourceFormat,
    headers: session.data.headers,
    suggested_mapping: mappingToPayload(session.data.suggestedMapping),
    current_mapping: mappingToPayload(mapping),
    target_ledger_id: targetLedgerId,
    dedup_strategy: dedupStrategy,
    auto_tag_names: autoTagNames,
    stats: {
      total_rows: txs.length,
      new_count: stats.newCount,
      duplicate_count: stats.duplicateCount,
      matched_count: stats.matchedCount,
      category_count: stats.categoryCount,
      account_count: stats.accountCount,
      tag_count: stats.tagCount,
      parse_warnings: session.data.parseWarnings,
      parse_warnings_total: session.data.parseWarnings.length,
    },
    sample_transactions: txs.slice(0, 10),
    time_range: {
      start: txs.length ? txs.reduce((a, b) => a.happenedAt < b.happenedAt ? a : b).happenedAt.slice(0, 10) : null,
      end: txs.length ? txs.reduce((a, b) => a.happenedAt > b.happenedAt ? a : b).happenedAt.slice(0, 10) : null,
    },
  });
});

// ==================== POST /{token}/execute ====================

importRouter.post('/:token/execute', zValidator('json', ImportExecuteSchema), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const kv = c.env.IMPORT_SESSIONS;
  const token = c.req.param('token');
  const req = c.req.valid('json');

  const session = await getSession(kv, token);
  if (!session) return c.json({ error: 'Import token not found or expired', error_code: 'IMPORT_TOKEN_EXPIRED' }, 404);
  if (session.status === 'cancelled') return c.json({ error: 'Import cancelled' }, 400);
  if (session.status === 'executing') return c.json({ error: 'Import already in progress' }, 409);

  const mapping = req.mapping ? mappingToInternal(req.mapping as Record<string, unknown>) : session.mapping;
  const targetLedgerId = req.target_ledger_id || session.targetLedgerId;
  const dedupStrategy = req.dedup_strategy ?? session.dedupStrategy;
  const autoTagNames = req.auto_tag_names ?? session.autoTagNames;

  if (!targetLedgerId) {
    return c.json({ error: 'target_ledger_id is required', error_code: 'IMPORT_MISSING_LEDGER' }, 400);
  }

  // Validate ledger access（支持所有者 + 共享成员）
  const ledger = await db
    .prepare('SELECT l.id, l.external_id FROM ledgers l WHERE l.external_id = ? AND (l.user_id = ? OR l.id IN (SELECT ledger_id FROM ledger_members WHERE user_id = ?))')
    .bind(targetLedgerId, userId, userId)
    .first<{ id: string; external_id: string }>();

  if (!ledger) {
    return c.json({ error: 'Ledger not found', error_code: 'IMPORT_LEDGER_NOT_FOUND' }, 404);
  }

  // Mark as executing
  session.status = 'executing';
  session.mapping = mapping;
  session.targetLedgerId = targetLedgerId;
  session.dedupStrategy = dedupStrategy;
  session.autoTagNames = autoTagNames;
  await saveSession(kv, session);

  // Apply mapping
  const txs = applyMapping(session.data.rows, mapping);

  // Get existing sets for dedup
  const existing = await buildExistingSets(db, userId, targetLedgerId);

  // SSE stream for execution progress
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const sendEvent = (event: string, data: Record<string, unknown>) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch { /* ignore */ }
      };

      try {
        let imported = 0;
        let skipped = 0;
        let errors: Array<{ row: number; message: string }> = [];

        for (let i = 0; i < txs.length; i++) {
          const tx = txs[i];

          // Check dedup
          const key = `${tx.amount}|${(tx.happenedAt || '').slice(0, 10)}`;
          if (dedupStrategy === 'skip_duplicates' && existing.txKeys.has(key)) {
            skipped++;
            continue;
          }

          try {
            const payload = buildTxPayload(tx, autoTagNames);

            await db.prepare(
              `INSERT INTO sync_changes
               (change_id, user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_device_id, scope)
               VALUES (?, ?, ?, ?, ?, 'upsert', ?, ?, 'web-import', 'user')`
            ).bind(
              Date.now() + i, userId, ledger.id, 'transaction',
              randomUUID(), JSON.stringify(payload), nowUtc(),
            ).run();

            imported++;
          } catch (err) {
            errors.push({ row: tx.sourceRowNumber, message: String(err) });
          }

          // Send progress every 10 rows
          if (i % 10 === 0 || i === txs.length - 1) {
            sendEvent('progress', {
              total: txs.length,
              imported,
              skipped,
              errors: errors.length,
              errors_detail: errors.slice(-5),
            });
          }
        }

        // Done
        session.status = 'done';
        await saveSession(kv, session);

        sendEvent('complete', {
          total: txs.length,
          imported,
          skipped,
          errors: errors.length,
          errors_detail: errors.slice(0, 20),
        });
        controller.close();
      } catch (err) {
        session.status = 'pending';
        await saveSession(kv, session);
        sendEvent('error', { message: String(err) });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
});

// ==================== DELETE /{token} ====================

importRouter.delete('/:token', async (c) => {
  const kv = c.env.IMPORT_SESSIONS;
  const token = c.req.param('token');

  const session = await getSession(kv, token);
  if (session) {
    session.status = 'cancelled';
    await saveSession(kv, session);
  }

  return c.json({ ok: true });
});

export default importRouter;