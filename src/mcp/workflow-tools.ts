/**
 * 瀵煎叆/瀵硅处/鎸佷箙鍖栧伐浣滄祦宸ュ叿锛堝榻愬師鐗?src/mcp/workflow_tools.py锛?133锛夈€? *
 * - preview_import锛氱増鏈寲 dry-run锛堢簿纭潵婧愯瘑鍒?existing锛屽悓鏃ュ悓棰濅粎 review 鍊欓€夛級
 * - execute_import_plan / undo_import_plan锛氬箓绛夋墽琛屼笌瀹夊叏鎾ら攢锛堟潵婧愰摼鎺ュ箓绛夛級
 * - reconcile_account / save_reconciliation_checkpoint锛氬璐︽牎楠屼笌鎸佷箙鍖栨鏌ョ偣
 * - link/unlink/list_transaction_sources锛氭潵婧愬紩鐢ㄧ鐞嗭紙淇濈暀鏈熶簰鏂ワ級
 *
 * 渚濊禆 capability_tools锛坮equire_ledger/run_write/get_account_balances锛夈€? * operations锛堝啓璁″垝锛夈€乼ransaction_service锛坧repare_transaction锛夈€? */
import { uuid4, revision, parseDateBoundary } from './query-context';
import { requireLedger, runWrite, getAccountBalances } from './capability-tools';
import { findOperation } from './operations';
import { prepareTransaction, listLiveLedgers } from './transaction-service';
import { serializeTx } from './tools/read-tools';
import { validateImportCandidate, validateSourceInput } from './validation';
import type { McpContext, LedgerInfo } from './types';

export interface SourceInput {
  source_system: string;
  source_id: string;
  order_id?: string | null;
  file_sha256?: string | null;
  row_number?: number | null;
}

export interface ImportCandidate {
  transaction: Record<string, unknown>;
  sources?: SourceInput[];
  action?: 'create' | 'link' | 'skip';
  existing_sync_id?: string | null;
  allow_similar?: boolean;
}

interface MCPStateRow {
  id: string;
  user_id: string;
  ledger_id: string;
  kind: string;
  revision: number;
  status: string;
  data_json: string | null;
  next_due_at: string | null;
  created_at: string;
  updated_at: string;
}

interface MCPSourceRow {
  id: string;
  ledger_id: string;
  tx_sync_id: string;
  source_system: string;
  source_id: string;
  metadata_json: string | null;
  created_by_user_id: string;
  created_at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === 'object' && 'message' in err
    && String((err as { message: unknown }).message).includes('UNIQUE');
}

export function recordOut(row: MCPStateRow): Record<string, unknown> {
  // 对齐上游 record_out（1.9.0 实测）：data 是**对象**，只有落库时才序列化成
  // data_json；时间用 isoformat(+00:00)
  let data: unknown = null;
  if (row.data_json) {
    try {
      data = JSON.parse(row.data_json);
    } catch {
      data = row.data_json;
    }
  }
  return {
    id: row.id,
    ledger_internal_id: row.ledger_id,
    kind: row.kind,
    revision: row.revision,
    status: row.status,
    data,
    next_due_at: row.next_due_at ? `${new Date(row.next_due_at).toISOString().replace(/Z$/, '+00:00')}` : null,
    created_at: `${new Date(row.created_at).toISOString().replace(/Z$/, '+00:00')}`,
    updated_at: `${new Date(row.updated_at).toISOString().replace(/Z$/, '+00:00')}`,
  };
}

/** 鍔犺浇璁板綍骞舵牎楠屽綋鍓嶈处鏈垚鍛橈紙write 鍒欒姹?owner/editor锛夈€?*/
export async function loadRecord(
  c: McpContext,
  recordId: string,
  opts: { kind?: string; write?: boolean } = {},
): Promise<[MCPStateRow, LedgerInfo]> {
  const row = await c.db.prepare('SELECT * FROM mcp_state_records WHERE id = ?').bind(recordId).first<MCPStateRow>();
  if (!row || (opts.kind && row.kind !== opts.kind)) throw new Error('Record not found');
  const ledger = await c.db.prepare('SELECT id, user_id, external_id, name, currency FROM ledgers WHERE id = ?')
    .bind(row.ledger_id).first<LedgerInfo>();
  if (!ledger) throw new Error('Record not found');
  await requireLedger(c, ledger.external_id, { write: opts.write });
  return [row, ledger];
}

/** 鎸佷箙鍖栬褰曪紙鍒涘缓鎴栧甫淇鐨勬洿鏂帮級锛屽啓瀹¤鏃ュ織銆備緵 rule/file 妯″潡澶嶇敤銆?*/
export async function saveRecord(
  c: McpContext,
  ledger: LedgerInfo,
  opts: {
    kind: string;
    data: Record<string, unknown>;
    record_id?: string | null;
    expected_revision?: number | null;
    status?: string;
    next_due_at?: string | null;
  },
): Promise<Record<string, unknown>> {
  const { db, userId } = c;
  const now = nowIso();
  await requireLedger(c, ledger.external_id, { write: true });
  if (opts.record_id) {
    const [row] = await loadRecord(c, opts.record_id, { kind: opts.kind, write: true });
    if (row.ledger_id !== ledger.id || opts.expected_revision === undefined || opts.expected_revision === null) {
      throw new Error('Updates require the matching ledger and expected_revision');
    }
    if (opts.kind === 'import_plan' && (row.user_id !== userId || ['executing', 'completed', 'undone'].includes(row.status))) {
      throw new Error('An executing/completed import plan cannot be edited; create a new preview');
    }
    const before = recordOut(row);
    const updated = await db.prepare(
      `UPDATE mcp_state_records SET data_json = ?, status = ?, revision = revision + 1, updated_at = ?, next_due_at = ?
       WHERE id = ? AND revision = ?`
    ).bind(JSON.stringify(opts.data), opts.status ?? row.status, now, opts.next_due_at ?? null, opts.record_id, opts.expected_revision).run();
    if (updated.meta.changes === 0) throw new Error('REVISION_CONFLICT: workflow record changed');
    const afterRow = await db.prepare('SELECT * FROM mcp_state_records WHERE id = ?').bind(opts.record_id).first<MCPStateRow>();
    await db.prepare(
      `INSERT INTO audit_logs (user_id, ledger_id, action, metadata_json, created_at) VALUES (?, ?, ?, ?, ?)`
    ).bind(userId, ledger.id, 'mcp_workflow_' + opts.kind, JSON.stringify({ record_id: opts.record_id, before, after: recordOut(afterRow!) }), now).run();
    return recordOut(afterRow!);
  }
  const [id, inserted] = [uuid4(), nowIso()];
  await db.prepare(
    `INSERT INTO mcp_state_records (id, user_id, ledger_id, kind, revision, status, data_json, next_due_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`
  ).bind(id, userId, ledger.id, opts.kind, opts.status ?? 'open', JSON.stringify(opts.data), opts.next_due_at ?? null, inserted, inserted).run();
  const row = await db.prepare('SELECT * FROM mcp_state_records WHERE id = ?').bind(id).first<MCPStateRow>();
  await db.prepare(
    `INSERT INTO audit_logs (user_id, ledger_id, action, metadata_json, created_at) VALUES (?, ?, ?, ?, ?)`
  ).bind(userId, ledger.id, 'mcp_workflow_' + opts.kind, JSON.stringify({ record_id: id, before: null, after: recordOut(row!) }), inserted).run();
  return recordOut(row!);
}

export async function listWorkflowRecords(
  c: McpContext,
  args: { ledger_id: string; kind: string; status?: string | null; limit?: number; offset?: number },
): Promise<Record<string, unknown>> {
  const ledger = await requireLedger(c, args.ledger_id);
  let q = 'SELECT * FROM mcp_state_records WHERE ledger_id = ? AND kind = ?';
  const p: unknown[] = [ledger.id, args.kind];
  if (args.status) { q += ' AND status = ?'; p.push(args.status); }
  const total = (await c.db.prepare(q.replace('SELECT *', 'SELECT COUNT(*) AS c')).bind(...p).first<{ c: number }>())?.c ?? 0;
  const limit = Math.max(1, Math.min(args.limit ?? 50, 100));
  const offset = Math.max(0, args.offset ?? 0);
  q += ' ORDER BY created_at DESC, id LIMIT ? OFFSET ?';
  p.push(limit, offset);
  const rows = await c.db.prepare(q).bind(...p).all<MCPStateRow>();
  return { items: rows.results.map(recordOut), total };
}

export async function getWorkflowRecord(c: McpContext, args: { record_id: string }): Promise<Record<string, unknown>> {
  const [row, ledger] = await loadRecord(c, args.record_id);
  return { ...recordOut(row), ledger_id: ledger.external_id };
}

function sourceOut(row: MCPSourceRow): Record<string, unknown> {
  return {
    id: row.id,
    sync_id: row.tx_sync_id,
    source_system: row.source_system,
    source_id: row.source_id,
    // 对齐上游 _source_out：metadata 是原始 JSON 字符串
    metadata: row.metadata_json ?? null,
  };
}

function sourceMeta(source: SourceInput): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  if (source.order_id !== undefined && source.order_id !== null) meta.order_id = source.order_id;
  if (source.file_sha256) meta.file_sha256 = source.file_sha256;
  if (source.row_number !== undefined && source.row_number !== null) meta.row_number = source.row_number;
  return meta;
}

/** 閾炬帴鏉ユ簮锛堝箓绛夛紱淇濈暀涓殑瀵煎叆鏉ユ簮鍙崌绾т负鐪熷疄閾炬帴锛夈€?*/
async function linkSource(
  db: D1Database,
  userId: string,
  ledger: LedgerInfo,
  syncId: string,
  source: SourceInput,
  importPlanId?: string,
): Promise<Record<string, unknown>> {
  const tx = await db.prepare('SELECT 1 FROM read_tx_projection WHERE ledger_id = ? AND sync_id = ?')
    .bind(ledger.id, syncId).first();
  if (!tx) throw new Error('Source target transaction not found');
  const existing = await db.prepare(
    'SELECT * FROM mcp_source_references WHERE ledger_id = ? AND source_system = ? AND source_id = ?'
  ).bind(ledger.id, source.source_system, source.source_id).first<MCPSourceRow>();
  if (existing) {
    const metadata = existing.metadata_json ? JSON.parse(existing.metadata_json) as Record<string, unknown> : {};
    if (importPlanId && metadata._reserved && metadata.import_plan_id === importPlanId) {
      const cleared: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(metadata)) if (k !== '_reserved') cleared[k] = v;
      await db.prepare('UPDATE mcp_source_references SET tx_sync_id = ?, metadata_json = ? WHERE id = ?')
        .bind(syncId, JSON.stringify(cleared), existing.id).run();
      return sourceOut({ ...existing, tx_sync_id: syncId, metadata_json: JSON.stringify(cleared) });
    }
    if (existing.tx_sync_id !== syncId) {
      throw new Error('SOURCE_CONFLICT: external identity already belongs to another transaction');
    }
    return sourceOut(existing);
  }
  const id = uuid4();
  const now = nowIso();
  await db.prepare(
    `INSERT INTO mcp_source_references (id, ledger_id, tx_sync_id, source_system, source_id, metadata_json, created_by_user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, ledger.id, syncId, source.source_system, source.source_id, JSON.stringify(sourceMeta(source)), userId, now).run();
  await db.prepare(
    `INSERT INTO audit_logs (user_id, ledger_id, action, metadata_json, created_at) VALUES (?, ?, ?, ?, ?)`
  ).bind(userId, ledger.id, 'mcp_source_link', JSON.stringify({ reference_id: id, sync_id: syncId }), now).run();
  return sourceOut({ id, ledger_id: ledger.id, tx_sync_id: syncId, source_system: source.source_system, source_id: source.source_id, metadata_json: JSON.stringify(sourceMeta(source)), created_by_user_id: userId, created_at: now });
}

export async function linkTransactionSource(
  c: McpContext,
  args: { ledger_id: string; sync_id: string; source: SourceInput },
): Promise<Record<string, unknown>> {
  // 对齐上游 SourceInput：字段长度/定长 sha256/未知键在入口拦住
  validateSourceInput(args.source as unknown as Record<string, unknown>, 0);
  const ledger = await requireLedger(c, args.ledger_id, { write: true });
  try {
    return await linkSource(c.db, c.userId, ledger, args.sync_id, args.source);
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      throw new Error('SOURCE_CONFLICT: source was linked concurrently; read it before retrying');
    }
    throw err;
  }
}

export async function listTransactionSources(
  c: McpContext,
  args: { ledger_id: string; sync_id: string },
): Promise<Array<Record<string, unknown>>> {
  const ledger = await requireLedger(c, args.ledger_id);
  const rows = await c.db.prepare(
    'SELECT * FROM mcp_source_references WHERE ledger_id = ? AND tx_sync_id = ?'
  ).bind(ledger.id, args.sync_id).all<MCPSourceRow>();
  return rows.results.map(sourceOut);
}

export async function previewImport(
  c: McpContext,
  args: { ledger_id: string; candidates: ImportCandidate[]; time_zone?: string | null; plan_id?: string | null; expected_revision?: number | null },
): Promise<Record<string, unknown>> {
  const { db, userId } = c;
  const timeZone = args.time_zone ?? null;
  if (!args.candidates || args.candidates.length < 1 || args.candidates.length > 200) {
    throw new Error('Import previews accept 1..200 candidates; split larger source files into plans');
  }
  // 对齐上游 ImportCandidate/SourceInput：action 枚举、sources ≤ 20、字段长度与 sha256 定长
  for (const [i, candidate] of args.candidates.entries()) {
    validateImportCandidate(candidate as unknown as Record<string, unknown>, i);
  }
  const ledger = await requireLedger(c, args.ledger_id, { write: true });
  const baseRevision = await revision(db, [ledger.id], ledger.user_id);
  const preview: Array<Record<string, unknown>> = [];
  const errors: Array<Record<string, unknown>> = [];
  const seenSources = new Set<string>();
  const balanceEffects: Record<string, number> = {};

  for (let index = 0; index < args.candidates.length; index++) {
    const candidate = args.candidates[index];
    // item 是候选对象的完整快照（上游 candidate.model_dump(mode="json")），
    // 所以字段与默认值必须与 ImportCandidate 一致：action/existing_sync_id/
    // allow_similar 有默认值，sources 里 order_id/file_sha256 也要显式给 null
    const sources = (candidate.sources ?? []).map(s => ({
      source_system: s.source_system,
      source_id: s.source_id,
      order_id: s.order_id ?? null,
      file_sha256: s.file_sha256 ?? null,
      row_number: s.row_number ?? null,
    }));
    const item: Record<string, unknown> = {
      // transaction 是 BatchTransactionItem 的完整 model_dump：缺省字段也要显式 null，
      // 不能只放 CSV 里出现的列
      transaction: {
        amount: 0, tx_type: 'expense', happened_at: null, note: null, category: null,
        account: null, tags: null, currency: null, category_id: null, account_id: null,
        from_account_id: null, to_account_id: null, from_account: null, to_account: null,
        native_amount: null, exclude_from_stats: false, exclude_from_budget: false,
        attachments: null,
        ...(candidate.transaction ?? {}),
      },
      sources,
      action: candidate.action ?? 'create',
      existing_sync_id: candidate.existing_sync_id ?? null,
      allow_similar: candidate.allow_similar ?? false,
      index,
      status: candidate.action === 'skip' ? 'skip' : 'ready',
      similar: [],
    };
    if (candidate.action === 'skip') { preview.push(item); continue; }

    const known: string[] = [];
    for (const source of candidate.sources ?? []) {
      const identity = `${source.source_system}\u0000${source.source_id}`;
      if (seenSources.has(identity)) errors.push({ index, code: 'DUPLICATE_SOURCE_IN_PLAN' });
      seenSources.add(identity);
      const ref = await db.prepare(
        'SELECT * FROM mcp_source_references WHERE ledger_id = ? AND source_system = ? AND source_id = ?'
      ).bind(ledger.id, source.source_system, source.source_id).first<MCPSourceRow>();
      if (ref) known.push(ref.tx_sync_id);
    }
    if (known.length > 0) {
      if (new Set(known).size !== 1 || (candidate.existing_sync_id && candidate.existing_sync_id !== known[0])) {
        errors.push({ index, code: 'SOURCE_CONFLICT' });
      } else {
        const target = await db.prepare('SELECT 1 FROM read_tx_projection WHERE ledger_id = ? AND sync_id = ?')
          .bind(ledger.id, known[0]).first();
        if (!target) errors.push({ index, code: 'SOURCE_TARGET_DELETED' });
        else item.status = 'existing';
        if (item.status === 'existing') item.existing_sync_id = known[0];
      }
    }
    if (candidate.action === 'link') {
      if (!candidate.existing_sync_id) {
        errors.push({ index, code: 'LINK_TARGET_NOT_FOUND' });
      } else {
        const target = await db.prepare('SELECT 1 FROM read_tx_projection WHERE ledger_id = ? AND sync_id = ?')
          .bind(ledger.id, candidate.existing_sync_id).first();
        if (!target) errors.push({ index, code: 'LINK_TARGET_NOT_FOUND' });
        else { item.status = 'link'; item.existing_sync_id = candidate.existing_sync_id; }
      }
    }
    try {
      const body = await prepareTransaction(c, ledger, { ...candidate.transaction }, { time_zone: timeZone });
      item.normalized = body;
      if (item.status === 'ready') {
        const stamp = new Date(body.happened_at as string);
        const dayBefore = new Date(stamp.getTime() - 24 * 3600 * 1000).toISOString();
        const dayAfter = new Date(stamp.getTime() + 24 * 3600 * 1000).toISOString();
        const matches = await db.prepare(
          `SELECT * FROM read_tx_projection WHERE ledger_id = ? AND tx_type = ? AND amount = ?
           AND happened_at >= ? AND happened_at <= ? LIMIT 10`
        ).bind(ledger.id, body.tx_type, body.amount, dayBefore, dayAfter).all<Record<string, unknown>>();
        item.similar = matches.results.map(r => serializeTx(r as never, (r.category_name as string | null) ?? null));
        if ((item.similar as unknown[]).length > 0 && !candidate.allow_similar) {
          item.status = 'review_required';
        }
        const amount = Number(body.amount);
        const effects: Array<[string | null, number]> = body.tx_type === 'transfer'
          ? [[body.from_account_id as string | null, -amount], [body.to_account_id as string | null, amount]]
          : [[body.account_id as string | null, body.tx_type === 'income' ? amount : -amount]];
        for (const [accountId, delta] of effects) {
          if (accountId) balanceEffects[accountId] = (balanceEffects[accountId] ?? 0) + delta;
        }
      }
    } catch (exc: unknown) {
      item.status = 'invalid';
      errors.push({ index, code: 'INVALID_TRANSACTION', message: exc instanceof Error ? exc.message : String(exc) });
    }
    preview.push(item);
  }

  if (await revision(db, [ledger.id], ledger.user_id) !== baseRevision) {
    throw new Error('REVISION_CONFLICT: data changed during preview; retry preview');
  }
  const ready = errors.length === 0 && !preview.some(item => item.status === 'review_required');
  const data: Record<string, unknown> = {
    base_revision: baseRevision,
    items: preview,
    errors,
    balance_effects: balanceEffects,
    time_zone: timeZone,
    ready,
  };
  const saved = await saveRecord(c, ledger, {
    kind: 'import_plan',
    data,
    record_id: args.plan_id ?? null,
    expected_revision: args.expected_revision ?? null,
    status: ready ? 'ready' : 'needs_review',
  });
  // 上游导入 plan 返回的 data 是**对象**，不是 JSON 字符串（只有落库时才序列化）
  return { ...(saved as Record<string, unknown>), data };
}

export async function executeImportPlan(
  c: McpContext,
  args: { plan_id: string; expected_revision?: number | null; confirm?: boolean },
): Promise<Record<string, unknown>> {
  const { db, userId } = c;
  const planId = args.plan_id;
  const expectedRevision = args.expected_revision ?? 0;
  // 对齐上游 execute_import_plan：未确认时回 status + plan_id（第 22 批误删 plan_id，此处修正）
  if (!args.confirm) return { status: 'confirmation_required', plan_id: planId };
  const [row, ledger] = await loadRecord(c, planId, { kind: 'import_plan', write: true });
  if (row.user_id !== userId) throw new Error('Only the preview creator can execute its import operation');
  if (row.revision !== expectedRevision) throw new Error('REVISION_CONFLICT: import plan version changed');
  const data = row.data_json ? JSON.parse(row.data_json) as Record<string, unknown> : {};
  if (!data.ready) throw new Error('Import plan contains unresolved errors or similar transactions');
  if (row.status === 'undone') throw new Error('Import plan was undone; create a new preview');

  const operation = await findOperation(db, {
    user_id: userId,
    key: `import:${planId}`,
    request: { plan_id: planId, plan_revision: expectedRevision },
    kind: 'import',
    ledger_id: ledger.id,
  });
  if (!operation && await revision(db, [ledger.id], ledger.user_id) !== data.base_revision) {
    throw new Error('REVISION_CONFLICT: ledger changed after preview; refresh the plan');
  }
  // 棰勭暀鏉ユ簮锛圲NIQUE 绾︽潫闃插苟鍙戞挒鍗曪級
  try {
    for (const item of data.items as Array<Record<string, unknown>>) {
      if (item.status === 'skip') continue;
      for (const raw of (item.sources as SourceInput[] | undefined) ?? []) {
        const source = raw as SourceInput;
        const reference = await db.prepare(
          'SELECT * FROM mcp_source_references WHERE ledger_id = ? AND source_system = ? AND source_id = ?'
        ).bind(ledger.id, source.source_system, source.source_id).first<MCPSourceRow>();
        if (reference) {
          const metadata = reference.metadata_json ? JSON.parse(reference.metadata_json) as Record<string, unknown> : {};
          const sameReservation = metadata.import_plan_id === planId;
          const sameTarget = item.existing_sync_id === reference.tx_sync_id;
          if (!sameReservation && !sameTarget) {
            throw new Error('SOURCE_CONFLICT: external identity changed after preview');
          }
        } else if (item.status === 'ready') {
          const id = uuid4();
          await db.prepare(
            `INSERT INTO mcp_source_references (id, ledger_id, tx_sync_id, source_system, source_id, metadata_json, created_by_user_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(id, ledger.id, `pending:${planId}:${item.index}`, source.source_system, source.source_id,
            JSON.stringify({ ...sourceMeta(source), import_plan_id: planId, _reserved: true }), userId, nowIso()).run();
        } else {
          await linkSource(db, userId, ledger, item.existing_sync_id as string, source);
        }
      }
    }
    await db.prepare(
      `UPDATE mcp_state_records SET status = 'executing', updated_at = ? WHERE id = ?`
    ).bind(nowIso(), planId).run();
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      throw new Error('SOURCE_CONFLICT: another import reserved this source; refresh preview');
    }
    throw err;
  }

  const items = data.items as Array<Record<string, unknown>>;
  const creates = items.filter(item => item.status === 'ready');
  const root = `/api/v1/write/ledgers/${ledger.external_id}/transactions/batch`;
  const bodies = creates.map(item => {
    const normalized = item.normalized as Record<string, unknown>;
    const { base_change_id, ...rest } = normalized;
    return rest;
  });
  const steps: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  for (let start = 0; start < bodies.length; start += 50) {
    steps.push({ method: 'POST', path: root, body: { base_change_id: 0, auto_ai_tag: false, transactions: bodies.slice(start, start + 50) } });
  }
  const outcome = await runWrite(c, ledger, {
    kind: 'import',
    request: { plan_id: planId, plan_revision: expectedRevision },
    steps,
    idempotency_key: `import:${planId}`,
  });
  if (outcome.status !== 'completed') return outcome;

  // 幂等重放标记是 write 路由注入的中间态字段，上游导入结果里不暴露
  if (Array.isArray(outcome.results)) {
    outcome.results = (outcome.results as Array<Record<string, unknown>>).map(r => {
      const { idempotency_replayed: _drop, ...rest } = r as Record<string, unknown>;
      return rest;
    });
  }

  const syncIds = (outcome.sync_ids as string[]) ?? [];
  const createdMap = new Map<number, string>();
  creates.forEach((item, i) => createdMap.set(item.index as number, syncIds[i]));
  const createdRevisions: Record<string, number> = {};
  const [row2] = await loadRecord(c, planId, { kind: 'import_plan', write: true });
  if (row2.revision !== expectedRevision) {
    throw new Error('REVISION_CONFLICT: plan changed while executing; operation is retained');
  }
  for (const item of items) {
    const createdSyncId = item.index !== undefined && createdMap.has(item.index as number)
      ? createdMap.get(item.index as number)
      : (item.existing_sync_id as string | undefined);
    if (!createdSyncId || item.status === 'skip') continue;
    for (const raw of (item.sources as SourceInput[] | undefined) ?? []) {
      await linkSource(db, userId, ledger, createdSyncId, raw as SourceInput, planId);
    }
    if (item.index !== undefined && createdMap.has(item.index as number)) {
      const minId = await db.prepare(
        `SELECT MIN(change_id) AS m FROM sync_changes WHERE ledger_id = ? AND entity_type = 'transaction' AND entity_sync_id = ? AND action = 'upsert'`
      ).bind(ledger.id, createdSyncId).first<{ m: number | null }>();
      createdRevisions[createdSyncId] = minId?.m ?? 0;
    }
  }
  await db.prepare(
    `UPDATE mcp_state_records SET data_json = ?, status = 'completed', updated_at = ? WHERE id = ?`
  ).bind(JSON.stringify({ ...data, operation_id: outcome.operation_id, created_revisions: createdRevisions }), nowIso(), planId).run();
  return { ...outcome, plan_id: planId, plan_revision: expectedRevision, sources_linked: true };
}

export async function undoImportPlan(
  c: McpContext,
  args: { plan_id: string; expected_revision?: number | null; confirm?: boolean },
): Promise<Record<string, unknown>> {
  const { db, userId } = c;
  const planId = args.plan_id;
  const expectedRevision = args.expected_revision ?? 0;
  if (!args.confirm) return { status: 'confirmation_required' };
  const [row, ledger] = await loadRecord(c, planId, { kind: 'import_plan', write: true });
  if (row.user_id !== userId) throw new Error('Only the import creator can undo its operation');
  if (row.revision !== expectedRevision || !['completed', 'undone'].includes(row.status)) {
    throw new Error('Plan version/status does not permit undo');
  }
  const data = row.data_json ? JSON.parse(row.data_json) as Record<string, unknown> : {};
  if (row.status === 'undone') return { status: 'undone', plan_id: planId };
  const createdRevisions = data.created_revisions as Record<string, number> | undefined ?? {};
  const conflicts: string[] = [];
  const steps: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  for (const [syncId, expected] of Object.entries(createdRevisions)) {
    const tx = await db.prepare('SELECT * FROM read_tx_projection WHERE ledger_id = ? AND sync_id = ?')
      .bind(ledger.id, syncId).first<Record<string, unknown>>();
    if (!tx) continue;
    if (Number(tx.source_change_id ?? 0) !== expected) conflicts.push(syncId);
    steps.push({
      method: 'DELETE',
      path: `/api/v1/write/ledgers/${ledger.external_id}/transactions/${syncId}`,
      body: { base_change_id: 0, expected_revision: expected },
    });
  }
  if (conflicts.length > 0) return { status: 'conflict', modified_sync_ids: conflicts, deleted_count: 0 };
  const outcome = await runWrite(c, ledger, {
    kind: 'undo_import',
    request: { plan_id: planId, revision: expectedRevision },
    steps,
    idempotency_key: `undo:${planId}`,
  });
  if (outcome.status === 'completed') {
    const [row2] = await loadRecord(c, planId, { kind: 'import_plan', write: true });
    const syncIds = Object.keys(createdRevisions);
    await db.prepare('UPDATE mcp_state_records SET status = ?, updated_at = ? WHERE id = ?')
      .bind('undone', nowIso(), planId).run();
    if (syncIds.length > 0) {
      const placeholders = syncIds.map(() => '?').join(',');
      await db.prepare(
        `DELETE FROM mcp_source_references WHERE ledger_id = ? AND tx_sync_id IN (${placeholders})`
      ).bind(ledger.id, ...syncIds).run();
    }
  }
  return { ...outcome, plan_id: planId };
}

export async function reconcileAccount(
  c: McpContext,
  args: { ledger_id: string; account_id: string; at: string; actual_balance: number; time_zone?: string | null },
): Promise<Record<string, unknown>> {
  if (!Number.isFinite(args.actual_balance)) throw new Error('actual_balance must be finite');
  const ledger = await requireLedger(c, args.ledger_id);
  const owner = ledger.user_id;
  const ownerLedgers = (await listLiveLedgers(c.db, c.userId)).filter(l => l.user_id === owner);
  const cutoff = parseDateBoundary(args.at, { end: true, timeZone: args.time_zone ?? c.configuredTimeZone ?? undefined });
  const balances = await getAccountBalances(c, { at: args.at, time_zone: args.time_zone ?? c.configuredTimeZone ?? null, scope: 'visible' });
  const matches = (balances.accounts as Array<Record<string, unknown>>).filter(
    item => item.account_id === args.account_id && item.owner_user_id === owner,
  );
  if (matches.length !== 1) throw new Error('Account not found');
  const account = matches[0];
  const placeholders = ownerLedgers.map(() => '?').join(',');
  const unassigned = await c.db.prepare(
    `SELECT * FROM read_tx_projection WHERE ledger_id IN (${placeholders})
     AND happened_at < ? AND tx_type IN ('income','expense') AND account_sync_id IS NULL
     ORDER BY happened_at DESC LIMIT 20`
  ).bind(...ownerLedgers.map(l => l.id), cutoff.toISOString()).all<Record<string, unknown>>();
  const calculated = Number(account.balance ?? 0);
  return {
    account,
    actual_balance: args.actual_balance,
    calculated_balance: calculated,
    difference: args.actual_balance - calculated,
    reconciled: Math.abs(args.actual_balance - calculated) < 0.005,
    at: args.at,
    // 对齐上游 reconcile_account：isoformat（+00:00），不是 Z 结尾
    cutoff_exclusive: cutoff.toISOString().replace(/Z$/, '+00:00'),
    // 未给 time_zone 时用 Cloud 配置时区（对齐上游 zone(None)）
    time_zone: args.time_zone ?? c.configuredTimeZone ?? 'Cloud default',
    coverage: {
      ledger_ids: ownerLedgers.map(l => l.external_id),
      revision: await revision(c.db, ownerLedgers.map(l => l.id), owner),
      opening_balance_effective_date: 'legacy opening balance has no effective date',
    },
    unassigned_candidates: unassigned.results.map(r => serializeTx(r as never, (r.category_name as string | null) ?? null)),
  };
}

export async function saveReconciliationCheckpoint(
  c: McpContext,
  args: { ledger_id: string; account_id: string; at: string; actual_balance: number; source_system: string; coverage_from?: string | null; time_zone?: string | null; confirm?: boolean },
): Promise<Record<string, unknown>> {
  if (!args.confirm) return { status: 'confirmation_required' };
  const result = await reconcileAccount(c, {
    ledger_id: args.ledger_id, account_id: args.account_id, at: args.at, actual_balance: args.actual_balance, time_zone: args.time_zone,
  });
  if (args.coverage_from
    && parseDateBoundary(args.coverage_from, { timeZone: args.time_zone ?? undefined }).getTime()
      >= parseDateBoundary(args.at, { end: true, timeZone: args.time_zone ?? undefined }).getTime()) {
    throw new Error('coverage_from must precede the checkpoint end');
  }
  const ledger = await requireLedger(c, args.ledger_id, { write: true });
  return saveRecord(c, ledger, {
    kind: 'checkpoint',
    data: { ...result, source_system: args.source_system, coverage_from: args.coverage_from ?? null, confirmed_by_user_id: c.userId },
    status: 'confirmed',
  });
}

export async function unlinkTransactionSource(
  c: McpContext,
  args: { ledger_id: string; reference_id: string; confirm?: boolean },
): Promise<Record<string, unknown>> {
  if (!args.confirm) return { status: 'confirmation_required' };
  const ledger = await requireLedger(c, args.ledger_id, { write: true });
  const reference = await c.db.prepare('SELECT * FROM mcp_source_references WHERE id = ?').bind(args.reference_id).first<MCPSourceRow>();
  if (!reference || reference.ledger_id !== ledger.id) throw new Error('Source reference not found');
  const metadata = reference.metadata_json ? JSON.parse(reference.metadata_json) as Record<string, unknown> : {};
  if (metadata._reserved) throw new Error('Source belongs to an unfinished import; resume that operation first');
  await c.db.prepare(
    `INSERT INTO audit_logs (user_id, ledger_id, action, metadata_json, created_at) VALUES (?, ?, ?, ?, ?)`
  ).bind(c.userId, ledger.id, 'mcp_source_unlink', JSON.stringify({ reference_id: args.reference_id, before: sourceOut(reference) }), nowIso()).run();
  await c.db.prepare('DELETE FROM mcp_source_references WHERE id = ?').bind(args.reference_id).run();
  return { status: 'unlinked', reference_id: args.reference_id };
}

