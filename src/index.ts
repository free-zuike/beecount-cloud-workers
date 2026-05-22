/**
 * BeeCount Cloud Workers - 入口文件
 *
 * 完整实现 BeeCount Cloud API 协议的 Cloudflare Workers 版本
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { validateAccessToken, hashPassword, base64urlDecode } from './auth';

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

// 初始化数据库表（完整 schema）
async function initializeDatabase(db: D1Database): Promise<void> {
  try {
    console.log('[INIT] Checking and creating database tables...');

    // 使用完整的 schema.sql 创建所有表
    // Users table
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

    await db.prepare('CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_users_is_admin ON users(is_admin)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_users_is_enabled ON users(is_enabled)').run();

    // Recovery codes table
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS recovery_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_hash TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
      )
    `).run();

    await db.prepare('CREATE INDEX IF NOT EXISTS idx_recovery_codes_user_id ON recovery_codes(user_id)').run();

    // User profiles table
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

    await db.prepare('CREATE INDEX IF NOT EXISTS idx_user_profiles_user_id ON user_profiles(user_id)').run();

    // Refresh tokens table
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_id TEXT,
        token_hash TEXT UNIQUE NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
      )
    `).run();

    await db.prepare('CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_refresh_tokens_device_id ON refresh_tokens(device_id)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token_hash ON refresh_tokens(token_hash)').run();

    // Personal Access Tokens table
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS personal_access_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        token_hash TEXT UNIQUE NOT NULL,
        prefix TEXT NOT NULL,
        scopes_json TEXT DEFAULT '[]' NOT NULL,
        expires_at TEXT,
        last_used_at TEXT,
        last_used_ip TEXT,
        revoked_at TEXT,
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
      )
    `).run();

    await db.prepare('CREATE INDEX IF NOT EXISTS idx_pats_user_id ON personal_access_tokens(user_id)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_pats_token_hash ON personal_access_tokens(token_hash)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_pats_prefix ON personal_access_tokens(prefix)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_pat_user_active ON personal_access_tokens(user_id, revoked_at)').run();

    // MCP call logs table
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS mcp_call_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        pat_id TEXT REFERENCES personal_access_tokens(id) ON DELETE SET NULL,
        pat_prefix TEXT,
        pat_name TEXT,
        tool_name TEXT NOT NULL,
        status TEXT NOT NULL,
        error_message TEXT,
        args_summary TEXT,
        duration_ms INTEGER DEFAULT 0,
        client_ip TEXT,
        called_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
      )
    `).run();

    await db.prepare('CREATE INDEX IF NOT EXISTS idx_mcp_call_user_time ON mcp_call_logs(user_id, called_at DESC)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_mcp_call_logs_user_id ON mcp_call_logs(user_id)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_mcp_call_logs_pat_id ON mcp_call_logs(pat_id)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_mcp_call_logs_tool_name ON mcp_call_logs(tool_name)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_mcp_call_logs_status ON mcp_call_logs(status)').run();

    // Audit logs table
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        ledger_id TEXT,
        action TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
      )
    `).run();

    await db.prepare('CREATE INDEX IF NOT EXISTS idx_audit_logs_user_time ON audit_logs(user_id, created_at DESC)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC)').run();

    // Devices table
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT DEFAULT 'Unknown Device',
        platform TEXT DEFAULT 'unknown',
        app_version TEXT,
        os_version TEXT,
        device_model TEXT,
        last_ip TEXT,
        last_seen_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
        revoked_at TEXT,
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
      )
    `).run();

    await db.prepare('CREATE INDEX IF NOT EXISTS idx_devices_user_id ON devices(user_id)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_devices_last_seen_at ON devices(last_seen_at)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_devices_revoked_at ON devices(revoked_at)').run();

    // Ledgers table
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

    await db.prepare('CREATE INDEX IF NOT EXISTS idx_ledgers_user_id ON ledgers(user_id)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_ledgers_external_id ON ledgers(external_id)').run();

    // Sync changes table
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

    await db.prepare('CREATE INDEX IF NOT EXISTS idx_sync_changes_user_cursor ON sync_changes(user_id, change_id)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_sync_changes_ledger_cursor ON sync_changes(ledger_id, change_id)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_sync_changes_entity_latest ON sync_changes(ledger_id, entity_type, entity_sync_id, change_id)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_sync_changes_user_id ON sync_changes(user_id)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_sync_changes_ledger_id ON sync_changes(ledger_id)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_sync_changes_entity_type ON sync_changes(entity_type)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_sync_changes_action ON sync_changes(action)').run();

    // Sync cursors table
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS sync_cursors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_id TEXT NOT NULL,
        ledger_external_id TEXT NOT NULL,
        last_cursor INTEGER DEFAULT 0 NOT NULL,
        updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
        UNIQUE(user_id, device_id, ledger_external_id)
      )
    `).run();

    await db.prepare('CREATE INDEX IF NOT EXISTS idx_sync_cursors_user_id ON sync_cursors(user_id)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_sync_cursors_device_id ON sync_cursors(device_id)').run();

    // Sync push idempotency table
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS sync_push_idempotency (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        response_json TEXT NOT NULL,
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
        expires_at TEXT NOT NULL,
        UNIQUE(user_id, device_id, idempotency_key)
      )
    `).run();

    await db.prepare('CREATE INDEX IF NOT EXISTS idx_sync_push_idempotency_user_id ON sync_push_idempotency(user_id)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_sync_push_idempotency_expires_at ON sync_push_idempotency(expires_at)').run();

    // Backup snapshots table
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS backup_snapshots (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        ledger_id TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
        snapshot_json TEXT NOT NULL,
        note TEXT,
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
      )
    `).run();

    await db.prepare('CREATE INDEX IF NOT EXISTS idx_backup_snapshots_user_id ON backup_snapshots(user_id)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_backup_snapshots_ledger_id ON backup_snapshots(ledger_id)').run();

    // Backup remotes table
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

    await db.prepare('CREATE INDEX IF NOT EXISTS idx_backup_remotes_backend_type ON backup_remotes(backend_type)').run();

    // Backup schedules table
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS backup_schedules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        ledger_id TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
        remote_id TEXT REFERENCES backup_remotes(id) ON DELETE SET NULL,
        cron_expression TEXT NOT NULL,
        retention_days INTEGER DEFAULT 30,
        enabled BOOLEAN DEFAULT 1 NOT NULL,
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
        updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
      )
    `).run();

    await db.prepare('CREATE INDEX IF NOT EXISTS idx_backup_schedules_ledger_id ON backup_schedules(ledger_id)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_backup_schedules_remote_id ON backup_schedules(remote_id)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_backup_schedules_enabled ON backup_schedules(enabled)').run();

    // Backup runs table
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS backup_runs (
        id TEXT PRIMARY KEY,
        schedule_id TEXT REFERENCES backup_schedules(id) ON DELETE SET NULL,
        ledger_id TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
        remote_id TEXT REFERENCES backup_remotes(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        error_message TEXT,
        backup_size INTEGER,
        backup_path TEXT,
        started_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
        completed_at TEXT
      )
    `).run();

    await db.prepare('CREATE INDEX IF NOT EXISTS idx_backup_runs_schedule_id ON backup_runs(schedule_id)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_backup_runs_ledger_id ON backup_runs(ledger_id)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_backup_runs_status ON backup_runs(status)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_backup_runs_started_at ON backup_runs(started_at DESC)').run();

    // Attachment files table
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS attachment_files (
        id TEXT PRIMARY KEY,
        ledger_id TEXT REFERENCES ledgers(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        sha256 TEXT NOT NULL,
        size_bytes INTEGER DEFAULT 0,
        mime_type TEXT,
        file_name TEXT,
        storage_path TEXT NOT NULL,
        attachment_kind TEXT DEFAULT 'transaction' NOT NULL,
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
      )
    `).run();

    await db.prepare('CREATE INDEX IF NOT EXISTS idx_attachment_files_sha256 ON attachment_files(sha256)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_attachment_files_ledger_created ON attachment_files(ledger_id, created_at)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_attachment_files_user_id ON attachment_files(user_id)').run();

    // Read projections tables
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS read_tx_projection (
        ledger_id TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
        sync_id TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        tx_type TEXT NOT NULL,
        amount REAL DEFAULT 0.0,
        happened_at TEXT NOT NULL,
        note TEXT,
        category_sync_id TEXT,
        category_name TEXT,
        category_kind TEXT,
        account_sync_id TEXT,
        account_name TEXT,
        from_account_sync_id TEXT,
        from_account_name TEXT,
        to_account_sync_id TEXT,
        to_account_name TEXT,
        tags_csv TEXT,
        tag_sync_ids_json TEXT,
        attachments_json TEXT,
        tx_index INTEGER DEFAULT 0,
        created_by_user_id TEXT,
        source_change_id INTEGER DEFAULT 0,
        PRIMARY KEY (ledger_id, sync_id)
      )
    `).run();

    await db.prepare('CREATE INDEX IF NOT EXISTS ix_read_tx_ledger_time ON read_tx_projection(ledger_id, happened_at DESC, tx_index DESC)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS ix_read_tx_ledger_category ON read_tx_projection(ledger_id, category_sync_id)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS ix_read_tx_ledger_account ON read_tx_projection(ledger_id, account_sync_id)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS ix_read_tx_user_time ON read_tx_projection(user_id, happened_at DESC)').run();

    await db.prepare(`
      CREATE TABLE IF NOT EXISTS read_account_projection (
        ledger_id TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
        sync_id TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT,
        account_type TEXT,
        currency TEXT,
        initial_balance REAL,
        note TEXT,
        credit_limit REAL,
        billing_day INTEGER,
        payment_due_day INTEGER,
        bank_name TEXT,
        card_last_four TEXT,
        source_change_id INTEGER DEFAULT 0,
        PRIMARY KEY (ledger_id, sync_id)
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

    await db.prepare('CREATE INDEX IF NOT EXISTS ix_read_cat_ledger_kind ON read_category_projection(ledger_id, kind)').run();

    await db.prepare(`
      CREATE TABLE IF NOT EXISTS read_tag_projection (
        ledger_id TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
        sync_id TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT,
        color TEXT,
        source_change_id INTEGER DEFAULT 0,
        PRIMARY KEY (ledger_id, sync_id)
      )
    `).run();

    await db.prepare(`
      CREATE TABLE IF NOT EXISTS read_budget_projection (
        ledger_id TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
        sync_id TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        budget_type TEXT,
        category_sync_id TEXT,
        amount REAL,
        period TEXT,
        start_day INTEGER,
        enabled BOOLEAN DEFAULT 1,
        source_change_id INTEGER DEFAULT 0,
        PRIMARY KEY (ledger_id, sync_id)
      )
    `).run();

    await db.prepare('CREATE INDEX IF NOT EXISTS ix_read_budget_ledger_cat ON read_budget_projection(ledger_id, category_sync_id)').run();

    // System settings table
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS system_settings (
        id TEXT PRIMARY KEY,
        timezone_offset INTEGER DEFAULT 0,
        cloud_config_json TEXT,
        setup_completed BOOLEAN DEFAULT 0 NOT NULL,
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
        updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
      )
    `).run();

    console.log('[INIT] Database tables created/verified successfully');
    
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
    } else {
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
    }
    
    // 不再自动创建测试用户
    // 用户可以自己注册账号使用
    
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

// 初始化中间件 - 在第一次请求时创建数据库表
let initialized = false;
app.use('*', async (c, next) => {
  if (!initialized) {
    await initializeDatabase(c.env.DB);
    // 不再自动创建管理员账户，由设置向导创建
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

// 用户登录诊断端点
app.get('/api/v1/diagnose-users', async (c) => {
  const db = c.env.DB;
  
  try {
    // 获取所有用户
    const users = await db.prepare('SELECT id, email, is_admin, is_enabled, created_at FROM users').all();
    
    // 检查是否有管理员用户
    const adminCount = await db.prepare('SELECT COUNT(*) as count FROM users WHERE is_admin = 1').first();
    
    return c.json({
      status: 'ok',
      users: users.results || [],
      admin_count: adminCount,
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

// 重置管理员密码端点
app.post('/api/v1/reset-admin-password', async (c) => {
  const db = c.env.DB;
  
  try {
    // 查找或创建管理员用户
    const existingAdmin = await db
      .prepare('SELECT id FROM users WHERE email = ?')
      .bind('admin@localhost')
      .first();
    
    // 生成新密码
    const newPassword = generateRandomPassword();
    const passwordHash = await hashPassword(newPassword);
    
    if (existingAdmin) {
      // 更新现有管理员密码
      await db
        .prepare('UPDATE users SET password_hash = ?, is_enabled = 1 WHERE id = ?')
        .bind(passwordHash, existingAdmin.id)
        .run();
      
      console.log('========================================');
      console.log('🔑 管理员密码已重置:');
      console.log('邮箱: admin@localhost');
      console.log('新密码:', newPassword);
      console.log('========================================');
      
      return c.json({
        status: 'ok',
        message: '管理员密码已重置',
        email: 'admin@localhost',
        new_password: newPassword,
        timestamp: new Date().toISOString()
      });
    } else {
      // 创建新管理员用户
      const userId = crypto.randomUUID();
      
      await db
        .prepare(
          `INSERT INTO users (id, email, password_hash, is_admin, is_enabled, created_at)
           VALUES (?, ?, ?, 1, 1, ?)`
        )
        .bind(userId, 'admin@localhost', passwordHash, new Date().toISOString())
        .run();
      
      // 创建用户 profile
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
      
      console.log('========================================');
      console.log('🐝 管理员账户已创建:');
      console.log('邮箱: admin@localhost');
      console.log('密码:', newPassword);
      console.log('========================================');
      
      return c.json({
        status: 'ok',
        message: '管理员账户已创建',
        email: 'admin@localhost',
        new_password: newPassword,
        timestamp: new Date().toISOString()
      });
    }
  } catch (error) {
    console.error('重置管理员密码失败:', error);
    return c.json({
      status: 'error',
      error: String(error),
      timestamp: new Date().toISOString()
    }, 500);
  }
});

// 数据库诊断端点
app.get('/api/v1/admin/backup/diagnose-db', async (c) => {
  const db = c.env.DB;
  
  try {
    // 获取 backup_runs 表结构
    const runsTableInfo = await db
      .prepare("PRAGMA table_info(backup_runs)")
      .all();
    
    // 获取 backup_schedules 表结构
    const schedulesTableInfo = await db
      .prepare("PRAGMA table_info(backup_schedules)")
      .all();
    
    // 获取表是否存在
    const runsTableExists = await db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='backup_runs'")
      .first();
    
    const schedulesTableExists = await db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='backup_schedules'")
      .first();
    
    // 获取一条示例数据
    let sampleRun = null;
    try {
      sampleRun = await db.prepare('SELECT * FROM backup_runs LIMIT 1').first();
    } catch (e) {
      sampleRun = { error: String(e) };
    }
    
    // 获取所有备份计划
    let schedules = null;
    try {
      schedules = await db.prepare('SELECT * FROM backup_schedules').all();
    } catch (e) {
      schedules = { error: String(e) };
    }
    
    return c.json({
      status: 'ok',
      backup_runs_table_exists: !!runsTableExists,
      backup_schedules_table_exists: !!schedulesTableExists,
      backup_runs_columns: runsTableInfo.results || [],
      backup_schedules_columns: schedulesTableInfo.results || [],
      sample_run: sampleRun,
      schedules: schedules?.results || schedules,
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
    // 添加 remote_ids 列到 backup_schedules 表
    try {
      await db.prepare('ALTER TABLE backup_schedules ADD COLUMN remote_ids TEXT').run();
      results.push('✓ Added remote_ids column to backup_schedules');
    } catch (e) {
      results.push('~ remote_ids column already exists in backup_schedules');
    }
    
    // 添加 next_run_at 列到 backup_schedules 表
    try {
      await db.prepare('ALTER TABLE backup_schedules ADD COLUMN next_run_at TEXT').run();
      results.push('✓ Added next_run_at column to backup_schedules');
    } catch (e) {
      results.push('~ next_run_at column already exists in backup_schedules');
    }
    
    // 添加 last_run_at 列到 backup_schedules 表
    try {
      await db.prepare('ALTER TABLE backup_schedules ADD COLUMN last_run_at TEXT').run();
      results.push('✓ Added last_run_at column to backup_schedules');
    } catch (e) {
      results.push('~ last_run_at column already exists in backup_schedules');
    }
    
    // 添加 last_run_status 列到 backup_schedules 表
    try {
      await db.prepare('ALTER TABLE backup_schedules ADD COLUMN last_run_status TEXT').run();
      results.push('✓ Added last_run_status column to backup_schedules');
    } catch (e) {
      results.push('~ last_run_status column already exists in backup_schedules');
    }
    
    // 添加 timezone_offset 列到 backup_schedules 表
    try {
      await db.prepare('ALTER TABLE backup_schedules ADD COLUMN timezone_offset INTEGER DEFAULT 0').run();
      results.push('✓ Added timezone_offset column to backup_schedules');
    } catch (e) {
      results.push('~ timezone_offset column already exists in backup_schedules');
    }
    
    // 添加 cloud_config_json 列到 system_settings 表
    try {
      await db.prepare('ALTER TABLE system_settings ADD COLUMN cloud_config_json TEXT').run();
      results.push('✓ Added cloud_config_json column to system_settings');
    } catch (e) {
      results.push('~ cloud_config_json column already exists in system_settings');
    }
    
    // 添加 ledger_id 列
    try {
      await db.prepare('ALTER TABLE backup_runs ADD COLUMN ledger_id TEXT').run();
      results.push('✓ Added ledger_id column');
      await db.prepare('UPDATE backup_runs SET ledger_id = "" WHERE ledger_id IS NULL').run();
      results.push('✓ Updated existing rows with default ledger_id');
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
    
    // 迁移 backup_remotes 表：从 config 列迁移到 config_json 列
    try {
      // 检查 config_json 列是否存在
      const pragmaResult = await db.prepare("PRAGMA table_info(backup_remotes)").all();
      const columns = (pragmaResult.results || []) as { name: string }[];
      const hasConfigJson = columns.some(col => col.name === 'config_json');
      
      if (!hasConfigJson) {
        // 检查 config 列是否存在
        const hasConfig = columns.some(col => col.name === 'config');
        
        if (hasConfig) {
          // 添加 config_json 列并复制 config 的值
          await db.prepare('ALTER TABLE backup_remotes ADD COLUMN config_json TEXT').run();
          results.push('✓ Added config_json column to backup_remotes');
          
          await db.prepare('UPDATE backup_remotes SET config_json = config WHERE config_json IS NULL').run();
          results.push('✓ Copied config values to config_json');
        } else {
          // 如果 config 列也不存在，直接添加 config_json
          await db.prepare('ALTER TABLE backup_remotes ADD COLUMN config_json TEXT').run();
          results.push('✓ Added config_json column to backup_remotes');
        }
      } else {
        results.push('~ config_json column already exists in backup_remotes');
      }
    } catch (e) {
      results.push('~ Error checking/migrating backup_remotes: ' + String(e));
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
    
    // 添加 finished_at 列
    try {
      await db.prepare('ALTER TABLE backup_runs ADD COLUMN finished_at TEXT').run();
      results.push('✓ Added finished_at column');
    } catch (e) {
      results.push('~ finished_at column already exists');
    }
    
    // 添加 bytes_total 列
    try {
      await db.prepare('ALTER TABLE backup_runs ADD COLUMN bytes_total INTEGER').run();
      results.push('✓ Added bytes_total column');
    } catch (e) {
      results.push('~ bytes_total column already exists');
    }
    
    // 添加 backup_filename 列
    try {
      await db.prepare('ALTER TABLE backup_runs ADD COLUMN backup_filename TEXT').run();
      results.push('✓ Added backup_filename column');
    } catch (e) {
      results.push('~ backup_filename column already exists');
    }
    
    // 添加 app_version 列到 devices 表
    try {
      await db.prepare('ALTER TABLE devices ADD COLUMN app_version TEXT').run();
      results.push('✓ Added app_version column to devices');
    } catch (e) {
      results.push('~ app_version column already exists in devices');
    }
    
    // 添加 os_version 列到 devices 表
    try {
      await db.prepare('ALTER TABLE devices ADD COLUMN os_version TEXT').run();
      results.push('✓ Added os_version column to devices');
    } catch (e) {
      results.push('~ os_version column already exists in devices');
    }
    
    // 添加 device_model 列到 devices 表
    try {
      await db.prepare('ALTER TABLE devices ADD COLUMN device_model TEXT').run();
      results.push('✓ Added device_model column to devices');
    } catch (e) {
      results.push('~ device_model column already exists in devices');
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

// 检查系统是否已初始化
app.get('/setup', async (c) => {
  const db = c.env.DB;
  
  const settings = await db
    .prepare('SELECT setup_completed FROM system_settings WHERE id = ?')
    .bind('default')
    .first<{ setup_completed: number }>();
  
  if (settings && settings.setup_completed === 1) {
    return c.redirect('/login');
  }
  
  return c.html(getSetupPageHTML());
});

// 获取设置页面
app.get('/login', async (c) => {
  const db = c.env.DB;
  
  const settings = await db
    .prepare('SELECT setup_completed FROM system_settings WHERE id = ?')
    .bind('default')
    .first<{ setup_completed: number }>();
  
  if (!settings || settings.setup_completed === 0) {
    return c.redirect('/setup');
  }
  
  return c.html(`
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>蜜蜂记账 - 登录</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .login-container {
      background: white;
      padding: 40px;
      border-radius: 12px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.2);
      width: 100%;
      max-width: 400px;
    }
    h1 {
      text-align: center;
      color: #667eea;
      margin-bottom: 30px;
      font-size: 28px;
    }
    .form-group {
      margin-bottom: 20px;
    }
    label {
      display: block;
      margin-bottom: 8px;
      color: #333;
      font-weight: 500;
    }
    input {
      width: 100%;
      padding: 12px;
      border: 2px solid #e0e0e0;
      border-radius: 6px;
      font-size: 16px;
      transition: border-color 0.3s;
    }
    input:focus {
      outline: none;
      border-color: #667eea;
    }
    button {
      width: 100%;
      padding: 14px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border: none;
      border-radius: 6px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: transform 0.2s;
    }
    button:hover {
      transform: translateY(-2px);
    }
    .message {
      padding: 12px;
      border-radius: 6px;
      margin-bottom: 20px;
      display: none;
    }
    .message.error {
      background: #fee;
      color: #c33;
      display: block;
    }
    .message.success {
      background: #efe;
      color: #3c3;
      display: block;
    }
  </style>
</head>
<body>
  <div class="login-container">
    <h1>🐝 蜜蜂记账</h1>
    <div id="message" class="message"></div>
    <form id="loginForm">
      <div class="form-group">
        <label for="email">邮箱</label>
        <input type="email" id="email" name="email" required placeholder="admin@example.com">
      </div>
      <div class="form-group">
        <label for="password">密码</label>
        <input type="password" id="password" name="password" required placeholder="请输入密码">
      </div>
      <button type="submit">登录</button>
    </form>
  </div>
  <script>
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const formData = new FormData(e.target);
      const email = formData.get('email');
      const password = formData.get('password');
      const messageEl = document.getElementById('message');
      
      try {
        const response = await fetch('/api/v1/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password })
        });
        
        const data = await response.json();
        
        if (response.ok) {
          localStorage.setItem('token', data.token);
          messageEl.className = 'message success';
          messageEl.textContent = '登录成功！';
          setTimeout(() => {
            window.location.href = '/app';
          }, 1000);
        } else {
          messageEl.className = 'message error';
          messageEl.textContent = data.error || '登录失败';
        }
      } catch (error) {
        messageEl.className = 'message error';
        messageEl.textContent = '网络错误，请重试';
      }
    });
  </script>
</body>
</html>
  `);
});

// 处理初始化设置提交
app.post('/api/v1/setup', async (c) => {
  const db = c.env.DB;
  
  try {
    const body = await c.req.json();
    const { timezone_offset, cloud_config, admin_mode, admin_email, admin_password } = body;
    
    // 检查是否已经设置过
    const existing = await db
      .prepare('SELECT id FROM system_settings WHERE id = ?')
      .bind('default')
      .first();
    
    const serverNow = new Date().toISOString();
    
    // 序列化云存储配置
    const cloudConfigJson = cloud_config ? JSON.stringify(cloud_config) : null;
    
    if (existing) {
      // 更新现有设置
      await db
        .prepare(`
          UPDATE system_settings SET
            timezone_offset = ?,
            cloud_config_json = ?,
            setup_completed = 1,
            updated_at = ?
          WHERE id = ?
        `)
        .bind(
          timezone_offset || 0,
          cloudConfigJson,
          serverNow,
          'default'
        )
        .run();
    } else {
      // 创建新设置
      await db
        .prepare(`
          INSERT INTO system_settings
            (id, timezone_offset, cloud_config_json, setup_completed, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        .bind(
          'default',
          timezone_offset || 0,
          cloudConfigJson,
          1,
          serverNow,
          serverNow
        )
        .run();
    }
    
    // 创建管理员账户
    if (admin_mode === 'auto' || (admin_mode === 'manual' && admin_email && admin_password)) {
      // 检查是否已有管理员账户
      const existingAdmin = await db
        .prepare('SELECT COUNT(*) as count FROM users WHERE is_admin = 1')
        .first<{ count: number }>();
      
      if (existingAdmin && existingAdmin.count > 0) {
        return c.json({
          success: true,
          message: '系统设置已保存，管理员账户已存在',
          timezone_offset: timezone_offset || 0
        });
      }
      
      let userId: string;
      let passwordHash: string;
      let userEmail: string;
      
      if (admin_mode === 'auto') {
        // 自动生成管理员账户
        const generateRandomPassword = () => {
          const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
          let password = '';
          for (let i = 0; i < 12; i++) {
            password += chars.charAt(Math.floor(Math.random() * chars.length));
          }
          return password;
        };
        
        userEmail = 'admin@localhost';
        const adminPassword = generateRandomPassword();
        userId = crypto.randomUUID();
        passwordHash = await hashPassword(adminPassword);
        
        // 创建用户
        await db.prepare(`
          INSERT INTO users (id, email, password_hash, is_admin, is_enabled)
          VALUES (?, ?, ?, 1, 1)
        `).bind(userId, userEmail, passwordHash).run();
        
        // 创建用户 profile
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
        
        await db.prepare(`
          INSERT INTO user_profiles (user_id, display_name, ai_config_json)
          VALUES (?, ?, ?)
        `).bind(userId, 'admin', defaultAiConfig).run();
        
        // 打印到日志
        console.log('========================================');
        console.log('🐝 BeeCount 管理员账户已创建:');
        console.log('邮箱:', userEmail);
        console.log('密码:', adminPassword);
        console.log('========================================');
        
        return c.json({
          success: true,
          message: '系统设置已保存，管理员账户已创建',
          timezone_offset: timezone_offset || 0,
          user_email: userEmail,
          auto_generated_password: adminPassword
        });
      } else {
        // 手动创建管理员账户
        userId = crypto.randomUUID();
        passwordHash = await hashPassword(admin_password);
        userEmail = admin_email.toLowerCase();
        
        // Create user
        await db.prepare(`
          INSERT INTO users (id, email, password_hash, is_admin, is_enabled)
          VALUES (?, ?, ?, 1, 1)
        `).bind(userId, userEmail, passwordHash).run();
        
        // Create user profile with default AI config
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
        
        await db.prepare(`
          INSERT INTO user_profiles (user_id, display_name, ai_config_json)
          VALUES (?, ?, ?)
        `).bind(userId, userEmail.split('@')[0], defaultAiConfig).run();
        
        return c.json({
          success: true,
          message: '系统设置已保存，管理员账户已创建',
          timezone_offset: timezone_offset || 0,
          user_email: userEmail
        });
      }
    }
    
    return c.json({
      success: true,
      message: '系统设置已保存',
      timezone_offset: timezone_offset || 0
    });
  } catch (error) {
    console.error('[Setup] Error saving settings:', error);
    return c.json({
      success: false,
      error: '保存设置失败',
      details: error instanceof Error ? error.message : String(error)
    }, 500);
  }
});

// 获取当前系统设置
app.get('/api/v1/setup', async (c) => {
  const db = c.env.DB;
  
  try {
    const settings = await db
      .prepare('SELECT * FROM system_settings WHERE id = ?')
      .bind('default')
      .first();
    
    if (!settings) {
      return c.json({
        setup_completed: false,
        timezone_offset: 0,
        cloud_config: null
      });
    }
    
    // 解析云存储配置
    let cloudConfig = null;
    const settingsAny = settings as any;
    if (settingsAny.cloud_config_json) {
      try {
        cloudConfig = JSON.parse(settingsAny.cloud_config_json);
        // 隐藏敏感信息
        if (cloudConfig && cloudConfig.config) {
          if (cloudConfig.config.access_key_id) cloudConfig.config.access_key_id = '***';
          if (cloudConfig.config.secret_access_key) cloudConfig.config.secret_access_key = '***';
          if (cloudConfig.config.key) cloudConfig.config.key = '***';
          if (cloudConfig.config.client_secret) cloudConfig.config.client_secret = '***';
          if (cloudConfig.config.pass) cloudConfig.config.pass = '***';
          if (cloudConfig.config.token) cloudConfig.config.token = '***';
        }
      } catch {}
    }
    
    return c.json({
      setup_completed: Boolean(settingsAny.setup_completed),
      timezone_offset: settingsAny.timezone_offset || 0,
      cloud_config: cloudConfig
    });
  } catch (error) {
    return c.json({
      setup_completed: false,
      timezone_offset: 0,
      cloud_config: null
    });
  }
});

function getSetupPageHTML(): string {
  // 最安全的方式：不使用任何嵌套引号
  const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>蜜蜂记账 - 初始设置</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; padding: 40px 20px; }
    .setup-container { background: white; padding: 40px; border-radius: 12px; box-shadow: 0 10px 40px rgba(0,0,0,0.2); width: 100%; max-width: 700px; margin: 0 auto; max-height: 90vh; overflow-y: auto; }
    h1 { text-align: center; color: #667eea; margin-bottom: 10px; font-size: 28px; }
    .subtitle { text-align: center; color: #666; margin-bottom: 30px; }
    .section { margin-bottom: 30px; padding-bottom: 20px; border-bottom: 2px solid #f0f0f0; }
    .section:last-child { border-bottom: none; }
    .section-title { color: #333; font-size: 18px; font-weight: 600; margin-bottom: 15px; display: flex; align-items: center; gap: 8px; }
    .form-group { margin-bottom: 15px; }
    label { display: block; margin-bottom: 6px; color: #555; font-weight: 500; font-size: 14px; }
    input, select { width: 100%; padding: 10px 12px; border: 2px solid #e0e0e0; border-radius: 6px; font-size: 14px; }
    input:focus, select:focus { outline: none; border-color: #667eea; }
    .checkbox-group { display: flex; align-items: center; gap: 8px; }
    .checkbox-group input[type=checkbox] { width: 18px; height: 18px; }
    button { width: 100%; padding: 14px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; border-radius: 6px; font-size: 16px; font-weight: 600; cursor: pointer; }
    button:hover { transform: translateY(-2px); transition: transform 0.2s; }
    button:disabled { opacity: 0.6; cursor: not-allowed; }
    .message { padding: 12px; border-radius: 6px; margin-bottom: 20px; display: none; }
    .message.error { background: #fee; color: #c33; display: block; }
    .message.success { background: #efe; color: #3c3; display: block; }
    .hint { font-size: 12px; color: #888; margin-top: 4px; }
    .copy-btn { padding: 4px 12px; background: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; margin-left: 8px; }
    .copy-btn.green { background: #28a745; }
    .result-row { display: flex; align-items: center; gap: 8px; margin: 8px 0; }
    .result-input { flex: 1; padding: 4px 8px; border: 1px solid #ddd; border-radius: 4px; font-family: monospace; }
  </style>
</head>
<body>
  <div class="setup-container">
    <h1>🐝 蜜蜂记账</h1>
    <p class="subtitle">首次设置向导</p>
    <div id="message" class="message"></div>
    <form id="setupForm">
      <div class="section">
        <div class="section-title">👤 管理员账户</div>
        <div class="form-group">
          <label><input type="radio" name="admin_mode" value="auto" checked> 自动创建管理员账户（推荐）</label>
          <div class="hint">系统将自动生成管理员账户和随机密码，请务必记录</div>
        </div>
        <div class="form-group">
          <label><input type="radio" name="admin_mode" value="manual"> 手动设置管理员账户</label>
          <div class="hint">手动输入邮箱和密码</div>
        </div>
        <div id="manualAdminFields" style="display: none;">
          <div class="form-group">
            <label for="admin_email">邮箱地址</label>
            <input type="email" id="admin_email" name="admin_email" placeholder="admin@example.com">
          </div>
          <div class="form-group">
            <label for="admin_password">密码</label>
            <input type="password" id="admin_password" name="admin_password" placeholder="••••••••" minlength="6">
          </div>
          <div class="form-group">
            <label for="admin_password_confirm">确认密码</label>
            <input type="password" id="admin_password_confirm" name="admin_password_confirm" placeholder="••••••••" minlength="6">
          </div>
        </div>
      </div>
      <div class="section">
        <div class="section-title">🌍 时区设置</div>
        <div class="form-group">
          <label for="timezone">选择时区</label>
          <select id="timezone" name="timezone_offset">
            <option value="-720">UTC-12 (贝克岛)</option>
            <option value="-660">UTC-11 (美属萨摩亚)</option>
            <option value="-600">UTC-10 (夏威夷)</option>
            <option value="-540">UTC-9 (阿拉斯加)</option>
            <option value="-480">UTC-8 (洛杉矶、温哥华)</option>
            <option value="-420">UTC-7 (丹佛、凤凰城)</option>
            <option value="-360">UTC-6 (芝加哥、墨西哥城)</option>
            <option value="-300">UTC-5 (纽约、多伦多)</option>
            <option value="-240">UTC-4 (圣地亚哥、哈利法克斯)</option>
            <option value="-210">UTC-3:30 (纽芬兰)</option>
            <option value="-180">UTC-3 (圣保罗、布宜诺斯艾利斯)</option>
            <option value="-120">UTC-2 (大西洋中部)</option>
            <option value="-60">UTC-1 (亚速尔群岛)</option>
            <option value="0">UTC+0 (伦敦、都柏林、里斯本)</option>
            <option value="60">UTC+1 (巴黎、柏林、罗马)</option>
            <option value="120">UTC+2 (雅典、赫尔辛基、基辅)</option>
            <option value="180">UTC+3 (莫斯科、伊斯坦布尔)</option>
            <option value="210">UTC+3:30 (德黑兰)</option>
            <option value="240">UTC+4 (迪拜、巴库)</option>
            <option value="270">UTC+4:30 (喀布尔)</option>
            <option value="300">UTC+5 (卡拉奇、塔什干)</option>
            <option value="330">UTC+5:30 (孟买、新德里、科伦坡)</option>
            <option value="345">UTC+5:45 (加德满都)</option>
            <option value="360">UTC+6 (达卡、新西伯利亚)</option>
            <option value="390">UTC+6:30 (仰光)</option>
            <option value="420">UTC+7 (曼谷、雅加达)</option>
            <option value="480" selected>UTC+8 (北京时间、香港、新加坡)</option>
            <option value="540">UTC+9 (东京、首尔、雅库茨克)</option>
            <option value="570">UTC+9:30 (阿德莱德、达尔文)</option>
            <option value="600">UTC+10 (悉尼、墨尔本、布里斯班)</option>
            <option value="630">UTC+10:30 (豪勋爵岛)</option>
            <option value="660">UTC+11 (所罗门群岛)</option>
            <option value="690">UTC+11:30 (诺福克岛)</option>
            <option value="720">UTC+12 (奥克兰、斐济)</option>
            <option value="765">UTC+12:45 (查塔姆群岛)</option>
            <option value="780">UTC+13 (努库阿洛法)</option>
            <option value="840">UTC+14 (基里蒂马蒂岛)</option>
          </select>
        </div>
      </div>
      <div class="section">
        <div class="section-title">☁️ 云存储设置（可选）</div>
        <div class="form-group">
          <div class="checkbox-group">
            <input type="checkbox" id="cloud_enabled" name="cloud_enabled">
            <label for="cloud_enabled" style="margin-bottom: 0;">启用云存储备份</label>
          </div>
        </div>
      </div>
      <button type="button" id="submitBtn">保存设置并继续</button>
    </form>
  </div>
  <script>
    function initSetup() {
      // 管理员模式切换
      const radios = document.getElementsByName('admin_mode');
      for (let i = 0; i < radios.length; i++) {
        radios[i].addEventListener('change', function() {
          const manualFields = document.getElementById('manualAdminFields');
          manualFields.style.display = this.value === 'manual' ? 'block' : 'none';
        });
      }
      // 提交按钮点击
      const submitBtn = document.getElementById('submitBtn');
      submitBtn.addEventListener('click', async function() {
        const form = document.getElementById('setupForm');
        const messageEl = document.getElementById('message');
        submitBtn.disabled = true;
        submitBtn.textContent = '保存中...';
        const formData = new FormData(form);
        const adminMode = formData.get('admin_mode');
        const adminEmail = formData.get('admin_email');
        const adminPassword = formData.get('admin_password');
        const adminPasswordConfirm = formData.get('admin_password_confirm');
        if (adminMode === 'manual') {
          if (!adminEmail || !adminPassword) {
            messageEl.className = 'message error';
            messageEl.textContent = '请填写管理员邮箱和密码';
            submitBtn.disabled = false;
            submitBtn.textContent = '保存设置并继续';
            return;
          }
          if (adminPassword !== adminPasswordConfirm) {
            messageEl.className = 'message error';
            messageEl.textContent = '两次输入的密码不一致';
            submitBtn.disabled = false;
            submitBtn.textContent = '保存设置并继续';
            return;
          }
        }
        try {
          const response = await fetch('/api/v1/setup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              timezone_offset: parseInt(formData.get('timezone_offset')),
              cloud_config: null,
              admin_mode: adminMode,
              admin_email: adminEmail,
              admin_password: adminPassword
            })
          });
          const result = await response.json();
          if (response.ok && result.success) {
            messageEl.className = 'message success';
            let html = '✓ ' + (result.message || '设置已保存') + '<br><br>';
            if (result.user_email) {
              html += '<div style="margin: 8px 0;"><strong>管理员账户:</strong> <code style="background: #f0f0f0; padding: 4px 8px; border-radius: 4px;">' + result.user_email + '</code></div>';
            }
            if (result.auto_generated_password) {
              html += '<div style="margin: 8px 0;"><strong>密码:</strong> <code style="background: #f0f0f0; padding: 4px 8px; border-radius: 4px;">' + result.auto_generated_password + '</code></div>';
              html += '<small style="color: #666;">请务必记录此密码！</small><br>';
            }
            html += '<br>正在跳转登录页面...';
            messageEl.innerHTML = html;
            setTimeout(function() { window.top.location.href = '/'; }, 8000);
          } else {
            messageEl.className = 'message error';
            messageEl.textContent = result.error || '保存失败，请重试';
            submitBtn.disabled = false;
            submitBtn.textContent = '保存设置并继续';
          }
        } catch (e) {
          messageEl.className = 'message error';
          messageEl.textContent = '网络错误，请重试';
          submitBtn.disabled = false;
          submitBtn.textContent = '保存设置并继续';
        }
      });
      // 检查是否已设置
      fetch('/api/v1/setup')
        .then(function(r) { return r.json(); })
        .then(function(data) { if (data.setup_completed) { window.location.href = '/login'; } })
        .catch(function() {});
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initSetup);
    } else {
      initSetup();
    }
  </script>
</body>
</html>
  `.trim();
  return html;
}

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

    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        'Content-Length': String(content.length)
      },
      body: content
    });

    if (response.ok) {
      const etag = response.headers.get('ETag') || undefined;
      return { ok: true, message: 'Upload successful', etag };
    } else {
      const errorText = await response.text().catch(() => '');
      return { ok: false, message: `Upload failed: HTTP ${response.status} ${response.statusText} ${errorText}`.slice(0, 200) };
    }
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    return { ok: false, message: `Upload error: ${errorMsg}` };
  }
}

async function performBackupIndex(db: D1Database, runId: string, ledgerId: string, remoteConfig: Record<string, string>): Promise<{ success: boolean; message: string; backupSize?: number; backupPath?: string }> {
  try {
    console.log(`[Backup] Starting backup for ledger: ${ledgerId}`);
    
    const changesResult = await db
      .prepare('SELECT entity_type, entity_sync_id, payload_json FROM sync_changes WHERE ledger_id = ?')
      .bind(ledgerId)
      .all();
    const changes = (changesResult.results || []) as { entity_type: string; entity_sync_id: string; payload_json: string }[];
    
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
      if (remoteConfig.savePath && typeof remoteConfig.savePath === 'string' && 
          remoteConfig.savePath !== 'custom' && remoteConfig.savePath !== 'environment variable') {
        basePrefix = remoteConfig.savePath.trim().replace(/^\/+|\/+$/g, '') + '/';
        console.log(`[Backup] Using savePath: ${basePrefix}`);
      } else if (remoteConfig.root_path && typeof remoteConfig.root_path === 'string' && remoteConfig.root_path.trim() !== '') {
        basePrefix = remoteConfig.root_path.trim().replace(/^\/+|\/+$/g, '') + '/';
        console.log(`[Backup] Using root_path: ${basePrefix}`);
      }
      
      const timestamp = new Date().toISOString().replace(/[:\-T]/g, '').slice(0, 14);
      const backupKey = `${basePrefix}backups/${ledgerId}/${timestamp}_backup.json`;
      
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
      
      return {
        success: true,
        message: 'Backup completed successfully',
        backupSize,
        backupPath: backupKey
      };
    } else if (remoteConfig.backend_type === 'local') {
      console.log('[Backup] Local backend - skipping upload (simulated). No remote storage configured.');
      return {
        success: true,
        message: 'Backup completed successfully (local storage only - no remote S3 configured)',
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

app.post('/api/v1/admin/backup/schedules/:id/run-now', async (c) => {
  try {
    const db = c.env.DB;
    const jwtSecret = c.env.JWT_SECRET;
    const scheduleIdParam = c.req.param('id');
    const scheduleId = Number(scheduleIdParam);
    const serverNow = new Date().toISOString();

    const authHeader = c.req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return c.json({ error: 'Unauthorized', detail: 'Missing Authorization header' }, 401);
    }

    const token = authHeader.slice(7);
    const validationResult = await validateAccessToken(token, jwtSecret);
    
    if (!validationResult || !('userId' in validationResult)) {
      return c.json({ error: 'Unauthorized', detail: 'Invalid or expired token' }, 401);
    }
    if (validationResult.expired) {
      return c.json({ error: 'Token expired' }, 401);
    }
    const userId = validationResult.userId;

    const schedule = await db
      .prepare('SELECT id, name, user_id, remote_ids FROM backup_schedules WHERE id = ?')
      .bind(scheduleId)
      .first<{ id: number; name: string; user_id: string; remote_ids: string }>();

    if (!schedule) {
      return c.json({ error: 'Schedule not found' }, 404);
    }

    let ledger = await db
      .prepare('SELECT id, external_id FROM ledgers WHERE user_id = ? LIMIT 1')
      .bind(userId)
      .first<{ id: string; external_id: string }>();

    if (!ledger && schedule.user_id) {
      ledger = await db
        .prepare('SELECT id, external_id FROM ledgers WHERE user_id = ? LIMIT 1')
        .bind(schedule.user_id)
        .first<{ id: string; external_id: string }>();
    }

    if (!ledger) {
      ledger = await db
        .prepare('SELECT id, external_id FROM ledgers LIMIT 1')
        .first<{ id: string; external_id: string }>();
    }

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

    let remoteId: string | null = null;
    let remoteConfig: Record<string, string> = { backend_type: 'local' };

    if (schedule.remote_ids) {
      try {
        const remoteIds = JSON.parse(schedule.remote_ids);
        if (remoteIds.length > 0) {
          remoteId = String(remoteIds[0]);
          const remote = await db
            .prepare('SELECT backend_type, config_summary FROM backup_remotes WHERE id = ?')
            .bind(remoteId)
            .first<{ backend_type: string; config_summary: string }>();
          
          if (remote) {
            const parsedConfig = JSON.parse(remote.config_summary || '{}');
            remoteConfig = {
              backend_type: remote.backend_type,
              ...parsedConfig,
              savePath: parsedConfig.root_path ? parsedConfig.root_path.replace(/^\/+|\/+$/g, '') : 'custom'
            };
          }
        }
      } catch {
        console.log('[Backup] Failed to parse remote_ids, using local backend');
      }
    }

    await db
      .prepare(
        `INSERT INTO backup_runs (schedule_id, ledger_id, remote_id, status, started_at)
         VALUES (?, ?, ?, 'pending', ?)`
      )
      .bind(scheduleId, ledger.id, remoteId, serverNow)
      .run();

    const result = await db.prepare('SELECT last_insert_rowid() as id').first<{ id: number }>();
    const runId = result?.id?.toString() || crypto.randomUUID();

    const backupResult = await performBackupIndex(db, runId, ledger.id, remoteConfig);
    
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
        schedule_id: scheduleId.toString(),
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
        schedule_id: scheduleId.toString(),
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

// 测试服务器基本功能
app.get('/api/v1/test-server', (c) => {
  try {
    const envKeys = c.env ? Object.keys(c.env).filter(k => !k.includes('SECRET') && !k.includes('KEY')) : [];
    return c.json({ 
      status: 'success', 
      message: 'Server is running',
      timestamp: new Date().toISOString(),
      env_keys: envKeys,
      has_env: !!c.env,
      has_db: !!c.env?.DB,
      jwt_secret_set: !!c.env?.JWT_SECRET
    });
  } catch (error) {
    return c.json({ 
      status: 'error', 
      message: 'Failed to access environment',
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// 测试认证变量是否正确传递（受保护端点）
app.get('/api/v1/test-auth', async (c) => {
  try {
    const userId = c.get('userId');
    const deviceId = c.get('deviceId');
    
    return c.json({ 
      status: 'success', 
      message: 'Auth variables check',
      user_id: userId ?? 'NOT_SET',
      device_id: deviceId ?? 'NOT_SET',
      has_user_id: !!userId,
      has_device_id: !!deviceId,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    return c.json({ 
      status: 'error', 
      message: 'Failed to check auth variables',
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// 测试认证失败的端点 - 这个端点需要认证，用于测试 Token 过期处理
app.get('/api/v1/test-auth-fail', async (c) => {
  try {
    const userId = c.get('userId');
    return c.json({ 
      status: 'success', 
      message: 'Authentication successful',
      user_id: userId,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    return c.json({ 
      status: 'error', 
      message: 'Failed',
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// 测试数据库连接
app.get('/api/v1/test-db', async (c) => {
  try {
    const db = c.env.DB;
    if (!db) {
      return c.json({ status: 'error', message: 'DB is undefined' }, 500);
    }
    
    const result = await db.prepare('SELECT 1 as test').first();
    return c.json({ 
      status: 'success', 
      message: 'Database connection is working',
      result: result 
    });
  } catch (error) {
    console.error('[TEST-DB] Error:', error);
    return c.json({ 
      status: 'error', 
      message: 'Database connection failed',
      error: error instanceof Error ? error.message : 'Unknown error',
      error_stack: error instanceof Error ? error.stack : undefined
    }, 500);
  }
});

// ===========================
// 认证中间件
// ===========================

// 通用认证中间件处理函数
const authMiddleware = async (c: any, next: () => Promise<void>, skipPaths: string[] = []) => {
  const requestPath = c.req.path;
  for (const skipPath of skipPaths) {
    // 支持匹配带 /api/v1 前缀和不带前缀的路径
    if (requestPath === skipPath || requestPath === '/api/v1' + skipPath) {
      return next();
    }
  }

  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.slice(7);
  
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    
    const payloadStr = base64urlDecode(parts[1]);
    if (!payloadStr) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const payload = JSON.parse(payloadStr);
    
    if (payload.type !== 'access') {
      return c.json({ error: 'Invalid token type' }, 401);
    }
  } catch {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  if (!c.env?.JWT_SECRET) {
    console.error('[AUTH] JWT_SECRET is not set');
    return c.json({ error: 'Internal Server Error' }, 500);
  }
  
  const validationResult = await validateAccessToken(token, c.env.JWT_SECRET);
  if (!validationResult) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  if ('expired' in validationResult && validationResult.expired) {
    return c.json({ error: 'TokenExpired' }, 401);
  }
  const userId = validationResult.userId;

  const deviceId = c.req.header('X-Device-ID') || c.req.header('x-device-id');

  if (deviceId && c.executionCtx) {
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
  return next();
};

// /api/v1 前缀的路由认证
app.use('/api/v1/*', async (c, next) => {
  return authMiddleware(c, next, [
    '/api/v1/auth', 
    '/api/v1/profile/avatar',
    '/api/v1/test-route',
    '/api/v1/admin/backup/test-public',
    '/api/v1/test-db',
    '/api/v1/test-server',
    '/api/v1/version'
  ]);
});

// /2fa 前缀的路由认证（蜜蜂记账 APP 使用 /2fa 路径）
app.use('/2fa/*', async (c, next) => {
  return authMiddleware(c, next, ['/2fa/verify']);
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
app.route('/read/summary', summaryRouter);
app.route('/write', writeRouter);
app.route('/devices', devicesRouter);
app.route('/profile', profileRouter);
app.route('/attachments', attachmentsRouter);
app.route('/import', importRouter);
app.route('/ai', aiRouter);
app.route('/backup', backupRouter);
app.route('/notifications', notificationsRouter);

// ===========================
// 全局错误处理中间件
// ===========================
app.onError((err, c) => {
  console.error('[ERROR]', err.message);
  
  return c.json({
    error: 'Internal Server Error',
    detail: err.message,
    timestamp: new Date().toISOString(),
  }, 500);
});

// ===========================
// WebSocket 实时同步端点
// ===========================
app.get('/ws', async (c) => {
  const token = c.req.query('token');
  if (!token) {
    return c.json({ error: 'Missing token' }, 400);
  }

  try {
    const validationResult = await validateAccessToken(token, c.env.JWT_SECRET);
    if (!validationResult || !('userId' in validationResult)) {
      return c.json({ error: 'Invalid token' }, 401);
    }
    if (validationResult.expired) {
      return c.json({ error: 'Token expired' }, 401);
    }
    const userId = validationResult.userId;

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
// 导出应用
// ===========================

// ===========================
// 定时任务处理 (Cron Trigger)
// ===========================

export default {
  // HTTP 请求处理
  fetch: app.fetch,
  
  // 定时任务调度处理
  async scheduled(event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    console.log('[CRON] Scheduled event triggered:', new Date().toISOString());
    
    const db = env.DB;
    
    try {
      // 获取所有启用的备份计划
      const schedulesResult = await db
        .prepare('SELECT * FROM backup_schedules WHERE enabled = 1')
        .all();
      
      const schedules = schedulesResult.results || [];
      console.log(`[CRON] Found ${schedules.length} enabled backup schedules`);
      
      for (const schedule of schedules) {
        try {
          await processBackupSchedule(db, schedule);
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

// ===========================
// 备份计划处理函数
// ===========================

async function processBackupSchedule(db: D1Database, schedule: any) {
  console.log(`[CRON] Processing schedule ${schedule.id}: ${schedule.name}`);
  
  // 获取时区偏移（默认为0）
  const timezoneOffset = schedule.timezone_offset || 0;
  
  // 如果没有 next_run_at，先计算一个
  if (!schedule.next_run_at) {
    const nextRun = calculateNextRun(schedule.cron_expr, timezoneOffset);
    await db
      .prepare('UPDATE backup_schedules SET next_run_at = ? WHERE id = ?')
      .bind(nextRun, schedule.id)
      .run();
    console.log(`[CRON] Set initial next_run_at for schedule ${schedule.id}: ${nextRun}`);
    return;
  }
  
  const now = new Date().toISOString();
  
  // 检查是否到达执行时间
  if (now < schedule.next_run_at) {
    console.log(`[CRON] Schedule ${schedule.id} not due yet. Next run: ${schedule.next_run_at}`);
    return;
  }
  
  console.log(`[CRON] Executing schedule ${schedule.id}: ${schedule.name}`);
  
  // 获取该用户的账本
  let ledger = await db
    .prepare('SELECT id FROM ledgers WHERE user_id = ? LIMIT 1')
    .bind(schedule.user_id)
    .first<{ id: string }>();
  
  if (!ledger) {
    console.log(`[CRON] No ledger found for schedule ${schedule.id}, skipping`);
    return;
  }
  
  // 解析远程配置
  let remoteId: string | null = null;
  let remoteConfig: Record<string, string> = { backend_type: 'local' };
  
  if (schedule.remote_ids) {
    try {
      const remoteIds = JSON.parse(schedule.remote_ids);
      if (remoteIds.length > 0) {
        remoteId = String(remoteIds[0]);
        const remote = await db
          .prepare('SELECT backend_type, config_summary FROM backup_remotes WHERE id = ?')
          .bind(remoteId)
          .first<{ backend_type: string; config_summary: string }>();
        
        if (remote) {
          const parsedConfig = JSON.parse(remote.config_summary || '{}');
          remoteConfig = {
            backend_type: remote.backend_type,
            ...parsedConfig,
            savePath: parsedConfig.root_path ? parsedConfig.root_path.replace(/^\/+|\/+$/g, '') : 'custom'
          };
        }
      }
    } catch (e) {
      console.log(`[CRON] Failed to parse remote config for schedule ${schedule.id}:`, e);
    }
  }
  
  // 创建备份运行记录
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  
  await db
    .prepare(
      'INSERT INTO backup_runs (id, schedule_id, ledger_id, remote_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .bind(runId, schedule.id, ledger.id, remoteId, 'pending', startedAt)
    .run();
  
  // 执行备份
  try {
    const backupResult = await performBackupIndex(db, runId, ledger.id, remoteConfig);
    const finishedAt = new Date().toISOString();
    
    if (backupResult.success) {
      await db
        .prepare(
          'UPDATE backup_runs SET status = ?, finished_at = ?, bytes_total = ?, backup_filename = ?, backup_path = ? WHERE id = ?'
        )
        .bind('completed', finishedAt, backupResult.backupSize, 
              backupResult.backupPath?.split('/').pop() || null, backupResult.backupPath, runId)
        .run();
      
      console.log(`[CRON] Backup completed for schedule ${schedule.id}`);
    } else {
      await db
        .prepare(
          'UPDATE backup_runs SET status = ?, finished_at = ?, error_message = ? WHERE id = ?'
        )
        .bind('failed', finishedAt, backupResult.message, runId)
        .run();
      
      console.log(`[CRON] Backup failed for schedule ${schedule.id}:`, backupResult.message);
    }
    
    // 更新计划的最后运行时间（使用时区偏移）
    const nextRun = calculateNextRun(schedule.cron_expr, timezoneOffset);
    await db
      .prepare(
        'UPDATE backup_schedules SET last_run_at = ?, last_run_status = ?, next_run_at = ?, updated_at = ? WHERE id = ?'
      )
      .bind(startedAt, backupResult.success ? 'completed' : 'failed', nextRun, startedAt, schedule.id)
      .run();
    
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    const finishedAt = new Date().toISOString();
    
    await db
      .prepare(
        'UPDATE backup_runs SET status = ?, finished_at = ?, error_message = ? WHERE id = ?'
      )
      .bind('failed', finishedAt, errorMsg, runId)
      .run();
    
    // 更新计划的失败状态（使用时区偏移）
    const nextRun = calculateNextRun(schedule.cron_expr, timezoneOffset);
    await db
      .prepare(
        'UPDATE backup_schedules SET last_run_at = ?, last_run_status = ?, next_run_at = ?, updated_at = ? WHERE id = ?'
      )
      .bind(startedAt, 'failed', nextRun, startedAt, schedule.id)
      .run();
    
    console.error(`[CRON] Exception during backup for schedule ${schedule.id}:`, error);
  }
}

// ===========================
// Cron 表达式解析和计算
// ===========================

/**
 * 计算下次运行时间
 * Cron 表达式格式: 分钟 小时 日期 月份 星期
 * @param cronExpr cron表达式
 * @param timezoneOffset 用户时区偏移（分钟，东八区为-480）
 */
function calculateNextRun(cronExpr: string, timezoneOffset: number = 0): string {
  try {
    const parts = cronExpr.trim().split(/\s+/);
    
    if (parts.length < 5) {
      const nextDate = new Date();
      nextDate.setMinutes(nextDate.getMinutes() + 5);
      return nextDate.toISOString();
    }
    
    const minuteStr = parts[0];
    const hourStr = parts[1];
    const dayStr = parts[2];
    
    const targetMinute = minuteStr === '*' ? 0 : parseInt(minuteStr, 10);
    const targetHour = hourStr === '*' ? 0 : parseInt(hourStr, 10);
    
    const now = new Date();
    
    // 创建目标时刻（用户本地时间）
    let targetLocal = new Date();
    targetLocal.setHours(targetHour);
    targetLocal.setMinutes(targetMinute);
    targetLocal.setSeconds(0);
    targetLocal.setMilliseconds(0);
    
    // 如果目标时间已经过了今天，设置为明天
    if (targetLocal.getTime() <= now.getTime()) {
      targetLocal.setDate(targetLocal.getDate() + 1);
    }
    
    // 如果指定了具体日期，调整日期
    if (dayStr !== '*') {
      const targetDay = parseInt(dayStr, 10);
      if (!isNaN(targetDay) && targetDay > 0 && targetDay <= 31) {
        if (targetDay < targetLocal.getDate()) {
          targetLocal.setMonth(targetLocal.getMonth() + 1);
        }
        targetLocal.setDate(targetDay);
      }
    }
    
    // 转换为UTC时间（timezoneOffset是本地时间与UTC的分钟差，东八区是-480）
    // UTC = 本地时间 + timezoneOffset分钟
    const targetUtc = new Date(targetLocal.getTime() + timezoneOffset * 60000);
    
    return targetUtc.toISOString();
  } catch (e) {
    console.error('[CRON] Error parsing cron expression:', cronExpr, e);
    const nextDate = new Date();
    nextDate.setMinutes(nextDate.getMinutes() + 5);
    return nextDate.toISOString();
  }
}
