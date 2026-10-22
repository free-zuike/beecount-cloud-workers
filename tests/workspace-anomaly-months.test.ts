import { describe, expect, it } from 'vitest';
import { computeAnomalyMonths } from '../src/routes/workspace';

// 移植上游 tests/test_workspace_anomaly_months.py 全部 7 个纯函数用例:
// baseline=median(已发生月份);异常需 expense>baseline×1.2 且差>200;
// <3 月返回空;归因 top2(本月独有 category multiplier=null);
// 多异常按 diff 降序;expense=0 月不进 baseline。
type SeriesItem = { bucket: string; expense: number; income: number; balance: number };

function series(items: Array<[string, number]>): SeriesItem[] {
  return items.map(([bucket, exp]) => ({ bucket, expense: exp, income: 0, balance: -exp }));
}

describe('异常月份归因(移植上游 test_workspace_anomaly_months.py)', () => {
  it('已发生月份 < 3 → 返回空', () => {
    expect(computeAnomalyMonths(series([['2026-01', 500], ['2026-02', 1000]]), {})).toEqual([]);
  });

  it('所有月份接近 baseline → 无异常', () => {
    const s = series([['2026-01', 800], ['2026-02', 850], ['2026-03', 820], ['2026-04', 900]]);
    const cat = Object.fromEntries(s.map(x => [x.bucket, { 餐饮: x.expense }]));
    expect(computeAnomalyMonths(s, cat)).toEqual([]);
  });

  it('明显异常 + 归因 top2(本月独有分类 multiplier=null)', () => {
    const s = series([
      ['2026-01', 800], ['2026-02', 850], ['2026-03', 820], ['2026-04', 800], ['2026-05', 1923],
    ]);
    const cat = {
      '2026-01': { 餐饮: 600, 购物: 200 },
      '2026-02': { 餐饮: 650, 购物: 200 },
      '2026-03': { 餐饮: 620, 购物: 200 },
      '2026-04': { 餐饮: 600, 购物: 200 },
      '2026-05': { 餐饮: 700, 购物: 1000, 教育: 223 },
    };
    const out = computeAnomalyMonths(s, cat);
    expect(out.length).toBe(1);
    const a = out[0];
    expect(a.bucket).toBe('2026-05');
    expect(a.expense).toBe(1923);
    // median([800,850,820,800,1923]) = 820
    expect(a.baseline).toBe(820);
    expect(a.deviation_pct).toBeGreaterThan(1.3);
    const cats = a.top_attributions.map(att => att.category_name);
    expect(cats).toContain('购物');
    const edu = a.top_attributions.find(att => att.category_name === '教育');
    if (edu) {
      expect(edu.median_others).toBe(0);
      expect(edu.multiplier).toBeNull();
    }
  });

  it('绝对差够但未超 1.2× → 不算异常', () => {
    const s = series([['2026-01', 5000], ['2026-02', 5000], ['2026-03', 5000], ['2026-04', 5800]]);
    expect(computeAnomalyMonths(s, {})).toEqual([]);
  });

  it('超 1.2× 但绝对差 <= 200 → 不算异常', () => {
    const s = series([['2026-01', 100], ['2026-02', 100], ['2026-03', 100], ['2026-04', 180]]);
    expect(computeAnomalyMonths(s, {})).toEqual([]);
  });

  it('本月独有 category → multiplier=null', () => {
    const s = series([['2026-01', 500], ['2026-02', 500], ['2026-03', 500], ['2026-04', 1500]]);
    const cat = {
      '2026-01': { 餐饮: 500 },
      '2026-02': { 餐饮: 500 },
      '2026-03': { 餐饮: 500 },
      '2026-04': { 餐饮: 500, 装修: 1000 },
    };
    const out = computeAnomalyMonths(s, cat);
    expect(out.length).toBe(1);
    const decor = out[0].top_attributions.find(att => att.category_name === '装修');
    expect(decor).toBeTruthy();
    expect(decor!.amount).toBe(1000);
    expect(decor!.median_others).toBe(0);
    expect(decor!.multiplier).toBeNull();
  });

  it('多个异常按 diff 降序', () => {
    const s = series([
      ['2026-01', 500], ['2026-02', 500], ['2026-03', 500], ['2026-04', 1200], ['2026-05', 2000],
    ]);
    const cat = Object.fromEntries(s.map(x => [x.bucket, { X: x.expense }]));
    const out = computeAnomalyMonths(s, cat);
    expect(out.length).toBe(2);
    expect(out[0].bucket).toBe('2026-05');
    expect(out[1].bucket).toBe('2026-04');
  });

  it('expense=0 的未发生月不参与 baseline', () => {
    const s = series([
      ['2026-01', 800], ['2026-02', 0], ['2026-03', 800], ['2026-04', 0], ['2026-05', 850], ['2026-06', 1500],
    ]);
    const cat = {
      '2026-01': { X: 800 },
      '2026-03': { X: 800 },
      '2026-05': { X: 850 },
      '2026-06': { X: 1500 },
    };
    const out = computeAnomalyMonths(s, cat);
    expect(out.length).toBe(1);
    expect(out[0].bucket).toBe('2026-06');
    // median([800,800,850,1500]) = (800+850)/2 = 825
    expect(out[0].baseline).toBe(825);
  });
});