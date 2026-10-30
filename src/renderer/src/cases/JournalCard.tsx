import { useCallback, useEffect, useId, useState, type FormEvent } from 'react'
import {
  checkJournalEntry,
  compareJournalEntries,
  isJournalEntryEdited,
  JOURNAL_ACTIVITY_MAX,
  JOURNAL_ACTIVITY_SUGGESTIONS,
  JOURNAL_BODY_MAX,
  type JournalEntry,
  type JournalEntryInput,
  type JournalIssue,
  type JournalMutationResult
} from '../../../shared/case-journal'
import { Alert, ConfirmDialog, formatDate, formatDateTime } from '../clients/components'
import { fromLocalInput, toLocalInput } from '../clients/localTime'
import { useCaseApi } from './useCaseApi'

// The case's research journal (#18): a dated log of the work done on this case.
// It is the researcher's own record and is separate from the client's notes and
// contact history. Saved text is shown as plain text, never as markup. Typed text
// is kept whenever a save fails.

const issueMessages: Record<JournalIssue['field'], Partial<Record<JournalIssue['code'], string>>> = {
  body: {
    required: 'Write what you did or found before adding it.',
    'too-long': `Keep an entry under ${JOURNAL_BODY_MAX.toLocaleString()} characters.`,
    'invalid-characters': 'This text has a character that can’t be saved. Remove it and try again.'
  },
  activity: {
    'too-long': `Keep the activity under ${JOURNAL_ACTIVITY_MAX} characters.`,
    'invalid-characters': 'The activity has a character that can’t be saved. Remove it and try again.'
  },
  occurredAt: {
    'invalid-format': 'Choose a date and time.',
    'in-future': 'This date is in the future. Choose when the work happened.'
  }
}

const saveMessages: Record<'failed' | 'not-found' | 'wrong-status', string> = {
  failed: 'Couldn’t save this entry. Your text is still here; please try again.',
  'not-found': 'This entry or case couldn’t be found any more. Copy your text if you need it.',
  'wrong-status': 'This case or its client is archived, so the journal can’t be changed.'
}

type SaveResult = JournalMutationResult | { ok: false; reason: 'failed' }

interface JournalCardProps {
  caseId: string
  readOnly: boolean
  /** Why the journal can't be changed, shown when readOnly. */
  readOnlyReason: string
}

export function JournalCard({ caseId, readOnly, readOnlyReason }: JournalCardProps) {
  const api = useCaseApi()
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [entries, setEntries] = useState<JournalEntry[]>([])
  const [attempt, setAttempt] = useState(0)
  const [editingId, setEditingId] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    api.listJournalEntries(caseId).then(
      (list) => {
        if (!current) return
        setEntries([...list].sort(compareJournalEntries))
        setState('ready')
      },
      () => {
        if (current) setState('error')
      }
    )
    return () => {
      current = false
    }
  }, [api, caseId, attempt])

  const save = useCallback(async (call: () => Promise<JournalMutationResult>): Promise<SaveResult> => {
    let result: JournalMutationResult
    try {
      result = await call()
    } catch {
      return { ok: false, reason: 'failed' }
    }
    if (result.ok) {
      const saved = result.entry
      setEntries((list) => [...list.filter((e) => e.id !== saved.id), saved].sort(compareJournalEntries))
    }
    return result
  }, [])

  return (
    <section className="card journal" aria-labelledby="case-journal-heading">
      <h2 id="case-journal-heading">Research journal</h2>
      <p className="hint journal-intro">
        Your dated log of the work on this case: what you searched, found and decided. It is separate from the client’s
        notes and contact history, which you’ll find on their profile.
      </p>

      {readOnly ? (
        <p className="muted journal-readonly">{readOnlyReason}</p>
      ) : (
        <JournalEditor key="new" onSave={(input) => save(() => api.createJournalEntry(caseId, input))} />
      )}

      {state === 'error' ? (
        <Alert tone="error" title="The journal couldn’t be loaded">
          <p>Nothing was changed or lost.</p>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => {
              setState('loading')
              setAttempt((n) => n + 1)
            }}
          >
            Try again
          </button>
        </Alert>
      ) : state === 'loading' ? (
        <p className="muted" role="status">
          Loading the journal…
        </p>
      ) : entries.length === 0 ? (
        <p className="muted journal-empty">No journal entries yet.</p>
      ) : (
        <ol className="timeline journal-list" aria-label="Journal entries, newest first">
          {entries.map((entry) => (
            <li key={entry.id} className="timeline-item kind-journal">
              {editingId === entry.id ? (
                <JournalEditor
                  entry={entry}
                  onSave={async (input) => {
                    const result = await save(() => api.updateJournalEntry(caseId, entry.id, input))
                    if (result.ok) setEditingId(null)
                    return result
                  }}
                  onCancel={() => setEditingId(null)}
                />
              ) : (
                <JournalView
                  entry={entry}
                  onEdit={readOnly || editingId !== null ? null : () => setEditingId(entry.id)}
                />
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

function JournalView({ entry, onEdit }: { entry: JournalEntry; onEdit: (() => void) | null }) {
  return (
    <>
      <p className="timeline-meta">
        <time dateTime={entry.occurredAt}>{formatDateTime(entry.occurredAt)}</time>
        {entry.activity && <span className="kind-label journal-activity">{entry.activity}</span>}
        {isJournalEntryEdited(entry) && (
          <span className="muted" title={`Edited ${formatDateTime(entry.updatedAt)}`}>
            Edited {formatDate(entry.updatedAt)}
          </span>
        )}
      </p>
      <p className="timeline-body preserve-lines">{entry.body}</p>
      {onEdit && (
        <button
          type="button"
          className="button button-small button-ghost"
          aria-label={`Edit journal entry from ${formatDateTime(entry.occurredAt)}`}
          onClick={onEdit}
        >
          Edit
        </button>
      )}
    </>
  )
}

interface JournalEditorProps {
  /** The entry being edited; omitted when adding. */
  entry?: JournalEntry
  onSave(input: JournalEntryInput): Promise<SaveResult>
  onCancel?(): void
}

function JournalEditor({ entry, onSave, onCancel }: JournalEditorProps) {
  const id = useId()
  const isEdit = entry !== undefined
  const initialWhen = toLocalInput(entry?.occurredAt ?? new Date().toISOString())
  const [when, setWhen] = useState(initialWhen)
  const [activity, setActivity] = useState(entry?.activity ?? '')
  const [body, setBody] = useState(entry?.body ?? '')
  const [errors, setErrors] = useState<Partial<Record<JournalIssue['field'], string>>>({})
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)

  const input: JournalEntryInput = { occurredAt: fromLocalInput(when), activity: activity === '' ? null : activity, body }
  const dirty = isEdit && (body !== entry.body || when !== initialWhen || (entry.activity ?? '') !== activity)

  function showIssues(issues: JournalIssue[]) {
    setErrors(
      Object.fromEntries(issues.map((issue) => [issue.field, issueMessages[issue.field][issue.code] ?? 'Check this field.']))
    )
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (saving) return
    setSaveError(null)
    const { issues } = checkJournalEntry(input)
    if (issues.length > 0) return showIssues(issues)

    setSaving(true)
    const result = await onSave(input)
    setSaving(false)
    if (result.ok) {
      setErrors({})
      if (!isEdit) {
        setBody('')
        setActivity('')
        setWhen(toLocalInput(new Date().toISOString()))
      }
    } else if (result.reason === 'invalid') {
      showIssues(result.issues)
    } else {
      setSaveError(saveMessages[result.reason])
    }
  }

  function cancel() {
    if (dirty) setConfirmDiscard(true)
    else onCancel?.()
  }

  const clear = (field: JournalIssue['field']) => setErrors((current) => ({ ...current, [field]: undefined }))
  const listId = `${id}-activities`

  return (
    <form
      className="add-note journal-form"
      onSubmit={onSubmit}
      noValidate
      aria-label={isEdit ? 'Edit journal entry' : 'Add a journal entry'}
    >
      <div className="field-grid">
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
              clear('occurredAt')
            }}
          />
          {errors.occurredAt && (
            <p id={`${id}-when-error`} className="field-issues issue-error" role="alert">
              {errors.occurredAt}
            </p>
          )}
        </div>
        <div className={`field${errors.activity ? ' field-invalid' : ''}`}>
          <label htmlFor={`${id}-activity`}>Activity (optional)</label>
          <input
            id={`${id}-activity`}
            type="text"
            list={listId}
            value={activity}
            autoComplete="off"
            aria-invalid={errors.activity !== undefined}
            aria-describedby={errors.activity ? `${id}-activity-error` : undefined}
            onChange={(e) => {
              setActivity(e.target.value)
              clear('activity')
            }}
          />
          <datalist id={listId}>
            {JOURNAL_ACTIVITY_SUGGESTIONS.map((suggestion) => (
              <option key={suggestion} value={suggestion} />
            ))}
          </datalist>
          {errors.activity && (
            <p id={`${id}-activity-error`} className="field-issues issue-error" role="alert">
              {errors.activity}
            </p>
          )}
        </div>
      </div>

      <div className={`field${errors.body ? ' field-invalid' : ''}`}>
        <label htmlFor={`${id}-body`}>{isEdit ? 'Entry' : 'What you did or found'}</label>
        <textarea
          id={`${id}-body`}
          rows={4}
          value={body}
          aria-invalid={errors.body !== undefined}
          aria-describedby={errors.body ? `${id}-body-error` : `${id}-body-hint`}
          onChange={(e) => {
            setBody(e.target.value)
            clear('body')
          }}
        />
        {errors.body ? (
          <p id={`${id}-body-error`} className="field-issues issue-error" role="alert">
            {errors.body}
          </p>
        ) : (
          <p id={`${id}-body-hint`} className="hint">
            Private to you. You can back-date an entry to when the work happened.
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
          {saving ? 'Saving…' : saveError ? 'Try again' : isEdit ? 'Save changes' : 'Add entry'}
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
