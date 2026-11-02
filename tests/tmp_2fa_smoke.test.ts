import { describe, it } from 'vitest';
import { buildTwoFactorApp, authTokenFor, routerEnv } from './mcp-harness';
import * as OTPAuth from 'otpauth';

function totpCode(secret: string): string {
  return new OTPAuth.TOTP({ issuer: 'BeeCount', secret: OTPAuth.Secret.fromBase32(secret), algorithm: 'SHA1', digits: 6, period: 30 }).generate();
}

describe('tmp 2fa smoke', () => {
  it('status_after exact sequence', async () => {
    const env = routerEnv();
    const { accessToken } = await authTokenFor(env);
    const app = buildTwoFactorApp();
    const h = (extra?: Record<string, string>) => ({ Authorization: `Bearer ${accessToken}`, ...(extra ?? {}) });
    const s1 = await app.request('/api/v1/auth/2fa/setup', { method: 'POST', headers: h() }, env as never);
    const s2 = await app.request('/api/v1/auth/2fa/setup', { method: 'POST', headers: h() }, env as never);
    const secret = (await s2.json() as any).secret;
    console.log('secret2?', !!secret);
    const conf = await app.request('/api/v1/auth/2fa/confirm', { method: 'POST', headers: h({ 'content-type': 'application/json' }), body: JSON.stringify({ code: totpCode(secret) }) }, env as never);
    console.log('confirm', conf.status, await conf.text());
    const dis = await app.request('/api/v1/auth/2fa/disable', { method: 'POST', headers: h({ 'content-type': 'application/json' }), body: JSON.stringify({ password: 'password123', code: totpCode(secret) }) }, env as never);
    console.log('disable', dis.status, await dis.text());
    const st = await app.request('/api/v1/auth/2fa/status', { method: 'GET', headers: h() }, env as never);
    console.log('status_after', st.status, await st.text());
  });
});
