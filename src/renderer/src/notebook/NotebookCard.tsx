import { Link } from 'react-router'
import { useCaseApi } from '../cases/useCaseApi'
import { useLoad } from '../cases/useLoad'

// The case page's way into the research notebook (#148): what is there, or an invitation
// to start one. Opening it never changes anything.

export function NotebookCard({ caseId, readOnly }: { caseId: string; readOnly: boolean }) {
  const api = useCaseApi()
  const outline = useLoad(() => api.getNotebook(caseId), caseId)
  const sections = outline.data?.sections.filter((s) => s.archivedAt === null) ?? []
  const pages = sections.reduce((total, s) => total + s.pages.filter((p) => p.archivedAt === null).length, 0)
  const started = sections.length > 0
  const label = started ? 'Open the notebook' : readOnly ? null : 'Start a notebook'

  return (
    <section className="card notebook-card" aria-labelledby="case-notebook-heading">
      <div className="notebook-card-body">
        <div>
          <h2 id="case-notebook-heading">Research notebook</h2>
          <p className="muted notebook-card-summary" role={outline.data === undefined ? 'status' : undefined}>
            {outline.status === 'error' && outline.data === undefined
              ? 'The notebook couldn’t be loaded.'
              : outline.data === undefined
                ? 'Loading…'
                : started
                  ? `${pages} ${pages === 1 ? 'page' : 'pages'} in ${sections.length} ${sections.length === 1 ? 'section' : 'sections'}. Rich notes for this case, saved as you write.`
                  : readOnly
                    ? 'No notebook was started for this case.'
                    : 'Sections and pages for your working notes on this case: headings, lists, checklists and links.'}
          </p>
        </div>
        {outline.status === 'error' && outline.data === undefined ? (
          <button type="button" className="button button-secondary" onClick={outline.retry}>
            Try again
          </button>
        ) : (
          label && (
            <Link className="button button-primary" to={`/cases/${caseId}/notebook`}>
              {label}
            </Link>
          )
        )}
      </div>
    </section>
  )
}
