import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, session } from 'electron'
import { registerAppProtocol } from './app-protocol'
import { ClientRepository } from './database/client-repository'
import { openAppDatabase, type OpenedDatabase } from './database/connection'
import { DatabaseTooNewError } from './database/migrations'
import { registerIpcHandlers } from './ipc'
import { buildApplicationMenu } from './menu'
import { APP_SCHEME, resolveRendererTarget } from './renderer-target'
import { hardenSession, hardenWebContents, secureWebPreferences } from './security'
import { isSameOrigin } from './security-policy'

protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true } }])

// Only an unpackaged build may load the renderer from the Vite dev server.
const target = resolveRendererTarget(app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL'])

// Tests run the unpackaged build against a throwaway profile. A packaged app
// ignores this and always uses the OS per-user data directory.
const testUserData = process.env['TRACING_GUATEMALA_TEST_USER_DATA']
if (!app.isPackaged && testUserData) app.setPath('userData', testUserData)

let database: OpenedDatabase | null = null

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

function openDatabaseOrQuit(): OpenedDatabase | null {
  try {
    return openAppDatabase(app.getPath('userData'))
  } catch (error) {
    // Only the error name is logged: SQLite messages can quote stored values.
    console.error(`Database open failed: ${error instanceof Error ? error.name : 'unknown error'}`)
    const detail =
      error instanceof DatabaseTooNewError
        ? 'Your data was saved by a newer version of Tracing Guatemala. Install that version to keep using it. Nothing was changed.'
        : 'Your saved data could not be opened. Nothing was changed or deleted. Close other copies of the app and try again.'
    dialog.showErrorBox('Tracing Guatemala cannot open its data', detail)
    app.exit(1)
    return null
  }
}

void app.whenReady().then(() => {
  database = openDatabaseOrQuit()
  if (!database) return
  const clients = new ClientRepository(database.db)

  hardenSession(session.defaultSession, target)
  if (target.mode === 'production') {
    registerAppProtocol(join(__dirname, '../renderer'))
  }
  registerIpcHandlers(ipcMain, {
    isTrustedSender: (url) => isSameOrigin(url, target.origin),
    getAppInfo: () => ({ name: app.getName(), version: app.getVersion(), platform: process.platform }),
    clients
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

app.on('will-quit', () => {
  database?.db.close()
  database = null
})
