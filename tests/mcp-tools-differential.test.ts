/**
 * MCP tools/list 目录差分测试（golden 来自上游 FastMCP 注册表，CI 生成
 * tests/fixtures/upstream-mcp-tools-golden.json）。
 *
 * 上游用官方 FastMCP SDK，其 tools/list 的工具目录由 SDK 注册生成；本地手搓 Streamable
 * transport 的 tools/list 必须与之对齐。比对：
 *  - 工具名集合（严格：缺失/多余/改名都算漂移，最高价值）；
 *  - 每个工具的 inputSchema 属性名（严格、递归）：顶层属性名严格；对带 data 信封的工具
 *    （save_review_item / save_classification_rule / manage_recurring_rule）下钻 data
 *    及其子对象（如 RecurringRule.transaction = BatchTransactionItem），逐层比属性名。
 *    不豁免任何 data 信封工具。
 *  - schema 生成器差异只比属性「名」（不比类型/约束/$defs/required/description）。
 * 注：description 本地移植时改写/增强（如 list_transactions 增补 cursor 说明），属有意
 * 演进，不纳入严格比对。工具「调用」的功能级对拍已由 tests/mcp-differential.test.ts 覆盖。
 *
 * 握手/版本协商/header 校验/通知 202 由 tests/mcp-streamable-contract.test.ts 覆盖。
 * 工具「调用结果」已由 tests/mcp-differential.test.ts 对上游 golden 覆盖。
 *
 * 本地无 golden 时 skip（不假装通过）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeHarness, seed, buildRouterApp } from './mcp-harness';
import mcpRouter from '../src/routes/mcp';

const GOLDEN_PATH = join(process.cwd(), 'tests/fixtures/upstream-mcp-tools-golden.json');
const hasGolden = existsSync(GOLDEN_PATH);
const golden: { tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> } =
  hasGolden ? JSON.parse(readFileSync(GOLDEN_PATH, 'utf-8')) : { tools: [] };

const TOKEN = 'bcmcp_test_token_tools_0123456789abcdef';
async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function app(h: ReturnType<typeof makeHarness>) {
  return buildRouterApp(mcpRouter as never, '/api/v1/mcp', h.db);
}

/** 解析 $ref / anyOf|oneOf 到实际对象（FastMCP 用 $defs 内联 Pydantic 模型）。 */
function resolveSchema(s: any, defs: Record<string, any>): any {
  let cur = s;
  let guard = 0;
  while (cur && guard++ < 20) {
    if (typeof cur.$ref === 'string') {
      const name = cur.$ref.split('/').pop();
      cur = defs[name];
      continue;
    }
    if (Array.isArray(cur.anyOf) || Array.isArray(cur.oneOf)) {
      const arr = cur.anyOf || cur.oneOf;
      const hit = arr.find((m: any) => m && (typeof m.$ref === 'string' || (m.properties && typeof m.properties === 'object')));
      if (hit) { cur = hit; continue; }
    }
    break;
  }
  return cur;
}

/** 取（已解析的）schema 的 properties 对象；无则返回 null。 */
function propsOf(resolved: any): Record<string, any> | null {
  if (resolved && resolved.properties && typeof resolved.properties === 'object') {
    return resolved.properties;
  }
  return null;
}

/** 递归比对：顶层属性名严格；对 data 信封下钻 data 及其子对象（不豁免 recurring）。 */
function diffToolSchema(
  name: string,
  lSchema: any, lDefs: Record<string, any>,
  uSchema: any, uDefs: Record<string, any>,
  mismatches: string[],
  path = '',
): void {
  const lr = resolveSchema(lSchema, lDefs);
  const ur = resolveSchema(uSchema, uDefs);
  const lProps = propsOf(lr);
  const uProps = propsOf(ur);
  const lKeys = lProps ? Object.keys(lProps).sort() : null;
  const uKeys = uProps ? Object.keys(uProps).sort() : null;
  if (lKeys && uKeys) {
    if (JSON.stringify(lKeys) !== JSON.stringify(uKeys)) {
      mismatches.push(`${name}${path}: 属性名 ${JSON.stringify(lKeys)} != ${JSON.stringify(uKeys)}`);
    } else if (path === '' || path.endsWith('.data')) {
      // 进入/已在 data 信封：继续下钻所有子对象（如 RecurringRule.transaction）。
      for (const k of lKeys) {
        const descend = path === '' ? k === 'data' : true;
        if (!descend) continue;
        diffToolSchema(name, lProps![k], lDefs, uProps![k], uDefs, mismatches, `${path}.${k}`);
      }
    }
  } else if (lKeys !== uKeys) {
    mismatches.push(`${name}${path}: 一侧缺少 properties（local=${lKeys}, upstream=${uKeys}）`);
  }
}

describe.skipIf(!hasGolden)('mcp tools/list catalog differential vs upstream', () => {
  async function seedPat(h: ReturnType<typeof makeHarness>): Promise<string> {
    const hash = await sha256Hex(TOKEN);
    h.sqlite.prepare(
      `INSERT INTO personal_access_tokens (id, user_id, name, token_hash, scopes_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('pat-tools', 'u1', 'test', hash, JSON.stringify(['mcp:read', 'mcp:write']), '2026-05-20T04:00:00Z');
    return TOKEN;
  }

  it('工具名集合与上游一致', async () => {
    const h = makeHarness();
    seed(h);
    const token = await seedPat(h);
    const res = await app(h).request('/api/v1/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token}`,
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/list',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/list',
        params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } },
      }),
    }, { DB: h.db, JWT_SECRET: 'test-secret' } as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { tools: Array<{ name: string }> } };
    const localNames = body.result.tools.map((t) => t.name).sort();
    const goldenNames = golden.tools.map((t) => t.name).sort();
    expect(localNames).toEqual(goldenNames);
  });

  it('每个工具 name + inputSchema 属性名（递归 data 信封）与上游一致', async () => {
    const h = makeHarness();
    seed(h);
    const token = await seedPat(h);
    const res = await app(h).request('/api/v1/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token}`,
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/list',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'tools/list',
        params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } },
      }),
    }, { DB: h.db, JWT_SECRET: 'test-secret' } as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> } };
    const localTools = new Map(body.result.tools.map((t) => [t.name, t]));
    const mismatches: string[] = [];
    for (const gt of golden.tools) {
      const lt = localTools.get(gt.name);
      expect(lt, `本地缺少工具 ${gt.name}`).toBeDefined();
      const uDefs = (gt.inputSchema?.$defs as Record<string, any>) || {};
      diffToolSchema(gt.name, lt!.inputSchema, {}, gt.inputSchema, uDefs, mismatches);
    }
    expect(mismatches, `inputSchema 漂移:\n${mismatches.join('\n')}`).toEqual([]);
  });
});
