/**
 * 管理员备份路由模�?- 实现 BeeCount Cloud 备份管理接口
 *
 * 参考原�?BeeCount-Cloud (Python/FastAPI) �?/admin/backup 端点�?
 * - GET    /admin/backup/remotes              - 列出备份远程配置
 * - POST   /admin/backup/remotes             - 创建备份远程配置
 * - PATCH  /admin/backup/remotes/:id         - 更新备份远程配置
 * - DELETE /admin/backup/remotes/:id         - 删除备份远程配置
 * - GET    /admin/backup/remotes/:id/reveal - 显示完整配置
 * - POST   /admin/backup/remotes/:id/test   - 测试指定备份远程配置
 * - POST   /admin/backup/remotes/test        - 测试备份远程配置
 *
 * - GET    /admin/backup/schedules           - 列出备份调度
 * - POST   /admin/backup/schedules           - 创建备份调度
 * - PATCH  /admin/backup/schedules/:id       - 更新备份调度
 * - DELETE /admin/backup/schedules/:id       - 删除备份调度
 *
 * - GET    /admin/backup/runs                - 列出备份运行记录
 * - POST   /admin/backup/run-now             - 手动触发备份
 *
 * 功能说明�?
 * - 需要管理员权限
 * - 备份元数据存储在 D1 数据�?
 * - 实际备份文件存储在配置的 S3 远程
 *
 * @module routes/admin_backup
 */

import { Hono } from 'hono';
import { serverLogger } from '../lib/logger';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { getFirstEnabledS3Config } from './sys_config';
import { signS3Request } from '../lib/s3';
import { performBackupFanOut, calculateNextRun, validateCronExpression, resolveAliasRemote, downloadBackupFile } from '../services/backup-executor';
import { insertAuditLog } from '../lib/audit';

/**
 * �?FastAPI 兼容错误格式�?zValidator 包装
 */
function apiValidator<T extends z.ZodTypeAny>(target: 'json' | 'query' | 'form', schema: T) {
  return zValidator(target, schema, (result, c) => {
    if (result.success) return;
    return c.json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        request_id: c.req.header('cf-ray') || '',
      },
      detail: 'Request validation failed',
      validation: result.error.issues.map(i => ({
        loc: ['body', ...i.path.map(p => String(p))],
        msg: i.message,
        type: 'value_error',
      })),
    }, 422);
  });
}

/**
 * 安全解析 config_summary，兼容旧的非 JSON 格式（如 {key:value}�?
 */
function safeParseConfig(summary: string | null | undefined): Record<string, any> {
  if (!summary) return {};
  try {
    return JSON.parse(summary);
  } catch {
    // 兼容旧格式：{key:value,key2:value2} �?{"key":"value","key2":"value2"}
    try {
      const inner = summary.replace(/^\{|\}$/g, '');
      const pairs = inner.split(',');
      const obj: Record<string, string> = {};
      for (const pair of pairs) {
        const colonIdx = pair.indexOf(':');
        if (colonIdx > 0) {
          const key = pair.slice(0, colonIdx).trim();
          const val = pair.slice(colonIdx + 1).trim();
          obj[key] = val;
        }
      }
      return obj;
    } catch {
      return {};
    }
  }
}

// ===========================
// WebDAV 连通性测�?
// ===========================

async function testWebDavConnection(
    url: string,
    username: string,
    password: string
): Promise<{ ok: boolean; message: string }> {
    try {
        if (!url) {
            return { ok: false, message: 'WebDAV URL is required' };
        }
        if (!username || !password) {
            return { ok: false, message: 'Username and password are required' };
        }

        const normalizedUrl = url.replace(/\/+$/, '');
        const auth = 'Basic ' + btoa(`${username}:${password}`);

        serverLogger.info('src.routers.admin', '[Backup WebDAV Test] Testing connection to:', normalizedUrl);

        // PROPFIND to check connectivity
        const propfindResponse = await fetch(normalizedUrl, {
            method: 'PROPFIND',
            headers: {
                'Authorization': auth,
                'Depth': '0',
                'Content-Type': 'application/xml',
            },
        });

        serverLogger.info('src.routers.admin', '[Backup WebDAV Test] PROPFIND Response status:', propfindResponse.status);

        const propfindBody = await propfindResponse.text().catch(() => '');

        if (propfindResponse.status === 401) {
            return { ok: false, message: 'WebDAV authentication failed: invalid username or password' };
        }
        if (propfindResponse.status === 404) {
            return { ok: false, message: `WebDAV path not found: ${normalizedUrl}` };
        }
        if (propfindResponse.status === 403) {
            return { ok: false, message: `WebDAV access denied: ${normalizedUrl}` };
        }
        if (!propfindResponse.ok) {
            return { ok: false, message: `WebDAV connection failed: HTTP ${propfindResponse.status} ${propfindResponse.statusText}` };
        }

        serverLogger.info('src.routers.admin', '[Backup WebDAV Test] PROPFIND test passed');

        // Try writing a test file
        const testPath = `__beecount_connection_test__/${Date.now()}.txt`;
        const testContent = 'Beecount WebDAV connection test file';
        const putUrl = `${normalizedUrl}/${testPath}`;

        const putResponse = await fetch(putUrl, {
            method: 'PUT',
            headers: {
                'Authorization': auth,
                'Content-Type': 'text/plain',
                'Content-Length': String(testContent.length),
            },
            body: testContent,
        });

        serverLogger.info('src.routers.admin', '[Backup WebDAV Test] PUT Response status:', putResponse.status);

        if (!putResponse.ok && putResponse.status !== 405) {
            return { ok: false, message: `WebDAV write test failed: HTTP ${putResponse.status} ${putResponse.statusText}` };
        }

        // Cleanup: DELETE test file
        if (putResponse.ok) {
            await fetch(putUrl, {
                method: 'DELETE',
                headers: { 'Authorization': auth },
            });
            serverLogger.info('src.routers.admin', '[Backup WebDAV Test] Cleanup DELETE sent');
        }

        return { ok: true, message: `WebDAV connection successful: ${normalizedUrl}` };
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        serverLogger.error('src.routers.admin', '[Backup WebDAV Test] Error:', errorMsg);
        if (errorMsg.includes('timeout') || errorMsg.includes('Timeout')) {
            return { ok: false, message: `WebDAV connection timeout: Unable to reach ${url}` };
        }
        return { ok: false, message: `WebDAV connection error: ${errorMsg}` };
    }
}

function nowUtc(): string {
  return new Date().toISOString();
}

/**
 * 解析 schedule 的 remote_ids：优先读 backup_schedule_remotes M2M（对齐原版），
 * 无 M2M 记录时回退解析 remote_ids JSON 列（旧数据兼容）。
 */
async function resolveScheduleRemoteIds(db: D1Database, scheduleId: number | string): Promise<Array<string | number>> {
  const schedIdStr = String(scheduleId);
  const m2m = await db
    .prepare('SELECT remote_id FROM backup_schedule_remotes WHERE schedule_id = ? ORDER BY sort_order ASC')
    .bind(schedIdStr)
    .all<{ remote_id: number }>();
  if (m2m.results.length > 0) {
    return m2m.results.map(r => r.remote_id);
  }
  const sched = await db
    .prepare('SELECT remote_ids FROM backup_schedules WHERE id = ?')
    .bind(schedIdStr)
    .first<{ remote_ids: string }>();
  if (!sched?.remote_ids) return [];
  try {
    const parsed = JSON.parse(sched.remote_ids);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 全量覆盖 schedule 的 remote 关联（对齐原版：先删旧映射再加新）。
 * 兼容旧实现：同步写回 remote_ids JSON 列（存放整型 id 列表）。
 * 前端可能传混型 remote_ids（如 [1, "1"]），统一转字符串并去重，
 * 否则插入 backup_schedule_remotes（PK=schedule_id+remote_id）会主键冲突 500。 */
async function replaceScheduleRemotes(
  db: D1Database,
  scheduleId: number | string,
  remoteIds: Array<string | number>,
) {
  const normalized = Array.from(new Set(remoteIds.map((rid) => String(rid))));
  return db.batch([
    db.prepare('DELETE FROM backup_schedule_remotes WHERE schedule_id = ?').bind(String(scheduleId)),
    ...normalized.map((rid, idx) =>
      db.prepare('INSERT INTO backup_schedule_remotes (schedule_id, remote_id, sort_order) VALUES (?, ?, ?)')
        .bind(String(scheduleId), rid, idx)),
    db.prepare('UPDATE backup_schedules SET remote_ids = ? WHERE id = ?')
      .bind(normalized.length ? JSON.stringify(normalized) : null, String(scheduleId)),
  ]);
}

async function testS3Connection(
    endpoint: string,
    bucket: string,
    accessKey: string,
    secretKey: string,
    region: string,
): Promise<{ ok: boolean; message: string }> {
    try {
        if (!endpoint) {
            return { ok: false, message: 'Endpoint is required' };
        }
        
        if (!bucket) {
            return { ok: false, message: 'Bucket name is required' };
        }
        
        if (!accessKey || !secretKey) {
            return { ok: false, message: 'Access key and secret key are required' };
        }
        
        const cleanBucket = bucket.replace(/^\/+/, '').replace(/\/+$/, '');
        if (!cleanBucket) {
            return { ok: false, message: 'Bucket name cannot be empty or only slashes' };
        }
        
        serverLogger.info('src.routers.admin', '[Backup S3 Test] Testing connection to endpoint:', endpoint);
        serverLogger.info('src.routers.admin', '[Backup S3 Test] Bucket:', cleanBucket);
        serverLogger.info('src.routers.admin', '[Backup S3 Test] Region:', region);
        
        // 首先尝试列出 bucket 中的对象，这是更直接的检测方�?
        const { url: listUrl, headers: listHeaders } = await signS3Request(
            accessKey,
            secretKey,
            region,
            endpoint,
            cleanBucket,
            '',
            'GET'
        );
        
        serverLogger.info('src.routers.admin', '[Backup S3 Test] Testing with LIST to:', listUrl);
        
        const listResponse = await fetch(listUrl, {
            method: 'GET',
            headers: listHeaders
        });
        
        serverLogger.info('src.routers.admin', '[Backup S3 Test] LIST Response status:', listResponse.status);
        serverLogger.info('src.routers.admin', '[Backup S3 Test] LIST Response headers:', Object.fromEntries(listResponse.headers.entries()));
        
        // 读取响应体以获取更多信息
        const listResponseText = await listResponse.text().catch(() => '');
        serverLogger.info('src.routers.admin', '[Backup S3 Test] LIST Response body:', listResponseText);
        
        // 即使状态码�?200，我们也需要验证响应是否真的表示成�?
        // 检查响应体是否包含错误信息
        if (listResponseText.includes('<Error>') || listResponseText.includes('<Code>')) {
            let errorMessage = `S3 connection failed: Response contains error`;
            // 尝试提取错误代码
            const codeMatch = listResponseText.match(/<Code>([^<]+)<\/Code>/);
            if (codeMatch) {
                const errorCode = codeMatch[1];
                errorMessage = `S3 error: ${errorCode}`;
                if (errorCode === 'NoSuchBucket') {
                    errorMessage = `S3 bucket not found: "${cleanBucket}" does not exist at ${endpoint}`;
                } else if (errorCode === 'AccessDenied') {
                    errorMessage = `S3 access denied: Bucket "${cleanBucket}" may not exist or credentials have insufficient permissions`;
                }
            }
            return { ok: false, message: errorMessage };
        }
        
        // 检查响应体是否包含有效�?ListBucketResult（这才是真正的成功）
        if (!listResponseText.includes('<ListBucketResult') && !listResponseText.includes('<?xml')) {
            return { ok: false, message: `S3 bucket verification failed: Invalid response from ${endpoint} for bucket "${cleanBucket}"` };
        }
        
        if (!listResponse.ok) {
            let errorMessage = `S3 connection failed: HTTP ${listResponse.status} ${listResponse.statusText}`;
            if (listResponse.status === 403) {
                errorMessage = `S3 access denied: Bucket "${cleanBucket}" may not exist or credentials have insufficient permissions (HTTP 403)`;
            } else if (listResponse.status === 404) {
                errorMessage = `S3 bucket not found: "${cleanBucket}" does not exist at ${endpoint} (HTTP 404)`;
            }
            // 如果有错误响应体，也添加到错误信息中
            if (listResponseText) {
                errorMessage += ` - ${listResponseText.substring(0, 200)}`;
            }
            return { ok: false, message: errorMessage };
        }
        
        serverLogger.info('src.routers.admin', '[Backup S3 Test] LIST test passed');
        return { ok: true, message: `S3 connection successful: ${cleanBucket} at ${endpoint}` };

    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        serverLogger.error('src.routers.admin', '[Backup S3 Test] Error:', errorMsg);
        if (errorMsg.includes('timeout') || errorMsg.includes('Timeout')) {
            return { ok: false, message: `S3 connection timeout: Unable to reach ${endpoint}` };
        }
        return { ok: false, message: `S3 connection error: ${errorMsg}` };
    }
}

// ===========================
// Schema 定义
// ===========================

const RemoteCreateSchema = z.object({
  name: z.string().min(1).max(64),
  backend_type: z.string().min(1).max(32),
  config: z.record(z.any()),
  encrypted: z.boolean().optional(),
  age_passphrase: z.string().optional().nullable(),
  encryption_password: z.string().optional().nullable(),
});

const RemoteUpdateSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  config: z.record(z.string()).optional(),
  encrypted: z.boolean().optional(),
  age_passphrase: z.string().optional().nullable(),
  encryption_password: z.string().optional().nullable(),
});

const RemoteTestSchema = z.object({
  backend_type: z.string(),
  config: z.record(z.any()),
});

const ScheduleCreateSchema = z.object({
  name: z.string().min(1).max(64),
  cron_expr: z.string().min(1).max(64),
  retention_days: z.number().int().min(1).max(365).optional(),
  enabled: z.boolean().optional(),
  remote_ids: z.array(z.union([z.string(), z.number()])).optional().default([]),
  include_attachments: z.boolean().optional().default(true),
  timezone_offset: z.number().optional(),
});

const ScheduleUpdateSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  cron_expr: z.string().min(1).max(64).optional(),
  retention_days: z.number().int().min(1).max(365).optional(),
  enabled: z.boolean().optional(),
  remote_ids: z.array(z.union([z.string(), z.number()])).optional(),
  include_attachments: z.boolean().optional(),
  timezone_offset: z.number().optional(),
});

const RunNowSchema = z.object({
  ledger_id: z.string(),
  remote_id: z.string().optional(),
});

type Bindings = {
  DB: D1Database;
  JWT_SECRET: string;
  R2: R2Bucket;
  BEECOUNT_DO: DurableObjectNamespace;
  S3_ENDPOINT?: string;
  S3_REGION?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
  S3_BUCKET_NAME?: string;
  CLOUDFLARE_API_TOKEN?: string;
  BACKUP_WORKFLOW: Workflow;
};

type Variables = {
  userId: string;
};

const backupRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// 通过 DO 广播 WebSocket 消息（替�?ws-manager 内存单例�?
async function broadcastViaDO(env: Bindings, userId: string, message: Record<string, unknown>): Promise<void> {
  try {
    const doId = env.BEECOUNT_DO.idFromName(`ws-${userId}`);
    const stub = env.BEECOUNT_DO.get(doId);
    await stub.fetch(new URL('/broadcast', 'http://do'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: JSON.stringify(message) }),
    });
  } catch (err) {
    serverLogger.error('src.routers.admin', '[Backup] DO broadcast failed:', (err as Error).message);
  }
}

// 测试端点 - 首先添加一个简单的测试路由
backupRouter.get('/test', (c) => {
  return c.json({ message: 'adminBackupRouter is working!', time: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// 管理员权限检�?
// ---------------------------------------------------------------------------

backupRouter.use('/*', async (c, next) => {
  const userId = c.get('userId');
  const db = c.env.DB;

  const user = await db
    .prepare('SELECT is_admin FROM users WHERE id = ?')
    .bind(userId)
    .first<{ is_admin: number }>();

  if (!user || !user.is_admin) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  await next();
});

// ---------------------------------------------------------------------------
// 诊断端点
// ---------------------------------------------------------------------------

/**
 * 下载 rclone.conf 文件
 * 生成标准�?rclone 配置文件格式
 */
backupRouter.get('/rclone-config', async (c) => {
  const db = c.env.DB;
  
  try {
    const remotes = await db
      .prepare('SELECT id, name, backend_type, config_summary FROM backup_remotes')
      .all<{ id: number; name: string; backend_type: string; config_summary: string }>();
    
    let configContent = '# BeeCount Cloud rclone configuration\n';
    configContent += '# Auto-generated - do not edit manually\n\n';
    
    let hasRcloneConfig = false;
    
    for (const row of (remotes.results || [])) {
      // R2 使用 Worker 绑定，不使用 rclone，跳�?
      if (row.backend_type === 'r2') continue;
      
      let config: Record<string, string> = {};
      try {
        config = safeParseConfig(row.config_summary);
        // 移除内部字段
        delete config._secrets;
      } catch {}
      
      configContent += `[${row.name}]\n`;
      configContent += `type = ${row.backend_type}\n`;
      
      // 根据 backend_type 生成配置
      if (row.backend_type === 's3') {
        if (config.endpoint) configContent += `endpoint = ${config.endpoint}\n`;
        if (config.access_key_id) configContent += `access_key_id = ${config.access_key_id}\n`;
        if (config.secret_access_key) configContent += `secret_access_key = ${config.secret_access_key}\n`;
        if (config.region) configContent += `region = ${config.region}\n`;
        if (config.bucket) configContent += `bucket = ${config.bucket}\n`;
        configContent += `provider = Cloudflare\n`;
      } else if (row.backend_type === 'b2') {
        // B2 使用 S3 兼容 API
        configContent += `endpoint = ${config.endpoint || 'https://s3.eu-central-003.backblazeb2.com'}\n`;
        if (config.access_key_id) configContent += `access_key_id = ${config.access_key_id}\n`;
        if (config.secret_access_key) configContent += `secret_access_key = ${config.secret_access_key}\n`;
        if (config.bucket) configContent += `bucket = ${config.bucket}\n`;
        configContent += `provider = Backblaze\n`;
      } else if (row.backend_type === 'ftp') {
        if (config.host) configContent += `host = ${config.host}\n`;
        if (config.port) configContent += `port = ${config.port}\n`;
        if (config.username) configContent += `user = ${config.username}\n`;
        if (config.password) configContent += `pass = ${config.password}\n`;
      } else if (row.backend_type === 'sftp') {
        if (config.host) configContent += `host = ${config.host}\n`;
        if (config.port) configContent += `port = ${config.port}\n`;
        if (config.username) configContent += `user = ${config.username}\n`;
        if (config.password) configContent += `pass = ${config.password}\n`;
      } else if (row.backend_type === 'webdav') {
        if (config.url) configContent += `url = ${config.url}\n`;
        if (config.username) configContent += `user = ${config.username}\n`;
        if (config.password) configContent += `pass = ${config.password}\n`;
      }
      
      configContent += '\n';
      hasRcloneConfig = true;
    }
    
    if (!hasRcloneConfig) {
      configContent += '# No rclone-compatible remotes configured.\n';
      configContent += '# R2 backups use Worker binding (no rclone needed).\n';
    }
    
    return new Response(configContent, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': 'attachment; filename="rclone.conf"',
      },
    });
  } catch (error) {
    serverLogger.error('src.routers.admin', '[rclone-config] Error:', error);
    return c.text('# Error generating rclone config\n', 500);
  }
});

// ---------------------------------------------------------------------------

backupRouter.get('/diagnose-s3', async (c) => {
  const db = c.env.DB;
  
  const result: any = {
    timestamp: new Date().toISOString(),
    sys_config: {},
    backup_remotes: {},
    environment: {}
  };
  
  try {
    const settingsResult = await db.prepare(
      'SELECT value FROM settings WHERE key = ?'
    ).bind('manage@sysConfig@upload').first<{ value: string }>();
    
    if (settingsResult && settingsResult.value) {
      const settingsKV = JSON.parse(settingsResult.value);
      result.sys_config.has_upload_config = true;
      result.sys_config.s3_channels = settingsKV.s3?.channels || [];
      result.sys_config.has_enabled_s3 = settingsKV.s3?.channels?.some((ch: any) => ch.enabled) || false;
    } else {
      result.sys_config.has_upload_config = false;
    }
  } catch (err) {
    result.sys_config.error = err instanceof Error ? err.message : 'Unknown error';
  }
  
  try {
    const remoteCount = await db.prepare(
      'SELECT COUNT(*) as count FROM backup_remotes'
    ).first<{ count: number }>();
    
    result.backup_remotes.count = remoteCount?.count || 0;
    
    const remoteConfigs = await db.prepare(
      'SELECT id, name, backend_type, config_summary FROM backup_remotes WHERE backend_type = ?'
    ).bind('s3').all();
    
    result.backup_remotes.s3_remotes = remoteConfigs.results || [];
  } catch (err) {
    result.backup_remotes.error = err instanceof Error ? err.message : 'Unknown error';
  }
  
  result.environment.has_s3_env_vars = !!(c.env.S3_ACCESS_KEY_ID && c.env.S3_BUCKET_NAME);
  result.environment.S3_ACCESS_KEY_ID_set = !!c.env.S3_ACCESS_KEY_ID;
  result.environment.S3_BUCKET_NAME_set = !!c.env.S3_BUCKET_NAME;
  
  return c.json(result);
});

// ---------------------------------------------------------------------------
// 远程配置管理
// ---------------------------------------------------------------------------

/**
 * 列出所有备份远程配�?
 */
backupRouter.get('/remotes', async (c) => {
  const db = c.env.DB;

  try {
    const rows = await db
      .prepare(
        `SELECT id, name, backend_type, config_summary, encrypted, 
               last_test_at, last_test_ok, last_test_error, 
               created_at, updated_at
         FROM backup_remotes
         ORDER BY created_at DESC`
      )
      .all<{
        id: string;
        name: string;
        backend_type: string;
        config_summary: string;
        encrypted: number;
        last_test_at: string | null;
        last_test_ok: number | null;
        last_test_error: string | null;
        created_at: string;
        updated_at: string;
      }>();

    const remotes = (rows.results || []).map((row) => {
      let config: Record<string, string> = {};
      try {
        config = safeParseConfig(row.config_summary);
      } catch {}
      const maskedConfig: Record<string, string> = {};
      for (const [key, value] of Object.entries(config)) {
        if (String(key).toLowerCase().includes('pass') || String(key).toLowerCase().includes('secret')) {
          maskedConfig[key] = value ? '***' : '';
        } else {
          maskedConfig[key] = String(value);
        }
      }

      return {
        id: String(row.id),
        name: row.name,
        backend_type: row.backend_type,
        config: maskedConfig,
        config_summary: maskedConfig,
        encrypted: Boolean(row.encrypted),
        last_test_at: row.last_test_at,
        last_test_ok: row.last_test_ok === null ? null : Boolean(row.last_test_ok),
        last_test_error: row.last_test_error,
        created_at: row.created_at,
        updated_at: row.updated_at,
      };
    });

    return c.json(remotes);
  } catch (error) {
    // 如果查询失败，尝试不查询新字段再试一�?
    try {
      const rows = await db
        .prepare(
          `SELECT id, name, backend_type, config_summary, encrypted, created_at, updated_at
           FROM backup_remotes
           ORDER BY created_at DESC`
        )
        .all<{
          id: string;
          name: string;
          backend_type: string;
          config_summary: string;
          encrypted: number;
          created_at: string;
          updated_at: string;
        }>();

      const remotes = (rows.results || []).map((row) => {
        let config: Record<string, string> = {};
        try {
          config = safeParseConfig(row.config_summary);
        } catch {}
        const maskedConfig: Record<string, string> = {};
        for (const [key, value] of Object.entries(config)) {
          if (String(key).toLowerCase().includes('pass') || String(key).toLowerCase().includes('secret')) {
            maskedConfig[key] = value ? '***' : '';
          } else {
            maskedConfig[key] = String(value);
          }
        }

        return {
          id: String(row.id),
          name: row.name,
          backend_type: row.backend_type,
          config_summary: maskedConfig,
          encrypted: Boolean(row.encrypted),
          last_test_at: null,
          last_test_ok: null,
          last_test_error: null,
          created_at: row.created_at,
          updated_at: row.updated_at,
        };
      });

      return c.json(remotes);
    } catch (fallbackError) {
      serverLogger.error('app', 'Error fetching backup_remotes (fallback also failed):', fallbackError);
      return c.json({ error: String(fallbackError) }, 500);
    }
  }
});

/**
 * 创建备份远程配置
 */
backupRouter.post('/remotes', apiValidator('json', RemoteCreateSchema), async (c) => {
  const db = c.env.DB;
  const req = c.req.valid('json');
  const serverNow = nowUtc();

  const configJson = JSON.stringify({
    ...req.config,
    ...(req.age_passphrase ? { age_passphrase: req.age_passphrase } : {}),
    ...(req.encryption_password ? { encryption_password: req.encryption_password } : {})
  });

  const result = await db
    .prepare(
      `INSERT INTO backup_remotes (name, backend_type, config_summary, encrypted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(
      req.name,
      req.backend_type,
      configJson,
      req.encrypted ? 1 : 0,
      serverNow,
      serverNow
    )
    .run();

  const remoteId = result.meta.last_row_id as number;

  return c.json({
    id: String(remoteId),
    name: req.name,
    backend_type: req.backend_type,
    config: req.config,
    encrypted: req.encrypted ?? false,
    created_at: serverNow,
    updated_at: serverNow,
  }, 201);
});

/**
 * 更新备份远程配置
 */
backupRouter.patch('/remotes/:id', apiValidator('json', RemoteUpdateSchema), async (c) => {
  const db = c.env.DB;
  const remoteId = c.req.param('id');
  const req = c.req.valid('json');
  const serverNow = nowUtc();

  const existing = await db
    .prepare('SELECT id FROM backup_remotes WHERE id = ?')
    .bind(remoteId)
    .first();

  const remote = await db.prepare(`SELECT id, name, backend_type, config_summary, encrypted FROM backup_remotes WHERE id = ?`).bind(remoteId).first<{ id: number; name: string; backend_type: string; config_summary: string; encrypted: number }>();
  if (!remote) return c.json({ error: 'Remote not found' }, 404);

  // 清理旧记录中可能的错误字段（�?R2 类型的多�?bucket�?
  let configToSave: Record<string, string> = {};
  if (req.config !== undefined) {
    configToSave = { ...req.config };
  } else {
    configToSave = safeParseConfig(remote.config_summary);
    // 如果�?R2 类型且含�?bucket 字段，删除它（R2 �?binding 获取�?
    if (remote.backend_type === 'r2' && configToSave.bucket) {
      delete configToSave.bucket;
    }
  }
  
  if (req.age_passphrase != null) {
    configToSave.age_passphrase = req.age_passphrase;
  } else if (remote.backend_type === 'r2') {
    // R2 保留原有�?age_passphrase 不删�?
  }
  
  // 只有�?config 有变化时才更�?config_summary 字段
  const originalConfig = safeParseConfig(remote.config_summary)
  const configHasChanged = JSON.stringify(configToSave) !== JSON.stringify(originalConfig);

  const updates: string[] = ['name = ?', 'updated_at = ?'];
  const params: unknown[] = [req.name || remote.name, serverNow];

  if (configHasChanged) {
    updates.push('config_summary = ?');
    params.push(JSON.stringify(configToSave));
  }

  if (req.encrypted !== undefined) {
    updates.push('encrypted = ?');
    params.push(req.encrypted ? 1 : 0);
  }

  params.push(remoteId);

  await db
    .prepare(`UPDATE backup_remotes SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...params)
    .run();

  const updated = await db
    .prepare(
      `SELECT id, name, backend_type, config_summary, encrypted, created_at, updated_at
       FROM backup_remotes WHERE id = ?`
    )
    .bind(remoteId)
    .first<{
      id: string;
      name: string;
      backend_type: string;
      config_summary: string;
      encrypted: number;
      created_at: string;
      updated_at: string;
    }>();

  return c.json({
    id: updated ? String(updated.id) : '',
    name: updated?.name,
    backend_type: updated?.backend_type,
    config: updated?.config_summary ? safeParseConfig(updated.config_summary) : {},
    encrypted: Boolean(updated?.encrypted),
    created_at: updated?.created_at,
    updated_at: updated?.updated_at,
  });
});

/**
 * 删除备份远程配置
 */
backupRouter.delete('/remotes/:id', async (c) => {
  const db = c.env.DB;
  const remoteId = c.req.param('id');

  const existing = await db
    .prepare('SELECT id FROM backup_remotes WHERE id = ?')
    .bind(remoteId)
    .first();

  if (!existing) {
    return c.json({ error: 'Remote not found' }, 404);
  }

  // 检查是否绑定定时任务（与原版对齐：绑定中的远端不可删除�?
  const boundSchedules = await db
    .prepare(`SELECT id FROM backup_schedules WHERE remote_ids LIKE ?`)
    .bind(`%"${remoteId}"%`)
    .first();
  if (boundSchedules) {
    return c.json({ error: 'Remote is bound to one or more schedules. Remove from schedules first.' }, 409);
  }

  await db.prepare('DELETE FROM backup_remotes WHERE id = ?').bind(remoteId).run();

  return c.json({ success: true });
});

/**
 * 显示备份远程配置完整信息（解密后�?
 */
backupRouter.get('/remotes/:id/reveal', async (c) => {
  const db = c.env.DB;
  const remoteId = c.req.param('id');

  const remote = await db
    .prepare(
      `SELECT id, name, backend_type, config_summary, encrypted, created_at, updated_at
       FROM backup_remotes WHERE id = ?`
    )
    .bind(remoteId)
    .first<{
      id: string;
      name: string;
      backend_type: string;
      config_summary: string;
      encrypted: number;
      created_at: string;
      updated_at: string;
    }>();

  if (!remote) {
    return c.json({ error: 'Remote not found' }, 404);
  }

  const userId = c.get('userId');
  await insertAuditLog({
    db, userId, action: 'backup_remote_reveal', entityType: 'backup_remote',
    details: { remote_id: remoteId, remote_name: remote.name, backend_type: remote.backend_type },
  });

  return c.json({
    id: String(remote.id),
    name: remote.name,
    backend_type: remote.backend_type,
    config: safeParseConfig(remote.config_summary),
    encrypted: Boolean(remote.encrypted),
    created_at: remote.created_at,
    updated_at: remote.updated_at,
  });
});

/**
 * 测试指定备份远程配置连通�?
 */
backupRouter.post('/remotes/:id/test', async (c) => {
  const db = c.env.DB;
  const remoteId = c.req.param('id');

  const remote = await db
    .prepare(
      `SELECT id, name, backend_type, config_summary
       FROM backup_remotes WHERE id = ?`
    )
    .bind(remoteId)
    .first<{
      id: string;
      name: string;
      backend_type: string;
      config_summary: string;
    }>();

  if (!remote) {
    return c.json({ error: 'Remote not found' }, 404);
  }

  const config = safeParseConfig(remote.config_summary);

  try {
    let testResult = {
      ok: false,
      backend_type: remote.backend_type,
      message: '',
    };

    switch (remote.backend_type) {
      case 's3':
        const s3Endpoint = config.endpoint || 'https://s3.amazonaws.com';
        const s3Bucket = config.bucket;
        const s3AccessKey = config.access_key_id;
        const s3SecretKey = config.secret_access_key;
        const s3Region = config.region || 'auto';
        
        if (!s3Bucket) {
          testResult.ok = false;
          testResult.message = 'Bucket name is required';
        } else if (!s3AccessKey || !s3SecretKey) {
          testResult.ok = false;
          testResult.message = 'Access key or secret key is missing';
        } else {
          const result = await testS3Connection(s3Endpoint, s3Bucket, s3AccessKey, s3SecretKey, s3Region);
          testResult.ok = result.ok;
          testResult.message = result.message;
        }
        break;

      case 'b2':
        // Backblaze B2 使用 S3 兼容 API（从 B2 API 获取 S3 端点�?
        const b2Endpoint = config.endpoint || await (async () => {
          try {
            const b2Key = (config.key || config.access_key_id || '').trim();
            const b2AccountId = (config.account || config.secret_access_key || '').trim();
            const auth = btoa(`${b2AccountId}:${b2Key}`);
            const res = await fetch('https://api.backblazeb2.com/b2api/v2/b2_authorize_account', {
              headers: { 'Authorization': `Basic ${auth}` },
            });
            if (res.ok) { const d = await res.json() as { s3ApiUrl?: string }; if (d.s3ApiUrl) return d.s3ApiUrl; }
          } catch {}
          return 'https://s3.eu-central-003.backblazeb2.com';
        })();
        const b2Bucket = config.bucket;
        const b2Key = (config.key || config.access_key_id || '').trim();
        const b2AccountId = (config.account || config.secret_access_key || '').trim();
        // �?endpoint 提取 region（如 s3.us-west-004.backblazeb2.com �?us-west-004�?
        const b2Region = (() => {
          try {
            const hostname = new URL(b2Endpoint).hostname;
            const m = hostname.match(/^s3\.([^.]+)\.backblazeb2\.com$/);
            return m ? m[1] : 'auto';
          } catch { return 'auto'; }
        })();
        
        if (!b2Bucket) {
          testResult.ok = false;
          testResult.message = 'Bucket name is required';
        } else if (!b2Key || !b2AccountId) {
          testResult.ok = false;
          testResult.message = 'Application Key and Account ID are required';
        } else {
          const result = await testS3Connection(b2Endpoint, b2Bucket, b2AccountId, b2Key, b2Region);
          testResult.ok = result.ok;
          testResult.message = result.ok ? 'Backblaze B2 accessible' : result.message;
        }
        break;



      case 'local':
        testResult.ok = true;
        testResult.message = 'Local backend configured (requires filesystem support)';
        break;

      case 'webdav':
        const webdavUrl = config.url;
        const webdavUsername = config.username || config.user;
        const webdavPassword = config.password || config.pass;
        
        if (!webdavUrl) {
          testResult.ok = false;
          testResult.message = 'WebDAV URL is required';
        } else if (!webdavUsername || !webdavPassword) {
          testResult.ok = false;
          testResult.message = 'WebDAV username and password are required';
        } else {
          const webdavResult = await testWebDavConnection(webdavUrl, webdavUsername, webdavPassword);
          testResult.ok = webdavResult.ok;
          testResult.message = webdavResult.message;
        }
        break;

      case 'ftp':
        const ftpHost = config.host || config.hostname;
        const ftpPort = parseInt(config.port || '21', 10);
        const ftpUsername = config.username || config.user;
        const ftpPassword = config.password || config.pass;

        if (!ftpHost) {
          testResult.ok = false;
          testResult.message = 'FTP host is required';
        } else if (!ftpUsername || !ftpPassword) {
          testResult.ok = false;
          testResult.message = 'FTP username and password are required';
        } else {
          const { createFtpClient } = await import('../lib/ftp');
          const ftpClient = createFtpClient({ host: ftpHost, port: ftpPort, username: ftpUsername, password: ftpPassword });
          const ftpResult = await ftpClient.test();
          testResult.ok = ftpResult.success;
          testResult.message = ftpResult.message;
        }
        break;

      case 'r2':
        if (!c.env.R2) {
          testResult.ok = false;
          testResult.message = 'R2 bucket not configured in Worker bindings';
        } else {
          try {
            // 测试 bucket 是否可访�?- 尝试列出对象
            const testKey = `__connection_test__/${Date.now()}.txt`;
            const testContent = 'BeeCount R2 connection test';
            
            // 写入测试文件
            await c.env.R2.put(testKey, testContent, {
              httpMetadata: { contentType: 'text/plain' }
            });
            
            // 读取测试文件验证
            const obj = await c.env.R2.get(testKey);
            if (!obj) {
              throw new Error('Failed to read back test file');
            }
            
            // 删除测试文件
            await c.env.R2.delete(testKey);
            
            testResult.ok = true;
            testResult.message = `R2 bucket accessible and writable. Test file: ${testKey}`;
          } catch (e) {
            testResult.ok = false;
            testResult.message = `R2 test failed: ${(e as Error).message}. Check bucket name and permissions.`;
          }
        }
        break;

      case 'sftp':
        const sftpHost = config.host || config.hostname;
        const sftpPort = parseInt(config.port || '22', 10);
        const sftpUsername = config.username || config.user;
        const sftpPassword = config.password || config.pass;

        if (!sftpHost) {
          testResult.ok = false;
          testResult.message = 'SFTP host is required';
        } else if (!sftpUsername) {
          testResult.ok = false;
          testResult.message = 'SFTP username is required';
        } else {
          const { createSftpClient } = await import('../lib/sftp');
          const sftpClient = createSftpClient({ host: sftpHost, port: sftpPort, username: sftpUsername, password: sftpPassword });
          const sftpResult = await sftpClient.test();
          testResult.ok = sftpResult.success;
          testResult.message = sftpResult.message;
        }
        break;

      case 'drive':
      case 'onedrive':
      case 'dropbox':
        if (!config.client_id || !config.client_secret) {
          testResult.ok = false;
          testResult.message = 'OAuth2 configuration incomplete (client_id, client_secret required)';
        } else if (!config.token) {
          testResult.ok = false;
          testResult.message = 'OAuth2 configuration incomplete (token required)';
        } else {
          testResult.ok = true;
          testResult.message = `${remote.backend_type} configured (OAuth2 token valid)`;
        }
        break;

      case 'alias':
        testResult.message = 'Alias resolved via target remote';
        testResult.ok = true;
        break;

      default:
        testResult.message = `Unknown backend type: ${remote.backend_type}`;
    }

    // 更新数据库中的测试状�?
    const now = new Date().toISOString();
    try {
      await db
        .prepare(
          `UPDATE backup_remotes 
           SET last_test_at = ?, 
               last_test_ok = ?, 
               last_test_error = ?,
               updated_at = ?
           WHERE id = ?`
        )
        .bind(
          now,
          testResult.ok ? 1 : 0,
          testResult.ok ? null : testResult.message,
          now,
          remoteId
        )
        .run();
    } catch (dbError) {
      // 忽略数据库更新错误，可能是字段还不存�?
      serverLogger.info('app', 'Could not update backup_remotes test status (table may not have the new columns yet)', dbError);
    }

    return c.json(testResult);
  } catch (error) {
    return c.json({
      ok: false,
      backend_type: remote.backend_type,
      message: error instanceof Error ? error.message : 'Unknown error',
    }, 500);
  }
});

/**
 * 测试备份远程配置连通�?
 */
backupRouter.post('/remotes/test', apiValidator('json', RemoteTestSchema), async (c) => {
  const req = c.req.valid('json');
  const backendType = req.backend_type;
  const config = req.config;

  try {
    let testResult = {
      ok: false,
      backend_type: backendType,
      message: '',
    };

    switch (backendType) {
      case 's3':
        const s3Endpoint = config.endpoint || 'https://s3.amazonaws.com';
        const s3Bucket = config.bucket;
        const s3AccessKey = config.access_key_id;
        const s3SecretKey = config.secret_access_key;
        const s3Region = config.region || 'auto';
        
        if (!s3Bucket) {
          testResult.ok = false;
          testResult.message = 'Bucket name is required';
        } else if (!s3AccessKey || !s3SecretKey) {
          testResult.ok = false;
          testResult.message = 'Access key or secret key is missing';
        } else {
          const result = await testS3Connection(s3Endpoint, s3Bucket, s3AccessKey, s3SecretKey, s3Region);
          testResult.ok = result.ok;
          testResult.message = result.message;
        }
        break;

      case 'local':
        testResult.ok = true;
        testResult.message = 'Local backend configured (requires filesystem support)';
        break;

      case 'webdav':
        const webdavUrl = config.url;
        const webdavUsername = config.username || config.user;
        const webdavPassword = config.password || config.pass;
        
        if (!webdavUrl) {
          testResult.ok = false;
          testResult.message = 'WebDAV URL is required';
        } else if (!webdavUsername || !webdavPassword) {
          testResult.ok = false;
          testResult.message = 'WebDAV username and password are required';
        } else {
          const webdavResult = await testWebDavConnection(webdavUrl, webdavUsername, webdavPassword);
          testResult.ok = webdavResult.ok;
          testResult.message = webdavResult.message;
        }
        break;

      default:
        testResult.message = `Unknown backend type: ${backendType}`;
    }

    return c.json(testResult);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Test failed';
    return c.json({
      ok: false,
      backend_type: backendType,
      message: errorMsg,
    });
  }
});

// ---------------------------------------------------------------------------
// 调度管理
// ---------------------------------------------------------------------------

/**
 * 列出所有备份调�?
 */
backupRouter.get('/schedules', async (c) => {
  const db = c.env.DB;

  let rows;
  try {
    // 先尝试查询带所有新字段的版�?
    rows = await db
      .prepare(
        `SELECT s.id, s.name, s.cron_expr, s.remote_ids,
                s.retention_days, s.include_attachments, s.enabled, s.created_at, s.updated_at,
                s.next_run_at, s.last_run_at, s.last_run_status, s.timezone_offset
         FROM backup_schedules s
         ORDER BY s.created_at DESC`
      )
      .all<{
        id: string;
        name: string;
        user_id: string;
        cron_expr: string;
        remote_ids: string;
        retention_days: number | null;
        include_attachments: number;
        enabled: number;
        created_at: string;
        updated_at: string;
        next_run_at: string | null;
        last_run_at: string | null;
        last_run_status: string | null;
        timezone_offset?: number;
      }>();
  } catch (error) {
    // 如果失败，回退到查询旧字段版本
    serverLogger.info('src.routers.admin', '[Backup] Falling back to query without timezone_offset');
    rows = await db
      .prepare(
        `SELECT s.id, s.name, s.cron_expr, s.remote_ids,
                s.retention_days, s.include_attachments, s.enabled, s.created_at, s.updated_at
         FROM backup_schedules s
         ORDER BY s.created_at DESC`
      )
      .all<{
        id: string;
        name: string;
        user_id: string;
        cron_expr: string;
        remote_ids: string;
        retention_days: number | null;
        include_attachments: number;
        enabled: number;
        created_at: string;
        updated_at: string;
      }>();
  }

  // 批量预取所有 schedule 的 M2M remote 映射（对齐原版 _build_schedule_out）
  const scheduleIds = rows.results.map(r => String(r.id));
  const m2mBySchedule = new Map<string, Array<string | number>>();
  if (scheduleIds.length > 0) {
    const placeholders = scheduleIds.map(() => '?').join(',');
    const m2m = await db
      .prepare(`SELECT schedule_id, remote_id FROM backup_schedule_remotes WHERE schedule_id IN (${placeholders}) ORDER BY sort_order ASC`)
      .bind(...scheduleIds)
      .all<{ schedule_id: number; remote_id: number }>();
    for (const row of m2m.results) {
      const sid = String(row.schedule_id);
      if (!m2mBySchedule.has(sid)) m2mBySchedule.set(sid, []);
      m2mBySchedule.get(sid)!.push(row.remote_id);
    }
  }

  const schedules = rows.results.map((row) => {
    // M2M 优先，回退 remote_ids JSON 列（旧数据兼容）
    const m2mIds = m2mBySchedule.get(String(row.id));
    let parsedRemoteIds: (string | number)[] = [];
    if (m2mIds) {
      parsedRemoteIds = m2mIds;
    } else if (row.remote_ids) {
      try {
        parsedRemoteIds = JSON.parse(row.remote_ids);
      } catch {}
    }
    return {
      id: String(row.id),
      name: row.name,
      cron_expr: row.cron_expr,
      retention_days: row.retention_days ?? 30,
      include_attachments: Boolean(row.include_attachments),
      enabled: Boolean(row.enabled),
      timezone_offset: (row as any).timezone_offset ?? 0,
      next_run_at: (row as any).next_run_at,
      last_run_at: (row as any).last_run_at,
      last_run_status: (row as any).last_run_status,
      remote_ids: parsedRemoteIds,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  });

  return c.json(schedules);
});

/**
 * 创建备份调度
 */
backupRouter.post('/schedules', apiValidator('json', ScheduleCreateSchema), async (c) => {
  const db = c.env.DB;
  const req = c.req.valid('json');
  const serverNow = nowUtc();
  const userId = c.get('userId');
  
  // 获取时区偏移：优先使用请求中的值，否则从系统设置获�?
  let timezoneOffset = req.timezone_offset;
  if (timezoneOffset === undefined || timezoneOffset === null) {
    try {
      const sysSetting = await db.prepare('SELECT timezone_offset FROM system_settings WHERE id = ?')
        .bind('default').first<{ timezone_offset: number }>();
      if (sysSetting) {
        timezoneOffset = sysSetting.timezone_offset;
        serverLogger.info('src.routers.admin', `[Backup] Using timezone from system_settings: ${timezoneOffset}`);
      }
    } catch (e) {
      // 表可能不存在，忽�?
    }
  }
  
  // 验证 cron 表达式（与原�?CronTrigger 对齐�?
  const cronCheck = validateCronExpression(req.cron_expr);
  if (!cronCheck.valid) {
    return c.json({ error: cronCheck.error }, 400);
  }

  // 计算首次运行时间（使用时区偏移）
  const nextRunAt = calculateNextRun(req.cron_expr, timezoneOffset ?? 0);

  const remoteIdsJson = req.remote_ids && req.remote_ids.length > 0 ? JSON.stringify(req.remote_ids) : null;

  // 先尝试插入带 timezone_offset 的版�?
  let insertResult;
  try {
    insertResult = await db
      .prepare(
        `INSERT INTO backup_schedules
         (name, user_id, cron_expr, retention_days, include_attachments, enabled, remote_ids, timezone_offset, next_run_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        req.name,
        userId,
        req.cron_expr,
        req.retention_days ?? 30,
        req.include_attachments !== false ? 1 : 0,
        req.enabled !== false ? 1 : 0,
        remoteIdsJson,
        timezoneOffset ?? 0,
        nextRunAt,
        serverNow,
        serverNow
      )
      .run();
  } catch (error) {
    // 如果失败，尝试不�?timezone_offset 的版�?
    serverLogger.info('src.routers.admin', '[Backup] Creating schedule without timezone_offset:', error);
    insertResult = await db
      .prepare(
        `INSERT INTO backup_schedules
         (name, user_id, cron_expr, retention_days, include_attachments, enabled, remote_ids, next_run_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        req.name,
        userId,
        req.cron_expr,
        req.retention_days ?? 30,
        req.include_attachments !== false ? 1 : 0,
        req.enabled !== false ? 1 : 0,
        remoteIdsJson,
        nextRunAt,
        serverNow,
        serverNow
      )
      .run();
  }

  const scheduleId = (insertResult as any).lastRowId;

  // schedule ↔ remote 多对多（对齐原版 BackupScheduleRemote）
  if (req.remote_ids && req.remote_ids.length > 0) {
    await replaceScheduleRemotes(db, scheduleId, req.remote_ids);
  }

  return c.json({
    id: scheduleId,
    name: req.name,
    cron_expr: req.cron_expr,
    retention_days: req.retention_days ?? 30,
    include_attachments: req.include_attachments ?? true,
    enabled: req.enabled ?? true,
    timezone_offset: req.timezone_offset ?? 0,
    next_run_at: nextRunAt,
    last_run_at: null,
    last_run_status: null,
    remote_ids: req.remote_ids,
    created_at: serverNow,
  }, 201);
});

/**
 * 计算下次运行时间
 * Cron 表达式格�? 分钟 小时 日期 月份 星期
 * @param cronExpr cron表达�?
 * @param timezoneOffset 用户时区偏移（分钟，东八区为-480�?
 */
// calculateNextRun 已提取到 src/services/backup-executor.ts

/**
 * 更新备份调度
 */
backupRouter.patch('/schedules/:id', apiValidator('json', ScheduleUpdateSchema), async (c) => {
  const db = c.env.DB;
  const scheduleId = c.req.param('id');
  const req = c.req.valid('json');
  const serverNow = nowUtc();

  const existing = await db
    .prepare('SELECT id FROM backup_schedules WHERE id = ?')
    .bind(scheduleId)
    .first();

  if (!existing) {
    return c.json({ error: 'Schedule not found' }, 404);
  }

  // 解析时区偏移（对齐原版：优先使用前端传的，否则从 system_settings 读取�?
  let timezoneOffset = req.timezone_offset;
  if (timezoneOffset === undefined || timezoneOffset === null) {
    try {
      const sysSetting = await db
        .prepare('SELECT timezone_offset FROM system_settings WHERE id = ?')
        .bind('default')
        .first<{ timezone_offset: number }>();
      if (sysSetting) {
        timezoneOffset = sysSetting.timezone_offset;
      }
    } catch { /* ignore */ }
  }

  const updates: string[] = ['updated_at = ?'];
  const params: (string | number | null)[] = [serverNow];

  if (req.name !== undefined) {
    updates.push('name = ?');
    params.push(req.name);
  }

  if (req.remote_ids !== undefined) {
    // M2M 全量覆盖（对齐原版）；helper 内部会同步写 remote_ids JSON 列兼容旧数据
    await replaceScheduleRemotes(db, scheduleId, req.remote_ids);
  }

  if (req.cron_expr !== undefined) {
    const cronCheck = validateCronExpression(req.cron_expr);
    if (!cronCheck.valid) {
      return c.json({ error: cronCheck.error }, 400);
    }
    updates.push('cron_expr = ?');
    params.push(req.cron_expr);
    // 更新 cron 表达式时重新计算下次运行时间（使用时区偏移）
    const nextRunAt = calculateNextRun(req.cron_expr, timezoneOffset ?? 0);
    updates.push('next_run_at = ?');
    params.push(nextRunAt);
  }

  if (req.timezone_offset !== undefined) {
    updates.push('timezone_offset = ?');
    params.push(req.timezone_offset);
  }

  if (req.retention_days !== undefined) {
    updates.push('retention_days = ?');
    params.push(req.retention_days);
  }

  if (req.include_attachments !== undefined) {
    updates.push('include_attachments = ?');
    params.push(req.include_attachments ? 1 : 0);
  }

  if (req.enabled !== undefined) {
    updates.push('enabled = ?');
    params.push(req.enabled ? 1 : 0);
    // 如果启用了，也重新计算下次运行时�?
    if (req.enabled) {
      const existingSchedule = await db
        .prepare('SELECT cron_expr FROM backup_schedules WHERE id = ?')
        .bind(scheduleId)
        .first<{ cron_expr: string }>();
      
      if (existingSchedule) {
        const cronToUse = req.cron_expr || existingSchedule.cron_expr;
        const nextRunAt = calculateNextRun(cronToUse, timezoneOffset ?? 0);
        updates.push('next_run_at = ?');
        params.push(nextRunAt);
      }
    }
  }

  params.push(scheduleId);

  // 尝试执行更新，如�?timezone_offset 不存在则移除它再重试
  try {
    await db
      .prepare(`UPDATE backup_schedules SET ${updates.join(', ')} WHERE id = ?`)
      .bind(...params)
      .run();
  } catch (error) {
    // 如果错误是关�?timezone_offset 列不存在，则移除该字段重�?
    const errorStr = String(error);
    if (errorStr.includes('timezone_offset') && req.timezone_offset !== undefined) {
      serverLogger.info('src.routers.admin', '[Backup] Retrying update without timezone_offset');
      // 移除 timezone_offset 相关的更�?
      const filteredUpdates = updates.filter(u => !u.includes('timezone_offset'));
      const filteredParams = params.filter((_, i) => i < params.length - 1);
      filteredParams.push(scheduleId);
      
      await db
        .prepare(`UPDATE backup_schedules SET ${filteredUpdates.join(', ')} WHERE id = ?`)
        .bind(...filteredParams)
        .run();
    } else {
      throw error;
    }
  }

  return c.json({ success: true });
});

/**
 * 删除备份调度
 */
backupRouter.delete('/schedules/:id', async (c) => {
  const db = c.env.DB;
  const scheduleId = c.req.param('id');

  const existing = await db
    .prepare('SELECT id FROM backup_schedules WHERE id = ?')
    .bind(scheduleId)
    .first();

  if (!existing) {
    return c.json({ error: 'Schedule not found' }, 404);
  }

  // 清理 M2M 关联（对齐原版：显式删除 schedule_remotes 行）
  await db.prepare('DELETE FROM backup_schedule_remotes WHERE schedule_id = ?').bind(scheduleId).run();
  await db.prepare('DELETE FROM backup_schedules WHERE id = ?').bind(scheduleId).run();

  return c.json({ success: true });
});

/**
 * 手动触发备份调度运行
 */
backupRouter.post('/schedules/:id/run-now', async (c) => {
  const db = c.env.DB;
  const scheduleId = c.req.param('id');
  const serverNow = nowUtc();

  const schedule = await db
    .prepare('SELECT id, name, user_id, retention_days FROM backup_schedules WHERE id = ?')
    .bind(scheduleId)
    .first<{ id: number; name: string; user_id: string; retention_days: number | null }>();

  if (!schedule) {
    return c.json({ error: 'Schedule not found' }, 404);
  }

  const ledger = await db
    .prepare('SELECT id FROM ledgers WHERE user_id = ? LIMIT 1')
    .bind(schedule.user_id)
    .first<{ id: string }>();

  const ledgerId = ledger?.id || null;

  let remoteConfigs: Array<{ remoteId: string; config: Record<string, string> }> = [];
  let shouldEncrypt = false;

  // remote_ids 优先从 M2M 表读（对齐原版），回退 remote_ids JSON 列
  const remoteIds = await resolveScheduleRemoteIds(db, schedule.id);
  for (const rid of remoteIds) {
    const strRid = String(rid);
    const remote = await db
      .prepare('SELECT backend_type, config_summary, encrypted FROM backup_remotes WHERE id = ?')
      .bind(strRid)
      .first<{ backend_type: string; config_summary: string; encrypted: number }>();

    if (remote) {
      const parsedConfig = safeParseConfig(remote.config_summary);
      // 补充 R2 Bucket 绑定
      if (remote.backend_type === 'r2' && c.env.R2) {
        parsedConfig._r2Bucket = c.env.R2;
      }
      remoteConfigs.push({ remoteId: strRid, config: { backend_type: remote.backend_type, ...parsedConfig } });
      if (remote.encrypted === 1) shouldEncrypt = true;
    }
  }

  // 兜底：无远端配置时尝�?sys_config S3
  if (remoteConfigs.length === 0) {
    try {
      const sysConfig = await getFirstEnabledS3Config(db, c.env);
      if (sysConfig && sysConfig.bucketName) {
        remoteConfigs.push({
          remoteId: 'sys_config',
          config: {
            backend_type: 's3',
            endpoint: sysConfig.endpoint || 'https://s3.amazonaws.com',
            bucket: sysConfig.bucketName,
            access_key_id: sysConfig.accessKeyId,
            secret_access_key: sysConfig.secretAccessKey,
            region: sysConfig.region || 'auto',
            savePath: sysConfig.savePath,
          }
        });
      }
    } catch {}
  }

  const remoteId = remoteConfigs[0]?.remoteId || null;

  const runInsertResult = await db
    .prepare(
      `INSERT INTO backup_runs (user_id, ledger_id, remote_id, status, started_at)
       VALUES (?, ?, ?, 'running', ?)`
    )
    .bind(schedule.user_id, ledgerId || '', remoteId, serverNow)
    .run();

  const runId = runInsertResult.meta.last_row_id as number;

  // 原版不广�?running 状态，只在备份完成时广播最终状�?

  // 后台执行备份（模仿原�?threading.Thread�?
  // 通过 Workflow 后台执行备份（无 30s 超时限制；_r2Bucket 实例不可序列化，剔除后由 Workflow 重建）
  if (c.env.BACKUP_WORKFLOW) {
    try {
      await c.env.BACKUP_WORKFLOW.create({
        params: {
          runId,
          userId: schedule.user_id,
          ledgerId: ledgerId || 'global',
          remoteConfigs: remoteConfigs.map(({ remoteId, config }) => {
            const { _r2Bucket, ...rest } = config;
            return { remoteId, config: rest };
          }),
          shouldEncrypt,
          retentionDays: schedule.retention_days ?? undefined,
          scheduleId: schedule.id,
          serverNow,
        },
      });
    } catch (wfErr) {
      serverLogger.error('src.routers.admin', '[Backup] Failed to start backup workflow:', (wfErr as Error).message);
      await db.prepare('UPDATE backup_runs SET status = ?, finished_at = ?, error_message = ? WHERE id = ?')
        .bind('failed', new Date().toISOString(), (wfErr as Error).message, runId).run();
    }
  } else {
    c.executionCtx.waitUntil((async () => {
      const logLines: string[] = [];
      const logFn = (msg: string) => { logLines.push(`[${new Date().toISOString()}] ${msg}`); };
      try {
        const backupResult = await performBackupFanOut(db, runId, schedule.user_id, ledgerId || 'global', remoteConfigs, shouldEncrypt, c.env.R2, logFn, schedule.retention_days ?? undefined, (phase) => {
          broadcastViaDO(c.env, schedule.user_id, { type: 'backup_progress', phase, runId }).catch(() => {});
        }, { scheduleId: schedule.id, scheduleName: schedule.name ?? null });
        const finishedAt = new Date().toISOString();
        const finalStatus = backupResult.success ? 'succeeded' : 'failed';
        await db.prepare(
          'UPDATE backup_runs SET status = ?, finished_at = ?, bytes_total = ?, backup_filename = ?, backup_path = ?, error_message = ?, log_text = ? WHERE id = ?'
        ).bind(finalStatus, finishedAt, backupResult.backupSize || null,
              backupResult.backupPath?.split('/').pop() || null, backupResult.backupPath || null,
              backupResult.success ? null : backupResult.message, logLines.join('\n'), runId).run();
        await broadcastViaDO(c.env, schedule.user_id, { type: 'backup_status', scheduleId: schedule.id, status: finalStatus, runId });
      } catch (err) {
        const finishedAt = new Date().toISOString();
        await db.prepare('UPDATE backup_runs SET status = ?, finished_at = ?, error_message = ?, log_text = ? WHERE id = ?')
          .bind('failed', finishedAt, (err as Error).message, logLines.join('\n'), runId).run();
        await broadcastViaDO(c.env, schedule.user_id, { type: 'backup_status', status: 'failed', runId });
      }
    })());
  }

  // 立即返回 running 状态（与原�?202 模式一致）
  return c.json({
    id: runId,
    schedule_id: Number(scheduleId),
    schedule_name: schedule.name,
    status: 'running',
    started_at: serverNow,
    finished_at: null,
    backup_filename: null,
    bytes_total: null,
    error_message: null,
    log_text: null,
    targets: [],
    message: 'Backup started',
  }, 202);
});

// ---------------------------------------------------------------------------
// 备份运行管理
// ---------------------------------------------------------------------------

/**
 * 列出备份运行记录
 */
backupRouter.get('/runs', async (c) => {
  const db = c.env.DB;
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 100);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);

  const rows = await db
    .prepare(
      `SELECT r.id, r.schedule_id, r.status,
              r.started_at, r.finished_at, r.error_message, r.log_text, r.bytes_total,
              r.backup_filename, s.name as schedule_name
       FROM backup_runs r
       LEFT JOIN backup_schedules s ON r.schedule_id = s.id
       ORDER BY r.started_at DESC
       LIMIT ? OFFSET ?`
    )
    .bind(limit, offset)
    .all<{
      id: number;
      schedule_id: number | null;
      status: string;
      started_at: string;
      finished_at: string | null;
      error_message: string | null;
      log_text: string | null;
      bytes_total: number | null;
      backup_filename: string | null;
      schedule_name: string | null;
    }>();

  const totalRow = await db.prepare('SELECT COUNT(*) as cnt FROM backup_runs').first<{ cnt: number }>();

  // 批量获取所�?targets（避�?N+1 查询�?
  const runIds = rows.results.map(r => r.id);
  let allTargets: any[] = [];
  if (runIds.length > 0) {
    try {
      const placeholders = runIds.map(() => '?').join(',');
      const targetResult = await db.prepare(
        `SELECT t.id, t.run_id, t.remote_id, t.status, t.started_at, t.finished_at, t.bytes_transferred, t.error_message,
                r.name as remote_name
         FROM backup_run_targets t
         LEFT JOIN backup_remotes r ON t.remote_id = r.id
         WHERE t.run_id IN (${placeholders})`
      ).bind(...runIds).all();
      allTargets = targetResult.results || [];
    } catch (e) {
      serverLogger.error('src.routers.admin', '[Backup] Failed to query backup_run_targets:', (e as Error).message);
    }
  }

  // �?run_id 分组 targets
  const targetsByRun: Record<number, any[]> = {};
  for (const t of allTargets) {
    const runId = t.run_id;
    if (!targetsByRun[runId]) targetsByRun[runId] = [];
    targetsByRun[runId].push(t);
  }

  // 构建 runs 列表
  const runs = rows.results.map(row => ({
      id: String(row.id),
      schedule_id: row.schedule_id ? String(row.schedule_id) : null,
      schedule_name: row.schedule_name || null,
      status: row.status,
      started_at: row.started_at,
      finished_at: row.finished_at,
      backup_filename: row.backup_filename,
      bytes_total: row.bytes_total,
      error_message: row.error_message,
      log_text: row.log_text,
      targets: targetsByRun[row.id] || [],
    }));

  return c.json({
    total: totalRow?.cnt ?? 0,
    items: runs,
  });
});

/**
 * 手动触发备份
 */
backupRouter.post('/run-now', apiValidator('json', RunNowSchema), async (c) => {
  const db = c.env.DB;
  const userId = c.get('userId');
  const req = c.req.valid('json');
  const serverNow = nowUtc();

  const ledger = await db
    .prepare('SELECT id, external_id FROM ledgers WHERE external_id = ?')
    .bind(req.ledger_id)
    .first<{ id: string; external_id: string }>();

  if (!ledger) {
    return c.json({ error: 'Ledger not found' }, 404);
  }

  // 加载远端配置（支持指�?remote_id 或所有已配置远端�?
  const remoteConfigs: Array<{ remoteId: string; config: Record<string, string> }> = [];
  if (req.remote_id) {
    const remote = await db
      .prepare('SELECT backend_type, config_summary, encrypted FROM backup_remotes WHERE id = ?')
      .bind(req.remote_id)
      .first<{ backend_type: string; config_summary: string; encrypted: number }>();
    if (remote) {
      const parsedConfig = safeParseConfig(remote.config_summary);
      if (remote.backend_type === 'r2' && c.env.R2) parsedConfig._r2Bucket = c.env.R2;
      remoteConfigs.push({ remoteId: req.remote_id, config: { backend_type: remote.backend_type, ...parsedConfig, _encrypted: String(remote.encrypted) } });
    }
  } else {
    // 无指定远端时加载所有远�?
    const allRemotes = await db
      .prepare('SELECT id, backend_type, config_summary, encrypted FROM backup_remotes')
      .all<{ id: string; backend_type: string; config_summary: string; encrypted: number }>();
    for (const remote of allRemotes.results || []) {
      const parsedConfig = safeParseConfig(remote.config_summary);
      if (remote.backend_type === 'r2' && c.env.R2) parsedConfig._r2Bucket = c.env.R2;
      remoteConfigs.push({ remoteId: remote.id, config: { backend_type: remote.backend_type, ...parsedConfig, _encrypted: String(remote.encrypted) } });
    }
  }

  const shouldEncrypt = remoteConfigs.some(rc => parseInt(rc.config._encrypted as string) === 1);
  const remoteId = remoteConfigs[0]?.remoteId || null;

  const runInsertResult = await db
    .prepare(
      `INSERT INTO backup_runs (user_id, ledger_id, remote_id, status, started_at)
       VALUES (?, ?, ?, 'running', ?)`
    )
    .bind(userId, ledger.id, remoteId, serverNow)
    .run();

  const runId = runInsertResult.meta.last_row_id as number;

  // 后台执行备份
  // 通过 Workflow 后台执行备份（无 30s 超时限制；_r2Bucket 实例不可序列化，剔除后由 Workflow 重建）
  if (c.env.BACKUP_WORKFLOW) {
    try {
      await c.env.BACKUP_WORKFLOW.create({
        params: {
          runId,
          userId,
          ledgerId: ledger.id,
          remoteConfigs: remoteConfigs.map(({ remoteId, config }) => {
            const { _r2Bucket, ...rest } = config;
            return { remoteId, config: rest };
          }),
          shouldEncrypt,
          retentionDays: undefined,
          scheduleId: null,
          serverNow,
        },
      });
    } catch (wfErr) {
      serverLogger.error('src.routers.admin', '[Backup] Failed to start backup workflow:', (wfErr as Error).message);
      await db.prepare('UPDATE backup_runs SET status = ?, finished_at = ?, error_message = ? WHERE id = ?')
        .bind('failed', new Date().toISOString(), (wfErr as Error).message, runId).run();
    }
  } else {
    c.executionCtx.waitUntil((async () => {
      const logLines: string[] = [];
      const logFn = (msg: string) => { logLines.push(`[${new Date().toISOString()}] ${msg}`); };
      try {
        const backupResult = await performBackupFanOut(db, runId, userId, ledger.id, remoteConfigs, shouldEncrypt, c.env.R2, logFn, undefined, (phase) => {
          broadcastViaDO(c.env, userId, { type: 'backup_progress', phase, runId }).catch(() => {});
        });
        const finishedAt = new Date().toISOString();
        const finalStatus = backupResult.success ? 'succeeded' : 'failed';
        await db.prepare(
          'UPDATE backup_runs SET status = ?, finished_at = ?, bytes_total = ?, backup_filename = ?, backup_path = ?, error_message = ?, log_text = ? WHERE id = ?'
        ).bind(finalStatus, finishedAt, backupResult.backupSize || null,
              backupResult.backupPath?.split('/').pop() || null, backupResult.backupPath || null,
              backupResult.success ? null : backupResult.message, logLines.join('\n'), runId).run();
        await broadcastViaDO(c.env, userId, { type: 'backup_status', status: finalStatus, runId });
      } catch (err) {
        const finishedAt = new Date().toISOString();
        await db.prepare('UPDATE backup_runs SET status = ?, finished_at = ?, error_message = ?, log_text = ? WHERE id = ?')
          .bind('failed', finishedAt, (err as Error).message, logLines.join('\n'), runId).run();
        await broadcastViaDO(c.env, userId, { type: 'backup_status', status: 'failed', runId });
      }
    })());
  }

  return c.json({
    id: runId,
    ledger_id: req.ledger_id,
    remote_id: remoteId,
    status: 'running',
    started_at: serverNow,
    message: 'Backup started.',
  }, 202);
});

/**
 * 获取备份运行状�?
 */
backupRouter.get('/runs/:id', async (c) => {
  const db = c.env.DB;
  const runId = c.req.param('id');

  const row = await db
    .prepare(
      `SELECT r.id, r.schedule_id, r.status,
              r.started_at, r.finished_at, r.error_message, r.bytes_total,
              r.backup_filename
       FROM backup_runs r
       WHERE r.id = ?`
    )
    .bind(runId)
    .first<{
      id: number;
      schedule_id: number | null;
      status: string;
      started_at: string;
      finished_at: string | null;
      error_message: string | null;
      bytes_total: number | null;
      backup_filename: string | null;
    }>();

  if (!row) {
    return c.json({ error: 'Run not found' }, 404);
  }

  return c.json({
    id: String(row.id),
    schedule_id: row.schedule_id ? String(row.schedule_id) : null,
    schedule_name: null,
    status: row.status,
    started_at: row.started_at,
    finished_at: row.finished_at,
    backup_filename: row.backup_filename,
    bytes_total: row.bytes_total,
    error_message: row.error_message,
    log_text: null,
    targets: [],
  });
});

/**
 * 删除备份运行记录
 */
backupRouter.delete('/runs/:id', async (c) => {
  const db = c.env.DB;
  const runId = c.req.param('id');

  const existing = await db
    .prepare('SELECT id FROM backup_runs WHERE id = ?')
    .bind(runId)
    .first();

  if (!existing) {
    return c.json({ error: 'Run not found' }, 404);
  }

  await db.prepare('DELETE FROM backup_runs WHERE id = ?').bind(runId).run();

  return c.json({ success: true });
});

/**
 * 批量删除备份运行记录（按状态筛选）
 */
backupRouter.post('/runs/cleanup', async (c) => {
  const db = c.env.DB;
  const body = await c.req.json();
  const status = body.status as string;

  if (!status) {
    return c.json({ error: 'Status is required' }, 400);
  }

  const result = await db
    .prepare('DELETE FROM backup_runs WHERE status = ?')
    .bind(status)
    .run();

  return c.json({ 
    success: true, 
    deleted_count: (result as any).changes || 0 
  });
});

// ==================== Restore Endpoints ====================

/**
 * POST /runs/:runId/prepare-restore - Prepare restore from backup
 */
backupRouter.post('/runs/:runId/prepare-restore', async (c) => {
  const db = c.env.DB;
  const userId = c.get('userId');
  const runId = c.req.param('runId');

  // 先尝试精确匹�?
  let run = await db
    .prepare('SELECT * FROM backup_runs WHERE id = ? AND user_id = ?')
    .bind(runId, userId)
    .first();

  // 兼容旧数据：user_id �?NULL 的记录，通过 schedule 匹配
  if (!run) {
    run = await db
      .prepare(`SELECT r.* FROM backup_runs r 
                LEFT JOIN backup_schedules s ON r.schedule_id = s.id 
                WHERE r.id = ? AND (r.user_id = ? OR (r.user_id IS NULL AND s.user_id = ?))`)
      .bind(runId, userId, userId)
      .first();
    
    // 补充 user_id
    if (run) {
      await db.prepare('UPDATE backup_runs SET user_id = ? WHERE id = ? AND user_id IS NULL')
        .bind(userId, runId).run();
    }
  }

  if (!run) {
    return c.json({ error: 'Backup run not found' }, 404);
  }

  // 检查状�?
  if (run.status !== 'succeeded' && run.status !== 'partial') {
    return c.json({ error: `Backup run status is ${run.status}, not eligible for restore` }, 400);
  }

  // 查找�?remote 信息
  let sourceRemoteId: number | null = null;
  let sourceRemoteName: string | null = null;
  try {
    const target = await db.prepare(
      `SELECT t.remote_id, r.name FROM backup_run_targets t 
       LEFT JOIN backup_remotes r ON t.remote_id = r.id 
       WHERE t.run_id = ? AND t.status = 'succeeded' LIMIT 1`
    ).bind(runId).first<{ remote_id: number; name: string }>();
    if (target) {
      sourceRemoteId = target.remote_id;
      sourceRemoteName = target.name;
    }
  } catch {}

  // 清理�?run 的旧 restore 记录（避�?stuck �?preparing 状态）
  try {
    await db.prepare('DELETE FROM backup_restores WHERE run_id = ? AND user_id = ?')
      .bind(runId, userId).run();
  } catch {}

  const restore = await db
    .prepare(
      `INSERT INTO backup_restores (user_id, run_id, status, created_at, extracted_path)
       VALUES (?, ?, 'preparing', datetime('now'), ?)`
    )
    .bind(userId, runId, `data/restore/${runId}/extracted`)
    .run();

  // 返回与原版一致的格式
  const restoreId = (restore as any).meta?.last_row_id;
  const restoreResult = {
    run_id: Number(runId),
    phase: 'downloading',
    started_at: new Date().toISOString(),
    finished_at: null,
    bytes_total: run.bytes_total || null,
    bytes_downloaded: 0,
    error_message: null,
    extracted_path: null,
    source_remote_id: sourceRemoteId,
    source_remote_name: sourceRemoteName,
    backup_filename: run.backup_filename || null,
  };

  // 后台下载备份�?R2（等同于原版下载到本地目录）
  const strRunId = String(runId);

  c.executionCtx.waitUntil((async () => {
    try {
      // 下载备份文件
      let backupPath = run.backup_path || '';
      if (!backupPath && c.env.R2) {
        const listing = await c.env.R2.list({ prefix: `backups/${userId}/` });
        if (listing.objects.length > 0) {
          const latest = listing.objects.sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime())[0];
          backupPath = latest.key;
        }
      }
      if (!backupPath) throw new Error('No backup file found');

      await broadcastViaDO(c.env, userId, {
        type: 'restore_progress', runId: strRunId, phase: 'downloading',
        bytesTransferred: 0, bytesTotal: run.bytes_total || 0,
      });

      // 下载完成 �?标记�?done（等用户点击恢复数据再导入）
      const finishedAt = new Date().toISOString();
      await db.prepare(
        `UPDATE backup_restores SET status = 'done', finished_at = ?, extracted_path = ? WHERE id = ?`
      ).bind(finishedAt, `data/restore/${runId}/extracted`, restoreId).run();

      await broadcastViaDO(c.env, userId, {
        type: 'restore_progress', runId: strRunId, phase: 'done',
        bytesTransferred: run.bytes_total || 0, bytesTotal: run.bytes_total || 0,
      });
    } catch (err) {
      serverLogger.error('src.routers.admin', `[Restore] Download failed: ${(err as Error).message}`);
      const finishedAt = new Date().toISOString();
      await db.prepare(
        `UPDATE backup_restores SET status = 'failed', finished_at = ?, error_message = ? WHERE id = ?`
      ).bind(finishedAt, (err as Error).message, restoreId).run();
      await broadcastViaDO(c.env, userId, {
        type: 'restore_progress', runId: strRunId, phase: 'failed',
        bytesTransferred: 0, bytesTotal: 0,
      });
    }
  })());

  return c.json(restoreResult, 202);
});

/**
 * POST /restores/:runId/trigger - 触发恢复执行
 */
backupRouter.post('/restores/:runId/trigger', async (c) => {
  const db = c.env.DB;
  const userId = c.get('userId');
  const runId = c.req.param('runId');

  const restore = await db
    .prepare('SELECT * FROM backup_restores WHERE run_id = ? AND user_id = ?')
    .bind(runId, userId)
    .first<{ id: number }>();

  if (!restore) {
    return c.json({ error: 'Restore not found' }, 404);
  }

  const run = await db
    .prepare('SELECT * FROM backup_runs WHERE id = ?')
    .bind(runId)
    .first<{ id: number; schedule_id: number | null; backup_path: string | null; bytes_total: number | null }>();

  if (!run) {
    return c.json({ error: 'Backup run not found' }, 404);
  }

  const schedule = run.schedule_id
    ? await db.prepare('SELECT user_id FROM backup_schedules WHERE id = ?').bind(run.schedule_id).first<{ user_id: string }>()
    : null;
  const backupUserId = schedule?.user_id || userId;

  const strRunId = String(runId);

  // 同步执行恢复（免费层 waitUntil 会被取消�?
  try {
    const { performRestore } = await import('../lib/restore-service');

    let backupPath = run.backup_path || '';
    if (!backupPath && c.env.R2) {
      const listing = await c.env.R2.list({ prefix: `backups/${backupUserId}/` });
      if (listing.objects.length > 0) {
        const latest = listing.objects.sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime())[0];
        backupPath = latest.key;
      }
    }
    if (!backupPath) throw new Error('No backup file found');

    // 查找备份密码（从 backup_remotes �?config_summary 中读�?age_passphrase�?
    let password: string | undefined;
    const bp = String(backupPath);
    if (bp.endsWith('.zip')) {
      try {
        const target = await db.prepare(
          `SELECT t.remote_id, r.config_summary FROM backup_run_targets t
           LEFT JOIN backup_remotes r ON t.remote_id = r.id
           WHERE t.run_id = ? AND t.status = 'succeeded' LIMIT 1`
        ).bind(runId).first<{ remote_id: number; config_summary: string }>();
        if (target?.config_summary) {
          const config = safeParseConfig(target.config_summary);
          password = config.age_passphrase || config.zipryption_password;
        }
      } catch {}
    }

    // 尝试从远端存储预下载（支持 S3/B2/WebDAV/OAuth2 等）
    let preloadedData: Uint8Array | null | undefined;
    if (backupPath && !backupPath.startsWith('backups/')) {
      // 路径不是 R2 格式，尝试从远端下载
      const target = await db.prepare(
        `SELECT br.backend_type, br.config_summary FROM backup_run_targets brt
         JOIN backup_remotes br ON brt.remote_id = br.id
         WHERE brt.run_id = ? AND brt.status = 'succeeded' LIMIT 1`
      ).bind(runId).first<{ backend_type: string; config_summary: string }>();
      if (target) {
        const config = (() => { try { return JSON.parse(target.config_summary || '{}') as Record<string, string>; } catch { return {} as Record<string, string>; } })();
        const remoteConfig: Record<string, string> = { backend_type: target.backend_type, ...config };
        const { downloadBackupFile } = await import('../services/backup-executor');
        preloadedData = await downloadBackupFile(remoteConfig, backupPath);
      }
    }

    await broadcastViaDO(c.env, userId, {
      type: 'restore_progress', runId: strRunId, phase: 'downloading',
      bytesTransferred: 0, bytesTotal: run.bytes_total || 0,
    });

    const result = await performRestore(db, c.env.R2, backupPath, (progress) => {
      broadcastViaDO(c.env, userId, {
        type: 'restore_progress', runId: strRunId, phase: progress.phase,
        bytesTransferred: progress.bytesTransferred, bytesTotal: progress.bytesTotal,
      }).catch(() => {});
    }, password, preloadedData ?? undefined);

    const finishedAt = new Date().toISOString();
    await db.prepare(
      `UPDATE backup_restores SET status = ?, finished_at = ?, extracted_path = ?, error_message = ? WHERE id = ?`
    ).bind(result.success ? 'done' : 'failed', finishedAt,
          result.success ? `data/restore/${runId}/extracted` : null,
          result.success ? null : result.message, restore.id).run();

    await broadcastViaDO(c.env, userId, {
      type: 'restore_progress', runId: strRunId, phase: result.success ? 'done' : 'failed',
      bytesTransferred: 0, bytesTotal: 0,
    });

    if (result.success) {
      // 重建 sync_changes，让 App 能同步到恢复后的数据
      try {
        const { createSyncChangesForUser } = await import('./backup');
        await createSyncChangesForUser(db, userId);
      } catch (e) {
        serverLogger.error('src.routers.admin', `[Restore] Sync changes creation failed: ${e}`);
      }
    }

    return c.json({ ok: true, message: result.message }, 200);
  } catch (err) {
    serverLogger.error('src.routers.admin', `[Restore] Failed: ${(err as Error).message}`);
    const finishedAt = new Date().toISOString();
    await db.prepare(
      `UPDATE backup_restores SET status = 'failed', finished_at = ?, error_message = ? WHERE id = ?`
    ).bind(finishedAt, (err as Error).message, restore.id).run();
    await broadcastViaDO(c.env, userId, {
      type: 'restore_progress', runId: strRunId, phase: 'failed',
      bytesTransferred: 0, bytesTotal: 0,
    });
    return c.json({ error: (err as Error).message }, 500);
  }
});

/**
 * GET /restores - List restore records
 */
backupRouter.get('/restores', async (c) => {
  const db = c.env.DB;
  const userId = c.get('userId');
  const limit = parseInt(c.req.query('limit') ?? '20');

  const result = await db
    .prepare('SELECT * FROM backup_restores WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
    .bind(userId, limit)
    .all();

  return c.json({ items: result.results || [] });
});

/**
 * GET /restores/:id - Get restore details
 */
backupRouter.get('/restores/:id', async (c) => {
  const db = c.env.DB;
  const userId = c.get('userId');
  const runId = c.req.param('id');

  // 前端传入的是 backup run ID，不�?restore record ID
  // 兼容两种查询方式
  let restore = await db
    .prepare('SELECT * FROM backup_restores WHERE run_id = ? AND user_id = ?')
    .bind(runId, userId)
    .first<{ id: number; run_id: number; status: string; created_at: string; finished_at: string | null; error_message: string | null; extracted_path: string | null }>();

  // 回退：按 restore record ID 查询
  if (!restore) {
    restore = await db
      .prepare('SELECT * FROM backup_restores WHERE id = ? AND user_id = ?')
      .bind(runId, userId)
      .first<{ id: number; run_id: number; status: string; created_at: string; finished_at: string | null; error_message: string | null; extracted_path: string | null }>();
  }

  if (!restore) {
    return c.json({ error: 'Restore not found' }, 404);
  }

  // 如果 restore 还在 preparing 状态（超过 1 分钟），标记�?done
  if (restore.status === 'preparing') {
    const createdAt = new Date(restore.created_at).getTime();
    if (Date.now() - createdAt > 60000) {
      await db.prepare(`UPDATE backup_restores SET status = 'done', finished_at = datetime('now') WHERE id = ?`)
        .bind(restore.id).run();
      restore.status = 'done';
      restore.finished_at = new Date().toISOString();
    }
  }

  // 返回与原版一致的格式 �?�?backup_runs 补充数据
  const runData = await db.prepare(
    `SELECT bytes_total, backup_filename FROM backup_runs WHERE id = ?`
  ).bind(restore.run_id).first<{ bytes_total: number | null; backup_filename: string | null }>();

  let sourceRemoteId: number | null = null;
  let sourceRemoteName: string | null = null;
  try {
    const target = await db.prepare(
      `SELECT t.remote_id, r.name FROM backup_run_targets t
       LEFT JOIN backup_remotes r ON t.remote_id = r.id
       WHERE t.run_id = ? LIMIT 1`
    ).bind(restore.run_id).first<{ remote_id: number; name: string }>();
    if (target) { sourceRemoteId = target.remote_id; sourceRemoteName = target.name; }
  } catch {}

  return c.json({
    run_id: restore.run_id,
    phase: restore.status || 'unknown',
    started_at: restore.created_at,
    finished_at: restore.finished_at || null,
    bytes_total: runData?.bytes_total || null,
    bytes_downloaded: runData?.bytes_total || null,
    error_message: restore.error_message || null,
    extracted_path: restore.extracted_path || `data/restore/${restore.run_id}/extracted`,
    source_remote_id: sourceRemoteId,
    source_remote_name: sourceRemoteName,
    backup_filename: runData?.backup_filename || null,
  });
});

/**
 * DELETE /restores/:id - Delete restore record
 */
backupRouter.delete('/restores/:id', async (c) => {
  const db = c.env.DB;
  const userId = c.get('userId');
  const id = c.req.param('id');

  // 前端传入 restoreRun.id �?backup run ID，原版用 run_id 参数
  await db
    .prepare('DELETE FROM backup_restores WHERE run_id = ? AND user_id = ?')
    .bind(id, userId)
    .run();

  return c.body(null, 204);
});

/**
 * GET /restore-from-r2/list - 列出 R2 中所有可用的备份文件 + 内容概览
 */
backupRouter.get('/restore-from-r2/list', async (c) => {
  const r2 = c.env.R2;
  if (!r2) return c.json({ error: 'R2 not configured' }, 400);

  // 尝试多种前缀
  const allObjects: R2Object[] = [];
  for (const prefix of ['beecount/backups/', 'backups/']) {
    let cursor: string | undefined;
    do {
      const listing = await r2.list({ prefix, limit: 100, cursor });
      allObjects.push(...listing.objects);
      cursor = listing.truncated ? listing.objects[listing.objects.length - 1].key : undefined;
    } while (cursor);
  }

  if (allObjects.length === 0) {
    return c.json({ backups: [], message: 'No backups found' });
  }

  // 过滤出备份文�?
  const backupFiles = allObjects
    .filter(o => o.key.endsWith('.tar.gz') || o.key.endsWith('.zip'))
    .sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime());

  const backups = [];
  for (const obj of backupFiles) {
    const entry: Record<string, unknown> = {
      key: obj.key,
      size: obj.size,
      uploaded: obj.uploaded.toISOString(),
      filename: obj.key.split('/').pop() || obj.key,
    };

    // 尝试读取�?10 个备份的内容概览（db.json 表名和行数）
    try {
      const resp = await r2.get(obj.key);
      if (resp) {
        const ab = await resp.arrayBuffer();
        const raw = new Uint8Array(ab);
        const ds = new DecompressionStream('gzip');
        const w = ds.writable.getWriter();
        w.write(raw); w.close();
        const reader = ds.readable.getReader();
        const chunks: Uint8Array[] = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
        let totalLen = 0;
        for (const ch of chunks) totalLen += ch.length;
        const decompressed = new Uint8Array(totalLen);
        let off = 0;
        for (const ch of chunks) { decompressed.set(ch, off); off += ch.length; }

        // 解析 tar，找 db.json
        let tarOff = 0;
        while (tarOff < decompressed.length - 512) {
          const hdr = decompressed.slice(tarOff, tarOff + 512);
          const name = new TextDecoder().decode(hdr.slice(0, 100)).replace(/\0/g, '');
          if (!name) break;
          const sizeOct = new TextDecoder().decode(hdr.slice(124, 136)).replace(/\0/g, '').trim();
          const sz = parseInt(sizeOct, 8) || 0;
          const contentOff = tarOff + 512;

          if (name === 'db.json') {
            const jsonText = new TextDecoder().decode(decompressed.slice(contentOff, contentOff + sz));
            const dbJson = JSON.parse(jsonText);
            const tables = dbJson.tables || {};
            const summary: Record<string, number> = {};
            for (const [t, rows] of Object.entries(tables)) {
              summary[t] = Array.isArray(rows) ? rows.length : 0;
            }
            entry.tables = summary;
            entry.totalRows = Object.values(summary).reduce((s, n) => s + n, 0);
          }
          if (name === 'db.sqlite3') {
            entry.hasSqlite3 = true;
          }
          tarOff = contentOff + Math.ceil(sz / 512) * 512;
        }
      }
    } catch (e) {
      entry.previewError = (e as Error).message;
    }

    backups.push(entry);
  }

  return c.json({ backups });
});

backupRouter.post('/restore-from-r2', async (c) => {
  const db = c.env.DB;
  const userId = c.get('userId');
  const r2 = c.env.R2;

  if (!r2) {
    return c.json({ error: 'R2 not configured' }, 400);
  }

  // 支持指定备份路径
  let body: { backupPath?: string; password?: string } = {};
  try { body = await c.req.json(); } catch {}
  const backupPath = body.backupPath;
  const password = body.password;

  // 查找备份文件
  let selectedPath = backupPath;
  if (!selectedPath) {
    let listing;
    listing = await r2.list({ prefix: `beecount/backups/${userId}/` });
    if (!listing.objects || listing.objects.length === 0) {
      listing = await r2.list({ prefix: `backups/${userId}/` });
    }
    if (!listing.objects || listing.objects.length === 0) {
      listing = await r2.list({ prefix: `beecount/backups/` });
    }
    if (!listing.objects || listing.objects.length === 0) {
      return c.json({ error: 'No backups found in R2' }, 404);
    }
    selectedPath = listing.objects.sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime())[0].key;
  }
  console.debug(`[Restore] Restoring from: ${selectedPath}`);

  try {
    const { performRestore } = await import('../lib/restore-service');

    const result = await performRestore(db, r2, selectedPath, (progress) => {
      console.debug(`[Restore] ${progress.phase}: ${progress.bytesTransferred}/${progress.bytesTotal}`);
    }, password);

    if (result.success) {
      try {
        const { createSyncChangesForUser } = await import('./backup');
        await createSyncChangesForUser(db, userId);
      } catch (e) {
        serverLogger.error('src.routers.admin', `[Restore] Sync changes creation failed: ${e}`);
      }
    }

    return c.json({
      success: result.success,
      message: result.message,
      backupFile: selectedPath,
      tablesImported: result.tablesImported,
      rowsImported: result.rowsImported,
      attachmentsUploaded: result.attachmentsUploaded,
    }, 200);
  } catch (err) {
    serverLogger.error('src.routers.admin', `[Restore] Failed: ${(err as Error).message}`);
    return c.json({ error: (err as Error).message }, 500);
  }
});

/**
 * DELETE /restore-from-r2/phantom-devices - 清理恢复过程中误创建�?phantom 设备
 */
backupRouter.delete('/phantom-devices', async (c) => {
  const db = c.env.DB;
  const result = await db.prepare(`DELETE FROM devices WHERE name = 'restored-device'`).run();
  return c.json({ deleted: result.meta?.changes || 0 });
});

// ---------------------------------------------------------------------------
// POST /admin/backups/upload-db - 上传数据库备份文�?
// ---------------------------------------------------------------------------

backupRouter.post('/upload-db', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const r2 = c.env.R2;

  const formData = await c.req.formData();
  const ledgerId = formData.get('ledger_id') as string | null;
  const file = formData.get('file') as File | null;
  const note = formData.get('note') as string | null;

  if (!file) return c.json({ error: 'No file provided' }, 400);

  const buffer = await file.arrayBuffer();
  const checksum = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  const fileName = file.name || `backup-${Date.now()}.db`;
  const r2Key = `backups/${userId}/${fileName}`;

  if (r2) {
    await r2.put(r2Key, buffer, { httpMetadata: { contentType: file.type || 'application/octet-stream' } });
  }

  const serverNow = new Date().toISOString();
  await db.prepare(`INSERT INTO backup_snapshots (user_id, ledger_id, kind, file_name, content_type, checksum, size, created_at, note)
    VALUES (?, ?, 'db', ?, ?, ?, ?, ?, ?)`)
    .bind(userId, ledgerId || null, fileName, file.type || null, checksum, buffer.byteLength, serverNow, note).run();

  // 备份产物记录（对齐原版 kind=db + checksum + storage_path）
  const artifactId = crypto.randomUUID();
  await db.prepare(`INSERT INTO backup_artifacts
    (id, user_id, ledger_id, kind, file_name, storage_path, content_type, checksum_sha256, size_bytes, metadata_json, created_at)
    VALUES (?, ?, ?, 'db', ?, ?, ?, ?, ?, ?, ?)`)
    .bind(artifactId, userId, ledgerId || null, fileName, r2Key, file.type || null, checksum, buffer.byteLength,
      note ? JSON.stringify({ note }) : null, serverNow).run();

  return c.json({ success: true, file_name: fileName, size: buffer.byteLength, checksum });
});

// ---------------------------------------------------------------------------
// POST /admin/backups/upload-snapshot - 上传 JSON 快照
// ---------------------------------------------------------------------------

const UploadSnapshotSchema = z.object({
  ledger_id: z.string(),
  payload: z.record(z.any()),
  note: z.string().optional(),
  metadata: z.record(z.any()).optional(),
});

backupRouter.post('/upload-snapshot', apiValidator('json', UploadSnapshotSchema), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const r2 = c.env.R2;
  const req = c.req.valid('json');

  const jsonStr = JSON.stringify(req.payload);
  const checksum = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(jsonStr))))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  const fileName = `snapshot-${Date.now()}.json`;
  const r2Key = `backups/${userId}/${fileName}`;

  if (r2) {
    await r2.put(r2Key, new TextEncoder().encode(jsonStr), { httpMetadata: { contentType: 'application/json' } });
  }

  const serverNow = new Date().toISOString();
  await db.prepare(`INSERT INTO backup_snapshots (user_id, ledger_id, kind, file_name, content_type, checksum, size, created_at, note)
    VALUES (?, ?, 'snapshot', ?, 'application/json', ?, ?, ?, ?)`)
    .bind(userId, req.ledger_id, fileName, checksum, jsonStr.length, serverNow, req.note || null).run();

  // 备份产物记录（对齐原版 kind=snapshot + checksum + storage_path）
  const artifactId = crypto.randomUUID();
  const metadata = { ...(req.metadata || {}), ...(req.note ? { note: req.note } : {}) };
  await db.prepare(`INSERT INTO backup_artifacts
    (id, user_id, ledger_id, kind, file_name, storage_path, content_type, checksum_sha256, size_bytes, metadata_json, created_at)
    VALUES (?, ?, ?, 'snapshot', ?, ?, 'application/json', ?, ?, ?, ?)`)
    .bind(artifactId, userId, req.ledger_id, fileName, r2Key, checksum, jsonStr.length,
      JSON.stringify(metadata), serverNow).run();

  return c.json({ success: true, file_name: fileName, size: jsonStr.length, checksum });
});

// ============================================================================
// Restore endpoints - 与原版恢复功能对�?
// ============================================================================

/**
 * POST /restore/:runId - 准备恢复（下载备份文件）
 */
backupRouter.post('/restore/:runId', async (c) => {
  const db = c.env.DB;
  const r2 = c.env.R2;
  const runId = parseInt(c.req.param('runId'));
  const userId = c.get('userId');
  
  // 验证备份记录
  const run = await db.prepare(
    'SELECT * FROM backup_runs WHERE id = ? AND user_id = ?'
  ).bind(runId, userId).first<{ id: number; status: string; backup_path: string; backup_filename: string | null; bytes_total: number | null; started_at: string }>();
  
  if (!run) {
    return c.json({ error: 'Backup run not found' }, 404);
  }
  
  if (run.status !== 'succeeded') {
    return c.json({ error: 'Backup run is not completed' }, 400);
  }
  
  if (!run.backup_path) {
    return c.json({ error: 'No backup file found' }, 400);
  }
  
  // 下载备份文件
  try {
    let backupFile: Uint8Array | null = null;
    
    // 先尝试 R2
    if (r2) {
      const r2Obj = await r2.get(run.backup_path);
      if (r2Obj) {
        const buffer = await r2Obj.arrayBuffer();
        backupFile = new Uint8Array(buffer);
      }
    }
    
    if (!backupFile) {
      // 尝试从所有成功上传的远端存储下载
      const targets = await db.prepare(
        `SELECT br.backend_type, br.config_summary FROM backup_run_targets brt
         JOIN backup_remotes br ON brt.remote_id = br.id
         WHERE brt.run_id = ? AND brt.status = 'succeeded'`
      ).bind(runId).all<{ backend_type: string; config_summary: string }>();
      
      for (const target of targets.results) {
        const config = (() => { try { return JSON.parse(target.config_summary || '{}') as Record<string, string>; } catch { return {} as Record<string, string>; } })();
        const remoteConfig: Record<string, string> = { backend_type: target.backend_type, ...config };
        backupFile = await downloadBackupFile(remoteConfig, run.backup_path);
        if (backupFile) break;
      }
    }
    
    if (!backupFile) {
      return c.json({ error: 'Backup file not found' }, 404);
    }
    
    return c.json({
      success: true,
      filename: run.backup_filename,
      size: backupFile.length,
      backup_path: run.backup_path,
      message: 'Backup file downloaded successfully.'
    });
  } catch (error) {
    return c.json({ error: `Failed to download backup: ${(error as Error).message}` }, 500);
  }
});

/**
 * GET /restore/:runId/info - 获取备份文件信息
 */
backupRouter.get('/restore/:runId/info', async (c) => {
  const db = c.env.DB;
  const runId = parseInt(c.req.param('runId'));
  const userId = c.get('userId');
  
  const run = await db.prepare(
    'SELECT * FROM backup_runs WHERE id = ? AND user_id = ?'
  ).bind(runId, userId).first<{ id: number; status: string; backup_path: string; backup_filename: string | null; bytes_total: number | null; started_at: string }>();
  
  if (!run) {
    return c.json({ error: 'Backup run not found' }, 404);
  }
  
  return c.json({
    id: run.id,
    filename: run.backup_filename,
    size: run.bytes_total,
    status: run.status,
    backup_path: run.backup_path,
    created_at: run.started_at,
  });
});

export default backupRouter;
