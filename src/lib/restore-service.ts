/**
 * Workers 版本的备份恢复服务
 * 
 * 原版用 Docker + rclone：下载 → 解包到本地目录 → shell 命令替换文件
 * Workers 版本：R2 读取 → 内存解压 → D1 导入 → R2 上传
 */

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
 * 从 R2 下载备份并解析 tar.gz
 */
async function downloadAndExtractBackup(
  r2: R2Bucket,
  backupPath: string,
): Promise<{ meta: any; tables: Record<string, unknown[]>; attachments: Map<string, Uint8Array> }> {
  // 下载 tar.gz
  const obj = await r2.get(backupPath);
  if (!obj) throw new Error(`Backup not found: ${backupPath}`);
  
  const arrayBuffer = await obj.arrayBuffer();
  const data = new Uint8Array(arrayBuffer);
  
  // 解压 gzip
  const decompressed = await decompressGzip(data);
  
  // 解析 tar
  const entries = parseTar(decompressed);
  
  // 提取 meta.json
  const metaEntry = entries.find(e => e.name === 'meta.json');
  const meta = metaEntry ? JSON.parse(new TextDecoder().decode(metaEntry.data)) : {};
  
  // 提取 db.json
  const dbJsonEntry = entries.find(e => e.name === 'db.json');
  const dbJson = dbJsonEntry ? JSON.parse(new TextDecoder().decode(dbJsonEntry.data)) : {};
  
  // 提取附件
  const attachments = new Map<string, Uint8Array>();
  for (const entry of entries) {
    if (entry.name.startsWith('attachments/') || entry.name.startsWith('avatars/')) {
      attachments.set(entry.name, entry.data);
    }
  }
  
  return { meta, tables: dbJson.tables || {}, attachments };
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
      entries.push({ name, size, data: fileData });
    }
    
    offset = contentOffset + Math.ceil(size / 512) * 512;
  }
  
  return entries;
}

/**
 * 导入数据到 D1
 * 策略：先查表的实际列，只导入匹配的列
 * targetUserId: 如果指定，会替换所有 user_id 列为当前用户（恢复后数据归属当前用户）
 */
async function importToD1(
  db: D1Database,
  tables: Record<string, unknown[]>,
  targetUserId?: string,
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

    // 逐行插入（避免批量中某行失败导致整批丢失）
    let importedCount = 0;
    for (const row of rows) {
      const record = row as Record<string, unknown>;
      // 如果指定了 targetUserId，替换 user_id 列（恢复后数据归属当前用户）
      if (targetUserId && matchedColumns.includes('user_id')) {
        record['user_id'] = targetUserId;
      }
      const values = matchedColumns.map(col => record[col] ?? null);

      try {
        if (useReplace) {
          await db.prepare(`INSERT OR REPLACE INTO "${tableName}" (${matchedColumns.map(c => `"${c}"`).join(',')}) VALUES (${matchedColumns.map(() => '?').join(',')})`)
            .bind(...values).run();
        } else {
          await db.prepare(`INSERT INTO "${tableName}" (${matchedColumns.map(c => `"${c}"`).join(',')}) VALUES (${matchedColumns.map(() => '?').join(',')})`)
            .bind(...values).run();
        }
        importedCount++;
      } catch (err) {
        const msg = `[Restore] ${tableName}: ${(err as Error).message}`;
        console.error(msg);
        errors.push(msg);
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
 */
async function uploadAttachments(
  r2: R2Bucket,
  attachments: Map<string, Uint8Array>,
): Promise<number> {
  let uploaded = 0;
  
  for (const [key, data] of attachments) {
    try {
      await r2.put(key, data);
      uploaded++;
    } catch (err) {
      console.error(`[Restore] Failed to upload ${key}: ${(err as Error).message}`);
    }
  }
  
  return uploaded;
}

/**
 * 执行完整的恢复流程
 */
export async function performRestore(
  db: D1Database,
  r2: R2Bucket,
  backupPath: string,
  onProgress?: (progress: RestoreProgress) => void,
  targetUserId?: string,
): Promise<RestoreResult> {
  try {
    // Phase 1: 下载并解压
    onProgress?.({ phase: 'downloading', bytesTransferred: 0, bytesTotal: 0 });
    
    const { meta, tables, attachments } = await downloadAndExtractBackup(r2, backupPath);
    
    const totalBytes = Object.values(tables).reduce((sum, rows) => sum + rows.length, 0) * 500; // 估算
    onProgress?.({ phase: 'downloading', bytesTransferred: totalBytes, bytesTotal: totalBytes });
    
    // Phase 2: 导入数据到 D1
    onProgress?.({ phase: 'importing', bytesTransferred: 0, bytesTotal: totalBytes });
    
    const { tablesImported, rowsImported, errors } = await importToD1(db, tables, targetUserId);

    const errMsg = errors.length > 0 ? ` (${errors.length} errors: ${errors.slice(0, 3).join('; ')})` : '';
    onProgress?.({ phase: 'importing', bytesTransferred: totalBytes, bytesTotal: totalBytes });

    const attachmentsUploaded = await uploadAttachments(r2, attachments);

    onProgress?.({ phase: 'uploading', bytesTransferred: attachmentsUploaded, bytesTotal: attachments.size });

    onProgress?.({ phase: 'done', bytesTransferred: 0, bytesTotal: 0 });

    return {
      success: true,
      message: `Restored ${tablesImported} tables, ${rowsImported} rows, ${attachmentsUploaded} attachments${errMsg}`,
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
