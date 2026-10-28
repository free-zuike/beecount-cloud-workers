/**
 * XLSX 导入解析回归（上游 file_tools 用 openpyxl，Workers 侧用 src/mcp/xlsx.ts）。
 *
 * 覆盖：ZIP 中央目录解析、deflate-raw 解压、sharedStrings 取值、稀疏列补空、
 * 128 MiB 展开上限。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { createLedger, makeHarness, mcpCtx, registerDevice, registerUser, type Harness } from './mcp-harness';
import { previewImportFile, setAttachmentBytesSource } from '../src/mcp/file-tools';
import { parseXlsx, readZipDirectory } from '../src/mcp/xlsx';

let h: Harness;
let bytes: Record<string, Uint8Array> = {};

afterEach(() => {
  setAttachmentBytesSource(null);
  bytes = {};
  h?.sqlite.close();
});

// ── 最小 ZIP 构造器（够用即可：本地头 + 数据 + 中央目录 + EOCD）──
function buildZip(entries: Array<{ name: string; data: Uint8Array; deflate: boolean }>): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const raw = e.deflate ? new Uint8Array(deflateRawSync(Buffer.from(e.data))) : e.data;
    const local = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0, true);
    dv.setUint16(8, e.deflate ? 8 : 0, true);
    dv.setUint32(14, 0, true);
    dv.setUint32(18, raw.length, true);
    dv.setUint32(22, e.data.length, true);
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    chunks.push(local, raw);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, e.deflate ? 8 : 0, true);
    cv.setUint32(20, raw.length, true);
    cv.setUint32(24, e.data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += local.length + raw.length;
  }
  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  chunks.push(...central, eocd);

  const total = [...chunks].reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}

const SHARED = `<?xml version="1.0"?><sst><si><t>date</t></si><si><t>amount</t></si><si><t>note</t></si><si><t>lunch &amp; coffee</t></si></sst>`;
// 第 2 行故意跳空 B 列（C2 直接写入），验证稀疏列补空
const SHEET = `<?xml version="1.0"?><worksheet><sheetData>`
  + `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>`
  + `<row r="2"><c r="A2" t="inlineStr"><t>2026-05-01T10:00:00Z</t></c><c r="C2" t="s"><v>3</v></c></row>`
  + `</sheetData></worksheet>`;

function xlsxBytes(): Uint8Array {
  const enc = new TextEncoder();
  return buildZip([
    { name: 'xl/sharedStrings.xml', data: enc.encode(SHARED), deflate: true },
    { name: 'xl/worksheets/sheet1.xml', data: enc.encode(SHEET), deflate: false },
  ]);
}

function setup(): ReturnType<typeof mcpCtx> {
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

async function seedXlsx(c: ReturnType<typeof mcpCtx>, id: string, data: Uint8Array): Promise<void> {
  const buf = await crypto.subtle.digest('SHA-256', data as BufferSource);
  const sha256 = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  bytes[id] = data;
  h.sqlite
    .prepare(
      `INSERT INTO attachment_files (id, ledger_id, user_id, sha256, size_bytes, mime_type, file_name, storage_path, attachment_kind, created_at)
       VALUES (?, 'L1-i', 'u1', ?, ?, ?, ?, ?, 'transaction', '2026-01-01T00:00:00Z')`,
    )
    .run(
      id, sha256, data.length,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'import.xlsx', `attachments/L1-i/${id}_import.xlsx`,
    );
}

describe('xlsx 解析', () => {
  it('解压 + sharedStrings + 稀疏列补空', async () => {
    const data = xlsxBytes();
    expect(readZipDirectory(data).has('xl/worksheets/sheet1.xml')).toBe(true);
    const rows = await parseXlsx(data);
    expect(rows[0]).toEqual(['date', 'amount', 'note']);
    // 第 2 行 B 列缺失 → 补空，C 列取共享字符串（含实体解码）
    expect(rows[1][0]).toBe('2026-05-01T10:00:00Z');
    expect(rows[1][1]).toBe('');
    expect(rows[1][2]).toBe('lunch & coffee');
  });

  it('非 zip 内容 → Not a valid .xlsx', async () => {
    await expect(parseXlsx(new TextEncoder().encode('not a zip').slice(0, 40))).rejects.toThrow(/Not a valid \.xlsx/);
  });

  it('展开体积宣称超过 128 MiB → 拒绝', async () => {
    const enc = new TextEncoder();
    const tiny = enc.encode('<worksheet/>');
    const data = buildZip([{ name: 'xl/worksheets/sheet1.xml', data: tiny, deflate: false }]);
    // 伪造 uncompressedSize：把中央目录里的未压缩大小改成 129 MiB
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let i = 0; i + 4 <= data.length; i++) {
      if (dv.getUint32(i, true) === 0x02014b50) { dv.setUint32(i + 24, 129 * 1024 * 1024, true); break; }
    }
    await expect(parseXlsx(data)).rejects.toThrow(/Expanded workbook exceeds 128 MiB/);
  });
});

describe('preview_import_file 支持 xlsx', () => {
  it('按 xlsx 解析出候选行', async () => {
    const c = setup();
    await seedXlsx(c, 'f-xlsx', xlsxBytes());
    const out = await previewImportFile(c, {
      file_id: 'f-xlsx',
      mapping: { amount: 'amount', happened_at: 'date', note: 'note' },
    }) as { plan: { data: { items: Array<{ sources: Array<{ row_number: number }> }> } } | null; errors: unknown[] };
    // 第 2 行 amount 列为空 → 记 INVALID_TRANSACTION，plan 为 null（对齐上游错误语义）
    expect(out.plan).toBeNull();
    expect(out.errors).toHaveLength(1);
  });
});
