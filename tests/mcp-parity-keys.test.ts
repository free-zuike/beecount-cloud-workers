/**
 * 返回键契约回归（第 3 层）：上游函数 return 里的顶层键，本地对应模块必须都出现。
 *
 * fixture 由脚本从上游 Python 源码提取（每个 def 的 return dict 首层键），不是手抄。
 * 说明：这是**文本级**护栏（键名出现在模块里），不是结构级断言——
 * 它能挡住"整个返回键被删掉/改名"，挡不住"键在但值口径不同"；
 * 值口径由 tests/mcp-file-tools.test.ts 等语义用例覆盖。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const contract = JSON.parse(
  readFileSync(join(process.cwd(), 'tests/fixtures/upstream-mcp-keys.json'), 'utf8'),
) as { functions: Record<string, string[]> };

/** 上游 Python 模块 → 本地 TS 模块 */
const MODULE_MAP: Record<string, string> = {
  read_tools: 'src/mcp/tools/read-tools.ts',
  server: 'src/routes/mcp.ts',
  auth: 'src/routes/mcp.ts',
  transaction_service: 'src/mcp/transaction-service.ts',
  analysis_tools: 'src/mcp/analysis-tools.ts',
  asset_history: 'src/mcp/asset-history.ts',
  capability_tools: 'src/mcp/capability-tools.ts',
  file_tools: 'src/mcp/file-tools.ts',
  workflow_tools: 'src/mcp/workflow-tools.ts',
  rule_tools: 'src/mcp/rule-tools.ts',
  operations: 'src/mcp/operations.ts',
};

describe('返回键与上游一致（文本级）', () => {
  it('fixture 覆盖到多个模块', () => {
    const modules = new Set(Object.keys(contract.functions).map(k => k.split('::')[0]));
    // 上游并非每个模块都有 return dict；至少应覆盖 6 个模块才说明提取有效
    expect(modules.size).toBeGreaterThanOrEqual(6);
    expect(Object.keys(contract.functions).length).toBeGreaterThan(20);
  });

  for (const [mod, relPath] of Object.entries(MODULE_MAP)) {
    it(`${mod} 的返回键本地都存在`, () => {
      const source = readFileSync(join(process.cwd(), relPath), 'utf8');
      const missing: string[] = [];
      for (const [fn, keys] of Object.entries(contract.functions)) {
        if (!fn.startsWith(`${mod}::`)) continue;
        for (const key of keys) {
          if (!source.includes(key)) missing.push(`${fn}.${key}`);
        }
      }
      expect(missing).toEqual([]);
    });
  }
});
