/**
 * mcp_calls 的运行时差分：本地 /api/v1/mcp-calls vs 上游 Python golden。
 *
 * golden 由 scripts/parity/upstream_dump.py 额外产出（upstream-mcp-calls-golden.json），
 * 调用上游 src.routers.mcp_calls.list_mcp_calls（先插 PAT + 两条 MCPCallLog）。
 * 本地侧复用 route-harness 造同样的数据并打同样的路由。
 *
 * 文件缺失时 skip（见 parity.yml 先生成再测试）。
 *
 * 注意：本地路由额外返回上游契约没有的 `pat_name`（冗余，client_label 已承载名字），
 * 本地侧 normalize 剥掉它，避免假分歧。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import mcpCallsRouter from '../src/routes/mcp_calls';
import { createAccessToken } from '../src/auth';
import {
  createRouteDb, insertUser, insertPat, insertCallLog, withAuth, ROUTE_JWT_SECRET,
} from './helpers/route-harness';
import { diffJson, formatDiffs, type Json } from './parity-compare';

const GOLDEN_PATH = join(process.cwd(), 'tests/fixtures/upstream-mcp-calls-golden.json');

interface McCase { name: string; status: number; result?: Json }

const hasGolden = existsSync(GOLDEN_PATH);
const golden: { cases: McCase[] } = hasGolden
  ? JSON.parse(readFileSync(GOLDEN_PATH, 'utf-8'))
  : { cases: [] };

// 与上游契约对齐：剥 id / called_at(时区尾差) / duration_ms(运行时抖动)；
// pat_name 是本地路由多返回的冗余字段，亦剥除。
const MC_DROP = new Set(['id', 'called_at', 'duration_ms', 'pat_name']);

function normalizeMc(value: Json): Json {
  if (Array.isArray(value)) return value.map(normalizeMc);
  if (value && typeof value === 'object') {
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(value as Record<string, Json>)) {
      if (MC_DROP.has(k)) continue;
      out[k] = normalizeMc(v);
    }
    return out;
  }
  return value;
}

function makeApp(db: D1Database): Hono {
  const app = new Hono();
  withAuth(app);
  app.route('/api/v1/mcp-calls', mcpCallsRouter);
  return app;
}

async function auth(userId = 'u1'): Promise<Record<string, string>> {
  return { Authorization: `Bearer ${await createAccessToken(userId, ROUTE_JWT_SECRET, ['app_write'])}` };
}

function envOf(db: D1Database) {
  return { DB: db, JWT_SECRET: ROUTE_JWT_SECRET } as any;
}

describe.skipIf(!hasGolden)('mcp_calls vs 上游 golden', () => {
  it('fixtures 已生成', () => {
    expect(hasGolden).toBe(true);
  });

  for (const c of golden.cases) {
    it(c.name, async () => {
      const { sqlite, db } = createRouteDb();
      insertUser(sqlite, 'u1');
      insertPat(sqlite, 'pat-1', 'My Client');
      insertCallLog(sqlite, {
        user_id: 'u1', pat_id: 'pat-1', pat_prefix: 'pat_', pat_name: 'Old',
        tool_name: 'search_transactions', status: 'ok', error_message: null, args_summary: '{}',
        duration_ms: 12, client_ip: '1.2.3.4', called_at: '2026-05-20T03:00:00Z',
      });
      insertCallLog(sqlite, {
        user_id: 'u1', pat_id: null, pat_prefix: null, pat_name: null,
        tool_name: 'get_transaction', status: 'error', error_message: 'boom', args_summary: '{}',
        duration_ms: 5, client_ip: '1.2.3.4', called_at: '2026-05-20T04:00:00Z',
      });
      const app = makeApp(db);
      const res = await app.request('/api/v1/mcp-calls', { headers: await auth() }, envOf(db));
      expect(res.status).toBe(200);
      const local = (await res.json()) as unknown as Json;
      const diffs = diffJson(normalizeMc(c.result ?? {}), normalizeMc(local));
      if (diffs.length) throw new Error(formatDiffs(c.name, diffs));
      expect(diffs.length).toBe(0);
    });
  }
});
