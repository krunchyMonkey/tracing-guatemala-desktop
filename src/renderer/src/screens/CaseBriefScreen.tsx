import { useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useClientStore } from '../clients/ClientStore'
import { Alert, ConfirmDialog } from '../clients/components'
import { CaseNotFound, CasesLoadError } from '../cases/components'
import {
  BRIEF_FIELDS,
  BRIEF_LIMITS,
  briefIssueMessage,
  briefSections,
  checkCaseBrief,
  isCaseId,
  type BriefField,
  type BriefIssue,
  type CaseBrief,
  type CaseBriefInput
} from '../cases/model'
import { useCaseApi } from '../cases/useCaseApi'
import { useLoad } from '../cases/useLoad'

// Write or edit a case's research brief (#17). Five plain-text sections, all
// optional; the host re-checks every save. Nothing typed is lost when a save fails.

type FormValues = Record<BriefField, string>

const toValues = (brief: CaseBrief): FormValues => ({
  objective: brief.objective ?? '',
  facts: brief.facts ?? '',
  people: brief.people ?? '',
  hypotheses: brief.hypotheses ?? '',
  questions: brief.questions ?? ''
})

const toInput = (values: FormValues): CaseBriefInput => ({
  objective: values.objective === '' ? null : values.objective,
  facts: values.facts === '' ? null : values.facts,
  people: values.people === '' ? null : values.people,
  hypotheses: values.hypotheses === '' ? null : values.hypotheses,
  questions: values.questions === '' ? null : values.questions
})

type SaveError = 'failed' | 'not-found' | 'wrong-status'

const saveErrorMessages: Record<SaveError, string> = {
  failed: 'Something went wrong while saving. Your changes are still here, so you can try again.',
  'not-found': 'This case couldn’t be found any more. Your changes are still here; copy anything you need.',
  'wrong-status':
    'This case or its client was archived, so its brief can’t be changed. Restore it first; your changes are still here.'
}

export function CaseBriefScreen() {
  const { caseId } = useParams()
  const valid = isCaseId(caseId)
  if (!valid) return <CaseNotFound />
  return <EditBrief key={caseId} caseId={caseId} />
}

function EditBrief({ caseId }: { caseId: string }) {
  const api = useCaseApi()
  const { clients } = useClientStore()
  const loaded = useLoad(
    async () => ({ researchCase: await api.getCase(caseId), brief: await api.getCaseBrief(caseId) }),
    caseId
  )

  if (loaded.status === 'error' && loaded.data === undefined) {
    return (
      <section aria-labelledby="form-heading">
        <h1 id="form-heading">Research brief</h1>
        <CasesLoadError onRetry={loaded.retry} what="This case" />
      </section>
    )
  }
  if (loaded.data === undefined) {
    return (
      <p role="status" className="muted">
        Loading the brief…
      </p>
    )
  }
  const { researchCase, brief } = loaded.data
  if (researchCase === null || brief === null) return <CaseNotFound />

  const client = clients.find((c) => c.id === researchCase.clientId)
  if (researchCase.archivedAt !== null || client?.status !== 'active') {
    return (
      <section aria-labelledby="form-heading">
        <h1 id="form-heading">Research brief</h1>
        <Alert tone="info" title={researchCase.archivedAt !== null ? 'This case is archived' : 'This client is archived'}>
          Archived cases, and cases of archived clients, are read-only.{' '}
          {researchCase.archivedAt !== null
            ? 'Unarchive the case to change its brief.'
            : `Restore ${client?.displayName ?? 'the client'} to change the brief.`}
        </Alert>
        <Link className="button button-secondary" to={`/cases/${researchCase.id}`}>
          Back to case
        </Link>
      </section>
    )
  }
  return <BriefForm key={researchCase.id} caseId={researchCase.id} title={researchCase.title} goal={researchCase.goal} brief={brief} />
}

function BriefForm({ caseId, title, goal, brief }: { caseId: string; title: string; goal: string | null; brief: CaseBrief }) {
  const api = useCaseApi()
  const navigate = useNavigate()
  const initial = toValues(brief)
  const [values, setValues] = useState(initial)
  const [submitted, setSubmitted] = useState(false)
  const [serverIssues, setServerIssues] = useState<BriefIssue[]>([])
  const [saveError, setSaveError] = useState<SaveError | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const summaryRef = useRef<HTMLDivElement>(null)

  const dirty = BRIEF_FIELDS.some((field) => values[field] !== initial[field])
  const { issues, input } = checkCaseBrief(toInput(values))
  const shown = submitted ? [...issues, ...serverIssues] : []
  const messageFor = (field: BriefField) => shown.filter((i) => i.field === field).map(briefIssueMessage)
  const exitTo = `/cases/${caseId}`

  const set = (field: BriefField, value: string) => {
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
      const result = await api.saveCaseBrief(caseId, input)
      if (result.ok) {
        navigate(exitTo, { state: { flash: 'Brief saved.' } })
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
        <Link to={exitTo}>← Back to case</Link>
      </p>
      <h1 id="form-heading">Research brief</h1>
      <p className="lead">
        For <strong>{title}</strong>. Everything here is optional and can be changed later. Plain text only; line breaks
        are kept.
      </p>

      <div className="brief-requested">
        <h2 className="brief-requested-heading">Client’s requested outcome</h2>
        {goal ? <p className="preserve-lines">{goal}</p> : <p className="muted">Not added</p>}
        <p className="hint">Shown for reference. Change it with “Edit details” on the case.</p>
      </div>

      {shown.length > 0 && (
        <div ref={summaryRef} tabIndex={-1} className="alert alert-error" role="alert">
          <p className="alert-title">
            {shown.length === 1 ? 'One thing needs fixing' : `${shown.length} things need fixing`} before saving:
          </p>
          <ul>
            {shown.map((issue) => (
              <li key={`${issue.field}-${issue.code}`}>
                <a href={`#field-${issue.field}`} onClick={(e) => focusField(e, issue.field)}>
                  {briefIssueMessage(issue)}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      {saveError && (
        <Alert tone="error" title="Couldn’t save the brief">
          {saveErrorMessages[saveError]}
        </Alert>
      )}

      <form noValidate onSubmit={(event) => void onSubmit(event)} className="client-form">
        <fieldset className="form-section">
          <legend>Your working material</legend>
          {BRIEF_FIELDS.map((field) => (
            <Field key={field} field={field} issues={messageFor(field)}>
              {(describedBy, invalid) => (
                <textarea
                  id={`field-${field}`}
                  rows={field === 'objective' ? 4 : 7}
                  maxLength={BRIEF_LIMITS[field] + 200}
                  value={values[field]}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  onChange={(e) => set(field, e.target.value)}
                />
              )}
            </Field>
          ))}
        </fieldset>

        <div className="form-actions">
          <button type="submit" className="button button-primary" disabled={saving} aria-busy={saving}>
            {saving ? 'Saving…' : 'Save brief'}
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
          <p>What you typed in the brief hasn’t been saved.</p>
        </ConfirmDialog>
      )}
    </section>
  )
}

function focusField(event: MouseEvent<HTMLAnchorElement>, field: BriefField) {
  const target = document.getElementById(`field-${field}`)
  if (!target) return
  event.preventDefault()
  target.focus()
}

interface FieldProps {
  field: BriefField
  issues: string[]
  children(describedBy: string, invalid: boolean): ReactNode
}

function Field({ field, issues, children }: FieldProps) {
  const { label, hint } = briefSections[field]
  const hintId = `${field}-hint`
  const issuesId = issues.length > 0 ? `${field}-issues` : null
  const describedBy = [hintId, issuesId].filter(Boolean).join(' ')
  return (
    <div className={`field${issues.length > 0 ? ' field-invalid' : ''}${field === 'hypotheses' ? ' brief-field-hypotheses' : ''}`}>
      <label htmlFor={`field-${field}`}>
        {label} <span className="optional">(optional)</span>
      </label>
      <p id={hintId} className="hint">
        {hint}
      </p>
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
