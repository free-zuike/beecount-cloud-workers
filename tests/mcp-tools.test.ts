import { describe, it, expect } from 'vitest';
import { TOOL_DEFS } from '../src/routes/mcp';

// 从原版 Python server.py 提取的工具定义
const EXPECTED_TOOLS: { name: string; params: string[]; required: string[] }[] = [
  { name: 'list_ledgers', params: [], required: [] },
  { name: 'get_active_ledger', params: [], required: [] },
  { name: 'list_transactions', params: ['ledger_id', 'date_from', 'date_to', 'category', 'account', 'min_amount', 'max_amount', 'q', 'limit'], required: [] },
  { name: 'get_transaction', params: ['sync_id'], required: ['sync_id'] },
  { name: 'list_categories', params: ['kind'], required: [] },
  { name: 'list_accounts', params: ['account_type'], required: [] },
  { name: 'list_tags', params: [], required: [] },
  { name: 'list_budgets', params: ['ledger_id'], required: [] },
  { name: 'get_ledger_stats', params: ['ledger_id'], required: [] },
  { name: 'get_analytics_summary', params: ['scope', 'period', 'ledger_id'], required: [] },
  { name: 'search', params: ['q', 'limit'], required: ['q'] },
  { name: 'create_transaction', params: ['amount', 'tx_type', 'category', 'account', 'happened_at', 'note', 'tags', 'ledger_id'], required: ['amount'] },
  { name: 'create_transactions', params: ['transactions', 'ledger_id'], required: ['transactions'] },
  { name: 'update_transaction', params: ['sync_id', 'amount', 'tx_type', 'category', 'account', 'happened_at', 'note', 'tags'], required: ['sync_id'] },
  { name: 'delete_transaction', params: ['sync_id', 'confirm'], required: ['sync_id'] },
  { name: 'create_category', params: ['name', 'kind', 'parent_name', 'icon', 'ledger_id'], required: ['name'] },
  { name: 'update_budget', params: ['budget_id', 'amount'], required: ['budget_id', 'amount'] },
  { name: 'parse_and_create_from_text', params: ['text', 'ledger_id'], required: ['text'] },
];

describe('MCP Tool Definitions', () => {
  it('should have exactly 18 tools (matching original Python)', () => {
    expect(TOOL_DEFS.length).toBe(EXPECTED_TOOLS.length);
  });

  it('should have tools in the same order as original Python', () => {
    const names = TOOL_DEFS.map(t => t.name);
    const expectedNames = EXPECTED_TOOLS.map(t => t.name);
    expect(names).toEqual(expectedNames);
  });

  it('each tool should have correct parameter names', () => {
    for (const expected of EXPECTED_TOOLS) {
      const tool = TOOL_DEFS.find(t => t.name === expected.name);
      expect(tool, `Tool "${expected.name}" not found`).toBeDefined();
      if (!tool) continue;

      const schema = tool.inputSchema as any;
      const actualParams = Object.keys(schema.properties || {});
      const expectedParams = expected.params;

      // Check that all expected params exist
      for (const p of expectedParams) {
        expect(actualParams, `Tool "${expected.name}" missing param "${p}"`).toContain(p);
      }

      // Check that there are no extra params
      for (const p of actualParams) {
        expect(expectedParams, `Tool "${expected.name}" has unexpected param "${p}"`).toContain(p);
      }

      // Check required params
      const actualRequired = schema.required || [];
      for (const r of expected.required) {
        expect(actualRequired, `Tool "${expected.name}" missing required param "${r}"`).toContain(r);
      }
      for (const r of actualRequired) {
        expect(expected.required, `Tool "${expected.name}" has unexpected required param "${r}"`).toContain(r);
      }
    }
  });

  it('should have English descriptions (not Chinese)', () => {
    // parse_and_create_from_text 描述含中文示例句（"上午星巴克花了 38"），与原版 Python 一致，允许
    const allowChinese = new Set(['parse_and_create_from_text']);
    for (const tool of TOOL_DEFS) {
      if (allowChinese.has(tool.name)) continue;
      expect(tool.description, `Tool "${tool.name}" description contains Chinese characters`).not.toMatch(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/);
    }
  });

  it('list_transactions limit should have default 50', () => {
    const tool = TOOL_DEFS.find(t => t.name === 'list_transactions')!;
    const schema = tool.inputSchema as any;
    expect(schema.properties.limit.default).toBe(50);
  });

  it('search limit should have default 20', () => {
    const tool = TOOL_DEFS.find(t => t.name === 'search')!;
    const schema = tool.inputSchema as any;
    expect(schema.properties.limit.default).toBe(20);
  });

  it('create_transaction should not have currency param', () => {
    const tool = TOOL_DEFS.find(t => t.name === 'create_transaction')!;
    const schema = tool.inputSchema as any;
    expect(schema.properties.currency).toBeUndefined();
  });

  it('create_transaction should not have ledger_id in required', () => {
    const tool = TOOL_DEFS.find(t => t.name === 'create_transaction')!;
    const schema = tool.inputSchema as any;
    expect(schema.required || []).not.toContain('ledger_id');
  });

  it('get_analytics_summary scope should have enum values', () => {
    const tool = TOOL_DEFS.find(t => t.name === 'get_analytics_summary')!;
    const schema = tool.inputSchema as any;
    expect(schema.properties.scope.enum).toEqual(['month', 'year', 'all']);
  });

  it('create_transaction tx_type should have enum values', () => {
    const tool = TOOL_DEFS.find(t => t.name === 'create_transaction')!;
    const schema = tool.inputSchema as any;
    expect(schema.properties.tx_type.enum).toEqual(['expense', 'income', 'transfer']);
  });

  it('delete_transaction should have confirm param', () => {
    const tool = TOOL_DEFS.find(t => t.name === 'delete_transaction')!;
    const schema = tool.inputSchema as any;
    expect(schema.properties.confirm).toBeDefined();
    expect(schema.properties.confirm.type).toBe('boolean');
  });
});