/**
 * 数据清理服务 - 扫描器
 *
 * 与原版 BeeCount-Cloud Python 的 src/services/data_cleanup/scanner.py 彻底对齐。
 * 扫描数据库中的孤立数据（实体引用已删的断链）。
 *
 * 关键差异：原版用 SQLAlchemy NOT EXISTS 相关子查询，关联条件 (user_id, sync_id)
 * 命中 user_*_projection 复合主键索引 —— 高效；worker 旧实现用 LEFT JOIN + 无索引
 * 导致笛卡尔扫描打爆 D1 行读取，已废弃。这里全部用 NOT EXISTS。
 */

import type { OrphanRecord, ScanReport } from './types';

const MAX_ORPHANS = 100;

// ---------------------------------------------------------------------------
// A 类：DB 引用断链（实体引用已删） — 与原版 scanner.py A 类对齐
// ---------------------------------------------------------------------------

/**
 * A1 — read_tx_projection.category_sync_id 在 user_category_projection 不存在。
 * user-global 维度：同 user_id 范围内 category sync_id 集合反查。
 */
async function scanTxMissingCategory(db: D1Database): Promise<OrphanRecord[]> {
  const result = await db.prepare(`
    SELECT p.user_id, p.ledger_id, p.sync_id, p.amount, p.category_sync_id
    FROM read_tx_projection p
    WHERE p.category_sync_id IS NOT NULL AND p.category_sync_id != ''
      AND NOT EXISTS (
        SELECT 1 FROM user_category_projection c
        WHERE c.user_id = p.user_id AND c.sync_id = p.category_sync_id
      )
    LIMIT ?
  `).bind(MAX_ORPHANS).all<{ user_id: string; ledger_id: string; sync_id: string; amount: number; category_sync_id: string }>();

  return result.results.map((row) => ({
    type: 'tx_missing_category' as const,
    user_id: row.user_id,
    row_id: `${row.ledger_id}:${row.sync_id}`,
    sync_id: row.sync_id,
    title: `交易 ${row.sync_id.slice(0, 8)} (¥${row.amount.toFixed(2)})`,
    subtitle: `分类已删 categorySyncId=${row.category_sync_id.slice(0, 8)}…`,
    extra: { ledger_id: row.ledger_id, sync_id: row.sync_id },
  }));
}

/**
 * A2 — read_tx_projection.account_sync_id 在 user_account_projection 不存在。
 */
async function scanTxMissingAccount(db: D1Database): Promise<OrphanRecord[]> {
  const result = await db.prepare(`
    SELECT p.user_id, p.ledger_id, p.sync_id, p.amount, p.account_sync_id
    FROM read_tx_projection p
    WHERE p.account_sync_id IS NOT NULL AND p.account_sync_id != ''
      AND NOT EXISTS (
        SELECT 1 FROM user_account_projection a
        WHERE a.user_id = p.user_id AND a.sync_id = p.account_sync_id
      )
    LIMIT ?
  `).bind(MAX_ORPHANS).all<{ user_id: string; ledger_id: string; sync_id: string; amount: number; account_sync_id: string }>();

  return result.results.map((row) => ({
    type: 'tx_missing_account' as const,
    user_id: row.user_id,
    row_id: `${row.ledger_id}:${row.sync_id}`,
    sync_id: row.sync_id,
    title: `交易 ${row.sync_id.slice(0, 8)} (¥${row.amount.toFixed(2)})`,
    subtitle: `账户已删 accountSyncId=${row.account_sync_id.slice(0, 8)}…`,
    extra: { ledger_id: row.ledger_id, sync_id: row.sync_id, field: 'account_sync_id' },
  }));
}

/**
 * A3a — 转账 tx.from_account_sync_id 已删。
 */
async function scanTxMissingFromAccount(db: D1Database): Promise<OrphanRecord[]> {
  const result = await db.prepare(`
    SELECT p.user_id, p.ledger_id, p.sync_id, p.amount, p.from_account_sync_id
    FROM read_tx_projection p
    WHERE p.from_account_sync_id IS NOT NULL AND p.from_account_sync_id != ''
      AND NOT EXISTS (
        SELECT 1 FROM user_account_projection a
        WHERE a.user_id = p.user_id AND a.sync_id = p.from_account_sync_id
      )
    LIMIT ?
  `).bind(MAX_ORPHANS).all<{ user_id: string; ledger_id: string; sync_id: string; amount: number; from_account_sync_id: string }>();

  return result.results.map((row) => ({
    type: 'tx_missing_from_account' as const,
    user_id: row.user_id,
    row_id: `${row.ledger_id}:${row.sync_id}`,
    sync_id: row.sync_id,
    title: `转账 ${row.sync_id.slice(0, 8)} (¥${row.amount.toFixed(2)})`,
    subtitle: `转出账户已删 fromAccountSyncId=${row.from_account_sync_id.slice(0, 8)}…`,
    extra: { ledger_id: row.ledger_id, sync_id: row.sync_id, field: 'from_account_sync_id' },
  }));
}

/**
 * A3b — 转账 tx.to_account_sync_id 已删。
 */
async function scanTxMissingToAccount(db: D1Database): Promise<OrphanRecord[]> {
  const result = await db.prepare(`
    SELECT p.user_id, p.ledger_id, p.sync_id, p.amount, p.to_account_sync_id
    FROM read_tx_projection p
    WHERE p.to_account_sync_id IS NOT NULL AND p.to_account_sync_id != ''
      AND NOT EXISTS (
        SELECT 1 FROM user_account_projection a
        WHERE a.user_id = p.user_id AND a.sync_id = p.to_account_sync_id
      )
    LIMIT ?
  `).bind(MAX_ORPHANS).all<{ user_id: string; ledger_id: string; sync_id: string; amount: number; to_account_sync_id: string }>();

  return result.results.map((row) => ({
    type: 'tx_missing_to_account' as const,
    user_id: row.user_id,
    row_id: `${row.ledger_id}:${row.sync_id}`,
    sync_id: row.sync_id,
    title: `转账 ${row.sync_id.slice(0, 8)} (¥${row.amount.toFixed(2)})`,
    subtitle: `转入账户已删 toAccountSyncId=${row.to_account_sync_id.slice(0, 8)}…`,
    extra: { ledger_id: row.ledger_id, sync_id: row.sync_id, field: 'to_account_sync_id' },
  }));
}

/**
 * A4 — read_budget_projection.category_sync_id 已删。
 */
async function scanBudgetMissingCategory(db: D1Database): Promise<OrphanRecord[]> {
  const result = await db.prepare(`
    SELECT p.user_id, p.ledger_id, p.sync_id, p.amount, p.budget_type, p.category_sync_id
    FROM read_budget_projection p
    WHERE p.category_sync_id IS NOT NULL AND p.category_sync_id != ''
      AND NOT EXISTS (
        SELECT 1 FROM user_category_projection c
        WHERE c.user_id = p.user_id AND c.sync_id = p.category_sync_id
      )
    LIMIT ?
  `).bind(MAX_ORPHANS).all<{ user_id: string; ledger_id: string; sync_id: string; amount: number; budget_type: string; category_sync_id: string }>();

  return result.results.map((row) => ({
    type: 'budget_missing_category' as const,
    user_id: row.user_id,
    row_id: `${row.ledger_id}:${row.sync_id}`,
    sync_id: row.sync_id,
    title: `预算 ${row.sync_id.slice(0, 8)} (¥${(row.amount || 0).toFixed(0)})`,
    subtitle: `分类已删 categorySyncId=${row.category_sync_id.slice(0, 8)}…`,
    extra: { ledger_id: row.ledger_id, sync_id: row.sync_id },
  }));
}

/**
 * A5/C1 — sync_changes 引用的实体已不存在（非 delete action）。
 * entity_type → 对应投影表（user-global 用 user_id+sync_id；tx/budget 用 user_id+sync_id）。
 * delete 不算孤儿（本来就是删除标记）。
 */
async function scanSyncChangeMissingEntity(db: D1Database): Promise<OrphanRecord[]> {
  const result = await db.prepare(`
    SELECT sc.change_id, sc.user_id, sc.entity_type, sc.entity_sync_id, sc.action
    FROM sync_changes sc
    WHERE sc.action != 'delete'
      AND (
        (sc.entity_type = 'transaction' AND NOT EXISTS (
          SELECT 1 FROM read_tx_projection p
          WHERE p.user_id = sc.user_id AND p.sync_id = sc.entity_sync_id
        ))
        OR (sc.entity_type = 'account' AND NOT EXISTS (
          SELECT 1 FROM user_account_projection a
          WHERE a.user_id = sc.user_id AND a.sync_id = sc.entity_sync_id
        ))
        OR (sc.entity_type = 'category' AND NOT EXISTS (
          SELECT 1 FROM user_category_projection c
          WHERE c.user_id = sc.user_id AND c.sync_id = sc.entity_sync_id
        ))
        OR (sc.entity_type = 'tag' AND NOT EXISTS (
          SELECT 1 FROM user_tag_projection t
          WHERE t.user_id = sc.user_id AND t.sync_id = sc.entity_sync_id
        ))
        OR (sc.entity_type = 'budget' AND NOT EXISTS (
          SELECT 1 FROM read_budget_projection b
          WHERE b.user_id = sc.user_id AND b.sync_id = sc.entity_sync_id
        ))
      )
    LIMIT ?
  `).bind(MAX_ORPHANS).all<{ change_id: number; user_id: string; entity_type: string; entity_sync_id: string; action: string }>();

  return result.results.map((row) => ({
    type: 'sync_change_missing_entity' as const,
    user_id: row.user_id,
    row_id: String(row.change_id),
    sync_id: row.entity_sync_id,
    title: `SyncChange #${row.change_id}`,
    subtitle: `${row.entity_type} · ${row.action} · 实体已删 ${row.entity_sync_id.slice(0, 8)}…`,
    extra: { change_id: row.change_id, entity_type: row.entity_type },
  }));
}

// ---------------------------------------------------------------------------
// B 类：附件 / 文件 — 与原版 scanner.py B 类对齐（worker 用 R2，无本地磁盘）
// ---------------------------------------------------------------------------

/**
 * B1 — AttachmentFile 行没被任何 tx (attachments_json) 或 category
 * (icon_cloud_file_id) 引用 — 对齐原版 _scan_attachment_no_ref。
 */
async function scanAttachmentNoRef(db: D1Database): Promise<OrphanRecord[]> {
  const rows = await db.prepare(
    `SELECT id, user_id, size_bytes, file_name, storage_path, attachment_kind, sha256
     FROM attachment_files
     LIMIT ?`
  ).bind(MAX_ORPHANS).all<{
    id: string;
    user_id: string;
    size_bytes: number | null;
    file_name: string | null;
    storage_path: string;
    attachment_kind: string;
    sha256: string | null;
  }>();

  const orphans: OrphanRecord[] = [];
  for (const row of rows.results) {
    // 判定是否仍被引用（对齐原版 _fileid_still_referenced：tx 的 attachments_json
    // 两种空格变体 + category 图标的 icon_cloud_file_id；INSTR 避免 LIKE 模式复杂度限制）
    const patNoSpace = `"cloudFileId":"${row.id}"`;
    const patWithSpace = `"cloudFileId": "${row.id}"`;
    // App 端（Flutter）attachments_json 用 fileName（sha 哈希）而非 cloudFileId，
    // 格式：{"fileName":"sha_<sha256>.jpg"}，需同时检查
    const shaPat = row.sha256 ? `sha_${row.sha256}.jpg` : null;
    const txHit = await db.prepare(
      `SELECT COUNT(*) as cnt FROM read_tx_projection
       WHERE user_id = ? AND (INSTR(attachments_json, ?) > 0 OR INSTR(attachments_json, ?) > 0${shaPat ? ' OR INSTR(attachments_json, ?) > 0' : ''})`
    ).bind(row.user_id, patNoSpace, patWithSpace, ...(shaPat ? [shaPat] : [])).first<{ cnt: number }>();

    let stillReferenced = txHit && txHit.cnt > 0;
    if (!stillReferenced) {
      const catHit = await db.prepare(
        `SELECT COUNT(*) as cnt FROM user_category_projection
         WHERE user_id = ? AND icon_cloud_file_id = ?`
      ).bind(row.user_id, row.id).first<{ cnt: number }>();
      stillReferenced = catHit && catHit.cnt > 0;
    }

    if (stillReferenced) continue;

    orphans.push({
      type: 'attachment_no_ref' as const,
      user_id: row.user_id,
      row_id: row.id,
      title: row.file_name || row.id.slice(0, 12),
      subtitle: `附件无引用 · ${row.attachment_kind}`,
      file_path: row.storage_path,
      size_bytes: row.size_bytes ?? 0,
    });
  }

  return orphans;
}

/**
 * B2 — AttachmentFile.storage_path 指向的 R2 对象不存在 — 对齐原版
 * _scan_attachment_file_missing（本地磁盘 → R2 适配）。
 */
async function scanAttachmentFileMissing(db: D1Database, r2?: R2Bucket): Promise<OrphanRecord[]> {
  const rows = await db.prepare(
    `SELECT id, user_id, file_name, storage_path, size_bytes
     FROM attachment_files
     LIMIT ?`
  ).bind(MAX_ORPHANS).all<{
    id: string;
    user_id: string;
    file_name: string | null;
    storage_path: string;
    size_bytes: number | null;
  }>();

  const orphans: OrphanRecord[] = [];
  for (const row of rows.results) {
    if (!row.storage_path) continue;
    let exists = false;
    if (r2) {
      try {
        const obj = await r2.head(row.storage_path);
        exists = !!obj;
      } catch { exists = false; }
    }
    // r2 未配置时无法判定（跳过，避免误报）
    if (r2 && exists) continue;

    if (!r2) {
      // 无 R2 绑定时做 DB-only 检查：storage_path 存在即可（无法验物理文件）
      continue;
    }
    orphans.push({
      type: 'attachment_file_missing' as const,
      user_id: row.user_id,
      row_id: row.id,
      title: row.file_name || row.id.slice(0, 12),
      subtitle: 'R2 对象丢失,DB 行残留',
      file_path: row.storage_path,
      size_bytes: row.size_bytes ?? 0,
    });
  }
  return orphans;
}

/**
 * B3 — R2 有对象但 attachment_files 无行 — 对齐原版 _scan_disk_file_no_row
 * （本地磁盘 → R2 适配）。scan 全部对象，比对 storage_path 全集。
 */
async function scanDiskFileNoRow(db: D1Database, r2?: R2Bucket): Promise<OrphanRecord[]> {
  if (!r2) return [];
  const dbPaths = new Set<string>();
  const rows = await db.prepare(
    `SELECT storage_path FROM attachment_files WHERE storage_path IS NOT NULL AND storage_path != ''`
  ).all<{ storage_path: string }>();
  for (const r of rows.results) dbPaths.add(r.storage_path.replace(/^beecount\//, ''));

  const orphans: OrphanRecord[] = [];
  for (const prefix of ['beecount/attachments/', 'attachments/']) {
    let cursor: string | undefined;
    do {
      let listing;
      try {
        listing = await r2.list({ prefix, limit: 1000, cursor });
      } catch {
        break;
      }
      for (const obj of listing.objects) {
        const key = obj.key.replace(/^beecount\//, '');
        if (dbPaths.has(key)) continue;
        orphans.push({
          type: 'disk_file_no_row' as const,
          title: obj.key.split('/').pop() || obj.key,
          subtitle: `R2 对象无 DB 行 · ${obj.key}`,
          file_path: obj.key,
          size_bytes: obj.size,
        });
      }
      cursor = listing.truncated && listing.objects.length > 0
        ? listing.objects[listing.objects.length - 1].key
        : undefined;
    } while (cursor);
  }
  return orphans;
}

/**
 * B4 — read_tx_projection.attachments_json 引用的 cloudFileId 在
 * attachment_files 不存在 — 对齐原版 _scan_tx_ref_broken_attachment。
 */
async function scanTxRefBrokenAttachment(db: D1Database): Promise<OrphanRecord[]> {
  const allFileIds = new Set<string>();
  const idRows = await db.prepare('SELECT id FROM attachment_files').all<{ id: string }>();
  for (const r of idRows.results) allFileIds.add(r.id);

  const rows = await db.prepare(
    `SELECT ledger_id, sync_id, user_id, attachments_json
     FROM read_tx_projection
     WHERE attachments_json IS NOT NULL
     LIMIT ?`
  ).bind(MAX_ORPHANS).all<{ ledger_id: string; sync_id: string; user_id: string; attachments_json: string }>();

  const orphans: OrphanRecord[] = [];
  for (const row of rows.results) {
    if (!row.attachments_json) continue;
    let atts: unknown;
    try {
      atts = JSON.parse(row.attachments_json);
    } catch { continue; }
    if (!Array.isArray(atts)) continue;
    const broken: string[] = [];
    for (const att of atts) {
      if (!att || typeof att !== 'object') continue;
      const fid = (att as Record<string, unknown>).cloudFileId;
      if (typeof fid === 'string' && fid && !allFileIds.has(fid)) broken.push(fid);
    }
    if (broken.length === 0) continue;
    orphans.push({
      type: 'tx_ref_broken_attachment' as const,
      user_id: row.user_id,
      row_id: `${row.ledger_id}:${row.sync_id}`,
      sync_id: row.sync_id,
      title: `交易 ${row.sync_id.slice(0, 8)} 引用 ${broken.length} 个失效附件`,
      subtitle: `cloudFileId 不在 attachment_files 表:${broken[0].slice(0, 12)}…`,
      extra: { ledger_id: row.ledger_id, sync_id: row.sync_id, broken_file_ids: broken },
    });
  }
  return orphans;
}

// ---------------------------------------------------------------------------
// scanAll — 与原版 scan_all() 对齐，聚合返回
// ---------------------------------------------------------------------------

export async function scanAll(db: D1Database, r2?: R2Bucket): Promise<ScanReport> {
  const dbOrphans: OrphanRecord[] = [];
  const fileOrphans: OrphanRecord[] = [];
  const syncOrphans: OrphanRecord[] = [];

  // A 类：DB 引用断链
  dbOrphans.push(
    ...(await scanTxMissingCategory(db)),
    ...(await scanTxMissingAccount(db)),
    ...(await scanTxMissingFromAccount(db)),
    ...(await scanTxMissingToAccount(db)),
    ...(await scanBudgetMissingCategory(db)),
  );

  // C 类：sync_changes 引用实体不存在
  syncOrphans.push(...(await scanSyncChangeMissingEntity(db)));

  // B 类：附件 / 文件
  fileOrphans.push(
    ...(await scanAttachmentNoRef(db)),
    ...(await scanAttachmentFileMissing(db, r2)),
    ...(await scanDiskFileNoRow(db, r2)),
    ...(await scanTxRefBrokenAttachment(db)),
  );

  let totalSizeBytes = 0;
  for (const orphan of fileOrphans) {
    totalSizeBytes += orphan.size_bytes ?? 0;
  }

  return {
    db_orphans: dbOrphans,
    file_orphans: fileOrphans,
    sync_orphans: syncOrphans,
    total_count: dbOrphans.length + fileOrphans.length + syncOrphans.length,
    total_size_bytes: totalSizeBytes,
  };
}