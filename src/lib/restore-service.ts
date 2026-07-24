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
    const name = header.slice(0, 100).toString('utf8').replace(/\0/g, '');
    if (!name) break;
    
    const sizeOctal = header.slice(124, 136).toString('utf8').replace(/\0/g, '').trim();
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
 */
async function importToD1(
  db: D1Database,
  tables: Record<string, unknown[]>,
): Promise<{ tablesImported: number; rowsImported: number }> {
  let tablesImported = 0;
  let rowsImported = 0;
  
  const tableNames = Object.keys(tables);
  for (const tableName of tableNames) {
    const rows = tables[tableName];
    if (!Array.isArray(rows) || rows.length === 0) continue;
    
    // 获取列名
    const firstRow = rows[0] as Record<string, unknown>;
    if (!firstRow || typeof firstRow !== 'object') continue;
    const columns = Object.keys(firstRow);
    if (columns.length === 0) continue;
    
    // 先清空表（备份恢复是全量替换）
    try {
      await db.prepare(`DELETE FROM "${tableName}"`).run();
    } catch {
      // 表可能不存在
    }
    
    // 批量插入（每批 100 行）
    const batchSize = 100;
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      const placeholders = batch.map(() => `(${columns.map(() => '?').join(',')})`).join(',');
      const values = batch.flatMap(row => {
        const record = row as Record<string, unknown>;
        return columns.map(col => record[col] ?? null);
      });
      
      try {
        await db.prepare(`INSERT INTO "${tableName}" (${columns.map(c => `"${c}"`).join(',')}) VALUES ${placeholders}`)
          .bind(...values)
          .run();
        rowsImported += batch.length;
      } catch (err) {
        console.error(`[Restore] Failed to import batch for ${tableName}: ${(err as Error).message}`);
      }
    }
    
    tablesImported++;
  }
  
  return { tablesImported, rowsImported };
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
): Promise<RestoreResult> {
  try {
    // Phase 1: 下载并解压
    onProgress?.({ phase: 'downloading', bytesTransferred: 0, bytesTotal: 0 });
    
    const { meta, tables, attachments } = await downloadAndExtractBackup(r2, backupPath);
    
    const totalBytes = Object.values(tables).reduce((sum, rows) => sum + rows.length, 0) * 500; // 估算
    onProgress?.({ phase: 'downloading', bytesTransferred: totalBytes, bytesTotal: totalBytes });
    
    // Phase 2: 导入数据到 D1
    onProgress?.({ phase: 'importing', bytesTransferred: 0, bytesTotal: totalBytes });
    
    const { tablesImported, rowsImported } = await importToD1(db, tables);
    
    onProgress?.({ phase: 'importing', bytesTransferred: totalBytes, bytesTotal: totalBytes });
    
    // Phase 3: 上传附件到 R2
    onProgress?.({ phase: 'uploading', bytesTransferred: 0, bytesTotal: attachments.size });
    
    const attachmentsUploaded = await uploadAttachments(r2, attachments);
    
    onProgress?.({ phase: 'uploading', bytesTransferred: attachmentsUploaded, bytesTotal: attachments.size });
    
    // Phase 4: 完成
    onProgress?.({ phase: 'done', bytesTransferred: 0, bytesTotal: 0 });
    
    return {
      success: true,
      message: `Restored ${tablesImported} tables, ${rowsImported} rows, ${attachmentsUploaded} attachments`,
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
