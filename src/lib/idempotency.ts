/**
 * 写路径 Idempotency-Key 幂等中间件（对齐上游 routers/write/_shared.py：
 * _prepare_write + SyncPushIdempotency 表）。
 *
 * 语义：同一 (user_id, device_id, Idempotency-Key) + 相同请求哈希（method+path+body）
 * 重发 → 直接 replay 第一次的响应（idempotency_replayed: true），不重复推进
 * change_id；哈希不同 → 409 "Idempotency key reused with different payload"。
 * 记录 24 小时过期（写入前清理过期行）。
 */

import { createHash } from 'node:crypto';

function nowUtc(): string {
  return new Date().toISOString();
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return JSON.stringify(value);
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${parts.join(',')}}`;
}

export function hashRequest(method: string, path: string, payload: unknown): string {
  const raw = stableStringify({ method, path, payload });
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

// 幂等端点白名单（对齐上游所有声明 Header(alias="Idempotency-Key") 的端点）：
// POST /ledgers、PATCH /ledgers/:id/meta、transactions/accounts/categories/tags/budgets
// 的 POST/PATCH/DELETE、batch create/delete。
export function isIdempotentPath(method: string, path: string): boolean {
  const base = path.replace(/^\/api\/v1/, '');
  if (method === 'POST' && base === '/write/ledgers') return true;
  if (
    base === '/write/ledgers/:id/meta' ||
    /^\/write\/ledgers\/[^/]+\/meta$/.test(base)
  ) return true;
  if (/^\/write\/ledgers\/[^/]+\/(transactions|accounts|categories|tags|budgets)(\/[^/]+)?$/.test(base)) {
    return true;
  }
  if (/^\/write\/ledgers\/[^/]+\/transactions\/batch(\/delete)?$/.test(base)) return true;
  if (/^\/write\/transactions\/batch(\/delete)?$/.test(base) || base === '/write/transactions/batch' || base === '/write/transactions/batch/delete') return true;
  return false;
}

/**
 * 写路由幂等中间件。挂在 writeRouter / batchWriteRouter 的 use('*') 上；
 * 仅当请求带 Idempotency-Key 且路径在幂等白名单内时生效，否则原样放行。
 */
export async function idempotencyMiddleware(c: any, next: () => Promise<void>) {
  const key = c.req.header('Idempotency-Key') as string | undefined;
  if (!key) return next();
  const db = c.env.DB as D1Database;
  const userId = c.get('userId');
  const deviceId = c.req.header('X-Device-ID') || 'web-console';
  const path = new URL(c.req.url).pathname;
  if (!isIdempotentPath(c.req.method, path)) return next();

  // 哈希用请求体（读 clone 不影响 zValidator 的正常解析）
  const cloned = c.req.raw.clone();
  let bodyText = '';
  try { bodyText = await cloned.text(); } catch { bodyText = ''; }
  let payload: unknown = null;
  if (bodyText) { try { payload = JSON.parse(bodyText); } catch { payload = null; } }
  const hash = hashRequest(c.req.method, path, payload);

  // 写入前清理过期行（对齐上游 _purge_expired_idempotency）
  try {
    await db.prepare('DELETE FROM sync_push_idempotency WHERE expires_at < ?').bind(nowUtc()).run();
  } catch { /* best-effort */ }

  const row = await db.prepare(
    'SELECT request_hash, response_json FROM sync_push_idempotency WHERE user_id = ? AND device_id = ? AND idempotency_key = ?'
  ).bind(userId, deviceId, key).first<{ request_hash: string; response_json: string }>();

  if (row) {
    if (row.request_hash !== hash) {
      return c.json({ error: 'Idempotency key reused with different payload' }, 409);
    }
    const stored = JSON.parse(row.response_json);
    stored.idempotency_replayed = true;
    return c.json(stored, 200);
  }

  await next();

  // 成功后缓存响应（对齐上游：response_json 存响应体，24h 过期）
  const res = c.res as Response;
  if (!res || res.status < 200 || res.status >= 300) return;
  let text = '';
  try { text = await res.clone().text(); } catch { return; }
  let stored: Record<string, unknown>;
  try {
    stored = JSON.parse(text);
    if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return;
  } catch { return; }
  stored.idempotency_replayed = false;
  const expires = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  try {
    await db.prepare(
      `INSERT INTO sync_push_idempotency (user_id, device_id, idempotency_key, request_hash, response_json, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(userId, deviceId, key, hash, JSON.stringify(stored), nowUtc(), expires).run();
  } catch { /* UNIQUE 冲突：并发同 key 双写场景，尽力而为 */ }

  // 注入 idempotency_replayed: false 并替换响应
  const headers = new Headers(res.headers);
  headers.delete('content-length');
  headers.set('content-type', 'application/json');
  c.res = new Response(JSON.stringify(stored), { status: res.status, headers });
}