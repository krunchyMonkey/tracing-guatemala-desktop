import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import type { NotebookPage } from '../../../shared/notebook'
import type { NoteContent } from '../../../shared/note-content'
import type { NotebookApi } from '../runtime/notebookApi'

// Basic saving for the notebook screen (#148; #149 hardens it with recovery). Edits are
// kept per page in memory, so leaving a page never drops what was typed: a page stays
// "dirty" until the host has accepted its content. A change is saved after a short
// pause, or at once when the person leaves the page. A stale save (`conflict`) is only
// reported here; resolving it is #149.

export const SAVE_DELAY_MS = 800

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'failed' | 'conflict'

export interface Draft {
  content: NoteContent
  /** The version the content builds on; sent with every save. */
  baseVersion: number
  /** True while the host has not accepted `content`. */
  dirty: boolean
}

export interface PageDrafts {
  statusOf(pageId: string): SaveStatus
  /** The unsaved draft of a page, if it has one. */
  unsavedDraft(pageId: string): Draft | undefined
  /** Starts tracking a freshly loaded page (no-op when it has unsaved changes). */
  adopt(page: Pick<NotebookPage, 'id' | 'version' | 'content'>): void
  /** The editor changed the page: remember it and save after a pause. */
  edit(pageId: string, content: NoteContent): void
  /** Saves now (when there is something to save). */
  flush(pageId: string): Promise<void>
  /** Forgets the draft, e.g. before reloading the page from the host. */
  discard(pageId: string): void
  hasUnsaved(): boolean
}

export function usePageDrafts(caseId: string, api: Pick<NotebookApi, 'saveNotebookPage'>): PageDrafts {
  const drafts = useRef(new Map<string, Draft>())
  const statuses = useRef(new Map<string, SaveStatus>())
  const timers = useRef(new Map<string, number>())
  const inFlight = useRef(new Set<string>())
  const [, refresh] = useReducer((n: number) => n + 1, 0)
  const apiRef = useRef(api)
  useEffect(() => {
    apiRef.current = api
  })

  const setStatus = useCallback((pageId: string, status: SaveStatus) => {
    statuses.current.set(pageId, status)
    refresh()
  }, [])

  const clearTimer = useCallback((pageId: string) => {
    const timer = timers.current.get(pageId)
    if (timer !== undefined) window.clearTimeout(timer)
    timers.current.delete(pageId)
  }, [])

  const save = useCallback(
    async (pageId: string): Promise<void> => {
      clearTimer(pageId)
      const draft = drafts.current.get(pageId)
      if (!draft || !draft.dirty || inFlight.current.has(pageId)) return
      inFlight.current.add(pageId)
      setStatus(pageId, 'saving')
      const sent = draft.content
      let result: Awaited<ReturnType<NotebookApi['saveNotebookPage']>> | null
      try {
        result = await apiRef.current.saveNotebookPage(caseId, pageId, { baseVersion: draft.baseVersion, content: sent })
      } catch {
        result = null
      }
      inFlight.current.delete(pageId)
      if (drafts.current.get(pageId) !== draft) return
      if (result?.ok) {
        draft.baseVersion = result.page.version
        if (draft.content === sent) {
          draft.dirty = false
          setStatus(pageId, 'saved')
        } else void save(pageId)
      } else {
        setStatus(pageId, result && !result.ok && result.reason === 'conflict' ? 'conflict' : 'failed')
      }
    },
    [caseId, clearTimer, setStatus]
  )

  // Leaving the notebook: save what is pending (the requests carry on without this screen).
  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const pageId of [...pending.keys()]) void save(pageId)
    }
  }, [save])

  return useMemo<PageDrafts>(
    () => ({
      statusOf: (pageId) => statuses.current.get(pageId) ?? 'idle',
      unsavedDraft: (pageId) => {
        const draft = drafts.current.get(pageId)
        return draft?.dirty ? draft : undefined
      },
      adopt(page) {
        if (drafts.current.get(page.id)?.dirty) return
        drafts.current.set(page.id, { content: page.content, baseVersion: page.version, dirty: false })
        statuses.current.delete(page.id)
        refresh()
      },
      edit(pageId, content) {
        const draft = drafts.current.get(pageId)
        if (!draft) return
        draft.content = content
        draft.dirty = true
        clearTimer(pageId)
        // A stale page stays flagged; anything else is about to be saved.
        if (statuses.current.get(pageId) !== 'conflict') setStatus(pageId, 'saving')
        timers.current.set(
          pageId,
          window.setTimeout(() => void save(pageId), SAVE_DELAY_MS)
        )
      },
      flush: (pageId) => save(pageId),
      discard(pageId) {
        clearTimer(pageId)
        drafts.current.delete(pageId)
        statuses.current.delete(pageId)
        refresh()
      },
      hasUnsaved: () => [...drafts.current.values()].some((d) => d.dirty)
    }),
    [clearTimer, save, setStatus]
  )
}
