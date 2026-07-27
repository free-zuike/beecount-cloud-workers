/**
 * AES-256-GCM 加密/解密 + 标准 AES-256 加密 zip（与原版 pyzipper WZ_AES 兼容）
 */
import JSZip from 'jszip';

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
 * 创建标准 AES-256 加密 zip 文件（WinZip AES，与原版 pyzipper WZ_AES 兼容）
 * 可用 7-Zip / WinRAR / macOS Archive Utility 等工具打开输入密码解压
 * zip 内包含 backup.tar.gz 文件
 */
export async function createEncryptedZip(tarGzBytes: Uint8Array, password: string): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('backup.tar.gz', tarGzBytes, { binary: true });
  return zip.generateAsync({
    type: 'uint8array',
    password,
    encryption: 'AES256',
  });
}

/**
 * 从标准 AES-256 加密 zip 中提取 backup.tar.gz
 */
export async function extractEncryptedZip(zipBytes: Uint8Array, password: string): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(zipBytes, { password });
  const file = zip.file('backup.tar.gz');
  if (!file) throw new Error('Encrypted zip does not contain backup.tar.gz');
  return file.async('uint8array');
}