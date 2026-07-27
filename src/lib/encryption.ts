/**
 * AES-256-GCM 加密/解密
 * 用于备份文件加密，加密后包装为标准 zip 文件（与原版兼容）
 * zip 内含 backup.enc 文件，可用标准解压工具打开
 */

const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const ITERATIONS = 100000;

// ========== zip 工具 ==========

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
 * 将加密数据包装为标准 zip 文件（stored 模式，无压缩）
 */
export function wrapInZip(encryptedData: Uint8Array): Uint8Array {
  const filename = 'backup.enc';
  const nameBytes = new TextEncoder().encode(filename);
  const { time, date } = dosTime();
  const crc = crc32(encryptedData);
  const size = encryptedData.length;

  // 1. Local file header
  const localHeader = new Uint8Array(30 + nameBytes.length);
  const lh = new DataView(localHeader.buffer);
  lh.setUint32(0, 0x04034b50, true);
  lh.setUint16(4, 20, true);
  lh.setUint16(6, 0, true);
  lh.setUint16(8, 0, true); // stored
  lh.setUint16(10, time, true);
  lh.setUint16(12, date, true);
  lh.setUint32(14, crc, true);
  lh.setUint32(18, size, true);
  lh.setUint32(22, size, true);
  lh.setUint16(26, nameBytes.length, true);
  lh.setUint16(28, 0, true);
  localHeader.set(nameBytes, 30);

  // 2. Central directory entry
  const cdEntry = new Uint8Array(46 + nameBytes.length);
  const cd = new DataView(cdEntry.buffer);
  cd.setUint32(0, 0x02014b50, true);
  cd.setUint16(4, 20, true);
  cd.setUint16(6, 20, true);
  cd.setUint16(8, 0, true);
  cd.setUint16(10, 0, true);
  cd.setUint16(12, time, true);
  cd.setUint16(14, date, true);
  cd.setUint32(16, crc, true);
  cd.setUint32(20, size, true);
  cd.setUint32(24, size, true);
  cd.setUint16(28, nameBytes.length, true);
  cd.setUint16(30, 0, true);
  cd.setUint16(32, 0, true);
  cd.setUint16(34, 0, true);
  cd.setUint16(36, 0, true);
  cd.setUint32(38, 0, true);
  cd.setUint32(42, 0, true);
  cdEntry.set(nameBytes, 46);

  // 3. End of central directory
  const eocd = new Uint8Array(22);
  const eo = new DataView(eocd.buffer);
  eo.setUint32(0, 0x06054b50, true);
  eo.setUint16(4, 0, true);
  eo.setUint16(6, 0, true);
  eo.setUint16(8, 1, true);
  eo.setUint16(10, 1, true);
  eo.setUint32(12, cdEntry.length, true);
  eo.setUint32(16, localHeader.length + encryptedData.length, true);
  eo.setUint16(20, 0, true);

  // 4. 组合
  const result = new Uint8Array(localHeader.length + encryptedData.length + cdEntry.length + eocd.length);
  result.set(localHeader, 0);
  result.set(encryptedData, localHeader.length);
  result.set(cdEntry, localHeader.length + encryptedData.length);
  result.set(eocd, localHeader.length + encryptedData.length + cdEntry.length);
  return result;
}

/**
 * 从 zip 文件中提取加密数据（backup.enc）
 */
export function extractFromZip(zipData: Uint8Array): Uint8Array {
  const eocdSignature = 0x06054b50;
  let eocdOffset = -1;
  for (let i = zipData.length - 22; i >= 0; i--) {
    const v = new DataView(zipData.buffer, zipData.byteOffset + i, 4);
    if (v.getUint32(0, true) === eocdSignature) { eocdOffset = i; break; }
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
  const compSize = lh.getUint32(18, true);
  return new Uint8Array(zipData.buffer, zipData.byteOffset + dataOffset, compSize);
}

// ========== AES-256-GCM ==========

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

/**
 * 加密数据（返回 salt + iv + ciphertext）
 */
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

/**
 * 解密数据
 */
export async function decryptData(encryptedData: Uint8Array, password: string): Promise<Uint8Array> {
  const salt = encryptedData.slice(0, SALT_LENGTH);
  const iv = encryptedData.slice(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const ciphertext = encryptedData.slice(SALT_LENGTH + IV_LENGTH);
  const key = await deriveKey(password, salt);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new Uint8Array(decrypted);
}

/**
 * 加密数据并包装为 zip 文件
 */
export async function encryptToZip(data: Uint8Array, password: string): Promise<Uint8Array> {
  const encrypted = await encryptData(data, password);
  return wrapInZip(encrypted);
}

/**
 * 从 zip 文件中提取并解密数据
 */
export async function decryptFromZip(zipData: Uint8Array, password: string): Promise<Uint8Array> {
  const encrypted = extractFromZip(zipData);
  return decryptData(encrypted, password);
}