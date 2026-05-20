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

function nowUtc(): string {
  return new Date().toISOString();
}

// ===========================
// S3 签名辅助函数
// ===========================

async function signS3Request(
    accessKey: string,
    secretKey: string,
    region: string,
    endpoint: string,
    bucket: string,
    key: string,
    method: string
): Promise<{ url: string; headers: Record<string, string> }> {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:\-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const service = 's3';
    
    const url = `${endpoint}/${bucket}/${key}`;
    const host = new URL(endpoint).host;
    
    const canonicalHeaders = `host:${host}\nx-amz-content-sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\nx-amz-date:${amzDate}\n`;
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
    const payloadHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    
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
            'Host': host,
            'x-amz-date': amzDate,
            'x-amz-content-sha256': payloadHash,
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

async function testS3Connection(
    endpoint: string,
    bucket: string,
    accessKey: string,
    secretKey: string,
    region: string
): Promise<{ ok: boolean; message: string }> {
    try {
        const { url, headers } = await signS3Request(
            accessKey,
            secretKey,
            region,
            endpoint,
            bucket.replace(/^\/+/, ''),
            '',
            'HEAD'
        );
        
        console.log('[Backup S3 Test] Testing connection to:', url);
        
        const response = await fetch(url, {
            method: 'HEAD',
            headers
        });
        
        console.log('[Backup S3 Test] Response status:', response.status);
        
        if (response.ok) {
            return { ok: true, message: `S3 connection successful: ${bucket} at ${endpoint}` };
        } else {
            const errorText = await response.text().catch(() => '');
            return { ok: false, message: `S3 connection failed: HTTP ${response.status} ${response.statusText} ${errorText}`.slice(0, 200) };
        }
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        console.error('[Backup S3 Test] Error:', errorMsg);
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
  ledger_id: z.string(),
  remote_id: z.string().optional().nullable(),
  cron_expression: z.string().min(1).max(64),
  retention_days: z.number().int().min(1).max(365).optional(),
  enabled: z.boolean().optional(),
});

const ScheduleUpdateSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  remote_id: z.string().nullable().optional(),
  cron_expression: z.string().min(1).max(64).optional(),
  retention_days: z.number().int().min(1).max(365).optional(),
  enabled: z.boolean().optional(),
});

const RunNowSchema = z.object({
  ledger_id: z.string(),
  remote_id: z.string().optional(),
});

type Bindings = {
  DB: D1Database;
  JWT_SECRET: string;
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
// 远程配置管理
// ---------------------------------------------------------------------------

/**
 * 列出所有备份远程配置
 */
backupRouter.get('/remotes', async (c) => {
  const db = c.env.DB;

  const rows = await db
    .prepare(
      `SELECT id, name, backend_type, config_summary, encrypted, created_at, updated_at
       FROM backup_remotes
       ORDER BY created_at DESC`
    )
    .all<{
      id: number;
      name: string;
      backend_type: string;
      config_summary: string;
      encrypted: number;
      created_at: string;
      updated_at: string;
    }>();

  const remotes = rows.results.map((row) => {
    const config = JSON.parse(row.config_summary || '{}');
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
      encrypted: Boolean(row.encrypted),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  });

  return c.json(remotes);
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

  const remoteId = result.lastRowId;

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
      id: number;
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
      id: number;
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
      id: number;
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
          testResult.message = 'Bucket name is required';
        } else if (!s3AccessKey || !s3SecretKey) {
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

      default:
        testResult.message = `Unknown backend type: ${remote.backend_type}`;
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
          testResult.message = 'Bucket name is required';
        } else if (!s3AccessKey || !s3SecretKey) {
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

  const rows = await db
    .prepare(
      `SELECT s.id, s.name, s.user_id, s.cron_expr,
              s.retention_days, s.enabled, s.created_at, s.updated_at,
              s.next_run_at, s.last_run_at, s.last_run_status
       FROM backup_schedules s
       ORDER BY s.created_at DESC`
    )
    .all<{
      id: number;
      name: string;
      user_id: string;
      cron_expr: string;
      retention_days: number | null;
      enabled: number;
      created_at: string;
      updated_at: string;
      next_run_at: string | null;
      last_run_at: string | null;
      last_run_status: string | null;
    }>();

  const schedules = rows.results.map((row) => ({
    id: String(row.id),
    name: row.name,
    ledger_id: '',
    remote_id: null,
    remote_name: null,
    cron_expression: row.cron_expr,
    retention_days: row.retention_days ?? 30,
    enabled: Boolean(row.enabled),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));

  return c.json(schedules);
});

/**
 * 创建备份调度
 */
backupRouter.post('/schedules', zValidator('json', ScheduleCreateSchema), async (c) => {
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

  const scheduleId = randomUUID();

  await db
    .prepare(
      `INSERT INTO backup_schedules
       (id, name, ledger_id, remote_id, cron_expression, retention_days, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      scheduleId,
      req.name,
      ledger.id,
      req.remote_id ?? null,
      req.cron_expression,
      req.retention_days ?? 30,
      req.enabled !== false ? 1 : 0,
      serverNow,
      serverNow
    )
    .run();

  return c.json({
    id: scheduleId,
    name: req.name,
    ledger_id: req.ledger_id,
    remote_id: req.remote_id,
    cron_expression: req.cron_expression,
    retention_days: req.retention_days ?? 30,
    enabled: req.enabled ?? true,
    created_at: serverNow,
    updated_at: serverNow,
  }, 201);
});

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

  if (req.remote_id !== undefined) {
    updates.push('remote_id = ?');
    params.push(req.remote_id);
  }

  if (req.cron_expression !== undefined) {
    updates.push('cron_expr = ?');
    params.push(req.cron_expression);
  }

  if (req.retention_days !== undefined) {
    updates.push('retention_days = ?');
    params.push(req.retention_days);
  }

  if (req.enabled !== undefined) {
    updates.push('enabled = ?');
    params.push(req.enabled ? 1 : 0);
  }

  params.push(scheduleId);

  await db
    .prepare(`UPDATE backup_schedules SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...params)
    .run();

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
              r.backup_filename
       FROM backup_runs r
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
    }>();

  const totalRow = await db.prepare('SELECT COUNT(*) as cnt FROM backup_runs').first<{ cnt: number }>();

  const runs = rows.results.map((row) => ({
    id: String(row.id),
    schedule_id: row.schedule_id ? String(row.schedule_id) : null,
    ledger_id: '',
    remote_id: null,
    remote_name: null,
    status: row.status,
    started_at: row.started_at,
    completed_at: row.finished_at,
    error_message: row.error_message,
    backup_size: row.bytes_total,
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

  const runId = randomUUID();

  await db
    .prepare(
      `INSERT INTO backup_runs
       (id, schedule_id, ledger_id, remote_id, status, started_at)
       VALUES (?, NULL, ?, ?, 'pending', ?)`
    )
    .bind(runId, ledger.id, req.remote_id ?? null, serverNow)
    .run();

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
    ledger_id: '',
    remote_id: null,
    remote_name: null,
    status: row.status,
    started_at: row.started_at,
    completed_at: row.finished_at,
    error_message: row.error_message,
    backup_size: row.bytes_total,
  });
});

export default backupRouter;
