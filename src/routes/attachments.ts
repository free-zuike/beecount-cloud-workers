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
import { serverLogger } from '../lib/logger';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { uploadToStorage, downloadFromStorage, deleteFromStorage } from '../lib/storage-adapter';

// 附件统一以 attachments/{ledgerExternalId}/{fileId}_{fileName} 为 key
// （storage-adapter 内部会自动加 beecount/ 前缀，key 本身不含该前缀）
// 下载历史数据时可能遇到含 beecount/ 前缀的旧路径，需去掉后传给 adapter
function stripBeecountPrefix(key: string): string {
  return key.replace(/^beecount\//, '').replace(/^attachments\/attachments\//, 'attachments/');
}

type Bindings = {
  DB: D1Database;
  JWT_SECRET: string;
  R2?: R2Bucket;
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

    try {
        const formData = await c.req.formData();
        const file = formData.get('file') as File | null;
        const ledgerExternalId = formData.get('ledger_id') as string | null;
        const fileName = formData.get('file_name') as string | null;

        serverLogger.info('src.routers.attachments', '[ATTACHMENT] Upload request received');
        serverLogger.info('src.routers.attachments', '[ATTACHMENT] File:', file?.name, 'Size:', file?.size);
        serverLogger.info('src.routers.attachments', '[ATTACHMENT] Ledger ID:', ledgerExternalId);

        if (!file) {
            return c.json({ error: 'No file provided' }, 400);
        }

        // 文件大小限制（与原版对齐，默认 50MB）
        const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
        if (file.size > MAX_UPLOAD_BYTES) {
            return c.json({ error: `File too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024}MB)` }, 413);
        }

        if (!ledgerExternalId) {
            return c.json({ error: 'ledger_id is required' }, 400);
        }

        let ledger = await db
            .prepare('SELECT id, external_id FROM ledgers WHERE user_id = ? AND external_id = ?')
            .bind(userId, ledgerExternalId)
            .first() as { id: string; external_id: string } | null;

        // 尝试共享账本 — 与原版 _resolve_ledger 对齐
        if (!ledger) {
            ledger = await db
                .prepare('SELECT l.id, l.external_id FROM ledgers l JOIN ledger_members lm ON l.id = lm.ledger_id WHERE lm.user_id = ? AND l.external_id = ?')
                .bind(userId, ledgerExternalId)
                .first() as { id: string; external_id: string } | null;
        }

        if (!ledger) {
            return c.json({ error: 'Ledger not found' }, 404);
        }

        const fileBuffer = await file.arrayBuffer();
        const hashBuffer = await crypto.subtle.digest('SHA-256', fileBuffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const sha256Hash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

        const mimeType = file.type || 'application/octet-stream';
        // 文件名安全处理：截断255字符，去除路径分隔符，清理非法字符
        const rawFileName = fileName || file.name || 'unnamed';
        const safeFileName = rawFileName
            .replace(/^.*[/\\]/, '')  // 去除路径前缀
            .substring(0, 255)       // 截断到255字符
            .replace(/[^\w\s.\-()]/g, '_');  // 替换非法字符
        const actualFileName = safeFileName || 'unnamed';
        const size = file.size;

        const existing = await db
            .prepare(
                `SELECT id FROM attachment_files
                 WHERE sha256 = ? AND ledger_id = ? AND attachment_kind = 'transaction'`
            )
            .bind(sha256Hash, ledger.id)
            .first() as { id: string } | null;

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
        
        // 统一附件 key：attachments/{ledgerExternalId}/{fileId}_{fileName}
        // storage-adapter 内部会加 beecount/ 前缀并回退到所有备份远端
        const storageKey = `attachments/${ledger.external_id}/${fileId}_${actualFileName}`;
        const uploadResult = await uploadToStorage(db, c.env, storageKey, new Uint8Array(fileBuffer), mimeType);
        if (!uploadResult.ok) {
            serverLogger.error('src.routers.attachments', '[ATTACHMENT] Upload failed: no available storage', { storageKey });
            return c.json({ error: 'Failed to upload attachment (no available storage)' }, 503);
        }
        serverLogger.info('src.routers.attachments', '[ATTACHMENT] Upload ok:', storageKey);

        const now = new Date().toISOString();
        await db
            .prepare(
                `INSERT INTO attachment_files
                 (id, ledger_id, user_id, sha256, size_bytes, mime_type, file_name, storage_path, attachment_kind, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'transaction', ?)`
            )
            .bind(fileId, ledger.id, userId, sha256Hash, size, mimeType, actualFileName, storageKey, now)
            .run();

        // 并发去重兜底：多个请求同时上传同一文件时（去重检查与 INSERT 之间
        // 是竞态），统一返回最早插入的那行 id，避免同一文件出现多个 file_id。
        // 重复行可在后续数据清理中合并。
        const canonical = await db
            .prepare(
                `SELECT id FROM attachment_files
                 WHERE sha256 = ? AND ledger_id = ? AND attachment_kind = 'transaction'
                 ORDER BY created_at ASC, id ASC LIMIT 1`
            )
            .bind(sha256Hash, ledger.id)
            .first() as { id: string } | null;
        const effectiveFileId = canonical?.id ?? fileId;

        // 对齐原版：附件不写 sync_changes（App 不识别 attachment 实体类型，
        // 附件信息通过交易 payload 的 attachments 字段同步）

        const response = {
            file_id: effectiveFileId,
            ledger_id: ledger.external_id,
            sha256: sha256Hash,
            size,
            mime_type: mimeType,
            file_name: actualFileName,
            created_at: now
        };

        return c.json(response);
    } catch (error) {
        serverLogger.error('src.routers.attachments', '[ATTACHMENT] Upload error:', error);
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

        let ledger = await db
            .prepare('SELECT id FROM ledgers WHERE user_id = ? AND external_id = ?')
            .bind(userId, ledgerExternalId)
            .first<{ id: string }>();

        // 支持共享账本
        if (!ledger) {
            ledger = await db
                .prepare('SELECT l.id FROM ledgers l JOIN ledger_members lm ON l.id = lm.ledger_id WHERE lm.user_id = ? AND l.external_id = ?')
                .bind(userId, ledgerExternalId)
                .first<{ id: string }>();
        }

        if (!ledger) {
            return c.json({ exists: [] });
        }

        const results: any[] = [];
        for (const rawSha256 of sha256List) {
            // SHA256 归一化：去除空白、转小写（与原版对齐）
            const sha256 = rawSha256.trim().toLowerCase();
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
        serverLogger.error('src.routers.attachments', '[ATTACHMENT] Batch exists error:', error);
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

    // 速率限制
    const { isRateLimited } = await import('../lib/rate-limit');
    const clientIp = c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown';
    if (isRateLimited('attachment-download', clientIp, 60, 60)) {
        return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    const row = await db
        .prepare(
            `SELECT a.id, a.sha256, a.size_bytes, a.mime_type, a.file_name, a.storage_path,
                    a.ledger_id, l.external_id as ledger_external_id
             FROM attachment_files a
             LEFT JOIN ledgers l ON a.ledger_id = l.id
             LEFT JOIN ledger_members lm ON l.id = lm.ledger_id
             WHERE a.id = ? AND (a.user_id = ? OR l.user_id = ? OR lm.user_id = ?)`
        )
        .bind(fileId, userId, userId, userId)
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

    // 先尝试 R2（附件存储在 R2 bucket）
    serverLogger.info('src.routers.attachments', '[ATTACH] R2 available:', !!c.env.R2, 'storage_path:', row.storage_path);
    if (c.env.R2) {
        // 优先用 DB 中的 storage_path（已含 beecount/ 前缀），回退尝试其他格式
        const normalizedPath = row.storage_path.replace(/^attachments\/attachments\//, 'attachments/');
        // DB 路径格式: beecount/attachments/{ledgerId}/{fileId}/{fileName}
        // R2 实际路径格式: beecount/attachments/{ledgerId}/{fileId}_{fileName}
        const r2Key = `beecount/attachments/${row.ledger_external_id}/${row.id}_${row.file_name}`;
        const possiblePaths = [
            row.storage_path,                    // DB 中的完整路径 (beecount/attachments/...)
            normalizedPath,                      // 去双重前缀
            `beecount/${normalizedPath}`,        // 加前缀
            r2Key,                               // R2 实际格式: {ledgerId}/{fileId}_{fileName}
            `attachments/${row.ledger_external_id}/${row.id}_${row.file_name}`,
            `beecount/attachments/${row.id}_${row.file_name}`,
        ];
        for (const key of possiblePaths) {
            if (!key) continue;
            serverLogger.info('src.routers.attachments', '[ATTACH] Trying R2 key:', key);
            const obj = await c.env.R2.get(key);
            if (obj) {
                const ext = (row.file_name || '').split('.').pop()?.toLowerCase() || '';
                const mimeGuess = ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : (obj.httpMetadata?.contentType || row.mime_type || 'application/octet-stream');
                serverLogger.info('src.routers.attachments', '[ATTACH] R2 found:', key, 'size:', obj.size, 'mime:', mimeGuess);
                return new Response(obj.body, {
                    headers: {
                        'Content-Type': mimeGuess,
                        'Content-Disposition': `inline; filename="${encodeURIComponent(row.file_name || 'attachment')}"`,
                        'Content-Length': String(obj.size),
                        'Cache-Control': 'public, max-age=31536000, immutable',
                        'Access-Control-Allow-Origin': '*',
                    },
                });
            }
        }
    }
    // R2 未命中：回退到 storage-adapter（自动遍历所有备份远端 S3/B2/WebDAV/FTP/SFTP）
    const fallbackKey = stripBeecountPrefix(row.storage_path);
    serverLogger.info('src.routers.attachments', '[ATTACH] R2 not found, trying backup remotes:', fallbackKey);
    const data = await downloadFromStorage(db, c.env, fallbackKey);
    if (data) {
        const ext = (row.file_name || '').split('.').pop()?.toLowerCase() || '';
        const mimeGuess = ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : (row.mime_type || 'application/octet-stream');
        return new Response(data.slice().buffer as ArrayBuffer, {
            headers: {
                'Content-Type': mimeGuess,
                'Content-Disposition': `inline; filename="${encodeURIComponent(row.file_name || 'attachment')}"`,
                'Content-Length': String(data.byteLength),
                'Cache-Control': 'public, max-age=31536000, immutable',
                'Access-Control-Allow-Origin': '*',
            },
        });
    }
    serverLogger.info('src.routers.attachments', '[ATTACH] Not found in R2 or backup remotes, returning metadata');
    return c.json({
        ledger_id: row.ledger_external_id,
        sha256: row.sha256,
        size: row.size_bytes,
        mime_type: row.mime_type,
        file_name: row.file_name,
        storage_path: row.storage_path,
        message: 'File content not available. Configure R2 or a backup remote for full support.',
    });
});

// DELETE /attachments/:id - 删除附件
attachmentsRouter.delete('/:id', async (c) => {
    const userId = c.get('userId');
    const db = c.env.DB;
    const fileId = c.req.param('id');

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

    // 从 R2 + 所有备份远端删除
    await deleteFromStorage(db, c.env, stripBeecountPrefix(row.storage_path));

    await db.prepare('DELETE FROM attachment_files WHERE id = ?').bind(fileId).run();

    // 对齐原版：附件删除不写 sync_changes（App 不识别 attachment 实体类型）

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

// POST /attachments/category-icons/upload - 分类图标上传（user-global，无 ledger_id）
attachmentsRouter.post('/category-icons/upload', async (c) => {
    const userId = c.get('userId');
    const db = c.env.DB;

    try {
        const formData = await c.req.formData();
        const file = formData.get('file') as File | null;

        if (!file) {
            return c.json({ error: 'No file provided' }, 400);
        }

        const MAX_ICON_BYTES = 5 * 1024 * 1024;
        if (file.size > MAX_ICON_BYTES) {
            return c.json({ error: 'Icon too large (max 5MB)' }, 413);
        }

        const fileBuffer = await file.arrayBuffer();
        const hashBuffer = await crypto.subtle.digest('SHA-256', fileBuffer);
        const sha256Hash = Array.from(new Uint8Array(hashBuffer))
            .map(b => b.toString(16).padStart(2, '0')).join('');
        const mimeType = file.type || 'image/png';
        const fileName = file.name || 'icon.png';
        // 如果 MIME 类型是通用类型，根据文件扩展名推断实际类型
        const effectiveMimeType = mimeType === 'application/octet-stream' || mimeType === 'application/octet-stream'
            ? (fileName.endsWith('.png') ? 'image/png'
                : fileName.endsWith('.jpg') || fileName.endsWith('.jpeg') ? 'image/jpeg'
                : fileName.endsWith('.gif') ? 'image/gif'
                : fileName.endsWith('.webp') ? 'image/webp'
                : 'image/png')
            : mimeType;
        const size = file.size;

        // 去重：同一用户同SHA256的category_icon不重复创建
        const existing = await db.prepare(
            'SELECT id, file_name, storage_path FROM attachment_files WHERE user_id = ? AND sha256 = ? AND attachment_kind = ?'
        ).bind(userId, sha256Hash, 'category_icon').first<{ id: string; file_name: string; storage_path: string }>();
        if (existing) {
            return c.json({
                file_id: existing.id,
                ledger_id: '',
                sha256: sha256Hash,
                size,
                mime_type: mimeType,
                file_name: existing.file_name,
                created_at: new Date().toISOString(),
            });
        }

        const r2Key = `category-icons/${userId}/${randomUUID()}_${fileName}`;

        // 上传到 storage-adapter（R2 优先，回退所有备份远端）
        const uploadResult = await uploadToStorage(db, c.env, r2Key, new Uint8Array(fileBuffer), effectiveMimeType);
        if (!uploadResult.ok) {
            serverLogger.error('src.routers.attachments', '[ATTACH] Category icon upload failed: no available storage');
            return c.json({ error: 'Upload failed: no available storage' }, 503);
        }

        const now = new Date().toISOString();
        const fileId = randomUUID();

        await db.prepare(
            `INSERT INTO attachment_files
             (id, ledger_id, user_id, sha256, size_bytes, mime_type, file_name, storage_path, attachment_kind, created_at)
             VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'category_icon', ?)`
        ).bind(fileId, userId, sha256Hash, size, effectiveMimeType, fileName, r2Key, now).run();

        serverLogger.info('src.routers.attachments', '[ATTACH] Category icon upload: name=', file.name, 'type=', file.type, 'size=', file.size);
        const result = {
            file_id: fileId,
            ledger_id: '',
            sha256: sha256Hash,
            size: Number(size),
            mime_type: String(mimeType),
            file_name: String(fileName),
            created_at: String(now),
        };
        serverLogger.info('src.routers.attachments', '[ATTACH] Category icon upload response:', JSON.stringify(result));
        return c.json(result);
    } catch (error) {
        serverLogger.error('src.routers.attachments', '[ATTACHMENT] Category icon upload error:', error);
        return c.json({ error: `Upload failed: ${(error as Error).message}` }, 500);
    }
});

export default attachmentsRouter;
