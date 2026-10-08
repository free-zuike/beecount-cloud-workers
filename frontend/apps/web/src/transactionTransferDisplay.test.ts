import { describe, expect, it } from 'vitest'
import { transferAmountDisplay } from '@beecount/web-features'
import type { ReadTransaction } from '@beecount/api-client'

const tx = {
  id: 'tx-1', tx_index: 0, tx_type: 'transfer', amount: 24.2, transfer_to_amount: 159.5,
  happened_at: '2026-10-08T10:34:10.000Z', note: null,
  category_name: '转账', category_kind: 'transfer', account_name: null,
  from_account_id: 'card', from_account_name: 'Card', from_account_currency: 'USD',
  to_account_id: 'alipay', to_account_name: 'Alipay', to_account_currency: 'CNY',
  tags: null, tags_list: [], attachments: null, last_change_id: 1,
} satisfies ReadTransaction

describe('transferAmountDisplay', () => {
  it('shows both actual legs in global cross-currency context', () => {
    expect(transferAmountDisplay(tx)).toEqual({
      text: '24.20 USD → 159.50 CNY', tone: 'default', direction: 'route',
    })
  })

  it('shows outgoing amount in the source account currency', () => {
    expect(transferAmountDisplay(tx, { id: 'card', currency: 'USD' })).toEqual({
      text: '-24.20 USD', tone: 'negative', direction: 'out',
    })
  })

  it('shows incoming amount in the destination account currency', () => {
    expect(transferAmountDisplay(tx, { id: 'alipay', currency: 'CNY' })).toEqual({
      text: '+159.50 CNY', tone: 'positive', direction: 'in',
    })
  })
})
