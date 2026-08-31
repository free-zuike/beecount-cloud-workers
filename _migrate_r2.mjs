/**
 * R2 批量迁移脚本：将 avatars/ attachments/ category-icons/ 迁移到 beecount/ 前缀下
 * 通过 Cloudflare API Token 认证
 *
 * 用法：
 *   R2_ACCESS_KEY=xxx R2_SECRET_KEY=yyy node _migrate_r2.mjs
 * 或者在 wrangler.toml 中配置了 R2 绑定后运行：
 *   npx wrangler r2 --cwd . node _migrate_r2.mjs
 */

const ACCOUNT_ID = '3f762871bd2e6a373f70d3b3a8e5dc88'; // 从日志中提取
const BUCKET_NAME = 'beecount-storage';

// 从环境变量或 wrangler 配置读取 R2 凭证
const ACCESS_KEY = process.env.R2_ACCESS_KEY;
const SECRET_KEY = process.env.R2_SECRET_KEY;

if (!ACCESS_KEY || !SECRET_KEY) {
  console.error('请设置 R2_ACCESS_KEY 和 R2_SECRET_KEY 环境变量');
  console.error('或者在 Cloudflare Dashboard → R2 API Tokens 创建专用 token');
  process.exit(1);
}

const ENDPOINT = `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`;

async function sha256Hex(data) {
  const buf = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmac(key, data) {
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
  return new Uint8Array(sig);
}

async function signS3(method, path, options = {}) {
  const { body, contentType } = options;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:\-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const host = new URL(ENDPOINT).host;
  const canonicalUri = path.startsWith('/') ? path : '/' + path;
  const canonicalQueryString = '';

  const headers = {
    host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
  };
  if (contentType) headers['content-type'] = contentType;

  const sortedHeaders = Object.keys(headers).sort().map(k => `${k}:${headers[k]}`).join('\n');
  const signedHeaders = Object.keys(headers).sort().join(';');
  const payloadHash = 'UNSIGNED-PAYLOAD';
  const canonicalRequest = `${method}\n${canonicalUri}\n${canonicalQueryString}\n${sortedHeaders}\n\n${signedHeaders}\n${payloadHash}`;

  const credentialScope = `${dateStamp}/auto/s3/aws4_request`;
  const hashedCR = await sha256Hex(canonicalRequest);
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${hashedCR}`;

  const kDate = await hmac(SECRET_KEY, dateStamp);
  const kRegion = await hmac(kDate, 'auto');
  const kService = await hmac(kRegion, 's3');
  const kSigning = await hmac(kService, 'aws4_request');
  const signature = await hmac(kSigning, stringToSign);
  const sigHex = Array.from(signature).map(b => b.toString(16).padStart(2, '0')).join('');

  headers['authorization'] = `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${sigHex}`;

  return { url: `${ENDPOINT}${canonicalUri}`, headers };
}

async function listObjects(prefix) {
  const objects = [];
  let delimiter = '';
  let marker = '';
  do {
    const qs = new URLSearchParams({ 'list-type': '2', prefix, delimiter });
    if (marker) qs.set('marker', marker);
    const { url, headers } = await signS3('GET', `/${BUCKET_NAME}?${qs}`);
    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      console.error(`Failed to list ${prefix}:`, await resp.text());
      break;
    }
    const text = await resp.text();
    const keyRegex = /<Key>([^<]+)<\/Key>/g;
    let match;
    while ((match = keyRegex.exec(text)) !== null) {
      objects.push(match[1]);
    }
    const isTruncatedMatch = text.match(/<IsTruncated>(true|false)<\/IsTruncated>/);
    const nextMarkerMatch = text.match(/<NextMarker>([^<]+)<\/NextMarker>/);
    marker = isTruncatedMatch && isTruncatedMatch[1] === 'true' ? (nextMarkerMatch?.[1] || '') : '';
  } while (marker);
  return objects;
}

async function copyObject(srcKey, destKey) {
  const copySource = `/${BUCKET_NAME}/${encodeURIComponent(srcKey)}`;
  const { url, headers } = await signS3('PUT', `/${encodeURIComponent(destKey)}`);
  headers['x-amz-copy-source'] = copySource;
  const resp = await fetch(url, { method: 'PUT', headers });
  if (!resp.ok) {
    const txt = await resp.text();
    console.error(`Copy failed ${srcKey} → ${destKey}:`, txt.slice(0, 200));
    return false;
  }
  return true;
}

async function deleteObject(key) {
  const { url, headers } = await signS3('DELETE', `/${encodeURIComponent(key)}`);
  const resp = await fetch(url, { method: 'DELETE', headers });
  return resp.ok || resp.status === 404;
}

async function main() {
  console.log(`R2 Migration: ${ENDPOINT} / ${BUCKET_NAME}`);
  console.log(`Account: ${ACCOUNT_ID}\n`);

  const prefixes = ['avatars/', 'attachments/', 'category-icons/'];
  let total = 0, errors = 0;

  for (const prefix of prefixes) {
    console.log(`[${prefix}] Scanning...`);
    const objects = await listObjects(prefix);
    console.log(`  Found ${objects.length} objects`);

    for (const key of objects) {
      const destKey = `beecount/${key}`;
      try {
        const ok = await copyObject(key, destKey);
        if (ok) {
          const delOk = await deleteObject(key);
          if (delOk) {
            total++;
          } else {
            console.error(`  Delete failed: ${key}`);
            errors++;
          }
        } else {
          errors++;
        }
        if (total % 50 === 0) console.log(`  Progress: ${total} migrated...`);
      } catch (e) {
        console.error(`  Error on ${key}:`, e.message);
        errors++;
      }
    }
    console.log(`  Done: ${objects.length} objects processed\n`);
  }

  console.log(`\n✅ Migration complete!`);
  console.log(`   Total migrated: ${total}`);
  console.log(`   Errors: ${errors}`);
}

main().catch(e => { console.error(e); process.exit(1); });
