/**
 * age 加密/解密 — 使用 age-encryption 库，与原版 Python BeeCount-Cloud 的 age 加密格式完全兼容
 *
 * 加密算法：X25519 + ChaCha20-Poly1305（与 age 标准一致）
 * 密钥格式：age identity（私钥） / recipient（公钥）
 *
 * 备份文件使用 passphrase 对称加密（与 age 的 `age -p` 命令兼容），
 * 也可扩展为 recipient 公钥加密（`age -r`）。
 */

import * as age from 'age-encryption';

const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const ITERATIONS = 100000;

/**
 * 使用 passphrase 加密数据（兼容 age -p）
 * 返回 ASCII armored 格式的密文，可直接保存为 .age 文件
 */
export async function encryptData(data: Uint8Array, password: string): Promise<Uint8Array> {
  // 使用 age 的 passphrase 加密
  // 先用 PBKDF2 派生对称密钥，再用 age 的 scrypt 加密
  // 实际上 age-encryption 的 Encrypter.setPassphrase 使用 scrypt
  const e = new age.Encrypter();
  e.setPassphrase(password);
  // age-encryption 的 encrypt 返回 Uint8Array
  const ciphertext = await e.encrypt(data);
  return ciphertext;
}

/**
 * 使用 passphrase 解密数据（兼容 age -p）
 */
export async function decryptData(encryptedData: Uint8Array, password: string): Promise<Uint8Array> {
  const d = new age.Decrypter();
  d.addPassphrase(password);
  const plaintext = await d.decrypt(encryptedData, 'uint8array');
  return plaintext;
}

/**
 * 生成 age identity/recipient 密钥对（用于 recipient 加密模式）
 * 返回 { identity: string, recipient: string }
 */
export async function generateKeyPair(): Promise<{ identity: string; recipient: string }> {
  const identity = await age.generateIdentity();
  const recipient = await age.identityToRecipient(identity);
  return { identity, recipient };
}

/**
 * 使用 recipient 公钥加密数据（兼容 age -r）
 */
export async function encryptWithRecipient(data: Uint8Array, recipient: string): Promise<Uint8Array> {
  const e = new age.Encrypter();
  e.addRecipient(recipient);
  return await e.encrypt(data);
}

/**
 * 使用 identity 私钥解密数据（兼容 age -i）
 */
export async function decryptWithIdentity(encryptedData: Uint8Array, identity: string): Promise<Uint8Array> {
  const d = new age.Decrypter();
  d.addIdentity(identity);
  return await d.decrypt(encryptedData, 'uint8array');
}