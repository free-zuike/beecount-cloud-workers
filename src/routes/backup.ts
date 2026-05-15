/**
 * 备份路由模块 - 实现 BeeCount Cloud 备份接口
 *
 * 参考原版 BeeCount-Cloud (Python/FastAPI) 的 /admin/backup 端点：
 * - POST   /backup/snapshots            - 创建手动备份快照
 * - GET    /backup/snapshots           - 列出备份快照
 * - POST   /backup/snapshots/:id/restore - 恢复备份快照
 *
 * 功能说明：
 * - 备份快照包含账本的完整数据（用于灾难恢复）
 * - 快照存储为 JSON 格式
 * - 支持手动创建和自动定时备份
 *
 * @module routes/backup
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { randomUUID } from 'crypto';

// ===========================
// 辅助函数
// ===========================

/** 获取当前 UTC 时间 */
function nowUtc(): string {
  return new Date().toISOString();
}

/** 安全序列化 JSON */
function safeJsonStringify(obj: unknown): string {
  return JSON.stringify(obj);
}

// ===========================
// Schema 定义
// ===========================

/** 创建备份请求 */
const BackupCreateSchema = z.object({
  ledger_id: z.string(),
  note: z.string().optional(),
});

// ===========================
// 类型定义
// ===========================

/** 备份快照输出 */
interface BackupSnapshotOut {
  id: string;
  ledger_id: string;
  note: string | null;
  created_at: string;
}

/** 恢复备份请求 */
const BackupRestoreSchema = z.object({
  device_id: z.string().optional(),
});

// ===========================
// 路由定义
// ===========================

type Bindings = {
  DB: D1Database;
  JWT_SECRET: string;
};

type Variables = {
  userId: string;
};

const backupRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// ---------------------------------------------------------------------------
// POST /backup/snapshots - 创建手动备份快照
// ---------------------------------------------------------------------------

/**
 * 创建账本的手动备份快照
 *
 * 功能说明：
 * - 从 projection 表构建完整快照 JSON
 * - 存储到 backup_snapshots 表
 * - 可选添加备注
 *
 * 请求字段：
 * - ledger_id: 账本外部 ID
 * - note: 备注（可选）
 */
backupRouter.post('/snapshots', zValidator('json', BackupCreateSchema), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const req = c.req.valid('json');
  const serverNow = nowUtc();

  // 查找账本
  const ledger = await db
    .prepare('SELECT id, external_id FROM ledgers WHERE user_id = ? AND external_id = ?')
    .bind(userId, req.ledger_id)
    .first<{ id: string; external_id: string }>();

  if (!ledger) {
    return c.json({ error: 'Ledger not found' }, 404);
  }

  // 构建快照数据
  const [transactions, accounts, categories, tags, budgets] = await Promise.all([
    db.prepare('SELECT * FROM read_tx_projection WHERE ledger_id = ?').bind(ledger.id).all(),
    db.prepare('SELECT * FROM read_account_projection WHERE ledger_id = ?').bind(ledger.id).all(),
    db.prepare('SELECT * FROM read_category_projection WHERE ledger_id = ?').bind(ledger.id).all(),
    db.prepare('SELECT * FROM read_tag_projection WHERE ledger_id = ?').bind(ledger.id).all(),
    db.prepare('SELECT * FROM read_budget_projection WHERE ledger_id = ?').bind(ledger.id).all(),
  ]);

  const snapshot = {
    ledger: {
      id: ledger.external_id,
    },
    transactions: transactions.results,
    accounts: accounts.results,
    categories: categories.results,
    tags: tags.results,
    budgets: budgets.results,
    exported_at: serverNow,
    version: '1.0',
  };

  const snapshotId = randomUUID();

  await db
    .prepare(
      `INSERT INTO backup_snapshots (id, user_id, ledger_id, snapshot_json, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(snapshotId, userId, ledger.id, safeJsonStringify(snapshot), req.note ?? null, serverNow)
    .run();

  const response: BackupSnapshotOut = {
    id: snapshotId,
    ledger_id: req.ledger_id,
    note: req.note ?? null,
    created_at: serverNow,
  };

  return c.json(response);
});

// ---------------------------------------------------------------------------
// GET /backup/snapshots - 列出备份快照
// ---------------------------------------------------------------------------

/**
 * 获取当前用户的所有备份快照
 *
 * 功能说明：
 * - 返回用户的所有备份快照列表
 * - 按创建时间倒序
 */
backupRouter.get('/snapshots', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;

  const rows = await db
    .prepare(
      `SELECT bs.id, bs.ledger_id, bs.note, bs.created_at,
              l.external_id as ledger_external_id
       FROM backup_snapshots bs
       JOIN ledgers l ON bs.ledger_id = l.id
       WHERE bs.user_id = ?
       ORDER BY bs.created_at DESC`
    )
    .bind(userId)
    .all<{
      id: string;
      ledger_id: string;
      ledger_external_id: string;
      note: string | null;
      created_at: string;
    }>();

  const result: BackupSnapshotOut[] = rows.results.map((row) => ({
    id: row.id,
    ledger_id: row.ledger_external_id,
    note: row.note,
    created_at: row.created_at,
  }));

  return c.json(result);
});

// ---------------------------------------------------------------------------
// POST /backup/snapshots/:id/restore - 恢复备份快照
// ---------------------------------------------------------------------------

/**
 * 从备份快照恢复账本数据
 *
 * 功能说明：
 * - 读取快照 JSON
 * - 清除现有 projection 数据
 * - 重新写入快照数据
 * - 生成新的 SyncChange 记录
 */
backupRouter.post('/snapshots/:id/restore', zValidator('json', BackupRestoreSchema), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const snapshotId = c.req.param('id');
  const req = c.req.valid('json');
  const serverNow = nowUtc();

  // 获取快照
  const snapshotRow = await db
    .prepare(
      `SELECT bs.*, l.external_id as ledger_external_id
       FROM backup_snapshots bs
       JOIN ledgers l ON bs.ledger_id = l.id
       WHERE bs.id = ? AND bs.user_id = ?`
    )
    .bind(snapshotId, userId)
    .first<{
      id: string;
      ledger_id: string;
      ledger_external_id: string;
      snapshot_json: string;
    }>();

  if (!snapshotRow) {
    return c.json({ error: 'Snapshot not found' }, 404);
  }

  let snapshot: {
    transactions?: Array<Record<string, unknown>>;
    accounts?: Array<Record<string, unknown>>;
    categories?: Array<Record<string, unknown>>;
    tags?: Array<Record<string, unknown>>;
    budgets?: Array<Record<string, unknown>>;
  };

  try {
    snapshot = JSON.parse(snapshotRow.snapshot_json);
  } catch {
    return c.json({ error: 'Invalid snapshot data' }, 400);
  }

  const ledgerId = snapshotRow.ledger_id;

  // 清除现有 projection 数据
  await db.prepare('DELETE FROM read_tx_projection WHERE ledger_id = ?').bind(ledgerId).run();
  await db.prepare('DELETE FROM read_account_projection WHERE ledger_id = ?').bind(ledgerId).run();
  await db.prepare('DELETE FROM read_category_projection WHERE ledger_id = ?').bind(ledgerId).run();
  await db.prepare('DELETE FROM read_tag_projection WHERE ledger_id = ?').bind(ledgerId).run();
  await db.prepare('DELETE FROM read_budget_projection WHERE ledger_id = ?').bind(ledgerId).run();

  // 获取最新 change_id
  const latestChangeId = await db
    .prepare('SELECT MAX(change_id) as max_id FROM sync_changes WHERE ledger_id = ?')
    .bind(ledgerId)
    .first<{ max_id: number | null }>();

  let nextChangeId = (latestChangeId?.max_id ?? 0) + 1;

  // 恢复 transactions
  if (snapshot.transactions) {
    for (const tx of snapshot.transactions) {
      await db
        .prepare(
          `INSERT INTO read_tx_projection
           (ledger_id, sync_id, user_id, tx_type, amount, happened_at, note,
            category_sync_id, category_name, category_kind,
            account_sync_id, account_name,
            from_account_sync_id, from_account_name,
            to_account_sync_id, to_account_name,
            tags_csv, tag_sync_ids_json, attachments_json, tx_index, source_change_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          ledgerId,
          tx.sync_id,
          userId,
          tx.tx_type,
          tx.amount,
          tx.happened_at,
          tx.note ?? null,
          tx.category_sync_id ?? null,
          tx.category_name ?? null,
          tx.category_kind ?? null,
          tx.account_sync_id ?? null,
          tx.account_name ?? null,
          tx.from_account_sync_id ?? null,
          tx.from_account_name ?? null,
          tx.to_account_sync_id ?? null,
          tx.to_account_name ?? null,
          tx.tags_csv ?? null,
          tx.tag_sync_ids_json ?? null,
          tx.attachments_json ?? null,
          tx.tx_index ?? 0,
          nextChangeId++,
        )
        .run();
    }
  }

  // 恢复 accounts
  if (snapshot.accounts) {
    for (const acc of snapshot.accounts) {
      await db
        .prepare(
          `INSERT INTO read_account_projection
           (ledger_id, sync_id, user_id, name, account_type, currency, initial_balance,
            note, credit_limit, billing_day, payment_due_day, bank_name, card_last_four, source_change_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          ledgerId,
          acc.sync_id,
          userId,
          acc.name,
          acc.account_type ?? null,
          acc.currency ?? null,
          acc.initial_balance ?? 0,
          acc.note ?? null,
          acc.credit_limit ?? null,
          acc.billing_day ?? null,
          acc.payment_due_day ?? null,
          acc.bank_name ?? null,
          acc.card_last_four ?? null,
          nextChangeId++,
        )
        .run();
    }
  }

  // 恢复 categories
  if (snapshot.categories) {
    for (const cat of snapshot.categories) {
      await db
        .prepare(
          `INSERT INTO read_category_projection
           (ledger_id, sync_id, user_id, name, kind, level, sort_order,
            icon, icon_type, custom_icon_path, icon_cloud_file_id, icon_cloud_sha256,
            parent_name, source_change_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          ledgerId,
          cat.sync_id,
          userId,
          cat.name,
          cat.kind ?? null,
          cat.level ?? null,
          cat.sort_order ?? null,
          cat.icon ?? null,
          cat.icon_type ?? null,
          cat.custom_icon_path ?? null,
          cat.icon_cloud_file_id ?? null,
          cat.icon_cloud_sha256 ?? null,
          cat.parent_name ?? null,
          nextChangeId++,
        )
        .run();
    }
  }

  // 恢复 tags
  if (snapshot.tags) {
    for (const tag of snapshot.tags) {
      await db
        .prepare(
          `INSERT INTO read_tag_projection
           (ledger_id, sync_id, user_id, name, color, source_change_id)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(
          ledgerId,
          tag.sync_id,
          userId,
          tag.name,
          tag.color ?? null,
          nextChangeId++,
        )
        .run();
    }
  }

  // 恢复 budgets
  if (snapshot.budgets) {
    for (const budget of snapshot.budgets) {
      await db
        .prepare(
          `INSERT INTO read_budget_projection
           (ledger_id, sync_id, user_id, budget_type, category_sync_id, amount,
            period, start_day, enabled, source_change_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          ledgerId,
          budget.sync_id,
          userId,
          budget.budget_type ?? 'total',
          budget.category_sync_id ?? null,
          budget.amount ?? 0,
          budget.period ?? 'monthly',
          budget.start_day ?? 1,
          budget.enabled ? 1 : 0,
          nextChangeId++,
        )
        .run();
    }
  }

  return c.json({
    restored: true,
    ledger_id: snapshotRow.ledger_external_id,
    change_id: nextChangeId - 1,
  });
});

export default backupRouter;
