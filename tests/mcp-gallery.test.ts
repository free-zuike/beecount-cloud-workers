/**
 * list_attachments 画廊语义回归（上游 file_tools.list_attachments →
 * routers/read/attachment_gallery.py::list_gallery_attachments）。
 *
 * 关键点：数据源是交易里的 attachments_json 引用（不是 attachment_files 表），
 * 按 file_key 聚合、带关联交易、status = pending/ready/missing。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createLedger, makeHarness, mcpCtx, registerDevice, registerUser, type Harness } from './mcp-harness';
import { listAttachments } from '../src/mcp/file-tools';

let h: Harness;

afterEach(() => { h?.sqlite.close(); });

function setup(): ReturnType<typeof mcpCtx> {
  h = makeHarness();
  registerUser(h, 'u1', 'u1@example.com');
  registerDevice(h, 'u1');
  createLedger(h, 'u1', 'L1-i', 'L1', '主账本');
  return mcpCtx(h, 'u1');
}

function seedTx(syncId: string, happenedAt: string, attachments: unknown[], note = 'note', category = '餐饮'): void {
  h.sqlite.prepare(
    `INSERT INTO read_tx_projection (ledger_id, sync_id, user_id, tx_type, amount, happened_at, note,
     category_sync_id, category_name, account_sync_id, account_name, from_account_sync_id, from_account_name,
     to_account_sync_id, to_account_name, tag_sync_ids_json, currency_code, native_amount,
     exclude_from_stats, exclude_from_budget, attachments_json)
     VALUES ('L1-i', ?, 'u1', 'expense', 10, ?, ?, 'c1', ?, 'a1', '现金', NULL, NULL, NULL, NULL, '[]', 'CNY', 10, 0, 0, ?)`,
  ).run(syncId, happenedAt, note, category, JSON.stringify(attachments));
}

function seedFile(id: string, mime: string): void {
  h.sqlite.prepare(
    `INSERT INTO attachment_files (id, ledger_id, user_id, sha256, size_bytes, mime_type, file_name, storage_path, attachment_kind, created_at)
     VALUES (?, 'L1-i', 'u1', 'sha', 10, ?, 'r.png', 'p', 'transaction', '2026-01-01T00:00:00Z')`,
  ).run(id, mime);
}

describe('list_attachments（画廊语义）', () => {
  it('同一附件被多笔交易引用 → 聚合成一条，带出全部关联交易', async () => {
    const c = setup();
    seedFile('f1', 'image/png');
    const ref = [{ cloudFileId: 'f1', fileName: 'f1_r.png', originalName: 'receipt.png' }];
    seedTx('t1', '2026-05-01T10:00:00Z', ref);
    seedTx('t2', '2026-05-02T10:00:00Z', ref);
    const out = await listAttachments(c, { ledger_id: 'L1' }) as {
      items: Array<{ key: string; status: string; mime_type: string | null; transactions: Array<{ id: string }> }>;
      total: number; transaction_total: number; limit: number; offset: number;
    };
    expect(out.items).toHaveLength(1);
    expect(out.items[0].key).toBe('f1');
    expect(out.items[0].status).toBe('ready');
    expect(out.items[0].mime_type).toBe('image/png');
    expect(out.items[0].transactions.map(t => t.id).sort()).toEqual(['t1', 't2']);
    expect(out.total).toBe(1);
    expect(out.transaction_total).toBe(2);
  });

  it('本地引用（无 cloudFileId）→ local: 前缀 key + pending', async () => {
    const c = setup();
    seedTx('t1', '2026-05-01T10:00:00Z', [{ fileName: 'local.png', originalName: 'x.png' }]);
    const out = await listAttachments(c, { ledger_id: 'L1' }) as {
      items: Array<{ key: string; status: string }>;
    };
    expect(out.items[0].key).toBe('local:t1:0');
    expect(out.items[0].status).toBe('pending');
  });

  it('cloudFileId 在附件表里不存在 → missing', async () => {
    const c = setup();
    seedTx('t1', '2026-05-01T10:00:00Z', [{ cloudFileId: 'gone', fileName: 'g.png' }]);
    const out = await listAttachments(c, { ledger_id: 'L1' }) as { items: Array<{ status: string }> };
    expect(out.items[0].status).toBe('missing');
  });

  it('q 能命中备注/分类/账户（不只是文件名）', async () => {
    const c = setup();
    seedTx('t1', '2026-05-01T10:00:00Z', [{ fileName: 'r.png', originalName: 'r.png' }], '星巴克', '餐饮');
    const hit = await listAttachments(c, { ledger_id: 'L1', q: '星巴克' }) as { total: number };
    const miss = await listAttachments(c, { ledger_id: 'L1', q: '不存在的词' }) as { total: number };
    expect(hit.total).toBe(1);
    expect(miss.total).toBe(0);
  });

  it('分页：limit/offset 作用在文件维度', async () => {
    const c = setup();
    for (let i = 0; i < 3; i++) {
      seedTx(`t${i}`, `2026-05-0${i + 1}T10:00:00Z`, [{ cloudFileId: `f${i}`, fileName: `f${i}.png` }]);
    }
    const page = await listAttachments(c, { ledger_id: 'L1', limit: 2, offset: 1 }) as {
      items: Array<{ key: string }>; total: number; limit: number; offset: number;
    };
    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(2);
    expect(page.limit).toBe(2);
    expect(page.offset).toBe(1);
    // 按发生时间倒序：t2(05-03) → f2，所以第二页是 f1、f0
    expect(page.items.map(i => i.key)).toEqual(['f1', 'f0']);
  });
});
