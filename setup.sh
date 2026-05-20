#!/bin/bash
# BeeCount Cloud Workers 一键部署脚本

set -e

echo "🐝 BeeCount Cloud Workers 部署脚本"
echo "======================================"

# 检查是否已登录
echo "🔍 检查 Cloudflare 登录状态..."
if ! npx wrangler whoami &> /dev/null; then
    echo "📝 请先登录 Cloudflare"
    npx wrangler login
fi

# 检查是否已有 D1 数据库
echo "🔍 检查 D1 数据库..."
DB_EXISTS=$(npx wrangler d1 list 2>&1 | grep -E "beecount-cloud|b0da0464-f186-4114-a291-9dd7d0b7a1d5" || true)

if [ -z "$DB_EXISTS" ]; then
    echo "🆕 创建新的 D1 数据库..."
    DB_OUTPUT=$(npx wrangler d1 create beecount-cloud 2>&1)
    echo "$DB_OUTPUT"
    
    # 提取 database_id
    DB_ID=$(echo "$DB_OUTPUT" | grep -o 'database_id = "[^"]*"' | cut -d'"' -f2)
    
    if [ -z "$DB_ID" ]; then
        echo "❌ 无法获取数据库 ID，请手动创建"
        exit 1
    fi
    
    echo "✅ 数据库创建成功，ID: $DB_ID"
    
    # 更新 wrangler.toml
    echo "📝 更新 wrangler.toml..."
    sed -i.bak "s/database_id = \".*\"/database_id = \"$DB_ID\"/" wrangler.toml
    rm -f wrangler.toml.bak
    
    echo "⏳ 等待数据库就绪..."
    sleep 5
    
    # 初始化数据库表
    echo "🗄️ 初始化数据库表..."
    npx wrangler d1 execute beecount-cloud --remote --file=./schema.sql
else
    echo "✅ D1 数据库已存在"
fi

# 部署
echo "🚀 开始部署..."
npm run deploy

echo ""
echo "======================================"
echo "✅ 部署完成！"
echo "📝 首次访问时会自动创建管理员账户"
echo "🔍 请在 Cloudflare Dashboard 的 Workers 日志中查看管理员密码"
echo "======================================"
