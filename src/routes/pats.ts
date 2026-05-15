/**
 * PAT 路由模块 - 实现 Personal Access Token 管理接口
 *
 * 参考原版 BeeCount-Cloud (Python/FastAPI) 的 /profile/pats 端点：
 * - GET    /profile/pats          - 列出当前用户的 PAT
 * - POST   /profile/pats           - 创建新 PAT
 * - DELETE /profile/pats/:id     - 撤销 PAT
 *
 * 功能说明：
 * - PAT 用于外部 LLM 客户端（Claude Desktop / Cursor / Cline）通过 MCP 协议访问账本
 * - Token 格式：bcmcp_<32 字节 base64url>
 * - 只有创建时返回明文 token，之后只存储 sha256 哈希
 * - 支持自定义过期时间和权限范围
 *
 * @module routes/pats
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

/** 生成 PAT token */
function generatePatToken(): { prefix: string; token: string } {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const base64 = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  const prefix = 'bcmcp_' + base64.slice(0, 16);
  const token = 'bcmcp_' + base64;
  return { prefix, token };
}

/** 计算 SHA256 哈希 */
async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ===========================
// Schema 定义
// ===========================

/** 创建 PAT 请求 */
const PatCreateSchema = z.object({
  name: z.string().min(1).max(128),
  scopes: z.array(z.enum(['mcp:read', 'mcp:write'])).default(['mcp:read']),
  expires_in_days: z.number().int().min(1).max(36500).nullable().optional(),
});

// ===========================
// 类型定义
// ===========================

/** PAT 输出 */
interface PatOut {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
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

const patsRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// ---------------------------------------------------------------------------
// GET /profile/pats - 列出当前用户的 PAT
// ---------------------------------------------------------------------------

/**
 * 获取当前用户的所有 PAT 列表
 *
 * 功能说明：
 * - 返回所有未撤销的 PAT
 * - 不返回完整 token（只返回 prefix 用于识别）
 * - 按创建时间倒序
 */
patsRouter.get('/', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;

  const rows = await db
    .prepare(
      `SELECT id, name, prefix, scopes_json, expires_at, last_used_at, created_at
       FROM personal_access_tokens
       WHERE user_id = ? AND revoked_at IS NULL
       ORDER BY created_at DESC`
    )
    .bind(userId)
    .all<{
      id: string;
      name: string;
      prefix: string;
      scopes_json: string;
      expires_at: string | null;
      last_used_at: string | null;
      created_at: string;
    }>();

  const result: PatOut[] = rows.results.map((row) => ({
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: JSON.parse(row.scopes_json || '[]'),
    expires_at: row.expires_at,
    last_used_at: row.last_used_at,
    created_at: row.created_at,
  }));

  return c.json(result);
});

// ---------------------------------------------------------------------------
// POST /profile/pats - 创建新 PAT
// ---------------------------------------------------------------------------

/**
 * 创建新的 Personal Access Token
 *
 * 功能说明：
 * - 生成随机 token
 * - 计算 SHA256 哈希存储
 * - 返回明文 token（只有这一次机会，需要用户保存）
 *
 * 请求字段：
 * - name: Token 名称（如 "Claude Desktop"）
 * - scopes: 权限范围数组（['mcp:read'] 或 ['mcp:read', 'mcp:write']）
 * - expires_in_days: 过期天数（可选，null 表示永不过期）
 *
 * 响应：
 * - 成功时返回 token（明文）和元数据
 */
patsRouter.post('/', zValidator('json', PatCreateSchema), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const req = c.req.valid('json');
  const serverNow = nowUtc();

  const { prefix, token } = generatePatToken();
  const tokenHash = await hashToken(token);

  let expiresAt: string | null = null;
  if (req.expires_in_days) {
    const expiresDate = new Date(Date.now() + req.expires_in_days * 24 * 60 * 60 * 1000);
    expiresAt = expiresDate.toISOString();
  }

  const patId = randomUUID();

  await db
    .prepare(
      `INSERT INTO personal_access_tokens
       (id, user_id, name, token_hash, prefix, scopes_json, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      patId,
      userId,
      req.name,
      tokenHash,
      prefix,
      JSON.stringify(req.scopes),
      expiresAt,
      serverNow,
    )
    .run();

  return c.json({
    id: patId,
    name: req.name,
    // ⚠️ 注意：明文 token 只有这一次返回机会
    token,
    scopes: req.scopes,
    expires_at: expiresAt,
    created_at: serverNow,
  });
});

// ---------------------------------------------------------------------------
// DELETE /profile/pats/:id - 撤销 PAT
// ---------------------------------------------------------------------------

/**
 * 撤销指定的 PAT
 *
 * 功能说明：
 * - 设置 revoked_at 为当前时间
 * - 被撤销的 PAT 无法再使用
 */
patsRouter.delete('/:id', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const patId = c.req.param('id');
  const serverNow = nowUtc();

  // 验证归属
  const pat = await db
    .prepare(
      'SELECT id FROM personal_access_tokens WHERE id = ? AND user_id = ? AND revoked_at IS NULL'
    )
    .bind(patId, userId)
    .first<{ id: string }>();

  if (!pat) {
    return c.json({ error: 'PAT not found' }, 404);
  }

  await db
    .prepare('UPDATE personal_access_tokens SET revoked_at = ? WHERE id = ?')
    .bind(serverNow, patId)
    .run();

  return c.json({ success: true });
});

export default patsRouter;
