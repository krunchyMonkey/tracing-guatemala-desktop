import type { NoteContent } from '../../../shared/note-content'
import type { NotebookIssue, NotebookPage } from '../../../shared/notebook'
import type { NotebookApi } from '../runtime/notebookApi'

// Drafts of the notebook pages (#149): the text a person typed that the host has not
// confirmed yet. One store lives above the router (see DraftStoreContext), so leaving
// the notebook, switching cases or opening another page never drops a draft or stops
// its saving. Drafts are kept in memory ONLY: real client notes are never written to
// localStorage or sessionStorage (docs/architecture/research-notebook.md), so a closed
// or reloaded tab loses what was not saved, which is why leaving the tab warns first.
//
// Saving rules:
// - A change is saved after SAVE_DELAY_MS of quiet, or at once when the person leaves the page.
// - One save per page is in flight at a time. Edits made meanwhile are saved afterwards
//   with the version the previous save returned.
// - A failure (network, host error, thrown) keeps the draft and retries by itself after
//   1 s, 2 s, 5 s, 10 s, then every 30 s; "Retry now" tries at once.
// - `invalid` (the host refused the content) is not retried until the text changes.
// - `wrong-status` / `not-found` make the page read-only; the draft stays readable.
// - `conflict` (another window saved first) pauses saving until the person decides.

export const SAVE_DELAY_MS = 800
export const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000] as const
export const RETRY_REPEAT_MS = 30_000

export type DraftStatus = 'clean' | 'saving' | 'saved' | 'retrying' | 'invalid' | 'conflict' | 'locked'

export interface DraftView {
  readonly caseId: string
  readonly pageId: string
  readonly content: NoteContent
  /** The version the content builds on; sent with every save. */
  readonly baseVersion: number
  /** True while the host has not accepted `content`. */
  readonly dirty: boolean
  readonly status: DraftStatus
  /** When the host last accepted this page from here. */
  readonly savedAt: Date | null
  /** For `invalid`: the first issue code the host reported. */
  readonly issueCode: string | null
  /** For `locked`: why the host refused (archived case or page, or the page is gone). */
  readonly lockedReason: 'wrong-status' | 'not-found' | null
  /** For `conflict`: the other window's version. */
  readonly conflictPage: NotebookPage | null
}

interface Entry {
  caseId: string
  pageId: string
  content: NoteContent
  baseVersion: number
  dirty: boolean
  status: DraftStatus
  savedAt: Date | null
  issueCode: string | null
  lockedReason: 'wrong-status' | 'not-found' | null
  conflictPage: NotebookPage | null
  keepPrevious: boolean
  inFlight: boolean
  failures: number
  saveTimer: number | undefined
  retryTimer: number | undefined
}

type SaveApi = Pick<NotebookApi, 'saveNotebookPage'>

export class NotebookDraftStore {
  private readonly entries = new Map<string, Entry>()
  private readonly listeners = new Set<() => void>()
  private version = 0

  constructor(
    private readonly getApi: () => SaveApi | null,
    private readonly now: () => Date = () => new Date()
  ) {}

  // ---------- subscription (useSyncExternalStore) ----------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Changes whenever anything in the store does. */
  getVersion = (): number => this.version

  private changed(): void {
    this.version += 1
    for (const listener of [...this.listeners]) listener()
  }

  // ---------- reads ----------

  get(pageId: string): DraftView | undefined {
    return this.entries.get(pageId)
  }

  /** The draft of a page, only while it holds text the host has not accepted. */
  unsaved(pageId: string): DraftView | undefined {
    const entry = this.entries.get(pageId)
    return entry?.dirty ? entry : undefined
  }

  /** Pages with text the host has not accepted yet, from any case. */
  unsavedPages(): DraftView[] {
    return [...this.entries.values()].filter((e) => e.dirty)
  }

  hasUnsaved(): boolean {
    return this.unsavedPages().length > 0
  }

  // ---------- changes ----------

  /** Starts tracking a freshly loaded page. A page with unsaved text keeps it. */
  adopt(caseId: string, page: Pick<NotebookPage, 'id' | 'version' | 'content'>): void {
    const entry = this.entries.get(page.id)
    if (entry?.dirty) {
      // The text is still the person's; only the version it builds on may be newer when nothing is in flight.
      return
    }
    this.clearTimers(entry)
    this.entries.set(page.id, this.fresh(caseId, page))
    this.changed()
  }

  /** The editor changed the page: remember it and save after a pause. */
  edit(pageId: string, content: NoteContent): void {
    const entry = this.entries.get(pageId)
    if (!entry) return
    entry.content = content
    entry.dirty = true
    this.clear(entry, 'retryTimer')
    this.clear(entry, 'saveTimer')
    if (entry.status === 'conflict' || entry.status === 'locked') {
      this.changed()
      return
    }
    entry.status = 'saving'
    entry.issueCode = null
    entry.saveTimer = window.setTimeout(() => void this.save(pageId), SAVE_DELAY_MS)
    this.changed()
  }

  /** Saves now (when there is something to save). */
  flush(pageId: string): Promise<void> {
    return this.save(pageId)
  }

  /** "Retry now": forgets the waiting time and tries again. */
  retryNow(pageId: string): Promise<void> {
    return this.save(pageId, true)
  }

  /** Drops the draft, e.g. when the person chose the saved version. */
  discard(pageId: string): void {
    const entry = this.entries.get(pageId)
    this.clearTimers(entry)
    if (this.entries.delete(pageId)) this.changed()
  }

  /** The page now matches what the host holds (after a restore): no draft, new version. */
  replaceWithSaved(caseId: string, page: Pick<NotebookPage, 'id' | 'version' | 'content'>): void {
    this.discard(page.id)
    this.entries.set(page.id, this.fresh(caseId, page))
    this.changed()
  }

  /** Conflict: re-save the draft on top of the other window's version, keeping that version in the history. */
  keepMine(pageId: string): Promise<void> {
    const entry = this.entries.get(pageId)
    if (!entry || entry.status !== 'conflict' || !entry.conflictPage) return Promise.resolve()
    entry.baseVersion = entry.conflictPage.version
    entry.conflictPage = null
    entry.keepPrevious = true
    entry.status = 'saving'
    this.changed()
    return this.save(pageId, true)
  }

  /** Conflict: drops the draft and returns the other window's page for the editor to show. */
  acceptSaved(pageId: string): NotebookPage | null {
    const entry = this.entries.get(pageId)
    const page = entry?.conflictPage ?? null
    if (!entry || !page) return null
    this.replaceWithSaved(entry.caseId, page)
    return page
  }

  // ---------- saving ----------

  private async save(pageId: string, manual = false): Promise<void> {
    const entry = this.entries.get(pageId)
    if (!entry) return
    this.clear(entry, 'saveTimer')
    this.clear(entry, 'retryTimer')
    if (!entry.dirty || entry.inFlight || entry.status === 'conflict' || entry.status === 'locked') return
    // A refused text is only sent again after it changed, or when the person asks.
    if (entry.status === 'invalid' && !manual) return
    const api = this.getApi()
    if (!api) return

    entry.inFlight = true
    entry.status = 'saving'
    this.changed()
    const sent = entry.content
    const keepPrevious = entry.keepPrevious
    let result: Awaited<ReturnType<SaveApi['saveNotebookPage']>> | null
    try {
      result = await api.saveNotebookPage(entry.caseId, pageId, {
        baseVersion: entry.baseVersion,
        content: sent,
        ...(keepPrevious ? { keepPrevious: true } : {})
      })
    } catch {
      result = null
    }
    entry.inFlight = false
    // Discarded or replaced while the save was running: the answer no longer matters here.
    if (this.entries.get(pageId) !== entry) return

    if (result?.ok) {
      entry.baseVersion = result.page.version
      entry.keepPrevious = false
      entry.failures = 0
      if (entry.content === sent) {
        entry.dirty = false
        entry.status = 'saved'
        entry.savedAt = this.now()
        this.changed()
      } else {
        // Edited during the save: save again on top of the new version.
        this.changed()
        void this.save(pageId)
      }
      return
    }

    if (result && !result.ok && result.reason === 'conflict') {
      entry.status = 'conflict'
      entry.conflictPage = result.page
    } else if (result && !result.ok && result.reason === 'invalid') {
      entry.status = 'invalid'
      entry.issueCode = firstIssueCode(result.issues)
    } else if (result && !result.ok) {
      entry.status = 'locked'
      entry.lockedReason = result.reason === 'not-found' ? 'not-found' : 'wrong-status'
    } else {
      this.scheduleRetry(entry)
    }
    this.changed()
  }

  private scheduleRetry(entry: Entry): void {
    // Newer text waiting for its own pause saves first and retries from there.
    entry.status = 'retrying'
    if (entry.saveTimer !== undefined) return
    const wait = RETRY_DELAYS_MS[entry.failures] ?? RETRY_REPEAT_MS
    entry.failures += 1
    entry.retryTimer = window.setTimeout(() => void this.save(entry.pageId), wait)
  }

  // ---------- internals ----------

  private fresh(caseId: string, page: Pick<NotebookPage, 'id' | 'version' | 'content'>): Entry {
    return {
      caseId,
      pageId: page.id,
      content: page.content,
      baseVersion: page.version,
      dirty: false,
      status: 'clean',
      savedAt: null,
      issueCode: null,
      lockedReason: null,
      conflictPage: null,
      keepPrevious: false,
      inFlight: false,
      failures: 0,
      saveTimer: undefined,
      retryTimer: undefined
    }
  }

  private clear(entry: Entry, which: 'saveTimer' | 'retryTimer'): void {
    if (entry[which] !== undefined) window.clearTimeout(entry[which])
    entry[which] = undefined
  }

  private clearTimers(entry: Entry | undefined): void {
    if (!entry) return
    this.clear(entry, 'saveTimer')
    this.clear(entry, 'retryTimer')
  }
}

function firstIssueCode(issues: NotebookIssue[]): string | null {
  return issues[0]?.code ?? null
}

// ---------- words for the status ----------

const pad = (n: number): string => String(n).padStart(2, '0')

/** Local time as HH:MM. */
export const clockTime = (at: Date): string => `${pad(at.getHours())}:${pad(at.getMinutes())}`

const issueMessages: Record<string, string> = {
  'content-too-long': 'The page is too long to save. Move some of it to a new page.',
  'text-too-long': 'A paragraph is too long. Split it into shorter ones.',
  'too-many-blocks': 'The page has too many blocks. Move some of it to a new page.',
  'too-many-runs': 'A paragraph has too much formatting. Simplify it or split it.',
  'invalid-href': 'A link on the page has an address that can’t be saved. Fix or remove the link.',
  'href-too-long': 'A link address on the page is too long. Shorten or remove the link.',
  'invalid-characters': 'The page has a character that can’t be saved. Remove it and try again.',
  'invalid-reference': 'A linked record on the page can’t be saved. Remove that link and add it again.'
}

/** Friendly words for a rejected save; never the content itself. */
export function issueMessage(code: string | null): string {
  return (code && issueMessages[code]) || 'The page has something the notebook can’t save. Edit it and try again.'
}

/** The line shown beside a page: "Saving…", "Saved at 14:05", "Not saved — retrying" and so on. */
export function statusText(view: DraftView | undefined): string {
  if (!view) return ''
  switch (view.status) {
    case 'saving':
      return 'Saving…'
    case 'saved':
      return view.savedAt ? `Saved at ${clockTime(view.savedAt)}` : 'Saved'
    case 'retrying':
      return 'Not saved — retrying'
    case 'invalid':
      return `Couldn’t save: ${issueMessage(view.issueCode)}`
    case 'conflict':
      return 'This page was changed in another window'
    case 'locked':
      return view.lockedReason === 'not-found' ? 'Not saved — the page is gone' : 'Not saved — read-only'
    case 'clean':
      return ''
  }
}
