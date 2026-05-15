# BeeCount Cloud Workers

BeeCount Cloud 的 Cloudflare Workers 实现 - 一个快速的边缘部署个人财务管理系统。

![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange)
![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue)
![License](https://img.shields.io/badge/License-MIT-green)

## 功能特性

- 🚀 **全球边缘部署** - 部署到全球 200+ 边缘节点
- 💾 **D1 SQLite 数据库** - 免费 5GB 存储空间
- 🔐 **JWT 认证** - 安全的基于令牌的认证，支持双因素认证
- 📎 **外部 S3 存储** - 可选的 S3 兼容存储用于附件
- 🤖 **AI 集成** - 支持 OpenAI 兼容 API（智谱、DeepSeek 等）
- 📊 **完整 API** - 60+ 个端点覆盖所有 BeeCount Cloud 功能

## 快速部署

### 方式一：一键部署（推荐）

1. Fork 此仓库到您的 GitHub 账户
2. 访问 [Cloudflare Dashboard](https://dash.cloudflare.com/)
3. 导航到 **Workers & Pages** → **Create Application** → **Connect to Git**
4. 连接您的仓库
5. 配置环境变量：
   - `JWT_SECRET`: 您的 JWT 签名密钥（使用 `openssl rand -base64 32` 生成）
6. 点击 **Deploy**

### 方式二：手动部署

```bash
# 克隆仓库
git clone https://github.com/free-zuike/beecount-cloud-workers.git
cd beecount-cloud-workers

# 安装依赖
npm install

# 登录 Cloudflare
npx wrangler login

# 创建 D1 数据库
npx wrangler d1 create beecount-cloud

# 更新 wrangler.toml 中的 database_id
# 然后应用 schema
npx wrangler d1 migrations apply beecount-cloud --remote

# 部署
npm run deploy
```

## 配置

### 必填环境变量

| 变量 | 说明 | 示例 |
|------|------|------|
| `JWT_SECRET` | JWT 签名密钥（至少 32 字符） | `openssl rand -base64 32` |
| `CLOUDFLARE_D1_DATABASE_ID` | D1 数据库 UUID | 来自 `wrangler d1 create` 输出 |

### 可选 S3 配置

用于外部 S3 兼容存储（附件）：

| 变量 | 说明 | 示例 |
|------|------|------|
| `S3_ENDPOINT` | S3 API 端点 | `https://s3.us-east-1.amazonaws.com` |
| `S3_REGION` | AWS 区域 | `us-east-1` |
| `S3_ACCESS_KEY_ID` | Access Key ID | `AKIA...` |
| `S3_SECRET_ACCESS_KEY` | Secret Access Key | `...` |
| `S3_BUCKET_NAME` | 附件存储桶 | `beecount-attachments` |

### AI 配置

AI 功能需要在用户资料的 `ai_config_json` 字段中配置：

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
- `POST /api/v1/auth/register` - 注册新用户
- `POST /api/v1/auth/login` - 登录
- `POST /api/v1/auth/refresh` - 刷新令牌
- `POST /api/v1/two-factor/*` - 双因素认证管理

### 同步（移动端）
- `POST /api/v1/sync/push` - 推送更改
- `POST /api/v1/sync/pull` - 拉取更改
- `GET /api/v1/sync/ledgers` - 获取账本列表
- `POST /api/v1/sync/full-sync` - 全量同步

### CRUD 操作
- `/api/v1/read/*` - 查询数据
- `/api/v1/write/*` - 创建/更新/删除
- `/api/v1/batch/*` - 批量操作

### 工具
- `/api/v1/attachments/*` - 文件上传
- `/api/v1/import/*` - CSV 导入
- `/api/v1/ai/*` - AI 功能
- `/api/v1/backup/*` - 快照与恢复

## 数据库 Schema

Schema 定义在 `schema.sql` 中。初始化方式：

```bash
# 本地开发
npx wrangler d1 migrations apply beecount-cloud --local

# 生产环境
npx wrangler d1 migrations apply beecount-cloud --remote
```

## 开发

```bash
# 安装依赖
npm install

# 启动本地开发服务器（使用 Miniflare）
npm run dev

# 类型检查
npm run typecheck

# Lint
npm run lint
```

## 项目结构

```
beecount-cloud-workers/
├── src/
│   ├── index.ts           # 入口文件，路由注册
│   ├── auth.ts            # JWT 工具函数
│   └── routes/            # API 路由处理器
│       ├── auth.ts        # 认证
│       ├── two_factor.ts  # 双因素认证/TOTP
│       ├── sync.ts        # 移动端同步
│       ├── read.ts        # 查询端点
│       ├── write.ts       # 写入端点
│       ├── workspace.ts   # 跨账本查询
│       ├── batch_write.ts # 批量操作
│       ├── attachments.ts # 文件上传（S3）
│       ├── ai.ts          # AI 集成
│       ├── import_data.ts # CSV 导入
│       ├── backup.ts      # 快照
│       ├── admin_backup.ts # 管理员备份管理
│       └── admin.ts       # 管理员端点
├── schema.sql             # D1 数据库 Schema
├── wrangler.toml          # Cloudflare 配置
├── deploy.html            # 一键部署页面
└── .github/workflows/     # CI/CD
```

## 许可证

MIT
