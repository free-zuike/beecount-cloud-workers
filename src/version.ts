/**
 * 服务端版本号 — 单点定义，对齐原版 Python src/version.py
 *
 * 发版时改此处 + 3 个 package.json 版本号。
 * CI/CD 通过 wrangler.toml [vars] 注入 APP_VERSION 覆盖此值。
 *
 * #151（对齐上游 version.py）：新增 App 版本兼容策略 ——
 * MIN_APP_VERSION 以下的 App 端在同步接口收到 426，/version 公开端点
 * 下发 min_app_version / recommended_app_version 供前端/运维展示。
 */
const FALLBACK_VERSION = '1.0.0';
const DEFAULT_MIN_APP_VERSION = '4.0.0';
const DEFAULT_RECOMMENDED_APP_VERSION = '4.1.0';

export const APP_VERSION = '1.10.1';

export const APP_NAME = 'BeeCount Cloud';

/** App 端上报自身版本的请求头（对齐上游 APP_VERSION_HEADER）。 */
export const APP_VERSION_HEADER = 'X-BeeCount-App-Version';

export type VersionPolicy = {
  version: string;
  minAppVersion: string;
  recommendedAppVersion: string;
};

type VersionEnv = {
  APP_VERSION?: string;
  MIN_APP_VERSION?: string;
  RECOMMENDED_APP_VERSION?: string;
};

/** 版本策略：env 变量优先（对齐上游 os.environ 读取），缺省回退到模块常量。 */
export function resolveVersionPolicy(env?: VersionEnv): VersionPolicy {
  return {
    version: (env?.APP_VERSION || APP_VERSION).trim(),
    minAppVersion: (env?.MIN_APP_VERSION || DEFAULT_MIN_APP_VERSION).trim(),
    recommendedAppVersion: (env?.RECOMMENDED_APP_VERSION || DEFAULT_RECOMMENDED_APP_VERSION).trim(),
  };
}

/** 解析 '4.1.0' / 'v4.1.0+123' / '4.1.0 (123)' / '4.1.0-beta.2' 的前导 X.Y.Z。 */
export function parseSemver(raw: string | null | undefined): [number, number, number] | null {
  if (!raw || typeof raw !== 'string') return null;
  const match = /^\s*v?(\d+)\.(\d+)\.(\d+)(?:$|[+\-\s(])/i.exec(raw);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * 仅当两侧都能解析、current 是正式版本（major > 0，跳过 0.0.1 本地开发包）、
 * 且 current < required 时返回 true（对齐上游 is_version_below）。
 */
export function isVersionBelow(
  current: string | null | undefined,
  required: string | null | undefined,
): boolean {
  const cur = parseSemver(current);
  const req = parseSemver(required);
  if (cur === null || req === null || cur[0] === 0) return false;
  if (cur[0] !== req[0]) return cur[0] < req[0];
  if (cur[1] !== req[1]) return cur[1] < req[1];
  return cur[2] < req[2];
}

/** 读取 X-BeeCount-App-Version 头，trim 并截断到 Device.app_version 长度（64）。 */
export function extractClientAppVersion(
  getHeader: (name: string) => string | undefined | null,
): string | null {
  const value = getHeader(APP_VERSION_HEADER) ?? getHeader(APP_VERSION_HEADER.toLowerCase());
  if (!value) return null;
  const cleaned = value.trim();
  if (!cleaned) return null;
  return cleaned.slice(0, 64);
}
