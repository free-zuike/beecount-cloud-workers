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
import { isAttachmentStillReferenced } from '../../lib/attachment-reference';

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
    WHERE p.category_sync_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM user_category_projection c
        WHERE c.user_id = p.user_id AND c.sync_id = p.category_sync_id
      )
    `).all<{ user_id: string; ledger_id: string; sync_id: string; amount: number; category_sync_id: string }>();

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
    WHERE p.account_sync_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM user_account_projection a
        WHERE a.user_id = p.user_id AND a.sync_id = p.account_sync_id
      )
    `).all<{ user_id: string; ledger_id: string; sync_id: string; amount: number; account_sync_id: string }>();

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
    WHERE p.from_account_sync_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM user_account_projection a
        WHERE a.user_id = p.user_id AND a.sync_id = p.from_account_sync_id
      )
    `).all<{ user_id: string; ledger_id: string; sync_id: string; amount: number; from_account_sync_id: string }>();

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
    WHERE p.to_account_sync_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM user_account_projection a
        WHERE a.user_id = p.user_id AND a.sync_id = p.to_account_sync_id
      )
    `).all<{ user_id: string; ledger_id: string; sync_id: string; amount: number; to_account_sync_id: string }>();

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
    WHERE p.category_sync_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM user_category_projection c
        WHERE c.user_id = p.user_id AND c.sync_id = p.category_sync_id
      )
    `).all<{ user_id: string; ledger_id: string; sync_id: string; amount: number; budget_type: string; category_sync_id: string }>();

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
    `).all<{ change_id: number; user_id: string; entity_type: string; entity_sync_id: string; action: string }>();

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
     `).all<{
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
    // 按 cloudFileId 精确匹配 + category 图标；同 sha 冗余行的保护见 helper 注释）
    const stillReferenced = await isAttachmentStillReferenced({
      db,
      fileId: row.id,
      sha256: row.sha256,
      scope: { userId: row.user_id },
      checkCategoryIcon: true,
    });
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
     `).all<{
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
      // 兼容两种存储格式：DB 可能存 attachments/...（无前缀，上传路径）
      // 或 beecount/attachments/...（带前缀，恢复/补登路径）。R2 实际 key 由
      // storage-adapter 统一加 beecount/ 前缀。两种变体都尝试，避免误报。
      const variants = [
        row.storage_path,
        row.storage_path.startsWith('beecount/') ? row.storage_path.slice('beecount/'.length) : `beecount/${row.storage_path}`,
      ];
      for (const key of variants) {
        try {
          const obj = await r2.head(key);
          if (obj) { exists = true; break; }
        } catch { /* try next variant */ }
      }
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
     `).all<{ ledger_id: string; sync_id: string; user_id: string; attachments_json: string }>();

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

/**
 * B5 — 同 sha 多行且组内多个行被交易引用（去重上线前的历史脏数据）。
 * 每个次行生成一条记录，cleaner 把引用迁移到保留行（最早被引用行）后删除。
 * 组内零引用行归 B1（attachment_no_ref）处理，不在这里重复列出。
 */
async function scanAttachmentDupRef(db: D1Database): Promise<OrphanRecord[]> {
  const groups = await db.prepare(
    `SELECT ledger_id, sha256 FROM attachment_files
     WHERE attachment_kind = 'transaction'
     GROUP BY ledger_id, sha256 HAVING COUNT(*) > 1`
  ).all<{ ledger_id: string; sha256: string }>();

  const orphans: OrphanRecord[] = [];
  for (const g of groups.results) {
    const rows = await db.prepare(
      `SELECT id, file_name, sha256, created_at FROM attachment_files
       WHERE ledger_id = ? AND sha256 = ? AND attachment_kind = 'transaction'
       ORDER BY created_at ASC, id ASC`
    ).bind(g.ledger_id, g.sha256).all<{ id: string; file_name: string | null; sha256: string | null; created_at: string }>();

    const referenced: Array<{ id: string; file_name: string | null }> = [];
    for (const row of rows.results) {
      const still = await isAttachmentStillReferenced({
        db,
        fileId: row.id,
        sha256: row.sha256,
        scope: { ledgerId: g.ledger_id },
      });
      if (still) referenced.push({ id: row.id, file_name: row.file_name });
    }
    if (referenced.length <= 1) continue; // 至多一个被引用行 → 其余走 B1

    const keep = referenced[0];
    for (const dup of referenced.slice(1)) {
      orphans.push({
        type: 'attachment_dup_ref' as const,
        row_id: dup.id,
        title: `附件重复引用 ${dup.file_name ?? dup.id.slice(0, 12)}`,
        subtitle: `同 sha 多行:引用将迁移到 ${keep.id.slice(0, 8)}… 后删除本行`,
        extra: { ledger_id: g.ledger_id, keep_id: keep.id },
      });
    }
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
    ...(await scanAttachmentDupRef(db)),
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