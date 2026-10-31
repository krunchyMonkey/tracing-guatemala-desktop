import { useCallback, useEffect, useId, useState, type FormEvent } from 'react'
import {
  ACTIVITY_TYPES,
  checkTimeEntry,
  compareEntries,
  formatMinutes,
  summarizeEntries,
  TIME_NOTE_MAX,
  type ActivityType,
  type TimeEntry,
  type TimeEntryInput,
  type TimeEntryMutationResult,
  type TimeIssue
} from '../../../shared/case-time'
import { Alert, ConfirmDialog } from '../clients/components'
import { activityLabels, timeIssueMessages } from './hoursText'
import { formatDueDate, localDateString } from './model'
import { useCaseApi } from './useCaseApi'
import { ElapsedClock, useTimer } from './TimerContext'

// Research hours on the case (#109): totals, the timer, and the saved entries
// (from the timer or typed in by hand). Totals are for this case only and are
// computed from the entries listed here. Dates are local calendar dates. Saved
// text is shown as plain text. Typed text is kept whenever a save fails.

type SaveResult = TimeEntryMutationResult | { ok: false; reason: 'failed' }

const saveMessages: Record<'failed' | 'not-found' | 'wrong-status', string> = {
  failed: 'Couldn’t save this entry. What you typed is still here; please try again.',
  'not-found': 'This entry or case couldn’t be found any more.',
  'wrong-status': 'This case or its client is archived, so the hours can’t be changed.'
}

interface HoursCardProps {
  caseId: string
  caseTitle: string
  readOnly: boolean
  /** Why the hours can't be changed, shown when readOnly. */
  readOnlyReason: string
}

export function HoursCard({ caseId, caseTitle, readOnly, readOnlyReason }: HoursCardProps) {
  const api = useCaseApi()
  const timer = useTimer()
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [entries, setEntries] = useState<TimeEntry[]>([])
  const [attempt, setAttempt] = useState(0)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<TimeEntry | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const localToday = localDateString(new Date())
  const { entriesVersion } = timer

  useEffect(() => {
    let current = true
    api.listTimeEntries(caseId).then(
      (list) => {
        if (!current) return
        setEntries([...list].sort(compareEntries))
        setState('ready')
      },
      () => {
        if (current) setState('error')
      }
    )
    return () => {
      current = false
    }
  }, [api, caseId, attempt, entriesVersion])

  const save = useCallback(async (call: () => Promise<TimeEntryMutationResult>): Promise<SaveResult> => {
    let result: TimeEntryMutationResult
    try {
      result = await call()
    } catch {
      return { ok: false, reason: 'failed' }
    }
    if (result.ok) {
      const saved = result.entry
      setEntries((list) => [...list.filter((e) => e.id !== saved.id), saved].sort(compareEntries))
    }
    return result
  }, [])

  async function confirmDelete(entry: TimeEntry) {
    if (busy) return
    setBusy(true)
    setDeleteError(null)
    let result: TimeEntryMutationResult | null
    try {
      result = await api.deleteTimeEntry(caseId, entry.id)
    } catch {
      result = null
    }
    setBusy(false)
    setDeleting(null)
    if (result?.ok) setEntries((list) => list.filter((e) => e.id !== entry.id))
    else {
      setDeleteError('Couldn’t delete that entry. Nothing was changed; the list has been refreshed.')
      setAttempt((n) => n + 1)
    }
  }

  const totals = summarizeEntries(entries, localToday)
  const ownTimer = timer.timer !== null && timer.timer.caseId === caseId ? timer.timer : null

  return (
    <section className="card hours" aria-labelledby="case-hours-heading">
      <h2 id="case-hours-heading">Research hours</h2>
      <p className="hint hours-intro">Time you spend on this case, for your own records. Nothing here is billed or sent to anyone.</p>

      {state === 'ready' && (
        <dl className="hours-totals" aria-label="Hours on this case">
          <div>
            <dt>Total hours</dt>
            <dd>{formatMinutes(totals.totalMinutes)}</dd>
          </div>
          <div>
            <dt>This week</dt>
            <dd>{formatMinutes(totals.weekMinutes)}</dd>
          </div>
          <div>
            <dt>This month</dt>
            <dd>{formatMinutes(totals.monthMinutes)}</dd>
          </div>
        </dl>
      )}

      {readOnly ? (
        <p className="muted hours-readonly">{readOnlyReason}</p>
      ) : (
        <>
          <div className="hours-timer">
            {ownTimer ? (
              <p className="hours-timer-status">
                <span>Timer {ownTimer.state === 'paused' ? 'paused' : ownTimer.needsReview ? 'needs review' : 'running'} on this case:</span>{' '}
                <ElapsedClock timer={ownTimer} syncedAt={timer.syncedAt} /> <span className="muted">Use the timer at the top to pause or save it.</span>
              </p>
            ) : (
              <button
                type="button"
                className="button button-primary"
                disabled={timer.busy || !timer.loaded}
                aria-busy={timer.busy}
                onClick={() => timer.requestStart(caseId, caseTitle)}
              >
                Start timer
              </button>
            )}
          </div>
          <EntryForm key="new" onSave={(input) => save(() => api.createTimeEntry(caseId, input))} localToday={localToday} />
        </>
      )}

      {deleteError && (
        <Alert tone="error" title="Not deleted">
          {deleteError}
        </Alert>
      )}

      {state === 'error' ? (
        <Alert tone="error" title="The hours couldn’t be loaded">
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
          Loading the hours…
        </p>
      ) : entries.length === 0 ? (
        <p className="muted hours-empty">No hours recorded yet.</p>
      ) : (
        <ul className="hours-list" aria-label="Hours entries">
          {entries.map((entry) => (
            <li key={entry.id} id={`time-${entry.id}`} tabIndex={-1} className="hours-item">
              {editingId === entry.id ? (
                <EntryForm
                  entry={entry}
                  localToday={localToday}
                  onSave={async (input) => {
                    const result = await save(() => api.updateTimeEntry(caseId, entry.id, input))
                    if (result.ok) setEditingId(null)
                    return result
                  }}
                  onCancel={() => setEditingId(null)}
                />
              ) : (
                <EntryView
                  entry={entry}
                  onEdit={readOnly || editingId !== null ? null : () => setEditingId(entry.id)}
                  onDelete={readOnly ? null : () => setDeleting(entry)}
                />
              )}
            </li>
          ))}
        </ul>
      )}

      {deleting && (
        <ConfirmDialog
          title="Delete this entry?"
          confirmLabel="Delete entry"
          tone="caution"
          confirmDisabled={busy}
          onCancel={() => setDeleting(null)}
          onConfirm={() => void confirmDelete(deleting)}
        >
          <p>
            {formatMinutes(deleting.durationMinutes)} hours on <time dateTime={deleting.workDate}>{formatDueDate(deleting.workDate)}</time> will be removed
            from this case’s total. This can’t be undone.
          </p>
        </ConfirmDialog>
      )}
    </section>
  )
}

function EntryView({ entry, onEdit, onDelete }: { entry: TimeEntry; onEdit: (() => void) | null; onDelete: (() => void) | null }) {
  const label = `${formatMinutes(entry.durationMinutes)} on ${formatDueDate(entry.workDate)}`
  return (
    <>
      <div className="hours-main">
        <p className="hours-line">
          <span className="hours-duration">{formatMinutes(entry.durationMinutes)}</span>
          <time dateTime={entry.workDate}>{formatDueDate(entry.workDate)}</time>
          {entry.activityType && <span className="hours-tag">{activityLabels[entry.activityType]}</span>}
          <span className="muted">{entry.source === 'timer' ? 'From the timer' : 'Added by hand'}</span>
        </p>
        {entry.note && <p className="hours-note preserve-lines">{entry.note}</p>}
      </div>
      <div className="task-actions">
        {onEdit && (
          <button type="button" className="button button-small button-ghost" aria-label={`Edit entry: ${label}`} onClick={onEdit}>
            Edit
          </button>
        )}
        {onDelete && (
          <button type="button" className="button button-small button-ghost" aria-label={`Delete entry: ${label}`} onClick={onDelete}>
            Delete
          </button>
        )}
      </div>
    </>
  )
}

/** Hours and minutes typed as text become whole minutes; anything else is an invalid duration. */
function parseDuration(hours: string, minutes: string): number {
  const h = hours.trim() === '' ? 0 : Number(hours)
  const m = minutes.trim() === '' ? 0 : Number(minutes)
  if (!Number.isInteger(h) || !Number.isInteger(m) || m > 59) return Number.NaN
  return h * 60 + m
}

interface EntryFormProps {
  entry?: TimeEntry
  localToday: string
  onSave(input: TimeEntryInput): Promise<SaveResult>
  onCancel?(): void
}

function EntryForm({ entry, localToday, onSave, onCancel }: EntryFormProps) {
  const id = useId()
  const isEdit = entry !== undefined
  const [workDate, setWorkDate] = useState(entry?.workDate ?? localToday)
  const [hours, setHours] = useState(entry ? String(Math.floor(entry.durationMinutes / 60)) : '')
  const [minutes, setMinutes] = useState(entry ? String(entry.durationMinutes % 60) : '')
  const [activity, setActivity] = useState<ActivityType | ''>(entry?.activityType ?? '')
  const [note, setNote] = useState(entry?.note ?? '')
  const [errors, setErrors] = useState<Partial<Record<TimeIssue['field'], string>>>({})
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)

  const durationMinutes = parseDuration(hours, minutes)
  const input: TimeEntryInput = { workDate, durationMinutes, activityType: activity === '' ? null : activity, note: note === '' ? null : note }
  const dirty =
    isEdit &&
    (workDate !== entry.workDate ||
      durationMinutes !== entry.durationMinutes ||
      activity !== (entry.activityType ?? '') ||
      note !== (entry.note ?? ''))

  function showIssues(issues: TimeIssue[]) {
    setErrors(Object.fromEntries(issues.map((issue) => [issue.field, timeIssueMessages[issue.field][issue.code] ?? 'Check this field.'])))
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (saving) return
    setSaveError(null)
    const { issues } = checkTimeEntry(input)
    if (issues.length > 0) return showIssues(issues)

    setSaving(true)
    const result = await onSave(input)
    setSaving(false)
    if (result.ok) {
      setErrors({})
      if (!isEdit) {
        setHours('')
        setMinutes('')
        setActivity('')
        setNote('')
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

  const clear = (field: TimeIssue['field']) => setErrors((current) => ({ ...current, [field]: undefined }))
  const fieldError = (field: TimeIssue['field'], name: string) =>
    errors[field] && (
      <p id={`${id}-${name}-error`} className="field-issues issue-error" role="alert">
        {errors[field]}
      </p>
    )

  return (
    <form className="add-note hours-form" onSubmit={onSubmit} noValidate aria-label={isEdit ? 'Edit hours entry' : 'Add hours by hand'}>
      <div className="hours-form-row">
        <div className={`field${errors.workDate ? ' field-invalid' : ''}`}>
          <label htmlFor={`${id}-date`}>Date</label>
          <input
            id={`${id}-date`}
            type="date"
            value={workDate}
            aria-invalid={errors.workDate !== undefined}
            aria-describedby={errors.workDate ? `${id}-date-error` : undefined}
            onChange={(e) => {
              setWorkDate(e.target.value)
              clear('workDate')
            }}
          />
          {fieldError('workDate', 'date')}
        </div>
        <div className={`field hours-field-short${errors.durationMinutes ? ' field-invalid' : ''}`}>
          <label htmlFor={`${id}-hours`}>Hours</label>
          <input
            id={`${id}-hours`}
            type="number"
            inputMode="numeric"
            min={0}
            max={12}
            step={1}
            value={hours}
            aria-invalid={errors.durationMinutes !== undefined}
            aria-describedby={errors.durationMinutes ? `${id}-duration-error` : undefined}
            onChange={(e) => {
              setHours(e.target.value)
              clear('durationMinutes')
            }}
          />
        </div>
        <div className={`field hours-field-short${errors.durationMinutes ? ' field-invalid' : ''}`}>
          <label htmlFor={`${id}-minutes`}>Minutes</label>
          <input
            id={`${id}-minutes`}
            type="number"
            inputMode="numeric"
            min={0}
            max={59}
            step={1}
            value={minutes}
            aria-invalid={errors.durationMinutes !== undefined}
            aria-describedby={errors.durationMinutes ? `${id}-duration-error` : undefined}
            onChange={(e) => {
              setMinutes(e.target.value)
              clear('durationMinutes')
            }}
          />
        </div>
        <div className={`field${errors.activityType ? ' field-invalid' : ''}`}>
          <label htmlFor={`${id}-activity`}>Activity (optional)</label>
          <select
            id={`${id}-activity`}
            value={activity}
            onChange={(e) => {
              setActivity(e.target.value as ActivityType | '')
              clear('activityType')
            }}
          >
            <option value="">Not specified</option>
            {ACTIVITY_TYPES.map((type) => (
              <option key={type} value={type}>
                {activityLabels[type]}
              </option>
            ))}
          </select>
          {fieldError('activityType', 'activity')}
        </div>
      </div>
      {fieldError('durationMinutes', 'duration')}

      <div className={`field${errors.note ? ' field-invalid' : ''}`}>
        <label htmlFor={`${id}-note`}>Note (optional)</label>
        <textarea
          id={`${id}-note`}
          rows={2}
          maxLength={TIME_NOTE_MAX * 2}
          value={note}
          aria-invalid={errors.note !== undefined}
          aria-describedby={errors.note ? `${id}-note-error` : undefined}
          onChange={(e) => {
            setNote(e.target.value)
            clear('note')
          }}
        />
        {fieldError('note', 'note')}
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
