import { useEffect, useMemo, useRef } from 'react'
import { Link, useSearchParams } from 'react-router'
import { useClientStore } from '../clients/ClientStore'
import { formatDate } from '../clients/components'
import { ArchivedBadge, CasesLoadError, DueDate, StateBadge } from '../cases/components'
import {
  OPEN_STATES,
  defaultCaseQuery,
  queryCases,
  type CaseQuery,
  type CaseState,
  type ResearchCase
} from '../cases/model'
import { useCaseApi } from '../cases/useCaseApi'
import { useLoad } from '../cases/useLoad'

// Case list (#16). The whole case set is small (a few hundred at most), so it is
// read once and the search, filters and sort run in the browser with the same
// shared rules the host uses. Filters live in the URL, like the client directory.

type StateGroup = 'open' | 'delivered' | 'closed' | 'all'
type ArchiveFilter = CaseQuery['archived']
type SortOrder = CaseQuery['sort']

interface CasesView {
  text: string
  client: string
  group: StateGroup
  archived: ArchiveFilter
  sort: SortOrder
}

const groupOptions: { value: StateGroup; label: string; states: CaseState[] }[] = [
  { value: 'open', label: 'Open', states: [...OPEN_STATES] },
  { value: 'delivered', label: 'Delivered', states: ['delivered'] },
  { value: 'closed', label: 'Closed', states: ['closed'] },
  { value: 'all', label: 'All', states: [] }
]

const archiveOptions: { value: ArchiveFilter; label: string }[] = [
  { value: 'active', label: 'Active cases' },
  { value: 'archived', label: 'Archived' },
  { value: 'all', label: 'All' }
]

const sortOptions: { value: SortOrder; label: string }[] = [
  { value: 'due', label: 'Due date' },
  { value: 'updated', label: 'Recently updated' },
  { value: 'created', label: 'Recently created' },
  { value: 'title', label: 'Title (A–Z)' }
]

const defaults: CasesView = { text: '', client: '', group: 'open', archived: 'active', sort: 'due' }
const SEARCH_MAX = 200

function readView(params: URLSearchParams): CasesView {
  const group = params.get('state')
  const archived = params.get('archived')
  const sort = params.get('sort')
  return {
    text: (params.get('q') ?? '').slice(0, SEARCH_MAX),
    client: params.get('client') ?? '',
    group: groupOptions.some((o) => o.value === group) ? (group as StateGroup) : defaults.group,
    archived: archiveOptions.some((o) => o.value === archived) ? (archived as ArchiveFilter) : defaults.archived,
    sort: sortOptions.some((o) => o.value === sort) ? (sort as SortOrder) : defaults.sort
  }
}

function writeView(view: CasesView): URLSearchParams {
  const params = new URLSearchParams()
  if (view.text) params.set('q', view.text)
  if (view.client) params.set('client', view.client)
  if (view.group !== defaults.group) params.set('state', view.group)
  if (view.archived !== defaults.archived) params.set('archived', view.archived)
  if (view.sort !== defaults.sort) params.set('sort', view.sort)
  return params
}

const none: ResearchCase[] = []
const everyCase: CaseQuery = { ...defaultCaseQuery, archived: 'all' }

export function CasesScreen() {
  const api = useCaseApi()
  const { clients } = useClientStore()
  const [params, setParams] = useSearchParams()
  const view = readView(params)
  const loaded = useLoad(() => api.listCases(everyCase), 'all')

  const clientNames = useMemo(() => new Map(clients.map((c) => [c.id, c.displayName])), [clients])
  const sortedClients = useMemo(
    () => [...clients].sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [clients]
  )
  const all = loaded.data ?? none
  const results = useMemo(
    () =>
      queryCases(all, {
        clientId: view.client || null,
        archived: view.archived,
        states: groupOptions.find((o) => o.value === view.group)?.states ?? [],
        text: view.text,
        sort: view.sort
      }),
    [all, view.client, view.archived, view.group, view.text, view.sort]
  )

  // URL updates commit asynchronously, so quick successive changes (a clear, then a
  // filter) build on the last view written, not the last one rendered.
  const search = params.toString()
  const pending = useRef(view)
  useEffect(() => {
    pending.current = readView(new URLSearchParams(search))
  }, [search])
  const update = (patch: Partial<CasesView>) => {
    pending.current = { ...pending.current, ...patch }
    setParams(writeView(pending.current), { replace: true })
  }
  const isFiltered =
    view.text !== '' || view.client !== '' || view.group !== defaults.group || view.archived !== defaults.archived

  const unarchived = all.filter((c) => c.archivedAt === null)
  const openCount = unarchived.filter((c) => OPEN_STATES.includes(c.state)).length
  const archivedCount = all.length - unarchived.length

  return (
    <section aria-labelledby="cases-heading" className="cases">
      <header className="page-header">
        <div>
          <h1 id="cases-heading">Cases</h1>
          <p className="lead">
            {loaded.status !== 'ready' || all.length === 0
              ? 'Every research order, in one place.'
              : `${openCount} open · ${unarchived.length - openCount} finished · ${archivedCount} archived`}
          </p>
        </div>
        <Link className="button button-primary" to="/cases/new">
          <span aria-hidden="true">+</span> New case
        </Link>
      </header>

      {loaded.status === 'error' && <CasesLoadError onRetry={loaded.retry} />}

      {loaded.status === 'loading' && loaded.data === undefined && (
        <p role="status" className="muted">
          Loading cases…
        </p>
      )}

      {loaded.data !== undefined && all.length === 0 && (
        <div className="empty-state">
          <div className="empty-illustration" aria-hidden="true" />
          <h2>No cases yet — open a client to start one</h2>
          <p>
            A case is one piece of research for one client, usually one Fiverr order. Open a client and choose “New
            case”, or start here and pick the client.
          </p>
          <Link className="button button-primary" to="/clients">
            Open clients
          </Link>
        </div>
      )}

      {loaded.data !== undefined && all.length > 0 && (
        <>
          <div className="toolbar case-toolbar" role="search">
            <div className="field search-field">
              <label htmlFor="case-search">Search cases</label>
              <input
                id="case-search"
                type="search"
                placeholder="Title or order reference"
                maxLength={SEARCH_MAX}
                value={view.text}
                onChange={(event) => update({ text: event.target.value })}
              />
            </div>

            <div className="field">
              <label htmlFor="case-sort">Sort by</label>
              <select id="case-sort" value={view.sort} onChange={(e) => update({ sort: e.target.value as SortOrder })}>
                {sortOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label htmlFor="case-client">Client</label>
              <select id="case-client" value={view.client} onChange={(e) => update({ client: e.target.value })}>
                <option value="">All clients</option>
                {sortedClients.map((client) => (
                  <option key={client.id} value={client.id}>
                    {client.displayName}
                  </option>
                ))}
              </select>
            </div>

            <fieldset className="segmented">
              <legend>State</legend>
              {groupOptions.map((option) => (
                <label key={option.value} className={view.group === option.value ? 'selected' : undefined}>
                  <input
                    type="radio"
                    name="state-group"
                    value={option.value}
                    checked={view.group === option.value}
                    onChange={() => update({ group: option.value })}
                  />
                  {option.label}
                </label>
              ))}
            </fieldset>

            <fieldset className="segmented">
              <legend>Show</legend>
              {archiveOptions.map((option) => (
                <label key={option.value} className={view.archived === option.value ? 'selected' : undefined}>
                  <input
                    type="radio"
                    name="archive-filter"
                    value={option.value}
                    checked={view.archived === option.value}
                    onChange={() => update({ archived: option.value })}
                  />
                  {option.label}
                </label>
              ))}
            </fieldset>
          </div>

          <p className="result-count" role="status">
            {results.length === 1 ? '1 case' : `${results.length} cases`}
            {isFiltered && (
              <>
                {' · '}
                <button type="button" className="link-button" onClick={() => update(defaults)}>
                  Clear search and filters
                </button>
              </>
            )}
          </p>

          {results.length === 0 ? (
            <div className="empty-state empty-state-compact">
              <h2>No matching cases</h2>
              <p>
                {view.text ? `Nothing matches “${view.text}”.` : 'No cases match these filters.'}
                {view.group === 'open' && ' Delivered and closed cases are hidden; choose “All” to include them.'}
                {view.archived === 'active' && ' Archived cases are hidden too.'}
              </p>
            </div>
          ) : (
            <table className="client-table case-table">
              <thead>
                <tr>
                  <th scope="col">Case</th>
                  <th scope="col">Client</th>
                  <th scope="col">State</th>
                  <th scope="col">Due</th>
                  <th scope="col">Last updated</th>
                </tr>
              </thead>
              <tbody>
                {results.map((researchCase) => (
                  <tr key={researchCase.id} className={researchCase.archivedAt !== null ? 'is-archived' : undefined}>
                    <th scope="row">
                      <Link to={`/cases/${researchCase.id}`}>{researchCase.title}</Link>
                      {researchCase.orderReference && <span className="case-ref">{researchCase.orderReference}</span>}
                    </th>
                    <td data-label="Client">
                      {clientNames.has(researchCase.clientId) ? (
                        <Link to={`/clients/${researchCase.clientId}`}>{clientNames.get(researchCase.clientId)}</Link>
                      ) : (
                        <span className="muted">Unknown client</span>
                      )}
                    </td>
                    <td data-label="State">
                      <StateBadge state={researchCase.state} />
                      {researchCase.archivedAt !== null && <ArchivedBadge />}
                    </td>
                    <td data-label="Due">
                      <DueDate researchCase={researchCase} />
                    </td>
                    <td data-label="Last updated">{formatDate(researchCase.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  )
}
