import { Link } from 'react-router'
import type { Client } from '../clients/model'
import type { CaseApi } from '../runtime/AppRuntime'
import { ArchivedBadge, CasesLoadError, DueDate, StateBadge } from './components'
import { OPEN_STATES, defaultCaseQuery, type ResearchCase } from './model'
import { useLoad } from './useLoad'

// "Research cases" section of a client profile (#16): only this client's cases.

export function ClientCases({ client, api }: { client: Client; api: CaseApi }) {
  const loaded = useLoad(
    () => api.listCases({ ...defaultCaseQuery, clientId: client.id, archived: 'all', states: [] }),
    client.id
  )
  const cases = (loaded.data ?? []).filter((c) => c.clientId === client.id)
  const groups: { label: string; items: ResearchCase[] }[] = [
    { label: 'Open', items: cases.filter((c) => c.archivedAt === null && OPEN_STATES.includes(c.state)) },
    { label: 'Delivered and closed', items: cases.filter((c) => c.archivedAt === null && !OPEN_STATES.includes(c.state)) },
    { label: 'Archived', items: cases.filter((c) => c.archivedAt !== null) }
  ]

  return (
    <section className="card client-cases" aria-labelledby="client-cases-heading">
      <div className="history-header">
        <h2 id="client-cases-heading">Research cases</h2>
        {client.status === 'active' && (
          <Link className="button button-secondary button-small" to={`/cases/new?client=${client.id}`}>
            New case
          </Link>
        )}
      </div>

      {client.status !== 'active' && (
        <p className="muted">Restore this client to start a new case. Their existing cases stay visible but read-only.</p>
      )}

      {loaded.status === 'error' && loaded.data === undefined ? (
        <CasesLoadError onRetry={loaded.retry} what="This client’s cases" />
      ) : loaded.data === undefined ? (
        <p className="muted" role="status">
          Loading cases…
        </p>
      ) : cases.length === 0 ? (
        <p className="muted">
          No cases yet.{client.status === 'active' ? ' Start one when this client places an order.' : ''}
        </p>
      ) : (
        groups
          .filter((group) => group.items.length > 0)
          .map((group) => (
            <div key={group.label} className="case-group">
              <h3>{group.label}</h3>
              <ul className="case-list">
                {group.items.map((researchCase) => (
                  <li key={researchCase.id}>
                    <Link to={`/cases/${researchCase.id}`}>{researchCase.title}</Link>
                    <span className="case-list-meta">
                      <StateBadge state={researchCase.state} />
                      {researchCase.archivedAt !== null && <ArchivedBadge />}
                      <DueDate researchCase={researchCase} />
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))
      )}
    </section>
  )
}
