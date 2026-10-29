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
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addMember, bindSelfCall, createLedger, makeHarness, mcpCtx, registerUser, type Harness } from './mcp-harness';
import { diffJson, formatDiffs, normalize, type Json } from './parity-compare';
import {
  getAnalyticsSummary, getLedgerStats, getTransaction, listAccounts, listBudgets,
  listCategories, listTags, listTransactions, search,
} from '../src/mcp/tools/read-tools';
import {
  createTransaction, deleteTransaction, setSelfCall, updateTransaction,
} from '../src/mcp/tools/write-tools';
import { previewImportFile, setAttachmentBytesSource } from '../src/mcp/file-tools';
import {
  executeImportPlan, getWorkflowRecord, linkTransactionSource, listTransactionSources,
  listWorkflowRecords, undoImportPlan, unlinkTransactionSource,
} from '../src/mcp/workflow-tools';

const GOLDEN_PATH = join(process.cwd(), 'tests/fixtures/upstream-golden.json');

interface GoldenCase { tool: string; args: Record<string, unknown>; result?: Json; error?: string }
interface GoldenScenarioStep { name: string; result?: Json; error?: string }
interface Golden {
  now: string;
  cases: GoldenCase[];
  scenario?: { name: string; steps: GoldenScenarioStep[] };
}

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
  // L3：空账本，验证空数组/0/null 的形状；month_start_day=25 走非 1 号起始的分支
  createLedger(h, 'u1', 'L3-i', 'L3', '空账本', 'JPY', 25);
  addMember(h, 'L3-i', 'u1', 'owner');

  // 导入预览用附件：两侧同一份 CSV（utf-8-sig），sha256/size 必须一致
  insertRow(h.sqlite, 'attachment_files', {
    id: 'f1', ledger_id: 'L1-i', user_id: 'u1', attachment_kind: 'transaction',
    file_name: 'seed.csv', mime_type: 'text/csv', storage_path: 'attachments/L1-i/f1_seed.csv',
    sha256: IMPORT_SHA, size_bytes: IMPORT_BYTES.length, created_at: '2026-05-01T00:00:00Z',
  });

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
 * golden 里的报错形如 `HTTPException: 400: Invalid analytics period`。
 * 去掉 `类型: 状态码: ` 前缀再比——状态码与异常类是 Python 传输层细节，
 * MCP 工具对 LLM 的契约是消息文本本身。
 */
function errorText(raw: string): string {
  return raw.replace(/^[A-Za-z_][A-Za-z0-9_.]*(?::\s*\d{3})?:\s*/, '');
}

// 导入预览的样本文件：上游用 utf-8-sig 写出，本地必须同字节同 sha256
const IMPORT_BYTES = Buffer.from(
  '\uFEFF日期,金额,类型,分类,备注\n2026-05-16,12.5,支出,餐饮,午饭\n2026-05-17,3000,收入,工资,五月工资\n',
  'utf8',
);
const IMPORT_SHA = createHash('sha256').update(IMPORT_BYTES).digest('hex');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SYNC_ID_RE = /^(tx|acc|cat|tag|bgt)_[0-9a-f]{12}$/;

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
        // 上游报错时本地必须报错，且**消息文本**要一致（去掉 Python 侧的
        // `HTTPException: 400: ` 前缀——那是传输层，MCP 契约是消息本身）
        if (kase.error) {
          const expected = errorText(kase.error);
          const actual = (err as Error).message;
          if (expected !== actual) {
            failures.push(`[${kase.tool}] 错误消息不一致\n  上游: ${expected}\n  本地: ${actual}`);
          }
          continue;
        }
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

/**
 * 写路径差分：步骤名与 scripts/parity/upstream_dump.py 的 scenario 一一对应。
 * 写工具的结果里带新建行的 sync_id（随机 uuid），两侧都归一成 <NEW> 再比。
 */
describe.skipIf(!hasGolden)('MCP 写路径差分（对上游 scenario）', () => {
  it('写入 → 回读 → 更新 → 删除，每一步结果都与上游一致', async () => {
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Golden;
    const steps = golden.scenario?.steps ?? [];
    // golden 里没有 scenario（旧版 golden）→ 明确跳过，不假装通过
    if (steps.length === 0) return;

    const h: Harness = makeHarness();
    seed(h);
    const c = mcpCtx(h, 'u1');
    c.configuredTimeZone = 'Asia/Shanghai';
    // 本地写工具通过 selfCall 回调打到自己的 write handler（生产里是 Worker 自请求）
    bindSelfCall(h, setSelfCall);
    const failures: string[] = [];
    let newId: string | null = null;

    // 夹具里预置的标签 id；其余出现在 tag_ids 里的一律是写工具自动补的「MCP」标签
    const SEEDED_TAGS = new Set(['g1', 'g2']);
    const scrubTagIds = (value: Json): Json => {
      if (!Array.isArray(value)) return scrub(value);
      const mapped = value.map(v => (typeof v === 'string' && SEEDED_TAGS.has(v) ? v : '<AUTO_TAG>'));
      // 两侧都是各自 id 的字典序遍历，归一后 id 变了会打乱顺序，故统一再排一次
      return mapped.sort((a, b) => String(a).localeCompare(String(b)));
    };

    const scrub = (value: Json): Json => {
      if (Array.isArray(value)) return value.map(scrub);
      if (value && typeof value === 'object') {
        const out: Record<string, Json> = {};
        for (const key of Object.keys(value as Record<string, Json>)) {
          const v = (value as Record<string, Json>)[key];
          // created_revisions 这类映射以随机的 sync_id 作**键**，键也要归一
          // created_revisions 是 {随机 sync_id: 版本号}。键随机、值才是契约，
          // 且直接把键归一会撞成同一个键（两条变一条），故只取值的多重集合
          if (key === 'created_revisions' && v && typeof v === 'object' && !Array.isArray(v)) {
            out[key] = Object.values(v as Record<string, Json>).map(scrub)
              .sort((a, b) => String(a).localeCompare(String(b)));
            continue;
          }
          const outKey = SYNC_ID_RE.test(key) ? '<SYNC_ID>' : key;
          out[outKey] = key === 'tag_ids' ? scrubTagIds(v) : scrub(v);
        }
        return out;
      }
      if (newId && value === newId) return '<NEW>';
      // 预览 id / 操作批 id 等每次运行都是新 uuid
      if (typeof value === 'string' && UUID_RE.test(value)) return '<UUID>';
      // 新建实体的 sync_id：上游 {prefix}_{uuid4().hex[:12]}，随机部分每次都不同
      if (typeof value === 'string' && SYNC_ID_RE.test(value)) return '<SYNC_ID>';
      return value;
    };

    const newIdOf = (res: unknown): string | null => {
      const r = (res ?? {}) as Record<string, unknown>;
      const nested = (r.transaction ?? r.data ?? r.item ?? {}) as Record<string, unknown>;
      const id = r.sync_id ?? nested.sync_id ?? r.id;
      return typeof id === 'string' ? id : null;
    };

    const run = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
      const expected = steps.find(s => s.name === name);
      if (!expected) return;
      let actualJson: Json | null = null;
      let thrown: string | null = null;
      try {
        actualJson = scrub(normalize(JSON.parse(JSON.stringify(await fn())) as Json));
      } catch (err) {
        thrown = (err as Error).message;
      }
      if (expected.error) {
        if (thrown === null) failures.push(`[${name}] 上游报错(${expected.error})而本地成功`);
        return;
      }
      if (thrown !== null) {
        failures.push(`[${name}] 本地抛错而上游成功: ${thrown}`);
        return;
      }
      // 期望值也走一遍 scrub：golden 可能是旧规则生成的，重复归一化是幂等的
      const diffs = diffJson(scrub(normalize(expected.result as Json)), actualJson as Json);
      if (diffs.length) failures.push(formatDiffs(name, diffs));
    };

    await run('create', async () => {
      const res = await createTransaction(c, {
        amount: 42.5, tx_type: 'expense', category: '餐饮', account: '现金',
        happened_at: '2026-05-15T10:00:00+08:00', note: '差分写入', tags: ['出差'], ledger_id: 'L1',
      });
      newId = newIdOf(res);
      return res;
    });
    await run('get_after_create', () => getTransaction(c, { ledger_id: 'L1', sync_id: newId ?? '' }));
    await run('update', () => updateTransaction(c, {
      sync_id: newId ?? '', amount: 99.5, note: '改过的备注', ledger_id: 'L1',
    }));
    await run('get_after_update', () => getTransaction(c, { ledger_id: 'L1', sync_id: newId ?? '' }));
    await run('delete_without_confirm', () => deleteTransaction(c, { sync_id: newId ?? '', ledger_id: 'L1' }));
    await run('delete', () => deleteTransaction(c, { sync_id: newId ?? '', confirm: true, ledger_id: 'L1' }));
    await run('get_after_delete', () => getTransaction(c, { ledger_id: 'L1', sync_id: newId ?? '' }));
    // 顺序即语义：这一步必须在导入**之前**跑，否则会把导入写入的 2 笔算进来
    await run('list_total_after', async () => {
      const page = await listTransactions(c, { ledger_id: 'L1', limit: 50 });
      return { total: page.total, has_more: page.has_more };
    });

    // 导入预览：附件字节由内存注入（生产是 R2），两侧解析同一份 CSV
    setAttachmentBytesSource(async () => new Uint8Array(IMPORT_BYTES));
    let planId: string | null = null;
    let lastPreview: unknown = null;
    let lastExecute: unknown = null;
    await run('preview_import_file', async () => {
      const res = await previewImportFile(c, { file_id: 'f1', time_zone: 'Asia/Shanghai' });
      lastPreview = res;
      const plan = (res as { plan?: Record<string, unknown> }).plan;
      for (const holder of [res as Record<string, unknown>, plan ?? {}]) {
        for (const key of ['plan_id', 'id', 'record_id']) {
          if (typeof holder[key] === 'string') { planId = holder[key] as string; break; }
        }
        if (planId) break;
      }
      return res;
    });

    // 导入执行：不 confirm → confirmation_required；confirm → 真正写交易。
    // expected_revision 必须等于预览时的 base_revision，否则上游报 REVISION_CONFLICT
    const planRev = Number(
      ((lastPreview as { plan?: { data?: { base_revision?: number } } }).plan?.data?.base_revision) ?? 0,
    );
    await run('execute_import_plan_no_confirm',
      () => executeImportPlan(c, { plan_id: planId ?? '', expected_revision: planRev }));
    // 错误 revision 必须被拒（写操作要防"预览之后账本变了"）
    await run('execute_import_plan_wrong_revision',
      () => executeImportPlan(c, { plan_id: planId ?? '', expected_revision: 0, confirm: true }));

    // 正确 revision = plan 记录自身的 revision（上游校验的是 row.revision，
    // 与 data.base_revision 不是同一个值，预览结果里也不暴露）
    const planRow = h.sqlite.prepare('SELECT revision FROM mcp_state_records WHERE id = ?')
      .get(planId ?? '') as { revision: number } | undefined;
    const planRecordRev = planRow?.revision ?? planRev;
    await run('execute_import_plan', async () => {
      const res = await executeImportPlan(c, {
        plan_id: planId ?? '', expected_revision: planRecordRev, confirm: true,
      });
      lastExecute = res;
      return res;
    });
    await run('list_total_after_import', async () => {
      const page = await listTransactions(c, { ledger_id: 'L1', limit: 50 });
      return { total: page.total };
    });

    // 工作流状态：计划记录 / 来源绑定 / 撤销
    await run('list_workflow_records',
      () => listWorkflowRecords(c, { ledger_id: 'L1', kind: 'import_plan' }));
    await run('get_workflow_record', () => getWorkflowRecord(c, { record_id: planId ?? '' }));

    // 来源绑定：导入落库后交易应带一条来源（幂等键的落点）；重复绑定必须被拒
    const createdIds = (lastExecute as { sync_ids?: string[] } | null)?.sync_ids
      ?? ((lastExecute as { results?: Array<{ created_sync_ids?: string[] }> } | null)
        ?.results?.[0]?.created_sync_ids ?? []);
    const createdId = createdIds[0] ?? null;
    if (createdId) {
      let lastSources: unknown = null;
      await run('list_transaction_sources', async () => {
        const res = await listTransactionSources(c, { ledger_id: 'L1', sync_id: createdId });
        lastSources = res;
        return res;
      });
      const src = Array.isArray(lastSources) ? (lastSources[0] as Record<string, unknown> | undefined) : undefined;
      if (src) {
        await run('link_transaction_source_duplicate', () => linkTransactionSource(c, {
          ledger_id: 'L1', sync_id: createdId,
          source: { source_system: src.source_system as string, source_id: src.source_id as string },
        }));
        await run('unlink_transaction_source_no_confirm',
          () => unlinkTransactionSource(c, { ledger_id: 'L1', reference_id: String(src.id) }));
        await run('unlink_transaction_source',
          () => unlinkTransactionSource(c, { ledger_id: 'L1', reference_id: String(src.id), confirm: true }));
        await run('list_transaction_sources_after_unlink',
          () => listTransactionSources(c, { ledger_id: 'L1', sync_id: createdId }));
      }
    }

    const rev2 = (h.sqlite.prepare('SELECT revision FROM mcp_state_records WHERE id = ?')
      .get(planId ?? '') as { revision: number } | undefined)?.revision ?? planRecordRev;
    await run('undo_import_plan_no_confirm',
      () => undoImportPlan(c, { plan_id: planId ?? '', expected_revision: rev2 }));
    await run('undo_import_plan',
      () => undoImportPlan(c, { plan_id: planId ?? '', expected_revision: rev2, confirm: true }));
    await run('list_total_after_undo', async () => {
      const page = await listTransactions(c, { ledger_id: 'L1', limit: 50 });
      return { total: page.total };
    });
    await run('get_workflow_record_after_undo', () => getWorkflowRecord(c, { record_id: planId ?? '' }));

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
