/**
 * 管理员备份路由模块 - 实现 BeeCount Cloud 备份管理接口
 *
 * 参考原版 BeeCount-Cloud (Python/FastAPI) 的 /admin/backup 端点：
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
 * 功能说明：
 * - 需要管理员权限
 * - 备份元数据存储在 D1 数据库
 * - 实际备份文件存储在配置的 S3 远程
 *
 * @module routes/admin_backup
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { getFirstEnabledS3Config } from './sys_config';
import { signS3Request } from '../lib/s3';
import { performBackup, calculateNextRun } from '../services/backup-executor';
import { insertAuditLog } from '../lib/audit';

// ===========================
// WebDAV 连通性测试
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

        console.log('[Backup WebDAV Test] Testing connection to:', normalizedUrl);

        // PROPFIND to check connectivity
        const propfindResponse = await fetch(normalizedUrl, {
            method: 'PROPFIND',
            headers: {
                'Authorization': auth,
                'Depth': '0',
                'Content-Type': 'application/xml',
            },
        });

        console.log('[Backup WebDAV Test] PROPFIND Response status:', propfindResponse.status);

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

        console.log('[Backup WebDAV Test] PROPFIND test passed');

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

        console.log('[Backup WebDAV Test] PUT Response status:', putResponse.status);

        if (!putResponse.ok && putResponse.status !== 405) {
            return { ok: false, message: `WebDAV write test failed: HTTP ${putResponse.status} ${putResponse.statusText}` };
        }

        // Cleanup: DELETE test file
        if (putResponse.ok) {
            await fetch(putUrl, {
                method: 'DELETE',
                headers: { 'Authorization': auth },
            });
            console.log('[Backup WebDAV Test] Cleanup DELETE sent');
        }

        return { ok: true, message: `WebDAV connection successful: ${normalizedUrl}` };
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        console.error('[Backup WebDAV Test] Error:', errorMsg);
        if (errorMsg.includes('timeout') || errorMsg.includes('Timeout')) {
            return { ok: false, message: `WebDAV connection timeout: Unable to reach ${url}` };
        }
        return { ok: false, message: `WebDAV connection error: ${errorMsg}` };
    }
}

function nowUtc(): string {
  return new Date().toISOString();
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
        
        console.log('[Backup S3 Test] Testing connection to endpoint:', endpoint);
        console.log('[Backup S3 Test] Bucket:', cleanBucket);
        console.log('[Backup S3 Test] Region:', region);
        
        // 首先尝试列出 bucket 中的对象，这是更直接的检测方法
        const { url: listUrl, headers: listHeaders } = await signS3Request(
            accessKey,
            secretKey,
            region,
            endpoint,
            cleanBucket,
            '',
            'GET'
        );
        
        console.log('[Backup S3 Test] Testing with LIST to:', listUrl);
        
        const listResponse = await fetch(listUrl, {
            method: 'GET',
            headers: listHeaders
        });
        
        console.log('[Backup S3 Test] LIST Response status:', listResponse.status);
        console.log('[Backup S3 Test] LIST Response headers:', Object.fromEntries(listResponse.headers.entries()));
        
        // 读取响应体以获取更多信息
        const listResponseText = await listResponse.text().catch(() => '');
        console.log('[Backup S3 Test] LIST Response body:', listResponseText);
        
        // 即使状态码是 200，我们也需要验证响应是否真的表示成功
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
        
        // 检查响应体是否包含有效的 ListBucketResult（这才是真正的成功）
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
        
        console.log('[Backup S3 Test] LIST test passed');
        return { ok: true, message: `S3 connection successful: ${cleanBucket} at ${endpoint}` };
        return { ok: true, message: `S3 connection successful: ${cleanBucket} at ${endpoint}` };
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        console.error('[Backup S3 Test] Error:', errorMsg);
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
  config: z.record(z.string()),
  is_default: z.boolean().optional(),
});

const RemoteUpdateSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  config: z.record(z.string()).optional(),
  is_default: z.boolean().optional(),
});

const RemoteTestSchema = z.object({
  backend_type: z.string(),
  config: z.record(z.string()),
});

const ScheduleCreateSchema = z.object({
  name: z.string().min(1).max(64),
  cron_expr: z.string().min(1).max(64),
  retention_days: z.number().int().min(1).max(365).optional(),
  enabled: z.boolean().optional(),
  remote_ids: z.array(z.union([z.string(), z.number()])).optional().default([]),
  include_attachments: z.boolean().optional().default(true),
  timezone_offset: z.number().optional().default(0),
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
  S3_ENDPOINT?: string;
  S3_REGION?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
  S3_BUCKET_NAME?: string;
};

type Variables = {
  userId: string;
};

const backupRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// 测试端点 - 首先添加一个简单的测试路由
backupRouter.get('/test', (c) => {
  return c.json({ message: 'adminBackupRouter is working!', time: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// 管理员权限检查
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
 * 生成标准的 rclone 配置文件格式
 */
backupRouter.get('/rclone-config', async (c) => {
  const db = c.env.DB;
  
  try {
    const remotes = await db
      .prepare('SELECT id, name, backend_type, config_summary FROM backup_remotes')
      .all();
    
    let configContent = '# BeeCount Cloud rclone configuration\n';
    configContent += '# Auto-generated - do not edit manually\n\n';
    
    let hasRcloneConfig = false;
    
    for (const row of (remotes.results || [])) {
      // R2 使用 Worker 绑定，不使用 rclone，跳过
      if (row.backend_type === 'r2') continue;
      
      let config: Record<string, string> = {};
      try {
        config = JSON.parse(row.config_summary || '{}');
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
    console.error('[rclone-config] Error:', error);
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
 * 列出所有备份远程配置
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
        config = JSON.parse(row.config_summary || '{}');
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
    // 如果查询失败，尝试不查询新字段再试一次
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
          config = JSON.parse(row.config_summary || '{}');
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
      console.error('Error fetching backup_remotes (fallback also failed):', fallbackError);
      return c.json({ error: String(fallbackError) }, 500);
    }
  }
});

/**
 * 创建备份远程配置
 */
backupRouter.post('/remotes', zValidator('json', RemoteCreateSchema), async (c) => {
  const db = c.env.DB;
  const req = c.req.valid('json');
  const serverNow = nowUtc();

  const configJson = JSON.stringify(req.config);

  const result = await db
    .prepare(
      `INSERT INTO backup_remotes (name, backend_type, config_summary, encrypted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(
      req.name,
      req.backend_type,
      configJson,
      req.is_default ? 1 : 0,
      serverNow,
      serverNow
    )
    .run();

  const remoteId = result.meta.last_row_id as number;

  if (req.is_default) {
    await db
      .prepare('UPDATE backup_remotes SET encrypted = 0 WHERE id != ?')
      .bind(remoteId)
      .run();
  }

  return c.json({
    id: String(remoteId),
    name: req.name,
    backend_type: req.backend_type,
    config: req.config,
    is_default: req.is_default ?? false,
    created_at: serverNow,
    updated_at: serverNow,
  }, 201);
});

/**
 * 更新备份远程配置
 */
backupRouter.patch('/remotes/:id', zValidator('json', RemoteUpdateSchema), async (c) => {
  const db = c.env.DB;
  const remoteId = c.req.param('id');
  const req = c.req.valid('json');
  const serverNow = nowUtc();

  const existing = await db
    .prepare('SELECT id FROM backup_remotes WHERE id = ?')
    .bind(remoteId)
    .first();

  if (!existing) {
    return c.json({ error: 'Remote not found' }, 404);
  }

  const updates: string[] = ['updated_at = ?'];
  const params: (string | number | null)[] = [serverNow];

  if (req.name !== undefined) {
    updates.push('name = ?');
    params.push(req.name);
  }

  if (req.config !== undefined) {
    updates.push('config_summary = ?');
    params.push(JSON.stringify(req.config));
  }
  if (req.is_default !== undefined) {
    updates.push('encrypted = ?');
    params.push(req.is_default ? 1 : 0);
  }

  params.push(remoteId);

  await db
    .prepare(`UPDATE backup_remotes SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...params)
    .run();

  if (req.is_default) {
    await db
      .prepare('UPDATE backup_remotes SET encrypted = 0 WHERE id != ?')
      .bind(remoteId)
      .run();
  }

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
    config: updated?.config_summary ? JSON.parse(updated.config_summary) : {},
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

  await db.prepare('DELETE FROM backup_remotes WHERE id = ?').bind(remoteId).run();

  return c.json({ success: true });
});

/**
 * 显示备份远程配置完整信息（解密后）
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
    config: JSON.parse(remote.config_summary || '{}'),
    encrypted: Boolean(remote.encrypted),
    created_at: remote.created_at,
    updated_at: remote.updated_at,
  });
});

/**
 * 测试指定备份远程配置连通性
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

  const config = JSON.parse(remote.config_summary || '{}');

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

      case 'local':
        testResult.ok = true;
        testResult.message = 'Local backend configured (requires filesystem support)';
        break;

      case 'webdav':
        const webdavUrl = config.url;
        const webdavUsername = config.username;
        const webdavPassword = config.password;
        
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
        const ftpUsername = config.username;
        const ftpPassword = config.password;

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
            // 测试 bucket 是否可访问 - 尝试列出对象
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
        const sftpUsername = config.username;
        const sftpPassword = config.password;

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

      default:
        testResult.message = `Unknown backend type: ${remote.backend_type}`;
    }

    // 更新数据库中的测试状态
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
      // 忽略数据库更新错误，可能是字段还不存在
      console.log('Could not update backup_remotes test status (table may not have the new columns yet)', dbError);
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
 * 测试备份远程配置连通性
 */
backupRouter.post('/remotes/test', zValidator('json', RemoteTestSchema), async (c) => {
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
        const webdavUsername = config.username;
        const webdavPassword = config.password;
        
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
 * 列出所有备份调度
 */
backupRouter.get('/schedules', async (c) => {
  const db = c.env.DB;

  let rows;
  try {
    // 先尝试查询带所有新字段的版本
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
    console.log('[Backup] Falling back to query without timezone_offset');
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

  const schedules = rows.results.map((row) => {
    let parsedRemoteIds: (string | number)[] = [];
    if (row.remote_ids) {
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
backupRouter.post('/schedules', zValidator('json', ScheduleCreateSchema), async (c) => {
  const db = c.env.DB;
  const req = c.req.valid('json');
  const serverNow = nowUtc();
  const userId = c.get('userId');
  
  // 获取时区偏移：优先使用请求中的值，否则从系统设置获取
  let timezoneOffset = req.timezone_offset;
  if (timezoneOffset === undefined || timezoneOffset === null) {
    try {
      const sysSetting = await db.prepare('SELECT timezone_offset FROM system_settings WHERE id = ?')
        .bind('default').first<{ timezone_offset: number }>();
      if (sysSetting) {
        timezoneOffset = sysSetting.timezone_offset;
        console.log(`[Backup] Using timezone from system_settings: ${timezoneOffset}`);
      }
    } catch (e) {
      // 表可能不存在，忽略
    }
  }
  
  // 计算首次运行时间（使用时区偏移）
  const nextRunAt = calculateNextRun(req.cron_expr, timezoneOffset ?? 0);

  const remoteIdsJson = req.remote_ids && req.remote_ids.length > 0 ? JSON.stringify(req.remote_ids) : null;

  // 先尝试插入带 timezone_offset 的版本
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
    // 如果失败，尝试不带 timezone_offset 的版本
    console.log('[Backup] Creating schedule without timezone_offset:', error);
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
 * Cron 表达式格式: 分钟 小时 日期 月份 星期
 * @param cronExpr cron表达式
 * @param timezoneOffset 用户时区偏移（分钟，东八区为-480）
 */
// calculateNextRun 已提取到 src/services/backup-executor.ts

/**
 * 更新备份调度
 */
backupRouter.patch('/schedules/:id', zValidator('json', ScheduleUpdateSchema), async (c) => {
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

  const updates: string[] = ['updated_at = ?'];
  const params: (string | number | null)[] = [serverNow];

  if (req.name !== undefined) {
    updates.push('name = ?');
    params.push(req.name);
  }

  if (req.remote_ids !== undefined) {
    const remoteIdsJson = req.remote_ids.length > 0 ? JSON.stringify(req.remote_ids) : null;
    updates.push('remote_ids = ?');
    params.push(remoteIdsJson);
  }

  if (req.cron_expr !== undefined) {
    updates.push('cron_expr = ?');
    params.push(req.cron_expr);
    // 更新 cron 表达式时重新计算下次运行时间（使用时区偏移）
    const nextRunAt = calculateNextRun(req.cron_expr, req.timezone_offset ?? 0);
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
    // 如果启用了，也重新计算下次运行时间
    if (req.enabled) {
      const existingSchedule = await db
        .prepare('SELECT cron_expr FROM backup_schedules WHERE id = ?')
        .bind(scheduleId)
        .first<{ cron_expr: string }>();
      
      if (existingSchedule) {
        const cronToUse = req.cron_expr || existingSchedule.cron_expr;
        const nextRunAt = calculateNextRun(cronToUse, req.timezone_offset ?? 0);
        updates.push('next_run_at = ?');
        params.push(nextRunAt);
      }
    }
  }

  params.push(scheduleId);

  // 尝试执行更新，如果 timezone_offset 不存在则移除它再重试
  try {
    await db
      .prepare(`UPDATE backup_schedules SET ${updates.join(', ')} WHERE id = ?`)
      .bind(...params)
      .run();
  } catch (error) {
    // 如果错误是关于 timezone_offset 列不存在，则移除该字段重试
    const errorStr = String(error);
    if (errorStr.includes('timezone_offset') && req.timezone_offset !== undefined) {
      console.log('[Backup] Retrying update without timezone_offset');
      // 移除 timezone_offset 相关的更新
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
    .prepare('SELECT id, name, user_id, remote_ids FROM backup_schedules WHERE id = ?')
    .bind(scheduleId)
    .first<{ id: number; name: string; user_id: string; remote_ids: string }>();

  if (!schedule) {
    return c.json({ error: 'Schedule not found' }, 404);
  }

  const ledger = await db
    .prepare('SELECT id FROM ledgers WHERE user_id = ? LIMIT 1')
    .bind(schedule.user_id)
    .first<{ id: string }>();

  const ledgerId = ledger?.id || null;

  let remoteId: string | null = null;
  let remoteConfig: Record<string, string> = { backend_type: 'local' };
  let shouldEncrypt = false;

  if (schedule.remote_ids) {
    try {
      const remoteIds = JSON.parse(schedule.remote_ids);
      console.log('[Backup] Parsed remote_ids:', remoteIds);
      if (remoteIds.length > 0) {
        remoteId = String(remoteIds[0]);
        console.log('[Backup] Querying backup_remotes with id:', remoteId);
        const remote = await db
          .prepare('SELECT backend_type, config_summary, encrypted FROM backup_remotes WHERE id = ?')
          .bind(remoteId)
          .first<{ backend_type: string; config_summary: string; encrypted: number }>();
        console.log('[Backup] Query result:', remote);
        
        if (remote) {
          const configStr = remote.config_summary || '{}';
          console.log('[Backup] configStr from backup_remotes:', configStr);
          const parsedConfig = JSON.parse(configStr);
          console.log('[Backup] parsedConfig keys:', Object.keys(parsedConfig));
          console.log('[Backup] parsedConfig.root_path:', parsedConfig.root_path);
          const hasS3Config = parsedConfig.bucket && parsedConfig.access_key_id && parsedConfig.secret_access_key;
          const isR2Type = remote.backend_type === 'r2';
          const isS3Type = remote.backend_type === 's3';
          if ((isS3Type && hasS3Config) || isR2Type) {
            console.log('[Backup] Found remote config:', remote.backend_type);
            const defaultRootPath = 'beecount';
            const rootPath = (parsedConfig.root_path || '').replace(/^\/+|\/+$/g, '') || defaultRootPath;
            remoteConfig = {
              backend_type: remote.backend_type,
              ...parsedConfig,
              path_style: parsedConfig.path_style !== undefined ? parsedConfig.path_style : 'true',
              savePath: rootPath
            };
            console.log('[Backup] Full remoteConfig:', JSON.stringify(remoteConfig));
            shouldEncrypt = remote.encrypted === 1;
          } else {
            console.log('[Backup] backup_remotes config is empty, trying sys_config');
          }
        }
      }
    } catch (err) {
      console.log('[Backup] Failed to parse remote_ids, trying sys_config. Error:', err);
    }
  }

  if (remoteConfig.backend_type === 'local' || !remoteConfig.bucket) {
    console.log('[Backup] Trying to get S3 config from sys_config');
    try {
      const sysConfig = await getFirstEnabledS3Config(db, c.env);
      if (sysConfig && sysConfig.bucketName) {
        console.log('[Backup] Found S3 config in sys_config:', sysConfig.name);
        remoteConfig = {
          backend_type: 's3',
          endpoint: sysConfig.endpoint || 'https://s3.amazonaws.com',
          bucket: sysConfig.bucketName,
          access_key_id: sysConfig.accessKeyId,
          secret_access_key: sysConfig.secretAccessKey,
          region: sysConfig.region || 'auto',
          savePath: sysConfig.savePath,
        };
        console.log('[Backup] Using sys_config S3 config, endpoint:', remoteConfig.endpoint, 'savePath:', remoteConfig.savePath);
      } else {
        console.log('[Backup] No S3 config found in sys_config either');
      }
    } catch (err) {
      console.log('[Backup] Failed to get sys_config S3 config:', err);
    }
  }

  const runInsertResult = await db
    .prepare(
      `INSERT INTO backup_runs (schedule_id, ledger_id, remote_id, status, started_at)
       VALUES (?, ?, ?, 'pending', ?)`
    )
    .bind(scheduleId, ledgerId || '', remoteId, serverNow)
    .run();

  const runId = runInsertResult.meta.last_row_id as number;

  const backupResult = await performBackup(db, runId, schedule.user_id, ledgerId || 'global', remoteConfig, shouldEncrypt, c.env.R2);
  
  const finishedAt = new Date().toISOString();
  
  if (backupResult.success) {
    await db
      .prepare(
        `UPDATE backup_runs 
         SET status = ?, finished_at = ?, bytes_total = ?, backup_filename = ?, backup_path = ?
         WHERE id = ?`
      )
      .bind('completed', finishedAt, backupResult.backupSize, 
            backupResult.backupPath?.split('/').pop() || null, backupResult.backupPath, runId)
      .run();

    return c.json({
      id: runId,
      schedule_id: Number(scheduleId),
      schedule_name: schedule.name,
      status: 'completed',
      started_at: serverNow,
      finished_at: finishedAt,
      backup_filename: backupResult.backupPath?.split('/').pop() || null,
      bytes_total: backupResult.backupSize,
      error_message: null,
      log_text: backupResult.message,
      targets: [],
      message: backupResult.message,
    }, 200);
  } else {
    await db
      .prepare(
        `UPDATE backup_runs 
         SET status = ?, finished_at = ?, error_message = ?
         WHERE id = ?`
      )
      .bind('failed', finishedAt, backupResult.message, runId)
      .run();

    return c.json({
      id: runId,
      schedule_id: Number(scheduleId),
      schedule_name: schedule.name,
      status: 'failed',
      started_at: serverNow,
      finished_at: finishedAt,
      backup_filename: null,
      bytes_total: null,
      error_message: backupResult.message,
      log_text: backupResult.message,
      targets: [],
      message: backupResult.message,
    }, 200);
  }
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
              r.started_at, r.finished_at, r.error_message, r.bytes_total,
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
      bytes_total: number | null;
      backup_filename: string | null;
      schedule_name: string | null;
    }>();

  const totalRow = await db.prepare('SELECT COUNT(*) as cnt FROM backup_runs').first<{ cnt: number }>();

  const runs = rows.results.map((row) => ({
    id: String(row.id),
    schedule_id: row.schedule_id ? String(row.schedule_id) : null,
    schedule_name: row.schedule_name || null,
    status: row.status,
    started_at: row.started_at,
    finished_at: row.finished_at,
    backup_filename: row.backup_filename,
    bytes_total: row.bytes_total,
    error_message: row.error_message,
    log_text: null,
    targets: [],
  }));

  return c.json({
    total: totalRow?.cnt ?? 0,
    items: runs,
  });
});

/**
 * 手动触发备份
 */
backupRouter.post('/run-now', zValidator('json', RunNowSchema), async (c) => {
  const db = c.env.DB;
  const req = c.req.valid('json');
  const serverNow = nowUtc();

  const ledger = await db
    .prepare('SELECT id, external_id FROM ledgers WHERE external_id = ?')
    .bind(req.ledger_id)
    .first<{ id: string; external_id: string }>();

  if (!ledger) {
    return c.json({ error: 'Ledger not found' }, 404);
  }

  const runInsertResult2 = await db
    .prepare(
      `INSERT INTO backup_runs
       (schedule_id, ledger_id, remote_id, status, started_at)
       VALUES (NULL, ?, ?, 'pending', ?)`
    )
    .bind(ledger.id, req.remote_id ?? null, serverNow)
    .run();

  const runId = runInsertResult2.meta.last_row_id as number;

  return c.json({
    id: runId,
    ledger_id: req.ledger_id,
    remote_id: req.remote_id,
    status: 'pending',
    started_at: serverNow,
    message: 'Backup scheduled. Use /admin/backup/runs to check status.',
  }, 202);
});

/**
 * 获取备份运行状态
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

  const run = await db
    .prepare('SELECT * FROM backup_runs WHERE id = ? AND user_id = ?')
    .bind(runId, userId)
    .first();

  if (!run) {
    return c.json({ error: 'Backup run not found' }, 404);
  }

  const restore = await db
    .prepare(
      `INSERT INTO backup_restores (user_id, run_id, status, created_at)
       VALUES (?, ?, 'preparing', datetime('now'))`
    )
    .bind(userId, runId)
    .run();

  const restoreId = (restore as any).meta?.last_row_id;

  return c.json({
    id: restoreId,
    run_id: runId,
    status: 'preparing',
    created_at: new Date().toISOString(),
  });
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
  const id = c.req.param('id');

  const restore = await db
    .prepare('SELECT * FROM backup_restores WHERE id = ? AND user_id = ?')
    .bind(id, userId)
    .first();

  if (!restore) {
    return c.json({ error: 'Restore not found' }, 404);
  }

  return c.json(restore);
});

/**
 * DELETE /restores/:id - Delete restore record
 */
backupRouter.delete('/restores/:id', async (c) => {
  const db = c.env.DB;
  const userId = c.get('userId');
  const id = c.req.param('id');

  await db
    .prepare('DELETE FROM backup_restores WHERE id = ? AND user_id = ?')
    .bind(id, userId)
    .run();

  return c.json({ success: true });
});

// ---------------------------------------------------------------------------
// POST /admin/backups/upload-db - 上传数据库备份文件
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

backupRouter.post('/upload-snapshot', zValidator('json', UploadSnapshotSchema), async (c) => {
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

  return c.json({ success: true, file_name: fileName, size: jsonStr.length, checksum });
});

export default backupRouter;