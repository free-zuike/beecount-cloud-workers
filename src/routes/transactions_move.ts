/**
 * 跨账本移动路由（对齐上游 1.10.x src/routers/write/transactions_move.py）。
 *
 * - POST /write/ledgers/:ledgerId/transactions/batch/move/prepare
 *   预检：返回每个交易的当前 payload 与 revision（source_change_id）。
 * - POST /write/ledgers/:ledgerId/transactions/batch/move
 *   原子移动：源账本写 delete tombstone + retirement（防旧设备复活），
 *   目标账本写 upsert（新 sync_id / 新 txIndex），附件按 sha256 去重复制，
 *   Idempotency-Key 回执落 transaction_move_receipts（同 key 同 payload 重放）。
 *
 * 约束（对齐上游 MOVE_* 错误码）：
 * - 两个账本都必须属于当前用户且为私有（无其他成员）
 * - 币种必须一致
 * - 源交易 revision 必须与客户端拿到的一致（否则 MOVE_SOURCE_CHANGED）
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { randomUUID } from 'crypto';

import { serverLogger } from '../lib/logger';
import { uploadToStorage, downloadFromStorage, deleteFromStorage } from '../lib/storage-adapter';
import { hashRequest } from '../lib/idempotency';
import { TX_PROJECTION_COLS, type TxProjectionRow } from '../lib/tx-upsert-payload';

// ===========================
// 辅助
// ===========================

function nowUtc(): string {
  return new Date().toISOString();
}

function safeJsonStringify(obj: unknown): string {
  return JSON.stringify(obj);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

interface LedgerRow {
  id: string;
  user_id: string;
  external_id: string;
  currency: string | null;
}

async function loadLedger(db: D1Database, userId: string, externalId: string): Promise<LedgerRow | null> {
  return db
    .prepare(
      `SELECT l.id, l.user_id, l.external_id, l.currency
       FROM ledgers l
       JOIN ledger_members lm ON l.id = lm.ledger_id
       WHERE l.external_id = ? AND lm.user_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM sync_changes sc
           WHERE sc.ledger_id = l.id AND sc.entity_type = 'ledger_snapshot'
             AND sc.action = 'delete'
             AND sc.change_id = (SELECT MAX(sc2.change_id) FROM sync_changes sc2
                                 WHERE sc2.ledger_id = l.id AND sc2.entity_type = 'ledger_snapshot')
         )`
    )
    .bind(externalId, userId)
    .first<LedgerRow>();
}

async function ledgerMemberCount(db: D1Database, ledgerId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS c FROM ledger_members WHERE ledger_id = ?')
    .bind(ledgerId)
    .first<{ c: number }>();
  return Number(row?.c ?? 0);
}

type MoveError = { status: 403 | 404 | 409 | 422 | 401; detail: string };

/** 校验源/目标账本（对齐上游 _ledgers）。 */
async function validateLedgers(
  db: D1Database,
  userId: string,
  sourceExternalId: string,
  targetExternalId: string
): Promise<{ source: LedgerRow; target: LedgerRow } | MoveError> {
  if (sourceExternalId === targetExternalId) {
    return { status: 409, detail: 'MOVE_SAME_LEDGER' };
  }
  const source = await loadLedger(db, userId, sourceExternalId);
  const target = await loadLedger(db, userId, targetExternalId);
  if (!source || !target) {
    return { status: 404, detail: 'Ledger not found' };
  }
  if (source.user_id !== userId || target.user_id !== userId) {
    return { status: 403, detail: 'MOVE_REQUIRES_OWNER' };
  }
  if ((await ledgerMemberCount(db, source.id)) > 1 || (await ledgerMemberCount(db, target.id)) > 1) {
    return { status: 409, detail: 'MOVE_REQUIRES_PRIVATE_LEDGERS' };
  }
  if ((source.currency || 'CNY').toUpperCase() !== (target.currency || 'CNY').toUpperCase()) {
    return { status: 409, detail: 'MOVE_REQUIRES_SAME_CURRENCY' };
  }
  return { source, target };
}

interface TxRow extends TxProjectionRow {
  source_change_id: number | null;
  tx_index: number | null;
}

async function loadTransactions(
  db: D1Database,
  ledgerId: string,
  syncIds: string[]
): Promise<Map<string, TxRow>> {
  const found = new Map<string, TxRow>();
  const unique = [...new Set(syncIds)];
  for (let i = 0; i < unique.length; i += 90) {
    const chunk = unique.slice(i, i + 90);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = await db
      .prepare(
        `SELECT ${TX_PROJECTION_COLS}, source_change_id, tx_index
         FROM read_tx_projection
         WHERE ledger_id = ? AND sync_id IN (${placeholders})`
      )
      .bind(ledgerId, ...chunk)
      .all<TxRow>();
    for (const row of rows.results ?? []) found.set(row.sync_id, row);
  }
  return found;
}

/**
 * 对齐上游 snapshot_builder._to_iso_utc：+00:00 后缀；
 * 毫秒为 0 时省略小数位，否则补足 6 位微秒。
 */
function toIsoUtc(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const iso = d.toISOString(); // 2025-01-15T10:00:00.000Z
  return iso.replace(/\.(\d{3})Z$/, (_m, ms: string) =>
    ms === '000' ? '+00:00' : `.${ms}000+00:00`
  );
}

/**
 * 投影行 → 交易 dict（对齐上游 _projection_row_to_tx_dict 的条件键语义：
 * 空值不出现；exclude 标记与 happenedAt 始终存在；txIndex 仅在非 0 时）。
 * 这是 prepare 响应与移动后目标 upsert payload 的共同基础。
 */
function txDict(row: TxRow): Record<string, unknown> {
  const item: Record<string, unknown> = {
    syncId: row.sync_id,
    type: row.tx_type,
    amount: row.amount,
    happenedAt: toIsoUtc(row.happened_at) ?? row.happened_at,
    excludeFromStats: Boolean(row.exclude_from_stats),
    excludeFromBudget: Boolean(row.exclude_from_budget),
  };
  if (row.note !== null && row.note !== undefined) item.note = row.note;
  if (row.category_sync_id) item.categoryId = row.category_sync_id;
  if (row.category_name) item.categoryName = row.category_name;
  if (row.category_kind) item.categoryKind = row.category_kind;
  if (row.account_sync_id) item.accountId = row.account_sync_id;
  if (row.account_name) item.accountName = row.account_name;
  if (row.from_account_sync_id) item.fromAccountId = row.from_account_sync_id;
  if (row.from_account_name) item.fromAccountName = row.from_account_name;
  if (row.to_account_sync_id) item.toAccountId = row.to_account_sync_id;
  if (row.to_account_name) item.toAccountName = row.to_account_name;
  if (row.tags_csv) item.tags = row.tags_csv;
  if (row.tag_sync_ids_json) {
    try {
      const ids = JSON.parse(row.tag_sync_ids_json);
      if (Array.isArray(ids) && ids.length > 0) item.tagIds = ids;
    } catch { /* ignore broken json */ }
  }
  if (row.attachments_json) {
    try {
      const atts = JSON.parse(row.attachments_json);
      if (Array.isArray(atts) && atts.length > 0) item.attachments = atts;
    } catch { /* ignore broken json */ }
  }
  if (row.tx_index) item.txIndex = row.tx_index;
  if (row.created_by_user_id) item.createdByUserId = row.created_by_user_id;
  if (row.currency_code !== null && row.currency_code !== undefined) item.currencyCode = row.currency_code;
  if (row.native_amount !== null && row.native_amount !== undefined) item.nativeAmount = row.native_amount;
  return item;
}

interface AttachmentRow {
  id: string;
  ledger_id: string;
  user_id: string;
  sha256: string | null;
  size_bytes: number | null;
  mime_type: string | null;
  file_name: string | null;
  storage_path: string;
  attachment_kind: string;
}

/** 校验并取出源附件行；无效 → MOVE_ATTACHMENT_MISSING（对齐上游 _source_attachment）。 */
async function loadSourceAttachment(
  db: D1Database,
  sourceLedgerId: string,
  item: unknown
): Promise<AttachmentRow | MoveError> {
  const fileId = item && typeof item === 'object' ? (item as Record<string, unknown>).cloudFileId : null;
  if (typeof fileId !== 'string' || !fileId) {
    return { status: 409, detail: 'MOVE_ATTACHMENT_MISSING' };
  }
  const row = await db
    .prepare(
      `SELECT id, ledger_id, user_id, sha256, size_bytes, mime_type, file_name, storage_path, attachment_kind
       FROM attachment_files WHERE id = ? AND ledger_id = ? AND attachment_kind = 'transaction'`
    )
    .bind(fileId, sourceLedgerId)
    .first<AttachmentRow>();
  if (!row) return { status: 409, detail: 'MOVE_ATTACHMENT_MISSING' };
  return row;
}

// ===========================
// Schema
// ===========================

const PrepareMoveSchema = z.object({
  target_ledger_id: z.string().min(1),
  transaction_ids: z.array(z.string().min(1)).min(1),
});

const MoveRevisionSchema = z.object({
  sync_id: z.string().min(1),
  revision: z.number().int().min(0),
});

const MoveSchema = z.object({
  target_ledger_id: z.string().min(1),
  items: z.array(MoveRevisionSchema).min(1),
});

// ===========================
// 路由
// ===========================

type Bindings = {
  DB: D1Database;
  JWT_SECRET: string;
  R2?: R2Bucket;
  BEECOUNT_DO: DurableObjectNamespace;
};

type Variables = {
  userId: string;
};

const moveRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

async function broadcastLedgerChange(
  c: { env: Bindings },
  ledgerId: string,
  changeId: number
): Promise<void> {
  const db = c.env.DB;
  try {
    const ledger = await db
      .prepare('SELECT external_id FROM ledgers WHERE id = ?')
      .bind(ledgerId)
      .first<{ external_id: string }>();
    if (!ledger) return;
    const members = await db
      .prepare('SELECT user_id FROM ledger_members WHERE ledger_id = ?')
      .bind(ledgerId)
      .all<{ user_id: string }>();
    const payload = JSON.stringify({
      type: 'sync_change',
      ledgerId: ledger.external_id,
      serverCursor: changeId,
      serverTimestamp: nowUtc(),
    });
    for (const member of members.results ?? []) {
      const doId = c.env.BEECOUNT_DO.idFromName(`ws-${member.user_id}`);
      const stub = c.env.BEECOUNT_DO.get(doId);
      await stub.fetch(
        new Request('https://dummy/broadcast', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: payload }),
        })
      );
    }
  } catch (error) {
    serverLogger.error('src.routers.transactions_move', '[MOVE] broadcast failed:', error);
  }
}

// ---------------------------------------------------------------------------
// POST /write/ledgers/:ledgerId/transactions/batch/move/prepare
// ---------------------------------------------------------------------------

moveRouter.post(
  '/ledgers/:ledgerId/transactions/batch/move/prepare',
  zValidator('json', PrepareMoveSchema),
  async (c) => {
    const userId = c.get('userId');
    const db = c.env.DB;
    const sourceExternalId = c.req.param('ledgerId');
    const req = c.req.valid('json');

    const ledgers = await validateLedgers(db, userId, sourceExternalId, req.target_ledger_id);
    if ('status' in ledgers) return c.json({ detail: ledgers.detail }, ledgers.status);

    if (new Set(req.transaction_ids).size !== req.transaction_ids.length) {
      return c.json({ detail: 'MOVE_DUPLICATE_SELECTION' }, 422);
    }

    const rows = await loadTransactions(db, ledgers.source.id, req.transaction_ids);
    if (rows.size !== req.transaction_ids.length) {
      return c.json({ detail: 'MOVE_SOURCE_CHANGED' }, 409);
    }

    const result: Array<{ sync_id: string; revision: number; transaction: Record<string, unknown> }> = [];
    const checkedFiles = new Set<string>();
    for (const syncId of req.transaction_ids) {
      const row = rows.get(syncId)!;
      const payload = txDict(row);
      const attachments = payload.attachments;
      if (Array.isArray(attachments)) {
        for (const item of attachments) {
          const fileId =
            item && typeof item === 'object' ? (item as Record<string, unknown>).cloudFileId : null;
          if (typeof fileId !== 'string' || !checkedFiles.has(fileId)) {
            const attachment = await loadSourceAttachment(db, ledgers.source.id, item);
            if ('status' in attachment) return c.json({ detail: attachment.detail }, attachment.status);
            checkedFiles.add(attachment.id);
          }
        }
      }
      result.push({ sync_id: syncId, revision: Number(row.source_change_id ?? 0), transaction: payload });
    }
    return c.json(result);
  }
);

// ---------------------------------------------------------------------------
// POST /write/ledgers/:ledgerId/transactions/batch/move
// ---------------------------------------------------------------------------

moveRouter.post(
  '/ledgers/:ledgerId/transactions/batch/move',
  zValidator('json', MoveSchema),
  async (c) => {
    const userId = c.get('userId');
    const db = c.env.DB;
    const sourceExternalId = c.req.param('ledgerId');
    const req = c.req.valid('json');
    const serverNow = nowUtc();

    const operationId = c.req.header('Idempotency-Key');
    const deviceId = c.req.header('X-Device-ID');
    if (!operationId || !deviceId) {
      return c.json({ detail: 'Idempotency-Key and X-Device-ID headers required' }, 422);
    }
    if (!/^[0-9a-fA-F-]{36}$/.test(operationId)) {
      return c.json({ detail: 'Invalid Idempotency-Key' }, 422);
    }

    // 设备身份校验（pull 协议同样用它跳过本设备事件）
    const device = await db
      .prepare('SELECT id FROM devices WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
      .bind(deviceId, userId)
      .first();
    if (!device) return c.json({ detail: 'Invalid device' }, 401);

    const requestHash = hashRequest('POST', sourceExternalId, req);

    // 幂等回执（对齐上游 _replay：先于账本校验）
    const replayRow = await db
      .prepare(
        'SELECT request_hash, result_json FROM transaction_move_receipts WHERE user_id = ? AND operation_id = ?'
      )
      .bind(userId, operationId)
      .first<{ request_hash: string; result_json: string }>();
    if (replayRow) {
      if (replayRow.request_hash !== requestHash) {
        return c.json({ detail: 'MOVE_OPERATION_REUSED' }, 409);
      }
      return c.json(JSON.parse(replayRow.result_json));
    }

    const ledgers = await validateLedgers(db, userId, sourceExternalId, req.target_ledger_id);
    if ('status' in ledgers) return c.json({ detail: ledgers.detail }, ledgers.status);
    const { source, target } = ledgers;

    const requestedIds = req.items.map((item) => item.sync_id);
    const rows = await loadTransactions(db, source.id, requestedIds);
    if (rows.size !== requestedIds.length) {
      return c.json({ detail: 'MOVE_SOURCE_CHANGED' }, 409);
    }
    for (const item of req.items) {
      const row = rows.get(item.sync_id)!;
      if (Number(row.source_change_id ?? 0) !== item.revision) {
        return c.json({ detail: 'MOVE_SOURCE_CHANGED' }, 409);
      }
    }

    // ---------- 附件预拷贝（R2 操作不能进 D1 batch；失败即中止，不留半成品） ----------
    const attachmentIds: Record<string, string> = {};
    const createdStorageKeys: string[] = [];
    const prepared: Array<{ row: TxRow; payload: Record<string, unknown> }> = [];

    try {
      for (const item of req.items) {
        const row = rows.get(item.sync_id)!;
        const payload = txDict(row);
        const attachments = payload.attachments;
        if (Array.isArray(attachments)) {
          for (const att of attachments) {
            if (!att || typeof att !== 'object') continue;
            const itemRef = att as Record<string, unknown>;
            const oldId = itemRef.cloudFileId;
            const oldKey = typeof oldId === 'string' ? oldId : '';
            if (!oldKey || attachmentIds[oldKey]) {
              if (oldKey) itemRef.cloudFileId = attachmentIds[oldKey];
              continue;
            }
            const original = await loadSourceAttachment(db, source.id, att);
            if ('status' in original) return c.json({ detail: original.detail }, original.status);

            // 同币种/同账本内按 sha256 去重（对齐上游 _copy_attachment）
            let copyId: string | null = null;
            if (original.sha256) {
              const existing = await db
                .prepare(
                  `SELECT id FROM attachment_files
                   WHERE ledger_id = ? AND sha256 = ? AND attachment_kind = 'transaction'
                   ORDER BY created_at ASC, id ASC LIMIT 1`
                )
                .bind(target.id, original.sha256)
                .first<{ id: string }>();
              if (existing) copyId = existing.id;
            }

            if (!copyId) {
              const bytes = await downloadFromStorage(db, c.env, original.storage_path);
              if (!bytes) return c.json({ detail: 'MOVE_ATTACHMENT_MISSING' }, 409);
              const digest = await sha256Hex(bytes);
              if (original.sha256 && digest !== original.sha256) {
                return c.json({ detail: 'MOVE_ATTACHMENT_MISSING' }, 409);
              }
              copyId = randomUUID();
              const storageKey = `attachments/${target.external_id}/${copyId}_${original.file_name ?? 'file'}`;
              const uploaded = await uploadToStorage(db, c.env, storageKey, bytes, original.mime_type ?? 'application/octet-stream');
              if (!uploaded.ok) {
                return c.json({ detail: 'MOVE_ATTACHMENT_MISSING' }, 409);
              }
              createdStorageKeys.push(storageKey);
              await db
                .prepare(
                  `INSERT INTO attachment_files
                   (id, ledger_id, user_id, sha256, size_bytes, mime_type, file_name, storage_path, attachment_kind, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'transaction', ?)`
                )
                .bind(
                  copyId,
                  target.id,
                  target.user_id,
                  digest,
                  original.size_bytes,
                  original.mime_type,
                  original.file_name,
                  storageKey,
                  serverNow
                )
                .run();
            }
            attachmentIds[oldKey] = copyId;
            itemRef.cloudFileId = copyId;
          }
        }
        prepared.push({ row, payload });
      }
    } catch (error) {
      serverLogger.error('src.routers.transactions_move', '[MOVE] attachment staging failed:', error);
      return c.json({ detail: 'MOVE_ATTACHMENT_MISSING' }, 409);
    }

    // ---------- 目标账本 txIndex 起点 ----------
    const indexRow = await db
      .prepare('SELECT COALESCE(MAX(tx_index), 0) AS max_index FROM read_tx_projection WHERE ledger_id = ?')
      .bind(target.id)
      .first<{ max_index: number }>();
    const baseIndex = Number(indexRow?.max_index ?? 0);

    // ---------- 单批原子写入 ----------
    const statements: D1PreparedStatement[] = [];
    const moved: Array<{ source_sync_id: string; target_sync_id: string }> = [];
    let targetChangeSlot = -1;
    let sourceChangeSlot = -1;

    let offset = 0;
    for (const { row, payload } of prepared) {
      offset += 1;
      const newSyncId = randomUUID();
      const movedPayload = {
        ...payload,
        syncId: newSyncId,
        ledgerSyncId: target.external_id,
        txIndex: baseIndex + offset,
        updatedByUserId: userId,
      };

      // 1) 目标账本 upsert 事件
      statements.push(
        db
          .prepare(
            `INSERT INTO sync_changes
             (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_device_id, updated_by_user_id, scope)
             VALUES (?, ?, 'transaction', ?, 'upsert', ?, ?, ?, ?, 'ledger')`
          )
          .bind(
            userId,
            target.id,
            newSyncId,
            safeJsonStringify(movedPayload),
            serverNow,
            deviceId,
            userId
          )
      );
      targetChangeSlot = statements.length - 1;

      // 2) 目标账本投影（source_change_id 取上一条 INSERT 的 rowid）
      statements.push(
        db
          .prepare(
            `INSERT INTO read_tx_projection
             (ledger_id, sync_id, user_id, tx_type, amount, happened_at, note,
              category_sync_id, category_name, category_kind,
              account_sync_id, account_name,
              from_account_sync_id, from_account_name,
              to_account_sync_id, to_account_name,
              tags_csv, tag_sync_ids_json, attachments_json, tx_index, source_change_id,
              exclude_from_stats, exclude_from_budget,
              created_by_user_id, last_edited_by_user_id,
              currency_code, native_amount)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT MAX(change_id) FROM sync_changes WHERE user_id = ? AND ledger_id = ? AND entity_sync_id = ? AND entity_type = 'transaction'),
             ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            target.id,
            newSyncId,
            userId,
            row.tx_type,
            row.amount,
            row.happened_at,
            row.note,
            row.category_sync_id,
            row.category_name,
            row.category_kind,
            row.account_sync_id,
            row.account_name,
            row.from_account_sync_id,
            row.from_account_name,
            row.to_account_sync_id,
            row.to_account_name,
            row.tags_csv,
            row.tag_sync_ids_json,
            // 附件在 staging 阶段已改写 cloudFileId（复制/去重后的新 fileId），
            // 投影必须用改写后的 payload，而不是源行的旧 attachments_json。
            Array.isArray(payload.attachments) && payload.attachments.length > 0
              ? safeJsonStringify(payload.attachments)
              : row.attachments_json,
            baseIndex + offset,
            userId,
            target.id,
            newSyncId,
            row.exclude_from_stats,
            row.exclude_from_budget,
            row.created_by_user_id,
            userId,
            row.currency_code,
            row.native_amount
          )
      );

      // 3) 源账本 delete tombstone（服务端身份：server-transaction-move）
      statements.push(
        db
          .prepare(
            `INSERT INTO sync_changes
             (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_device_id, updated_by_user_id, scope)
             VALUES (?, ?, 'transaction', ?, 'delete', '{}', ?, 'server-transaction-move', ?, 'ledger')`
          )
          .bind(userId, source.id, row.sync_id, serverNow, userId)
      );
      sourceChangeSlot = statements.length - 1;

      // 4) 源投影删除
      statements.push(
        db
          .prepare('DELETE FROM read_tx_projection WHERE ledger_id = ? AND sync_id = ?')
          .bind(source.id, row.sync_id)
      );

      // 5) 清理旧 upsert 历史，防止 stale upsert 复活（对齐 _compact_entity_upsert_events）
      statements.push(
        db
          .prepare(
            `DELETE FROM sync_changes
             WHERE ledger_id = ? AND entity_type = 'transaction' AND entity_sync_id = ? AND action != 'delete'`
          )
          .bind(source.id, row.sync_id)
      );

      // 6) retirement 标记
      statements.push(
        db
          .prepare(
            `INSERT INTO transaction_move_retirements (ledger_id, sync_id) VALUES (?, ?)
             ON CONFLICT(ledger_id, sync_id) DO NOTHING`
          )
          .bind(source.id, row.sync_id)
      );

      moved.push({ source_sync_id: row.sync_id, target_sync_id: newSyncId });
    }

    const result = {
      operation_id: operationId,
      items: moved,
      attachment_ids: attachmentIds,
      server_timestamp: serverNow,
    };

    // 7) 幂等回执
    statements.push(
      db
        .prepare(
          `INSERT INTO transaction_move_receipts (user_id, operation_id, request_hash, result_json)
           VALUES (?, ?, ?, ?)`
        )
        .bind(userId, operationId, requestHash, safeJsonStringify(result))
    );

    let batchResults: Array<{ meta: { last_row_id: number } }> = [];
    try {
      for (let i = 0; i < statements.length; i += 100) {
        const chunkResults = await db.batch(statements.slice(i, i + 100));
        batchResults.push(...(chunkResults as unknown as Array<{ meta: { last_row_id: number } }>));
      }
    } catch (error) {
      serverLogger.error('src.routers.transactions_move', '[MOVE] db.batch failed:', error);
      // 回滚已上传的 R2 副本（DB 原子失败时清理孤儿文件）
      for (const key of createdStorageKeys) {
        try {
          await deleteFromStorage(db, c.env, key);
        } catch { /* best-effort */ }
      }
      return c.json({ detail: 'MOVE_FAILED' }, 500);
    }

    // ---------- 广播（每个账本用该账本最后一条 change_id） ----------
    const targetChangeId = batchResults[targetChangeSlot]?.meta.last_row_id ?? 0;
    const sourceChangeId = batchResults[sourceChangeSlot]?.meta.last_row_id ?? 0;
    if (targetChangeId) await broadcastLedgerChange(c, target.id, targetChangeId);
    if (sourceChangeId) await broadcastLedgerChange(c, source.id, sourceChangeId);

    serverLogger.info(
      'src.routers.transactions_move',
      `[MOVE] moved ${moved.length} tx from ${sourceExternalId} to ${target.external_id} (operation ${operationId})`
    );

    return c.json(result);
  }
);

export default moveRouter;
