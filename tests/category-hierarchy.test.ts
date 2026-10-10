import { describe, expect, it } from 'vitest';
import {
  buildCategoryHierarchy,
  categoryIdsByExactName,
  categoryRoot,
  categorySubtreeIds,
} from '../src/lib/category-hierarchy';

describe('category hierarchy', () => {
  const hierarchy = buildCategoryHierarchy([
    { sync_id: 'food', name: '餐饮', kind: 'expense', level: 1, parent_name: null, parent_sync_id: null },
    { sync_id: 'lunch', name: '午餐', kind: 'expense', level: 2, parent_name: '餐饮', parent_sync_id: 'food' },
    { sync_id: 'dinner', name: '晚餐', kind: 'expense', level: 2, parent_name: '餐饮', parent_sync_id: null },
    { sync_id: 'other', name: '其他', kind: 'expense', level: 1, parent_name: null, parent_sync_id: null },
  ]);

  it('expands a parent to all descendants but keeps a child child-only', () => {
    expect(categorySubtreeIds(hierarchy, 'food').sort()).toEqual(['dinner', 'food', 'lunch']);
    expect(categorySubtreeIds(hierarchy, 'lunch')).toEqual(['lunch']);
  });

  it('rolls both modern parent ids and legacy parent names to the root', () => {
    expect(categoryRoot(hierarchy, 'lunch')?.name).toBe('餐饮');
    expect(categoryRoot(hierarchy, 'dinner')?.name).toBe('餐饮');
    expect(categoryRoot(hierarchy, 'other')?.name).toBe('其他');
  });

  it('treats an exact top-level name as the whole subtree', () => {
    expect(categoryIdsByExactName(hierarchy, '餐饮').sort()).toEqual(['dinner', 'food', 'lunch']);
    expect(categoryIdsByExactName(hierarchy, '午餐')).toEqual(['lunch']);
  });
});
