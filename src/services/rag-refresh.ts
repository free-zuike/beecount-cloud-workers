/**
 * RAG 文档索引刷新服务 — 对齐原版 services/ai/docs_refresh.py。
 *
 * worker 无本地磁盘/持久卷：索引文件存 R2（beecount/rag-index/ 前缀）。
 * - 启动/首次访问时从 R2 加载已持久化的索引对（zh/en + hash）
 * - refresh(): 拉取远端 hash → 比对 → 下载校验新的索引对 → 原子热切换
 * - check_latest(): 只拉小 hash 文件比对，不下载索引
 * - status(): 返回当前版本状态（对齐原版 DocsIndexStatus.as_dict()）
 */

import { DocsIndex, normalizeLang, type RetrievedChunk } from './rag-index';

const INDEX_FILES = ['docs-index.zh.sqlite', 'docs-index.en.sqlite'];
const R2_PREFIX = 'beecount/rag-index/';

export interface RagLanguageStatus {
  build_time: string | null;
  chunk_count: number;
  dim: number;
}

export interface RagIndexStatus {
  source: string;
  corpus_hash: string | null;
  embedding_model: string | null;
  languages: Record<string, RagLanguageStatus>;
  last_checked_at: string | null;
  last_updated_at: string | null;
  last_error: string | null;
  remote_corpus_hash: string | null;
  is_latest: boolean | null;
}

export interface RagEnv {
  R2?: R2Bucket;
  RAG_INDEX_SOURCE_URL?: string;
  EMBEDDING_MODEL?: string;
  EMBEDDING_BASE_URL?: string;
  EMBEDDING_API_KEY?: string;
  RAG_INDEX_REFRESH_TIMEOUT?: string;
}

/** server-side embedding 未配置 — 对齐原版 EmbeddingNotConfiguredError */
export class EmbeddingNotConfiguredError extends Error {}

/**
 * 用 server 持有的 embedding key 把文本转向量（对齐原版 provider_client.embed_query）。
 * 配置走 env：EMBEDDING_BASE_URL / EMBEDDING_API_KEY / EMBEDDING_MODEL。
 */
export async function embedQuery(env: RagEnv, text: string): Promise<number[]> {
  const apiKey = env.EMBEDDING_API_KEY?.trim();
  if (!apiKey) throw new EmbeddingNotConfiguredError('EMBEDDING_API_KEY 未配置');
  const baseUrl = (env.EMBEDDING_BASE_URL?.trim() || 'https://api.siliconflow.cn/v1').replace(/\/$/, '');
  const model = env.EMBEDDING_MODEL?.trim() || 'BAAI/bge-m3';
  const timeout = Number(env.RAG_INDEX_REFRESH_TIMEOUT) || 15000;
  const resp = await fetch(`${baseUrl}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, input: text }),
    signal: AbortSignal.timeout(timeout),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`embedding API error: HTTP ${resp.status} ${body.slice(0, 200)}`);
  }
  const data = (await resp.json()) as { data?: Array<{ embedding: unknown }> };
  const embedding = data.data?.[0]?.embedding;
  if (!Array.isArray(embedding)) throw new Error('embedding API 返回 shape 异常');
  return embedding.map((x) => Number(x));
}

interface ActiveIndexes {
  zh: DocsIndex;
  en: DocsIndex;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class DocsRefreshService {
  private env: RagEnv;
  private indexes: ActiveIndexes | null = null;
  private status: RagIndexStatus;
  private fetchOverride: ((filename: string) => Promise<Uint8Array>) | null = null;

  constructor(env: RagEnv, fetchOverride?: (filename: string) => Promise<Uint8Array>) {
    this.env = env;
    this.fetchOverride = fetchOverride ?? null;
    this.status = {
      source: 'none',
      corpus_hash: null,
      embedding_model: env.EMBEDDING_MODEL || null,
      languages: {},
      last_checked_at: null,
      last_updated_at: null,
      last_error: null,
      remote_corpus_hash: null,
      is_latest: null,
    };
  }

  async init(): Promise<void> {
    const r2 = this.env.R2;
    if (!r2) return;
    try {
      const hashObj = await r2.get(`${R2_PREFIX}docs-index.hash`);
      const zhObj = await r2.get(`${R2_PREFIX}docs-index.zh.sqlite`);
      const enObj = await r2.get(`${R2_PREFIX}docs-index.en.sqlite`);
      if (!hashObj || !zhObj || !enObj) return;
      const hash = (await hashObj.text()).trim();
      if (!hash) return;
      const [zhBytes, enBytes] = await Promise.all([zhObj.arrayBuffer(), enObj.arrayBuffer()]);
      const zh = await DocsIndex.create('zh', new Uint8Array(zhBytes));
      const en = await DocsIndex.create('en', new Uint8Array(enBytes));
      if (zh.is_empty || en.is_empty) return;
      this.indexes = { zh, en };
      this.status = this.statusForIndexes({ zh, en }, hash, 'runtime-cache');
    } catch (err) {
      console.warn('[RAG] init from R2 failed:', err);
    }
  }

  statusValue(): RagIndexStatus {
    return { ...this.status, languages: { ...this.status.languages } };
  }

  /** 按 locale 取当前活跃索引（zh/zh-CN/zh-TW → zh；其它 → en）。 */
  getIndex(lang?: string | null): DocsIndex | null {
    if (!this.indexes) return null;
    const key = normalizeLang(lang) as 'zh' | 'en';
    return this.indexes[key];
  }

  /** 检索 top-K（返回的 chunk 与 score 给 ask 拼 prompt）。 */
  retrieve(lang: string | null | undefined, queryVector: number[], k = 4): RetrievedChunk[] {
    const idx = this.getIndex(lang);
    if (!idx) return [];
    return idx.search(queryVector, k);
  }

  async checkLatest(): Promise<RagIndexStatus> {
    const checkedAt = nowIso();
    try {
      const remoteHash = await this.fetchRemoteHash();
      this.status = withCheck(this.status, checkedAt, remoteHash, Boolean(
        this.status.corpus_hash && remoteHash === this.status.corpus_hash
      ), null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[RAG] latest-version check failed:', msg);
      this.status = withCheck(this.status, checkedAt, null, null, msg.slice(0, 300));
    }
    return this.statusValue();
  }

  async refresh(): Promise<RagIndexStatus> {
    const checkedAt = nowIso();
    let remoteHash: string | null = null;
    try {
      remoteHash = await this.fetchRemoteHash();
      if (remoteHash === this.status.corpus_hash) {
        this.status = withCheck(this.status, checkedAt, remoteHash, true, null);
        return this.statusValue();
      }

      const [zhBytes, enBytes] = await this.downloadAndValidate(remoteHash);
      const zh = await DocsIndex.create('zh', zhBytes);
      const en = await DocsIndex.create('en', enBytes);
      // 校验通过后再落盘（对齐原版 _persist 前完成全部 validation）
      await this.persist(zhBytes, enBytes, remoteHash);
      this.indexes = { zh, en };
      this.status = this.statusForIndexes(
        { zh, en }, remoteHash, 'runtime-cache',
        checkedAt, checkedAt, remoteHash, true,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[RAG] refresh failed:', msg);
      this.status = withCheck(this.status, checkedAt, remoteHash, remoteHash ? false : null, msg.slice(0, 300));
    }
    return this.statusValue();
  }

  // ── 内部 ──────────────────────────────────────────────────────────────────

  private sourceUrl(): string {
    const url = this.env.RAG_INDEX_SOURCE_URL?.trim();
    if (!url) throw new Error('RAG_INDEX_SOURCE_URL is empty');
    return url.replace(/\/$/, '');
  }

  private timeoutMs(): number {
    return Number(this.env.RAG_INDEX_REFRESH_TIMEOUT) || 15000;
  }

  private async fetchBytes(filename: string): Promise<Uint8Array> {
    if (this.fetchOverride) return this.fetchOverride(filename);
    const url = `${this.sourceUrl()}/${filename}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs()) });
    if (!resp.ok) throw new Error(`fetch ${filename} failed: HTTP ${resp.status}`);
    const buf = await resp.arrayBuffer();
    return new Uint8Array(buf);
  }

  private async fetchRemoteHash(): Promise<string> {
    const bytes = await this.fetchBytes('docs-index.hash');
    const hash = new TextDecoder().decode(bytes).trim();
    if (!hash) throw new Error('remote docs-index.hash is empty');
    return hash;
  }

  private async downloadAndValidate(remoteHash: string): Promise<[Uint8Array, Uint8Array]> {
    // 先下载到内存，全部校验通过才返回（对齐原版 tempdir + validate 后再 persist）
    const zhBytes = await this.fetchBytes('docs-index.zh.sqlite');
    const enBytes = await this.fetchBytes('docs-index.en.sqlite');
    const zh = await DocsIndex.create('zh', zhBytes);
    const en = await DocsIndex.create('en', enBytes);
    this.validateIndex(zh, 'docs-index.zh.sqlite');
    this.validateIndex(en, 'docs-index.en.sqlite');
    void remoteHash; // 已由 fetchRemoteHash 保证非空
    return [zhBytes, enBytes];
  }

  private validateIndex(index: DocsIndex, filename: string): void {
    if (index.is_empty) throw new Error(`${filename} has no chunks`);
    const model = this.env.EMBEDDING_MODEL;
    if (model && index.embeddingModel && index.embeddingModel !== model) {
      throw new Error(`${filename} model=${index.embeddingModel!} does not match runtime model=${model}`);
    }
    if (index.dim <= 0) throw new Error(`${filename} has invalid vector dimension`);
  }

  private async persist(zhBytes: Uint8Array, enBytes: Uint8Array, corpusHash: string): Promise<void> {
    const r2 = this.env.R2;
    if (!r2) return;
    await Promise.all([
      r2.put(`${R2_PREFIX}docs-index.zh.sqlite`, zhBytes),
      r2.put(`${R2_PREFIX}docs-index.en.sqlite`, enBytes),
      r2.put(`${R2_PREFIX}docs-index.hash`, corpusHash + '\n'),
    ]);
  }

  private statusForIndexes(
    indexes: ActiveIndexes,
    corpusHash: string,
    source: string,
    checkedAt: string | null = null,
    updatedAt: string | null = null,
    remoteCorpusHash: string | null = null,
    isLatest: boolean | null = null,
  ): RagIndexStatus {
    const languages: Record<string, RagLanguageStatus> = {};
    for (const [lang, idx] of Object.entries(indexes) as Array<['zh' | 'en', DocsIndex]>) {
      languages[lang] = {
        build_time: idx.buildTime,
        chunk_count: idx.chunks.length,
        dim: idx.dim,
      };
    }
    return {
      source,
      corpus_hash: corpusHash,
      embedding_model: this.env.EMBEDDING_MODEL || null,
      languages,
      last_checked_at: checkedAt,
      last_updated_at: updatedAt,
      last_error: null,
      remote_corpus_hash: remoteCorpusHash,
      is_latest: isLatest,
    };
  }
}

function withCheck(
  status: RagIndexStatus,
  checkedAt: string,
  remoteHash: string | null,
  isLatest: boolean | null,
  error: string | null,
): RagIndexStatus {
  return {
    ...status,
    languages: { ...status.languages },
    last_checked_at: checkedAt,
    last_error: error,
    remote_corpus_hash: remoteHash,
    is_latest: isLatest,
  };
}

// ── 单例（对齐原版 get_docs_refresh_service）──────────────────────────────

let _service: DocsRefreshService | null = null;

export function getRagService(env: RagEnv): DocsRefreshService {
  if (_service === null) {
    _service = new DocsRefreshService(env);
  }
  return _service;
}

export function resetRagService(): void {
  _service = null;
}
