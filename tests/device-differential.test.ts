/**
 * device LIST（GET /devices）与 REVOKE（POST /devices/:id/revoke）响应差分。
 *
 * 设备登录时自动创建、没有请求体，所以这里比「响应」而非「请求」。比对两侧的
 * DeviceOut 字段集与值（id/name/platform/版本信息/last_seen_at/created_at/session_count），
 * 以及 revoke 端点的 ok + device_id。日期归一到 UTC 秒级（时区无关）。
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeHarness, seed, buildDevicesApp, seedDevice } from './mcp-harness';

const GOLDEN_PATH = join(process.cwd(), 'tests/fixtures/upstream-device-golden.json');
const golden = existsSync(GOLDEN_PATH) ? JSON.parse(readFileSync(GOLDEN_PATH, 'utf-8')) : null;

type Json = Record<string, any>;

function normDt(v: unknown): string | null {
  if (!v) return null;
  let s = String(v).replace(' ', 'T');
  if (!/[Zz]$/.test(s) && !/[+\-]\d{2}:?\d{2}$/.test(s)) s = s + 'Z';
  const d = new Date(s);
  if (isNaN(d.getTime())) return String(v);
  return d.toISOString().replace(/\.\d+Z$/, '');
}

// DeviceOut 字段集（上游与 workers 必须一致）
const DEVICE_OUT_FIELDS = [
  'id', 'name', 'platform', 'app_version', 'os_version', 'device_model',
  'last_ip', 'last_seen_at', 'created_at', 'session_count',
];

function normalizeDevice(d: Json): Json {
  const out: Json = {};
  for (const f of DEVICE_OUT_FIELDS) out[f] = f === 'last_seen_at' || f === 'created_at' ? normDt(d[f]) : d[f];
  return out;
}

function normalizeList(list: Json[]): Json[] {
  return list.map(normalizeDevice).sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

describe('device LIST 响应差分（与上游 golden 对比）', () => {
  const run = golden ? it : it.skip;

  run('GET /devices 响应（DeviceOut 字段集 + 值）与上游一致', async () => {
    const h = makeHarness();
    seed(h);
    seedDevice(h);
    const app = buildDevicesApp();
    const res = await app.request(
      '/api/v1/devices?view=sessions&active_within_days=73000',
      { method: 'GET', headers: { 'X-Test-User': 'u1' } },
      { DB: h.db, JWT_SECRET: 'test-secret' },
    );
    expect(res.status).toBe(200);
    const local = normalizeList((await res.json()) as Json[]);
    const want = normalizeList(golden.list as Json[]);
    expect(JSON.stringify(local)).toEqual(JSON.stringify(want));
  });

  run('DeviceOut 字段集完整（无缺漏/无多余，与上游 DeviceOut 对齐）', async () => {
    const h = makeHarness();
    seed(h);
    seedDevice(h);
    const app = buildDevicesApp();
    const res = await app.request(
      '/api/v1/devices?view=sessions&active_within_days=73000',
      { method: 'GET', headers: { 'X-Test-User': 'u1' } },
      { DB: h.db, JWT_SECRET: 'test-secret' },
    );
    const body = (await res.json()) as Json[];
    expect(body.length).toBeGreaterThan(0);
    const keys = Object.keys(body[0]).sort();
    expect(keys).toEqual([...DEVICE_OUT_FIELDS].sort());
  });

  run('POST /devices/:id/revoke 撤销设备（ok + device_id）与上游一致', async () => {
    const h = makeHarness();
    seed(h);
    seedDevice(h);
    const app = buildDevicesApp();
    const res = await app.request(
      '/api/v1/devices/dev-1/revoke',
      { method: 'POST', headers: { 'X-Test-User': 'u1' } },
      { DB: h.db, JWT_SECRET: 'test-secret' },
    );
    expect(res.status).toBe(golden.revoke.status);
    expect(await res.json()).toEqual(golden.revoke.result);
  });
});

// 幂等性（本地行为，对齐上游）：对已撤销设备重复 revoke 仍返回 200（不回退为 404）。
describe('device REVOKE 幂等性（对齐上游，无需 golden）', () => {
  it('重复 revoke 同一设备仍返回 200', async () => {
    const h = makeHarness();
    seed(h);
    seedDevice(h);
    const app = buildDevicesApp();
    const first = await app.request(
      '/api/v1/devices/dev-1/revoke',
      { method: 'POST', headers: { 'X-Test-User': 'u1' } },
      { DB: h.db, JWT_SECRET: 'test-secret' },
    );
    expect(first.status).toBe(200);
    const second = await app.request(
      '/api/v1/devices/dev-1/revoke',
      { method: 'POST', headers: { 'X-Test-User': 'u1' } },
      { DB: h.db, JWT_SECRET: 'test-secret' },
    );
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true, device_id: 'dev-1' });
  });

  it('revoke 不存在的设备返回 404', async () => {
    const h = makeHarness();
    seed(h);
    const app = buildDevicesApp();
    const res = await app.request(
      '/api/v1/devices/nope/revoke',
      { method: 'POST', headers: { 'X-Test-User': 'u1' } },
      { DB: h.db, JWT_SECRET: 'test-secret' },
    );
    expect(res.status).toBe(404);
  });
});
