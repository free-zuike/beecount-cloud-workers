import { useCallback, useMemo, useState } from 'react'

import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  useLocale,
  useT,
} from '@beecount/ui'

import * as CountryFlags from 'country-flag-icons/react/3x2'

import {
  CURRENCY_REGION_GROUPS,
  countryCodeForCurrency,
  currencyDisplayName,
} from '../lib/currencies'

type FlagComp = React.FC<{ className?: string; title?: string }>
const _flags = CountryFlags as unknown as Record<string, FlagComp | undefined>

/** 币种国旗(区域货币无国旗 → null,调用处用符号占位)。 */
function CurrencyFlag({ code }: { code: string }) {
  const country = countryCodeForCurrency(code)
  const Flag = country ? _flags[country] : undefined
  if (!Flag) {
    return (
      <span className="flex h-3.5 w-5 shrink-0 items-center justify-center rounded-[4px] bg-muted text-[8px] font-semibold text-muted-foreground">
        {code.slice(0, 2)}
      </span>
    )
  }
  return <Flag className="h-3.5 w-5 shrink-0 rounded-[4px]" title={code} />
}

type CurrencySelectorProps = {
  open: boolean
  onClose: () => void
  /** 当前选中的货币 code(大写),空字符串视为未选。 */
  value: string
  onSelect: (code: string) => void
  /** 标题文案,例如"选择币种"。 */
  title?: string
  /** 是否只读 — 只展示当前货币不让换。例如"账户已有交易"场景。 */
  readOnly?: boolean
  readOnlyHint?: string
  /** v30 多币种:各币种对 rateBase 的汇率(1 该币种 = value rateBase),
   *  传入则每行展示汇率。调用方拉 /read/exchange-rates 提供。 */
  ratesToBase?: Record<string, number>
  rateBase?: string
}

/**
 * 通用币种选择器(业务组件) — 弹窗 + 搜索 + 区域分组。
 *
 * 跟 mobile `_showCurrencyPicker`(account_edit_page.dart:395)对齐:
 *   - 搜索框模糊匹配 code / 本地化名称
 *   - 按地区分组(eastAsia / europe / americas / ...)
 *   - 当前选中态用主题色高亮
 *
 * 为了复用,组件把 dialog 包装内置;调用方只控制 open / onClose / value /
 * onSelect。账户表单、账本表单都可以接同一个。
 */
export function CurrencySelector({
  open,
  onClose,
  value,
  onSelect,
  title,
  readOnly,
  readOnlyHint,
  ratesToBase,
  rateBase,
}: CurrencySelectorProps) {
  const t = useT()
  const { locale } = useLocale()
  const [query, setQuery] = useState('')

  const normalizedValue = (value || '').trim().toUpperCase()

  // 币种显示名:优先用 i18n key(主流币种人工译名)覆盖,否则用 Intl.DisplayNames
  // 按当前语言本地化(长尾币种也能出名字)。
  const resolveName = useCallback(
    (code: string): string => {
      const i18nKey = `currency.${code}`
      const i18n = t(i18nKey)
      return i18n === i18nKey ? currencyDisplayName(code, locale) : i18n
    },
    [t, locale],
  )

  // 把分组结构按搜索词过滤一遍,空 region 不渲染。
  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase()
    return CURRENCY_REGION_GROUPS.map((group) => {
      const codes = group.codes.filter((code) => {
        if (!q) return true
        const name = resolveName(code).toLowerCase()
        return code.toLowerCase().includes(q) || name.includes(q)
      })
      return { ...group, codes }
    }).filter((group) => group.codes.length > 0)
  }, [query, resolveName])

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          setQuery('')
          onClose()
        }
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{title ?? t('currency.dialog.title')}</DialogTitle>
        </DialogHeader>
        {readOnly ? (
          <div className="rounded-md border border-amber-300/60 bg-amber-50/80 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-900/20 dark:text-amber-200">
            {readOnlyHint || t('currency.dialog.readOnlyHint')}
          </div>
        ) : null}
        <div className="space-y-3">
          <Input
            placeholder={t('currency.dialog.search')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            disabled={readOnly}
          />
          <div className="max-h-[60vh] overflow-y-auto pr-1">
            {filteredGroups.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                {t('currency.dialog.empty')}
              </div>
            ) : (
              filteredGroups.map((group) => (
                <div key={group.region} className="mb-3">
                  <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {t(`currency.region.${group.region}`) === `currency.region.${group.region}`
                      ? group.region
                      : t(`currency.region.${group.region}`)}
                  </div>
                  <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                    {group.codes.map((code) => {
                      const name = resolveName(code)
                      const display = name && name !== code ? `${name} (${code})` : code
                      const selected = normalizedValue === code
                      return (
                        <button
                          key={code}
                          type="button"
                          disabled={readOnly}
                          onClick={() => {
                            onSelect(code)
                            setQuery('')
                            onClose()
                          }}
                          className={`flex items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                            selected
                              ? 'border-primary/60 bg-primary/10 text-primary'
                              : 'border-border/60 hover:bg-accent/40'
                          }`}
                        >
                          <CurrencyFlag code={code} />
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className="truncate">{display}</span>
                            {rateBase &&
                            code !== rateBase.toUpperCase() &&
                            ratesToBase?.[code] != null ? (
                              <span className="truncate text-[11px] text-muted-foreground">
                                1 {code} ≈ {ratesToBase[code].toPrecision(4)}{' '}
                                {rateBase.toUpperCase()}
                              </span>
                            ) : null}
                          </span>
                          {selected ? <span aria-hidden>✓</span> : null}
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t('dialog.cancel')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * 触发按钮(可选),展示当前货币 + 点击打开 dialog。让消费者不用自己渲一个
 * `<button>` + 维护 open state — 直接 `<CurrencySelectorTrigger value=...
 * onChange=... />` 用得起来。
 */
type CurrencySelectorTriggerProps = {
  value: string
  onChange: (code: string) => void
  /** 真值 = 锁定当前币种,点开能看到提示但不能换(对应 mobile "账户已有交易"
   *  场景)。`readOnlyHint` 是提示文字。 */
  readOnly?: boolean
  readOnlyHint?: string
  className?: string
  placeholder?: string
  /** v30 多币种:透传给弹窗展示汇率(见 CurrencySelectorProps)。 */
  ratesToBase?: Record<string, number>
  rateBase?: string
}

export function CurrencySelectorTrigger({
  value,
  onChange,
  readOnly,
  readOnlyHint,
  className,
  placeholder,
  ratesToBase,
  rateBase,
}: CurrencySelectorTriggerProps) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const code = (value || '').trim().toUpperCase()
  const i18nKey = `currency.${code}`
  const name = t(i18nKey)
  const display = !code
    ? placeholder || t('currency.placeholder')
    : name === i18nKey
      ? code
      : `${name} (${code})`
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={[
          'flex h-10 w-full items-center justify-between gap-2 rounded-md border border-input bg-muted px-3 py-2 text-left text-sm shadow-sm transition-colors hover:bg-accent/40',
          className || '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        <span className="flex min-w-0 items-center gap-2">
          {code ? <CurrencyFlag code={code} /> : null}
          <span className={`truncate ${code ? '' : 'text-muted-foreground'}`}>
            {display}
          </span>
        </span>
        <span className="text-xs text-muted-foreground opacity-60">▾</span>
      </button>
      <CurrencySelector
        open={open}
        onClose={() => setOpen(false)}
        value={value}
        onSelect={onChange}
        readOnly={readOnly}
        readOnlyHint={readOnlyHint}
        ratesToBase={ratesToBase}
        rateBase={rateBase}
      />
    </>
  )
}
