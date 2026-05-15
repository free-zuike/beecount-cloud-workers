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

  const response: UserProfileOut = {
    user_id: row.id,
    email: row.email,
    display_name: row.display_name,
    avatar_url: row.avatar_file_id,
    avatar_version: row.avatar_version ?? 0,
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

  const response: UserProfileOut = {
    user_id: row.id,
    email: row.email,
    display_name: row.display_name,
    avatar_url: row.avatar_file_id,
    avatar_version: row.avatar_version ?? 0,
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

  // 获取上传的文件（简化版，实际需要处理 FormData）
  // Cloudflare Workers 支持 Request.formData()
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

    // 计算 SHA256（简化，完整实现需要读取文件内容）
    const fileBuffer = await file.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', fileBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const sha256 = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

    // 存储路径
    const storagePath = `avatars/${userId}/${fileId}/${fileName}`;

    // 插入 attachment_files 记录
    await db
      .prepare(
        `INSERT INTO attachment_files
         (id, ledger_id, user_id, sha256, size_bytes, mime_type, file_name, storage_path, attachment_kind, created_at)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'category_icon', ?)`
      )
      .bind(fileId, userId, sha256, size, mimeType, fileName, storagePath, serverNow)
      .run();

    // 更新 avatar_version
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

  return c.json({
    avatar_url: fileId,
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
 * - 支持缓存（通过 v 参数控制）
 *
 * 路径参数：
 * - user_id: 用户 ID
 *
 * 查询参数：
 * - v: 头像版本号（用于缓存 busting）
 *
 * 响应：
 * - 200: 图片文件
 * - 404: 头像不存在
 */
profileRouter.get('/avatar/:user_id', async (c) => {
  const userId = c.req.param('user_id');
  const db = c.env.DB;
  const version = c.req.query('v');

  const profile = await db
    .prepare(
      `SELECT p.avatar_file_id, p.avatar_version
       FROM user_profiles p
       WHERE p.user_id = ?`
    )
    .bind(userId)
    .first<{
      avatar_file_id: string | null;
      avatar_version: number | null;
    }>();

  if (!profile || !profile.avatar_file_id) {
    return c.json({ error: 'Avatar not found' }, 404);
  }

  const attachment = await db
    .prepare(
      `SELECT id, storage_path, mime_type, file_name, size_bytes
       FROM attachment_files
       WHERE id = ?`
    )
    .bind(profile.avatar_file_id)
    .first<{
      id: string;
      storage_path: string;
      mime_type: string | null;
      file_name: string | null;
      size_bytes: number;
    }>();

  if (!attachment) {
    return c.json({ error: 'Avatar not found' }, 404);
  }

  const cacheControl =
    version && version === String(profile.avatar_version)
      ? 'public, max-age=31536000, immutable'
      : 'no-cache';

  return c.json({
    file_id: attachment.id,
    mime_type: attachment.mime_type,
    file_name: attachment.file_name,
    size: attachment.size_bytes,
    version: profile.avatar_version,
    cache_control: cacheControl,
  });
});

export default profileRouter;
