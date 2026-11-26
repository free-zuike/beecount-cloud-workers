/**
 * 残留子分类检测与清理（对齐上游 1.10.x services/data_cleanup/category_orphans.py）。
 *
 * 判定：子分类的父分类「不存在」——注意缺失的父 ID 本身不能证明父分类已删除
 * （例如父分类尚未上传）；只有 sync_changes 里该父分类的最新事件是 delete 且晚于
 * 子分类的最后变更时，才视为「父分类已删除」。
 * 同时给出 referenced（仍被交易/预算/下级分类引用）与 parent_deleted，
 * 两者共同决定 can_clean（可安全删除）。
 */

export interface CategoryParentIssue {
  user_id: string;
  sync_id: string;
  name: string | null;
  source_change_id: number | null;
  parent_id: string | null;
  parent_name: string | null;
  parent_event_id: number | null;
  parent_deleted: number;
  referenced: number;
}

/** 对齐上游 _orphan_categories 的核心查询（D1/SQLite 版）。 */
export async function listCategoryParentIssues(
  db: D1Database,
  options: { userId?: string; syncId?: string } = {}
): Promise<CategoryParentIssue[]> {
  const filters: string[] = [];
  const params: string[] = [];
  if (options.userId) {
    filters.push('c.user_id = ?');
    params.push(options.userId);
  }
  if (options.syncId) {
    filters.push('c.sync_id = ?');
    params.push(options.syncId);
  }
  const where = filters.length > 0 ? ` AND ${filters.join(' AND ')}` : '';

  const rows = await db
    .prepare(
      `SELECT
         c.user_id AS user_id,
         c.sync_id AS sync_id,
         c.name AS name,
         c.source_change_id AS source_change_id,
         NULLIF(TRIM(c.parent_sync_id), '') AS parent_id,
         NULLIF(TRIM(c.parent_name), '') AS parent_name,
         (SELECT MAX(sc.change_id) FROM sync_changes sc
           WHERE sc.user_id = c.user_id
             AND sc.scope = 'user'
             AND sc.entity_type = 'category'
             AND sc.entity_sync_id = NULLIF(TRIM(c.parent_sync_id), '')) AS parent_event_id,
         (
           NOT EXISTS (
             SELECT 1 FROM user_category_projection p
             WHERE p.user_id = c.user_id
               AND p.sync_id = NULLIF(TRIM(c.parent_sync_id), '')
           )
           AND EXISTS (
             SELECT 1 FROM sync_changes sc2
             WHERE sc2.change_id = (
                 SELECT MAX(sc.change_id) FROM sync_changes sc
                 WHERE sc.user_id = c.user_id
                   AND sc.scope = 'user'
                   AND sc.entity_type = 'category'
                   AND sc.entity_sync_id = NULLIF(TRIM(c.parent_sync_id), '')
               )
               AND sc2.action = 'delete'
               AND sc2.change_id > c.source_change_id
           )
         ) AS parent_deleted,
         (
           EXISTS (
             SELECT 1 FROM read_tx_projection tx
             WHERE tx.user_id = c.user_id
               AND (
                 tx.category_sync_id = c.sync_id
                 OR (tx.category_sync_id IS NULL AND tx.category_name = c.name)
               )
           )
           OR EXISTS (
             SELECT 1 FROM read_budget_projection b
             WHERE b.user_id = c.user_id AND b.category_sync_id = c.sync_id
           )
           OR EXISTS (
             SELECT 1 FROM user_category_projection d
             WHERE d.user_id = c.user_id
               AND d.sync_id <> c.sync_id
               AND (
                 d.parent_sync_id = c.sync_id
                 OR (d.parent_sync_id IS NULL AND d.parent_name = c.name AND d.kind = c.kind)
               )
           )
         ) AS referenced
       FROM user_category_projection c
       WHERE (c.level = 2
              OR NULLIF(TRIM(c.parent_sync_id), '') IS NOT NULL
              OR NULLIF(TRIM(c.parent_name), '') IS NOT NULL)
         AND NOT EXISTS (
           SELECT 1 FROM user_category_projection p
           WHERE p.user_id = c.user_id
             AND p.sync_id <> c.sync_id
             AND p.kind = c.kind
             AND COALESCE(p.level, 1) = 1
             AND NULLIF(TRIM(p.parent_sync_id), '') IS NULL
             AND NULLIF(TRIM(p.parent_name), '') IS NULL
             AND (
               p.sync_id = NULLIF(TRIM(c.parent_sync_id), '')
               OR (NULLIF(TRIM(c.parent_sync_id), '') IS NULL AND TRIM(p.name) = NULLIF(TRIM(c.parent_name), ''))
             )
         )${where}
       ORDER BY c.sync_id`
    )
    .bind(...params)
    .all<CategoryParentIssue>();
  return (rows.results ?? []).map((row) => ({
    ...row,
    parent_deleted: Number(row.parent_deleted),
    referenced: Number(row.referenced),
  }));
}

/**
 * 删除一个确认可清理的孤儿分类（对齐上游 delete_orphan_category）：
 * - 必须带扫描版本（source_change_id），防止用过期扫描结果删掉已修复的分类
 * - 删除后写 user-scope delete 事件并压掉旧 upsert 历史
 * 返回 'deleted' | 'stale' | 'missing'
 */
export async function deleteOrphanCategory(
  db: D1Database,
  params: {
    userId: string;
    syncId: string;
    sourceChangeId: number;
    actorUserId: string | null;
  }
): Promise<'deleted' | 'stale' | 'missing'> {
  const { userId, syncId, sourceChangeId, actorUserId } = params;
  if (!userId || !syncId || !Number.isInteger(sourceChangeId)) {
    throw new Error('分类清理缺少扫描版本，请重新扫描');
  }

  const now = new Date().toISOString();
  const candidate = (
    await listCategoryParentIssues(db, { userId, syncId })
  )[0];

  if (!candidate) {
    const exists = await db
      .prepare('SELECT 1 AS ok FROM user_category_projection WHERE user_id = ? AND sync_id = ?')
      .bind(userId, syncId)
      .first();
    return exists ? 'stale' : 'missing';
  }
  if (candidate.source_change_id !== sourceChangeId) {
    return 'stale';
  }
  if (!candidate.parent_deleted || candidate.referenced) {
    return 'stale';
  }

  const statements = [
    db
      .prepare(
        `DELETE FROM user_category_projection
         WHERE user_id = ? AND sync_id = ? AND source_change_id = ?`
      )
      .bind(userId, syncId, sourceChangeId),
    db
      .prepare(
        `INSERT INTO sync_changes
         (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_device_id, updated_by_user_id, scope)
         VALUES (?, NULL, 'category', ?, 'delete', '{}', ?, 'admin-data-cleanup', ?, 'user')`
      )
      .bind(userId, syncId, now, actorUserId),
    db
      .prepare(
        `DELETE FROM sync_changes
         WHERE user_id = ? AND scope = 'user' AND entity_type = 'category'
           AND entity_sync_id = ? AND action <> 'delete'`
      )
      .bind(userId, syncId),
  ];

  const result = await db.batch(statements);
  const deleted = Number((result[0] as { meta?: { changes?: number } })?.meta?.changes ?? 0);
  return deleted > 0 ? 'deleted' : 'missing';
}
