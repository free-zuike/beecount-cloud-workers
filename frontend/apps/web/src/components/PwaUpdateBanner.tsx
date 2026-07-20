import { useEffect, useState } from 'react'
import { RefreshCw, X } from 'lucide-react'

import { Button, useT } from '@beecount/ui'

import { acceptServiceWorkerUpdate, SW_UPDATE_EVENT } from '../lib/pwa-sw-update'

const DISMISS_KEY = 'beecount.pwa.update-dismissed'

export function PwaUpdateBanner() {
  const t = useT()
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const sessionDismissed = sessionStorage.getItem(DISMISS_KEY) === '1'
    if (sessionDismissed) return

    const onUpdate = () => setVisible(true)
    window.addEventListener(SW_UPDATE_EVENT, onUpdate)
    return () => window.removeEventListener(SW_UPDATE_EVENT, onUpdate)
  }, [])

  if (!visible) return null

  return (
    <div className="fixed left-1/2 top-3 z-50 -translate-x-1/2 px-3 sm:left-auto sm:right-4 sm:translate-x-0">
      <div className="flex items-center gap-3 rounded-lg border border-primary/40 bg-background/95 px-4 py-2 shadow-lg backdrop-blur">
        <RefreshCw className="h-4 w-4 text-primary" />
        <span className="text-sm">{t('pwa.update.available')}</span>
        <Button
          size="sm"
          className="h-7 px-3"
          onClick={() => {
            acceptServiceWorkerUpdate()
          }}
        >
          {t('pwa.update.apply')}
        </Button>
        <button
          type="button"
          className="rounded p-1 text-muted-foreground hover:bg-muted"
          aria-label={t('common.close') as string}
          onClick={() => {
            sessionStorage.setItem(DISMISS_KEY, '1')
            setVisible(false)
          }}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}
