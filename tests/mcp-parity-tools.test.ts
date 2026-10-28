/**
 * 工具集契约回归：本地 MCP 工具清单必须覆盖上游全部工具，且读写 scope 一致。
 *
 * fixture 由脚本从上游源码自动提取（server.py 的 name=.../scope=... +
 * 各模块 READ_FUNCTIONS/WRITE_FUNCTIONS），不是手抄，避免"我以为对齐了"。
 * 以后本地新增/删除/改 scope 而上游没变，这里会直接红。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REGISTERED_TOOLS } from '../src/mcp/registry';
import { BASE_TOOL_NAMES, BASE_WRITE_TOOLS } from '../src/routes/mcp';

interface UpstreamTool { name: string; scope: 'read' | 'write'; module: string; kind: 'tool' | 'resource' }

const contract = JSON.parse(
  readFileSync(join(process.cwd(), 'tests/fixtures/upstream-mcp-tools.json'), 'utf8'),
) as { tool_count: number; tools: UpstreamTool[] };

function localScope(name: string): 'read' | 'write' | null {
  const registered = REGISTERED_TOOLS.find(t => t.name === name);
  if (registered) return registered.scope as 'read' | 'write';
  if (BASE_TOOL_NAMES.includes(name)) return BASE_WRITE_TOOLS.includes(name) ? 'write' : 'read';
  return null;
}

describe('MCP 工具集与上游一致', () => {
  it('fixture 自身可信（工具数 > 50，且无重复）', () => {
    expect(contract.tool_count).toBeGreaterThan(50);
    expect(new Set(contract.tools.map(t => t.name)).size).toBe(contract.tools.length);
  });

  it('上游每个工具本地都存在', () => {
    const missing = contract.tools
      .filter(t => t.kind === 'tool' && localScope(t.name) === null)
      .map(t => t.name);
    expect(missing).toEqual([]);
  });

  it('上游的 MCP 资源本地都有对应处理器', () => {
    const source = readFileSync(join(process.cwd(), 'src/routes/mcp.ts'), 'utf8');
    // read_attachment_resource / read_export_resource 在 resources/read 分支里处理
    expect(source).toContain('beecount://attachments/');
    expect(source).toContain('beecount://exports/');
  });

  it('上游每个工具的读写 scope 本地都一致', () => {
    const wrong = contract.tools
      .filter(t => t.kind === 'tool')
      .map(t => ({ name: t.name, upstream: t.scope, local: localScope(t.name) }))
      .filter(x => x.local !== null && x.local !== x.upstream);
    expect(wrong).toEqual([]);
  });

  it('本地没有上游不存在的多余工具', () => {
    const upstreamNames = new Set(contract.tools.filter(t => t.kind === 'tool').map(t => t.name));
    const extra = [
      ...REGISTERED_TOOLS.map(t => t.name),
      ...BASE_TOOL_NAMES,
    ].filter(n => !upstreamNames.has(n));
    expect([...new Set(extra)]).toEqual([]);
  });
});
