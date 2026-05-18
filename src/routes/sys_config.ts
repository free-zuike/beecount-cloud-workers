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

const sysConfig = new Hono<{ Bindings: Bindings }>();

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
