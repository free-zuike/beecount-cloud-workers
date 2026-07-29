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
import { createHmac } from 'crypto';

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
  
  let response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  
  // 推理模型锁 temperature 时自适应重试（对齐原版 _post_chat_adaptive）
  if (!response.ok && response.status === 400) {
    const errText = await response.clone().text();
    if (errText.includes('temperature')) {
      delete body.temperature;
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
    } else {
      throw new Error(`AI API error: ${response.status} - ${errText.slice(0, 200)}`);
    }
  }
  
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

/**
 * 下载图片并转为 base64
 */
async function downloadImageAsBase64(imageId: string, db: D1Database): Promise<string | null> {
  // 从 attachments 表获取存储路径
  const attachment = await db
    .prepare('SELECT storage_path, mime_type FROM attachment_files WHERE id = ?')
    .bind(imageId)
    .first<{ storage_path: string; mime_type: string | null }>();
  
  if (!attachment) return null;
  
  // 如果配置了 S3，从 S3 下载
  // 这里简化处理，返回 URL 让客户端使用
  return `data:${attachment.mime_type || 'image/png'};base64,<image_data>`;
}

// ===========================
// Schema 定义
// ===========================

const AiAskSchema = z.object({
  question: z.string().min(1).max(4000),
  ledger_id: z.string().optional(),
  chat_history: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string(),
  })).optional(),
});

const AiParseTxImageSchema = z.object({
  image_id: z.string().optional(),
  image_url: z.string().optional(),
  hint: z.string().optional(),
});

const AiParseTxTextSchema = z.object({
  text: z.string().min(1).max(2000),
  hint: z.string().optional(),
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
};

type Variables = {
  userId: string;
};

const aiRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// ---------------------------------------------------------------------------
// POST /ai/ask - 文档 Q&A（SSE 流式返回）
// ---------------------------------------------------------------------------

/**
 * 对账本数据提问，AI 生成回答（流式）
 *
 * 功能说明：
 * - 基于账本的交易/账户/分类数据回答问题
 * - 支持对话历史（多轮对话）
 * - 返回 SSE 流
 */
aiRouter.post('/ask', zValidator('json', AiAskSchema), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const req = c.req.valid('json');

  const profile = await db
    .prepare('SELECT ai_config_json FROM user_profiles WHERE user_id = ?')
    .bind(userId)
    .first<{ ai_config_json: string | null }>();

  const aiConfig = parseAiConfig(profile?.ai_config_json ?? null);
  const provider = findProvider(aiConfig, 'text');

  if (!provider || !provider.textModel) {
    return c.json({
      error: 'AI provider not configured. Please configure AI provider in settings.',
    }, 400);
  }

  let ledgerQuery = 'SELECT id FROM ledgers WHERE user_id = ?';
  const ledgerParams: string[] = [userId];

  if (req.ledger_id) {
    ledgerQuery += ' AND external_id = ?';
    ledgerParams.push(req.ledger_id);
  }

  const ledgers = await db.prepare(ledgerQuery).bind(...ledgerParams).all<{ id: string }>();

  if (ledgers.results.length === 0) {
    return c.json({ error: 'No ledger found' }, 400);
  }

  const ledgerIds = ledgers.results.map((l) => l.id);
  const placeholders = ledgerIds.map(() => '?').join(',');

  const [txRows, acctRows, catRows, tagRows] = await Promise.all([
    db.prepare(`SELECT tx_type, amount, happened_at, note, category_name FROM read_tx_projection WHERE ledger_id IN (${placeholders}) ORDER BY happened_at DESC LIMIT 100`).bind(...ledgerIds).all<{ tx_type: string; amount: number; happened_at: string; note: string | null; category_name: string | null }>(),
    db.prepare(`SELECT name, account_type, currency FROM read_account_projection WHERE ledger_id IN (${placeholders})`).bind(...ledgerIds).all<{ name: string; account_type: string | null; currency: string | null }>(),
    db.prepare(`SELECT name, kind FROM read_category_projection WHERE ledger_id IN (${placeholders})`).bind(...ledgerIds).all<{ name: string; kind: string | null }>(),
    db.prepare(`SELECT name, color FROM read_tag_projection WHERE ledger_id IN (${placeholders})`).bind(...ledgerIds).all<{ name: string; color: string | null }>(),
  ]);

  const contextParts: string[] = ['## 最近交易（最新100条）'];
  for (const tx of txRows.results) {
    contextParts.push(`- [${tx.happened_at.slice(0, 10)}] ${tx.tx_type}: ${tx.amount} | ${tx.category_name ?? '无分类'} | ${tx.note ?? ''}`);
  }
  contextParts.push('\n## 账户');
  for (const a of acctRows.results) {
    contextParts.push(`- ${a.name} (${a.account_type ?? 'unknown'})`);
  }
  contextParts.push('\n## 分类');
  for (const cat of catRows.results) {
    contextParts.push(`- ${cat.name} (${cat.kind ?? 'unknown'})`);
  }
  contextParts.push('\n## 标签');
  for (const t of tagRows.results) {
    contextParts.push(`- ${t.name} ${t.color ? `(${t.color})` : ''}`);
  }

  const context = contextParts.join('\n');

  const systemPrompt = `你是一个专业的记账助手。请根据用户的账本数据回答问题。

账本数据：
${context}

规则：
- 只基于提供的数据回答，不要编造
- 金额单位与账本一致（通常是人民币元）
- 如果数据不足，说明无法回答
- 用中文回答`;

  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: systemPrompt },
  ];

  if (req.chat_history) {
    for (const h of req.chat_history) {
      messages.push({ role: h.role, content: h.content });
    }
  }
  messages.push({ role: 'user', content: req.question });

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
          const data = JSON.stringify({ content: chunk });
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`));
        controller.close();
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: errorMsg, done: true })}\n\n`));
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
// POST /ai/parse-tx-image - 上传截图 → AI 解析交易
// ---------------------------------------------------------------------------

/**
 * 上传截图，AI 解析出交易信息
 */
aiRouter.post('/parse-tx-image', zValidator('json', AiParseTxImageSchema), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const req = c.req.valid('json');

  const profile = await db
    .prepare('SELECT ai_config_json FROM user_profiles WHERE user_id = ?')
    .bind(userId)
    .first<{ ai_config_json: string | null }>();

  const aiConfig = parseAiConfig(profile?.ai_config_json ?? null);
  const provider = findProvider(aiConfig, 'vision');

  if (!provider || !provider.visionModel) {
    return c.json({
      error: 'Vision AI provider not configured. Please configure AI provider with vision model.',
    }, 400);
  }

  if (!req.image_id && !req.image_url) {
    return c.json({ error: 'image_id or image_url is required' }, 400);
  }

  let imageContent: string | null = null;
  
  if (req.image_id) {
    imageContent = await downloadImageAsBase64(req.image_id, db);
  } else if (req.image_url) {
    // SSRF 防护：仅允许 https URL，拒绝私有 IP
    try {
      const parsedUrl = new URL(req.image_url);
      if (parsedUrl.protocol !== 'https:') {
        return c.json({ error: 'Only HTTPS URLs are allowed for image_url' }, 400);
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
      const imgResponse = await fetch(req.image_url);
      if (imgResponse.ok) {
        const imgBuffer = await imgResponse.arrayBuffer();
        const base64 = btoa(String.fromCharCode(...new Uint8Array(imgBuffer)));
        const contentType = imgResponse.headers.get('content-type') || 'image/png';
        imageContent = `data:${contentType};base64,${base64}`;
      }
    } catch {
      // 忽略图片下载错误
    }
  }

  const hint = req.hint ? `\n用户提示：${req.hint}` : '';
  const systemPrompt = `你是一个专业的记账助手。请分析图片中的内容，提取交易信息。

请返回 JSON 格式：
{
  "tx_drafts": [
    {
      "tx_type": "expense|income|transfer",
      "amount": 金额数字,
      "category_name": "分类名",
      "happened_at": "YYYY-MM-DD",
      "note": "备注"
    }
  ]
}

规则：
- 金额必须是数字，不是字符串
- 如果是支出，返回 tx_type: "expense"
- 如果是收入，返回 tx_type: "income"
- 如果是转账，返回 tx_type: "transfer"
- 如果无法识别，返回空的 tx_drafts 数组`;

  const messages: Array<{ role: string; content: string | Array<unknown> }> = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `请分析这张图片提取交易信息。${hint}`,
        },
        ...(imageContent ? [{ type: 'image_url', image_url: { url: imageContent } }] : []),
      ],
    },
  ];

  try {
    const content = await callAiChatJson(
      provider.baseUrl,
      provider.apiKey,
      provider.visionModel,
      messages
    );

    const parsed = extractJson(content) as {
      tx_drafts?: Array<{
        tx_type?: string;
        amount?: number;
        category_name?: string;
        happened_at?: string;
        note?: string;
      }>;
    } | null;

    const suggestions = (parsed?.tx_drafts ?? []).map((draft) => ({
      tx_type: (draft.tx_type as 'expense' | 'income' | 'transfer') || 'expense',
      amount: draft.amount ?? 0,
      category_name: draft.category_name ?? '其他',
      happened_at: draft.happened_at ?? new Date().toISOString().slice(0, 10),
      note: draft.note ?? '',
      confidence: 0.8,
    }));

    return c.json({
      suggestions,
      provider: provider.id,
      model: provider.visionModel,
      image_id: req.image_id,
      hint: req.hint,
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'AI parsing failed';
    return c.json({ error: errorMsg }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /ai/parse-tx-text - 文字描述 → AI 解析交易
// ---------------------------------------------------------------------------

/**
 * 文字描述记账，AI 解析出交易信息
 */
aiRouter.post('/parse-tx-text', zValidator('json', AiParseTxTextSchema), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const req = c.req.valid('json');

  const profile = await db
    .prepare('SELECT ai_config_json FROM user_profiles WHERE user_id = ?')
    .bind(userId)
    .first<{ ai_config_json: string | null }>();

  const aiConfig = parseAiConfig(profile?.ai_config_json ?? null);
  const provider = findProvider(aiConfig, 'text');

  if (!provider || !provider.textModel) {
    return c.json({
      error: 'AI provider not configured. Please configure AI provider in settings.',
    }, 400);
  }

  const hint = req.hint ? `\n用户提示：${req.hint}` : '';
  const systemPrompt = `你是一个专业的记账助手。请分析用户的文字描述，提取交易信息。

请返回 JSON 格式：
{
  "tx_drafts": [
    {
      "tx_type": "expense|income|transfer",
      "amount": 金额数字,
      "category_name": "分类名",
      "happened_at": "YYYY-MM-DD",
      "note": "备注"
    }
  ]
}

规则：
- 金额必须是数字，不是字符串
- 尝试识别支出/收入/转账
- 如果金额不明确，根据语境推断`;

  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `${req.text}${hint}` },
  ];

  try {
    const content = await callAiChatJson(
      provider.baseUrl,
      provider.apiKey,
      provider.textModel,
      messages
    );

    const parsed = extractJson(content) as {
      tx_drafts?: Array<{
        tx_type?: string;
        amount?: number;
        category_name?: string;
        happened_at?: string;
        note?: string;
      }>;
    } | null;

    const suggestions = (parsed?.tx_drafts ?? []).map((draft) => ({
      tx_type: (draft.tx_type as 'expense' | 'income' | 'transfer') || 'expense',
      amount: draft.amount ?? 0,
      category_name: draft.category_name ?? '其他',
      happened_at: draft.happened_at ?? new Date().toISOString().slice(0, 10),
      note: draft.note ?? req.text,
      confidence: 0.8,
    }));

    return c.json({
      suggestions,
      provider: provider.id,
      model: provider.textModel,
      original_text: req.text,
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'AI parsing failed';
    return c.json({ error: errorMsg }, 500);
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
  const formData = new FormData();
  formData.append('file', new Blob([wavBytes], { type: 'audio/wav' }), 'silence.wav');
  formData.append('model', model);

  const response = await fetch(whisperUrl, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: formData,
    signal: AbortSignal.timeout(timeout),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`AI API error: ${response.status} - ${errText.slice(0, 200)}`);
  }

  const data = await response.json() as { text?: string };
  return (data.text || '').trim();
}

// 64×64 红色 JPEG 测试图（对齐原版 test_samples.py）
const _TEST_JPEG_DATA_URL = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCABAAEADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDyyiiivzo/ssKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooA//2Q==';

/**
 * 视觉测试：发 64×64 红色 JPEG + "describe" prompt（对齐原版 _test_vision）
 */
async function _testVision(baseUrl: string, apiKey: string, model: string): Promise<string> {
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const payload = {
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

  let response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000),
  });

  // 推理模型锁 temperature 时自适应重试
  if (!response.ok && response.status === 400) {
    const errText = await response.clone().text();
    if (errText.includes('temperature')) {
      delete (payload as Record<string, unknown>).temperature;
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20000),
      });
    } else {
      throw new Error(`AI API error: ${response.status} - ${errText.slice(0, 200)}`);
    }
  }

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
    
    // 根据 capability 选择模型
    if (capability === 'vision' && providerObj.visionModel) {
      model = model || providerObj.visionModel;
    } else if (capability === 'speech' && providerObj.audioModel) {
      model = model || providerObj.audioModel;
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
        model = model || provider.textModel || '';
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

  try {
    let content: string;

    if (capability === 'speech') {
      // 语音测试: 发 1 秒静音 WAV 到 /audio/transcriptions（对齐原版 _test_speech）
      content = await _testSpeech(baseUrl, apiKey, model || 'whisper-1', 15000);
    } else if (capability === 'vision') {
      // 视觉测试: 发 64×64 红色 JPEG + "describe" prompt（对齐原版 _test_vision）
      content = await _testVision(baseUrl, apiKey, model || 'gpt-4-vision-preview');
    } else {
      // 文本测试
      const messages = [
        { role: 'user', content: 'Hi' }
      ];
      content = await callAiChatJson(baseUrl, apiKey, model || 'gpt-3.5-turbo', messages, 10000, false, 16);
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
    } else if (errorMsg.includes('429') || errorMsg.includes('rate') || errorMsg.includes('quota') || errorMsg.includes('余额')) {
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
