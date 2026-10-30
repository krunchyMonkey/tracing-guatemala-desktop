import type { BackupChoice } from '../../../shared/ipc'
import type { AppDataApi, BackupApi, BackupStatusApi, CaseApi, LanAdminApi } from '../runtime/AppRuntime'

// The Live web app's data calls (#110): same-origin fetches to the loopback
// local web host (src/server/live-host.ts). Every call carries the session's
// CSRF token; the session cookie itself is HttpOnly. Backups are downloaded and
// restored by upload instead of native file dialogs.

export const API_PREFIX = '/api/v1'
const CSRF_HEADER = 'X-TG-CSRF'

/** `demoUrl` is the host's fictional-demo address (#114); untrusted until web/demoLink.ts checks it. */
export type SessionState =
  | { authenticated: true; csrfToken: string; demoUrl?: unknown; remote?: boolean; device?: { name?: unknown } }
  | { authenticated: false; demoUrl?: unknown; remote?: boolean }

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

/**
 * Pairs this browser with the host using the code shown on the researcher's
 * computer (#136). Resolves on success (the browser now holds the session
 * cookie); rejects with the host's error code, or `unreachable`.
 */
export async function enrollDevice(code: string, deviceName: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  let response: Response
  try {
    response = await fetchImpl(`${API_PREFIX}/lan/enroll`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(deviceName.trim() ? { code, deviceName } : { code })
    })
  } catch {
    throw new LiveApiError('unreachable')
  }
  if (!response.ok) {
    const error = (await response.json().catch(() => null)) as { error?: unknown } | null
    throw new LiveApiError(typeof error?.error === 'string' ? error.error : `http-${response.status}`)
  }
}

interface LiveApiOptions {
  csrfToken: string
  /** Called when the host no longer knows this browser (it was restarted). */
  onSessionLost: () => void
  /** Called when the host can't be reached at all (paired devices only, #137). */
  onUnreachable?: () => void
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

export function createLiveApi(options: LiveApiOptions): {
  data: AppDataApi
  backup: BackupApi
  backupStatus: BackupStatusApi
  cases: CaseApi
  lan: LanAdminApi
  /** Ends this paired device's session (home-network devices only). */
  signOut: () => Promise<void>
} {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
  const pickFile = options.pickFile ?? pickBackupFile
  const download = options.download ?? downloadUrl

  async function post<T>(path: string, body: BodyInit, headers: Record<string, string>): Promise<T> {
    let response: Response
    try {
      response = await fetchImpl(`${API_PREFIX}${path}`, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { ...headers, [CSRF_HEADER]: options.csrfToken },
        body
      })
    } catch {
      options.onUnreachable?.()
      throw new LiveApiError('unreachable')
    }
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

  const backupStatus: BackupStatusApi = () => call('getBackupStatus')

  const cases: CaseApi = {
    listCases: (query) => call('listCases', query),
    getCase: (id) => call('getCase', id),
    listCaseEvents: (caseId) => call('listCaseEvents', caseId),
    createCase: (clientId, input) => call('createCase', clientId, input),
    updateCase: (id, input) => call('updateCase', id, input),
    setCaseState: (id, to) => call('setCaseState', id, to),
    archiveCase: (id) => call('archiveCase', id),
    unarchiveCase: (id) => call('unarchiveCase', id),
    getCaseBrief: (caseId) => call('getCaseBrief', caseId),
    saveCaseBrief: (caseId, input) => call('saveCaseBrief', caseId, input),
    listJournalEntries: (caseId) => call('listJournalEntries', caseId),
    createJournalEntry: (caseId, input) => call('createJournalEntry', caseId, input),
    updateJournalEntry: (caseId, entryId, input) => call('updateJournalEntry', caseId, entryId, input),
    getNotebook: (caseId) => call('getNotebook', caseId),
    createNotebookSection: (caseId, input) => call('createNotebookSection', caseId, input),
    renameNotebookSection: (caseId, sectionId, input) => call('renameNotebookSection', caseId, sectionId, input),
    moveNotebookSection: (caseId, sectionId, toIndex) => call('moveNotebookSection', caseId, sectionId, toIndex),
    archiveNotebookSection: (caseId, sectionId) => call('archiveNotebookSection', caseId, sectionId),
    unarchiveNotebookSection: (caseId, sectionId) => call('unarchiveNotebookSection', caseId, sectionId),
    createNotebookPage: (caseId, sectionId, input) => call('createNotebookPage', caseId, sectionId, input),
    getNotebookPage: (caseId, pageId) => call('getNotebookPage', caseId, pageId),
    renameNotebookPage: (caseId, pageId, input) => call('renameNotebookPage', caseId, pageId, input),
    moveNotebookPage: (caseId, pageId, move) => call('moveNotebookPage', caseId, pageId, move),
    archiveNotebookPage: (caseId, pageId) => call('archiveNotebookPage', caseId, pageId),
    unarchiveNotebookPage: (caseId, pageId) => call('unarchiveNotebookPage', caseId, pageId),
    saveNotebookPage: (caseId, pageId, save) => call('saveNotebookPage', caseId, pageId, save),
    listPageRevisions: (caseId, pageId) => call('listPageRevisions', caseId, pageId),
    getPageRevision: (caseId, pageId, revisionId) => call('getPageRevision', caseId, pageId, revisionId),
    restorePageRevision: (caseId, pageId, revisionId, baseVersion) => call('restorePageRevision', caseId, pageId, revisionId, baseVersion),
    listCaseTasks: (caseId) => call('listCaseTasks', caseId),
    createCaseTask: (caseId, input) => call('createCaseTask', caseId, input),
    updateCaseTask: (caseId, taskId, input) => call('updateCaseTask', caseId, taskId, input),
    completeCaseTask: (caseId, taskId) => call('completeCaseTask', caseId, taskId),
    reopenCaseTask: (caseId, taskId) => call('reopenCaseTask', caseId, taskId),
    listTimeEntries: (caseId) => call('listTimeEntries', caseId),
    createTimeEntry: (caseId, input) => call('createTimeEntry', caseId, input),
    updateTimeEntry: (caseId, entryId, input) => call('updateTimeEntry', caseId, entryId, input),
    deleteTimeEntry: (caseId, entryId) => call('deleteTimeEntry', caseId, entryId),
    getActiveTimer: () => call('getActiveTimer'),
    startTimer: (caseId) => call('startTimer', caseId),
    pauseTimer: (version) => call('pauseTimer', version),
    resumeTimer: (version) => call('resumeTimer', version),
    heartbeatTimer: (version) => call('heartbeatTimer', version),
    stopAndSaveTimer: (version, options) => call('stopAndSaveTimer', version, options),
    discardTimer: (version) => call('discardTimer', version),
    getStudioSummary: () => call('getStudioSummary')
  }

  const lan: LanAdminApi = {
    getLanStatus: () => call('getLanStatus'),
    createPairingCode: () => call('createPairingCode'),
    listDevices: () => call('listDevices'),
    revokeDevice: (id) => call('revokeDevice', id),
    revokeAllDevices: () => call('revokeAllDevices'),
    disableLan: () => call('disableLan')
  }

  const signOut = async () => {
    await post('/lan/logout', '{}', { 'Content-Type': 'application/json' })
  }

  return { data, backup, backupStatus, cases, lan, signOut }
}
