/**
 * 汇率取价契约（对齐上游 src/services/exchange_rate/fetcher.py）。
 *
 * 锁住三件事：取价链兜底、方向约定（1 base = x quote，不取倒数）、TTL 缓存与并发去重。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLedger, makeHarness, mcpCtx, registerDevice, registerUser, type Harness } from './mcp-harness';
import { fetchUpstream, getRateSnapshot } from '../src/mcp/exchange-rate';

let h: Harness;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  h = makeHarness();
  // 用 D1 语义的上下文（模块里用的是 D1 的 prepare().bind() 接口）
  registerUser(h, 'u1', 'u1@example.com');
  registerDevice(h, 'u1');
  createLedger(h, 'u1', 'L1-i', 'L1', '主账本');
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  h?.sqlite.close();
});

describe('fetchUpstream', () => {
  it('上游挂了 → 走 jsDelivr 镜像', async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (String(url).includes('fastly.jsdelivr.net')) {
        return new Response(JSON.stringify({ date: '2026-05-13', usd: { cny: 7.2 } }), { status: 200 });
      }
      return new Response('nope', { status: 500 });
    }) as unknown as typeof fetch;
    const snap = await fetchUpstream('USD', { EXCHANGE_RATE_UPSTREAM: 'https://bad.example/api' });
    expect(snap.source).toBe('fawazahmed0');
    expect(snap.rates.CNY).toBe(7.2);
    expect(snap.rate_date).toBe('2026-05-13');
  });

  it('镜像全挂 → 兜底 frankfurter', async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (String(url).includes('frankfurter.dev')) {
        return new Response(JSON.stringify({ date: '2026-05-13', rates: { CNY: 7.1 } }), { status: 200 });
      }
      return new Response('nope', { status: 500 });
    }) as unknown as typeof fetch;
    const snap = await fetchUpstream('USD', {});
    expect(snap.source).toBe('frankfurter');
    expect(snap.rates.CNY).toBe(7.1);
  });

  it('全挂 → 抛异常（不静默按 1:1）', async () => {
    globalThis.fetch = vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    await expect(fetchUpstream('USD', {})).rejects.toThrow(/Exchange rate upstream unavailable/);
  });
});

describe('getRateSnapshot', () => {
  it('首次取价写入缓存，TTL 内第二次不再打外网', async () => {
    let frankfurterCalls = 0;
    globalThis.fetch = vi.fn(async (url: string) => {
      // 取价链会先试三个 jsDelivr 镜像（这里都给 500），最后才兜底 frankfurter
      if (String(url).includes('frankfurter.dev')) {
        frankfurterCalls += 1;
        return new Response(JSON.stringify({ date: '2026-05-13', rates: { CNY: 7.3 } }), { status: 200 });
      }
      return new Response('nope', { status: 500 });
    }) as unknown as typeof fetch;

    const first = await getRateSnapshot(mcpCtx(h, 'u1').db, 'USD', {});
    expect(first?.rates.CNY).toBe(7.3);
    const second = await getRateSnapshot(mcpCtx(h, 'u1').db, 'USD', {});
    expect(second?.rates.CNY).toBe(7.3);
    // 第二次走 TTL 缓存，不再打上游
    expect(frankfurterCalls).toBe(1);
  });

  it('并发同 base 只发一个上游请求（防击穿）', async () => {
    let frankfurterCalls = 0;
    globalThis.fetch = vi.fn(async (url: string) => {
      if (String(url).includes('frankfurter.dev')) {
        frankfurterCalls += 1;
        await new Promise(r => setTimeout(r, 20));
        return new Response(JSON.stringify({ date: '2026-05-13', rates: { CNY: 7.4 } }), { status: 200 });
      }
      return new Response('nope', { status: 500 });
    }) as unknown as typeof fetch;

    const [a, b] = await Promise.all([
      getRateSnapshot(mcpCtx(h, 'u1').db, 'EUR', {}),
      getRateSnapshot(mcpCtx(h, 'u1').db, 'EUR', {}),
    ]);
    expect(a?.rates.CNY).toBe(7.4);
    expect(b?.rates.CNY).toBe(7.4);
    // 并发只放一个上游请求（镜像失败的调用不计）
    expect(frankfurterCalls).toBe(1);
  });
});

