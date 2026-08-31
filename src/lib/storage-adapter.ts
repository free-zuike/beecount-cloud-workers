/**
 * 通用对象存储适配器
 *
 * 统一调用所有已配置的远端（R2/S3/B2/WebDAV/FTP/SFTP）进行文件存取。
 * 优先级：R2（Worker 绑定）> S3/B2 > WebDAV > FTP > SFTP
 * 所有 key 统一以 beecount/ 为前缀，避免污染远端根目录。
 */
import { serverLogger } from './logger';
import { uploadToS3, downloadFromS3, deleteS3Object } from './s3';
import { createFtpClient } from './ftp';
import { createSftpClient } from './sftp';

// 统一前缀，所有存储操作都在 beecount/ 子目录下
const PREFIX = 'beecount/';

/** 给 key 加上统一前缀（避免空 key 时出问题） */
function prefixKey(key: string): string {
  return PREFIX + key.replace(/^\//, '');
}

// 安全解析 config_summary
function parseConfig(summary: string): Record<string, any> {
  if (!summary) return {};
  try { return JSON.parse(summary); } catch { return {}; }
}

interface RemoteEntry {
  id: string;
  backend_type: string;
  config: Record<string, any>;
}

/** 获取所有未加密的已配置远端 */
export async function getAllEnabledRemotes(db: D1Database): Promise<RemoteEntry[]> {
  const rows = await db.prepare(
    'SELECT id, backend_type, config_summary FROM backup_remotes WHERE encrypted = 0'
  ).all<{ id: string; backend_type: string; config_summary: string }>();
  return (rows.results || []).map(r => ({
    id: r.id,
    backend_type: r.backend_type,
    config: parseConfig(r.config_summary),
  }));
}

/** 按优先级过滤远端（去掉 OAuth 类） */
function filterUploadable(remotes: RemoteEntry[]): RemoteEntry[] {
  return remotes.filter(r => !['drive', 'onedrive', 'dropbox'].includes(r.backend_type));
}

/** 构建 S3 兼容上传参数（兼容 S3/B2 字段名差异） */
function toS3UploadParams(rc: RemoteEntry, key: string, contentType: string, body: Uint8Array) {
  const c = rc.config;
  const isB2 = rc.backend_type === 'b2';
  let endpoint = c.endpoint;
  if (isB2 && !endpoint) {
    try {
      endpoint = 'https://s3.eu-central-003.backblazeb2.com';
    } catch {}
  }
  if (!endpoint) endpoint = isB2 ? 'https://s3.eu-central-003.backblazeb2.com' : 'https://s3.amazonaws.com';
  const accessKey = (isB2 ? (c.account || c.access_key_id || '') : (c.access_key_id || c.key || '')).trim();
  const secretKey = (isB2 ? (c.key || c.secret_access_key || '') : (c.secret_access_key || c.account || '')).trim();
  const region = c.region || 'auto';
  const bucket = (c.bucket || '').trim();
  let prefix = '';
  if (c.savePath && c.savePath !== 'custom') prefix = c.savePath.replace(/^\/+|\/+$/g, '') + '/';
  else if (c.root_path) prefix = c.root_path.replace(/^\/+|\/+$/g, '') + '/';
  return { endpoint, bucket, accessKey, secretKey, region, key: prefix + key, contentType, body };
}

/**
 * 上传文件到第一个可用的远端
 * 返回 { ok, key? }，失败时 ok=false
 */
export async function uploadToStorage(
  db: D1Database,
  env: { R2?: R2Bucket },
  key: string,
  body: Uint8Array,
  contentType: string,
): Promise<{ ok: boolean; key?: string }> {
  const log = (msg: string) => serverLogger.info('storage-adapter', msg);

  // 1. R2（Worker 绑定，最高优先级）
  if (env.R2) {
    try {
      await env.R2.put(prefixKey(key), body, { httpMetadata: { contentType } });
      log(`R2 upload ok: ${key}`);
      return { ok: true, key };
    } catch (e) { log(`R2 upload failed: ${(e as Error).message}`); }
  }

  // 2. 遍历所有备份远端
  const remotes = filterUploadable(await getAllEnabledRemotes(db));
  for (const rc of remotes) {
    try {
      const result = await uploadToRemote(rc, key, body, contentType);
      if (result.ok) {
        log(`Upload ok via ${rc.backend_type}[${rc.id}]: ${key}`);
        return { ok: true, key: `${rc.backend_type}:${rc.id}/${key}` };
      }
      log(`Upload failed via ${rc.backend_type}[${rc.id}]: ${result.message}`);
    } catch (e) { log(`Upload error via ${rc.backend_type}[${rc.id}]: ${(e as Error).message}`); }
  }

  return { ok: false };
}

/**
 * 从第一个可用的远端下载文件
 */
export async function downloadFromStorage(
  db: D1Database,
  env: { R2?: R2Bucket },
  key: string,
): Promise<Uint8Array | null> {
  const log = (msg: string) => serverLogger.info('storage-adapter', msg);

  // 1. R2 — 优先新前缀，回退旧路径（兼容历史数据）
  if (env.R2) {
    const obj = await env.R2.get(prefixKey(key));
    if (obj) {
      log(`R2 download ok (new prefix): ${key}`);
      return new Uint8Array(await obj.arrayBuffer());
    }
    // 回退：尝试不带 beecount/ 前缀的旧路径
    const oldObj = await env.R2.get(key);
    if (oldObj) {
      log(`R2 download ok (legacy): ${key}`);
      return new Uint8Array(await oldObj.arrayBuffer());
    }
  }

  // 2. 遍历备份远端
  const remotes = filterUploadable(await getAllEnabledRemotes(db));
  for (const rc of remotes) {
    try {
      const result = await downloadFromRemote(rc, key);
      if (result.ok) {
        log(`Download ok via ${rc.backend_type}[${rc.id}]: ${key}`);
        return result.body ?? null;
      }
    } catch (e) { log(`Download error via ${rc.backend_type}[${rc.id}]: ${(e as Error).message}`); }
  }

  return null;
}

/**
 * 删除文件（best-effort，第一个成功的就返回）
 */
export async function deleteFromStorage(
  db: D1Database,
  env: { R2?: R2Bucket },
  key: string,
): Promise<void> {
  const log = (msg: string) => serverLogger.info('storage-adapter', msg);

  if (env.R2) {
    try { await env.R2.delete(prefixKey(key)); log(`R2 delete ok: ${key}`); } catch {}
  }

  const remotes = filterUploadable(await getAllEnabledRemotes(db));
  for (const rc of remotes) {
    try {
      const result = await deleteFromRemote(rc, key);
      if (result.ok) { log(`Delete ok via ${rc.backend_type}[${rc.id}]: ${key}`); break; }
    } catch {}
  }
}

// ---- 各远端具体实现 ----

async function uploadToRemote(rc: RemoteEntry, key: string, body: Uint8Array, contentType: string): Promise<{ ok: boolean; message: string }> {
  const c = rc.config;
  const bt = rc.backend_type;

  if (bt === 's3' || bt === 'b2') {
    const p = toS3UploadParams(rc, prefixKey(key), contentType, body);
    if (!p.bucket || !p.accessKey || !p.secretKey) return { ok: false, message: 'S3 config incomplete' };
    const result = await uploadToS3(p.endpoint, p.bucket, p.accessKey, p.secretKey, p.region, p.key, p.body, p.contentType);
    return result.ok ? { ok: true, message: 'ok' } : { ok: false, message: result.message };
  }

  if (bt === 'webdav') {
    const url = c.url?.replace(/\/+$/, '');
    const user = c.username || c.user || '';
    const pass = c.password || c.pass || '';
    if (!url || !user) return { ok: false, message: 'WebDAV config incomplete' };
    try {
      const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
      const fileUrl = `${url}/${prefixKey(key).replace(/^\//, '')}`;
      const resp = await fetch(fileUrl, { method: 'PUT', headers: { 'Authorization': auth, 'Content-Type': contentType }, body });
      return resp.ok ? { ok: true, message: 'ok' } : { ok: false, message: `HTTP ${resp.status}` };
    } catch (e) { return { ok: false, message: (e as Error).message }; }
  }

  if (bt === 'ftp') {
    try {
      const client = createFtpClient({
        host: c.host || c.hostname || '', port: parseInt(c.port || '21'),
        username: c.username || '', password: c.password || '',
      });
      let prefix = (c.savePath && c.savePath !== 'custom') ? c.savePath.replace(/^\/+|\/+$/g, '') + '/' :
                   (c.root_path ? c.root_path.replace(/^\/+|\/+$/g, '') + '/' : '');
      await client.upload(prefix + key, body);
      return { ok: true, message: 'ok' };
    } catch (e) { return { ok: false, message: (e as Error).message }; }
  }

  if (bt === 'sftp') {
    try {
      const client = createSftpClient({
        host: c.host || c.hostname || '', port: parseInt(c.port || '22'),
        username: c.username || '', password: c.password || '', privateKey: c.private_key || c.privateKey,
      });
      let prefix = (c.savePath && c.savePath !== 'custom') ? c.savePath.replace(/^\/+|\/+$/g, '') + '/' :
                   (c.root_path ? c.root_path.replace(/^\/+|\/+$/g, '') + '/' : '');
      await client.upload(prefix + key, body);
      return { ok: true, message: 'ok' };
    } catch (e) { return { ok: false, message: (e as Error).message }; }
  }

  return { ok: false, message: `Unsupported backend_type: ${bt}` };
}

async function downloadFromRemote(rc: RemoteEntry, key: string): Promise<{ ok: boolean; body?: Uint8Array }> {
  const c = rc.config;
  const bt = rc.backend_type;

  if (bt === 's3' || bt === 'b2') {
    const p = toS3UploadParams(rc, prefixKey(key), 'application/octet-stream', new Uint8Array(0));
    if (!p.bucket || !p.accessKey || !p.secretKey) return { ok: false };
    try {
      const body = await downloadFromS3(p.endpoint, p.bucket, p.accessKey, p.secretKey, p.region, p.key);
      return body ? { ok: true, body } : { ok: false };
    } catch { return { ok: false }; }
  }

  if (bt === 'webdav') {
    const url = c.url?.replace(/\/+$/, '');
    const user = c.username || c.user || '';
    const pass = c.password || c.pass || '';
    if (!url) return { ok: false };
    try {
      const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
      const resp = await fetch(`${url}/${prefixKey(key).replace(/^\//, '')}`, { headers: { 'Authorization': auth } });
      if (!resp.ok) return { ok: false };
      return { ok: true, body: new Uint8Array(await resp.arrayBuffer()) };
    } catch { return { ok: false }; }
  }

  // FTP/SFTP 下载暂不支持（附件场景基本不需要）
  return { ok: false };
}

async function deleteFromRemote(rc: RemoteEntry, key: string): Promise<{ ok: boolean }> {
  const c = rc.config;
  const bt = rc.backend_type;

  if (bt === 's3' || bt === 'b2') {
    const p = toS3UploadParams(rc, prefixKey(key), 'application/octet-stream', new Uint8Array(0));
    if (!p.bucket || !p.accessKey || !p.secretKey) return { ok: false };
    try {
      const ok = await deleteS3Object(p.endpoint, p.bucket, p.accessKey, p.secretKey, p.region, p.key);
      return { ok };
    } catch { return { ok: false }; }
  }

  if (bt === 'webdav') {
    const url = c.url?.replace(/\/+$/, '');
    const user = c.username || c.user || '';
    const pass = c.password || c.pass || '';
    if (!url) return { ok: false };
    try {
      const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
      const resp = await fetch(`${url}/${prefixKey(key).replace(/^\//, '')}`, { method: 'DELETE', headers: { 'Authorization': auth } });
      return { ok: resp.ok || resp.status === 404 };
    } catch { return { ok: false }; }
  }

  // FTP/SFTP 删除支持（可选）
  if (bt === 'ftp') {
    try {
      const client = createFtpClient({
        host: c.host || c.hostname || '', port: parseInt(c.port || '21'),
        username: c.username || '', password: c.password || '',
      });
      let prefix = (c.savePath && c.savePath !== 'custom') ? c.savePath.replace(/^\/+|\/+$/g, '') + '/' :
                   (c.root_path ? c.root_path.replace(/^\/+|\/+$/g, '') + '/' : '');
      const ok = await client.delete(prefix + prefixKey(key)).catch(() => false);
      return { ok };
    } catch { return { ok: false }; }
  }

  if (bt === 'sftp') {
    try {
      const client = createSftpClient({
        host: c.host || c.hostname || '', port: parseInt(c.port || '22'),
        username: c.username || '', password: c.password || '', privateKey: c.private_key || c.privateKey,
      });
      let prefix = (c.savePath && c.savePath !== 'custom') ? c.savePath.replace(/^\/+|\/+$/g, '') + '/' :
                   (c.root_path ? c.root_path.replace(/^\/+|\/+$/g, '') + '/' : '');
      const ok = await client.delete(prefix + prefixKey(key)).catch(() => false);
      return { ok };
    } catch { return { ok: false }; }
  }

  return { ok: false };
}
