import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation, useParams } from 'react-router'
import { useClientStore } from '../clients/ClientStore'
import { Alert, ConfirmDialog, formatDate, formatDateTime } from '../clients/components'
import { BriefCard } from '../cases/BriefCard'
import { ExportSummaryDialog } from '../cases/ExportSummaryDialog'
import { JournalCard } from '../cases/JournalCard'
import { NotebookCard } from '../notebook/NotebookCard'
import { HoursCard } from '../cases/HoursCard'
import { TasksCard } from '../cases/TasksCard'
import { ArchivedBadge, CaseNotFound, CasesLoadError, DueDate, StateBadge } from '../cases/components'
import {
  CASE_TRANSITIONS,
  eventSentence,
  isCaseId,
  needsConfirmation,
  stateHelp,
  stateLabels,
  transitionLabel,
  type CaseMutationResult,
  type CaseState,
  type ResearchCase
} from '../cases/model'
import { useCaseApi } from '../cases/useCaseApi'
import { useLoad } from '../cases/useLoad'
import { guideAnchor } from '../guidance/anchors'

// Case overview (#16): the case's details, its state controls, next steps (#19), research brief
// (#17), research journal (#18), history, and archive. Archived cases and cases of archived clients are read-only.

type Pending = { kind: 'state'; to: CaseState } | { kind: 'archive' } | { kind: 'unarchive' }

const failureMessages: Record<string, string> = {
  failed: 'The change couldn’t be saved. Nothing was lost; please try again.',
  'not-found': 'This case couldn’t be found any more.',
  'wrong-status': 'This case or its client is archived, so it can’t be changed. The page now shows its current state.',
  'client-archived': 'This client is archived, so the case can’t be changed.',
  'invalid-transition': 'That change isn’t available from the case’s current state. The page now shows the current state.',
  invalid: 'The case has details that can’t be saved. Edit the case and try again.'
}

export function CaseScreen() {
  const { caseId } = useParams()
  const valid = isCaseId(caseId)
  if (!valid) return <CaseNotFound />
  return <CaseOverview key={caseId} caseId={caseId} />
}

function CaseOverview({ caseId }: { caseId: string }) {
  const api = useCaseApi()
  const store = useClientStore()
  const location = useLocation()
  const flash = (location.state as { flash?: string } | null)?.flash
  const loaded = useLoad(() => api.getCase(caseId), caseId)
  const [current, setCurrent] = useState<ResearchCase | null | undefined>(undefined)
  const [version, setVersion] = useState(0)
  const [pending, setPending] = useState<Pending | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const [exporting, setExporting] = useState(false)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const { refreshClient } = store

  // The loaded copy is the starting point; saved results replace it.
  useEffect(() => {
    if (loaded.data !== undefined) setCurrent(loaded.data)
  }, [loaded.data])

  const clientId = current?.clientId
  useEffect(() => {
    if (clientId !== undefined) void refreshClient(clientId)
  }, [clientId, refreshClient])

  if (loaded.status === 'error' && current === undefined) {
    return (
      <section aria-labelledby="case-error-heading">
        <h1 id="case-error-heading">Case</h1>
        <CasesLoadError onRetry={loaded.retry} what="This case" />
      </section>
    )
  }
  if (current === undefined) {
    return (
      <p role="status" className="muted">
        Loading case…
      </p>
    )
  }
  if (current === null) return <CaseNotFound />

  const researchCase = current
  const client = store.clients.find((c) => c.id === researchCase.clientId)
  const caseArchived = researchCase.archivedAt !== null
  const clientArchived = client?.status !== 'active'
  const readOnly = caseArchived || clientArchived

  async function run(action: Pending) {
    setPending(null)
    setWorking(true)
    setFailure(null)
    setMessage(null)
    let result: CaseMutationResult
    try {
      result =
        action.kind === 'state'
          ? await api.setCaseState(researchCase.id, action.to)
          : action.kind === 'archive'
            ? await api.archiveCase(researchCase.id)
            : await api.unarchiveCase(researchCase.id)
    } catch {
      setFailure('failed')
      setWorking(false)
      requestAnimationFrame(() => headingRef.current?.focus())
      return
    }
    setWorking(false)
    if (result.ok) {
      setCurrent(result.case)
      setVersion((n) => n + 1)
      setMessage(
        action.kind === 'state'
          ? `Case is now ${stateLabels[action.to].toLowerCase()}.`
          : action.kind === 'archive'
            ? 'Case archived.'
            : 'Case unarchived.'
      )
    } else {
      setFailure(result.reason)
      if (result.reason === 'not-found') setCurrent(null)
      else void api.getCase(researchCase.id).then((fresh) => fresh && setCurrent(fresh), () => undefined)
      void refreshClient(researchCase.clientId)
    }
    // The button that opened the dialog may be gone now, so focus a stable place.
    requestAnimationFrame(() => headingRef.current?.focus())
  }

  const choose = (to: CaseState) => {
    if (needsConfirmation(researchCase.state, to)) setPending({ kind: 'state', to })
    else void run({ kind: 'state', to })
  }

  const flashText = message ?? flash

  return (
    <section aria-labelledby="case-heading" className="profile case-overview">
      <p className="breadcrumb">
        <Link to="/cases">← Cases</Link>
      </p>

      <div role="status" className="flash-region">
        {flashText && <p className="flash">{flashText}</p>}
      </div>
      {failure && (
        <Alert tone="error" title="That didn’t work">
          {failureMessages[failure] ?? failureMessages['failed']}
        </Alert>
      )}

      {caseArchived && researchCase.archivedAt && (
        <div className="archived-banner">
          <p>
            <strong>Archived on {formatDate(researchCase.archivedAt)}.</strong> This case is read-only
            {clientArchived ? '' : '. Unarchive it to make changes or change its state'}.
          </p>
        </div>
      )}
      {clientArchived && (
        <div className="archived-banner">
          <p>
            <strong>{client ? `${client.displayName} is archived.` : 'This client is archived.'}</strong> Their cases are
            read-only until the client is restored.{' '}
            {client && <Link to={`/clients/${client.id}`}>Open the client</Link>}
          </p>
        </div>
      )}

      <header className="case-header" {...guideAnchor('case-header')}>
        <div className="profile-title">
          <h1 id="case-heading" ref={headingRef} tabIndex={-1}>
            {researchCase.title}
          </h1>
          <p className="profile-meta">
            <StateBadge state={researchCase.state} />
            {caseArchived && <ArchivedBadge />}
            <span>
              for{' '}
              {client ? <Link to={`/clients/${client.id}`}>{client.displayName}</Link> : <span className="muted">an unknown client</span>}
            </span>
          </p>
        </div>
        <div className="profile-actions">
          {!readOnly && (
            <Link className="button button-primary" to={`/cases/${researchCase.id}/edit`}>
              Edit details
            </Link>
          )}
          <button type="button" className="button button-secondary" onClick={() => setExporting(true)}>
            Export summary…
          </button>
        </div>
      </header>

      <NotebookCard caseId={researchCase.id} readOnly={readOnly} />

      <div className="case-grid">
        <section className="card" aria-labelledby="case-details-heading">
          <h2 id="case-details-heading">Details</h2>
          <dl className="detail-list">
            <Row label="Requested outcome">
              {researchCase.goal ? <span className="preserve-lines">{researchCase.goal}</span> : <span className="muted">Not added</span>}
            </Row>
            <Row label="Order reference">
              {researchCase.orderReference ?? <span className="muted">Not added</span>}
            </Row>
            <Row label="Due date">
              <DueDate researchCase={researchCase} />
            </Row>
            <Row label="Created">{formatDateTime(researchCase.createdAt)}</Row>
            <Row label="Last updated">{formatDateTime(researchCase.updatedAt)}</Row>
            <Row label="State changed">{formatDateTime(researchCase.stateChangedAt)}</Row>
          </dl>
        </section>

        <section className="card" aria-labelledby="case-state-heading">
          <h2 id="case-state-heading">Progress</h2>
          <p className="state-now">
            <StateBadge state={researchCase.state} /> <span className="muted">{stateHelp[researchCase.state]}</span>
          </p>
          {readOnly ? (
            <p className="muted">
              {caseArchived
                ? 'This case is archived, so its state can’t be changed.'
                : 'This client is archived, so the case’s state can’t be changed.'}
            </p>
          ) : (
            <div role="group" aria-label="Change state" className="state-actions">
              {CASE_TRANSITIONS[researchCase.state].map((to) => (
                <button
                  key={to}
                  type="button"
                  className={`button ${to === 'active' && researchCase.state === 'intake' ? 'button-primary' : 'button-secondary'}`}
                  disabled={working}
                  onClick={() => choose(to)}
                >
                  {transitionLabel(researchCase.state, to)}
                </button>
              ))}
            </div>
          )}
          {!readOnly && (
            <p className="hint state-note">
              State changes are always your decision. Nothing is sent to anyone from here.
            </p>
          )}
          {!clientArchived && (
            <div className="archive-row">
              {caseArchived ? (
                <button type="button" className="button button-ghost" disabled={working} onClick={() => setPending({ kind: 'unarchive' })}>
                  Unarchive case
                </button>
              ) : (
                <button type="button" className="button button-ghost" disabled={working} onClick={() => setPending({ kind: 'archive' })}>
                  Archive case
                </button>
              )}
            </div>
          )}
        </section>
      </div>

      <TasksCard
        caseId={researchCase.id}
        readOnly={readOnly}
        readOnlyReason={
          caseArchived
            ? 'This case is archived, so its next steps can’t be changed. Existing steps stay visible.'
            : 'This client is archived, so the next steps can’t be changed. Existing steps stay visible.'
        }
      />

      <HoursCard
        caseId={researchCase.id}
        caseTitle={researchCase.title}
        readOnly={readOnly}
        readOnlyReason={
          caseArchived
            ? 'This case is archived, so its hours can’t be changed. Existing entries stay visible.'
            : 'This client is archived, so the hours can’t be changed. Existing entries stay visible.'
        }
      />

      <BriefCard
        researchCase={researchCase}
        readOnly={readOnly}
        readOnlyReason={
          caseArchived
            ? 'This case is archived, so its brief can’t be changed.'
            : 'This client is archived, so the brief can’t be changed.'
        }
      />

      <JournalCard
        caseId={researchCase.id}
        readOnly={readOnly}
        readOnlyReason={
          caseArchived
            ? 'This case is archived, so the journal can’t be changed. Existing entries stay visible.'
            : 'This client is archived, so the journal can’t be changed. Existing entries stay visible.'
        }
      />

      <History caseId={researchCase.id} version={version} />

      {exporting && (
        <ExportSummaryDialog
          caseId={researchCase.id}
          caseTitle={researchCase.title}
          onCancel={() => setExporting(false)}
          onExported={(text) => {
            setExporting(false)
            setFailure(null)
            setMessage(text)
          }}
        />
      )}

      {pending && (
        <ConfirmDialog
          title={confirmTitle(pending)}
          confirmLabel={confirmLabel(pending, researchCase.state)}
          tone={pending.kind === 'state' && pending.to === 'closed' ? 'caution' : 'default'}
          onCancel={() => setPending(null)}
          onConfirm={() => void run(pending)}
        >
          {confirmBody(pending, researchCase.state)}
        </ConfirmDialog>
      )}
    </section>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

function confirmTitle(pending: Pending): string {
  if (pending.kind === 'archive') return 'Archive this case?'
  if (pending.kind === 'unarchive') return 'Unarchive this case?'
  if (pending.to === 'delivered') return 'Mark this case as delivered?'
  if (pending.to === 'closed') return 'Close this case?'
  return 'Reopen this case?'
}

function confirmLabel(pending: Pending, from: CaseState): string {
  if (pending.kind === 'archive') return 'Archive case'
  if (pending.kind === 'unarchive') return 'Unarchive case'
  return transitionLabel(from, pending.to)
}

function confirmBody(pending: Pending, from: CaseState): ReactNode {
  if (pending.kind === 'archive') {
    return (
      <p>
        It’s hidden from your default case list and becomes read-only. <strong>Nothing is deleted:</strong> you can
        unarchive it at any time and it returns in the same state.
      </p>
    )
  }
  if (pending.kind === 'unarchive') return <p>The case returns to your case list in its current state, and can be edited again.</p>
  if (pending.to === 'delivered') {
    return (
      <p>
        Use this once you’ve sent a draft or the final result outside this app. Nothing is sent from here. You can
        reopen the case if revisions are requested.
      </p>
    )
  }
  if (pending.to === 'closed') {
    return (
      <p>
        Closing means no further work is expected. Its history is kept, and you can reopen it later.
      </p>
    )
  }
  return (
    <p>
      The case goes back to Active from {stateLabels[from]}, with its whole history kept. For a new
      objective or a new order, start a new case instead.
    </p>
  )
}

function History({ caseId, version }: { caseId: string; version: number }) {
  const api = useCaseApi()
  const events = useLoad(() => api.listCaseEvents(caseId), `${caseId}:${version}`)
  return (
    <section className="card history" aria-labelledby="case-history-heading">
      <h2 id="case-history-heading">History</h2>
      {events.status === 'error' && events.data === undefined ? (
        <CasesLoadError onRetry={events.retry} what="The history" />
      ) : events.data === undefined ? (
        <p className="muted empty-history" role="status">
          Loading history…
        </p>
      ) : events.data.length === 0 ? (
        <p className="muted empty-history">No history yet.</p>
      ) : (
        <ol className="timeline">
          {events.data.map((event) => (
            <li key={event.id} className={`timeline-item kind-case-${event.kind}`}>
              <p className="timeline-meta">
                <span className="kind-label">{eventSentence(event)}</span>
                <time dateTime={event.occurredAt}>{formatDateTime(event.occurredAt)}</time>
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
