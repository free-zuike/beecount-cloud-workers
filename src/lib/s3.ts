/**
 * S3 签名辅助函数公共模块
 *
 * 提供 AWS Signature V4 签名、S3 上传等通用功能，
 * 供 index.ts、admin_backup.ts、profile.ts、attachments.ts 共用。
 */

// ===========================
// 底层加密辅助函数
// ===========================

export async function hmac(key: Uint8Array | ArrayBuffer, data: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    (key as ArrayBuffer),
    { name: 'HMAC', hash: { name: 'SHA-256' } },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data));
  return new Uint8Array(signature);
}

export async function sha256Hex(data: string): Promise<string> {
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(data));
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function hmacHex(key: Uint8Array, data: string): Promise<string> {
  const signature = await hmac(key, data);
  return Array.from(signature).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function getSignatureKey(key: string, dateStamp: string, regionName: string, serviceName: string): Promise<Uint8Array> {
  const kDate = await hmac(new TextEncoder().encode(`AWS4${key}`), dateStamp);
  const kRegion = await hmac(kDate, regionName);
  const kService = await hmac(kRegion, serviceName);
  const kSigning = await hmac(kService, 'aws4_request');
  return kSigning;
}

// ===========================
// S3 签名请求
// ===========================

/**
 * 签名 S3 请求（空 body hash 版本，用于 PUT/GET/DELETE 等不带 body 的请求）
 * - payloadHash 使用空字符串的 SHA-256
 * - signedHeaders: host, x-amz-content-sha256, x-amz-date
 */
export async function signS3Request(
  accessKey: string,
  secretKey: string,
  region: string,
  endpoint: string,
  bucket: string,
  key: string,
  method: string
): Promise<{ url: string; headers: Record<string, string> }> {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:\-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const service = 's3';

  const url = `${endpoint}/${bucket}/${key}`;
  const host = new URL(endpoint).host;

  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const payloadHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

  const canonicalRequest = `${method}\n/${bucket}/${key}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;

  const hashedCanonicalRequest = await sha256Hex(canonicalRequest);
  const stringToSign = `${algorithm}\n${amzDate}\n${credentialScope}\n${hashedCanonicalRequest}`;

  const signingKey = await getSignatureKey(secretKey, dateStamp, region, service);
  const signature = await hmacHex(signingKey, stringToSign);

  const authorizationHeader = `${algorithm} Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    url,
    headers: {
      'Host': host,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
      'Authorization': authorizationHeader
    }
  };
}

/**
 * 签名 S3 请求（带 content-type 和 UNSIGNED-PAYLOAD 版本）
 * - payloadHash: UNSIGNED-PAYLOAD
 * - signedHeaders: content-type, host, x-amz-content-sha256, x-amz-date
 * 用于 profile.ts 和 attachments.ts 中需要指定 content-type 的场景
 */
export async function signRequest(
  accessKey: string,
  secretKey: string,
  region: string,
  endpoint: string,
  bucket: string,
  key: string,
  method: string,
  contentType: string,
  bodyLength: number
): Promise<{ url: string; headers: Record<string, string> }> {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:\-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const service = 's3';

  const url = `${endpoint}/${bucket}/${key}`;
  const host = new URL(endpoint).host;

  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-amz-content-sha256:UNSIGNED-PAYLOAD\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
  const payloadHash = 'UNSIGNED-PAYLOAD';

  const canonicalRequest = `${method}\n/${bucket}/${key}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const hashedCanonicalRequest = await sha256Hex(canonicalRequest);
  const stringToSign = `${algorithm}\n${amzDate}\n${credentialScope}\n${hashedCanonicalRequest}`;

  const signingKey = await getSignatureKey(secretKey, dateStamp, region, service);
  const signature = await hmacHex(signingKey, stringToSign);

  const authorizationHeader = `${algorithm} Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    url,
    headers: {
      'Content-Type': contentType,
      'X-Amz-Date': amzDate,
      'X-Amz-Content-SHA256': payloadHash,
      'Authorization': authorizationHeader
    }
  };
}

// ===========================
// S3 上传
// ===========================

export async function uploadToS3(
  endpoint: string,
  bucket: string,
  accessKey: string,
  secretKey: string,
  region: string,
  key: string,
  content: string | Uint8Array,
  contentType: string = 'application/json'
): Promise<{ ok: boolean; message: string; etag?: string }> {
  try {
    const { url, headers } = await signS3Request(
      accessKey,
      secretKey,
      region,
      endpoint,
      bucket.replace(/^\/+/, ''),
      key,
      'PUT'
    );

    const contentLength = typeof content === 'string' ? content.length : content.length;

    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        ...headers,
        'Content-Type': contentType,
        'Content-Length': String(contentLength)
      },
      body: content
    });

    if (response.ok) {
      const etag = response.headers.get('ETag') || undefined;
      return { ok: true, message: 'Upload successful', etag };
    } else {
      const errorText = await response.text().catch(() => '');
      return { ok: false, message: `Upload failed: HTTP ${response.status} ${response.statusText} ${errorText}`.slice(0, 200) };
    }
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    return { ok: false, message: `Upload error: ${errorMsg}` };
  }
}
