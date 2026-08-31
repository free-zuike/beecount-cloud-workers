const fs = require('fs');
const path = require('path');
const ACCOUNT_ID = '3f762871bd2e6a373f70d3b3a8e5dc88';
const BUCKET = 'beecount-storage';
const ENDPOINT = `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`;
const configPath = path.join(process.env.USERPROFILE || process.env.HOME, '.wrangler', 'config', 'default.toml');
const oauthToken = fs.readFileSync(configPath, 'utf8').match(/oauth_token\s*=\s*"([^"]+)"/)[1];

async function sha256Hex(data) {
  const buf = Buffer.from(data, 'utf8');
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}
async function hmac(key, data) {
  const keyBuf = Buffer.from(key, 'utf8');
  const cryptoKey = await crypto.subtle.importKey('raw', keyBuf, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, Buffer.from(data, 'utf8'));
  return new Uint8Array(sig);
}
function toHex(buf) { return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join(''); }

async function signS3(method, pathStr) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:\-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const host = `${ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const canonicalUri = pathStr.startsWith('/') ? pathStr : '/' + pathStr;
  const headers = { host, 'x-amz-date': amzDate, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' };
  const sortedKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedKeys.map(k => `${k}:${headers[k]}`).join('\n') + '\n';
  const signedHeaders = sortedKeys.join(';');
  const canonicalRequest = `${method}\n${canonicalUri}\n\n${canonicalHeaders}\n\n${signedHeaders}\nUNSIGNED-PAYLOAD`;
  const credentialScope = `${dateStamp}/auto/s3/aws4_request`;
  const hashedCR = await sha256Hex(canonicalRequest);
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${hashedCR}`;
  const kDate = await hmac(oauthToken, dateStamp);
  const kRegion = await hmac(kDate, 'auto');
  const kService = await hmac(kRegion, 's3');
  const kSigning = await hmac(kService, 'aws4_request');
  const sig = await hmac(kSigning, stringToSign);
  headers['authorization'] = `AWS4-HMAC-SHA256 Credential=${oauthToken}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${toHex(sig)}`;
  return { url: `https://${host}/${BUCKET}${canonicalUri}`, headers };
}

async function list(prefix) {
  const all = [];
  let marker = '';
  do {
    const qs = new URLSearchParams({ 'list-type': '2', prefix });
    if (marker) qs.set('marker', marker);
    const { url, headers } = await signS3('GET', `/?${qs}`);
    const resp = await fetch(url, { headers });
    if (!resp.ok) break;
    const text = await resp.text();
    for (const m of text.matchAll(/<Key>([^<]+)<\/Key>/g)) all.push(m[1]);
    const isTruncated = text.includes('<IsTruncated>true</IsTruncated>');
    const nm = text.match(/<NextMarker>([^<]+)<\/NextMarker>/);
    marker = isTruncated ? (nm?.[1] || '') : '';
  } while (marker);
  return all;
}

(async () => {
  const all = await list('');
  console.log('Total objects:', all.length);
  console.log('\nSample keys:');
  all.slice(0, 30).forEach(k => console.log(' ', k));
  const avatars = all.filter(k => k.startsWith('avatars/') || k.startsWith('beecount/avatars/'));
  const atts = all.filter(k => k.startsWith('attachments/') || k.startsWith('beecount/attachments/'));
  console.log('\navatars/:', avatars.length);
  console.log('attachments/:', atts.length);
  console.log('beecount/avatars/:', all.filter(k => k.startsWith('beecount/avatars/')).length);
  console.log('beecount/attachments/:', all.filter(k => k.startsWith('beecount/attachments/')).length);
})();
