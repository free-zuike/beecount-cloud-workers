import { Context, Next } from 'hono';

const API_PATHS = [
  '/api/v1/',
  '/sync',
  '/read',
  '/write',
  '/devices',
  '/profile',
  '/attachments',
  '/import',
  '/ai',
  '/backup',
  '/notifications',
  '/ws',
  '/2fa',
  '/mcp-calls',
  '/admin',
  '/sys-config',
  '/export',
  '/mcp',
];

const STATIC_PREFIXES = [
  '/assets/',
  '/branding/',
  '/icons/',
];

export const spaMiddleware = async (c: any, next: Next) => {
  const url = new URL(c.req.url);
  const pathname = url.pathname;

  if (API_PATHS.some(p => pathname.startsWith(p))) {
    return await next();
  }

  // 如果 pathname 是 /app 或 / 且不是 /app/setup，检查 setup 是否完成
  if (pathname === '/' || pathname === '/app' || pathname === '/app/') {
    try {
      const settings = await c.env.DB.prepare('SELECT setup_completed FROM system_settings WHERE id = ?').bind('default').first<{ setup_completed: number }>();
      if (!settings || settings.setup_completed !== 1) {
        return c.redirect('/app/setup', 302);
      }
    } catch {
      // 数据库还没初始化，也重定向到 setup
      return c.redirect('/app/setup', 302);
    }
  }

  const isStaticAsset = STATIC_PREFIXES.some(p => pathname.startsWith(p)) ||
                        pathname === '/manifest.webmanifest' ||
                        pathname === '/sw.js';

  const res = await c.env.ASSETS.fetch(c.req.raw);

  if (isStaticAsset) {
    return res;
  }

  if (res.status === 404) {
    const indexRes = await c.env.ASSETS.fetch(new Request(`${url.origin}/index.html`, { method: 'GET' }));
    return indexRes;
  }

  return res;
};
