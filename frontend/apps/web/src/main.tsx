import React from 'react'
import { createRoot } from 'react-dom/client'
import {
  LocaleProvider,
  PrimaryColorProvider,
  ThemeProvider,
  ToastProvider,
  applyDocumentLocale,
  applyPrimaryColor,
  applyTheme,
  initialLocale,
  initialPrimaryColor,
  initialThemeMode
} from '@beecount/ui'

import { App } from './App'
import { dictionaries } from './i18n'
import { setupServiceWorkerUpdates } from './lib/pwa-sw-update'
import './styles.css'

applyTheme(initialThemeMode())
applyDocumentLocale(initialLocale())
// 启动时立刻 apply primary color，避免 React hydration 前首屏闪烁默认金色。
applyPrimaryColor(initialPrimaryColor())

// 注册 PWA service worker：生产 + dev 都注册，dev 下 sw 只管静态资源不影响
// HMR（/api 被跳过）。原生 fetch API 里 MIME 不对 iOS 会拒绝，所以指定 scope。
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((registration) => {
        setupServiceWorkerUpdates(registration)
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('[pwa] sw register failed', err)
      })
  })
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LocaleProvider dictionaries={dictionaries}>
      <ThemeProvider>
        <PrimaryColorProvider>
          <ToastProvider>
            <App />
          </ToastProvider>
        </PrimaryColorProvider>
      </ThemeProvider>
    </LocaleProvider>
  </React.StrictMode>
)
