/**
 * AI 路由模块 - 实现 BeeCount Cloud AI 记账和文档问答接口
 *
 * 参考原版 BeeCount-Cloud (Python/FastAPI) 的 /ai 端点：
 * - POST /ai/ask                        - 文档 Q&A（SSE 流式返回）
 * - POST /ai/parse-tx-image            - 上传截图 → AI 解析交易草稿
 * - POST /ai/parse-tx-text             - 文字描述 → AI 解析交易草稿
 * - POST /ai/test-provider             - 测试 AI provider 连通性
 *
 * 功能说明：
 * - 支持 OpenAI-compatible API（OpenAI、Zhipu、DeepSeek、SiliconFlow 等）
 * - 用户在个人资料中配置 AI providers
 * - SSE 流式返回在 Cloudflare Workers 中通过 ReadableStream 实现
 *
 * AI 配置格式（存储在 user_profiles.ai_config_json）：
 * {
 *   "providers": [
 *     {
 *       "id": "zhipu_glm",
 *       "apiKey": "sk-xxx",
 *       "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
 *       "textModel": "glm-4-flash",
 *       "visionModel": "glm-4v-flash"
 *     }
 *   ],
 *   "binding": {
 *     "textProviderId": "zhipu_glm",
 *     "visionProviderId": "zhipu_glm"
 *   }
 * }
 *
 * @module routes/ai
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { createHmac, randomUUID } from 'crypto';
import { EmbeddingNotConfiguredError, embedQuery, getRagService } from '../services/rag-refresh';
import type { RetrievedChunk } from '../services/rag-index';
import { serverLogger } from '../lib/logger';

function nowUtc(): string {
  return new Date().toISOString();
}

// ===========================
// AI 配置类型
// ===========================

interface AiProvider {
  id: string;
  apiKey: string;
  baseUrl: string;
  textModel?: string;
  visionModel?: string;
  audioModel?: string;
  name?: string;
}

interface AiConfig {
  providers?: AiProvider[];
  binding?: {
    textProviderId?: string;
    visionProviderId?: string;
  };
  [key: string]: unknown;
}

// ===========================
// AI 客户端工具
// ===========================

/**
 * 解析用户 AI 配置
 */
function parseAiConfig(jsonStr: string | null): AiConfig {
  if (!jsonStr) return {};
  try {
    return JSON.parse(jsonStr) as AiConfig;
  } catch {
    return {};
  }
}

/**
 * 查找指定类型的 provider
 */
function findProvider(config: AiConfig, kind: 'text' | 'vision'): AiProvider | null {
  const bindingKey = kind === 'text' ? 'textProviderId' : 'visionProviderId';
  const modelKey = kind === 'text' ? 'textModel' : 'visionModel';
  
  const providerId = config.binding?.[bindingKey];
  if (!providerId || !config.providers) return null;
  
  const provider = config.providers.find(p => p.id === providerId);
  if (!provider || !provider.apiKey || !provider.baseUrl) return null;
  
  return provider;
}

// 自适应参数剥离（对齐原版 Python _post_chat_adaptive + _rejected_param）
// 不同模型对 OpenAI-compatible 参数有不同约束：推理模型锁 temperature，
// 部分模型不支持 response_format。与其写死兼容分支，不如听上游报错动态适配。
const _REQUIRED_KEYS = new Set(['model', 'messages', 'stream']);
const _MAX_PARAM_STRIPS = 3;

function _rejectedParam(payload: Record<string, unknown>, statusCode: number, body: string): string | null {
  if (statusCode < 400) return null;
  // 1) 结构化: {"error": {"param": "temperature", ...}}
  try {
    const parsed = JSON.parse(body);
    const err = parsed?.error;
    if (err && typeof err === 'object') {
      const param = err.param;
      if (typeof param === 'string' && param in payload && !_REQUIRED_KEYS.has(param)) {
        return param;
      }
    }
  } catch { /* ignore */ }
  // 2) 文案兜底: 错误信息点了我们发出去的哪个可丢键
  const low = body.toLowerCase();
  for (const key of Object.keys(payload)) {
    if (!_REQUIRED_KEYS.has(key) && low.includes(key.toLowerCase())) {
      return key;
    }
  }
  return null;
}

async function _postChatAdaptive(
  url: string, headers: Record<string, string>, payload: Record<string, unknown>, timeout: number
): Promise<Response> {
  let currentPayload = { ...payload };
  let response = await fetch(url, {
    method: 'POST', headers, body: JSON.stringify(currentPayload),
    signal: AbortSignal.timeout(timeout),
  });
  for (let i = 0; i < _MAX_PARAM_STRIPS; i++) {
    if (response.ok) return response;
    const errText = await response.clone().text();
    const param = _rejectedParam(currentPayload, response.status, errText);
    if (param === null) return response;
    currentPayload = Object.fromEntries(
      Object.entries(currentPayload).filter(([k]) => k !== param)
    );
    response = await fetch(url, {
      method: 'POST', headers, body: JSON.stringify(currentPayload),
      signal: AbortSignal.timeout(timeout),
    });
  }
  return response;
}

/**
 * 通用 AI API 调用（JSON 模式）
 */
async function callAiChatJson(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: Array<{ role: string; content: string | Array<unknown> }>,
  timeout: number = 30000,
  useJsonFormat: boolean = true,
  maxTokens?: number
): Promise<string> {
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  
  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: 0.2,
  };
  if (maxTokens !== undefined) {
    body.max_tokens = maxTokens;
  }
  if (useJsonFormat) {
    body.response_format = { type: 'json_object' };
  }
  
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  };

  const response = await _postChatAdaptive(url, headers, body, timeout);
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`AI API error: ${response.status} - ${errorText.slice(0, 200)}`);
  }
  
  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string; code?: string | number; type?: string };
  };

  if (data.error) {
    throw new Error(`AI API error: ${data.error.code || 'unknown'} - ${data.error.message || JSON.stringify(data.error)}`);
  }

  // 对齐原版: data.get("choices", [{}])[0].get("message", {}).get("content", "")
  const content = data.choices?.[0]?.message?.content ?? '';
  return content;
}

/**
 * 流式 AI API 调用（SSE 模式）
 */
async function* streamAiChat(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: Array<{ role: string; content: string | Array<unknown> }>,
  timeout: number = 30000
): AsyncGenerator<string> {
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'Accept': 'text/event-stream',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.3,
      stream: true,
    }),
    signal: AbortSignal.timeout(timeout),
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`AI API error: ${response.status} - ${errorText.slice(0, 200)}`);
  }
  
  if (!response.body) {
    throw new Error('No response body');
  }
  
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        
        const dataStr = trimmed.slice(5).trim();
        if (dataStr === '[DONE]') return;
        
        try {
          const data = JSON.parse(dataStr);
          const content = data.choices?.[0]?.delta?.content;
          if (content) {
            yield content;
          }
        } catch {
          // 忽略解析错误
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * 从 LLM 输出中提取 JSON
 */
function extractJson(text: string): unknown {
  const blockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (blockMatch) {
    try {
      return JSON.parse(blockMatch[1].trim());
    } catch {
      // 继续尝试其他方法
    }
  }
  
  const objectMatch = text.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try {
      return JSON.parse(objectMatch[0]);
    } catch {
      // 继续
    }
  }
  
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ===========================
// B2/B3 共享工具（对齐原版 parse_tx_image.py / parse_tx_text.py）
// ===========================

const _ISO_CURRENCY_RE = /^[A-Z]{3}$/;

/** LLM 给的币种 → ISO 4217 大写码；不合法返 ""（= 跟账本主币种）。
 * 唯一例外是裸 `$` → USD（实测 LLM 常把「45 美元」识别成 "$"；A$/C$/S$/HK$
 * 这些歧义写法提示本身就会带前缀）。`¥` 不映射 —— CNY 与 JPY 都写裸 ¥，
 * 猜错是 ~20 倍金额差，宁可退回账本主币种。 */
function normalizeCurrency(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const code = raw.trim().toUpperCase();
  if (code === '$') return 'USD';
  return _ISO_CURRENCY_RE.test(code) ? code : '';
}

class SchemaInvalidError extends Error {}

/** 严格校验 LLM 输出：必须是 `{"tx_drafts": [...]}`。对齐原版 —— 不静默
 * 兼容其它结构（顶层 array / items key 等），兼容会让 prompt 漂移。 */
function normalizeDrafts(result: unknown): Array<Record<string, unknown>> {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    throw new SchemaInvalidError(
      `expected JSON object with \`tx_drafts\` key, got ${result === null ? 'null' : Array.isArray(result) ? 'array' : typeof result}`
    );
  }
  const drafts = (result as Record<string, unknown>).tx_drafts;
  if (!Array.isArray(drafts)) {
    const keys = Object.keys(result as Record<string, unknown>).slice(0, 5);
    throw new SchemaInvalidError(
      `\`tx_drafts\` missing or not array; top-level keys present: ${JSON.stringify(keys)}`
    );
  }
  const out: Array<Record<string, unknown>> = [];
  for (const d of drafts) {
    if (typeof d !== 'object' || d === null) continue;
    const rec = d as Record<string, unknown>;
    const amt = rec.amount;
    if (typeof amt !== 'number' || !Number.isFinite(amt)) continue;
    const txType = (rec.type as string) || 'expense';
    out.push({
      type: ['expense', 'income', 'transfer'].includes(txType) ? txType : 'expense',
      amount: Math.abs(amt), // 强制正数
      // 多币种："" = 跟账本主币种。非法值降级成 "" 而不是丢弃整笔。
      currency: normalizeCurrency(rec.currency),
      happened_at: (rec.happened_at as string) || '',
      category_name: ((rec.category_name as string) || '').trim(),
      account_name: ((rec.account_name as string) || '').trim(),
      from_account_name: ((rec.from_account_name as string) || '').trim() || null,
      to_account_name: ((rec.to_account_name as string) || '').trim() || null,
      note: ((rec.note as string) || '').trim(),
      tags: Array.isArray(rec.tags)
        ? rec.tags.filter((t) => typeof t === 'string' && t.trim())
        : [],
      confidence: ['high', 'medium', 'low'].includes(rec.confidence as string)
        ? rec.confidence
        : 'medium',
    });
  }
  return out;
}

/** 取当前账本的 category / account / 本位币（给 LLM hint）。对齐原版：
 * - category 排除「有子分类的父类」（父类是 grouping，不能作为交易分类）
 * - account 返回 (名称, 币种)，排除隐藏账户（#240）
 * - 没传 ledger_id → 跨账本聚合；本位币取「唯一账本的币种，否则 CNY」 */
async function loadLedgerContext(
  db: D1Database,
  userId: string,
  ledgerId?: string | null,
): Promise<{ categories: string[]; accounts: Array<[string, string | null]>; ledgerCurrency: string }> {
  const fallback = 'CNY';
  let ledgerIntIds: string[] = [];
  let ledgerCurrency = fallback;

  if (ledgerId) {
    const ledger = await db
      .prepare('SELECT id, currency FROM ledgers WHERE user_id = ? AND external_id = ?')
      .bind(userId, ledgerId)
      .first<{ id: string; currency: string | null }>();
    if (!ledger) return { categories: [], accounts: [], ledgerCurrency: fallback };
    ledgerIntIds = [ledger.id];
    ledgerCurrency = (ledger.currency || fallback).trim().toUpperCase();
  } else {
    const all = await db
      .prepare('SELECT id, currency FROM ledgers WHERE user_id = ?')
      .bind(userId)
      .all<{ id: string; currency: string | null }>();
    ledgerIntIds = all.results.map((l) => l.id);
    ledgerCurrency = all.results.length === 1
      ? (all.results[0].currency || fallback).trim().toUpperCase()
      : fallback;
  }

  if (ledgerIntIds.length === 0) return { categories: [], accounts: [], ledgerCurrency };

  // category 是 user-global，按 user_id 拉（跨 ledger 统一）
  const catRows = await db
    .prepare('SELECT name, parent_name FROM user_category_projection WHERE user_id = ?')
    .bind(userId)
    .all<{ name: string | null; parent_name: string | null }>();
  const parentNamesWithChildren = new Set(
    catRows.results.filter((c) => c.parent_name).map((c) => c.parent_name as string)
  );
  const selectableCats = new Set<string>();
  for (const c of catRows.results) {
    if (!c.name) continue;
    if (c.parent_name) selectableCats.add(c.name);
    else if (!parentNamesWithChildren.has(c.name)) selectableCats.add(c.name);
  }

  // account 排除隐藏（#240）：隐藏账户不作为新交易记账目标
  const acctRows = await db
    .prepare('SELECT name, currency, hidden FROM user_account_projection WHERE user_id = ?')
    .bind(userId)
    .all<{ name: string | null; currency: string | null; hidden: number | null }>();
  const acctSet = new Map<string, string | null>();
  for (const a of acctRows.results) {
    if (a.name && !a.hidden) {
      acctSet.set(a.name, (a.currency || '').trim().toUpperCase() || null);
    }
  }
  const accounts = [...acctSet.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  return { categories: [...selectableCats].sort(), accounts, ledgerCurrency };
}

/** CURRENCY_HINT 提示行（对齐原版 _format_currency_hint）：报主币种；
 * 有外币账户时额外列出。 */
function formatCurrencyHint(accounts: Array<[string, string | null]>, ledgerCurrency: string): string {
  const base = (ledgerCurrency || 'CNY').trim().toUpperCase();
  const others = [...new Set(accounts.map(([, c]) => c).filter((c): c is string => !!c && c !== base))].sort();
  let line = `账本主币种:${base}`;
  if (others.length) line += `;账本内已有外币账户:${others.join('、')}`;
  return line;
}

// ===========================
// Schema 定义
// ===========================

const AiAskSchema = z.object({
  query: z.string().min(1).max(4000),
  locale: z.string().regex(/^(zh|zh-CN|zh-TW|en)$/).default('zh'),
});

// 对齐原版：parse-tx-image 收 multipart FormData，parse-tx-text 收 JSON
const AiParseTxTextSchema = z.object({
  text: z.string().min(1).max(5000),
  ledger_id: z.string().optional(),
  locale: z.string().optional(),
});

const AiTestProviderSchema = z.object({
  provider: z.union([
    z.string(),
    z.object({
      id: z.string(),
      apiKey: z.string(),
      baseUrl: z.string(),
      textModel: z.string().optional(),
      visionModel: z.string().optional(),
      audioModel: z.string().optional(),
      name: z.string().optional(),
    }),
  ]),
  capability: z.enum(['text', 'vision', 'speech']).optional(),
  model: z.string().optional(),
  api_key: z.string().optional(),
  base_url: z.string().optional(),
});

const AiSpeechToTextSchema = z.object({
  audio_data: z.string().optional(),
  audio_url: z.string().optional(),
  language: z.string().optional(),
  model: z.string().optional(),
});

type Bindings = {
  DB: D1Database;
  JWT_SECRET: string;
  S3_ENDPOINT?: string;
  S3_REGION?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
  S3_BUCKET_NAME?: string;
  R2?: R2Bucket;
  RAG_INDEX_SOURCE_URL?: string;
  EMBEDDING_MODEL?: string;
  EMBEDDING_BASE_URL?: string;
  EMBEDDING_API_KEY?: string;
};

type Variables = {
  userId: string;
};

const aiRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// ---------------------------------------------------------------------------
// GET /ai/docs-index/status - 文档索引状态（用户可读，对齐原版 ask.py）
// ---------------------------------------------------------------------------

aiRouter.get('/docs-index/status', async (c) => {
  const checkLatest = c.req.query('check_latest') === 'true';
  const service = getRagService(c.env);
  await service.init();
  const status = checkLatest ? await service.checkLatest() : service.statusValue();
  return c.json(status);
});

// ---------------------------------------------------------------------------
// POST /ai/ask - 文档 Q&A（SSE 流式返回，对齐原版 ask.py）
// 流程：解析 chat provider → 索引可用性 → embed 用户问题 → top-K 检索 →
//       拼 prompt → 流式 chat → SSE chunk/sources/done
// ---------------------------------------------------------------------------

const _SYSTEM_ZH = `你是 BeeCount(蜜蜂记账)的助手,只基于下面提供的「相关文档」回答用户的问题。

规则:
1. **必须用中文回答**,即使相关文档是英文也要翻译成中文输出。
2. 文档里没明确说的,直接回答「文档里没找到相关说明」,不要编造、不要发挥。
3. 答案要简洁直接 — 步骤类问题给编号步骤;概念类问题用一两句话解释。
4. 不要在答案末尾列引用来源(系统会自动贴)。
5. 不要在中文输出里夹杂英文短语,除非是专有名词(如 PIN / 2FA)。
6. 如果用户问跟 BeeCount / 记账无关,就说「这个问题不在我能回答的范围内」。`;

const _SYSTEM_EN = `You are the assistant for BeeCount, a personal finance app. Answer ONLY based on the
"Relevant Docs" provided below.

Rules:
1. **You MUST answer in English**, even if the relevant docs are in Chinese — translate
   them to English in your reply.
2. If the docs don't clearly say something, answer "Sorry, the docs don't cover this"
   instead of making things up.
3. Be concise. Step-by-step for how-to questions; one or two sentences for concept questions.
4. Don't list source references at the end (the system appends them automatically).
5. Don't mix Chinese characters into English output unless quoting a UI label that exists
   only in Chinese.
6. If the user asks something unrelated to BeeCount / personal finance, reply "That's outside
   what I can answer".`;

function buildAskMessages(query: string, chunks: RetrievedChunk[], lang: string): Array<{ role: string; content: string }> {
  const system = lang.startsWith('zh') ? _SYSTEM_ZH : _SYSTEM_EN;
  const parts: string[] = [];
  chunks.forEach((c, i) => {
    let header = `### [${i + 1}] ${c.chunk.doc_title}`;
    if (c.chunk.section) header += ` — ${c.chunk.section}`;
    parts.push(`${header}\n${c.chunk.content.trim()}`);
  });
  const docsBlock = parts.length > 0
    ? parts.join('\n\n')
    : (lang.startsWith('zh') ? '(没找到相关文档)' : '(no relevant docs found)');
  const userContent = lang.startsWith('zh')
    ? `## 相关文档\n\n${docsBlock}\n\n## 用户问题\n\n${query}`
    : `## Relevant Docs\n\n${docsBlock}\n\n## User Question\n\n${query}`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: userContent },
  ];
}

function sseEvent(eventType: string, data: unknown): string {
  return `data: ${JSON.stringify({ type: eventType, ...(typeof data === 'object' && data !== null ? data : { value: data }) })}\n\n`;
}

aiRouter.post('/ask', zValidator('json', AiAskSchema), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const req = c.req.valid('json');

  // 1. 解析 chat provider — 没配直接返 400（前端显 fallback），不进 stream
  const profile = await db
    .prepare('SELECT ai_config_json FROM user_profiles WHERE user_id = ?')
    .bind(userId)
    .first<{ ai_config_json: string | null }>();

  const aiConfig = parseAiConfig(profile?.ai_config_json ?? null);
  const provider = findProvider(aiConfig, 'text');

  if (!provider || !provider.textModel) {
    return c.json({
      error_code: 'AI_NO_CHAT_PROVIDER',
      message: 'AI provider not configured. Please configure AI provider in settings.',
    }, 400);
  }

  // 2. 索引可用性检查 — 不可用直接 503，不进 stream
  const service = getRagService(c.env);
  await service.init();
  const docsIdx = service.getIndex(req.locale);
  if (!docsIdx || docsIdx.is_empty) {
    return c.json({
      error_code: 'AI_DOCS_INDEX_EMPTY',
      message: `docs index for lang=${req.locale!} not loaded; run admin refresh first`,
    }, 503);
  }

  // 3. embed 用户问题（server-side key）
  let qvec: number[];
  try {
    qvec = await embedQuery(c.env, req.query);
  } catch (err) {
    if (err instanceof EmbeddingNotConfiguredError) {
      return c.json({
        error_code: 'AI_EMBEDDING_UNAVAILABLE',
        message: err.message,
      }, 503);
    }
    throw err;
  }

  // 4. 检索 top-K
  const retrieved = service.retrieve(req.locale, qvec, 4);

  // 5. 拼 prompt + stream chat
  const messages = buildAskMessages(req.query, retrieved, req.locale);
  const sources = retrieved.map((r) => ({
    doc_path: r.chunk.doc_path,
    doc_title: r.chunk.doc_title,
    section: r.chunk.section,
    url: r.chunk.url,
  }));

  serverLogger.info('src.routers.ai', '[AI] /ai/ask user:', userId, 'lang:', req.locale, 'query:', req.query.slice(0, 50), 'top_k:', retrieved.length, 'provider:', provider.id);

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of streamAiChat(
          provider.baseUrl,
          provider.apiKey,
          provider.textModel!,
          messages
        )) {
          controller.enqueue(encoder.encode(sseEvent('chunk', { text: chunk })));
        }
        controller.enqueue(encoder.encode(sseEvent('sources', { items: sources })));
        controller.enqueue(encoder.encode(sseEvent('done', {})));
        controller.close();
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        controller.enqueue(encoder.encode(sseEvent('error', { error_code: 'AI_PROVIDER_ERROR', message: errorMsg.slice(0, 200) })));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
});

// ---------------------------------------------------------------------------
// POST /ai/parse-tx-image - 上传截图 → AI 解析交易（multipart FormData）
// ---------------------------------------------------------------------------

/**
 * 上传截图，AI 解析出交易信息。对齐原版 FastAPI 协议：
 * - 请求：multipart FormData（image 文件 + ledger_id + locale）
 * - 返回：{ tx_drafts: [...], image_id }，image_id 用于 batch 保存时转附件
 * 错误码（前端按 error_code 显示对应 fallback）：
 * - AI_NO_VISION_PROVIDER (400) / AI_IMAGE_TOO_LARGE (413) /
 *   AI_IMAGE_TYPE_INVALID (400) / AI_PROVIDER_ERROR (502) /
 *   AI_PARSE_FAILED (422) / AI_SCHEMA_INVALID (422)
 */
aiRouter.post('/parse-tx-image', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;

  // 1. multipart FormData 解析
  const formData = await c.req.formData();
  const imageFile = formData.get('image') as File | null;
  const ledgerId = (formData.get('ledger_id') as string | null) || undefined;
  const locale = (formData.get('locale') as string | null) || 'zh';

  if (!imageFile) {
    return c.json({ error: { code: 'AI_IMAGE_TYPE_INVALID', message: 'image file is required' } }, 400);
  }

  // 2. 校验 mime + size（对齐原版 5MB / jpg-png-webp-gif）
  const mime = (imageFile.type || '').toLowerCase();
  const _ALLOWED_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
  if (!_ALLOWED_MIMES.has(mime)) {
    return c.json({
      error: { code: 'AI_IMAGE_TYPE_INVALID', message: `unsupported image type: ${mime!}; allowed: jpeg/png/webp/gif` },
    }, 400);
  }
  const imageBytes = new Uint8Array(await imageFile.arrayBuffer());
  const _MAX_IMAGE_BYTES = 5 * 1024 * 1024;
  if (imageBytes.length > _MAX_IMAGE_BYTES) {
    return c.json({
      error: { code: 'AI_IMAGE_TOO_LARGE', message: `image size ${imageBytes.length} exceeds 5MB` },
    }, 413);
  }

  // 3. 解析 vision provider
  const profile = await db
    .prepare('SELECT ai_config_json FROM user_profiles WHERE user_id = ?')
    .bind(userId)
    .first<{ ai_config_json: string | null }>();
  const aiConfig = parseAiConfig(profile?.ai_config_json ?? null);
  const provider = findProvider(aiConfig, 'vision');
  if (!provider || !provider.visionModel) {
    return c.json({
      error: { code: 'AI_NO_VISION_PROVIDER', message: 'Vision AI provider not configured. Please configure AI provider with vision model.' },
    }, 400);
  }

  // 4. 取 ledger 上下文（categories + accounts 带币种 + 本位币）
  const { categories, accounts, ledgerCurrency } = await loadLedgerContext(db, userId, ledgerId);

  // 5. 拼 prompt（多币种：schema 含 currency + CURRENCY_HINT 上下文）
  const imageDataUrl = `data:${mime};base64,${btoa(String.fromCharCode(...imageBytes))}`;
  const systemPrompt = `你是一个专业的记账助手。请分析图片中的内容，提取交易信息。

请返回 JSON 格式：
{"tx_drafts": [{"type": "expense|income|transfer", "amount": 金额数字, "category_name": "分类名", "account_name": "账户名", "from_account_name": "转账转出账户", "to_account_name": "转账转入账户", "happened_at": "YYYY-MM-DD", "note": "备注", "currency": "币种", "tags": ["标签"], "confidence": "high|medium|low"}]}

${formatCurrencyHint(accounts, ledgerCurrency)}
账本可用类目:${categories.length ? categories.join(', ') : '(无 — category_name 留空)'}
账本可用账户:${accounts.length ? accounts.map(([name, ccy]) => ccy ? `${name}(${ccy})` : name).join(', ') : '(无 — account_name 留空)'}

规则：
- 金额必须是数字，不是字符串
- 如果是支出，返回 type: "expense"；收入 "income"；转账 "transfer"
- currency 必须是 3 位大写 ISO 4217 代码(不要填货币符号或中文名)：美元/$ → USD,日元/円 → JPY,欧元/€ → EUR,英镑/£ → GBP,港币 → HKD,新台币 → TWD,韩元 → KRW,泰铢 → THB
- 与账本主币种(${ledgerCurrency})相同时 currency 留 ""；图片里出现任何外币说法(中文名/符号/代码都算)就必须填，别漏
- 例:「花了 45 美元」→ "USD"；「1200 日元」→ "JPY"；「星巴克 $6.5」→ "USD"
- 如果无法识别，返回空的 tx_drafts 数组`;

  const messages: Array<{ role: string; content: string | Array<unknown> }> = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: [
        { type: 'text', text: '请分析这张图片提取交易信息。' },
        { type: 'image_url', image_url: { url: imageDataUrl } },
      ],
    },
  ];

  // 6. 调 vision LLM
  let drafts: Array<Record<string, unknown>>;
  try {
    const content = await callAiChatJson(
      provider.baseUrl,
      provider.apiKey,
      provider.visionModel,
      messages
    );
    const parsed = extractJson(content);
    drafts = normalizeDrafts(parsed);
  } catch (err) {
    if (err instanceof SchemaInvalidError) {
      return c.json({
        error: { code: 'AI_SCHEMA_INVALID', message: (err as Error).message, raw: String((err as Error).message).slice(0, 1000) },
      }, 422);
    }
    const errorMsg = err instanceof Error ? err.message : 'AI parsing failed';
    return c.json({ error: { code: 'AI_PROVIDER_ERROR', message: errorMsg.slice(0, 200) } }, 502);
  }

  // 7. 缓存 image bytes（R2 优先，无 R2 则用 S3）
  const imageId = randomUUID();
  const r2Key = `ai-tmp/${userId}/${imageId}`;
  if (c.env.R2) {
    try {
      await c.env.R2.put(r2Key, imageBytes, { httpMetadata: { contentType: mime } });
    } catch { /* 缓存失败不阻断解析 */ }
  } else {
    try {
      const { getFirstEnabledS3Config } = await import('./sys_config');
      const { signRequest } = await import('../lib/s3');
      const s3Config = await getFirstEnabledS3Config(db, c.env);
      if (s3Config) {
        const { url, headers } = await signRequest(s3Config.accessKeyId, s3Config.secretAccessKey, s3Config.region, s3Config.endpoint, s3Config.bucketName, r2Key, 'PUT', mime, imageBytes.byteLength);
        await fetch(url, { method: 'PUT', headers: { ...headers, 'Content-Type': mime }, body: imageBytes });
      }
    } catch { /* 缓存失败不阻断解析 */ }
  }
  await db.prepare(
    `INSERT INTO ai_image_cache (image_id, user_id, mime_type, size_bytes, r2_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(imageId, userId, mime, imageBytes.length, r2Key, nowUtc()).run().catch(() => {});

  return c.json({ tx_drafts: drafts, image_id: imageId });
});

// ---------------------------------------------------------------------------
// POST /ai/parse-tx-text - 文字描述 → AI 解析交易
// ---------------------------------------------------------------------------

/**
 * 文字描述记账，AI 解析出交易信息。对齐原版：
 * - 请求：JSON { text, ledger_id?, locale? }
 * - 返回：{ tx_drafts: [...] }
 * 错误码：AI_NO_CHAT_PROVIDER (400) / AI_PROVIDER_ERROR (502) /
 * AI_PARSE_FAILED (422) / AI_SCHEMA_INVALID (422)
 */
aiRouter.post('/parse-tx-text', zValidator('json', AiParseTxTextSchema), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const req = c.req.valid('json');
  const locale = req.locale || 'zh';

  const profile = await db
    .prepare('SELECT ai_config_json FROM user_profiles WHERE user_id = ?')
    .bind(userId)
    .first<{ ai_config_json: string | null }>();
  const aiConfig = parseAiConfig(profile?.ai_config_json ?? null);
  const provider = findProvider(aiConfig, 'text');
  if (!provider || !provider.textModel) {
    return c.json({
      error: { code: 'AI_NO_CHAT_PROVIDER', message: 'AI provider not configured. Please configure AI provider in settings.' },
    }, 400);
  }

  // 取 ledger 上下文（categories + accounts 带币种 + 本位币）
  const { categories, accounts, ledgerCurrency } = await loadLedgerContext(db, userId, req.ledger_id);

  const systemPrompt = `你是一个专业的记账助手。请分析用户的文字描述，提取交易信息。

请返回 JSON 格式：
{"tx_drafts": [{"type": "expense|income|transfer", "amount": 金额数字, "category_name": "分类名", "account_name": "账户名", "from_account_name": "转账转出账户", "to_account_name": "转账转入账户", "happened_at": "YYYY-MM-DD", "note": "备注", "currency": "币种", "tags": ["标签"], "confidence": "high|medium|low"}]}

${formatCurrencyHint(accounts, ledgerCurrency)}
账本可用类目:${categories.length ? categories.join(', ') : '(无 — category_name 留空)'}
账本可用账户:${accounts.length ? accounts.map(([name, ccy]) => ccy ? `${name}(${ccy})` : name).join(', ') : '(无 — account_name 留空)'}

规则：
- 金额必须是数字，不是字符串
- 尝试识别支出/收入/转账
- 如果金额不明确，根据语境推断
- currency 必须是 3 位大写 ISO 4217 代码(不要填货币符号或中文名)：美元/$ → USD,日元/円 → JPY,欧元/€ → EUR,英镑/£ → GBP,港币 → HKD,新台币 → TWD,韩元 → KRW,泰铢 → THB
- 与账本主币种(${ledgerCurrency})相同时 currency 留 ""；原文出现任何外币说法(中文名/符号/代码都算)就必须填，别漏
- 例:「花了 45 美元」→ "USD"；「1200 日元」→ "JPY"；「星巴克 $6.5」→ "USD"`;

  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `${req.text}\n\nlocale: ${locale}` },
  ];

  try {
    const content = await callAiChatJson(
      provider.baseUrl,
      provider.apiKey,
      provider.textModel,
      messages
    );
    const parsed = extractJson(content);
    const drafts = normalizeDrafts(parsed);
    return c.json({ tx_drafts: drafts });
  } catch (err) {
    if (err instanceof SchemaInvalidError) {
      return c.json({
        error: { code: 'AI_SCHEMA_INVALID', message: (err as Error).message, raw: String((err as Error).message).slice(0, 1000) },
      }, 422);
    }
    const errorMsg = err instanceof Error ? err.message : 'AI parsing failed';
    return c.json({ error: { code: 'AI_PROVIDER_ERROR', message: errorMsg.slice(0, 200) } }, 502);
  }
});

// ---------------------------------------------------------------------------
// 测试样本（对齐原版 Python test_samples.py）
// ---------------------------------------------------------------------------

/** 1 秒 8kHz 16-bit PCM 静音 WAV 的 base64 */
function _buildTestWavBase64(): string {
  const sampleRate = 8000;
  const numSamples = sampleRate; // 1 秒
  const dataSize = numSamples * 2; // 16-bit
  const fileSize = 36 + dataSize;

  const buf = new ArrayBuffer(44 + dataSize);
  const dv = new DataView(buf);
  let off = 0;
  const w = (s: string) => { for (let i = 0; i < s.length; i++) dv.setUint8(off++, s.charCodeAt(i)); };
  w('RIFF');
  dv.setUint32(off, fileSize, true); off += 4;
  w('WAVE');
  w('fmt ');
  dv.setUint32(off, 16, true); off += 4; // chunk size
  dv.setUint16(off, 1, true); off += 2; // PCM
  dv.setUint16(off, 1, true); off += 2; // mono
  dv.setUint32(off, sampleRate, true); off += 4;
  dv.setUint32(off, sampleRate * 2, true); off += 4; // byte rate
  dv.setUint16(off, 2, true); off += 2; // block align
  dv.setUint16(off, 16, true); off += 2; // bits per sample
  w('data');
  dv.setUint32(off, dataSize, true); off += 4;
  // 剩余字节默认 0（静音 PCM）
  const wavBytes = new Uint8Array(buf.byteLength);
  wavBytes.set(new Uint8Array(buf));
  const binary = Array.from(wavBytes, b => String.fromCharCode(b)).join('');
  return btoa(binary);
}

const _TEST_WAV_BASE64 = _buildTestWavBase64();

/**
 * 语音测试：发 1 秒静音 WAV 到 /audio/transcriptions（对齐原版 _test_speech）
 */
async function _testSpeech(baseUrl: string, apiKey: string, model: string, timeout: number): Promise<string> {
  const whisperUrl = `${baseUrl.replace(/\/$/, '')}/audio/transcriptions`;
  const wavBytes = Uint8Array.from(atob(_TEST_WAV_BASE64), c => c.charCodeAt(0));

  // 手动构造 multipart body（Workers 的 FormData 在某些 provider 上兼容性有问题）
  const boundary = '----WebKitFormBoundary' + Math.random().toString(36).slice(2);
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];

  const w = (s: string) => parts.push(encoder.encode(s));
  const wb = (b: Uint8Array) => parts.push(b);

  w('--' + boundary + '\r\n');
  w('Content-Disposition: form-data; name="file"; filename="silence.wav"\r\n');
  w('Content-Type: audio/wav\r\n\r\n');
  wb(wavBytes);
  w('\r\n');
  w('--' + boundary + '\r\n');
  w('Content-Disposition: form-data; name="model"\r\n\r\n');
  w(model);
  w('\r\n--' + boundary + '--\r\n');

  // 合并所有 Uint8Array
  const totalLen = parts.reduce((s, p) => s + p.length, 0);
  const merged = new Uint8Array(totalLen);
  let offset = 0;
  for (const p of parts) {
    merged.set(p, offset);
    offset += p.length;
  }

  const response = await fetch(whisperUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body: merged,
    signal: AbortSignal.timeout(timeout),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`AI API error: ${response.status} - ${errText.slice(0, 200)}`);
  }

  const data = await response.json() as { text?: string };
  // 静音 WAV 转录返回空 text 是正常的（没有语音内容），不代表 API 有问题。
  // 返回成功消息证明 API 连通。
  return (data.text || '').trim() || '(silence accepted, API connected)';
}

// 64×64 红色 JPEG 测试图（对齐原版 test_samples.py）
const _TEST_JPEG_DATA_URL = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCABAAEADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDyyiiivzo/ssKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooA//2Q==';

/**
 * 视觉测试：发 64×64 红色 JPEG + "describe" prompt（对齐原版 _test_vision）
 */
async function _testVision(baseUrl: string, apiKey: string, model: string): Promise<string> {
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const payload: Record<string, unknown> = {
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'describe' },
          { type: 'image_url', image_url: { url: _TEST_JPEG_DATA_URL } },
        ],
      },
    ],
    max_tokens: 16,
    temperature: 0.2,
  };

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  };

  const response = await _postChatAdaptive(url, headers, payload, 20000);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`AI API error: ${response.status} - ${errorText.slice(0, 200)}`);
  }

  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return (data.choices?.[0]?.message?.content ?? '').trim();
}

// ---------------------------------------------------------------------------
// 速率限制（内存，对齐原版 Python _check_rate_limit）
// ---------------------------------------------------------------------------

const _rateWindows = new Map<string, number[]>();
const _RATE_LIMIT_WINDOW_MS = 60_000;
const _RATE_LIMIT_MAX = 30;

function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  let window = _rateWindows.get(userId);
  if (!window) {
    window = [];
    _rateWindows.set(userId, window);
  }
  while (window.length > 0 && now - window[0] > _RATE_LIMIT_WINDOW_MS) {
    window.shift();
  }
  if (window.length >= _RATE_LIMIT_MAX) return false;
  window.push(now);
  return true;
}

// ---------------------------------------------------------------------------
// POST /ai/test-provider - 测试 AI provider 连通性
// ---------------------------------------------------------------------------

/**
 * 测试 AI provider 是否可用
 */
aiRouter.post('/test-provider', zValidator('json', AiTestProviderSchema), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const req = c.req.valid('json');
  const startTime = Date.now();

  // 速率限制：单用户 60s 内最多 30 次（对齐原版 Python _check_rate_limit）
  if (!checkRateLimit(userId)) {
    return c.json({
      success: false,
      error_code: 'AI_TEST_RATE_LIMITED',
      error_message: '测试过于频繁，请 1 分钟后再试',
      latency_ms: Date.now() - startTime,
      preview: '',
    });
  }

  let apiKey = req.api_key ?? '';
  let baseUrl = req.base_url ?? '';
  let model = req.model ?? '';
  const capability = req.capability || 'text';
  let providerId: string;
  
  // 处理 provider 字段：可以是字符串 ID 或完整对象
  if (typeof req.provider === 'object' && req.provider !== null) {
    // provider 是对象，直接使用其中的配置
    const providerObj = req.provider as {
      id: string;
      apiKey: string;
      baseUrl: string;
      textModel?: string;
      visionModel?: string;
      audioModel?: string;
    };
    providerId = providerObj.id;
    apiKey = apiKey || providerObj.apiKey;
    baseUrl = baseUrl || providerObj.baseUrl;
    
    // 根据 capability 选择模型（对齐原版，model 为空时后续检查 MISSING_FIELDS）
    if (capability === 'vision') {
      model = model || providerObj.visionModel || '';
    } else if (capability === 'speech') {
      model = model || providerObj.audioModel || '';
    } else {
      model = model || providerObj.textModel || '';
    }
  } else {
    // provider 是字符串 ID，从数据库配置中查找
    providerId = req.provider as string;
    
    const profile = await db
      .prepare('SELECT ai_config_json FROM user_profiles WHERE user_id = ?')
      .bind(userId)
      .first<{ ai_config_json: string | null }>();

    const aiConfig = parseAiConfig(profile?.ai_config_json ?? null);
    
    if (!apiKey || !baseUrl) {
      const provider = aiConfig.providers?.find(p => p.id === providerId);
      if (provider) {
        apiKey = apiKey || provider.apiKey;
        baseUrl = baseUrl || provider.baseUrl;
        // 根据 capability 选对应模型字段（对齐原版）
        if (capability === 'vision') {
          model = model || provider.visionModel || '';
        } else if (capability === 'speech') {
          model = model || provider.audioModel || '';
        } else {
          model = model || provider.textModel || '';
        }
      }
    }
  }

  if (!apiKey || !baseUrl) {
    return c.json({
      success: false,
      error_code: 'AI_TEST_MISSING_FIELDS',
      error_message: `Missing API key or base URL for provider: ${providerId}`,
      latency_ms: Date.now() - startTime,
      preview: '',
    });
  }

  // 模型为空时返回 MISSING_FIELDS（对齐原版）
  if (!model) {
    return c.json({
      success: false,
      error_code: 'AI_TEST_MISSING_FIELDS',
      error_message: `${capability} model not configured`,
      latency_ms: Date.now() - startTime,
      preview: '',
    });
  }

  try {
    let content: string;

    if (capability === 'speech') {
      // 语音测试: 发 1 秒静音 WAV 到 /audio/transcriptions（对齐原版 _test_speech）
      content = await _testSpeech(baseUrl, apiKey, model, 15000);
    } else if (capability === 'vision') {
      // 视觉测试: 发 64×64 红色 JPEG + "describe" prompt（对齐原版 _test_vision）
      content = await _testVision(baseUrl, apiKey, model);
    } else {
      // 文本测试
      const messages = [
        { role: 'user', content: 'Hi' }
      ];
      content = await callAiChatJson(baseUrl, apiKey, model, messages, 10000, false, 16);
    }
    
    if (!content || content.trim().length === 0) {
      return c.json({
        success: false,
        error_code: 'AI_TEST_EMPTY_RESPONSE',
        error_message: 'AI provider returned empty response',
        latency_ms: Date.now() - startTime,
        preview: '',
      });
    }

    return c.json({
      success: true,
      latency_ms: Date.now() - startTime,
      preview: content || 'Connection successful',
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Connection failed';
    
    let errorCode = 'AI_TEST_UNKNOWN';
    if (errorMsg.includes('401') || errorMsg.includes('403') || errorMsg.includes('auth') || errorMsg.includes('API key')) {
      errorCode = 'AI_TEST_AUTH';
    } else if (errorMsg.includes('余额') || errorMsg.includes('充值') || errorMsg.includes('insufficient') || errorMsg.includes('balance')) {
      errorCode = 'AI_TEST_INSUFFICIENT_BALANCE';
    } else if (errorMsg.includes('429') || errorMsg.includes('rate') || errorMsg.includes('quota')) {
      errorCode = 'AI_TEST_RATE_LIMITED';
    } else if (errorMsg.includes('404') || errorMsg.includes('model not found') || errorMsg.includes('not exist')) {
      errorCode = 'AI_TEST_MODEL_NOT_FOUND';
    } else if (errorMsg.includes('timeout') || errorMsg.includes('AbortError')) {
      errorCode = 'AI_TEST_TIMEOUT';
    } else if (errorMsg.includes('network') || errorMsg.includes('fetch') || errorMsg.includes('ECONNREFUSED')) {
      errorCode = 'AI_TEST_NETWORK';
    }
    
    return c.json({
      success: false,
      error_code: errorCode,
      error_message: errorMsg,
      latency_ms: Date.now() - startTime,
      preview: '',
    });
  }
});

// ---------------------------------------------------------------------------
// POST /ai/speech-to-text - 语音转文字（Whisper API）
// ---------------------------------------------------------------------------

/**
 * 接收音频数据，调用兼容 OpenAI 的 Whisper API 进行转录
 */
aiRouter.post('/speech-to-text', zValidator('json', AiSpeechToTextSchema), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const req = c.req.valid('json');

  if (!req.audio_data && !req.audio_url) {
    return c.json({ error: 'audio_data or audio_url is required' }, 400);
  }

  const profile = await db
    .prepare('SELECT ai_config_json FROM user_profiles WHERE user_id = ?')
    .bind(userId)
    .first<{ ai_config_json: string | null }>();

  const aiConfig = parseAiConfig(profile?.ai_config_json ?? null);
  const provider = findProvider(aiConfig, 'text');

  if (!provider || !provider.apiKey) {
    return c.json({
      error: 'AI provider not configured. Please configure AI provider in settings.',
    }, 400);
  }

  const whisperBaseUrl = provider.baseUrl.replace(/\/chat\/completions$/, '').replace(/\/$/, '');
  const whisperUrl = `${whisperBaseUrl}/audio/transcriptions`;

  try {
    let audioBlob: Blob;
    let filename = 'audio.webm';

    if (req.audio_data) {
      const binaryStr = atob(req.audio_data);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      audioBlob = new Blob([bytes], { type: 'audio/webm' });
    } else {
      // SSRF 防护：仅允许 https URL，拒绝私有 IP
      const parsedUrl = new URL(req.audio_url!);
      if (parsedUrl.protocol !== 'https:') {
        return c.json({ error: 'Only HTTPS URLs are allowed for audio_url' }, 400);
      }
      const hostname = parsedUrl.hostname;
      if (
        hostname === '127.0.0.1' || hostname === 'localhost' ||
        hostname.startsWith('10.') || hostname.startsWith('192.168.') ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
        /^0\./.test(hostname) || hostname === '::1' || hostname === '0.0.0.0'
      ) {
        return c.json({ error: 'Private/internal URLs are not allowed' }, 400);
      }
      const audioResponse = await fetch(req.audio_url!);
      if (!audioResponse.ok) {
        return c.json({ error: `Failed to fetch audio: ${audioResponse.status}` }, 400);
      }
      const audioBuffer = await audioResponse.arrayBuffer();
      audioBlob = new Blob([audioBuffer], { type: audioResponse.headers.get('content-type') || 'audio/webm' });
      const urlParts = req.audio_url!.split('/');
      filename = urlParts[urlParts.length - 1].split('?')[0] || 'audio.webm';
    }

    const formData = new FormData();
    formData.append('file', audioBlob, filename);
    formData.append('model', req.model || 'whisper-1');
    if (req.language) {
      formData.append('language', req.language);
    }

    const response = await fetch(whisperUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${provider.apiKey}`,
      },
      body: formData,
      signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Whisper API error: ${response.status} - ${errorText.slice(0, 200)}`);
    }

    const data = await response.json() as { text?: string };

    return c.json({
      text: data.text ?? '',
      provider: provider.id,
      model: req.model || 'whisper-1',
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Speech-to-text failed';
    return c.json({ error: errorMsg }, 500);
  }
});

export default aiRouter;
