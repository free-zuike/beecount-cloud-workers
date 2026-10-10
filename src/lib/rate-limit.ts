/**
 * Rate limiting helpers.
 *
 * Production uses one Durable Object per (action + client key), so limits are
 * shared across Worker isolates. The in-memory implementation remains as a
 * fallback for tests / local environments and if the DO binding is temporarily
 * unavailable.
 */

type RateBucket = { timestamps: number[] }

const buckets = new Map<string, RateBucket>()

const DEFAULT_WINDOW_SECONDS = 60
const DEFAULT_MAX_REQUESTS = 30

function isVitest(): boolean {
  return typeof process !== 'undefined' && Boolean(process.env?.VITEST)
}

/**
 * Process-local sliding-window limiter. Keep this as the deterministic fallback
 * rather than failing open when Durable Object access is unavailable.
 */
export function isRateLimited(
  action: string,
  clientKey: string,
  windowSeconds: number = DEFAULT_WINDOW_SECONDS,
  maxRequests: number = DEFAULT_MAX_REQUESTS,
): boolean {
  if (isVitest()) return false

  const now = Date.now()
  const key = `${action}:${clientKey}`
  const windowMs = windowSeconds * 1000

  let bucket = buckets.get(key)
  if (!bucket) {
    bucket = { timestamps: [] }
    buckets.set(key, bucket)
  }

  bucket.timestamps = bucket.timestamps.filter((ts) => now - ts < windowMs)
  if (bucket.timestamps.length >= maxRequests) return true

  bucket.timestamps.push(now)
  return false
}

/**
 * Cluster-wide rate limit check backed by BeeCountDO.
 *
 * Each action/client pair maps to a single Durable Object instance. DO request
 * serialization makes check+increment atomic across all Worker isolates.
 */
export async function isRateLimitedDistributed(
  namespace: DurableObjectNamespace | null | undefined,
  action: string,
  clientKey: string,
  windowSeconds: number = DEFAULT_WINDOW_SECONDS,
  maxRequests: number = DEFAULT_MAX_REQUESTS,
): Promise<boolean> {
  if (!namespace) {
    return isRateLimited(action, clientKey, windowSeconds, maxRequests)
  }

  try {
    const id = namespace.idFromName(`rate-limit:${action}:${clientKey}`)
    const stub = namespace.get(id)
    const response = await stub.fetch('http://do/rate-limit/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ windowSeconds, maxRequests }),
    })
    if (!response.ok) throw new Error(`rate limit DO returned ${response.status}`)
    const body = await response.json<{ limited?: boolean }>()
    return Boolean(body.limited)
  } catch {
    // A transient DO failure must not disable abuse protection entirely.
    return isRateLimited(action, clientKey, windowSeconds, maxRequests)
  }
}
