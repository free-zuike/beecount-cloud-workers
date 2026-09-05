/**
 * 文档索引 — 对齐原版 services/ai/docs_index.py。
 *
 * 加载 BeeCount-Website 构建的 sqlite 索引（meta + chunks + vector BLOB），
 * 内存中做 cosine top-K 检索。worker 无本地磁盘：索引字节由 R2 提供，
 * 解析用 sql.js（对齐 sqlite-writer.ts 先例）。
 */

export interface DocChunk {
  id: number;
  content: string;
  doc_path: string;
  doc_title: string;
  section: string;
  url: string;
}

export interface RetrievedChunk {
  chunk: DocChunk;
  score: number;
}

export interface DocsIndexMeta {
  embedding_model: string | null;
  dim: number;
  build_time: string | null;
  chunk_count: number;
}

/** RRF 融合常数（对齐原版 _RRF_OFFSET）。 */
const RRF_OFFSET = 60;
/** FTS5 trigram 最短长度（对齐原版 _MIN_TRIGRAM_QUERY_CHARS）。 */
const MIN_TRIGRAM_QUERY_CHARS = 3;
/** BM25 三列权重：content / doc_title / section（对齐原版 bm25(x, 1.0, 5.0, 4.0)）。 */
const BM25_COL_WEIGHTS = [1.0, 5.0, 4.0];

/**
 * FTS5 trigram tokenizer 的纯 JS 复刻：任意连续 3 字符即一个 token，
 * 大小写不敏感（默认 case_sensitive 0）。返回 token → 频次。
 */
function buildTrigramFreq(text: string): Map<string, number> {
  const folded = text.toLowerCase();
  const freq = new Map<string, number>();
  for (let i = 0; i + MIN_TRIGRAM_QUERY_CHARS <= folded.length; i++) {
    const tri = folded.slice(i, i + MIN_TRIGRAM_QUERY_CHARS);
    freq.set(tri, (freq.get(tri) ?? 0) + 1);
  }
  return freq;
}

export class DocsIndex {
  readonly lang: string;
  chunks: DocChunk[] = [];
  /** 行向量已 L2-normalize；query 时 dot 即 cosine。按 chunks 索引排列。 */
  matrix: Float32Array = new Float32Array(0);
  dim = 0;
  embeddingModel: string | null = null;
  buildTime: string | null = null;

  /** chunk.id → chunks 数组位置（对齐原版 _chunk_positions）。 */
  private chunkPositions = new Map<number, number>();
  /** 每 chunk 三列（content/doc_title/section）的 trigram 频次。 */
  private docTrigramFreq = new Map<number, Array<Map<string, number>>>();
  /** 每 chunk 三列的 trigram 数（BM25 的 dl）。 */
  private docLen = new Map<number, number[]>();
  /** trigram → 出现该 trigram 的文档数（BM25 的 df）。 */
  private df = new Map<string, number>();
  /** 三列平均 trigram 数（BM25 的 avgdl）。 */
  private avgdl = [0, 0, 0];
  private n = 0;

  private constructor(lang: string) {
    this.lang = lang;
  }

  /** sql.js 初始化是异步的（对齐 sqlite-writer.ts）；加载完成后才可用。 */
  static async create(lang: string, bytes: Uint8Array): Promise<DocsIndex> {
    const idx = new DocsIndex(lang);
    await idx.load(bytes);
    return idx;
  }

  private async load(bytes: Uint8Array): Promise<void> {
    let SQL: { Database: new (data?: Uint8Array) => { exec: (sql: string) => Array<{ columns: string[]; values: unknown[][] }>; close: () => void } };
    let db: { exec: (sql: string) => Array<{ columns: string[]; values: unknown[][] }>; close: () => void };
    try {
      // 与 sqlite-writer.ts 相同：asm 版无需 WASM fetch，但工厂返回 Promise
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const initSqlJs = require('sql.js/dist/sql-asm.js');
      if (typeof self !== 'undefined' && !(self as any).location) {
        (self as any).location = { href: 'http://localhost/', origin: 'http://localhost', protocol: 'http:', host: 'localhost', hostname: 'localhost', port: '80', pathname: '/', search: '', hash: '' };
      }
      SQL = await initSqlJs();
      db = new SQL.Database(bytes);
    } catch (err) {
      console.warn('[RAG] sql.js load failed:', err);
      return;
    }

    try {
      // meta: key/value
      const metaRes = db.exec('SELECT key, value FROM meta');
      if (metaRes.length > 0) {
        for (const row of metaRes[0].values) {
          const key = String(row[0]);
          const value = String(row[1]);
          if (key === 'embedding_model') this.embeddingModel = value;
          else if (key === 'dim') this.dim = Number(value) || 0;
          else if (key === 'build_time') this.buildTime = value;
        }
      }

      // chunks: id, content, doc_path, doc_title, section, url, vector(BLOB float32)
      const chunkRes = db.exec(
        'SELECT id, content, doc_path, doc_title, section, url, vector FROM chunks ORDER BY id'
      );
      const vectors: Float32Array[] = [];
      if (chunkRes.length > 0) {
        for (const row of chunkRes[0].values) {
          const [id, content, path, title, section, url, vecBytes] = row as [
            number, string, string, string, string, string, Uint8Array,
          ];
          this.chunks.push({
            id: Number(id),
            content: content ?? '',
            doc_path: path ?? '',
            doc_title: title ?? '',
            section: section ?? '',
            url: url ?? '',
          });
          // FTS5 trigram 检索统计（sql.js 无 FTS5 模块，纯 JS 复刻 chunks_fts 表）
          const chunkId = Number(id);
          this.chunkPositions.set(chunkId, this.chunks.length - 1);
          const columnTexts = [content ?? '', title ?? '', section ?? ''];
          const freqs = columnTexts.map(buildTrigramFreq);
          this.docTrigramFreq.set(chunkId, freqs);
          this.docLen.set(chunkId, freqs.map((m) => { let s = 0; for (const c of m.values()) s += c; return s; }));
          // sql.js BLOB → Uint8Array；float32 little-endian
          const bytesArr = vecBytes instanceof Uint8Array ? vecBytes : new Uint8Array(vecBytes as ArrayBuffer);
          vectors.push(new Float32Array(bytesArr.buffer, bytesArr.byteOffset, bytesArr.byteLength / 4));
        }
      }

      if (vectors.length > 0) {
        const dim = vectors[0].length;
        const m = new Float32Array(vectors.length * dim);
        for (let i = 0; i < vectors.length; i++) {
          const v = vectors[i];
          // L2-normalize（原版 numpy 同逻辑）
          let norm = 0;
          for (let j = 0; j < dim; j++) norm += v[j] * v[j];
          norm = Math.sqrt(norm);
          const inv = norm > 0 ? 1 / norm : 1;
          for (let j = 0; j < dim; j++) m[i * dim + j] = v[j] * inv;
        }
        this.matrix = m;
        this.dim = dim || this.dim;
      }

      // BM25 全局统计：df（跨列去重）与三列 avgdl
      this.n = this.chunks.length;
      const seenInDoc = new Set<string>();
      for (const freqs of this.docTrigramFreq.values()) {
        seenInDoc.clear();
        for (const freq of freqs) {
          for (const tri of freq.keys()) {
            if (seenInDoc.has(tri)) continue;
            seenInDoc.add(tri);
            this.df.set(tri, (this.df.get(tri) ?? 0) + 1);
          }
        }
      }
      const colTotal = [0, 0, 0];
      for (const lens of this.docLen.values()) {
        for (let col = 0; col < 3; col++) colTotal[col] += lens[col];
      }
      this.avgdl = this.n > 0 ? colTotal.map((s) => s / this.n) : [0, 0, 0];
    } finally {
      db.close();
    }
  }

  get is_empty(): boolean {
    return this.chunks.length === 0;
  }

  /**
   * cosine top-K。query_vector 无需预归一化。
   * 纯 JS 矩阵乘（无 numpy；索引 ~200-300 chunks × 1024 维，量级极小）。
   */
  search(queryVector: Iterable<number>, k = 4): RetrievedChunk[] {
    if (this.is_empty || this.dim === 0) return [];
    const q = new Float32Array(queryVector);
    if (q.length !== this.dim) {
      console.warn(
        `[RAG] embedding dim mismatch: query=${q.length} index=${this.dim} (lang=${this.lang}, model=${this.embeddingModel})`
      );
      return [];
    }
    let n = 0;
    for (let j = 0; j < this.dim; j++) n += q[j] * q[j];
    n = Math.sqrt(n);
    if (n === 0) return [];
    const inv = 1 / n;

    const scores = new Float32Array(this.chunks.length);
    for (let i = 0; i < this.chunks.length; i++) {
      let dot = 0;
      for (let j = 0; j < this.dim; j++) dot += this.matrix[i * this.dim + j] * q[j];
      scores[i] = dot * inv;
    }

    const actualK = Math.min(k, this.chunks.length);
    // 简单 top-K（数据量小，全排即可）
    const idx = Array.from(scores)
      .map((s, i) => ({ s, i }))
      .sort((a, b) => b.s - a.s)
      .slice(0, actualK);

    return idx.map(({ s, i }) => ({ chunk: this.chunks[i], score: s }));
  }

  /**
   * 向量 + 关键词混合检索（RRF 融合）——对齐原版 hybrid_search。
   * 索引无 FTS5 表或关键词不可用时自动回退纯向量检索。
   */
  hybridSearch(query: string, queryVector: Iterable<number>, k = 4, vectorK = 12, keywordK = 12): RetrievedChunk[] {
    if (this.is_empty || k <= 0) return [];

    const vectorResults = this.search(queryVector, Math.max(vectorK, 0));
    const keywordIds = this.keywordChunkIds(query, Math.max(keywordK, 0));

    const fused = new Map<number, number>();
    vectorResults.forEach((result, rank) => {
      const base = 1 / (RRF_OFFSET + rank + 1);
      fused.set(result.chunk.id, (fused.get(result.chunk.id) ?? 0) + base);
    });
    keywordIds.forEach((chunkId, rank) => {
      const base = 1 / (RRF_OFFSET + rank + 1);
      fused.set(chunkId, (fused.get(chunkId) ?? 0) + base);
    });

    const rankedIds = [...fused.entries()]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .slice(0, k);
    return rankedIds.map(([chunkId, score]) => ({
      chunk: this.chunks[this.chunkPositions.get(chunkId)!],
      score,
    }));
  }

  /**
   * FTS5 trigram 关键词候选，BM25 排序——对齐原版 _keyword_chunk_ids。
   * 查询切为中文整段 + 英文/数字词 → trigram OR → BM25(top 列权重 1.0/5.0/4.0)。
   */
  private keywordChunkIds(query: string, limit: number): number[] {
    const normalizedQuery = query.trim();
    if (limit <= 0 || normalizedQuery.length < MIN_TRIGRAM_QUERY_CHARS) return [];

    const chineseText = normalizedQuery.replace(/[^\u4e00-\u9fff]/g, '');
    const tokens = [
      ...(chineseText ? [chineseText] : []),
      ...(normalizedQuery.match(/[A-Za-z0-9_]+/g) ?? []).map((t) => t.toLowerCase()),
    ];
    const trigrams = new Set<string>();
    for (const token of tokens) {
      for (let offset = 0; offset + MIN_TRIGRAM_QUERY_CHARS <= token.length; offset++) {
        trigrams.add(token.slice(offset, offset + MIN_TRIGRAM_QUERY_CHARS));
      }
    }
    if (trigrams.size === 0) return [];

    const scored: Array<[number, number]> = [];
    for (const chunk of this.chunks) {
      const freqs = this.docTrigramFreq.get(chunk.id);
      const lens = this.docLen.get(chunk.id);
      if (!freqs || !lens) continue;
      // 任一查询 trigram 命中任一列才进入打分（等价 FTS5 MATCH OR）
      let hit = false;
      for (const tri of trigrams) {
        if (freqs[0].has(tri) || freqs[1].has(tri) || freqs[2].has(tri)) {
          hit = true;
          break;
        }
      }
      if (!hit) continue;
      scored.push([chunk.id, this.bm25Score(freqs, lens, trigrams)]);
    }
    scored.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    return scored.slice(0, limit).map(([id]) => id);
  }

  /** SQLite FTS5 bm25() 的纯 JS 复刻（k1=1.2, b=0.75，按列权重）。 */
  private bm25Score(
    freqs: Array<Map<string, number>>,
    lens: number[],
    trigrams: Set<string>,
  ): number {
    const k1 = 1.2;
    const b = 0.75;
    let score = 0;
    for (const tri of trigrams) {
      const docCount = this.df.get(tri) ?? 0;
      if (docCount === 0) continue;
      const idf = Math.log(1 + (this.n - docCount + 0.5) / (docCount + 0.5));
      for (let col = 0; col < 3; col++) {
        const tf = freqs[col].get(tri) ?? 0;
        if (tf === 0) continue;
        const denom = tf + k1 * (1 - b + b * (lens[col] / this.avgdl[col]));
        score += BM25_COL_WEIGHTS[col] * ((idf * tf * (k1 + 1)) / denom);
      }
    }
    return score;
  }
}

export function normalizeLang(lang: string | null | undefined): string {
  if (!lang) return 'en';
  const s = lang.trim().toLowerCase().replace(/_/g, '-');
  return s.startsWith('zh') ? 'zh' : 'en';
}
