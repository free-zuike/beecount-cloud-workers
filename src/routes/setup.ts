import { Hono } from 'hono';
import { hashPassword } from '../auth';
import { DEFAULT_AI_CONFIG } from '../lib/defaults';

type Bindings = {
  DB: D1Database;
};

const setupRouter = new Hono<{ Bindings: Bindings }>();

setupRouter.post('/', async (c) => {
  const db = c.env.DB;
  
  try {
    const body = await c.req.json();
    const { timezone_offset, cloud_config, admin_mode, admin_email, admin_password } = body;
    
    const existing = await db
      .prepare('SELECT id FROM system_settings WHERE id = ?')
      .bind('default')
      .first();
    
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
      
      await db.prepare(`
        INSERT INTO users (id, email, password_hash, is_admin, is_enabled)
        VALUES (?, ?, ?, 1, 1)
      `).bind(userId, userEmail, passwordHash).run();
      
      await db.prepare(`
        INSERT INTO user_profiles (user_id, display_name, ai_config_json)
        VALUES (?, ?, ?)
      `).bind(userId, userEmail.split('@')[0], DEFAULT_AI_CONFIG).run();
      
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
    console.error('[Setup] Error saving settings:', error);
    return c.json({
      success: false,
      error: '保存设置失败',
      details: error instanceof Error ? error.message : String(error)
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
    
    if (!settings) {
      return c.json({
        setup_completed: false,
        timezone_offset: 0,
        cloud_config: null
      });
    }
    
    let cloudConfig = null;
    const settingsAny = settings as any;
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

export default setupRouter;
