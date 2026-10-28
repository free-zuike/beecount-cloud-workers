/**
 * 极简 XLSX（.xlsx）只读解析。
 *
 * 上游用 openpyxl；Workers 没有 Python 生态，这里直接用 Web 标准 API：
 * ZIP 中央目录 → DecompressionStream('deflate-raw') → 解析 sharedStrings + sheet1。
 * 只取导入预览需要的"二维字符串表"，不做样式/公式/合并单元格。
 */

interface ZipEntry {
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** 解析 ZIP 中央目录（含 zip64 的最小支持：大小用 32 位字段，超 4GiB 直接报错） */
export function readZipDirectory(bytes: Uint8Array): Map<string, ZipEntry> {
  const dv = view(bytes);
  const out = new Map<string, ZipEntry>();
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 65558; i--) {
    if (dv.getUint32(i, true) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid .xlsx (zip) file');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || dv.getUint32(p, true) !== CD_SIG) break;
    const method = dv.getUint16(p + 10, true);
    const compressedSize = dv.getUint32(p + 20, true);
    const uncompressedSize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const name = new TextDecoder('utf-8').decode(bytes.subarray(p + 46, p + 46 + nameLen));
    out.set(name, { method, compressedSize, uncompressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function entryData(bytes: Uint8Array, entry: ZipEntry): Uint8Array {
  const dv = view(bytes);
  const base = entry.localOffset;
  if (dv.getUint32(base, true) !== LOCAL_SIG) throw new Error('Not a valid .xlsx (zip) file');
  const nameLen = dv.getUint16(base + 26, true);
  const extraLen = dv.getUint16(base + 28, true);
  const start = base + 30 + nameLen + extraLen;
  return bytes.subarray(start, start + entry.compressedSize);
}

/** raw DEFLATE 解压（Workers 与 Node 18+ 都支持 DecompressionStream('deflate-raw')） */
export async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('XLSX import is unavailable in this runtime');
  }
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  await writer.write(data as unknown as Uint8Array);
  await writer.close();
  const buf = await new Response(ds.readable as ReadableStream).arrayBuffer();
  return new Uint8Array(buf);
}

/** 列引用 A1 → 0-based 列号 */
function colIndex(ref: string): number {
  const m = ref.match(/^([A-Z]+)/);
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    const texts = [...m[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(t => decodeXmlEntities(t[1]));
    out.push(texts.join(''));
  }
  return out;
}

function parseSheet(xml: string, shared: string[]): string[][] {
  const rows: string[][] = [];
  for (const rowMatch of xml.matchAll(/<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const c of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g)) {
      const attrs = c[1] ?? c[3] ?? '';
      const ref = (attrs.match(/\br="([A-Z]+\d+)"/) ?? [])[1] ?? '';
      const type = (attrs.match(/\bt="([a-z]+)"/) ?? [])[1] ?? 'n';
      const idx = ref ? colIndex(ref) : cells.length;
      let value = '';
      const vMatch = (c[2] ?? '').match(/<v>([\s\S]*?)<\/v>/);
      const inlineMatch = (c[2] ?? '').match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/);
      if (type === 's' && vMatch) {
        value = shared[Number(vMatch[1])] ?? '';
      } else if (type === 'inlineStr' && inlineMatch) {
        value = decodeXmlEntities(inlineMatch[1]);
      } else if (vMatch) {
        value = decodeXmlEntities(vMatch[1]);
      } else if (inlineMatch) {
        value = decodeXmlEntities(inlineMatch[1]);
      }
      while (cells.length < idx) cells.push('');
      cells[idx] = value;
    }
    rows.push(cells);
  }
  return rows;
}

/** 解析 .xlsx 为二维字符串表（对齐上游：展开后总体积 > 128 MiB 直接拒） */
export async function parseXlsx(bytes: Uint8Array): Promise<string[][]> {
  const dir = readZipDirectory(bytes);
  const MAX_EXPANDED = 128 * 1024 * 1024;
  let expanded = 0;
  const readText = async (name: string): Promise<string | null> => {
    const entry = dir.get(name);
    if (!entry) return null;
    expanded += entry.uncompressedSize;
    if (expanded > MAX_EXPANDED) throw new Error('Expanded workbook exceeds 128 MiB');
    const raw = entry.method === 0 ? entryData(bytes, entry) : await inflateRaw(entryData(bytes, entry));
    return new TextDecoder('utf-8').decode(raw);
  };
  const sharedXml = await readText('xl/sharedStrings.xml');
  const shared = sharedXml ? parseSharedStrings(sharedXml) : [];
  const sheetXml = await readText('xl/worksheets/sheet1.xml');
  if (!sheetXml) throw new Error('Workbook has no readable worksheet');
  return parseSheet(sheetXml, shared);
}
