// 移植上游 tests/test_category_icon_resolver.py：
// byName 图标解析 —— 锁定 Flutter getCategoryIconByName 的 1:1 行为
// （相同匹配顺序 + 相同输出）。
import { describe, expect, it } from 'vitest';
import { needsBackfill, resolveCategoryIcon, resolveIconByName } from '../src/services/category_icon';

describe('resolveIconByName（移植上游 test_by_name_rules）', () => {
  const cases: Array<[string, string]> = [
    // 用户反馈的具体 case —— 首屏必须对
    ['爱车养车', 'directions_car'],
    ['家居家装', 'chair'],
    ['母婴2', 'child_friendly'],
    ['退款', 'savings'],  // Flutter 故意把"退款"归到 savings，照搬
    // 常规规则
    ['餐饮', 'restaurant'],
    ['外卖', 'restaurant'],
    ['打车', 'local_taxi'],
    ['地铁', 'subway'],
    ['公交', 'directions_bus'],
    ['高铁', 'train'],
    ['火车', 'train'],
    ['飞机', 'flight'],
    ['出行', 'directions_transit'],
    ['车', 'directions_car'],
    ['购车', 'directions_car'],
    ['淘宝购物', 'shopping_bag'],
    ['聚会', 'groups'],
    ['衣服', 'checkroom'],
    ['超市', 'local_grocery_store'],
    ['水果', 'local_grocery_store'],
    ['电影', 'sports_esports'],
    ['家庭', 'family_restroom'],
    ['居家', 'chair'],
    ['物业', 'chair'],
    ['化妆', 'brush'],
    ['话费', 'network_cell'],
    ['订阅', 'subscriptions'],
    ['红包', 'card_giftcard'],
    ['水电', 'water_drop'],  // 含"水"/"电"
    ['房贷', 'account_balance'],
    ['工资', 'attach_money'],
    ['基金', 'savings'],
    ['教育', 'menu_book'],
    ['医院', 'medical_services'],
    ['宠物', 'pets'],
    ['健身', 'fitness_center'],
    ['手机', 'devices_other'],
    ['旅游', 'card_travel'],
    ['酒店', 'hotel'],
    ['烟酒', 'local_bar'],
    ['停车', 'local_parking'],
    ['加油', 'local_gas_station'],
    ['保养', 'build'],
    ['过路费', 'alt_route'],
    ['快递', 'local_shipping'],
    ['社保', 'receipt_long'],
    ['捐赠', 'volunteer_activism'],
    ['办公', 'work'],
    // 优先级 —— "聚会"规则(social/groups)排在"家庭"之前，所以"家庭聚会"走 groups
    ['家庭聚会', 'groups'],
    ['妈妈家庭', 'family_restroom'],
    // "居家"命中"家"字，抢在"住房"前
    ['住房家居', 'chair'],
    // 兜底
    ['', 'circle'],
    ['不知道是啥', 'circle'],
  ];
  for (const [name, expected] of cases) {
    it(`resolveIconByName(${JSON.stringify(name)}) == ${expected}`, () => {
      expect(resolveIconByName(name)).toBe(expected);
    });
  }
});

describe('resolveCategoryIcon priority（移植上游）', () => {
  it('stored icon 非空时直接透传，不走 byName', () => {
    expect(resolveCategoryIcon('build', '爱车养车')).toBe('build');
    expect(resolveCategoryIcon('  custom  ', '爱车养车')).toBe('custom');
    // 空 icon → 走 byName
    expect(resolveCategoryIcon(null, '爱车养车')).toBe('directions_car');
    expect(resolveCategoryIcon('', '爱车养车')).toBe('directions_car');
    expect(resolveCategoryIcon('   ', '爱车养车')).toBe('directions_car');
    // icon 和 name 都空 → circle
    expect(resolveCategoryIcon(null, null)).toBe('circle');
    expect(resolveCategoryIcon('', '')).toBe('circle');
  });
});

describe('needsBackfill（移植上游）', () => {
  it('空字符串 / 纯空格 / None 都需要 backfill，非空不需要', () => {
    expect(needsBackfill(null)).toBe(true);
    expect(needsBackfill('')).toBe(true);
    expect(needsBackfill('   ')).toBe(true);
    // 'category' 是 category_edit_page 的默认初值，不视为需要覆盖
    expect(needsBackfill('category')).toBe(false);
    expect(needsBackfill('build')).toBe(false);
    expect(needsBackfill('restaurant')).toBe(false);
  });
});