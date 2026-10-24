/**
 * 附件「是否仍被引用」判定 —— 对齐上游 projection._fileid_still_referenced /
 * _fileid_still_referenced_in_ledger（只按 cloudFileId 精确匹配）。
 *
 * 本地历史上曾额外按 `sha_<sha256>.jpg` 文件名匹配，导致同 sha 冗余行
 * （同一照片重复上传）被误判为「仍被引用」而永远清不掉。修复采用保守方案：
 * - 该 sha 在 scope 内仅 1 行（正常数据）：sha 文件名引用可归属到本行，
 *   参与判定 —— 保护「仅 fileName 无 cloudFileId」的旧版 App 数据不被误删；
 * - 该 sha 多行（冗余）：sha 引用无法归属到具体行，退化为只按 cloudFileId
 *   判定；若存在「仅 fileName 引用（无 cloudFileId）」的残缺交易，整组保守保留。
 *
 * scope 二选一：ledgerId（删除/GC 路径，对齐 _fileid_still_referenced_in_ledger）
 * 或 userId（admin 数据清理 B1，对齐 _fileid_still_referenced）。
 */
export interface AttachmentReferenceOptions {
  db: D1Database;
  fileId: string;
  sha256?: string | null;
  scope: { ledgerId?: string; userId?: string };
  kind?: string;
  checkCategoryIcon?: boolean;
}

export async function isAttachmentStillReferenced(
  opts: AttachmentReferenceOptions,
): Promise<boolean> {
  const {
    db,
    fileId,
    sha256,
    scope,
    kind = 'transaction',
    checkCategoryIcon = false,
  } = opts;
  const scopeVal = scope.ledgerId ?? scope.userId;
  if (!scopeVal) return false;
  const scopeCol = scope.ledgerId ? 'ledger_id' : 'user_id';

  const patNoSpace = `"cloudFileId":"${fileId}"`;
  const patWithSpace = `"cloudFileId": "${fileId}"`;

  // 1. cloudFileId 精确引用（主判据，上游语义）
  const cfHit = await db
    .prepare(
      `SELECT COUNT(*) as cnt FROM read_tx_projection
       WHERE ${scopeCol} = ? AND (INSTR(attachments_json, ?) > 0 OR INSTR(attachments_json, ?) > 0)`
    )
    .bind(scopeVal, patNoSpace, patWithSpace)
    .first<{ cnt: number }>();
  if (cfHit && cfHit.cnt > 0) return true;

  // category icon（仅 admin B1 用，对齐上游 _fileid_still_referenced）
  if (checkCategoryIcon && scope.userId) {
    const catHit = await db
      .prepare(
        `SELECT COUNT(*) as cnt FROM user_category_projection WHERE user_id = ? AND icon_cloud_file_id = ?`
      )
      .bind(scope.userId, fileId)
      .first<{ cnt: number }>();
    if (catHit && catHit.cnt > 0) return true;
  }

  if (!sha256) return false;

  // 2. 该 sha 在 scope 内的行数（含自身）
  const rowCount = await db
    .prepare(
      `SELECT COUNT(*) as cnt FROM attachment_files
       WHERE sha256 = ? AND attachment_kind = ? AND ${scopeCol} = ?`
    )
    .bind(sha256, kind, scopeVal)
    .first<{ cnt: number }>();
  const n = rowCount?.cnt ?? 0;
  if (n === 0) return false;

  const shaPat = `sha_${sha256}.jpg`;

  if (n === 1) {
    // 3. 单行：sha 文件名引用可归属到本行（旧版 App「仅 fileName」数据）
    const shaHit = await db
      .prepare(
        `SELECT COUNT(*) as cnt FROM read_tx_projection
         WHERE ${scopeCol} = ? AND INSTR(attachments_json, ?) > 0`
      )
      .bind(scopeVal, shaPat)
      .first<{ cnt: number }>();
    return (shaHit?.cnt ?? 0) > 0;
  }

  // 4. 多行冗余：存在「仅 fileName 引用（无 cloudFileId）」的残缺交易 → 整组保守保留
  const shaOnlyRef = await db
    .prepare(
      `SELECT COUNT(*) as cnt FROM read_tx_projection
       WHERE ${scopeCol} = ? AND INSTR(attachments_json, ?) > 0 AND INSTR(attachments_json, 'cloudFileId') = 0`
    )
    .bind(scopeVal, shaPat)
    .first<{ cnt: number }>();
  return (shaOnlyRef?.cnt ?? 0) > 0;
}
