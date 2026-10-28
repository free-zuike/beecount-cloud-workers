/**
 * 汇率取价（对齐上游 src/services/exchange_rate/fetcher.py）。
 *
 * - 方向约定：1 base = x quote，不取倒数
 * - 取价链：配置上游 → 三个 jsDelivr 镜像(@fawazahmed0/currency-api) → frankfurter
 * - 缓存：TTL 内直接返回，不 hit 外网（TTL 默认 12 小时）
 * - 并发防击穿：同 base 同时只放一个上游请求
 */
const JSDELIVR_MIRRORS = [
  'https://fastly.jsdelivr.net',
  'https://testingcf.jsdelivr.net',
  'https://cdn.jsdelivr.net',
];
const FAWAZ_PATH = '/npm/@fawazahmed0/currency-api@latest/v1/currencies/{base}.min.json';
const FRANKFURTER = 'https://api.frankfurter.dev/v1/latest?base={BASE}';

export interface RateSnapshot {
  base: string;
  rate_date: string;
  source: string;
  fetched_at: string;
  rates: Record<string, number>;
}

const inflight = new Map<string, Promise<RateSnapshot>>();

function num(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 按上游链取价；全挂抛异常 */
export async function fetchUpstream(base: string, env?: Record<string, unknown> | null): Promise<RateSnapshot> {
  const b = base.toUpperCase();
  const lower = base.toLowerCase();
  const configured = typeof env?.EXCHANGE_RATE_UPSTREAM === 'string' ? env.EXCHANGE_RATE_UPSTREAM.trim() : '';

  if (configured) {
    try {
      const res = await fetch(`${configured.replace(/\/$/, '')}/v1/latest?base=${b}`, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`upstream status ${res.status}`);
      const data = await res.json() as { date?: string; rates?: Record<string, unknown> };
      const rates: Record<string, number> = {};
      for (const [k, v] of Object.entries(data.rates ?? {})) { const n = num(v); if (n) rates[k.toUpperCase()] = n; }
      if (Object.keys(rates).length) {
        return { base: b, rate_date: String(data.date ?? ''), source: 'configured', fetched_at: new Date().toISOString(), rates };
      }
    } catch { /* 继续下一个源 */ }
  }

  for (const host of JSDELIVR_MIRRORS) {
    try {
      const res = await fetch(host + FAWAZ_PATH.replace('{base}', lower), { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`mirror status ${res.status}`);
      const data = await res.json() as Record<string, Record<string, unknown>>;
      const payload = data[lower] ?? {};
      const rates: Record<string, number> = {};
      for (const [k, v] of Object.entries(payload)) { const n = num(v); if (n) rates[k.toUpperCase()] = n; }
      if (Object.keys(rates).length) {
        return { base: b, rate_date: String((data as Record<string, unknown>).date ?? ''), source: 'fawazahmed0', fetched_at: new Date().toISOString(), rates };
      }
    } catch { /* 继续下一个镜像 */ }
  }

  const res = await fetch(FRANKFURTER.replace('{BASE}', b), { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('Exchange rate upstream unavailable');
  const data = await res.json() as { date?: string; rates?: Record<string, unknown> };
  const rates: Record<string, number> = {};
  for (const [k, v] of Object.entries(data.rates ?? {})) { const n = num(v); if (n) rates[k.toUpperCase()] = n; }
  if (!Object.keys(rates).length) throw new Error('Exchange rate upstream unavailable');
  return { base: b, rate_date: String(data.date ?? ''), source: 'frankfurter', fetched_at: new Date().toISOString(), rates };
}

interface CacheRow {
  base_currency: string;
  rate_date: string | null;
  source: string | null;
  payload_json: string | null;
  fetched_at: string | null;
}

/**
 * 取某基准币的汇率快照：缓存新鲜直接用，否则走取价链并回写缓存。
 * 缓存不可用时退化为直接取价（不静默按 1:1 处理）。
 */
export async function getRateSnapshot(
  db: D1Database,
  base: string,
  env?: Record<string, unknown> | null,
): Promise<RateSnapshot | null> {
  const b = base.toUpperCase();
  const ttlHours = Number(env?.EXCHANGE_RATE_CACHE_TTL_HOURS ?? 12) || 12;
  const cached = await db
    .prepare('SELECT base_currency, rate_date, source, payload_json, fetched_at FROM exchange_rate_cache WHERE base_currency = ?')
    .bind(b)
    .first<CacheRow>();
  if (cached?.payload_json && cached.fetched_at) {
    const age = Date.now() - new Date(cached.fetched_at).getTime();
    if (age < ttlHours * 3600_000) {
      try {
        const rates = JSON.parse(cached.payload_json) as Record<string, number>;
        return { base: b, rate_date: cached.rate_date ?? '', source: cached.source ?? 'cache', fetched_at: cached.fetched_at, rates };
      } catch { /* 缓存损坏 → 重新取价 */ }
    }
  }

  const pending = inflight.get(b);
  if (pending) return pending;
  const task = (async () => {
    const snap = await fetchUpstream(b, env);
    await db.prepare(
      `INSERT OR REPLACE INTO exchange_rate_cache (base_currency, rate_date, source, payload_json, fetched_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(b, snap.rate_date, snap.source, JSON.stringify(snap.rates), snap.fetched_at).run();
    return snap;
  })();
  inflight.set(b, task);
  try {
    return await task;
  } finally {
    inflight.delete(b);
  }
}
