export type AuditAction =
  | 'create' | 'update' | 'delete'
  | 'sync_push' | 'backup' | 'restore' | 'clear_data'
  | 'batch_create' | 'batch_delete'
  | 'init_defaults' | 'invite' | 'join' | 'remove_member' | 'update_meta';

interface AuditLogParams {
  db: D1Database;
  userId: string;
  ledgerId?: string | null;
  action: AuditAction;
  entityType?: string | null;
  entityId?: string | null;
  details?: Record<string, unknown>;
}

export async function insertAuditLog(params: AuditLogParams): Promise<void> {
  const { db, userId, ledgerId, action, entityType, entityId, details } = params;
  try {
    await db
      .prepare(
        `INSERT INTO audit_logs (user_id, ledger_id, action, entity_type, entity_id, details_json)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(
        userId,
        ledgerId ?? null,
        action,
        entityType ?? null,
        entityId ?? null,
        details ? JSON.stringify(details) : null,
      )
      .run();
  } catch (err) {
    console.error('[AUDIT] Failed to insert audit log:', err);
  }
}
