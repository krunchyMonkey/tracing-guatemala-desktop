import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { useLocation, useNavigate } from 'react-router'
import type { JournalEntryInput } from '../../../shared/case-journal'
import type { CaseTaskInput } from '../../../shared/case-tasks'
import { checkNotebookTitle, PAGE_TITLE_MAX, type NotebookPage } from '../../../shared/notebook'
import { emptyNoteContent, noteContentToPlainText, type RecordRef } from '../../../shared/note-content'
import { newBlockId } from './newBlockId'
import { useCaseApi } from '../cases/useCaseApi'
import { useLoad } from '../cases/useLoad'
import { CreateJournalDialog, CreateTaskDialog, LinkRecordDialog, type CreateResult } from './BridgeDialogs'
import { statusText } from './draftStore'
import { useDraftStore } from './DraftStoreContext'
import { EditorToolbar } from './EditorToolbar'
import { HistoryDialog } from './HistoryDialog'
import { LinkDialog } from './LinkDialog'
import { useNotebookAdapters } from './NotebookAdapters'
import type { EditorCommand, EditorState, RichTextEditorSession } from './ports'
import type { CaseRecord, CaseRecords } from './useCaseRecords'

// One page: its title, the formatting toolbar, the writing surface and the save status.
// The editor is created once and shows each page through setContent, so switching pages
// keeps the toolbar, focus order and the library's own state in one place. Unsaved text
// lives in the draft store (provided by App), never only in the editor.

const PLACEHOLDER = 'Start writing… Use the toolbar or type # for a heading'
const IDLE_STATE: EditorState = { canUndo: false, canRedo: false, activeMarks: [], activeBlock: null, selectedText: '', focused: false }

const titleMessages: Record<string, string> = {
  required: 'Give the page a title.',
  'too-long': `Keep the title under ${PAGE_TITLE_MAX} characters.`,
  'invalid-characters': 'The title has a character that can’t be saved. Remove it and try again.'
}

const unsavedForHistory = 'This page has text that isn’t saved yet. Wait until it says “Saved” (or press Retry now), then restore a version.'

type Dialog = null | 'link' | 'record' | 'task' | 'journal' | 'history'

interface PageEditorProps {
  caseId: string
  pageId: string
  /** Why nothing here can be changed (archived case, client, section or page); null when editable. */
  lockedReason: string | null
  records: CaseRecords
  /** Renames go through the host; the screen refreshes the outline afterwards. */
  onRenamed(): void
  onFailure(reason: string): void
}

export function PageEditor({ caseId, pageId, lockedReason, records, onRenamed, onFailure }: PageEditorProps) {
  const api = useCaseApi()
  const store = useDraftStore()
  const navigate = useNavigate()
  const { editor } = useNotebookAdapters()
  const location = useLocation()
  const loaded = useLoad(() => api.getNotebookPage(caseId, pageId), `${caseId}:${pageId}`)
  const page = loaded.data && loaded.data.id === pageId ? loaded.data : undefined
  const missing = loaded.status === 'ready' && loaded.data === null
  const draft = store.get(pageId)
  const conflict = draft?.status === 'conflict'
  const gone = draft?.status === 'locked'
  const editable = page !== undefined && lockedReason === null && !conflict && !gone

  const hostRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const sessionRef = useRef<RichTextEditorSession | null>(null)
  /** The page whose content the editor holds; edits belong to it. */
  const shownRef = useRef<string | null>(null)
  const focusTitlePending = useRef(false)
  const describeRef = useRef(records.describe)
  const openRecordRef = useRef<(ref: RecordRef) => void>(() => undefined)
  const [session, setSession] = useState<RichTextEditorSession | null>(null)
  const [editorState, setEditorState] = useState<EditorState>(IDLE_STATE)
  const [title, setTitle] = useState('')
  const [titleIssue, setTitleIssue] = useState<string | null>(null)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [notice, setNotice] = useState('')
  const [copyNote, setCopyNote] = useState('')
  /** The words selected when the editor last had the focus (opening a dialog blurs the editor and some browsers drop the selection then). */
  const lastSelection = useRef('')
  const [pickedText, setPickedText] = useState('')

  useEffect(() => {
    openRecordRef.current = (ref) => navigate(`/cases/${caseId}`, { state: { focusRecord: `${ref.kind}-${ref.id}` } })
  })

  // Created once, empty and read-only until a page is shown.
  useEffect(() => {
    const created = editor.create({
      element: hostRef.current!,
      content: emptyNoteContent(),
      editable: false,
      label: 'Page text',
      placeholder: PLACEHOLDER,
      newId: newBlockId,
      onChange: (content) => {
        if (shownRef.current) store.edit(shownRef.current, content)
      },
      onStateChange: (state) => {
        setEditorState(state)
        if (state.focused || state.selectedText !== '') lastSelection.current = state.selectedText
      },
      describeReference: (ref) => describeRef.current(ref),
      onReferenceActivate: (ref) => openRecordRef.current(ref)
    })
    sessionRef.current = created
    setSession(created)
    return () => {
      created.destroy()
      sessionRef.current = null
      setSession(null)
    }
  }, [editor, store])

  // Reference labels follow the case's records, which may load after the blocks are shown.
  useEffect(() => {
    describeRef.current = records.describe
    session?.refreshReferences()
  }, [session, records.describe, records.all, records.status])

  // Leaving a page (or the notebook) saves what is pending first; if that fails the
  // store keeps the draft and retries in the background.
  useEffect(() => {
    sessionRef.current?.setEditable(false)
    setNotice('')
    setCopyNote('')
    return () => {
      void store.flush(pageId)
    }
  }, [pageId, store])

  // Show the page: its unsaved draft if it has one, else what the host sent.
  const focusTitle = (location.state as { focusTitle?: boolean } | null)?.focusTitle === true
  useEffect(() => {
    if (!page || !session) return
    const unsaved = store.unsaved(page.id)
    if (!unsaved) store.adopt(caseId, page)
    session.setContent(unsaved ? unsaved.content : page.content)
    shownRef.current = page.id
    setTitle(page.title)
    setTitleIssue(null)
    focusTitlePending.current = focusTitle
  }, [page, session, store, caseId, focusTitle])

  // A new page opens with its title selected, ready to be typed over (after the field shows it).
  useEffect(() => {
    if (!focusTitlePending.current || !page || title !== page.title) return
    focusTitlePending.current = false
    titleRef.current?.focus()
    titleRef.current?.select()
  }, [title, page])

  useEffect(() => {
    if (!session) return
    session.setEditable(editable)
  }, [session, editable, page])

  async function commitTitle() {
    if (!page || lockedReason !== null) return
    const check = checkNotebookTitle(title, PAGE_TITLE_MAX)
    if (check.title === null) {
      setTitleIssue(titleMessages[check.issues[0]?.code ?? 'required'] ?? titleMessages['required']!)
      return
    }
    setTitleIssue(null)
    if (check.title === page.title) {
      setTitle(check.title)
      return
    }
    let result
    try {
      result = await api.renameNotebookPage(caseId, page.id, { title: check.title })
    } catch {
      onFailure('failed')
      return
    }
    if (result.ok) {
      setTitle(result.page.title)
      onRenamed()
    } else {
      onFailure(result.reason)
      setTitle(page.title)
    }
  }

  function onTitleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault()
      void commitTitle()
      sessionRef.current?.focus()
    } else if (event.key === 'Escape' && page) {
      setTitle(page.title)
      setTitleIssue(null)
    }
  }

  const run = (command: EditorCommand): void => {
    sessionRef.current?.run(command)
  }

  async function copyDraft() {
    const content = draft?.content ?? sessionRef.current?.getContent() ?? emptyNoteContent()
    try {
      await navigator.clipboard.writeText(noteContentToPlainText(content, records.describe))
      setCopyNote('Your text was copied to the clipboard.')
    } catch {
      setCopyNote('Couldn’t copy automatically. Select the text on the page and copy it yourself.')
    }
  }

  /** The editor shows exactly this page's saved text again. */
  function showSaved(saved: NotebookPage) {
    store.replaceWithSaved(caseId, saved)
    sessionRef.current?.setContent(saved.content)
  }

  function useSavedVersion() {
    const saved = store.acceptSaved(pageId)
    if (saved) sessionRef.current?.setContent(saved.content)
    setCopyNote('')
  }

  function insertReference(target: RecordRef): boolean {
    return sessionRef.current?.run({ type: 'insertReference', target }) ?? false
  }

  function chooseRecord(entry: CaseRecord) {
    setDialog(null)
    if (insertReference({ kind: entry.kind, id: entry.record.id })) setNotice('Link added to the page.')
  }

  async function createTask(input: CaseTaskInput): Promise<CreateResult> {
    let result
    try {
      result = await api.createCaseTask(caseId, input)
    } catch {
      return { ok: false, message: 'Couldn’t reach the app. Nothing was created; your text is still here, so please try again.' }
    }
    if (!result.ok) return { ok: false, message: failureText(result.reason, 'task') }
    records.add({ kind: 'task', record: result.task })
    void records.reload()
    setDialog(null)
    const linked = insertReference({ kind: 'task', id: result.task.id })
    setNotice(`Task “${result.task.title}” created${linked ? ' and linked here' : ''}. Find it under Next steps on the case.`)
    return { ok: true }
  }

  async function createJournal(input: JournalEntryInput): Promise<CreateResult> {
    let result
    try {
      result = await api.createJournalEntry(caseId, input)
    } catch {
      return { ok: false, message: 'Couldn’t reach the app. Nothing was added; your text is still here, so please try again.' }
    }
    if (!result.ok) return { ok: false, message: failureText(result.reason, 'journal entry') }
    records.add({ kind: 'journal', record: result.entry })
    void records.reload()
    setDialog(null)
    const linked = insertReference({ kind: 'journal', id: result.entry.id })
    setNotice(`Journal entry added${linked ? ' and linked here' : ''}. Find it in the Research journal on the case.`)
    return { ok: true }
  }

  const unsaved = draft?.dirty === true
  const historyBlocked = lockedReason ?? (unsaved ? unsavedForHistory : gone ? 'This page can’t be changed any more.' : null)

  if (missing) {
    return (
      <div className="note-page">
        <p className="muted">This page couldn’t be found any more. Choose another page from the list.</p>
      </div>
    )
  }
  if (loaded.status === 'error' && !page) {
    return (
      <div className="note-page">
        <div className="alert alert-error" role="alert">
          <p className="alert-title">The page couldn’t be loaded</p>
          <div>
            <button type="button" className="button button-secondary" onClick={loaded.retry}>
              Try again
            </button>
          </div>
        </div>
      </div>
    )
  }

  /** Back to the writing surface, with the selection it had. */
  const backToEditor = () => sessionRef.current?.focus()

  /** Opens a dialog, remembering the selection it was opened for. */
  function open(next: Exclude<Dialog, null>): void {
    setPickedText(lastSelection.current)
    setDialog(next)
  }

  function submitLink(href: string): boolean {
    const ok = sessionRef.current?.run({ type: 'setLink', href }) ?? false
    if (ok) setDialog(null)
    return ok
  }

  const status = draft?.status
  const bridge = lockedReason === null && !gone

  return (
    <div className="note-page" aria-busy={page === undefined}>
      {lockedReason && <p className="archived-banner note-locked">{lockedReason}</p>}
      <form className="note-title-row" onSubmit={(event: FormEvent) => event.preventDefault()}>
        <label htmlFor="note-page-title" className="visually-hidden">
          Page title
        </label>
        <input
          id="note-page-title"
          ref={titleRef}
          type="text"
          className="note-title-input"
          value={title}
          readOnly={lockedReason !== null}
          placeholder={page ? 'Untitled page' : 'Loading…'}
          maxLength={PAGE_TITLE_MAX + 20}
          aria-invalid={titleIssue ? true : undefined}
          aria-describedby={titleIssue ? 'note-title-issue' : undefined}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => void commitTitle()}
          onKeyDown={onTitleKeyDown}
        />
        <button type="button" className="button button-secondary button-small" disabled={page === undefined} onClick={() => open('history')}>
          History
        </button>
        {titleIssue && (
          <p id="note-title-issue" className="issue-error">
            {titleIssue}
          </p>
        )}
      </form>

      {conflict && (
        <div className="alert alert-warning note-conflict" role="alert" aria-labelledby="note-conflict-title">
          <p id="note-conflict-title" className="alert-title">
            This page was changed in another window.
          </p>
          <p>
            It was saved somewhere else (another tab or device) after you opened it. Your text below has <strong>not</strong> been saved, and nothing has been overwritten. Choose what to do:
          </p>
          <div className="button-row">
            <button type="button" className="button button-primary" onClick={() => void store.keepMine(pageId)}>
              Keep my version
            </button>
            <button type="button" className="button button-secondary" onClick={useSavedVersion}>
              Use the saved version
            </button>
            <button type="button" className="button button-secondary" onClick={() => void copyDraft()}>
              Copy my text
            </button>
          </div>
          <p className="muted note-conflict-hint">“Keep my version” saves your text and keeps the other version in the page history. “Use the saved version” drops your unsaved text.</p>
          <p role="status" className="muted">
            {copyNote}
          </p>
        </div>
      )}

      {lockedReason === null && (
        <EditorToolbar
          state={editorState}
          disabled={page === undefined || !editable}
          onCommand={run}
          onLink={() => open('link')}
          bridge={bridge ? { onLinkRecord: () => open('record'), onCreateTask: () => open('task'), onCreateJournal: () => open('journal') } : undefined}
        />
      )}

      <div className="note-sheet">
        <div ref={hostRef} className="note-surface" />
        {page === undefined && (
          <p className="note-loading muted" role="status">
            Loading page…
          </p>
        )}
      </div>

      <div className="note-status-row">
        <p className="note-save-status" role="status" aria-live="polite">
          {statusText(draft)}
        </p>
        {status === 'retrying' && (
          <button type="button" className="button button-secondary button-small" onClick={() => void store.retryNow(pageId)}>
            Retry now
          </button>
        )}
        {status === 'invalid' && (
          <button type="button" className="button button-secondary button-small" onClick={() => void store.retryNow(pageId)}>
            Try saving again
          </button>
        )}
        {(status === 'retrying' || status === 'invalid' || status === 'locked') && (
          <button type="button" className="button button-secondary button-small" onClick={() => void copyDraft()}>
            Copy my text
          </button>
        )}
        {status === 'retrying' && <span className="muted note-status-hint">Your text is still here. It keeps trying to save by itself.</span>}
        {status === 'locked' && <span className="muted note-status-hint">Your text is still here, but this page can’t be changed any more (it or its case may be archived).</span>}
        {status !== 'conflict' && copyNote && (
          <span className="muted note-status-hint" role="status">
            {copyNote}
          </span>
        )}
      </div>
      <div role="status" className="flash-region">
        {notice && <p className="flash">{notice}</p>}
      </div>

      {dialog === 'link' && (
        <LinkDialog
          selectedText={pickedText}
          onApply={submitLink}
          onRemove={() => {
            sessionRef.current?.run({ type: 'setLink', href: null })
            setDialog(null)
          }}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog === 'record' && <LinkRecordDialog records={records} onChoose={chooseRecord} onCancel={() => setDialog(null)} returnFocus={backToEditor} />}
      {dialog === 'task' && <CreateTaskDialog selectedText={pickedText} onCreate={createTask} onCancel={() => setDialog(null)} returnFocus={backToEditor} />}
      {dialog === 'journal' && <CreateJournalDialog selectedText={pickedText} onCreate={createJournal} onCancel={() => setDialog(null)} returnFocus={backToEditor} />}
      {dialog === 'history' && page && (
        <HistoryDialog
          caseId={caseId}
          pageId={pageId}
          currentVersion={draft?.baseVersion ?? page.version}
          blockedReason={historyBlocked}
          describe={records.describe}
          onRestored={(restored) => {
            showSaved(restored)
            setNotice('Version restored.')
          }}
          onConflict={showSaved}
          onClose={() => setDialog(null)}
          returnFocus={backToEditor}
        />
      )}
    </div>
  )
}

function failureText(reason: 'invalid' | 'not-found' | 'wrong-status', what: string): string {
  if (reason === 'wrong-status') return `This case or its client is archived, so the ${what} wasn’t created.`
  if (reason === 'not-found') return `This case couldn’t be found any more, so the ${what} wasn’t created.`
  return `The ${what} has something that can’t be saved. Check the fields and try again.`
}
