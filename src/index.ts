import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { initializeDatabase } from './db/schema';
import { authMiddleware } from './middleware/auth';
import { spaMiddleware } from './middleware/spa';
import { processBackupSchedule } from './services/backup-scheduler';

import setupRouter from './routes/setup';
import authRouter from './routes/auth';
import twoFactorRouter from './routes/two_factor';
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
import notificationsRouter from './routes/notifications';
import mcpCallsRouter from './routes/mcp_calls';
import mcpRouter from './routes/mcp';
import adminRouter from './routes/admin';
import sysConfigRouter from './routes/sys_config';
import csvRouter from './routes/csv';
import wsRouter from './routes/websocket';

type Bindings = {
  DB: D1Database;
  ASSETS: { fetch: (request: Request) => Promise<Response> };
  BEECOUNT_WS: DurableObjectNamespace;
  BEECOUNT_LOG_BUFFER: DurableObjectNamespace;
  BEECOUNT_LOCK: DurableObjectNamespace;
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
    initialized = true;
  }
  await next();
});

app.get('/healthz', (c) => c.json({ status: 'ok' }));

app.route('/api/v1/setup', setupRouter);

app.get('/api/v1/version', (c) =>
  c.json({
    name: 'BeeCount Cloud Workers',
    version: '1.0.0',
  })
);

app.use('/api/v1/*', async (c, next) => {
  return authMiddleware(c, next, [
    '/api/v1/auth',
    '/api/v1/profile/avatar',
    '/api/v1/version'
  ]);
});

app.use('/2fa/*', async (c, next) => {
  return authMiddleware(c, next, ['/2fa/verify']);
});

app.use('/sync/*', async (c, next) => authMiddleware(c, next));
app.use('/read/*', async (c, next) => authMiddleware(c, next));
app.use('/write/*', async (c, next) => authMiddleware(c, next));
app.use('/devices/*', async (c, next) => authMiddleware(c, next));
app.use('/profile/*', async (c, next) => authMiddleware(c, next, ['/profile/avatar']));
app.use('/attachments/*', async (c, next) => authMiddleware(c, next));
app.use('/import/*', async (c, next) => authMiddleware(c, next));
app.use('/ai/*', async (c, next) => authMiddleware(c, next));
app.use('/backup/*', async (c, next) => authMiddleware(c, next));
app.use('/notifications/*', async (c, next) => authMiddleware(c, next));
app.use('/sys-config/*', async (c, next) => authMiddleware(c, next));
app.use('/export/*', async (c, next) => authMiddleware(c, next));

app.route('/api/v1/auth', authRouter);
app.route('/api/v1/2fa', twoFactorRouter);
app.route('/2fa', twoFactorRouter);
app.route('/api/v1/sync', syncRouter);
app.route('/api/v1/read', readRouter);
app.route('/api/v1/read/summary', summaryRouter);
app.route('/api/v1/read/workspace', workspaceRouter);
app.route('/api/v1/write', writeRouter);
app.route('/api/v1/write', batchWriteRouter);
app.route('/api/v1/devices', devicesRouter);
app.route('/api/v1/profile', profileRouter);
app.route('/api/v1/profile/pats', patsRouter);
app.route('/api/v1/attachments', attachmentsRouter);
app.route('/api/v1/import', importRouter);
app.route('/api/v1/ai', aiRouter);
app.route('/api/v1/backup', backupRouter);
app.route('/api/v1/notifications', notificationsRouter);
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
app.route('/devices', devicesRouter);
app.route('/profile', profileRouter);
app.route('/attachments', attachmentsRouter);
app.route('/import', importRouter);
app.route('/ai', aiRouter);
app.route('/backup', backupRouter);
app.route('/notifications', notificationsRouter);
app.route('/export', csvRouter);

app.onError((err, c) => {
  console.error('[ERROR]', err.message);
  return c.json({
    error: 'Internal Server Error',
    timestamp: new Date().toISOString(),
  }, 500);
});

app.route('/ws', wsRouter);

app.get('*', spaMiddleware);

export default {
  fetch: app.fetch,
  
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
          await processBackupSchedule(db, schedule, env.BEECOUNT_LOCK);
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
