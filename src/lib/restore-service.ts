/**
 * Workers 版本的备份恢复服务
 * 
 * 原版用 Docker + rclone：下载 → 解包到本地目录 → shell 命令替换文件
 * Workers 版本：R2 读取 → 内存解压 → D1 导入 → R2 上传
 */

// 配置 zip.js 必须先于其他导入
import { configure } from '@zip.js/zip.js';
configure({ useWebWorkers: false });
import { ZipReader, Uint8ArrayReader, Uint8ArrayWriter } from '@zip.js/zip.js/index-native.js';
import { readSqliteToTables } from './sqlite-writer';

/**
 * 统一归档内文件名：原版 tar 用 arcname='.' 会产生 './db.sqlite3' 前缀，去掉
 */
function normalizeEntryName(name: string): string {
  return name.replace(/^\.\//, '');
}

export interface RestoreProgress {
  phase: 'downloading' | 'importing' | 'uploading' | 'done' | 'failed';
  bytesTransferred: number;
  bytesTotal: number;
  message?: string;
}

export interface RestoreResult {
  success: boolean;
  message: string;
  tablesImported: number;
  rowsImported: number;
  attachmentsUploaded: number;
}

/**
 * 从 R2 下载备份并解析
 * 支持格式：
 *   - .zip（AES-256 加密 ZIP，使用 @zip.js/zip.js）
 *   - .enc（AES-256-GCM 加密 tar.gz）
 *   - .tar.gz（未加密 tar.gz）
 */
async function downloadAndExtractBackup(
  r2: R2Bucket,
  backupPath: string,
  password?: string,
  preloadedData?: Uint8Array,
): Promise<{ meta: any; tables: Record<string, unknown[]>; attachments: Map<string, Uint8Array> }> {
  // 下载备份文件
  let data: Uint8Array;
  if (preloadedData) {
    data = preloadedData;
  } else {
    const obj = await r2.get(backupPath);
    if (!obj) throw new Error(`Backup not found: ${backupPath}`);
    data = new Uint8Array(await obj.arrayBuffer());
  }
  let entries: { name: string; size: number; data: Uint8Array }[];

  // 判断是否为 ZIP 格式（PK\x03\x04 开头）
  const isZip = data.length > 2 && data[0] === 0x50 && data[1] === 0x4b;

  if (isZip) {
    // ZIP 格式（AES-256 加密 ZIP）
    if (!password) {
      throw new Error('Encrypted backup requires password');
    }
    const reader = new ZipReader(new Uint8ArrayReader(data));
    const zipEntries = await reader.getEntries();
    entries = [];
    for (const ze of zipEntries) {
      if (ze.directory) continue;
      const writer = new Uint8ArrayWriter();
      await ze.getData?.(writer, { password });
      const fileData = writer.getData() as unknown as Uint8Array;
      const normalized = normalizeEntryName(ze.filename);
      if (normalized) entries.push({ name: normalized, size: fileData.length, data: fileData });
    }
    await reader.close();
  } else if (data.length > 10) {
    // age 加密格式（ASCII armored 或二进制格式）
    const header = new TextDecoder().decode(data.slice(0, 40));
    const isAge = header.includes('age-encryption.org') || header.startsWith('-----BEGIN AGE');
    if (isAge) {
      if (!password) {
        throw new Error('Encrypted backup requires password');
      }
      const { decryptData } = await import('./encryption');
      data = new Uint8Array(await decryptData(data, password));
      const decompressed = await decompressGzip(data);
      entries = parseTar(decompressed);
    } else if (backupPath.endsWith('.enc')) {
      // AES-256-GCM 加密 tar.gz
      if (!password) {
        throw new Error('Encrypted backup requires password');
      }
      const { decryptData } = await import('./encryption');
      data = new Uint8Array(await decryptData(data, password));
      const decompressed = await decompressGzip(data);
      entries = parseTar(decompressed);
    } else {
      // 未加密 tar.gz
      const decompressed = await decompressGzip(data);
      entries = parseTar(decompressed);
    }
  } else {
    // 无法识别的格式
    entries = [];
  }

  // 提取 meta.json
  const metaEntry = entries.find(e => e.name === 'meta.json');
  const meta = metaEntry ? JSON.parse(new TextDecoder().decode(metaEntry.data)) : {};

  // 提取附件
  const attachments = new Map<string, Uint8Array>();
  for (const entry of entries) {
    if (entry.name.startsWith('attachments/') || entry.name.startsWith('avatars/')) {
      attachments.set(entry.name, entry.data);
    }
  }

  // 数据来源优先 db.json（老 TS 备份格式，向后兼容）；否则读 db.sqlite3（原版格式）
  let tables: Record<string, unknown[]> = {};
  const dbJsonEntry = entries.find(e => e.name === 'db.json');
  if (dbJsonEntry) {
    const dbJson = JSON.parse(new TextDecoder().decode(dbJsonEntry.data));
    tables = dbJson.tables || {};
  } else {
    const sqliteEntry = entries.find(e => e.name === 'db.sqlite3');
    if (sqliteEntry) {
      const { tables: sqliteTables } = await readSqliteToTables(sqliteEntry.data);
      tables = sqliteTables;
    }
  }

  return { meta, tables, attachments };
}

/**
 * gzip 解压
 */
async function decompressGzip(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  writer.write(data);
  writer.close();
  
  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  
  let totalLength = 0;
  for (const chunk of chunks) totalLength += chunk.length;
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/**
 * 简易 tar 解析器
 */
function parseTar(data: Uint8Array): { name: string; size: number; data: Uint8Array }[] {
  const entries: { name: string; size: number; data: Uint8Array }[] = [];
  let offset = 0;
  
  while (offset < data.length - 512) {
    const header = data.slice(offset, offset + 512);
    const name = new TextDecoder().decode(header.slice(0, 100)).replace(/\0/g, '');
    if (!name) break;
    
    const sizeOctal = new TextDecoder().decode(header.slice(124, 136)).replace(/\0/g, '').trim();
    const size = parseInt(sizeOctal, 8) || 0;
    
    const contentOffset = offset + 512;
    const fileData = data.slice(contentOffset, contentOffset + size);
    
    if (name !== '.' && name !== './') {
      const normalized = normalizeEntryName(name);
      if (normalized) {
        entries.push({ name: normalized, size, data: fileData });
      }
    }
    
    offset = contentOffset + Math.ceil(size / 512) * 512;
  }
  
  return entries;
}

/**
 * 导入数据到 D1
 * 策略：先查表的实际列，只导入匹配的列，保留原始 user_id
 * userIdMapping: 备份中旧 user_id → 现有用户实际 user_id 的映射（按邮箱匹配）
 */
async function importToD1(
  db: D1Database,
  tables: Record<string, unknown[]>,
  userIdMapping?: Record<string, string>,
): Promise<{ tablesImported: number; rowsImported: number; errors: string[] }> {
  let tablesImported = 0;
  let rowsImported = 0;
  const errors: string[] = [];

  // 获取 D1 中已存在的表
  const existingTablesResult = await db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all<{ name: string }>();
  const existingTableNames = new Set((existingTablesResult.results || []).map(r => r.name));

  const tableNames = Object.keys(tables);
  for (const tableName of tableNames) {
    const rows = tables[tableName];
    if (!Array.isArray(rows) || rows.length === 0) continue;

    // 跳过运维表，这些是运行时数据，不应被备份覆盖
    const SKIP_TABLES = new Set(['backup_runs', 'backup_run_targets', 'backup_restores', 'backup_snapshots', 'sync_cursors', 'sync_push_idempotency', 'mcp_call_logs']);
    if (SKIP_TABLES.has(tableName)) {
      console.debug(`[Restore] Skipping ${tableName}: operational table`);
      continue;
    }

    // 跳过 D1 中不存在的表
    if (!existingTableNames.has(tableName)) {
      console.debug(`[Restore] Skipping table ${tableName}: not found in D1`);
      continue;
    }

    // 获取表的实际列
    const tableInfoResult = await db.prepare(`PRAGMA table_info("${tableName}")`).all<{ name: string; pk: number }>();
    const tableInfoRows = tableInfoResult.results || [];
    const dbColumns = new Set(tableInfoRows.map(c => c.name));

    // 获取备份中的列名
    const firstRow = rows[0] as Record<string, unknown>;
    if (!firstRow || typeof firstRow !== 'object') continue;
    const backupColumns = Object.keys(firstRow);

    // 只使用 D1 表中存在的列
    const matchedColumns = backupColumns.filter(col => dbColumns.has(col));
    if (matchedColumns.length === 0) {
      console.debug(`[Restore] Skipping table ${tableName}: no matching columns`);
      continue;
    }

    // 如果备份列多于 D1 列，记录差异
    const missingInD1 = backupColumns.filter(col => !dbColumns.has(col));
    if (missingInD1.length > 0) {
      console.debug(`[Restore] ${tableName}: skipping columns: ${missingInD1.join(', ')}`);
    }

    // 获取主键列（用于 INSERT OR REPLACE）
    const pkColumns = tableInfoRows.filter(c => c.pk > 0).map(c => c.name);
    const useReplace = pkColumns.length > 0;

    // 批量插入（每批最多 100 条，避免超过 Workers 子请求限制）
    let importedCount = 0;
    const BATCH_SIZE = 100;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const stmts: D1PreparedStatement[] = [];
      
      for (const row of batch) {
        const record = row as Record<string, unknown>;
        // 如果指定了 userIdMapping，替换 user_id 列
        if (userIdMapping && matchedColumns.includes('user_id') && record['user_id'] && userIdMapping[String(record['user_id'])]) {
          record['user_id'] = userIdMapping[String(record['user_id'])];
        }
        // users 表：跳过已存在邮箱的用户
        if (tableName === 'users' && userIdMapping && record['id'] && userIdMapping[String(record['id'])]) {
          continue;
        }
        // users 表：保留现有用户的 password_hash
        if (tableName === 'users' && record['id']) {
          const existingUser = await db.prepare('SELECT id FROM users WHERE id = ?').bind(record['id']).first<{ id: string }>();
          if (existingUser) {
            const skipPassword = matchedColumns.indexOf('password_hash');
            if (skipPassword >= 0) {
              matchedColumns.splice(skipPassword, 1);
            }
          }
        }
        const values = matchedColumns.map(col => record[col] ?? null);
        if (useReplace) {
          stmts.push(db.prepare(`INSERT OR REPLACE INTO "${tableName}" (${matchedColumns.map(c => `"${c}"`).join(',')}) VALUES (${matchedColumns.map(() => '?').join(',')})`).bind(...values));
        } else {
          stmts.push(db.prepare(`INSERT INTO "${tableName}" (${matchedColumns.map(c => `"${c}"`).join(',')}) VALUES (${matchedColumns.map(() => '?').join(',')})`).bind(...values));
        }
      }
      
      if (stmts.length > 0) {
        try {
          await db.batch(stmts);
          importedCount += stmts.length;
        } catch (e) {
          errors.push(`${tableName} batch ${Math.floor(i / BATCH_SIZE) + 1}: ${(e as Error).message}`);
        }
      }
    }

    if (importedCount > 0) {
      tablesImported++;
      rowsImported += importedCount;
      console.debug(`[Restore] ${tableName}: ${importedCount}/${rows.length} rows imported`);
    }
  }

  return { tablesImported, rowsImported, errors };
}

/**
 * 上传附件到 R2
 *
 * 对齐原版：附件落库的 storage_path（attachment_files.storage_path，形如
 * beecount/attachments/...）必须与 R2 实际 key 一致，下载时才能按表行命中。
 * 备份 tar 内的附件 key 是无前缀的相对路径（attachments/...），上传时补上
 * beecount/ 前缀，与 attachment_files 表行对齐（index.ts 打包时按 R2 真实
 * key 打包，见 createTarGzStream 的附件收集——两者必须同一约定）。
 */
async function uploadAttachments(
  r2: R2Bucket,
  attachments: Map<string, Uint8Array>,
): Promise<{ uploaded: number; uploadedKeys: string[] }> {
  let uploaded = 0;
  const uploadedKeys: string[] = [];

  for (const [key, data] of attachments) {
    try {
      // 统一加 beecount/ 前缀：与 attachment_files 表行对齐（index.ts 打包同约定）
      const r2Key = key.startsWith('beecount/') ? key : `beecount/${key}`;
      await r2.put(r2Key, data);
      uploaded++;
      uploadedKeys.push(r2Key);
    } catch (err) {
      console.error(`[Restore] Failed to upload ${key}: ${(err as Error).message}`);
    }
  }

  return { uploaded, uploadedKeys };
}

/**
 * 恢复后把 attachment_files.storage_path 改写为与 R2 实际 key 一致。
 *
 * 原因：原版备份的 storage_path 是绝对路径（/data/attachments/<user>/<ledger_ext>/<sha[:2]>/<uuid>_<name>），
 * 直接导入后下载端按 storage_path 拼 R2 key 永远 404（beecount/data/... ≠ beecount/attachments/...）。
 * 这里按「文件名尾段」关联——原版附件文件名 uuid4.hex 随机唯一，与附件 id 不同，只能按文件名匹配。
 * worker 自己备份的 storage_path 已是 beecount/ 格式，匹配后不变（幂等）。
 */
async function remapAttachmentStoragePaths(
  db: D1Database,
  uploadedKeys: string[],
): Promise<number> {
  if (uploadedKeys.length === 0) return 0;
  const rows = await db.prepare(
    `SELECT id, storage_path FROM attachment_files WHERE storage_path IS NOT NULL AND storage_path != ''`
  ).all<{ id: string; storage_path: string }>();

  // 文件名尾段 → 实际 R2 key（同一个文件名可能在多个 key 中出现，取最后一个）
  const keyByFileName = new Map<string, string>();
  for (const key of uploadedKeys) {
    const fileName = key.split('/').pop();
    if (fileName) keyByFileName.set(fileName, key);
  }

  let updated = 0;
  for (const row of rows.results) {
    const fileName = row.storage_path.split('/').pop();
    if (!fileName) continue;
    const targetKey = keyByFileName.get(fileName);
    if (!targetKey || targetKey === row.storage_path) continue;
    await db.prepare('UPDATE attachment_files SET storage_path = ? WHERE id = ?')
      .bind(targetKey, row.id).run();
    updated++;
  }
  return updated;
}

/**
 * 执行完整的恢复流程
 */
export async function performRestore(
  db: D1Database,
  r2: R2Bucket,
  backupPath: string,
  onProgress?: (progress: RestoreProgress) => void,
  password?: string,
  preloadedData?: Uint8Array,
): Promise<RestoreResult> {
  try {
    // 禁用外键约束，防止 INSERT OR REPLACE 触发 ON DELETE CASCADE 删除关联数据
    await db.prepare('PRAGMA foreign_keys = OFF').run();

    // Phase 1: 下载并解压（支持加密备份）
    onProgress?.({ phase: 'downloading', bytesTransferred: 0, bytesTotal: 0 });
    
    const { meta, tables, attachments } = await downloadAndExtractBackup(r2, backupPath, password, preloadedData);
    
    const totalBytes = Object.values(tables).reduce((sum, rows) => sum + rows.length, 0) * 500; // 估算
    onProgress?.({ phase: 'downloading', bytesTransferred: totalBytes, bytesTotal: totalBytes });
    
    // Phase 2: 导入数据到 D1
    onProgress?.({ phase: 'importing', bytesTransferred: 0, bytesTotal: totalBytes });

    // 按邮箱匹配用户：如果备份中的用户 email 已存在于 D1，将备份数据映射到现有用户
    let userIdMapping: Record<string, string> | undefined;
    const backupUsers = tables['users'] as Record<string, unknown>[] | undefined;
    if (backupUsers && backupUsers.length > 0) {
      const existingUsers = await db.prepare('SELECT id, email FROM users').all<{ id: string; email: string }>();
      const emailToId: Record<string, string> = {};
      for (const eu of (existingUsers.results || [])) {
        emailToId[eu.email.toLowerCase()] = eu.id;
      }
      userIdMapping = {};
      let hasMatchingEmail = false;
      for (const bu of backupUsers) {
        const buEmail = String(bu.email || '').toLowerCase();
        if (buEmail && emailToId[buEmail]) {
          userIdMapping[String(bu.id)] = emailToId[buEmail];
          hasMatchingEmail = true;
        }
      }
      // 不跳过 users 表，importToD1 中会跳过已存在邮箱的用户行
    }

    const { tablesImported, rowsImported, errors } = await importToD1(db, tables, userIdMapping);

    const errMsg = errors.length > 0 ? ` (${errors.length} errors: ${errors.slice(0, 3).join('; ')})` : '';
    onProgress?.({ phase: 'importing', bytesTransferred: totalBytes, bytesTotal: totalBytes });

    const { uploaded: attachmentsUploaded, uploadedKeys } = await uploadAttachments(r2, attachments);
    // 对齐附件表行：把 storage_path 改写为实际上传的 R2 key（原版绝对路径 → beecount/ 格式）
    const remapped = await remapAttachmentStoragePaths(db, uploadedKeys);

    // 重新启用外键约束
    await db.prepare('PRAGMA foreign_keys = ON').run();

    onProgress?.({ phase: 'uploading', bytesTransferred: attachmentsUploaded, bytesTotal: attachments.size });

    onProgress?.({ phase: 'done', bytesTransferred: 0, bytesTotal: 0 });

    return {
      success: true,
      message: `Restored ${tablesImported} tables, ${rowsImported} rows, ${attachmentsUploaded} attachments, ${remapped} storage_path remapped${errMsg}`,
      tablesImported,
      rowsImported,
      attachmentsUploaded,
    };
  } catch (err) {
    const message = (err as Error).message;
    onProgress?.({ phase: 'failed', bytesTransferred: 0, bytesTotal: 0, message });
    return {
      success: false,
      message,
      tablesImported: 0,
      rowsImported: 0,
      attachmentsUploaded: 0,
    };
  }
}
