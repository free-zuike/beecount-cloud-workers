/**
 * MCP 参数校验层（对齐原版 pydantic 契约）。
 *
 * 原版靠 pydantic 模型（extra="forbid" + Field(min_length/max_length/ge/le/gt)）在入口
 * 拦住非法入参；TypeScript 侧没有这套声明式校验，历史上是「静默接受」，导致非法枚举、
 * 超长字段、未知键、布尔伪装的金额都能进到写路径。这里把上游各模块 Fields 的契约
 * 集中成可复用校验器，供 manage / preview_import / save_review_item / 周期规则等入口调用。
 */

/** 与上游 pydantic ValidationError 对齐：消息直接透出给 Agent */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValueError';
  }
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null;
}

/** 金额：拒绝 boolean（Number(true)=1 会伪装成 1 元）、NaN/Inf、<=0 */
export function positiveAmount(value: unknown, field = 'amount'): number {
  if (typeof value === 'boolean') throw new ValidationError(`${field} must be a number, not a boolean`);
  // 对齐上游（pydantic float 校验）的分段文案
  let raw: unknown = value;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t || !Number.isFinite(Number(t))) throw new ValidationError('Input should be a valid number');
    raw = Number(t);
  }
  if (raw === null || raw === undefined || typeof raw !== 'number') {
    throw new ValidationError('Input should be a valid number');
  }
  if (!Number.isFinite(raw)) throw new ValidationError('Input should be a finite number');
  if (raw <= 0) throw new ValidationError('Input should be greater than 0');
  return raw;
}

/** 可选数值区间（ge/le） */
export function optionalNumber(
  value: unknown,
  field: string,
  opts: { ge?: number; le?: number; gt?: number } = {},
): number | null {
  if (isBlank(value)) return null;
  if (typeof value === 'boolean') throw new ValidationError(`${field} must be a number, not a boolean`);
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) throw new ValidationError(`${field} must be a finite number`);
  const { ge, le, gt } = opts;
  if (gt !== undefined && !(n > gt)) throw new ValidationError(`${field} must be greater than ${gt}`);
  if (ge !== undefined && !(n >= ge)) throw new ValidationError(`${field} must be >= ${ge}`);
  if (le !== undefined && !(n <= le)) throw new ValidationError(`${field} must be <= ${le}`);
  return n;
}

/** 可选整数区间（ge/le） */
export function optionalInt(
  value: unknown,
  field: string,
  opts: { ge?: number; le?: number } = {},
): number | null {
  const n = optionalNumber(value, field, opts);
  if (n === null) return null;
  if (!Number.isInteger(n)) throw new ValidationError(`${field} must be an integer`);
  return n;
}

/** 可选字符串长度（min_length/max_length，trim 后判定非空） */
export function optionalString(
  value: unknown,
  field: string,
  opts: { minLength?: number; maxLength?: number } = {},
): string | null {
  if (isBlank(value)) return null;
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string`);
  const { minLength = 0, maxLength = Number.POSITIVE_INFINITY } = opts;
  if (value.length < minLength) throw new ValidationError(`${field} must be at least ${minLength} characters`);
  if (value.length > maxLength) throw new ValidationError(`${field} must be at most ${maxLength} characters`);
  return value;
}

/** 定长字符串（如 file_sha256 = 64） */
export function optionalFixedLength(value: unknown, length: number, field: string): string | null {
  const s = optionalString(value, field);
  if (s === null) return null;
  if (s.length !== length) throw new ValidationError(`${field} must be exactly ${length} characters`);
  return s;
}

/** 枚举（必填时 value 为空也报错） */
export function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
  opts: { required?: boolean } = {},
): T | null {
  if (isBlank(value)) {
    if (opts.required) throw new ValidationError(`${field} is required`);
    return null;
  }
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ValidationError(`${field} must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

/** 数组长度上限（max_length） */
export function maxItems(value: unknown, max: number, field: string): unknown[] {
  if (isBlank(value)) return [];
  if (!Array.isArray(value)) throw new ValidationError(`${field} must be a list`);
  if (value.length > max) throw new ValidationError(`${field} accepts at most ${max} items`);
  return value;
}

/** 未知键拒绝（extra="forbid"） */
export function rejectUnknownKeys(
  value: unknown,
  allowed: readonly string[],
  label: string,
): void {
  if (isBlank(value) || typeof value !== 'object' || Array.isArray(value)) return;
  const allow = new Set(allowed);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (!allow.has(key)) throw new ValidationError(`${label} received an unknown field: ${key}`);
  }
}

/** 按实体套用上游 Fields 契约（manage_* 的 data） */
export function validateManageData(
  entity: 'accounts' | 'categories' | 'tags' | 'budgets' | 'ledgers',
  data: Record<string, unknown> | null | undefined,
): void {
  if (!data) return;
  if (entity === 'accounts') {
    rejectUnknownKeys(data, [
      'name', 'account_type', 'currency', 'initial_balance', 'note', 'credit_limit',
      'billing_day', 'payment_due_day', 'bank_name', 'card_last_four', 'hidden',
    ], 'account fields');
    optionalString(data.name, 'name', { minLength: 1, maxLength: 255 });
    optionalNumber(data.credit_limit, 'credit_limit', { ge: 0 });
    optionalInt(data.billing_day, 'billing_day', { ge: 1, le: 31 });
    optionalInt(data.payment_due_day, 'payment_due_day', { ge: 1, le: 31 });
    optionalString(data.card_last_four, 'card_last_four', { maxLength: 8 });
    // 对齐上游 AccountFields 的强类型：initial_balance 为数值
    if (data.initial_balance !== undefined && data.initial_balance !== null) {
      const n = Number(data.initial_balance);
      if (!Number.isFinite(n)) throw new ValidationError('initial_balance must be a finite number');
    }
    return;
  }
  if (entity === 'categories') {
    rejectUnknownKeys(data, ['name', 'kind', 'parent_sync_id', 'parent_name', 'icon', 'sort_order'], 'category fields');
    optionalString(data.name, 'name', { minLength: 1, maxLength: 255 });
    enumValue(data.kind, ['expense', 'income', 'transfer'] as const, 'kind');
    // 对齐上游 CategoryFields 的强类型：sort_order 为整数
    if (data.sort_order !== undefined && data.sort_order !== null) {
      optionalInt(data.sort_order, 'sort_order', {});
    }
    return;
  }
  if (entity === 'tags') {
    rejectUnknownKeys(data, ['name', 'color'], 'tag fields');
    optionalString(data.name, 'name', { minLength: 1, maxLength: 255 });
    return;
  }
  if (entity === 'budgets') {
    rejectUnknownKeys(data, ['type', 'category_id', 'amount', 'period', 'enabled'], 'budget fields');
    enumValue(data.type, ['total', 'category'] as const, 'type');
    enumValue(data.period, ['monthly', 'weekly', 'yearly'] as const, 'period');
    if (data.amount !== undefined && data.amount !== null) positiveAmount(data.amount, 'amount');
    return;
  }
  rejectUnknownKeys(data, ['ledger_name', 'currency', 'month_start_day'], 'ledger fields');
  optionalString(data.ledger_name, 'ledger_name', { minLength: 1, maxLength: 255 });
  optionalInt(data.month_start_day, 'month_start_day', { ge: 1, le: 28 });
}

/** 导入来源引用（上游 SourceInput） */
export function validateSourceInput(source: Record<string, unknown>, index: number): void {
  rejectUnknownKeys(source, ['source_system', 'source_id', 'order_id', 'file_sha256', 'row_number'], `sources[${index}]`);
  optionalString(source.source_system, 'source_system', { minLength: 1, maxLength: 128 });
  optionalString(source.source_id, 'source_id', { minLength: 1, maxLength: 255 });
  optionalString(source.order_id, 'order_id', { maxLength: 255 });
  optionalFixedLength(source.file_sha256, 64, 'file_sha256');
  optionalInt(source.row_number, 'row_number', { ge: 1 });
}

/** 导入候选（上游 ImportCandidate：sources ≤ 20、action 枚举） */
export function validateImportCandidate(candidate: Record<string, unknown>, index: number): void {
  rejectUnknownKeys(
    candidate,
    ['transaction', 'sources', 'action', 'existing_sync_id', 'allow_similar'],
    `candidates[${index}]`,
  );
  enumValue(candidate.action, ['create', 'link', 'skip'] as const, `candidates[${index}].action`);
  maxItems(candidate.sources, 20, `candidates[${index}].sources`);
  for (const [i, source] of ((candidate.sources as unknown[]) ?? []).entries()) {
    validateSourceInput(source as Record<string, unknown>, i);
  }
}
