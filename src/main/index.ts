import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, session } from 'electron'
import { registerAppProtocol } from './app-protocol'
import { BACKUP_EXTENSION, createBackupService, type BackupDialogs } from './backup'
import { AppData } from './database/app-data'
import { DatabaseTooNewError } from './database/migrations'
import { registerIpcHandlers, type ClientService, type NoteService } from './ipc'
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

let data: AppData | null = null

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

function openDataOrQuit(): AppData | null {
  try {
    return new AppData(app.getPath('userData'))
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

const backupFilters = [{ name: 'Tracing Guatemala backup', extensions: [BACKUP_EXTENSION] }]

const backupDialogs: BackupDialogs = {
  async chooseSaveTarget(defaultName) {
    const options = { title: 'Save a backup', defaultPath: join(app.getPath('documents'), defaultName), filters: backupFilters }
    const window = BrowserWindow.getFocusedWindow()
    const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options)
    return result.canceled || !result.filePath ? null : result.filePath
  },
  async chooseBackupFile() {
    const options = {
      title: 'Choose a backup to restore',
      properties: ['openFile' as const],
      filters: [...backupFilters, { name: 'All files', extensions: ['*'] }]
    }
    const window = BrowserWindow.getFocusedWindow()
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  }
}

void app.whenReady().then(() => {
  data = openDataOrQuit()
  if (!data) return
  const current = (): AppData => {
    if (!data) throw new Error('Data is closed')
    return data
  }
  // Delegate on every call: a restore replaces the connection and repositories.
  const clients: ClientService = {
    list: (query) => current().clients.list(query),
    get: (id) => current().clients.get(id),
    create: (input) => current().clients.create(input),
    update: (id, input) => current().clients.update(id, input),
    archive: (id) => current().clients.archive(id),
    restore: (id) => current().clients.restore(id),
    findDuplicates: (input, excludeId) => current().clients.findDuplicates(input, excludeId)
  }
  const notes: NoteService = {
    list: (clientId) => current().notes.list(clientId),
    create: (clientId, input) => current().notes.create(clientId, input),
    update: (clientId, noteId, input) => current().notes.update(clientId, noteId, input)
  }

  hardenSession(session.defaultSession, target)
  if (target.mode === 'production') {
    registerAppProtocol(join(__dirname, '../renderer'))
  }
  registerIpcHandlers(ipcMain, {
    isTrustedSender: (url) => isSameOrigin(url, target.origin),
    getAppInfo: () => ({ name: app.getName(), version: app.getVersion(), platform: process.platform }),
    clients,
    notes,
    backup: createBackupService(current, backupDialogs)
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
  data?.close()
  data = null
})
