/**
 * 内存速率限制器 - 与原版 _apply_rate_limit 对齐
 * 
 * 使用滑动窗口算法：在指定时间窗口内，每个 (action + IP) 组合限制最大请求数。
 * 仅在内存中存储，Worker 重启后重置（与原版行为一致）。
 */

type RateBucket = { timestamps: number[] };

const buckets = new Map<string, RateBucket>();

const DEFAULT_WINDOW_SECONDS = 60;
const DEFAULT_MAX_REQUESTS = 30;

/**
 * 检查请求是否超过速率限制
 * @returns true 如果被限制（应返回 429），false 如果通过
 */
export function isRateLimited(
  action: string,
  clientIp: string,
  windowSeconds: number = DEFAULT_WINDOW_SECONDS,
  maxRequests: number = DEFAULT_MAX_REQUESTS
): boolean {
  // 与原版一致：测试环境跳过限流
  if (typeof process !== 'undefined' && process.env?.VITEST) return false;

  const now = Date.now();
  const key = `${action}:${clientIp}`;
  const windowMs = windowSeconds * 1000;

  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { timestamps: [] };
    buckets.set(key, bucket);
  }

  // 清理过期时间戳
  bucket.timestamps = bucket.timestamps.filter(ts => now - ts < windowMs);

  if (bucket.timestamps.length >= maxRequests) {
    return true;
  }

  bucket.timestamps.push(now);
  return false;
}
