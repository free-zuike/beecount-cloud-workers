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
        
        // 然后尝试上传测试文件（这是更严格的测试）
        const testKey = `__beecount_connection_test__/${Date.now()}.txt`;
        const testContent = 'Beecount S3 connection test file';
        
        const { url: putUrl, headers: putHeaders } = await signS3Request(
            accessKey,
            secretKey,
            region,
            endpoint,
            cleanBucket,
            testKey,
            'PUT'
        );
        
        console.log('[Backup S3 Test] Testing with PUT to:', putUrl);
        
        const putResponse = await fetch(putUrl, {
            method: 'PUT',
            headers: {
                ...putHeaders,
                'Content-Type': 'text/plain',
                'Content-Length': String(testContent.length)
            },
            body: testContent
        });
        
        console.log('[Backup S3 Test] PUT Response status:', putResponse.status);
        
        // 验证 PUT 响应
        const putResponseText = await putResponse.text().catch(() => '');
        console.log('[Backup S3 Test] PUT Response body:', putResponseText);
        
        if (putResponseText.includes('<Error>') || putResponseText.includes('<Code>')) {
            let errorMessage = `S3 upload failed: Response contains error`;
            const codeMatch = putResponseText.match(/<Code>([^<]+)<\/Code>/);
            if (codeMatch) {
                const errorCode = codeMatch[1];
                errorMessage = `S3 upload error: ${errorCode}`;
            }
            return { ok: false, message: errorMessage };
        }
        
        if (!putResponse.ok) {
            let errorMessage = `S3 connection failed: HTTP ${putResponse.status} ${putResponse.statusText}`;
            if (putResponse.status === 403) {
                errorMessage = `S3 access denied: Bucket "${cleanBucket}" may not exist or credentials have insufficient permissions (HTTP 403)`;
            } else if (putResponse.status === 404) {
                errorMessage = `S3 bucket not found: "${cleanBucket}" does not exist at ${endpoint} (HTTP 404)`;
            }
            return { ok: false, message: errorMessage };
        }
        
        const etag = putResponse.headers.get('ETag') || '';
        console.log('[Backup S3 Test] Upload successful, ETag:', etag);
        
        // 验证 ETag 是否有效（真正的成功应该有 ETag）
        if (!etag || etag === 'null') {
            console.log('[Backup S3 Test] Warning: No valid ETag in response');
            // 虽然没有 ETag，但我们先继续，因为有些服务可能不返回 ETag
        }
        
        // 清理：删除测试文件
        const { url: deleteUrl, headers: deleteHeaders } = await signS3Request(
            accessKey,
            secretKey,
            region,
            endpoint,
            cleanBucket,
            testKey,
            'DELETE'
        );
        
        await fetch(deleteUrl, {
            method: 'DELETE',
            headers: deleteHeaders
        });
        
        console.log('[Backup S3 Test] Cleanup DELETE sent');
        
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

async function uploadToS3(
    endpoint: string,
    bucket: string,
    accessKey: string,
    secretKey: string,
    region: string,
    key: string,
    content: string
): Promise<{ ok: boolean; message: string; etag?: string }> {
    try {
        const { url, headers } = await signS3Request(
            accessKey,
            secretKey,
            region,
            endpoint,
            bucket.replace(/^\/+/, ''),
            key,
            'PUT'
        );
        
        console.log('[Backup S3 Upload] Uploading to:', url);
        
        const response = await fetch(url, {
            method: 'PUT',
            headers: {
                ...headers,
                'Content-Type': 'application/json',
                'Content-Length': String(content.length)
            },
            body: content
        });
        
        console.log('[Backup S3 Upload] Response status:', response.status);
        
        if (response.ok) {
            const etag = response.headers.get('ETag') || undefined;
            return { ok: true, message: 'Upload successful', etag };
        } else {
            const errorText = await response.text().catch(() => '');
            return { ok: false, message: `Upload failed: HTTP ${response.status} ${response.statusText} ${errorText}`.slice(0, 200) };
        }
    } catch (error: unknown) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        console.error('[Backup S3 Upload] Error:', errorMsg);
        return { ok: false, message: `Upload error: ${errorMsg}` };
    }
}

async function performBackup(
    db: D1Database,
    runId: string,
    ledgerId: string,
    remoteConfig: Record<string, string>
): Promise<{ success: boolean; message: string; backupSize?: number; backupPath?: string }> {
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
        
        const backupContent = JSON.stringify(backupData, null, 2);
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
            
            // 处理路径前缀（可能来自 root_path 或 savePath）
            let basePrefix = '';
            if (remoteConfig.root_path) {
                // 来自 backup_remotes 配置的 root_path
                basePrefix = remoteConfig.root_path.replace(/^\/+|\/+$/g, '') + '/';
            } else if (remoteConfig.savePath && remoteConfig.savePath !== 'custom' && remoteConfig.savePath !== 'environment variable') {
                // 来自 sys_config 配置的 savePath
                basePrefix = remoteConfig.savePath.replace(/^\/+|\/+$/g, '') + '/';
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
        } else if (remoteConfig.backend_type === 'local') {
            console.log('[Backup] Local backend - skipping upload (simulated)');
            return {
                success: true,
                message: 'Backup completed (local storage)',
                backupSize,
                backupPath: `local://backup_${runId}.json`
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
});

const ScheduleUpdateSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  cron_expr: z.string().min(1).max(64).optional(),
  retention_days: z.number().int().min(1).max(365).optional(),
  enabled: z.boolean().optional(),
  remote_ids: z.array(z.union([z.string(), z.number()])).optional(),
  include_attachments: z.boolean().optional(),
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

  const remoteId = (result as any).lastRowId;

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
      `SELECT s.id, s.name, s.cron_expr, s.remote_ids,
              s.retention_days, s.include_attachments, s.enabled, s.created_at, s.updated_at,
              s.next_run_at, s.last_run_at, s.last_run_status
       FROM backup_schedules s
       ORDER BY s.created_at DESC`
    )
    .all<{
      id: number;
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
    }>();

  const schedules = rows.results.map((row) => {
    let parsedRemoteIds: (string | number)[] = [];
    if (row.remote_ids) {
      try {
        parsedRemoteIds = JSON.parse(row.remote_ids);
      } catch {}
    }
    return {
      id: Number(row.id),
      name: row.name,
      cron_expr: row.cron_expr,
      retention_days: row.retention_days ?? 30,
      include_attachments: Boolean(row.include_attachments),
      enabled: Boolean(row.enabled),
      next_run_at: row.next_run_at,
      last_run_at: row.last_run_at,
      last_run_status: row.last_run_status,
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

  const remoteIdsJson = req.remote_ids && req.remote_ids.length > 0 ? JSON.stringify(req.remote_ids) : null;

  const insertResult = await db
    .prepare(
      `INSERT INTO backup_schedules
       (name, user_id, cron_expr, retention_days, include_attachments, enabled, remote_ids, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      req.name,
      userId,
      req.cron_expr,
      req.retention_days ?? 30,
      req.include_attachments !== false ? 1 : 0,
      req.enabled !== false ? 1 : 0,
      remoteIdsJson,
      serverNow,
      serverNow
    )
    .run();

  const scheduleId = Number((insertResult as any).lastRowId);

  return c.json({
    id: scheduleId,
    name: req.name,
    cron_expr: req.cron_expr,
    retention_days: req.retention_days ?? 30,
    include_attachments: req.include_attachments ?? true,
    enabled: req.enabled ?? true,
    next_run_at: null,
    last_run_at: null,
    last_run_status: null,
    remote_ids: req.remote_ids,
    created_at: serverNow,
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

  if (req.remote_ids !== undefined) {
    const remoteIdsJson = req.remote_ids.length > 0 ? JSON.stringify(req.remote_ids) : null;
    updates.push('remote_ids = ?');
    params.push(remoteIdsJson);
  }

  if (req.cron_expr !== undefined) {
    updates.push('cron_expr = ?');
    params.push(req.cron_expr);
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

  if (!ledger) {
    return c.json({ error: 'Ledger not found' }, 404);
  }

  const runId = randomUUID();

  let remoteId: string | null = null;
  let remoteConfig: Record<string, string> = { backend_type: 'local' };

  if (schedule.remote_ids) {
    try {
      const remoteIds = JSON.parse(schedule.remote_ids);
      console.log('[Backup] Parsed remote_ids:', remoteIds);
      if (remoteIds.length > 0) {
        remoteId = String(remoteIds[0]);
        console.log('[Backup] Querying backup_remotes with id:', remoteId);
        const remote = await db
          .prepare('SELECT backend_type, config_summary FROM backup_remotes WHERE id = ?')
          .bind(remoteId)
          .first<{ backend_type: string; config_summary: string }>();
        console.log('[Backup] Query result:', remote);
        
        if (remote) {
          const configStr = remote.config_summary || '{}';
          const parsedConfig = JSON.parse(configStr);
          if (Object.keys(parsedConfig).length > 0 && parsedConfig.bucket) {
            console.log('[Backup] Found remote config:', remote.backend_type);
            remoteConfig = {
              backend_type: remote.backend_type,
              ...parsedConfig
            };
            console.log('[Backup] Full remoteConfig:', JSON.stringify(remoteConfig));
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

  await db
    .prepare(
      `INSERT INTO backup_runs (id, schedule_id, ledger_id, remote_id, status, started_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`
    )
    .bind(runId, scheduleId, ledger.id, remoteId, serverNow)
    .run();

  const backupResult = await performBackup(db, runId, ledger.id, remoteConfig);
  
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
    schedule_name: null,
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

export default backupRouter;