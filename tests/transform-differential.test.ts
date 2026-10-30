/**
 * 导入转换差分：本地 applyMapping vs 上游 Python 实现的 golden。
 *
 * golden 由 scripts/parity/upstream_dump.py 额外产出（upstream-transform-golden.json），
 * 直接调上游 services/import_data/transformer.apply_mapping。
 * 本地侧用 src/services/import_data/transformer.ts 里的 applyMapping（纯函数）。
 *
 * 为什么重要：workers 在 transformer.ts 里**独立重写**了逐行 transform（金额符号、
 * txType 推断、日期解析、required_complete、tags 拆分），注释"对齐原版 Python"，
 * 且零测试。这是"早期错误对齐"的另一高发区——金额负号语义、空类型行、币种符号剥离、
 * required_complete 返回空等分支此前完全没覆盖。
 *
 * 文件缺失时 skip（见 parity.yml 先生成再测试）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyMapping } from '../src/services/import_data/transformer';
import type { ImportFieldMapping, ParsedRow } from '../src/services/import_data/schema';
import { diffJson, formatDiffs, normalize, type Json } from './parity-compare';

const GOLDEN_PATH = join(process.cwd(), 'tests/fixtures/upstream-transform-golden.json');

interface TransformCase {
  name: string;
  mapping: Record<string, unknown>;
  rows: Array<Record<string, string>>;
  result?: { txs: Json[]; errorCount: number };
  error?: string;
}

const hasGolden = existsSync(GOLDEN_PATH);
const golden: { cases: TransformCase[] } = hasGolden
  ? JSON.parse(readFileSync(GOLDEN_PATH, 'utf-8'))
  : { cases: [] };

function normDt(v: unknown): string | null {
  if (!v) return null;
  return String(v).replace(/\.\d+/, '').replace(/Z$/, '');
}

/** workers 的 ImportTransaction → 与 golden 相同的规范形状（undefined→null，日期去 Z/毫秒）。 */
function normTx(t: ReturnType<typeof applyMapping>[number]): Json {
  return {
    txType: t.txType,
    amount: t.amount,
    happenedAt: normDt(t.happenedAt),
    currencyCode: t.currencyCode ?? null,
    note: t.note ?? null,
    categoryName: t.categoryName ?? null,
    parentCategoryName: t.parentCategoryName ?? null,
    accountName: t.accountName ?? null,
    fromAccountName: t.fromAccountName ?? null,
    toAccountName: t.toAccountName ?? null,
    tagNames: t.tagNames,
    sourceRowNumber: t.sourceRowNumber,
  };
}

describe.skipIf(!hasGolden)('导入转换 applyMapping vs 上游 golden', () => {
  it('fixtures 已生成', () => {
    expect(golden.cases.length).toBeGreaterThan(0);
  });

  for (const kase of golden.cases) {
    it(`[${kase.name}]`, () => {
      if (kase.error) {
        let threw = false;
        let msg = '';
        try {
          applyMapping(
            kase.rows.map((c, i) => ({ rowNumber: i + 1, cells: c, rawLine: '' }) as ParsedRow),
            kase.mapping as unknown as ImportFieldMapping,
          );
        } catch (e) {
          threw = true;
          msg = e instanceof Error ? e.message : String(e);
        }
        expect(threw).toBe(true);
        expect(msg).toContain(kase.error.replace(/^[A-Za-z_][A-Za-z0-9_.]*(?::\s*\d{3})?:\s*/, ''));
        return;
      }

      const localTxs = applyMapping(
        kase.rows.map((c, i) => ({ rowNumber: i + 1, cells: c, rawLine: '' }) as ParsedRow),
        kase.mapping as unknown as ImportFieldMapping,
      ).map(normTx);
      const want = normalize((kase.result as { txs: Json[] }).txs.map(normalize));
      const got = normalize(localTxs);
      const diffs = diffJson(want, got);
      expect(diffs.length ? formatDiffs('transform', diffs) : '').toBe('');
    });
  }
});
