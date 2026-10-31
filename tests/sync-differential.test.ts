/**
 * sync/pull 响应差分（客户端增量同步协议）。
 *
 * 这是最关键的客户端兼容面：App 按 cursor 拉 SyncChange，响应结构
 * （changes[change_id, ledger_id, entity_type, entity_sync_id, action, payload,
 * updated_at, updated_by_device_id, scope] + server_cursor + has_more）若与上游
 * 不一致，App 直接坏。
 *
 * 做法：两侧插同一条 change（transaction + category，snake_case payload），
 * 然后用各自真实实现拉 pull，比归一化后的响应。归一化只丢 server_cursor /
 * change_id（游标类易变字段），其余逐字段比对，payload 原样透传（不丢字段、
 * 不变 camel/snake）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeHarness, seed, buildSyncApp, seedSync } from './mcp-harness';

const GOLDEN_PATH = join(process.cwd(), 'tests/fixtures/upstream-sync-golden.json');

// 若 golden 尚未生成（首次 CI 前本地），跳过而不是崩，避免误导。
const golden = existsSync(GOLDEN_PATH)
  ? JSON.parse(readFileSync(GOLDEN_PATH, 'utf-8'))
  : null;

type Json = Record<string, any>;

/** 把各种日期表征归一到 UTC 秒级字符串，避免 naive/时区/Z/空格差异。
 * 关键点：上游 datetime 存的是 UTC，但 SQLite 不存时区，model_dump 出来的裸时间戳
 * 没有 Z；workers 存的是带 Z 的 UTC。两者都必须按 UTC 解释，否则在非 UTC 本地
 * 时区下会分叉（CI 在 UTC 上巧合一致、本地却失败）。 */
function normDt(v: unknown): string | null {
  if (!v) return null;
  let s = String(v).replace(' ', 'T');
  if (!/[Zz]$/.test(s) && !/[+\-]\d{2}:?\d{2}$/.test(s)) {
    s = s + 'Z';
  }
  const d = new Date(s);
  if (isNaN(d.getTime())) return String(v);
  return d.toISOString().replace(/\.\d+Z$/, '');
}

function normalizeChange(c: Json): Json {
  const payload = typeof c.payload === 'string' ? JSON.parse(c.payload) : c.payload;
  return {
    entity_type: c.entity_type,
    entity_sync_id: c.entity_sync_id,
    action: c.action,
    scope: c.scope,
    ledger_id: c.ledger_id,
    updated_by_device_id: c.updated_by_device_id ?? null,
    updated_at: normDt(c.updated_at),
    payload,
  };
}

function normalizeSync(resp: Json): Json {
  const changes = (resp.changes || [])
    .map(normalizeChange)
    .sort((a: Json, b: Json) =>
      `${a.entity_type}/${a.entity_sync_id}/${a.action}`.localeCompare(
        `${b.entity_type}/${b.entity_sync_id}/${b.action}`,
      ),
    );
  return { has_more: resp.has_more, changes };
}

const serialize = (v: unknown) => JSON.stringify(v);

describe('sync/pull 响应差分（与上游 golden 对比）', () => {
  const run = golden ? it : it.skip;

  run('pull 响应（信封 + change 结构 + payload 原样透传）与上游一致', async () => {
    const h = makeHarness();
    seed(h);
    seedSync(h);
    const app = buildSyncApp();
    const res = await app.request(
      '/api/v1/sync/pull?since=0',
      { method: 'GET', headers: { 'X-Test-User': 'u1' } },
      { DB: h.db, JWT_SECRET: 'test-secret' },
    );
    expect(res.status).toBe(200);
    const local = normalizeSync(await res.json());
    const want = normalizeSync(golden);
    expect(serialize(local)).toEqual(serialize(want));
  });

  run('transaction payload 保持上游 snake_case 字段（tx_type/happened_at/createdByUserId）', async () => {
    const h = makeHarness();
    seed(h);
    seedSync(h);
    const app = buildSyncApp();
    const res = await app.request(
      '/api/v1/sync/pull?since=0',
      { method: 'GET', headers: { 'X-Test-User': 'u1' } },
      { DB: h.db, JWT_SECRET: 'test-secret' },
    );
    const body = (await res.json()) as Json;
    const tx = body.changes.find((c: Json) => c.entity_type === 'transaction');
    expect(tx).toBeTruthy();
    const p = typeof tx.payload === 'string' ? JSON.parse(tx.payload) : tx.payload;
    expect(p.tx_type).toBe('expense');
    expect(p.happened_at).toBe('2026-05-16T03:30:00Z');
    expect(p.createdByUserId).toBe('u1');
    expect(p.updatedByUserId).toBe('u1');
  });
});
