/**
 * 备份执行器 - 提取公共的备份执行逻辑
 *
 * 被 src/index.ts（定时任务）和 src/routes/admin_backup.ts（管理员手动触发）共用
 */

import { uploadToS3 } from '../lib/s3';
import { createFtpClient } from '../lib/ftp';
import { createSftpClient } from '../lib/sftp';

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

async function webdavPut(url: string, auth: string, content: string): Promise<{ ok: boolean; status: number; message: string }> {
  const encoder = new TextEncoder();
  const body = encoder.encode(content);
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': auth,
      'Content-Type': 'application/json',
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
  content: string
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
}

// ===========================
// AES-256-GCM 加密工具
// ===========================

const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const KEY_LENGTH = 256;
const ITERATIONS = 100000;

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: KEY_LENGTH },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptData(plaintext: string, password: string): Promise<string> {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const key = await deriveKey(password, salt);

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(plaintext)
  );

  const combined = new Uint8Array(SALT_LENGTH + IV_LENGTH + ciphertext.byteLength);
  combined.set(salt, 0);
  combined.set(iv, SALT_LENGTH);
  combined.set(new Uint8Array(ciphertext), SALT_LENGTH + IV_LENGTH);

  return btoa(String.fromCharCode(...combined));
}

async function getEncryptionPassword(
  remoteConfig: Record<string, string>,
  db: D1Database
): Promise<string | null> {
  if (remoteConfig.encryption_password) {
    return remoteConfig.encryption_password;
  }

  if (remoteConfig.encryption_key_id) {
    const setting = await db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .bind(`backup_encryption_key:${remoteConfig.encryption_key_id}`)
      .first<{ value: string }>();
    if (setting) {
      return setting.value;
    }
  }

  return null;
}

async function fetchLedgerChanges(
  db: D1Database,
  ledgerId: string
): Promise<{ entity_type: string; entity_sync_id: string; payload_json: string }[]> {
  const result = await db
    .prepare('SELECT entity_type, entity_sync_id, payload_json FROM sync_changes WHERE ledger_id = ?')
    .bind(ledgerId)
    .all();
  return (result.results || []) as { entity_type: string; entity_sync_id: string; payload_json: string }[];
}

export async function performBackup(
  db: D1Database,
  runId: number,
  ledgerId: string,
  remoteConfig: Record<string, string>,
  shouldEncrypt?: boolean,
  r2?: R2Bucket
): Promise<BackupResult> {
  try {
    console.log(`[Backup] Starting backup for ledger: ${ledgerId}`);

    const changes = await fetchLedgerChanges(db, ledgerId);
    console.log(`[Backup] Found ${changes.length} changes to backup`);

    const backupData = {
      ledger_id: ledgerId,
      backup_time: new Date().toISOString(),
      version: '1.0',
      changes: changes.map(c => ({
        entity_type: c.entity_type,
        entity_sync_id: c.entity_sync_id,
        payload: JSON.parse(c.payload_json)
      }))
    };

    let backupContent = JSON.stringify(backupData, null, 2);
    let encrypted = false;

    if (shouldEncrypt) {
      const password = await getEncryptionPassword(remoteConfig, db);
      if (password) {
        backupContent = await encryptData(backupContent, password);
        encrypted = true;
        console.log('[Backup] Data encrypted with AES-256-GCM');
      } else {
        console.log('[Backup] Encryption enabled but no password found, proceeding without encryption');
      }
    }

    const backupSize = backupContent.length;

    console.log(`[Backup] Backup content size: ${backupSize} bytes`);

    if (remoteConfig.backend_type === 's3') {
      const s3Endpoint = remoteConfig.endpoint || 'https://s3.amazonaws.com';
      const s3Bucket = remoteConfig.bucket;
      const s3AccessKey = remoteConfig.access_key_id;
      const s3SecretKey = remoteConfig.secret_access_key;
      const s3Region = remoteConfig.region || 'auto';

      if (!s3Bucket || !s3AccessKey || !s3SecretKey) {
        return { success: false, message: 'S3 configuration incomplete' };
      }

      let basePrefix = '';
      const DEFAULT_PREFIX = 'beecount';
      if (remoteConfig.savePath && typeof remoteConfig.savePath === 'string' &&
          remoteConfig.savePath.trim() !== '' && remoteConfig.savePath !== 'custom' && remoteConfig.savePath !== 'environment variable') {
        basePrefix = remoteConfig.savePath.trim().replace(/^\/+|\/+$/g, '') + '/';
        console.log(`[Backup] Using savePath: ${basePrefix}`);
      } else if (remoteConfig.root_path && typeof remoteConfig.root_path === 'string' && remoteConfig.root_path.trim() !== '') {
        basePrefix = remoteConfig.root_path.trim().replace(/^\/+|\/+$/g, '') + '/';
        console.log(`[Backup] Using root_path: ${basePrefix}`);
      } else {
        basePrefix = DEFAULT_PREFIX + '/';
        console.log(`[Backup] Using default prefix: ${basePrefix}`);
      }

      const timestamp = new Date().toISOString().replace(/[:\-T]/g, '').slice(0, 14);
      const backupKey = `${basePrefix}backups/${ledgerId}/${timestamp}_backup.json`;

      console.log(`[Backup] Uploading to S3 key: ${backupKey}`);

      const uploadResult = await uploadToS3(
        s3Endpoint,
        s3Bucket,
        s3AccessKey,
        s3SecretKey,
        s3Region,
        backupKey,
        backupContent
      );

      if (!uploadResult.ok) {
        return { success: false, message: uploadResult.message };
      }

      console.log(`[Backup] Upload successful: ${backupKey}`);

      return {
        success: true,
        message: 'Backup completed successfully',
        backupSize,
        backupPath: backupKey
      };
    } else if (remoteConfig.backend_type === 'webdav') {
      const webdavUrl = remoteConfig.url;
      const webdavUsername = remoteConfig.username;
      const webdavPassword = remoteConfig.password;

      if (!webdavUrl || !webdavUsername || !webdavPassword) {
        return { success: false, message: 'WebDAV configuration incomplete (url, username, password required)' };
      }

      const timestamp = new Date().toISOString().replace(/[:\-T]/g, '').slice(0, 14);
      let basePrefix = '';
      if (remoteConfig.savePath && typeof remoteConfig.savePath === 'string' &&
          remoteConfig.savePath !== 'custom' && remoteConfig.savePath !== 'environment variable') {
        basePrefix = remoteConfig.savePath.trim().replace(/^\/+|\/+$/g, '') + '/';
      } else if (remoteConfig.root_path && typeof remoteConfig.root_path === 'string' && remoteConfig.root_path.trim() !== '') {
        basePrefix = remoteConfig.root_path.trim().replace(/^\/+|\/+$/g, '') + '/';
      }

      const backupKey = `${basePrefix}backups/${ledgerId}/${timestamp}_backup.json`;

      console.log(`[Backup] Uploading to WebDAV: ${backupKey}`);

      const uploadResult = await uploadToWebDav(webdavUrl, webdavUsername, webdavPassword, backupKey, backupContent);

      if (!uploadResult.ok) {
        return { success: false, message: uploadResult.message };
      }

      console.log(`[Backup] WebDAV upload successful: ${backupKey}`);

      return {
        success: true,
        message: 'Backup completed successfully via WebDAV',
        backupSize,
        backupPath: backupKey
      };
    } else if (remoteConfig.backend_type === 'local') {
      console.log('[Backup] Local backend - skipping upload (simulated)');
      return {
        success: true,
        message: 'Backup completed (local storage)',
        backupSize,
        backupPath: `local://backup_${runId}.json`
      };
    } else if (remoteConfig.backend_type === 'r2') {
      if (!r2) {
        return { success: false, message: 'R2 bucket not configured' };
      }

      let basePrefix = '';
      const DEFAULT_PREFIX = 'beecount';
      if (remoteConfig.savePath && typeof remoteConfig.savePath === 'string' &&
          remoteConfig.savePath.trim() !== '' && remoteConfig.savePath !== 'custom' && remoteConfig.savePath !== 'environment variable') {
        basePrefix = remoteConfig.savePath.trim().replace(/^\/+|\/+$/g, '') + '/';
      } else if (remoteConfig.root_path && typeof remoteConfig.root_path === 'string' && remoteConfig.root_path.trim() !== '') {
        basePrefix = remoteConfig.root_path.trim().replace(/^\/+|\/+$/g, '') + '/';
      } else {
        basePrefix = DEFAULT_PREFIX + '/';
      }

      const timestamp = new Date().toISOString().replace(/[:\-T]/g, '').slice(0, 14);
      const backupKey = `${basePrefix}backups/${ledgerId}/${timestamp}_backup.json`;
      await r2.put(backupKey, backupContent, { httpMetadata: { contentType: 'application/json' } });
      return {
        success: true,
        message: 'Backup uploaded to R2',
        backupSize,
        backupPath: backupKey
      };
    } else if (remoteConfig.backend_type === 'ftp') {
      const ftpHost = remoteConfig.host || remoteConfig.hostname;
      const ftpPort = parseInt(remoteConfig.port || '21', 10);
      const ftpUser = remoteConfig.username;
      const ftpPass = remoteConfig.password;

      if (!ftpHost || !ftpUser || !ftpPass) {
        return { success: false, message: 'FTP configuration incomplete (host, username, password required)' };
      }

      const ftpClient = createFtpClient({ host: ftpHost, port: ftpPort, username: ftpUser, password: ftpPass });

      let basePrefix = '';
      if (remoteConfig.savePath && typeof remoteConfig.savePath === 'string' && remoteConfig.savePath.trim() !== '') {
        basePrefix = remoteConfig.savePath.trim().replace(/^\/+|\/+$/g, '') + '/';
      }

      const timestamp = new Date().toISOString().replace(/[:\-T]/g, '').slice(0, 14);
      const backupKey = `${basePrefix}backups/${ledgerId}/${timestamp}_backup.json`;

      console.log(`[Backup] Uploading to FTP: ${backupKey}`);

      const encoder = new TextEncoder();
      const uploadResult = await ftpClient.upload(backupKey, encoder.encode(backupContent));

      if (!uploadResult) {
        return { success: false, message: 'FTP upload failed' };
      }

      return {
        success: true,
        message: 'Backup completed successfully via FTP',
        backupSize,
        backupPath: backupKey
      };
    } else if (remoteConfig.backend_type === 'sftp') {
      const sftpHost = remoteConfig.host || remoteConfig.hostname;
      const sftpPort = parseInt(remoteConfig.port || '22', 10);
      const sftpUsername = remoteConfig.username;
      const sftpPassword = remoteConfig.password;
      const sftpKey = remoteConfig.private_key || remoteConfig.privateKey;

      if (!sftpHost || !sftpUsername) {
        return { success: false, message: 'SFTP configuration incomplete (host, username required)' };
      }

      let basePrefix = '';
      if (remoteConfig.savePath && typeof remoteConfig.savePath === 'string' && remoteConfig.savePath.trim() !== '') {
        basePrefix = remoteConfig.savePath.trim().replace(/^\/+|\/+$/g, '') + '/';
      }

      const timestamp = new Date().toISOString().replace(/[:\-T]/g, '').slice(0, 14);
      const backupKey = `${basePrefix}backups/${ledgerId}/${timestamp}_backup.json`;

      console.log(`[Backup] Uploading to SFTP: ${backupKey}`);

      const sftpClient = createSftpClient({ host: sftpHost, port: sftpPort, username: sftpUsername, password: sftpPassword, privateKey: sftpKey });
      const encoder = new TextEncoder();
      const uploadResult = await sftpClient.upload(backupKey, encoder.encode(backupContent));

      if (!uploadResult) {
        return { success: false, message: 'SFTP upload failed' };
      }

      return {
        success: true,
        message: 'Backup completed successfully via SFTP',
        backupSize,
        backupPath: backupKey
      };
    } else {
      return { success: false, message: `Unsupported backend type: ${remoteConfig.backend_type}` };
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Backup] Error:', errorMsg);
    return { success: false, message: `Backup error: ${errorMsg}` };
  }
}

/**
 * 计算下次运行时间
 * Cron 表达式格式: 分钟 小时 日期 月份 星期
 * @param cronExpr cron表达式
 * @param timezoneOffset 用户时区偏移（分钟，东八区为-480）
 */
export function calculateNextRun(cronExpr: string, timezoneOffset: number = 0): string {
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

    const now = new Date();

    let targetLocal = new Date();
    targetLocal.setHours(targetHour);
    targetLocal.setMinutes(targetMinute);
    targetLocal.setSeconds(0);
    targetLocal.setMilliseconds(0);

    if (targetLocal.getTime() <= now.getTime()) {
      targetLocal.setDate(targetLocal.getDate() + 1);
    }

    if (dayStr !== '*') {
      const targetDay = parseInt(dayStr, 10);
      if (!isNaN(targetDay) && targetDay > 0 && targetDay <= 31) {
        if (targetDay < targetLocal.getDate()) {
          targetLocal.setMonth(targetLocal.getMonth() + 1);
        }
        targetLocal.setDate(targetDay);
      }
    }

    const targetUtc = new Date(targetLocal.getTime() + timezoneOffset * 60000);

    return targetUtc.toISOString();
  } catch (e) {
    console.error('[Schedule] Error parsing cron expression:', cronExpr, e);
    const nextDate = new Date();
    nextDate.setMinutes(nextDate.getMinutes() + 5);
    return nextDate.toISOString();
  }
}
