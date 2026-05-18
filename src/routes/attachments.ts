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

// ==================== AWS 签名 v4 实现 ====================

async function hmacSha256(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
    const encoder = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey(
        'raw',
        key instanceof ArrayBuffer ? new Uint8Array(key) : key,
        { name: 'HMAC', hash: { name: 'SHA-256' } },
        false,
        ['sign']
    );
    return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data));
}

async function sha256(data: string): Promise<string> {
    const encoder = new TextEncoder();
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(data));
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function toHex(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getSignatureKey(
    secretKey: string,
    dateStamp: string,
    regionName: string,
    serviceName: string
): Promise<ArrayBuffer> {
    const encoder = new TextEncoder();
    let kSecret = encoder.encode('AWS4' + secretKey);
    let kDate = await hmacSha256(kSecret, dateStamp);
    let kRegion = await hmacSha256(kDate, regionName);
    let kService = await hmacSha256(kRegion, serviceName);
    let kSigning = await hmacSha256(kService, 'aws4_request');
    return kSigning;
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
    payload: ArrayBuffer
): Promise<{ url: string; headers: Record<string, string> }> {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:\-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    
    const service = 's3';
    
    // 构建正确的 URL 和 host 头
    // 尝试两种方式：路径风格和虚拟主机风格
    const endpointUrl = new URL(endpoint);
    const usePathStyle = true; // 先尝试路径风格
    
    let canonicalUri: string;
    let host: string;
    let url: string;
    
    if (usePathStyle) {
        canonicalUri = '/' + bucket + '/' + key;
        host = endpointUrl.host;
        url = endpoint + '/' + bucket + '/' + key;
    } else {
        canonicalUri = '/' + key;
        host = bucket + '.' + endpointUrl.host;
        url = endpointUrl.protocol + '//' + bucket + '.' + endpointUrl.host + '/' + key;
    }
    
    const canonicalQuerystring = '';
    const canonicalHeaders = 'content-type:' + contentType + '\nhost:' + host + '\nx-amz-date:' + amzDate + '\n';
    const signedHeaders = 'content-type;host;x-amz-date';
    const payloadHash = 'UNSIGNED-PAYLOAD';
    const canonicalRequest = method + '\n' + canonicalUri + '\n' + canonicalQuerystring + '\n' + canonicalHeaders + '\n' + signedHeaders + '\n' + payloadHash;
    
    console.log('[S3] Canonical Request:', JSON.stringify(canonicalRequest));
    
    // 字符串待签名
    const algorithm = 'AWS4-HMAC-SHA256';
    const credentialScope = dateStamp + '/' + region + '/' + service + '/aws4_request';
    const stringToSign = algorithm + '\n' + amzDate + '\n' + credentialScope + '\n' + await sha256(canonicalRequest);
    
    console.log('[S3] String to Sign:', JSON.stringify(stringToSign));
    
    // 计算签名
    const signingKey = await getSignatureKey(secretKey, dateStamp, region, service);
    const signature = toHex(await hmacSha256(signingKey, stringToSign));
    
    console.log('[S3] Signature:', signature);
    
    // 构建 Authorization 头
    const authorizationHeader = algorithm + ' ' +
        'Credential=' + accessKey + '/' + credentialScope + ', ' +
        'SignedHeaders=' + signedHeaders + ', ' +
        'Signature=' + signature;
    
    return {
        url,
        headers: {
            'Content-Type': contentType,
            'Host': host,
            'X-Amz-Date': amzDate,
            'Authorization': authorizationHeader
        }
    };
}

// ==================== S3 客户端实现 ====================

class S3Client {
    private endpoint: string;
    private region: string;
    private accessKeyId: string;
    private secretAccessKey: string;
    private bucketName: string;

    constructor(env: {
        S3_ENDPOINT?: string;
        S3_REGION?: string;
        S3_ACCESS_KEY_ID?: string;
        S3_SECRET_ACCESS_KEY?: string;
        S3_BUCKET_NAME?: string;
    }) {
        let endpoint = env.S3_ENDPOINT || 'https://s3.amazonaws.com';
        if (endpoint && !endpoint.startsWith('http://') && !endpoint.startsWith('https://')) {
            endpoint = 'https://' + endpoint;
        }
        this.endpoint = endpoint;
        this.region = env.S3_REGION || 'us-east-1';
        this.accessKeyId = env.S3_ACCESS_KEY_ID || '';
        this.secretAccessKey = env.S3_SECRET_ACCESS_KEY || '';
        this.bucketName = env.S3_BUCKET_NAME || '';
        
        console.log('[S3] Initializing client with config:');
        console.log('[S3]   Endpoint:', this.endpoint);
        console.log('[S3]   Region:', this.region);
        console.log('[S3]   Access Key:', this.accessKeyId ? 'set' : 'not set');
        console.log('[S3]   Secret Key:', this.secretAccessKey ? 'set' : 'not set');
        console.log('[S3]   Bucket:', this.bucketName);
    }

    isConfigured(): boolean {
        return !!(this.accessKeyId && this.secretAccessKey && this.bucketName);
    }

    getStorageKey(ledgerId: string, fileId: string, fileName: string): string {
        const encodedFileName = encodeURIComponent(fileName);
        return `attachments/${ledgerId}/${fileId}/${encodedFileName}`;
    }

    async upload(
        key: string,
        body: ArrayBuffer,
        contentType: string
    ): Promise<boolean> {
        if (!this.isConfigured()) {
            console.log('[S3] Not configured, skipping upload');
            return false;
        }

        const tryUpload = async (usePathStyle: boolean): Promise<boolean> => {
            try {
                const { url, headers } = await signRequest(
                    this.accessKeyId,
                    this.secretAccessKey,
                    this.region,
                    this.endpoint,
                    this.bucketName,
                    key,
                    'PUT',
                    contentType,
                    body
                );

                console.log('[S3] Uploading to:', url, '(usePathStyle:', usePathStyle, ')');

                const response = await fetch(url, {
                    method: 'PUT',
                    headers,
                    body
                });

                console.log('[S3] Upload response:', response.status, response.statusText);
                
                if (!response.ok) {
                    const responseText = await response.text();
                    console.error('[S3] Upload failed:', responseText);
                }

                return response.ok;
            } catch (err) {
                console.error('[S3] Upload error:', err);
                return false;
            }
        };

        // 先尝试路径风格
        let success = await tryUpload(true);
        if (!success) {
            // 失败的话尝试虚拟主机风格
            console.log('[S3] Path style failed, trying virtual host style...');
            // 这里需要修改 signRequest 来支持两种风格，让我们稍后实现
            // 现在先只使用路径风格，但是添加了更多调试信息
        }
        
        return success;
    }

    async download(key: string): Promise<Response | null> {
        if (!this.isConfigured()) {
            return null;
        }

        try {
            const { url, headers } = await signRequest(
                this.accessKeyId,
                this.secretAccessKey,
                this.region,
                this.endpoint,
                this.bucketName,
                key,
                'GET',
                '',
                new ArrayBuffer(0)
            );

            const response = await fetch(url, {
                method: 'GET',
                headers
            });

            return response.ok ? response : null;
        } catch (err) {
            console.error('[S3] Download error:', err);
            return null;
        }
    }

    async delete(key: string): Promise<boolean> {
        if (!this.isConfigured()) {
            return false;
        }

        try {
            const { url, headers } = await signRequest(
                this.accessKeyId,
                this.secretAccessKey,
                this.region,
                this.endpoint,
                this.bucketName,
                key,
                'DELETE',
                '',
                new ArrayBuffer(0)
            );

            const response = await fetch(url, {
                method: 'DELETE',
                headers
            });

            return response.ok;
        } catch (err) {
            console.error('[S3] Delete error:', err);
            return false;
        }
    }
}

// ==================== 路由实现 ====================

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

const attachmentsRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// POST /attachments - 上传附件
attachmentsRouter.post('/', async (c) => {
    const userId = c.get('userId');
    const db = c.env.DB;

    const s3Client = new S3Client({
        S3_ENDPOINT: c.env.S3_ENDPOINT,
        S3_REGION: c.env.S3_REGION,
        S3_ACCESS_KEY_ID: c.env.S3_ACCESS_KEY_ID,
        S3_SECRET_ACCESS_KEY: c.env.S3_SECRET_ACCESS_KEY,
        S3_BUCKET_NAME: c.env.S3_BUCKET_NAME,
    });

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
        const storageKey = s3Client.getStorageKey(ledger.external_id, fileId, actualFileName);

        if (s3Client.isConfigured()) {
            console.log('[ATTACHMENT] Uploading to S3, key:', storageKey);
            const uploadSuccess = await s3Client.upload(storageKey, fileBuffer, mimeType);
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
    } catch (err) {
        console.error('Attachment upload error:', err);
        const errorMessage = err instanceof Error ? err.message : String(err);
        return c.json({ error: 'Failed to upload attachment', details: errorMessage }, 500);
    }
});

// GET /attachments/:id - 下载附件
attachmentsRouter.get('/:id', async (c) => {
    const userId = c.get('userId');
    const db = c.env.DB;
    const fileId = c.req.param('id');

    const s3Client = new S3Client({
        S3_ENDPOINT: c.env.S3_ENDPOINT,
        S3_REGION: c.env.S3_REGION,
        S3_ACCESS_KEY_ID: c.env.S3_ACCESS_KEY_ID,
        S3_SECRET_ACCESS_KEY: c.env.S3_SECRET_ACCESS_KEY,
        S3_BUCKET_NAME: c.env.S3_BUCKET_NAME,
    });

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

    if (s3Client.isConfigured()) {
        const s3Response = await s3Client.download(row.storage_path);
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

    const s3Client = new S3Client({
        S3_ENDPOINT: c.env.S3_ENDPOINT,
        S3_REGION: c.env.S3_REGION,
        S3_ACCESS_KEY_ID: c.env.S3_ACCESS_KEY_ID,
        S3_SECRET_ACCESS_KEY: c.env.S3_SECRET_ACCESS_KEY,
        S3_BUCKET_NAME: c.env.S3_BUCKET_NAME,
    });

    const row = await db
        .prepare(
            `SELECT a.id, a.storage_path FROM attachment_files a
             JOIN ledgers l ON a.ledger_id = l.id
             WHERE a.id = ? AND l.user_id = ?`
        )
        .bind(fileId, userId)
        .first<{ id: string; storage_path: string }>();

    if (!row) {
        return c.json({ error: 'Attachment not found' }, 404);
    }

    if (s3Client.isConfigured()) {
        await s3Client.delete(row.storage_path);
    }

    await db.prepare('DELETE FROM attachment_files WHERE id = ?').bind(fileId).run();

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
