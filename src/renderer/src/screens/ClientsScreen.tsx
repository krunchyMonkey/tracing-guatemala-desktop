import { Link, useSearchParams } from 'react-router'
import { useClientStore } from '../clients/ClientStore'
import { PrototypeBanner, SourceTag, StatusBadge, formatDate } from '../clients/components'
import {
  defaultQuery,
  queryClients,
  sourceLabels,
  type ClientSource,
  type DirectoryQuery,
  type SortOrder,
  type StatusFilter
} from '../clients/model'

// PROVISIONAL client directory (#3), built on the draft #2 model. Uses in-memory
// fictional data only; see docs/prototypes/client-directory.md.

const statusOptions: { value: StatusFilter; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'archived', label: 'Archived' },
  { value: 'all', label: 'All' }
]

const sortOptions: { value: SortOrder; label: string }[] = [
  { value: 'name', label: 'Name (A–Z)' },
  { value: 'updated', label: 'Recently updated' },
  { value: 'created', label: 'Recently added' }
]

const allSources = Object.keys(sourceLabels) as ClientSource[]

// Filters live in the URL so they survive opening a profile and coming back.
function readQuery(params: URLSearchParams): DirectoryQuery {
  const status = params.get('status')
  const sort = params.get('sort')
  return {
    text: params.get('q') ?? '',
    status: statusOptions.some((o) => o.value === status) ? (status as StatusFilter) : defaultQuery.status,
    sort: sortOptions.some((o) => o.value === sort) ? (sort as SortOrder) : defaultQuery.sort,
    sources: params.getAll('source').filter((s): s is ClientSource => allSources.includes(s as ClientSource))
  }
}

function writeQuery(query: DirectoryQuery): URLSearchParams {
  const params = new URLSearchParams()
  if (query.text) params.set('q', query.text)
  if (query.status !== defaultQuery.status) params.set('status', query.status)
  if (query.sort !== defaultQuery.sort) params.set('sort', query.sort)
  for (const source of query.sources) params.append('source', source)
  return params
}

export function ClientsScreen() {
  const { clients } = useClientStore()
  const [params, setParams] = useSearchParams()
  const query = readQuery(params)
  const results = queryClients(clients, query)
  const isFiltered = query.text !== '' || query.sources.length > 0 || query.status !== defaultQuery.status
  const activeCount = clients.filter((c) => c.status === 'active').length

  const update = (patch: Partial<DirectoryQuery>) => setParams(writeQuery({ ...query, ...patch }), { replace: true })
  const toggleSource = (source: ClientSource) =>
    update({
      sources: query.sources.includes(source) ? query.sources.filter((s) => s !== source) : [...query.sources, source]
    })

  return (
    <section aria-labelledby="clients-heading" className="clients">
      <PrototypeBanner />

      <header className="page-header">
        <div>
          <h1 id="clients-heading">Clients</h1>
          <p className="lead">
            {clients.length === 0
              ? 'Everyone you research for, in one place.'
              : `${activeCount} active · ${clients.length - activeCount} archived`}
          </p>
        </div>
        <Link className="button button-primary" to="/clients/new">
          <span aria-hidden="true">+</span> Add client
        </Link>
      </header>

      {clients.length === 0 ? (
        <div className="empty-state">
          <div className="empty-illustration" aria-hidden="true" />
          <h2>No clients yet</h2>
          <p>
            Add your first client to keep their contact details and notes together. You only need a name and where
            they found you.
          </p>
          <Link className="button button-primary" to="/clients/new">
            Add your first client
          </Link>
        </div>
      ) : (
        <>
          <div className="toolbar" role="search">
            <div className="field search-field">
              <label htmlFor="client-search">Search clients</label>
              <input
                id="client-search"
                type="search"
                placeholder="Name, Fiverr username, or email"
                value={query.text}
                onChange={(event) => update({ text: event.target.value })}
              />
            </div>

            <div className="field">
              <label htmlFor="client-sort">Sort by</label>
              <select
                id="client-sort"
                value={query.sort}
                onChange={(event) => update({ sort: event.target.value as SortOrder })}
              >
                {sortOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <fieldset className="segmented">
              <legend>Status</legend>
              {statusOptions.map((option) => (
                <label key={option.value} className={query.status === option.value ? 'selected' : undefined}>
                  <input
                    type="radio"
                    name="status"
                    value={option.value}
                    checked={query.status === option.value}
                    onChange={() => update({ status: option.value })}
                  />
                  {option.label}
                </label>
              ))}
            </fieldset>

            <fieldset className="chips">
              <legend>Source</legend>
              {allSources.map((source) => (
                <label key={source} className={query.sources.includes(source) ? 'selected' : undefined}>
                  <input
                    type="checkbox"
                    checked={query.sources.includes(source)}
                    onChange={() => toggleSource(source)}
                  />
                  {sourceLabels[source]}
                </label>
              ))}
            </fieldset>
          </div>

          <p className="result-count" role="status">
            {results.length === 1 ? '1 client' : `${results.length} clients`}
            {isFiltered && (
              <>
                {' · '}
                <button type="button" className="link-button" onClick={() => setParams(new URLSearchParams())}>
                  Clear search and filters
                </button>
              </>
            )}
          </p>

          {results.length === 0 ? (
            <div className="empty-state empty-state-compact">
              <h2>No matching clients</h2>
              <p>
                {query.text ? `Nothing matches “${query.text}”.` : 'No clients match these filters.'}
                {query.status === 'active' && ' Archived clients are hidden; choose “All” to include them.'}
              </p>
            </div>
          ) : (
            <table className="client-table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Contact</th>
                  <th scope="col">Source</th>
                  <th scope="col">Last updated</th>
                  {query.status !== 'active' && <th scope="col">Status</th>}
                </tr>
              </thead>
              <tbody>
                {results.map((client) => (
                  <tr key={client.id} className={client.status === 'archived' ? 'is-archived' : undefined}>
                    <th scope="row">
                      <Link to={`/clients/${client.id}`}>{client.displayName}</Link>
                    </th>
                    <td className="contact-cell">
                      {client.fiverrUsername && <span>@{client.fiverrUsername}</span>}
                      {client.email && <span>{client.email}</span>}
                      {!client.fiverrUsername && !client.email && (
                        <span className="muted">{client.otherContact ? 'See profile' : 'No contact details'}</span>
                      )}
                    </td>
                    <td>
                      <SourceTag source={client.source} />
                    </td>
                    <td>{formatDate(client.updatedAt)}</td>
                    {query.status !== 'active' && (
                      <td>
                        <StatusBadge status={client.status} />
                      </td>
                    )}
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
