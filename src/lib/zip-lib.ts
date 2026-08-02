/**
 * ZIP 加密工具 — 使用 @zip.js/zip.js 创建标准 AES-256 加密 ZIP 文件
 * 兼容 7-Zip / WinRAR / Keka 等常见工具
 */

// 使用 index.min.js 尝试兼容 Workers
import { configure, ZipWriter, Uint8ArrayWriter, Uint8ArrayReader } from '@zip.js/zip.js';

// 配置 zip.js 不使用 Web Workers（Cloudflare Workers 不支持）
configure({ useWebWorkers: false });

/**
 * 创建 AES-256 加密 ZIP 文件（标准 ZIP 格式，可用 7-Zip 打开）
 */
export async function createEncryptedZip(
  files: Array<{ name: string; data: Uint8Array }>,
  password: string,
): Promise<Uint8Array> {
  const writer = new Uint8ArrayWriter();
  const zipWriter = new ZipWriter(writer, {
    password,
    encryptionStrength: 3, // AES-256
  });

  for (const file of files) {
    await zipWriter.add(file.name, new Uint8ArrayReader(file.data));
  }

  await zipWriter.close();
  return writer.getData() as unknown as Uint8Array;
}

/**
 * 创建不加密的标准 ZIP 文件
 */
export async function createZip(
  files: Array<{ name: string; data: Uint8Array }>,
): Promise<Uint8Array> {
  const writer = new Uint8ArrayWriter();
  const zipWriter = new ZipWriter(writer);

  for (const file of files) {
    await zipWriter.add(file.name, new Uint8ArrayReader(file.data));
  }

  await zipWriter.close();
  return writer.getData() as unknown as Uint8Array;
}