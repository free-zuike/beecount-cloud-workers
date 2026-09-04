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

export class DocsIndex {
  readonly lang: string;
  chunks: DocChunk[] = [];
  /** 行向量已 L2-normalize；query 时 dot 即 cosine。按 chunks 索引排列。 */
  matrix: Float32Array = new Float32Array(0);
  dim = 0;
  embeddingModel: string | null = null;
  buildTime: string | null = null;

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
}

export function normalizeLang(lang: string | null | undefined): string {
  if (!lang) return 'en';
  const s = lang.trim().toLowerCase().replace(/_/g, '-');
  return s.startsWith('zh') ? 'zh' : 'en';
}
