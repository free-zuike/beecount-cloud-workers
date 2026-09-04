/**
 * RAG 文档索引服务测试 — 对齐原版 tests/test_docs_refresh.py。
 * 用 sql.js 构造索引 sqlite 字节，验证：
 *  1. DocsIndex 加载（meta/chunks/dim）+ 余弦 top-K 检索
 *  2. refresh() 远端 hash 比对 → 下载校验 → 热切换 + 状态
 *  3. check_latest() 只比对 hash
 *  4. 校验失败保留旧索引
 */
import { describe, expect, it, beforeEach } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import initSqlJs from 'sql.js/dist/sql-asm.js';

import { DocsIndex, normalizeLang } from '../src/services/rag-index';
import {
  DocsRefreshService,
  resetRagService,
  type RagEnv,
} from '../src/services/rag-refresh';

// 构造一个最小索引库：meta + 1 条 chunk（2 维向量）
async function buildIndexBytes(opts: {
  content: string;
  buildTime: string;
  model: string;
  dim: number;
  vector: number[];
}): Promise<Uint8Array> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(`CREATE TABLE chunks (
    id INTEGER PRIMARY KEY, content TEXT NOT NULL, doc_path TEXT NOT NULL,
    doc_title TEXT, section TEXT, url TEXT, vector BLOB NOT NULL
  )`);
  db.run(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)`);
  db.run(
    `INSERT INTO chunks VALUES (1, ?, 'record/attachment.md', '附件', '删除附件', 'https://example.test', ?)`,
    [opts.content, new Uint8Array(new Float32Array(opts.vector).buffer)],
  );
  db.run('INSERT INTO meta VALUES (?, ?)', ['embedding_model', opts.model]);
  db.run('INSERT INTO meta VALUES (?, ?)', ['dim', String(opts.dim)]);
  db.run('INSERT INTO meta VALUES (?, ?)', ['build_time', opts.buildTime]);
  const out = db.export();
  db.close();
  return new Uint8Array(out);
}

describe('DocsIndex', () => {
  it('loads meta + chunks and runs cosine top-K search', async () => {
    const idx = await DocsIndex.create('zh', await buildIndexBytes({
      content: 'BeeCount 支持多币种',
      buildTime: '2026-09-03T12:00:00Z',
      model: 'test-model',
      dim: 2,
      vector: [1.0, 0.0],
    }));
    expect(idx.is_empty).toBe(false);
    expect(idx.dim).toBe(2);
    expect(idx.embeddingModel).toBe('test-model');
    expect(idx.buildTime).toBe('2026-09-03T12:00:00Z');
    expect(idx.chunks[0].content).toBe('BeeCount 支持多币种');

    // 与向量 [1,0] 完全对齐 → score ≈ 1
    const hits = idx.search([1.0, 0.0], 1);
    expect(hits.length).toBe(1);
    expect(hits[0].chunk.doc_path).toBe('record/attachment.md');
    expect(hits[0].score).toBeGreaterThan(0.99);

    // 维度不匹配 → 空
    expect(idx.search([1, 0, 0], 1)).toEqual([]);
  });

  it('normalizeLang maps zh variants to zh, others to en', () => {
    expect(normalizeLang('zh')).toBe('zh');
    expect(normalizeLang('zh-CN')).toBe('zh');
    expect(normalizeLang('zh_TW')).toBe('zh');
    expect(normalizeLang('en')).toBe('en');
    expect(normalizeLang('')).toBe('en');
    expect(normalizeLang(null)).toBe('en');
  });
});

describe('DocsRefreshService', () => {
  beforeEach(() => resetRagService());

  function makeEnv(extra?: Partial<RagEnv>): RagEnv {
    return { EMBEDDING_MODEL: 'test-model', ...extra };
  }

  it('refresh fetches, validates and hot-swaps both language indexes', async () => {
    const payloads = new Map<string, Uint8Array>([
      ['docs-index.hash', new TextEncoder().encode('new-corpus-hash\n')],
      ['docs-index.zh.sqlite', await buildIndexBytes({
        content: 'new zh', buildTime: '2026-09-03T12:00:00Z', model: 'test-model', dim: 2, vector: [1, 0],
      })],
      ['docs-index.en.sqlite', await buildIndexBytes({
        content: 'new en', buildTime: '2026-09-03T12:00:00Z', model: 'test-model', dim: 2, vector: [0, 1],
      })],
    ]);
    const service = new DocsRefreshService(makeEnv(), (name) => {
      const b = payloads.get(name);
      if (!b) throw new Error(`missing ${name}`);
      return Promise.resolve(b);
    });

    const status = await service.refresh();
    expect(status.corpus_hash).toBe('new-corpus-hash');
    expect(status.source).toBe('runtime-cache');
    expect(status.is_latest).toBe(true);
    expect(status.languages.zh.build_time).toBe('2026-09-03T12:00:00Z');
    expect(service.getIndex('zh')!.chunks[0].content).toBe('new zh');
    expect(service.getIndex('en')!.chunks[0].content).toBe('new en');

    // 再刷一次相同 hash → 不换索引，is_latest=true
    const status2 = await service.refresh();
    expect(status2.is_latest).toBe(true);
    expect(service.getIndex('zh')!.chunks[0].content).toBe('new zh');
  });

  it('checkLatest only compares remote hash without swapping', async () => {
    const payloads = new Map<string, Uint8Array>([
      ['docs-index.hash', new TextEncoder().encode('abc123\n')],
    ]);
    const service = new DocsRefreshService(makeEnv(), (name) => {
      const b = payloads.get(name);
      if (!b) throw new Error(`missing ${name}`);
      return Promise.resolve(b);
    });

    const status = await service.checkLatest();
    expect(status.remote_corpus_hash).toBe('abc123');
    expect(status.is_latest).toBe(false); // corpus_hash 为空 → false
    expect(service.getIndex('zh')).toBeNull();
  });

  it('keeps active indexes when a downloaded file is invalid', async () => {
    const validZh = await buildIndexBytes({
      content: 'ok zh', buildTime: '2026-01-01T00:00:00Z', model: 'test-model', dim: 2, vector: [1, 0],
    });
    const service = new DocsRefreshService(makeEnv(), async (name) => {
      // zh 正常、en 被破坏（空库 → is_empty → 校验失败）
      if (name === 'docs-index.hash') return new TextEncoder().encode('new-hash\n');
      if (name === 'docs-index.zh.sqlite') return validZh;
      const SQL = await initSqlJs();
      const db = new SQL.Database();
      db.run('CREATE TABLE chunks (id INTEGER PRIMARY KEY, content TEXT, doc_path TEXT, doc_title TEXT, section TEXT, url TEXT, vector BLOB)');
      db.run('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
      const out = db.export();
      db.close();
      return new Uint8Array(out);
    });

    const status = await service.refresh();
    expect(status.corpus_hash).toBeNull(); // 校验失败 → 未切换
    expect(status.last_error).toContain('has no chunks');
    expect(service.getIndex('zh')).toBeNull(); // 无旧索引 → 仍不可用
  });

  it('statusValue exposes RagIndexStatus shape used by frontend', async () => {
    const service = new DocsRefreshService(makeEnv(), () => Promise.reject(new Error('no remote')));
    const status = await service.refresh(); // refresh 失败 → last_error
    expect(status.source).toBe('none');
    expect(status.last_error).toBeDefined();
    expect(status.languages).toEqual({});
    // 失败且拿不到远端 hash → is_latest 保持 null（对齐原版）
    expect(status.is_latest).toBeNull();
  });
});
