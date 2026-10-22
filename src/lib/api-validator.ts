import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import type { Context } from 'hono';

// FastAPI 兼容校验错误:zValidator 默认 400,原版 Pydantic 语义是 422
// VALIDATION_ERROR + 结构化 issues(对齐 admin_backup.ts 的 apiValidator)。
export function apiValidator<T extends z.ZodTypeAny>(
  target: 'json' | 'query' | 'form',
  schema: T,
) {
  return zValidator(target, schema, (result, c) => {
    if (result.success) return;
    return c.json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        request_id: c.req.header('cf-ray') || '',
      },
      detail: 'Request validation failed',
      validation: result.error.issues.map(i => ({
        loc: ['body', ...i.path.map(p => String(p))],
        msg: i.message,
        type: 'value_error',
      })),
    }, 422);
  });
}

export type { Context };