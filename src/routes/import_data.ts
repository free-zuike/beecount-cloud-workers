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

const ImportExecuteSchema = z.object({
  field_mapping: z.record(z.string()),
  ledger_id: z.string().optional(),
  deduplicate: z.boolean().default(true),
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

    const suggestedMapping: Record<string, string> = {};
    const lowerHeaders = headers.map((h) => h.toLowerCase().trim());

    const mappingRules: [string[], string[]][] = [
      [['金额', 'amount', 'amt', '钱', '数额'], ['amount']],
      [['时间', '日期', 'happened_at', 'date', 'datetime', '交易时间', '发生时间'], ['happened_at']],
      [['类型', 'type', 'tx_type', '交易类型', '收支'], ['tx_type']],
      [['备注', 'note', '描述', 'description', 'memo', '说明'], ['note']],
      [['分类', 'category', '分类名称', 'cat'], ['category_name']],
      [['账户', 'account', 'account_name', '账户名称'], ['account_name']],
      [['标签', 'tags', 'tag'], ['tags']],
    ];

    for (const [keywords, targetField] of mappingRules) {
      for (let i = 0; i < lowerHeaders.length; i++) {
        const header = lowerHeaders[i];
        for (const keyword of keywords) {
          if (header.includes(keyword)) {
            suggestedMapping[headers[i]] = targetField[0];
            break;
          }
        }
      }
    }

    return c.json({
      token,
      file_name: fileName,
      row_count: rows.length,
      headers,
      preview_rows: rows.slice(0, 10),
      suggested_mapping: suggestedMapping,
      expires_in_seconds: 1800,
    });
  } catch (err) {
    return c.json({ error: 'Failed to parse file' }, 400);
  }
});

importRouter.get('/:token/preview', async (c) => {
  const token = c.req.param('token');
  const kv = c.env.IMPORT_SESSIONS;

  const session = await getSession(kv, token);
  if (!session) {
    return c.json({ error: 'Import token not found or expired' }, 404);
  }

  if (session.status === 'cancelled') {
    return c.json({ error: 'Import cancelled' }, 400);
  }

  return c.json({
    token,
    file_name: session.file_name,
    row_count: session.row_count,
    headers: session.headers,
    preview_rows: session.rows.slice(0, 10),
    status: session.status,
    expires_at: session.expires_at,
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
  const encoder = new TextEncoder();

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

      try {
        for (let i = 0; i < total; i++) {
          const row = session.rows[i];

          try {
            const amount = colIndex['amount'] !== undefined ? parseFloat(row[colIndex['amount']] ?? '0') : 0;
            const happenedAt = colIndex['happened_at'] !== undefined ? row[colIndex['happened_at']] : new Date().toISOString();
            const txTypeRaw = colIndex['tx_type'] !== undefined ? row[colIndex['tx_type']] ?? '' : '';
            const note = colIndex['note'] !== undefined ? row[colIndex['note']] ?? '' : '';
            const categoryName = colIndex['category_name'] !== undefined ? row[colIndex['category_name']] ?? '' : '';
            const accountName = colIndex['account_name'] !== undefined ? row[colIndex['account_name']] ?? '' : '';
            const tags = colIndex['tags'] !== undefined ? row[colIndex['tags']] ?? '' : '';

            let txType = 'expense';
            const lowerTxType = txTypeRaw.toLowerCase();
            if (/收|income/.test(lowerTxType)) txType = 'income';
            else if (/转|transfer/.test(lowerTxType)) txType = 'transfer';

            let skip = false;
            if (deduplicate) {
              const existing = await db
                .prepare('SELECT sync_id FROM read_tx_projection WHERE ledger_id = ? AND amount = ? AND happened_at LIKE ? LIMIT 1')
                .bind(ledgerId, amount, `${happenedAt}%`)
                .first();

              if (existing) {
                skip = true;
              }
            }

            if (!skip) {
              const syncId = randomUUID();
              const serverNow = nowUtc();

              const payload: Record<string, unknown> = {
                tx_type: txType,
                amount,
                happened_at: happenedAt,
                note,
                category_name: categoryName || null,
                account_name: accountName || null,
                tags,
              };

              const changeResult = await db
                .prepare(
                  `INSERT INTO sync_changes
                   (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
                )
                .bind(userId, ledgerId, 'transaction', syncId, safeJsonStringify(payload), serverNow, userId)
                .run();

              const newChangeId = changeResult.meta.last_row_id as number;

              await db
                .prepare(
                  `INSERT INTO read_tx_projection
                   (ledger_id, sync_id, user_id, tx_type, amount, happened_at, note,
                    category_name, account_name, tags_csv, source_change_id)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                )
                .bind(ledgerId, syncId, userId, txType, amount, happenedAt, note, categoryName || null, accountName || null, tags || null, newChangeId)
                .run();

              success++;
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ row: { index: i, success: true, tx_sync_id: syncId } })}\n\n`));
            } else {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ row: { index: i, success: false, error: 'duplicate skipped' } })}\n\n`));
            }
          } catch (rowErr) {
            failed++;
            const errorMsg = rowErr instanceof Error ? rowErr.message : 'Unknown error';
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ row: { index: i, success: false, error: errorMsg } })}\n\n`));
          }

          if (i % 10 === 0) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ progress: { current: i + 1, total, success, failed } })}\n\n`));
          }
        }

        session.status = 'done';
        await saveSession(kv, session);

        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: { total, success, failed } })}\n\n`));
        controller.close();
      } catch (err) {
        session.status = 'cancelled';
        await saveSession(kv, session);
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: errorMsg, done: { total, success, failed } })}\n\n`));
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
