/**
 * attachments 端点差分：用上游 golden（upstream-attachments-golden.json）作基准，
 * 与本地 Hono attachments 路由（真实实现）比对。
 *
 * 覆盖：upload（multipart，需内存 R2）/ batch-exists 命中 / batch-exists 未命中。
 * 比对排除：file_id（随机 uuid）、created_at（时间相关）。其余确定性字段
 * （ledger_id / sha256 / size / mime_type / exists 等）逐项比对。
 *
 * 注：上游无 /exists（本地独有），故不纳入对拍。download/thumbnail 返回二进制，
 * 且依赖存储原图，golden 难以稳定比对，亦不纳入（属平台适配，已在 batch-exists 覆盖读路径）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeHarness, registerUser, createLedger, makeMockR2, buildRouterApp, insertRow } from './mcp-harness';
import attachmentsRouter from '../src/routes/attachments';

const GOLDEN_PATH = join(process.cwd(), 'tests/fixtures/upstream-attachments-golden.json');
const hasGolden = existsSync(GOLDEN_PATH);
const goldenData = hasGolden ? JSON.parse(readFileSync(GOLDEN_PATH, 'utf-8')) : { steps: [] };

const goldenSteps: Record<string, { status: number; result: unknown }> = {};
for (const s of (goldenData.steps ?? []) as Array<{ name: string; status: number; result: unknown }>) {
  goldenSteps[s.name] = { status: s.status, result: s.result };
}

const VOLATILE = new Set(['file_id', 'created_at']);
function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (VOLATILE.has(k)) continue;
      out[k] = scrub(v);
    }
    return out;
  }
  return value;
}

const CONTENT = new TextEncoder().encode('hello attachment content');
const LEDGER_INT = 'ATT-L1-i';
const LEDGER_EXT = 'L1';

describe.skipIf(!hasGolden)('attachments differential vs upstream', () => {
  it('upload', async () => {
    const h = makeHarness();
    registerUser(h, 'u1', 'u1@example.com');
    createLedger(h, 'u1', LEDGER_INT, LEDGER_EXT, '主账本', 'CNY');
    const app = buildRouterApp(attachmentsRouter as never, '/api/v1/attachments', h.db);
    const r2 = makeMockR2();
    const fd = new FormData();
    fd.set('file', new File([CONTENT], 'seed.csv', { type: 'text/csv' }));
    fd.set('ledger_id', LEDGER_EXT);
    const resp = await app.request('/api/v1/attachments/upload', {
      method: 'POST',
      headers: { 'X-Test-User': 'u1' },
      body: fd,
    }, { DB: h.db, JWT_SECRET: 'test-secret-for-parity-0123456789', R2: r2 } as never);
    const status = resp.status;
    const body = scrub(await resp.json().catch(() => null));
    expect(status).toBe(goldenSteps['upload'].status);
    expect(body).toEqual(scrub(goldenSteps['upload'].result));
  });

  it('batch_exists_hit', async () => {
    const h = makeHarness();
    registerUser(h, 'u1', 'u1@example.com');
    createLedger(h, 'u1', LEDGER_INT, LEDGER_EXT, '主账本', 'CNY');
    const sha = await crypto.subtle.digest('SHA-256', CONTENT);
    const shaHex = Array.from(new Uint8Array(sha)).map(b => b.toString(16).padStart(2, '0')).join('');
    insertRow(h.sqlite, 'attachment_files', {
      id: 'att-hit', ledger_id: LEDGER_INT, user_id: 'u1', sha256: shaHex,
      size_bytes: CONTENT.length, mime_type: 'text/csv', file_name: 'seed.csv',
      storage_path: `attachments/${LEDGER_EXT}/att-hit_seed.csv`, attachment_kind: 'transaction',
      created_at: '2026-01-01T00:00:00Z',
    });
    const app = buildRouterApp(attachmentsRouter as never, '/api/v1/attachments', h.db);
    const resp = await app.request('/api/v1/attachments/batch-exists', {
      method: 'POST',
      headers: { 'X-Test-User': 'u1', 'content-type': 'application/json' },
      body: JSON.stringify({ ledger_id: LEDGER_EXT, sha256_list: [shaHex] }),
    }, { DB: h.db, JWT_SECRET: 'test-secret-for-parity-0123456789' } as never);
    const status = resp.status;
    const body = scrub(await resp.json().catch(() => null));
    expect(status).toBe(goldenSteps['batch_exists_hit'].status);
    expect(body).toEqual(scrub(goldenSteps['batch_exists_hit'].result));
  });

  it('batch_exists_miss', async () => {
    const h = makeHarness();
    registerUser(h, 'u1', 'u1@example.com');
    createLedger(h, 'u1', LEDGER_INT, LEDGER_EXT, '主账本', 'CNY');
    const app = buildRouterApp(attachmentsRouter as never, '/api/v1/attachments', h.db);
    const resp = await app.request('/api/v1/attachments/batch-exists', {
      method: 'POST',
      headers: { 'X-Test-User': 'u1', 'content-type': 'application/json' },
      body: JSON.stringify({ ledger_id: LEDGER_EXT, sha256_list: ['deadbeef'.repeat(8)] }),
    }, { DB: h.db, JWT_SECRET: 'test-secret-for-parity-0123456789' } as never);
    const status = resp.status;
    const body = scrub(await resp.json().catch(() => null));
    expect(status).toBe(goldenSteps['batch_exists_miss'].status);
    expect(body).toEqual(scrub(goldenSteps['batch_exists_miss'].result));
  });
});
