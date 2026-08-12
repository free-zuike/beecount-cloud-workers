import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TOOL_DEFS, selfCall, PROTOCOL_VERSION, SUPPORTED_VERSIONS, SERVER_INFO } from '../src/routes/mcp';

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

// 从原版 Python server.py 提取的 write router 端点路径
const WRITE_ENDPOINTS: Record<string, { method: string; path: string; bodyFields: string[] }> = {
  create_transaction: { method: 'POST', path: '/api/v1/write/ledgers/{ledgerId}/transactions', bodyFields: ['base_change_id', 'tx_type', 'amount', 'happened_at'] },
  update_transaction: { method: 'PATCH', path: '/api/v1/write/ledgers/{ledgerId}/transactions/{syncId}', bodyFields: ['base_change_id'] },
  delete_transaction: { method: 'DELETE', path: '/api/v1/write/ledgers/{ledgerId}/transactions/{syncId}', bodyFields: ['base_change_id'] },
  create_category: { method: 'POST', path: '/api/v1/write/ledgers/{ledgerId}/categories', bodyFields: ['base_change_id', 'name', 'kind'] },
  update_budget: { method: 'PATCH', path: '/api/v1/write/ledgers/{ledgerId}/budgets/{budgetId}', bodyFields: ['base_change_id', 'amount'] },
  create_transactions: { method: 'POST', path: '/api/v1/write/ledgers/{ledgerId}/transactions/batch', bodyFields: ['base_change_id', 'transactions'] },
};

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

      for (const p of expectedParams) {
        expect(actualParams, `Tool "${expected.name}" missing param "${p}"`).toContain(p);
      }
      for (const p of actualParams) {
        expect(expectedParams, `Tool "${expected.name}" has unexpected param "${p}"`).toContain(p);
      }

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

describe('MCP Write Path (self-call to write router)', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ entity_id: 'test-sync-id', new_change_id: 1, server_timestamp: '2026-01-01T00:00:00Z', idempotency_replayed: false }), { status: 200 }))
    );
  });

  // 验证每个写工具调用的 write router 端点路径和请求体格式
  it('create_transaction should POST to /write/ledgers/{id}/transactions with snake_case body', async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    const env = { JWT_SECRET: 'test-secret' };
    const baseUrl = 'https://beecount.example.com';
    const userId = 'user-1';

    // 模拟 write router 的 create_transaction 请求体
    const body = {
      base_change_id: 0,
      tx_type: 'expense',
      amount: 100,
      happened_at: '2026-01-15T00:00:00',
      note: 'test note',
      category_name: '鲜花',
      category_kind: 'expense',
      account_name: '现金',
      tags: ['MCP', '鲜花'],
      currency_code: 'CNY',
    };

    await selfCall('POST', '/api/v1/write/ledgers/ledger-1/transactions', env, baseUrl, userId, body);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const call = mockFetch.mock.calls[0];
    const url = call[0] as string;
    const options = call[1] as RequestInit;

    // 验证 URL
    expect(url).toBe('https://beecount.example.com/api/v1/write/ledgers/ledger-1/transactions');

    // 验证方法
    expect(options.method).toBe('POST');

    // 验证请求体包含 snake_case 字段
    const sentBody = JSON.parse(options.body as string);
    expect(sentBody.base_change_id).toBe(0);
    expect(sentBody.tx_type).toBe('expense');
    expect(sentBody.amount).toBe(100);
    expect(sentBody.category_name).toBe('鲜花');
    expect(sentBody.category_kind).toBe('expense');
    expect(sentBody.account_name).toBe('现金');
    // 不使用 camelCase
    expect(sentBody.categoryName).toBeUndefined();
    expect(sentBody.accountName).toBeUndefined();

    // 验证 Authorization header
    const headers = options.headers as Record<string, string>;
    expect(headers['Authorization']).toMatch(/^Bearer /);
  });

  it('create_transactions should POST to /write/ledgers/{id}/transactions/batch', async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    const env = { JWT_SECRET: 'test-secret' };
    const baseUrl = 'https://beecount.example.com';

    const body = {
      base_change_id: 0,
      transactions: [
        { tx_type: 'expense', amount: 50, happened_at: '2026-01-15T00:00:00', category_name: '餐饮', account_name: '现金' },
        { tx_type: 'income', amount: 200, happened_at: '2026-01-15T00:00:00', category_name: '工资', account_name: '银行卡' },
      ],
      auto_ai_tag: false,
    };

    await selfCall('POST', '/api/v1/write/ledgers/ledger-1/transactions/batch', env, baseUrl, 'user-1', body);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toBe('https://beecount.example.com/api/v1/write/ledgers/ledger-1/transactions/batch');
  });

  it('update_transaction should PATCH to /write/ledgers/{id}/transactions/{syncId}', async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    const env = { JWT_SECRET: 'test-secret' };
    const baseUrl = 'https://beecount.example.com';

    await selfCall('PATCH', '/api/v1/write/ledgers/ledger-1/transactions/sync-123', env, baseUrl, 'user-1', { base_change_id: 0, amount: 150, note: 'updated' });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toBe('https://beecount.example.com/api/v1/write/ledgers/ledger-1/transactions/sync-123');
    expect(mockFetch.mock.calls[0][1]!.method).toBe('PATCH');
  });

  it('delete_transaction should DELETE to /write/ledgers/{id}/transactions/{syncId}', async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    const env = { JWT_SECRET: 'test-secret' };
    const baseUrl = 'https://beecount.example.com';

    await selfCall('DELETE', '/api/v1/write/ledgers/ledger-1/transactions/sync-123', env, baseUrl, 'user-1', { base_change_id: 0 });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toBe('https://beecount.example.com/api/v1/write/ledgers/ledger-1/transactions/sync-123');
    expect(mockFetch.mock.calls[0][1]!.method).toBe('DELETE');
  });

  it('create_category should POST to /write/ledgers/{id}/categories', async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    const env = { JWT_SECRET: 'test-secret' };
    const baseUrl = 'https://beecount.example.com';

    await selfCall('POST', '/api/v1/write/ledgers/ledger-1/categories', env, baseUrl, 'user-1', { base_change_id: 0, name: '交通', kind: 'expense', level: 1 });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toBe('https://beecount.example.com/api/v1/write/ledgers/ledger-1/categories');
  });

  it('update_budget should PATCH to /write/ledgers/{id}/budgets/{budgetId}', async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    const env = { JWT_SECRET: 'test-secret' };
    const baseUrl = 'https://beecount.example.com';

    await selfCall('PATCH', '/api/v1/write/ledgers/ledger-1/budgets/bgt-123', env, baseUrl, 'user-1', { base_change_id: 0, amount: 1000 });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toBe('https://beecount.example.com/api/v1/write/ledgers/ledger-1/budgets/bgt-123');
  });

  it('self-call should include Authorization header with Bearer token', async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    const env = { JWT_SECRET: 'test-secret' };
    const baseUrl = 'https://beecount.example.com';

    await selfCall('POST', '/api/v1/write/ledgers/l-1/transactions', env, baseUrl, 'user-1', { base_change_id: 0, tx_type: 'expense', amount: 10, happened_at: '2026-01-01T00:00:00' });

    const headers = mockFetch.mock.calls[0][1]!.headers as Record<string, string>;
    expect(headers['Authorization']).toMatch(/^Bearer /);
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('self-call should throw on non-OK response', async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(new Response('Bad Request', { status: 400 })));
    const env = { JWT_SECRET: 'test-secret' };
    const baseUrl = 'https://beecount.example.com';

    await expect(selfCall('POST', '/api/v1/write/ledgers/l-1/transactions', env, baseUrl, 'user-1', { base_change_id: 0 })).rejects.toThrow('Write request failed: 400');
  });
});

describe('MCP Protocol Version (2026-07-28)', () => {
  it('should have the latest protocol version', () => {
    expect(PROTOCOL_VERSION).toBe('2026-07-28');
  });

  it('should include the latest version in supported versions', () => {
    expect(SUPPORTED_VERSIONS).toContain(PROTOCOL_VERSION);
  });

  it('should support legacy versions for backward compatibility', () => {
    expect(SUPPORTED_VERSIONS).toContain('2024-11-05');
    expect(SUPPORTED_VERSIONS).toContain('2025-03-26');
    expect(SUPPORTED_VERSIONS).toContain('2025-06-18');
    expect(SUPPORTED_VERSIONS).toContain('2025-11-25');
  });

  it('should have a server info with name and version', () => {
    expect(SERVER_INFO.name).toBe('beecount-mcp');
    expect(SERVER_INFO.version).toBe('1.0.0');
  });
});