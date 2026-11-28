/**
 * 周期账单交接（对齐上游 1.10.1+ src/recurring_handoff.py，#148）。
 *
 * App 端周期规则迁移到 Cloud：把 App 本地已生成的周期流水（按日期分组）
 * 与 Cloud 已执行的周期交易做稳定身份映射（uuid5 稳定 ID + 精确入账日期），
 * 未交接的流水仍由 App 上传，Cloud 接管后续生成。
 */

import { createHash, createHmac } from 'node:crypto';

export const RECURRING_SOURCE_PREFIX = 'beecount.recurring.';

const NAMESPACE_URL_BYTES = new Uint8Array([
  0x6b, 0xa7, 0xb8, 0x11, 0x9d, 0xad, 0x11, 0xd1,
  0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8,
]);

/** RFC 4122 name-based UUID v5（SHA-1），与 Python uuid.uuid5(NAMESPACE_URL, name) 一致。 */
export function uuid5(namespaceBytes: Uint8Array, name: string): string {
  const nameBytes = new TextEncoder().encode(name);
  const data = new Uint8Array(namespaceBytes.length + nameBytes.length);
  data.set(namespaceBytes, 0);
  data.set(nameBytes, namespaceBytes.length);
  const digest = new Uint8Array(createHash('sha1').update(data).digest());
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = Array.from(digest).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function historySourceId(syncId: string): string {
  return uuid5(NAMESPACE_URL_BYTES, syncId);
}

function jsonValue(json: string | null | undefined, key: string): string | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const v = parsed[key];
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

/** 上游 last_imported_dates：按规则取本地最近一次入账日期。 */
export async function lastImportedDates(
  db: D1Database,
  ledgerId: string,
  ruleId?: string
): Promise<Record<string, string>> {
  let sql =
    `SELECT source_system, MAX(json_extract(metadata_json, '$.date')) AS day
     FROM mcp_source_references
     WHERE ledger_id = ? AND source_system LIKE '${RECURRING_SOURCE_PREFIX}%'
     GROUP BY source_system`;
  const params: string[] = [ledgerId];
  if (ruleId !== undefined) {
    sql += ` AND source_system = ?`;
    params.push(RECURRING_SOURCE_PREFIX + ruleId);
  }
  const rows = await db.prepare(sql).bind(...params).all<{ source_system: string; day: string | null }>();
  const out: Record<string, string> = {};
  for (const row of rows.results ?? []) {
    if (row.day) out[row.source_system.slice(RECURRING_SOURCE_PREFIX.length)] = row.day;
  }
  return out;
}

export interface HandoffItem {
  sync_id: string;
  date: string;
}

export interface LocalPeriodResult {
  mapping: Record<string, string>;
  deleted: string[];
  requiredUploads: string[];
}

/** 上游 local_periods：本地流水 ↔ Cloud 流水的稳定映射。 */
export async function localPeriods(
  db: D1Database,
  ledger: { id: string },
  user: { id: string },
  ruleId: string,
  config: { time_zone: string },
  items: HandoffItem[],
  opts: { commit?: boolean } = {}
): Promise<Record<string, string>> {
  if (items.length === 0) return {};
  const source = RECURRING_SOURCE_PREFIX + ruleId;
  const candidates = new Map<string, Set<string>>();
  const known = new Set<string>();
  const refs = await db
    .prepare(
      `SELECT tx_sync_id, metadata_json FROM mcp_source_references
       WHERE ledger_id = ? AND source_system = ?`
    )
    .bind(ledger.id, source)
    .all<{ tx_sync_id: string; metadata_json: string | null }>();
  for (const ref of refs.results ?? []) {
    known.add(ref.tx_sync_id);
    const day = jsonValue(ref.metadata_json, 'date');
    if (day) {
      const set = candidates.get(day) ?? new Set<string>();
      set.add(ref.tx_sync_id);
      candidates.set(day, set);
    }
  }
  // Cloud 已完成的周期执行也算已知（普通交易被删除也不丢）
  const prefix = 'recurring:' + ruleId + ':';
  const operations = await db
    .prepare(
      `SELECT request_key, results_json FROM mcp_write_operations
       WHERE ledger_id = ? AND request_key LIKE ? AND status = 'completed'`
    )
    .bind(ledger.id, prefix + '%')
    .all<{ request_key: string; results_json: string | null }>();
  for (const operation of operations.results ?? []) {
    const instant = operation.request_key.slice(prefix.length);
    const parsed = new Date(
      `${instant.slice(0, 4)}-${instant.slice(4, 6)}-${instant.slice(6, 8)}T${instant.slice(9, 11)}:${instant.slice(11, 13)}:${instant.slice(13, 15)}Z`
    );
    const day = new Date(parsed.getTime())
      .toLocaleDateString('sv-SE', { timeZone: config.time_zone });
    let results: Array<Record<string, unknown>> = [];
    try {
      results = JSON.parse(operation.results_json ?? '[]') as Array<Record<string, unknown>>;
    } catch { /* ignore */ }
    for (const result of results) {
      const ids = (result.created_sync_ids as string[] | undefined) ??
        [result.entity_id as string].filter(Boolean);
      if (ids && ids[0]) {
        known.add(ids[0]);
        const set = candidates.get(day) ?? new Set<string>();
        set.add(ids[0]);
        candidates.set(day, set);
      }
    }
  }

  const byId = new Map<string, string>();
  for (const item of items) {
    byId.set(item.sync_id, item.date);
  }
  if (byId.size !== items.length) {
    throw new Error('HISTORY_CONFLICT: duplicate transaction identities in local history');
  }
  const counts = new Map<string, number>();
  for (const day of byId.values()) counts.set(day, (counts.get(day) ?? 0) + 1);

  const mappings: Record<string, string> = {};
  const sourceRefs: Array<{ source_id: string; tx_sync_id: string; date: string }> = [];
  for (const [sid, day] of byId) {
    const matches = candidates.get(day);
    if (known.has(sid)) {
      mappings[sid] = sid;
      continue;
    }
    if (!matches || matches.size === 0) {
      mappings[sid] = sid;
      if (opts.commit) {
        sourceRefs.push({ source_id: 'history:' + historySourceId(sid), tx_sync_id: sid, date: day });
      }
      continue;
    }
    if (matches.size !== 1 || (counts.get(day) ?? 0) !== 1) {
      throw new Error('HISTORY_CONFLICT: several transactions share this date');
    }
    const already = await db
      .prepare('SELECT sync_id FROM read_tx_projection WHERE ledger_id = ? AND sync_id = ?')
      .bind(ledger.id, sid)
      .first();
    if (already) {
      throw new Error('Already synchronized copies for the same period must be reviewed in the ledger');
    }
    mappings[sid] = [...matches][0];
  }

  if (opts.commit && sourceRefs.length > 0) {
    const statements = sourceRefs.map((ref) =>
      db
        .prepare(
          `INSERT INTO mcp_source_references
           (id, ledger_id, user_id, source_system, source_id, tx_sync_id, created_by_user_id, metadata_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          randomId(),
          ledger.id,
          user.id,
          source,
          ref.source_id,
          ref.tx_sync_id,
          user.id,
          JSON.stringify({ date: ref.date })
        )
    );
    for (let i = 0; i < statements.length; i += 100) {
      await db.batch(statements.slice(i, i + 100));
    }
  }
  return mappings;
}

function randomId(): string {
  return crypto.randomUUID();
}

/** 上游 handoff_upload_state：读取每次重试时的当前准入状态。 */
export async function handoffUploadState(
  db: D1Database,
  ledgerId: string,
  mappings: Record<string, string>
): Promise<{ required_uploads: string[]; deleted_transactions: string[] }> {
  // 只有「映射到自身」的 sid 才需要上传/核对（映射到 Cloud 已有交易的不用）
  const candidates = Object.entries(mappings)
    .filter(([sid, canonical]) => sid === canonical)
    .map(([sid]) => sid);
  const uploads: string[] = [];
  const deleted: string[] = [];
  for (let i = 0; i < candidates.length; i += 400) {
    const page = candidates.slice(i, i + 400);
    const placeholders = page.map(() => '?').join(',');
    const present = await db
      .prepare(
        `SELECT sync_id FROM read_tx_projection WHERE ledger_id = ? AND sync_id IN (${placeholders})`
      )
      .bind(ledgerId, ...page)
      .all<{ sync_id: string }>();
    const presentIds = new Set((present.results ?? []).map((r) => r.sync_id));
    const missing = page.filter((sid) => !presentIds.has(sid));
    const latest = new Map<string, string>();
    if (missing.length > 0) {
      const placeholders2 = missing.map(() => '?').join(',');
      const rows = await db
        .prepare(
          `SELECT entity_sync_id, action FROM sync_changes
           WHERE ledger_id = ? AND entity_type = 'transaction' AND entity_sync_id IN (${placeholders2})
           ORDER BY change_id`
        )
        .bind(ledgerId, ...missing)
        .all<{ entity_sync_id: string; action: string }>();
      for (const row of rows.results ?? []) latest.set(row.entity_sync_id, row.action);
    }
    for (const sid of page) {
      if (latest.get(sid) === 'delete') deleted.push(sid);
      else if (!presentIds.has(sid) && !latest.has(sid)) uploads.push(sid);
    }
  }
  return { required_uploads: uploads, deleted_transactions: deleted };
}

/** 上游 receipt：已提交的交接回执（幂等重放）。 */
export async function handoffReceipt(
  db: D1Database,
  key: string | null | undefined
): Promise<Record<string, unknown> | null> {
  if (!key) return null;
  const row = await db
    .prepare(
      `SELECT ledger_id, data_json, kind FROM mcp_state_records WHERE id = ?`
    )
    .bind(key)
    .first<{ ledger_id: string; data_json: string; kind: string }>();
  if (!row || row.kind !== 'recurring_handoff') return null;
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(row.data_json) as Record<string, unknown>;
  } catch {
    return null;
  }
  const mappings = (data.transactions ?? {}) as Record<string, string>;
  const admission = await handoffUploadState(db, row.ledger_id, mappings);
  return {
    id: data.rule_id,
    handoff_confirmed: true,
    local_transactions: mappings,
    ...admission,
  };
}

/** 上游 check_mobile_push：拦截不兼容的老客户端对受周期账单保护账本的推送。 */
export async function checkMobilePush(
  db: D1Database,
  ledgerIds: string[],
  changes: Array<{ ledger_id?: string | null; entity_type: string; action?: string; entity_sync_id?: string; payload?: unknown }>,
  protocol: string | null | undefined
): Promise<void> {
  const financial = new Set<string>();
  for (const c of changes) {
    if (c.action !== 'delete' && (c.entity_type === 'transaction' || c.entity_type === 'ledger_snapshot') && c.ledger_id) {
      financial.add(c.ledger_id);
    }
  }
  if (financial.size === 0) return;
  const financialArr = [...financial];
  const ledgerArr = ledgerIds.length > 0 ? ledgerIds : ['__none__'];
  const ledgerPh = ledgerArr.map(() => '?').join(',');
  const finPh = financialArr.map(() => '?').join(',');
  const protectedMap = new Map<string, string>();
  const rows = await db
    .prepare(
      `SELECT external_id, id FROM ledgers
       WHERE id IN (${ledgerPh}) AND external_id IN (${finPh}) AND id IN (
         SELECT ledger_id FROM mcp_state_records
         WHERE kind = 'recurring_handoff'
            OR (kind = 'recurring_rule'
                AND json_extract(data_json, '$.rule.creation_hash') IS NOT NULL
                AND json_extract(data_json, '$.rule.creation_hash') != '')
       )`
    )
    .bind(...ledgerArr, ...financialArr)
    .all<{ external_id: string; id: string }>();
  for (const row of rows.results ?? []) protectedMap.set(row.external_id, row.id);
  if (protectedMap.size === 0) return;
  if (protocol !== 'cloud-v1') {
    const e = new Error('Update BeeCount to sync a ledger with Cloud recurring rules') as Error & { status?: number };
    e.status = 426;
    throw e;
  }
  for (const change of changes) {
    const internalId = change.ledger_id ? protectedMap.get(change.ledger_id) : undefined;
    if (!internalId || change.action === 'delete') continue;
    let items: Array<{ syncId?: string; localRecurringOrigin?: unknown }> = [];
    if (change.entity_type === 'transaction') {
      const payload = change.payload as Record<string, unknown> | null | undefined;
      items = [{ syncId: change.entity_sync_id, localRecurringOrigin: payload?.localRecurringOrigin }];
    } else if (change.entity_type === 'ledger_snapshot') {
      try {
        const payload = change.payload as Record<string, unknown> | null;
        const content = typeof payload?.content === 'string'
          ? (JSON.parse(payload.content) as { items?: Array<Record<string, unknown>> })
          : (payload?.content as { items?: Array<Record<string, unknown>> } | undefined);
        items = (content?.items ?? []) as Array<{ syncId?: string; localRecurringOrigin?: unknown }>;
      } catch {
        const e = new Error('Invalid ledger snapshot') as Error & { status?: number };
        e.status = 422;
        throw e;
      }
    } else {
      continue;
    }
    for (const item of items) {
      if (!item.localRecurringOrigin) continue;
      const sid = item.syncId;
      if (!sid) continue;
      const knownRow = await db
        .prepare('SELECT sync_id FROM read_tx_projection WHERE ledger_id = ? AND sync_id = ?')
        .bind(internalId, sid)
        .first();
      if (knownRow) continue;
      const lastAction = await db
        .prepare(
          `SELECT action FROM sync_changes
           WHERE ledger_id = ? AND entity_type = 'transaction' AND entity_sync_id = ?
           ORDER BY change_id DESC LIMIT 1`
        )
        .bind(internalId, sid)
        .first<{ action: string }>();
      if (lastAction?.action === 'delete') {
        if (change.entity_type === 'transaction'
            && (change.payload as Record<string, unknown> | null)?.restoredSnapshot === true) {
          // push 主循环会拒绝这个过期恢复，不丢弃整批
          continue;
        }
        const e = new Error('HISTORY_CONFLICT: this recurring transaction was deleted in Cloud') as Error & { status?: number };
        e.status = 409;
        throw e;
      }
      const sourceKnown = await db
        .prepare(
          `SELECT id FROM mcp_source_references
           WHERE ledger_id = ? AND tx_sync_id = ? AND source_system LIKE '${RECURRING_SOURCE_PREFIX}%'`
        )
        .bind(internalId, sid)
        .first();
      if (sourceKnown) continue;
      const e = new Error('Review this device\'s pending local recurring transactions before syncing') as Error & { status?: number };
      e.status = 409;
      throw e;
    }
  }
}
