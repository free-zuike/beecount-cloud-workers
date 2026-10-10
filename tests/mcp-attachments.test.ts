import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execTool, resolveTransactionAttachments, decodeStrictBase64 } from '../src/routes/mcp';
import { createRealDb } from './helpers/realsql-db';

// 上传/附件测试需要的真实表结构（与 src/db/schema.ts attachment_files 对齐）
const ATTACH_TABLES = `
  CREATE TABLE ledgers (id TEXT PRIMARY KEY, user_id TEXT, external_id TEXT, name TEXT, currency TEXT, created_at TEXT);
  CREATE TABLE ledger_members (ledger_id TEXT, user_id TEXT, role TEXT, joined_at TEXT);
  CREATE TABLE sync_changes (
    change_id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, ledger_id TEXT, entity_type TEXT,
    entity_sync_id TEXT, action TEXT, payload_json TEXT, updated_at TEXT,
    updated_by_user_id TEXT, updated_by_device_id TEXT, scope TEXT
  );
  CREATE TABLE attachment_files (
    id TEXT PRIMARY KEY, ledger_id TEXT, user_id TEXT, sha256 TEXT, size_bytes INTEGER,
    mime_type TEXT, file_name TEXT, storage_path TEXT, attachment_kind TEXT, created_at TEXT
  );
  CREATE TABLE mcp_call_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, pat_id TEXT, pat_prefix TEXT, pat_name TEXT,
    tool_name TEXT, status TEXT, error_message TEXT, args_summary TEXT, duration_ms INTEGER, called_at TEXT
  );
`;

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function setupDb() {
  const { sqlite, db } = createRealDb();
  sqlite.exec(ATTACH_TABLES);
  sqlite.exec(`
    INSERT INTO ledgers (id, user_id, external_id, name, currency, created_at) VALUES
      ('led-1', 'u1', 'ledger-1', '主账本', 'CNY', '2026-01-01T00:00:00Z'),
      ('led-2', 'u2', 'ledger-2', '他人账本', 'CNY', '2026-01-01T00:00:00Z');
    INSERT INTO ledger_members (ledger_id, user_id, role, joined_at) VALUES ('led-1', 'u1', 'owner', '2026-01-01T00:00:00Z');
  `);
  return { sqlite, db };
}

// 预置附件行：led-1 有 f1/f2（transaction），led-2 有 f3，category_icon f4
function seedAttachments(sqlite: any) {
  sqlite.exec(`
    INSERT INTO attachment_files (id, ledger_id, user_id, sha256, size_bytes, mime_type, file_name, storage_path, attachment_kind, created_at) VALUES
      ('f1', 'led-1', 'u1', 'sha1', 10, 'image/png', 'a.png', 'attachments/ledger-1/f1_a.png', 'transaction', '2026-01-01T00:00:00Z'),
      ('f2', 'led-1', 'u1', 'sha2', 20, 'image/jpeg', 'b.jpg', 'attachments/ledger-1/f2_b.jpg', 'transaction', '2026-01-01T00:00:00Z'),
      ('f3', 'led-2', 'u2', 'sha3', 30, 'image/png', 'c.png', 'attachments/ledger-2/f3_c.png', 'transaction', '2026-01-01T00:00:00Z'),
      ('f4', 'led-1', 'u1', 'sha4', 40, 'image/png', 'icon.png', 'category-icons/u1/f4_icon.png', 'category_icon', '2026-01-01T00:00:00Z');
  `);
}

describe('resolveTransactionAttachments (对齐原版 attachments.py)', () => {
  function freshDb() {
    const { sqlite, db } = setupDb();
    seedAttachments(sqlite);
    return db;
  }

  it('returns [] for an empty list', async () => {
    const { db } = setupDb();
    expect(await resolveTransactionAttachments(db, 'led-1', [])).toEqual([]);
  });

  it('rejects empty / whitespace / non-string ids', async () => {
    const db = freshDb();
    await expect(resolveTransactionAttachments(db, 'led-1', [''])).rejects.toThrow(/non-empty uploaded file IDs/);
    await expect(resolveTransactionAttachments(db, 'led-1', ['  '])).rejects.toThrow(/non-empty uploaded file IDs/);
    await expect(resolveTransactionAttachments(db, 'led-1', [123 as any])).rejects.toThrow(/non-empty uploaded file IDs/);
  });

  it('rejects duplicate ids', async () => {
    const db = freshDb();
    await expect(resolveTransactionAttachments(db, 'led-1', ['f1', 'f1'])).rejects.toThrow(/Duplicate attachment file IDs/);
  });

  it('preserves order and sets sortOrder', async () => {
    const db = freshDb();
    const out = await resolveTransactionAttachments(db, 'led-1', ['f2', 'f1']);
    expect(out.map(a => a.sortOrder)).toEqual([0, 1]);
    expect(out.map(a => a.cloudFileId)).toEqual(['f2', 'f1']);
  });

  it('builds the camelCase contract fields', async () => {
    const db = freshDb();
    const out = await resolveTransactionAttachments(db, 'led-1', ['f1']);
    expect(out[0]).toEqual({
      fileName: 'f1_a.png',
      originalName: 'a.png',
      fileSize: 10,
      mimeType: 'image/png',
      cloudFileId: 'f1',
      cloudSha256: 'sha1',
      sortOrder: 0,
    });
  });

  it('rejects unknown ids with a generic error (no existence leak)', async () => {
    const db = freshDb();
    await expect(resolveTransactionAttachments(db, 'led-1', ['nope'])).rejects.toThrow(/Attachment not found in the target ledger/);
  });

  it('does not leak files belonging to other ledgers', async () => {
    const db = freshDb();
    // f3 属于 led-2：对 led-1 解析必须与「未知 ID」报同样错误
    await expect(resolveTransactionAttachments(db, 'led-1', ['f3'])).rejects.toThrow(/Attachment not found in the target ledger/);
  });

  it('rejects category icons as transaction attachments', async () => {
    const db = freshDb();
    await expect(resolveTransactionAttachments(db, 'led-1', ['f4'])).rejects.toThrow(/Attachment not found in the target ledger/);
  });
});

describe('upload_attachment (execTool 集成)', () => {
  let sqlite: any;
  let db: D1Database;
  let r2Put: ReturnType<typeof vi.fn>;
  let env: { JWT_SECRET: string; R2: R2Bucket };

  beforeEach(() => {
    const setup = setupDb();
    sqlite = setup.sqlite; db = setup.db;
    r2Put = vi.fn(async () => ({}));
    env = { JWT_SECRET: 'test-secret', R2: { put: r2Put } as unknown as R2Bucket };
  });

  const callUpload = (args: Record<string, unknown>, scopes = ['mcp:write']) =>
    execTool(db, env, 'https://beecount.example.com', 'u1', scopes, 'upload_attachment', args, 'pat-1', 'bcmcp_test', 'test-pat');

  it('uploads base64 bytes and persists metadata', async () => {
    const bytes = new TextEncoder().encode('hello receipt bytes');
    const res = await callUpload({ file_name: 'receipt.png', content_base64: toBase64(bytes) });
    const out = JSON.parse(res.content[0].text);
    expect(out.file_id).toBeTruthy();
    expect(out.ledger_id).toBe('ledger-1');
    expect(out.sha256).toBe(await sha256Hex(bytes));
    expect(out.size).toBe(bytes.length);
    expect(out.mime_type).toBe('image/png');
    expect(out.file_name).toBe('receipt.png');
    expect(out.created_at).toBeTruthy();
    expect(r2Put).toHaveBeenCalledTimes(1);
    const row = sqlite.prepare('SELECT * FROM attachment_files WHERE id = ?').get(out.file_id);
    expect(row).toBeTruthy();
    expect(row.storage_path).toBe(`attachments/ledger-1/${out.file_id}_receipt.png`);
  });

  it('reuses the same file_id for identical bytes (dedup)', async () => {
    const bytes = new TextEncoder().encode('same bytes twice');
    const b64 = toBase64(bytes);
    const r1 = JSON.parse((await callUpload({ file_name: 'a.png', content_base64: b64 })).content[0].text);
    const r2 = JSON.parse((await callUpload({ file_name: 'a.png', content_base64: b64 })).content[0].text);
    expect(r1.file_id).toBe(r2.file_id);
    expect(r2Put).toHaveBeenCalledTimes(1);
    const cnt = sqlite.prepare('SELECT COUNT(*) c FROM attachment_files WHERE sha256 = ?').get(await sha256Hex(bytes)).c;
    expect(cnt).toBe(1);
  });

  it('accepts an explicit mime_type override', async () => {
    const res = await callUpload({ file_name: 'scan.pdf', content_base64: toBase64(new Uint8Array([1, 2, 3])), mime_type: 'application/pdf' });
    expect(JSON.parse(res.content[0].text).mime_type).toBe('application/pdf');
  });

  it('sanitizes path-traversal file names', async () => {
    const res = await callUpload({ file_name: '../x/../../y.png', content_base64: toBase64(new Uint8Array([1, 2, 3])) });
    expect(JSON.parse(res.content[0].text).file_name).toBe('y.png');
  });

  it('rejects invalid base64 (garbage / data URL prefix / CJK / bad length)', async () => {
    await expect(callUpload({ file_name: 'a.png', content_base64: 'not-base64!!' })).rejects.toThrow(/not valid base64/);
    await expect(callUpload({ file_name: 'a.png', content_base64: 'data:image/png;base64,AAAA' })).rejects.toThrow(/not valid base64/);
    await expect(callUpload({ file_name: 'a.png', content_base64: '中文' })).rejects.toThrow(/not valid base64/);
    await expect(callUpload({ file_name: 'a.png', content_base64: 'abc' })).rejects.toThrow(/not valid base64/);
  });

  it('rejects an empty file', async () => {
    await expect(callUpload({ file_name: 'a.png', content_base64: '' })).rejects.toThrow(/file is empty/);
  });

  it('rejects files over the 64 MiB upload limit', async () => {
    const big = new Uint8Array(64 * 1024 * 1024 + 1);
    await expect(callUpload({ file_name: 'big.png', content_base64: toBase64(big) })).rejects.toThrow(/File too large \(max 64 MiB\)/);
  }, 30000);

  it('requires mcp:write scope (mcp:read cannot upload)', async () => {
    await expect(callUpload({ file_name: 'a.png', content_base64: toBase64(new Uint8Array([1])) }, ['mcp:read'])).rejects.toThrow(/PAT missing required scope: mcp:write/);
  });

  it('returns ledger_not_found for an unknown ledger_id', async () => {
    const res = await callUpload({ file_name: 'a.png', content_base64: toBase64(new Uint8Array([1])), ledger_id: 'nope' });
    const out = JSON.parse(res.content[0].text);
    expect(out.status).toBe('ledger_not_found');
  });

  it('does not leak file content into the call log summary', async () => {
    await callUpload({ file_name: 'secret.png', content_base64: toBase64(new TextEncoder().encode('TOP-SECRET-BYTES')) });
    const log = sqlite.prepare('SELECT args_summary FROM mcp_call_logs WHERE tool_name = ? ORDER BY id DESC LIMIT 1').get('upload_attachment');
    const keys = JSON.parse(log.args_summary);
    expect(keys).toContain('file_name');
    expect(keys).toContain('content_base64');
    expect(log.args_summary).not.toContain('secret.png');
    expect(log.args_summary).not.toContain('TOP-SECRET-BYTES');
  });
});

describe('decodeStrictBase64', () => {
  it('decodes valid base64 to the original bytes', () => {
    const bytes = new TextEncoder().encode('Hello, 中文！');
    const decoded = decodeStrictBase64(toBase64(bytes));
    expect(Array.from(decoded)).toEqual(Array.from(bytes));
  });

  it('rejects malformed input', () => {
    expect(() => decodeStrictBase64('')).not.toThrow();
    expect(() => decodeStrictBase64('a')).toThrow(/not valid base64/);
    expect(() => decodeStrictBase64('a b c')).toThrow(/not valid base64/);
    expect(() => decodeStrictBase64('!!!!')).toThrow(/not valid base64/);
    expect(() => decodeStrictBase64('YWJj===')).toThrow(/not valid base64/);
  });
});
