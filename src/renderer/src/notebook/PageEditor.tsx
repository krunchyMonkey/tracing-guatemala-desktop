import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { useLocation } from 'react-router'
import { checkNotebookTitle, PAGE_TITLE_MAX } from '../../../shared/notebook'
import { emptyNoteContent } from '../../../shared/note-content'
import { newBlockId } from './newBlockId'
import { useCaseApi } from '../cases/useCaseApi'
import { useLoad } from '../cases/useLoad'
import { EditorToolbar } from './EditorToolbar'
import { LinkDialog } from './LinkDialog'
import { useNotebookAdapters } from './NotebookAdapters'
import type { EditorCommand, EditorState, RichTextEditorSession } from './ports'
import type { PageDrafts } from './usePageDrafts'

// One page: its title, the formatting toolbar, the writing surface and the save status.
// The editor is created once and shows each page through setContent, so switching pages
// keeps the toolbar, focus order and the library's own state in one place. Unsaved text
// lives in `drafts` (kept by the notebook screen), never only in the editor.

const PLACEHOLDER = 'Start writing… Use the toolbar or type # for a heading'
const IDLE_STATE: EditorState = { canUndo: false, canRedo: false, activeMarks: [], activeBlock: null, selectedText: '', focused: false }

const titleMessages: Record<string, string> = {
  required: 'Give the page a title.',
  'too-long': `Keep the title under ${PAGE_TITLE_MAX} characters.`,
  'invalid-characters': 'The title has a character that can’t be saved. Remove it and try again.'
}

interface PageEditorProps {
  caseId: string
  pageId: string
  /** Why nothing here can be changed (archived case, client, section or page); null when editable. */
  lockedReason: string | null
  drafts: PageDrafts
  /** Renames go through the host; the screen refreshes the outline afterwards. */
  onRenamed(): void
  onFailure(reason: string): void
}

export function PageEditor({ caseId, pageId, lockedReason, drafts, onRenamed, onFailure }: PageEditorProps) {
  const api = useCaseApi()
  const { editor } = useNotebookAdapters()
  const location = useLocation()
  const [reloads, setReloads] = useState(0)
  const loaded = useLoad(() => api.getNotebookPage(caseId, pageId), `${caseId}:${pageId}:${reloads}`)
  const page = loaded.data && loaded.data.id === pageId ? loaded.data : undefined
  const missing = loaded.status === 'ready' && loaded.data === null
  const editable = page !== undefined && lockedReason === null

  const hostRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const sessionRef = useRef<RichTextEditorSession | null>(null)
  /** The page whose content the editor holds; edits belong to it. */
  const shownRef = useRef<string | null>(null)
  const focusTitlePending = useRef(false)
  const [session, setSession] = useState<RichTextEditorSession | null>(null)
  const [editorState, setEditorState] = useState<EditorState>(IDLE_STATE)
  const [title, setTitle] = useState('')
  const [titleIssue, setTitleIssue] = useState<string | null>(null)
  const [linking, setLinking] = useState(false)

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
        if (shownRef.current) drafts.edit(shownRef.current, content)
      },
      onStateChange: setEditorState
    })
    sessionRef.current = created
    setSession(created)
    return () => {
      created.destroy()
      sessionRef.current = null
      setSession(null)
    }
  }, [editor, drafts])

  // Leaving a page (or the notebook) saves what is pending first.
  useEffect(() => {
    sessionRef.current?.setEditable(false)
    return () => {
      void drafts.flush(pageId)
    }
  }, [pageId, drafts])

  // Show the page: its unsaved draft if it has one, else what the host sent.
  const focusTitle = (location.state as { focusTitle?: boolean } | null)?.focusTitle === true
  useEffect(() => {
    if (!page || !session) return
    const draft = drafts.unsavedDraft(page.id)
    if (!draft) drafts.adopt(page)
    session.setContent(draft ? draft.content : page.content)
    shownRef.current = page.id
    setTitle(page.title)
    setTitleIssue(null)
    focusTitlePending.current = focusTitle
  }, [page, session, drafts, focusTitle])

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
    if (!page || !editable) return
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

  const status = drafts.statusOf(pageId)
  const statusText = status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved' : status === 'failed' ? 'Not saved' : status === 'conflict' ? 'This page changed elsewhere' : ''

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

  function submitLink(href: string): boolean {
    const ok = sessionRef.current?.run({ type: 'setLink', href }) ?? false
    if (ok) setLinking(false)
    return ok
  }

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
          readOnly={!editable}
          placeholder={page ? 'Untitled page' : 'Loading…'}
          maxLength={PAGE_TITLE_MAX + 20}
          aria-invalid={titleIssue ? true : undefined}
          aria-describedby={titleIssue ? 'note-title-issue' : undefined}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => void commitTitle()}
          onKeyDown={onTitleKeyDown}
        />
        {titleIssue && (
          <p id="note-title-issue" className="issue-error">
            {titleIssue}
          </p>
        )}
      </form>

      {lockedReason === null && <EditorToolbar state={editorState} disabled={page === undefined} onCommand={run} onLink={() => setLinking(true)} />}

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
          {statusText}
        </p>
        {status === 'failed' && (
          <button type="button" className="button button-secondary button-small" onClick={() => void drafts.flush(pageId)}>
            Retry
          </button>
        )}
        {status === 'conflict' && (
          <button
            type="button"
            className="button button-secondary button-small"
            onClick={() => {
              drafts.discard(pageId)
              setReloads((n) => n + 1)
            }}
          >
            Reload page
          </button>
        )}
        {status === 'failed' && <span className="muted note-status-hint">Your text is still here. It saves again when you retry.</span>}
        {status === 'conflict' && <span className="muted note-status-hint">Reloading shows the saved version and drops your unsaved changes.</span>}
      </div>

      {linking && (
        <LinkDialog
          selectedText={editorState.selectedText}
          onApply={submitLink}
          onRemove={() => {
            sessionRef.current?.run({ type: 'setLink', href: null })
            setLinking(false)
          }}
          onCancel={() => setLinking(false)}
        />
      )}
    </div>
  )
}
