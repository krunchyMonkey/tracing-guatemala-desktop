import { Link } from 'react-router'
import { Alert } from '../clients/components'
import { formatDueDate, isOverdue, localDateString, stateLabels, type CaseState, type ResearchCase } from './model'

export function StateBadge({ state }: { state: CaseState }) {
  return <span className={`badge state-badge state-${state}`}>{stateLabels[state]}</span>
}

export function ArchivedBadge() {
  return <span className="badge badge-archived">Archived</span>
}

/** Due date with a text (not just colour) Overdue marker. */
export function DueDate({ researchCase }: { researchCase: ResearchCase }) {
  if (researchCase.dueDate === null) return <span className="muted">No due date</span>
  const overdue = isOverdue(researchCase, localDateString(new Date()))
  return (
    <span className="due-date">
      <time dateTime={researchCase.dueDate}>{formatDueDate(researchCase.dueDate)}</time>
      {overdue && <span className="overdue-tag">Overdue</span>}
    </span>
  )
}

export function CaseNotFound() {
  return (
    <section aria-labelledby="case-missing-heading">
      <h1 id="case-missing-heading">Case not found</h1>
      <p>This link doesn’t match any saved case.</p>
      <Link to="/cases">Back to cases</Link>
    </section>
  )
}

export function CasesLoadError({ onRetry, what = 'Your cases' }: { onRetry(): void; what?: string }) {
  return (
    <Alert tone="error" title={`${what} couldn’t be loaded`}>
      <p>Nothing was changed or lost. Try again, or restart the app if this keeps happening.</p>
      <button type="button" className="button button-secondary" onClick={onRetry}>
        Try again
      </button>
    </Alert>
  )
}
