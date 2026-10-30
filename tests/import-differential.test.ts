/**
 * 导入解析差分：本地 parseCsvText vs 上游 Python 实现的 golden。
 *
 * golden 由 scripts/parity/upstream_dump.py 额外产出（upstream-import-golden.json），
 * 直接调上游 services/import_data/parser.parse_csv_text。
 * 本地侧用 src/services/import_data/parser.ts 里的 parseCsvText（纯函数，无 HTTP / 无 DB）。
 *
 * 为什么重要：workers 在 parser.ts 里**独立重写**了 CSV/TSV 解析 + 列名模糊匹配
 * （注释"对齐原版 Python"）。分隔符检测、BOM 剥离、表头行探测、beecount/generic 格式
 * 识别、列名 alias 匹配——这些环节没有任何测试盯着，是"早期错误对齐"的高发区。
 * 比如旧实现只识别 \t 和默认逗号，分号 / 竖线 CSV 会被当成单列。
 *
 * 文件缺失时 skip（见 parity.yml 先生成再测试）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCsvText } from '../src/services/import_data/parser';
import { diffJson, formatDiffs, normalize, type Json } from './parity-compare';

const GOLDEN_PATH = join(process.cwd(), 'tests/fixtures/upstream-import-golden.json');

interface ImportCase { name: string; text: string; result?: Json; error?: string }

const hasGolden = existsSync(GOLDEN_PATH);
const golden: { cases: ImportCase[] } = hasGolden
  ? JSON.parse(readFileSync(GOLDEN_PATH, 'utf-8'))
  : { cases: [] };

/** 把 workers 的 ImportData 折成与 golden 相同的规范形状（丢掉 warnings，统一键名）。 */
function toCanonical(d: ReturnType<typeof parseCsvText>): Json {
  return {
    sourceFormat: d.sourceFormat,
    headers: d.headers,
    rows: d.rows.map(r => ({ rowNumber: r.rowNumber, cells: r.cells })),
    suggestedMapping: d.suggestedMapping as unknown as Json,
  } as Json;
}

describe.skipIf(!hasGolden)('导入解析 parseCsvText vs 上游 golden', () => {
  it('fixtures 已生成', () => {
    expect(golden.cases.length).toBeGreaterThan(0);
  });

  for (const kase of golden.cases) {
    it(`[${kase.name}]`, () => {
      if (kase.error) {
        let threw = false;
        let msg = '';
        try {
          parseCsvText(kase.text);
        } catch (e) {
          threw = true;
          msg = e instanceof Error ? e.message : String(e);
        }
        expect(threw).toBe(true);
        expect(msg).toContain(kase.error.replace(/^[A-Za-z_][A-Za-z0-9_.]*(?::\s*\d{3})?:\s*/, ''));
        return;
      }

      const local = normalize(toCanonical(parseCsvText(kase.text)));
      const want = normalize(kase.result as Json);
      const diffs = diffJson(want, local);
      expect(diffs.length ? formatDiffs('parse', diffs) : '').toBe('');
    });
  }
});
