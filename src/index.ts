import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { initializeDatabase } from './db/schema';
import { authMiddleware } from './middleware/auth';
import { spaMiddleware } from './middleware/spa';
import { processBackupSchedule } from './services/backup-scheduler';
import { initLogger } from './lib/logger';

import setupRouter from './routes/setup';
import authRouter from './routes/auth';
import syncRouter from './routes/sync';
import readRouter from './routes/read';
import summaryRouter from './routes/summary';
import workspaceRouter from './routes/workspace';
import writeRouter from './routes/write';
import batchWriteRouter from './routes/batch_write';
import devicesRouter from './routes/devices';
import profileRouter from './routes/profile';
import patsRouter from './routes/pats';
import attachmentsRouter from './routes/attachments';
import importRouter from './routes/import_data';
import aiRouter from './routes/ai';
import backupRouter from './routes/backup';
import adminBackupRouter from './routes/admin_backup';
import mcpCallsRouter from './routes/mcp_calls';
import mcpRouter from './routes/mcp';
import adminRouter from './routes/admin';
import sysConfigRouter from './routes/sys_config';
import csvRouter from './routes/csv';
import wsRouter from './routes/websocket';

import { BeeCountDO } from './do';

type Bindings = {
  DB: D1Database;
  ASSETS: { fetch: (request: Request) => Promise<Response> };
  BEECOUNT_DO: DurableObjectNamespace;
  R2: R2Bucket;
  API_PREFIX: string;
  JWT_SECRET: string;
  CORS_ORIGINS?: string;
  S3_ENDPOINT?: string;
  S3_REGION?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
  S3_BUCKET_NAME?: string;
  S3_PATH_STYLE?: string;
  S3_CDN_DOMAIN?: string;
  CLOUDFLARE_API_TOKEN?: string;
};

type Variables = {
  userId: string;
  deviceId: string | null;
};

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

app.use('*', async (c, next) => {
  const corsOrigins = c.env.CORS_ORIGINS ? c.env.CORS_ORIGINS.split(',') : ['*'];
  return cors({ origin: corsOrigins })(c, next);
});

let initialized = false;
app.use('*', async (c, next) => {
  if (!initialized) {
    await initializeDatabase(c.env.DB);
    initLogger(c.env.DB);
    initialized = true;
  }
  await next();
});

app.get('/healthz', (c) => c.json({ status: 'ok' }));

// ---- 公共路由（无需鉴权）----
app.route('/api/v1/setup', setupRouter);
app.route('/api/v1/auth', authRouter);
app.get('/api/v1/version', (c) =>
  c.json({ name: 'BeeCount Cloud', version: '1.6.1' })
);

// 头像下载公开访问（与原版一致）
app.get('/api/v1/profile/avatar/:userId', async (c) => {
  const userId = c.req.param('userId');
  const db = c.env.DB;
  const r2 = c.env.R2;

  // 速率限制
  const { isRateLimited } = await import('./lib/rate-limit');
  const clientIp = c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown';
  if (isRateLimited('avatar-download', clientIp, 60, 60)) {
    return c.json({ error: 'Rate limit exceeded' }, 429);
  }

  if (!r2) return c.json({ error: 'Storage not configured' }, 500);

  const profile = await db.prepare('SELECT avatar_file_id, avatar_version FROM user_profiles WHERE user_id = ?').bind(userId).first<{ avatar_file_id: string; avatar_version: number }>();
  if (!profile?.avatar_file_id) return c.json({ error: 'Avatar not found' }, 404);

  const obj = await r2.get(`avatars/${userId}/${profile.avatar_file_id}`);
  if (!obj) return c.json({ error: 'Avatar not found' }, 404);

  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || 'image/png',
      'Cache-Control': c.req.query('v') ? 'public, max-age=31536000, immutable' : 'no-cache',
    },
  });
});

// ---- OAuth2 回调（不需要认证，被 OAuth 提供商直接调用） ----
app.get('/api/v1/admin/backup/remotes/oauth2/callback', async (c) => {
  const code = c.req.query('code');
  const provider = c.req.query('provider') || 'drive';
  if (!code) return c.text('Missing authorization code', 400);
  // 跳转到回调页面，用前端 POST 换取 token
  return c.html(`<!DOCTYPE html><html><body>
    <h2>授权成功</h2>
    <p>授权码: <code style="word-break:break-all">${code}</code></p>
    <p>使用以下命令换取 token:</p>
    <pre>curl -X POST https://beecount.qzz.io/api/v1/admin/backup/remotes/oauth2/token \\
  -H "Content-Type: application/json" \\
  -d '{"code":"${code}","provider":"${provider}","client_id":"你的client_id","client_secret":"你的client_secret"}'</pre>
  </body></html>`);
});
app.post('/api/v1/admin/backup/remotes/oauth2/token', async (c) => {
  const { code, provider, client_id, client_secret } = await c.req.json();
  if (!code || !client_id || !client_secret) return c.json({ error: 'Missing required fields' }, 400);
  const tokenEndpoints: Record<string, string> = { drive: 'https://oauth2.googleapis.com/token', onedrive: 'https://login.microsoftonline.com/common/oauth2/v2.0/token', dropbox: 'https://api.dropbox.com/oauth2/token' };
  const tokenUrl = tokenEndpoints[provider || 'drive'];
  if (!tokenUrl) return c.json({ error: `Unsupported provider: ${provider}` }, 400);
  try {
    const resp = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, client_id, client_secret, redirect_uri: 'https://beecount.qzz.io/api/v1/admin/backup/remotes/oauth2/callback', grant_type: 'authorization_code' }),
    });
    const tokenData = await resp.json();
    if (!resp.ok) return c.json({ error: 'Token exchange failed', details: tokenData }, 400);
    return c.json({ message: 'Token obtained successfully', token: tokenData });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
});

// ---- 鉴权中间件 ----
app.use('/api/v1/*', authMiddleware);
app.use('/sync/*', authMiddleware);
app.use('/read/*', authMiddleware);
app.use('/write/*', authMiddleware);
app.use('/devices/*', authMiddleware);
app.use('/profile/*', authMiddleware);
app.use('/attachments/*', authMiddleware);
app.use('/api/v1/attachments/*', authMiddleware);
app.use('/import/*', authMiddleware);
app.use('/api/v1/import/*', authMiddleware);
app.use('/ai/*', authMiddleware);
app.use('/backup/*', authMiddleware);
app.use('/sys-config/*', authMiddleware);
app.use('/export/*', authMiddleware);

// ---- 受保护路由 ----
app.route('/api/v1/sync', syncRouter);
app.route('/api/v1/read', readRouter);
app.route('/api/v1/read/summary', summaryRouter);
app.route('/api/v1/read/workspace', workspaceRouter);
// 共享账本成员管理端点（与原版 /api/v1/ledgers/{ext}/members 对齐）
app.route('/api/v1', workspaceRouter);
app.route('/api/v1/write', writeRouter);
app.route('/api/v1/write', batchWriteRouter);
app.route('/api/v1/devices', devicesRouter);
app.route('/api/v1/profile', profileRouter);
app.route('/api/v1/profile/pats', patsRouter);
app.route('/api/v1/attachments', attachmentsRouter);
app.route('/api/v1/import', importRouter);
app.route('/api/v1/ai', aiRouter);
app.route('/api/v1/backup', backupRouter);
app.route('/api/v1/mcp-calls', mcpCallsRouter);
app.route('/api/v1/admin/backup', adminBackupRouter);
app.route('/api/v1/admin', adminRouter);
app.route('/api/v1/sys-config', sysConfigRouter);
app.route('/api/v1/profile/mcp-calls', mcpCallsRouter);
app.route('/api/v1/export', csvRouter);
app.route('/api/v1/mcp', mcpRouter);
app.route('/mcp', mcpRouter);
app.route('/sync', syncRouter);
app.route('/read', readRouter);
app.route('/read/summary', summaryRouter);
app.route('/write', writeRouter);
app.route('/write', batchWriteRouter);
app.route('/devices', devicesRouter);
app.route('/profile', profileRouter);
app.route('/attachments', attachmentsRouter);
app.route('/import', importRouter);
app.route('/ai', aiRouter);
app.route('/backup', backupRouter);
app.route('/export', csvRouter);

app.onError((err, c) => {
  console.error('[ERROR]', err.message);
  const requestId = c.req.header('cf-ray') || '';
  return c.json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Internal Server Error',
      request_id: requestId,
    },
    detail: 'Internal Server Error',
  }, 500);
});

app.route('/ws', wsRouter);

// 邀请链接重定向到 Web App 账本页面（原版 Python 用独立域名处理）
app.get('/invite/:code', (c) => {
  const code = c.req.param('code');
  return c.redirect(`/app/ledgers?invite=${code}`, 302);
});

app.get('*', spaMiddleware);

export { BeeCountDO };

export default {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket 升级必须在 Worker 层处理（Hono 中间件会丢失 Upgrade 头）
    if (url.pathname === '/ws' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const token = url.searchParams.get('token');
      if (!token) {
        return new Response(JSON.stringify({ error: 'Missing token' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }

      try {
        const { validateAccessToken } = await import('./auth');
        const result = await validateAccessToken(token, env.JWT_SECRET);
        if (!result || !('userId' in result)) {
          return new Response(JSON.stringify({ error: 'Invalid token' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
        }

        const userId = (result as any).userId;
        const doId = env.BEECOUNT_DO.idFromName(`ws-${userId}`);
        const doStub = env.BEECOUNT_DO.get(doId);

        return doStub.fetch(request);
      } catch (error) {
        return new Response(JSON.stringify({ error: 'WebSocket failed' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }

    return app.fetch(request, env, ctx);
  },
  
  async scheduled(event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    console.log('[CRON] Scheduled event triggered:', new Date().toISOString());
    
    const db = env.DB;
    
    try {
      const schedulesResult = await db
        .prepare('SELECT * FROM backup_schedules WHERE enabled = 1')
        .all();
      
      const schedules = schedulesResult.results || [];
      console.log(`[CRON] Found ${schedules.length} enabled backup schedules`);
      
      for (const schedule of schedules) {
        try {
          await processBackupSchedule(db, schedule, env.BEECOUNT_DO, env.R2, {
            CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN,
            BEECOUNT_DO: env.BEECOUNT_DO,
          });
        } catch (scheduleError) {
          console.error(`[CRON] Error processing schedule ${schedule.id}:`, scheduleError);
        }
      }
      
      console.log('[CRON] Scheduled event completed');
    } catch (error) {
      console.error('[CRON] Error in scheduled event:', error);
    }
  }
};
