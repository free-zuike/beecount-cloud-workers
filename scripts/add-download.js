const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'src', 'services', 'backup-executor.ts');
let content = fs.readFileSync(filePath, 'utf8');

const marker = 'export async function resolveAliasRemote';
const newBlock = `export async function downloadBackupFile(
  remoteConfig: Record<string, string>,
  key: string,
): Promise<Uint8Array | null> {
  const bt = remoteConfig.backend_type;

  if (bt === 's3' || bt === 'b2') {
    const { downloadFromS3 } = require('../lib/s3');
    const isB2 = bt === 'b2';
    const endpoint = remoteConfig.endpoint || (isB2 ? 'https://s3.eu-central-003.backblazeb2.com' : 'https://s3.amazonaws.com');
    const bucket = remoteConfig.bucket;
    const accessKey = isB2 ? (remoteConfig.account || remoteConfig.access_key_id)?.trim() : (remoteConfig.access_key_id || remoteConfig.key)?.trim();
    const secretKey = isB2 ? (remoteConfig.key || remoteConfig.secret_access_key)?.trim() : (remoteConfig.secret_access_key || remoteConfig.account)?.trim();
    const region = remoteConfig.region || 'auto';
    return await downloadFromS3(endpoint, bucket!, accessKey!, secretKey!, region, key);
  }

  if (bt === 'webdav') {
    const baseUrl = remoteConfig.url;
    const username = remoteConfig.username || remoteConfig.user;
    const password = remoteConfig.password || remoteConfig.pass;
    if (!baseUrl || !username || !password) return null;
    const auth = 'Basic ' + Buffer.from(username + ':' + password).toString('base64');
    const response = await fetch(baseUrl + key, {
      headers: { 'Authorization': auth },
    });
    if (!response.ok) return null;
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }

  if (bt === 'drive' || bt === 'onedrive' || bt === 'dropbox') {
    const { refreshAccessToken } = require('../lib/oauth2-storage');
    const tokenEndpoints: Record<string, string> = {
      drive: 'https://oauth2.googleapis.com/token',
      onedrive: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      dropbox: 'https://api.dropbox.com/oauth2/token',
    };
    const token = await refreshAccessToken(bt as any, remoteConfig.client_id!, remoteConfig.client_secret!, remoteConfig.token!);
    if (!token) return null;

    if (bt === 'drive') {
      // Google Drive: use file ID in key (Path from list)
      const res = await fetch(\`https://www.googleapis.com/drive/v3/files/\${key}?alt=media\`, {
        headers: { 'Authorization': \`Bearer \${token}\` },
      });
      if (!res.ok) return null;
      const buffer = await res.arrayBuffer();
      return new Uint8Array(buffer);
    }
    if (bt === 'dropbox') {
      const res = await fetch('https://content.dropboxapi.com/2/files/download', {
        method: 'POST',
        headers: {
          'Authorization': \`Bearer \${token}\`,
          'Dropbox-API-Arg': JSON.stringify({ path: key }),
        },
      });
      if (!res.ok) return null;
      const buffer = await res.arrayBuffer();
      return new Uint8Array(buffer);
    }
    return null;
  }

  return null;
}

export async function resolveAliasRemote`;
content = content.replace(marker, newBlock);
fs.writeFileSync(filePath, content, 'utf8');
console.log('Done');