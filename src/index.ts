/**
 * BeeCount Cloud Workers - 入口文件
 *
 * 完整实现 BeeCount Cloud API 协议的 Cloudflare Workers 版本
 *
 * 路由结构：
 * - /                                     - 前端页面 (React SPA)
 * - /healthz                              - 健康检查
 * - /api/v1/version                       - API 版本
 *
 * === 认证 (无需登录) ===
 * - /api/v1/auth/register                 - 用户注册
 * - /api/v1/auth/login                   - 用户登录
 * - /api/v1/auth/refresh                 - 刷新令牌
 *
 * === 2FA (需登录) ===
 * - /api/v1/2fa/status                  - 获取 2FA 状态
 * - /api/v1/2fa/setup                   - 开启 2FA
 * - /api/v1/2fa/confirm                 - 确认 2FA 启用
 * - /api/v1/2fa/verify                  - 登录第二步验证
 * - /api/v1/2fa/disable                 - 关闭 2FA
 * - /api/v1/2fa/recovery-codes/regenerate - 重新生成恢复码
 *
 * === 同步 (需登录) ===
 * - /api/v1/sync/ledgers                - 列出账本
 * - /api/v1/sync/full                   - 全量同步
 * - /api/v1/sync/push                   - 增量推送
 * - /api/v1/sync/pull                   - 增量拉取
 *
 * === 读 (需登录) ===
 * - /api/v1/read/ledgers                - 账本列表
 * - /api/v1/read/ledgers/:id            - 账本详情
 * - /api/v1/read/ledgers/:id/stats      - 账本统计
 * - /api/v1/read/ledgers/:id/transactions - 交易列表
 * - /api/v1/read/ledgers/:id/accounts   - 账户列表
 * - /api/v1/read/ledgers/:id/categories  - 分类列表
 * - /api/v1/read/ledgers/:id/tags       - 标签列表
 * - /api/v1/read/ledgers/:id/budgets    - 预算列表
 * - /api/v1/read/summary                - 单账本快速统计
 *
 * === Workspace 聚合 (需登录) ===
 * - /api/v1/read/workspace/transactions - 跨账本交易列表
 * - /api/v1/read/workspace/accounts     - 跨账本账户聚合
 * - /api/v1/read/workspace/categories   - 跨账本分类聚合
 * - /api/v1/read/workspace/tags         - 跨账本标签聚合
 * - /api/v1/read/workspace/ledger-counts - 账本总览统计
 * - /api/v1/read/workspace/analytics    - 收支分析
 *
 * === 写 (需登录) ===
 * - /api/v1/write/ledgers               - 创建账本
 * - /api/v1/write/ledgers/:id           - 更新账本
 * - /api/v1/write/transactions          - 创建交易
 * - /api/v1/write/transactions/:id     - 更新交易
 * - /api/v1/write/transactions/:id     - 删除交易
 * - /api/v1/write/transactions/batch   - 批量创建交易
 * - /api/v1/write/transactions/batch-delete - 批量删除交易
 * - /api/v1/write/accounts             - 创建账户
 * - /api/v1/write/categories           - 创建分类
 * - /api/v1/write/tags                - 创建标签
 * - /api/v1/write/budgets             - 创建预算
 *
 * === 设备管理 (需登录) ===
 * - /api/v1/devices                   - 设备列表
 * - /api/v1/devices/:id               - 撤销设备
 *
 * === 个人资料 (需登录) ===
 * - /api/v1/profile/me                - 获取资料
 * - /api/v1/profile/me/avatar         - 上传头像
 *
 * === PAT 管理 (需登录) ===
 * - /api/v1/profile/pats              - PAT 列表
 * - /api/v1/profile/pats/:id          - 撤销 PAT
 *
 * === 附件管理 (需登录) ===
 * - /api/v1/attachments               - 上传附件
 * - /api/v1/attachments/:id           - 下载附件
 * - /api/v1/attachments/exists        - 检查附件是否存在
 *
 * === 导入 (需登录) ===
 * - /api/v1/import/upload             - 上传文件
 * - /api/v1/import/:token/preview    - 预览字段映射
 * - /api/v1/import/:token/execute     - 执行导入
 * - /api/v1/import/:token             - 取消导入
 *
 * === AI (需登录) ===
 * - /api/v1/ai/ask                   - 文档 Q&A (SSE)
 * - /api/v1/ai/parse-tx-image        - 图片记账
 * - /api/v1/ai/parse-tx-text         - 文字记账
 * - /api/v1/ai/test-provider          - 测试 AI provider
 *
 * === 备份 (需登录) ===
 * - /api/v1/backup/snapshots          - 创建备份
 * - /api/v1/backup/snapshots          - 备份列表
 * - /api/v1/backup/snapshots/:id/restore - 恢复备份
 *
 * === 实时通知 (需登录) ===
 * - /api/v1/notifications/subscribe   - SSE 订阅
 * - /api/v1/notifications/poll        - 短轮询
 *
 * === MCP 调用日志 (需登录) ===
 * - /api/v1/mcp-calls                 - 调用历史查询
 *
 * === 管理员 (需 admin) ===
 * - /api/v1/admin/overview             - 系统概览
 * - /api/v1/admin/users               - 用户列表
 * - /api/v1/admin/users/:id           - 更新用户
 * - /api/v1/admin/devices             - 设备列表
 * - /api/v1/admin/logs                - 日志查询
 * - /api/v1/admin/backup/remotes      - 备份远程配置
 * - /api/v1/admin/backup/schedules    - 备份调度
 * - /api/v1/admin/backup/runs         - 备份运行记录
 *
 * @module index
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { validateAccessToken } from './auth';

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

// ===========================
// 前端页面 - 使用 Cloudflare Workers Assets
// ===========================
app.get('/*', async (c) => {
  // 使用 Workers Assets 服务静态文件
  const res = await c.env.ASSETS.fetch(c.req.raw);
  return res;
});

/**
 * 健康检查端点
 */
app.get('/healthz', (c) => c.json({ status: 'ok' }));

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
    if (c.req.path.startsWith(skipPath)) {
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

  c.set('userId', userId);
  c.set('deviceId', deviceId ?? null);
  await next();
};

// /api/v1 前缀的路由认证
app.use('/api/v1/*', async (c, next) => {
  await authMiddleware(c, next, ['/api/v1/auth']);
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
app.use('/profile/*', async (c, next) => authMiddleware(c, next));
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
app.route('/api/v1/admin', adminRouter);
app.route('/api/v1/admin/backup', adminBackupRouter);
app.route('/api/v1/sys-config', sysConfigRouter);

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
// 错误处理
// ===========================

app.notFound((c) => {
  return c.html('<html><body><h1>404 - Not Found</h1><p>页面不存在</p><a href="/">返回首页</a></body></html>');
});

app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({ error: 'Internal Server Error' }, 500);
});

// ===========================
// 导出应用
// ===========================

export default app;
