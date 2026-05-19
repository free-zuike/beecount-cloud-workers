/**
 * BeeCount Cloud Workers - 入口文件
 *
 * 完整实现 BeeCount Cloud API 协议的 Cloudflare Workers 版本
 *
 * 路由结构：
 * - /                                     - 前端页面
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
// 前端页面
// ===========================

const FRONTEND_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>蜜蜂记账 - BeeCount Cloud</title>
  <style>
    :root {
      --primary: #f97316;
      --primary-dark: #ea580c;
      --primary-light: #fed7aa;
      --secondary: #64748b;
      --background: #f8fafc;
      --surface: #ffffff;
      --text: #1e293b;
      --text-muted: #64748b;
      --border: #e2e8f0;
      --success: #22c55e;
      --error: #ef4444;
      --warning: #f59e0b;
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--background);
      color: var(--text);
      min-height: 100vh;
    }

    .container { max-width: 1200px; margin: 0 auto; padding: 20px; }

    .header {
      background: linear-gradient(135deg, var(--primary), var(--primary-dark));
      color: white;
      padding: 16px 0;
      box-shadow: 0 4px 6px rgba(249, 115, 22, 0.3);
      position: sticky;
      top: 0;
      z-index: 100;
    }

    .header-content {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .logo {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 1.25rem;
      font-weight: 700;
    }

    .logo-icon {
      width: 36px;
      height: 36px;
      background: white;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.25rem;
    }

    .nav-tabs {
      display: flex;
      gap: 4px;
      background: rgba(255,255,255,0.1);
      padding: 4px;
      border-radius: 10px;
    }

    .nav-tab {
      padding: 8px 16px;
      background: transparent;
      border: none;
      color: rgba(255,255,255,0.8);
      font-size: 0.9rem;
      font-weight: 500;
      cursor: pointer;
      border-radius: 6px;
      transition: all 0.2s;
    }

    .nav-tab:hover { background: rgba(255,255,255,0.1); color: white; }
    .nav-tab.active { background: white; color: var(--primary); }

    .header-actions { display: flex; gap: 8px; }
    .header-btn {
      padding: 8px 12px;
      background: rgba(255,255,255,0.15);
      border: none;
      color: white;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.9rem;
      transition: all 0.2s;
    }
    .header-btn:hover { background: rgba(255,255,255,0.25); }

    .card {
      background: var(--surface);
      border-radius: 12px;
      padding: 20px;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
      border: 1px solid var(--border);
    }

    .page { display: none; }
    .page.active { display: block; }

    .form-group { margin-bottom: 16px; }
    .form-group label { display: block; font-weight: 500; margin-bottom: 6px; color: var(--text); }
    
    .form-group input, .form-group select, .form-group textarea {
      width: 100%;
      padding: 12px 16px;
      border: 1px solid var(--border);
      border-radius: 8px;
      font-size: 1rem;
      transition: border-color 0.2s, box-shadow 0.2s;
      background: var(--surface);
    }

    .form-group input:focus, .form-group select:focus, .form-group textarea:focus {
      outline: none;
      border-color: var(--primary);
      box-shadow: 0 0 0 3px var(--primary-light);
    }

    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 10px 20px;
      border: none;
      border-radius: 8px;
      font-size: 0.95rem;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
    }

    .btn-primary { background: var(--primary); color: white; }
    .btn-primary:hover { background: var(--primary-dark); transform: translateY(-1px); }
    .btn-secondary { background: var(--surface); color: var(--text); border: 1px solid var(--border); }
    .btn-secondary:hover { background: var(--background); }
    .btn-danger { background: var(--error); color: white; }
    .btn-danger:hover { background: #dc2626; }
    .btn-success { background: var(--success); color: white; }
    .btn-success:hover { background: #16a34a; }
    .btn-block { width: 100%; }

    .auth-container {
      min-height: calc(100vh - 68px);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 40px 20px;
    }

    .auth-card { width: 100%; max-width: 400px; }

    .auth-tabs {
      display: flex;
      margin-bottom: 24px;
      border-bottom: 1px solid var(--border);
    }

    .auth-tab {
      flex: 1;
      padding: 12px;
      background: none;
      border: none;
      font-size: 1rem;
      font-weight: 500;
      color: var(--text-muted);
      cursor: pointer;
      border-bottom: 2px solid transparent;
      transition: all 0.2s;
    }

    .auth-tab.active { color: var(--primary); border-bottom-color: var(--primary); }
    .auth-form { display: none; }
    .auth-form.active { display: block; }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 12px;
      margin-bottom: 24px;
    }

    .stat-card {
      background: var(--surface);
      border-radius: 12px;
      padding: 16px;
      border: 1px solid var(--border);
      text-align: center;
    }

    .stat-label { font-size: 0.8rem; color: var(--text-muted); margin-bottom: 6px; }
    .stat-value { font-size: 1.5rem; font-weight: 700; }
    .stat-value.income { color: var(--success); }
    .stat-value.expense { color: var(--error); }

    .ledger-list { display: grid; gap: 12px; }

    .ledger-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      cursor: pointer;
      transition: all 0.2s;
    }

    .ledger-item:hover {
      border-color: var(--primary);
      box-shadow: 0 4px 12px rgba(249, 115, 22, 0.1);
    }

    .ledger-info h3 { font-size: 1.1rem; margin-bottom: 4px; }
    .ledger-info p { font-size: 0.85rem; color: var(--text-muted); }
    .ledger-info .ledger-id { font-size: 0.75rem; color: var(--text-muted); font-family: monospace; word-break: break-all; }
    .ledger-info .ledger-balance { color: var(--success); font-weight: 500; }
    .ledger-stats { text-align: right; }
    .ledger-stats .income { color: var(--success); font-size: 0.95rem; }
    .ledger-stats .expense { color: var(--error); font-size: 0.95rem; }

    .modal {
      display: none;
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0, 0, 0, 0.5);
      align-items: center;
      justify-content: center;
      z-index: 1000;
      padding: 20px;
    }

    .modal.active { display: flex; }

    .modal-content {
      background: var(--surface);
      border-radius: 16px;
      padding: 24px;
      width: 100%;
      max-width: 500px;
      max-height: 90vh;
      overflow-y: auto;
    }

    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
    }

    .modal-title { font-size: 1.2rem; font-weight: 600; }
    .modal-close { background: none; border: none; font-size: 1.5rem; cursor: pointer; color: var(--text-muted); padding: 4px; }
    .modal-close:hover { color: var(--text); }

    .transaction-list { display: flex; flex-direction: column; gap: 10px; }

    .transaction-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px;
      background: var(--background);
      border-radius: 8px;
      transition: all 0.2s;
    }

    .transaction-item:hover { background: var(--border); }

    .transaction-icon {
      width: 40px;
      height: 40px;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.2rem;
    }

    .transaction-icon.income { background: #dcfce7; }
    .transaction-icon.expense { background: #fee2e2; }

    .transaction-info { flex: 1; }
    .transaction-info h4 { font-size: 0.95rem; margin-bottom: 2px; }
    .transaction-info p { font-size: 0.8rem; color: var(--text-muted); }

    .transaction-amount { font-weight: 600; font-size: 0.95rem; }
    .transaction-amount.income { color: var(--success); }
    .transaction-amount.expense { color: var(--error); }

    .transaction-actions { display: flex; gap: 8px; }
    .tx-action-btn {
      padding: 6px 10px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 6px;
      font-size: 0.8rem;
      cursor: pointer;
      transition: all 0.2s;
    }
    .tx-action-btn:hover { background: var(--background); }
    .tx-action-btn.delete:hover { background: #fee2e2; color: var(--error); border-color: var(--error); }

    .loading {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 40px;
      color: var(--text-muted);
    }

    .spinner {
      width: 24px;
      height: 24px;
      border: 3px solid var(--border);
      border-top-color: var(--primary);
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin-right: 12px;
    }

    @keyframes spin { to { transform: rotate(360deg); } }

    .toast {
      position: fixed;
      bottom: 20px;
      right: 20px;
      padding: 12px 24px;
      border-radius: 8px;
      color: white;
      font-weight: 500;
      z-index: 2000;
      animation: slideIn 0.3s ease;
    }

    .toast.success { background: var(--success); }
    .toast.error { background: var(--error); }

    @keyframes slideIn {
      from { transform: translateX(100%); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }

    .empty-state { text-align: center; padding: 60px 20px; color: var(--text-muted); }
    .empty-state-icon { font-size: 4rem; margin-bottom: 16px; }

    .settings-nav {
      display: flex;
      gap: 8px;
      margin-bottom: 20px;
      flex-wrap: wrap;
    }

    .settings-nav-btn {
      padding: 10px 16px;
      background: var(--background);
      border: 1px solid var(--border);
      border-radius: 8px;
      cursor: pointer;
      font-size: 0.9rem;
      transition: all 0.2s;
    }

    .settings-nav-btn:hover { background: var(--border); }
    .settings-nav-btn.active { background: var(--primary); color: white; border-color: var(--primary); }

    .settings-section { display: none; }
    .settings-section.active { display: block; }

    .type-selector {
      display: flex;
      gap: 12px;
      margin-bottom: 20px;
    }

    .type-btn {
      flex: 1;
      padding: 14px;
      border: 2px solid var(--border);
      border-radius: 12px;
      background: var(--surface);
      cursor: pointer;
      text-align: center;
      transition: all 0.2s;
    }

    .type-btn:hover { border-color: var(--primary); }
    .type-btn.active { border-color: var(--primary); background: var(--primary-light); }
    .type-btn .icon { font-size: 1.8rem; margin-bottom: 6px; }
    .type-btn .label { font-weight: 600; }
    .type-btn.expense.active { border-color: var(--error); background: #fee2e2; }
    .type-btn.income.active { border-color: var(--success); background: #dcfce7; }

    .quick-amounts {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 16px;
    }

    .quick-amount {
      padding: 8px 14px;
      background: var(--background);
      border: 1px solid var(--border);
      border-radius: 20px;
      cursor: pointer;
      font-size: 0.85rem;
    }

    .quick-amount:hover { background: var(--border); }

    .filter-bar {
      display: flex;
      gap: 12px;
      margin-bottom: 20px;
      flex-wrap: wrap;
      align-items: center;
    }

    .filter-bar select, .filter-bar input {
      padding: 8px 12px;
      border: 1px solid var(--border);
      border-radius: 6px;
      font-size: 0.9rem;
    }

    .filter-bar select:focus, .filter-bar input:focus {
      outline: none;
      border-color: var(--primary);
    }

    .category-list, .tag-list, .account-list {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
      gap: 10px;
      margin-top: 16px;
    }

    .category-item, .tag-item, .account-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      background: var(--background);
      border: 1px solid var(--border);
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.2s;
    }

    .category-item:hover, .tag-item:hover, .account-item:hover {
      background: var(--border);
    }

    .category-icon { font-size: 1.2rem; }

    .chart-container {
      background: var(--surface);
      border-radius: 12px;
      padding: 20px;
      border: 1px solid var(--border);
      margin-bottom: 20px;
    }

    .chart-title {
      font-size: 1rem;
      font-weight: 600;
      margin-bottom: 16px;
      color: var(--text);
    }

    .bar-chart {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .bar-item {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .bar-label {
      width: 80px;
      font-size: 0.85rem;
      color: var(--text-muted);
      text-align: right;
    }

    .bar-track {
      flex: 1;
      height: 24px;
      background: var(--background);
      border-radius: 12px;
      overflow: hidden;
      position: relative;
    }

    .bar-fill {
      height: 100%;
      border-radius: 12px;
      transition: width 0.3s ease;
      display: flex;
      align-items: center;
      justify-content: flex-end;
      padding-right: 8px;
      color: white;
      font-size: 0.75rem;
      font-weight: 600;
    }

    .bar-fill.income { background: var(--success); }
    .bar-fill.expense { background: var(--error); }

    .ledger-actions { display: flex; gap: 8px; }

    .budget-list { display: flex; flex-direction: column; gap: 12px; }
    .budget-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px;
      background: var(--background);
      border: 1px solid var(--border);
      border-radius: 8px;
    }
    .budget-info { display: flex; flex-direction: column; gap: 4px; }
    .budget-category { font-weight: 500; }
    .budget-period { font-size: 0.8rem; color: var(--text-muted); }
    .budget-amount { display: flex; flex-direction: column; gap: 4px; align-items: flex-end; }
    .budget-progress { width: 100px; height: 8px; background: var(--border); border-radius: 4px; overflow: hidden; }
    .progress-bar { height: 100%; background: var(--primary); transition: width 0.3s; }
    .budget-actions { display: flex; gap: 8px; margin-left: 16px; }

    .page-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
    }

    .page-header h2 {
      font-size: 1.25rem;
      font-weight: 600;
    }

    .badge {
      display: inline-block;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 0.75rem;
      font-weight: 500;
    }

    .badge-success { background: #dcfce7; color: var(--success); }
    .badge-error { background: #fee2e2; color: var(--error); }
    .badge-warning { background: #fef3c7; color: var(--warning); }

    .section-title {
      font-size: 1rem;
      font-weight: 600;
      margin-bottom: 12px;
      color: var(--text);
    }

    .two-fa-status {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 16px;
      background: var(--background);
      border-radius: 8px;
      margin-bottom: 16px;
    }

    .two-fa-status.enabled { background: #dcfce7; }
    .two-fa-status.disabled { background: #fef3c7; }

    .backup-list { display: flex; flex-direction: column; gap: 12px; }

    .backup-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px;
      background: var(--background);
      border-radius: 8px;
    }

    .device-list { display: flex; flex-direction: column; gap: 10px; }

    .device-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px;
      background: var(--background);
      border-radius: 8px;
    }

    .device-info { display: flex; align-items: center; gap: 12px; }
    .device-icon { font-size: 1.5rem; }
    .device-name { font-weight: 500; }
    .device-meta { font-size: 0.8rem; color: var(--text-muted); }

    @media (max-width: 768px) {
      .header-content { flex-direction: column; gap: 12px; }
      .stats-grid { grid-template-columns: 1fr 1fr; }
      .nav-tabs { flex-wrap: wrap; justify-content: center; }
      .filter-bar { flex-direction: column; }
      .filter-bar > * { width: 100%; }
      .category-list, .tag-list, .account-list { grid-template-columns: 1fr 1fr; }
    }
  </style>
</head>
<body>
  <div id="app"></div>

  <script>
    const API_BASE = window.location.origin;
    
    const state = {
      token: localStorage.getItem('token'),
      user: null,
      ledgers: [],
      currentLedger: null,
      transactions: [],
      categories: [],
      accounts: [],
      tags: [],
      currentPage: 'home',
      currentLedgerForTx: null
    };

    async function api(endpoint, options = {}) {
      const headers = {};
      if (state.token) {
        headers['Authorization'] = 'Bearer ' + state.token;
      }
      
      // 通过 header 传递 device_id（和原版 BeeCount-Cloud 一致）
      const deviceId = localStorage.getItem('device_id');
      if (deviceId) {
        headers['X-Device-ID'] = deviceId;
      }
      
      const fetchOptions = {
        ...options,
        headers: { ...headers, ...options.headers }
      };
      
      // 如果 body 是 FormData，不设置 Content-Type，让浏览器自动设置
      if (options.body instanceof FormData) {
        delete fetchOptions.headers['Content-Type'];
      } else if (!fetchOptions.headers['Content-Type']) {
        fetchOptions.headers['Content-Type'] = 'application/json';
      }
      
      const response = await fetch(API_BASE + endpoint, fetchOptions);
      
      if (response.status === 401) {
        localStorage.removeItem('token');
        localStorage.removeItem('device_id');
        state.token = null;
        render();
        throw new Error('登录已过期，请重新登录');
      }
      
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || data.details || '请求失败');
      }
      return data;
    }

    function showToast(message, type) {
      type = type || 'success';
      const toast = document.createElement('div');
      toast.className = 'toast ' + type;
      toast.textContent = message;
      document.body.appendChild(toast);
      setTimeout(function() { toast.remove(); }, 3000);
    }

    function formatMoney(amount) {
      if (!amount && amount !== 0) return '¥0.00';
      return new Intl.NumberFormat('zh-CN', {
        style: 'currency',
        currency: 'CNY'
      }).format(amount / 100);
    }

    function formatDate(dateStr) {
      if (!dateStr) return '';
      return new Date(dateStr).toLocaleDateString('zh-CN');
    }

    function formatDateTime(dateStr) {
      if (!dateStr) return '';
      const d = new Date(dateStr);
      return d.toLocaleDateString('zh-CN') + ' ' + d.toLocaleTimeString('zh-CN', {hour: '2-digit', minute:'2-digit'});
    }

    function render() {
      const app = document.getElementById('app');
      
      if (!state.token) {
        app.innerHTML = renderAuth();
        bindAuthEvents();
      } else {
        app.innerHTML = renderMainLayout();
        bindNavigationEvents();
        loadPageData();
      }
    }

    function renderAuth() {
      return '<header class="header"><div class="container header-content"><div class="logo"><div class="logo-icon">🐝</div><span>蜜蜂记账</span></div></div></header><div class="auth-container"><div class="card auth-card"><div class="auth-tabs"><button class="auth-tab active" data-tab="login">登录</button><button class="auth-tab" data-tab="register">注册</button></div><form id="loginForm" class="auth-form active"><div class="form-group"><label>邮箱</label><input type="email" name="email" placeholder="your@email.com" required></div><div class="form-group"><label>密码</label><input type="password" name="password" placeholder="••••••••" required></div><button type="submit" class="btn btn-primary btn-block">登录</button></form><form id="registerForm" class="auth-form"><div class="form-group"><label>邮箱</label><input type="email" name="email" placeholder="your@email.com" required></div><div class="form-group"><label>密码</label><input type="password" name="password" placeholder="至少 8 位" minlength="8" required></div><button type="submit" class="btn btn-primary btn-block">注册</button></form></div></div>';
    }

    function bindAuthEvents() {
      document.querySelectorAll('.auth-tab').forEach(function(tab) {
        tab.addEventListener('click', function() {
          document.querySelectorAll('.auth-tab').forEach(function(t) { t.classList.remove('active'); });
          document.querySelectorAll('.auth-form').forEach(function(f) { f.classList.remove('active'); });
          tab.classList.add('active');
          document.getElementById(tab.dataset.tab + 'Form').classList.add('active');
        });
      });

      document.getElementById('loginForm').addEventListener('submit', async function(e) {
        e.preventDefault();
        const formData = new FormData(e.target);
        
        // 获取或生成设备 ID
        let deviceId = localStorage.getItem('device_id');
        if (!deviceId) {
          deviceId = 'web_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
          localStorage.setItem('device_id', deviceId);
        }
        
        // 检测平台和设备名称
        const ua = navigator.userAgent;
        let platform = 'unknown';
        let deviceName = 'Web Browser';
        
        if (ua.includes('Windows')) { platform = 'windows'; deviceName = 'Windows PC'; }
        else if (ua.includes('Mac')) { platform = 'macos'; deviceName = 'Mac'; }
        else if (ua.includes('Linux')) { platform = 'linux'; deviceName = 'Linux PC'; }
        else if (ua.includes('Android')) { platform = 'android'; deviceName = 'Android Device'; }
        else if (ua.includes('iOS') || ua.includes('iPhone') || ua.includes('iPad')) { platform = 'ios'; deviceName = 'iOS Device'; }
        
        try {
          const data = await api('/api/v1/auth/login', {
            method: 'POST',
            body: JSON.stringify({
              email: formData.get('email'),
              password: formData.get('password'),
              device_id: deviceId,
              device_name: deviceName,
              platform: platform
            })
          });
          state.token = data.access_token;
          localStorage.setItem('token', data.access_token);
          showToast('登录成功');
          render();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });

      document.getElementById('registerForm').addEventListener('submit', async function(e) {
        e.preventDefault();
        const formData = new FormData(e.target);
        try {
          await api('/api/v1/auth/register', {
            method: 'POST',
            body: JSON.stringify({
              email: formData.get('email'),
              password: formData.get('password')
            })
          });
          showToast('注册成功，请登录');
          document.querySelector('[data-tab="login"]').click();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    }

    function renderMainLayout() {
      return '<header class="header"><div class="container header-content"><div class="logo"><div class="logo-icon">🐝</div><span>蜜蜂记账</span></div><div class="nav-tabs"><button class="nav-tab active" data-page="home">首页</button><button class="nav-tab" data-page="transactions">交易</button><button class="nav-tab" data-page="categories">分类</button><button class="nav-tab" data-page="accounts">账户</button><button class="nav-tab" data-page="stats">统计</button><button class="nav-tab" data-page="tags">🏷️ 标签</button><button class="nav-tab" data-page="budgets">💰 预算</button><button class="nav-tab" data-page="backup">☁️ 备份</button><button class="nav-tab" data-page="debug">🔍 调试</button></div><div class="header-actions"><button class="header-btn" onclick="showSettingsModal()">⚙️</button><button class="header-btn" onclick="logout()">退出</button></div></div></header><main class="container" id="mainContent"></main>' + renderAllModals();
    }

    function renderAllModals() {
      return '<div id="ledgerModal" class="modal"><div class="modal-content"><div class="modal-header"><h3 class="modal-title" id="ledgerModalTitle">账本详情</h3><button class="modal-close" onclick="closeModal(\&apos;ledgerModal\&apos;)">×</button></div><div id="ledgerModalContent"></div></div></div><div id="createLedgerModal" class="modal"><div class="modal-content"><div class="modal-header"><h3 class="modal-title">新建账本</h3><button class="modal-close" onclick="closeModal(\&apos;createLedgerModal\&apos;)">×</button></div><form id="createLedgerForm"><div class="form-group"><label>账本名称</label><input type="text" name="name" placeholder="例如：家庭账本" required></div><div class="form-group"><label>货币</label><select name="currency"><option value="CNY">人民币 (CNY)</option><option value="USD">美元 (USD)</option><option value="EUR">欧元 (EUR)</option></select></div><button type="submit" class="btn btn-primary btn-block">创建</button></form></div></div><div id="editLedgerModal" class="modal"><div class="modal-content"><div class="modal-header"><h3 class="modal-title">编辑账本</h3><button class="modal-close" onclick="closeModal(\&apos;editLedgerModal\&apos;)">×</button></div><form id="editLedgerForm"><input type="hidden" name="ledger_id"><div class="form-group"><label>账本名称</label><input type="text" name="name" placeholder="例如：家庭账本" required></div><div class="form-group"><label>货币</label><select name="currency"><option value="CNY">人民币 (CNY)</option><option value="USD">美元 (USD)</option><option value="EUR">欧元 (EUR)</option></select></div><button type="submit" class="btn btn-primary btn-block">保存</button></form></div></div><div id="deleteLedgerModal" class="modal"><div class="modal-content"><div class="modal-header"><h3 class="modal-title">删除账本</h3><button class="modal-close" onclick="closeModal(\&apos;deleteLedgerModal\&apos;)">×</button></div><p>确定要删除这个账本吗？所有交易记录将被永久删除！</p><form id="deleteLedgerForm"><input type="hidden" name="ledger_id"><button type="submit" class="btn btn-danger btn-block">确认删除</button></form></div></div><div id="createCategoryModal" class="modal"><div class="modal-content"><div class="modal-header"><h3 class="modal-title">新建分类</h3><button class="modal-close" onclick="closeModal(\&apos;createCategoryModal\&apos;)">×</button></div><form id="createCategoryForm"><div class="form-group"><label>分类名称</label><input type="text" name="name" placeholder="例如：餐饮" required></div><div class="form-group"><label>类型</label><select name="kind"><option value="expense">支出</option><option value="income">收入</option></select></div><div class="form-group"><label>图标</label><input type="text" name="icon" placeholder="例如：🍔" value="📁"></div><button type="submit" class="btn btn-primary btn-block">创建</button></form></div></div><div id="editCategoryModal" class="modal"><div class="modal-content"><div class="modal-header"><h3 class="modal-title">编辑分类</h3><button class="modal-close" onclick="closeModal(\&apos;editCategoryModal\&apos;)">×</button></div><form id="editCategoryForm"><input type="hidden" name="category_sync_id"><div class="form-group"><label>分类名称</label><input type="text" name="name" placeholder="例如：餐饮" required></div><div class="form-group"><label>类型</label><select name="kind"><option value="expense">支出</option><option value="income">收入</option></select></div><div class="form-group"><label>图标</label><input type="text" name="icon" placeholder="例如：🍔" value="📁"></div><button type="submit" class="btn btn-primary btn-block">保存</button></form></div></div><div id="deleteCategoryModal" class="modal"><div class="modal-content"><div class="modal-header"><h3 class="modal-title">删除分类</h3><button class="modal-close" onclick="closeModal(\&apos;deleteCategoryModal\&apos;)">×</button></div><p>确定要删除这个分类吗？</p><form id="deleteCategoryForm"><input type="hidden" name="category_sync_id"><button type="submit" class="btn btn-danger btn-block">确认删除</button></form></div></div><div id="createAccountModal" class="modal"><div class="modal-content"><div class="modal-header"><h3 class="modal-title">新建账户</h3><button class="modal-close" onclick="closeModal(\&apos;createAccountModal\&apos;)">×</button></div><form id="createAccountForm"><div class="form-group"><label>账户名称</label><input type="text" name="name" placeholder="例如：现金" required></div><div class="form-group"><label>类型</label><select name="kind"><option value="cash">现金</option><option value="bank">银行卡</option><option value="credit">信用卡</option><option value="other">其他</option></select></div><div class="form-group"><label>余额 (分)</label><input type="number" name="balance" placeholder="当前余额" value="0"></div><button type="submit" class="btn btn-primary btn-block">创建</button></form></div></div><div id="editAccountModal" class="modal"><div class="modal-content"><div class="modal-header"><h3 class="modal-title">编辑账户</h3><button class="modal-close" onclick="closeModal(\&apos;editAccountModal\&apos;)">×</button></div><form id="editAccountForm"><input type="hidden" name="account_sync_id"><div class="form-group"><label>账户名称</label><input type="text" name="name" placeholder="例如：现金" required></div><div class="form-group"><label>类型</label><select name="kind"><option value="cash">现金</option><option value="bank">银行卡</option><option value="credit">信用卡</option><option value="other">其他</option></select></div><div class="form-group"><label>余额 (分)</label><input type="number" name="balance" placeholder="当前余额"></div><button type="submit" class="btn btn-primary btn-block">保存</button></form></div></div><div id="deleteAccountModal" class="modal"><div class="modal-content"><div class="modal-header"><h3 class="modal-title">删除账户</h3><button class="modal-close" onclick="closeModal(\&apos;deleteAccountModal\&apos;)">×</button></div><p>确定要删除这个账户吗？</p><form id="deleteAccountForm"><input type="hidden" name="account_sync_id"><button type="submit" class="btn btn-danger btn-block">确认删除</button></form></div></div><div id="createTagModal" class="modal"><div class="modal-content"><div class="modal-header"><h3 class="modal-title">新建标签</h3><button class="modal-close" onclick="closeModal(\&apos;createTagModal\&apos;)">×</button></div><form id="createTagForm"><div class="form-group"><label>标签名称</label><input type="text" name="name" placeholder="例如：重要" required></div><button type="submit" class="btn btn-primary btn-block">创建</button></form></div></div><div id="editTagModal" class="modal"><div class="modal-content"><div class="modal-header"><h3 class="modal-title">编辑标签</h3><button class="modal-close" onclick="closeModal(\&apos;editTagModal\&apos;)">×</button></div><form id="editTagForm"><input type="hidden" name="tag_sync_id"><div class="form-group"><label>标签名称</label><input type="text" name="name" placeholder="例如：重要" required></div><button type="submit" class="btn btn-primary btn-block">保存</button></form></div></div><div id="deleteTagModal" class="modal"><div class="modal-content"><div class="modal-header"><h3 class="modal-title">删除标签</h3><button class="modal-close" onclick="closeModal(\&apos;deleteTagModal\&apos;)">×</button></div><p>确定要删除这个标签吗？</p><form id="deleteTagForm"><input type="hidden" name="tag_sync_id"><button type="submit" class="btn btn-danger btn-block">确认删除</button></form></div></div><div id="createBudgetModal" class="modal"><div class="modal-content"><div class="modal-header"><h3 class="modal-title">设置预算</h3><button class="modal-close" onclick="closeModal(\&apos;createBudgetModal\&apos;)">×</button></div><form id="createBudgetForm"><div class="form-group"><label>分类</label><select name="category_id" id="budgetCategorySelect"><option value="">选择分类</option></select></div><div class="form-group"><label>预算金额 (分)</label><input type="number" name="amount" placeholder="例如：500000 = 5000元" required></div><button type="submit" class="btn btn-primary btn-block">保存</button></form></div></div><div id="editBudgetModal" class="modal"><div class="modal-content"><div class="modal-header"><h3 class="modal-title">编辑预算</h3><button class="modal-close" onclick="closeModal(\&apos;editBudgetModal\&apos;)">×</button></div><form id="editBudgetForm"><input type="hidden" name="budget_sync_id"><div class="form-group"><label>分类</label><select name="category_id" id="editBudgetCategorySelect"><option value="">选择分类</option></select></div><div class="form-group"><label>预算金额 (分)</label><input type="number" name="amount" placeholder="例如：500000 = 5000元" required></div><button type="submit" class="btn btn-primary btn-block">保存</button></form></div></div><div id="deleteBudgetModal" class="modal"><div class="modal-content"><div class="modal-header"><h3 class="modal-title">删除预算</h3><button class="modal-close" onclick="closeModal(\&apos;deleteBudgetModal\&apos;)">×</button></div><p>确定要删除这个预算吗？</p><form id="deleteBudgetForm"><input type="hidden" name="budget_sync_id"><button type="submit" class="btn btn-danger btn-block">确认删除</button></form></div></div><div id="settingsModal" class="modal"><div class="modal-content" style="max-width: 600px;"><div class="modal-header"><h3 class="modal-title">设置</h3><button class="modal-close" onclick="closeModal(\&apos;settingsModal\&apos;)">×</button></div><div id="settingsContent"></div></div></div><div id="createTxModal" class="modal"><div class="modal-content"><div class="modal-header"><h3 class="modal-title">记一笔</h3><button class="modal-close" onclick="closeModal(\&apos;createTxModal\&apos;)">×</button></div><form id="createTxForm"><div class="form-group"><label>账本</label><select name="ledger_id" id="txLedgerSelect"></select></div><div class="type-selector"><div class="type-btn expense active" data-type="expense" onclick="selectTxType(\&apos;expense\&apos;)"><div class="icon">📉</div><div class="label">支出</div></div><div class="type-btn income" data-type="income" onclick="selectTxType(\&apos;income\&apos;)"><div class="icon">📈</div><div class="label">收入</div></div></div><div class="form-group"><label>金额 (元)</label><input type="number" name="amount" placeholder="请输入金额" min="1" required step="0.01"><small style="color: var(--text-muted);">例如：100 = 100元</small></div><div class="quick-amounts"><button type="button" class="quick-amount" onclick="setQuickAmount(1000)">10元</button><button type="button" class="quick-amount" onclick="setQuickAmount(5000)">50元</button><button type="button" class="quick-amount" onclick="setQuickAmount(10000)">100元</button><button type="button" class="quick-amount" onclick="setQuickAmount(50000)">500元</button></div><div class="form-group"><label>分类</label><input type="text" name="category_name" placeholder="例如：餐饮、交通"></div><div class="form-group"><label>账户</label><input type="text" name="account_name" placeholder="例如：现金、银行卡"></div><div class="form-group"><label>备注</label><input type="text" name="note" placeholder="可选"></div><input type="hidden" name="tx_type" id="txTypeInput" value="expense"><button type="submit" class="btn btn-primary btn-block">保存</button></form></div></div><div id="editTxModal" class="modal"><div class="modal-content"><div class="modal-header"><h3 class="modal-title">编辑交易</h3><button class="modal-close" onclick="closeModal(\&apos;editTxModal\&apos;)">×</button></div><form id="editTxForm"><input type="hidden" name="tx_id"><div class="form-group"><label>账本</label><select name="ledger_id" id="editTxLedgerSelect"></select></div><div class="type-selector"><div class="type-btn expense" data-type="expense" onclick="selectEditTxType(\&apos;expense\&apos;)"><div class="icon">📉</div><div class="label">支出</div></div><div class="type-btn income" data-type="income" onclick="selectEditTxType(\&apos;income\&apos;)"><div class="icon">📈</div><div class="label">收入</div></div></div><div class="form-group"><label>金额 (元)</label><input type="number" name="amount" placeholder="请输入金额" min="1" required step="0.01"></div><div class="form-group"><label>分类</label><input type="text" name="category_name" placeholder="例如：餐饮、交通"></div><div class="form-group"><label>账户</label><input type="text" name="account_name" placeholder="例如：现金、银行卡"></div><div class="form-group"><label>备注</label><input type="text" name="note" placeholder="可选"></div><input type="hidden" name="tx_type" id="editTxTypeInput" value="expense"><button type="submit" class="btn btn-primary btn-block">保存</button></form></div></div><div id="confirmClearDataModal" class="modal"><div class="modal-content"><div class="modal-header"><h3 class="modal-title">确认清空数据</h3><button class="modal-close" onclick="closeModal(\&apos;confirmClearDataModal\&apos;)">×</button></div><p style="color: #e74c3c; font-weight: bold;">警告：此操作不可恢复！</p><p>确定要清空所有账本、交易、分类、账户和标签数据吗？</p><form id="confirmClearDataForm"><div class="form-group"><label>请输入"清空"确认</label><input type="text" name="confirm_text" placeholder="请输入清空" required></div><button type="submit" class="btn btn-danger btn-block">确认清空所有数据</button></form></div></div><div id="importModal" class="modal"><div class="modal-content" style="max-width: 500px;"><div class="modal-header"><h3 class="modal-title">导入数据</h3><button class="modal-close" onclick="closeModal(\&apos;importModal\&apos;)">×</button></div><div id="importStep1"><p style="color: var(--text-muted); margin-bottom: 16px;">支持 JSON、CSV、Excel 文件</p><div class="form-group"><label>导入账本</label><select name="ledger_id" id="importLedgerSelect"></select></div><div class="form-group"><label>选择文件</label><input type="file" id="importFileInput" accept=".json,.csv,.xlsx,.xls" style="width: 100%; padding: 10px; border: 1px solid var(--border-color); border-radius: 8px;"></div><div id="importPreview" style="margin-top: 16px; max-height: 300px; overflow-y: auto;"></div><button type="button" class="btn btn-primary btn-block" onclick="startImport()">开始导入</button></div><div id="importProgress" style="display: none;"><p>正在导入...</p><div style="background: var(--border-color); height: 8px; border-radius: 4px; margin: 16px 0;"><div id="importProgressBar" style="background: var(--primary-color); height: 100%; border-radius: 4px; width: 0%; transition: width 0.3s;"></div></div><p id="importStatus"></p></div></div></div>';
    }

    function bindNavigationEvents() {
      document.querySelectorAll('.nav-tab').forEach(function(tab) {
        tab.addEventListener('click', function() {
          document.querySelectorAll('.nav-tab').forEach(function(t) { t.classList.remove('active'); });
          tab.classList.add('active');
          state.currentPage = tab.dataset.page;
          loadPageData();
        });
      });

      document.getElementById('confirmClearDataForm').addEventListener('submit', async function(e) {
        e.preventDefault();
        const formData = new FormData(e.target);
        if (formData.get('confirm_text') !== '清空') {
          showToast('请输入"清空"确认', 'error');
          return;
        }
        await confirmClearData();
      });

      bindDashboardEvents();
    }

    function bindDashboardEvents() {
      document.getElementById('createLedgerForm').addEventListener('submit', async function(e) {
        e.preventDefault();
        const formData = new FormData(e.target);
        try {
          await api('/api/v1/write/ledgers', {
            method: 'POST',
            body: JSON.stringify({
              ledger_name: formData.get('name'),
              currency: formData.get('currency')
            })
          });
          closeModal('createLedgerModal');
          showToast('账本创建成功，正在初始化默认分类...');
          loadPageData();
          
          setTimeout(async function() {
            try {
              await api('/api/v1/write/categories/init-defaults', {
                method: 'POST'
              });
              showToast('默认分类已初始化');
              loadPageData();
            } catch (err) {
              console.error('Init default categories failed:', err);
            }
          }, 500);
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
      
      document.getElementById('createTxForm').addEventListener('submit', async function(e) {
        e.preventDefault();
        const formData = new FormData(e.target);
        const ledgerId = formData.get('ledger_id');
        
        if (!ledgerId) {
          showToast('请选择账本', 'error');
          return;
        }
        
        try {
          await api('/api/v1/write/transactions', {
            method: 'POST',
            body: JSON.stringify({
              ledger_id: ledgerId,
              tx_type: formData.get('tx_type'),
              amount: parseInt(formData.get('amount')) * 100,
              category_name: formData.get('category_name') || null,
              account_name: formData.get('account_name') || null,
              note: formData.get('note') || null,
              happened_at: new Date().toISOString()
            })
          });
          closeModal('createTxModal');
          showToast('记账成功');
          loadPageData();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });

      document.getElementById('editTxForm').addEventListener('submit', async function(e) {
        e.preventDefault();
        const formData = new FormData(e.target);
        const txId = formData.get('tx_id');
        
        try {
          await api('/api/v1/write/transactions/' + txId, {
            method: 'PATCH',
            body: JSON.stringify({
              base_change_id: 0,
              ledger_id: formData.get('ledger_id'),
              tx_type: formData.get('tx_type'),
              amount: parseInt(formData.get('amount')) * 100,
              category_name: formData.get('category_name') || null,
              account_name: formData.get('account_name') || null,
              note: formData.get('note') || null
            })
          });
          closeModal('editTxModal');
          showToast('更新成功');
          loadPageData();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });

      document.getElementById('createCategoryForm').addEventListener('submit', async function(e) {
        e.preventDefault();
        const formData = new FormData(e.target);
        try {
          await api('/api/v1/write/categories', {
            method: 'POST',
            body: JSON.stringify({
              name: formData.get('name'),
              kind: formData.get('kind'),
              icon: formData.get('icon')
            })
          });
          closeModal('createCategoryModal');
          showToast('分类创建成功');
          loadPageData();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });

      document.getElementById('createAccountForm').addEventListener('submit', async function(e) {
        e.preventDefault();
        const formData = new FormData(e.target);
        try {
          await api('/api/v1/write/accounts', {
            method: 'POST',
            body: JSON.stringify({
              name: formData.get('name'),
              kind: formData.get('kind'),
              balance: parseInt(formData.get('balance')) || 0
            })
          });
          closeModal('createAccountModal');
          showToast('账户创建成功');
          loadPageData();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });

      document.getElementById('editLedgerForm').addEventListener('submit', async function(e) {
        e.preventDefault();
        const formData = new FormData(e.target);
        const ledgerId = formData.get('ledger_id');
        try {
          await api('/api/v1/write/ledgers/' + ledgerId, {
            method: 'PATCH',
            body: JSON.stringify({
              base_change_id: 0,
              ledger_name: formData.get('name'),
              currency: formData.get('currency')
            })
          });
          closeModal('editLedgerModal');
          showToast('账本更新成功');
          loadPageData();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });

      document.getElementById('deleteLedgerForm').addEventListener('submit', async function(e) {
        e.preventDefault();
        const formData = new FormData(e.target);
        const ledgerId = formData.get('ledger_id');
        try {
          await api('/api/v1/write/ledgers/' + ledgerId, {
            method: 'DELETE',
            body: JSON.stringify({ base_change_id: 0 })
          });
          closeModal('deleteLedgerModal');
          showToast('账本已删除');
          loadPageData();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });

      document.getElementById('editCategoryForm').addEventListener('submit', async function(e) {
        e.preventDefault();
        const formData = new FormData(e.target);
        const syncId = formData.get('category_sync_id');
        try {
          await api('/api/v1/write/categories/' + syncId, {
            method: 'PATCH',
            body: JSON.stringify({
              base_change_id: 0,
              name: formData.get('name'),
              kind: formData.get('kind'),
              icon: formData.get('icon') || '📁'
            })
          });
          closeModal('editCategoryModal');
          showToast('分类更新成功');
          loadPageData();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });

      document.getElementById('deleteCategoryForm').addEventListener('submit', async function(e) {
        e.preventDefault();
        const formData = new FormData(e.target);
        const syncId = formData.get('category_sync_id');
        try {
          await api('/api/v1/write/categories/' + syncId, {
            method: 'DELETE',
            body: JSON.stringify({ base_change_id: 0 })
          });
          closeModal('deleteCategoryModal');
          showToast('分类已删除');
          loadPageData();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });

      document.getElementById('editAccountForm').addEventListener('submit', async function(e) {
        e.preventDefault();
        const formData = new FormData(e.target);
        const syncId = formData.get('account_sync_id');
        try {
          await api('/api/v1/write/accounts/' + syncId, {
            method: 'PATCH',
            body: JSON.stringify({
              base_change_id: 0,
              name: formData.get('name'),
              kind: formData.get('kind'),
              initial_balance: parseInt(formData.get('balance')) || 0
            })
          });
          closeModal('editAccountModal');
          showToast('账户更新成功');
          loadPageData();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });

      document.getElementById('deleteAccountForm').addEventListener('submit', async function(e) {
        e.preventDefault();
        const formData = new FormData(e.target);
        const syncId = formData.get('account_sync_id');
        try {
          await api('/api/v1/write/accounts/' + syncId, {
            method: 'DELETE',
            body: JSON.stringify({ base_change_id: 0 })
          });
          closeModal('deleteAccountModal');
          showToast('账户已删除');
          loadPageData();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });

      document.getElementById('createTagForm').addEventListener('submit', async function(e) {
        e.preventDefault();
        const formData = new FormData(e.target);
        try {
          await api('/api/v1/write/tags', {
            method: 'POST',
            body: JSON.stringify({
              base_change_id: 0,
              name: formData.get('name')
            })
          });
          closeModal('createTagModal');
          showToast('标签创建成功');
          loadPageData();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });

      document.getElementById('editTagForm').addEventListener('submit', async function(e) {
        e.preventDefault();
        const formData = new FormData(e.target);
        const syncId = formData.get('tag_sync_id');
        try {
          await api('/api/v1/write/tags/' + syncId, {
            method: 'PATCH',
            body: JSON.stringify({
              base_change_id: 0,
              name: formData.get('name')
            })
          });
          closeModal('editTagModal');
          showToast('标签更新成功');
          loadPageData();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });

      document.getElementById('deleteTagForm').addEventListener('submit', async function(e) {
        e.preventDefault();
        const formData = new FormData(e.target);
        const syncId = formData.get('tag_sync_id');
        try {
          await api('/api/v1/write/tags/' + syncId, {
            method: 'DELETE',
            body: JSON.stringify({ base_change_id: 0 })
          });
          closeModal('deleteTagModal');
          showToast('标签已删除');
          loadPageData();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });

      document.getElementById('createBudgetForm').addEventListener('submit', async function(e) {
        e.preventDefault();
        const formData = new FormData(e.target);
        try {
          await api('/api/v1/write/budgets', {
            method: 'POST',
            body: JSON.stringify({
              base_change_id: 0,
              type: 'category',
              category_id: formData.get('category_id'),
              amount: parseInt(formData.get('amount')),
              period: 'monthly',
              start_day: 1,
              enabled: true
            })
          });
          closeModal('createBudgetModal');
          showToast('预算设置成功');
          loadPageData();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });

      document.getElementById('deleteBudgetForm').addEventListener('submit', async function(e) {
        e.preventDefault();
        const formData = new FormData(e.target);
        const syncId = formData.get('budget_sync_id');
        try {
          await api('/api/v1/write/budgets/' + syncId, {
            method: 'DELETE',
            body: JSON.stringify({ base_change_id: 0 })
          });
          closeModal('deleteBudgetModal');
          showToast('预算已删除');
          loadPageData();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });

      document.getElementById('editBudgetForm').addEventListener('submit', async function(e) {
        e.preventDefault();
        const formData = new FormData(e.target);
        const syncId = formData.get('budget_sync_id');
        try {
          await api('/api/v1/write/budgets/' + syncId, {
            method: 'PATCH',
            body: JSON.stringify({
              base_change_id: 0,
              type: 'category',
              category_id: formData.get('category_id'),
              amount: parseInt(formData.get('amount')),
              period: 'monthly',
              start_day: 1,
              enabled: true
            })
          });
          closeModal('editBudgetModal');
          showToast('预算更新成功');
          loadPageData();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    }

    async function loadPageData() {
      const mainContent = document.getElementById('mainContent');
      mainContent.innerHTML = '<div class="loading"><div class="spinner"></div>加载中...</div>';
      
      try {
        state.ledgers = await api('/api/v1/read/ledgers') || [];
        
        switch(state.currentPage) {
          case 'home':
            await renderHomePage(mainContent);
            break;
          case 'transactions':
            await renderTransactionsPage(mainContent);
            break;
          case 'categories':
            await renderCategoriesPage(mainContent);
            break;
          case 'accounts':
            await renderAccountsPage(mainContent);
            break;
          case 'stats':
            await renderStatsPage(mainContent);
            break;
          case 'tags':
            await renderTagsPage(mainContent);
            break;
          case 'budgets':
            await renderBudgetsPage(mainContent);
            break;
          case 'backup':
            await renderBackupPage(mainContent);
            break;
          case 'debug':
            await renderDebugPage(mainContent);
            break;
        }
      } catch (err) {
        mainContent.innerHTML = '<div class="empty-state"><p>加载失败: ' + err.message + '</p><button class="btn btn-primary" onclick="loadPageData()">重试</button></div>';
      }
    }

    async function renderHomePage(container) {
      let totalIncome = 0;
      let totalExpense = 0;
      for (const ledger of state.ledgers) {
        totalIncome += ledger.income_total || 0;
        totalExpense += ledger.expense_total || 0;
      }

      let ledgerHtml = '';
      if (state.ledgers.length === 0) {
        ledgerHtml = '<div class="empty-state"><div class="empty-state-icon">📒</div><p>还没有账本</p><p>点击上方按钮创建您的第一个账本</p></div>';
      } else {
        ledgerHtml = '<div class="ledger-list">' + state.ledgers.map(function(ledger) {
          const escapedName = (ledger.ledger_name || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          const escapedId = ledger.ledger_id.replace(/"/g, '&quot;');
          const txCount = ledger.transaction_count || 0;
          const balance = (ledger.income_total || 0) - (ledger.expense_total || 0);
          const currency = ledger.currency || 'CNY';
          return '<div class="ledger-item" data-id="' + escapedId + '"><div class="ledger-info" onclick="showLedgerDetail(this.closest(&apos;[data-id]&apos;).dataset.id)"><h3>' + escapedName + ' (ID:' + escapedId + ')</h3><p>币种：' + currency + '</p><p>笔数：' + txCount + '</p><p class="ledger-balance">余额：' + formatMoney(balance) + '</p></div><div class="ledger-actions" style="display: flex; gap: 8px;"><button class="tx-action-btn" onclick="event.stopPropagation(); showEditLedgerModal(this.closest(&apos;[data-id]&apos;).dataset.id)">编辑</button><button class="tx-action-btn delete" onclick="event.stopPropagation(); deleteLedger(this.closest(&apos;[data-id]&apos;).dataset.id)">删除</button></div></div>';
        }).join('') + '</div>';
      }

      container.innerHTML = '<div class="page active"><div class="page-header"><h2>我的账本</h2><button class="btn btn-primary" onclick="showCreateLedgerModal()">+ 新建账本</button></div><div class="stats-grid"><div class="stat-card"><div class="stat-label">账本数量</div><div class="stat-value">' + state.ledgers.length + '</div></div><div class="stat-card"><div class="stat-label">总收入</div><div class="stat-value income">' + formatMoney(totalIncome) + '</div></div><div class="stat-card"><div class="stat-label">总支出</div><div class="stat-value expense">' + formatMoney(totalExpense) + '</div></div><div class="stat-card"><div class="stat-label">总余额</div><div class="stat-value ' + ((totalIncome - totalExpense) >= 0 ? 'income' : 'expense') + '">' + formatMoney(totalIncome - totalExpense) + '</div></div></div>' + ledgerHtml + '</div>';
    }

    async function renderTransactionsPage(container) {
      const ledgerOptions = state.ledgers.map(l => {
        const name = (l.ledger_name || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const id = (l.ledger_id || '').replace(/"/g, '&quot;');
        return '<option value="' + id + '">' + name + '</option>';
      }).join('');
      container.innerHTML = '<div class="page active"><div class="page-header"><h2>交易记录</h2><button class="btn btn-primary" onclick="openCreateTxModal()">+ 记一笔</button></div><div class="card"><div class="filter-bar"><select id="txLedgerFilter" onchange="loadTransactions()"><option value="">全部账本</option>' + ledgerOptions + '</select><select id="txTypeFilter" onchange="loadTransactions()"><option value="">全部类型</option><option value="expense">支出</option><option value="income">收入</option></select><input type="date" id="txDateFilter" onchange="loadTransactions()" placeholder="日期"></div><div id="txListContainer"></div></div></div>';
      
      await loadTransactions();
    }

    async function loadTransactions() {
      const container = document.getElementById('txListContainer');
      if (!container) return;
      
      container.innerHTML = '<div class="loading"><div class="spinner"></div>加载中...</div>';
      
      try {
        const ledgerId = document.getElementById('txLedgerFilter')?.value;
        const txType = document.getElementById('txTypeFilter')?.value;
        const date = document.getElementById('txDateFilter')?.value;
        
        let url = '/api/v1/read/workspace/transactions?limit=50';
        if (ledgerId) url += '&ledger_id=' + ledgerId;
        if (txType) url += '&tx_type=' + txType;
        if (date) url += '&start_at=' + date + '&end_at=' + date;
        
        let txs = await api(url);
        if (txs && txs.items) {
          txs = txs.items;
        } else if (!Array.isArray(txs)) {
          txs = [];
        }
        
        if (txs.length === 0) {
          container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📝</div><p>暂无交易记录</p></div>';
        } else {
          container.innerHTML = '<div class="transaction-list">' + txs.map(function(tx) {
            const txId = String(tx.id || '').replace(/"/g, '&quot;');
            const note = (tx.note || tx.category_name || '未分类').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const ledgerName = (tx.ledger_name || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const dateStr = formatDate(tx.happened_at);
            const amount = formatMoney(tx.amount);
            return '<div class="transaction-item" data-id="' + txId + '"><div class="transaction-icon ' + tx.tx_type + '">' + (tx.tx_type === 'income' ? '📈' : '📉') + '</div><div class="transaction-info"><h4>' + note + '</h4><p>' + (ledgerName ? ledgerName + ' · ' : '') + dateStr + '</p></div><div class="transaction-amount ' + tx.tx_type + '">' + (tx.tx_type === 'income' ? '+' : '-') + amount + '</div><div class="transaction-actions"><button class="tx-action-btn" onclick="editTransaction(this.closest(&apos;[data-id]&apos;).dataset.id)">编辑</button><button class="tx-action-btn delete" onclick="deleteTransaction(this.closest(&apos;[data-id]&apos;).dataset.id)">删除</button></div></div>';
          }).join('') + '</div>';
        }
      } catch (err) {
        container.innerHTML = '<p style="color: var(--error);">加载失败: ' + err.message + '</p>';
      }
    }

    async function renderCategoriesPage(container) {
      try {
        state.categories = await api('/api/v1/read/workspace/categories') || [];
      } catch (err) {
        state.categories = [];
      }
      
      const hasParentCategories = state.categories.some(c => c.level === 2 && c.parent_name);
      
      const catItemHtml = function(c, showDelete = true) {
        const name = (c.name || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const syncId = (c.id || c.sync_id || '').replace(/"/g, '&quot;');
        const indentStyle = c.level === 2 ? 'padding-left: 24px; border-left: 2px solid var(--border); margin-left: 8px;' : '';
        const deleteBtn = showDelete ? '<button class="tx-action-btn" onclick="showEditCategoryModal(this.closest(&apos;[data-id]&apos;).dataset.id)">编辑</button><button class="tx-action-btn delete" onclick="showDeleteCategoryModal(this.closest(&apos;[data-id]&apos;).dataset.id)">删除</button>' : '';
        return '<div class="category-item" data-id="' + syncId + '" style="' + indentStyle + '"><span class="category-icon">' + (c.icon || '📁') + '</span><span>' + name + '</span><div class="tag-actions" style="margin-left: auto; display: flex; gap: 4px;">' + deleteBtn + '</div></div>';
      };
      
      if (hasParentCategories) {
        const renderCategoryGroup = function(cats, title) {
          const grouped = {};
          cats.forEach(function(c) {
            if (c.level === 2 && c.parent_name) {
              if (!grouped[c.parent_name]) {
                grouped[c.parent_name] = { parent: null, children: [] };
              }
              grouped[c.parent_name].children.push(c);
            } else if (c.level === 1) {
              if (!grouped[c.name]) {
                grouped[c.name] = { parent: c, children: [] };
              } else {
                grouped[c.name].parent = c;
              }
            }
          });
          
          let html = '<div class="card"><h4 class="section-title">' + title + '</h4>';
          const entries = Object.entries(grouped).sort(function(a, b) {
            return (a[1].parent?.sort_order || 999) - (b[1].parent?.sort_order || 999);
          });
          
          entries.forEach(function(entry) {
            const parentName = entry[0];
            const data = entry[1];
            if (data.parent) {
              html += '<div style="margin-bottom: 12px;"><div style="font-weight: 600; color: var(--primary); margin-bottom: 6px;">' + catItemHtml(data.parent, false) + '</div>';
              if (data.children.length > 0) {
                data.children.forEach(function(child) {
                  html += catItemHtml(child);
                });
              }
              html += '</div>';
            }
          });
          
          html += '</div>';
          return html;
        };
        
        const expenseCats = state.categories.filter(c => c.kind === 'expense');
        const incomeCats = state.categories.filter(c => c.kind === 'income');
        
        container.innerHTML = '<div class="page active"><div class="page-header"><h2>分类管理</h2><button class="btn btn-primary" onclick="showModal(\'createCategoryModal\')">+ 新建分类</button></div>' + renderCategoryGroup(expenseCats, '支出分类') + '<div style="margin-top: 16px;">' + renderCategoryGroup(incomeCats, '收入分类') + '</div></div>';
      } else {
        const expenseCats = state.categories.filter(c => c.kind === 'expense');
        const incomeCats = state.categories.filter(c => c.kind === 'income');
        
        container.innerHTML = '<div class="page active"><div class="page-header"><h2>分类管理</h2><button class="btn btn-primary" onclick="showModal(\'createCategoryModal\')">+ 新建分类</button></div><div class="card"><h4 class="section-title">支出分类</h4><div class="category-list">' + (expenseCats.length > 0 ? expenseCats.map(catItemHtml).join('') : '<p style="color: var(--text-muted);">暂无支出分类</p>') + '</div></div><div class="card" style="margin-top: 16px;"><h4 class="section-title">收入分类</h4><div class="category-list">' + (incomeCats.length > 0 ? incomeCats.map(catItemHtml).join('') : '<p style="color: var(--text-muted);">暂无收入分类</p>') + '</div></div></div>';
      }
    }
    
    async function initDefaultCategories() {
      try {
        showToast('正在初始化默认分类...');
        const result = await api('/api/v1/write/categories/init-defaults', {
          method: 'POST'
        });
        showToast('已添加 ' + (result.created_count || 0) + ' 个分类');
        loadPageData();
      } catch (err) {
        showToast('初始化失败: ' + err.message, 'error');
      }
    }
    
    async function renderAccountsPage(container) {
      try {
        state.accounts = await api('/api/v1/read/workspace/accounts') || [];
      } catch (err) {
        state.accounts = [];
      }
      
      const kindLabels = {cash: '💵 现金', bank: '🏦 银行卡', credit: '💳 信用卡', other: '📋 其他'};
      
      const accountItemHtml = function(a) {
        const name = (a.name || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const syncId = (a.id || a.sync_id || '').replace(/"/g, '&quot;');
        return '<div class="account-item" data-id="' + syncId + '"><div><span style="font-size: 1.2rem; margin-right: 8px;">' + (kindLabels[a.kind] || '📋') + '</span><strong>' + name + '</strong></div><div class="transaction-amount ' + ((a.balance || 0) >= 0 ? 'income' : 'expense') + '">' + formatMoney(a.balance || 0) + '</div><div class="tag-actions" style="display: flex; gap: 4px;"><button class="tx-action-btn" onclick="showEditAccountModal(this.closest(&apos;[data-id]&apos;).dataset.id)">编辑</button><button class="tx-action-btn delete" onclick="showDeleteAccountModal(this.closest(&apos;[data-id]&apos;).dataset.id)">删除</button></div></div>';
      };
      
      container.innerHTML = '<div class="page active"><div class="page-header"><h2>账户管理</h2><button class="btn btn-primary" onclick="showModal(&apos;createAccountModal&apos;)">+ 新建账户</button></div><div class="stats-grid" style="margin-bottom: 20px;"><div class="stat-card"><div class="stat-label">账户数量</div><div class="stat-value">' + state.accounts.length + '</div></div><div class="stat-card"><div class="stat-label">总余额</div><div class="stat-value">' + formatMoney(state.accounts.reduce((sum, a) => sum + (a.balance || 0), 0)) + '</div></div></div><div class="card"><div class="account-list">' + (state.accounts.length > 0 ? state.accounts.map(accountItemHtml).join('') : '<p style="color: var(--text-muted);">暂无账户</p>') + '</div></div></div>';
    }

    async function renderStatsPage(container) {
      const now = new Date();
      const currentMonth = now.getMonth();
      const currentYear = now.getFullYear();
      
      const allTxs = [];
      const categoryStats = {};
      
      for (const ledger of state.ledgers) {
        try {
          const txs = await api('/api/v1/read/ledgers/' + ledger.ledger_id + '/transactions?limit=500');
          if (Array.isArray(txs)) {
            for (const tx of txs) {
              const txDate = new Date(tx.happened_at);
              if (txDate.getMonth() === currentMonth && txDate.getFullYear() === currentYear) {
                allTxs.push(tx);
                const catName = tx.category_name || '未分类';
                if (!categoryStats[catName]) {
                  categoryStats[catName] = { income: 0, expense: 0 };
                }
                categoryStats[catName][tx.tx_type] += tx.amount;
              }
            }
          }
        } catch (e) {}
      }
      
      const monthlyIncome = allTxs.filter(t => t.tx_type === 'income').reduce((sum, t) => sum + t.amount, 0);
      const monthlyExpense = allTxs.filter(t => t.tx_type === 'expense').reduce((sum, t) => sum + t.amount, 0);
      
      const sortedExpenseCats = Object.entries(categoryStats)
        .filter(([_, stats]) => stats.expense > 0)
        .sort((a, b) => b[1].expense - a[1].expense)
        .slice(0, 5);
      
      const maxExpense = sortedExpenseCats.length > 0 ? sortedExpenseCats[0][1].expense : 1;
      
      container.innerHTML = '<div class="page active"><div class="page-header"><h2>统计分析</h2></div><div class="stats-grid"><div class="stat-card"><div class="stat-label">本月收入</div><div class="stat-value income">' + formatMoney(monthlyIncome) + '</div></div><div class="stat-card"><div class="stat-label">本月支出</div><div class="stat-value expense">' + formatMoney(monthlyExpense) + '</div></div><div class="stat-card"><div class="stat-label">本月结余</div><div class="stat-value ' + ((monthlyIncome - monthlyExpense) >= 0 ? 'income' : 'expense') + '">' + formatMoney(monthlyIncome - monthlyExpense) + '</div></div><div class="stat-card"><div class="stat-label">交易笔数</div><div class="stat-value">' + allTxs.length + '</div></div></div><div class="chart-container"><h4 class="chart-title">支出排行 TOP 5</h4><div class="bar-chart">' + (sortedExpenseCats.length > 0 ? sortedExpenseCats.map(([name, stats]) => '<div class="bar-item"><div class="bar-label">' + name + '</div><div class="bar-track"><div class="bar-fill expense" style="width: ' + Math.max(5, (stats.expense / maxExpense) * 100) + '%">' + formatMoney(stats.expense) + '</div></div></div>').join('') : '<p style="color: var(--text-muted);">本月暂无支出记录</p>') + '</div></div></div>';
    }

    async function renderTagsPage(container) {
      try {
        state.tags = await api('/api/v1/read/workspace/tags') || [];
      } catch (err) {
        state.tags = [];
      }

      const tagItemHtml = function(t) {
        const name = (t.name || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const syncId = (t.id || t.sync_id || '').replace(/"/g, '&quot;');
        return '<div class="tag-item" data-id="' + syncId + '"><span class="tag-name">' + name + '</span><div class="tag-actions"><button class="tx-action-btn" onclick="editTag(this.closest(&apos;[data-id]&apos;).dataset.id)">编辑</button><button class="tx-action-btn delete" onclick="deleteTag(this.closest(&apos;[data-id]&apos;).dataset.id)">删除</button></div></div>';
      };

      container.innerHTML = '<div class="page active"><div class="page-header"><h2>标签管理</h2><button class="btn btn-primary" onclick="showModal(&apos;createTagModal&apos;)">+ 新建标签</button></div><div class="card"><div class="tag-list">' + (state.tags.length > 0 ? state.tags.map(tagItemHtml).join('') : '<p style="color: var(--text-muted);">暂无标签</p>') + '</div></div></div>';
    }

    function showEditTagModal(syncId) {
      const tag = state.tags.find(t => (t.id || t.sync_id) === syncId);
      if (!tag) return;
      document.getElementById('editTagForm').tag_sync_id.value = syncId;
      document.getElementById('editTagForm').name.value = tag.name;
      showModal('editTagModal');
    }

    async function editTag(syncId) {
      showEditTagModal(syncId);
    }

    function showDeleteTagModal(syncId) {
      document.getElementById('deleteTagForm').tag_sync_id.value = syncId;
      showModal('deleteTagModal');
    }

    async function deleteTag(syncId) {
      showDeleteTagModal(syncId);
    }

    async function renderBudgetsPage(container) {
      try {
        const budgets = await api('/api/v1/read/workspace/budgets') || [];
        const categories = await api('/api/v1/read/workspace/categories') || [];
        state.budgets = budgets;
        state.categories = categories;
        const now = new Date();
        const currentMonth = now.toISOString().slice(0, 7);

        const budgetItemHtml = function(b) {
          const catName = (categories.find(c => c.id === b.category_id)?.name || b.category_name || '未分类').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          const budgetId = String(b.id || '').replace(/"/g, '&quot;');
          const period = (b.period || currentMonth).replace(/</g, '&lt;').replace(/>/g, '&gt;');
          const spent = formatMoney(b.spent || 0);
          const amount = formatMoney(b.amount);
          const progressWidth = Math.min(100, (b.spent || 0) / b.amount * 100);
          return '<div class="budget-item" data-id="' + budgetId + '"><div class="budget-info"><span class="budget-category">' + catName + '</span><span class="budget-period">' + period + '</span></div><div class="budget-amount"><div class="budget-progress"><div class="progress-bar" style="width: ' + progressWidth + '%"></div></div><span>' + spent + ' / ' + amount + '</span></div><div class="budget-actions"><button class="tx-action-btn" onclick="editBudget(this.closest(&apos;[data-id]&apos;).dataset.id)">编辑</button><button class="tx-action-btn delete" onclick="deleteBudget(this.closest(&apos;[data-id]&apos;).dataset.id)">删除</button></div></div>';
        };
        
        container.innerHTML = '<div class="page active"><div class="page-header"><h2>预算管理</h2><button class="btn btn-primary" onclick="openCreateBudgetModal()">+ 设置预算</button></div><div class="card"><div class="budget-list">' + (budgets.length > 0 ? budgets.map(budgetItemHtml).join('') : '<p style="color: var(--text-muted);">暂无预算设置</p>') + '</div></div></div>';
      } catch (err) {
        container.innerHTML = '<div class="page active"><div class="page-header"><h2>预算管理</h2><button class="btn btn-primary" onclick="openCreateBudgetModal()">+ 设置预算</button></div><div class="card"><p style="color: var(--text-muted);">暂无预算设置</p></div></div>';
      }
    }

    function openCreateBudgetModal() {
      const categorySelect = document.getElementById('budgetCategorySelect');
      if (categorySelect && state.categories) {
        const catOptions = state.categories.map(c => {
          const name = (c.name || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          return '<option value="' + c.id + '">' + name + '</option>';
        }).join('');
        categorySelect.innerHTML = '<option value="">选择分类</option>' + catOptions + '<option value="other">其他</option>';
      }
      showModal('createBudgetModal');
    }

    function showEditBudgetModal(budgetId) {
      const budgets = state.budgets || [];
      const budget = budgets.find(b => b.id === budgetId);
      if (!budget) return;
      const categories = state.categories || [];
      const catOptions = categories.map(c => {
        const name = (c.name || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return '<option value="' + c.id + '">' + name + '</option>';
      }).join('');
      document.getElementById('editBudgetForm').budget_sync_id.value = budgetId;
      document.getElementById('editBudgetCategorySelect').innerHTML = '<option value="">选择分类</option>' + catOptions + '<option value="other">其他</option>';
      document.getElementById('editBudgetForm').category_id.value = budget.category_id || '';
      document.getElementById('editBudgetForm').amount.value = budget.amount || 0;
      showModal('editBudgetModal');
    }

    async function editBudget(budgetId) {
      showEditBudgetModal(budgetId);
    }

    function showDeleteBudgetModal(budgetId) {
      document.getElementById('deleteBudgetForm').budget_sync_id.value = budgetId;
      showModal('deleteBudgetModal');
    }

    async function deleteBudget(budgetId) {
      showDeleteBudgetModal(budgetId);
    }

    async function renderBackupPage(container) {
      container.innerHTML = '<div class="page active"><div class="page-header"><h2>备份与恢复</h2></div><div class="card"><h4>导出备份</h4><p style="color: var(--text-muted); margin-bottom: 16px;">将您的所有数据导出为 JSON 文件</p><button class="btn btn-primary" onclick="exportBackup()">📤 导出数据</button></div><div class="card" style="margin-top: 16px;"><h4>导入数据</h4><p style="color: var(--text-muted); margin-bottom: 16px;">从 JSON、CSV、Excel 文件导入交易记录</p><button class="btn btn-secondary" onclick="showImportModal()">📥 导入数据</button></div><div class="card" style="margin-top: 16px;"><h4>危险操作</h4><p style="color: var(--text-muted); margin-bottom: 16px;">此操作不可恢复</p><button class="btn btn-danger" onclick="clearAllData()">🗑️ 清空所有数据</button></div></div>';
    }

    async function renderDebugPage(container) {
      container.innerHTML = '<div class="page active"><div class="page-header"><h2>调试工具</h2></div><div class="card"><h4>数据库数据查看</h4><p style="color: var(--text-muted); margin-bottom: 16px;">点击下方按钮查看数据库中的原始数据</p></div><div id="debugActions"></div><div id="debugOutput" style="background: #1e1e1e; color: #d4d4d4; padding: 16px; border-radius: 8px; font-family: monospace; font-size: 12px; max-height: 600px; overflow: auto; white-space: pre-wrap;"></div><div class="card" style="margin-top: 24px;"><h4>S3 配置管理</h4><p style="color: var(--text-muted); margin-bottom: 16px;">配置 S3 存储以用于附件上传</p><div id="s3ConfigStatus" style="margin-bottom: 16px;"></div><button class="btn btn-primary" style="margin-bottom: 16px;" onclick="loadS3Config()">刷新 S3 配置</button><div id="s3ConfigForm" style="margin-top: 16px;"></div></div><div class="card" style="margin-top: 24px;"><h4>附件上传测试</h4><p style="color: var(--text-muted); margin-bottom: 16px;">测试附件上传功能</p><div id="attachmentUploadStatus"></div><input type="file" id="attachmentFileInput" accept="image/*" style="margin-bottom: 16px;"><select id="attachmentLedgerSelect" style="margin-bottom: 16px; padding: 8px; border: 1px solid var(--border); border-radius: 4px; width: 100%;"><option value="">选择账本</option></select><button class="btn btn-primary" onclick="testUploadAttachment()">上传附件</button></div></div>';
      
      const actions = document.getElementById('debugActions');
      const btn1 = document.createElement('button');
      btn1.className = 'btn btn-primary';
      btn1.textContent = '查看账本';
      btn1.onclick = function() { loadDebugData('ledgers'); };
      actions.appendChild(btn1);
      
      const btn2 = document.createElement('button');
      btn2.className = 'btn btn-primary';
      btn2.textContent = '查看交易';
      btn2.onclick = function() { loadDebugData('transactions'); };
      actions.appendChild(btn2);
      
      const btn3 = document.createElement('button');
      btn3.className = 'btn btn-primary';
      btn3.textContent = '查看同步变更';
      btn3.onclick = function() { loadDebugData('sync-changes'); };
      actions.appendChild(btn3);
      
      actions.style.cssText = 'display: flex; gap: 10px; margin-bottom: 16px;';
      
      // 加载 S3 配置
      await loadS3Config();
      
      // 加载账本列表到选择框
      loadLedgerSelectForAttachment();
    }
    
    async function loadLedgerSelectForAttachment() {
      const select = document.getElementById('attachmentLedgerSelect');
      if (!select) return;
      
      try {
        const ledgers = await api('/api/v1/read/ledgers') || [];
        ledgers.forEach(ledger => {
          const option = document.createElement('option');
          option.value = ledger.ledger_id || '';
          option.textContent = (ledger.ledger_name || '') + ' (' + (ledger.ledger_id || '') + ')';
          select.appendChild(option);
        });
      } catch (err) {
        console.error('Failed to load ledgers:', err);
      }
    }
    
    async function testUploadAttachment() {
      const fileInput = document.getElementById('attachmentFileInput');
      const ledgerSelect = document.getElementById('attachmentLedgerSelect');
      const statusDiv = document.getElementById('attachmentUploadStatus');
      
      if (!fileInput.files || !fileInput.files[0]) {
        statusDiv.innerHTML = '<p style="color: var(--error);">请选择文件</p>';
        return;
      }
      
      if (!ledgerSelect.value) {
        statusDiv.innerHTML = '<p style="color: var(--error);">请选择账本</p>';
        return;
      }
      
      statusDiv.innerHTML = '<p>正在上传...</p>';
      
      try {
        const formData = new FormData();
        formData.append('file', fileInput.files[0]);
        formData.append('ledger_id', ledgerSelect.value);
        formData.append('file_name', fileInput.files[0].name);
        
        const result = await api('/attachments', {
          method: 'POST',
          body: formData,
          headers: {} // 不设置 Content-Type，让浏览器自动设置
        });
        
        statusDiv.innerHTML = '<p style="color: var(--success);">上传成功！<br>File ID: ' + (result.file_id || '') + '<br>SHA256: ' + (result.sha256 || '') + '<br>Size: ' + (result.size || 0) + ' bytes</p>';
      } catch (err) {
        statusDiv.innerHTML = '<p style="color: var(--error);">上传失败: ' + (err.message || err) + '</p>';
      }
    }

    async function loadDebugData(type) {
      const output = document.getElementById('debugOutput');
      if (!output) {
        alert('Debug element not found');
        return;
      }
      output.textContent = '加载中...';
      
      try {
        let url;
        if (type === 'ledgers') {
          url = '/api/v1/read/debug/ledgers';
        } else if (type === 'transactions') {
          url = '/api/v1/read/debug/transactions';
        } else if (type === 'sync-changes') {
          url = '/api/v1/read/debug/sync-changes';
        }
        
        const data = await api(url);
        output.textContent = JSON.stringify(data);
      } catch(err) {
        output.textContent = 'Error: ' + (err.message || 'unknown');
      }
    }

    async function loadS3Config() {
      const statusDiv = document.getElementById('s3ConfigStatus');
      const formDiv = document.getElementById('s3ConfigForm');
      
      if (!statusDiv || !formDiv) return;
      
      statusDiv.innerHTML = '<p>正在加载 S3 配置...</p>';
      
      try {
        const configs = await api('/api/v1/sys-config/s3') || [];
        renderS3Configs(configs, formDiv);
        statusDiv.innerHTML = '<p style="color: var(--success);">加载成功！</p>';
      } catch (err) {
        statusDiv.innerHTML = '<p style="color: var(--error);">加载失败: ' + (err.message || err) + '</p>';
        renderS3Form(formDiv, null);
      }
    }

    function renderS3Configs(configs, container) {
      let html = '';
      
      configs.forEach(config => {
        const isEnabled = config.enabled;
        html += '<div class="card" style="margin-bottom: 16px; padding: 16px; border: ' + (isEnabled ? '2px solid var(--success)' : '1px solid var(--border)') + ';">' +
          '<h4 style="margin-bottom: 8px;">' + (config.name || 'S3 配置') + ' ' + (isEnabled ? '🟢' : '🔴') + '</h4>' +
          '<p style="margin-bottom: 8px; font-size: 14px; color: var(--text-muted);">Endpoint: ' + (config.endpoint || '') + '</p>' +
          '<p style="margin-bottom: 8px; font-size: 14px; color: var(--text-muted);">Bucket: ' + (config.bucket_name || '') + '</p>' +
          '<div style="margin-top: 12px; display: flex; gap: 8px;">' +
          '<button class="btn btn-primary" onclick="toggleS3Config(' + config.id + ')">' + (isEnabled ? '禁用' : '启用') + '</button>' +
          '<button class="btn btn-secondary" onclick="editS3Config(' + config.id + ')">编辑</button>' +
          '<button class="btn btn-danger" onclick="deleteS3Config(' + config.id + ')">删除</button>' +
          '</div>' +
          '</div>';
      });
      
      container.innerHTML = html;
      
      const addBtn = document.createElement('button');
      addBtn.className = 'btn btn-success';
      addBtn.style.marginTop = '16px';
      addBtn.textContent = '+ 添加新的 S3 配置';
      addBtn.onclick = function() { renderS3Form(document.getElementById('s3ConfigForm'), null); };
      container.appendChild(addBtn);
    }

    function renderS3Form(container, config) {
      const isEdit = config !== null;
      const title = isEdit ? '编辑 S3 配置' : '添加 S3 配置';
      
      // 将 camelCase 转换为 snake_case 用于表单
      const formConfig = config ? {
        ...config,
        bucket_name: config.bucketName,
        access_key_id: config.accessKeyId,
        secret_access_key: config.secretAccessKey,
        path_style: config.pathStyle,
        cdn_domain: config.cdnDomain,
        save_path: config.savePath
      } : null;
      
      container.innerHTML = '<div class="card" style="padding: 16px;">' +
        '<h4 style="margin-bottom: 16px;">' + title + '</h4>' +
        '<form id="s3ConfigFormInner">' +
        (isEdit ? '<input type="hidden" name="id" value="' + formConfig.id + '">' : '') +
        '<div class="form-group">' +
        '<label>配置名称</label>' +
        '<input type="text" name="name" placeholder="例如：我的 S3 存储" required ' + (isEdit && formConfig.name ? 'value="' + formConfig.name.replace(/"/g, '&quot;') + '"' : '') + '>' +
        '</div>' +
        '<div class="form-group">' +
        '<label>Endpoint</label>' +
        '<input type="text" name="endpoint" placeholder="例如：https://s3.amazonaws.com" required ' + (isEdit && formConfig.endpoint ? 'value="' + formConfig.endpoint.replace(/"/g, '&quot;') + '"' : '') + '>' +
        '</div>' +
        '<div class="form-group">' +
        '<label>Region</label>' +
        '<input type="text" name="region" placeholder="例如：us-east-1" ' + (isEdit && formConfig.region ? 'value="' + formConfig.region.replace(/"/g, '&quot;') + '"' : '') + '>' +
        '</div>' +
        '<div class="form-group">' +
        '<label>Bucket Name</label>' +
        '<input type="text" name="bucket_name" placeholder="例如：my-bucket" required ' + (isEdit && formConfig.bucket_name ? 'value="' + formConfig.bucket_name.replace(/"/g, '&quot;') + '"' : '') + '>' +
        '</div>' +
        '<div class="form-group">' +
        '<label>Access Key ID</label>' +
        '<input type="text" name="access_key_id" placeholder="Access Key ID" required ' + (isEdit && formConfig.access_key_id ? 'value="' + formConfig.access_key_id.replace(/"/g, '&quot;') + '"' : '') + '>' +
        '</div>' +
        '<div class="form-group">' +
        '<label>Secret Access Key</label>' +
        '<input type="password" name="secret_access_key" placeholder="Secret Access Key" required>' +
        (isEdit ? '<small style="color: var(--text-muted);">留空表示不修改</small>' : '') +
        '</div>' +
        '<div class="form-group">' +
        '<label>路径风格</label>' +
        '<select name="path_style">' +
        '<option value="true" ' + (isEdit && formConfig.path_style ? 'selected' : '') + '>启用</option>' +
        '<option value="false" ' + (isEdit && !formConfig.path_style ? 'selected' : '') + '>禁用</option>' +
        '</select>' +
        '</div>' +
        '<div class="form-group">' +
        '<label>CDN 域名（可选）</label>' +
        '<input type="text" name="cdn_domain" placeholder="例如：https://cdn.example.com" ' + (isEdit && formConfig.cdn_domain ? 'value="' + formConfig.cdn_domain.replace(/"/g, '&quot;') + '"' : '') + '>' +
        '</div>' +
        '<div class="form-group">' +
        '<label>保存路径（可选）</label>' +
        '<input type="text" name="save_path" placeholder="例如：/attachments" ' + (isEdit && formConfig.save_path ? 'value="' + formConfig.save_path.replace(/"/g, '&quot;') + '"' : '') + '>' +
        '</div>' +
        '<div style="display: flex; gap: 8px;">' +
        '<button type="submit" class="btn btn-primary">' + (isEdit ? '保存修改' : '添加配置') + '</button>' +
        '<button type="button" class="btn btn-secondary" onclick="loadS3Config()">取消</button>' +
        '</div>' +
        '</form>' +
        '</div>';
      
      // 绑定表单事件
      const form = document.getElementById('s3ConfigFormInner');
      if (form) {
        form.addEventListener('submit', async function(e) {
          e.preventDefault();
          const formData = new FormData(e.target);
          const data = {};
          formData.forEach((value, key) => {
            data[key] = value;
          });
          
          // 转换布尔值
          if (data.path_style) {
            data.path_style = data.path_style === 'true';
          }
          
          const statusDiv = document.getElementById('s3ConfigStatus');
          statusDiv.innerHTML = '<p>正在保存...</p>';
          
          try {
            let result;
            if (isEdit) {
              result = await api('/api/v1/sys-config/s3/' + data.id, {
                method: 'PUT',
                body: JSON.stringify(data)
              });
            } else {
              result = await api('/api/v1/sys-config/s3', {
                method: 'POST',
                body: JSON.stringify(data)
              });
            }
            
            statusDiv.innerHTML = '<p style="color: var(--success);">保存成功！</p>';
            await loadS3Config();
          } catch (err) {
            statusDiv.innerHTML = '<p style="color: var(--error);">保存失败: ' + (err.message || err) + '</p>';
          }
        });
      }
    }

    async function editS3Config(configId) {
      try {
        const configs = await api('/api/v1/sys-config/s3') || [];
        const config = configs.find(c => c.id === configId);
        if (config) {
          const formDiv = document.getElementById('s3ConfigForm');
          renderS3Form(formDiv, config);
        }
      } catch (err) {
        alert('获取配置失败: ' + (err.message || err));
      }
    }

    async function toggleS3Config(configId) {
      try {
        await api('/api/v1/sys-config/s3/' + configId + '/toggle', {
          method: 'POST'
        });
        await loadS3Config();
      } catch (err) {
        alert('切换状态失败: ' + (err.message || err));
      }
    }

    async function deleteS3Config(configId) {
      if (!confirm('确定要删除这个配置吗？')) return;
      
      try {
        await api('/api/v1/sys-config/s3/' + configId, {
          method: 'DELETE'
        });
        await loadS3Config();
      } catch (err) {
        alert('删除失败: ' + (err.message || err));
      }
    }

    async function exportBackup() {
      try {
        console.log('Starting backup export...');
        const ledgers = await api('/api/v1/read/ledgers') || [];
        console.log('Got ledgers:', ledgers);
        
        const txResult = await api('/api/v1/read/workspace/transactions?limit=2000') || { items: [] };
        console.log('Got txResult:', txResult);
        
        const catResult = await api('/api/v1/read/workspace/categories') || { items: [] };
        console.log('Got catResult:', catResult);
        
        const accResult = await api('/api/v1/read/workspace/accounts') || { items: [] };
        console.log('Got accResult:', accResult);
        
        const tagResult = await api('/api/v1/read/workspace/tags') || { items: [] };
        console.log('Got tagResult:', tagResult);
        
        const budgetResult = await api('/api/v1/read/workspace/budgets') || { items: [] };
        console.log('Got budgetResult:', budgetResult);

        const transactions = Array.isArray(txResult) ? txResult : txResult.items || [];
        const categories = Array.isArray(catResult) ? catResult : catResult.items || [];
        const accounts = Array.isArray(accResult) ? accResult : accResult.items || [];
        const tags = Array.isArray(tagResult) ? tagResult : tagResult.items || [];
        const budgets = Array.isArray(budgetResult) ? budgetResult : budgetResult.items || [];
        
        console.log('Processed - tx:', transactions.length, 'cat:', categories.length, 'acc:', accounts.length, 'tags:', tags.length, 'budgets:', budgets.length);

        const backup = {
          version: '1.0',
          exportTime: new Date().toISOString(),
          data: {
            ledgers,
            transactions,
            categories,
            accounts,
            tags,
            budgets
          }
        };
        
        console.log('Final backup data:', backup);

        const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'beecount-backup-' + new Date().toISOString().slice(0, 10) + '.json';
        a.click();
        URL.revokeObjectURL(url);
        showToast('备份导出成功');
      } catch (err) {
        console.error('Export error:', err);
        showToast('导出失败: ' + err.message, 'error');
      }
    }



    function showImportModal() {
      const ledgerSelect = document.getElementById('importLedgerSelect');
      if (ledgerSelect) {
        ledgerSelect.innerHTML = '<option value="">选择账本</option>' + state.ledgers.map(l => '<option value="' + (l.ledger_id || '').replace(/"/g, '&quot;') + '">' + (l.ledger_name || '').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</option>').join('');
      }
      document.getElementById('importStep1').style.display = 'block';
      document.getElementById('importProgress').style.display = 'none';
      document.getElementById('importFileInput').value = '';
      document.getElementById('importPreview').innerHTML = '';
      showModal('importModal');
    }

    let importedData = [];

    function parseCSV(text) {
      const lines = text.split(new RegExp('\\r?\\n')).filter(line => line.trim());
      if (lines.length === 0) return [];
      const headers = parseCSVLine(lines[0]);
      const data = [];
      for (let i = 1; i < lines.length; i++) {
        const values = parseCSVLine(lines[i]);
        const row = {};
        headers.forEach((h, idx) => {
          row[h.trim()] = values[idx] || '';
        });
        data.push(row);
      }
      return data;
    }

    function parseCSVLine(line) {
      const result = [];
      let current = '';
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
          if (inQuotes && line[i + 1] === '"') {
            current += '"';
            i++;
          } else {
            inQuotes = !inQuotes;
          }
        } else if (char === ',' && !inQuotes) {
          result.push(current);
          current = '';
        } else {
          current += char;
        }
      }
      result.push(current);
      return result;
    }

    async function startImport() {
      const ledgerId = document.getElementById('importLedgerSelect').value;
      
      document.getElementById('importStep1').style.display = 'none';
      document.getElementById('importProgress').style.display = 'block';
      
      let successCount = 0;
      let failCount = 0;
      let skipCount = 0;
      
      const fileInput = document.getElementById('importFileInput');
      const file = fileInput.files[0];
      const fileName = file.name.toLowerCase();
      
      console.log('Starting import...', fileName);
      
      try {
        const reader = new FileReader();
        const fileContent = await new Promise((resolve, reject) => {
          reader.onload = e => resolve(e.target.result);
          reader.onerror = e => reject(e);
          reader.readAsText(file);
        });
        
        console.log('File loaded, content length:', fileContent.length);
        
        let importData;
        if (fileName.endsWith('.json')) {
          importData = JSON.parse(fileContent);
        } else if (fileName.endsWith('.csv')) {
          importData = parseCSV(fileContent);
        } else {
          showToast('不支持的文件格式', 'error');
          closeModal('importModal');
          return;
        }
        
        console.log('Import data parsed:', importData);
        
        if (!importData || (Array.isArray(importData) && importData.length === 0)) {
          showToast('文件中没有数据', 'error');
          closeModal('importModal');
          return;
        }
        
        let targetLedgerId = ledgerId;
        const importedLedgerIds = [];
        
        if (fileName.endsWith('.json') && importData.version) {
          const backup = importData;
          console.log('Processing backup:', backup);
          
          if (backup.data && backup.data.ledgers) {
            console.log('Found ledgers in backup:', backup.data.ledgers.length);
            for (const ledger of backup.data.ledgers) {
              try {
                console.log('Importing ledger:', ledger);
                const result = await api('/api/v1/write/ledgers', {
                  method: 'POST',
                  body: JSON.stringify({
                    base_change_id: 0,
                    ledger_id: ledger.ledger_id || undefined,
                    ledger_name: ledger.ledger_name,
                    currency: ledger.currency || 'CNY'
                  })
                });
                successCount++;
                const importedId = result && result.ledger_id ? result.ledger_id : ledger.ledger_id;
                importedLedgerIds.push(importedId);
                targetLedgerId = importedId;
                console.log('Ledger imported, id:', importedId);
              } catch (e) {
                console.error('Import ledger error:', e);
                if (ledger.ledger_id) {
                  importedLedgerIds.push(ledger.ledger_id);
                  targetLedgerId = ledger.ledger_id;
                }
              }
            }
          }
          
          console.log('Imported ledger IDs:', importedLedgerIds);
          
          if (backup.data && backup.data.accounts && importedLedgerIds.length > 0) {
            console.log('Found accounts in backup:', backup.data.accounts.length);
            for (const account of backup.data.accounts) {
              const accountLedgerId = account.ledger_id || importedLedgerIds[0];
              try {
                await api('/api/v1/write/accounts', {
                  method: 'POST',
                  body: JSON.stringify({
                    base_change_id: 0,
                    ledger_id: accountLedgerId,
                    name: account.account_name || account.name,
                    account_type: account.kind || account.account_type || 'cash',
                    initial_balance: account.balance || 0,
                  })
                });
                successCount++;
              } catch (e) {
                console.error('Import account error:', e);
                failCount++;
              }
            }
          }
          
          if (backup.data && backup.data.categories && importedLedgerIds.length > 0) {
            console.log('Found categories in backup:', backup.data.categories.length);
            for (const cat of backup.data.categories) {
              const catLedgerId = cat.ledger_id || importedLedgerIds[0];
              try {
                await api('/api/v1/write/categories', {
                  method: 'POST',
                  body: JSON.stringify({
                    base_change_id: 0,
                    ledger_id: catLedgerId,
                    name: cat.category_name || cat.name || '未分类',
                    kind: (cat.kind === 'expense' || cat.kind === 'income' || cat.kind === 'transfer') ? cat.kind : 'expense',
                    icon: cat.icon || '📁'
                  })
                });
                successCount++;
              } catch (e) {
                console.error('Import category error:', e);
                failCount++;
              }
            }
          }
          
          if (backup.data && backup.data.tags && importedLedgerIds.length > 0) {
            console.log('Found tags in backup:', backup.data.tags.length);
            for (const tag of backup.data.tags) {
              const tagLedgerId = tag.ledger_id || importedLedgerIds[0];
              try {
                await api('/api/v1/write/tags', {
                  method: 'POST',
                  body: JSON.stringify({
                    base_change_id: 0,
                    ledger_id: tagLedgerId,
                    name: tag.tag_name || tag.name || '标签'
                  })
                });
                successCount++;
              } catch (e) {
                console.error('Import tag error:', e);
                failCount++;
              }
            }
          }
          
          if (backup.data && backup.data.transactions && backup.data.transactions.length > 0) {
            console.log('Found transactions in backup:', backup.data.transactions.length);
            if (importedLedgerIds.length === 0) {
              showToast('未找到账本，无法导入交易', 'error');
            } else {
              for (let i = 0; i < backup.data.transactions.length; i++) {
                const tx = backup.data.transactions[i];
                try {
                  const txLedgerId = tx.ledger_id || importedLedgerIds[0];
                  console.log('Importing tx', i, txLedgerId, tx);
                  
                  let amount = tx.amount;
                  if (typeof amount !== 'number') {
                    amount = parseInt(amount) || 0;
                  }
                  
                  const reqBody = {
                    base_change_id: 0,
                    ledger_id: txLedgerId,
                    tx_type: tx.tx_type || 'expense',
                    amount: amount,
                    happened_at: tx.happened_at || new Date().toISOString(),
                    note: tx.note || null,
                    category_name: tx.category_name || null,
                    account_name: tx.account_name || null
                  };
                  console.log('Sending request:', reqBody);
                  
                  const result = await api('/api/v1/write/transactions', {
                    method: 'POST',
                    body: JSON.stringify(reqBody)
                  });
                  console.log('Tx import result:', result);
                  successCount++;
                } catch (e) {
                  console.error('Import tx error:', e, 'tx:', tx);
                  failCount++;
                }
                document.getElementById('importProgressBar').style.width = Math.round((i + 1) / backup.data.transactions.length * 100) + '%';
                document.getElementById('importStatus').textContent = '导入交易: ' + (i + 1) + ' / ' + backup.data.transactions.length;
              }
            }
          } else {
            console.log('No transactions found in backup');
            if (!backup.data || !backup.data.transactions) {
              showToast('备份文件中没有交易记录');
            }
          }
          
          if (backup.data && backup.data.budgets && importedLedgerIds.length > 0) {
            console.log('Found budgets in backup:', backup.data.budgets.length);
            for (const budget of backup.data.budgets) {
              const budgetLedgerId = budget.ledger_id || importedLedgerIds[0];
              try {
                await api('/api/v1/write/budgets', {
                  method: 'POST',
                  body: JSON.stringify({
                    base_change_id: 0,
                    ledger_id: budgetLedgerId,
                    category_id: budget.category_id || '',
                    amount: budget.amount || 0,
                    period: budget.period || 'monthly'
                  })
                });
                successCount++;
              } catch (e) {
                console.error('Import budget error:', e);
                failCount++;
              }
            }
          }
        } else {
          const txData = Array.isArray(importData) ? importData : [importData];
          
          if (!targetLedgerId) {
            showToast('请先选择目标账本', 'error');
            closeModal('importModal');
            return;
          }
          
          for (let i = 0; i < txData.length; i++) {
            const row = txData[i];
            if (!row.amount && !row.金额) {
              skipCount++;
              continue;
            }
            
            try {
              let amount = parseFloat(String(row.amount || row.金额 || 0).replace(/[^\d.-]/g, ''));
              if (amount < 1000) {
                amount = Math.round(amount * 100);
              }
              
              let txType = 'expense';
              const typeStr = String(row.type || row.tx_type || row.类型 || '').toLowerCase();
              if (typeStr.includes('收入') || typeStr.includes('income')) {
                txType = 'income';
              }
              
              let happenedAt = row.date || row.happened_at || row.日期 || row.time;
              if (!happenedAt) {
                happenedAt = new Date().toISOString();
              } else {
                try {
                  const d = new Date(happenedAt);
                  if (!isNaN(d.getTime())) {
                    happenedAt = d.toISOString();
                  } else {
                    happenedAt = new Date().toISOString();
                  }
                } catch {
                  happenedAt = new Date().toISOString();
                }
              }
              
              await api('/api/v1/write/transactions', {
                method: 'POST',
                body: JSON.stringify({
                  base_change_id: 0,
                  ledger_id: targetLedgerId,
                  tx_type: txType,
                  amount: amount,
                  happened_at: happenedAt,
                  note: row.note || row.备注 || row.description || '',
                  category_name: row.category || row.分类 || ''
                })
              });
              successCount++;
            } catch (err) {
              console.error('Import CSV tx error:', err);
              failCount++;
            }
            
            document.getElementById('importProgressBar').style.width = Math.round((i + 1) / txData.length * 100) + '%';
            document.getElementById('importStatus').textContent = '导入中: ' + (i + 1) + ' / ' + txData.length;
          }
        }
        
        showToast('导入完成: 成功 ' + successCount + ' 条, 失败 ' + failCount + ' 条, 跳过 ' + skipCount + ' 条');
      } catch (err) {
        console.error('Import failed:', err);
        showToast('导入失败: ' + err.message, 'error');
      }
      
      closeModal('importModal');
      loadPageData();
    }

    async function clearAllData() {
      showModal('confirmClearDataModal');
    }

    async function confirmClearData() {
      try {
        await api('/api/v1/backup/clear-data', {
          method: 'DELETE'
        });
        closeModal('confirmClearDataModal');
        showToast('所有数据已清空（账户已保留）');
        loadPageData();
      } catch (err) {
        showToast('清空失败: ' + err.message, 'error');
      }
    }

    function showCreateLedgerModal() {
      document.getElementById('createLedgerForm').reset();
      showModal('createLedgerModal');
    }

    function showEditLedgerModal(ledgerId) {
      const ledger = state.ledgers.find(l => l.ledger_id === ledgerId);
      if (!ledger) return;
      const form = document.getElementById('editLedgerForm');
      form.querySelector('[name="ledger_id"]').value = ledgerId;
      form.querySelector('[name="name"]').value = ledger.ledger_name;
      form.querySelector('[name="currency"]').value = ledger.currency || 'CNY';
      showModal('editLedgerModal');
    }

    async function deleteLedger(ledgerId) {
      showDeleteLedgerModal(ledgerId);
    }

    function showDeleteLedgerModal(ledgerId) {
      document.getElementById('deleteLedgerForm').querySelector('[name="ledger_id"]').value = ledgerId;
      showModal('deleteLedgerModal');
    }

    function showEditCategoryModal(syncId) {
      const cat = state.categories.find(c => c.id === syncId || c.sync_id === syncId);
      if (!cat) return;
      const form = document.getElementById('editCategoryForm');
      form.querySelector('[name="category_sync_id"]').value = cat.id || cat.sync_id;
      form.querySelector('[name="name"]').value = cat.name;
      form.querySelector('[name="kind"]').value = cat.kind;
      form.querySelector('[name="icon"]').value = cat.icon || '📁';
      showModal('editCategoryModal');
    }

    function showDeleteCategoryModal(syncId) {
      const form = document.getElementById('deleteCategoryForm');
      form.querySelector('[name="category_sync_id"]').value = syncId;
      showModal('deleteCategoryModal');
    }

    function showEditAccountModal(syncId) {
      const account = state.accounts.find(a => a.id === syncId || a.sync_id === syncId);
      if (!account) return;
      const form = document.getElementById('editAccountForm');
      form.querySelector('[name="account_sync_id"]').value = account.id || account.sync_id;
      form.querySelector('[name="name"]').value = account.name;
      form.querySelector('[name="kind"]').value = account.kind || 'cash';
      form.querySelector('[name="balance"]').value = account.balance || 0;
      showModal('editAccountModal');
    }

    function showDeleteAccountModal(syncId) {
      const form = document.getElementById('deleteAccountForm');
      form.querySelector('[name="account_sync_id"]').value = syncId;
      showModal('deleteAccountModal');
    }

    function openCreateTxModal() {
      document.getElementById('createTxForm').reset();
      selectTxType('expense');
      
      const ledgerSelect = document.getElementById('txLedgerSelect');
      if (ledgerSelect) {
        ledgerSelect.innerHTML = state.ledgers.map(l => '<option value="' + l.ledger_id + '">' + l.ledger_name + '</option>').join('');
      }
      
      showModal('createTxModal');
    }

    function showModal(modalId) {
      document.getElementById(modalId).classList.add('active');
    }

    function closeModal(modalId) {
      document.getElementById(modalId).classList.remove('active');
    }

    async function showLedgerDetail(ledgerId) {
      const modal = document.getElementById('ledgerModal');
      const content = document.getElementById('ledgerModalContent');
      const ledger = state.ledgers.find(l => l.ledger_id === ledgerId);
      
      document.getElementById('ledgerModalTitle').textContent = ledger ? ledger.ledger_name : '账本详情';
      modal.classList.add('active');
      content.innerHTML = '<div class="loading"><div class="spinner"></div>加载中...</div>';
      
      try {
        const txs = await api('/api/v1/read/ledgers/' + ledgerId + '/transactions?limit=20');
        const txArray = Array.isArray(txs) ? txs : [];
        
        let txListHtml = '';
        if (txArray.length === 0) {
          txListHtml = '<p style="color: var(--text-muted); text-align: center; padding: 20px;">暂无交易记录</p>';
        } else {
          txListHtml = '<div class="transaction-list">' + txArray.map(function(tx) {
            return '<div class="transaction-item"><div class="transaction-icon ' + tx.tx_type + '">' + (tx.tx_type === 'income' ? '📈' : '📉') + '</div><div class="transaction-info"><h4>' + (tx.note || tx.category_name || '未分类') + '</h4><p>' + formatDate(tx.happened_at) + '</p></div><div class="transaction-amount ' + tx.tx_type + '">' + (tx.tx_type === 'income' ? '+' : '-') + formatMoney(tx.amount) + '</div></div>';
          }).join('') + '</div>';
        }
        
        content.innerHTML = '<div style="margin-bottom: 16px;"><button class="btn btn-primary btn-block" onclick="openCreateTxForLedger(this.dataset.ledgerId)" data-ledger-id="' + ledgerId + '">+ 记一笔</button></div>' + txListHtml + '<div style="margin-top: 16px;"><button class="btn btn-secondary btn-block" onclick="closeModal(&apos;ledgerModal&apos;)">关闭</button></div>';
      } catch (err) {
        content.innerHTML = '<p style="color: var(--error);">加载失败: ' + err.message + '</p>';
      }
    }

    function openCreateTxForLedger(ledgerId) {
      document.getElementById('createTxForm').reset();
      selectTxType('expense');
      
      const ledgerSelect = document.getElementById('txLedgerSelect');
      if (ledgerSelect) {
        ledgerSelect.innerHTML = state.ledgers.map(l => '<option value="' + l.ledger_id + '"' + (l.ledger_id === ledgerId ? ' selected' : '') + '>' + l.ledger_name + '</option>').join('');
      }
      
      closeModal('ledgerModal');
      showModal('createTxModal');
    }

    function selectTxType(type) {
      document.querySelectorAll('#createTxModal .type-btn').forEach(function(btn) { btn.classList.remove('active'); });
      document.querySelector('#createTxModal .type-btn.' + type).classList.add('active');
      document.getElementById('txTypeInput').value = type;
    }

    function setQuickAmount(amount) {
      document.querySelector('#createTxModal input[name="amount"]').value = amount;
    }

    async function editTransaction(txId) {
      try {
        let txs = await api('/api/v1/read/workspace/transactions?limit=100');
        if (txs && txs.items) {
          txs = txs.items;
        }
        const txArray = Array.isArray(txs) ? txs : [];
        const tx = txArray.find(t => t.id === txId);
        
        if (!tx) {
          showToast('未找到交易记录', 'error');
          return;
        }
        
        const form = document.getElementById('editTxForm');
        form.querySelector('[name="tx_id"]').value = txId;
        form.querySelector('[name="amount"]').value = tx.amount;
        form.querySelector('[name="category_name"]').value = tx.category_name || '';
        form.querySelector('[name="account_name"]').value = tx.account_name || '';
        form.querySelector('[name="note"]').value = tx.note || '';
        
        const ledgerSelect = document.getElementById('editTxLedgerSelect');
        if (ledgerSelect) {
          ledgerSelect.innerHTML = state.ledgers.map(l => '<option value="' + l.ledger_id + '"' + (l.ledger_id === tx.ledger_id ? ' selected' : '') + '>' + l.ledger_name + '</option>').join('');
        }
        
        selectEditTxType(tx.tx_type);
        
        showModal('editTxModal');
      } catch (err) {
        showToast(err.message, 'error');
      }
    }

    function selectEditTxType(type) {
      document.querySelectorAll('#editTxModal .type-btn').forEach(function(btn) { btn.classList.remove('active'); });
      document.querySelector('#editTxModal .type-btn.' + type).classList.add('active');
      document.getElementById('editTxTypeInput').value = type;
    }

    async function deleteTransaction(txId) {
      if (!confirm('确定要删除这条交易记录吗？')) return;
      
      try {
        await api('/api/v1/write/transactions/' + txId, { method: 'DELETE', body: JSON.stringify({ base_change_id: 0 }) });
        showToast('删除成功');
        loadPageData();
      } catch (err) {
        showToast(err.message, 'error');
      }
    }

    function logout() {
      state.token = null;
      localStorage.removeItem('token');
      showToast('已退出登录');
      render();
    }

    async function showSettingsModal() {
      const modal = document.getElementById('settingsModal');
      const content = document.getElementById('settingsContent');
      modal.classList.add('active');
      
      content.innerHTML = '<div class="loading"><div class="spinner"></div>加载中...</div>';
      
      try {
        const profile = await api('/api/v1/profile/me');
        const devices = await api('/api/v1/devices').catch(() => ({ devices: [] }));
        const twoFactorStatus = await api('/api/v1/2fa/status').catch(() => ({ enabled: false }));
        const s3Configs = await api('/api/v1/sys-config/s3').catch(() => []);
        
        content.innerHTML = '<div class="settings-nav"><button class="settings-nav-btn active" onclick="showSettingsSection(\'profile\', this)">个人资料</button><button class="settings-nav-btn" onclick="showSettingsSection(\'security\', this)">安全设置</button><button class="settings-nav-btn" onclick="showSettingsSection(\'devices\', this)">设备管理</button><button class="settings-nav-btn" onclick="showSettingsSection(\'storage\', this)">存储配置</button></div>' +
          '<div id="settingsProfileSection" class="settings-section active"><div class="card" style="margin-top: 16px;"><h4 class="section-title">个人资料</h4><form id="profileForm"><div class="form-group"><label>邮箱</label><input type="email" value="' + profile.email + '" disabled></div><div class="form-group"><label>显示名称</label><input type="text" name="display_name" value="' + (profile.display_name || '') + '" placeholder="设置您的显示名称"></div><button type="submit" class="btn btn-primary btn-block">保存</button></form></div></div>' +
          '<div id="settingsSecuritySection" class="settings-section"><div class="card" style="margin-top: 16px;"><h4 class="section-title">两步验证 (2FA)</h4><div class="two-fa-status ' + (twoFactorStatus.enabled ? 'enabled' : 'disabled') + '"><span>' + (twoFactorStatus.enabled ? '🟢 已启用' : '🔴 未启用') + '</span></div>' + (twoFactorStatus.enabled ? '<p style="color: var(--text-muted); margin-bottom: 16px;">您的账户已启用两步验证，安全性更高。</p><button class="btn btn-danger" onclick="disable2FA()">禁用 2FA</button>' : '<p style="color: var(--text-muted); margin-bottom: 16px;">启用两步验证提高账户安全性。</p><button class="btn btn-primary" onclick="setup2FA()">启用 2FA</button>') + '</div><div class="card" style="margin-top: 16px;"><h4 class="section-title">修改密码</h4><form id="passwordForm"><div class="form-group"><label>当前密码</label><input type="password" name="current_password" required></div><div class="form-group"><label>新密码</label><input type="password" name="new_password" minlength="8" required placeholder="至少8位"></div><div class="form-group"><label>确认新密码</label><input type="password" name="confirm_password" minlength="8" required></div><button type="submit" class="btn btn-primary btn-block">修改密码</button></form></div></div>' +
          '<div id="settingsDevicesSection" class="settings-section"><div class="card" style="margin-top: 16px;"><h4 class="section-title">已登录设备</h4><div class="device-list">' + (devices.devices && devices.devices.length > 0 ? devices.devices.map(d => '<div class="device-item" data-id="' + d.id + '"><div class="device-info"><span class="device-icon">💻</span><div><div class="device-name">' + (d.name || '未知设备') + '</div><div class="device-meta">' + formatDateTime(d.last_active_at || d.created_at) + '</div></div></div><button class="btn btn-danger" onclick="revokeDevice(this.closest(\'[data-id]\').dataset.id)">撤销</button></div>').join('') : '<p style="color: var(--text-muted);">暂无设备记录</p>') + '</div></div></div>' +
          '<div id="settingsStorageSection" class="settings-section"><div class="card" style="margin-top: 16px;"><h4 class="section-title">S3 存储配置</h4><p style="color: var(--text-muted); margin-bottom: 16px;">配置 S3 兼容存储（AWS S3、MinIO、Cloudflare R2 等）用于存储附件和图片。</p><div id="s3ConfigList" style="margin-bottom: 16px;">' + (Array.isArray(s3Configs) && s3Configs.length > 0 ? s3Configs.map(cfg => '<div style="padding: 12px; background: var(--background); border-radius: 8px; margin-bottom: 8px;"><strong>' + (cfg.name || 'S3 配置') + '</strong> ' + (cfg.enabled ? '<span style="color: var(--success);">🟢</span>' : '<span style="color: var(--error);">🔴</span>') + '<br><small style="color: var(--text-muted);">' + (cfg.endpoint || '') + ' / ' + (cfg.bucket_name || '') + '</small></div>').join('') : '<p style="color: var(--text-muted);">暂无 S3 配置</p>') + '</div><button class="btn btn-primary" onclick="showAddS3ConfigModal()">+ 添加 S3 配置</button></div></div>';<button class="settings-nav-btn active" onclick="showSettingsSection(\&apos;profile\&apos;, this)">个人资料</button><button class="settings-nav-btn" onclick="showSettingsSection(\&apos;security\&apos;, this)">安全设置</button><button class="settings-nav-btn" onclick="showSettingsSection(\&apos;devices\&apos;, this)">设备管理</button></div><div id="settingsProfileSection" class="settings-section active"><div class="card" style="margin-top: 16px;"><h4 class="section-title">个人资料</h4><form id="profileForm"><div class="form-group"><label>邮箱</label><input type="email" value="' + profile.email + '" disabled></div><div class="form-group"><label>显示名称</label><input type="text" name="display_name" value="' + (profile.display_name || '') + '" placeholder="设置您的显示名称"></div><button type="submit" class="btn btn-primary btn-block">保存</button></form></div></div><div id="settingsSecuritySection" class="settings-section"><div class="card" style="margin-top: 16px;"><h4 class="section-title">修改密码</h4><form id="passwordForm"><div class="form-group"><label>当前密码</label><input type="password" name="current_password" required></div><div class="form-group"><label>新密码</label><input type="password" name="new_password" minlength="8" required placeholder="至少8位"></div><div class="form-group"><label>确认新密码</label><input type="password" name="confirm_password" minlength="8" required></div><button type="submit" class="btn btn-primary btn-block">修改密码</button></form></div></div><div id="settingsDevicesSection" class="settings-section"><div class="card" style="margin-top: 16px;"><h4 class="section-title">已登录设备</h4><div class="device-list">' + (devices.devices && devices.devices.length > 0 ? devices.devices.map(d => '<div class="device-item" data-id="' + d.id + '"><div class="device-info"><span class="device-icon">💻</span><div><div class="device-name">' + (d.name || '未知设备') + '</div><div class="device-meta">' + formatDateTime(d.last_active_at || d.created_at) + '</div></div></div><button class="btn btn-danger" onclick="revokeDevice(this.closest(&apos;[data-id]&apos;).dataset.id)">撤销</button></div>').join('') : '<p style="color: var(--text-muted);">暂无设备记录</p>') + '</div></div></div>';
        
        document.getElementById('profileForm').addEventListener('submit', async function(e) {
          e.preventDefault();
          const formData = new FormData(e.target);
          try {
            await api('/api/v1/profile/me', {
              method: 'PATCH',
              body: JSON.stringify({ display_name: formData.get('display_name') })
            });
            showToast('资料已保存');
          } catch (err) {
            showToast(err.message, 'error');
          }
        });
        
        document.getElementById('passwordForm').addEventListener('submit', async function(e) {
          e.preventDefault();
          const formData = new FormData(e.target);
          if (formData.get('new_password') !== formData.get('confirm_password')) {
            showToast('两次输入的密码不一致', 'error');
            return;
          }
          try {
            await api('/api/v1/profile/me/change-password', {
              method: 'POST',
              body: JSON.stringify({
                current_password: formData.get('current_password'),
                new_password: formData.get('new_password')
              })
            });
            showToast('密码修改成功');
            e.target.reset();
          } catch (err) {
            showToast(err.message, 'error');
          }
        });
      } catch (err) {
        content.innerHTML = '<p style="color: var(--error);">加载失败: ' + err.message + '</p>';
      }
    }

    async function revokeDevice(deviceId) {
      if (!confirm('确定要撤销该设备吗？')) return;
      
      try {
        await api('/api/v1/devices/' + deviceId, { method: 'DELETE' });
        showToast('设备已撤销');
        showSettingsModal();
      } catch (err) {
        showToast(err.message, 'error');
      }
    }

    async function setup2FA() {
      try {
        const result = await api('/api/v1/2fa/setup', { method: 'POST' });
        if (result.qr_code_url) {
          if (confirm('请使用身份验证器 APP 扫描二维码，然后点击确定输入验证码。\n\n如果您无法扫描二维码，密钥是：' + (result.manual_entry_key || 'N/A'))) {
            const code = prompt('请输入验证码：');
            if (code) {
              await api('/api/v1/2fa/confirm', {
                method: 'POST',
                body: JSON.stringify({ code: code })
              });
              showToast('2FA 已启用');
              showSettingsModal();
            }
          }
        } else {
          showToast('2FA 设置失败', 'error');
        }
      } catch (err) {
        showToast('2FA 设置失败: ' + err.message, 'error');
      }
    }
    
    async function disable2FA() {
      if (!confirm('确定要禁用两步验证吗？这会降低账户安全性。')) return;
      try {
        const code = prompt('请输入验证码以确认禁用：');
        if (code) {
          await api('/api/v1/2fa/disable', {
            method: 'POST',
            body: JSON.stringify({ code: code })
          });
          showToast('2FA 已禁用');
          showSettingsModal();
        }
      } catch (err) {
        showToast('禁用失败: ' + err.message, 'error');
      }
    }
    
    function showAddS3ConfigModal() {
      const modal = document.createElement('div');
      modal.id = 's3ConfigModal';
      modal.className = 'modal active';
      modal.innerHTML = '<div class="modal-content"><div class="modal-header"><h3 class="modal-title">添加 S3 配置</h3><button class="modal-close" onclick="closeModal(\'s3ConfigModal\')">×</button></div>' +
        '<form id="s3ConfigForm" style="padding: 16px 0;"><div class="form-group"><label>配置名称</label><input type="text" name="name" placeholder="例如：我的 S3" required></div>' +
        '<div class="form-group"><label>Endpoint</label><input type="text" name="endpoint" placeholder="https://s3.amazonaws.com" required></div>' +
        '<div class="form-group"><label>Region</label><input type="text" name="region" placeholder="us-east-1"></div>' +
        '<div class="form-group"><label>Bucket</label><input type="text" name="bucket_name" placeholder="my-bucket" required></div>' +
        '<div class="form-group"><label>Access Key ID</label><input type="text" name="access_key_id" required></div>' +
        '<div class="form-group"><label>Secret Access Key</label><input type="password" name="secret_access_key" required></div>' +
        '<button type="submit" class="btn btn-primary btn-block">保存</button></form></div>';
      document.body.appendChild(modal);
      
      document.getElementById('s3ConfigForm').addEventListener('submit', async function(e) {
        e.preventDefault();
        const formData = new FormData(e.target);
        const data = {};
        formData.forEach((v, k) => data[k] = v);
        try {
          await api('/api/v1/sys-config/s3', {
            method: 'POST',
            body: JSON.stringify(data)
          });
          showToast('S3 配置已添加');
          closeModal('s3ConfigModal');
          modal.remove();
          showSettingsModal();
        } catch (err) {
          showToast('添加失败: ' + err.message, 'error');
        }
      });
    }
    
    function showSettingsSection(section, btn) {
      document.querySelectorAll('.settings-nav-btn').forEach(function(b) { b.classList.remove('active'); });
      document.querySelectorAll('.settings-section').forEach(function(s) { s.classList.remove('active'); });
      btn.classList.add('active');
      document.getElementById('settings' + section.charAt(0).toUpperCase() + section.slice(1) + 'Section').classList.add('active');
    }

    document.addEventListener('DOMContentLoaded', render);
  </script>
</body>
</html>`;

app.get('/', (c) => {
  c.header('Content-Type', 'text/html; charset=utf-8');
  return c.body(FRONTEND_HTML);
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
