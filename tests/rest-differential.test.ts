/**
 * REST 只读计算的差分测试：本地 read/summary 路由 vs 上游 Python 实现的 golden。
 *
 * golden 由 scripts/parity/upstream_dump.py 额外产出（upstream-rest-golden.json），
 * 调用上游 routers/read 里的 get_summary / list_budgets_usage / list_exchange_rate_overrides。
 * 本地侧用 buildReadApp() 挂载真实 read + summary 路由，发 HTTP 请求比对完整 JSON。
 *
 * 为什么重要：workers 在 routes/summary.ts / routes/read.ts 里**独立重写**了这些统计 SQL，
 * 带"对齐上游"注释——正是 MCP 层那几类早期错误对齐最易重演的地方，且此前无任何测试盯着。
 *
 * 文件缺失时 skip（见 parity.yml 先生成再测试）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildReadApp, makeHarness, seed, insertRow, type Harness } from './mcp-harness';
import { diffJson, formatDiffs, normalize, type Json } from './parity-compare';

const GOLDEN_PATH = join(process.cwd(), 'tests/fixtures/upstream-rest-golden.json');

interface RestCase { tool: string; args: Record<string, unknown>; result?: Json; error?: string }

const hasGolden = existsSync(GOLDEN_PATH);
const golden: { cases: RestCase[] } = hasGolden
  ? JSON.parse(readFileSync(GOLDEN_PATH, 'utf-8'))
  : { cases: [] };

/** 这些返回数组：exchange-rate-overrides、budgets/usage 及各类列表的项顺序非契约，按多重集合比。 */
const ORDER_UNDEFINED = new Set([
  'list_exchange_rate_overrides', 'list_budgets_usage',
  'list_ledgers', 'list_accounts', 'list_categories', 'list_tags', 'list_budgets',
]);

function sortTop(value: Json): Json {
  if (!Array.isArray(value)) return value;
  const key = (v: Json) => JSON.stringify(v);
  return [...value].sort((a, b) => key(a).localeCompare(key(b)));
}

/** 剥掉服务端 now() 字段（exported_at / updated_at）：golden 侧已 scrub，本地侧在此对齐。 */
function dropReadVolatile(v: Json): Json {
  if (Array.isArray(v)) return v.map(dropReadVolatile);
  if (v && typeof v === 'object') {
    const out: Record<string, Json> = {};
    for (const [k, val] of Object.entries(v as Record<string, Json>)) {
      if (k === 'exported_at' || k === 'updated_at') continue;
      out[k] = dropReadVolatile(val);
    }
    return out;
  }
  return v;
}

/** 把 golden 的工具名 + 参数映射成本地 REST 路由请求。 */
function toRequest(tool: string, args: Record<string, unknown>): { method: string; path: string } {
  switch (tool) {
    case 'get_summary':
      return { method: 'GET', path: `/api/v1/read/summary?ledger_id=${args.ledger_id}` };
    case 'list_budgets_usage':
      return { method: 'GET', path: `/api/v1/read/ledgers/${args.ledger_external_id}/budgets/usage` };
    case 'list_exchange_rate_overrides':
      return { method: 'GET', path: '/api/v1/read/exchange-rate-overrides' };
    case 'list_transactions': {
      // 本地 /ledgers/:id/transactions 与上游 ledgers.py:240 参数名一致（tx_type/q/start_at/end_at/limit/offset）
      const { ledger_external_id, ...rest } = args as Record<string, unknown> & { ledger_external_id: string };
      const qp = new URLSearchParams();
      for (const [k, v] of Object.entries(rest)) {
        if (v !== undefined && v !== null) qp.set(k, String(v));
      }
      const qs = qp.toString();
      return { method: 'GET', path: `/api/v1/read/ledgers/${ledger_external_id}/transactions${qs ? `?${qs}` : ''}` };
    }
    case 'list_ledgers':
      return { method: 'GET', path: '/api/v1/read/ledgers' };
    case 'get_ledger':
      return { method: 'GET', path: `/api/v1/read/ledgers/${args.ledger_external_id}` };
    case 'get_ledger_stats':
      return { method: 'GET', path: `/api/v1/read/ledgers/${args.ledger_external_id}/stats` };
    case 'list_accounts':
      return { method: 'GET', path: `/api/v1/read/ledgers/${args.ledger_external_id}/accounts` };
    case 'list_categories':
      return { method: 'GET', path: `/api/v1/read/ledgers/${args.ledger_external_id}/categories` };
    case 'list_tags':
      return { method: 'GET', path: `/api/v1/read/ledgers/${args.ledger_external_id}/tags` };
    case 'list_budgets':
      return { method: 'GET', path: `/api/v1/read/ledgers/${args.ledger_external_id}/budgets` };
    default:
      throw new Error(`REST 差分未映射工具: ${tool}`);
  }
}

function statusErrorCode(text: string): string {
  // 上游 400/404/409 等错误体可能是 {"detail":"..."} 或 {"error":"..."}
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    return String(j.detail ?? j.error ?? '');
  } catch {
    return text.slice(0, 200);
  }
}

/**
 * 对齐 upstream_dump.py scenario 的 create_transactions 批量写：对 L1 额外插入 2 笔交易，
 * 使本地 harness 的 read_tx_projection 与上游生成 REST golden 时所处的 db 状态一致。
 * 直接按上游最终落库的字段值插入（happened_at 已是 Asia/Shanghai → UTC 后的结果），
 * 避免依赖批量路由的时区换算实现细节，只要最终统计口径一致即可差分通过。
 */
function seedBatchL1(h: Harness): void {
  const bt: Array<[string, 'expense' | 'income', number, string, string, string, string, string | null]> = [
    ['bt1', 'expense', 12.5, '2026-05-12T16:00:00Z', 'c1', 'a1', '批量咖啡', 'MCP'],
    ['bt2', 'income', 9000, '2026-05-19T16:00:00Z', 'c2', 'a1', '批量工资', 'MCP'],
  ];
  for (const [sync, kind, amount, happened, cat, acc, note, tags] of bt) {
    insertRow(h.sqlite, 'read_tx_projection', {
      sync_id: sync, user_id: 'u1', ledger_id: 'L1-i', tx_type: kind, amount,
      happened_at: happened, category_sync_id: cat, account_sync_id: acc,
      category_name: cat === 'c1' ? '餐饮' : cat === 'c2' ? '工资' : null,
      category_kind: cat === 'c1' ? 'expense' : cat === 'c2' ? 'income' : cat === 'c3' ? 'transfer' : null,
      account_name: acc === 'a1' ? '现金' : acc === 'a2' ? '招行' : null,
      note, tags_csv: tags, currency_code: null, native_amount: null, tx_index: 0,
      from_account_id: null, to_account_id: null, from_account_name: null, to_account_name: null,
      exclude_from_stats: 0, exclude_from_budget: 0,
      source_change_id: 1, created_by_user_id: 'u1', created_at: happened, updated_at: happened,
      tags_sync_ids_json: null, tag_sync_ids_json: null,
    });
  }
  // 对齐上游 scenario 末态：L1 的最新 change_id=18（list_transactions 透传 last_change_id）。
  h.sqlite.prepare('INSERT INTO sync_changes (change_id, user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id, updated_by_device_id, scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(18, 'u1', 'L1-i', 'ledger_snapshot', 'L1', 'upsert', '{}', '2026-05-20T00:00:00Z', 'u1', null, 'ledger');
}

// list_transactions 的核心比对投影：覆盖全部确定性字段（过滤/排序/分页相关 + 确定性元数据
// created_by_* / last_edited_by_* / ledger_* / last_change_id / exclude_* / currency/native /
// from_account_id / to_account_id / tx_index / attachments），确保响应结构与上游逐项对齐。
// 仅剔除唯一一类无法静态对齐的字段：id / tag_ids（上游夹具每次 CI 重生都会随机生成）。
const LT_CORE = new Set<string>([
  'tx_type', 'amount', 'happened_at', 'note', 'category_name', 'category_kind',
  'account_name', 'from_account_name', 'to_account_name', 'from_account_id', 'to_account_id',
  'category_id', 'account_id', 'tx_index',
  'tags', 'tags_list', 'currency_code', 'native_amount', 'attachments',
  'created_by_user_id', 'created_by_email', 'created_by_display_name', 'created_by_avatar_url', 'created_by_avatar_version',
  'last_edited_by_user_id', 'last_edited_by_email', 'last_edited_by_display_name', 'last_edited_by_avatar_url', 'last_edited_by_avatar_version',
  'ledger_id', 'ledger_name', 'last_change_id',
  'exclude_from_stats', 'exclude_from_budget',
]);
function projectListTx(v: Json): Json {
  if (Array.isArray(v)) {
    return v.map((o) =>
      o && typeof o === 'object' && !Array.isArray(o)
        ? (Object.fromEntries(
            Object.entries(o as Record<string, Json>).filter(([k]) => LT_CORE.has(k)),
          ) as Json)
        : o,
    ) as Json;
  }
  return v;
}

describe.skipIf(!hasGolden)('REST 只读计算 vs 上游 golden', () => {
  it('fixtures 已生成', () => {
    expect(golden.cases.length).toBeGreaterThan(0);
  });

  for (const kase of golden.cases) {
    it(`[${kase.tool}] ${JSON.stringify(kase.args)}`, async () => {
      const h: Harness = makeHarness();
      seed(h);
      // 对齐 upstream_dump.py 的 scenario：对 L1 执行 create_transactions 批量写（2 笔）。
      // 上游 REST golden 是在 scenario（含批量写）跑完后的同一 db 上生成的，
      // 所以本地 harness 必须复现这 2 笔，否则 worker 得 7 而 golden 得 9。
      seedBatchL1(h);
      const userId = 'u1';
      const app = buildReadApp(h.db);
      const { method, path } = toRequest(kase.tool, kase.args);

      const res = await app.request(path, {
        method,
        headers: { 'X-Test-User': userId },
      }, { DB: h.db, JWT_SECRET: 'test-secret' });

      if (kase.error) {
        expect(res.status).toBeGreaterThanOrEqual(400);
        const got = statusErrorCode(await res.text());
        // 去掉 Python 传输层前缀（见 mcp 差分），只比消息文本
        const expected = kase.error.replace(/^[A-Za-z_][A-Za-z0-9_.]*(?::\s*\d{3})?:\s*/, '');
        expect(got).toContain(expected);
        return;
      }

      expect(res.status).toBe(200);
      const body = dropReadVolatile(normalize(JSON.parse(await res.text()) as Json));
      const want = dropReadVolatile(normalize(kase.result as Json));
      // list_transactions 投影到核心字段（过滤/排序/分页相关），剔除非确定性/夹具相关元数据
      const bodyProj = kase.tool === 'list_transactions' ? projectListTx(body) : body;
      const wantProj = kase.tool === 'list_transactions' ? projectListTx(want) : want;
      const left = ORDER_UNDEFINED.has(kase.tool) ? sortTop(bodyProj) : bodyProj;
      const right = ORDER_UNDEFINED.has(kase.tool) ? sortTop(wantProj) : wantProj;
      const diffs = diffJson(left, right);
      expect(diffs.length ? formatDiffs(kase.tool, diffs) : '').toBe('');
    });
  }
});
