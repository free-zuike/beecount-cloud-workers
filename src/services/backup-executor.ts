/**
 * 备份执行�?- 提取公共的备份执行逻辑
 *
 * �?src/index.ts（定时任务）�?src/routes/admin_backup.ts（管理员手动触发）共�?
 */

import { uploadToS3, listS3Objects, deleteS3Object, downloadFromS3 } from '../lib/s3';
import { createFtpClient } from '../lib/ftp';
import { createSftpClient } from '../lib/sftp';
import { createTarGz } from '../lib/tar';
import { createEncryptedZip } from '../lib/zip-lib';
import { computeRetentionDeletes, filterBackupFiles } from './backup-retention';
import { uploadToOAuth2Provider, listOAuth2Files, deleteOAuth2File, refreshAccessToken } from '../lib/oauth2-storage';
import { createSqliteWithData } from '../lib/sqlite-writer';

// ===========================
// WebDAV 工具函数
// ===========================

function buildWebDavAuth(username: string, password: string): string {
  return 'Basic ' + btoa(`${username}:${password}`);
}

function normalizeWebDavUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

async function webdavPropfind(url: string, auth: string, depth: number = 0): Promise<{ ok: boolean; status: number; body: string }> {
  const response = await fetch(url, {
    method: 'PROPFIND',
    headers: {
      'Authorization': auth,
      'Depth': String(depth),
      'Content-Type': 'application/xml',
    },
  });
  const body = await response.text().catch(() => '');
  return { ok: response.ok, status: response.status, body };
}

async function webdavMkcol(url: string, auth: string): Promise<{ ok: boolean; status: number }> {
  const response = await fetch(url, {
    method: 'MKCOL',
    headers: {
      'Authorization': auth,
    },
  });
  return { ok: response.ok || response.status === 405, status: response.status };
}

async function webdavPut(url: string, auth: string, content: string | Uint8Array): Promise<{ ok: boolean; status: number; message: string }> {
  const body = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': auth,
      'Content-Type': 'application/gzip',
      'Content-Length': String(body.length),
    },
    body,
  });
  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    return { ok: false, status: response.status, message: `PUT failed: HTTP ${response.status} ${response.statusText} ${errorText}`.slice(0, 200) };
  }
  return { ok: true, status: response.status, message: 'Upload successful' };
}

async function webdavGet(url: string, auth: string): Promise<{ ok: boolean; status: number; body: string; message: string }> {
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': auth,
    },
  });
  const body = await response.text().catch(() => '');
  if (!response.ok) {
    return { ok: false, status: response.status, body: '', message: `GET failed: HTTP ${response.status} ${response.statusText}` };
  }
  return { ok: true, status: response.status, body, message: 'Download successful' };
}

async function ensureWebDavDirectory(url: string, auth: string): Promise<void> {
  const parts = url.split('/').filter(Boolean);
  let current = url.includes('://') ? `${new URL(url).protocol}//${new URL(url).host}` : '';
  for (let i = 0; i < parts.length - 1; i++) {
    if (!current.endsWith('/')) current += '/';
    current += parts[i];
    if (!current.endsWith('/')) current += '/';
    await webdavMkcol(current, auth);
  }
}

async function uploadToWebDav(
  baseUrl: string,
  username: string,
  password: string,
  filePath: string,
  content: string | Uint8Array
): Promise<{ ok: boolean; message: string }> {
  try {
    const normalizedBase = normalizeWebDavUrl(baseUrl);
    const auth = buildWebDavAuth(username, password);
    const fileUrl = `${normalizedBase}/${filePath.replace(/^\/+/, '')}`;
    const dirUrl = fileUrl.substring(0, fileUrl.lastIndexOf('/') + 1);

    if (dirUrl && dirUrl !== `${normalizedBase}/`) {
      await ensureWebDavDirectory(dirUrl, auth);
    }

    const result = await webdavPut(fileUrl, auth, content);
    if (!result.ok) {
      return { ok: false, message: result.message };
    }
    return { ok: true, message: `WebDAV upload successful: ${filePath}` };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    return { ok: false, message: `WebDAV upload error: ${errorMsg}` };
  }
}

export interface BackupResult {
  success: boolean;
  message: string;
  backupSize?: number;
  backupPath?: string;
  attachmentsUploaded?: number;
}

// ===========================
// AES-256 加密 ZIP �?使用 '../lib/zip-lib' �?createEncryptedZip（基�?@zip.js/zip.js�?
// ===========================

async function getEncryptionPassword(
  remoteConfig: Record<string, string>,
  db: D1Database
): Promise<string | null> {
  if (remoteConfig.zipryption_password) {
    return remoteConfig.zipryption_password;
  }

  if (remoteConfig.zipryption_key_id) {
    const setting = await db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .bind(`backup_encryption_key:${remoteConfig.zipryption_key_id}`)
      .first<{ value: string }>();
    if (setting) {
      return setting.value;
    }
  }

  return null;
}

/**
 * 需要备份的用户数据表（排除运维类表，与原版 db_snapshot.py DEFAULT_EXCLUDED_TABLES 对齐�?
 * 排除：backup_runs, backup_run_targets, sync_push_idempotency, audit_logs, refresh_tokens, mcp_call_logs
 * 保留：PAT 表（用户 LLM 配置依赖�? backup_remotes/schedules（配置保留）, 所有用户数据表
 */
const BACKUP_TABLES = [
  'users',
  'user_profiles',
  'devices',
  'ledgers',
  'ledger_members',
  'ledger_invites',
  'sync_changes',
  'sync_cursors',
  'read_tx_projection',
  'read_account_projection',
  'read_category_projection',
  'read_tag_projection',
  'read_budget_projection',
  'attachment_files',
  'personal_access_tokens',
  'backup_remotes',
  'backup_schedules',
  'backup_runs',
  'backup_run_targets',
  // 'backup_schedule_remotes', // 表可能不存在，跳�?
  'system_settings',
  'recovery_codes',
  'exchange_rate_overrides',
  'backup_snapshots',
  'backup_restores',
];

/** D1 每次查询最多返回的行数 */
const D1_BATCH_SIZE = 1000;

/**
 * 导出单张表的所有数据（分批查询，处�?D1 行数限制�?
 */
async function exportTable(db: D1Database, tableName: string): Promise<unknown[]> {
  const allRows: unknown[] = [];
  let offset = 0;
  while (true) {
    const result = await db
      .prepare(`SELECT * FROM ${tableName} LIMIT ? OFFSET ?`)
      .bind(D1_BATCH_SIZE, offset)
      .all();
    const rows = result.results || [];
    allRows.push(...rows);
    if (rows.length < D1_BATCH_SIZE) break;
    offset += D1_BATCH_SIZE;
  }
  return allRows;
}

/**
 * �?R2 获取所有附件文�?
 * 返回 { name: Uint8Array } 映射，name �?tar 中的路径
 */
async function fetchR2Attachments(r2: R2Bucket): Promise<Map<string, Uint8Array>> {
  const attachments = new Map<string, Uint8Array>();
  const prefixes = ['attachments/', 'avatars/', 'category-icons/'];

  console.log(`[Backup] Fetching R2 files with prefixes: ${prefixes.join(', ')}`);

  let totalFiles = 0;
  let totalSize = 0;

  for (const prefix of prefixes) {
    let cursor: string | undefined;
    do {
      const listed = await r2.list({ prefix, cursor, limit: 1000 });
      cursor = listed.truncated ? listed.cursor : undefined;

      for (const obj of listed.objects) {
        try {
          const data = await r2.get(obj.key);
          if (data) {
            const arrayBuffer = await data.arrayBuffer();
            attachments.set(obj.key, new Uint8Array(arrayBuffer));
            totalFiles++;
            totalSize += obj.size;
            console.log(`[Backup] Fetched: ${obj.key} (${obj.size} bytes)`);
          }
        } catch (err) {
          console.error(`[Backup] Failed to fetch ${obj.key}: ${(err as Error).message}`);
        }
      }
    } while (cursor);
  }

  console.log(`[Backup] Total R2 files: ${totalFiles} files, ${totalSize} bytes`);
  return attachments;
}

/**
 * 带重试的异步操作
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  delayMs: number = 1000,
  label: string = 'operation'
): Promise<T> {
  let lastError: Error | null = null;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err as Error;
      console.error(`[Backup] ${label} failed (attempt ${i + 1}/${maxRetries}): ${lastError.message}`);
      if (i < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, delayMs * (i + 1)));
      }
    }
  }
  throw lastError;
}

export interface GeneratedBackup {
  backupBytes: Uint8Array;
  entries: Array<{ name: string; data: Uint8Array }>;
  encrypted: boolean;
  backupSize: number;
  logLines: string[];
}

/**
 * 生成备份字节（与原版 fan-out 对齐：生成一次，上传到多个远端）
 */
export async function generateBackupBytes(
  db: D1Database,
  userId: string,
  ledgerId: string,
  r2?: R2Bucket,
  logFn?: (msg: string) => void,
): Promise<GeneratedBackup> {
  const log = logFn || console.log;
  const logLines: string[] = [];
  const logWrap = (msg: string) => { log(msg); logLines.push(`[${new Date().toISOString()}] ${msg}`); };

  logWrap(`[Backup] Starting full database backup, user: ${userId}`);

  // 导出所有用户数据表
  const tables: Record<string, unknown[]> = {};
  for (const tableName of BACKUP_TABLES) {
    try {
      const rows = await withRetry(() => exportTable(db, tableName), 3, 1000, `export ${tableName}`);
      if (rows.length > 0) tables[tableName] = rows;
    } catch (err) {
      logWrap(`[Backup] Skipping ${tableName}: ${(err as Error).message}`);
    }
  }

  // R2 附件
  let attachments = new Map<string, Uint8Array>();
  if (r2) {
    try {
      attachments = await withRetry(() => fetchR2Attachments(r2), 2, 2000, 'fetch R2 attachments');
      logWrap(`[Backup] R2 attachments: ${attachments.size} files`);
    } catch {}
  }

  // 构建文件条目（供 tar.gz �?ZIP 使用�?
  const entries: { name: string; data: Uint8Array }[] = [];
  entries.push({ name: 'meta.json', data: new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, appVersion: '1.6.1', createdAt: new Date().toISOString(), userId, includeAttachments: true }, null, 2)) });
  try {
    const { createMinimalSqliteFile } = await import('../lib/sqlite-writer');
    entries.push({ name: 'db.sqlite3', data: createMinimalSqliteFile() });
  } catch {}
  entries.push({ name: 'db.json', data: new TextEncoder().encode(JSON.stringify({ backup_time: new Date().toISOString(), version: '1.0', schema_version: 1, user_id: userId, tables }, null, 2)) });
  for (const [key, value] of attachments) entries.push({ name: key, data: value });

  let backupBytes = await withRetry(() => createTarGz(entries), 2, 1000, 'create tar.gz');
  logWrap(`[Backup] tar.gz created: ${backupBytes.length} bytes, ${Object.keys(tables).length} tables`);

  return { backupBytes, entries, encrypted: false, backupSize: backupBytes.length, logLines };
}

/**
 * 列出远端存储中的文件（用�?retention 清理�?
 */
export async function listRemoteFiles(
  config: Record<string, string>,
): Promise<Array<{ Name?: string; Path?: string; IsDir?: boolean }>> {
  if (config.backend_type === 's3' || config.backend_type === 'b2') {
    const isB2 = config.backend_type === 'b2';
    const endpoint = config.endpoint || (isB2 ? 'https://s3.eu-central-003.backblazeb2.com' : 'https://s3.amazonaws.com');
    const bucket = config.bucket;
    const accessKey = isB2 ? (config.account || config.access_key_id)?.trim() : (config.access_key_id || config.key)?.trim();
    const secretKey = isB2 ? (config.key || config.secret_access_key)?.trim() : (config.secret_access_key || config.account)?.trim();
    const region = config.region || 'auto';
    let prefix = '';
    if (config.savePath && config.savePath !== 'custom') prefix = config.savePath.trim().replace(/^\/+|\/+$/g, '') + '/';
    else if (config.root_path) prefix = config.root_path.trim().replace(/^\/+|\/+$/g, '') + '/';
    else prefix = 'beecount/';
    return await listS3Objects(endpoint, bucket!, accessKey!, secretKey!, region, prefix);
  }

  if (config.backend_type === 'r2' && config._r2Bucket) {
    const bucket = config._r2Bucket as unknown as R2Bucket;
    const prefix = 'beecount/backups/';
    const objects = await bucket.list({ prefix });
    return objects.objects.map(o => ({ Name: o.key, Path: o.key, IsDir: false }));
  }

  if (config.backend_type === 'webdav') {
    // WebDAV 列出文件（PROPFIND�?
    try {
      const baseUrl = config.url!;
      const username = config.username!;
      const password = config.password!;
      const auth = 'Basic ' + Buffer.from(username + ':' + password).toString('base64');
      const response = await fetch(baseUrl, {
        method: 'PROPFIND',
        headers: { 'Authorization': auth, 'Depth': 'infinity' },
      });
      if (!response.ok) return [];
      const text = await response.text();
      const items: Array<{ Name?: string; Path?: string; IsDir?: boolean }> = [];
      const hrefRegex = /<d:href>([^<]+)<\/d:href>/g;
      let match;
      while ((match = hrefRegex.exec(text)) !== null) {
        const href = match[1];
        const name = href.split('/').pop() || href;
        if (name) items.push({ Name: name, Path: href, IsDir: false });
      }
      return items;
    } catch {
      return [];
    }
  }

  if (config.backend_type === 'ftp') {
    const ftpClient = createFtpClient({
      host: config.host || config.hostname || '',
      port: parseInt(config.port || '21', 10),
      username: config.username || '',
      password: config.password || '',
    });
    let prefix = '';
    if (config.savePath && config.savePath !== 'custom') prefix = config.savePath.trim().replace(/^\/+|\/+$/g, '') + '/';
    else if (config.root_path) prefix = config.root_path.trim().replace(/^\/+|\/+$/g, '') + '/';
    return await ftpClient.listRecursive(prefix);
  }

  if (config.backend_type === 'sftp') {
    const sftpClient = createSftpClient({
      host: config.host || config.hostname || '',
      port: parseInt(config.port || '22', 10),
      username: config.username || '',
      password: config.password || '',
      privateKey: config.private_key || config.privateKey,
    });
    let prefix = '';
    if (config.savePath && config.savePath !== 'custom') prefix = config.savePath.trim().replace(/^\/+|\/+$/g, '') + '/';
    else if (config.root_path) prefix = config.root_path.trim().replace(/^\/+|\/+$/g, '') + '/';
    return await sftpClient.listRecursive(prefix);
  }

  if (config.backend_type === 'drive' || config.backend_type === 'onedrive' || config.backend_type === 'dropbox') {
    return await listOAuth2Files(config);
  }

  return [];
}

/**
 * 从远端删除文件（用于 retention 清理�?
 */
export async function deleteRemoteFile(
  config: Record<string, string>,
  fileName: string,
): Promise<boolean> {
  if (config.backend_type === 's3' || config.backend_type === 'b2') {
    const isB2 = config.backend_type === 'b2';
    const endpoint = config.endpoint || (isB2 ? 'https://s3.eu-central-003.backblazeb2.com' : 'https://s3.amazonaws.com');
    const bucket = config.bucket;
    const accessKey = isB2 ? (config.account || config.access_key_id)?.trim() : (config.access_key_id || config.key)?.trim();
    const secretKey = isB2 ? (config.key || config.secret_access_key)?.trim() : (config.secret_access_key || config.account)?.trim();
    const region = config.region || 'auto';
    // S3 list 返回完整 key（含前缀），直接使用 fileName 即可
    return await deleteS3Object(endpoint, bucket!, accessKey!, secretKey!, region, fileName);
  }

  if (config.backend_type === 'r2' && config._r2Bucket) {
    const bucket = config._r2Bucket as unknown as R2Bucket;
    try {
      await bucket.delete(fileName);
      return true;
    } catch {
      return false;
    }
  }

  if (config.backend_type === 'webdav') {
    try {
      const baseUrl = config.url!;
      const username = config.username!;
      const password = config.password!;
      const auth = 'Basic ' + Buffer.from(username + ':' + password).toString('base64');
      const response = await fetch(baseUrl + fileName, {
        method: 'DELETE',
        headers: { 'Authorization': auth },
      });
      return response.ok || response.status === 404;
    } catch {
      return false;
    }
  }

  if (config.backend_type === 'ftp') {
    const ftpClient = createFtpClient({
      host: config.host || config.hostname || '',
      port: parseInt(config.port || '21', 10),
      username: config.username || '',
      password: config.password || '',
    });
    let prefix = '';
    if (config.savePath && config.savePath !== 'custom') prefix = config.savePath.trim().replace(/^\/+|\/+$/g, '') + '/';
    else if (config.root_path) prefix = config.root_path.trim().replace(/^\/+|\/+$/g, '') + '/';
    return await ftpClient.delete(prefix + fileName);
  }

  if (config.backend_type === 'sftp') {
    const sftpClient = createSftpClient({
      host: config.host || config.hostname || '',
      port: parseInt(config.port || '22', 10),
      username: config.username || '',
      password: config.password || '',
      privateKey: config.private_key || config.privateKey,
    });
    let prefix = '';
    if (config.savePath && config.savePath !== 'custom') prefix = config.savePath.trim().replace(/^\/+|\/+$/g, '') + '/';
    else if (config.root_path) prefix = config.root_path.trim().replace(/^\/+|\/+$/g, '') + '/';
    return await sftpClient.delete(prefix + fileName);
  }

  if (config.backend_type === 'drive' || config.backend_type === 'onedrive' || config.backend_type === 'dropbox') {
    return await deleteOAuth2File(config, fileName);
  }

  return false;
}

/**
 * 上传备份到单个远端（与原�?fan-out 单个 worker 对齐�?
 */
export async function uploadBackupToRemote(
  backupBytes: Uint8Array,
  encrypted: boolean,
  remoteConfig: Record<string, string>,
  userId: string,
  logFn?: (msg: string) => void,
): Promise<{ ok: boolean; message: string; key?: string }> {
  const log = logFn || console.log;

  if (remoteConfig.backend_type === 's3' || remoteConfig.backend_type === 'b2') {
    const isB2 = remoteConfig.backend_type === 'b2';
    let endpoint = remoteConfig.endpoint;
    // B2 �?API 获取 S3 兼容端点（原�?rclone 方式�?
    if (isB2 && !endpoint) {
      try {
        const b2Auth = await fetch('https://api.backblazeb2.com/b2api/v2/b2_authorize_account', {
          headers: { 'Authorization': 'Basic ' + btoa(`${(remoteConfig.account || remoteConfig.access_key_id || '').trim()}:${(remoteConfig.key || remoteConfig.secret_access_key || '').trim()}`) },
        });
        if (b2Auth.ok) {
          const b2Data = await b2Auth.json() as { s3ApiUrl?: string };
          if (b2Data.s3ApiUrl) endpoint = b2Data.s3ApiUrl;
        }
      } catch {}
    }
    if (!endpoint) endpoint = isB2 ? 'https://s3.eu-central-003.backblazeb2.com' : 'https://s3.amazonaws.com';
    const bucket = remoteConfig.bucket;
    // B2 �?account/key 字段名（rclone 风格），S3 �?access_key_id/secret_access_key
    const accessKey = (isB2 ? (remoteConfig.account || remoteConfig.access_key_id) : (remoteConfig.access_key_id || remoteConfig.key))?.trim();
    const secretKey = (isB2 ? (remoteConfig.key || remoteConfig.secret_access_key) : (remoteConfig.secret_access_key || remoteConfig.account))?.trim();
    const region = isB2
      ? (() => { try { const m = new URL(endpoint).hostname.match(/^s3\.([^.]+)\.backblazeb2\.com$/); return m ? m[1] : 'auto'; } catch { return 'auto'; }})()
      : (remoteConfig.region || 'auto');
    if (!bucket || !accessKey || !secretKey) return { ok: false, message: 'S3 configuration incomplete' };

    let prefix = '';
    if (remoteConfig.savePath && remoteConfig.savePath !== 'custom') prefix = remoteConfig.savePath.trim().replace(/^\/+|\/+$/g, '') + '/';
    else if (remoteConfig.root_path) prefix = remoteConfig.root_path.trim().replace(/^\/+|\/+$/g, '') + '/';
    else prefix = 'beecount/';

    const localTime = new Date(Date.now() + 8 * 3600000);
    const ts = localTime.toISOString().replace(/[:\-T]/g, '').slice(0, 14);
    const key = `${prefix}backups/${userId}/${ts}_backup${encrypted ? '.zip' : '.tar.gz'}`;

    const result = await uploadToS3(endpoint, bucket, accessKey, secretKey, region, key, backupBytes, 'application/gzip');
    return result.ok ? { ok: true, message: 'Upload successful', key } : { ok: false, message: result.message };
  }

  if (remoteConfig.backend_type === 'webdav') {
    const localTime = new Date(Date.now() + 8 * 3600000);
    const ts = localTime.toISOString().replace(/[:\-T]/g, '').slice(0, 14);
    let prefix = '';
    if (remoteConfig.savePath && remoteConfig.savePath !== 'custom') prefix = remoteConfig.savePath.trim().replace(/^\/+|\/+$/g, '') + '/';
    else if (remoteConfig.root_path) prefix = remoteConfig.root_path.trim().replace(/^\/+|\/+$/g, '') + '/';
    else prefix = 'beecount/';
    const key = `${prefix}backups/${userId}/${ts}_backup${encrypted ? '.zip' : '.tar.gz'}`;
    const webdavUser = remoteConfig.username || remoteConfig.user;
    const webdavPass = remoteConfig.password || remoteConfig.pass;
    const result = await uploadToWebDav(remoteConfig.url!, webdavUser!, webdavPass!, key, backupBytes);
    return result.ok ? { ok: true, message: 'Upload successful', key } : { ok: false, message: result.message };
  }

  if (remoteConfig.backend_type === 'r2' && remoteConfig._r2Bucket) {
    const bucket = remoteConfig._r2Bucket as unknown as R2Bucket;
    const localTime = new Date(Date.now() + 8 * 3600000);
    const ts = localTime.toISOString().replace(/[:\-T]/g, '').slice(0, 14);
    const key = `beecount/backups/${userId}/${ts}_backup${encrypted ? '.zip' : '.tar.gz'}`;
    await bucket.put(key, backupBytes, { httpMetadata: { contentType: 'application/gzip' } });
    return { ok: true, message: 'R2 upload successful', key };
  }

  if (remoteConfig.backend_type === 'drive' || remoteConfig.backend_type === 'onedrive' || remoteConfig.backend_type === 'dropbox') {
    if (!remoteConfig.client_id || !remoteConfig.client_secret || !remoteConfig.token) {
      return { ok: false, message: 'OAuth2 configuration incomplete' };
    }
    const localTime = new Date(Date.now() + 8 * 3600000);
    const ts = localTime.toISOString().replace(/[:\-T]/g, '').slice(0, 14);
    let prefix = '';
    if (remoteConfig.savePath && remoteConfig.savePath !== 'custom') prefix = remoteConfig.savePath.trim().replace(/^\/+|\/+$/g, '') + '/';
    else if (remoteConfig.root_path) prefix = remoteConfig.root_path.trim().replace(/^\/+|\/+$/g, '') + '/';
    else prefix = 'beecount/';
    const key = `${prefix}backups/${userId}/${ts}_backup${encrypted ? '.zip' : '.tar.gz'}`;
    const result = await uploadToOAuth2Provider(remoteConfig, key, backupBytes);
    return result ? { ok: true, message: 'Upload successful', key } : { ok: false, message: 'Upload failed' };
  }

  if (remoteConfig.backend_type === 'ftp') {
    const ftpHost = remoteConfig.host || remoteConfig.hostname;
    const ftpPort = parseInt(remoteConfig.port || '21', 10);
    const ftpUser = remoteConfig.username || remoteConfig.user;
    const ftpPass = remoteConfig.password || remoteConfig.pass;

    if (!ftpHost || !ftpUser || !ftpPass) {
      return { ok: false, message: 'FTP configuration incomplete (host, username, password required)' };
    }

    const localTime = new Date(Date.now() + 8 * 3600000);
    const ts = localTime.toISOString().replace(/[:\-T]/g, '').slice(0, 14);
    let prefix = '';
    if (remoteConfig.savePath && remoteConfig.savePath !== 'custom') prefix = remoteConfig.savePath.trim().replace(/^\/+|\/+$/g, '') + '/';
    else if (remoteConfig.root_path) prefix = remoteConfig.root_path.trim().replace(/^\/+|\/+$/g, '') + '/';
    else prefix = 'beecount/';
    const key = `${prefix}backups/${userId}/${ts}_backup${encrypted ? '.zip' : '.tar.gz'}`;

    try {
      const { createFtpClient } = await import('../lib/ftp');
      const ftpClient = createFtpClient({ host: ftpHost, port: ftpPort, username: ftpUser, password: ftpPass });
      const ok = await ftpClient.upload(key, backupBytes);
      return ok ? { ok: true, message: 'Upload successful', key } : { ok: false, message: 'FTP upload failed' };
    } catch (e) {
      return { ok: false, message: `FTP upload failed: ${(e as Error).message}` };
    }
  }

  if (remoteConfig.backend_type === 'sftp') {
    const sftpHost = remoteConfig.host || remoteConfig.hostname;
    const sftpPort = parseInt(remoteConfig.port || '22', 10);
    const sftpUsername = remoteConfig.username || remoteConfig.user;
    const sftpPassword = remoteConfig.password || remoteConfig.pass;
    const sftpKey = remoteConfig.private_key || remoteConfig.privateKey || remoteConfig.key_file;

    if (!sftpHost || !sftpUsername) {
      return { ok: false, message: 'SFTP configuration incomplete (host, username required)' };
    }

    const localTime = new Date(Date.now() + 8 * 3600000);
    const ts = localTime.toISOString().replace(/[:\-T]/g, '').slice(0, 14);
    let prefix = '';
    if (remoteConfig.savePath && remoteConfig.savePath !== 'custom') prefix = remoteConfig.savePath.trim().replace(/^\/+|\/+$/g, '') + '/';
    else if (remoteConfig.root_path) prefix = remoteConfig.root_path.trim().replace(/^\/+|\/+$/g, '') + '/';
    else prefix = 'beecount/';
    const key = `${prefix}backups/${userId}/${ts}_backup${encrypted ? '.zip' : '.tar.gz'}`;

    try {
      const { createSftpClient } = await import('../lib/sftp');
      const sftpClient = createSftpClient({
        host: sftpHost,
        port: sftpPort,
        username: sftpUsername,
        password: sftpPassword || undefined,
        privateKey: sftpKey || undefined,
      });
      const ok = await sftpClient.upload(key, backupBytes);
      return ok ? { ok: true, message: 'SFTP upload successful', key } : { ok: false, message: 'Update Create failed: permission denied' };
    } catch (e) {
      return { ok: false, message: `Update Create failed: ${(e as Error).message}` };
    }
  }

  return { ok: true, message: 'Local backup (no upload)' };
}

/**
 * 并行上传备份到多个远端（与原�?fan-out ThreadPoolExecutor 对齐�?
 */
export async function performBackupFanOut(
  db: D1Database,
  runId: number,
  userId: string,
  ledgerId: string,
  remoteConfigs: Array<{ remoteId: string; config: Record<string, string> }>,
  shouldEncrypt?: boolean,
  r2?: R2Bucket,
  logFn?: (msg: string) => void,
  retentionDays?: number,
  progressFn?: (phase: string, meta?: Record<string, unknown>) => void,
): Promise<BackupResult> {
  const log = logFn || console.log;
  const logLines: string[] = [];
  const logWrap = (msg: string) => { log(msg); logLines.push(`[${new Date().toISOString()}] ${msg}`); };

  progressFn?.('starting');

  // 1. 生成一次备份字�?
  const generated = await generateBackupBytes(db, userId, ledgerId, r2, logFn);
  logLines.push(...generated.logLines);
  progressFn?.('snapshot_db');
  progressFn?.('snapshot_attachments');
  progressFn?.('packing');

  // 2. 加密（如果需要）�?对齐原版：直接加密文件到 ZIP，无中间 tar �?
  let backupBytes = generated.backupBytes;
  let encrypted = false;
  if (shouldEncrypt && remoteConfigs.length > 0) {
    const pw = remoteConfigs[0].config.age_passphrase || remoteConfigs[0].config.zipryption_password;
    if (pw) {
      try {
        // 将文件直接添加到 ZIP（对齐原�?tar_builder.py build_encrypted_zip�?
        backupBytes = await createEncryptedZip(generated.entries, pw);
        encrypted = true;
        logWrap(`[Backup] Encrypted (AES-256 ZIP): ${backupBytes.length} bytes`);
      } catch (e) {
        logWrap(`[Backup] Encryption failed: ${e}`);
      }
    }
  }

  // 3. 解析 alias 远端
  let effectiveConfigs = remoteConfigs;
  const hasAlias = remoteConfigs.some(rc => rc.config.backend_type === 'alias');
  if (hasAlias) {
    effectiveConfigs = await Promise.all(remoteConfigs.map(async (rc) => {
      if (rc.config.backend_type !== 'alias') return rc;
      const resolved = await resolveAliasRemote(db, rc.config);
      if (resolved.error) {
        logWrap(`[Backup] Alias resolution failed: ${resolved.error}`);
        return { ...rc, config: { ...rc.config, backend_type: 'local' } };
      }
      return { ...rc, config: resolved };
    }));
  }

  // 4. 并行上传到所有远端（与原�?ThreadPoolExecutor fan-out 对齐�?
  const remoteIds = effectiveConfigs.map(r => r.remoteId);
  logWrap(`[Backup] Fan-out to ${effectiveConfigs.length} remotes: ${remoteIds.join(', ')}`);
  progressFn?.('fan_out_start');

  const uploadResults = await Promise.allSettled(
    effectiveConfigs.map(async ({ remoteId, config }) => {
      progressFn?.('uploading', { remoteId });
      const result = await uploadBackupToRemote(backupBytes, encrypted, config, userId, logWrap);
      logWrap(`[Backup] Remote ${remoteId}: ${result.ok ? 'success' : 'failed'} ${result.message}`);
      return { remoteId, ...result };
    })
  );

  const successful = uploadResults.filter(r => r.status === 'fulfilled' && r.value.ok);
  const failed = uploadResults.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.ok));

  // 4. 取第一个有 key 的成功路径（不限�?R2�?
  let backupPath: string | null = null;
  if (successful.length > 0) {
    for (const result of successful) {
      const successResult = (result as PromiseFulfilledResult<{ remoteId: string; ok: boolean; message: string; key?: string }>).value;
      if (successResult.key) {
        backupPath = successResult.key;
        break;
      }
    }
  }

  // 5. 上传附件�?R2
  let attachmentsUploaded = 0;
  if (r2) {
    try {
      const attachments = await fetchR2Attachments(r2);
      for (const [key, data] of attachments) {
        try { await r2.put(key, data); attachmentsUploaded++; } catch {}
      }
    } catch {}
  }

  // 6. 保留策略（只�?schedule 模式且有成功上传时执行）
  if (retentionDays && retentionDays > 0 && successful.length > 0) {
    logWrap(`[Backup] Retention: running with retention_days=${retentionDays}`);
    for (const result of successful) {
      const r = (result as PromiseFulfilledResult<{ remoteId: string; ok: boolean; message: string; key?: string }>).value;
      const remoteConfig = effectiveConfigs.find(rc => rc.remoteId === r.remoteId);
      if (!remoteConfig) continue;
      try {
        const items = await listRemoteFiles(remoteConfig.config);
        const backupFiles = filterBackupFiles(items);
        const toDelete = computeRetentionDeletes(backupFiles, retentionDays);
        for (const f of toDelete) {
          try {
            await deleteRemoteFile(remoteConfig.config, f.path || f.name);
            logWrap(`[Backup] Retention deleted: ${f.name}`);
          } catch (exc) {
            logWrap(`[Backup] Retention delete failed: ${f.name}: ${exc}`);
          }
        }
      } catch (exc) {
        logWrap(`[Backup] Retention list failed on ${remoteConfig.config.name || 'remote'}: ${exc}`);
      }
    }
  }

  const allSucceeded = failed.length === 0;
  const status = allSucceeded ? 'succeeded' : (successful.length > 0 ? 'partial' : 'failed');

  return {
    success: allSucceeded,
    message: allSucceeded
      ? `Backup completed to ${remoteConfigs.length} remote(s)`
      : `${successful.length}/${remoteConfigs.length} succeeded, ${failed.length} failed`,
    backupSize: backupBytes.length,
    backupPath: backupPath || undefined,
    attachmentsUploaded,
  };
}

/**
 * 计算下次运行时间
 * Cron 表达式格�? 分钟 小时 日期 月份 星期
 * cronExpr 中的时间�?UTC 时间
 * @param cronExpr cron表达式（UTC时间�?
 * @param timezoneOffset 用户时区偏移（分钟，东八区为-480，仅用于显示�?
 */
/**
 * 验证 cron 表达式是否合法（5 字段：分 �?�?�?周）
 * 与原�?APScheduler CronTrigger.from_crontab() 对齐
 */
export function validateCronExpression(cronExpr: string): { valid: boolean; error?: string } {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) {
    return { valid: false, error: `Cron expression must have 5 fields, got ${parts.length}` };
  }

  const ranges = [
    { name: 'minute', min: 0, max: 59 },
    { name: 'hour', min: 0, max: 23 },
    { name: 'day', min: 1, max: 31 },
    { name: 'month', min: 1, max: 12 },
    { name: 'weekday', min: 0, max: 7 },
  ];

  for (let i = 0; i < 5; i++) {
    const field = parts[i];
    const { name, min, max } = ranges[i];

    if (field === '*') continue;

    // 处理 */N
    if (field.startsWith('*/')) {
      const step = parseInt(field.slice(2), 10);
      if (isNaN(step) || step < 1 || step > max) {
        return { valid: false, error: `Invalid ${name} step: ${field}` };
      }
      continue;
    }

    // 处理 N-M
    const rangeMatch = field.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      if (start < min || end > max || start > end) {
        return { valid: false, error: `Invalid ${name} range: ${field}` };
      }
      continue;
    }

    // 处理逗号分隔的�?
    const values = field.split(',');
    for (const v of values) {
      const num = parseInt(v, 10);
      if (isNaN(num) || num < min || num > max) {
        return { valid: false, error: `Invalid ${name} value: ${v} (valid range ${min}-${max})` };
      }
    }
  }

  return { valid: true };
}

export function calculateNextRun(cronExpr: string, timezoneOffset: number | string = 0): string {
  try {
    const parts = cronExpr.trim().split(/\s+/);

    if (parts.length < 5) {
      const nextDate = new Date();
      nextDate.setMinutes(nextDate.getMinutes() + 5);
      return nextDate.toISOString();
    }

    const minuteStr = parts[0];
    const hourStr = parts[1];
    const dayStr = parts[2];

    const targetMinute = minuteStr === '*' ? 0 : parseInt(minuteStr, 10);
    const targetHour = hourStr === '*' ? 0 : parseInt(hourStr, 10);

    // 解析时区偏移（分钟），支�?IANA 时区�?
    let offsetMs = 0;
    if (typeof timezoneOffset === 'string' && timezoneOffset) {
      // IANA 时区名，�?Date 计算当前偏移
      const now = new Date();
      const utcMs = now.getTime();
      const localStr = now.toLocaleString('en-US', { timeZone: timezoneOffset });
      const localDate = new Date(localStr);
      offsetMs = localDate.getTime() - utcMs;
    } else if (typeof timezoneOffset === 'number') {
      offsetMs = timezoneOffset * 60 * 1000;
    }

    // �?cron 时间视为本地时间（带时区偏移），计算对应�?UTC 时间
    // timezone_offset 使用 JS 约定（new Date().getTimezoneOffset()）：UTC+8 = -480
    // 公式：UTC = 本地时间 + timezone_offset（分钟）
    // 例如�?4:00 CST = 04:00 UTC + (-480min) = 04:00 UTC - 8h = 20:00 UTC 前一�?
    const now = new Date();
    const nowMs = now.getTime();

    // 创建目标时间（将 cron �?hour/minute 设为 UTC 时间�?
    const targetDate = new Date();
    targetDate.setUTCHours(targetHour, targetMinute, 0, 0);
    // 加上时区偏移得到实际 UTC 时间（JS 约定：UTC+8 = -480，加 -480分钟 = �?小时�?
    let targetUtcMs = targetDate.getTime() + offsetMs;

    // 如果目标时间已过，加一�?
    while (targetUtcMs <= nowMs) {
      targetUtcMs += 24 * 60 * 60 * 1000;
    }

    if (dayStr !== '*') {
      const targetDay = parseInt(dayStr, 10);
      if (!isNaN(targetDay) && targetDay > 0 && targetDay <= 31) {
        const tempDate = new Date(targetUtcMs);
        if (targetDay < tempDate.getUTCDate()) {
          targetUtcMs += 31 * 24 * 60 * 60 * 1000;
        }
        tempDate.setTime(targetUtcMs);
        tempDate.setUTCDate(targetDay);
        targetUtcMs = tempDate.getTime();
      }
    }

    return new Date(targetUtcMs).toISOString();
  } catch (e) {
    console.error('[Schedule] Error parsing cron expression:', cronExpr, e);
    const nextDate = new Date();
    nextDate.setMinutes(nextDate.getMinutes() + 5);
    return nextDate.toISOString();
  }
}

/**
 * 解析 alias 远端配置：查找目标远端并合并路径前缀
 */
export async function downloadBackupFile(
  remoteConfig: Record<string, string>,
  key: string,
): Promise<Uint8Array | null> {
  const bt = remoteConfig.backend_type;

  if (bt === 's3' || bt === 'b2') {
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
    const tokenEndpoints: Record<string, string> = {
      drive: 'https://oauth2.googleapis.com/token',
      onedrive: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      dropbox: 'https://api.dropbox.com/oauth2/token',
    };
    const token = await refreshAccessToken(bt as any, remoteConfig.client_id!, remoteConfig.client_secret!, remoteConfig.token!);
    if (!token) return null;

    if (bt === 'drive') {
      // Google Drive: use file ID in key (Path from list)
      const res = await fetch(`https://www.googleapis.com/drive/v3/files/${key}?alt=media`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) return null;
      const buffer = await res.arrayBuffer();
      return new Uint8Array(buffer);
    }
    if (bt === 'dropbox') {
      const res = await fetch('https://content.dropboxapi.com/2/files/download', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
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

export async function resolveAliasRemote(
  db: D1Database,
  config: Record<string, string>,
): Promise<Record<string, string>> {
  const remoteSpec = config.remote || '';
  const colonIdx = remoteSpec.indexOf(':');
  if (colonIdx < 0) return { ...config, error: 'Invalid alias format' };
  const targetName = remoteSpec.slice(0, colonIdx).trim();
  const aliasPath = remoteSpec.slice(colonIdx + 1).trim();
  const target = await db
    .prepare('SELECT id, backend_type, config_summary FROM backup_remotes WHERE name = ?')
    .bind(targetName)
    .first<{ id: string; backend_type: string; config_summary: string }>();
  if (!target) return { ...config, error: `Alias target "${targetName}" not found` };
  const targetConfig = (() => { try { return JSON.parse(target.config_summary || '{}'); } catch { return {}; } })();
  const resolved: Record<string, string> = { backend_type: target.backend_type, ...targetConfig };
  if (aliasPath) resolved.savePath = aliasPath;
  return resolved;
}




