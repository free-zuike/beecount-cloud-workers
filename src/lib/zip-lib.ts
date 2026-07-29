/**
 * ZIP 加密工具 — 使用 jszip 创建 AES-256 加密 ZIP 文件
 * 兼容 7-Zip / WinRAR / Keka 等常见工具
 */

import JSZip from 'jszip';

/**
 * 创建 AES-256 加密 ZIP 文件
 *
 * @param files 要打包的文件列表 [{name, data}]
 * @param password 加密密码
 * @returns ZIP 文件字节
 */
export async function createEncryptedZip(
  files: Array<{ name: string; data: Uint8Array }>,
  password: string,
): Promise<Uint8Array> {
  const zip = new JSZip();

  for (const file of files) {
    zip.file(file.name, file.data);
  }

  const blob = await zip.generateAsync({
    type: 'blob',
    password,
    encryptionStrength: 3,
  } as any) as Blob;

  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * 创建不加密的标准 ZIP 文件
 */
export async function createZip(
  files: Array<{ name: string; data: Uint8Array }>,
): Promise<Uint8Array> {
  const zip = new JSZip();

  for (const file of files) {
    zip.file(file.name, file.data);
  }

  const blob = await zip.generateAsync({
    type: 'blob',
  } as any) as Blob;

  return new Uint8Array(await blob.arrayBuffer());
}