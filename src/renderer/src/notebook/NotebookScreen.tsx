import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router'
import type { NotebookFailure } from '../../../shared/notebook'
import { useClientStore } from '../clients/ClientStore'
import { Alert, ConfirmDialog } from '../clients/components'
import { CaseNotFound, CasesLoadError } from '../cases/components'
import { isCaseId } from '../cases/model'
import { useCaseApi } from '../cases/useCaseApi'
import { useLoad } from '../cases/useLoad'
import { NotebookNav, type NavActions } from './NotebookNav'
import { PageEditor } from './PageEditor'
import {
  activePages,
  activeSections,
  findPage,
  FIRST_PAGE_TITLE,
  FIRST_SECTION_TITLE,
  firstOpenPage,
  NEW_PAGE_TITLE,
  orderedOutline,
  stepIndex,
  type OutlineSection
} from './notebookModel'
import { usePageDrafts } from './usePageDrafts'

// The research notebook of one case (#148): a list of sections and pages beside the
// page being written. Everything it shows comes from the NotebookApi and the editor
// port, so it runs in the Live app and the browser demo alike.

const failureMessages: Record<string, string> = {
  failed: 'The change couldn’t be saved. Nothing was lost; please try again.',
  'not-found': 'That page or section couldn’t be found any more. The list now shows what is saved.',
  'wrong-status': 'This case or its client is archived, or that item is archived, so it can’t be changed. The list now shows what is saved.',
  invalid: 'That name can’t be used. Use 1 to 80 characters for a section and up to 120 for a page.',
  'too-many': 'There are too many of those here already. Archive some first.'
}

type Pending = { kind: 'section'; id: string; title: string } | { kind: 'page'; id: string; title: string }

export function NotebookScreen() {
  const { caseId, pageId } = useParams()
  if (!isCaseId(caseId)) return <CaseNotFound />
  return <Notebook key={caseId} caseId={caseId} pageId={pageId} />
}

function Notebook({ caseId, pageId }: { caseId: string; pageId: string | undefined }) {
  const api = useCaseApi()
  const store = useClientStore()
  const navigate = useNavigate()
  const loadedCase = useLoad(() => api.getCase(caseId), caseId)
  const [outlineVersion, setOutlineVersion] = useState(0)
  const outlineLoad = useLoad(() => api.getNotebook(caseId), `${caseId}:${outlineVersion}`)
  const drafts = usePageDrafts(caseId, api)
  const [failure, setFailure] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [pending, setPending] = useState<Pending | null>(null)
  const [navOpen, setNavOpen] = useState(false)
  const [working, setWorking] = useState(false)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const { refreshClient } = store
  const researchCase = loadedCase.data
  const clientId = researchCase?.clientId

  useEffect(() => {
    if (clientId !== undefined) void refreshClient(clientId)
  }, [clientId, refreshClient])

  // Leaving the browser tab with unsaved text asks first.
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (drafts.hasUnsaved()) event.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [drafts])

  const refresh = () => setOutlineVersion((n) => n + 1)

  /** Runs a host call; on success refreshes the list, on refusal explains and refreshes too. */
  async function mutate<R extends { ok: true } | NotebookFailure>(call: () => Promise<R>, done: string): Promise<Extract<R, { ok: true }> | null> {
    setWorking(true)
    setFailure(null)
    setMessage('')
    let result: R
    try {
      result = await call()
    } catch {
      setFailure('failed')
      setWorking(false)
      return null
    }
    setWorking(false)
    refresh()
    if (result.ok) {
      setMessage(done)
      return result as Extract<R, { ok: true }>
    }
    const refusal = result as NotebookFailure
    setFailure(refusal.reason === 'invalid' && refusal.issues.some((i) => i.field === 'limit') ? 'too-many' : refusal.reason)
    return null
  }

  if (loadedCase.status === 'error' && !researchCase) {
    return (
      <section aria-labelledby="notebook-error-heading">
        <h1 id="notebook-error-heading">Research notebook</h1>
        <CasesLoadError onRetry={loadedCase.retry} what="This case" />
      </section>
    )
  }
  if (researchCase === undefined || (outlineLoad.data === undefined && outlineLoad.status !== 'error')) {
    return (
      <p role="status" className="muted">
        Loading notebook…
      </p>
    )
  }
  if (researchCase === null) return <CaseNotFound />
  if (outlineLoad.data === undefined) {
    return (
      <section aria-labelledby="notebook-error-heading">
        <h1 id="notebook-error-heading">Research notebook</h1>
        <CasesLoadError onRetry={outlineLoad.retry} what="The notebook" />
      </section>
    )
  }
  if (outlineLoad.data === null) return <CaseNotFound />

  const client = store.clients.find((c) => c.id === researchCase.clientId)
  const caseArchived = researchCase.archivedAt !== null
  const clientArchived = client?.status !== 'active'
  const readOnly = caseArchived || clientArchived
  const sections = orderedOutline(outlineLoad.data)
  const found = pageId ? findPage(sections, pageId) : null
  const readOnlyReason = caseArchived
    ? 'This case is archived, so its notebook is read-only. You can still read every page.'
    : 'This client is archived, so the notebook is read-only. You can still read every page.'

  const pageLockedReason = readOnly
    ? readOnlyReason
    : found?.page.archivedAt
      ? 'This page is archived, so it is read-only. Restore it from the Archived list to edit it.'
      : found?.section.archivedAt
        ? 'This section is archived, so its pages are read-only. Restore the section to edit them.'
        : null

  async function startNotebook() {
    const section = await mutate(() => api.createNotebookSection(caseId, { title: FIRST_SECTION_TITLE }), 'Notebook started.')
    if (!section) return
    const page = await mutate(() => api.createNotebookPage(caseId, section.section.id, { title: FIRST_PAGE_TITLE }), 'Notebook started.')
    if (page) navigate(`/cases/${caseId}/notebook/${page.page.id}`, { state: { focusTitle: false } })
  }

  async function addPage(sectionId: string) {
    const created = await mutate(() => api.createNotebookPage(caseId, sectionId, { title: NEW_PAGE_TITLE }), 'Page added.')
    if (created) {
      setNavOpen(false)
      navigate(`/cases/${caseId}/notebook/${created.page.id}`, { state: { focusTitle: true } })
    }
  }

  const sectionOf = (id: string): OutlineSection | undefined => sections.find((s) => s.id === id)

  const actions: NavActions = {
    async createSection(title) {
      await mutate(() => api.createNotebookSection(caseId, { title }), 'Section added.')
    },
    async renameSection(id, title) {
      await mutate(() => api.renameNotebookSection(caseId, id, { title }), 'Section renamed.')
    },
    async moveSection(id, direction) {
      const toIndex = stepIndex(sections, id, direction)
      if (toIndex !== null) await mutate(() => api.moveNotebookSection(caseId, id, toIndex), 'Section moved.')
    },
    archiveSection: (id) => setPending({ kind: 'section', id, title: sectionOf(id)?.title ?? '' }),
    async unarchiveSection(id) {
      await mutate(() => api.unarchiveNotebookSection(caseId, id), 'Section restored.')
    },
    createPage: (sectionId) => void addPage(sectionId),
    async renamePage(id, title) {
      await mutate(() => api.renameNotebookPage(caseId, id, { title }), 'Page renamed.')
    },
    async movePage(id, direction) {
      const where = findPage(sections, id)
      const toIndex = where ? stepIndex(where.section.pages, id, direction) : null
      if (where && toIndex !== null) await mutate(() => api.moveNotebookPage(caseId, id, { sectionId: where.section.id, toIndex }), 'Page moved.')
    },
    async movePageToSection(id, sectionId) {
      const target = sectionOf(sectionId)
      if (target) await mutate(() => api.moveNotebookPage(caseId, id, { sectionId, toIndex: target.pages.length }), `Page moved to ${target.title}.`)
    },
    archivePage: (id) => setPending({ kind: 'page', id, title: findPage(sections, id)?.page.title ?? '' }),
    async unarchivePage(id) {
      await mutate(() => api.unarchiveNotebookPage(caseId, id), 'Page restored.')
    }
  }

  async function confirmArchive(action: Pending) {
    setPending(null)
    const result =
      action.kind === 'section'
        ? await mutate(() => api.archiveNotebookSection(caseId, action.id), 'Section archived.')
        : await mutate(() => api.archiveNotebookPage(caseId, action.id), 'Page archived.')
    // The open page may just have been archived: go to another one.
    if (result && pageId) {
      const stillOpen = action.kind === 'page' ? action.id === pageId : findPage(sections, pageId)?.section.id === action.id
      if (stillOpen) navigate(`/cases/${caseId}/notebook`, { replace: true })
    }
  }

  // Opening the notebook shows its first page; an empty section offers to add one.
  const firstPage = firstOpenPage(sections)
  if (!pageId && firstPage) return <Navigate to={`/cases/${caseId}/notebook/${firstPage.id}`} replace />

  const noSections = sections.length === 0
  const emptySection = activeSections(sections).find((s) => activePages(s).length === 0)

  return (
    <section aria-labelledby="notebook-heading" className="notebook">
      <p className="breadcrumb">
        <Link to={`/cases/${caseId}`}>← {researchCase.title}</Link>
      </p>
      <header className="notebook-header">
        <h1 id="notebook-heading" ref={headingRef} tabIndex={-1}>
          Research notebook
        </h1>
        {!noSections && (
          <button type="button" className="button button-secondary note-nav-toggle" aria-expanded={navOpen} aria-controls="notebook-nav" onClick={() => setNavOpen((open) => !open)}>
            Pages
          </button>
        )}
      </header>

      <div role="status" className="flash-region" aria-live="polite">
        {message && <p className="flash">{message}</p>}
      </div>
      {failure && (
        <Alert tone="error" title="That didn’t work">
          {failureMessages[failure] ?? failureMessages['failed']}
        </Alert>
      )}

      {noSections ? (
        <StartNotebook readOnly={readOnly} readOnlyReason={readOnlyReason} working={working} onStart={() => void startNotebook()} />
      ) : (
        <div className={`notebook-layout${navOpen ? ' nav-open' : ''}`}>
          <NotebookNav
            id="notebook-nav"
            caseId={caseId}
            sections={sections}
            currentPageId={pageId}
            readOnly={readOnly}
            actions={actions}
            onNavigate={() => setNavOpen(false)}
          />
          <div className="notebook-main">
            {pageId ? (
              <PageEditor
                caseId={caseId}
                pageId={pageId}
                lockedReason={pageLockedReason}
                drafts={drafts}
                onRenamed={refresh}
                onFailure={(reason) => {
                  setFailure(reason)
                  refresh()
                }}
              />
            ) : (
              <div className="note-page note-empty">
                <h2>{emptySection ? emptySection.title : 'No pages yet'}</h2>
                <p className="muted">This notebook has no pages to open yet.</p>
                {!readOnly && emptySection && (
                  <button type="button" className="button button-primary" disabled={working} onClick={() => void addPage(emptySection.id)}>
                    Add a page
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {pending && (
        <ConfirmDialog
          title={pending.kind === 'section' ? 'Archive this section?' : 'Archive this page?'}
          confirmLabel={pending.kind === 'section' ? 'Archive section' : 'Archive page'}
          onCancel={() => setPending(null)}
          onConfirm={() => void confirmArchive(pending)}
        >
          <p>
            “{pending.title}” {pending.kind === 'section' ? 'and its pages are' : 'is'} hidden from the list and become read-only. <strong>Nothing is deleted:</strong> restore it any time from the Archived list.
          </p>
        </ConfirmDialog>
      )}
    </section>
  )
}

function StartNotebook({ readOnly, readOnlyReason, working, onStart }: { readOnly: boolean; readOnlyReason: string; working: boolean; onStart(): void }): ReactNode {
  return (
    <div className="card note-start">
      <h2>{readOnly ? 'No notebook was started' : 'Start your research notebook'}</h2>
      {readOnly ? (
        <p className="muted">{readOnlyReason}</p>
      ) : (
        <>
          <p>
            A calm place for this case’s working notes: sections and pages you can write on, format, and reorder. Starting creates a section called “{FIRST_SECTION_TITLE}” with a page called “{FIRST_PAGE_TITLE}”; you can rename or move them any time.
          </p>
          <button type="button" className="button button-primary" disabled={working} onClick={onStart}>
            Start your research notebook
          </button>
        </>
      )}
    </div>
  )
}
