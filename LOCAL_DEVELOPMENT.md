# BeeCount Cloud Workers 本地开发指南

## 环境要求

- Node.js 18+ 
- npm 或 yarn
- Cloudflare Wrangler CLI (`npm install -g wrangler`)

## 本地开发步骤

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

复制示例配置文件并根据需要修改：

```bash
cp .dev.vars.example .dev.vars
```

**重要**：
- 本地开发可以直接使用 `.dev.vars.example` 中的默认 JWT_SECRET
- 生产环境部署时**必须使用强密码**（至少 32 字节）

### 3. 启动本地开发服务器

```bash
npm run dev
```

这将启动 Wrangler dev server，通常在 `http://localhost:8787` 运行。

### 4. 访问应用

- 主应用界面：`http://localhost:8787`
- API 端点：`http://localhost:8787/api/v1/...`
- 健康检查：`http://localhost:8787/healthz`

## 本地数据库

### 使用远程 D1 数据库（推荐用于开发）

项目已配置使用远程 Cloudflare D1 数据库：
- **数据库名称**: `beecount-cloud`
- **数据库 ID**: `b0da0464-f186-4114-a291-9dd7d0b7a1d5`

无需额外配置，直接运行 `npm run dev` 即可使用远程数据库。

### 创建本地 D1 数据库（可选）

如果你想在本地测试数据库操作：

```bash
# 创建本地数据库
wrangler d1 create beecount-cloud-local

# 将返回的 database_id 填入 wrangler.toml
```

### 管理数据库

```bash
# 查看数据库表结构
wrangler d1 execute beecount-cloud --command "SELECT name FROM sqlite_master WHERE type='table';"

# 执行 SQL 查询
wrangler d1 execute beecount-cloud --command "SELECT * FROM users LIMIT 10;"
```

## 测试 API

### 登录获取 token

```bash
curl -X POST http://localhost:8787/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "your@email.com", "password": "yourpassword"}'
```

### 使用 token 访问受保护的端点

```bash
curl http://localhost:8787/api/v1/read/ledgers \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

### 同步 API

```bash
# 拉取变更
curl "http://localhost:8787/api/v1/sync/pull?since=0&limit=100" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"

# 推送变更
curl -X POST http://localhost:8787/api/v1/sync/push \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"device_id": "your-device-id", "changes": []}'
```

## 调试技巧

### 查看日志

Wrangler dev server 会自动在终端显示请求日志。

### 添加控制台日志

在代码中使用 `console.log()`：

```typescript
console.log('[DEBUG] Request received:', req);
```

### 热重载

Wrangler dev server 支持热重载，修改代码后会自动重新加载。

## 生产部署

### 部署到 Cloudflare Workers

```bash
# 确保已登录 Cloudflare
wrangler login

# 部署
npm run deploy
```

### 环境变量

生产环境的 JWT_SECRET 必须设置为一个强密码：

```bash
# 方式 1：使用 Cloudflare Dashboard
# 在 Workers & Pages -> 设置 -> 环境变量中设置

# 方式 2：使用 CLI
wrangler secret put JWT_SECRET
# 输入强密码（至少 32 字节）

# 方式 3：部署时指定
JWT_SECRET="your-strong-secret" npm run deploy
```

## 常见问题

### Q: Wrangler dev 启动失败？
A: 确保：
1. Node.js 版本 >= 18
2. 已安装依赖：`npm install`
3. Wrangler 版本正确：`npx wrangler --version`

### Q: 数据库连接失败？
A: 
1. 检查网络连接
2. 确认 D1 数据库存在且 ID 正确
3. 查看 Cloudflare Dashboard 中的 D1 使用情况

### Q: JWT 验证失败？
A: 确保 `.dev.vars` 中的 JWT_SECRET 与生产环境一致。

## 相关资源

- [Cloudflare Workers 文档](https://developers.cloudflare.com/workers/)
- [D1 数据库文档](https://developers.cloudflare.com/d1/)
- [Wrangler CLI 文档](https://developers.cloudflare.com/workers/wrangler/)
