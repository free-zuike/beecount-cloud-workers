/**
 * csv 导出的运行时差分：本地 /api/v1/read/workspace/transactions.csv vs 上游 Python golden。
 *
 * golden 由 scripts/parity/upstream_dump.py 额外产出（upstream-csv-export-golden.json），
 * 调用上游 src.routers.read.workspace.export_workspace_transactions_csv（tx_ids 限定 t1/t3）。
 * 本地侧用 buildRouterApp 挂 workspaceRouter，打同一条路由。
 *
 * 文本体比对做结构化归一（不是逐字节）：
 *  - 去 UTF-8 BOM；
 *  - 按列名对齐，剥除 workers 独有、上游契约没有的 `currency` 列（已知格式分歧，待产品侧对齐）；
 *  - amount 规范为浮点串（容忍 38.00 / 38 这类格式差异）；
 *  - 行集合比较（容忍排序）。
 * 文件缺失时 skip（见 parity.yml 先生成再测试）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import workspaceRouter from '../src/routes/workspace';
import { makeHarness, seed, buildRouterApp } from './mcp-harness';
import { diffJson, formatDiffs, type Json } from './parity-compare';

const GOLDEN_PATH = join(process.cwd(), 'tests/fixtures/upstream-csv-export-golden.json');

interface CsvCase { name: string; status: number; result?: string }

const hasGolden = existsSync(GOLDEN_PATH);
const golden: { cases: CsvCase[] } = hasGolden
  ? JSON.parse(readFileSync(GOLDEN_PATH, 'utf-8'))
  : { cases: [] };

/** 极简 CSV 行解析（处理引号包裹的字段；受控数据无字段内含逗号，简单实现足够）。 */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** 把 CSV 文本归约为可比较的规范结构：{ headers: string[], rows: string[] }（行集合化）。 */
function normalizeCsv(text: string): { headers: string[]; rows: string[] } {
  const raw = text.replace(/^﻿/, ''); // 去 BOM
  const lines = raw.split(/\r\n|\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = parseCsvLine(lines[0]);
  // workers 独有 currency 列：剥除（上下游列名对齐）
  const dropIdx = headers.indexOf('currency');
  const keep = (cells: string[]) => (dropIdx >= 0 ? cells.filter((_, i) => i !== dropIdx) : cells);
  const normHeaders = keep(headers);
  const amtIdx = headers.indexOf('amount');
  const rows = lines.slice(1).map((l) => {
    const cells = keep(parseCsvLine(l));
    return cells
      .map((c, i) => (i === amtIdx ? String(Number(c)) : c.trim()))
      .join('|');
  });
  return { headers: normHeaders, rows };
}

describe.skipIf(!hasGolden)('csv 导出 vs 上游 golden', () => {
  it('fixtures 已生成', () => {
    expect(hasGolden).toBe(true);
  });

  for (const c of golden.cases) {
    it(c.name, async () => {
      const h = makeHarness();
      await seed(h);
      const app = buildRouterApp(workspaceRouter as any, '/api/v1/read/workspace', h.db);
      const res = await app.request(
        '/api/v1/read/workspace/transactions.csv?ledger_id=L1&tx_ids=t1&tx_ids=t3',
        { headers: { 'X-Test-User': 'u1' } },
        { DB: h.db, JWT_SECRET: 'test-secret-for-parity-0123456789' } as never,
      );
      expect(res.status).toBe(200);
      const localText = await res.text();
      const g = normalizeCsv(c.result ?? '');
      const l = normalizeCsv(localText);
      // 表头（去 currency 后）必须一致
      const headerDiffs = diffJson(
        g.headers.slice().sort() as unknown as Json,
        l.headers.slice().sort() as unknown as Json,
      );
      if (headerDiffs.length) throw new Error('CSV 表头分歧: ' + formatDiffs(c.name, headerDiffs));
      // 行集合比较
      const gset = new Set(g.rows);
      const lset = new Set(l.rows);
      const missing = [...gset].filter((r) => !lset.has(r));
      const extra = [...lset].filter((r) => !gset.has(r));
      if (missing.length || extra.length) {
        throw new Error(
          `CSV 行分歧: 缺 ${missing.length} 条 / 多 ${extra.length} 条\n` +
          `  缺: ${missing.slice(0, 3).join(' || ')}\n  多: ${extra.slice(0, 3).join(' || ')}`,
        );
      }
      expect(missing.length + extra.length).toBe(0);
    });
  }
});
