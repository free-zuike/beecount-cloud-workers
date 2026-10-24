// 附件引用判定（isAttachmentStillReferenced）回归测试 —— 真实 SQLite 求值。
// 覆盖保守修复方案 C 的三类场景：
//  1. 单行 sha + 仅 fileName 引用（旧版 App 数据）→ 判为被引用（绝不误删）
//  2. 同 sha 冗余行 + 交易按 cloudFileId 引用 → 只清无引用冗余行、保留被引用行
//  3. 同 sha 冗余行 + 残缺「仅 fileName」引用 → 整组保留
// 另覆盖 user scope（admin 数据清理 B1 语义）+ category icon 引用。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { isAttachmentStillReferenced } from '../src/lib/attachment-reference';

let sqlite: DatabaseSync;
let db: D1Database;

const LEDGER = 'ledger-1';
const USER = 'user-1';

function makeD1(s: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      const statement = s.prepare(sql);
      let params: unknown[] = [];
      return {
        bind(...values: unknown[]) { params = values; return this; },
        async run() {
          const r = statement.run(...(params as never[]));
          return { meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } };
        },
        async first<T = unknown>() {
          const row = statement.get(...(params as never[])) as T | undefined;
          return row ?? null;
        },
        async all<T = unknown>() {
          return { results: statement.all(...(params as never[])) as T[] };
        },
      };
    },
  } as unknown as D1Database;
}

const DDL = `
  CREATE TABLE read_tx_projection (
    ledger_id TEXT, sync_id TEXT, user_id TEXT, tx_type TEXT, amount REAL DEFAULT 0, happened_at TEXT, note TEXT,
    category_sync_id TEXT, category_name TEXT, category_kind TEXT,
    account_sync_id TEXT, account_name TEXT,
    from_account_sync_id TEXT, from_account_name TEXT,
    to_account_sync_id TEXT, to_account_name TEXT,
    tags_csv TEXT, tag_sync_ids_json TEXT, attachments_json TEXT, tx_index INTEGER DEFAULT 0,
    created_by_user_id TEXT, last_edited_by_user_id TEXT, source_change_id INTEGER DEFAULT 0,
    currency_code TEXT, native_amount REAL,
    exclude_from_stats INTEGER DEFAULT 0, exclude_from_budget INTEGER DEFAULT 0,
    PRIMARY KEY (ledger_id, sync_id)
  );
  CREATE TABLE attachment_files (
    id TEXT PRIMARY KEY, ledger_id TEXT, user_id TEXT, sha256 TEXT,
    size_bytes INTEGER, mime_type TEXT, file_name TEXT, storage_path TEXT,
    attachment_kind TEXT DEFAULT 'transaction', created_at TEXT
  );
  CREATE TABLE user_category_projection (
    user_id TEXT, sync_id TEXT, category_sync_id TEXT, name TEXT, kind TEXT,
    icon_cloud_file_id TEXT, parent_sync_id TEXT, sort_order INTEGER,
    PRIMARY KEY (user_id, sync_id)
  );
`;

const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec(DDL);
  db = makeD1(sqlite);
});

afterEach(() => {
  sqlite.close();
});

function insertAtt(id: string, sha: string, ledger = LEDGER, user = USER) {
  sqlite.prepare(
    `INSERT INTO attachment_files (id, ledger_id, user_id, sha256, file_name, storage_path, attachment_kind, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'transaction', '2026-01-01T00:00:00.000Z')`
  ).run(id, ledger, user, sha, `att-${id}.jpg`, `attachments/${ledger}/${id}_att.jpg`);
}

function insertTx(syncId: string, attachmentsJson: string, ledger = LEDGER, user = USER) {
  sqlite.prepare(
    `INSERT INTO read_tx_projection (ledger_id, sync_id, user_id, tx_type, amount, happened_at, attachments_json)
     VALUES (?, ?, ?, 'expense', 1, '2026-01-01T00:00:00.000Z', ?)`
  ).run(ledger, syncId, user, attachmentsJson);
}

describe('isAttachmentStillReferenced', () => {
  it('单行 sha：cloudFileId 引用 → 被引用', async () => {
    insertAtt('A', SHA);
    insertTx('t1', JSON.stringify([{ cloudFileId: 'A', fileName: `sha_${SHA}.jpg` }]));
    expect(await isAttachmentStillReferenced({ db, fileId: 'A', sha256: SHA, scope: { ledgerId: LEDGER } })).toBe(true);
  });

  it('单行 sha：仅 fileName 引用（旧版 App 数据，无 cloudFileId）→ 被引用，不误删', async () => {
    insertAtt('A', SHA);
    insertTx('t1', JSON.stringify([{ fileName: `sha_${SHA}.jpg` }]));
    expect(await isAttachmentStillReferenced({ db, fileId: 'A', sha256: SHA, scope: { ledgerId: LEDGER } })).toBe(true);
  });

  it('单行 sha：无任何引用 → 孤儿', async () => {
    insertAtt('A', SHA);
    expect(await isAttachmentStillReferenced({ db, fileId: 'A', sha256: SHA, scope: { ledgerId: LEDGER } })).toBe(false);
  });

  it('冗余（同 sha 两行）：交易引用保留行 A → A 保留、B 判孤儿', async () => {
    insertAtt('A', SHA);
    insertAtt('B', SHA);
    insertTx('t1', JSON.stringify([{ cloudFileId: 'A', fileName: `sha_${SHA}.jpg` }]));
    expect(await isAttachmentStillReferenced({ db, fileId: 'A', sha256: SHA, scope: { ledgerId: LEDGER } })).toBe(true);
    expect(await isAttachmentStillReferenced({ db, fileId: 'B', sha256: SHA, scope: { ledgerId: LEDGER } })).toBe(false);
  });

  it('冗余：交易引用非最早行 B → B 保留、A 判孤儿', async () => {
    insertAtt('A', SHA);
    insertAtt('B', SHA);
    insertTx('t1', JSON.stringify([{ cloudFileId: 'B', fileName: `sha_${SHA}.jpg` }]));
    expect(await isAttachmentStillReferenced({ db, fileId: 'A', sha256: SHA, scope: { ledgerId: LEDGER } })).toBe(false);
    expect(await isAttachmentStillReferenced({ db, fileId: 'B', sha256: SHA, scope: { ledgerId: LEDGER } })).toBe(true);
  });

  it('冗余 + 残缺「仅 fileName」引用（无 cloudFileId）→ 整组保留', async () => {
    insertAtt('A', SHA);
    insertAtt('B', SHA);
    insertTx('t1', JSON.stringify([{ fileName: `sha_${SHA}.jpg` }]));
    expect(await isAttachmentStillReferenced({ db, fileId: 'A', sha256: SHA, scope: { ledgerId: LEDGER } })).toBe(true);
    expect(await isAttachmentStillReferenced({ db, fileId: 'B', sha256: SHA, scope: { ledgerId: LEDGER } })).toBe(true);
  });

  it('冗余 + 交易同时含 cloudFileId（正常 Web/App 数据）→ 仅清无引用行', async () => {
    insertAtt('A', SHA);
    insertAtt('B', SHA);
    insertTx('t1', JSON.stringify([{ cloudFileId: 'A', fileName: `sha_${SHA}.jpg` }]));
    // B 无任何引用：cfHit=0、sha 多行、无「仅 fileName」引用 → 孤儿
    expect(await isAttachmentStillReferenced({ db, fileId: 'B', sha256: SHA, scope: { ledgerId: LEDGER } })).toBe(false);
  });

  it('user scope（B1 语义）：user_id 过滤', async () => {
    insertAtt('A', SHA, LEDGER, 'user-1');
    insertAtt('C', SHA2, LEDGER, 'user-2');
    insertTx('t1', JSON.stringify([{ cloudFileId: 'A', fileName: `sha_${SHA}.jpg` }]), LEDGER, 'user-1');
    // user-1 的 A 被引用；user-2 的 C 无引用（同账本但不同 user 的投影行不影响）
    expect(await isAttachmentStillReferenced({ db, fileId: 'A', sha256: SHA, scope: { userId: 'user-1' } })).toBe(true);
    expect(await isAttachmentStillReferenced({ db, fileId: 'C', sha256: SHA2, scope: { userId: 'user-2' } })).toBe(false);
  });

  it('category icon 引用（B1 专属）→ 被引用', async () => {
    insertAtt('A', SHA);
    sqlite.prepare(
      `INSERT INTO user_category_projection (user_id, sync_id, category_sync_id, name, kind, icon_cloud_file_id, parent_sync_id, sort_order)
       VALUES (?, 'c1', 'cat-1', '分类', 'expense', ?, NULL, 0)`
    ).run(USER, 'A');
    expect(await isAttachmentStillReferenced({
      db, fileId: 'A', sha256: SHA, scope: { userId: USER }, checkCategoryIcon: true,
    })).toBe(true);
    // 不启用 category 检查时按原语义判定（无 tx 引用 → 孤儿）
    expect(await isAttachmentStillReferenced({ db, fileId: 'A', sha256: SHA, scope: { userId: USER } })).toBe(false);
  });

  it('不同账本的引用不算（ledger scope 隔离）', async () => {
    insertAtt('A', SHA, LEDGER);
    insertTx('t1', JSON.stringify([{ cloudFileId: 'A' }]), 'other-ledger');
    expect(await isAttachmentStillReferenced({ db, fileId: 'A', sha256: SHA, scope: { ledgerId: LEDGER } })).toBe(false);
  });
});
