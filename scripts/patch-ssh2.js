/**
 * 修补 ssh2 的 crypto.js，将 poly1305 WebAssembly 加载包在 try-catch 中
 * Workers 不支持 WebAssembly 代码生成，但 ssh2 会因此崩溃
 * 限制 cipher 为 CTR/CBC 时 poly1305 不会被用到
 */
const fs = require('fs');
const path = require('path');

const cryptoPath = path.join(__dirname, '..', 'node_modules', 'ssh2', 'lib', 'protocol', 'crypto.js');

try {
  let content = fs.readFileSync(cryptoPath, 'utf8');

  const oldCode = `    return new Promise(async (resolve, reject) => {
      try {
        POLY1305_WASM_MODULE = await require('./crypto/poly1305.js')();
        POLY1305_RESULT_MALLOC = POLY1305_WASM_MODULE._malloc(16);
        poly1305_auth = POLY1305_WASM_MODULE.cwrap(
          'poly1305_auth',
          null,
          ['number', 'array', 'number', 'array', 'number', 'array']
        );
      } catch (ex) {
        return reject(ex);
      }
      resolve();
    });`;

  const newCode = `    return new Promise(async (resolve) => {
      try {
        POLY1305_WASM_MODULE = await require('./crypto/poly1305.js')();
      } catch {
        // Workers 不支持 WebAssembly
      }
      if (POLY1305_WASM_MODULE) {
        try {
          POLY1305_RESULT_MALLOC = POLY1305_WASM_MODULE._malloc(16);
          poly1305_auth = POLY1305_WASM_MODULE.cwrap(
            'poly1305_auth',
            null,
            ['number', 'array', 'number', 'array', 'number', 'array']
          );
        } catch {}
      }
      resolve();
    });`;

  if (content.includes(oldCode)) {
    content = content.replace(oldCode, newCode);
    fs.writeFileSync(cryptoPath, content, 'utf8');
    console.log('[patch-ssh2] crypto.js patched successfully');
  } else {
    console.log('[patch-ssh2] crypto.js already patched or pattern not found');
  }
} catch (err) {
  console.error('[patch-ssh2] Failed to patch crypto.js:', err.message);
}