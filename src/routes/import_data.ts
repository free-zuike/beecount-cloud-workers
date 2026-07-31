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
import { serverLogger } from '../lib/logger';

function nowUtc(): string { return new Date().toISOString(); }

type Bindings = { DB: D1Database; BEECOUNT_DO: DurableObjectNamespace; JWT_SECRET: string };
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

async function saveSession(env: Bindings, userId: string, session: ImportSession): Promise<void> {
  const doId = env.BEECOUNT_DO.idFromName(`ws-${userId}`);
  const doStub = env.BEECOUNT_DO.get(doId);
  await doStub.fetch('http://do/import/save', {
    method: 'POST',
    body: JSON.stringify({ token: session.token, data: session }),
    headers: { 'Content-Type': 'application/json' },
  });
}

async function getSession(env: Bindings, userId: string, token: string): Promise<ImportSession | null> {
  const doId = env.BEECOUNT_DO.idFromName(`ws-${userId}`);
  const doStub = env.BEECOUNT_DO.get(doId);
  const res = await doStub.fetch(`http://do/import/get?token=${token}`);
  const { data } = await res.json<{ data: ImportSession | null }>();
  return data;
}

async function deleteSession(env: Bindings, userId: string, token: string): Promise<void> {
  const doId = env.BEECOUNT_DO.idFromName(`ws-${userId}`);
  const doStub = env.BEECOUNT_DO.get(doId);
  await doStub.fetch('http://do/import/delete', {
    method: 'POST',
    body: JSON.stringify({ token }),
    headers: { 'Content-Type': 'application/json' },
  });
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
  mapping: FieldMappingSchema.optional(),
  target_ledger_id: z.string().nullable().optional(),
  dedup_strategy: z.enum(['skip_duplicates', 'insert_all']).optional(),
  auto_tag_names: z.array(z.string()).optional(),
});

const ImportExecuteSchema = z.object({
  mapping: FieldMappingSchema.optional(),
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

    await saveSession(c.env, userId, session);

    // Apply mapping to get sample transactions
    const sampleTxs = applyMapping(importData.rows, importData.suggestedMapping);
    const sampleTransactions = sampleTxs.slice(0, 10).map(tx => ({
      tx_type: tx.txType,
      amount: String(tx.amount),
      happened_at: tx.happenedAt,
      note: tx.note ?? null,
      category_name: tx.categoryName ?? null,
      parent_category_name: tx.parentCategoryName ?? null,
      account_name: tx.accountName ?? null,
      from_account_name: tx.fromAccountName ?? null,
      to_account_name: tx.toAccountName ?? null,
      tag_names: tx.tagNames,
      source_row_number: tx.sourceRowNumber,
    }));

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
        time_range_start: null,
        time_range_end: null,
        total_signed_amount: '0',
        by_type: { expense_count: 0, expense_total: '0', income_count: 0, income_total: '0', transfer_count: 0 },
        accounts: { new_names: [], matched_names: [] },
        categories: { new_names: [], matched_names: [] },
        tags: { new_names: [], matched_names: [] },
        skipped_dedup: 0,
        parse_errors: [],
        parse_errors_total: 0,
        parse_warnings: importData.parseWarnings,
        parse_warnings_total: importData.parseWarnings.length,
      },
      sample_rows: importData.rows.slice(0, 10).map(r => r.cells),
      sample_transactions: sampleTransactions,
    });
  } catch (err) {
    serverLogger.error('src.routers.import', '[IMPORT] Upload failed:', err);
    return c.json({ error: 'Failed to parse file', error_code: 'IMPORT_PARSE_FAILED' }, 400);
  }
});

// ==================== POST /{token}/preview ====================

importRouter.post('/:token/preview', zValidator('json', ImportPreviewSchema), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const token = c.req.param('token');
  const req = c.req.valid('json');

  const session = await getSession(c.env, userId, token);
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
  await saveSession(c.env, userId, session);

  // 计算新增字段
  let expenseTotal = 0, incomeTotal = 0, transferCount = 0;
  let timeMin: string | null = null, timeMax: string | null = null;
  for (const tx of txs) {
    const amt = Number(tx.amount) || 0;
    if (tx.txType === 'expense') expenseTotal += amt;
    else if (tx.txType === 'income') incomeTotal += amt;
    else if (tx.txType === 'transfer') transferCount++;
    if (!timeMin || tx.happenedAt < timeMin) timeMin = tx.happenedAt;
    if (!timeMax || tx.happenedAt > timeMax) timeMax = tx.happenedAt;
  }

  // 计算新账/匹配账
  const newAccountNames: string[] = [];
  const matchedAccountNames: string[] = [];
  const newCategoryNames: string[] = [];
  const matchedCategoryNames: string[] = [];
  const newTagNames: string[] = [];
  const matchedTagNames: string[] = [];
  if (targetLedgerId) {
    for (const tx of txs) {
      if (tx.accountName) {
        if (existing.accountNames.has(tx.accountName)) matchedAccountNames.push(tx.accountName);
        else newAccountNames.push(tx.accountName);
      }
      if (tx.categoryName) {
        if (existing.categoryNames.has(tx.categoryName)) matchedCategoryNames.push(tx.categoryName);
        else newCategoryNames.push(tx.categoryName);
      }
      for (const t of tx.tagNames) {
        if (existing.tagNames.has(t)) matchedTagNames.push(t);
        else newTagNames.push(t);
      }
    }
  }

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
      time_range_start: timeMin ? timeMin.slice(0, 10) : null,
      time_range_end: timeMax ? timeMax.slice(0, 10) : null,
      total_signed_amount: String(incomeTotal - expenseTotal),
      by_type: {
        expense_count: txs.filter(t => t.txType === 'expense').length,
        expense_total: String(expenseTotal),
        income_count: txs.filter(t => t.txType === 'income').length,
        income_total: String(incomeTotal),
        transfer_count: transferCount,
      },
      accounts: { new_names: [...new Set(newAccountNames)], matched_names: [...new Set(matchedAccountNames)] },
      categories: { new_names: [...new Set(newCategoryNames)], matched_names: [...new Set(matchedCategoryNames)] },
      tags: { new_names: [...new Set(newTagNames)], matched_names: [...new Set(matchedTagNames)] },
      skipped_dedup: stats.duplicateCount,
      parse_errors: [],
      parse_errors_total: 0,
      parse_warnings: session.data.parseWarnings,
      parse_warnings_total: session.data.parseWarnings.length,
    },
    sample_transactions: txs.slice(0, 10).map(tx => ({
      tx_type: tx.txType,
      amount: String(tx.amount),
      happened_at: tx.happenedAt,
      note: tx.note ?? null,
      category_name: tx.categoryName ?? null,
      parent_category_name: tx.parentCategoryName ?? null,
      account_name: tx.accountName ?? null,
      from_account_name: tx.fromAccountName ?? null,
      to_account_name: tx.toAccountName ?? null,
      tag_names: tx.tagNames,
      source_row_number: tx.sourceRowNumber,
    })),
    time_range: {
      start: timeMin ? timeMin.slice(0, 10) : null,
      end: timeMax ? timeMax.slice(0, 10) : null,
    },
  });
});

// ==================== POST /{token}/execute ====================

importRouter.post('/:token/execute', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const token = c.req.param('token');

  const session = await getSession(c.env, userId, token);
  if (!session) return c.json({ error: 'Import token not found or expired', error_code: 'IMPORT_TOKEN_EXPIRED' }, 410);
  if (session.status === 'cancelled') return c.json({ error: 'Import cancelled' }, 400);
  if (session.status === 'executing') return c.json({ error: 'Import already in progress' }, 409);

  const mapping = session.mapping;
  const targetLedgerId = session.targetLedgerId;
  const dedupStrategy = session.dedupStrategy;
  const autoTagNames = session.autoTagNames;

  if (!targetLedgerId) {
    return c.json({ error: 'target_ledger_id is required', error_code: 'IMPORT_MISSING_LEDGER' }, 400);
  }

  // Validate ledger access（与原版 _resolve_target_ledger 一致：JOIN ledger_members）
  const ledger = await db
    .prepare('SELECT l.id, l.external_id FROM ledgers l INNER JOIN ledger_members lm ON lm.ledger_id = l.id WHERE l.external_id = ? AND lm.user_id = ?')
    .bind(targetLedgerId, userId)
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
  await saveSession(c.env, userId, session);

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
        await saveSession(c.env, userId, session);

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
        await saveSession(c.env, userId, session);
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
  const userId = c.get('userId');
  const token = c.req.param('token');

  const session = await getSession(c.env, userId, token);
  if (session) {
    session.status = 'cancelled';
    await saveSession(c.env, userId, session);
  }

  return c.json({ ok: true });
});

export default importRouter;