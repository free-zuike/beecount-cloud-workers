import { useT } from '@beecount/ui'

import type { DetailScope } from '../../lib/txDialogEvents'

interface Props {
  value: DetailScope
  onChange: (next: DetailScope) => void
  className?: string
}

/**
 * 详情弹窗顶部的"全部账本 / 当前账本"切换。复用 i18n 现有键 shell.allLedgers
 * + home.scope.current,不再引入新文案。被 AccountDetail / CategoryDetail /
 * TagDetail 三处弹窗共用,所以放在 components/dialogs/。
 */
export function DetailScopeToggle({ value, onChange, className }: Props) {
  const t = useT()
  const options: Array<{ key: DetailScope; label: string }> = [
    { key: 'all', label: t('shell.allLedgers') },
    { key: 'current', label: t('home.scope.current') },
  ]
  return (
    <div
      role="tablist"
      aria-label={t('shell.allLedgers')}
      className={`inline-flex rounded-md border border-border/60 bg-muted/30 p-0.5 text-xs ${className || ''}`}
    >
      {options.map((opt) => {
        const active = opt.key === value
        return (
          <button
            key={opt.key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.key)}
            className={`rounded px-2.5 py-1 transition-colors ${
              active
                ? 'bg-background font-semibold text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}
