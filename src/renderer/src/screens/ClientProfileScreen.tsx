import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
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
  checkNote,
  isEdited,
  type Client,
  type ClientNote,
  type NoteChannel,
  type NoteDirection,
  type NoteInput,
  type NoteIssue
} from '../clients/model'
import { ClientCases } from '../cases/ClientCases'
import { useAppRuntime } from '../runtime/AppRuntime'
import { useClientNotes, type NoteSaveResult } from '../clients/useClientNotes'
import { fromLocalInput, toLocalInput } from '../clients/localTime'

// Client profile (#3 baseline). Reads the saved client when opened (#8);
// archive/restore (#6) and notes/contact log (#9) are saved through the main
// process. Orders and research cases are a labeled placeholder for later phases.

type HistoryFilter = 'all' | 'note' | 'contact'

export function ClientProfileScreen() {
  const { id } = useParams()
  const store = useClientStore()
  const { cases } = useAppRuntime()
  const location = useLocation()
  const flash = (location.state as { flash?: string } | null)?.flash
  const [pending, setPending] = useState<'archive' | 'restore' | null>(null)
  const [actionFailed, setActionFailed] = useState(false)
  const [working, setWorking] = useState(false)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const { refreshClient } = store

  useEffect(() => {
    if (id !== undefined) void refreshClient(id)
  }, [id, refreshClient])

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
    // The button that opened the dialog is replaced, so move focus somewhere stable.
    requestAnimationFrame(() => headingRef.current?.focus())
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
          <h1 id="profile-heading" ref={headingRef} tabIndex={-1}>
            {client.displayName}
          </h1>
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

      {cases ? (
        <ClientCases client={client} api={cases} />
      ) : (
        <section className="card placeholder-card" aria-labelledby="orders-heading">
          <h2 id="orders-heading">Orders &amp; research cases</h2>
          <p className="muted">
            Planned for a later phase. For now, record orders and custom offers as notes below, for example “Custom
            offer sent: Premium package, adjusted price”.
          </p>
        </section>
      )}

      {/* Archive and restore add system entries, so the history re-reads when the client changes. */}
      <History clientId={client.id} version={client.updatedAt} readOnly={isArchived} />

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

const noteIssueMessages: Record<NoteIssue['code'], string> = {
  required: 'Write something before adding it.',
  'too-long': `Keep entries under ${NOTE_MAX.toLocaleString()} characters.`,
  'invalid-format': 'Choose a date and time.',
  'in-future': 'This date is in the future. Choose when it happened.'
}

const noteSaveMessages: Record<'failed' | 'not-found' | 'wrong-status', string> = {
  failed: 'Couldn’t save this entry. Your text is still here; please try again.',
  'not-found': 'This entry or client couldn’t be found any more. Copy your text if you need it.',
  'wrong-status': 'This client is archived, so entries can’t be changed. Restore the client first.'
}

function History({ clientId, version, readOnly }: { clientId: string; version: string; readOnly: boolean }) {
  const notes = useClientNotes(clientId, version)
  const [filter, setFilter] = useState<HistoryFilter>('all')
  const [editingId, setEditingId] = useState<string | null>(null)
  const visible = notes.notes.filter((n) => filter === 'all' || n.kind === filter)

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

      {!readOnly && <NoteEditor key="new" onSave={notes.create} />}

      {notes.state === 'error' ? (
        <Alert tone="error" title="Notes couldn’t be loaded">
          <p>Nothing was changed or lost.</p>
          <button type="button" className="button button-secondary" onClick={notes.retry}>
            Try again
          </button>
        </Alert>
      ) : notes.state === 'loading' ? (
        <p className="muted empty-history" role="status">
          Loading notes…
        </p>
      ) : visible.length === 0 ? (
        <p className="muted empty-history">
          {notes.notes.length === 0 ? 'No notes or contact history yet.' : 'Nothing of this kind yet.'}
        </p>
      ) : (
        <ol className="timeline">
          {visible.map((note) => (
            <li key={note.id} className={`timeline-item kind-${note.kind}`}>
              {editingId === note.id ? (
                <NoteEditor
                  note={note}
                  onSave={async (input) => {
                    const result = await notes.update(note.id, input)
                    if (result.ok) setEditingId(null)
                    return result
                  }}
                  onCancel={() => setEditingId(null)}
                />
              ) : (
                <NoteView
                  note={note}
                  onEdit={readOnly || note.kind === 'system' || editingId !== null ? null : () => setEditingId(note.id)}
                />
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

function NoteView({ note, onEdit }: { note: ClientNote; onEdit: (() => void) | null }) {
  return (
    <>
      <p className="timeline-meta">
        <span className="kind-label">{kindLabels[note.kind]}</span>
        {note.kind === 'contact' && note.direction && note.channel && (
          <span>
            {directionLabels[note.direction]} · {noteChannelLabels[note.channel]}
          </span>
        )}
        <time dateTime={note.occurredAt}>{formatDateTime(note.occurredAt)}</time>
        {isEdited(note) && (
          <span className="muted" title={`Edited ${formatDateTime(note.updatedAt)}`}>
            Edited {formatDate(note.updatedAt)}
          </span>
        )}
      </p>
      <p className="timeline-body">{note.body}</p>
      {onEdit && (
        <button
          type="button"
          className="button button-small button-ghost"
          aria-label={`Edit ${kindLabels[note.kind].toLowerCase()} from ${formatDateTime(note.occurredAt)}`}
          onClick={onEdit}
        >
          Edit
        </button>
      )}
    </>
  )
}

interface NoteEditorProps {
  /** The entry being edited; omitted when adding. */
  note?: ClientNote
  onSave(input: NoteInput): Promise<NoteSaveResult>
  onCancel?(): void
}

/** Add or edit a note or logged contact. Typed text is kept whenever a save fails. */
function NoteEditor({ note, onSave, onCancel }: NoteEditorProps) {
  const id = useId()
  const isEdit = note !== undefined
  const [kind, setKind] = useState<NoteInput['kind']>(note?.kind === 'contact' ? 'contact' : 'note')
  const [channel, setChannel] = useState<NoteChannel>(note?.channel ?? 'fiverr')
  const [direction, setDirection] = useState<NoteDirection>(note?.direction ?? 'outbound')
  const [body, setBody] = useState(note?.body ?? '')
  const initialWhen = toLocalInput(note?.occurredAt ?? new Date().toISOString())
  const [when, setWhen] = useState(initialWhen)
  const [errors, setErrors] = useState<Partial<Record<NoteIssue['field'], string>>>({})
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)

  const input: NoteInput = {
    kind,
    occurredAt: fromLocalInput(when),
    channel: kind === 'contact' ? channel : null,
    direction: kind === 'contact' ? direction : null,
    body
  }
  const dirty =
    isEdit &&
    (body !== note.body || when !== initialWhen || input.channel !== note.channel || input.direction !== note.direction)

  function showIssues(issues: NoteIssue[]) {
    setErrors(Object.fromEntries(issues.map((issue) => [issue.field, noteIssueMessages[issue.code]])))
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (saving) return
    setSaveError(null)
    const { issues } = checkNote(input)
    if (issues.length > 0) return showIssues(issues)

    setSaving(true)
    const result = await onSave(input)
    setSaving(false)
    if (result.ok) {
      setErrors({})
      if (!isEdit) {
        setBody('')
        setWhen(toLocalInput(new Date().toISOString()))
      }
    } else if (result.reason === 'invalid') {
      showIssues(result.issues)
    } else {
      setSaveError(noteSaveMessages[result.reason])
    }
  }

  function cancel() {
    if (dirty) setConfirmDiscard(true)
    else onCancel?.()
  }

  const noun = kind === 'note' ? 'note' : 'contact entry'
  // The form itself is named "Edit note" when editing, so the text box keeps a plain label.
  const bodyLabel = kind === 'note' ? (isEdit ? 'Note' : 'Your note') : 'What was said'

  return (
    <form className="add-note" onSubmit={onSubmit} noValidate aria-label={isEdit ? `Edit ${noun}` : `Add a ${noun}`}>
      {!isEdit && (
        <fieldset className="segmented segmented-small">
          <legend>Add</legend>
          <label className={kind === 'note' ? 'selected' : undefined}>
            <input type="radio" name={`${id}-kind`} checked={kind === 'note'} onChange={() => setKind('note')} />
            Note
          </label>
          <label className={kind === 'contact' ? 'selected' : undefined}>
            <input
              type="radio"
              name={`${id}-kind`}
              checked={kind === 'contact'}
              onChange={() => setKind('contact')}
            />
            Logged contact
          </label>
        </fieldset>
      )}

      <div className="field-grid">
        {kind === 'contact' && (
          <>
            <div className="field">
              <label htmlFor={`${id}-direction`}>Message</label>
              <select
                id={`${id}-direction`}
                value={direction}
                onChange={(e) => setDirection(e.target.value as NoteDirection)}
              >
                <option value="outbound">I sent</option>
                <option value="inbound">I received</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor={`${id}-channel`}>Via</label>
              <select
                id={`${id}-channel`}
                value={channel}
                onChange={(e) => setChannel(e.target.value as NoteChannel)}
              >
                {(Object.keys(noteChannelLabels) as NoteChannel[]).map((c) => (
                  <option key={c} value={c}>
                    {noteChannelLabels[c]}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}
        <div className={`field${errors.occurredAt ? ' field-invalid' : ''}`}>
          <label htmlFor={`${id}-when`}>When</label>
          <input
            id={`${id}-when`}
            type="datetime-local"
            value={when}
            aria-invalid={errors.occurredAt !== undefined}
            aria-describedby={errors.occurredAt ? `${id}-when-error` : undefined}
            onChange={(e) => {
              setWhen(e.target.value)
              setErrors((current) => ({ ...current, occurredAt: undefined }))
            }}
          />
          {errors.occurredAt && (
            <p id={`${id}-when-error`} className="field-issues issue-error" role="alert">
              {errors.occurredAt}
            </p>
          )}
        </div>
      </div>

      <div className={`field${errors.body ? ' field-invalid' : ''}`}>
        <label htmlFor={`${id}-body`}>{bodyLabel}</label>
        <textarea
          id={`${id}-body`}
          rows={3}
          value={body}
          aria-invalid={errors.body !== undefined}
          aria-describedby={errors.body ? `${id}-body-error` : `${id}-body-hint`}
          onChange={(e) => {
            setBody(e.target.value)
            setErrors((current) => ({ ...current, body: undefined }))
          }}
        />
        {errors.body ? (
          <p id={`${id}-body-error`} className="field-issues issue-error" role="alert">
            {errors.body}
          </p>
        ) : (
          <p id={`${id}-body-hint`} className="hint">
            Private to you. Contact entries are a record only; nothing is sent.
          </p>
        )}
      </div>

      {saveError && (
        <Alert tone="error" title="Not saved">
          {saveError}
        </Alert>
      )}

      <div className="button-row">
        <button type="submit" className="button button-secondary" disabled={saving} aria-busy={saving}>
          {saving ? 'Saving…' : isEdit ? 'Save changes' : `Add ${noun}`}
        </button>
        {isEdit && (
          <button type="button" className="button button-ghost" onClick={cancel}>
            Cancel
          </button>
        )}
      </div>

      {confirmDiscard && (
        <ConfirmDialog
          title="Discard your changes?"
          confirmLabel="Discard changes"
          tone="caution"
          onCancel={() => setConfirmDiscard(false)}
          onConfirm={() => onCancel?.()}
        >
          <p>Your edits to this entry haven’t been saved.</p>
        </ConfirmDialog>
      )}
    </form>
  )
}
