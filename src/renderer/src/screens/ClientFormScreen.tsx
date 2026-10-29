import { useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useClientStore, type SaveResult } from '../clients/ClientStore'
import { Alert, ConfirmDialog, StatusBadge } from '../clients/components'
import {
  NAME_MAX,
  channelLabels,
  emptyFormValues,
  sourceLabels,
  toFormValues,
  toValidationIssues,
  validateClient,
  type ClientFormValues,
  type ClientInput,
  type ClientSource,
  type ContactChannel,
  type DuplicateCandidate,
  type FieldName,
  type ValidationIssue
} from '../clients/model'

// Add/edit form (#3 baseline, saved through the main process since #6). Fields and
// rules follow client-model/v1; the main process re-checks every save.

type SaveError = 'failed' | 'not-found' | 'wrong-status' | 'duplicate-check-failed'

const saveErrorMessages: Record<SaveError, string> = {
  failed: 'Something went wrong while saving. Your changes are still here, so you can try again.',
  'not-found': 'This client couldn’t be found any more. Your changes are still here; copy anything you need.',
  'wrong-status': 'This client was archived, so it can’t be edited. Restore it from the profile first.',
  'duplicate-check-failed':
    'Couldn’t check whether this client already exists, so nothing was saved. Your changes are still here; please try again.'
}

const signalLabels = { email: 'same email', fiverrUsername: 'same Fiverr username', displayName: 'same name' }

export function ClientFormScreen() {
  const { id } = useParams()
  const { clients } = useClientStore()

  if (id === undefined) return <ClientForm key="new" />

  const existing = clients.find((c) => c.id === id)
  if (!existing) return <NotFound />
  if (existing.status === 'archived') {
    return (
      <section aria-labelledby="form-heading">
        <h1 id="form-heading">Edit client</h1>
        <Alert tone="info" title="This client is archived">
          Archived clients are read-only. Restore {existing.displayName} from their profile to make changes.
        </Alert>
        <Link className="button button-secondary" to={`/clients/${existing.id}`}>
          Back to profile
        </Link>
      </section>
    )
  }
  return <ClientForm key={existing.id} clientId={existing.id} initial={toFormValues(existing)} />
}

function NotFound() {
  return (
    <section aria-labelledby="form-heading">
      <h1 id="form-heading">Client not found</h1>
      <p>This link doesn’t match any saved client.</p>
      <Link to="/clients">Back to clients</Link>
    </section>
  )
}

function ClientForm({ clientId, initial = emptyFormValues }: { clientId?: string; initial?: ClientFormValues }) {
  const store = useClientStore()
  const navigate = useNavigate()
  const [values, setValues] = useState(initial)
  const [submitted, setSubmitted] = useState(false)
  const [duplicates, setDuplicates] = useState<DuplicateCandidate[] | null>(null)
  const [saveError, setSaveError] = useState<SaveError | null>(null)
  const [serverIssues, setServerIssues] = useState<ValidationIssue[]>([])
  const [saving, setSaving] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const summaryRef = useRef<HTMLDivElement>(null)
  const duplicatesRef = useRef<HTMLDivElement>(null)

  const isEdit = clientId !== undefined
  const dirty = (Object.keys(values) as FieldName[]).some((key) => values[key] !== initial[key])
  const { issues, input } = validateClient(values)
  const errors = submitted ? [...issues.filter((i) => i.severity === 'error'), ...serverIssues] : []
  const issuesFor = (field: FieldName) =>
    issues.filter((i) => i.field === field && (i.severity !== 'error' || submitted))
  const exitTo = isEdit ? `/clients/${clientId}` : store.directoryHref

  const set = <K extends FieldName>(field: K, value: ClientFormValues[K]) => {
    setValues((v) => ({ ...v, [field]: value }))
    setDuplicates(null)
    setSaveError(null)
    setServerIssues([])
  }

  async function save(valid: ClientInput) {
    if (saving) return
    setSaving(true)
    setDuplicates(null)
    let result: SaveResult
    try {
      result = clientId !== undefined ? await store.updateClient(clientId, valid) : await store.createClient(valid)
    } finally {
      setSaving(false)
    }
    if (result.ok) {
      navigate(`/clients/${result.client.id}`, { state: { flash: isEdit ? 'Changes saved.' : 'Client added.' } })
      return
    }
    // The form keeps every value so nothing typed is lost.
    if (result.reason === 'invalid') {
      setServerIssues(toValidationIssues(result.issues).filter((i) => i.severity === 'error'))
      requestAnimationFrame(() => summaryRef.current?.focus())
    } else {
      setSaveError(result.reason)
    }
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
    // The main process compares against every saved client, archived ones included.
    setSaving(true)
    let matches: DuplicateCandidate[]
    try {
      matches = await store.findDuplicates(input, clientId ?? null)
    } catch {
      setSaving(false)
      setSaveError('duplicate-check-failed')
      return
    }
    setSaving(false)
    if (matches.length > 0) {
      setDuplicates(matches)
      requestAnimationFrame(() => duplicatesRef.current?.focus())
      return
    }
    void save(input)
  }

  function onCancel() {
    if (dirty) setConfirmDiscard(true)
    else navigate(exitTo)
  }

  const showSourceDetail = values.source === 'referral' || values.source === 'other' || values.sourceDetail !== ''
  const generalInfo = issues.find((i) => i.field === null)

  return (
    <section aria-labelledby="form-heading" className="client-form-page">
      <p className="breadcrumb">
        <Link to={exitTo}>{isEdit ? '← Back to profile' : '← Clients'}</Link>
      </p>
      <h1 id="form-heading">{isEdit ? `Edit ${initial.displayName}` : 'Add a client'}</h1>
      <p className="lead">Only the name and source are required. Everything else can be added later.</p>

      {errors.length > 0 && (
        <div ref={summaryRef} tabIndex={-1} className="alert alert-error" role="alert">
          <p className="alert-title">
            {errors.length === 1 ? 'One thing needs fixing' : `${errors.length} things need fixing`} before saving:
          </p>
          <ul>
            {errors.map((issue) => (
              <li key={`${issue.field}-${issue.message}`}>
                <a href={`#field-${issue.field}`} onClick={(e) => focusField(e, issue.field)}>
                  {issue.message}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      {saveError && (
        <Alert tone="error" title="Couldn’t save this client">
          {saveErrorMessages[saveError]}
        </Alert>
      )}

      {duplicates && input && (
        <div ref={duplicatesRef} tabIndex={-1} className="alert alert-warning duplicate-panel" role="alert">
          <p className="alert-title">This might be someone you already have</p>
          <ul className="duplicate-list">
            {duplicates.map(({ client, signals }) => (
              <li key={client.id}>
                <span className="duplicate-name">{client.displayName}</span> <StatusBadge status={client.status} />
                <span className="muted"> · {signals.map((s) => signalLabels[s]).join(', ')}</span>{' '}
                <Link to={`/clients/${client.id}`}>
                  {client.status === 'archived' ? 'Open to restore' : 'Open existing client'}
                </Link>
              </li>
            ))}
          </ul>
          <div className="button-row">
            <button type="button" className="button button-secondary" disabled={saving} onClick={() => void save(input)}>
              {isEdit ? 'Save anyway' : 'Save as a new client anyway'}
            </button>
            <button type="button" className="button button-ghost" onClick={() => setDuplicates(null)}>
              Go back and edit
            </button>
          </div>
        </div>
      )}

      <form noValidate onSubmit={(event) => void onSubmit(event)} className="client-form">
        <fieldset className="form-section">
          <legend>About this client</legend>

          <Field
            id="displayName"
            label="Name"
            hint="How you’ll recognize them. It doesn’t need to be their legal name."
            issues={issuesFor('displayName')}
          >
            {(describedBy, invalid) => (
              <input
                id="field-displayName"
                type="text"
                maxLength={NAME_MAX + 20}
                autoComplete="off"
                value={values.displayName}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                aria-required="true"
                onChange={(e) => set('displayName', e.target.value)}
              />
            )}
          </Field>

          <fieldset
            className="radio-cards"
            id="field-source"
            tabIndex={-1}
            aria-describedby={issuesFor('source').length ? 'source-issues' : undefined}
          >
            <legend>Where did they find you?</legend>
            <div className="radio-card-grid">
              {(Object.keys(sourceLabels) as ClientSource[]).map((source) => (
                <label key={source} className={values.source === source ? 'selected' : undefined}>
                  <input
                    type="radio"
                    name="source"
                    value={source}
                    checked={values.source === source}
                    onChange={() => set('source', source)}
                  />
                  {sourceLabels[source]}
                </label>
              ))}
            </div>
            <IssueList id="source-issues" issues={issuesFor('source')} />
          </fieldset>

          {showSourceDetail && (
            <Field
              id="sourceDetail"
              label="Source details"
              optional
              hint="For example, who referred them."
              issues={issuesFor('sourceDetail')}
            >
              {(describedBy, invalid) => (
                <input
                  id="field-sourceDetail"
                  type="text"
                  value={values.sourceDetail}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  onChange={(e) => set('sourceDetail', e.target.value)}
                />
              )}
            </Field>
          )}
        </fieldset>

        <fieldset className="form-section">
          <legend>How to reach them</legend>
          {generalInfo && <p className="hint-inline">{generalInfo.message}</p>}

          <div className="field-grid">
            <Field id="fiverrUsername" label="Fiverr username" optional issues={issuesFor('fiverrUsername')}>
              {(describedBy, invalid) => (
                <div className="input-prefix">
                  <span aria-hidden="true">@</span>
                  <input
                    id="field-fiverrUsername"
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    value={values.fiverrUsername}
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    onChange={(e) => set('fiverrUsername', e.target.value)}
                  />
                </div>
              )}
            </Field>

            <Field id="email" label="Email" optional issues={issuesFor('email')}>
              {(describedBy, invalid) => (
                <input
                  id="field-email"
                  type="email"
                  autoComplete="off"
                  value={values.email}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  onChange={(e) => set('email', e.target.value)}
                />
              )}
            </Field>
          </div>

          <Field
            id="otherContact"
            label="Other contact"
            optional
            hint="Anything else, such as “WhatsApp, evenings only”."
            issues={issuesFor('otherContact')}
          >
            {(describedBy, invalid) => (
              <input
                id="field-otherContact"
                type="text"
                value={values.otherContact}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                onChange={(e) => set('otherContact', e.target.value)}
              />
            )}
          </Field>

          <Field id="preferredContactChannel" label="Preferred way to contact" optional issues={[]}>
            {(describedBy) => (
              <select
                id="field-preferredContactChannel"
                value={values.preferredContactChannel}
                aria-describedby={describedBy}
                onChange={(e) => set('preferredContactChannel', e.target.value as ContactChannel)}
              >
                {(Object.keys(channelLabels) as ContactChannel[]).map((channel) => (
                  <option key={channel} value={channel}>
                    {channelLabels[channel]}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </fieldset>

        <div className="form-actions">
          <button type="submit" className="button button-primary" disabled={saving} aria-busy={saving}>
            {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Save client'}
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

function focusField(event: MouseEvent<HTMLAnchorElement>, field: FieldName | null) {
  if (!field) return
  const target = document.getElementById(`field-${field}`)
  if (!target) return
  event.preventDefault()
  // Radio groups focus their checked (or first) option.
  const focusable = target.matches('fieldset')
    ? (target.querySelector<HTMLElement>('input:checked') ?? target.querySelector<HTMLElement>('input'))
    : target
  focusable?.focus()
}

interface FieldProps {
  id: FieldName
  label: string
  optional?: boolean
  hint?: string
  issues: ValidationIssue[]
  children(describedBy: string | undefined, invalid: boolean): ReactNode
}

function Field({ id, label, optional, hint, issues, children }: FieldProps) {
  const hintId = hint ? `${id}-hint` : null
  const issuesId = issues.length > 0 ? `${id}-issues` : null
  const describedBy = [hintId, issuesId].filter(Boolean).join(' ') || undefined
  const invalid = issues.some((i) => i.severity === 'error')
  return (
    <div className={`field${invalid ? ' field-invalid' : ''}`}>
      <label htmlFor={`field-${id}`}>
        {label} {optional && <span className="optional">(optional)</span>}
      </label>
      {hint && (
        <p id={hintId ?? undefined} className="hint">
          {hint}
        </p>
      )}
      {children(describedBy, invalid)}
      {issuesId && <IssueList id={issuesId} issues={issues} />}
    </div>
  )
}

function IssueList({ id, issues }: { id: string; issues: ValidationIssue[] }) {
  if (issues.length === 0) return null
  return (
    <ul id={id} className="field-issues">
      {issues.map((issue) => (
        <li key={issue.message} className={`issue-${issue.severity}`}>
          {issue.message}
        </li>
      ))}
    </ul>
  )
}
