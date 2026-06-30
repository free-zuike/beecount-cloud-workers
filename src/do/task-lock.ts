import { DurableObject } from 'cloudflare:workers';

interface LockState {
  holder: string | null;
  acquiredAt: number | null;
  ttlMs: number;
}

export class TaskLock extends DurableObject {
  private static DEFAULT_TTL = 30 * 60 * 1000; // 30 minutes

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = url.pathname === '/lock' || url.pathname === '/refresh'
      ? await request.json<{ holder?: string; ttlMs?: number }>()
      : {};

    switch (url.pathname) {
      case '/lock':
        return Response.json(await this.tryLock(body.holder || 'default', body.ttlMs || TaskLock.DEFAULT_TTL));
      case '/unlock':
        return Response.json(await this.unlock());
      case '/status':
        return Response.json(await this.getStatus());
      case '/refresh':
        return Response.json(await this.refresh(body.holder || 'default', body.ttlMs || TaskLock.DEFAULT_TTL));
      default:
        return new Response('Not found', { status: 404 });
    }
  }

  async tryLock(holder: string, ttlMs: number): Promise<{ acquired: boolean; holder: string | null }> {
    const now = Date.now();
    const lock = await this.ctx.storage.get<LockState>('lock');

    if (!lock || !lock.holder || now - (lock.acquiredAt || 0) >= lock.ttlMs) {
      // Lock is free or expired
      await this.ctx.storage.put('lock', { holder, acquiredAt: now, ttlMs });
      return { acquired: true, holder };
    }

    // Lock is held and not expired
    return { acquired: false, holder: lock.holder };
  }

  async unlock(): Promise<{ released: boolean }> {
    await this.ctx.storage.put('lock', { holder: null, acquiredAt: null, ttlMs: 0 });
    return { released: true };
  }

  async getStatus(): Promise<LockState> {
    const lock = await this.ctx.storage.get<LockState>('lock');
    if (!lock || !lock.holder) {
      return { holder: null, acquiredAt: null, ttlMs: 0 };
    }

    const now = Date.now();
    if (now - (lock.acquiredAt || 0) >= lock.ttlMs) {
      // Expired
      await this.ctx.storage.put('lock', { holder: null, acquiredAt: null, ttlMs: 0 });
      return { holder: null, acquiredAt: null, ttlMs: 0 };
    }

    return lock;
  }

  async refresh(holder: string, ttlMs: number): Promise<{ refreshed: boolean }> {
    const lock = await this.ctx.storage.get<LockState>('lock');
    if (lock && lock.holder === holder) {
      await this.ctx.storage.put('lock', { ...lock, ttlMs, acquiredAt: Date.now() });
      return { refreshed: true };
    }
    return { refreshed: false };
  }
}
