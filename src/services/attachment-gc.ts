/**
 * 延迟附件 GC sweeper（#150，对齐上游 projection.expire_pending_attachment_gc +
 * main.py _start_pending_attachment_gc 后台循环）。
 *
 * 背景：交易附件分批上传时（上传与 outbox 在不同 HTTP 批次），中间态的草稿
 * manifest 可能暂时不引用已上传的文件。立即 GC 会误删仍在途的 blob，所以
 * upsert 时把「被移除的附件」挂起 1 天（read_tx_projection.pending_attachment_gc_json
 * / attachment_gc_after），本 sweeper 周期性（cron 每 5 分钟）过期处理：
 * 到期后按交易当前 attachments_json 重新判定 —— 仍在上传中的（无 cloudFileId
 * 的占位条目，按 sha256/本地文件名匹配）继续保留，其余真正回收。
 */

import { isAttachmentStillReferenced } from '../lib/attachment-reference';
import { deleteFromStorage } from '../lib/storage-adapter';

type GCStorage = { R2?: R2Bucket };

/** 当前 UTC ISO 时间（与 routes/sync.ts nowUtc 同口径）。 */
function nowUtc(): string {
  return new Date().toISOString();
}

type GcProjectionRow = {
  ledger_id: string;
  sync_id: string;
  user_id: string;
  attachments_json: string | null;
  pending_attachment_gc_json: string | null;
  attachment_gc_after: string | null;
};

function jsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** 上传中的占位条目 → 等待中的 sha256 集合 + 本地文件名集合（对齐上游 expire 判定）。 */
function pendingUploadSignals(attachmentsJson: string | null): {
  hashes: Set<string>;
  localNames: Set<string>;
} {
  const hashes = new Set<string>();
  const localNames = new Set<string>();
  const arr = jsonParse<unknown[]>(attachmentsJson, []);
  if (!Array.isArray(arr)) return { hashes, localNames };
  for (const entry of arr) {
    if (!entry || typeof entry !== 'object' || (entry as Record<string, unknown>).cloudFileId) continue;
    const e = entry as Record<string, unknown>;
    const fileName = typeof e.fileName === 'string' ? e.fileName : '';
    if (typeof e.cloudSha256 === 'string' && e.cloudSha256) {
      hashes.add(e.cloudSha256);
    } else if (fileName.startsWith('sha_') && fileName.slice(4).split('.')[0].length === 64) {
      hashes.add(fileName.slice(4).split('.')[0]);
    } else if (fileName) {
      localNames.add(fileName);
    }
  }
  return { hashes, localNames };
}

/** 单条回收：引用检查（user scope）→ 删远端对象 + attachment_files 行。 */
async function gcAttachmentFile(
  db: D1Database,
  storage: GCStorage,
  userId: string,
  fileId: string,
): Promise<void> {
  const attFile = await db
    .prepare("SELECT storage_path, sha256 FROM attachment_files WHERE id = ? AND attachment_kind = 'transaction'")
    .bind(fileId)
    .first<{ storage_path: string | null; sha256: string | null }>();
  if (!attFile) return;
  const stillReferenced = await isAttachmentStillReferenced({
    db,
    fileId,
    sha256: attFile.sha256,
    scope: { userId },
  });
  if (stillReferenced) return;
  if (attFile.storage_path) {
    await deleteFromStorage(db, storage, attFile.storage_path.replace(/^beecount\//, ''));
  }
  await db.prepare('DELETE FROM attachment_files WHERE id = ?').bind(fileId).run();
}

/**
 * 过期挂起批量处理（对齐上游 expire_pending_attachment_gc，limit 默认 128）。
 * 返回处理的行数（供 cron 日志/连续调度判断）。
 */
export async function expirePendingAttachmentGc(
  db: D1Database,
  storage: GCStorage,
  limit = 128,
): Promise<number> {
  const dueRows = await db
    .prepare(
      `SELECT ledger_id, sync_id, user_id, attachments_json, pending_attachment_gc_json, attachment_gc_after
       FROM read_tx_projection
       WHERE attachment_gc_after IS NOT NULL AND attachment_gc_after <= ?
       ORDER BY attachment_gc_after
       LIMIT ?`
    )
    .bind(nowUtc(), limit)
    .all<GcProjectionRow>();

  for (const row of dueRows.results ?? []) {
    try {
      const held = jsonParse<Record<string, string[]>>(row.pending_attachment_gc_json, {});
      const heldIds = Object.keys(held);
      const { hashes, localNames } = pendingUploadSignals(row.attachments_json);

      // 仍在上传中的附件保留：attachment_files 行的 sha256 命中等待哈希，
      // 或挂起时记录的本地文件名与占位条目文件名相交
      const retained = new Set<string>();
      if (heldIds.length > 0 && hashes.size > 0) {
        const placeholders = heldIds.map(() => '?').join(',');
        const hashPlaceholders = [...hashes].map(() => '?').join(',');
        const rows = await db
          .prepare(
            `SELECT id FROM attachment_files WHERE id IN (${placeholders}) AND sha256 IN (${hashPlaceholders})`
          )
          .bind(...heldIds, ...[...hashes])
          .all<{ id: string }>();
        for (const r of rows.results ?? []) retained.add(r.id);
      }
      for (const [fid, names] of Object.entries(held)) {
        if (names.some(n => localNames.has(n))) retained.add(fid);
      }

      // 更新挂起状态：仍等待的留在 pending json（deadline 清空，下次 upsert 重新计时）
      const retainedJson = retained.size > 0
        ? JSON.stringify(Object.fromEntries([...retained].sort().map(fid => [fid, held[fid] ?? []])))
        : null;
      await db
        .prepare('UPDATE read_tx_projection SET pending_attachment_gc_json = ?, attachment_gc_after = NULL WHERE ledger_id = ? AND sync_id = ?')
        .bind(retainedJson, row.ledger_id, row.sync_id)
        .run();

      // 真正回收：挂起 − 仍等待
      for (const fid of heldIds) {
        if (retained.has(fid)) continue;
        await gcAttachmentFile(db, storage, row.user_id, fid);
      }
    } catch (err) {
      // 单行失败不影响其余行（对齐上游 best-effort 语义）
      console.error('[attachment-gc] row failed:', (err as Error).message);
    }
  }

  return (dueRows.results ?? []).length;
}
