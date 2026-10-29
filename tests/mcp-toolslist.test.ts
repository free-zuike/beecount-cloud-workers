/**
 * tools/list 契约（对齐上游 server.py）：注册过的工具必须全部能被发现。
 *
 * 上游把 capability/file/analysis/rule/workflow 模块的 READ/WRITE_FUNCTIONS
 * 全部 register 到 MCP，因此 tools/list 要能列出 55 个工具，
 * 而不是只有分发层 switch 里的那 19 个基础工具。
 */
import { describe, expect, it } from 'vitest';
import { ALL_TOOL_DEFS, BASE_TOOL_NAMES } from '../src/routes/mcp';
import { REGISTERED_TOOLS } from '../src/mcp/registry';

describe('tools/list（对齐上游注册面）', () => {
  it('列出全部注册工具：基础工具 + 注册表工具', () => {
    const names = new Set(ALL_TOOL_DEFS.map(t => t.name));
    for (const n of BASE_TOOL_NAMES) expect(names.has(n)).toBe(true);
    for (const t of REGISTERED_TOOLS) expect(names.has(t.name)).toBe(true);
    expect(names.size).toBe(BASE_TOOL_NAMES.length + REGISTERED_TOOLS.length);
  });

  it('只读工具有 readOnlyHint / idempotentHint 注解', () => {
    const byName = new Map(ALL_TOOL_DEFS.map(t => [t.name, t]));
    expect(byName.get('list_transactions')?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get('search')?.annotations?.idempotentHint).toBe(true);
  });

  it('注解按上游公式：写工具 destructive 且非幂等；开放式只有 AI 解析两个', () => {
    const byName = new Map(ALL_TOOL_DEFS.map(t => [t.name, t]));
    expect(byName.get('delete_transaction')?.annotations?.destructiveHint).toBe(true);
    expect(byName.get('create_transaction')?.annotations?.destructiveHint).toBe(true);
    // 上游 idempotentHint = 只读（除 export_transactions）或 retry_operation
    expect(byName.get('create_transaction')?.annotations?.idempotentHint).toBe(false);
    expect(byName.get('retry_operation')?.annotations?.idempotentHint).toBe(true);
    // openWorldHint 只有 parse_receipt / preview_text_transactions
    expect(byName.get('parse_receipt')?.annotations?.openWorldHint).toBe(true);
    expect(byName.get('preview_text_transactions')?.annotations?.openWorldHint).toBe(true);
    expect(byName.get('parse_and_create_from_text')?.annotations?.openWorldHint).toBe(false);
    // export_transactions 虽属读函数，但不标 readOnly
    expect(byName.get('export_transactions')?.annotations?.readOnlyHint).toBe(false);
  });
});
