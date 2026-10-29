import type { Session, WebContents, WebPreferences } from 'electron'
import { buildContentSecurityPolicy } from '../shared/csp'
import type { RendererTarget } from './renderer-target'
import { describeBlockedUrl, isAllowedRequestUrl, isSameOrigin } from './security-policy'

export function secureWebPreferences(preloadPath: string): WebPreferences {
  return {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    // Chromium's spellchecker can download dictionaries on some platforms.
    spellcheck: false
  }
}

export function hardenSession(ses: Session, target: RendererTarget): void {
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)

  ses.webRequest.onBeforeRequest((details, callback) => {
    const allowed = isAllowedRequestUrl(details.url, target)
    if (!allowed) {
      console.warn(`[security] blocked ${describeBlockedUrl(details.url)} request`)
    }
    callback({ cancel: !allowed })
  })

  // Production responses get their CSP from the app:// protocol handler.
  if (target.mode === 'development') {
    const csp = buildContentSecurityPolicy({ mode: 'development', devServerOrigin: target.origin })
    ses.webRequest.onHeadersReceived((details, callback) => {
      callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } })
    })
  }
}

export function hardenWebContents(contents: WebContents, target: RendererTarget): void {
  const blockForeignNavigation = (event: { url: string; preventDefault(): void }) => {
    if (!isSameOrigin(event.url, target.origin)) {
      event.preventDefault()
      console.warn(`[security] blocked navigation to ${describeBlockedUrl(event.url)}`)
    }
  }
  contents.on('will-navigate', blockForeignNavigation)
  contents.on('will-redirect', blockForeignNavigation)
  contents.on('will-attach-webview', (event) => event.preventDefault())
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
}
