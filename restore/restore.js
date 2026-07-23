#!/usr/bin/env node
/**
 * BeeCount Cloud 备份恢复脚本
 * 
 * 用法:
 *   node restore.js <backup.tar.gz> <beecount-data-dir>
 * 
 * 示例:
 *   node restore.js backup.tar.gz ./data
 * 
 * 这个脚本会:
 * 1. 解压 tar.gz 备份文件
 * 2. 将 db.json 数据导入到 db.sqlite3
 * 3. 复制附件到正确位置
 * 4. 准备好恢复目录
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const tar = require('tar');

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 2) {
    console.log('用法: node restore.js <backup.tar.gz> <beecount-data-dir>');
    console.log('示例: node restore.js backup.tar.gz ./data');
    process.exit(1);
  }
  
  const backupFile = args[0];
  const dataDir = args[1];
  
  if (!fs.existsSync(backupFile)) {
    console.error(`错误: 备份文件不存在: ${backupFile}`);
    process.exit(1);
  }
  
  // 创建临时目录
  const tempDir = path.join(dataDir, '_restore_temp');
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true });
  }
  fs.mkdirSync(tempDir, { recursive: true });
  
  console.log('1. 解压备份文件...');
  await tar.extract({
    file: backupFile,
    cwd: tempDir,
  });
  
  console.log('2. 检查备份内容...');
  const files = fs.readdirSync(tempDir);
  console.log('   备份文件:', files);
  
  // 检查是否有 db.json
  if (!files.includes('db.json')) {
    console.error('错误: 备份中没有 db.json 文件');
    process.exit(1);
  }
  
  // 读取 db.json
  console.log('3. 读取数据库数据...');
  const dbJson = JSON.parse(fs.readFileSync(path.join(tempDir, 'db.json'), 'utf8'));
  console.log('   表数量:', Object.keys(dbJson.tables).length);
  console.log('   总行数:', Object.values(dbJson.tables).reduce((sum, rows) => sum + rows.length, 0));
  
  // 创建 SQLite 数据库
  console.log('4. 创建 SQLite 数据库...');
  const sqlite3 = require('better-sqlite3');
  const dbPath = path.join(dataDir, 'db.sqlite3');
  
  // 备份现有数据库
  if (fs.existsSync(dbPath)) {
    const backupPath = dbPath + '.backup.' + Date.now();
    console.log('   备份现有数据库到:', backupPath);
    fs.copyFileSync(dbPath, backupPath);
  }
  
  const db = new sqlite3(dbPath);
  
  // 创建表结构
  console.log('5. 创建表结构...');
  const schemas = `
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      is_admin BOOLEAN DEFAULT 0 NOT NULL,
      is_enabled BOOLEAN DEFAULT 1 NOT NULL,
      created_at TEXT NOT NULL,
      totp_secret_encrypted TEXT,
      totp_enabled BOOLEAN DEFAULT 0 NOT NULL,
      totp_enabled_at TEXT
    );
    
    CREATE TABLE IF NOT EXISTS user_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT UNIQUE NOT NULL,
      display_name TEXT,
      avatar_file_id TEXT,
      avatar_version INTEGER DEFAULT 0,
      income_is_red BOOLEAN DEFAULT 1,
      theme_primary_color TEXT,
      appearance_json TEXT,
      ai_config_json TEXT,
      updated_at TEXT NOT NULL,
      primary_currency TEXT DEFAULT 'CNY'
    );
    
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT DEFAULT 'Unknown Device',
      platform TEXT DEFAULT 'unknown',
      app_version TEXT,
      os_version TEXT,
      device_model TEXT,
      last_ip TEXT,
      last_seen_at TEXT NOT NULL,
      revoked_at TEXT,
      created_at TEXT NOT NULL
    );
    
    CREATE TABLE IF NOT EXISTS ledgers (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      external_id TEXT NOT NULL,
      name TEXT,
      currency TEXT DEFAULT 'CNY' NOT NULL,
      role TEXT DEFAULT 'owner' NOT NULL,
      is_shared BOOLEAN DEFAULT 0 NOT NULL,
      invite_code TEXT,
      invite_expires_at TEXT,
      created_at TEXT NOT NULL,
      month_start_day INTEGER DEFAULT 1
    );
    
    CREATE TABLE IF NOT EXISTS ledger_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ledger_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT DEFAULT 'editor' NOT NULL,
      joined_at TEXT NOT NULL,
      UNIQUE(ledger_id, user_id)
    );
    
    CREATE TABLE IF NOT EXISTS ledger_invites (
      id TEXT PRIMARY KEY,
      ledger_id TEXT NOT NULL,
      code TEXT NOT NULL,
      target_role TEXT DEFAULT 'editor' NOT NULL,
      invited_by TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      used_by TEXT,
      created_at TEXT NOT NULL
    );
    
    CREATE TABLE IF NOT EXISTS sync_changes (
      change_id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      ledger_id TEXT,
      entity_type TEXT NOT NULL,
      entity_sync_id TEXT NOT NULL,
      action TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by_device_id TEXT,
      updated_by_user_id TEXT,
      scope TEXT DEFAULT 'ledger'
    );
    
    CREATE TABLE IF NOT EXISTS sync_cursors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      ledger_external_id TEXT NOT NULL,
      last_cursor INTEGER DEFAULT 0 NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, device_id, ledger_external_id)
    );
    
    CREATE TABLE IF NOT EXISTS attachment_files (
      id TEXT PRIMARY KEY,
      ledger_id TEXT,
      user_id TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      size_bytes INTEGER DEFAULT 0,
      mime_type TEXT,
      file_name TEXT,
      storage_path TEXT NOT NULL,
      attachment_kind TEXT DEFAULT 'transaction' NOT NULL,
      created_at TEXT NOT NULL
    );
    
    CREATE TABLE IF NOT EXISTS personal_access_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      token_hash TEXT UNIQUE NOT NULL,
      prefix TEXT NOT NULL,
      scopes_json TEXT DEFAULT '[]' NOT NULL,
      expires_at TEXT,
      last_used_at TEXT,
      last_used_ip TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL
    );
    
    CREATE TABLE IF NOT EXISTS backup_remotes (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      backend_type TEXT NOT NULL,
      config_summary TEXT NOT NULL,
      encrypted BOOLEAN DEFAULT 0 NOT NULL,
      last_test_at TEXT,
      last_test_ok BOOLEAN,
      last_test_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    
    CREATE TABLE IF NOT EXISTS backup_schedules (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      user_id TEXT NOT NULL,
      cron_expr TEXT NOT NULL,
      remote_ids TEXT,
      retention_days INTEGER DEFAULT 30,
      include_attachments BOOLEAN DEFAULT 1 NOT NULL,
      enabled BOOLEAN DEFAULT 1 NOT NULL,
      timezone_offset INTEGER DEFAULT 0,
      next_run_at TEXT,
      last_run_at TEXT,
      last_run_status TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    
    CREATE TABLE IF NOT EXISTS system_settings (
      id TEXT PRIMARY KEY,
      timezone_offset INTEGER DEFAULT 0,
      cloud_config_json TEXT,
      setup_completed BOOLEAN DEFAULT 0 NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    
    CREATE TABLE IF NOT EXISTS recovery_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL
    );
  `;
  
  db.exec(schemas);
  
  // 插入数据
  console.log('6. 导入数据...');
  for (const [tableName, rows] of Object.entries(dbJson.tables)) {
    if (!rows || rows.length === 0) continue;
    
    const columns = Object.keys(rows[0]);
    const placeholders = columns.map(() => '?').join(', ');
    const insertSql = `INSERT OR REPLACE INTO "${tableName}" (${columns.map(c => `"${c}"`).join(', ')}) VALUES (${placeholders})`;
    
    const insert = db.prepare(insertSql);
    
    const insertMany = db.transaction((items) => {
      for (const row of items) {
        const values = columns.map(col => {
          const val = row[col];
          if (val === null || val === undefined) return null;
          if (typeof val === 'boolean') return val ? 1 : 0;
          if (typeof val === 'object') return JSON.stringify(val);
          return val;
        });
        insert.run(...values);
      }
    });
    
    insertMany(rows);
    console.log(`   ${tableName}: ${rows.length} 行`);
  }
  
  // 复制附件
  console.log('7. 复制附件...');
  const attachmentsDir = path.join(dataDir, 'attachments');
  const avatarsDir = path.join(dataDir, 'avatars');
  
  if (fs.existsSync(path.join(tempDir, 'attachments'))) {
    fs.cpSync(path.join(tempDir, 'attachments'), attachmentsDir, { recursive: true });
    console.log('   附件已复制到:', attachmentsDir);
  }
  
  if (fs.existsSync(path.join(tempDir, 'avatars'))) {
    fs.cpSync(path.join(tempDir, 'avatars'), avatarsDir, { recursive: true });
    console.log('   头像已复制到:', avatarsDir);
  }
  
  // 关闭数据库
  db.close();
  
  // 清理临时目录
  console.log('8. 清理临时文件...');
  fs.rmSync(tempDir, { recursive: true });
  
  console.log('\n✅ 恢复完成!');
  console.log('数据库已更新:', dbPath);
  console.log('请重启 BeeCount Cloud 服务。');
}

main().catch(err => {
  console.error('错误:', err);
  process.exit(1);
});
