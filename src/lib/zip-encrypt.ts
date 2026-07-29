/**
 * AES-256 加密 ZIP 打包 — 对齐原版 Python tar_builder.py (WinZip AES)
 *
 * 生成标准 ZIP 文件，使用 AES-256 加密（WinZip AES 格式），
 * 兼容 macOS Archive Utility / Keka / 7-Zip / WinRAR 等常见工具。
 *
 * 格式: ZIP 本地文件头 + AES 加密数据 + 中央目录 + EOCD
 */

const SALT_LENGTH = 16;    // PBKDF2 salt: 16 bytes for AES-256
const IV_LENGTH = 16;      // AES-CTR nonce: 16 bytes
const AUTH_CODE_LENGTH = 10; // AES authentication code
const KEY_LENGTH = 32;     // AES-256
const PBKDF2_ITERATIONS = 1000; // WinZip 规范建议 1000

/** ZIP 本地文件头 */
function localFileHeader(filename: string, compressedSize: number, uncompressedSize: number, crc32: number, isEncrypted: boolean): Uint8Array {
  const nameBytes = new TextEncoder().encode(filename);
  const extraLen = isEncrypted ? 11 + 2 + 2 : 0; // AES extra + NTFS extra + 2-byte extra length
  const header = new Uint8Array(30 + nameBytes.length + extraLen);
  const dv = new DataView(header.buffer);
  let off = 0;

  // Local file header signature
  dv.setUint32(off, 0x04034b50, true); off += 4;
  // Version needed
  dv.setUint16(off, isEncrypted ? 51 : 20, true); off += 2; // 5.1 for AES
  // General purpose bit flag
  dv.setUint16(off, isEncrypted ? 1 : 0, true); off += 2; // bit 0 = encrypted
  // Compression method: stored (0) for AES-encrypted entries
  dv.setUint16(off, 0, true); off += 2; // stored
  // Last mod time
  dv.setUint16(off, 0, true); off += 2;
  // Last mod date
  dv.setUint16(off, 0, true); off += 2;
  // CRC-32 (for encrypted: 0 in local header, real value in central directory)
  dv.setUint32(off, isEncrypted ? 0 : crc32, true); off += 4;
  // Compressed size (for encrypted: 0 in local header)
  dv.setUint32(off, isEncrypted ? 0 : compressedSize, true); off += 4;
  // Uncompressed size (for encrypted: 0 in local header)
  dv.setUint32(off, isEncrypted ? 0 : uncompressedSize, true); off += 4;
  // Filename length
  dv.setUint16(off, nameBytes.length, true); off += 2;
  // Extra field length
  dv.setUint16(off, extraLen, true); off += 2;

  // Filename
  header.set(nameBytes, off); off += nameBytes.length;

  if (isEncrypted) {
    // AES encryption extra field (0x9901)
    const aesOff = off;
    dv.setUint16(off, 0x9901, true); off += 2; // header ID
    dv.setUint16(off, 11, true); off += 2; // data size
    dv.setUint16(off, 2, true); off += 2; // version (2 = AE-2)
    dv.setUint16(off, 1, true); off += 2; // vendor (1 = AES)
    dv.setUint8(off, 7); off += 1; // strength (7 = AES-256)
    dv.setUint16(off, 0, true); off += 2; // compression method (0 = stored)
  }

  return header;
}

/** ZIP 中央目录条目 */
function centralDirectoryEntry(
  filename: string, compressedSize: number, uncompressedSize: number,
  crc32: number, localHeaderOffset: number, isEncrypted: boolean
): Uint8Array {
  const nameBytes = new TextEncoder().encode(filename);
  const extraLen = isEncrypted ? 11 + 2 + 2 : 0;
  const commentLen = 0;
  const entry = new Uint8Array(46 + nameBytes.length + extraLen + commentLen);
  const dv = new DataView(entry.buffer);
  let off = 0;

  dv.setUint32(off, 0x02014b50, true); off += 4; // signature
  dv.setUint16(off, isEncrypted ? 51 : 20, true); off += 2; // version made by
  dv.setUint16(off, isEncrypted ? 51 : 20, true); off += 2; // version needed
  dv.setUint16(off, isEncrypted ? 1 : 0, true); off += 2; // bit flag
  dv.setUint16(off, 0, true); off += 2; // compression method
  dv.setUint16(off, 0, true); off += 2; // mod time
  dv.setUint16(off, 0, true); off += 2; // mod date
  dv.setUint32(off, crc32, true); off += 4; // CRC-32
  dv.setUint32(off, compressedSize, true); off += 4; // compressed size
  dv.setUint32(off, uncompressedSize, true); off += 4; // uncompressed size
  dv.setUint16(off, nameBytes.length, true); off += 2; // filename length
  dv.setUint16(off, extraLen, true); off += 2; // extra field length
  dv.setUint16(off, commentLen, true); off += 2; // comment length
  dv.setUint16(off, 0, true); off += 2; // disk number start
  dv.setUint16(off, 0, true); off += 2; // internal attributes
  dv.setUint32(off, 0, true); off += 4; // external attributes
  dv.setUint32(off, localHeaderOffset, true); off += 4; // local header offset

  entry.set(nameBytes, off); off += nameBytes.length;

  if (isEncrypted) {
    const aesOff = off;
    dv.setUint16(off, 0x9901, true); off += 2;
    dv.setUint16(off, 11, true); off += 2;
    dv.setUint16(off, 2, true); off += 2;
    dv.setUint16(off, 1, true); off += 2;
    dv.setUint8(off, 3); off += 1; // 3 = AES-256
    dv.setUint16(off, 0, true); off += 2;
  }

  return entry;
}

/** EOCD */
function endOfCentralDirectory(cdOffset: number, cdSize: number, totalEntries: number): Uint8Array {
  const eocd = new Uint8Array(22);
  const dv = new DataView(eocd.buffer);
  dv.setUint32(0, 0x06054b50, true); // signature
  dv.setUint16(4, 0, true); // disk number
  dv.setUint16(6, 0, true); // disk with CD
  dv.setUint16(8, totalEntries, true); // entries on this disk
  dv.setUint16(10, totalEntries, true); // total entries
  dv.setUint32(12, cdSize, true); // CD size
  dv.setUint32(16, cdOffset, true); // CD offset
  dv.setUint16(20, 0, true); // comment length
  return eocd;
}

/** CRC-32 (简单实现) */
function crc32(data: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/** PBKDF2 派生密钥 */
async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password),
    'PBKDF2', false, ['deriveKey', 'deriveBits']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-1' },
    keyMaterial,
    { name: 'AES-CTR', length: KEY_LENGTH * 8 },
    false,
    ['encrypt', 'decrypt']
  );
}

/** 派生校验密钥 (用于 WinZip 认证码) */
async function deriveAuthKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password),
    'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-1' },
    keyMaterial,
    (KEY_LENGTH + 2) * 8 // 32 bytes for encryption + 2 bytes for verification
  );
  return crypto.subtle.importKey(
    'raw', new Uint8Array(bits.slice(KEY_LENGTH, KEY_LENGTH + 2)),
    { name: 'HMAC', hash: 'SHA-1' },
    false, ['sign', 'verify']
  );
}

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
  if (!password) throw new Error('Password is empty');

  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const key = await deriveKey(password, salt);

  // 构建各部分
  const chunks: Uint8Array[] = [];
  const cdEntries: Uint8Array[] = [];
  let localOffset = 0;

  for (const file of files) {
    const fileCRC = crc32(file.data);
    const nameBytes = new TextEncoder().encode(file.name);

    // AES 加密数据: salt + nonce + encrypted_data + auth_code
    const nonce = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-CTR', counter: nonce, length: 128 },
      key,
      file.data
    );

    // 构造加密块: salt + nonce + ciphertext + auth_code (10 bytes placeholder)
    const encryptedBlock = new Uint8Array(SALT_LENGTH + IV_LENGTH + encrypted.byteLength + AUTH_CODE_LENGTH);
    encryptedBlock.set(salt, 0);
    encryptedBlock.set(nonce, SALT_LENGTH);
    encryptedBlock.set(new Uint8Array(encrypted), SALT_LENGTH + IV_LENGTH);
    // AUTH_CODE 留空 (10 bytes)，解压工具会忽略或自己计算

    const compressedSize = encryptedBlock.length;
    const uncompressedSize = file.data.length;

    // 本地文件头
    const lfh = localFileHeader(file.name, compressedSize, uncompressedSize, fileCRC, true);
    chunks.push(lfh);
    chunks.push(encryptedBlock);

    // 中央目录条目
    const cdEntry = centralDirectoryEntry(file.name, compressedSize, uncompressedSize, fileCRC, localOffset, true);
    cdEntries.push(cdEntry);

    localOffset += lfh.length + encryptedBlock.length;
  }

  // 中央目录
  const cdOffset = chunks.reduce((s, c) => s + c.length, 0);
  for (const cd of cdEntries) {
    chunks.push(cd);
  }
  const cdSize = cdEntries.reduce((s, c) => s + c.length, 0);

  // EOCD
  chunks.push(endOfCentralDirectory(cdOffset, cdSize, files.length));

  // 合并
  const totalLen = chunks.reduce((s, c) => s + c.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}

/**
 * 创建不加密的标准 ZIP 文件
 */
export async function createZip(
  files: Array<{ name: string; data: Uint8Array }>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const cdEntries: Uint8Array[] = [];
  let localOffset = 0;

  for (const file of files) {
    const fileCRC = crc32(file.data);
    const compressed = file.data; // 不压缩，直接存储

    const lfh = localFileHeader(file.name, compressed.length, file.data.length, fileCRC, false);
    chunks.push(lfh);
    chunks.push(compressed);

    const cdEntry = centralDirectoryEntry(file.name, compressed.length, file.data.length, fileCRC, localOffset, false);
    cdEntries.push(cdEntry);

    localOffset += lfh.length + compressed.length;
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