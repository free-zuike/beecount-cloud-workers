/**
 * 分类图标解析 —— Flutter `getCategoryIconByName` 的 TS 复刻。
 * 逐字对齐原版 Python services/category_icon.py（顺序严格照搬，先匹配胜出）。
 * 上游当前仅在单测中使用（alembic backfill 属 Python 内部），本地同构实现该纯函数。
 */

// Flutter `CategoryService.getCategoryIcon` 的 case-return 不一致条目：stored 值
// 自身不是 Material Symbols 名，要转成 Flutter 渲染用的 Icons 名再给字体。
export const FLUTTER_RENAMES: Record<string, string> = {
  boat: 'directions_boat',
  compass: 'explore',
  energy_savings_leaf: 'eco',
  euro: 'euro_symbol',
  face_retouching: 'face',
  money: 'attach_money',
  oil_barrel: 'propane_tank',
  part_time: 'schedule',
  real_estate_agent: 'home_work',
  yen: 'currency_yen',
};

/** 按分类名字模糊匹配推导图标（Material Symbols ligature 名，已剥 `_outlined` 后缀）。
 *  空 name 或都不命中 → 返回 `circle`（跟 Flutter 的 `Icons.circle_outlined` 默认分支一致）。 */
export function resolveIconByName(name: string | null | undefined): string {
  if (!name) return 'circle';
  const n = name;

  // 餐饮
  if (['餐', '饭', '吃', '外卖'].some(kw => n.includes(kw))) return 'restaurant';

  // 交通出行
  if (n.includes('打车')) return 'local_taxi';
  if (n.includes('地铁')) return 'subway';
  if (n.includes('公交')) return 'directions_bus';
  if (n.includes('高铁') || n.includes('火车')) return 'train';
  if (n.includes('飞机')) return 'flight';
  if (n.includes('交通') || n.includes('出行')) return 'directions_transit';

  // 车辆（未被上面交通覆盖的"车/车辆/车贷/购车/爱车"）
  if (n === '车' || ['车辆', '车贷', '购车', '爱车'].some(kw => n.includes(kw))) return 'directions_car';

  // 购物
  if (['购物', '百货', '网购', '淘宝', '京东'].some(kw => n.includes(kw))) return 'shopping_bag';

  // 社交
  if (['社交', '聚会', '朋友', '聚餐'].some(kw => n.includes(kw))) return 'groups';

  // 服饰
  if (n.includes('服饰') || ['衣', '鞋', '裤', '帽'].some(kw => n.includes(kw))) return 'checkroom';

  // 超市/食材
  if (['超市', '生鲜', '菜', '粮油', '蔬菜', '水果'].some(kw => n.includes(kw))) return 'local_grocery_store';

  // 娱乐
  if (['娱乐', '游戏', '电影', '影院'].some(kw => n.includes(kw))) return 'sports_esports';

  // 家庭（先于居家规则——原 Flutter 顺序就这样，"家庭"命中后不再进后面的"居家/家/家居/物业/维修"）
  if (['家庭', '家人', '家属'].some(kw => n.includes(kw))) return 'family_restroom';

  // 居家 / 物业 / 维修 —— 会拦截"家"这一广泛字符
  if (['居家', '家', '家居', '物业', '维修'].some(kw => n.includes(kw))) return 'chair';

  // 美容美妆
  if (['美妆', '化妆', '护肤', '美容'].some(kw => n.includes(kw))) return 'brush';

  // 通讯
  if (['通讯', '话费', '宽带', '流量'].some(kw => n.includes(kw))) return 'network_cell';

  // 订阅
  if (['订阅', '会员', '流媒体'].some(kw => n.includes(kw))) return 'subscriptions';

  // 礼物/红包
  if (['礼物', '红包', '礼金', '请客', '人情'].some(kw => n.includes(kw))) return 'card_giftcard';

  // 水电燃气
  if (['水', '电', '煤', '燃气'].some(kw => n.includes(kw))) return 'water_drop';

  // 房贷/贷款
  if (['房贷', '按揭', '贷款', '信用卡'].some(kw => n.includes(kw))) return 'account_balance';

  // 住房（排在房贷后面，"房贷"被前面抢走）
  if (['住房', '房租', '房', '租'].some(kw => n.includes(kw))) return 'home';

  // 工资/收入
  if (['工资', '收入', '奖金', '报销', '兼职', '转账'].some(kw => n.includes(kw))) return 'attach_money';

  // 理财/退款 —— "退款"在这里被匹配到 savings（跟 Flutter 行为一致，照搬）
  if (['理财', '利息', '基金', '股票', '退款'].some(kw => n.includes(kw))) return 'savings';

  // 教育
  if (['教育', '学习', '培训', '书'].some(kw => n.includes(kw))) return 'menu_book';

  // 医疗
  if (['医疗', '医院', '药', '体检'].some(kw => n.includes(kw))) return 'medical_services';

  // 宠物
  if (n.includes('宠物') || n.includes('猫') || n.includes('狗')) return 'pets';

  // 运动
  if (['运动', '健身', '球', '跑步'].some(kw => n.includes(kw))) return 'fitness_center';

  // 数码
  if (['数码', '电子', '手机', '电脑'].some(kw => n.includes(kw))) return 'devices_other';

  // 旅行
  if (['旅行', '旅游', '出差', '机票'].some(kw => n.includes(kw))) return 'card_travel';

  // 酒店
  if (['酒店', '住宿', '民宿'].some(kw => n.includes(kw))) return 'hotel';

  // 烟酒茶
  if (['烟', '酒', '茶'].some(kw => n.includes(kw))) return 'local_bar';

  // 母婴
  if (['母婴', '孩子', '奶粉'].some(kw => n.includes(kw))) return 'child_friendly';

  // 停车
  if (n.includes('停车')) return 'local_parking';
  if (n.includes('加油')) return 'local_gas_station';

  // 保养/维修（"居家/维修"规则会先抢"维修"，到这里主要是"保养"）
  if (n.includes('保养') || n.includes('维修')) return 'build';

  // 汽车（跟前面"车/车辆"规则互补）
  if (n.includes('汽车') || n.includes('车辆') || n === '车') return 'directions_car';

  // 过路费
  if (n.includes('过路费') || n.includes('过桥费')) return 'alt_route';

  // 快递
  if (n.includes('快递') || n.includes('邮寄')) return 'local_shipping';

  // 税/社保/公积金/罚款
  if (['税', '社保', '公积金', '罚款'].some(kw => n.includes(kw))) return 'receipt_long';

  // 捐赠
  if (n.includes('捐赠') || n.includes('公益')) return 'volunteer_activism';

  // 工作
  if (['工作', '办公', '出差', '职场', '会议'].some(kw => n.includes(kw))) return 'work';

  return 'circle';
}

/** 给定 DB 存的 icon + 分类 name，返回最终要填/渲染的 icon 值：
 *  1. stored_icon 非空 → 直接返回（不碰）
 *  2. stored_icon 空 + name 非空 → byName 推导
 *  3. 都空 → `circle`（跟 Flutter 默认分支一致） */
export function resolveCategoryIcon(
  storedIcon: string | null | undefined,
  categoryName: string | null | undefined,
): string {
  if (storedIcon && storedIcon.trim()) return storedIcon.trim();
  return resolveIconByName(categoryName);
}

/** 判断某条 category 是否需要走 byName backfill —— 即 icon 字段**空**。
 *  注意：`'category'` 字符串**不视为**需要 backfill（Flutter category_edit_page 的初始默认值）。 */
export function needsBackfill(storedIcon: string | null | undefined): boolean {
  return storedIcon === null || storedIcon === undefined || storedIcon.trim() === '';
}