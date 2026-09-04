/**
 * 服务端版本号 — 单点定义，对齐原版 Python src/version.py
 *
 * 发版时改此处 + 3 个 package.json 版本号。
 * CI/CD 通过 wrangler.toml [vars] 注入 APP_VERSION 覆盖此值。
 */
const FALLBACK_VERSION = '1.0.0';
export const APP_VERSION = '1.6.4';

export const APP_NAME = 'BeeCount Cloud';