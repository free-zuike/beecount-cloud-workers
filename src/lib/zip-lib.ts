/**
 * ZIP 加密工具 — 使用 Web Crypto API 实现 AES-256-GCM 加密
 * 兼容 Cloudflare Workers
 */

/**
 * 创建 AES-256-GCM 加密文件
 * 格式: IV(16字节) + 加密数据 + GCM tag(16字节)
 *
 * @param files 要打包的文件列表 [{name, data}]
 * @param password 加密密码（通过 PBKDF2 派生密钥）
 * @returns 加密后的文件字节
 */
export async function createEncryptedZip(
  files: Array<{ name: string; data: Uint8Array }>,
  password: string,
): Promise<Uint8Array> {
  // 1. 将所有文件打包为 tar 格式（无压缩，因为加密后压缩无效）
  const tarData = createTar(files);
  
  // 2. 使用 PBKDF2 派生 AES 密钥
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  const aesKey = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: 100000,
      hash: 'SHA-256',
    },
    passwordKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );

  // 3. AES-256-GCM 加密
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    tarData
  );

  // 4. 组装输出: salt(16) + iv(12) + 加密数据(含最后16字节GCM tag)
  const result = new Uint8Array(16 + 12 + encrypted.byteLength);
  result.set(salt, 0);
  result.set(iv, 16);
  result.set(new Uint8Array(encrypted), 28);
  return result;
}

/**
 * 解密 AES-256-GCM 加密文件
 */
export async function decryptEncryptedZip(
  data: Uint8Array,
  password: string,
): Promise<Uint8Array> {
  const salt = data.slice(0, 16);
  const iv = data.slice(16, 28);
  const encrypted = data.slice(28);

  const passwordKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  const aesKey = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: 100000,
      hash: 'SHA-256',
    },
    passwordKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    encrypted
  );
  return new Uint8Array(decrypted);
}

/**
 * 创建简单 tar 格式（无压缩，仅用于加密前打包）
 */
function createTar(files: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const blocks: Uint8Array[] = [];
  const encoder = new TextEncoder();

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const data = file.data;
    const header = new Uint8Array(512);
    
    // 文件名 (100 bytes)
    header.set(nameBytes.slice(0, 100), 0);
    
    // 文件大小 (12 bytes, octal)
    const sizeStr = data.length.toString(8).padStart(11, '0');
    header.set(encoder.encode(sizeStr), 124);
    
    // 文件类型 (1 byte, '0' = regular file)
    header[156] = 0x30; // '0'
    
    // 校验和 (8 bytes, spaces)
    const checksumBytes = encoder.encode('        ');
    header.set(checksumBytes, 148);
    
    // 计算校验和
    let checksum = 0;
    for (let i = 0; i < 512; i++) {
      checksum += header[i];
    }
    const checksumStr = checksum.toString(8).padStart(6, '0');
    header.set(encoder.encode(checksumStr), 148);
    header[154] = 0x20; // space
    header[155] = 0x20; // space
    
    blocks.push(header);
    blocks.push(data);
    
    // 填充到 512 字节对齐
    const padding = (512 - (data.length % 512)) % 512;
    if (padding > 0) {
      blocks.push(new Uint8Array(padding));
    }
  }

  // 两个 512 字节的结束块
  blocks.push(new Uint8Array(1024));

  const totalSize = blocks.reduce((sum, b) => sum + b.length, 0);
  const result = new Uint8Array(totalSize);
  let offset = 0;
  for (const block of blocks) {
    result.set(block, offset);
    offset += block.length;
  }
  return result;
}