#!/usr/bin/env node
/**
 * 从上游 MCP 测试里抽取断言，产出可核对的清册。
 *
 * 为什么需要这个：本地没有 Python 运行时，无法直接跑上游服务做运行时差分；
 * 但上游 tests/test_mcp_*.py 里的 300+ 条 assert 就是**权威期望值**（上游作者自己写的）。
 * 本脚本把它们连同所属测试函数一起导出，供逐条移植成 TS 用例，或作为人工核对的清单。
 *
 * 用法：
 *   node scripts/parity/extract-upstream-asserts.mjs <上游仓库根目录> [输出文件]
 * 默认输出 tests/fixtures/upstream-mcp-asserts.json
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';

const upstreamRoot = process.argv[2];
if (!upstreamRoot) {
  console.error('usage: node scripts/parity/extract-upstream-asserts.mjs <upstream-root> [out.json]');
  process.exit(2);
}
const outPath = process.argv[3] ?? 'tests/fixtures/upstream-mcp-asserts.json';
const testsDir = join(upstreamRoot, 'tests');

/** 断言分类：便于按"可移植性"排优先级 */
function classify(expr) {
  if (/status_code\s*==\s*20\d/.test(expr)) return 'http-status-ok';
  if (/status_code\s*==\s*4\d\d/.test(expr)) return 'http-status-error';
  if (/"error"|'error'/.test(expr)) return 'error-body';
  if (/"status"|'status'/.test(expr)) return 'status-field';
  if (/len\(|== \[\]|== \{\}|== 0\b/.test(expr)) return 'count-or-empty';
  if (/jsonrpc|protocolVersion|capabilities|serverInfo|instructions/.test(expr)) return 'protocol';
  if (/tools\/list|resources\/list|prompts\/list|names? ==|set\(/.test(expr)) return 'catalog';
  if (/\d{4}-\d{2}-\d{2}T/.test(expr)) return 'datetime';
  return 'other';
}

const files = readdirSync(testsDir).filter(f => /^test_mcp.*\.py$/.test(f)).sort();
const result = { generatedFrom: upstreamRoot, files: {}, totals: {} };

for (const file of files) {
  const text = readFileSync(join(testsDir, file), 'utf8');
  const lines = text.split(/\r?\n/);
  let currentTest = null;
  const asserts = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const testMatch = /^def (test_\w+)/.exec(line);
    if (testMatch) currentTest = testMatch[1];
    const assertMatch = /^\s+assert\s+(.+)$/.exec(line);
    if (!assertMatch) continue;
    const expr = assertMatch[1].trim();
    asserts.push({
      test: currentTest,
      line: i + 1,
      kind: classify(expr),
      expr: expr.length > 400 ? `${expr.slice(0, 400)}…` : expr,
    });
  }
  result.files[basename(file)] = asserts;
  for (const a of asserts) {
    result.totals[a.kind] = (result.totals[a.kind] ?? 0) + 1;
  }
}

result.totalAsserts = Object.values(result.files).reduce((n, list) => n + list.length, 0);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(`extracted ${result.totalAsserts} asserts from ${files.length} files -> ${outPath}`);
for (const [kind, n] of Object.entries(result.totals).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${kind}: ${n}`);
}
