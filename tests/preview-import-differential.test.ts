/**
 * preview_import 的运行时差分：本地 previewImport vs 上游 Python golden。
 *
 * golden 由 scripts/parity/upstream_dump.py 额外产出（upstream-preview-import-golden.json），
 * 调用上游 src.mcp.workflow_tools.preview_import（独立库，避免污染写路径 golden 的
 * list_workflow_records）。本地侧用 mcpCtx 直接调 previewImport，比完整 JSON。
 *
 * 为什么单独成文件：preview_import 会写 import_plan 到 mcp_state_records，若进主 golden
 * 会污染 list_workflow_records 断言；故上游用独立库 + 独立 golden 文件隔离。
 *
 * 文件缺失时 skip（见 parity.yml 先生成再测试）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeHarness, mcpCtx, seed } from './mcp-harness';
import { diffJson, formatDiffs, type Json } from './parity-compare';
import { previewImport } from '../src/mcp/workflow-tools';

const GOLDEN_PATH = join(process.cwd(), 'tests/fixtures/upstream-preview-import-golden.json');

interface PreviewCase { name: string; status: number; result?: Json }

const hasGolden = existsSync(GOLDEN_PATH);
const golden: { cases: PreviewCase[] } = hasGolden
  ? JSON.parse(readFileSync(GOLDEN_PATH, 'utf-8'))
  : { cases: [] };

// 与 scripts/parity/upstream_dump.py 的 _scrub_pi 保持一致的本地侧剥离
const PI_DROP = new Set([
  'id', 'ledger_internal_id', 'revision', 'next_due_at', 'created_at', 'updated_at',
  'base_revision', 'existing_sync_id', 'similar',
  // tag_ids 是种子派生的 sync_id（跨代码库不可比），与 id/similar 同理需剥离；
  // tags 名称（如默认 "MCP"）保留比对，以校验 workers 正确合并默认标签。
  'tag_ids',
]);

function scrubHa(v: Json): Json {
  if (typeof v === 'string') return v.replace(/Z$/, '').replace(/\+00:00$/, '') as Json;
  return v;
}

function normalizePreview(value: Json): Json {
  if (Array.isArray(value)) return value.map(normalizePreview);
  if (value && typeof value === 'object') {
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(value as Record<string, Json>)) {
      if (PI_DROP.has(k)) continue;
      if (k === 'happened_at') { out[k] = scrubHa(v); continue; }
      if (k === 'items' && Array.isArray(v)) { out[k] = v.map(normalizePreview); continue; }
      if (k === 'normalized' && v && typeof v === 'object') {
        const n: Record<string, Json> = {};
        for (const [nk, nv] of Object.entries(v as Record<string, Json>)) {
          // tag_ids 是种子派生的 sync_id（跨代码库不可比），与 id/similar 同理需剥离；
          // tags 名称（如默认 "MCP"）保留比对，以校验 workers 正确合并默认标签。
          if (PI_DROP.has(nk)) continue;
          n[nk] = nk === 'happened_at' ? scrubHa(nv) : nv;
        }
        out[k] = n;
        continue;
      }
      out[k] = normalizePreview(v);
    }
    return out;
  }
  return value;
}

describe.skipIf(!hasGolden)('preview_import vs 上游 golden', () => {
  it('fixtures 已生成', () => {
    expect(hasGolden).toBe(true);
  });

  for (const c of golden.cases) {
    it(c.name, async () => {
      const h = makeHarness();
      await seed(h);
      const ctx = mcpCtx(h, 'u1');
      const local = (await previewImport(ctx, {
        ledger_id: 'L1',
        candidates: [{
          transaction: {
            amount: 12.5, tx_type: 'expense', happened_at: '2026-05-16T03:30:00+00:00',
            category_id: 'c1', account_id: 'a1', note: '午饭',
          },
          sources: [{ source_system: 'bank', source_id: 'pi-001' }],
          action: 'create', allow_similar: true,
        }],
      })) as unknown as Json;
      const diffs = diffJson(normalizePreview(c.result ?? {}), normalizePreview(local));
      if (diffs.length) throw new Error(formatDiffs(c.name, diffs));
      expect(diffs.length).toBe(0);
    });
  }
});
