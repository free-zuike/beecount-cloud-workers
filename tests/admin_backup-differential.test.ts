/**
 * admin_backup 端点差分：用上游 golden（upstream-admin-backup-golden.json）作基准，
 * 与本地 Hono admin_backup 路由（真实实现）比对。
 *
 * 覆盖（只读聚合，种子对齐下确定性）：
 *  - /remotes：备份远端列表（scrub config(local 独有) / created_at / updated_at）
 *  - /schedules：备份计划列表（scrub timezone_offset(local 独有) / created_at / updated_at）
 *
 * 比对排除（本地扩展 / tz 尾差，非语义分歧）：
 *  - config：本地在 list 端点额外返回一份（由 config_summary 派生、并 mask 密码/密钥字段），上游无此字段
 *  - timezone_offset：本地 schedule 额外返回（调度不再存时区，统一 0），上游无此字段
 *  - created_at / updated_at：上游经 _utc 标 +00:00，本地原样返回字符串，tz 尾差
 *
 * 注：test_remote(rclone) / run_schedule_now(request.app.state) / prepare-restore(磁盘)
 * 依赖外部，不在对拍范围。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeHarness, seed, buildRouterApp } from './mcp-harness';
import adminBackupRouter from '../src/routes/admin_backup';

const GOLDEN_PATH = join(process.cwd(), 'tests/fixtures/upstream-admin-backup-golden.json');
const hasGolden = existsSync(GOLDEN_PATH);
const goldenData = hasGolden ? JSON.parse(readFileSync(GOLDEN_PATH, 'utf-8')) : { cases: [] };

const goldenCases: Record<string, { status: number; result: unknown }> = {};
for (const c of (goldenData.cases ?? []) as Array<{ name: string; status: number; result: unknown }>) {
  goldenCases[c.name] = { status: c.status, result: c.result };
}

const NOW = '2026-05-20T04:00:00Z';

const VOLATILE = new Set(['config', 'timezone_offset', 'created_at', 'updated_at']);
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

/** 注入与 golden 同内容的备份行（remote + schedule + M2M）。 */
function seedBackup(h: ReturnType<typeof makeHarness>): void {
  h.sqlite.prepare(
    `INSERT INTO backup_remotes (id, user_id, name, backend_type, config_summary, encrypted, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(1, 'u1', 'R2', 's3',
    JSON.stringify({ provider: 'Cloudflare', region: 'auto', bucket: 'beecount-test' }),
    0, NOW, NOW);
  h.sqlite.prepare(
    `INSERT INTO backup_schedules (id, user_id, name, cron_expr, retention_days, include_attachments, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(1, 'u1', 'nightly', '0 4 * * *', 30, 1, 1, NOW, NOW);
  h.sqlite.prepare(
    `INSERT INTO backup_schedule_remotes (schedule_id, remote_id, sort_order) VALUES (?, ?, ?)`
  ).run(1, 1, 0);
}

function app(h: ReturnType<typeof makeHarness>) {
  return buildRouterApp(adminBackupRouter as never, '/api/v1/admin/backup', h.db);
}

describe.skipIf(!hasGolden)('admin_backup differential vs upstream', () => {
  it('list_remotes', async () => {
    const h = makeHarness();
    seed(h);
    h.sqlite.prepare('UPDATE users SET is_admin=1 WHERE id=?').run('u1');
    seedBackup(h);
    const res = await app(h).request('/api/v1/admin/backup/remotes', {
      method: 'GET',
      headers: { 'X-Test-User': 'u1' },
    }, { DB: h.db, JWT_SECRET: 'test-secret' } as never);
    expect(res.status).toBe(goldenCases['list_remotes'].status);
    const body = scrub(await res.json());
    expect(body).toEqual(scrub(goldenCases['list_remotes'].result));
  });

  it('list_schedules', async () => {
    const h = makeHarness();
    seed(h);
    h.sqlite.prepare('UPDATE users SET is_admin=1 WHERE id=?').run('u1');
    seedBackup(h);
    const res = await app(h).request('/api/v1/admin/backup/schedules', {
      method: 'GET',
      headers: { 'X-Test-User': 'u1' },
    }, { DB: h.db, JWT_SECRET: 'test-secret' } as never);
    expect(res.status).toBe(goldenCases['list_schedules'].status);
    const body = scrub(await res.json());
    expect(body).toEqual(scrub(goldenCases['list_schedules'].result));
  });
});
