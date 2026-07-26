# BeeCount Cloud Workers

BeeCount Cloud 的 Cloudflare Workers 实现 — 原版 [BeeCount-Cloud](https://github.com/TNT-Likely/BeeCount-Cloud) (Python/FastAPI) 的功能对齐移植，部署到 Cloudflare Workers (TypeScript/Hono/D1)。

![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange)
![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue)
![License](https://img.shields.io/badge/License-MIT-green)

## 与原版的关系

本项目是 [BeeCount-Cloud](https://github.com/TNT-Likely/BeeCount-Cloud) 的 Cloudflare Workers 移植版，**功能与原版完全一致**（经逐端点逐字段对比验证）。差异仅限于 Cloudflare 平台限制：

| 差异项 | 原版 | Workers | 原因 |
|--------|------|---------|------|
| 数据库 | PostgreSQL/SQLite | D1 (SQLite) | D1 不支持 VACUUM INTO，改用 JSON 导出 |
| 布尔存储 | 原生 boolean | INTEGER 0/1 | SQLite 限制 |
| 附件存储 | 本地文件系统 | R2 对象存储 | Workers 无本地文件系统 |
| 加密备份 | age + pyzipper | AES-256-GCM (Web Crypto) | 无法运行 age CLI |
| 密码混淆 | rclone obscure | 无 | 无法运行 rclone CLI |
| 定时任务 | APScheduler (Python 线程) | waitUntil (Workers 异步) | 运行时限制 |
| 并行备份 | rclone fan-out | Promise.allSettled | Workers 原生并行 |
| 投影事务 | DB transaction rollback | 单条 try/catch | D1 不支持跨语句事务 |
| 指标监控 | Prometheus | 无 | 无 statsd 基础设施 |
| 注册控制 | 环境变量 REGISTRATION_ENABLED | 环境变量 REGISTRATION_ENABLED | 已对齐 |

## 功能特性

- 🚀 **全球边缘部署** — 部署到全球 200+ 边缘节点
- 💾 **D1 SQLite 数据库** — 免费 5GB 存储空间
- 🔐 **JWT 认证** — 安全的基于令牌的认证，支持双因素认证 (TOTP)
- 👤 **自动创建管理员账户** — 首次访问时自动创建默认管理员
- 📂 **自动创建默认分类** — 创建账本时自动初始化默认分类
- 📎 **R2/S3/FTP/SFTP/WebDAV** — 支持多种远程备份存储
- 🤖 **AI 集成** — 支持 OpenAI 兼容 API（智谱、DeepSeek 等）
- 📊 **60+ API 端点** — 覆盖所有 BeeCount Cloud 功能
- 🔄 **完整同步协议** — 支持增量同步、共享账本、多设备
- 💰 **预算管理** — 总预算/分类预算，支持 month_start_day
- 📊 **跨账本统计** — 工作区聚合分析、净值趋势

## 快速部署

### 方式一：使用一键部署脚本（推荐）

```bash
git clone https://github.com/free-zuike/beecount-cloud-workers.git
cd beecount-cloud-workers
npm install
chmod +x setup.sh
./setup.sh
```

### 方式二：GitHub Actions 自动部署

1. Fork 仓库
2. 添加 Secrets：`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`
3. 创建 D1 数据库并更新 `wrangler.toml` 的 `database_id`
4. 推送到 main 分支自动部署

### 方式三：手动部署

```bash
npm install
npx wrangler login
npx wrangler d1 create beecount-cloud
npx wrangler d1 execute beecount-cloud --remote --file=./schema.sql
npm run deploy
```

## 首次使用

1. 访问 Cloudflare Workers URL
2. 在 Workers Logs 中查看管理员密码
3. 登录后修改密码
4. 设置 `REGISTRATION_ENABLED=false` 环境变量关闭注册（生产环境）

## 配置

### wrangler.toml

```toml
name = "beecount-cloud-workers"
main = "src/index.ts"

[[d1_databases]]
binding = "DB"
database_name = "beecount-cloud"
database_id = "你的数据库ID"

[vars]
API_PREFIX = "/api/v1"
JWT_SECRET = "你的JWT密钥"

# 可选：关闭注册
# REGISTRATION_ENABLED = "false"
```

### AI 配置

在用户资料的 `ai_config_json` 中配置：

```json
{
  "providers": [{
    "id": "zhipu_glm",
    "apiKey": "your-api-key",
    "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
    "textModel": "glm-4-flash",
    "visionModel": "glm-4v-flash"
  }],
  "binding": {
    "textProviderId": "zhipu_glm",
    "visionProviderId": "zhipu_glm"
  }
}
```

## API 端点

### 认证
- `POST /auth/register` — 注册新用户（REGISTRATION_ENABLED=false 时禁用）
- `POST /auth/login` — 登录（支持 2FA TOTP）
- `POST /auth/refresh` — 刷新 JWT 令牌
- `POST /auth/logout` — 登出
- `GET /auth/me` — 当前用户信息

### 双因素认证
- `GET /2fa/status` — 查询 2FA 状态
- `POST /2fa/setup` — 生成 TOTP secret
- `POST /2fa/confirm` — 确认启用 2FA
- `POST /2fa/verify` — 2FA 验证（登录时）
- `POST /2fa/disable` — 禁用 2FA
- `POST /2fa/recovery-codes/regenerate` — 重新生成恢复码

### 管理员
- `GET /admin/overview` — 系统概览
- `GET /admin/users` — 用户列表
- `POST /admin/users` — 创建用户（is_admin 强制 false）
- `PATCH /admin/users/:id` — 更新用户（不可禁用管理员）
- `DELETE /admin/users/:id` — 软删除用户
- `POST /admin/users/:id/password` — 修改密码
- `GET /admin/devices` — 设备列表（支持 deduped/sessions 视图）
- `POST /admin/devices/:id/revoke` — 撤销设备
- `DELETE /admin/devices/:id` — 删除设备
- `GET /admin/logs` — 审计日志

### 同步（移动端）
- `POST /sync/push` — 推送增量变更（LWW 冲突解决）
- `GET /sync/pull` — 拉取增量变更（支持共享账本）
- `GET /sync/full` — 全量同步快照
- `GET /sync/ledgers` — 获取可访问账本列表

### CRUD 操作
- `/read/ledgers/*` — 查询账本/交易/账户/分类/标签/预算
- `/write/ledgers/*` — 创建/更新/删除
- `/workspace/*` — 跨账本统计/分析/邀请

### 备份
- `GET /admin/backup/remotes` — 备份远端列表
- `POST /admin/backup/remotes` — 创建备份远端
- `GET /admin/backup/schedules` — 备份计划列表
- `POST /admin/backup/run-now` — 立即备份
- `POST /restore-from-r2` — 从 R2 恢复数据

## 项目结构

```
beecount-cloud-workers/
├── src/
│   ├── index.ts              # 入口，路由注册
│   ├── auth.ts               # JWT 签发/验证
│   ├── middleware/auth.ts    # 认证中间件
│   ├── lib/
│   │   ├── tar.ts            # tar.gz 创建
│   │   ├── sqlite-writer.ts  # SQLite 文件创建
│   │   ├── encryption.ts     # AES-256-GCM 加密
│   │   ├── ws-manager.ts     # WebSocket 管理
│   │   └── audit.ts          # 审计日志
│   ├── routes/               # API 路由
│   │   ├── auth.ts           # 认证
│   │   ├── two_factor.ts     # 2FA
│   │   ├── sync.ts           # 同步协议
│   │   ├── admin.ts          # 管理端点
│   │   ├── read.ts           # 查询端点
│   │   ├── write.ts          # 写入端点
│   │   ├── workspace.ts      # 跨账本
│   │   ├── profile.ts        # 用户资料
│   │   ├── attachments.ts    # 文件管理
│   │   ├── admin_backup.ts   # 备份管理
│   │   ├── backup.ts         # 数据修复
│   │   └── devices.ts        # 设备管理
│   └── services/
│       ├── backup-executor.ts # 备份执行
│       ├── restore-service.ts # 恢复服务
│       └── data-cleanup/     # 孤立数据清理
├── schema.sql                # D1 数据库 Schema
├── wrangler.toml             # Cloudflare 配置
└── .github/workflows/        # CI/CD 自动部署
```

## 数据库

```bash
npx wrangler d1 execute beecount-cloud --remote --file=./schema.sql
```

## 本地开发

```bash
npm install
npx wrangler d1 create beecount-cloud --local
npx wrangler d1 execute beecount-cloud --local --file=./schema.sql
npx wrangler dev
```

## 许可证

MIT
