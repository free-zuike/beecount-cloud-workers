/**
 * two_factor 端点差分：用上游 golden（upstream-two-factor-golden.json）作基准。
 *
 * 由于 TOTP secret 由服务端随机生成，golden 与本地 replay 的 secret 必然不同，
 * 无法简单重放 code。故采用「结构比对」：golden 记录各步骤的状态码 + 响应结构
 * （已 scrub 掉 secret / qr_code_uri / recovery_codes / enabled_at 等随机/时间戳字段），
 * 本地测试自建完整 2FA 流程（用本地 secret 经 otpauth 计算 code）逐步骤比对。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as OTPAuth from 'otpauth';
import { buildTwoFactorApp, authTokenFor, routerEnv } from './mcp-harness';

const GOLDEN_PATH = join(process.cwd(), 'tests/fixtures/upstream-two-factor-golden.json');
const hasGolden = existsSync(GOLDEN_PATH);
const goldenData = hasGolden ? JSON.parse(readFileSync(GOLDEN_PATH, 'utf-8')) : { steps: [] };

// scrub 与 golden 生成端一致：剔除随机 secret / qr / recovery_codes / 时间戳 enabled_at
const VOLATILE = new Set(['secret', 'qr_code_uri', 'recovery_codes', 'enabled_at']);
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

interface Step { name: string; status: number; result: unknown; }

function step(name: string): Step {
  const s = (goldenData.steps ?? []).find((x: Step) => x.name === name);
  if (!s) throw new Error(`golden 缺少步骤: ${name}`);
  return s;
}

function totpCode(secret: string): string {
  const totp = new OTPAuth.TOTP({
    issuer: 'BeeCount',
    secret: OTPAuth.Secret.fromBase32(secret),
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
  });
  return totp.generate();
}

describe.skipIf(!hasGolden)('two_factor differential vs upstream', () => {
  const base = (userId: string, extra?: Record<string, string>) => ({ 'X-Test-User': userId, ...(extra ?? {}) });

  it('status_before: disabled', async () => {
    const env = routerEnv();
    const { userId } = await authTokenFor(env);
    const app = buildTwoFactorApp();
    const resp = await app.request('/api/v1/auth/2fa/status', { method: 'GET', headers: base(userId) }, env as never);
    expect(resp.status).toBe(step('status_before').status);
    expect(scrub(await resp.json())).toEqual(scrub(step('status_before').result));
  });

  it('setup returns expires_in and enables flow', async () => {
    const env = routerEnv();
    const { userId } = await authTokenFor(env);
    const app = buildTwoFactorApp();
    const resp = await app.request('/api/v1/auth/2fa/setup', { method: 'POST', headers: base(userId) }, env as never);
    expect(resp.status).toBe(step('setup').status);
    const body = await resp.json() as { secret: string; expires_in: number };
    expect(typeof body.secret).toBe('string');
    expect(scrub(body)).toEqual(scrub(step('setup').result));
    return body.secret;
  });

  it('confirm enables 2FA', async () => {
    const env = routerEnv();
    const { userId } = await authTokenFor(env);
    const app = buildTwoFactorApp();
    const setup = await app.request('/api/v1/auth/2fa/setup', { method: 'POST', headers: base(userId) }, env as never);
    const secret = (await setup.json() as { secret: string }).secret;
    const code = totpCode(secret);
    const resp = await app.request('/api/v1/auth/2fa/confirm', { method: 'POST', headers: { ...base(userId), 'content-type': 'application/json' }, body: JSON.stringify({ code }) }, env as never);
    expect(resp.status).toBe(step('confirm').status);
    expect(scrub(await resp.json())).toEqual(scrub(step('confirm').result));
  });

  it('status_enabled: enabled', async () => {
    const env = routerEnv();
    const { userId } = await authTokenFor(env);
    const app = buildTwoFactorApp();
    await app.request('/api/v1/auth/2fa/setup', { method: 'POST', headers: base(userId) }, env as never);
    const setup = await app.request('/api/v1/auth/2fa/setup', { method: 'POST', headers: base(userId) }, env as never);
    const secret = (await setup.json() as { secret: string }).secret;
    await app.request('/api/v1/auth/2fa/confirm', { method: 'POST', headers: { ...base(userId), 'content-type': 'application/json' }, body: JSON.stringify({ code: totpCode(secret) }) }, env as never);
    const resp = await app.request('/api/v1/auth/2fa/status', { method: 'GET', headers: base(userId) }, env as never);
    expect(resp.status).toBe(step('status_enabled').status);
    expect(scrub(await resp.json())).toEqual(scrub(step('status_enabled').result));
  });

  it('disable turns 2FA off', async () => {
    const env = routerEnv();
    const { userId } = await authTokenFor(env);
    const app = buildTwoFactorApp();
    await app.request('/api/v1/auth/2fa/setup', { method: 'POST', headers: base(userId) }, env as never);
    const setup = await app.request('/api/v1/auth/2fa/setup', { method: 'POST', headers: base(userId) }, env as never);
    const secret = (await setup.json() as { secret: string }).secret;
    await app.request('/api/v1/auth/2fa/confirm', { method: 'POST', headers: { ...base(userId), 'content-type': 'application/json' }, body: JSON.stringify({ code: totpCode(secret) }) }, env as never);
    const resp = await app.request('/api/v1/auth/2fa/disable', { method: 'POST', headers: { ...base(userId), 'content-type': 'application/json' }, body: JSON.stringify({ password: 'password123' }) }, env as never);
    expect(resp.status).toBe(step('disable').status);
    expect(scrub(await resp.json())).toEqual(scrub(step('disable').result));
  });

  it('status_after: disabled again', async () => {
    const env = routerEnv();
    const { userId } = await authTokenFor(env);
    const app = buildTwoFactorApp();
    await app.request('/api/v1/auth/2fa/setup', { method: 'POST', headers: base(userId) }, env as never);
    const setup = await app.request('/api/v1/auth/2fa/setup', { method: 'POST', headers: base(userId) }, env as never);
    const secret = (await setup.json() as { secret: string }).secret;
    await app.request('/api/v1/auth/2fa/confirm', { method: 'POST', headers: { ...base(userId), 'content-type': 'application/json' }, body: JSON.stringify({ code: totpCode(secret) }) }, env as never);
    await app.request('/api/v1/auth/2fa/disable', { method: 'POST', headers: { ...base(userId), 'content-type': 'application/json' }, body: JSON.stringify({ password: 'password123' }) }, env as never);
    const resp = await app.request('/api/v1/auth/2fa/status', { method: 'GET', headers: base(userId) }, env as never);
    expect(resp.status).toBe(step('status_after').status);
    expect(scrub(await resp.json())).toEqual(scrub(step('status_after').result));
  });
});
