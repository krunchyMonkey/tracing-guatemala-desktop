import { useEffect, useRef, useState } from 'react'
import type { RecordRef } from '../../../shared/note-content'
import type { NotebookPage, PageRevision, PageRevisionSummary } from '../../../shared/notebook'
import { ConfirmDialog, formatDateTime } from '../clients/components'
import { useCaseApi } from '../cases/useCaseApi'
import { ModalDialog } from './ModalDialog'
import { NoteContentView } from './NoteContentView'

// Page history (#149): the earlier states the host kept, a read-only preview of each,
// and "Restore this version". Restoring never loses the current text: the host keeps it
// as a "Before restore" entry first. It is refused while the page has text that is not
// saved yet, and when another window changed the page meanwhile (nothing is overwritten).

const reasonLabels: Record<PageRevisionSummary['reason'], string> = {
  autosave: 'Autosave',
  'restore-point': 'Before restore',
  restored: 'Restored'
}

interface HistoryDialogProps {
  caseId: string
  pageId: string
  /** The version the page is at, here. A change refreshes the list. */
  currentVersion: number
  /** Restoring is not allowed while this is true (unsaved text, read-only page). */
  blockedReason: string | null
  describe(ref: RecordRef): string
  onRestored(page: NotebookPage): void
  /** Another window changed the page: the page as it is now. */
  onConflict(page: NotebookPage): void
  onClose(): void
  returnFocus?: () => void
}

export function HistoryDialog({ caseId, pageId, currentVersion, blockedReason, describe, onRestored, onConflict, onClose, returnFocus }: HistoryDialogProps) {
  const api = useCaseApi()
  const [list, setList] = useState<PageRevisionSummary[] | null>(null)
  const [listFailed, setListFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [preview, setPreview] = useState<PageRevision | null | 'failed'>(null)
  const [confirming, setConfirming] = useState(false)
  const [working, setWorking] = useState(false)
  const [message, setMessage] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let current = true
    setListFailed(false)
    api.listPageRevisions(caseId, pageId).then(
      (revisions) => {
        if (current) setList(revisions)
      },
      () => {
        if (current) setListFailed(true)
      }
    )
    return () => {
      current = false
    }
  }, [api, caseId, pageId, currentVersion, attempt])

  useEffect(() => {
    if (!selectedId) {
      setPreview(null)
      return
    }
    let current = true
    setPreview(null)
    api.getPageRevision(caseId, pageId, selectedId).then(
      (revision) => {
        if (current) setPreview(revision ?? 'failed')
      },
      () => {
        if (current) setPreview('failed')
      }
    )
    return () => {
      current = false
    }
  }, [api, caseId, pageId, selectedId])

  const selected = list?.find((r) => r.id === selectedId)

  async function restore() {
    if (!selected || blockedReason || working) return
    setConfirming(false)
    setWorking(true)
    setProblem(null)
    setMessage('')
    let result
    try {
      result = await api.restorePageRevision(caseId, pageId, selected.id, currentVersion)
    } catch {
      setWorking(false)
      setProblem('Couldn’t restore that version. Nothing was changed; please try again.')
      return
    }
    setWorking(false)
    if (result.ok) {
      setMessage(`Restored the version from ${formatDateTime(selected.createdAt)}. What was there before is kept in the history.`)
      setSelectedId(null)
      onRestored(result.page)
    } else if (result.reason === 'conflict') {
      setProblem('This page was changed in another window, so nothing was restored. The page now shows the saved version; look again and restore if you still want to.')
      setSelectedId(null)
      onConflict(result.page)
    } else {
      setProblem('This page can’t be changed any more (it or its case may be archived), so nothing was restored.')
    }
  }

  return (
    <>
      <ModalDialog title="Page history" wide onClose={onClose} initialFocus={() => closeRef.current} returnFocus={returnFocus}>
        <p className="muted">Earlier versions of this page. Pick one to read it; restoring never loses what is on the page now.</p>
        <div role="status" aria-live="polite" className="note-history-message">
          {message}
        </div>
        {problem && (
          <p className="issue-error" role="alert">
            {problem}
          </p>
        )}
        {listFailed && list === null ? (
          <p role="alert" className="issue-error">
            The history couldn’t be loaded.{' '}
            <button type="button" className="button button-secondary button-small" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          </p>
        ) : list === null ? (
          <p role="status" className="muted">
            Loading history…
          </p>
        ) : list.length === 0 ? (
          <p className="muted">No earlier versions yet. They appear as you write.</p>
        ) : (
          <div className="note-history">
            <ul className="note-history-list" aria-label="Versions">
              {list.map((revision) => (
                <li key={revision.id}>
                  <button
                    type="button"
                    className="note-history-item"
                    aria-pressed={revision.id === selectedId}
                    onClick={() => {
                      setSelectedId(revision.id)
                      setConfirming(false)
                    }}
                  >
                    <span className="note-history-time">{formatDateTime(revision.createdAt)}</span>
                    <span className="muted">
                      {reasonLabels[revision.reason]} · version {revision.version}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="note-history-preview" aria-label="Preview" role="region">
              {selected === undefined ? (
                <p className="muted">Choose a version to read it here.</p>
              ) : preview === null ? (
                <p role="status" className="muted">
                  Loading version…
                </p>
              ) : preview === 'failed' ? (
                <p role="alert" className="issue-error">
                  That version couldn’t be loaded.
                </p>
              ) : (
                <NoteContentView content={preview.content} describe={describe} />
              )}
            </div>
          </div>
        )}
        {selected && blockedReason && <p className="muted note-history-blocked">{blockedReason}</p>}
        <div className="dialog-actions">
          <button ref={closeRef} type="button" className="button button-secondary" onClick={onClose}>
            Close
          </button>
          <button type="button" className="button button-primary" disabled={!selected || preview === null || preview === 'failed' || blockedReason !== null || working} aria-busy={working} onClick={() => setConfirming(true)}>
            {working ? 'Restoring…' : 'Restore this version'}
          </button>
        </div>
      </ModalDialog>
      {confirming && selected && (
        <ConfirmDialog title="Restore this version?" confirmLabel="Restore version" onCancel={() => setConfirming(false)} onConfirm={() => void restore()}>
          <p>
            The page goes back to the version from {formatDateTime(selected.createdAt)}. <strong>Nothing is lost:</strong> what is on the page now stays in the history as “Before restore”.
          </p>
        </ConfirmDialog>
      )}
    </>
  )
}
