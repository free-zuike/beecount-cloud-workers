/**
 * 个人资料路由模块 - 实现 BeeCount Cloud 用户资料接口
 *
 * 参考原版 BeeCount-Cloud (Python/FastAPI) 的 /profile 端点：
 * - GET  /profile/me            - 获取当前用户资料
 * - PATCH /profile/me           - 更新当前用户资料
 * - POST /profile/me/avatar     - 上传头像
 *
 * 功能说明：
 * - 用户资料包括显示名、主题设置、AI 配置等
 * - AI 配置存储为 JSON（providers / binding / custom_prompt 等）
 * - 外观设置存储为 JSON（header_decoration_style / compact_amount / show_transaction_time）
 *
 * @module routes/profile
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { hashPassword, verifyPassword } from '../auth';

// ===========================
// 辅助函数
// ===========================

/** 获取当前 UTC 时间 */
function nowUtc(): string {
  return new Date().toISOString();
}

/** 安全解析 JSON */
function safeJsonParse<T = Record<string, unknown>>(jsonStr: string | null): T | null {
  if (!jsonStr) return null;
  try {
    return JSON.parse(jsonStr) as T;
  } catch {
    return null;
  }
}

/** 安全序列化 JSON */
function safeJsonStringify(obj: unknown): string | null {
  if (obj === null || obj === undefined) return null;
  try {
    return JSON.stringify(obj);
  } catch {
    return null;
  }
}

// ===========================
// S3 服务类（用于头像上传下载）
// ===========================

class S3Service {
  private db: D1Database;
  private env: Bindings;
  private s3ConfigCache: any = null;
  private s3ConfigCacheTime: number = 0;
  private CACHE_TTL_MS = 60000;

  constructor(db: D1Database, env: S3Bindings) {
    this.db = db;
    this.env = env;
  }

  private async getS3Config(): Promise<any> {
    const now = Date.now();
    if (this.s3ConfigCache && (now - this.s3ConfigCacheTime) < this.CACHE_TTL_MS) {
      return this.s3ConfigCache;
    }

    try {
      const { getFirstEnabledS3Config } = await import('./sys_config');
      const dbConfig = await getFirstEnabledS3Config(this.db, this.env as Bindings);
      if (dbConfig) {
        this.s3ConfigCache = dbConfig;
        this.s3ConfigCacheTime = now;
        console.log('[S3Service] Using config from sys_config');
        return dbConfig;
      }
    } catch {
      // ignore
    }

    // 尝试从备份配置中读取
    try {
      const backupRemote = await this.db
        .prepare(
          'SELECT config_summary FROM backup_remotes WHERE backend_type = ? AND encrypted = 0 ORDER BY id DESC LIMIT 1'
        )
        .bind('s3')
        .first<{ config_summary: string }>();

      if (backupRemote && backupRemote.config_summary) {
          const config = JSON.parse(backupRemote.config_summary);
          if (config.access_key_id && config.secret_access_key && config.bucket) {
            const backupConfig = {
              id: 'backup_remote',
              name: 'Backup S3',
              type: 's3',
              savePath: 'backup_remote',
              accessKeyId: config.access_key_id,
              secretAccessKey: config.secret_access_key,
              region: config.region || 'auto',
              bucketName: config.bucket.replace(/^\/+/, ''),
              endpoint: config.endpoint || 'https://s3.amazonaws.com',
              pathStyle: config.path_style !== undefined ? Boolean(config.path_style) : true,
              cdnDomain: config.cdn_domain || '',
              enabled: true,
              fixed: true
            };
            this.s3ConfigCache = backupConfig;
            this.s3ConfigCacheTime = now;
            console.log('[S3Service] Using config from backup_remotes');
            return backupConfig;
          }
        }
    } catch (err) {
      console.error('[S3Service] Failed to load config from backup_remotes:', err);
    }

    if (this.env.S3_ACCESS_KEY_ID) {
      const envConfig = {
        id: 1,
        name: 'S3_env',
        type: 's3',
        savePath: 'environment variable',
        accessKeyId: this.env.S3_ACCESS_KEY_ID,
        secretAccessKey: this.env.S3_SECRET_ACCESS_KEY,
        region: this.env.S3_REGION || 'us-east-1',
        bucketName: this.env.S3_BUCKET_NAME,
        endpoint: this.env.S3_ENDPOINT,
        pathStyle: true,
        cdnDomain: '',
        enabled: true,
        fixed: true
      };
      this.s3ConfigCache = envConfig;
      this.s3ConfigCacheTime = now;
      console.log('[S3Service] Using config from environment variables');
      return envConfig;
    }

    console.log('[S3Service] No S3 config found');
    return null;
  }

  async isConfigured(): Promise<boolean> {
    const config = await this.getS3Config();
    const configured = config !== null;
    console.log('[S3Service] isConfigured:', configured, config ? `endpoint: ${config.endpoint}, bucket: ${config.bucketName}` : 'no config');
    return configured;
  }

  async upload(key: string, body: ArrayBuffer, contentType: string): Promise<boolean> {
    const config = await this.getS3Config();
    if (!config) {
      console.log('[S3Service] upload: no config available');
      return false;
    }

    try {
      console.log('[S3Service] upload: starting upload to', key);
      console.log('[S3Service] config:', {
        endpoint: config.endpoint,
        bucket: config.bucketName,
        region: config.region,
        accessKeyId: config.accessKeyId ? '***' : 'missing'
      });
      const { url, headers } = await signRequest(
        config.accessKeyId,
        config.secretAccessKey,
        config.region || 'us-east-1',
        config.endpoint,
        config.bucketName,
        key,
        'PUT',
        contentType,
        body.byteLength
      );

      console.log('[S3Service] upload: sending request to', url);
      const response = await fetch(url, {
        method: 'PUT',
        headers,
        body
      });

      console.log('[S3Service] upload: response status', response.status);
      if (!response.ok) {
        const responseText = await response.text();
        console.error('[S3Service] upload: failed with response:', responseText);
      }
      return response.ok;
    } catch (err) {
      console.error('[S3Service] upload: error', err);
      if (err instanceof Error) {
        console.error('[S3Service] upload: error stack', err.stack);
      }
      return false;
    }
  }

  async download(key: string): Promise<Response | null> {
    const config = await this.getS3Config();
    if (!config) {
      console.log('[S3Service] download: no config available');
      return null;
    }

    try {
      console.log('[S3Service] download: starting download from', key);
      const { url, headers } = await signRequest(
        config.accessKeyId,
        config.secretAccessKey,
        config.region || 'us-east-1',
        config.endpoint,
        config.bucketName,
        key,
        'GET',
        'application/octet-stream',
        0
      );

      console.log('[S3Service] download: sending request to', url);
      const response = await fetch(url, {
        method: 'GET',
        headers
      });

      if (!response.ok) {
        console.log('[S3Service] download: response not ok', response.status);
        return null;
      }

      console.log('[S3Service] download: success');
      return response;
    } catch (err) {
      console.error('[S3Service] download: error', err);
      return null;
    }
  }
}

async function signRequest(
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

async function getSignatureKey(key: string, dateStamp: string, regionName: string, serviceName: string): Promise<Uint8Array> {
    const kDate = await hmac(new TextEncoder().encode(`AWS4${key}`), dateStamp);
    const kRegion = await hmac(kDate, regionName);
    const kService = await hmac(kRegion, serviceName);
    const kSigning = await hmac(kService, 'aws4_request');
    return kSigning;
}

async function hmac(key: Uint8Array | ArrayBuffer, data: string): Promise<Uint8Array> {
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

async function sha256Hex(data: string): Promise<string> {
    const encoder = new TextEncoder();
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(data));
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(key: Uint8Array, data: string): Promise<string> {
    const signature = await hmac(key, data);
    return Array.from(signature).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ===========================
// Schema 定义
// ===========================

/** 更新资料请求 */
const ProfilePatchSchema = z.object({
  display_name: z.string().min(1).max(32).optional(),
  income_is_red: z.boolean().nullable().optional(),
  theme_primary_color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullable().optional(),
  appearance: z.record(z.unknown()).nullable().optional(),
  ai_config: z.record(z.unknown()).nullable().optional(),
});

// ===========================
// 类型定义
// ===========================

/** 用户资料输出 */
interface UserProfileOut {
  user_id: string;
  email: string;
  display_name: string | null;
  avatar_url: string | null;
  avatar_version: number;
  income_is_red: boolean | null;
  theme_primary_color: string | null;
  appearance: Record<string, unknown> | null;
  ai_config: Record<string, unknown> | null;
}

// ===========================
// 路由定义
// ===========================

type Bindings = {
  DB: D1Database;
  JWT_SECRET: string;
  S3_ENDPOINT?: string;
  S3_REGION?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
  S3_BUCKET_NAME?: string;
  S3_PATH_STYLE?: string;
  S3_CDN_DOMAIN?: string;
};

type Variables = {
  userId: string;
};

const profileRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// ---------------------------------------------------------------------------
// GET /profile/me - 获取当前用户资料
// ---------------------------------------------------------------------------

/**
 * 获取当前登录用户的资料
 *
 * 功能说明：
 * - 联表查询 users 和 user_profiles
 * - 返回用户的显示名、头像、主题、AI 配置等信息
 *
 * 响应字段：
 * - user_id: 用户 ID
 * - email: 邮箱
 * - display_name: 显示名称
 * - avatar_url: 头像 URL（这里返回 avatar_file_id，实际 URL 由客户端拼接）
 * - avatar_version: 头像版本号
 * - income_is_red: 收入是否红色显示（true = 红收绿支，false = 红支绿收）
 * - theme_primary_color: 主题色（#RRGGBB）
 * - appearance: 外观设置 JSON
 * - ai_config: AI 配置 JSON
 */
profileRouter.get('/me', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;

  const row = await db
    .prepare(
      `SELECT u.id, u.email,
              p.display_name, p.avatar_file_id, p.avatar_version,
              p.income_is_red, p.theme_primary_color,
              p.appearance_json, p.ai_config_json
       FROM users u
       LEFT JOIN user_profiles p ON p.user_id = u.id
       WHERE u.id = ?`
    )
    .bind(userId)
    .first<{
      id: string;
      email: string;
      display_name: string | null;
      avatar_file_id: string | null;
      avatar_version: number;
      income_is_red: number | null;
      theme_primary_color: string | null;
      appearance_json: string | null;
      ai_config_json: string | null;
    }>();

  if (!row) {
    return c.json({ error: 'User not found' }, 404);
  }

  const avatarVersion = row.avatar_version ?? 0;
  const avatarUrl = row.avatar_file_id 
    ? `/api/v1/profile/avatar/${row.id}?v=${avatarVersion}`
    : null;

  const response: UserProfileOut = {
    user_id: row.id,
    email: row.email,
    display_name: row.display_name,
    avatar_url: avatarUrl,
    avatar_version: avatarVersion,
    income_is_red: row.income_is_red !== null ? Boolean(row.income_is_red) : null,
    theme_primary_color: row.theme_primary_color,
    appearance: safeJsonParse(row.appearance_json),
    ai_config: safeJsonParse(row.ai_config_json),
  };

  return c.json(response);
});

// ---------------------------------------------------------------------------
// PATCH /profile/me - 更新当前用户资料
// ---------------------------------------------------------------------------

/**
 * 更新当前登录用户的资料
 *
 * 功能说明：
 * - 所有字段可选，只更新非 undefined 的字段
 * - display_name 最大 32 字符
 * - theme_primary_color 必须符合 #RRGGBB 格式
 * - appearance 和 ai_config 整体覆盖（如果有）
 *
 * 请求字段（全部可选）：
 * - display_name: 显示名称
 * - income_is_red: 收入红色显示偏好
 * - theme_primary_color: 主题色
 * - appearance: 外观设置对象
 * - ai_config: AI 配置对象
 */
profileRouter.patch('/me', zValidator('json', ProfilePatchSchema), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const req = c.req.valid('json');
  const serverNow = nowUtc();

  // 检查是否已有 profile
  const existing = await db
    .prepare('SELECT id FROM user_profiles WHERE user_id = ?')
    .bind(userId)
    .first<{ id: number }>();

  if (!existing) {
    // 创建新 profile
    await db
      .prepare(
        `INSERT INTO user_profiles (user_id, display_name, avatar_version, income_is_red,
                                    theme_primary_color, appearance_json, ai_config_json, updated_at)
         VALUES (?, ?, 0, ?, ?, ?, ?, ?)`
      )
      .bind(
        userId,
        req.display_name ?? null,
        req.income_is_red ?? null,
        req.theme_primary_color ?? null,
        safeJsonStringify(req.appearance ?? null),
        safeJsonStringify(req.ai_config ?? null),
        serverNow,
      )
      .run();
  } else {
    // 构建动态更新语句
    const updates: string[] = ['updated_at = ?'];
    const params: (string | number | null)[] = [serverNow];

    if (req.display_name !== undefined) {
      updates.push('display_name = ?');
      params.push(req.display_name);
    }
    if (req.income_is_red !== undefined) {
      updates.push('income_is_red = ?');
      params.push(req.income_is_red === null ? null : req.income_is_red ? 1 : 0);
    }
    if (req.theme_primary_color !== undefined) {
      updates.push('theme_primary_color = ?');
      params.push(req.theme_primary_color);
    }
    if (req.appearance !== undefined) {
      updates.push('appearance_json = ?');
      params.push(safeJsonStringify(req.appearance));
    }
    if (req.ai_config !== undefined) {
      updates.push('ai_config_json = ?');
      params.push(safeJsonStringify(req.ai_config));
    }

    params.push(userId);

    await db
      .prepare(`UPDATE user_profiles SET ${updates.join(', ')} WHERE user_id = ?`)
      .bind(...params)
      .run();
  }

  // 返回更新后的资料
  const row = await db
    .prepare(
      `SELECT u.id, u.email,
              p.display_name, p.avatar_file_id, p.avatar_version,
              p.income_is_red, p.theme_primary_color,
              p.appearance_json, p.ai_config_json
       FROM users u
       LEFT JOIN user_profiles p ON p.user_id = u.id
       WHERE u.id = ?`
    )
    .bind(userId)
    .first<{
      id: string;
      email: string;
      display_name: string | null;
      avatar_file_id: string | null;
      avatar_version: number;
      income_is_red: number | null;
      theme_primary_color: string | null;
      appearance_json: string | null;
      ai_config_json: string | null;
    }>();

  if (!row) {
    return c.json({ error: 'User not found' }, 404);
  }

  const avatarVersion = row.avatar_version ?? 0;
  const avatarUrl = row.avatar_file_id 
    ? `/api/v1/profile/avatar/${row.id}?v=${avatarVersion}`
    : null;

  const response: UserProfileOut = {
    user_id: row.id,
    email: row.email,
    display_name: row.display_name,
    avatar_url: avatarUrl,
    avatar_version: avatarVersion,
    income_is_red: row.income_is_red !== null ? Boolean(row.income_is_red) : null,
    theme_primary_color: row.theme_primary_color,
    appearance: safeJsonParse(row.appearance_json),
    ai_config: safeJsonParse(row.ai_config_json),
  };

  return c.json(response);
});

// ---------------------------------------------------------------------------
// POST /profile/me/avatar - 上传头像
// ---------------------------------------------------------------------------

/**
 * 修改密码
 *
 * 请求字段：
 * - current_password: 当前密码
 * - new_password: 新密码（至少8位）
 */
profileRouter.post('/me/change-password', zValidator('json', z.object({
  current_password: z.string(),
  new_password: z.string().min(8)
})), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const { current_password, new_password } = c.req.valid('json');

  // 获取当前密码哈希
  const user = await db
    .prepare('SELECT password_hash FROM users WHERE id = ?')
    .bind(userId)
    .first<{ password_hash: string }>();

  if (!user) {
    return c.json({ error: 'User not found' }, 404);
  }

  // 验证当前密码
  const passwordValid = await verifyPassword(user.password_hash, current_password);
  if (!passwordValid) {
    return c.json({ error: 'Current password is incorrect' }, 400);
  }

  // 哈希新密码并更新
  const newPasswordHash = await hashPassword(new_password);
  await db
    .prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .bind(newPasswordHash, userId)
    .run();

  return c.json({ success: true, message: 'Password changed successfully' });
});

/**
 * 上传用户头像
 *
 * 功能说明：
 * - 接收 FormData 中的 file 字段
 * - 计算文件 SHA256 哈希
 * - 存储到 attachment_files 表（kind='category_icon' 用于头像）
 * - 更新 user_profiles 的 avatar_file_id 和 avatar_version
 *
 * 请求：
 * - FormData with file field
 *
 * 响应：
 * - avatar_url: 头像文件 ID
 * - avatar_version: 新版本号
 */
profileRouter.post('/me/avatar', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const serverNow = nowUtc();

  let fileId: string;
  let newVersion: number;

  try {
    const formData = await c.req.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return c.json({ error: 'No file provided' }, 400);
    }

    fileId = randomUUID();
    const fileName = file.name || 'avatar';
    const mimeType = file.type || 'image/png';
    const size = file.size;

    const fileBuffer = await file.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', fileBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const sha256 = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

    const storagePath = `avatars/${userId}/${fileId}/${fileName}`;

    const s3 = new S3Service(db, c.env);
    if (await s3.isConfigured()) {
      const uploadSuccess = await s3.upload(storagePath, fileBuffer, mimeType);
      if (!uploadSuccess) {
        return c.json({ error: 'Failed to upload avatar to S3' }, 500);
      }
    }

    await db
      .prepare(
        `INSERT INTO attachment_files
         (id, ledger_id, user_id, sha256, size_bytes, mime_type, file_name, storage_path, attachment_kind, created_at)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'category_icon', ?)`
      )
      .bind(fileId, userId, sha256, size, mimeType, fileName, storagePath, serverNow)
      .run();

    const profile = await db
      .prepare('SELECT avatar_version FROM user_profiles WHERE user_id = ?')
      .bind(userId)
      .first<{ avatar_version: number }>();

    newVersion = (profile?.avatar_version ?? 0) + 1;

    await db
      .prepare(
        `UPDATE user_profiles
         SET avatar_file_id = ?, avatar_version = ?, updated_at = ?
         WHERE user_id = ?`
      )
      .bind(fileId, newVersion, serverNow, userId)
      .run();
  } catch (err) {
    return c.json({ error: 'Failed to upload avatar' }, 500);
  }

  const avatarUrl = `/api/v1/profile/avatar/${userId}?v=${newVersion}`;

  return c.json({
    avatar_url: avatarUrl,
    avatar_version: newVersion,
  });
});

// ---------------------------------------------------------------------------
// POST /profile/avatar - 上传当前用户头像
// ---------------------------------------------------------------------------

/**
 * 上传当前用户头像（不带 /me 前缀）
 */
profileRouter.post('/avatar', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const serverNow = nowUtc();

  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  let fileId: string;
  let newVersion: number;

  try {
    const formData = await c.req.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return c.json({ error: 'No file provided' }, 400);
    }

    fileId = randomUUID();
    const fileName = file.name || 'avatar';
    const mimeType = file.type || 'image/png';
    const size = file.size;

    const fileBuffer = await file.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', fileBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const sha256 = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

    const storagePath = `avatars/${userId}/${fileId}/${fileName}`;

    const s3 = new S3Service(db, c.env);
    if (await s3.isConfigured()) {
      const uploadSuccess = await s3.upload(storagePath, fileBuffer, mimeType);
      if (!uploadSuccess) {
        return c.json({ error: 'Failed to upload avatar to S3' }, 500);
      }
    }

    await db
      .prepare(
        `INSERT INTO attachment_files
         (id, ledger_id, user_id, sha256, size_bytes, mime_type, file_name, storage_path, attachment_kind, created_at)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'category_icon', ?)`
      )
      .bind(fileId, userId, sha256, size, mimeType, fileName, storagePath, serverNow)
      .run();

    const profile = await db
      .prepare('SELECT avatar_version FROM user_profiles WHERE user_id = ?')
      .bind(userId)
      .first<{ avatar_version: number }>();

    newVersion = (profile?.avatar_version ?? 0) + 1;

    await db
      .prepare(
        `UPDATE user_profiles
         SET avatar_file_id = ?, avatar_version = ?, updated_at = ?
         WHERE user_id = ?`
      )
      .bind(fileId, newVersion, serverNow, userId)
      .run();
  } catch (err) {
    return c.json({ error: 'Failed to upload avatar' }, 500);
  }

  const avatarUrl = `/api/v1/profile/avatar/${userId}?v=${newVersion}`;

  return c.json({
    avatar_url: avatarUrl,
    avatar_version: newVersion,
  });
});

// ---------------------------------------------------------------------------
// GET /profile/avatar/:user_id - 下载用户头像
// ---------------------------------------------------------------------------

/**
 * 下载指定用户头像
 *
 * 功能说明：
 * - 公开端点，无需认证即可访问
 * - 按 user_id 查询用户头像
 * - 如果有头像文件，直接返回图片内容
 * - 如果没有，返回默认的 SVG 头像
 */
profileRouter.get('/avatar/:user_id', async (c) => {
  const userId = c.req.param('user_id');
  const db = c.env.DB;
  const version = c.req.query('v');

  try {
    const profile = await db
      .prepare(
        `SELECT u.email, p.avatar_file_id, p.avatar_version, p.display_name
         FROM users u
         LEFT JOIN user_profiles p ON p.user_id = u.id
         WHERE u.id = ?`
      )
      .bind(userId)
      .first<{
        email: string;
        avatar_file_id: string | null;
        avatar_version: number | null;
        display_name: string | null;
      }>();

    if (!profile) {
      return c.json({ error: 'User not found' }, 404);
    }

    const displayName = profile.display_name || profile.email.split('@')[0];
    const initial = displayName.charAt(0).toUpperCase();

    const cacheControl = version && version === String(profile.avatar_version)
      ? 'public, max-age=31536000, immutable'
      : 'no-cache';

    if (profile.avatar_file_id) {
      const attachment = await db
        .prepare(
          `SELECT mime_type, file_name, size_bytes, storage_path
           FROM attachment_files
           WHERE id = ?`
        )
        .bind(profile.avatar_file_id)
        .first<{
          mime_type: string | null;
          file_name: string | null;
          size_bytes: number;
          storage_path: string;
        }>();

      if (attachment && attachment.storage_path) {
        const s3 = new S3Service(db, c.env);
        if (await s3.isConfigured()) {
          const s3Response = await s3.download(attachment.storage_path);
          if (s3Response) {
            return new Response(s3Response.body, {
              headers: {
                'Content-Type': attachment.mime_type || 'image/png',
                'Content-Length': String(attachment.size_bytes),
                'Cache-Control': cacheControl,
              },
            });
          }
        }
      }
    }

    const defaultAvatar = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
      <circle cx="64" cy="64" r="64" fill="#4F46E5"/>
      <text x="64" y="72" font-family="Arial, sans-serif" font-size="48" font-weight="bold" fill="white" text-anchor="middle">${initial}</text>
    </svg>`;

    const avatarBuffer = new TextEncoder().encode(defaultAvatar);
    
    return new Response(avatarBuffer, {
      headers: {
        'Content-Type': 'image/svg+xml',
        'Content-Length': String(avatarBuffer.length),
        'Cache-Control': 'public, max-age=31536000',
      },
    });
  } catch (err) {
    console.error('[Avatar] Error fetching avatar:', err);
    return c.json({ error: 'Failed to fetch avatar' }, 500);
  }
});

export default profileRouter;
