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
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

class S3Service {
    private env: {
        S3_ENDPOINT?: string;
        S3_REGION?: string;
        S3_ACCESS_KEY_ID?: string;
        S3_SECRET_ACCESS_KEY?: string;
        S3_BUCKET_NAME?: string;
    };

    constructor(env: {
        S3_ENDPOINT?: string;
        S3_REGION?: string;
        S3_ACCESS_KEY_ID?: string;
        S3_SECRET_ACCESS_KEY?: string;
        S3_BUCKET_NAME?: string;
    }) {
        this.env = env;
    }

    isConfigured(): boolean {
        return !!(
            this.env.S3_ACCESS_KEY_ID &&
            this.env.S3_SECRET_ACCESS_KEY &&
            this.env.S3_BUCKET_NAME &&
            this.env.S3_ENDPOINT
        );
    }

    private getClient(forcePathStyle: boolean): S3Client {
        return new S3Client({
            region: this.env.S3_REGION || 'auto',
            endpoint: this.env.S3_ENDPOINT,
            credentials: {
                accessKeyId: this.env.S3_ACCESS_KEY_ID!,
                secretAccessKey: this.env.S3_SECRET_ACCESS_KEY!,
            },
            forcePathStyle: forcePathStyle
        });
    }

    getStorageKey(ledgerId: string, fileId: string, fileName: string): string {
        const encodedFileName = encodeURIComponent(fileName);
        return `attachments/${ledgerId}/${fileId}/${encodedFileName}`;
    }

    async upload(key: string, body: ArrayBuffer, contentType: string): Promise<boolean> {
        if (!this.isConfigured()) {
            console.log('[S3] Not configured, skipping upload');
            return false;
        }

        console.log('[S3] Initializing upload with config:');
        console.log('[S3]   Endpoint:', this.env.S3_ENDPOINT);
        console.log('[S3]   Region:', this.env.S3_REGION || 'auto');
        console.log('[S3]   Bucket:', this.env.S3_BUCKET_NAME);
        console.log('[S3]   Key:', key);

        const uint8Array = new Uint8Array(body);

        // 先尝试路径风格
        let client = this.getClient(true);
        try {
            console.log('[S3] Trying path-style upload');
            const command = new PutObjectCommand({
                Bucket: this.env.S3_BUCKET_NAME,
                Key: key,
                Body: uint8Array,
                ContentType: contentType
            });
            await client.send(command);
            console.log('[S3] Path-style upload succeeded');
            return true;
        } catch (error: any) {
            console.error('[S3] Path-style upload failed:', error);
            console.error('[S3] Error details:', JSON.stringify({
                name: error.name,
                message: error.message,
                $metadata: error.$metadata,
                cause: error.cause
            }, null, 2));
            
            // 失败的话尝试虚拟主机风格
            console.log('[S3] Trying virtual-host-style upload');
            client = this.getClient(false);
            try {
                const command = new PutObjectCommand({
                    Bucket: this.env.S3_BUCKET_NAME,
                    Key: key,
                    Body: uint8Array,
                    ContentType: contentType
                });
                await client.send(command);
                console.log('[S3] Virtual-host-style upload succeeded');
                return true;
            } catch (error2: any) {
                console.error('[S3] Virtual-host-style upload also failed:', error2);
                console.error('[S3] Error 2 details:', JSON.stringify({
                    name: error2.name,
                    message: error2.message,
                    $metadata: error2.$metadata,
                    cause: error2.cause
                }, null, 2));
                return false;
            }
        }
    }

    async download(key: string): Promise<Response | null> {
        if (!this.isConfigured()) {
            return null;
        }

        // 先尝试路径风格
        let client = this.getClient(true);
        try {
            const command = new GetObjectCommand({
                Bucket: this.env.S3_BUCKET_NAME,
                Key: key
            });
            const response = await client.send(command);
            if (response.Body) {
                const arrayBuffer = await response.Body.transformToByteArray();
                return new Response(arrayBuffer);
            }
            return null;
        } catch (error) {
            console.error('[S3] Path-style download failed:', error);
            
            // 失败的话尝试虚拟主机风格
            client = this.getClient(false);
            try {
                const command = new GetObjectCommand({
                    Bucket: this.env.S3_BUCKET_NAME,
                    Key: key
                });
                const response = await client.send(command);
                if (response.Body) {
                    const arrayBuffer = await response.Body.transformToByteArray();
                    return new Response(arrayBuffer);
                }
                return null;
            } catch (error2) {
                console.error('[S3] Virtual-host-style download also failed:', error2);
                return null;
            }
        }
    }

    async delete(key: string): Promise<boolean> {
        if (!this.isConfigured()) {
            return false;
        }

        // 先尝试路径风格
        let client = this.getClient(true);
        try {
            const command = new DeleteObjectCommand({
                Bucket: this.env.S3_BUCKET_NAME,
                Key: key
            });
            await client.send(command);
            return true;
        } catch (error) {
            console.error('[S3] Path-style delete failed:', error);
            
            // 失败的话尝试虚拟主机风格
            client = this.getClient(false);
            try {
                const command = new DeleteObjectCommand({
                    Bucket: this.env.S3_BUCKET_NAME,
                    Key: key
                });
                await client.send(command);
                return true;
            } catch (error2) {
                console.error('[S3] Virtual-host-style delete also failed:', error2);
                return false;
            }
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
};

type Variables = {
    userId: string;
};

const attachmentsRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// POST /attachments - 上传附件
attachmentsRouter.post('/', async (c) => {
    const userId = c.get('userId');
    const db = c.env.DB;

    const s3 = new S3Service({
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
        const storageKey = s3.getStorageKey(ledger.external_id, fileId, actualFileName);

        if (s3.isConfigured()) {
            console.log('[ATTACHMENT] Uploading to S3, key:', storageKey);
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
});

// GET /attachments/:id - 下载附件
attachmentsRouter.get('/:id', async (c) => {
    const userId = c.get('userId');
    const db = c.env.DB;
    const fileId = c.req.param('id');

    const s3 = new S3Service({
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

    if (s3.isConfigured()) {
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

    const s3 = new S3Service({
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

    if (s3.isConfigured()) {
        await s3.delete(row.storage_path);
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
