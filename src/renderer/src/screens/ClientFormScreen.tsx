import { useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useClientStore } from '../clients/ClientStore'
import { Alert, ConfirmDialog, PrototypeBanner, StatusBadge } from '../clients/components'
import {
  NAME_MAX,
  channelLabels,
  emptyFormValues,
  findDuplicates,
  sourceLabels,
  toFormValues,
  validateClient,
  type ClientFormValues,
  type ClientInput,
  type ClientSource,
  type ContactChannel,
  type DuplicateCandidate,
  type FieldName,
  type ValidationIssue
} from '../clients/model'

// PROVISIONAL add/edit form (#3). Fields and rules follow the draft #2 model.

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
      <p>This client may have been removed from the prototype’s sample data.</p>
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
  const [saveFailed, setSaveFailed] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const summaryRef = useRef<HTMLDivElement>(null)
  const duplicatesRef = useRef<HTMLDivElement>(null)

  const isEdit = clientId !== undefined
  const dirty = (Object.keys(values) as FieldName[]).some((key) => values[key] !== initial[key])
  const { issues, input } = validateClient(values)
  const errors = submitted ? issues.filter((i) => i.severity === 'error') : []
  const issuesFor = (field: FieldName) =>
    issues.filter((i) => i.field === field && (i.severity !== 'error' || submitted))
  const exitTo = isEdit ? `/clients/${clientId}` : '/clients'

  const set = <K extends FieldName>(field: K, value: ClientFormValues[K]) => {
    setValues((v) => ({ ...v, [field]: value }))
    setDuplicates(null)
    setSaveFailed(false)
  }

  function save(valid: ClientInput) {
    const result = clientId !== undefined ? store.updateClient(clientId, valid) : store.createClient(valid)
    if (!result.ok) {
      setSaveFailed(true)
      return
    }
    navigate(`/clients/${result.value.id}`, { state: { flash: isEdit ? 'Changes saved.' : 'Client added.' } })
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    setSubmitted(true)
    setSaveFailed(false)
    if (!input) {
      requestAnimationFrame(() => summaryRef.current?.focus())
      return
    }
    const matches = findDuplicates(input, store.clients, clientId)
    if (matches.length > 0) {
      setDuplicates(matches)
      requestAnimationFrame(() => duplicatesRef.current?.focus())
      return
    }
    save(input)
  }

  function onCancel() {
    if (dirty) setConfirmDiscard(true)
    else navigate(exitTo)
  }

  const showSourceDetail = values.source === 'referral' || values.source === 'other' || values.sourceDetail !== ''
  const generalInfo = issues.find((i) => i.field === null)

  return (
    <section aria-labelledby="form-heading" className="client-form-page">
      <PrototypeBanner />
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

      {saveFailed && (
        <Alert tone="error" title="Couldn’t save this client">
          Something went wrong while saving. Your changes are still here, so you can try again.
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
            <button type="button" className="button button-secondary" onClick={() => save(input)}>
              {isEdit ? 'Save anyway' : 'Save as a new client anyway'}
            </button>
            <button type="button" className="button button-ghost" onClick={() => setDuplicates(null)}>
              Go back and edit
            </button>
          </div>
        </div>
      )}

      <form noValidate onSubmit={onSubmit} className="client-form">
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
          <button type="submit" className="button button-primary">
            {isEdit ? 'Save changes' : 'Save client'}
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
