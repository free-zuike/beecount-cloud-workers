/**
 * 跟 mobile `lib/utils/currencies.dart` 保持同一份货币 code 列表(151 个,
 * 覆盖通行 ISO 4217;全部在汇率源 fawaz currency-api 有报价)。新增货币只需在
 * 此追加,前端两端都得同步更新。
 *
 * 不单独维护 symbol 表 —— web 上目前没有展示 symbol 的地方,需要时可从
 * [Intl.NumberFormat] 派生。币种名称同理走 [Intl.DisplayNames](见
 * [currencyDisplayName]),主流币种由 i18n key `currency.<CODE>` 覆盖。
 */

const CURRENCY_GROUPS: Array<{ region: string; codes: string[] }> = [
  { region: 'eastAsia', codes: ['CNY', 'JPY', 'KRW', 'HKD', 'TWD', 'MOP', 'MNT', 'KPW'] },
  { region: 'southeastAsia', codes: ['SGD', 'MYR', 'THB', 'IDR', 'PHP', 'VND', 'MMK', 'KHR', 'LAK', 'BND'] },
  { region: 'southAsia', codes: ['INR', 'PKR', 'BDT', 'LKR', 'NPR', 'BTN', 'MVR', 'AFN'] },
  { region: 'centralAsia', codes: ['KZT', 'UZS', 'TJS', 'TMT', 'KGS'] },
  { region: 'middleEast', codes: ['AED', 'SAR', 'ILS', 'TRY', 'QAR', 'KWD', 'BHD', 'OMR', 'JOD', 'LBP', 'IQD', 'IRR', 'YER', 'SYP', 'GEL', 'AMD', 'AZN'] },
  { region: 'europe', codes: ['EUR', 'GBP', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'RUB', 'BYN', 'UAH', 'RON', 'BGN', 'RSD', 'ISK', 'MDL', 'ALL', 'MKD', 'BAM', 'GIP'] },
  { region: 'northAmerica', codes: ['USD', 'CAD', 'MXN'] },
  { region: 'centralAmericaCaribbean', codes: ['GTQ', 'HNL', 'NIO', 'CRC', 'PAB', 'DOP', 'CUP', 'JMD', 'TTD', 'BSD', 'BBD', 'BZD', 'HTG', 'XCD', 'KYD', 'AWG', 'ANG', 'BMD'] },
  { region: 'southAmerica', codes: ['BRL', 'ARS', 'CLP', 'COP', 'PEN', 'UYU', 'PYG', 'BOB', 'VES', 'GYD', 'SRD'] },
  { region: 'oceania', codes: ['AUD', 'NZD', 'FJD', 'PGK', 'SBD', 'TOP', 'VUV', 'WST', 'XPF'] },
  { region: 'africa', codes: ['ZAR', 'EGP', 'NGN', 'KES', 'GHS', 'MAD', 'DZD', 'TND', 'LYD', 'ETB', 'UGX', 'TZS', 'RWF', 'XAF', 'XOF', 'MUR', 'BWP', 'NAD', 'ZMW', 'MWK', 'MZN', 'AOA', 'CDF', 'GMD', 'GNF', 'LRD', 'SLE', 'SDG', 'SSP', 'SOS', 'DJF', 'ERN', 'BIF', 'CVE', 'STN', 'SCR', 'KMF', 'LSL', 'SZL', 'MGA', 'MRU'] },
]

export const CURRENCY_CODES: readonly string[] = CURRENCY_GROUPS.flatMap((g) => g.codes)

export const CURRENCY_REGION_GROUPS = CURRENCY_GROUPS

/**
 * 用 [Intl.DisplayNames] 按 locale 本地化任意 ISO 货币名(en→"US Dollar",
 * zh-CN→"美元")。环境不支持 / 未知 code 时回退 code 本身。
 *
 * 组件层优先用 i18n key `currency.<CODE>` 覆盖(主流币种保留人工译名),
 * 仅在无覆盖时调用本函数 —— 这样长尾币种也能自动按当前语言显示名称。
 */
/**
 * 从 Intl.NumberFormat 派生币种符号(zh-CN:CNY→"¥"、JPY→"JP¥"、USD→"US$")。
 * 用 currencyDisplay:'symbol'(非 narrowSymbol):JPY/CNY 的 narrow 同为 "¥",
 * 多币种列表里无法区分 —— symbol 形态自带区分前缀。未知 code 回退 code 本身。
 */
export function currencySymbol(code: string, locale = 'zh-CN'): string {
  const upper = code.toUpperCase()
  try {
    const parts = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: upper,
      currencyDisplay: 'symbol',
    }).formatToParts(1)
    return parts.find((p) => p.type === 'currency')?.value || upper
  } catch {
    return upper
  }
}

/** 币种码 → ISO 国家码(国旗用)。前两位派生;欧盟/台币/区域货币特例。
 *  与 App lib/utils/currencies.dart countryCodeForCurrency 对齐。 */
const _CURRENCY_COUNTRY: Record<string, string | null> = {
  EUR: 'EU',
  TWD: 'CN', // 新台币显示中国国旗(中国大陆市场合规)
  XAF: null, XOF: null, XCD: null, XPF: null,
  XDR: null, XAU: null, XAG: null, XPT: null, XPD: null,
}

export function countryCodeForCurrency(code: string): string | null {
  const c = (code || '').trim().toUpperCase()
  if (c in _CURRENCY_COUNTRY) return _CURRENCY_COUNTRY[c]
  if (c.length < 2) return null
  return c.slice(0, 2)
}

export function currencyDisplayName(code: string, locale: string): string {
  const upper = code.toUpperCase()
  try {
    const dn = new Intl.DisplayNames([locale], { type: 'currency' })
    return dn.of(upper) || upper
  } catch {
    return upper
  }
}

// ---------------------------------------------------------------------------
// v30 交易折算(记账/编辑提交用)。规则与 App 端对齐:
//   - 有效汇率 = 手动 override > 自动源(fawaz,1 base = x quote → 除)
//   - override 方向是「1 quote = rate base」→ 乘
//   - 编辑模式币种未变 → 返回 null(两字段都不发,金额变化由 server L14 按
//     该笔隐含汇率联动 —— 避免「只改备注折算被今日汇率重算」的快照漂移)
//   - 改回本位币 → 显式发 currency_code=base + native=amount(server 语义
//     None=不变,不发就改不回来)
//   - 缺汇率 → throw,调用方阻断保存(绝不静默 1:1)
// ---------------------------------------------------------------------------

import { fetchExchangeRateOverrides, fetchExchangeRates } from '@beecount/api-client'

export type CurrencyFields = { currency_code: string; native_amount: number }

type RatesEntry = {
  at: number
  auto: Record<string, unknown>
  /** quote(大写) → rate(1 quote = rate base) */
  overrides: Map<string, number>
}
const _ratesCache = new Map<string, RatesEntry>()
const _RATES_TTL_MS = 5 * 60 * 1000

async function _effectiveRates(token: string, base: string): Promise<RatesEntry> {
  const hit = _ratesCache.get(base)
  if (hit && Date.now() - hit.at < _RATES_TTL_MS) return hit
  const [auto, allOverrides] = await Promise.all([
    fetchExchangeRates(token, base),
    fetchExchangeRateOverrides(token).catch(() => []),
  ])
  const overrides = new Map<string, number>()
  for (const o of allOverrides) {
    if ((o.base_currency || '').toUpperCase() !== base) continue
    const r = Number(o.rate)
    if (Number.isFinite(r) && r > 0) overrides.set((o.quote_currency || '').toUpperCase(), r)
  }
  const entry: RatesEntry = { at: Date.now(), auto: auto.rates || {}, overrides }
  _ratesCache.set(base, entry)
  return entry
}

/**
 * 币种选择弹窗展示用:各币种对 base 的汇率 map(key=quote 大写,value=1 quote ≈ value base)。
 * 复用 _effectiveRates(5min 缓存 + 手动 override 合并)。fawaz auto 方向是
 * 1 base = rate quote,取倒数;手动 override 本就是 1 quote = rate base,直接覆盖 auto。
 * 账本币种弹窗 / 记账币种选择共用,替代各处手写的 fetchExchangeRates + 1/y。
 */
export async function loadRatesToBase(
  token: string,
  base: string
): Promise<Record<string, number>> {
  const entry = await _effectiveRates(token, base.trim().toUpperCase())
  const out: Record<string, number> = {}
  for (const [q, v] of Object.entries(entry.auto)) {
    const y = Number(v)
    if (Number.isFinite(y) && y > 0) out[q.toUpperCase()] = 1 / y
  }
  for (const [q, r] of entry.overrides) {
    if (Number.isFinite(r) && r > 0) out[q] = r // 手动汇率优先
  }
  return out
}

export async function resolveCurrencyFields(opts: {
  token: string
  ledgerBase: string
  /** 交易币种(表单所选;'' 视作本位币) */
  currency: string
  amount: number
  /** 编辑模式必传:该笔原币种(''=本位币)。币种未变 → 返回 null。
   *  新建传 undefined。 */
  originalCurrency?: string | null
}): Promise<CurrencyFields | null> {
  const base = opts.ledgerBase.trim().toUpperCase()
  const eff = (opts.currency || base).trim().toUpperCase()
  if (opts.originalCurrency !== undefined) {
    const orig = (opts.originalCurrency || base).trim().toUpperCase()
    if (eff === orig) return null // 币种未变:金额联动交给 server L14,防漂移
  }
  if (eff === base) {
    // 本位币(含「改回本位币」):隐含汇率 1
    return { currency_code: base, native_amount: opts.amount }
  }
  const entry = await _effectiveRates(opts.token, base)
  const manual = entry.overrides.get(eff)
  if (manual !== undefined) {
    return { currency_code: eff, native_amount: opts.amount * manual }
  }
  const raw = entry.auto[eff] ?? entry.auto[eff.toLowerCase()]
  const rate = Number(raw)
  if (!Number.isFinite(rate) || rate <= 0) throw new Error('rate missing')
  // fawaz 方向 1 base = rate quote → quote 金额折 base 要除
  return { currency_code: eff, native_amount: opts.amount / rate }
}

/** 列表/详情的「外币交易」判定:折算快照存在且 ≠ 原币值。 */
export function isForeignTx(row: {
  currency_code?: string | null
  native_amount?: number | null
  amount: number
}): boolean {
  return Boolean(
    row.currency_code && row.native_amount != null && row.native_amount !== row.amount
  )
}
