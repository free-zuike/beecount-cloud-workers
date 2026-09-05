# BeeCount Cloud Workers

BeeCount Cloud 的 Cloudflare Workers 实现 — 原版 [BeeCount-Cloud](https://github.com/TNT-Likely/BeeCount-Cloud) (Python/FastAPI) 的功能对齐移植，部署到 Cloudflare Workers (TypeScript/Hono/D1)。

![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange)
![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue)
![License](https://img.shields.io/badge/License-MIT-green)

## 与原版的关系

本项目是 [BeeCount-Cloud](https://github.com/TNT-Likely/BeeCount-Cloud) 的 Cloudflare Workers 移植版，**功能与原版完全一致**（经逐端点逐字段对比验证）。差异仅限于 Cloudflare 平台限制：

| 差异项 | 原版 | Workers | 原因 |
|--------|------|---------|------|
| 数据库 | PostgreSQL/SQLite | D1 (SQLite) | 备份用 D1 Export API 生成 .sqlite3 文件，与原版 VACUUM INTO 等效 |
| 布尔存储 | 原生 boolean | INTEGER 0/1 | SQLite 限制 |
| 附件存储 | 本地文件系统或 S3 | R2 优先，自动回退所有已配置备份远端（S3/B2/WebDAV/FTP/SFTP） | Workers 无本地文件系统；所有附件/头像统一存储在远端 `beecount/` 子目录下 |
| 加密备份 | pyzipper (WZ_AES) | @zip.js/zip.js 加密 ZIP | 使用同一 AES-256 标准，备份文件互通 |
| 密码混淆 | rclone obscure | 无 | 无法运行 rclone CLI |
| 定时任务 | APScheduler (Python 线程) | Workflows + Cron | Workers 运行时限制 |
| 并行备份 | rclone fan-out | Promise.allSettled | Workers 原生并行 |
| 项目事务 | DB transaction (commit/rollback) | db.batch 原子事务 | D1 原生支持 batch 多语句事务，已对齐原版语义 |
| OAuth2 备份 | rclone 处理 OAuth2 | 直接调用 REST API | Workers 内实现 |
| 指标监控 | Prometheus | 无 | 无 statsd 基础设施 |
| 注册控制 | 环境变量 REGISTRATION_ENABLED | 环境变量 REGISTRATION_ENABLED | 已对齐 |
| 前端部署 | 前后端分离部署 | Workers Assets 同域部署 | 一起部署到同一 Workers 域名，无需跨域配置 |

## 备份

备份文件格式与原版完全兼容，文件名 `YYYYMMDD-HHMMSS.tar.gz`（明文）或 `.zip`（AES-256 加密）。

| 文件 | 说明 |
|------|------|
| `db.sqlite3` | 标准 SQLite 二进制（D1 Export API 导出，等效原版 VACUUM INTO） |
| `meta.json` | 元数据 |
| `.jwt_secret` | JWT 签名密钥（从环境变量读取） |
| `attachments/` | 附件 |
| `db.json` | 未配置 `CLOUDFLARE_API_TOKEN` 时的回退格式，仅生成此文件，仍可通过 Web 恢复 |

**注意**：`db.sqlite3` 生成依赖 `CLOUDFLARE_API_TOKEN`（D1.Read 权限），未配置时跳过 `db.sqlite3`。

与原版差异：

| 差异项 | 原版 | Workers |
|--------|------|---------|
| SQLite 生成 | VACUUM INTO（本地文件系统） | D1 Export API（REST API，不耗 CPU） |
| 加密 | pyzipper WZ_AES | @zip.js/zip.js AES-256（同一标准） |
| 附件来源 | 本地文件系统 hardlink | S3 兼容对象存储（R2 优先，无 R2 自动回退 S3） |
| Token 依赖 | 无 | 需 `CLOUDFLARE_API_TOKEN`，否则无 `db.sqlite3` |

### OAuth2 远端授权（Google Drive / OneDrive / Dropbox）

这三个远端是 OAuth2 授权模式，配置时除 `client_id / client_secret` 外，还需要一个 `OAuth Token (JSON)`。OAuth 协议要求**首次授权必须由用户在浏览器中登录并点"允许"**（访问私人文件的安全要求，无法跳过），之后 token 过期由服务端自动刷新，只需授权一次。

**通用流程**（backend_type 选 `drive` 时 provider 填 `drive`，`onedrive` → `onedrive`，`dropbox` → `dropbox`）：

1. **创建应用拿到 Client ID / Client Secret**（见下表各提供商入口）
2. **配 Redirect URI**：在提供商应用设置里添加

   ```
   https://<你的workers域名>/api/v1/admin/backup/remotes/oauth2/callback
   ```

3. **浏览器打开授权链接**（构造方式见"授权链接模板"，替换 client_id）→ 登录并点允许
4. 页面跳回回调地址，**显示授权码 code**
5. **用 code 换 token**（服务器端点已实现，无需 rclone）：

   ```bash
   curl -X POST https://<你的workers域名>/api/v1/admin/backup/remotes/oauth2/token \
     -H "Content-Type: application/json" \
     -d '{"code":"<回调页显示的code>","provider":"drive|onedrive|dropbox","client_id":"<你的ClientID>","client_secret":"<你的ClientSecret>"}'
   ```

   返回 JSON 中的 `token` 对象（含 `access_token` / `refresh_token`）即第三个字段 **OAuth Token (JSON)**，整体填入。

#### 各提供商授权链接模板

| 提供商 | Client ID/Secret 入口 | 授权链接 |
|---|---|---|
| **Google Drive** | [Google Cloud Console](https://console.cloud.google.com/apis/credentials) → OAuth 2.0 客户端（Client ID 选 Web） | `https://accounts.google.com/o/oauth2/v2/auth?client_id=<CI>&redirect_uri=<回调>&response_type=code&scope=https://www.googleapis.com/auth/drive.file&access_type=offline&prompt=consent&state=drive` |
| **OneDrive** | [Azure 应用注册](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps) → 认证 → 添加"移动/桌面或 Web"平台 | `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=<CI>&redirect_uri=<回调>&response_type=code&scope=offline_access Files.ReadWrite&state=onedrive` |
| **Dropbox** | [Dropbox App 控制台](https://www.dropbox.com/developers/apps) → Scoped access（权限勾 `files.content.write/read`） | `https://www.dropbox.com/oauth2/authorize?client_id=<CI>&response_type=code&redirect_uri=<回调>&token_access_type=offline&state=dropbox` |

> ⚠️ 三个都**必须带 offline/token_access_type=offline 参数**，否则换不到 `refresh_token`，授权过期后会失败。code 有效期很短（分钟级），拿到后尽快换 token。

## 功能特性

- 🚀 **全球边缘部署** — 部署到全球 200+ 边缘节点
- 💾 **D1 SQLite 数据库** — 免费 5GB 存储空间
- 🔐 **JWT 认证** — 安全的基于令牌的认证，支持双因素认证 (TOTP)
- 👤 **自动创建管理员账户** — 首次访问时自动创建默认管理员
- 📂 **自动创建默认分类** — 创建账本时自动初始化默认分类
- 📎 **多类型远端备份** — S3/B2/R2/WebDAV/FTP/SFTP/Google Drive/OneDrive/Dropbox
- 🔄 **自动保留策略** — 定时备份后自动清理超期文件
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

1. **创建 Cloudflare API Token**
   - 打开 Cloudflare → 右上角头像 → **My Profile** → **API Tokens**
   - 点击 **Create Token** → **Create Custom Token**
   - **Token Name**：`beecount-cloud-workers-deploy`（或你喜欢的名字）
   - **Edit Permissions**：
     - 搜索 `Workers` → 添加 **Edit**（Worker Scripts 部署权限）
     - 搜索 `D1` → 添加 **Edit**（D1 数据库创建 + 导出备份所需）
   - **Zone Resources**：`All zones` 或选择你的域名所属 Zone
   - **Account Resources**：选择你的账号（必选）
   - **Continue to summary** → **Create Token**
   - 复制生成的 Token 值（只显示一次，妥善保存）

2. Fork 仓库到你自己名下

3. 打开 Fork 后的仓库 → **Settings** → **Secrets and Variables** → **Actions** → **New repository secret**
   - Name：`CLOUDFLARE_API_TOKEN`
   - Value：粘贴第 1 步复制的 Token
   - 点 **Add secret**

4. 回到仓库首页，**推送到 main 分支自动部署**
   - `CLOUDFLARE_ACCOUNT_ID` 和 `D1_DATABASE_ID` 由 CI 通过 Token 自动解析注入，无需手动配置
   - 部署完成后 GitHub Actions 日志会打印最终域名

> 💡 权限说明：Token 使用 **Workers: Edit + D1: Edit** 权限，覆盖 Worker 部署、D1 数据库创建、D1 Export API 生成 `db.sqlite3` 备份三项操作，Fork 用户开箱即用。

### 方式三：手动部署

```bash
npm install
npx wrangler login
npx wrangler d1 create beecount-cloud
# 数据库表结构由代码自动创建（首次请求时自动执行迁移），无需手动执行 SQL
npm run deploy
```

## 首次使用

1. 访问 Cloudflare Workers URL
2. 在初始化页面填写管理员邮箱、密码（至少 6 位）、时区，点击"完成初始化"
3. 生产环境关闭注册：Cloudflare Dashboard → Workers → Settings → **Variables and Secrets** → 添加变量 `REGISTRATION_ENABLED` = `"false"`（字符串，含双引号）

## 配置

### wrangler.toml

```toml
name = "beecount-cloud-workers"
main = "src/index.ts"
compatibility_date = "2026-06-18"
compatibility_flags = ["nodejs_compat"]

[triggers]
crons = ["*/5 * * * *"]

[alias]
tslib = "tslib"
"@modelcontextprotocol/sdk" = "./node_modules/@modelcontextprotocol/sdk/dist/esm/index.js"
"ssh2/lib/protocol/crypto/poly1305.js" = "./shims/ssh2-poly1305.js"
"age-encryption" = "./node_modules/age-encryption/dist/index.js"

[[d1_databases]]
binding = "DB"
database_name = "beecount-cloud"
database_id = "你的数据库ID"

[[durable_objects.bindings]]
name = "BEECOUNT_DO"
class_name = "BeeCountDO"

# R2 对象存储（可选）：无信用卡账户可注释掉以下三行，附件/头像将自动使用已有的备份远端
# [[r2_buckets]]
# binding = "R2"
# bucket_name = "beecount-storage"

# ⚠️ 若不开 R2 且未配置任何备份远端，附件和头像将不可用（不会报错）
# 建议：在后台「远端备份」至少配置一个远端（如 Backblaze B2 免费额度），附件和头像即可正常使用

[[workflows]]
name = "backup-workflow"
binding = "BACKUP_WORKFLOW"
class_name = "BackupWorkflow"

[vars]
API_PREFIX = "/api/v1"
CLOUDFLARE_ACCOUNT_ID = "你的Cloudflare账户ID"
D1_DATABASE_ID = "你的数据库ID"
# CLOUDFLARE_API_TOKEN 在 CI 部署时自动注入，或手动设置 Secret

[observability]
enabled = true

[assets]
directory = "./frontend/apps/web/dist"
binding = "ASSETS"

# JWT_SECRET 通过 Cloudflare Dashboard → Secrets 设置
# 或 CLI: npx wrangler secret put JWT_SECRET
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

#### AI 文档问答（RAG）

Web 端 `⌘K` 的 AI 助手会基于 BeeCount 官方文档回答使用问题（附来源链接）。部署者需额外配置 **server 侧 embedding key**（把用户问题转成向量去文档库检索；免费额度足够，参考 [SiliconFlow](https://siliconflow.cn)）：

```bash
# 部署后执行（敏感配置走 Secret，禁止放 wrangler.toml [vars]）
npx wrangler secret put EMBEDDING_API_KEY
```

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `EMBEDDING_API_KEY` | （空） | **必需**：不配则 AI 问答返回 503、健康页索引卡片显示"不可用"；不影响记账/同步/备份 |
| `EMBEDDING_MODEL` | `BAAI/bge-m3` | 必须与索引构建用模型一致，否则检索结果无意义 |
| `EMBEDDING_BASE_URL` | `https://api.siliconflow.cn/v1` | OpenAI 兼容 `/embeddings` 端点 |
| `RAG_INDEX_SOURCE_URL` | `https://raw.githubusercontent.com/TNT-Likely/BeeCount-Website/main/data` | 官方文档索引源 |
| `RAG_INDEX_REFRESH_INTERVAL_SECONDS` | `21600`（6h） | cron 自动刷新间隔 |

部署后手动拉取一次索引：Web 后台「设置 → 健康」→ **AI 文档索引**卡片 → **立即更新**；或 `POST /api/v1/admin/rag/refresh`。

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

**支持远端类型**：S3、B2、R2、WebDAV、FTP、SFTP、Google Drive、OneDrive、Dropbox

OAuth2 远端（Google Drive/OneDrive/Dropbox）需配置 `client_id`、`client_secret`、`refresh_token`。

### 导入

- `POST /import/upload` — 上传 CSV/TSV/XLSX 文件解析
- `POST /import/:token/preview` — 预览导入结果
- `POST /import/:token/execute` — 执行导入（SSE 进度流）

### 共享账本

- `POST /workspace/ledgers/:id/invites` — 生成邀请码
- `GET /workspace/ledgers/:id/invites` — 列出活跃邀请
- `DELETE /workspace/ledgers/:id/invites/:code` — 撤销邀请
- `POST /workspace/invites/:code/preview` — 预览邀请详情
- `POST /workspace/invites/:code/accept` — 接受邀请
- `GET /invite/:code` — 邀请链接重定向（需配置 `INVITE_SHARE_ORIGIN`）

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
│   │   ├── audit.ts          # 审计日志
│   │   ├── s3.ts             # S3 签名/上传/列出/删除
│   │   ├── ftp.ts            # FTP 客户端
│   │   ├── sftp.ts           # SFTP 客户端
│   │   ├── oauth2-storage.ts # OAuth2 云存储（Google Drive/OneDrive/Dropbox）
│   │   └── zip-lib.ts        # ZIP 加密
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
│   │   ├── csv.ts            # CSV 导出
│   │   ├── import_data.ts    # CSV/TSV/XLSX 导入
│   │   └── devices.ts        # 设备管理
│   ├── services/
│   │   ├── backup-executor.ts # 备份执行
│   │   ├── backup-retention.ts# 备份保留策略
│   │   ├── restore-service.ts # 恢复服务
│   │   ├── import_data/      # 数据导入（parser/transformer/stats）
│   │   └── data-cleanup/     # 孤立数据清理
│   └── do/
│       └── index.ts          # Durable Object（WS/日志/锁/导入缓存）
├── wrangler.toml             # Cloudflare 配置
└── .github/workflows/        # CI/CD 自动部署
```

## 数据库

数据库表结构由代码自动创建（`src/db/schema.ts` 中的 `CREATE TABLE IF NOT EXISTS` 在首次请求时执行），无需手动执行 SQL。

## 本地开发

```bash
npm install
npx wrangler d1 create beecount-cloud --local
npx wrangler dev
```

## 许可证

MIT
