export type ResolvedCategory = {
  categoryId: string | null
  categoryName: string | null
  categoryKind: 'expense' | 'income' | 'transfer' | null
}

/**
 * Resolve the canonical transfer category for one user.
 *
 * Transfer is a real category kind in BeeCount. Historically the Web editor
 * cleared category fields for transfers, so many transfer rows ended up
 * uncategorized even though every user has a top-level `transfer` category.
 *
 * The caller may pass an explicit category. If no category is supplied for a
 * transfer, this helper chooses the user's top-level transfer category. The
 * Chinese default name `转账` is preferred, but the logic remains locale-safe.
 */
export async function resolveTransactionCategory(
  db: D1Database,
  userId: string,
  txType: string,
  category: {
    categoryId?: string | null
    categoryName?: string | null
    categoryKind?: string | null
  },
): Promise<ResolvedCategory> {
  const explicitId = category.categoryId?.trim() || null
  const explicitName = category.categoryName?.trim() || null
  const explicitKind = category.categoryKind as ResolvedCategory['categoryKind'] | undefined

  if (txType !== 'transfer') {
    return {
      categoryId: explicitId,
      categoryName: explicitName,
      categoryKind: explicitKind ?? (txType === 'income' ? 'income' : txType === 'expense' ? 'expense' : null),
    }
  }

  if (explicitId || explicitName) {
    let row: { sync_id: string; name: string } | null = null
    if (explicitId) {
      row = await db.prepare(
        `SELECT sync_id, name
         FROM user_category_projection
         WHERE user_id = ? AND sync_id = ? AND kind = 'transfer'
         LIMIT 1`,
      ).bind(userId, explicitId).first<{ sync_id: string; name: string }>()
    }
    if (!row && explicitName) {
      row = await db.prepare(
        `SELECT sync_id, name
         FROM user_category_projection
         WHERE user_id = ? AND kind = 'transfer' AND name = ?
         ORDER BY CASE WHEN level = 1 THEN 0 ELSE 1 END, name
         LIMIT 1`,
      ).bind(userId, explicitName).first<{ sync_id: string; name: string }>()
    }
    return {
      categoryId: row?.sync_id ?? explicitId,
      categoryName: row?.name ?? explicitName,
      categoryKind: 'transfer',
    }
  }

  const fallback = await db.prepare(
    `SELECT sync_id, name
     FROM user_category_projection
     WHERE user_id = ? AND kind = 'transfer'
     ORDER BY CASE WHEN name = '转账' THEN 0 ELSE 1 END,
              CASE WHEN level = 1 THEN 0 ELSE 1 END,
              name
     LIMIT 1`,
  ).bind(userId).first<{ sync_id: string; name: string }>()

  return {
    categoryId: fallback?.sync_id ?? null,
    categoryName: fallback?.name ?? null,
    categoryKind: fallback ? 'transfer' : null,
  }
}
