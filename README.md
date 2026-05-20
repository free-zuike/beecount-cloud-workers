# BeeCount Cloud Workers

BeeCount Cloud 的 Cloudflare Workers 实现 - 一个快速的边缘部署个人财务管理系统。

![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange)
![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue)
![License](https://img.shields.io/badge/License-MIT-green)

## 功能特性

- 🚀 **全球边缘部署** - 部署到全球 200+ 边缘节点
- 💾 **D1 SQLite 数据库** - 免费 5GB 存储空间
- 🔐 **JWT 认证** - 安全的基于令牌的认证，支持双因素认证
- 👤 **自动创建管理员账户** - 首次访问时自动创建默认管理员
- 📂 **自动创建默认分类** - 创建账本时自动初始化默认分类
- 📎 **外部 S3 存储** - 可选的 S3 兼容存储用于附件
- 🤖 **AI 集成** - 支持 OpenAI 兼容 API（智谱、DeepSeek 等）
- 📊 **完整 API** - 60+ 个端点覆盖所有 BeeCount Cloud 功能

## 快速部署

### 方式一：使用一键部署脚本（推荐）

在本地终端运行：

```bash
# 克隆仓库
git clone https://github.com/free-zuike/beecount-cloud-workers.git
cd beecount-cloud-workers

# 安装依赖
npm install

# 运行一键部署脚本
chmod +x setup.sh
./setup.sh
```

脚本会自动：
1. 登录 Cloudflare
2. 创建 D1 数据库
3. 初始化数据库表
4. 部署应用
5. 首次访问时自动创建管理员账户

### 方式二：使用 GitHub Actions 自动部署

1. Fork 此仓库到您的 GitHub 账户
2. 在 GitHub 仓库设置中添加 Secrets：
   - `CLOUDFLARE_API_TOKEN`: Cloudflare API Token（需要 Workers 和 D1 权限）
   - `CLOUDFLARE_ACCOUNT_ID`: Cloudflare 账户 ID
3. 在本地预先创建 D1 数据库并更新 `wrangler.toml` 中的 `database_id`
4. 推送到 main 分支自动触发部署

### 方式三：手动部署

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

# 更新 wrangler.toml 中的 database_id 为输出的 ID
# 然后初始化数据库表
npx wrangler d1 execute beecount-cloud --remote --file=./schema.sql

# 部署
npm run deploy
```

## 首次使用

部署成功后：

1. **访问应用** - 打开 Cloudflare Workers 分配的 URL
2. **查看管理员密码** - 在 Cloudflare Dashboard → Workers & Pages → 你的 Worker → Logs 中查看
   - 默认管理员邮箱：`admin@localhost`
   - 密码会在首次访问时生成并输出到日志
3. **登录并修改密码** - 使用管理员账户登录，在用户管理中修改密码
4. **创建账本** - 创建新账本时会自动初始化默认分类

## 配置

### wrangler.toml 配置

```toml
name = "beecount-cloud-workers"
main = "src/index.ts"

[[d1_databases]]
binding = "DB"
database_name = "beecount-cloud"
database_id = "你的数据库ID"  # 从 wrangler d1 create 获取

[vars]
API_PREFIX = "/api/v1"
JWT_SECRET = "你的JWT密钥"  # 使用 openssl rand -base64 32 生成
```

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

### 管理员
- `GET /admin/overview` - 系统概览
- `GET /admin/users` - 用户列表
- `POST /admin/users` - 创建用户
- `PATCH /admin/users/:id` - 更新用户
- `DELETE /admin/users/:id` - 删除用户
- `POST /admin/users/:id/password` - 修改用户密码
- `GET /admin/devices` - 设备列表
- `GET /admin/logs` - 日志

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

Schema 定义在 `schema.sql` 中。

```bash
# 初始化数据库表
npx wrangler d1 execute beecount-cloud --remote --file=./schema.sql
```

## 本地开发

```bash
# 安装依赖
npm install

# 启动本地开发服务器
npm run dev

# 本地开发需要先创建本地 D1 数据库
npx wrangler d1 create beecount-cloud --local
npx wrangler d1 execute beecount-cloud --local --file=./schema.sql
```

## 项目结构

```
beecount-cloud-workers/
├── src/
│   ├── index.ts           # 入口文件，路由注册和管理员初始化
│   ├── auth.ts            # JWT 工具函数
│   └── routes/            # API 路由处理器
│       ├── auth.ts        # 认证
│       ├── two_factor.ts  # 双因素认证/TOTP
│       ├── sync.ts        # 移动端同步
│       ├── read.ts        # 查询端点
│       ├── write.ts       # 写入端点（包含默认分类创建）
│       ├── workspace.ts   # 跨账本查询
│       ├── batch_write.ts # 批量操作
│       ├── attachments.ts # 文件上传（S3）
│       ├── ai.ts          # AI 集成
│       ├── import_data.ts # CSV 导入
│       ├── backup.ts      # 快照
│       ├── admin_backup.ts # 管理员备份管理
│       └── admin.ts       # 管理员端点（包含修改密码功能）
├── schema.sql             # D1 数据库 Schema
├── wrangler.toml          # Cloudflare 配置
├── setup.sh               # 一键部署脚本
└── .github/workflows/     # CI/CD 自动部署
```

## 许可证

MIT
