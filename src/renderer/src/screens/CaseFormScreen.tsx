import { useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { useClientStore } from '../clients/ClientStore'
import { Alert, ConfirmDialog } from '../clients/components'
import { CaseNotFound, CasesLoadError } from '../cases/components'
import {
  CASE_GOAL_MAX,
  CASE_TITLE_MAX,
  ORDER_REFERENCE_MAX,
  checkCase,
  isCaseId,
  issueMessage,
  type CaseField,
  type CaseInput,
  type CaseIssue,
  type ResearchCase
} from '../cases/model'
import { useCaseApi } from '../cases/useCaseApi'
import { useLoad } from '../cases/useLoad'

// Create and edit a research case (#16). Fields and rules follow case-model/v1;
// the host re-checks every save. Nothing typed is lost when a save fails.

interface FormValues {
  title: string
  goal: string
  orderReference: string
  dueDate: string
}

const emptyValues: FormValues = { title: '', goal: '', orderReference: '', dueDate: '' }

const toValues = (c: ResearchCase): FormValues => ({
  title: c.title,
  goal: c.goal ?? '',
  orderReference: c.orderReference ?? '',
  dueDate: c.dueDate ?? ''
})

const toInput = (v: FormValues): CaseInput => ({
  title: v.title,
  goal: v.goal === '' ? null : v.goal,
  orderReference: v.orderReference === '' ? null : v.orderReference,
  dueDate: v.dueDate === '' ? null : v.dueDate
})

type SaveError = 'failed' | 'not-found' | 'client-archived' | 'wrong-status' | 'invalid-transition'

const saveErrorMessages: Record<SaveError, string> = {
  failed: 'Something went wrong while saving. Your changes are still here, so you can try again.',
  'not-found': 'This case or client couldn’t be found any more. Your changes are still here; copy anything you need.',
  'client-archived': 'This client is archived, so a new case can’t be started. Restore the client from their profile first.',
  'wrong-status': 'This case or its client was archived, so it can’t be changed. Restore it first; your changes are still here.',
  'invalid-transition': 'This case can’t be changed right now. Your changes are still here.'
}

export function CaseFormScreen() {
  const { caseId } = useParams()
  return caseId === undefined ? <NewCase /> : <EditCase caseId={caseId} />
}

function NewCase() {
  const { clients } = useClientStore()
  const [params, setParams] = useSearchParams()
  const clientId = params.get('client')
  const client = clients.find((c) => c.id === clientId)

  if (client?.status === 'active') return <CaseForm key={client.id} client={client} />

  if (client) {
    return (
      <section aria-labelledby="form-heading">
        <h1 id="form-heading">New case</h1>
        <Alert tone="info" title={`${client.displayName} is archived`}>
          A new case needs an active client. Restore the client from their profile first.
        </Alert>
        <Link className="button button-secondary" to={`/clients/${client.id}`}>
          Open {client.displayName}
        </Link>
      </section>
    )
  }

  const active = clients.filter((c) => c.status === 'active').sort((a, b) => a.displayName.localeCompare(b.displayName))
  return (
    <section aria-labelledby="form-heading" className="client-form-page">
      <p className="breadcrumb">
        <Link to="/cases">← Cases</Link>
      </p>
      <h1 id="form-heading">New case</h1>
      {clientId !== null && (
        <Alert tone="warning" title="That client wasn’t found">
          Choose one of your clients below.
        </Alert>
      )}
      <p className="lead">Every case belongs to one client. Who is it for?</p>
      {active.length === 0 ? (
        <Alert tone="info" title="No active clients yet">
          Add a client first, then start their case.
          <p>
            <Link to="/clients/new">Add a client</Link>
          </p>
        </Alert>
      ) : (
        <form
          className="client-form"
          onSubmit={(event) => {
            event.preventDefault()
            const chosen = new FormData(event.currentTarget).get('client')
            if (typeof chosen === 'string' && chosen !== '') setParams({ client: chosen })
          }}
        >
          <div className="field">
            <label htmlFor="case-client-picker">Client</label>
            <select id="case-client-picker" name="client" defaultValue="">
              <option value="" disabled>
                Choose a client…
              </option>
              {active.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.displayName}
                </option>
              ))}
            </select>
          </div>
          <div className="form-actions">
            <button type="submit" className="button button-primary">
              Continue
            </button>
          </div>
        </form>
      )}
    </section>
  )
}

function EditCase({ caseId }: { caseId: string }) {
  const api = useCaseApi()
  const { clients } = useClientStore()
  const valid = isCaseId(caseId)
  const loaded = useLoad(() => (valid ? api.getCase(caseId) : Promise.resolve(null)), caseId)

  if (!valid) return <CaseNotFound />
  if (loaded.status === 'error' && loaded.data === undefined) {
    return (
      <section aria-labelledby="form-heading">
        <h1 id="form-heading">Edit case</h1>
        <CasesLoadError onRetry={loaded.retry} what="This case" />
      </section>
    )
  }
  if (loaded.data === undefined) {
    return (
      <p role="status" className="muted">
        Loading case…
      </p>
    )
  }
  const researchCase = loaded.data
  if (researchCase === null) return <CaseNotFound />

  const client = clients.find((c) => c.id === researchCase.clientId)
  if (researchCase.archivedAt !== null || client?.status !== 'active') {
    return (
      <section aria-labelledby="form-heading">
        <h1 id="form-heading">Edit case</h1>
        <Alert tone="info" title={researchCase.archivedAt !== null ? 'This case is archived' : 'This client is archived'}>
          Archived cases, and cases of archived clients, are read-only.{' '}
          {researchCase.archivedAt !== null
            ? 'Unarchive the case to make changes.'
            : `Restore ${client?.displayName ?? 'the client'} to make changes.`}
        </Alert>
        <Link className="button button-secondary" to={`/cases/${researchCase.id}`}>
          Back to case
        </Link>
      </section>
    )
  }
  return <CaseForm key={researchCase.id} client={client} existing={researchCase} />
}

function CaseForm({ client, existing }: { client: { id: string; displayName: string }; existing?: ResearchCase }) {
  const api = useCaseApi()
  const navigate = useNavigate()
  const initial = existing ? toValues(existing) : emptyValues
  const [values, setValues] = useState(initial)
  const [submitted, setSubmitted] = useState(false)
  const [serverIssues, setServerIssues] = useState<CaseIssue[]>([])
  const [saveError, setSaveError] = useState<SaveError | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const summaryRef = useRef<HTMLDivElement>(null)

  const isEdit = existing !== undefined
  const dirty = (Object.keys(values) as (keyof FormValues)[]).some((key) => values[key] !== initial[key])
  const { issues, input } = checkCase(toInput(values))
  const shown = submitted ? [...issues, ...serverIssues] : []
  const messageFor = (field: CaseField) => shown.filter((i) => i.field === field).map(issueMessage)
  const exitTo = existing ? `/cases/${existing.id}` : `/clients/${client.id}`

  const set = (field: keyof FormValues, value: string) => {
    setValues((v) => ({ ...v, [field]: value }))
    setSaveError(null)
    setServerIssues([])
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (saving) return
    setSubmitted(true)
    setSaveError(null)
    setServerIssues([])
    if (!input) {
      requestAnimationFrame(() => summaryRef.current?.focus())
      return
    }
    setSaving(true)
    try {
      const result = existing ? await api.updateCase(existing.id, input) : await api.createCase(client.id, input)
      if (result.ok) {
        navigate(`/cases/${result.case.id}`, { state: { flash: isEdit ? 'Changes saved.' : 'Case created.' } })
      } else if (result.reason === 'invalid') {
        setServerIssues(result.issues)
        requestAnimationFrame(() => summaryRef.current?.focus())
      } else {
        setSaveError(result.reason)
      }
    } catch {
      setSaveError('failed')
    } finally {
      setSaving(false)
    }
  }

  function onCancel() {
    if (dirty) setConfirmDiscard(true)
    else navigate(exitTo)
  }

  return (
    <section aria-labelledby="form-heading" className="client-form-page">
      <p className="breadcrumb">
        <Link to={exitTo}>{isEdit ? '← Back to case' : `← ${client.displayName}`}</Link>
      </p>
      <h1 id="form-heading">{isEdit ? 'Edit case' : 'New case'}</h1>
      <p className="lead">
        For{' '}
        <Link to={`/clients/${client.id}`}>
          <strong>{client.displayName}</strong>
        </Link>
        . Only the title is required. The rest can be added later.
      </p>

      {shown.length > 0 && (
        <div ref={summaryRef} tabIndex={-1} className="alert alert-error" role="alert">
          <p className="alert-title">
            {shown.length === 1 ? 'One thing needs fixing' : `${shown.length} things need fixing`} before saving:
          </p>
          <ul>
            {shown.map((issue) => (
              <li key={`${issue.field}-${issue.code}`}>
                <a href={`#field-${issue.field}`} onClick={(e) => focusField(e, issue.field)}>
                  {issueMessage(issue)}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      {saveError && (
        <Alert tone="error" title="Couldn’t save this case">
          {saveErrorMessages[saveError]}
          {saveError === 'client-archived' && (
            <p>
              <Link to={`/clients/${client.id}`}>Open {client.displayName} to restore them</Link>
            </p>
          )}
        </Alert>
      )}

      <form noValidate onSubmit={(event) => void onSubmit(event)} className="client-form">
        <fieldset className="form-section">
          <legend>About this case</legend>

          <Field id="title" label="Title" hint="A label you will recognize in lists, such as “Paternal line — Totonicapán, 1880s”." issues={messageFor('title')}>
            {(describedBy, invalid) => (
              <input
                id="field-title"
                type="text"
                autoComplete="off"
                maxLength={CASE_TITLE_MAX + 20}
                value={values.title}
                aria-required="true"
                aria-describedby={describedBy}
                aria-invalid={invalid}
                onChange={(e) => set('title', e.target.value)}
              />
            )}
          </Field>

          <Field
            id="goal"
            label="Requested outcome"
            optional
            hint="What the client wants to find out, ideally in their own words."
            issues={messageFor('goal')}
          >
            {(describedBy, invalid) => (
              <textarea
                id="field-goal"
                rows={5}
                maxLength={CASE_GOAL_MAX + 200}
                value={values.goal}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                onChange={(e) => set('goal', e.target.value)}
              />
            )}
          </Field>

          <div className="field-grid">
            <Field
              id="orderReference"
              label="Order reference"
              optional
              hint="For example the Fiverr order number. Never paste passwords or payment details."
              issues={messageFor('orderReference')}
            >
              {(describedBy, invalid) => (
                <input
                  id="field-orderReference"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={ORDER_REFERENCE_MAX + 20}
                  value={values.orderReference}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  onChange={(e) => set('orderReference', e.target.value)}
                />
              )}
            </Field>

            <Field id="dueDate" label="Due date" optional hint="The order’s deadline, if it has one." issues={messageFor('dueDate')}>
              {(describedBy, invalid) => (
                <input
                  id="field-dueDate"
                  type="date"
                  value={values.dueDate}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  onChange={(e) => set('dueDate', e.target.value)}
                />
              )}
            </Field>
          </div>
        </fieldset>

        <div className="form-actions">
          <button type="submit" className="button button-primary" disabled={saving} aria-busy={saving}>
            {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create case'}
          </button>
          <button type="button" className="button button-secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>

      {confirmDiscard && (
        <ConfirmDialog
          title="Discard your changes?"
          confirmLabel="Discard changes"
          tone="caution"
          onCancel={() => setConfirmDiscard(false)}
          onConfirm={() => navigate(exitTo)}
        >
          <p>What you typed on this form hasn’t been saved.</p>
        </ConfirmDialog>
      )}
    </section>
  )
}

function focusField(event: MouseEvent<HTMLAnchorElement>, field: CaseField) {
  const target = document.getElementById(`field-${field}`)
  if (!target) return
  event.preventDefault()
  target.focus()
}

interface FieldProps {
  id: CaseField
  label: string
  optional?: boolean
  hint?: string
  issues: string[]
  children(describedBy: string | undefined, invalid: boolean): ReactNode
}

function Field({ id, label, optional, hint, issues, children }: FieldProps) {
  const hintId = hint ? `${id}-hint` : null
  const issuesId = issues.length > 0 ? `${id}-issues` : null
  const describedBy = [hintId, issuesId].filter(Boolean).join(' ') || undefined
  return (
    <div className={`field${issues.length > 0 ? ' field-invalid' : ''}`}>
      <label htmlFor={`field-${id}`}>
        {label} {optional && <span className="optional">(optional)</span>}
      </label>
      {hint && (
        <p id={hintId ?? undefined} className="hint">
          {hint}
        </p>
      )}
      {children(describedBy, issues.length > 0)}
      {issuesId && (
        <ul id={issuesId} className="field-issues">
          {issues.map((message) => (
            <li key={message} className="issue-error">
              {message}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
