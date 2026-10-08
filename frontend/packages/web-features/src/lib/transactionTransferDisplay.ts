import type { ReadTransaction } from '@beecount/api-client'

export type TransferAmountDisplay = {
  text: string
  tone: 'positive' | 'negative' | 'default'
  direction: 'in' | 'out' | 'route'
}

function fmtAmount(value: number): string {
  return value.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

function withCurrency(value: number, currency?: string | null): string {
  const ccy = (currency || '').trim().toUpperCase()
  return ccy ? `${fmtAmount(value)} ${ccy}` : fmtAmount(value)
}

/**
 * Transfer display is account-relative when an account context is supplied.
 * Without account context, cross-currency transfers show both actual legs.
 */
export function transferAmountDisplay(
  tx: ReadTransaction,
  accountContext?: { id?: string | null; currency?: string | null },
): TransferAmountDisplay | null {
  if (tx.tx_type !== 'transfer') return null

  const fromCurrency = (tx.from_account_currency || '').trim().toUpperCase() || accountContext?.currency || null
  const toCurrency = (tx.to_account_currency || '').trim().toUpperCase() || accountContext?.currency || null
  const incomingAmount = tx.transfer_to_amount ?? tx.amount
  const accountId = accountContext?.id || null

  if (accountId && accountId === tx.from_account_id) {
    return { text: `-${withCurrency(tx.amount, fromCurrency)}`, tone: 'negative', direction: 'out' }
  }
  if (accountId && accountId === tx.to_account_id) {
    return { text: `+${withCurrency(incomingAmount, toCurrency)}`, tone: 'positive', direction: 'in' }
  }

  const isCrossCurrency =
    tx.transfer_to_amount != null &&
    ((fromCurrency && toCurrency && fromCurrency !== toCurrency) || incomingAmount !== tx.amount)

  if (isCrossCurrency) {
    return {
      text: `${withCurrency(tx.amount, fromCurrency)} → ${withCurrency(incomingAmount, toCurrency)}`,
      tone: 'default',
      direction: 'route',
    }
  }

  return {
    text: withCurrency(tx.amount, fromCurrency || toCurrency),
    tone: 'default',
    direction: 'route',
  }
}
