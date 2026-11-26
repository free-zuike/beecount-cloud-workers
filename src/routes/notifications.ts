/**
 * 个人通知中心路由（对齐上游 1.10.x routers/notifications.py）。
 *
 * - GET  /notifications       — 派生通知列表（web_read），no-store
 * - POST /notifications/read  — 批量标记已读（web_write），幂等，204
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

import { allowAppRwScopes, requireAnyScopes } from '../middleware/scope';
import { activeNotices, applyReadState, readKeysOf } from '../services/notifications';

type Bindings = {
  DB: D1Database;
  JWT_SECRET: string;
};

type Variables = {
  userId: string;
  scopes?: string[];
};

const notificationsRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

async function loadUser(db: D1Database, userId: string) {
  return db
    .prepare('SELECT id, is_admin FROM users WHERE id = ?')
    .bind(userId)
    .first<{ id: string; is_admin: number | boolean }>();
}

notificationsRouter.get('/', async (c) => {
  // 与 read/write/devices 同一兼容策略：ALLOW_APP_RW_SCOPES 宽松模式下 app_write 也可读
  const denied = requireAnyScopes(c, ['web_read'], allowAppRwScopes(c) ? ['app_write'] : []);
  if (denied) return denied;

  const userId = c.get('userId');
  const db = c.env.DB;
  const user = await loadUser(db, userId);
  if (!user) return c.json({ detail: 'User not found' }, 404);

  const notices = await applyReadState(db, userId, await activeNotices(db, user));
  // 对齐上游 Notice.receipt_ids(exclude=True)：分组回执键只在服务端内部使用，不对外输出
  const body = notices.map((notice) => {
    const { receipt_ids: _receiptIds, ...rest } =
      notice as unknown as Record<string, unknown> & { receipt_ids?: string[] };
    return rest;
  });
  c.header('Cache-Control', 'no-store');
  return c.json(body);
});

const MarkNotificationsReadSchema = z.object({
  ids: z.array(z.string().min(1).max(128)).min(1).max(200),
});

notificationsRouter.post('/read', zValidator('json', MarkNotificationsReadSchema), async (c) => {
  const denied = requireAnyScopes(c, ['web_write'], allowAppRwScopes(c) ? ['app_write'] : []);
  if (denied) return denied;

  const userId = c.get('userId');
  const db = c.env.DB;
  const user = await loadUser(db, userId);
  if (!user) return c.json({ detail: 'User not found' }, 404);

  const requested = new Set(c.req.valid('json').ids);
  const notices = await activeNotices(db, user);
  const keys = new Set<string>();
  for (const notice of notices) {
    if (!requested.has(notice.id)) continue;
    for (const key of readKeysOf(notice)) keys.add(key);
  }

  if (keys.size > 0) {
    const statements = [...keys].map((key) =>
      db
        .prepare(
          `INSERT INTO user_notification_reads (user_id, notification_id)
           VALUES (?, ?)
           ON CONFLICT(user_id, notification_id) DO NOTHING`
        )
        .bind(userId, key)
    );
    for (let i = 0; i < statements.length; i += 100) {
      await db.batch(statements.slice(i, i + 100));
    }
  }

  return c.body(null, 204);
});

export default notificationsRouter;
