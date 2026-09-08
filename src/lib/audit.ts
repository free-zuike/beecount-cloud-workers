export type AuditAction =
  | 'create' | 'update' | 'delete'
  | 'sync_push' | 'backup' | 'restore' | 'clear_data'
  | 'batch_create' | 'batch_delete'
  | 'init_defaults' | 'invite' | 'join' | 'remove_member' | 'update_meta'
  | 'revoke_invite' | 'preview_invite' | 'transfer_owner'
  | 'backup_remote_reveal'
  | 'admin_user_create' | 'admin_user_patch' | 'admin_user_delete';

interface AuditLogParams {
  db: D1Database;
  userId: string;
  ledgerId?: string | null;
  action: AuditAction;
  entityType?: string | null;
  entityId?: string | null;
  details?: Record<string, unknown>;
  logBuffer?: DurableObjectNamespace;
  level?: string;
  logger?: string;
}

export async function insertAuditLog(params: AuditLogParams): Promise<void> {
  const { db, userId, ledgerId, action, entityType, entityId, details, logBuffer, level, logger } = params;
  try {
    // 对齐原版 audit_logs（user_id, ledger_id, action, metadata_json）：
    // entityType/entityId/details/level/logger 等扩展信息并入 metadata_json
    await db
      .prepare(
        `INSERT INTO audit_logs (user_id, ledger_id, action, metadata_json)
         VALUES (?, ?, ?, ?)`
      )
      .bind(
        userId,
        ledgerId ?? null,
        action,
        JSON.stringify({
          entityType: entityType ?? null,
          entityId: entityId ?? null,
          details: details ?? null,
          level: level ?? 'INFO',
          logger: logger ?? null,
        }),
      )
      .run();

    // Also buffer in LogBuffer DO for real-time log viewing
    if (logBuffer) {
      try {
        const doId = logBuffer.idFromName(`log-${userId}`);
        const stub = logBuffer.get(doId);
        await stub.fetch(new URL('/add', 'http://do'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            level: 'info',
            source: 'audit',
            message: `${action} ${entityType || ''} ${entityId || ''}`,
          }),
        });
      } catch {
        // LogBuffer DO failure should not block audit log
      }
    }
  } catch (err) {
    console.error('[AUDIT] Failed to insert audit log:', err);
  }
}

export async function logToBuffer(
  logBuffer: DurableObjectNamespace,
  userId: string,
  level: string,
  source: string,
  message: string
): Promise<void> {
  try {
    const doId = logBuffer.idFromName(`log-${userId}`);
    const stub = logBuffer.get(doId);
    await stub.fetch(new URL('/add', 'http://do'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level, source, message }),
    });
  } catch {
    // Buffer failure should not block operations
  }
}
