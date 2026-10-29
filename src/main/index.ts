import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, Menu, protocol, session } from 'electron'
import { registerAppProtocol } from './app-protocol'
import { registerIpcHandlers } from './ipc'
import { buildApplicationMenu } from './menu'
import { APP_SCHEME, resolveRendererTarget } from './renderer-target'
import { hardenSession, hardenWebContents, secureWebPreferences } from './security'
import { isSameOrigin } from './security-policy'

protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true } }])

// Only an unpackaged build may load the renderer from the Vite dev server.
const target = resolveRendererTarget(app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL'])

app.on('web-contents-created', (_event, contents) => hardenWebContents(contents, target))

function createMainWindow(): void {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Tracing Guatemala',
    webPreferences: secureWebPreferences(join(__dirname, '../preload/index.js'))
  })
  window.once('ready-to-show', () => window.show())
  void window.loadURL(target.entryUrl)
}

void app.whenReady().then(() => {
  hardenSession(session.defaultSession, target)
  if (target.mode === 'production') {
    registerAppProtocol(join(__dirname, '../renderer'))
  }
  registerIpcHandlers(ipcMain, {
    isTrustedSender: (url) => isSameOrigin(url, target.origin),
    getAppInfo: () => ({ name: app.getName(), version: app.getVersion(), platform: process.platform })
  })
  Menu.setApplicationMenu(buildApplicationMenu(target.mode === 'development'))

  createMainWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
