/**
 * ssh2 Poly1305 WebAssembly 模块的 shim
 * Cloudflare Workers 不允许 WebAssembly 代码生成，此 shim 提供空实现
 * 实际不会被调用（已限制 cipher 为 CTR/CBC，不使用 ChaCha20-Poly1305）
 */
"use strict";
module.exports = function() {
  return {
    HEAPU8: { buffer: new ArrayBuffer(0) },
    _malloc: function() { return 0; },
    _free: function() {},
  };
};