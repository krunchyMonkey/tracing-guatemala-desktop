import { useState, type FormEvent } from 'react'
import { Link, useLocation, useParams } from 'react-router'
import { useClientStore } from '../clients/ClientStore'
import {
  Alert,
  ConfirmDialog,
  SourceTag,
  StatusBadge,
  formatDate,
  formatDateTime
} from '../clients/components'
import {
  NOTE_MAX,
  channelLabels,
  type Client,
  type ClientNote,
  type NoteChannel,
  type NoteDirection
} from '../clients/model'

// Client profile (#3 baseline). Client details and archive/restore are saved
// (#6); notes are session-only until #9. Orders and research cases are a
// labeled placeholder for later phases.

type HistoryFilter = 'all' | 'note' | 'contact'

export function ClientProfileScreen() {
  const { id } = useParams()
  const store = useClientStore()
  const location = useLocation()
  const flash = (location.state as { flash?: string } | null)?.flash
  const [pending, setPending] = useState<'archive' | 'restore' | null>(null)
  const [actionFailed, setActionFailed] = useState(false)
  const [working, setWorking] = useState(false)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)

  const client = store.clients.find((c) => c.id === id)
  if (!client) {
    return (
      <section aria-labelledby="profile-heading">
        <h1 id="profile-heading">Client not found</h1>
        <p>This link doesn’t match any saved client.</p>
        <Link to={store.directoryHref}>Back to clients</Link>
      </section>
    )
  }

  const isArchived = client.status === 'archived'
  const history = store.notes
    .filter((n) => n.clientId === client.id)
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))

  async function confirmStatusChange() {
    if (!client || !pending || working) return
    const action = pending
    setPending(null)
    setWorking(true)
    setStatusMessage(null)
    const result = action === 'archive' ? await store.archiveClient(client.id) : await store.restoreClient(client.id)
    setWorking(false)
    setActionFailed(!result.ok)
    if (result.ok) setStatusMessage(action === 'archive' ? 'Client archived.' : 'Client restored.')
  }

  return (
    <section aria-labelledby="profile-heading" className="profile">
      <p className="breadcrumb">
        <Link to={store.directoryHref}>← Clients</Link>
      </p>

      <div role="status" className="flash-region">
        {(statusMessage ?? flash) && <p className="flash">{statusMessage ?? flash}</p>}
      </div>
      {actionFailed && (
        <Alert tone="error" title="That didn’t work">
          The client’s status couldn’t be changed. Nothing was lost; please try again.
        </Alert>
      )}

      {isArchived && client.archivedAt && (
        <div className="archived-banner">
          <p>
            <strong>Archived on {formatDate(client.archivedAt)}.</strong> This profile is read-only. Restore it to make
            changes or add notes.
          </p>
        </div>
      )}

      <header className="profile-header">
        <div className="avatar" aria-hidden="true">
          {initials(client.displayName)}
        </div>
        <div className="profile-title">
          <h1 id="profile-heading">{client.displayName}</h1>
          <p className="profile-meta">
            <StatusBadge status={client.status} /> <SourceTag source={client.source} />
            <span className="muted">Client since {formatDate(client.createdAt)}</span>
          </p>
        </div>
        <div className="profile-actions">
          {isArchived ? (
            <button type="button" className="button button-primary" disabled={working} onClick={() => setPending('restore')}>
              Restore client
            </button>
          ) : (
            <>
              <Link className="button button-primary" to={`/clients/${client.id}/edit`}>
                Edit details
              </Link>
              <button
                type="button"
                className="button button-secondary"
                disabled={working}
                onClick={() => setPending('archive')}
              >
                Archive
              </button>
            </>
          )}
        </div>
      </header>

      <div className="profile-grid">
        <ContactCard client={client} />
        <DetailsCard client={client} />
      </div>

      <section className="card placeholder-card" aria-labelledby="orders-heading">
        <h2 id="orders-heading">Orders &amp; research cases</h2>
        <p className="muted">
          Planned for a later phase. For now, record orders and custom offers as notes below, for example “Custom
          offer sent: Premium package, adjusted price”.
        </p>
      </section>

      <History clientId={client.id} history={history} readOnly={isArchived} />

      {pending && (
        <ConfirmDialog
          title={pending === 'archive' ? `Archive ${client.displayName}?` : `Restore ${client.displayName}?`}
          confirmLabel={pending === 'archive' ? 'Archive client' : 'Restore client'}
          onCancel={() => setPending(null)}
          onConfirm={() => void confirmStatusChange()}
        >
          {pending === 'archive' ? (
            <p>
              They’ll be hidden from your active clients. <strong>Nothing is deleted:</strong> their details and notes
              stay, and you can restore them at any time.
            </p>
          ) : (
            <p>They’ll appear in your active clients again, with all their details and notes.</p>
          )}
        </ConfirmDialog>
      )}
    </section>
  )
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter((part) => /^\p{L}/u.test(part))
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('')
}

function ContactCard({ client }: { client: Client }) {
  const rows: { label: string; value: string | null; channel: Client['preferredContactChannel'] }[] = [
    { label: 'Fiverr', value: client.fiverrUsername && `@${client.fiverrUsername}`, channel: 'fiverr' },
    { label: 'Email', value: client.email, channel: 'email' },
    { label: 'Other', value: client.otherContact, channel: 'other' }
  ]
  return (
    <section className="card" aria-labelledby="contact-heading">
      <h2 id="contact-heading">Contact</h2>
      <dl className="detail-list">
        {rows.map((row) => (
          <div key={row.label}>
            <dt>
              {row.label}
              {client.preferredContactChannel === row.channel && <span className="preferred-tag">Preferred</span>}
            </dt>
            <dd className={row.value ? undefined : 'muted'}>{row.value ?? 'Not added'}</dd>
          </div>
        ))}
        {client.preferredContactChannel === 'unspecified' && (
          <div>
            <dt>Preferred</dt>
            <dd className="muted">{channelLabels.unspecified}</dd>
          </div>
        )}
      </dl>
    </section>
  )
}

function DetailsCard({ client }: { client: Client }) {
  return (
    <section className="card" aria-labelledby="details-heading">
      <h2 id="details-heading">Details</h2>
      <dl className="detail-list">
        <div>
          <dt>Source details</dt>
          <dd className={client.sourceDetail ? undefined : 'muted'}>{client.sourceDetail ?? 'Not added'}</dd>
        </div>
        <div>
          <dt>Added</dt>
          <dd>{formatDateTime(client.createdAt)}</dd>
        </div>
        <div>
          <dt>Last updated</dt>
          <dd>{formatDateTime(client.updatedAt)}</dd>
        </div>
      </dl>
    </section>
  )
}

const kindLabels: Record<ClientNote['kind'], string> = { note: 'Note', contact: 'Contact', system: 'Status change' }
const directionLabels: Record<NoteDirection, string> = { inbound: 'Received', outbound: 'Sent' }
const noteChannelLabels: Record<NoteChannel, string> = { fiverr: 'Fiverr', email: 'Email', other: 'Other' }

function History({ clientId, history, readOnly }: { clientId: string; history: ClientNote[]; readOnly: boolean }) {
  const [filter, setFilter] = useState<HistoryFilter>('all')
  const visible = history.filter((n) => filter === 'all' || n.kind === filter)

  return (
    <section className="card history" aria-labelledby="history-heading">
      <div className="history-header">
        <h2 id="history-heading">Notes &amp; contact history</h2>
        <fieldset className="segmented segmented-small">
          <legend className="visually-hidden">Show</legend>
          {(['all', 'note', 'contact'] as const).map((value) => (
            <label key={value} className={filter === value ? 'selected' : undefined}>
              <input
                type="radio"
                name="history-filter"
                value={value}
                checked={filter === value}
                onChange={() => setFilter(value)}
              />
              {value === 'all' ? 'All' : value === 'note' ? 'Notes' : 'Contact log'}
            </label>
          ))}
        </fieldset>
      </div>

      <p className="hint-inline">
        Notes aren’t saved yet in this version: they disappear when you close the app. Client details and archive
        status are saved.
      </p>

      {!readOnly && <AddNoteForm clientId={clientId} />}

      {visible.length === 0 ? (
        <p className="muted empty-history">
          {history.length === 0 ? 'No notes or contact history yet.' : 'Nothing of this kind yet.'}
        </p>
      ) : (
        <ol className="timeline">
          {visible.map((note) => (
            <li key={note.id} className={`timeline-item kind-${note.kind}`}>
              <p className="timeline-meta">
                <span className="kind-label">{kindLabels[note.kind]}</span>
                {note.kind === 'contact' && note.direction && note.channel && (
                  <span>
                    {directionLabels[note.direction]} · {noteChannelLabels[note.channel]}
                  </span>
                )}
                <time dateTime={note.occurredAt}>{formatDateTime(note.occurredAt)}</time>
              </p>
              <p className="timeline-body">{note.body}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

function AddNoteForm({ clientId }: { clientId: string }) {
  const { addNote } = useClientStore()
  const [kind, setKind] = useState<'note' | 'contact'>('note')
  const [channel, setChannel] = useState<NoteChannel>('fiverr')
  const [direction, setDirection] = useState<NoteDirection>('outbound')
  const [body, setBody] = useState('')
  const [error, setError] = useState<string | null>(null)

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    const text = body.trim()
    if (text === '') return setError('Write something before adding it.')
    if (text.length > NOTE_MAX) return setError(`Keep entries under ${NOTE_MAX.toLocaleString()} characters.`)
    addNote(clientId, {
      kind,
      occurredAt: new Date().toISOString(),
      channel: kind === 'contact' ? channel : null,
      direction: kind === 'contact' ? direction : null,
      body: text
    })
    setBody('')
    setError(null)
  }

  return (
    <form className="add-note" onSubmit={onSubmit} noValidate>
      <fieldset className="segmented segmented-small">
        <legend>Add</legend>
        <label className={kind === 'note' ? 'selected' : undefined}>
          <input type="radio" name="note-kind" checked={kind === 'note'} onChange={() => setKind('note')} />
          Note
        </label>
        <label className={kind === 'contact' ? 'selected' : undefined}>
          <input type="radio" name="note-kind" checked={kind === 'contact'} onChange={() => setKind('contact')} />
          Logged contact
        </label>
      </fieldset>

      {kind === 'contact' && (
        <div className="field-grid">
          <div className="field">
            <label htmlFor="note-direction">Message</label>
            <select
              id="note-direction"
              value={direction}
              onChange={(e) => setDirection(e.target.value as NoteDirection)}
            >
              <option value="outbound">I sent</option>
              <option value="inbound">I received</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="note-channel">Via</label>
            <select id="note-channel" value={channel} onChange={(e) => setChannel(e.target.value as NoteChannel)}>
              {(Object.keys(noteChannelLabels) as NoteChannel[]).map((c) => (
                <option key={c} value={c}>
                  {noteChannelLabels[c]}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      <div className={`field${error ? ' field-invalid' : ''}`}>
        <label htmlFor="note-body">{kind === 'note' ? 'Your note' : 'What was said'}</label>
        <textarea
          id="note-body"
          rows={3}
          value={body}
          aria-invalid={error !== null}
          aria-describedby={error ? 'note-error' : 'note-hint'}
          onChange={(e) => {
            setBody(e.target.value)
            setError(null)
          }}
        />
        {error ? (
          <p id="note-error" className="field-issues issue-error" role="alert">
            {error}
          </p>
        ) : (
          <p id="note-hint" className="hint">
            Private to you. Contact entries are a record only; nothing is sent.
          </p>
        )}
      </div>
      <button type="submit" className="button button-secondary">
        Add {kind === 'note' ? 'note' : 'contact entry'}
      </button>
    </form>
  )
}
