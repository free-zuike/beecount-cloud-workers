# BeeCount Cloud 备份恢复脚本

## 问题说明

由于 Cloudflare Workers 环境限制，sql.js WASM 无法正常工作，导致备份中的 `db.sqlite3` 文件只包含 schema 而不包含数据。

本脚本可以将备份中的 `db.json` 数据导入到真正的 SQLite 数据库中。

## 使用方法

### 1. 安装依赖

```bash
cd restore
npm install
```

### 2. 恢复备份

```bash
node restore.js <backup.tar.gz> <beecount-data-dir>
```

示例：
```bash
# 恢复到本地 BeeCount Cloud 数据目录
node restore.js ../beecount_backups_xxx.tar.gz /path/to/beecount/data

# 恢复到 Docker volume
node restore.js ../beecount_backups_xxx.tar.gz /var/lib/docker/volumes/beecount_data/_data
```

### 3. 重启服务

```bash
# Docker Compose
docker compose restart

# 或直接重启
systemctl restart beecount
```

## 恢复过程

1. 解压 tar.gz 备份文件
2. 备份现有 db.sqlite3
3. 创建新的 SQLite 数据库
4. 从 db.json 导入所有表数据
5. 复制附件和头像文件
6. 清理临时文件

## 注意事项

- 恢复前会自动备份现有数据库
- 恢复后需要重启服务
- 附件文件会被覆盖（如果同名文件已存在）
- 建议在恢复前手动备份整个数据目录

## 自动化恢复

如果需要自动化恢复，可以将脚本集成到 CI/CD 流程中：

```bash
#!/bin/bash
BACKUP_FILE=$1
DATA_DIR=/path/to/beecount/data

# 停止服务
docker compose stop

# 恢复备份
node restore.js $BACKUP_FILE $DATA_DIR

# 启动服务
docker compose start
```
