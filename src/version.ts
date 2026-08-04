/**
 * 服务端版本号 — 单点定义，对齐原版 Python src/version.py
 *
 * 优先级:
 *   1. `APP_VERSION` 环境变量（CI/CD 构建时注入）
 *   2. 本地开发 fallback 版本
 */
const FALLBACK_VERSION = '1.0.0';
export const APP_VERSION = (typeof process !== 'undefined' && process.env?.APP_VERSION) || FALLBACK_VERSION;

export const APP_NAME = 'BeeCount Cloud';