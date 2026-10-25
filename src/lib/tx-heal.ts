/**
 * 同步自愈 —— 修复「缺字段交易变更」。
 *
 * 背景：#B5 补偿事故。B5 附件收敛曾写出只含 attachments 的 transaction upsert
 * change（payload 缺 amount/happenedAt 等），设备端覆盖式应用后把交易清成
 * 0 元/空日期。服务器投影无损但设备端已坏。
 *
 * 机制：pull 时检测「该实体最新一条 upsert 缺 amount 字段」的坏变更，从
 * read_tx_projection 读完整字段补写一条完整 payload 的 upsert change
 * （updated_by_device_id = NULL，pull 放行）。设备端下次同步覆盖即恢复，
 * 无需任何手动操作。补写后该实体最新 upsert 已完整，天然幂等。
 */
import { buildTxUpsertPayload, TX_PROJECTION_COLS, type TxProjectionRow } from './tx-upsert-payload';

/** 判断 upsert payload 是否完整（缺 amount 即视为坏变更，正常交易必有 amount） */
function hasAmount(payloadJson: string): boolean {
  return payloadJson.includes('"amount"');
}

/**
 * 对给定账本执行自愈，返回补写的变更数。
 * ledgerIds 为内部 ledger id 列表（空则跳过）。
 */
export async function healBrokenTxUpserts(
  db: D1Database,
  ledgerIds: string[],
): Promise<number> {
  const ids = [...new Set(ledgerIds)].filter(Boolean);
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => '?').join(',');

  // 坏变更：transaction upsert 且缺 amount，且是该实体最新一条 upsert
  const broken = await db.prepare(
    `SELECT sc.change_id, sc.ledger_id, sc.entity_sync_id, sc.user_id
     FROM sync_changes sc
     WHERE sc.entity_type = 'transaction' AND sc.action = 'upsert'
       AND sc.ledger_id IN (${placeholders})
       AND INSTR(sc.payload_json, '"amount"') = 0
       AND sc.change_id = (
         SELECT MAX(s2.change_id) FROM sync_changes s2
         WHERE s2.entity_type = 'transaction' AND s2.action = 'upsert'
           AND s2.ledger_id = sc.ledger_id
           AND s2.entity_sync_id = sc.entity_sync_id
       )
     LIMIT 500`
  ).bind(...ids).all<{
    change_id: number;
    ledger_id: string;
    entity_sync_id: string;
    user_id: string;
  }>();

  if (broken.results.length === 0) return 0;

  // 批量读投影完整字段，构造完整 upsert 补写
  const stmts: ReturnType<D1Database['prepare']>[] = [];

  for (const b of broken.results) {
    const tx = await db.prepare(
      `SELECT ${TX_PROJECTION_COLS} FROM read_tx_projection
       WHERE ledger_id = ? AND sync_id = ?`
    ).bind(b.ledger_id, b.entity_sync_id).first<TxProjectionRow>();
    if (!tx) continue; // 投影已删（交易已删）→ 无需修复

    const payload = buildTxUpsertPayload(tx);
    const now = new Date().toISOString();
    stmts.push(db.prepare(
      `INSERT INTO sync_changes
       (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_device_id, updated_by_user_id, scope)
       VALUES (?, ?, 'transaction', ?, 'upsert', ?, ?, NULL, ?, 'ledger')`
    ).bind(b.user_id, b.ledger_id, b.entity_sync_id, payload, now, b.user_id));
  }

  if (stmts.length === 0) return 0;
  for (let i = 0; i < stmts.length; i += 100) {
    await db.batch(stmts.slice(i, i + 100));
  }
  return stmts.length;
}