import type { ReadTransaction } from '@beecount/api-client'
import { Card, CardContent, CardHeader, CardTitle, useT } from '@beecount/ui'
import { transferAmountDisplay } from '@beecount/web-features'

interface Props {
  transactions: ReadTransaction[]
  onClickTransaction?: (tx: ReadTransaction) => void
}

function formatDate(s: string): string {
  try {
    const d = new Date(s)
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    const hh = String(d.getHours()).padStart(2, '0')
    const mi = String(d.getMinutes()).padStart(2, '0')
    return `${mm}/${dd} ${hh}:${mi}`
  } catch {
    return s
  }
}

export function OverviewRecentTransactions({ transactions, onClickTransaction }: Props) {
  const t = useT()
  const top = transactions.slice(0, 8)

  return (
    <Card className="bc-panel overflow-hidden">
      <CardHeader>
        <CardTitle className="text-base">{t('overview.recent.title')}</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {top.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-xs text-muted-foreground">
            {t('overview.recent.empty')}
          </div>
        ) : (
          <ul className="divide-y divide-border/50">
            {top.map((tx) => {
              const transferDisplay = transferAmountDisplay(tx)
              const sign = transferDisplay
                ? ''
                : tx.tx_type === 'expense' ? '-' : tx.tx_type === 'income' ? '+' : ''
              const amountColor = transferDisplay?.tone === 'negative'
                ? 'text-expense'
                : transferDisplay?.tone === 'positive'
                  ? 'text-income'
                  : tx.tx_type === 'expense'
                    ? 'text-expense'
                    : tx.tx_type === 'income'
                      ? 'text-income'
                      : 'text-foreground'
              const accountText = tx.tx_type === 'transfer'
                ? `${tx.from_account_name || '-'} → ${tx.to_account_name || '-'}`
                : tx.account_name
              return (
                <li
                  key={tx.id}
                  className={`group flex items-center gap-3 px-4 py-2.5 text-sm transition hover:bg-accent/40 ${
                    onClickTransaction ? 'cursor-pointer' : ''
                  }`}
                  onClick={() => onClickTransaction?.(tx)}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">
                        {tx.category_name ||
                          (tx.tx_type === 'transfer'
                            ? t('overview.recent.transfer')
                            : t('overview.recent.uncategorized'))}
                      </span>
                      {tx.tags_list && tx.tags_list.length > 0 ? (
                        <span className="truncate text-[11px] text-muted-foreground">
                          · {tx.tags_list.join(',')}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                      <span>{formatDate(tx.happened_at)}</span>
                      {accountText ? <span>· {accountText}</span> : null}
                      {tx.ledger_name ? <span>· {tx.ledger_name}</span> : null}
                    </div>
                  </div>
                  <div className={`shrink-0 font-mono tabular-nums ${amountColor}`}>
                    {transferDisplay ? transferDisplay.text : (
                      <>
                        {sign}
                        {tx.amount.toLocaleString(undefined, {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2
                        })}
                      </>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
