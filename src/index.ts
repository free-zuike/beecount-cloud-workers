/**
 * BeeCount Cloud Workers - 入口文件
 *
 * 完整实现 BeeCount Cloud API 协议的 Cloudflare Workers 版本
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { validateAccessToken, hashPassword } from './auth';

// WebSocket 连接存储（简单实现）
const wsConnections = new Map<string, Set<WebSocket>>();

// 生成随机密码
function generateRandomPassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let password = '';
  for (let i = 0; i < 12; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
}

// 初始化数据库表（备用方案）
async function initializeDatabase(db: D1Database): Promise<void> {
  try {
    // 检查 users 表是否存在
    const usersTableCheck = await db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'")
      .first();

    // 检查备份表是否存在
    const backupRunsTableCheck = await db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='backup_runs'")
      .first();

    if (usersTableCheck && backupRunsTableCheck) {
      console.log('[INIT] Database tables already exist');
      return;
    }

    console.log('[INIT] Creating database tables...');

    // 如果 users 表已存在但备份表不存在，只创建备份表
    if (usersTableCheck && !backupRunsTableCheck) {
      console.log('[INIT] Users table exists, creating missing backup tables...');
    }

    // 如果 users 表不存在，创建基础表
    if (!usersTableCheck) {
      await db.prepare(`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          email TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          is_admin BOOLEAN DEFAULT 0 NOT NULL,
          is_enabled BOOLEAN DEFAULT 1 NOT NULL,
          created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
          totp_secret_encrypted TEXT,
          totp_enabled BOOLEAN DEFAULT 0 NOT NULL,
          totp_enabled_at TEXT
        )
      `).run();

      await db.prepare(`
        CREATE TABLE IF NOT EXISTS user_profiles (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          display_name TEXT,
          avatar_file_id TEXT,
          avatar_version INTEGER DEFAULT 0,
          income_is_red BOOLEAN DEFAULT 1,
          theme_primary_color TEXT,
          appearance_json TEXT,
          ai_config_json TEXT,
          updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
        )
      `).run();

      await db.prepare(`
        CREATE TABLE IF NOT EXISTS ledgers (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          external_id TEXT NOT NULL,
          name TEXT,
          currency TEXT DEFAULT 'CNY' NOT NULL,
          created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
          UNIQUE(user_id, external_id)
        )
      `).run();

      await db.prepare(`
        CREATE TABLE IF NOT EXISTS sync_changes (
          change_id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          ledger_id TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
          entity_type TEXT NOT NULL,
          entity_sync_id TEXT NOT NULL,
          action TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          updated_by_device_id TEXT,
          updated_by_user_id TEXT
        )
      `).run();

      await db.prepare(`
        CREATE TABLE IF NOT EXISTS read_category_projection (
          ledger_id TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
          sync_id TEXT NOT NULL,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name TEXT,
          kind TEXT,
          level INTEGER,
          sort_order INTEGER,
          icon TEXT,
          icon_type TEXT,
          custom_icon_path TEXT,
          icon_cloud_file_id TEXT,
          icon_cloud_sha256 TEXT,
          parent_name TEXT,
          source_change_id INTEGER DEFAULT 0,
          PRIMARY KEY (ledger_id, sync_id)
        )
      `).run();
    }

    // 创建备份相关的表（总是尝试创建，使用 IF NOT EXISTS）
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS backup_remotes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        backend_type TEXT NOT NULL,
        config_json TEXT NOT NULL,
        is_default BOOLEAN DEFAULT 0 NOT NULL,
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
        updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
      )
    `).run();

    await db.prepare(`
      CREATE TABLE IF NOT EXISTS backup_schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        cron_expr TEXT NOT NULL,
        remote_ids TEXT,
        retention_days INTEGER DEFAULT 30,
        include_attachments BOOLEAN DEFAULT 0 NOT NULL,
        enabled BOOLEAN DEFAULT 1 NOT NULL,
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
        updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
      )
    `).run();

    await db.prepare(`
      CREATE TABLE IF NOT EXISTS backup_runs (
        id TEXT PRIMARY KEY,
        schedule_id INTEGER,
        ledger_id TEXT NOT NULL,
        remote_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        error_message TEXT,
        backup_size INTEGER,
        backup_path TEXT,
        started_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
        completed_at TEXT
      )
    `).run();

    // 如果 backup_runs 表已存在但缺少 ledger_id 列，添加它（不带 NOT NULL 约束）
    try {
      await db.prepare('ALTER TABLE backup_runs ADD COLUMN ledger_id TEXT').run();
      console.log('[INIT] Added ledger_id column to backup_runs');
      // 更新现有行设置默认值
      await db.prepare('UPDATE backup_runs SET ledger_id = "" WHERE ledger_id IS NULL').run();
    } catch (e) {
      // 如果列已存在或其他错误，忽略
      console.log('[INIT] ledger_id column already exists or error:', e);
    }

    // 创建索引
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_backup_schedules_user_id ON backup_schedules(user_id)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_backup_runs_schedule_id ON backup_runs(schedule_id)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_backup_runs_ledger_id ON backup_runs(ledger_id)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_backup_runs_status ON backup_runs(status)').run();

    console.log('[INIT] Database tables created successfully');
  } catch (error) {
    console.error('[INIT] Failed to initialize database:', error);
  }
}

// 初始化默认管理员账户
async function initializeAdmin(db: D1Database): Promise<void> {
  try {
    console.log('🔍 [INIT] Checking for existing admin user...');
    
    // 检查是否已有管理员账户
    const adminCount = await db
      .prepare('SELECT COUNT(*) as count FROM users WHERE is_admin = 1')
      .first<{ count: number }>();

    if (adminCount && adminCount.count > 0) {
      console.log('✅ [INIT] Admin user already exists, skipping initialization');
      return;
    }

    console.log('🆕 [INIT] Creating default admin user...');

    // 生成随机密码
    const adminPassword = generateRandomPassword();
    const adminEmail = 'admin@localhost';
    const userId = crypto.randomUUID();
    const passwordHash = await hashPassword(adminPassword);

    // 创建管理员用户
    await db
      .prepare(
        `INSERT INTO users (id, email, password_hash, is_admin, is_enabled, created_at)
         VALUES (?, ?, ?, 1, 1, ?)`
      )
      .bind(userId, adminEmail, passwordHash, new Date().toISOString())
      .run();

    // 创建用户 profile（包含默认 AI 配置）
    const defaultAiConfig = JSON.stringify({
      providers: [
        {
          id: 'zhipu_glm',
          name: '智谱GLM',
          isBuiltIn: true,
          apiKey: '',
          baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
          textModel: 'glm-4-flash',
          visionModel: 'glm-4v-flash',
          audioModel: 'glm-4-voice'
        }
      ],
      binding: {
        textProviderId: 'zhipu_glm',
        visionProviderId: 'zhipu_glm',
        speechProviderId: 'zhipu_glm'
      },
      strategy: 'cloud_first',
      custom_prompt: ''
    });
    
    await db
      .prepare(
        `INSERT INTO user_profiles (user_id, display_name, avatar_version, ai_config_json)
         VALUES (?, ?, 0, ?)`
      )
      .bind(userId, 'Admin', defaultAiConfig)
      .run();

    console.log('');
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║                                                            ║');
    console.log('║    🐝 BEECOUNT CLOUD - ADMIN ACCOUNT CREATED! 🐝          ║');
    console.log('║                                                            ║');
    console.log('╠════════════════════════════════════════════════════════════╣');
    console.log('║  Email:    admin@localhost                                 ║');
    console.log('║  Password: ' + adminPassword.padEnd(42) + '║');
    console.log('╠════════════════════════════════════════════════════════════╣');
    console.log('║  PLEASE LOGIN AND CHANGE THIS PASSWORD IMMEDIATELY!        ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log('');
    
    // 同时也输出多行，确保能看到
    console.log('📧 ADMIN EMAIL: admin@localhost');
    console.log('🔑 ADMIN PASSWORD: ' + adminPassword);
    console.log('📝 REMINDER: Change password after first login!');
    
  } catch (error) {
    console.error('❌ [INIT] Failed to initialize admin user:', error);
    if (error instanceof Error) {
      console.error('Error details:', error.message);
      console.error('Stack:', error.stack);
    }
  }
}

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
import adminRouter from './routes/admin';
import sysConfigRouter from './routes/sys_config';

type Bindings = {
  DB: D1Database;
  ASSETS: { fetch: (request: Request) => Promise<Response> };
  API_PREFIX: string;
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
  deviceId: string | null;
};

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// 全局中间件
app.use('*', cors());

// 初始化中间件 - 在第一次请求时创建数据库表和管理员
let initialized = false;
app.use('*', async (c, next) => {
  if (!initialized) {
    await initializeDatabase(c.env.DB);
    await initializeAdmin(c.env.DB);
    initialized = true;
  }
  await next();
});

/**
 * 健康检查端点
 */
app.get('/healthz', (c) => c.json({ status: 'ok' }));

/**
 * 测试端点 - 在所有中间件和其他路由之前！
 */
app.get('/api/v1/test-route', (c) => c.json({ 
  message: 'Test route is working!', 
  time: new Date().toISOString() 
}));

// 我们要的关键路由 - 在所有认证之前！
app.post('/api/v1/admin/backup/test-public', (c) => 
  c.json({ message: 'Public test endpoint works!', time: new Date().toISOString() })
);

// 数据库诊断端点
app.get('/api/v1/admin/backup/diagnose-db', async (c) => {
  const db = c.env.DB;
  
  try {
    // 获取 backup_runs 表结构
    const tableInfo = await db
      .prepare("PRAGMA table_info(backup_runs)")
      .all();
    
    // 获取表是否存在
    const tableExists = await db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='backup_runs'")
      .first();
    
    return c.json({
      status: 'ok',
      table_exists: !!tableExists,
      columns: tableInfo.results || [],
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    return c.json({
      status: 'error',
      error: String(error),
      timestamp: new Date().toISOString()
    }, 500);
  }
});

// 手动数据库迁移端点 - 添加缺失的列
app.post('/api/v1/admin/backup/migrate-db', async (c) => {
  const db = c.env.DB;
  const results: string[] = [];
  
  try {
    // 添加 ledger_id 列
    try {
      await db.prepare('ALTER TABLE backup_runs ADD COLUMN ledger_id TEXT').run();
      results.push('✓ Added ledger_id column');
    } catch (e) {
      results.push('~ ledger_id column already exists');
    }
    
    // 添加 remote_id 列
    try {
      await db.prepare('ALTER TABLE backup_runs ADD COLUMN remote_id TEXT').run();
      results.push('✓ Added remote_id column');
    } catch (e) {
      results.push('~ remote_id column already exists');
    }
    
    // 添加 backup_size 列
    try {
      await db.prepare('ALTER TABLE backup_runs ADD COLUMN backup_size INTEGER').run();
      results.push('✓ Added backup_size column');
    } catch (e) {
      results.push('~ backup_size column already exists');
    }
    
    // 添加 backup_path 列
    try {
      await db.prepare('ALTER TABLE backup_runs ADD COLUMN backup_path TEXT').run();
      results.push('✓ Added backup_path column');
    } catch (e) {
      results.push('~ backup_path column already exists');
    }
    
    // 添加 completed_at 列
    try {
      await db.prepare('ALTER TABLE backup_runs ADD COLUMN completed_at TEXT').run();
      results.push('✓ Added completed_at column');
    } catch (e) {
      results.push('~ completed_at column already exists');
    }
    
    return c.json({
      status: 'success',
      message: 'Database migration completed',
      results: results,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    return c.json({
      status: 'error',
      error: String(error),
      results: results,
      timestamp: new Date().toISOString()
    }, 500);
  }
});

app.post('/api/v1/admin/backup/schedules/:id/run-now', async (c) => {
  try {
    const db = c.env.DB;
    const jwtSecret = c.env.JWT_SECRET;
    const scheduleIdParam = c.req.param('id');
    const scheduleId = Number(scheduleIdParam);
    const serverNow = new Date().toISOString();

    // 手动验证 token（因为这个路由在认证中间件之前定义）
    const authHeader = c.req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return c.json({ error: 'Unauthorized', detail: 'Missing Authorization header' }, 401);
    }

    const token = authHeader.slice(7);
    const userId = await validateAccessToken(token, jwtSecret);
    
    if (!userId) {
      return c.json({ error: 'Unauthorized', detail: 'Invalid or expired token' }, 401);
    }

    // 获取 schedule
    const schedule = await db
      .prepare('SELECT id, name, user_id FROM backup_schedules WHERE id = ?')
      .bind(scheduleId)
      .first<{ id: number; name: string; user_id: string }>();

    if (!schedule) {
      return c.json({ error: 'Schedule not found' }, 404);
    }

    // 策略1：使用认证用户的第一个 ledger
    let ledger = await db
      .prepare('SELECT id, external_id FROM ledgers WHERE user_id = ? LIMIT 1')
      .bind(userId)
      .first<{ id: string; external_id: string }>();

    // 策略2：如果没有，尝试使用 schedule owner 的第一个 ledger
    if (!ledger && schedule.user_id) {
      ledger = await db
        .prepare('SELECT id, external_id FROM ledgers WHERE user_id = ? LIMIT 1')
        .bind(schedule.user_id)
        .first<{ id: string; external_id: string }>();
    }

    // 策略3：最后的备用方案 - 使用系统中的任意一个 ledger
    if (!ledger) {
      ledger = await db
        .prepare('SELECT id, external_id FROM ledgers LIMIT 1')
        .first<{ id: string; external_id: string }>();
    }

    // 如果真的没有任何 ledger，返回详细错误信息
    if (!ledger) {
      return c.json({
        error: 'Ledger not found',
        details: {
          authenticated_user_id: userId,
          schedule_user_id: schedule.user_id,
          schedule_name: schedule.name,
          message: 'No ledgers exist in the system. Please create a ledger first.'
        }
      }, 404);
    }

    await db
      .prepare(
        `INSERT INTO backup_runs (schedule_id, ledger_id, remote_id, status, started_at)
         VALUES (?, ?, NULL, 'pending', ?)`
      )
      .bind(scheduleId, ledger.id, serverNow)
      .run();

    // 获取刚插入的行的 ID
    const result = await db.prepare('SELECT last_insert_rowid() as id').first<{ id: number }>();
    const runId = result?.id?.toString() || crypto.randomUUID();

    return c.json({
      id: runId,
      schedule_id: scheduleId.toString(),
      schedule_name: schedule.name,
      status: 'pending',
      started_at: serverNow,
      finished_at: null,
      backup_filename: null,
      bytes_total: null,
      error_message: null,
      log_text: null,
      targets: [],
      message: 'Backup scheduled. Use /admin/backup/runs to check status.',
    }, 202);
  } catch (e) {
    console.error('[run-now] Error:', e);
    return c.json({ error: 'Internal server error', detail: String(e) }, 500);
  }
});

/**
 * API 版本信息
 */
app.get('/api/v1/version', (c) =>
  c.json({
    name: 'BeeCount Cloud Workers',
    version: '1.0.0',
  })
);

// ===========================
// 认证中间件
// ===========================

// 通用认证中间件处理函数
const authMiddleware = async (c: any, next: () => Promise<void>, skipPaths: string[] = []) => {
  // 检查是否有需要跳过的路径
  for (const skipPath of skipPaths) {
    // 对于头像路径，只跳过 GET 请求，不跳过 POST 上传
    if (skipPath.includes('/profile/avatar')) {
      if (c.req.method === 'GET' && c.req.path.startsWith(skipPath)) {
        return await next();
      }
    } else if (c.req.path.startsWith(skipPath)) {
      return await next();
    }
  }

  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized', detail: 'Missing Authorization header' }, 401);
  }

  const token = authHeader.slice(7);
  
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return c.json({ error: 'Unauthorized', detail: 'Invalid token' }, 401);
    }
    
    const payloadB64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(payloadB64));
    
    if (payload.type !== 'access') {
      return c.json({ error: 'Invalid token type', detail: 'Token must be type=access' }, 401);
    }
  } catch {
    return c.json({ error: 'Unauthorized', detail: 'Invalid token' }, 401);
  }
  
  const userId = await validateAccessToken(token, c.env.JWT_SECRET);
  if (!userId) {
    return c.json({ error: 'Unauthorized', detail: 'Invalid token' }, 401);
  }

  // 从 header 获取 device_id (仅用于 last_seen_at 更新)，与原版一致
  const deviceId = c.req.header('X-Device-ID') || c.req.header('x-device-id');

  // 更新设备最后活跃时间（用于显示在线状态）
  if (deviceId) {
    const now = new Date().toISOString();
    const clientIp = c.req.header('CF-Connecting-IP');
    c.executionCtx.waitUntil(
      c.env.DB
        .prepare('UPDATE devices SET last_seen_at = ?, last_ip = ? WHERE id = ?')
        .bind(now, clientIp ?? null, deviceId)
        .run()
    );
  }

  c.set('userId', userId);
  c.set('deviceId', deviceId ?? null);
  await next();
};

// /api/v1 前缀的路由认证
app.use('/api/v1/*', async (c, next) => {
  await authMiddleware(c, next, [
    '/api/v1/auth', 
    '/api/v1/profile/avatar',
    '/api/v1/test-route',
    '/api/v1/admin/backup/test-public'
  ]);
});

// /2fa 前缀的路由认证（蜜蜂记账 APP 使用 /2fa 路径）
app.use('/2fa/*', async (c, next) => {
  await authMiddleware(c, next, ['/2fa/verify']);
});

// 其他蜜蜂记账 APP 兼容路由（没有 /api/v1 前缀）
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

// ===========================
// 路由注册
// ===========================

app.route('/api/v1/auth', authRouter);
app.route('/api/v1/2fa', twoFactorRouter);
app.route('/2fa', twoFactorRouter); // 蜜蜂记账 APP 使用的路径
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
// 临时在 adminRouter 注册 - 放在最后！让 adminBackupRouter 之后！
app.route('/api/v1/admin', adminRouter);
app.route('/api/v1/sys-config', sysConfigRouter);

// 前端使用的路径：/api/v1/profile/mcp-calls
app.route('/api/v1/profile/mcp-calls', mcpCallsRouter);

// 蜜蜂记账 APP 兼容：添加没有 /api/v1 前缀的路由
app.route('/sync', syncRouter);
app.route('/read', readRouter);
app.route('/write', writeRouter);
app.route('/devices', devicesRouter);
app.route('/profile', profileRouter);
app.route('/attachments', attachmentsRouter);
app.route('/import', importRouter);
app.route('/ai', aiRouter);
app.route('/backup', backupRouter);
app.route('/notifications', notificationsRouter);

// ===========================
// WebSocket 实时同步端点
// ===========================
app.get('/ws', async (c) => {
  const token = c.req.query('token');
  if (!token) {
    return c.json({ error: 'Missing token' }, 400);
  }

  try {
    const userId = await validateAccessToken(token, c.env.JWT_SECRET);
    if (!userId) {
      return c.json({ error: 'Invalid token' }, 401);
    }

    const upgradeHeader = c.req.header('Upgrade');
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
      return c.json({ error: 'Expected WebSocket upgrade' }, 426);
    }

    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    server.accept();

    // 存储连接
    if (!wsConnections.has(userId)) {
      wsConnections.set(userId, new Set());
    }
    wsConnections.get(userId)!.add(server);

    server.addEventListener('message', async (event) => {
      try {
        const message = JSON.parse(event.data);
        console.log('[WS] Received message:', message);
        
        // 广播给同一用户的其他连接
        const connections = wsConnections.get(userId);
        if (connections) {
          connections.forEach((conn) => {
            if (conn !== server && conn.readyState === WebSocket.OPEN) {
              conn.send(event.data);
            }
          });
        }
      } catch (error) {
        console.error('[WS] Error processing message:', error);
      }
    });

    server.addEventListener('close', () => {
      const connections = wsConnections.get(userId);
      if (connections) {
        connections.delete(server);
        if (connections.size === 0) {
          wsConnections.delete(userId);
        }
      }
    });

    server.addEventListener('error', (error) => {
      console.error('[WS] Error:', error);
    });

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  } catch (error) {
    console.error('[WS] Connection error:', error);
    return c.json({ error: 'WebSocket connection failed' }, 500);
  }
});

// ===========================
// 前端静态文件服务 (SPA 支持)
// ===========================
app.get('*', async (c, next) => {
  const url = new URL(c.req.url);
  const pathname = url.pathname;
  
  // 如果是 API 路由或其他后端路由，直接下一个中间件，不用处理！
  if (pathname.startsWith('/api/v1/') || 
      pathname.startsWith('/sync') || 
      pathname.startsWith('/read') || 
      pathname.startsWith('/write') || 
      pathname.startsWith('/devices') || 
      pathname.startsWith('/profile') || 
      pathname.startsWith('/attachments') || 
      pathname.startsWith('/import') || 
      pathname.startsWith('/ai') || 
      pathname.startsWith('/backup') || 
      pathname.startsWith('/notifications') || 
      pathname.startsWith('/ws') || 
      pathname.startsWith('/2fa') || 
      pathname.startsWith('/mcp-calls') || 
      pathname.startsWith('/admin') || 
      pathname.startsWith('/sys-config')) {
    return await next();
  }
  
  // 静态资源文件 (assets, branding, icons, manifest.webmanifest, sw.js)
  // 这些文件应该直接从 ASSETS 获取
  const isStaticAsset = pathname.startsWith('/assets/') || 
                       pathname.startsWith('/branding/') || 
                       pathname.startsWith('/icons/') ||
                       pathname === '/manifest.webmanifest' ||
                       pathname === '/sw.js';
  
  // 获取请求的文件
  const res = await c.env.ASSETS.fetch(c.req.raw);
  
  if (isStaticAsset) {
    // 静态资源文件直接返回
    return res;
  }
  
  // 对于其他路径，如果文件不存在，返回 index.html (SPA 路由)
  if (res.status === 404) {
    const indexRes = await c.env.ASSETS.fetch(new Request(`${url.origin}/index.html`, { method: 'GET' }));
    return indexRes;
  }
  
  return res;
});

// ===========================
// 错误处理
// ===========================

app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({ error: 'Internal Server Error' }, 500);
});

// ===========================
// 导出应用
// ===========================

export default app;
