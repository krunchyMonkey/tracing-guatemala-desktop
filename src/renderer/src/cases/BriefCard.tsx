import { Link } from 'react-router'
import { formatDateTime } from '../clients/components'
import { CasesLoadError } from './components'
import { BRIEF_FIELDS, briefIsEmpty, briefSections, type BriefField, type ResearchCase } from './model'
import { useCaseApi } from './useCaseApi'
import { useLoad } from './useLoad'

// The research brief on the case page (#17): the researcher's own working
// material, read-only here. Saved text is shown as plain text, never as markup.
// The hypotheses section looks different on purpose: it is not established fact.

interface BriefCardProps {
  researchCase: ResearchCase
  readOnly: boolean
  /** Why the brief can't be changed, shown when readOnly. */
  readOnlyReason: string
}

export function BriefCard({ researchCase, readOnly, readOnlyReason }: BriefCardProps) {
  const api = useCaseApi()
  const loaded = useLoad(() => api.getCaseBrief(researchCase.id), researchCase.id)
  const brief = loaded.data
  const editPath = `/cases/${researchCase.id}/brief`

  return (
    <section className="card brief" aria-labelledby="case-brief-heading">
      <div className="brief-header">
        <h2 id="case-brief-heading">Research brief</h2>
        {!readOnly && brief && !briefIsEmpty(brief) && (
          <Link className="button button-secondary" to={editPath}>
            Edit brief
          </Link>
        )}
      </div>

      {loaded.status === 'error' && brief === undefined ? (
        <CasesLoadError onRetry={loaded.retry} what="The research brief" />
      ) : !brief ? (
        <p className="muted" role="status">
          Loading the brief…
        </p>
      ) : (
        <>
          <div className="brief-requested">
            <h3>Client’s requested outcome</h3>
            {researchCase.goal ? <p className="preserve-lines">{researchCase.goal}</p> : <p className="muted">Not added</p>}
          </div>

          {briefIsEmpty(brief) ? (
            <div className="brief-empty">
              <p>
                <strong>No research brief yet.</strong>
              </p>
              <p className="muted">
                Keep your own working notes here: what you are trying to establish, what has been reported, who is
                involved, your hypotheses and what is still open.
              </p>
              {readOnly ? (
                <p className="muted">{readOnlyReason}</p>
              ) : (
                <Link className="button button-primary" to={editPath}>
                  Write the brief
                </Link>
              )}
            </div>
          ) : (
            <>
              {BRIEF_FIELDS.map((field) => {
                const text = brief[field]
                return text === null ? null : <Section key={field} field={field} text={text} />
              })}
              <p className="hint brief-meta">
                {brief.updatedAt && <>Brief last saved {formatDateTime(brief.updatedAt)}. </>}
                {readOnly && readOnlyReason}
              </p>
            </>
          )}
        </>
      )}
    </section>
  )
}

function Section({ field, text }: { field: BriefField; text: string }) {
  const { label } = briefSections[field]
  const headingId = `brief-${field}-heading`
  return (
    <section className={`brief-section brief-${field}`} aria-labelledby={headingId}>
      <h3 id={headingId}>{label}</h3>
      {field === 'facts' && <p className="hint">Recorded from the client or sources; not verified by the app.</p>}
      {field === 'hypotheses' && <p className="brief-label">Hypothesis — not established</p>}
      <p className="preserve-lines brief-text">{text}</p>
    </section>
  )
}
