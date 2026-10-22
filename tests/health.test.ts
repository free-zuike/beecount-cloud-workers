import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index';
import { createRealDb } from './helpers/realsql-db';

// 移植上游 tests/test_health.py:
// GET /healthz → 200 {status:"ok"};GET /ready → 200 {status:"ready"}(需 DB 查询成功)。
let db: D1Database;

beforeEach(() => {
  const real = createRealDb();
  db = real.db;
});

describe('健康探针(移植上游 test_health.py)', () => {
  it('GET /healthz → 200 status=ok', async () => {
    const res = await app.request('/healthz', {}, { DB: db, JWT_SECRET: 'x' } as any);
    expect(res.status).toBe(200);
    expect((await res.json() as any).status).toBe('ok');
  });

  it('GET /ready → 200 status=ready(DB 可查询)', async () => {
    const res = await app.request('/ready', {}, { DB: db, JWT_SECRET: 'x' } as any);
    expect(res.status).toBe(200);
    expect((await res.json() as any).status).toBe('ready');
  });
});