/**
 * CSV 导出路由模块 - 实现账本交易的 CSV 格式导出
 *
 * 端点：
 * - GET /export/csv - 导出指定账本的交易为 CSV 格式
 *
 * @module routes/csv
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';

type Bindings = {
  DB: D1Database;
};

type Variables = {
  userId: string;
};

const csvRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

function escapeCsvField(field: string | number | null): string {
  if (field === null || field === undefined) return '';
  const str = String(field);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

const ExportQuerySchema = z.object({
  ledger_id: z.string().min(1),
  date_from: z.string().optional(),
  date_to: z.string().optional(),
  category_name: z.string().optional(),
  account_name: z.string().optional(),
  tx_type: z.enum(['income', 'expense', 'transfer']).optional(),
});

csvRouter.get('/export/csv', zValidator('query', ExportQuerySchema), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const { ledger_id, date_from, date_to, category_name, account_name, tx_type } = c.req.valid('query');

  const ledger = await db
    .prepare('SELECT id, name FROM ledgers WHERE user_id = ? AND external_id = ?')
    .bind(userId, ledger_id)
    .first<{ id: string; name: string | null }>();

  if (!ledger) {
    return c.json({ error: 'Ledger not found or access denied' }, 404);
  }

  let txQuery = 'SELECT * FROM read_tx_projection WHERE ledger_id = ?';
  const params: (string | number)[] = [ledger.id];

  if (tx_type) {
    txQuery += ' AND tx_type = ?';
    params.push(tx_type);
  }

  if (category_name) {
    txQuery += ' AND category_name LIKE ?';
    params.push(`%${category_name}%`);
  }

  if (account_name) {
    txQuery += ' AND (account_name LIKE ? OR from_account_name LIKE ? OR to_account_name LIKE ?)';
    const pattern = `%${account_name}%`;
    params.push(pattern, pattern, pattern);
  }

  if (date_from) {
    txQuery += ' AND happened_at >= ?';
    params.push(date_from);
  }

  if (date_to) {
    txQuery += ' AND happened_at <= ?';
    params.push(date_to + 'T23:59:59.999Z');
  }

  txQuery += ' ORDER BY happened_at DESC, tx_index DESC';

  const txRows = await db.prepare(txQuery).bind(...params).all<Record<string, unknown>>();

  const header = ['日期', '类型', '金额', '账户', '分类', '标签', '备注'];
  const rows = [header.join(',')];

  for (const tx of txRows.results) {
    const date = String(tx.happened_at ?? '').slice(0, 10);
    const txType = String(tx.tx_type ?? '');
    const amount = String(tx.amount ?? 0);
    const account = String(tx.account_name ?? tx.from_account_name ?? '');
    const category = String(tx.category_name ?? '');
    const tags = String(tx.tags_csv ?? '');
    const note = String(tx.note ?? '');

    rows.push(
      [date, txType, amount, account, category, tags, note].map(escapeCsvField).join(',')
    );
  }

  const csvContent = '\uFEFF' + rows.join('\r\n');
  const fileName = `${ledger.name || ledger_id}_transactions_${new Date().toISOString().slice(0, 10)}.csv`;

  return new Response(csvContent, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${fileName}"`,
    },
  });
});

export default csvRouter;
