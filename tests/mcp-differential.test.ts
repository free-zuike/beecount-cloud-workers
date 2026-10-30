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
import { bindSelfCall, IMPORT_BYTES, IMPORT_SHA, makeHarness, mcpCtx, seed, type Harness } from './mcp-harness';
import { diffJson, formatDiffs, normalize, type Json } from './parity-compare';
import {
  getActiveLedger, getAnalyticsSummary, getLedgerStats, getTransaction, listAccounts,
  listBudgets, listCategories, listLedgers, listTags, listTransactions, search,
} from '../src/mcp/tools/read-tools';
import { listAttachments } from '../src/mcp/file-tools';
import { getAccountBalances } from '../src/mcp/capability-tools';
import {
  createTransaction, deleteTransaction, setSelfCall, updateTransaction,
} from '../src/mcp/tools/write-tools';
import { previewImportFile, setAttachmentBytesSource } from '../src/mcp/file-tools';
import {
  executeImportPlan, getWorkflowRecord, linkTransactionSource, listTransactionSources,
  listWorkflowRecords, reconcileAccount, saveReconciliationCheckpoint, undoImportPlan,
  unlinkTransactionSource,
} from '../src/mcp/workflow-tools';

const GOLDEN_PATH = join(process.cwd(), 'tests/fixtures/upstream-golden.json');

interface GoldenCase { tool: string; args: Record<string, unknown>; result?: Json; error?: string }
interface GoldenScenarioStep { name: string; result?: Json; error?: string }
interface Golden {
  now: string;
  cases: GoldenCase[];
  scenario?: { name: string; steps: GoldenScenarioStep[] };
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
  get_account_balances: getAccountBalances as never,
  list_ledgers: listLedgers as never,
  get_active_ledger: getActiveLedger as never,
  list_attachments: listAttachments as never,
  search: search as never,
};

/**
 * 上游这些工具**没有 ORDER BY**，顺序由数据库决定、不是契约；本地为了结果稳定
 * 显式排了序。这里按"多重集合"比较（两侧先按规范 JSON 排序），只忽略顺序，
 * 元素内容与数量仍然逐字段严格比对。
 */
// 这些工具返回数组的"顺序"不是契约：list_* 上游没有 ORDER BY；search 只按
// happened_at desc 排序，同刻记录的顺序未定义（SQLite 与 D1 可能不同）。
// 都按多重集合比较，只忽略顺序，元素内容与数量仍逐字段严格比对。
const ORDER_UNDEFINED = new Set(['list_categories', 'list_accounts', 'list_tags', 'list_budgets', 'search', 'list_ledgers']);

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

    // 对账：余额比对 + 检查点。a1 = 现金（cash）
    await run('reconcile_account', () => reconcileAccount(c, {
      ledger_id: 'L1', account_id: 'a1', at: '2026-05-02T23:59:59Z', actual_balance: 1000, time_zone: 'UTC',
    }));
    await run('reconcile_account_tz_kolkata', () => reconcileAccount(c, {
      ledger_id: 'L1', account_id: 'a1', at: '2026-05-02T23:59:59Z', actual_balance: 1000,
      time_zone: 'Asia/Kolkata',
    }));
    await run('reconcile_account_nan', () => reconcileAccount(c, {
      ledger_id: 'L1', account_id: 'a1', at: '2026-05-02T23:59:59Z', actual_balance: Number.NaN,
      time_zone: 'UTC',
    }));
    await run('reconcile_account_bad_account', () => reconcileAccount(c, {
      ledger_id: 'L1', account_id: 'nope', at: '2026-05-02T23:59:59Z', actual_balance: 1000,
      time_zone: 'UTC',
    }));
    await run('save_reconciliation_checkpoint_no_confirm', () => saveReconciliationCheckpoint(c, {
      ledger_id: 'L1', account_id: 'a1', at: '2026-05-02T23:59:59Z', actual_balance: 1000,
      source_system: 'bank', coverage_from: '2026-05-01', time_zone: 'UTC',
    }));
    await run('save_reconciliation_checkpoint', () => saveReconciliationCheckpoint(c, {
      ledger_id: 'L1', account_id: 'a1', at: '2026-05-02T23:59:59Z', actual_balance: 1000,
      source_system: 'bank', coverage_from: '2026-05-01', time_zone: 'UTC', confirm: true,
    }));
    await run('save_reconciliation_checkpoint_bad_range', () => saveReconciliationCheckpoint(c, {
      ledger_id: 'L1', account_id: 'a1', at: '2026-05-02T23:59:59Z', actual_balance: 1000,
      source_system: 'bank', coverage_from: '2026-06-01', time_zone: 'UTC', confirm: true,
    }));
    await run('list_workflow_records_checkpoint',
      () => listWorkflowRecords(c, { ledger_id: 'L1', kind: 'checkpoint' }));

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
