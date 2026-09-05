/**
 * 混合检索测试 — 对齐原版 tests/test_docs_hybrid_search.py。
 * worker 的 sql.js 无 FTS5 模块，用纯 JS 复刻 trigram + BM25；
 * 三个场景断言与原版完全一致（关键词命中压过向量唯一命中）。
 */
import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import initSqlJs from 'sql.js/dist/sql-asm.js';

import { DocsIndex } from '../src/services/rag-index';

const CONTENT_CHUNK_1 = '# 交易记录\n\n编辑一笔交易的通用说明。';
const CONTENT_CHUNK_2 = '# 交易附件\n\n长按要删除的附件图片并确认删除。';

async function buildHybridIndex(): Promise<Uint8Array> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(`CREATE TABLE chunks (
    id INTEGER PRIMARY KEY, content TEXT NOT NULL, doc_path TEXT NOT NULL,
    doc_title TEXT, section TEXT, url TEXT, vector BLOB NOT NULL
  )`);
  db.run(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)`);
  const rows = [
    [1, CONTENT_CHUNK_1, 'record/edit.md', '交易记录', '编辑交易', 'https://example.test/1', [1.0, 0.0]],
    [2, CONTENT_CHUNK_2, 'record/attachment.md', '交易附件', '删除附件', 'https://example.test/2', [0.0, 1.0]],
  ];
  for (const [id, content, docPath, title, section, url, vector] of rows) {
    db.run(
      'INSERT INTO chunks VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, content, docPath, title, section, url, new Uint8Array(new Float32Array(vector as number[]).buffer)],
    );
  }
  db.run('INSERT INTO meta VALUES (?, ?)', ['dim', '2']);
  db.run('INSERT INTO meta VALUES (?, ?)', ['embedding_model', 'test-model']);
  const out = db.export();
  db.close();
  return new Uint8Array(out);
}

describe('DocsIndex hybridSearch', () => {
  it('promotes exact section keyword over vector-only match', async () => {
    const idx = await DocsIndex.create('zh', await buildHybridIndex());
    const result = idx.hybridSearch('删除附件', [1.0, 0.0], 1, 2, 2);
    expect(result.map((r) => r.chunk.id)).toEqual([2]);
  });

  it('matches keyword inside a natural language question', async () => {
    const idx = await DocsIndex.create('zh', await buildHybridIndex());
    const result = idx.hybridSearch('如何删除附件', [1.0, 0.0], 1, 2, 2);
    expect(result.map((r) => r.chunk.id)).toEqual([2]);
  });

  it('joins Chinese keywords split by punctuation', async () => {
    const idx = await DocsIndex.create('zh', await buildHybridIndex());
    const result = idx.hybridSearch('如何删除，附件？', [1.0, 0.0], 1, 2, 2);
    expect(result.map((r) => r.chunk.id)).toEqual([2]);
  });

  it('returns all vector-only results when keyword search finds nothing', async () => {
    const idx = await DocsIndex.create('zh', await buildHybridIndex());
    // 查询全是英文数字词且不命中任何 chunk（如 "zzz" 无 trigram 命中）→ 纯向量
    const result = idx.hybridSearch('zzzz', [1.0, 0.0], 4, 12, 12);
    expect(result[0].chunk.id).toBe(1);
  });
});