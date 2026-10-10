export type CategoryHierarchyNode = {
  sync_id: string;
  name: string;
  kind: string | null;
  level: number | null;
  parent_name: string | null;
  parent_sync_id: string | null;
};

export type CategoryHierarchy = {
  byId: Map<string, CategoryHierarchyNode>;
  parentById: Map<string, string>;
  childrenByParent: Map<string, string[]>;
};

function nameKey(kind: string | null, name: string): string {
  return `${kind ?? ''}::${name.trim().toLowerCase()}`;
}

/** Build a stable hierarchy from the user-global category projection.
 * parent_sync_id is authoritative; parent_name is a legacy fallback. */
export function buildCategoryHierarchy(rows: CategoryHierarchyNode[]): CategoryHierarchy {
  const byId = new Map(rows.map((row) => [row.sync_id, row]));
  const topLevelByName = new Map<string, string>();

  for (const row of rows) {
    if (row.level === 1 || (!row.parent_sync_id && !row.parent_name)) {
      topLevelByName.set(nameKey(row.kind, row.name), row.sync_id);
    }
  }

  const parentById = new Map<string, string>();
  const childrenByParent = new Map<string, string[]>();

  for (const row of rows) {
    let parentId = row.parent_sync_id && byId.has(row.parent_sync_id)
      ? row.parent_sync_id
      : null;

    if (!parentId && row.parent_name) {
      parentId = topLevelByName.get(nameKey(row.kind, row.parent_name)) ?? null;
    }

    if (!parentId || parentId === row.sync_id) continue;
    parentById.set(row.sync_id, parentId);
    const children = childrenByParent.get(parentId) ?? [];
    children.push(row.sync_id);
    childrenByParent.set(parentId, children);
  }

  return { byId, parentById, childrenByParent };
}

export async function loadCategoryHierarchy(
  db: D1Database,
  userId: string,
): Promise<CategoryHierarchy> {
  const rows = await db.prepare(
    `SELECT sync_id, name, kind, level, parent_name, parent_sync_id
     FROM user_category_projection
     WHERE user_id = ?`,
  ).bind(userId).all<CategoryHierarchyNode>();

  return buildCategoryHierarchy(rows.results);
}

/** Selected parent category means self + all descendants; selected child means itself.
 * The traversal is recursive even though BeeCount currently exposes two levels. */
export function categorySubtreeIds(hierarchy: CategoryHierarchy, categorySyncId: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [categorySyncId];

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    for (const childId of hierarchy.childrenByParent.get(id) ?? []) {
      queue.push(childId);
    }
  }

  return out;
}

/** Resolve a transaction's category to the highest known parent for reporting. */
export function categoryRoot(
  hierarchy: CategoryHierarchy,
  categorySyncId: string | null | undefined,
): CategoryHierarchyNode | null {
  if (!categorySyncId) return null;
  let currentId = categorySyncId;
  const seen = new Set<string>();

  while (!seen.has(currentId)) {
    seen.add(currentId);
    const parentId = hierarchy.parentById.get(currentId);
    if (!parentId) break;
    currentId = parentId;
  }

  return hierarchy.byId.get(currentId) ?? hierarchy.byId.get(categorySyncId) ?? null;
}

/** Resolve exact category names to their full subtrees, preserving the old exact-name API
 * while making a top-level category behave as the aggregate category users see in the UI. */
export function categoryIdsByExactName(hierarchy: CategoryHierarchy, name: string): string[] {
  const ids = new Set<string>();
  for (const row of hierarchy.byId.values()) {
    if (row.name !== name) continue;
    for (const id of categorySubtreeIds(hierarchy, row.sync_id)) ids.add(id);
  }
  return [...ids];
}
