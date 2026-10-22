import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import workspaceRouter from '../src/routes/workspace';
import { createRealDb, WRITE_PATH_TABLES } from './helpers/realsql-db';

// 移植上游 tests/test_workspace_csv_export.py 的端到端断言:
// 12 列 + BOM、zh-CN/zh-TW/en 表头、Type 列本地化、二级分类拆列、
// transfer 空列、CSV 转义、中文文件名 RFC 5987、时间戳/period 文件名、
// tz_offset 折算、filter(tx_type/q) passthrough。
let sqlite: DatabaseSync;
let db: D1Database;
let app: Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>;

const USER = 'user-1';
const LEDGER_ID = 'lg-1';

beforeEach(() => {
  const real = createRealDb();
  sqlite = real.sqlite;
  db = real.db;
  sqlite.exec(WRITE_PATH_TABLES);
  sqlite.prepare("INSERT INTO users (id, email, password_hash) VALUES ('user-1', 'csv@x.com', 'x')").run();
  sqlite.prepare(
    "INSERT INTO ledgers (id, user_id, external_id, name, currency) VALUES ('lg-1', 'user-1', 'lg-1', '个人账本', 'CNY')"
  ).run();
  sqlite.prepare("INSERT INTO ledger_members (ledger_id, user_id, role, joined_at) VALUES ('lg-1', 'user-1', 'owner', '2025-01-01T00:00:00Z')").run();

  app = new Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>();
  app.use('*', async (c, next) => {
    c.set('userId', USER);
    await next();
  });
  app.route('/api/v1/read/workspace', workspaceRouter);
});

afterEach(() => sqlite.close());

/** seed 1 expense(二级分类 午餐) + 1 income(一级分类 工资) + 1 transfer(对齐上游 _seed_basic)。 */
function seedBasic() {
  sqlite.prepare(
    `INSERT INTO user_category_projection (sync_id, user_id, name, kind, level, parent_name, parent_sync_id)
     VALUES ('cat-food', ?, '餐饮', 'expense', 1, NULL, NULL)`
  ).run(USER);
  sqlite.prepare(
    `INSERT INTO user_category_projection (sync_id, user_id, name, kind, level, parent_name, parent_sync_id)
     VALUES ('cat-lunch', ?, '午餐', 'expense', 2, '餐饮', 'cat-food')`
  ).run(USER);
  sqlite.prepare(
    `INSERT INTO user_category_projection (sync_id, user_id, name, kind, level, parent_name, parent_sync_id)
     VALUES ('cat-salary', ?, '工资', 'income', 1, NULL, NULL)`
  ).run(USER);

  sqlite.prepare(
    `INSERT INTO read_tx_projection (ledger_id, sync_id, user_id, tx_type, amount, happened_at, note,
       category_sync_id, category_name, account_sync_id, account_name, from_account_sync_id, from_account_name,
       to_account_sync_id, to_account_name, tx_index)
     VALUES ('lg-1', 'tx-1', ?, 'expense', 35.5, '2026-04-15T06:30:00Z', '午餐',
       'cat-lunch', '午餐', 'acc-credit', '招商信用卡', NULL, NULL, NULL, NULL, 0)`
  ).run(USER);
  sqlite.prepare(
    `INSERT INTO read_tx_projection (ledger_id, sync_id, user_id, tx_type, amount, happened_at, note,
       category_sync_id, category_name, account_sync_id, account_name, tx_index)
     VALUES ('lg-1', 'tx-2', ?, 'income', 5000, '2026-04-15T08:00:00Z', '工资',
       'cat-salary', '工资', 'acc-savings', '余额宝', 1)`
  ).run(USER);
  sqlite.prepare(
    `INSERT INTO read_tx_projection (ledger_id, sync_id, user_id, tx_type, amount, happened_at, note,
       from_account_sync_id, from_account_name, to_account_sync_id, to_account_name, tx_index)
     VALUES ('lg-1', 'tx-3', ?, 'transfer', 1000, '2026-04-16T02:00:00Z', '还信用卡',
       'acc-savings', '余额宝', 'acc-credit', '招商信用卡', 2)`
  ).run(USER);
}

async function fetchCsv(params: Record<string, string | string[]> = {}) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((x) => sp.append(k, x));
    else sp.set(k, v);
  }
  const qs = sp.toString();
  return await app.request(`/api/v1/read/workspace/transactions.csv${qs ? `?${qs}` : ''}`, {}, { DB: db });
}

function dataLines(body: string): string[] {
  return body.replace(/^\ufeff/, '').split('\r\n').filter((l) => l.length > 0);
}

describe('CSV 导出(移植上游 test_workspace_csv_export.py)', () => {
  it('表头 + BOM,默认 en;?lang=zh-CN / zh-TW 本地化表头', async () => {
    seedBasic();
    const en = await fetchCsv({ ledger_id: LEDGER_ID });
    expect(en.status).toBe(200);
    expect(en.headers.get('content-type')).toContain('text/csv');
    // Node undici 的 text() 自动剥离 BOM(上游 Python decode 保留),先读字节断言 BOM,再解码文本
    const enBuf = new Uint8Array(await en.arrayBuffer());
    expect([enBuf[0], enBuf[1], enBuf[2]]).toEqual([0xef, 0xbb, 0xbf]);
    const enBody = new TextDecoder().decode(enBuf);
    const enHeader = enBody.replace(/^\ufeff/, '').split('\r\n')[0];
    expect(enHeader).toBe('Type,Category,Subcategory,Amount,Currency,Account,From Account,To Account,Note,Time,Tags,Attachments');

    const zh = await fetchCsv({ ledger_id: LEDGER_ID, lang: 'zh-CN' });
    const zhBody = await zh.text();
    expect(zhBody.replace(/^\ufeff/, '').split('\r\n')[0]).toBe('类型,分类,二级分类,金额,币种,账户,转出账户,转入账户,备注,时间,标签,附件');

    const tw = await fetchCsv({ ledger_id: LEDGER_ID, lang: 'zh-TW' });
    const twBody = await tw.text();
    expect(twBody.replace(/^\ufeff/, '').split('\r\n')[0]).toBe('類型,分類,二級分類,金額,幣種,帳戶,轉出帳戶,轉入帳戶,備註,時間,標籤,附件');
  });

  it('Type 列本地化:zh-CN 收入/支出/转账,不再出现英文枚举;en 为 Income/Expense/Transfer', async () => {
    seedBasic();
    const zh = await fetchCsv({ ledger_id: LEDGER_ID, lang: 'zh-CN' });
    const zhBody = await zh.text();
    const zhData = zhBody.replace(/^\ufeff/, '').split('\r\n').slice(1).join('\n');
    expect(zhData).toContain('收入');
    expect(zhData).toContain('支出');
    expect(zhData).toContain('转账');
    expect(zhData).not.toContain('expense,');
    expect(zhData).not.toContain('income,');
    expect(zhData).not.toContain('transfer,');

    const en = await fetchCsv({ ledger_id: LEDGER_ID, lang: 'en' });
    const enData = (await en.text()).replace(/^\ufeff/, '').split('\r\n').slice(1).join('\n');
    for (const prefix of ['Income,', 'Expense,', 'Transfer,']) {
      expect(enData).toContain(prefix);
    }
  });

  it('二级分类拆列:level=2 → Category=父类、SubCategory=子类;level=1 → SubCategory 空', async () => {
    seedBasic();
    const zh = await fetchCsv({ ledger_id: LEDGER_ID, lang: 'zh-CN' });
    const lines = dataLines(await zh.text());
    const expenseLine = lines.find((l) => l.startsWith('支出,'));
    expect(expenseLine).toBeTruthy();
    const expenseCells = expenseLine!.split(',');
    expect(expenseCells[1]).toBe('餐饮');
    expect(expenseCells[2]).toBe('午餐');

    const incomeLine = lines.find((l) => l.startsWith('收入,'));
    expect(incomeLine).toBeTruthy();
    const incomeCells = incomeLine!.split(',');
    expect(incomeCells[1]).toBe('工资');
    expect(incomeCells[2]).toBe('');
  });

  it('transfer 行:Category/SubCategory/Account 空,FromAccount/ToAccount 填', async () => {
    seedBasic();
    const zh = await fetchCsv({ ledger_id: LEDGER_ID, lang: 'zh-CN' });
    const lines = dataLines(await zh.text());
    const transferLine = lines.find((l) => l.startsWith('转账,'));
    expect(transferLine).toBeTruthy();
    const cells = transferLine!.split(',');
    expect(cells[0]).toBe('转账');
    expect(cells[1]).toBe('');
    expect(cells[2]).toBe('');
    expect(cells[5]).toBe('');
    expect(cells[6]).toBe('余额宝');
    expect(cells[7]).toBe('招商信用卡');
  });

  it('CSV 转义:note 含逗号与双引号', async () => {
    sqlite.prepare(
      `INSERT INTO read_tx_projection (ledger_id, sync_id, user_id, tx_type, amount, happened_at, note,
         category_sync_id, category_name, account_sync_id, account_name, tx_index)
       VALUES ('lg-1', 'tx-esc', ?, 'expense', 12, '2026-04-15T06:00:00Z', '他说"好吃",还想再来',
         'cat-food', '餐饮', 'acc-credit', '招商信用卡', 0)`
    ).run(USER);

    const zh = await fetchCsv({ ledger_id: LEDGER_ID, lang: 'zh-CN' });
    const body = await zh.text();
    expect(body).toContain('"他说""好吃"",还想再来"');
  });

  it("中文文件名 RFC 5987:filename*=UTF-8'' 编码 + ASCII fallback", async () => {
    seedBasic();
    const r = await fetchCsv({ ledger_id: LEDGER_ID });
    const disp = r.headers.get('content-disposition') ?? '';
    expect(disp).toContain("filename*=UTF-8''");
    expect(disp).toContain('%E4');
    expect(disp).toContain('filename="');
  });

  it('无日期 → 文件名用导出时间戳 YYYYMMDD-HHMMSS,不再有 all_all;有日期 → 用 period', async () => {
    seedBasic();
    const noDates = await fetchCsv({ ledger_id: LEDGER_ID });
    const disp1 = noDates.headers.get('content-disposition') ?? '';
    expect(/\d{8}-\d{6}/.test(disp1)).toBe(true);
    expect(disp1).not.toContain('all_all');

    const withDates = await fetchCsv({
      ledger_id: LEDGER_ID,
      date_from: '2026-04-01T00:00:00Z',
      date_to: '2026-05-01T00:00:00Z',
    });
    const disp2 = withDates.headers.get('content-disposition') ?? '';
    expect(disp2).toContain('2026-04-01_2026-05-01');
  });

  it('tz_offset_minutes 折算:UTC 4/15 17:00 + tz=480 → 本地 4/16 01:00,Time 列带前后空格', async () => {
    sqlite.prepare(
      `INSERT INTO read_tx_projection (ledger_id, sync_id, user_id, tx_type, amount, happened_at, note,
         category_sync_id, category_name, account_sync_id, account_name, tx_index)
       VALUES ('lg-1', 'tx-tz', ?, 'expense', 1, '2026-04-15T17:00:00Z', 'x',
         'cat-food', '餐饮', 'acc-credit', '招商信用卡', 0)`
    ).run(USER);

    const utc = await fetchCsv({ ledger_id: LEDGER_ID });
    const utcBody = await utc.text();
    expect(utcBody).toContain('  2026-04-15 17:00:00  ');

    const cst = await fetchCsv({ ledger_id: LEDGER_ID, tz_offset_minutes: '480' });
    const cstBody = await cst.text();
    expect(cstBody).toContain('  2026-04-16 01:00:00  ');
  });

  it('filter passthrough:tx_type=income 只导出收入行;q=工资 只匹配工资行', async () => {
    seedBasic();
    const byType = await fetchCsv({ ledger_id: LEDGER_ID, tx_type: 'income', lang: 'zh-CN' });
    const typeLines = dataLines(await byType.text());
    expect(typeLines.length).toBe(2);
    expect(typeLines[1].startsWith('收入,')).toBe(true);

    const byQ = await fetchCsv({ ledger_id: LEDGER_ID, q: '工资', lang: 'zh-CN' });
    const qLines = dataLines(await byQ.text());
    expect(qLines.length).toBe(2);
    expect(qLines[1]).toContain('工资');
  });

  it('无权访问账本 → 404;不存在的账本 → 404', async () => {
    seedBasic();
    const forbidden = await fetchCsv({ ledger_id: 'other-lg' });
    expect(forbidden.status).toBe(404);
  });

  it('tx_ids 多选导出:只出选中行(移植上游 test_tx_batch_delete 三例)', async () => {
    seedBasic();
    const res = await fetchCsv({ ledger_id: LEDGER_ID, lang: 'zh-CN', tx_ids: ['tx-1', 'tx-2'] });
    expect(res.status).toBe(200);
    // 表头 + 2 行数据
    expect(dataLines(await res.text()).length).toBe(3);
  });

  it('tx_ids 全是伪造 → 只有表头,没有数据行', async () => {
    seedBasic();
    const res = await fetchCsv({ ledger_id: LEDGER_ID, lang: 'zh-CN', tx_ids: ['tx_does_not_exist'] });
    expect(res.status).toBe(200);
    expect(dataLines(await res.text()).length).toBe(1);
  });

  it('传 tx_ids 时忽略其它过滤器(q 不匹配也被忽略)', async () => {
    seedBasic();
    const res = await fetchCsv({
      ledger_id: LEDGER_ID, lang: 'zh-CN',
      q: 'DOES_NOT_MATCH_ANYTHING_xyz',
      tx_ids: ['tx-1', 'tx-2', 'tx-3'],
    });
    expect(res.status).toBe(200);
    expect(dataLines(await res.text()).length).toBe(4); // 表头 + 3 条
  });
});
