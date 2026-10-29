/**
 * 运行时差分测试：本地实现 vs 上游 Python 实现的 golden 输出。
 *
 * golden 由 `npm run parity:dump` 在**有 Python 的上游环境**生成
 * （见 scripts/parity/upstream_dump.py；两侧夹具必须一一对应）。
 * 文件不存在时本测试 skip，并打印生成命令 —— 不会假装通过。
 *
 * 为什么需要它：代码级人工核对有漏检（本项目已发生两次：第 22 批误删 plan_id、
 * 第 64 批把两套注解公式混成一套）。这条测试用"同一份数据、同一组参数、比完整 JSON"
 * 来给出不依赖人读的结论。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addMember, createLedger, makeHarness, mcpCtx, registerUser, type Harness } from './mcp-harness';
import { diffJson, formatDiffs, normalize, type Json } from './parity-compare';
import {
  getAnalyticsSummary, getLedgerStats, getTransaction, listAccounts, listBudgets,
  listCategories, listTags, listTransactions, search,
} from '../src/mcp/tools/read-tools';

const GOLDEN_PATH = join(process.cwd(), 'tests/fixtures/upstream-golden.json');

interface GoldenCase { tool: string; args: Record<string, unknown>; result?: Json; error?: string }
interface Golden { now: string; cases: GoldenCase[] }

/**
 * 按表结构插入（PRAGMA 过滤掉该表不存在的列），避免测试与 schema 漂移耦合。
 */
function insertRow(sqlite: import('node:sqlite').DatabaseSync, table: string, row: Record<string, unknown>): void {
  const cols = (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name);
  const keys = Object.keys(row).filter(k => cols.includes(k));
  if (keys.length === 0) return;
  const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
  sqlite.prepare(sql).run(...keys.map(k => row[k] as never));
}

/** 与 upstream_dump.py 完全对应的夹具 */
function seed(h: Harness): void {
  registerUser(h, 'u1', 'u1@example.com');
  registerUser(h, 'u2', 'u2@example.com');
  createLedger(h, 'u1', 'L1-i', 'L1', '主账本', 'CNY');
  // L2 属于 u2，u1 是 editor（共享账本可见性）
  insertRow(h.sqlite, 'ledgers', {
    id: 'L2-i', external_id: 'L2', user_id: 'u2', name: '共享账本', currency: 'USD',
    month_start_day: 1, created_at: '2026-05-20T04:00:00Z', deleted_at: null,
  });
  addMember(h, 'L1-i', 'u1', 'owner');
  addMember(h, 'L2-i', 'u1', 'editor');
  addMember(h, 'L2-i', 'u2', 'owner');

  for (const c of [
    { sync_id: 'c1', name: '餐饮', kind: 'expense', sort_order: 1, icon: '🍜' },
    { sync_id: 'c2', name: '工资', kind: 'income', sort_order: 2 },
  ]) {
    insertRow(h.sqlite, 'user_category_projection', {
      ...c, user_id: 'u1', ledger_id: 'L1-i', parent_sync_id: null, last_change_id: 1,
    });
  }
  // 本地 D1 的 hidden 是 NOT NULL DEFAULT 0（显式 NULL 会被拒），上游可空。
  // 夹具统一用 0，两侧都可表示；null 语义由 capability-tools 的单测覆盖。
  for (const a of [
    { sync_id: 'a1', name: '现金', account_type: 'cash', currency: 'CNY', hidden: 0 },
    { sync_id: 'a2', name: '招行', account_type: 'bank', currency: 'CNY', hidden: 0 },
  ]) {
    insertRow(h.sqlite, 'user_account_projection', {
      ...a, user_id: 'u1', ledger_id: 'L1-i', note: null, last_change_id: 1,
    });
  }
  insertRow(h.sqlite, 'user_tag_projection', {
    sync_id: 'g1', user_id: 'u1', ledger_id: 'L1-i', name: '出差', color: '#00bcf2', last_change_id: 1,
  });
  insertRow(h.sqlite, 'user_tag_projection', {
    sync_id: 'g2', user_id: 'u1', ledger_id: 'L1-i', name: '客户', color: '#ff9800', last_change_id: 1,
  });

  const txs = [
    ['t1', 'expense', 38, '2026-05-02T03:30:00Z', 'c1', 'a1', '星巴克', null, 'CNY', null],
    ['t2', 'expense', 12.5, '2026-05-02T03:30:00Z', 'c1', 'a1', '同秒第二笔', null, 'CNY', null],
    ['t3', 'income', 8000, '2026-05-10T02:30:00Z', 'c2', 'a2', null, null, 'CNY', null],
    ['t4', 'expense', 100, '2026-05-11T02:30:00Z', 'c1', 'a1', null, null, 'CNY', null],
    ['t5', 'expense', 20, '2026-05-12T02:30:00Z', 'c1', 'a1', null, null, 'CNY', null],
    ['t6', 'expense', 7.5, '2026-05-13T02:30:00Z', null, 'a1', null, null, 'USD', 1.03],
    ['t7', 'expense', 30, '2026-05-14T02:30:00Z', 'c1', 'a1', null, '出差,客户', 'CNY', null],
  ] as const;
  for (const [sync, kind, amount, happened, cat, acc, note, tags, cur, native] of txs) {
    insertRow(h.sqlite, 'read_tx_projection', {
      sync_id: sync, user_id: 'u1', ledger_id: 'L1-i', tx_type: kind, amount,
      happened_at: happened, category_sync_id: cat, account_sync_id: acc,
      category_name: cat === 'c1' ? '餐饮' : cat === 'c2' ? '工资' : null,
      account_name: acc === 'a1' ? '现金' : acc === 'a2' ? '招行' : null,
      note, tags_csv: tags, currency_code: cur, native_amount: native,
      from_account_id: null, to_account_id: null, from_account_name: null, to_account_name: null,
      exclude_from_stats: sync === 't4' ? 1 : 0,
      exclude_from_budget: sync === 't5' ? 1 : 0,
      source_change_id: 1, created_by_user_id: 'u1', created_at: happened, updated_at: happened,
      tags_sync_ids_json: null, tag_sync_ids_json: null,
    });
  }
}

const TOOL_FNS: Record<string, (c: ReturnType<typeof mcpCtx>, args: Record<string, unknown>) => Promise<unknown>> = {
  list_transactions: listTransactions as never,
  get_transaction: getTransaction as never,
  list_categories: listCategories as never,
  list_accounts: listAccounts as never,
  list_tags: listTags as never,
  list_budgets: listBudgets as never,
  get_ledger_stats: getLedgerStats as never,
  get_analytics_summary: getAnalyticsSummary as never,
  search: search as never,
};

/**
 * 上游这些工具**没有 ORDER BY**，顺序由数据库决定、不是契约；本地为了结果稳定
 * 显式排了序。这里按"多重集合"比较（两侧先按规范 JSON 排序），只忽略顺序，
 * 元素内容与数量仍然逐字段严格比对。
 */
const ORDER_UNDEFINED = new Set(['list_categories', 'list_accounts', 'list_tags', 'list_budgets']);

function sortTop(value: Json): Json {
  if (!Array.isArray(value)) return value;
  const key = (v: Json) => JSON.stringify(v);
  return [...value].sort((a, b) => key(a).localeCompare(key(b)));
}

const hasGolden = existsSync(GOLDEN_PATH);

/**
 * 比对器自检：证明它抓得住真差异（包括"值是 0 而不是 null"这种最容易漏的）。
 * 这段不依赖 golden，永远执行。
 */
describe('差分比对器自检', () => {
  it('完全相同的对象 0 差异', () => {
    expect(diffJson({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] })).toEqual([]);
  });

  it('抓得住 0 与 null 的差别', () => {
    const diffs = diffJson({ total: 0 }, { total: null });
    expect(diffs).toHaveLength(1);
    expect(diffs[0].reason).toBe('type');
  });

  it('抓得住缺少字段与多出字段', () => {
    const missing = diffJson({ a: 1, b: 2 }, { a: 1 });
    expect(missing[0].reason).toBe('missing-in-local');
    const extra = diffJson({ a: 1 }, { a: 1, b: 2 });
    expect(extra[0].reason).toBe('missing-in-upstream');
  });

  it('抓得住数组长度与元素顺序差异', () => {
    expect(diffJson([1, 2], [1])[0].path).toBe('$.length');
    expect(diffJson([1, 2], [2, 1])).not.toEqual([]);
  });

  it('抓得住浮点精度差异（不做四舍五入）', () => {
    expect(diffJson({ amount: 38 }, { amount: 38.000001 })).toHaveLength(1);
  });

  it('易变字段被规范化掉', () => {
    expect(normalize({ revision: 3, amount: 1 })).toEqual({ amount: 1 });
  });
});

describe.skipIf(!hasGolden)('MCP 运行时差分（对上游 golden）', () => {
  it('只读工具输出与上游逐字段一致', async () => {
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Golden;
    const h = makeHarness();
    seed(h);
    const c = mcpCtx(h, 'u1');
    c.configuredTimeZone = 'Asia/Shanghai';

    const failures: string[] = [];
    for (const kase of golden.cases) {
      const fn = TOOL_FNS[kase.tool];
      if (!fn) { failures.push(`[${kase.tool}] 本地未实现该工具`); continue; }
      let local: Json;
      try {
        local = normalize(JSON.parse(JSON.stringify(await fn(c, kase.args))) as Json);
      } catch (err) {
        // 上游报错时本地必须报错；上游成功时本地报错算差异
        if (kase.error) continue;
        failures.push(`[${kase.tool}] 本地抛错而上游成功: ${(err as Error).message}`);
        continue;
      }
      if (kase.error) {
        failures.push(`[${kase.tool}] 上游报错(${kase.error})而本地成功`);
        continue;
      }
      const unordered = ORDER_UNDEFINED.has(kase.tool);
      const upstream = normalize(kase.result as Json);
      const left = unordered ? sortTop(upstream) : upstream;
      const right = unordered ? sortTop(local) : local;
      const diffs = diffJson(left, right);
      if (diffs.length) failures.push(formatDiffs(kase.tool, diffs));
    }
    expect(failures.join('\n')).toBe('');
  });
});

describe.skipIf(hasGolden)('MCP 运行时差分（待生成 golden）', () => {
  it('提示如何生成 golden', () => {
    // 这条不是"通过"，是显式告知：差分尚未生效
    console.warn(
      '\n[parity] tests/fixtures/upstream-golden.json 不存在，运行时差分未生效。\n'
      + '        在装有上游依赖的 Python 环境执行：npm run parity:dump\n',
    );
    expect(hasGolden).toBe(false);
  });
});
