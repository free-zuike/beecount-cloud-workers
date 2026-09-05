import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { initializeDatabase } from './db/schema';
import { APP_VERSION, APP_NAME } from './version';
import { authMiddleware } from './middleware/auth';
import { spaMiddleware } from './middleware/spa';
import { processBackupSchedule } from './services/backup-scheduler';
import { initLogger, serverLogger } from './lib/logger';
import { getFirstEnabledS3Config } from './routes/sys_config';
import { signRequest } from './lib/s3';
import { downloadFromStorage, deleteFromStorage } from './lib/storage-adapter';

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
  R2?: R2Bucket;
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
  REGISTRATION_ENABLED?: string;
  BACKUP_WORKFLOW?: any;
  RAG_INDEX_SOURCE_URL?: string;
  RAG_INDEX_REFRESH_INTERVAL_SECONDS?: string;
  EMBEDDING_MODEL?: string;
  EMBEDDING_BASE_URL?: string;
  EMBEDDING_API_KEY?: string;
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
let setupCompleted = false;
async function ensureInitialized(db: D1Database, logBuffer?: DurableObjectNamespace): Promise<void> {
  if (!initialized) {
    await initializeDatabase(db);
    initLogger(db, logBuffer);
    initialized = true;
  }
  if (!setupCompleted) {
    try {
      const settings = await db.prepare("SELECT setup_completed FROM system_settings WHERE id = ?").bind('default').first<{ setup_completed: number }>();
      if (settings?.setup_completed === 1) setupCompleted = true;
    } catch { /* transient D1 error, retry next request */ }
  }
}
app.use('*', async (c, next) => {
  await ensureInitialized(c.env.DB, c.env.BEECOUNT_DO);
  await next();
});

app.get('/healthz', (c) => c.json({ status: 'ok' }));

// 就绪探针（对齐原版）：查 DB 确认可用
app.get('/ready', async (c) => {
  await c.env.DB.prepare('SELECT 1').run();
  return c.json({ status: 'ready' });
});

// Prometheus 指标（对齐原版）：轻量内存计数器 + 文本格式
const _startTs = Date.now();
let _requestTotal = 0;
let _requestBytes = 0;
app.use('*', async (c, next) => {
  _requestTotal++;
  const len = Number(c.req.header('content-length') || 0);
  _requestBytes += len;
  return next();
});
app.get('/metrics', (c) => {
  const lines: string[] = [];
  lines.push('# TYPE beecount_http_requests_total counter');
  lines.push(`beecount_http_requests_total ${_requestTotal}`);
  lines.push('# TYPE beecount_http_request_bytes_total counter');
  lines.push(`beecount_http_request_bytes_total ${_requestBytes}`);
  lines.push('# TYPE beecount_workers_uptime_seconds gauge');
  lines.push(`beecount_workers_uptime_seconds ${Math.floor((Date.now() - _startTs) / 1000)}`);
  return c.text(lines.join('\n') + '\n');
});

// OAuth 2.0 Protected Resource Metadata (RFC 9728) — MCP 客户端（Claude /
// Cursor / Cline）连接前会探测此端点。我们只有静态 PAT、无 OAuth server，
// 所以声明 authorization_servers=[] + bearer header，让客户端走 Bearer 鉴权。
// 该端点必须存在且是可解析 JSON，否则 SDK 握手会因 schema 不匹配报错。
app.get('/.well-known/oauth-protected-resource', (c) => {
  const base = new URL(c.req.url).origin;
  return c.json({
    resource: `${base}/api/v1/mcp`,
    authorization_servers: [],
    bearer_methods_supported: ['header'],
    resource_documentation: 'https://github.com/free-zuike/beecount-cloud-workers',
  });
});
// 部分 SDK 会按 oauth-protected-resource/<resource_path> 形式探测，同样返回
app.get('/.well-known/oauth-protected-resource/{path:path}', (c) => {
  const base = new URL(c.req.url).origin;
  return c.json({
    resource: `${base}/api/v1/mcp`,
    authorization_servers: [],
    bearer_methods_supported: ['header'],
    resource_documentation: 'https://github.com/free-zuike/beecount-cloud-workers',
  });
});

// ---- 公共路由（无需鉴权）----
app.route('/api/v1/setup', setupRouter);
app.route('/api/v1/auth', authRouter);
app.get('/api/v1/version', (c) =>
  c.json({ name: APP_NAME, version: APP_VERSION })
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

  const profile = await db.prepare('SELECT avatar_file_id, avatar_version FROM user_profiles WHERE user_id = ?').bind(userId).first<{ avatar_file_id: string; avatar_version: number }>();
  if (!profile?.avatar_file_id) return c.json({ error: 'Avatar not found' }, 404);

  const key = profile.avatar_file_id;

  // 统一走 downloadFromStorage（R2 优先 + 自动 beecount/ 前缀 + 所有备份远端回退），
  // 与上传端 uploadToStorage(prefixKey) 的 key 语义一致；兼容 avatar_file_id 为
  // 纯文件名（原版恢复导入）或已带前缀（beecount/avatars/...）的存量。
  const data = await downloadFromStorage(db, c.env, key.replace(/^beecount\//, ''));
  if (!data) return c.json({ error: 'Avatar not found' }, 404);
  // 按扩展名 / 魔数给定 MIME（原版恢复的头像文件名带 .jpg/.png，直接能猜）
  const ext = (key.split('.').pop() || '').toLowerCase();
  const imgType = ext === 'png' ? 'image/png'
    : ext === 'webp' ? 'image/webp'
    : ext === 'gif' ? 'image/gif'
    : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
    : 'image/png';
  return new Response(data, {
    headers: {
      'Content-Type': imgType,
      'Cache-Control': c.req.query('v') ? 'public, max-age=31536000, immutable' : 'no-cache',
    },
  });
});

// ---- 请求日志中间件（对齐原版 Python install_request_middleware） ----
app.use('*', async (c, next) => {
  const requestId = c.req.header('cf-ray') || crypto.randomUUID();
  const start = performance.now();
  try {
    await next();
  } finally {
    try {
      const elapsed = performance.now() - start;
      const status = c.res.status;
      const userId = c.get('userId') || '-';
      console.log(`[ACCESS] ${c.req.method} ${c.req.path} → ${status} ${elapsed.toFixed(1)}ms req=${requestId} user=${userId}`);
      c.res.headers.set('X-Request-ID', requestId);
      c.res.headers.set('X-Response-Time-Ms', elapsed.toFixed(2));
    } catch (_) {
      /* 日志记录失败不影响请求 */
    }
  }
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
app.route('/api/v1/mcp/', mcpRouter); // 尾斜杠变体：标准 SDK 客户端常带尾斜杠
app.route('/mcp', mcpRouter);
app.route('/mcp/', mcpRouter);
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
  try {
    serverLogger.error('app', `[ERROR] ${c.req.method} ${c.req.path} → ${err.message}\n${err.stack ?? ''}`);
  } catch { console.error('[ERROR]', err.message); }
  const requestId = c.req.header('cf-ray') || '';
  return c.json({
    error: {
      code: 'INTERNAL_ERROR',
      message: err.message,
      request_id: requestId,
      stack: (err.stack ?? '').split('\n').slice(0, 6),
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

// 根路径 - 检查 setup 状态，未完成则输出 setup 页面
app.get('/', async (c) => {
  try {
    if (!setupCompleted) {
      const settings = await c.env.DB.prepare("SELECT setup_completed FROM system_settings WHERE id = ?").bind('default').first<{ setup_completed: number }>();
    if (!settings || settings.setup_completed !== 1) {
      return c.html(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>BeeCount - 初始化</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:-apple-system,system-ui,sans-serif;max-width:420px;margin:60px auto;padding:0 20px}h1{font-size:22px;margin-bottom:4px}p{color:#666;margin-bottom:28px;font-size:14px}label{display:block;margin-bottom:4px;font-weight:600;font-size:13px;color:#374151}input,select{width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;margin-bottom:16px;font-size:15px;box-sizing:border-box;outline:none}input:focus,select:focus{border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.15)}button{background:#2563eb;color:#fff;border:none;padding:11px;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;width:100%}button:hover{background:#1d4ed8}.error{color:#dc2626;font-size:13px;margin-top:10px;text-align:center}.success{color:#16a34a;font-size:13px;margin-top:10px;text-align:center}</style></head><body><h1>初始化系统</h1><p>创建管理员账户，开始使用 BeeCount</p><form id="f"><label>管理员邮箱</label><input type="email" id="e" placeholder="admin@example.com" required><label>密码</label><input type="password" id="p" minlength="6" placeholder="至少 6 位" required><label>时区</label><select id="t"><option value="-720">-12:00</option><option value="-660">-11:00</option><option value="-600">-10:00</option><option value="-540">-09:00</option><option value="-480" selected>UTC+8 北京时间</option><option value="-420">+07:00</option><option value="-360">+06:00</option><option value="-300">+05:00</option><option value="-240">+04:00</option><option value="-180">+03:00</option><option value="-120">+02:00</option><option value="-60">+01:00</option><option value="0">UTC</option></select><button type="submit">完成初始化</button></form><p id="m"></p><script>document.getElementById('f').onsubmit=async(e)=>{e.preventDefault();const r=await fetch('/api/v1/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({admin_email:document.getElementById('e').value,admin_password:document.getElementById('p').value,timezone_offset:parseInt(document.getElementById('t').value),admin_mode:'manual'})});const d=await r.json();if(d.success){document.getElementById('m').className='success';document.getElementById('m').textContent='初始化成功，即将跳转...';setTimeout(()=>window.location.href='/app',1500)}else{document.getElementById('m').className='error';document.getElementById('m').textContent=d.error||'设置失败'}}</script></body></html>`);
    }
    setupCompleted = true;
    }
    return c.redirect('/app', 302);
  } catch {
    return c.redirect('/app', 302);
  }
});

app.use('*', spaMiddleware);

export { BeeCountDO };

export default {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const start = Date.now();

    // WebSocket 升级必须在 Worker 层处理（Hono 中间件会丢失 Upgrade 头）
    if (url.pathname === '/ws' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const token = url.searchParams.get('token');
      if (!token) {
        return new Response(JSON.stringify({ error: 'Missing token' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }

      try {
        // WebSocket 请求绕过 Hono 中间件，这里手动初始化 DB 和 logger
        await ensureInitialized(env.DB, env.BEECOUNT_DO);
        const { validateAccessToken } = await import('./auth');
        const result = await validateAccessToken(token, env.JWT_SECRET);
        if (!result || !('userId' in result)) {
          return new Response(JSON.stringify({ error: 'Invalid token' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
        }

        const userId = (result as any).userId;
        const doId = env.BEECOUNT_DO.idFromName(`ws-${userId}`);
        const doStub = env.BEECOUNT_DO.get(doId);

        serverLogger.info('src.routers.ws', `WS ${url.pathname} → upgrade 200`);
        return doStub.fetch(request);
      } catch (error) {
        serverLogger.error('src.routers.ws', `WS ${url.pathname} → upgrade 500`);
        return new Response(JSON.stringify({ error: 'WebSocket failed' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }

    // 兜底日志：记录所有经过 Hono 的 HTTP 请求（中间件也可能记录，但这里确保不遗漏）
    const response = await app.fetch(request, env, ctx);
    const elapsed = Date.now() - start;
    ctx.waitUntil((async () => {
      try {
        await serverLogger.info('beecount.access', `${request.method} ${url.pathname} → ${response.status} ${elapsed}ms`);
      } catch { /* 日志失败不阻塞 */ }
    })());
    return response;
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
            BACKUP_WORKFLOW: env.BACKUP_WORKFLOW,
          });
        } catch (scheduleError) {
          console.error(`[CRON] Error processing schedule ${schedule.id}:`, scheduleError);
        }
      }
      
      console.log('[CRON] Scheduled event completed');
    } catch (error) {
      console.error('[CRON] Error in scheduled event:', error);
    }

    // RAG 文档索引周期刷新（对齐原版启动后台循环；R2 记录上次刷新时间做节流）
    try {
      if (env.RAG_INDEX_SOURCE_URL) {
        const { getRagService } = await import('./services/rag-refresh');
        const intervalSec = Number(env.RAG_INDEX_REFRESH_INTERVAL_SECONDS) || 21600;
        const markerKey = 'beecount/rag-index/last-refresh-ts';
        let lastTs = 0;
        if (env.R2) {
          const marker = await env.R2.get(markerKey);
          if (marker) lastTs = Number(await marker.text()) || 0;
        }
        if (Date.now() - lastTs >= intervalSec * 1000) {
          const service = getRagService(env);
          await service.init();
          await service.refresh();
          if (env.R2) await env.R2.put(markerKey, String(Date.now()));
          console.log('[CRON] RAG index refresh done');
        }
      }
    } catch (error) {
      console.error('[CRON] RAG refresh error:', error);
    }
  }
};

export { BackupWorkflow } from './workflows/backup';
