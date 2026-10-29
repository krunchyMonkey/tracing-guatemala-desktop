import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { useClientStore } from '../clients/ClientStore'
import { Alert, SourceTag, StatusBadge, formatDate } from '../clients/components'
import {
  defaultQuery,
  sourceLabels,
  type Client,
  type ClientSource,
  type DirectoryQuery,
  type SortOrder,
  type StatusFilter
} from '../clients/model'

// Client directory (#3 baseline). Search, filters and sort run in the main
// process (clients:list, #7); the filters live in the URL.

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

/** Matches the clients:list contract limit. */
const SEARCH_MAX = 200

// Filters live in the URL so they survive opening a profile and coming back.
function readQuery(params: URLSearchParams): DirectoryQuery {
  const status = params.get('status')
  const sort = params.get('sort')
  return {
    text: (params.get('q') ?? '').slice(0, SEARCH_MAX),
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

type DirectoryResults = { state: 'loading' | 'ready' | 'error'; clients: Client[] }

/**
 * Query results for the directory. Previous results stay visible while a new
 * query runs, and a slower, older response never replaces a newer one.
 */
function useDirectoryResults(query: DirectoryQuery): DirectoryResults & { retry(): void } {
  const { clients, searchClients } = useClientStore()
  const [results, setResults] = useState<DirectoryResults>({ state: 'loading', clients: [] })
  const [attempt, setAttempt] = useState(0)
  const key = JSON.stringify(query)

  useEffect(() => {
    let current = true
    const parsed = JSON.parse(key) as DirectoryQuery
    searchClients(parsed).then(
      (list) => {
        if (current) setResults({ state: 'ready', clients: list })
      },
      () => {
        if (current) setResults((r) => ({ state: 'error', clients: r.clients }))
      }
    )
    return () => {
      current = false
    }
    // `clients` changes after every save, so the results refresh with it.
  }, [key, clients, searchClients, attempt])

  return { ...results, retry: () => setAttempt((n) => n + 1) }
}

export function ClientsScreen() {
  const { clients, rememberDirectorySearch } = useClientStore()
  const [params, setParams] = useSearchParams()
  const query = readQuery(params)
  const directory = useDirectoryResults(query)
  const search = params.toString()
  // URL updates commit asynchronously, so quick successive changes (a filter
  // click, then typing) build on the last query written, not the last rendered.
  const pending = useRef(query)

  useEffect(() => {
    pending.current = readQuery(new URLSearchParams(search))
    rememberDirectorySearch(search ? `?${search}` : '')
  }, [search, rememberDirectorySearch])
  const results = directory.clients
  const isFiltered = query.text !== '' || query.sources.length > 0 || query.status !== defaultQuery.status
  const activeCount = clients.filter((c) => c.status === 'active').length

  const update = (patch: Partial<DirectoryQuery>) => {
    pending.current = { ...pending.current, ...patch }
    setParams(writeQuery(pending.current), { replace: true })
  }
  const toggleSource = (source: ClientSource) => {
    const { sources } = pending.current
    update({ sources: sources.includes(source) ? sources.filter((s) => s !== source) : [...sources, source] })
  }

  return (
    <section aria-labelledby="clients-heading" className="clients">

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
                maxLength={SEARCH_MAX}
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

          {directory.state === 'error' && (
            <Alert tone="error" title="Search isn’t working right now">
              <p>Your clients are safe. Try again, or restart the app if this keeps happening.</p>
              <button type="button" className="button button-secondary" onClick={directory.retry}>
                Try again
              </button>
            </Alert>
          )}

          <p className="result-count" role="status">
            {directory.state === 'loading' && results.length === 0
              ? 'Searching…'
              : results.length === 1
                ? '1 client'
                : `${results.length} clients`}
            {isFiltered && (
              <>
                {' · '}
                <button type="button" className="link-button" onClick={() => update(defaultQuery)}>
                  Clear search and filters
                </button>
              </>
            )}
          </p>

          {directory.state !== 'ready' && results.length === 0 ? null : results.length === 0 ? (
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
                    <td className="contact-cell" data-label="Contact">
                      {client.fiverrUsername && <span>@{client.fiverrUsername}</span>}
                      {client.email && <span>{client.email}</span>}
                      {!client.fiverrUsername && !client.email && (
                        <span className="muted">{client.otherContact ? 'See profile' : 'No contact details'}</span>
                      )}
                    </td>
                    <td data-label="Source">
                      <SourceTag source={client.source} />
                    </td>
                    <td data-label="Last updated">{formatDate(client.updatedAt)}</td>
                    {query.status !== 'active' && (
                      <td data-label="Status">
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
