/**
 * AES-256-GCM 加密/解密 + 标准 ZipCrypto 加密 zip 文件
 * ZipCrypto 是传统 zip 加密方式，7-Zip / WinRAR / macOS 等都支持
 */

const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const ITERATIONS = 100000;

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptData(data: Uint8Array, password: string): Promise<Uint8Array> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const key = await deriveKey(password, salt);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  const result = new Uint8Array(SALT_LENGTH + IV_LENGTH + ciphertext.byteLength);
  result.set(salt, 0);
  result.set(iv, SALT_LENGTH);
  result.set(new Uint8Array(ciphertext), SALT_LENGTH + IV_LENGTH);
  return result;
}

export async function decryptData(encryptedData: Uint8Array, password: string): Promise<Uint8Array> {
  const salt = encryptedData.slice(0, SALT_LENGTH);
  const iv = encryptedData.slice(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const ciphertext = encryptedData.slice(SALT_LENGTH + IV_LENGTH);
  const key = await deriveKey(password, salt);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new Uint8Array(decrypted);
}

// ========== ZipCrypto 加密 ==========

// ZipCrypto 密钥初始化常量
const ZIP_CRYPTO_KEY0 = 0x12345678;
const ZIP_CRYPTO_KEY1 = 0x23456789;
const ZIP_CRYPTO_KEY2 = 0x34567890;

function zipCryptoUpdateKeys(keys: Uint32Array, byte: number): void {
  keys[0] = crc32Byte(keys[0], byte);
  keys[1] = (keys[1] + (keys[0] & 0xFF)) | 0;
  keys[1] = (keys[1] * 134775813 + 1) >>> 0;
  keys[2] = crc32Byte(keys[2], keys[1] >>> 24);
}

function crc32Byte(crc: number, byte: number): number {
  return ((crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xFF]) >>> 0;
}

function zipCryptoDecryptByte(keys: Uint32Array): number {
  const temp = (keys[2] & 0xFFFF) | 2;
  return ((temp * (temp ^ 1)) >>> 8) & 0xFF;
}

function zipCryptoInit(password: string): Uint32Array {
  const keys = new Uint32Array([ZIP_CRYPTO_KEY0, ZIP_CRYPTO_KEY1, ZIP_CRYPTO_KEY2]);
  const encoder = new TextEncoder();
  const pwBytes = encoder.encode(password);
  for (let i = 0; i < pwBytes.length; i++) {
    zipCryptoUpdateKeys(keys, pwBytes[i]);
  }
  return keys;
}

// CRC32 表
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    c = CRC32_TABLE[(c ^ data[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosTime(): { time: number; date: number } {
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >>> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  return { time, date };
}

/**
 * 创建 ZipCrypto 加密的 zip 文件
 * 内含 backup.tar.gz，可用标准解压工具打开（需输入密码）
 */
export function createEncryptedZip(tarGzBytes: Uint8Array, password: string): Uint8Array {
  const filename = 'backup.tar.gz';
  const nameBytes = new TextEncoder().encode(filename);
  const { time, date } = dosTime();
  const fileCrc = crc32(tarGzBytes);
  const size = tarGzBytes.length;

  // 初始化 ZipCrypto 密钥
  const keys = zipCryptoInit(password);

  // 生成 12 字节加密头（随机数）
  const header = crypto.getRandomValues(new Uint8Array(12));

  // 加密头部字节
  const encryptedHeader = new Uint8Array(12);
  for (let i = 0; i < 12; i++) {
    const keyByte = zipCryptoDecryptByte(keys);
    encryptedHeader[i] = header[i] ^ keyByte;
    // 最后一位用作校验
    if (i === 11) {
      encryptedHeader[i] = (header[i] ^ keyByte) & 0xFF;
    }
    zipCryptoUpdateKeys(keys, header[i]);
  }

  // 加密文件数据
  const encryptedData = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    const keyByte = zipCryptoDecryptByte(keys);
    encryptedData[i] = tarGzBytes[i] ^ keyByte;
    zipCryptoUpdateKeys(keys, tarGzBytes[i]);
  }

  // 组合加密内容：12 字节加密头 + 加密数据
  const encryptedContent = new Uint8Array(12 + size);
  encryptedContent.set(encryptedHeader, 0);
  encryptedContent.set(encryptedData, 12);

  // 校验字节：CRC-32 的高 8 位
  const checkByte = (fileCrc >>> 24) & 0xFF;
  // 加密头部最后一个字节的校验
  const lastKeyByte = zipCryptoDecryptByte(keys);
  // 注意：校验字节在加密头中已经包含，这里用 header[11] 作为校验值
  // 修改加密头最后一个字节为校验字节
  // 重新计算：加密头第12字节应该用校验字节异或 keyByte
  const checkEncrypted = checkByte ^ lastKeyByte;
  encryptedHeader[11] = checkEncrypted;

  // 重新组合加密内容
  encryptedContent.set(encryptedHeader, 0);

  // 通用位标记：bit 0 = 加密, bit 1 = 8k 滑块, bit 6 = 强加密
  const flags = 1; // 只设加密位

  // 1. Local file header
  const localHeader = new Uint8Array(30 + nameBytes.length);
  const lh = new DataView(localHeader.buffer);
  lh.setUint32(0, 0x04034b50, true);
  lh.setUint16(4, 20, true);     // version needed
  lh.setUint16(6, flags, true);  // flags (encrypted)
  lh.setUint16(8, 0, true);      // stored
  lh.setUint16(10, time, true);
  lh.setUint16(12, date, true);
  lh.setUint32(14, 0, true);     // CRC (unknown, set to 0)
  lh.setUint32(18, 0, true);     // compressed size (unknown)
  lh.setUint32(22, 0, true);     // uncompressed size (unknown)
  lh.setUint16(26, nameBytes.length, true);
  lh.setUint16(28, 0, true);
  localHeader.set(nameBytes, 30);

  // 2. 文件数据（加密头 + 加密数据）
  const fileData = encryptedContent;

  // 3. Central directory entry
  const cdEntry = new Uint8Array(46 + nameBytes.length);
  const cd = new DataView(cdEntry.buffer);
  cd.setUint32(0, 0x02014b50, true);
  cd.setUint16(4, 20, true);
  cd.setUint16(6, 20, true);
  cd.setUint16(8, flags, true);
  cd.setUint16(10, 0, true);
  cd.setUint16(12, time, true);
  cd.setUint16(14, date, true);
  cd.setUint32(16, fileCrc, true);
  cd.setUint32(20, 12 + size, true);  // compressed = 12 + data
  cd.setUint32(24, size, true);       // uncompressed
  cd.setUint16(28, nameBytes.length, true);
  cd.setUint16(30, 0, true);
  cd.setUint16(32, 0, true);
  cd.setUint16(34, 0, true);
  cd.setUint16(36, 0, true);
  cd.setUint32(38, 0, true);
  cd.setUint32(42, 0, true);
  cdEntry.set(nameBytes, 46);

  // 4. End of central directory
  const eocd = new Uint8Array(22);
  const eo = new DataView(eocd.buffer);
  eo.setUint32(0, 0x06054b50, true);
  eo.setUint16(4, 0, true);
  eo.setUint16(6, 0, true);
  eo.setUint16(8, 1, true);
  eo.setUint16(10, 1, true);
  eo.setUint32(12, cdEntry.length, true);
  eo.setUint32(16, localHeader.length + fileData.length, true);
  eo.setUint16(20, 0, true);

  // 5. 组合
  const result = new Uint8Array(localHeader.length + fileData.length + cdEntry.length + eocd.length);
  result.set(localHeader, 0);
  result.set(fileData, localHeader.length);
  result.set(cdEntry, localHeader.length + fileData.length);
  result.set(eocd, localHeader.length + fileData.length + cdEntry.length);
  return result;
}

/**
 * 从 ZipCrypto 加密的 zip 中提取 backup.tar.gz
 */
export function extractEncryptedZip(zipData: Uint8Array, password: string): Uint8Array {
  // 查找 End of Central Directory
  let eocdOffset = -1;
  for (let i = zipData.length - 22; i >= 0; i--) {
    const v = new DataView(zipData.buffer, zipData.byteOffset + i, 4);
    if (v.getUint32(0, true) === 0x06054b50) { eocdOffset = i; break; }
  }
  if (eocdOffset < 0) throw new Error('Invalid zip: no EOCD');

  const eo = new DataView(zipData.buffer, zipData.byteOffset + eocdOffset, 22);
  const cdOffset = eo.getUint32(16, true);
  const cd = new DataView(zipData.buffer, zipData.byteOffset + cdOffset, 46);
  const localOffset = cd.getUint32(42, true);
  const lh = new DataView(zipData.buffer, zipData.byteOffset + localOffset, 30);
  const nameLen = lh.getUint16(26, true);
  const extraLen = lh.getUint16(28, true);
  const dataOffset = localOffset + 30 + nameLen + extraLen;
  const compSize = cd.getUint32(20, true); // compressed size from CD

  // 读取加密数据（12 字节头 + 加密数据）
  const encryptedData = new Uint8Array(zipData.buffer, zipData.byteOffset + dataOffset, compSize);

  // 解密
  const keys = zipCryptoInit(password);

  // 解密 12 字节加密头
  const header = new Uint8Array(12);
  for (let i = 0; i < 12; i++) {
    const keyByte = zipCryptoDecryptByte(keys);
    header[i] = encryptedData[i] ^ keyByte;
    zipCryptoUpdateKeys(keys, header[i]);
  }

  // 校验密码 - 检查 CRC 高 8 位
  const checkByte = (cd.getUint32(16, true) >>> 24) & 0xFF;
  // 注意：有些实现用 header[11] 做校验，有些用解密后的值
  // 实际校验：解密后的 header[11] 应该等于 CRC-32 的高 8 位
  if (header[11] !== checkByte) {
    throw new Error('Incorrect password or corrupted zip data');
  }

  // 解密文件数据
  const dataSize = compSize - 12;
  const decrypted = new Uint8Array(dataSize);
  for (let i = 0; i < dataSize; i++) {
    const keyByte = zipCryptoDecryptByte(keys);
    decrypted[i] = encryptedData[12 + i] ^ keyByte;
    zipCryptoUpdateKeys(keys, decrypted[i]);
  }

  return decrypted;
}