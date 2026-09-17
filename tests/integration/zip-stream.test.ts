// 加密 zip 流式往返测试：createEncryptedZipStream（zip.js 2.15，ReadableStream entry）
// 产出 AES-256 加密 zip，用 ZipReader + 密码解回，校验流式附件内容与 data 条目一致。
import { describe, it, expect } from 'vitest';
import { ZipReader, Uint8ArrayReader, TextWriter } from '@zip.js/zip.js';
import { createEncryptedZipStream } from '../../src/lib/zip-lib';

describe('encrypted zip streaming', () => {
  it('round-trips data + stream entries with AES-256', async () => {
    const attachmentBytes = new TextEncoder().encode('FAKE_IMAGE_STREAM_CONTENT_附件内容');
    const entries = [
      { name: 'meta.json', data: new TextEncoder().encode('{"schemaVersion":1}') },
      { name: 'attachments/u1/led-1/ab/att-1_photo.jpg', size: attachmentBytes.length, stream: () => new Blob([attachmentBytes]).stream() },
    ];

    const zipBytes = await createEncryptedZipStream(entries, 'test-password');

    const reader = new ZipReader(new Uint8ArrayReader(zipBytes), { password: 'test-password' });
    try {
      const zipEntries = await reader.getEntries();
      expect(zipEntries.map(e => e.filename)).toEqual([
        'meta.json',
        'attachments/u1/led-1/ab/att-1_photo.jpg',
      ]);

      const meta = await zipEntries[0].getData(new TextWriter());
      expect(meta).toBe('{"schemaVersion":1}');

      const att = await zipEntries[1].getData(new TextWriter());
      expect(att).toBe('FAKE_IMAGE_STREAM_CONTENT_附件内容');
    } finally {
      await reader.close();
    }
  });
});
