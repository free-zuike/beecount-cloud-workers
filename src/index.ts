/**
 * BeeCount Cloud Workers - 入口文件
 *
 * 完整实现 BeeCount Cloud API 协议的 Cloudflare Workers 版本
 *
 * 路由结构：
 * - /healthz                                    - 健康检查
 * - /api/v1/version                              - API 版本
 *
 * === 认证 (无需登录) ===
 * - /api/v1/auth/register                        - 用户注册
 * - /api/v1/auth/login                           - 用户登录
 * - /api/v1/auth/refresh                         - 刷新令牌
 *
 * === 2FA (需登录) ===
 * - /api/v1/2fa/status                           - 获取 2FA 状态
 * - /api/v1/2fa/setup                            - 开启 2FA
 * - /api/v1/2fa/confirm                         - 确认 2FA 启用
 * - /api/v1/2fa/verify                           - 登录第二步验证
 * - /api/v1/2fa/disable                          - 关闭 2FA
 * - /api/v1/2fa/recovery-codes/regenerate        - 重新生成恢复码
 *
 * === 同步 (需登录) ===
 * - /api/v1/sync/ledgers                         - 列出账本
 * - /api/v1/sync/full                           - 全量同步
 * - /api/v1/sync/push                            - 增量推送
 * - /api/v1/sync/pull                           - 增量拉取
 *
 * === 读 (需登录) ===
 * - /api/v1/read/ledgers                         - 账本列表
 * - /api/v1/read/ledgers/:id                    - 账本详情
 * - /api/v1/read/ledgers/:id/stats              - 账本统计
 * - /api/v1/read/ledgers/:id/transactions       - 交易列表
 * - /api/v1/read/ledgers/:id/accounts           - 账户列表
 * - /api/v1/read/ledgers/:id/categories         - 分类列表
 * - /api/v1/read/ledgers/:id/tags               - 标签列表
 * - /api/v1/read/ledgers/:id/budgets            - 预算列表
 * - /api/v1/read/summary                        - 单账本快速统计
 *
 * === Workspace 聚合 (需登录) ===
 * - /api/v1/read/workspace/transactions          - 跨账本交易列表
 * - /api/v1/read/workspace/accounts             - 跨账本账户聚合
 * - /api/v1/read/workspace/categories            - 跨账本分类聚合
 * - /api/v1/read/workspace/tags                  - 跨账本标签聚合
 * - /api/v1/read/workspace/ledger-counts        - 账本总览统计
 * - /api/v1/read/workspace/analytics            - 收支分析
 *
 * === 写 (需登录) ===
 * - /api/v1/write/ledgers                       - 创建账本
 * - /api/v1/write/ledgers/:id                  - 更新账本
 * - /api/v1/write/transactions                  - 创建交易
 * - /api/v1/write/transactions/:id             - 更新交易
 * - /api/v1/write/transactions/:id             - 删除交易
 * - /api/v1/write/transactions/batch            - 批量创建交易
 * - /api/v1/write/transactions/batch-delete      - 批量删除交易
 * - /api/v1/write/accounts                      - 创建账户
 * - /api/v1/write/categories                    - 创建分类
 * - /api/v1/write/tags                          - 创建标签
 * - /api/v1/write/budgets                       - 创建预算
 *
 * === 设备管理 (需登录) ===
 * - /api/v1/devices                              - 设备列表
 * - /api/v1/devices/:id                         - 撤销设备
 *
 * === 个人资料 (需登录) ===
 * - /api/v1/profile/me                           - 获取资料
 * - /api/v1/profile/me/avatar                   - 上传头像
 *
 * === PAT 管理 (需登录) ===
 * - /api/v1/profile/pats                         - PAT 列表
 * - /api/v1/profile/pats/:id                    - 撤销 PAT
 *
 * === 附件管理 (需登录) ===
 * - /api/v1/attachments                          - 上传附件
 * - /api/v1/attachments/:id                      - 下载附件
 * - /api/v1/attachments/exists                   - 检查附件是否存在
 *
 * === 导入 (需登录) ===
 * - /api/v1/import/upload                        - 上传文件
 * - /api/v1/import/:token/preview               - 预览字段映射
 * - /api/v1/import/:token/execute               - 执行导入
 * - /api/v1/import/:token                        - 取消导入
 *
 * === AI (需登录) ===
 * - /api/v1/ai/ask                               - 文档 Q&A (SSE)
 * - /api/v1/ai/parse-tx-image                   - 图片记账
 * - /api/v1/ai/parse-tx-text                    - 文字记账
 * - /api/v1/ai/test-provider                    - 测试 AI provider
 *
 * === 备份 (需登录) ===
 * - /api/v1/backup/snapshots                     - 创建备份
 * - /api/v1/backup/snapshots                     - 备份列表
 * - /api/v1/backup/snapshots/:id/restore         - 恢复备份
 *
 * === 实时通知 (需登录) ===
 * - /api/v1/notifications/subscribe              - SSE 订阅
 * - /api/v1/notifications/poll                   - 短轮询
 *
 * === MCP 调用日志 (需登录) ===
 * - /api/v1/mcp-calls                            - 调用历史查询
 *
 * === 管理员 (需 admin) ===
 * - /api/v1/admin/overview                       - 系统概览
 * - /api/v1/admin/users                          - 用户列表
 * - /api/v1/admin/users/:id                     - 更新用户
 * - /api/v1/admin/devices                        - 设备列表
 * - /api/v1/admin/logs                           - 日志查询
 * - /api/v1/admin/backup/remotes                - 备份远程配置
 * - /api/v1/admin/backup/schedules              - 备份调度
 * - /api/v1/admin/backup/runs                   - 备份运行记录
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

type Bindings = {
  DB: D1Database;
  API_PREFIX: string;
  JWT_SECRET: string;
};

type Variables = {
  userId: string;
};

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// 全局中间件
app.use('*', cors());

// ===========================
// 公开端点（无需认证）
// ===========================

/**
 * 根路径 - API 信息
 */
app.get('/', (c) =>
  c.json({
    name: 'BeeCount Cloud Workers',
    version: '1.0.0',
    description: '蜜蜂记账 Cloudflare Workers 版本',
    endpoints: {
      health: '/healthz',
      version: '/api/v1/version',
      auth: '/api/v1/auth',
      docs: 'https://github.com/free-zuike/beecount-cloud-workers'
    }
  })
);

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

/**
 * 全局认证中间件
 * - 跳过 /auth/* 路由（登录/注册无需认证）
 * - 跳过 /2fa/verify（登录流程第二步，无需预先认证）
 */
app.use('/api/v1/*', async (c, next) => {
  // 认证路由跳过检查
  if (c.req.path.startsWith('/api/v1/auth') || c.req.path.startsWith('/api/v1/2fa/verify')) {
    return await next();
  }

  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.slice(7);
  const userId = await validateAccessToken(token, c.env.JWT_SECRET);
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  c.set('userId', userId);
  await next();
});

// ===========================
// 路由注册
// ===========================

// 认证路由（无需登录）
app.route('/api/v1/auth', authRouter);

// 2FA 路由（需登录）
app.route('/api/v1/2fa', twoFactorRouter);

// 同步路由（需登录）
app.route('/api/v1/sync', syncRouter);

// 读路由（需登录）
app.route('/api/v1/read', readRouter);

// 账本摘要（需登录）
app.route('/api/v1/read/summary', summaryRouter);

// Workspace 聚合（需登录）
app.route('/api/v1/read/workspace', workspaceRouter);

// 写路由（需登录）
app.route('/api/v1/write', writeRouter);

// 批量写路由（需登录）
app.route('/api/v1/write', batchWriteRouter);

// 设备管理（需登录）
app.route('/api/v1/devices', devicesRouter);

// 个人资料（需登录）
app.route('/api/v1/profile', profileRouter);

// PAT 管理（需登录）
app.route('/api/v1/profile/pats', patsRouter);

// 附件管理（需登录）
app.route('/api/v1/attachments', attachmentsRouter);

// 导入管理（需登录）
app.route('/api/v1/import', importRouter);

// AI 接口（需登录）
app.route('/api/v1/ai', aiRouter);

// 备份管理（需登录）
app.route('/api/v1/backup', backupRouter);

// 实时通知（需登录）
app.route('/api/v1/notifications', notificationsRouter);

// MCP 调用日志（需登录）
app.route('/api/v1/mcp-calls', mcpCallsRouter);

// 管理员接口（需 admin 权限，内部再检查）
app.route('/api/v1/admin', adminRouter);

// 管理员备份管理（需 admin 权限）
app.route('/api/v1/admin/backup', adminBackupRouter);

// ===========================
// 错误处理
// ===========================

app.notFound((c) => {
  return c.json({ error: 'Not Found' }, 404);
});

app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({ error: 'Internal Server Error' }, 500);
});

// ===========================
// 导出应用
// ===========================

export default app;
