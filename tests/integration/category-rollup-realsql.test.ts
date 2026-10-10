import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { DatabaseSync } from 'node:sqlite';
import readRouter from '../../src/routes/read';
import workspaceRouter from '../../src/routes/workspace';
import csvRouter from '../../src/routes/csv';
import { createRealDb } from '../helpers/realsql-db';

let sqlite: DatabaseSync;
let db: D1Database;
let app: Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>;

beforeEach(() => {
  const real = createRealDb(); sqlite = real.sqlite; db = real.db;
  sqlite.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT);
    CREATE TABLE ledgers (id TEXT PRIMARY KEY,user_id TEXT,external_id TEXT,name TEXT,currency TEXT,month_start_day INTEGER DEFAULT 1,created_at TEXT,deleted_at TEXT);
    CREATE TABLE ledger_members (ledger_id TEXT,user_id TEXT,role TEXT,joined_at TEXT);
    CREATE TABLE sync_changes (change_id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT,ledger_id TEXT,entity_type TEXT,entity_sync_id TEXT,action TEXT,payload_json TEXT,updated_at TEXT,updated_by_user_id TEXT,updated_by_device_id TEXT,scope TEXT);
    CREATE TABLE user_category_projection (sync_id TEXT PRIMARY KEY,user_id TEXT,name TEXT,kind TEXT,level INTEGER,sort_order INTEGER DEFAULT 0,icon TEXT,icon_type TEXT,custom_icon_path TEXT,icon_cloud_file_id TEXT,icon_cloud_sha256 TEXT,parent_name TEXT,parent_sync_id TEXT,source_change_id INTEGER DEFAULT 0);
    CREATE TABLE read_tx_projection (ledger_id TEXT NOT NULL,sync_id TEXT NOT NULL,user_id TEXT NOT NULL,tx_type TEXT NOT NULL,amount REAL DEFAULT 0,transfer_to_amount REAL,happened_at TEXT NOT NULL,note TEXT,category_sync_id TEXT,category_name TEXT,category_kind TEXT,account_sync_id TEXT,account_name TEXT,from_account_sync_id TEXT,from_account_name TEXT,to_account_sync_id TEXT,to_account_name TEXT,tags_csv TEXT,tag_sync_ids_json TEXT,attachments_json TEXT,tx_index INTEGER DEFAULT 0,created_by_user_id TEXT,last_edited_by_user_id TEXT,source_change_id INTEGER DEFAULT 0,exclude_from_stats INTEGER DEFAULT 0,exclude_from_budget INTEGER DEFAULT 0,currency_code TEXT,native_amount REAL,created_at TEXT,created_by TEXT,updated_at TEXT,PRIMARY KEY (ledger_id,sync_id));
    CREATE TABLE read_budget_projection (ledger_id TEXT,sync_id TEXT,user_id TEXT,budget_type TEXT,category_sync_id TEXT,amount REAL,period TEXT,start_day INTEGER,enabled INTEGER,source_change_id INTEGER DEFAULT 0);
    INSERT INTO users VALUES ('user-1','rollup@example.com');
    INSERT INTO ledgers (id,user_id,external_id,name,currency,month_start_day,created_at) VALUES ('ledger-1','user-1','ledger-1','Rollup','CNY',1,'2026-01-01T00:00:00Z');
    INSERT INTO ledger_members VALUES ('ledger-1','user-1','owner','2026-01-01T00:00:00Z');
    INSERT INTO user_category_projection (sync_id,user_id,name,kind,level,sort_order,parent_name,parent_sync_id) VALUES
      ('food','user-1','餐饮','expense',1,1,NULL,NULL),('lunch','user-1','午餐','expense',2,1,'餐饮','food'),('dinner','user-1','晚餐','expense',2,2,'餐饮','food'),('travel','user-1','交通','expense',1,2,NULL,NULL);
  `);
  const now = new Date().toISOString();
  const ins = sqlite.prepare(`INSERT INTO read_tx_projection (ledger_id,sync_id,user_id,tx_type,amount,happened_at,category_sync_id,category_name,category_kind,source_change_id,exclude_from_stats,exclude_from_budget,created_at,updated_at) VALUES ('ledger-1',?,'user-1','expense',?,?,?,?, 'expense',?,0,0,?,?)`);
  ins.run('tx-parent',5,now,'food','餐饮',1,now,now);
  ins.run('tx-lunch',10,now,'lunch','午餐',2,now,now);
  ins.run('tx-dinner',20,now,'dinner','晚餐',3,now,now);
  ins.run('tx-travel',7,now,'travel','交通',4,now,now);
  sqlite.prepare(`INSERT INTO read_budget_projection VALUES ('ledger-1','budget-food','user-1','category','food',100,'monthly',1,1,1)`).run();
  app = new Hono();
  app.use('*', async (c, next) => { c.set('userId', 'user-1'); await next(); });
  app.route('/api/v1/read', readRouter); app.route('/api/v1', workspaceRouter); app.route('/api/v1/export', csvRouter);
});

afterEach(() => sqlite.close());
async function json<T>(path: string): Promise<T> { const r = await app.request(path, undefined, { DB: db }); expect(r.status).toBe(200); return r.json() as Promise<T>; }

describe('category parent rollup', () => {
  it('rolls child counts into the parent and keeps child direct counts', async () => {
    const rows = await json<Array<{ id:string; tx_count:number }>>('/api/v1/categories?ledger_id=ledger-1');
    expect(rows.find(x => x.id === 'food')?.tx_count).toBe(3);
    expect(rows.find(x => x.id === 'lunch')?.tx_count).toBe(1);
    expect(rows.find(x => x.id === 'dinner')?.tx_count).toBe(1);
    expect(rows.find(x => x.id === 'travel')?.tx_count).toBe(1);
  });

  it('expands parent detail to parent + children only', async () => {
    const parent = await json<{ total:number; items:Array<{sync_id:string}> }>('/api/v1/read/workspace/transactions?ledger_id=ledger-1&category_sync_id=food');
    expect(parent.total).toBe(3);
    expect(parent.items.map(x => x.sync_id).sort()).toEqual(['tx-dinner','tx-lunch','tx-parent']);
    const child = await json<{ total:number; items:Array<{sync_id:string}> }>('/api/v1/read/workspace/transactions?ledger_id=ledger-1&category_sync_id=lunch');
    expect(child.total).toBe(1);
    expect(child.items[0]?.sync_id).toBe('tx-lunch');
  });

  it('rolls analytics ranks to the top level without double counting', async () => {
    const a = await json<{summary:{expense_total:number;transaction_count:number};category_ranks:Array<{category_name:string;total:number;tx_count:number}>}>('/api/v1/analytics?ledger_id=ledger-1&scope=all&metric=expense');
    expect(a.summary).toMatchObject({ expense_total:42, transaction_count:4 });
    expect(a.category_ranks).toEqual([
      { category_name:'餐饮', total:35, tx_count:3 },
      { category_name:'交通', total:7, tx_count:1 },
    ]);
  });

  it('uses the same parent subtree for both budget endpoints', async () => {
    const usage = await json<{items:Array<{budget_id:string;used:number}>}>('/api/v1/read/ledgers/ledger-1/budgets/usage');
    expect(usage.items.find(x => x.budget_id === 'budget-food')?.used).toBe(35);
    const budgets = await json<Array<{id:string;spent:number}>>('/api/v1/budgets?ledger_id=ledger-1');
    expect(budgets.find(x => x.id === 'budget-food')?.spent).toBe(35);
  });

  it('includes child rows in both CSV paths when filtering by parent id', async () => {
    const alias = await app.request('/api/v1/transactions.csv?ledger_id=ledger-1&category_sync_id=food', undefined, { DB: db });
    expect(alias.status).toBe(200);
    const aliasText = await alias.text();
    expect(aliasText).toContain('餐饮'); expect(aliasText).toContain('午餐'); expect(aliasText).toContain('晚餐'); expect(aliasText).not.toContain('交通');

    const exported = await app.request('/api/v1/export/workspace/transactions.csv?ledger_id=ledger-1&category_sync_id=food&lang=zh-CN', undefined, { DB: db });
    expect(exported.status).toBe(200);
    const exportText = await exported.text();
    expect(exportText).toContain('餐饮'); expect(exportText).toContain('午餐'); expect(exportText).toContain('晚餐'); expect(exportText).not.toContain('交通');
  });
});
