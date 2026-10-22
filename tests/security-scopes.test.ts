import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createAccessToken, createRefreshToken } from '../src/auth';

// 移植上游 tests/test_security_scopes.py:
// token 含 sub/type/scopes/client_type;并补本地契约:scopes 为空时不写该 claim(2FA challenge token)。
const decode = (t: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString());

describe('token claims(移植上游 test_security_scopes.py)', () => {
  it('access token 含 sub/type=access/scopes/client_type', async () => {
    const token = await createAccessToken('user-1', 'test-secret', ['app_write'], 3600, 'access', 'app');
    const p = decode(token);
    expect(p.sub).toBe('user-1');
    expect(p.type).toBe('access');
    expect(p.scopes).toEqual(['app_write']);
    expect(p.client_type).toBe('app');
  });

  it('refresh token 为 type=refresh 且携带 scopes 与 client_type', async () => {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(`CREATE TABLE refresh_tokens (
      id TEXT PRIMARY KEY, user_id TEXT, device_id TEXT, token_hash TEXT UNIQUE NOT NULL,
      expires_at TEXT NOT NULL, revoked_at TEXT, created_at TEXT
    )`);
    const db = {
      prepare(sql: string) {
        const statement = sqlite.prepare(sql);
        let params: unknown[] = [];
        return {
          bind(...values: unknown[]) { params = values; return this; },
          async run() {
            await statement.run(...(params as never[]));
            return { meta: { changes: 1 } };
          },
          async first<T = unknown>() { return (statement.get(...(params as never[])) as T) ?? null; },
          async all<T = unknown>() { return { results: statement.all(...(params as never[])) as T[] }; },
        };
      },
    } as unknown as D1Database;
    try {
      const { token } = await createRefreshToken('user-2', 'dev-2', db, ['web_read', 'web_write', 'ops_write'], 'test-secret', 'web');
      const p = decode(token);
      expect(p.sub).toBe('user-2');
      expect(p.type).toBe('refresh');
      expect(p.scopes).toEqual(['web_read', 'web_write', 'ops_write']);
      expect(p.client_type).toBe('web');
    } finally {
      sqlite.close();
    }
  });

  it('scopes 为空时不写 scopes claim(本地契约,2FA challenge token 无 scope)', async () => {
    const token = await createAccessToken('user-3', 'test-secret', []);
    expect(decode(token).scopes).toBeUndefined();
  });
});