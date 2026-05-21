/**
 * 附件路由模块 - 实现 BeeCount Cloud 附件上传/下载接口
 *
 * 参考原版 BeeCount-Cloud (Python/FastAPI) 的 /attachments 端点：
 * - POST   /attachments              - 上传附件
 * - GET    /attachments/:id          - 下载附件
 * - DELETE /attachments/:id          - 删除附件
 * - POST   /attachments/exists       - 批量检查附件是否存在
 *
 * 功能说明：
 * - 附件存储在外部 S3 兼容服务（如 AWS S3、MinIO、Cloudflare R2 等）
 * - 按 ledger_id 隔离附件访问权限
 * - 支持按 SHA256 去重（相同文件只存一份）
 * - 元数据存储在 D1 数据库中
 *
 * @module routes/attachments
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { randomUUID } from 'crypto';

// 从 sys_config 模块导入获取配置的函数
import { getFirstEnabledS3Config } from './sys_config';

// 简化的 S3 签名算法实现
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
    
    // 使用路径风格（path-style），兼容大多数 S3 兼容服务
    const url = `${endpoint}/${bucket}/${key}`;
    const host = new URL(endpoint).host;
    console.log('[S3] Using path style - endpoint:', endpoint, 'bucket:', bucket, 'key:', key);
    
    // 创建规范请求
    const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-amz-content-sha256:UNSIGNED-PAYLOAD\nx-amz-date:${amzDate}\n`;
    const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
    const payloadHash = 'UNSIGNED-PAYLOAD';
    
    const canonicalRequest = `${method}\n/${bucket}/${key}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
    
    console.log('[S3] Canonical Request:', JSON.stringify(canonicalRequest));
    
    // 计算字符串到签名
    const algorithm = 'AWS4-HMAC-SHA256';
    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const hashedCanonicalRequest = await sha256Hex(canonicalRequest);
    const stringToSign = `${algorithm}\n${amzDate}\n${credentialScope}\n${hashedCanonicalRequest}`;
    
    console.log('[S3] String to Sign:', JSON.stringify(stringToSign));
    
    // 计算签名
    const signingKey = await getSignatureKey(secretKey, dateStamp, region, service);
    const signature = await hmacHex(signingKey, stringToSign);
    
    console.log('[S3] Signature:', signature);
    
    // 构建授权头
    const authorizationHeader = `${algorithm} Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    
    console.log('[S3] Authorization:', authorizationHeader);
    
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

class S3Service {
    private db: D1Database;
    private env: Bindings;
    private s3ConfigCache: any = null;
    private s3ConfigCacheTime: number = 0;
    private CACHE_TTL_MS = 60000; // 缓存 1 分钟

    constructor(db: D1Database, env: Bindings) {
        this.db = db;
        this.env = env;
    }

    // 从数据库或环境变量获取 S3 配置
    private async getS3Config(): Promise<any> {
        const now = Date.now();
        
        // 检查缓存是否有效
        if (this.s3ConfigCache && (now - this.s3ConfigCacheTime) < this.CACHE_TTL_MS) {
            return this.s3ConfigCache;
        }

        try {
            // 尝试从数据库获取配置
            const dbConfig = await getFirstEnabledS3Config(this.db, this.env);
            if (dbConfig) {
                this.s3ConfigCache = dbConfig;
                this.s3ConfigCacheTime = now;
                console.log('[S3] Using config from database:', dbConfig.name);
                return dbConfig;
            }
        } catch (error) {
            console.error('[S3] Error getting config from database:', error);
        }

        // 移除从 backup_remotes 读取 S3 配置的逻辑，避免与 sys_config 冲突

        // 回退到环境变量配置
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
            console.log('[S3] Using config from environment variables');
            return envConfig;
        }

        console.log('[S3] No S3 config found');
        return null;
    }

    async isConfigured(): Promise<boolean> {
        const config = await this.getS3Config();
        return config !== null;
    }

    getStorageKey(ledgerId: string, fileId: string, fileName: string, savePath?: string): string {
        const encodedFileName = encodeURIComponent(fileName);
        const basePath = savePath && savePath !== 'custom' ? savePath.replace(/^\/+|\/+$/g, '') : 'attachments';
        return `${basePath}/${ledgerId}/${fileId}/${encodedFileName}`;
    }

    async upload(key: string, body: ArrayBuffer, contentType: string): Promise<boolean> {
        const config = await this.getS3Config();
        if (!config) {
            console.log('[S3] Not configured, skipping upload');
            return false;
        }

        console.log('[S3] Initializing upload with config:');
        console.log('[S3]   Endpoint:', config.endpoint);
        console.log('[S3]   Region:', config.region || 'us-east-1');
        console.log('[S3]   Bucket:', config.bucketName);
        console.log('[S3]   Key:', key);

        try {
            console.log('[S3] Signing request');
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

            console.log('[S3] Sending request to:', url);
            const response = await fetch(url, {
                method: 'PUT',
                headers,
                body
            });

            console.log('[S3] Response status:', response.status, response.statusText);
            
            if (!response.ok) {
                let responseText = '';
                try {
                    responseText = await response.text();
                } catch (e) {
                    responseText = '(unable to read response body)';
                }
                console.error('[S3] Upload failed:', response.status, response.statusText, responseText);
                return false;
            }

            console.log('[S3] Upload successful');
            return true;
        } catch (error: any) {
            console.error('[S3] Upload error:', error);
            return false;
        }
    }

    async download(key: string): Promise<Response | null> {
        const config = await this.getS3Config();
        if (!config) {
            return null;
        }

        try {
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

            const response = await fetch(url, {
                method: 'GET',
                headers
            });

            if (!response.ok) {
                return null;
            }

            return response;
        } catch (error) {
            console.error('[S3] Download error:', error);
            return null;
        }
    }

    async delete(key: string): Promise<boolean> {
        const config = await this.getS3Config();
        if (!config) {
            return false;
        }

        try {
            const { url, headers } = await signRequest(
                config.accessKeyId,
                config.secretAccessKey,
                config.region || 'us-east-1',
                config.endpoint,
                config.bucketName,
                key,
                'DELETE',
                'application/octet-stream',
                0
            );

            const response = await fetch(url, {
                method: 'DELETE',
                headers
            });

            return response.ok;
        } catch (error) {
            console.error('[S3] Delete error:', error);
            return false;
        }
    }
}

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

const attachmentsRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// 上传附件处理函数（供 / 和 /upload 共用）
const handleUpload = async (c: any) => {
    const userId = c.get('userId');
    const db = c.env.DB;

    const s3 = new S3Service(db, c.env);

    try {
        const formData = await c.req.formData();
        const file = formData.get('file') as File | null;
        const ledgerExternalId = formData.get('ledger_id') as string | null;
        const fileName = formData.get('file_name') as string | null;

        console.log('[ATTACHMENT] Upload request received');
        console.log('[ATTACHMENT] File:', file?.name, 'Size:', file?.size);
        console.log('[ATTACHMENT] Ledger ID:', ledgerExternalId);

        if (!file) {
            return c.json({ error: 'No file provided' }, 400);
        }

        if (!ledgerExternalId) {
            return c.json({ error: 'ledger_id is required' }, 400);
        }

        const ledger = await db
            .prepare('SELECT id, external_id FROM ledgers WHERE user_id = ? AND external_id = ?')
            .bind(userId, ledgerExternalId)
            .first<{ id: string; external_id: string }>();

        if (!ledger) {
            return c.json({ error: 'Ledger not found' }, 404);
        }

        const fileBuffer = await file.arrayBuffer();
        const hashBuffer = await crypto.subtle.digest('SHA-256', fileBuffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const sha256Hash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

        const mimeType = file.type || 'application/octet-stream';
        const actualFileName = fileName || file.name || 'unnamed';
        const size = file.size;

        const existing = await db
            .prepare(
                `SELECT id FROM attachment_files
                 WHERE sha256 = ? AND ledger_id = ? AND attachment_kind = 'transaction'`
            )
            .bind(sha256Hash, ledger.id)
            .first<{ id: string }>();

        if (existing) {
            const response = {
                file_id: existing.id,
                ledger_id: ledger.external_id,
                sha256: sha256Hash,
                size,
                mime_type: mimeType,
                file_name: actualFileName,
                created_at: new Date().toISOString()
            };
            return c.json(response);
        }

        const fileId = randomUUID();
        
        const s3Config = await s3.getS3Config();
        const savePath = s3Config?.savePath || 'attachments';
        const storageKey = s3.getStorageKey(ledger.external_id, fileId, actualFileName, savePath);

        if (await s3.isConfigured()) {
            console.log('[ATTACHMENT] Uploading to S3, key:', storageKey, 'savePath:', savePath);
            const uploadSuccess = await s3.upload(storageKey, fileBuffer, mimeType);
            console.log('[ATTACHMENT] S3 upload result:', uploadSuccess);
            if (!uploadSuccess) {
                return c.json({ error: 'Failed to upload to S3' }, 500);
            }
        }

        const now = new Date().toISOString();
        await db
            .prepare(
                `INSERT INTO attachment_files
                 (id, ledger_id, user_id, sha256, size_bytes, mime_type, file_name, storage_path, attachment_kind, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'transaction', ?)`
            )
            .bind(fileId, ledger.id, userId, sha256Hash, size, mimeType, actualFileName, storageKey, now)
            .run();

        // 写入 sync_changes 以便 APP 能同步附件信息
        await db
            .prepare(
                `INSERT INTO sync_changes
                 (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .bind(
                userId,
                ledger.id,
                'attachment',
                fileId,
                'upsert',
                JSON.stringify({
                    file_id: fileId,
                    sha256: sha256Hash,
                    size: size,
                    mime_type: mimeType,
                    file_name: actualFileName,
                }),
                now,
                userId
            )
            .run();

        const response = {
            file_id: fileId,
            ledger_id: ledger.external_id,
            sha256: sha256Hash,
            size,
            mime_type: mimeType,
            file_name: actualFileName,
            created_at: now
        };

        return c.json(response);
    } catch (error) {
        console.error('[ATTACHMENT] Upload error:', error);
        return c.json({ error: 'Failed to upload attachment' }, 500);
    }
};

// POST /attachments/upload - APP 兼容端点
attachmentsRouter.post('/upload', async (c) => {
    return handleUpload(c);
});

// POST /attachments/batch-exists - 批量检查附件是否存在
attachmentsRouter.post('/batch-exists', async (c) => {
    const userId = c.get('userId');
    const db = c.env.DB;

    try {
        const body = await c.req.json();
        const ledgerExternalId = body.ledger_id as string;
        const sha256List = body.sha256_list as string[];

        if (!ledgerExternalId || !sha256List || !Array.isArray(sha256List)) {
            return c.json({ error: 'Invalid request' }, 400);
        }

        const ledger = await db
            .prepare('SELECT id FROM ledgers WHERE user_id = ? AND external_id = ?')
            .bind(userId, ledgerExternalId)
            .first<{ id: string }>();

        if (!ledger) {
            return c.json({ exists: [] });
        }

        const results: any[] = [];
        for (const sha256 of sha256List) {
            const existing = await db
                .prepare(
                    `SELECT id, file_name, mime_type, size_bytes, created_at 
                     FROM attachment_files 
                     WHERE sha256 = ? AND ledger_id = ? AND attachment_kind = 'transaction'`
                )
                .bind(sha256, ledger.id)
                .first<{ id: string; file_name: string; mime_type: string; size_bytes: number; created_at: string }>();

            if (existing) {
                results.push({
                    sha256,
                    exists: true,
                    file_id: existing.id,
                    file_name: existing.file_name,
                    mime_type: existing.mime_type,
                    size: existing.size_bytes,
                    created_at: existing.created_at
                });
            } else {
                results.push({
                    sha256,
                    exists: false
                });
            }
        }

        return c.json({ exists: results });
    } catch (error) {
        console.error('[ATTACHMENT] Batch exists error:', error);
        return c.json({ error: 'Failed to check attachments' }, 500);
    }
});

// POST /attachments - Web 端上传附件
attachmentsRouter.post('/', async (c) => {
    return handleUpload(c);
});

// GET /attachments/:id - 下载附件
attachmentsRouter.get('/:id', async (c) => {
    const userId = c.get('userId');
    const db = c.env.DB;
    const fileId = c.req.param('id');

    const s3 = new S3Service(db, c.env);

    const row = await db
        .prepare(
            `SELECT a.id, a.sha256, a.size_bytes, a.mime_type, a.file_name, a.storage_path,
                    l.external_id as ledger_external_id
             FROM attachment_files a
             JOIN ledgers l ON a.ledger_id = l.id
             WHERE a.id = ? AND l.user_id = ?`
        )
        .bind(fileId, userId)
        .first<{
            id: string;
            sha256: string;
            size_bytes: number;
            mime_type: string | null;
            file_name: string | null;
            storage_path: string;
            ledger_external_id: string;
        }>();

    if (!row) {
        return c.json({ error: 'Attachment not found' }, 404);
    }

    if (await s3.isConfigured()) {
        const s3Response = await s3.download(row.storage_path);
        if (s3Response) {
            return new Response(s3Response.body, {
                headers: {
                    'Content-Type': row.mime_type || 'application/octet-stream',
                    'Content-Disposition': `inline; filename="${encodeURIComponent(row.file_name || 'attachment')}"`,
                    'Content-Length': String(row.size_bytes),
                },
            });
        }
    }

    return c.json({
        file_id: row.id,
        ledger_id: row.ledger_external_id,
        sha256: row.sha256,
        size: row.size_bytes,
        mime_type: row.mime_type,
        file_name: row.file_name,
        storage_path: row.storage_path,
        message: 'File content not available. Configure S3 endpoint for full support.',
    });
});

// DELETE /attachments/:id - 删除附件
attachmentsRouter.delete('/:id', async (c) => {
    const userId = c.get('userId');
    const db = c.env.DB;
    const fileId = c.req.param('id');

    const s3 = new S3Service(db, c.env);

    const row = await db
        .prepare(
            `SELECT a.id, a.storage_path, a.ledger_id FROM attachment_files a
             JOIN ledgers l ON a.ledger_id = l.id
             WHERE a.id = ? AND l.user_id = ?`
        )
        .bind(fileId, userId)
        .first<{ id: string; storage_path: string; ledger_id: string }>();

    if (!row) {
        return c.json({ error: 'Attachment not found' }, 404);
    }

    if (await s3.isConfigured()) {
        await s3.delete(row.storage_path);
    }

    await db.prepare('DELETE FROM attachment_files WHERE id = ?').bind(fileId).run();

    // 写入 sync_changes 以便 APP 能同步附件删除
    const now = new Date().toISOString();
    await db
        .prepare(
            `INSERT INTO sync_changes
             (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
            userId,
            row.ledger_id,
            'attachment',
            fileId,
            'delete',
            JSON.stringify({ file_id: fileId }),
            now,
            userId
        )
        .run();

    return c.json({ success: true });
});

// POST /attachments/exists - 批量检查附件是否存在
const AttachmentExistsRequestSchema = z.object({
    checks: z.array(z.object({
        sha256: z.string(),
        ledger_id: z.string(),
    })),
});

attachmentsRouter.post('/exists', zValidator('json', AttachmentExistsRequestSchema), async (c) => {
    const userId = c.get('userId');
    const db = c.env.DB;
    const req = c.req.valid('json');

    const results: Array<{
        sha256: string;
        exists: boolean;
        file_id: string | null;
        size: number | null;
        mime_type: string | null;
    }> = [];

    for (const check of req.checks) {
        const row = await db
            .prepare(
                `SELECT a.id, a.size_bytes, a.mime_type
                 FROM attachment_files a
                 JOIN ledgers l ON a.ledger_id = l.id
                 WHERE a.sha256 = ? AND l.external_id = ? AND l.user_id = ?`
            )
            .bind(check.sha256, check.ledger_id, userId)
            .first<{ id: string; size_bytes: number; mime_type: string | null }>();

        results.push({
            sha256: check.sha256,
            exists: !!row,
            file_id: row?.id ?? null,
            size: row?.size_bytes ?? null,
            mime_type: row?.mime_type ?? null,
        });
    }

    return c.json(results);
});

export default attachmentsRouter;
