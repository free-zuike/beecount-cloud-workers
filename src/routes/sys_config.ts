import { Hono } from 'hono';

type Bindings = {
    DB: D1Database;
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

const sysConfig = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Admin-only middleware: all sys-config endpoints require admin
sysConfig.use('/*', async (c, next) => {
    const userId = c.get('userId');
    const db = c.env.DB;

    const user = await db
        .prepare('SELECT is_admin FROM users WHERE id = ?')
        .bind(userId)
        .first<{ is_admin: number }>();

    if (!user || !user.is_admin) {
        return c.json({ error: 'Admin required' }, 403);
    }

    await next();
});

// ===================== S3 配置管理端点 =====================

// 获取系统配置 (Web UI 使用)
sysConfig.get('/get', async (c) => {
    const db = c.env.DB;
    const settings = await getUploadConfig(db, c.env);
    
    // 返回 Web UI 需要的格式
    return c.json({
        s3: settings.s3 || { channels: [], loadBalance: { enabled: false, channels: [] } }
    });
});

// 获取所有 S3 配置
sysConfig.get('/s3', async (c) => {
    const db = c.env.DB;
    const settings = await getUploadConfig(db, c.env);
    return c.json(settings.s3?.channels || []);
});

// 创建 S3 配置
sysConfig.post('/s3', async (c) => {
    const db = c.env.DB;
    const body = await c.req.json();
    
    try {
        // 获取现有配置
        let settings;
        try {
            settings = await getUploadConfig(db, c.env);
        } catch (e) {
            console.error('[S3] Error getting upload config:', e);
            settings = { s3: { channels: [], loadBalance: { enabled: false, channels: [] } } };
        }
        
        const s3Channels = settings.s3?.channels || [];
        
        // 计算新 ID
        const existingIds = s3Channels.map((c: any) => c.id || 0);
        const newId = existingIds.length > 0 ? Math.max(...existingIds) + 1 : 1;
        
        // 构建新配置
        const newConfig: any = {
            id: newId,
            name: body.name || '未命名配置',
            type: 's3',
            accessKeyId: body.access_key_id || '',
            secretAccessKey: body.secret_access_key || '',
            region: body.region || 'auto',
            bucketName: body.bucket_name || '',
            endpoint: body.endpoint || '',
            pathStyle: body.path_style === 'true' || body.path_style === true,
            cdnDomain: body.cdn_domain || '',
            savePath: body.save_path || 'custom',
            enabled: true
        };
        
        s3Channels.push(newConfig);
        
        // 保存到数据库
        const saveData = {
            s3: {
                channels: s3Channels,
                loadBalance: settings.s3?.loadBalance || { enabled: false, channels: [] }
            }
        };
        
        await db.prepare(
            'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime("now")) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
        ).bind('manage@sysConfig@upload', JSON.stringify(saveData)).run();
        
        console.log('[S3] Config created successfully:', newConfig.id);
        return c.json(newConfig);
    } catch (error: any) {
        console.error('[S3] Failed to create config:', error);
        return c.json({ error: 'Failed to create configuration: ' + (error?.message || 'Unknown error') }, 500);
    }
});

// 更新 S3 配置
sysConfig.put('/s3/:id', async (c) => {
    const db = c.env.DB;
    const id = parseInt(c.req.param('id'));
    const body = await c.req.json();
    
    try {
        const settings = await getUploadConfig(db, c.env);
        const s3Channels = settings.s3?.channels || [];
        const index = s3Channels.findIndex((c: any) => c.id === id);
        
        if (index === -1) {
            return c.json({ error: 'Config not found' }, 404);
        }
        
        s3Channels[index] = {
            ...s3Channels[index],
            name: body.name || s3Channels[index].name,
            accessKeyId: body.access_key_id || s3Channels[index].accessKeyId,
            secretAccessKey: body.secret_access_key || s3Channels[index].secretAccessKey,
            region: body.region || s3Channels[index].region,
            bucketName: body.bucket_name || s3Channels[index].bucketName,
            endpoint: body.endpoint || s3Channels[index].endpoint,
            pathStyle: body.path_style !== undefined ? (body.path_style === 'true' || body.path_style === true) : s3Channels[index].pathStyle,
            cdnDomain: body.cdn_domain !== undefined ? body.cdn_domain : s3Channels[index].cdnDomain,
            savePath: body.save_path || s3Channels[index].savePath
        };
        
        await db.prepare(
            'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime("now")) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
        ).bind('manage@sysConfig@upload', JSON.stringify({
            s3: {
                channels: s3Channels,
                loadBalance: settings.s3?.loadBalance || { enabled: false, channels: [] }
            }
        })).run();
        
        return c.json(s3Channels[index]);
    } catch (error) {
        console.error('Failed to update S3 config:', error);
        return c.json({ error: 'Failed to update configuration' }, 500);
    }
});

// 切换 S3 配置启用状态
sysConfig.post('/s3/:id/toggle', async (c) => {
    const db = c.env.DB;
    const id = parseInt(c.req.param('id'));
    
    try {
        const settings = await getUploadConfig(db, c.env);
        const s3Channels = settings.s3?.channels || [];
        const index = s3Channels.findIndex((c: any) => c.id === id);
        
        if (index === -1) {
            return c.json({ error: 'Config not found' }, 404);
        }
        
        s3Channels[index].enabled = !s3Channels[index].enabled;
        
        await db.prepare(
            'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime("now")) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
        ).bind('manage@sysConfig@upload', JSON.stringify({
            s3: {
                channels: s3Channels,
                loadBalance: settings.s3?.loadBalance || { enabled: false, channels: [] }
            }
        })).run();
        
        return c.json(s3Channels[index]);
    } catch (error) {
        console.error('Failed to toggle S3 config:', error);
        return c.json({ error: 'Failed to toggle configuration' }, 500);
    }
});

// 删除 S3 配置
sysConfig.delete('/s3/:id', async (c) => {
    const db = c.env.DB;
    const id = parseInt(c.req.param('id'));
    
    try {
        const settings = await getUploadConfig(db, c.env);
        let s3Channels = settings.s3?.channels || [];
        s3Channels = s3Channels.filter((c: any) => c.id !== id);
        
        await db.prepare(
            'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime("now")) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
        ).bind('manage@sysConfig@upload', JSON.stringify({
            s3: {
                channels: s3Channels,
                loadBalance: settings.s3?.loadBalance || { enabled: false, channels: [] }
            }
        })).run();
        
        return c.json({ success: true });
    } catch (error) {
        console.error('Failed to delete S3 config:', error);
        return c.json({ error: 'Failed to delete configuration' }, 500);
    }
});

// ===================== 原有的上传配置端点 =====================

// 获取上传配置（包括 S3 配置）
sysConfig.get('/upload', async (c) => {
    const db = c.env.DB;
    const settings = await getUploadConfig(db, c.env);
    return c.json(settings);
});

// 保存上传配置
sysConfig.post('/upload', async (c) => {
    const db = c.env.DB;
    const body = await c.req.json();
    
    try {
        // 保存到数据库
        await db.prepare(
            'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime("now")) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
        ).bind('manage@sysConfig@upload', JSON.stringify(body)).run();
        
        return c.json(body);
    } catch (error) {
        console.error('Failed to save upload config:', error);
        return c.json({ error: 'Failed to save configuration' }, 500);
    }
});

// 获取上传配置的函数
export async function getUploadConfig(db: D1Database, env: Bindings) {
    const settings: any = {};
    
    // 从数据库读取配置
    const settingsResult = await db.prepare(
        'SELECT value FROM settings WHERE key = ?'
    ).bind('manage@sysConfig@upload').first<{ value: string }>();
    
    const settingsKV = settingsResult && settingsResult.value ? JSON.parse(settingsResult.value) : {};
    
    // =====================读取 S3 渠道配置=====================
    const s3: any = {};
    const s3Channels: any[] = [];
    s3.channels = s3Channels;
    
    // 从环境变量读取默认 S3 配置
    if (env.S3_ACCESS_KEY_ID) {
        s3Channels.push({
            id: 1,
            name: 'S3_env',
            type: 's3',
            savePath: 'environment variable',
            accessKeyId: env.S3_ACCESS_KEY_ID,
            secretAccessKey: env.S3_SECRET_ACCESS_KEY,
            region: env.S3_REGION || 'auto',
            bucketName: env.S3_BUCKET_NAME,
            endpoint: env.S3_ENDPOINT,
            pathStyle: env.S3_PATH_STYLE === 'true',
            cdnDomain: env.S3_CDN_DOMAIN || '',
            enabled: true,
            fixed: true,
        });
    }
    
    // 从数据库读取 S3 配置
    for (const s of settingsKV.s3?.channels || []) {
        // 如果 savePath 是 environment variable，修改可变参数
        if (s.savePath === 'environment variable') {
            if (s3Channels[0]) {
                s3Channels[0].enabled = s.enabled;
                s3Channels[0].quota = s.quota;
                s3Channels[0].cdnDomain = s.cdnDomain;
            }
            continue;
        }
        s.id = s3Channels.length + 1;
        s3Channels.push(s);
    }
    
    // 负载均衡配置
    const s3LoadBalance = settingsKV.s3?.loadBalance || {
        enabled: false,
        channels: [],
    };
    s3.loadBalance = s3LoadBalance;
    
    settings.s3 = s3;
    
    return settings;
}

// 获取第一个可用的 S3 配置
export async function getFirstEnabledS3Config(db: D1Database, env: Bindings) {
    const config = await getUploadConfig(db, env);
    const s3Channels = config.s3?.channels || [];
    return s3Channels.find((channel: any) => channel.enabled) || null;
}

export default sysConfig;
