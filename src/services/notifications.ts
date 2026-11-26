/**
 * 个人通知中心（对齐上游 1.10.x services/notifications/*）。
 *
 * 三类派生通知（不落库，按当前数据即时推导；已读状态存 user_notification_reads）：
 * 1. category_missing_parent — 旧版 App 删除父分类后残留的子分类
 * 2. backup_schedule_issue   — 备份计划失败/部分失败/逾期（仅管理员）
 * 3. device_sync_failure     — 设备同步连续失败 ≥3 次
 */

import type { SyncFailureDetail } from './sync-health';
import { SYNC_FAILURE_THRESHOLD, listSyncFailures } from './sync-health';
import { listCategoryParentIssues as listIssues } from './category-orphans';

// ===========================
// 通知类型
// ===========================

export interface NoticeBase {
  id: string;
  unread: boolean;
  /** 分组卡片逐个确认底层 incident；恢复一个时另一个不应因分组缩小而重新变未读 */
  receipt_ids?: string[];
}

export interface CategoryNoticeItem {
  id: string;
  name: string | null;
  parent_name: string | null;
}

export interface CategoryParentNotice extends NoticeBase {
  type: 'category_missing_parent';
  count: number;
  categories: CategoryNoticeItem[];
}

export interface BackupNotice extends NoticeBase {
  type: 'backup_schedule_issue';
  schedule_id: number;
  schedule_name: string;
  reason: 'failed' | 'partial' | 'overdue';
  count: number;
  run_id: number | null;
  at: string;
}

export interface DeviceSyncNotice extends NoticeBase {
  type: 'device_sync_failure';
  device_id: string;
  device_name: string;
  failures: SyncFailureDetail[];
}

export type CloudNotice = CategoryParentNotice | BackupNotice | DeviceSyncNotice;

// ===========================
// 稳定 ID（对齐上游 notice_id：kind + sha256(python json.dumps)）
// ===========================

/** 模拟 Python json.dumps(..., separators=(",", ":"))（ensure_ascii 默认 True）。 */
function pythonJsonDumps(value: unknown): string {
  const raw = JSON.stringify(value);
  return raw.replace(/[\u007f-\uffff]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
}

export async function noticeId(kind: string, ...identity: unknown[]): Promise<string> {
  const encoded = pythonJsonDumps(identity);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(encoded));
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${kind}:${hex}`;
}

export function readKeysOf(notice: NoticeBase): string[] {
  return notice.receipt_ids?.length ? notice.receipt_ids : [notice.id];
}

// ===========================
// 1) 分类缺父级
// ===========================

export interface CategoryParentIssue {
  sync_id: string;
  name: string | null;
  parent_id: string | null;
  parent_name: string | null;
  parent_event_id: number | null;
}

/** 与数据清理共用同一检测查询（services/category-orphans.ts）。 */
export async function listCategoryParentIssues(
  db: D1Database,
  userId: string
): Promise<CategoryParentIssue[]> {
  const issues = await listIssues(db, { userId });
  return issues.map((issue) => ({
    sync_id: issue.sync_id,
    name: issue.name,
    parent_id: issue.parent_id,
    parent_name: issue.parent_name,
    parent_event_id: issue.parent_event_id,
  }));
}
async function categoryNotices(db: D1Database, userId: string): Promise<CategoryParentNotice[]> {
  const issues = await listCategoryParentIssues(db, userId);
  if (issues.length === 0) return [];
  const identity = issues.map((issue) => [
    issue.sync_id,
    issue.name,
    issue.parent_id,
    issue.parent_name,
    issue.parent_event_id,
  ]);
  return [
    {
      id: await noticeId('category_missing_parent', userId, identity),
      unread: true,
      type: 'category_missing_parent',
      count: issues.length,
      categories: issues.slice(0, 5).map((issue) => ({
        id: issue.sync_id,
        name: issue.name,
        parent_name: issue.parent_name,
      })),
    },
  ];
}

// ===========================
// 2) 备份计划异常（仅管理员）
// ===========================

const OVERDUE_GRACE_MS = 60 * 60 * 1000;
const FULL_FAILURE_THRESHOLD = 2;
const MAX_SCAN_MINUTES = 366 * 24 * 60;

interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  dayWildcard: boolean;
  dowWildcard: boolean;
}

function expandCronField(field: string, min: number, max: number): Set<number> | null {
  if (field === '*') {
    const all = new Set<number>();
    for (let v = min; v <= max; v += 1) all.add(v);
    return all;
  }
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10);
    if (!Number.isFinite(step) || step < 1) return null;
    const all = new Set<number>();
    for (let v = min; v <= max; v += step) all.add(v);
    return all;
  }
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      if (start < min || end > max || start > end) return null;
      for (let v = start; v <= end; v += 1) values.add(v);
      continue;
    }
    const num = parseInt(part, 10);
    if (!Number.isFinite(num) || num < min || num > max) return null;
    values.add(num);
  }
  return values;
}

function parseCron(cronExpr: string): CronFields | null {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const minutes = expandCronField(parts[0], 0, 59);
  const hours = expandCronField(parts[1], 0, 23);
  const daysOfMonth = expandCronField(parts[2], 1, 31);
  const months = expandCronField(parts[3], 1, 12);
  const daysOfWeekRaw = expandCronField(parts[4], 0, 7);
  if (!minutes || !hours || !daysOfMonth || !months || !daysOfWeekRaw) return null;
  const daysOfWeek = new Set([...daysOfWeekRaw].map((d) => (d === 7 ? 0 : d)));
  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    dayWildcard: parts[2] === '*',
    dowWildcard: parts[4] === '*',
  };
}

/** 返回 strict after 之后的第一个 cron 触发时间（UTC ms），找不到返回 null。 */
export function nextCronFireAfter(
  cronExpr: string,
  afterUtcMs: number,
  timezoneOffsetMinutes: number
): number | null {
  const fields = parseCron(cronExpr);
  if (!fields) return null;
  const offsetMs = timezoneOffsetMinutes * 60 * 1000;
  // UTC = local + offset ⇒ local = UTC - offset
  let cursor = Math.floor(afterUtcMs / 60000) * 60000 + 60000;
  for (let i = 0; i < MAX_SCAN_MINUTES; i += 1) {
    const local = new Date(cursor - offsetMs);
    const minute = local.getUTCMinutes();
    const hour = local.getUTCHours();
    const day = local.getUTCDate();
    const month = local.getUTCMonth() + 1;
    const dow = local.getUTCDay();
    // 与标准 cron 一致：DOM/DOW 任一为 * 时只看另一个；都不为 * 时取「或」语义。
    const dayMatches = fields.dayWildcard && fields.dowWildcard
      ? true
      : fields.dayWildcard
        ? fields.daysOfWeek.has(dow)
        : fields.dowWildcard
          ? fields.daysOfMonth.has(day)
          : fields.daysOfMonth.has(day) || fields.daysOfWeek.has(dow);
    const matches =
      fields.minutes.has(minute) &&
      fields.hours.has(hour) &&
      fields.months.has(month) &&
      dayMatches;
    if (matches) return cursor;
    cursor += 60000;
  }
  return null;
}

async function serverTimezoneOffset(db: D1Database): Promise<number> {
  try {
    const row = await db
      .prepare('SELECT timezone_offset FROM system_settings WHERE id = ?')
      .bind('default')
      .first<{ timezone_offset: number }>();
    if (row && Number.isFinite(Number(row.timezone_offset))) return Number(row.timezone_offset);
  } catch { /* ignore */ }
  return 0;
}

async function backupNotices(
  db: D1Database,
  userId: string,
  isAdmin: boolean,
  nowMs: number,
  timezoneOffset: number
): Promise<BackupNotice[]> {
  if (!isAdmin) return [];
  const schedules = await db
    .prepare(
      `SELECT id, name, cron_expr,
              COALESCE(cron_effective_at, created_at) AS effective_at
       FROM backup_schedules
       WHERE user_id = ? AND enabled = 1
       ORDER BY id`
    )
    .bind(userId)
    .all<{ id: number; name: string; cron_expr: string; effective_at: string }>();

  const notices: BackupNotice[] = [];
  for (const schedule of schedules.results ?? []) {
    const effectiveAt = schedule.effective_at;
    const success = await db
      .prepare(
        `SELECT MAX(finished_at) AS finished_at FROM backup_runs
         WHERE schedule_id = ? AND user_id = ? AND status = 'succeeded' AND started_at >= ?`
      )
      .bind(schedule.id, userId, effectiveAt)
      .first<{ finished_at: string | null }>();
    const since = success?.finished_at ?? effectiveAt;

    const failures = await db
      .prepare(
        `SELECT id, status, finished_at FROM backup_runs
         WHERE schedule_id = ? AND user_id = ?
           AND started_at >= ? AND status IN ('failed', 'partial')
           AND finished_at > ?
         ORDER BY finished_at DESC, id DESC
         LIMIT 200`
      )
      .bind(schedule.id, userId, effectiveAt, since)
      .all<{ id: number; status: string; finished_at: string }>();
    const failureRows = failures.results ?? [];
    const count = failureRows.length;
    const latest = failureRows[0];

    let reason: BackupNotice['reason'];
    let at: string;
    let runId: number | null = null;
    if (latest && (latest.status === 'partial' || count >= FULL_FAILURE_THRESHOLD)) {
      reason = latest.status as 'failed' | 'partial';
      at = new Date(latest.finished_at).toISOString();
      runId = latest.id;
    } else {
      const sinceMs = new Date(since).getTime();
      if (!Number.isFinite(sinceMs)) continue;
      const due = nextCronFireAfter(schedule.cron_expr, sinceMs, timezoneOffset);
      if (due === null) continue;
      if (nowMs < due + OVERDUE_GRACE_MS) continue;
      reason = 'overdue';
      at = new Date(due).toISOString();
    }

    notices.push({
      id: await noticeId('backup_schedule_issue', userId, schedule.id, new Date(since).toISOString()),
      unread: true,
      type: 'backup_schedule_issue',
      schedule_id: schedule.id,
      schedule_name: schedule.name,
      reason,
      count,
      run_id: runId,
      at,
    });
  }
  return notices;
}

// ===========================
// 3) 设备同步失败
// ===========================

async function deviceNotices(db: D1Database, userId: string): Promise<DeviceSyncNotice[]> {
  const rows = await db
    .prepare(
      `SELECT d.id AS device_id, d.name AS device_name, f.direction, f.incident_id,
              f.failure_count, f.reason, f.first_failed_at, f.last_failed_at
       FROM devices d
       JOIN device_sync_failures f ON f.device_id = d.id
       WHERE d.user_id = ? AND d.revoked_at IS NULL AND f.failure_count >= ?
       ORDER BY d.id, f.direction`
    )
    .bind(userId, SYNC_FAILURE_THRESHOLD)
    .all<{
      device_id: string;
      device_name: string;
      direction: string;
      incident_id: string;
      failure_count: number;
      reason: string;
      first_failed_at: string;
      last_failed_at: string;
    }>();

  const byDevice = new Map<string, typeof rows.results>();
  for (const row of rows.results ?? []) {
    const list = byDevice.get(row.device_id) ?? [];
    list.push(row);
    byDevice.set(row.device_id, list);
  }

  const notices: DeviceSyncNotice[] = [];
  for (const [deviceId, streaks] of byDevice) {
    const incidents = streaks.map((s) => s.incident_id);
    notices.push({
      id: await noticeId('device_sync_failure', userId, deviceId, incidents),
      unread: true,
      type: 'device_sync_failure',
      receipt_ids: await Promise.all(
        streaks.map((s) => noticeId('device_sync_failure', s.incident_id))
      ),
      device_id: deviceId,
      device_name: streaks[0].device_name,
      failures: streaks.map((s) => ({
        direction: s.direction as 'push' | 'pull',
        count: s.failure_count,
        reason: s.reason as 'changes_rejected' | 'server_error',
        first_failed_at: s.first_failed_at,
        last_failed_at: s.last_failed_at,
      })),
    });
  }
  return notices;
}

// ===========================
// 汇总 + 已读状态
// ===========================

export async function activeNotices(
  db: D1Database,
  user: { id: string; is_admin: number | boolean }
): Promise<CloudNotice[]> {
  const nowMs = Date.now();
  const timezoneOffset = await serverTimezoneOffset(db);
  const [categories, backups, devices] = await Promise.all([
    categoryNotices(db, user.id),
    backupNotices(db, user.id, Boolean(user.is_admin), nowMs, timezoneOffset),
    deviceNotices(db, user.id),
  ]);
  return [...backups, ...devices, ...categories];
}

export async function applyReadState(
  db: D1Database,
  userId: string,
  notices: CloudNotice[]
): Promise<CloudNotice[]> {
  const keys = [...new Set(notices.flatMap((notice) => readKeysOf(notice)))];
  if (keys.length === 0) return notices;
  const receipts = new Set<string>();
  for (let i = 0; i < keys.length; i += 500) {
    const chunk = keys.slice(i, i + 500);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = await db
      .prepare(
        `SELECT notification_id FROM user_notification_reads
         WHERE user_id = ? AND notification_id IN (${placeholders})`
      )
      .bind(userId, ...chunk)
      .all<{ notification_id: string }>();
    for (const row of rows.results ?? []) receipts.add(row.notification_id);
  }
  for (const notice of notices) {
    const noticeKeys = readKeysOf(notice);
    notice.unread = !noticeKeys.every((key) => receipts.has(key));
  }
  return notices;
}

// 供测试/其他服务复用
export { listSyncFailures };
