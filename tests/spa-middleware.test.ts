import { describe, expect, it } from 'vitest';
import { spaMiddleware } from '../src/middleware/spa';

describe('spaMiddleware', () => {
  it('falls back deep app routes to index.html', async () => {
    const requestedPaths: string[] = [];
    const url = 'https://bill.example/app/transactions';
    const c = {
      req: {
        url,
        raw: new Request(url),
      },
      env: {
        ASSETS: {
          fetch: async (request: Request) => {
            const pathname = new URL(request.url).pathname;
            requestedPaths.push(pathname);
            if (pathname === '/index.html') {
              return new Response('<!doctype html><div id="root"></div>', {
                status: 200,
                headers: { 'Content-Type': 'text/html' },
              });
            }
            return new Response('Not Found', { status: 404 });
          },
        },
      },
    };

    const response = await spaMiddleware(c, (async () => undefined) as any);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('id="root"');
    expect(requestedPaths).toEqual(['/app/transactions', '/index.html']);
  });
});
