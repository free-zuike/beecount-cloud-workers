import { Hono } from 'hono';
import { serverLogger } from '../lib/logger';
import { hashPassword } from '../auth';
import { DEFAULT_AI_CONFIG } from '../lib/defaults';

type Bindings = {
  DB: D1Database;
};

const setupRouter = new Hono<{ Bindings: Bindings }>();

setupRouter.post('/', async (c) => {
  const db = c.env.DB;

  try {
    const existing = await db
      .prepare('SELECT setup_completed FROM system_settings WHERE id = ?')
      .bind('default')
      .first<{ setup_completed: number }>();

    if (existing?.setup_completed === 1) {
      return c.json({ error: 'Setup already completed' }, 403);
    }

    const body = await c.req.json();
    const { timezone_offset, cloud_config, admin_mode, admin_email, admin_password } = body;

    const serverNow = new Date().toISOString();
    
    const cloudConfigJson = cloud_config ? JSON.stringify(cloud_config) : null;
    
    if (existing) {
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
    
    if (admin_mode === 'manual' && admin_email && admin_password) {
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
      
      const userId = crypto.randomUUID();
      const passwordHash = await hashPassword(admin_password);
      const userEmail = admin_email.toLowerCase();
      
      await db.batch([
        db.prepare(`
          INSERT INTO users (id, email, password_hash, is_admin, is_enabled)
          VALUES (?, ?, ?, 1, 1)
        `).bind(userId, userEmail, passwordHash),
        db.prepare(`
          INSERT INTO user_profiles (user_id, display_name, ai_config_json)
          VALUES (?, ?, ?)
        `).bind(userId, userEmail.split('@')[0], DEFAULT_AI_CONFIG),
      ]);
      
      return c.json({
        success: true,
        message: '系统设置已保存，管理员账户已创建',
        timezone_offset: timezone_offset || 0,
        user_email: userEmail
      });
    }
    
    return c.json({
      success: true,
      message: '系统设置已保存',
      timezone_offset: timezone_offset || 0
    });
  } catch (error) {
    serverLogger.error('app', '[Setup] Error saving settings:', error);
    return c.json({
      success: false,
      error: '保存设置失败'
    }, 500);
  }
});

setupRouter.get('/', async (c) => {
  const db = c.env.DB;
  
  try {
    const settings = await db
      .prepare('SELECT * FROM system_settings WHERE id = ?')
      .bind('default')
      .first();

    // 健壮性：system_settings.setup_completed 可能因历史迁移（ALTER TABLE ADD COLUMN
    // DEFAULT 0）被回填为 0、或该行缺失，导致"库里已有管理员却被判为未完成"而错误地
    // 逼用户重新走首次启动的"创建管理员"流程。这里把"已存在管理员账户"也视为已完成。
    let adminCount = 0;
    try {
      const row = await db
        .prepare('SELECT COUNT(*) as count FROM users WHERE is_admin = 1')
        .first<{ count: number }>();
      adminCount = row?.count ?? 0;
    } catch {
      // users 表也不可用时（极早期库）忽略，退回到按 setup_completed 判定。
    }

    const settingsAny = settings as any;
    const setupCompleted = settingsAny?.setup_completed === 1 || adminCount > 0;

    if (!settings) {
      return c.json({
        setup_completed: setupCompleted,
        timezone_offset: 0,
        cloud_config: null
      });
    }
    
    let cloudConfig = null;
    if (settingsAny.cloud_config_json) {
      try {
        cloudConfig = JSON.parse(settingsAny.cloud_config_json);
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
      setup_completed: setupCompleted,
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

export default setupRouter;
