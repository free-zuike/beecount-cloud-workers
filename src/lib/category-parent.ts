/**
 * 对齐上游 0758b41（#101 category parent identity）的分类父级解析：
 * parentSyncId 稳定关联优先；缺 ID 时 parentName 必须唯一匹配「顶级无父」
 * 分类（同 kind、level=1、非自己、自身无父），歧义/无匹配不猜。
 */
export async function resolveCategoryParent(
  db: D1Database,
  userId: string,
  kind: string | null,
  parentSyncId: string | null | undefined,
  parentName: string | null | undefined,
  selfSyncId: string,
): Promise<{ parentSyncId: string | null; parentName: string | null }> {
  let psid = parentSyncId ? parentSyncId.trim() : null;
  let pname = parentName ? parentName.trim() : null;

  if (psid === null && pname) {
    const rows = await db.prepare(
      `SELECT sync_id FROM user_category_projection
       WHERE user_id = ? AND name = ? AND kind = ?
         AND (level IS NULL OR level = 1) AND sync_id != ?
         AND parent_sync_id IS NULL AND parent_name IS NULL`
    ).bind(userId, pname, kind, selfSyncId).all<{ sync_id: string }>();
    if (rows.results.length === 1) psid = rows.results[0].sync_id;
  }

  if (psid) {
    const parent = await db.prepare(
      `SELECT name FROM user_category_projection
       WHERE user_id = ? AND sync_id = ? AND kind = ? AND (level IS NULL OR level = 1)`
    ).bind(userId, psid, kind).first<{ name: string | null }>();
    if (parent) pname = parent.name;
  }

  return { parentSyncId: psid, parentName: pname };
}