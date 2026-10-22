/**
 * Scope 门禁中间件（对齐上游 deps.require_scopes / require_any_scopes + routers
 * read/_shared.py _READ_SCOPE_DEP、write/_shared.py _WRITE_SCOPE_DEP、devices.py）。
 *
 * 默认（ALLOW_APP_RW_SCOPES 未设 / true，与上游生产默认一致）：read 需要
 * web_read 或 app_write；write 需要 web_write 或 app_write；devices 需要
 * ops_write 或 app_write。
 * 开启严格模式（ALLOW_APP_RW_SCOPES=false，对齐上游 conftest.py）：read 只认
 * web_read、write 只认 web_write、devices 只认 ops_write——app token（只有
 * app_write）访问 read/write/devices → 403。
 *
 * 依赖 authMiddleware 已把 scopes 写入 c.get('scopes')。
 */
import { Context, Next } from 'hono';

function allowAppRwScopes(c: any): boolean {
  const v = (c.env as any)?.ALLOW_APP_RW_SCOPES;
  if (typeof v === 'string') return v === 'true';
  return v !== false;
}

export function requireAnyScopes(c: any, required: string[], allowed: string[]): Response | null {
  const scopes = new Set<string>(c.get('scopes') ?? []);
  if (required.some((s) => scopes.has(s))) return null;
  if (allowed.some((s) => scopes.has(s))) return null;
  return c.json({ error: 'Insufficient scope' }, 403);
}

export const scopeGuard = async (c: Context, next: Next) => {
  const path = c.req.path;
  const loose = allowAppRwScopes(c);
  const scopes = new Set<string>(c.get('scopes') ?? []);

  let required: string[];
  let allowed: string[] = [];
  if (path.startsWith('/read/') || path === '/read' || path.startsWith('/api/v1/read/') || path === '/api/v1/read') {
    required = ['web_read'];
    allowed = loose ? ['app_write'] : [];
  } else if (path.startsWith('/write/') || path === '/write' || path.startsWith('/api/v1/write/') || path === '/api/v1/write') {
    required = ['web_write'];
    allowed = loose ? ['app_write'] : [];
  } else if (path.startsWith('/devices/') || path === '/devices' || path.startsWith('/api/v1/devices/') || path === '/api/v1/devices') {
    required = ['ops_write'];
    allowed = loose ? ['app_write'] : [];
  } else {
    return next();
  }

  if (required.some((s) => scopes.has(s)) || allowed.some((s) => scopes.has(s))) {
    return next();
  }
  return c.json({ error: 'Insufficient scope' }, 403);
};