/**
 * AI prompt 模板 — 文档 Q&A（A1）+ 记账提取（B2 截图 / B3 文本）
 * 逐字对齐原版 Python services/ai/prompts.py
 */

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

export function buildAskMessages(
  query: string,
  chunks: Array<{ chunk: { doc_title: string; section?: string | null; content: string } }>,
  lang: string,
): Array<{ role: string; content: string }> {
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

// ── B2 / B3 共用 schema ──────────────────────────────────────────────────

const _TX_DRAFTS_SCHEMA_ZH = `**输出格式必须严格遵守**:返回一个 JSON 对象,**最外层是 dict 不是 array**,
只有一个 key \`tx_drafts\`,值才是 array。

正确:\`{"tx_drafts": [{...}, {...}]}\`
**错误**(不要这样):\`[{...}]\`、\`{"transactions": [...]}\`、\`{"items": [...]}\`、
单笔 dict \`{...}\`。即使只识别到 1 笔也要用 array。识别到 0 笔返 \`{"tx_drafts": []}\`。

每笔交易包含字段:
  - \`type\`: "expense" | "income" | "transfer"
  - \`amount\`: 数字,绝对值(不带正负号)
  - \`happened_at\`: ISO 8601 datetime,根据原文/图片日期推断;没日期用 "{{NOW}}"
  - \`category_name\`: 从「可用类目」选,选不到用 ""(留给用户在前端选)
  - \`account_name\`: 从「可用账户」选,选不到用 "";仅 expense/income 有意义
  - \`from_account_name\` / \`to_account_name\`: 仅 transfer 用
  - \`note\`: ≤15 字商家名 / 商品名 / 简短描述
  - \`currency\`: 币种,必须是 3 位大写 ISO 4217 代码,**不要填货币符号,也不要填中文名**
    - 常见对应:美元/美金/$ → USD,日元/日圆/円 → JPY,欧元/欧/€ → EUR,
      英镑/£ → GBP,港币/港元 → HKD,新台币 → TWD,韩元 → KRW,泰铢 → THB
    - 与账本主币种相同时留 ""(主币种是 CNY 时,「花了 50 元」留 "")
    - 原文/图片出现任何外币说法(中文名、符号、代码都算)就必须填,别漏
    - 例:「花了 45 美元」→ "USD";「星巴克 $6.5」→ "USD";「1200 日元」→ "JPY"
  - \`tags\`: array,可空
  - \`confidence\`: "high" | "medium" | "low"
    - high: 金额 + 类型 + 时间 都明确从原始内容抠出来
    - medium: 某些字段是合理推断(类目)
    - low: 多个字段不确定,请用户核对`;

const _TX_DRAFTS_SCHEMA_EN = `**STRICT OUTPUT FORMAT**: Return a JSON object — **the top level MUST be a dict, NOT an array** —
with exactly one key \`tx_drafts\` whose value is an array.

Correct: \`{"tx_drafts": [{...}, {...}]}\`
**WRONG** (don't do): \`[{...}]\`, \`{"transactions": [...]}\`, \`{"items": [...]}\`,
or a single object \`{...}\`. Always use array even for a single tx. For 0 tx return \`{"tx_drafts": []}\`.

Each draft has fields:
  - \`type\`: "expense" | "income" | "transfer"
  - \`amount\`: number, absolute value (no signs)
  - \`happened_at\`: ISO 8601 datetime; infer from source; fallback to "{{NOW}}"
  - \`category_name\`: pick from available categories; "" if no match
  - \`account_name\`: pick from available accounts; "" if no match (for expense/income)
  - \`from_account_name\` / \`to_account_name\`: only for transfer
  - \`note\`: ≤15 chars merchant/item/short description
  - \`currency\`: MUST be a 3-letter uppercase ISO 4217 code — **never a currency
    symbol, never a currency name**
    - Mapping: dollar/dollars/$ → USD, yen/円 → JPY, euro/€ → EUR, pound/£ → GBP,
      HK dollar → HKD, NT dollar → TWD, won → KRW, baht → THB
    - Leave "" when it equals the ledger's base currency
    - Fill it whenever the source states a foreign currency in ANY form (name,
      symbol or code) — don't skip it
    - e.g. "spent 45 dollars" → "USD"; "Starbucks $6.5" → "USD"; "1200 yen" → "JPY"
  - \`tags\`: array, can be empty
  - \`confidence\`: "high" | "medium" | "low"`;

const _PARSE_TX_IMAGE_ZH = `你是 BeeCount 记账助手。我会给你一张支付凭证截图(可能是支付宝/微信/信用卡推送/
银行账单截图),你需要提取所有交易记录。

当前时间:{NOW}
账本可用类目:{CATEGORIES}
账本可用账户:{ACCOUNTS}
{CURRENCY_HINT}

{SCHEMA}

要求:
1. 图片如果完全不像支付凭证(比如截了个聊天界面),返回 {"tx_drafts": []}
2. 多笔识别场景:信用卡账单 / 微信账单列表 / 一个月汇总图 — 提取所有清晰的条目
3. **不要编造**:看不清的字段用 "" 或 null,不要瞎填;金额看不清的整笔跳过

只输出 JSON,不要前后加任何解释文字。`;

const _PARSE_TX_IMAGE_EN = `You are BeeCount's bookkeeping assistant. I'll give you a payment receipt screenshot
(could be Alipay/WeChat/credit-card notification/bank statement). Extract every
transaction visible.

Current time: {NOW}
Available categories in this ledger: {CATEGORIES}
Available accounts in this ledger: {ACCOUNTS}
{CURRENCY_HINT}

{SCHEMA}

Rules:
1. If the image is clearly NOT a payment receipt (e.g. chat screenshot), return
   {"tx_drafts": []}.
2. Multi-tx: credit card statements / bill lists / monthly summary — extract every
   clear entry.
3. **Don't fabricate**: leave fields as "" or null when unclear; if amount is unclear
   skip that whole tx (don't include it).

Output JSON only, no prefix/suffix text.`;

const _PARSE_TX_TEXT_ZH = `你是 BeeCount 记账助手。我会给你一段记账文本(可能是微信/支付宝/信用卡账单段落,
也可能是用户手写的待入账列表),你需要提取所有交易记录。

当前时间:{NOW}
账本可用类目:{CATEGORIES}
账本可用账户:{ACCOUNTS}
{CURRENCY_HINT}

文本:
{TEXT}

{SCHEMA}

要求:
1. 字段缺失处理:
   - 没明确日期 → 推断("昨天打车" → 昨天日期 + 推断时间)
   - 完全没日期信息 → 用 "{NOW}"
   - 没明确类目 → 从文本推断(美团 → 餐饮,滴滴 → 交通);推不出留 ""
2. 多笔识别:每行一笔 / 用 - * 1. 列表分隔的也是多笔
3. 文本里全是闲聊 / 不是账单 → 返 {"tx_drafts": []}
4. **不要编造金额**:看不清的金额直接跳过那笔(不要瞎填),宁缺毋滥

只输出 JSON,不要前后加任何解释文字。`;

const _PARSE_TX_TEXT_EN = `You are BeeCount's bookkeeping assistant. I'll give you a piece of text (could be a
WeChat/Alipay/credit-card statement excerpt, or a user's hand-written list of pending
transactions). Extract every transaction.

Current time: {NOW}
Available categories in this ledger: {CATEGORIES}
Available accounts in this ledger: {ACCOUNTS}
{CURRENCY_HINT}

Text:
{TEXT}

{SCHEMA}

Rules:
1. Field inference:
   - No explicit date → infer ("dinner yesterday" → yesterday's date + reasonable hour)
   - No date info at all → use "{NOW}"
   - No explicit category → infer (Starbucks → Coffee/Food); leave "" if unclear
2. Multi-tx: each line / list item is one tx
3. Plain chitchat / not a bill → return {"tx_drafts": []}
4. **Don't fabricate amounts**: skip the whole tx if amount unclear

Output JSON only, no prefix/suffix text.`;

// ── helpers ──────────────────────────────────────────────────────────────

export function formatCategoriesHint(categories: string[]): string {
  if (!categories.length) return '(none — leave category_name empty for user to pick)';
  return categories.filter(c => c).join(', ');
}

/** 账户清单。只有币种 ≠ 账本主币种的账户才标注币种 — 单币种用户看到的
 *  字符串与加多币种支持之前逐字相同(零噪声、零回归)。 */
export function formatAccountsHint(
  accounts: Array<[string, string | null]>,
  ledgerCurrency: string,
): string {
  if (!accounts.length) return '(none — leave account_name empty for user to pick)';
  const base = (ledgerCurrency || '').trim().toUpperCase();
  const parts: string[] = [];
  for (const [name, ccy] of accounts) {
    if (!name) continue;
    const code = (ccy || '').trim().toUpperCase();
    parts.push(code && code !== base ? `${name}(${code})` : name);
  }
  return parts.join(', ');
}

/** 币种提示行。账本内只有一种币种时只报主币种(一行,极短);出现外币账户时
 *  额外列出可用币种。 */
export function formatCurrencyHint(
  accounts: Array<[string, string | null]>,
  ledgerCurrency: string,
  isZh: boolean,
): string {
  const base = (ledgerCurrency || 'CNY').trim().toUpperCase();
  const others = [...new Set(
    accounts.map(([, c]) => (c || '').trim().toUpperCase()).filter(c => c && c !== base),
  )].sort();
  if (isZh) {
    let line = `账本主币种:${base}`;
    if (others.length) line += `;账本内已有外币账户:${others.join('、')}`;
    return line;
  }
  let line = `Ledger base currency: ${base}`;
  if (others.length) line += `; foreign-currency accounts present: ${others.join(', ')}`;
  return line;
}

function fillTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{(NOW|CATEGORIES|ACCOUNTS|CURRENCY_HINT|TEXT|SCHEMA)\}/g, (_, k: string) => vars[k] ?? '');
}

export function buildParseTxImageMessages(opts: {
  categories: string[];
  accounts: Array<[string, string | null]>;
  ledgerCurrency?: string;
  now: Date;
  locale?: string;
  imageDataUrl: string;
  customPromptTemplate?: string | null;
}): Array<{ role: string; content: Array<unknown> }> {
  const isZh = (opts.locale || 'zh').toLowerCase().startsWith('zh');
  const template = opts.customPromptTemplate || (isZh ? _PARSE_TX_IMAGE_ZH : _PARSE_TX_IMAGE_EN);
  const schema = isZh ? _TX_DRAFTS_SCHEMA_ZH : _TX_DRAFTS_SCHEMA_EN;
  const prompt = fillTemplate(template, {
    NOW: opts.now.toISOString().slice(0, 19),
    CATEGORIES: formatCategoriesHint(opts.categories),
    ACCOUNTS: formatAccountsHint(opts.accounts, opts.ledgerCurrency || 'CNY'),
    CURRENCY_HINT: formatCurrencyHint(opts.accounts, opts.ledgerCurrency || 'CNY', isZh),
    SCHEMA: schema,
  });
  return [
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: opts.imageDataUrl } },
        { type: 'text', text: prompt },
      ],
    },
  ];
}

export function buildParseTxTextMessages(opts: {
  text: string;
  categories: string[];
  accounts: Array<[string, string | null]>;
  ledgerCurrency?: string;
  now: Date;
  locale?: string;
  customPromptTemplate?: string | null;
}): Array<{ role: string; content: string }> {
  const isZh = (opts.locale || 'zh').toLowerCase().startsWith('zh');
  const template = opts.customPromptTemplate || (isZh ? _PARSE_TX_TEXT_ZH : _PARSE_TX_TEXT_EN);
  const schema = isZh ? _TX_DRAFTS_SCHEMA_ZH : _TX_DRAFTS_SCHEMA_EN;
  const prompt = fillTemplate(template, {
    NOW: opts.now.toISOString().slice(0, 19),
    CATEGORIES: formatCategoriesHint(opts.categories),
    ACCOUNTS: formatAccountsHint(opts.accounts, opts.ledgerCurrency || 'CNY'),
    CURRENCY_HINT: formatCurrencyHint(opts.accounts, opts.ledgerCurrency || 'CNY', isZh),
    TEXT: opts.text,
    SCHEMA: schema,
  });
  return [{ role: 'user', content: prompt }];
}
