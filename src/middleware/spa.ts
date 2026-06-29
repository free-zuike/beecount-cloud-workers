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
