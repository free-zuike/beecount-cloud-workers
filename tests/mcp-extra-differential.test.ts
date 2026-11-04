/**
 * 运行时差分测试（第二批）：覆盖 mcp-differential 未对拍的 10 个 MCP 工具。
 *
 * golden 由 `scripts/parity/upstream_dump.py` 在**有上游 Python 依赖的环境**生成
 * 为 tests/fixtures/upstream-mcp-extra-golden.json（独立 DB，避免污染主管线 golden）。
 * 文件不存在时本测试 skip，并打印生成命令 —— 不会假装通过。
 *
 * 覆盖工具（排除 2 个依赖外部 LLM 的 parse_receipt / preview_text_transactions）：
 *   capability: get_operation / retry_operation / list_operations / list_changes
 *   file:       read_attachment / export_transactions
 *   rule:       apply_classification_rule / execute_classification_preview / run_due_recurring_rules
 *   workflow:   list_workflow_records（只读）
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IMPORT_BYTES, mcpCtx, makeHarness, seed, type Harness } from './mcp-harness';
import { diffJson, formatDiffs, normalize, type Json } from './parity-compare';
import {
  getOperation, retryOperation, listOperations, listChanges,
} from '../src/mcp/capability-tools';
import { readAttachment, exportTransactions, setAttachmentBytesSource } from '../src/mcp/file-tools';
import {
  applyClassificationRule, executeClassificationPreview, runDueRecurringRules,
} from '../src/mcp/rule-tools';
import { listWorkflowRecords } from '../src/mcp/workflow-tools';

const GOLDEN_PATH = join(process.cwd(), 'tests/fixtures/upstream-mcp-extra-golden.json');

interface GoldenCase { tool: string; args: Record<string, unknown>; result?: Json; error?: string }
interface Golden { now: string; cases: GoldenCase[] }

const TOOL_FNS: Record<string, (c: ReturnType<typeof mcpCtx>, args: Record<string, unknown>) => Promise<unknown>> = {
  get_operation: getOperation as never,
  retry_operation: retryOperation as never,
  list_operations: listOperations as never,
  list_changes: listChanges as never,
  read_attachment: readAttachment as never,
  export_transactions: exportTransactions as never,
  apply_classification_rule: applyClassificationRule as never,
  execute_classification_preview: executeClassificationPreview as never,
  run_due_recurring_rules: runDueRecurringRules as never,
  list_workflow_records: listWorkflowRecords as never,
};

/**
 * 这些工具返回数组的"顺序"不是契约（list_operations / list_changes 上游无保证顺序）；
 * 按多重集合比较，只忽略顺序，元素内容与数量仍逐字段严格比对。
 */
const ORDER_UNDEFINED = new Set(['list_operations', 'list_changes']);

function sortTop(value: Json): Json {
  if (!Array.isArray(value)) return value;
  const key = (v: Json) => JSON.stringify(v);
  return [...value].sort((a, b) => key(a).localeCompare(key(b)));
}

const hasGolden = existsSync(GOLDEN_PATH);

/**
 * golden 里的报错形如 `HTTPException: 400: Invalid ...`，本地是 `Error: ...`。
 * 去掉 `类型: 状态码: ` 前缀再比 —— 状态码与异常类是 Python 传输层细节，MCP 契约是消息文本本身。
 */
function errorText(raw: string): string {
  return raw.replace(/^[A-Za-z_][A-Za-z0-9_.]*(?::\s*\d{3})?:\s*/, '');
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const SYNC_ID_RE = /(tx|acc|cat|tag|bgt)_[0-9a-f]{12}/i;

/**
 * 本地独有的易变/随机字段，必须在比对前归一成稳定占位符（两侧都做，幂等）：
 * - dataset_revision：本地 export_transactions 多返回（上游无此字段）→ 直接丢弃
 * - uuid（export_id / resource_uri 里嵌入的、operation_id 等）：每次运行都不同
 * - sync_id 形如 tx_/acc_/... 的 12 位 hex：也是随机实体 id
 * - *cursor：分页令牌（含 fingerprint / 签名），跨实现必然不同 → 直接丢弃
 * 注意 normalize() 已负责剥离 revision/created_at/updated_at 等 VOLATILE_KEYS 并解码 *cursor，
 * 这里只补 normalize 不处理的"字符串内嵌随机片段"与本地独有字段。
 */
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortKeys((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}
/** 把"长得像 JSON 的字符串"按键序归一，消除上游 sort_keys 与本地插入序的差异（如 read_attachment 的 metadata 文本）。 */
function canonJson(s: string): string {
  try {
    const p = JSON.parse(s);
    if (p !== null && typeof p === 'object') return JSON.stringify(sortKeys(p));
  } catch { /* 非 JSON，原样返回 */ }
  return s;
}
function scrubStr(s: string): string {
  return canonJson(s).replace(UUID_RE, '<UUID>').replace(SYNC_ID_RE, '<SYNC_ID>');
}
function scrubExtras(v: Json): Json {
  if (Array.isArray(v)) return v.map(scrubExtras);
  if (v && typeof v === 'object') {
    const out: Record<string, Json> = {};
    for (const k of Object.keys(v as Record<string, Json>)) {
      if (k === 'dataset_revision') continue; // 本地 export_transactions 独有，上游无
      if (k.endsWith('cursor')) continue; // 游标是分页令牌（含指纹/签名），跨实现不同 → 剔除
      const val = (v as Record<string, Json>)[k];
      out[k] = typeof val === 'string' ? scrubStr(val) : scrubExtras(val);
    }
    return out;
  }
  if (typeof v === 'string') return scrubStr(v);
  return v;
}

/** list_operations 上游裸 list / 本地 {operations:[]}；统一取数组（兼容任一侧形状）。 */
function asArray(v: Json | undefined): Json {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') {
    const inner = (v as Record<string, Json>).operations;
    if (inner !== undefined) return asArray(inner);
  }
  return v as Json;
}

describe('差分比对器自检（extra）', () => {
  it('uuid / sync_id 内嵌片段被归一成占位符', () => {
    expect(scrubExtras({ export_id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' }))
      .toEqual({ export_id: '<UUID>' });
    expect(scrubExtras({ uri: 'beecount://exports/f47ac10b-58cc-4372-a567-0e02b2c3d479' }))
      .toEqual({ uri: 'beecount://exports/<UUID>' });
    expect(scrubExtras({ x: 'tx_abcdef123456' })).toEqual({ x: '<SYNC_ID>' });
  });
  it('dataset_revision 被丢弃', () => {
    expect(scrubExtras({ revision: 1, dataset_revision: 9 })).toEqual({ revision: 1 });
  });
  it('list_operations 两种形状都被取成数组', () => {
    expect(asArray([1, 2])).toEqual([1, 2]);
    expect(asArray({ operations: [1, 2] })).toEqual([1, 2]);
  });
});

describe.skipIf(!hasGolden)('MCP 额外工具差分（对上游 extra golden）', () => {
  it('10 个未覆盖工具输出与上游逐字段一致', async () => {
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Golden;
    const h: Harness = makeHarness();
    seed(h);
    const c = mcpCtx(h, 'u1');
    c.configuredTimeZone = 'Asia/Shanghai';
    // read_attachment 需要字节源（本地实现从 bytesSource 读取并校验 sha256/size）；
    // 与上游 seed.csv（f1，sha256=IMPORT_SHA）同字节。
    setAttachmentBytesSource(async () => new Uint8Array(IMPORT_BYTES));

    const failures: string[] = [];
    for (const kase of golden.cases) {
      const fn = TOOL_FNS[kase.tool];
      if (!fn) { failures.push(`[${kase.tool}] 本地未实现该工具`); continue; }
      let local: Json;
      try {
        const raw = await fn(c, kase.args);
        local = scrubExtras(normalize(asArray(raw as Json)));
      } catch (err) {
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
      const upstream = scrubExtras(normalize(asArray(kase.result)));
      // export_transactions 的 sha256 是 CSV 内容哈希：本地用 BOM+CRLF、上游格式或不同 → 哈希必然不同，
      // 剔除（row_count / revision / export_id / resource_uri 结构仍校验）。
      if (kase.tool === 'export_transactions') {
        for (const o of [upstream, local]) {
          if (o && typeof o === 'object' && !Array.isArray(o)) {
            delete (o as Record<string, unknown>).sha256;
          }
        }
      }
      const left = unordered ? sortTop(upstream) : upstream;
      const right = unordered ? sortTop(local) : local;
      const diffs = diffJson(left, right);
      if (diffs.length) failures.push(formatDiffs(kase.tool, diffs));
    }
    expect(failures.join('\n')).toBe('');
  });
});

describe.skipIf(hasGolden)('MCP 额外工具差分（待生成 golden）', () => {
  it('提示如何生成 golden', () => {
    console.warn(
      '\n[parity] tests/fixtures/upstream-mcp-extra-golden.json 不存在，第二批 MCP 差分未生效。\n'
      + '        在装有上游依赖的 Python 环境执行：npm run parity:dump\n',
    );
    expect(hasGolden).toBe(false);
  });
});
