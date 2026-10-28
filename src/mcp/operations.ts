/**
 * 持久化写操作计划（对齐原版 src/mcp/operations.py）。
 *
 * 语义：写之前先落 plan（含幂等键/哈希/步骤），执行按 steps 逐条自调用生产
 * write 路由，每条步骤独立提交；失败保留已完成步骤（partial）可重试。
 * 短 lease 防并发执行；执行期间持续续租；重试复用原始 payload。
 */
import { fingerprint, uuid4, nowUtcIso } from './query-context';

export interface OperationStep {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

export interface OperationRow {
  id: string;
  user_id: string;
  ledger_id: string;
  request_key: string;
  request_hash: string;
  kind: string;
  status: string;
  plan_json: string;
  results_json: string;
  error_json: string | null;
  lease_id: string | null;
  lease_until: string | null;
  created_at: string;
  updated_at: string;
}

export interface OperationOut extends Record<string, unknown> {
  operation_id: string;
  status: string;
  kind: string;
  completed_steps: number;
  total_steps: number;
  transaction_boundary: string;
  sync_ids: string[];
  results: Array<Record<string, unknown>>;
  error: Record<string, unknown> | null;
}

const LEASE_MINUTES = 5;

function leaseExpiry(): string {
  return new Date(Date.now() + LEASE_MINUTES * 60 * 1000).toISOString();
}

/** operation_out：从行聚合对外输出（sync_ids 从 results 提取）。 */
export function operationOut(row: OperationRow): OperationOut {
  let results: Array<Record<string, unknown>> = [];
  try { results = JSON.parse(row.results_json || '[]'); } catch { results = []; }
  let plan: unknown[] = [];
  try { plan = JSON.parse(row.plan_json || '[]'); } catch { plan = []; }
  const ids: string[] = [];
  for (const result of results) {
    const created = result.created_sync_ids as string[] | undefined;
    if (Array.isArray(created)) ids.push(...created);
    else if (typeof result.entity_id === 'string') ids.push(result.entity_id);
  }
  let error: Record<string, unknown> | null = null;
  try { error = row.error_json ? JSON.parse(row.error_json) : null; } catch { error = null; }
  return {
    operation_id: row.id,
    status: row.status,
    kind: row.kind,
    completed_steps: results.length,
    total_steps: plan.length,
    transaction_boundary: 'Each step commits independently; completed steps are retained on failure',
    sync_ids: ids,
    results,
    error,
  };
}

/** 查找既有操作：同 key 不同请求/类型/账本 → IDEMPOTENCY_CONFLICT。 */
export async function findOperation(
  db: D1Database,
  opts: { user_id: string; key: string; request: unknown; kind?: string | null; ledger_id?: string | null },
): Promise<OperationRow | null> {
  const row = await db.prepare(
    'SELECT * FROM mcp_write_operations WHERE user_id = ? AND request_key = ?'
  ).bind(opts.user_id, opts.key).first<OperationRow>();
  if (!row) return null;
  const hash = fingerprint(opts.request);
  if (
    row.request_hash !== hash ||
    (opts.kind !== undefined && opts.kind !== null && row.kind !== opts.kind) ||
    (opts.ledger_id !== undefined && opts.ledger_id !== null && row.ledger_id !== opts.ledger_id)
  ) {
    throw new Error('IDEMPOTENCY_CONFLICT: key was already used with different arguments');
  }
  return row;
}

/** 保存操作计划（幂等：同 key 同请求复用既有行）。 */
export async function saveOperation(
  db: D1Database,
  opts: {
    user_id: string;
    ledger_id: string;
    key: string;
    kind: string;
    request: unknown;
    steps: OperationStep[];
  },
): Promise<OperationRow> {
  const existing = await findOperation(db, {
    user_id: opts.user_id,
    key: opts.key,
    request: opts.request,
    kind: opts.kind,
    ledger_id: opts.ledger_id,
  });
  if (existing) return existing;
  const row: OperationRow = {
    id: uuid4(),
    user_id: opts.user_id,
    ledger_id: opts.ledger_id,
    request_key: opts.key,
    request_hash: fingerprint(opts.request),
    kind: opts.kind,
    status: 'pending',
    plan_json: JSON.stringify(opts.steps),
    results_json: '[]',
    error_json: null,
    lease_id: null,
    lease_until: null,
    created_at: nowUtcIso(),
    updated_at: nowUtcIso(),
  };
  try {
    await db.prepare(
      `INSERT INTO mcp_write_operations
       (id, user_id, ledger_id, request_key, request_hash, kind, status, plan_json, results_json, error_json, lease_id, lease_until, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      row.id, row.user_id, row.ledger_id, row.request_key, row.request_hash, row.kind, row.status,
      row.plan_json, row.results_json, row.error_json, row.lease_id, row.lease_until,
      row.created_at, row.updated_at,
    ).run();
  } catch (err: unknown) {
    // UNIQUE(user_id, request_key) 并发冲突 → 重查
    if (err && typeof err === 'object' && 'message' in err && String((err as { message: unknown }).message).includes('UNIQUE')) {
      const again = await findOperation(db, {
        user_id: opts.user_id,
        key: opts.key,
        request: opts.request,
        kind: opts.kind,
        ledger_id: opts.ledger_id,
      });
      if (again) return again;
    }
    throw err;
  }
  return row;
}

/**
 * 执行操作：lease 抢占 → 逐步骤自调用 → 结果累积 → 完成/失败标记。
 * call 签名：async (method, path, userId, body, headers?) => result
 */
export async function executeOperation(
  db: D1Database,
  row: OperationRow,
  userId: string,
  call: (method: string, path: string, userId: string, body: Record<string, unknown>, headers: Record<string, string>) => Promise<Record<string, unknown>>,
): Promise<OperationOut> {
  const now = nowUtcIso();
  const lease = uuid4();
  const leaseUntil = leaseExpiry();

  // 抢占 lease：仅当未完成且 lease 过期/空闲
  const claim = await db.prepare(
    `UPDATE mcp_write_operations SET status = 'running', lease_id = ?, lease_until = ?, updated_at = ?
     WHERE id = ? AND user_id = ? AND status != 'completed' AND (lease_until IS NULL OR lease_until < ?)`
  ).bind(lease, leaseUntil, now, row.id, userId, now).run();
  const refreshed = await db.prepare('SELECT * FROM mcp_write_operations WHERE id = ?').bind(row.id).first<OperationRow>();
  if (!refreshed) throw new Error('Operation not found');
  if (claim.meta.changes === 0) return operationOut(refreshed); // 被别人执行中 → 只读状态

  const steps: OperationStep[] = JSON.parse(refreshed.plan_json || '[]');
  let results: Array<Record<string, unknown>> = JSON.parse(refreshed.results_json || '[]');
  let status = 'completed';
  let error: Record<string, unknown> | null = null;

  try {
    for (let index = results.length; index < steps.length; index++) {
      const step = steps[index];
      const result = await call(
        step.method,
        step.path,
        refreshed.user_id,
        step.body,
        // 对齐上游：mcp 内部调用标记 mcp-internal，幂等记录 36500 天不过期
        { 'Idempotency-Key': `mcp:${row.id}:${index}`, 'X-Device-ID': 'mcp-internal' },
      );
      results.push(result);
      // 每步结果落库 + 续租
      const keep = await db.prepare(
        `UPDATE mcp_write_operations SET results_json = ?, updated_at = ?, lease_until = ?
         WHERE id = ? AND lease_id = ?`
      ).bind(JSON.stringify(results), nowUtcIso(), leaseExpiry(), row.id, lease).run();
      if (keep.meta.changes === 0) {
        throw new Error('Operation execution lease lost; query its status before retrying');
      }
    }
  } catch (exc: unknown) {
    status = results.length > 0 ? 'partial' : 'failed';
    // 不持久化含源数据/凭据的异常文本；code 优先取 409/422 等业务错误码（对齐上游）
    const statusCode = (exc as { status_code?: number }).status_code;
    const errCode = (exc as { error_code?: string }).error_code;
    const code = errCode ?? (exc instanceof Error ? exc.name : 'Error');
    const retryable = statusCode !== undefined
      ? (statusCode >= 500 || statusCode === 408 || statusCode === 429)
      : true;
    error = {
      step: results.length,
      code,
      retryable,
    };
  }

  await db.prepare(
    `UPDATE mcp_write_operations SET status = ?, error_json = ?, lease_id = NULL, lease_until = NULL, updated_at = ?
     WHERE id = ? AND lease_id = ?`
  ).bind(status, error ? JSON.stringify(error) : null, nowUtcIso(), row.id, lease).run();
  const finalRow = await db.prepare('SELECT * FROM mcp_write_operations WHERE id = ?').bind(row.id).first<OperationRow>();
  return operationOut(finalRow ?? refreshed);
}

/** 读取操作（无副作用）。 */
export async function getOperation(db: D1Database, userId: string, operationId: string): Promise<OperationOut | null> {
  const row = await db.prepare(
    'SELECT * FROM mcp_write_operations WHERE id = ? AND user_id = ?'
  ).bind(operationId, userId).first<OperationRow>();
  return row ? operationOut(row) : null;
}

/** 列出账本的操作（最新优先）。 */
export async function listOperations(
  db: D1Database,
  userId: string,
  ledgerId: string,
  limit = 30,
): Promise<OperationOut[]> {
  const rows = await db.prepare(
    `SELECT * FROM mcp_write_operations WHERE user_id = ? AND ledger_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`
  ).bind(userId, ledgerId, Math.min(Math.max(limit, 1), 100)).all<OperationRow>();
  return rows.results.map(operationOut);
}
