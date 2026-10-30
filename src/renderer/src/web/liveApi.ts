import type { BackupChoice } from '../../../shared/ipc'
import type { AppDataApi, BackupApi } from '../runtime/AppRuntime'

// The Live web app's data calls (#110): same-origin fetches to the loopback
// local web host (src/server/live-host.ts). Every call carries the session's
// CSRF token; the session cookie itself is HttpOnly. Backups are downloaded and
// restored by upload instead of native file dialogs.

export const API_PREFIX = '/api/v1'
const CSRF_HEADER = 'X-TG-CSRF'

/** `demoUrl` is the host's fictional-demo address (#114); untrusted until web/demoLink.ts checks it. */
export type SessionState = { authenticated: true; csrfToken: string; demoUrl?: unknown } | { authenticated: false; demoUrl?: unknown }

/** Thrown for any failed call; carries only the host's error code. */
export class LiveApiError extends Error {
  constructor(readonly code: string) {
    super(`Live request rejected: ${code}`)
    this.name = 'LiveApiError'
  }
}

export async function fetchSession(fetchImpl: typeof fetch = fetch): Promise<SessionState> {
  const response = await fetchImpl(`${API_PREFIX}/session`, { credentials: 'same-origin', cache: 'no-store' })
  if (!response.ok) throw new LiveApiError(`http-${response.status}`)
  return (await response.json()) as SessionState
}

interface LiveApiOptions {
  csrfToken: string
  /** Called when the host no longer knows this browser (it was restarted). */
  onSessionLost: () => void
  fetchImpl?: typeof fetch
  /** Lets the person pick a backup file; resolves null if they cancel. */
  pickFile?: () => Promise<File | null>
  /** Starts a browser download of `url`. */
  download?: (url: string) => void
}

/** A hidden file input; `cancel` fires when the picker is dismissed. */
export function pickBackupFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.tgbackup'
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true })
    input.addEventListener('cancel', () => resolve(null), { once: true })
    input.click()
  })
}

export function downloadUrl(url: string): void {
  const link = document.createElement('a')
  link.href = url
  link.download = ''
  link.rel = 'noopener'
  document.body.append(link)
  link.click()
  link.remove()
}

export function createLiveApi(options: LiveApiOptions): { data: AppDataApi; backup: BackupApi } {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
  const pickFile = options.pickFile ?? pickBackupFile
  const download = options.download ?? downloadUrl

  async function post<T>(path: string, body: BodyInit, headers: Record<string, string>): Promise<T> {
    const response = await fetchImpl(`${API_PREFIX}${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { ...headers, [CSRF_HEADER]: options.csrfToken },
      body
    })
    if (response.status === 401) options.onSessionLost()
    if (!response.ok) {
      const error = (await response.json().catch(() => null)) as { error?: unknown } | null
      throw new LiveApiError(typeof error?.error === 'string' ? error.error : `http-${response.status}`)
    }
    return ((await response.json()) as { result: T }).result
  }

  const call = <T>(name: string, ...args: unknown[]) =>
    post<T>(`/call/${name}`, JSON.stringify({ args }), { 'Content-Type': 'application/json' })

  const data: AppDataApi = {
    getAppInfo: () => call('getAppInfo'),
    listClients: (query) => call('listClients', query),
    getClient: (id) => call('getClient', id),
    createClient: (input) => call('createClient', input),
    updateClient: (id, input) => call('updateClient', id, input),
    archiveClient: (id) => call('archiveClient', id),
    restoreClient: (id) => call('restoreClient', id),
    findDuplicateClients: (input, excludeId) => call('findDuplicateClients', input, excludeId),
    listNotes: (clientId) => call('listNotes', clientId),
    createNote: (clientId, input) => call('createNote', clientId, input),
    updateNote: (clientId, noteId, input) => call('updateNote', clientId, noteId, input)
  }

  const backup: BackupApi = {
    async createBackup() {
      const result = await call<Awaited<ReturnType<BackupApi['createBackup']>>>('createBackup')
      if (result.ok) download(`${API_PREFIX}/backup/download/${encodeURIComponent(result.fileName)}`)
      return result
    },
    async chooseBackupToRestore() {
      const file = await pickFile()
      if (!file) return { ok: false, reason: 'cancelled' }
      return post<BackupChoice>('/backup/upload', file, {
        'Content-Type': 'application/octet-stream',
        'X-TG-File-Name': encodeURIComponent(file.name),
        'X-TG-Last-Modified': String(file.lastModified)
      })
    },
    restoreBackup: (token) => call('restoreBackup', token)
  }

  return { data, backup }
}
