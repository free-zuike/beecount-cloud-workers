/**
 * 备份执行器 - 提取公共的备份执行逻辑
 *
 * 被 src/index.ts（定时任务）和 src/routes/admin_backup.ts（管理员手动触发）共用
 */

import { uploadToS3 } from '../lib/s3';
import { createFtpClient } from '../lib/ftp';
import { createSftpClient } from '../lib/sftp';
import { createTarGz } from '../lib/tar';
import { encryptData } from '../lib/encryption';
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

/**
 * 需要备份的用户数据表（排除运维类表，与原版 db_snapshot.py DEFAULT_EXCLUDED_TABLES 对齐）
 * 排除：backup_runs, backup_run_targets, sync_push_idempotency, audit_logs, refresh_tokens, mcp_call_logs
 * 保留：PAT 表（用户 LLM 配置依赖）, backup_remotes/schedules（配置保留）, 所有用户数据表
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
  // 'backup_schedule_remotes', // 表可能不存在，跳过
  'system_settings',
  'recovery_codes',
  'exchange_rate_overrides',
  'backup_snapshots',
  'backup_restores',
];

/** D1 每次查询最多返回的行数 */
const D1_BATCH_SIZE = 1000;

/**
 * 导出单张表的所有数据（分批查询，处理 D1 行数限制）
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
 * 从 R2 获取所有附件文件
 * 返回 { name: Uint8Array } 映射，name 是 tar 中的路径
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

export async function performBackup(
  db: D1Database,
  runId: number,
  userId: string,
  ledgerId: string,
  remoteConfig: Record<string, string>,
  shouldEncrypt?: boolean,
  r2?: R2Bucket,
  logFn?: (msg: string) => void
): Promise<BackupResult> {
  const log = logFn || console.log;
  try {
    log(`[Backup] Starting full database backup, user: ${userId}`);

    // 导出所有用户数据表（带重试）
    const tables: Record<string, unknown[]> = {};
    for (const tableName of BACKUP_TABLES) {
      try {
        const rows = await withRetry(
          () => exportTable(db, tableName),
          3,
          1000,
          `export ${tableName}`
        );
        if (rows.length > 0) {
          tables[tableName] = rows;
          log(`[Backup] ${tableName}: ${rows.length} rows`);
        }
      } catch (err) {
        // 表可能不存在（老版本 DB 还没跑过 migration），跳过
        log(`[Backup] Skipping ${tableName}: ${(err as Error).message}`);
      }
    }

    const totalRows = Object.values(tables).reduce((sum, rows) => sum + rows.length, 0);
    log(`[Backup] Total: ${Object.keys(tables).length} tables, ${totalRows} rows`);

    // 获取 R2 附件文件（带重试）
    let attachments = new Map<string, Uint8Array>();
    if (r2) {
      try {
        attachments = await withRetry(
          () => fetchR2Attachments(r2),
          2,
          2000,
          'fetch R2 attachments'
        );
        console.log(`[Backup] R2 attachments included: ${attachments.size} files`);
      } catch (err) {
        console.error(`[Backup] Failed to fetch R2 attachments: ${(err as Error).message}`);
        // 继续备份，附件缺失不阻止数据库备份
      }
    }

    // 创建 tar.gz 归档（与原版格式对齐）
    const tarEntries: { name: string; data: Uint8Array }[] = [];

    // 1. meta.json
    const meta = {
      schemaVersion: 1,
      appVersion: '1.0',
      createdAt: new Date().toISOString(),
      userId: userId,
      includeAttachments: true,
    };
    tarEntries.push({
      name: 'meta.json',
      data: new TextEncoder().encode(JSON.stringify(meta, null, 2)),
    });

    // 2. 数据库导出 - 创建包含数据的 SQLite 文件
    console.log('[Backup] Creating db.sqlite3 with data...');
    try {
      const sqliteData = createSqliteWithData(tables);
      tarEntries.push({
        name: 'db.sqlite3',
        data: sqliteData,
      });
      console.log(`[Backup] db.sqlite3 created: ${sqliteData.length} bytes`);
    } catch (err) {
      console.error(`[Backup] Failed to create SQLite: ${(err as Error).message}`);
      
      // 回退到最小化 SQLite
      try {
        const { createMinimalSqliteFile } = await import('../lib/sqlite-writer');
        const minimalSqlite = createMinimalSqliteFile();
        tarEntries.push({
          name: 'db.sqlite3',
          data: minimalSqlite,
        });
      } catch (e) {
        console.error(`[Backup] Fallback also failed: ${(e as Error).message}`);
      }
    }
    
    // 始终包含 db.json 作为备份
    const dbExport = {
      backup_time: new Date().toISOString(),
      version: '1.0',
      schema_version: 1,
      user_id: userId,
      tables,
    };
    tarEntries.push({
      name: 'db.json',
      data: new TextEncoder().encode(JSON.stringify(dbExport, null, 2)),
    });
    console.log(`[Backup] db.json created: ${JSON.stringify(dbExport).length} bytes`);

    // 3. 附件文件
    for (const [key, value] of attachments) {
      tarEntries.push({
        name: key,
        data: value,
      });
    }

    console.log(`[Backup] Creating tar.gz with ${tarEntries.length} entries`);
    let backupBytes = await withRetry(
      () => createTarGz(tarEntries),
      2,
      1000,
      'create tar.gz'
    );
    let encrypted = false;

    // 加密备份文件
    if (shouldEncrypt) {
      const encryptionPassword = remoteConfig.age_passphrase || remoteConfig.encryption_password;
      if (encryptionPassword) {
        try {
          console.log('[Backup] Encrypting backup with AES-256-GCM...');
          backupBytes = await encryptData(backupBytes, encryptionPassword);
          encrypted = true;
          console.log(`[Backup] Backup encrypted: ${backupBytes.length} bytes`);
        } catch (encryptErr) {
          console.error(`[Backup] Encryption failed: ${(encryptErr as Error).message}`);
          // 加密失败继续上传未加密的备份
        }
      } else {
        console.log('[Backup] No encryption password found, skipping encryption');
      }
    }

    const backupSize = backupBytes.length;

    console.log(`[Backup] Backup content size: ${backupSize} bytes`);

    if (remoteConfig.backend_type === 's3' || remoteConfig.backend_type === 'b2') {
      // B2 使用 S3 兼容 API
      const isB2 = remoteConfig.backend_type === 'b2';
      const s3Endpoint = remoteConfig.endpoint || (isB2 ? 'https://s3.us-west-004.backblazeb2.com' : 'https://s3.amazonaws.com');
      const s3Bucket = remoteConfig.bucket;
      const s3AccessKey = remoteConfig.access_key_id || remoteConfig.key;
      const s3SecretKey = remoteConfig.secret_access_key || remoteConfig.account;
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

      // 使用本地时间（UTC+8）生成时间戳
      const now = new Date();
      const localTime = new Date(now.getTime() + (8 * 60 * 60 * 1000)); // UTC+8
      const timestamp = localTime.toISOString().replace(/[:\-T]/g, '').slice(0, 14);
      const fileExt = encrypted ? '.zip' : '.tar.gz';
      const backupKey = `${basePrefix}backups/${userId}/${timestamp}_backup${fileExt}`;

      console.log(`[Backup] Uploading to S3 key: ${backupKey}`);

      const uploadResult = await uploadToS3(
        s3Endpoint,
        s3Bucket,
        s3AccessKey,
        s3SecretKey,
        s3Region,
        backupKey,
        backupBytes,
        'application/gzip'
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

      const backupKey = `${basePrefix}backups/${userId}/${timestamp}_backup.tar.gz`;

      console.log(`[Backup] Uploading to WebDAV: ${backupKey}`);

      const uploadResult = await uploadToWebDav(webdavUrl, webdavUsername, webdavPassword, backupKey, backupBytes);

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
        backupPath: `local://backup_${runId}.tar.gz`
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

      // 使用本地时间（UTC+8）生成时间戳
      const now = new Date();
      const localTime = new Date(now.getTime() + (8 * 60 * 60 * 1000)); // UTC+8
      const timestamp = localTime.toISOString().replace(/[:\-T]/g, '').slice(0, 14);
      const fileExt = encrypted ? '.zip' : '.tar.gz';
      const backupKey = `${basePrefix}backups/${userId}/${timestamp}_backup${fileExt}`;
      
      console.log(`[Backup] Uploading to R2: ${backupKey} (${backupSize} bytes)`);
      try {
        await withRetry(
          () => r2.put(backupKey, backupBytes, { httpMetadata: { contentType: 'application/gzip' } }),
          3,
          2000,
          'R2 upload'
        );
        console.log(`[Backup] R2 upload successful: ${backupKey}`);
        return {
          success: true,
          message: 'Backup uploaded to R2',
          backupSize,
          backupPath: backupKey
        };
      } catch (r2Err) {
        console.error(`[Backup] R2 upload failed after retries: ${(r2Err as Error).message}`);
        return { success: false, message: `R2 upload failed: ${(r2Err as Error).message}` };
      }
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

      // 使用本地时间（UTC+8）生成时间戳
      const now = new Date();
      const localTime = new Date(now.getTime() + (8 * 60 * 60 * 1000)); // UTC+8
      const timestamp = localTime.toISOString().replace(/[:\-T]/g, '').slice(0, 14);
      const fileExt = encrypted ? '.zip' : '.tar.gz';
      const backupKey = `${basePrefix}backups/${userId}/${timestamp}_backup${fileExt}`;

      console.log(`[Backup] Uploading to FTP: ${backupKey}`);

      const uploadResult = await ftpClient.upload(backupKey, backupBytes);

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

      // 使用本地时间（UTC+8）生成时间戳
      const now = new Date();
      const localTime = new Date(now.getTime() + (8 * 60 * 60 * 1000)); // UTC+8
      const timestamp = localTime.toISOString().replace(/[:\-T]/g, '').slice(0, 14);
      const fileExt = encrypted ? '.zip' : '.tar.gz';
      const backupKey = `${basePrefix}backups/${userId}/${timestamp}_backup${fileExt}`;

      console.log(`[Backup] Uploading to SFTP: ${backupKey}`);

      const sftpClient = createSftpClient({ host: sftpHost, port: sftpPort, username: sftpUsername, password: sftpPassword, privateKey: sftpKey });
      const uploadResult = await sftpClient.upload(backupKey, backupBytes);

      if (!uploadResult) {
        return { success: false, message: 'SFTP upload failed' };
      }

      return {
        success: true,
        message: 'Backup completed successfully via SFTP',
        backupSize,
        backupPath: backupKey
      };
    } else if (remoteConfig.backend_type === 'drive' || remoteConfig.backend_type === 'onedrive' || remoteConfig.backend_type === 'dropbox') {
      // OAuth2 后端需要 rclone，当前环境不支持
      // 用户需要使用 rclone CLI 手动备份
      return { 
        success: false, 
        message: `${remoteConfig.backend_type} backup requires rclone. Please use rclone CLI manually or switch to R2/S3/WebDAV/SFTP/FTP.` 
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
 * cronExpr 中的时间是 UTC 时间
 * @param cronExpr cron表达式（UTC时间）
 * @param timezoneOffset 用户时区偏移（分钟，东八区为-480，仅用于显示）
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

    // cron 时间是 UTC，直接使用
    const now = new Date();
    const nowUtcMs = now.getTime();
    
    // 创建目标时间（UTC）
    const targetDate = new Date();
    targetDate.setUTCHours(targetHour, targetMinute, 0, 0);
    let targetUtcMs = targetDate.getTime();
    
    // 如果目标时间已过，加一天
    if (targetUtcMs <= nowUtcMs) {
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
