import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30000,
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    alias: {
      // Workers 专属模块在 vitest(node) 下不存在 —— 用测试 shim 模拟
      'cloudflare:sockets': path.resolve(__dirname, 'tests/shims/cloudflare-sockets.ts'),
    },
  },
});