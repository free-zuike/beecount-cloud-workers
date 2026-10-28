/**
 * 文件/导入导出工具对齐回归（上游 src/mcp/file_tools.py）。
 *
 * - attachment_bytes：只认 transaction 附件、sha256 完整性校验
 * - read_attachment：图片/文本/资源链接分流
 * - preview_import_file：默认 source_id 带行号（不再整文件撞号）
 * - export_transactions：列集合、币种回落、tag_id 精确匹配、日期边界按时区
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createLedger, makeHarness, mcpCtx, registerDevice, registerUser, type Harness } from './mcp-harness';
import {
  attachmentBytes,
  exportTransactions,
  previewImportFile,
  readAttachment,
  setAttachmentBytesSource,
} from '../src/mcp/file-tools';
import type { McpContext } from '../src/mcp/types';

let h: Harness;
let bytes: Record<string, Uint8Array> = {};

afterEach(() => {
  setAttachmentBytesSource(null);
  bytes = {};
  h?.sqlite.close();
});

async function sha256Hex(data: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function seedFile(
  id: string,
  content: string | Uint8Array,
  mime: string,
  kind = 'transaction',
  fileName = `${id}.bin`,
): Promise<{ sha256: string; size: number }> {
  const data = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  const sha256 = await sha256Hex(data);
  bytes[id] = data;
  h.sqlite
    .prepare(
      `INSERT INTO attachment_files (id, ledger_id, user_id, sha256, size_bytes, mime_type, file_name, storage_path, attachment_kind, created_at)
       VALUES (?, 'L1-i', 'u1', ?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00Z')`,
    )
    .run(id, sha256, data.length, mime, fileName, `attachments/L1-i/${id}_${fileName}`, kind);
  return { sha256, size: data.length };
}

function setup(): McpContext {
  h = makeHarness();
  registerUser(h, 'u1', 'u1@example.com');
  registerDevice(h, 'u1');
  createLedger(h, 'u1', 'L1-i', 'L1', '主账本');
  setAttachmentBytesSource(async (_c, fileId) => {
    const data = bytes[fileId];
    if (!data) throw new Error('Attachment storage unavailable');
    return data;
  });
  return mcpCtx(h, 'u1');
}

describe('attachment_bytes（对齐上游）', () => {
  it('非 transaction 附件一律 Attachment not found', async () => {
    const c = setup();
    await seedFile('f-icon', 'x', 'image/png', 'category_icon', 'icon.png');
    await expect(attachmentBytes(c, { file_id: 'f-icon' })).rejects.toThrow(/Attachment not found/);
  });

  it('sha256 不匹配 → Attachment integrity check failed', async () => {
    const c = setup();
    await seedFile('f1', 'hello', 'text/plain');
    // 篡改字节源（大小一致、内容不同）
    bytes['f1'] = new TextEncoder().encode('world');
    await expect(attachmentBytes(c, { file_id: 'f1' })).rejects.toThrow(/Attachment integrity check failed/);
  });
});

describe('read_attachment（对齐上游内容分流）', () => {
  it('图片且 ≤ 8 MiB → image 内容', async () => {
    const c = setup();
    await seedFile('f-img', 'PNGDATA', 'image/png', 'transaction', 'r.png');
    const out = await readAttachment(c, { file_id: 'f-img' }) as { content: Array<Record<string, unknown>> };
    expect(out.content[0].type).toBe('text');
    expect(out.content[1].type).toBe('image');
    expect(out.content[1].mimeType).toBe('image/png');
  });

  it('小文本 → text 内容', async () => {
    const c = setup();
    await seedFile('f-txt', 'colA,colB\n1,2', 'text/csv', 'transaction', 't.csv');
    const out = await readAttachment(c, { file_id: 'f-txt' }) as { content: Array<Record<string, unknown>> };
    expect(out.content[1].type).toBe('text');
  });

  it('其他/大文件 → 只给认证资源链接', async () => {
    const c = setup();
    await seedFile('f-bin', 'x'.repeat(32), 'application/pdf', 'transaction', 'a.pdf');
    const out = await readAttachment(c, { file_id: 'f-bin' }) as { content: Array<Record<string, unknown>> };
    expect(out.content[1]).toMatchObject({ type: 'resource_link', uri: 'beecount://attachments/f-bin' });
  });
});

describe('preview_import_file（对齐上游 source_id 契约）', () => {
  it('默认 source_id 带行号，多行不撞号', async () => {
    const c = setup();
    const { sha256 } = await seedFile(
      'f-csv',
      'date,amount,note\n2026-05-01T10:00:00Z,12.5,lunch\n2026-05-02T10:00:00Z,30,dinner\n',
      'text/csv',
    );
    const out = await previewImportFile(c, {
      file_id: 'f-csv',
      mapping: { amount: 'amount', happened_at: 'date', note: 'note' },
    }) as { plan: { data: string } };
    // 对齐上游 record_out：data 是原始 JSON 字符串，需自行解析
    const planData = JSON.parse(out.plan.data as string) as { items: Array<{ sources: Array<{ source_id: string; row_number: number }> }> };
    const sources = planData.items.flatMap(cand => cand.sources);
    expect(sources.map(s => s.source_id)).toEqual([`${sha256}:2`, `${sha256}:3`]);
    expect(sources.map(s => s.row_number)).toEqual([2, 3]);
  });

  it('空 source_id（指定列为空）→ 记错误且不生成 plan', async () => {
    const c = setup();
    await seedFile('f-csv2', 'date,amount,oid\n2026-05-01T10:00:00Z,12.5,\n', 'text/csv');
    const out = await previewImportFile(c, {
      file_id: 'f-csv2',
      mapping: { amount: 'amount', happened_at: 'date' },
      source_id_column: 'oid',
    }) as { status: string; plan: unknown; errors: Array<{ row_number: number; code: string }> };
    expect(out.status).toBe('mapping_or_data_errors');
    expect(out.plan).toBeNull();
    expect(out.errors[0]).toMatchObject({ row_number: 2, code: 'EMPTY_SOURCE_ID' });
  });
});

describe('export_transactions（对齐上游 CSV 契约）', () => {
  function seedTx(c: McpContext, syncId: string, happenedAt: string, tags: string, currency: string | null): void {
    h.sqlite
      .prepare(
        `INSERT INTO read_tx_projection (ledger_id, sync_id, user_id, tx_type, amount, happened_at, note,
         category_sync_id, category_name, account_sync_id, account_name, from_account_sync_id, from_account_name,
         to_account_sync_id, to_account_name, tag_sync_ids_json, currency_code, native_amount, exclude_from_stats, exclude_from_budget)
         VALUES ('L1-i', ?, 'u1', 'expense', 10, ?, 'n', 'c1', '餐饮', 'a1', '现金', NULL, NULL, NULL, NULL, ?, ?, 10, 0, 0)`,
      )
      .run(syncId, happenedAt, tags, currency);
  }

  it('列集合与币种回落对齐上游', async () => {
    const c = setup();
    seedTx(c, 't1', '2026-05-13T02:00:00Z', '[]', null);
    const out = await exportTransactions(c, { ledger_id: 'L1' }) as { export_id: string; row_count: number };
    const row = h.sqlite
      .prepare('SELECT data_json FROM mcp_state_records WHERE id = ?')
      .get(out.export_id) as { data_json: string };
    const csv = JSON.parse(row.data_json).csv as string;
    const header = csv.replace(/^\uFEFF/, '').split('\r\n')[0];
    expect(header).toBe(
      'sync_id,tx_type,amount,happened_at,note,category_id,category_name,account_id,account_name,'
      + 'from_account_id,from_account_name,to_account_id,to_account_name,tags,currency_code,native_amount,'
      + 'exclude_from_stats,exclude_from_budget',
    );
    expect(csv).toContain('CNY'); // 币种回落到账本币种
    expect(out.row_count).toBe(1);
  });

  it('tag_id 精确匹配（不做子串匹配）', async () => {
    const c = setup();
    seedTx(c, 't1', '2026-05-13T02:00:00Z', '["tag-a"]', 'CNY');
    seedTx(c, 't2', '2026-05-14T02:00:00Z', '["tag-ab"]', 'CNY');
    const out = await exportTransactions(c, { ledger_id: 'L1', tag_id: 'tag-a' }) as { row_count: number };
    expect(out.row_count).toBe(1);
  });

  it('日期边界按 time_zone 折算（Asia/Shanghai）', async () => {
    const c = setup();
    seedTx(c, 't1', '2026-05-12T20:00:00Z', '[]', 'CNY'); // 上海时间 2026-05-13 04:00
    seedTx(c, 't2', '2026-05-12T10:00:00Z', '[]', 'CNY'); // 上海时间 2026-05-12 18:00
    const out = await exportTransactions(c, {
      ledger_id: 'L1',
      date_from: '2026-05-13',
      date_to: '2026-05-13',
      time_zone: 'Asia/Shanghai',
    }) as { row_count: number };
    expect(out.row_count).toBe(1);
  });
});


