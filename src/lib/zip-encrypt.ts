/**
 * AES-256 加密 ZIP 打包 — 对齐原版 Python tar_builder.py (WinZip AES)
 *
 * 生成标准 ZIP 文件，使用 AES-256 加密（WinZip AES 格式 AE-2），
 * 兼容 macOS Archive Utility / Keka / 7-Zip / WinRAR 等常见工具。
 *
 * WinZip AES 格式:
 *   [salt 16B][PV 2B][AES-CTR encrypted data][HMAC 10B]
 */

const SALT_LENGTH = 16;
const PV_LENGTH = 2;
const AUTH_CODE_LENGTH = 10;
const KEY_LENGTH = 32; // AES-256
const PBKDF2_ITERATIONS = 1000;

/** CRC-32 */
function crc32(data: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/** 派生加密密钥 + 验证值 */
async function deriveEncryptionKey(password: string, salt: Uint8Array): Promise<{ key: CryptoKey; pv: Uint8Array }> {
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-1' },
    keyMaterial,
    (KEY_LENGTH + 2) * 8 // 32B enc key + 2B PV
  );
  const keyBytes = new Uint8Array(bits.slice(0, KEY_LENGTH));
  const pv = new Uint8Array(bits.slice(KEY_LENGTH, KEY_LENGTH + 2));
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CTR', length: 256 }, false, ['encrypt']);
  return { key, pv };
}

/** 派生 HMAC 认证密钥 */
async function deriveHmacKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-1' },
    keyMaterial,
    KEY_LENGTH * 8
  );
  return crypto.subtle.importKey('raw', new Uint8Array(bits), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
}

/** 使用 AES-256-CTR 加密，counter 从 0 开始 */
async function aesCtrEncrypt(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const counter = new Uint8Array(16); // 全零
  return new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CTR', counter, length: 128 }, key, data));
}

/** ZIP 本地文件头 */
function localFileHeader(filename: string, compressedSize: number, uncompressedSize: number, crc32Val: number, isEncrypted: boolean): Uint8Array {
  const nameBytes = new TextEncoder().encode(filename);
  const extraLen = isEncrypted ? 11 + 2 : 0; // AES extra (11) + 2-byte length field
  const header = new Uint8Array(30 + nameBytes.length + extraLen);
  const dv = new DataView(header.buffer);
  let off = 0;
  dv.setUint32(off, 0x04034b50, true); off += 4;
  dv.setUint16(off, isEncrypted ? 51 : 20, true); off += 2; // version 5.1 for AES
  dv.setUint16(off, isEncrypted ? 1 : 0, true); off += 2; // bit 0 = encrypted
  dv.setUint16(off, 0, true); off += 2; // stored
  dv.setUint16(off, 0, true); off += 2;
  dv.setUint16(off, 0, true); off += 2;
  dv.setUint32(off, isEncrypted ? 0 : crc32Val, true); off += 4; // 0 for encrypted
  dv.setUint32(off, isEncrypted ? 0 : compressedSize, true); off += 4;
  dv.setUint32(off, isEncrypted ? 0 : uncompressedSize, true); off += 4;
  dv.setUint16(off, nameBytes.length, true); off += 2;
  dv.setUint16(off, extraLen, true); off += 2;
  header.set(nameBytes, off); off += nameBytes.length;
  if (isEncrypted) {
    dv.setUint16(off, 0x9901, true); off += 2; // AES extra ID
    dv.setUint16(off, 11, true); off += 2; // data size
    dv.setUint16(off, 2, true); off += 2; // AE-2
    dv.setUint16(off, 1, true); off += 2; // vendor
    dv.setUint8(off, 7); off += 1; // AES-256
    dv.setUint16(off, 0, true); off += 2; // stored
  }
  return header;
}

/** ZIP 中央目录条目 */
function centralDirectoryEntry(filename: string, compressedSize: number, uncompressedSize: number, crc32Val: number, localOffset: number, isEncrypted: boolean): Uint8Array {
  const nameBytes = new TextEncoder().encode(filename);
  const extraLen = isEncrypted ? 11 + 2 : 0;
  const entry = new Uint8Array(46 + nameBytes.length + extraLen);
  const dv = new DataView(entry.buffer);
  let off = 0;
  dv.setUint32(off, 0x02014b50, true); off += 4;
  dv.setUint16(off, 51, true); off += 2;
  dv.setUint16(off, 51, true); off += 2;
  dv.setUint16(off, isEncrypted ? 1 : 0, true); off += 2;
  dv.setUint16(off, 0, true); off += 2;
  dv.setUint16(off, 0, true); off += 2;
  dv.setUint16(off, 0, true); off += 2;
  dv.setUint32(off, crc32Val, true); off += 4;
  dv.setUint32(off, compressedSize, true); off += 4;
  dv.setUint32(off, uncompressedSize, true); off += 4;
  dv.setUint16(off, nameBytes.length, true); off += 2;
  dv.setUint16(off, extraLen, true); off += 2;
  dv.setUint16(off, 0, true); off += 2;
  dv.setUint16(off, 0, true); off += 2;
  dv.setUint16(off, 0, true); off += 2;
  dv.setUint32(off, 0, true); off += 4;
  dv.setUint32(off, localOffset, true); off += 4;
  entry.set(nameBytes, off); off += nameBytes.length;
  if (isEncrypted) {
    dv.setUint16(off, 0x9901, true); off += 2;
    dv.setUint16(off, 11, true); off += 2;
    dv.setUint16(off, 2, true); off += 2;
    dv.setUint16(off, 1, true); off += 2;
    dv.setUint8(off, 7); off += 1;
    dv.setUint16(off, 0, true); off += 2;
  }
  return entry;
}

/** EOCD */
function endOfCentralDirectory(cdOffset: number, cdSize: number, totalEntries: number): Uint8Array {
  const eocd = new Uint8Array(22);
  const dv = new DataView(eocd.buffer);
  dv.setUint32(0, 0x06054b50, true);
  dv.setUint16(4, 0, true);
  dv.setUint16(6, 0, true);
  dv.setUint16(8, totalEntries, true);
  dv.setUint16(10, totalEntries, true);
  dv.setUint32(12, cdSize, true);
  dv.setUint32(16, cdOffset, true);
  dv.setUint16(20, 0, true);
  return eocd;
}

/**
 * 创建 AES-256 加密 ZIP 文件（WinZip AES 格式）
 */
export async function createEncryptedZip(
  files: Array<{ name: string; data: Uint8Array }>,
  password: string,
): Promise<Uint8Array> {
  if (!password) throw new Error('Password is empty');

  const chunks: Uint8Array[] = [];
  const cdEntries: Uint8Array[] = [];
  let localOffset = 0;

  for (const file of files) {
    const fileCRC = crc32(file.data);
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));

    // 派生加密密钥 + 验证值
    const { key, pv } = await deriveEncryptionKey(password, salt);

    // 加密数据
    const encrypted = await aesCtrEncrypt(key, file.data);

    // 计算 HMAC
    const hmacKey = await deriveHmacKey(password, salt);
    const hmac = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, encrypted));
    const authCode = hmac.slice(0, AUTH_CODE_LENGTH);

    // 构造加密块: [salt 16B][PV 2B][encrypted][auth_code 10B]
    const encryptedBlock = new Uint8Array(SALT_LENGTH + PV_LENGTH + encrypted.length + AUTH_CODE_LENGTH);
    encryptedBlock.set(salt, 0);
    encryptedBlock.set(pv, SALT_LENGTH);
    encryptedBlock.set(encrypted, SALT_LENGTH + PV_LENGTH);
    encryptedBlock.set(authCode, SALT_LENGTH + PV_LENGTH + encrypted.length);

    const compressedSize = encryptedBlock.length;
    const uncompressedSize = file.data.length;

    const lfh = localFileHeader(file.name, compressedSize, uncompressedSize, fileCRC, true);
    chunks.push(lfh);
    chunks.push(encryptedBlock);

    const cdEntry = centralDirectoryEntry(file.name, compressedSize, uncompressedSize, fileCRC, localOffset, true);
    cdEntries.push(cdEntry);

    localOffset += lfh.length + encryptedBlock.length;
  }

  const cdOffset = chunks.reduce((s, c) => s + c.length, 0);
  for (const cd of cdEntries) chunks.push(cd);
  const cdSize = cdEntries.reduce((s, c) => s + c.length, 0);
  chunks.push(endOfCentralDirectory(cdOffset, cdSize, files.length));

  const totalLen = chunks.reduce((s, c) => s + c.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}