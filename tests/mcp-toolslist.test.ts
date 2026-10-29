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

  it('基础工具注解按上游 server.py 覆盖公式', () => {
    const byName = new Map(ALL_TOOL_DEFS.map(t => [t.name, t]));
    // 写工具里只有这三个是 destructive 且幂等
    for (const n of ['update_transaction', 'delete_transaction', 'update_budget']) {
      expect(byName.get(n)?.annotations?.destructiveHint).toBe(true);
      expect(byName.get(n)?.annotations?.idempotentHint).toBe(true);
    }
    // create_* 不是 destructive、也不是幂等
    expect(byName.get('create_transaction')?.annotations?.destructiveHint).toBe(false);
    expect(byName.get('create_transaction')?.annotations?.idempotentHint).toBe(false);
    // 基础写工具里 openWorld 只有 parse_and_create_from_text
    expect(byName.get('parse_and_create_from_text')?.annotations?.openWorldHint).toBe(true);
    expect(byName.get('upload_attachment')?.annotations?.openWorldHint).toBe(false);
  });

  it('注册表工具注解按 register_capabilities 公式', () => {
    const byName = new Map(ALL_TOOL_DEFS.map(t => [t.name, t]));
    // 这两个走外部 AI，openWorld=true
    expect(byName.get('parse_receipt')?.annotations?.openWorldHint).toBe(true);
    expect(byName.get('preview_text_transactions')?.annotations?.openWorldHint).toBe(true);
    // retry_operation 是写工具但幂等
    expect(byName.get('retry_operation')?.annotations?.idempotentHint).toBe(true);
    expect(byName.get('retry_operation')?.annotations?.destructiveHint).toBe(true);
    // export_transactions 属读函数但不标 readOnly、也不幂等
    expect(byName.get('export_transactions')?.annotations?.readOnlyHint).toBe(false);
    expect(byName.get('export_transactions')?.annotations?.idempotentHint).toBe(false);
    // 普通注册读工具
    expect(byName.get('list_operations')?.annotations?.readOnlyHint).toBe(true);
  });
});
