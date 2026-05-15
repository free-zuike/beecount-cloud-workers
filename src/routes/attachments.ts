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
import { randomUUID, createHmac } from 'crypto';

// ===========================
// S3 客户端工具类
// ===========================

/**
 * S3 客户端 - 支持外部 S3 兼容服务
 * 使用 AWS Signature Version 4 进行身份验证
 */
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
    this.endpoint = env.S3_ENDPOINT || 'https://s3.amazonaws.com';
    this.region = env.S3_REGION || 'us-east-1';
    this.accessKeyId = env.S3_ACCESS_KEY_ID || '';
    this.secretAccessKey = env.S3_SECRET_ACCESS_KEY || '';
    this.bucketName = env.S3_BUCKET_NAME || '';
  }

  /**
   * 检查是否已配置 S3
   */
  isConfigured(): boolean {
    return !!(this.accessKeyId && this.secretAccessKey && this.bucketName);
  }

  /**
   * 获取文件存储路径
   */
  getStorageKey(ledgerId: string, fileId: string, fileName: string): string {
    const encodedFileName = encodeURIComponent(fileName);
    return `attachments/${ledgerId}/${fileId}/${encodedFileName}`;
  }

  /**
   * 生成 AWS Signature Version 4
   */
  private generateSignature(
    method: string,
    key: string,
    contentType: string,
    date: string,
    dateStamp: string
  ): string {
    const algorithm = 'AWS4-HMAC-SHA256';
    const credentialScope = `${dateStamp}/${this.region}/s3/aws4_request`;

    // 构建规范请求
    const canonicalUri = `/${this.bucketName}/${key}`;
    const canonicalQuerystring = '';
    const canonicalHeaders = `content-type:${contentType}\nhost:${new URL(this.endpoint).hostname}\nx-amz-date:${date}\n`;
    const signedHeaders = 'content-type;host;x-amz-date';

    const payloadHash = 'UNSIGNED-PAYLOAD';
    const canonicalRequest = `${method}\n${canonicalUri}\n${canonicalQuerystring}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

    // 构建字符串签名
    const stringToSign = `${algorithm}\n${date}\n${credentialScope}\n${this.sha256(canonicalRequest)}`;

    // 计算签名
    const kDate = this.hmacBuffer('AWS4' + this.secretAccessKey, dateStamp);
    const kRegion = this.hmacBuffer(kDate, this.region);
    const kService = this.hmacBuffer(kRegion, 's3');
    const kSigning = this.hmacBuffer(kService, 'aws4_request');
    const signature = this.hmacHex(kSigning, stringToSign);

    return signature;
  }

  private hmacHex(key: string | Buffer, data: string): string {
    const hmac = createHmac('sha256', key);
    hmac.update(data);
    return hmac.digest('hex');
  }

  private hmacBuffer(key: string | Buffer, data: string): Buffer {
    const hmac = createHmac('sha256', key);
    hmac.update(data);
    return hmac.digest();
  }

  private sha256(data: string): string {
    return createHmac('sha256', '').update(data).digest('hex');
  }

  /**
   * 上传文件到 S3
   */
  async upload(
    key: string,
    body: ArrayBuffer,
    contentType: string
  ): Promise<boolean> {
    if (!this.isConfigured()) {
      return false;
    }

    const now = new Date();
    const date = now.toISOString().replace(/[:\-]|\.\d{3}/g, '');
    const dateStamp = date.slice(0, 8);

    const signature = this.generateSignature('PUT', key, contentType, date, dateStamp);
    const credential = `${this.accessKeyId}/${dateStamp}/${this.region}/s3/aws4_request`;

    const url = `${this.endpoint}/${this.bucketName}/${key}`;
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
        'x-amz-date': date,
        'Authorization': `AWS4-HMAC-SHA256 Credential=${credential}, SignedHeaders=content-type;host;x-amz-date, Signature=${signature}`,
      },
      body: body,
    });

    return response.ok;
  }

  /**
   * 从 S3 下载文件
   */
  async download(key: string): Promise<Response | null> {
    if (!this.isConfigured()) {
      return null;
    }

    const now = new Date();
    const date = now.toISOString().replace(/[:\-]|\.\d{3}/g, '');
    const dateStamp = date.slice(0, 8);

    const signature = this.generateSignature('GET', key, '', date, dateStamp);
    const credential = `${this.accessKeyId}/${dateStamp}/${this.region}/s3/aws4_request`;

    const url = `${this.endpoint}/${this.bucketName}/${key}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'x-amz-date': date,
        'Authorization': `AWS4-HMAC-SHA256 Credential=${credential}, SignedHeaders=host;x-amz-date, Signature=${signature}`,
      },
    });

    return response.ok ? response : null;
  }

  /**
   * 从 S3 删除文件
   */
  async delete(key: string): Promise<boolean> {
    if (!this.isConfigured()) {
      return false;
    }

    const now = new Date();
    const date = now.toISOString().replace(/[:\-]|\.\d{3}/g, '');
    const dateStamp = date.slice(0, 8);

    const signature = this.generateSignature('DELETE', key, '', date, dateStamp);
    const credential = `${this.accessKeyId}/${dateStamp}/${this.region}/s3/aws4_request`;

    const url = `${this.endpoint}/${this.bucketName}/${key}`;
    const response = await fetch(url, {
      method: 'DELETE',
      headers: {
        'x-amz-date': date,
        'Authorization': `AWS4-HMAC-SHA256 Credential=${credential}, SignedHeaders=host;x-amz-date, Signature=${signature}`,
      },
    });

    return response.ok;
  }
}

// ===========================
// 辅助函数
// ===========================

/** 获取当前 UTC 时间 */
function nowUtc(): string {
  return new Date().toISOString();
}

// ===========================
// 类型定义
// ===========================

/** 附件上传输出 */
interface AttachmentUploadOut {
  file_id: string;
  ledger_id: string;
  sha256: string;
  size: number;
  mime_type: string | null;
  file_name: string | null;
  created_at: string;
}

/** 附件存在检查项 */
interface AttachmentExistsItem {
  sha256: string;
  exists: boolean;
  file_id: string | null;
  size: number | null;
  mime_type: string | null;
}

// ===========================
// Schema 定义
// ===========================

/** 附件存在检查请求 */
const AttachmentExistsRequestSchema = z.object({
  checks: z.array(z.object({
    sha256: z.string(),
    ledger_id: z.string(),
  })),
});

// ===========================
// 路由定义
// ===========================

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

// ---------------------------------------------------------------------------
// POST /attachments - 上传附件
// ---------------------------------------------------------------------------

/**
 * 上传交易附件
 *
 * 功能说明：
 * - 接收 FormData 中的文件
 * - 计算 SHA256 哈希
 * - 按 (ledger_id, sha256) 去重
 * - 存储附件元数据到 attachment_files 表
 *
 * 请求：
 * - FormData with fields:
 *   - file: 文件
 *   - ledger_id: 账本外部 ID
 *   - file_name: 文件名（可选）
 *
 * 响应：
 * - file_id: 文件 ID
 * - ledger_id: 账本 ID
 * - sha256: 文件哈希
 * - size: 文件大小
 * - mime_type: MIME 类型
 * - file_name: 文件名
 * - created_at: 创建时间
 */
attachmentsRouter.post('/', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const serverNow = nowUtc();

  // 初始化 S3 客户端
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

    if (!file) {
      return c.json({ error: 'No file provided' }, 400);
    }

    if (!ledgerExternalId) {
      return c.json({ error: 'ledger_id is required' }, 400);
    }

    // 查询账本
    const ledger = await db
      .prepare('SELECT id, external_id FROM ledgers WHERE user_id = ? AND external_id = ?')
      .bind(userId, ledgerExternalId)
      .first<{ id: string; external_id: string }>();

    if (!ledger) {
      return c.json({ error: 'Ledger not found' }, 404);
    }

    // 计算 SHA256
    const fileBuffer = await file.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', fileBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const sha256 = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

    const mimeType = file.type || 'application/octet-stream';
    const actualFileName = fileName || file.name || 'unnamed';
    const size = file.size;

    // 检查是否已存在相同 SHA256 的附件
    const existing = await db
      .prepare(
        `SELECT id FROM attachment_files
         WHERE sha256 = ? AND ledger_id = ? AND attachment_kind = 'transaction'`
      )
      .bind(sha256, ledger.id)
      .first<{ id: string }>();

    if (existing) {
      // 返回已存在的文件
      const response: AttachmentUploadOut = {
        file_id: existing.id,
        ledger_id: ledger.external_id,
        sha256,
        size,
        mime_type: mimeType,
        file_name: actualFileName,
        created_at: serverNow,
      };
      return c.json(response);
    }

    // 生成新文件 ID
    const fileId = randomUUID();
    const storageKey = s3Client.getStorageKey(ledger.external_id, fileId, actualFileName);

    // 上传到 S3（如果已配置）
    if (s3Client.isConfigured()) {
      const uploadSuccess = await s3Client.upload(storageKey, fileBuffer, mimeType);
      if (!uploadSuccess) {
        return c.json({ error: 'Failed to upload to S3' }, 500);
      }
    }

    // 插入记录
    await db
      .prepare(
        `INSERT INTO attachment_files
         (id, ledger_id, user_id, sha256, size_bytes, mime_type, file_name, storage_path, attachment_kind, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'transaction', ?)`
      )
      .bind(fileId, ledger.id, userId, sha256, size, mimeType, actualFileName, storageKey, serverNow)
      .run();

    const response: AttachmentUploadOut = {
      file_id: fileId,
      ledger_id: ledger.external_id,
      sha256,
      size,
      mime_type: mimeType,
      file_name: actualFileName,
      created_at: serverNow,
    };

    return c.json(response);
  } catch (err) {
    console.error('Attachment upload error:', err);
    return c.json({ error: 'Failed to upload attachment' }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /attachments/:id - 下载附件
// ---------------------------------------------------------------------------

/**
 * 下载附件
 *
 * 功能说明：
 * - 按 ID 查询附件
 * - 验证用户有权限访问（附件属于用户的账本）
 * - 返回文件内容
 *
 * 路径参数：
 * - id: 附件文件 ID
 *
 * 响应：
 * - 200: 文件内容（带正确的 Content-Type）
 * - 404: 附件不存在或无权限
 */
attachmentsRouter.get('/:id', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const fileId = c.req.param('id');

  // 初始化 S3 客户端
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

  // 如果已配置 S3，从 S3 下载文件
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

  // 如果未配置 S3，返回文件元数据
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

// ---------------------------------------------------------------------------
// DELETE /attachments/:id - 删除附件
// ---------------------------------------------------------------------------

/**
 * 删除附件
 *
 * 功能说明：
 * - 验证用户有权限删除
 * - 从 attachment_files 表删除记录
 * - 如果已配置 S3，同时从 S3 删除实际文件
 */
attachmentsRouter.delete('/:id', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const fileId = c.req.param('id');

  // 初始化 S3 客户端
  const s3Client = new S3Client({
    S3_ENDPOINT: c.env.S3_ENDPOINT,
    S3_REGION: c.env.S3_REGION,
    S3_ACCESS_KEY_ID: c.env.S3_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY: c.env.S3_SECRET_ACCESS_KEY,
    S3_BUCKET_NAME: c.env.S3_BUCKET_NAME,
  });

  // 验证权限并获取存储路径
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

  // 从 S3 删除文件（如果已配置）
  if (s3Client.isConfigured()) {
    await s3Client.delete(row.storage_path);
  }

  // 从数据库删除记录
  await db.prepare('DELETE FROM attachment_files WHERE id = ?').bind(fileId).run();

  return c.json({ success: true });
});

// ---------------------------------------------------------------------------
// POST /attachments/exists - 批量检查附件是否存在
// ---------------------------------------------------------------------------

/**
 * 批量检查附件是否存在
 *
 * 功能说明：
 * - 接收 SHA256 列表
 * - 返回每个 SHA256 的存在状态和元数据
 * - 用于客户端在上传前检查是否已存在
 */
attachmentsRouter.post('/exists', zValidator('json', AttachmentExistsRequestSchema), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const req = c.req.valid('json');

  const results: AttachmentExistsItem[] = [];

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
