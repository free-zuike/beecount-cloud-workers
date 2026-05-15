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
      padding: 20px 0;
      box-shadow: 0 4px 6px rgba(249, 115, 22, 0.3);
    }

    .header-content {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .logo {
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 1.5rem;
      font-weight: 700;
    }

    .logo-icon {
      width: 40px;
      height: 40px;
      background: white;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.5rem;
    }

    .card {
      background: var(--surface);
      border-radius: 12px;
      padding: 24px;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
      border: 1px solid var(--border);
    }

    .form-group { margin-bottom: 16px; }
    .form-group label { display: block; font-weight: 500; margin-bottom: 6px; }
    
    .form-group input, .form-group select {
      width: 100%;
      padding: 12px 16px;
      border: 1px solid var(--border);
      border-radius: 8px;
      font-size: 1rem;
      transition: border-color 0.2s, box-shadow 0.2s;
    }

    .form-group input:focus {
      outline: none;
      border-color: var(--primary);
      box-shadow: 0 0 0 3px var(--primary-light);
    }

    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 12px 24px;
      border: none;
      border-radius: 8px;
      font-size: 1rem;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
    }

    .btn-primary { background: var(--primary); color: white; }
    .btn-primary:hover { background: var(--primary-dark); transform: translateY(-1px); }
    .btn-secondary { background: var(--surface); color: var(--text); border: 1px solid var(--border); }
    .btn-secondary:hover { background: var(--background); }
    .btn-block { width: 100%; }

    .auth-container {
      min-height: calc(100vh - 80px);
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

    .dashboard { display: none; }
    .dashboard.active { display: block; }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }

    .stat-card {
      background: var(--surface);
      border-radius: 12px;
      padding: 20px;
      border: 1px solid var(--border);
    }

    .stat-label { font-size: 0.875rem; color: var(--text-muted); margin-bottom: 8px; }
    .stat-value { font-size: 1.75rem; font-weight: 700; }
    .stat-value.income { color: var(--success); }
    .stat-value.expense { color: var(--error); }

    .ledger-list { display: grid; gap: 16px; }

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

    .ledger-info h3 { font-size: 1.125rem; margin-bottom: 4px; }
    .ledger-info p { font-size: 0.875rem; color: var(--text-muted); }
    .ledger-stats { text-align: right; }
    .ledger-stats .income { color: var(--success); }
    .ledger-stats .expense { color: var(--error); }

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

    .modal-title { font-size: 1.25rem; font-weight: 600; }
    .modal-close { background: none; border: none; font-size: 1.5rem; cursor: pointer; color: var(--text-muted); }

    .transaction-list { display: flex; flex-direction: column; gap: 12px; }

    .transaction-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px;
      background: var(--background);
      border-radius: 8px;
    }

    .transaction-icon {
      width: 40px;
      height: 40px;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.25rem;
    }

    .transaction-icon.income { background: #dcfce7; }
    .transaction-icon.expense { background: #fee2e2; }

    .transaction-info { flex: 1; }
    .transaction-info h4 { font-size: 1rem; margin-bottom: 2px; }
    .transaction-info p { font-size: 0.875rem; color: var(--text-muted); }

    .transaction-amount { font-weight: 600; font-size: 1rem; }
    .transaction-amount.income { color: var(--success); }
    .transaction-amount.expense { color: var(--error); }

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

    @media (max-width: 768px) {
      .header-content { flex-direction: column; gap: 12px; }
      .stats-grid { grid-template-columns: 1fr; }
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
      transactions: []
    };

    async function api(endpoint, options = {}) {
      const headers = { 'Content-Type': 'application/json' };
      if (state.token) {
        headers['Authorization'] = 'Bearer ' + state.token;
      }
      
      const response = await fetch(API_BASE + endpoint, {
        ...options,
        headers: { ...headers, ...options.headers }
      });
      
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || '请求失败');
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
      return new Intl.NumberFormat('zh-CN', {
        style: 'currency',
        currency: 'CNY'
      }).format(amount / 100);
    }

    function formatDate(dateStr) {
      return new Date(dateStr).toLocaleDateString('zh-CN');
    }

    function render() {
      const app = document.getElementById('app');
      
      if (!state.token) {
        app.innerHTML = renderAuth();
        bindAuthEvents();
      } else {
        app.innerHTML = renderDashboard();
        bindDashboardEvents();
        loadLedgers();
      }
    }

    function renderAuth() {
      return '<header class="header"><div class="container header-content"><div class="logo"><div class="logo-icon">🐝</div><span>蜜蜂记账</span></div></div></header><div class="auth-container"><div class="card auth-card"><div class="auth-tabs"><button class="auth-tab active" data-tab="login">登录</button><button class="auth-tab" data-tab="register">注册</button></div><form id="loginForm" class="auth-form active"><div class="form-group"><label>邮箱</label><input type="email" name="email" placeholder="your@email.com" required></div><div class="form-group"><label>密码</label><input type="password" name="password" placeholder="••••••••" required></div><button type="submit" class="btn btn-primary btn-block">登录</button></form><form id="registerForm" class="auth-form"><div class="form-group"><label>邮箱</label><input type="email" name="email" placeholder="your@email.com" required></div><div class="form-group"><label>密码</label><input type="password" name="password" placeholder="至少 8 位" minlength="8" required></div><button type="submit" class="btn btn-primary btn-block">注册</button></form></div></div>';
    }

    function bindAuthEvents() {
      var tabs = document.querySelectorAll('.auth-tab');
      tabs.forEach(function(tab) {
        tab.addEventListener('click', function() {
          tabs.forEach(function(t) { t.classList.remove('active'); });
          document.querySelectorAll('.auth-form').forEach(function(f) { f.classList.remove('active'); });
          tab.classList.add('active');
          document.getElementById(tab.dataset.tab + 'Form').classList.add('active');
        });
      });

      document.getElementById('loginForm').addEventListener('submit', async function(e) {
        e.preventDefault();
        var formData = new FormData(e.target);
        try {
          var data = await api('/api/v1/auth/login', {
            method: 'POST',
            body: JSON.stringify({
              email: formData.get('email'),
              password: formData.get('password')
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
        var formData = new FormData(e.target);
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

    function renderDashboard() {
      return '<header class="header"><div class="container header-content"><div class="logo"><div class="logo-icon">🐝</div><span>蜜蜂记账</span></div><button class="btn btn-secondary" onclick="logout()">退出</button></div></header><main class="container dashboard active"><div style="display: flex; justify-content: space-between; align-items: center; margin: 24px 0;"><h2>我的账本</h2><button class="btn btn-primary" onclick="showCreateLedgerModal()">+ 新建账本</button></div><div id="statsGrid" class="stats-grid"></div><div id="ledgerList" class="ledger-list"></div></main><div id="ledgerModal" class="modal"><div class="modal-content"><div class="modal-header"><h3 class="modal-title" id="ledgerModalTitle">账本详情</h3><button class="modal-close" onclick="closeModal(\\'ledgerModal\\')">×</button></div><div id="ledgerModalContent"></div></div></div><div id="createLedgerModal" class="modal"><div class="modal-content"><div class="modal-header"><h3 class="modal-title">新建账本</h3><button class="modal-close" onclick="closeModal(\\'createLedgerModal\\')">×</button></div><form id="createLedgerForm"><div class="form-group"><label>账本名称</label><input type="text" name="name" placeholder="例如：家庭账本" required></div><div class="form-group"><label>货币</label><select name="currency"><option value="CNY">人民币 (CNY)</option><option value="USD">美元 (USD)</option><option value="EUR">欧元 (EUR)</option></select></div><button type="submit" class="btn btn-primary btn-block">创建</button></form></div></div>';
    }

    function bindDashboardEvents() {
      document.getElementById('createLedgerForm').addEventListener('submit', async function(e) {
        e.preventDefault();
        var formData = new FormData(e.target);
        try {
          await api('/api/v1/write/ledgers', {
            method: 'POST',
            body: JSON.stringify({
              name: formData.get('name'),
              currency: formData.get('currency')
            })
          });
          closeModal('createLedgerModal');
          showToast('账本创建成功');
          loadLedgers();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    }

    async function loadLedgers() {
      var ledgerList = document.getElementById('ledgerList');
      var statsGrid = document.getElementById('statsGrid');
      ledgerList.innerHTML = '<div class="loading"><div class="spinner"></div>加载中...</div>';
      
      try {
        var data = await api('/api/v1/read/workspace/ledger-counts');
        state.ledgers = data.ledgers || [];
        
        statsGrid.innerHTML = '<div class="stat-card"><div class="stat-label">账本数量</div><div class="stat-value">' + state.ledgers.length + '</div></div><div class="stat-card"><div class="stat-label">本月收入</div><div class="stat-value income">' + formatMoney(data.monthly_income || 0) + '</div></div><div class="stat-card"><div class="stat-label">本月支出</div><div class="stat-value expense">' + formatMoney(data.monthly_expense || 0) + '</div></div><div class="stat-card"><div class="stat-label">本月结余</div><div class="stat-value ' + ((data.monthly_income - data.monthly_expense) >= 0 ? 'income' : 'expense') + '">' + formatMoney((data.monthly_income || 0) - (data.monthly_expense || 0)) + '</div></div>';
        
        if (state.ledgers.length === 0) {
          ledgerList.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📒</div><p>还没有账本</p><p>点击上方按钮创建您的第一个账本</p></div>';
        } else {
          ledgerList.innerHTML = state.ledgers.map(function(ledger) {
            return '<div class="ledger-item" onclick="showLedgerDetail(\\'' + ledger.id + '\\')"><div class="ledger-info"><h3>' + ledger.name + '</h3><p>' + formatDate(ledger.created_at) + '</p></div><div class="ledger-stats"><div class="income">+' + formatMoney(ledger.monthly_income || 0) + '</div><div class="expense">-' + formatMoney(ledger.monthly_expense || 0) + '</div></div></div>';
          }).join('');
        }
      } catch (err) {
        ledgerList.innerHTML = '<div class="empty-state"><p>加载失败: ' + err.message + '</p></div>';
      }
    }

    async function showLedgerDetail(ledgerId) {
      var modal = document.getElementById('ledgerModal');
      var content = document.getElementById('ledgerModalContent');
      document.getElementById('ledgerModalTitle').textContent = '账本详情';
      
      modal.classList.add('active');
      content.innerHTML = '<div class="loading"><div class="spinner"></div>加载中...</div>';
      
      try {
        var transactions = await api('/api/v1/read/ledgers/' + ledgerId + '/transactions?limit=10');
        state.transactions = transactions.transactions || [];
        
        if (state.transactions.length === 0) {
          content.innerHTML = '<h4 style="margin-bottom: 16px;">账本详情</h4><p style="color: var(--text-muted); text-align: center; padding: 20px;">暂无交易记录</p><div style="margin-top: 20px;"><button class="btn btn-secondary btn-block" onclick="closeModal(\\'ledgerModal\\')">关闭</button></div>';
        } else {
          content.innerHTML = '<h4 style="margin-bottom: 16px;">最近交易</h4><div class="transaction-list">' + state.transactions.map(function(tx) {
            return '<div class="transaction-item"><div class="transaction-icon ' + tx.type + '">' + (tx.type === 'income' ? '📈' : '📉') + '</div><div class="transaction-info"><h4>' + (tx.description || tx.category_name) + '</h4><p>' + formatDate(tx.date) + '</p></div><div class="transaction-amount ' + tx.type + '">' + (tx.type === 'income' ? '+' : '-') + formatMoney(tx.amount) + '</div></div>';
          }).join('') + '</div><div style="margin-top: 20px;"><button class="btn btn-secondary btn-block" onclick="closeModal(\\'ledgerModal\\')">关闭</button></div>';
        }
      } catch (err) {
        content.innerHTML = '<p style="color: var(--error);">加载失败: ' + err.message + '</p>';
      }
    }

    function showCreateLedgerModal() {
      document.getElementById('createLedgerForm').reset();
      document.getElementById('createLedgerModal').classList.add('active');
    }

    function closeModal(modalId) {
      document.getElementById(modalId).classList.remove('active');
    }

    function logout() {
      state.token = null;
      localStorage.removeItem('token');
      showToast('已退出登录');
      render();
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

app.use('/api/v1/*', async (c, next) => {
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

app.route('/api/v1/auth', authRouter);
app.route('/api/v1/2fa', twoFactorRouter);
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
