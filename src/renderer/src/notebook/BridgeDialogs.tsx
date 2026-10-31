import { useId, useMemo, useState, type FormEvent } from 'react'
import { checkJournalEntry, JOURNAL_ACTIVITY_MAX, JOURNAL_BODY_MAX, type JournalEntryInput, type JournalIssue } from '../../../shared/case-journal'
import { checkCaseTask, TASK_DESCRIPTION_MAX, TASK_TITLE_MAX, type CaseTaskInput, type CaseTaskIssue } from '../../../shared/case-tasks'
import { Alert } from '../clients/components'
import { fromLocalInput, toLocalInput } from '../clients/localTime'
import { labelOf, type CaseRecord, type CaseRecords } from './useCaseRecords'
import { ModalDialog } from './ModalDialog'

// The notebook's bridge to the rest of the case (#149). Links never copy: choosing a
// record only inserts a reference to it. Creating a task or journal entry from notes
// is always explicit: nothing exists until the person presses the button.

// ---------- link a record ----------

const KIND_TITLES = { journal: 'Journal entries', task: 'Next steps', time: 'Research hours' } as const

export function LinkRecordDialog({ records, onChoose, onCancel, returnFocus }: { records: CaseRecords; onChoose(entry: CaseRecord): void; onCancel(): void; returnFocus?: () => void }) {
  const [filter, setFilter] = useState('')
  const inputId = useId()
  const needle = filter.trim().toLowerCase()
  const shown = useMemo(() => records.all.filter((entry) => needle === '' || labelOf(entry).toLowerCase().includes(needle)), [records.all, needle])

  return (
    <ModalDialog title="Link a record" wide onClose={onCancel} returnFocus={returnFocus}>
      <p className="muted">Adds a link to a record of this case. The record itself stays where it is; nothing is copied.</p>
      <div className="field">
        <label htmlFor={inputId}>Filter records</label>
        <input id={inputId} type="text" autoComplete="off" value={filter} onChange={(event) => setFilter(event.target.value)} />
      </div>
      {records.status === 'loading' && (
        <p role="status" className="muted">
          Loading records…
        </p>
      )}
      {records.status === 'error' && (
        <Alert tone="error" title="The records couldn’t be loaded">
          <button type="button" className="button button-secondary button-small" onClick={() => void records.reload()}>
            Try again
          </button>
        </Alert>
      )}
      {records.status === 'ready' && records.all.length === 0 && <p className="muted">This case has no journal entries, next steps or hours to link yet.</p>}
      {records.status === 'ready' && records.all.length > 0 && shown.length === 0 && <p className="muted">No records match “{filter.trim()}”.</p>}
      {(['journal', 'task', 'time'] as const).map((kind) => {
        const group = shown.filter((entry) => entry.kind === kind)
        if (group.length === 0) return null
        return (
          <section key={kind} aria-label={KIND_TITLES[kind]} className="note-link-group">
            <h3>{KIND_TITLES[kind]}</h3>
            <ul className="note-link-list">
              {group.map((entry) => (
                <li key={entry.record.id}>
                  <button type="button" className="button button-ghost note-link-choice" onClick={() => onChoose(entry)}>
                    {labelOf(entry)}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )
      })}
      <div className="dialog-actions">
        <button type="button" className="button button-secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </ModalDialog>
  )
}

// ---------- create from the selection ----------

export type CreateResult = { ok: true } | { ok: false; message: string }

const taskMessages: Record<CaseTaskIssue['code'], string> = {
  required: 'Give the task a name.',
  'too-long': 'This is too long.',
  'invalid-characters': 'This has a character that can’t be saved. Remove it and try again.',
  'invalid-format': 'Choose a valid date.',
  'invalid-date': 'Choose a valid date.'
}

const journalMessages: Record<JournalIssue['code'], string> = {
  required: 'Write what you did or found.',
  'too-long': 'This is too long.',
  'invalid-characters': 'This has a character that can’t be saved. Remove it and try again.',
  'invalid-format': 'Choose a date and time.',
  'in-future': 'This date is in the future. Choose when the work happened.'
}

const firstLine = (text: string): string => text.split('\n')[0]!.trim()

interface CreateDialogProps<Input> {
  selectedText: string
  onCreate(input: Input): Promise<CreateResult>
  onCancel(): void
  returnFocus?: () => void
}

export function CreateTaskDialog({ selectedText, onCreate, onCancel, returnFocus }: CreateDialogProps<CaseTaskInput>) {
  const id = useId()
  const text = selectedText.trim()
  const [title, setTitle] = useState(() => firstLine(text).slice(0, TASK_TITLE_MAX))
  const [description, setDescription] = useState(() => (text.length > firstLine(text).length ? text.slice(0, TASK_DESCRIPTION_MAX) : ''))
  const [dueDate, setDueDate] = useState('')
  const [errors, setErrors] = useState<Partial<Record<CaseTaskIssue['field'], string>>>({})
  const [problem, setProblem] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (saving) return
    setProblem(null)
    const input: CaseTaskInput = { title, description: description === '' ? null : description, dueDate: dueDate === '' ? null : dueDate }
    const { issues } = checkCaseTask(input)
    if (issues.length > 0) return setErrors(Object.fromEntries(issues.map((i) => [i.field, taskMessages[i.code]])))
    setErrors({})
    setSaving(true)
    const result = await onCreate(input)
    setSaving(false)
    if (!result.ok) setProblem(result.message)
  }

  return (
    <ModalDialog title="Create a task from your notes" onClose={onCancel} returnFocus={returnFocus}>
      <form onSubmit={(event) => void submit(event)} noValidate>
        <p className="muted">
          {text === '' ? 'Nothing is selected, so start from a blank task.' : 'Prefilled from your selection. Edit it as you like.'} The task is only created when you press Create task.
        </p>
        <div className={`field${errors.title ? ' field-invalid' : ''}`}>
          <label htmlFor={`${id}-title`}>What needs doing</label>
          <input id={`${id}-title`} type="text" autoComplete="off" value={title} aria-invalid={errors.title !== undefined} onChange={(e) => setTitle(e.target.value)} />
          {errors.title && (
            <p className="field-issues issue-error" role="alert">
              {errors.title}
            </p>
          )}
        </div>
        <div className={`field${errors.description ? ' field-invalid' : ''}`}>
          <label htmlFor={`${id}-description`}>Details (optional)</label>
          <textarea id={`${id}-description`} rows={3} value={description} aria-invalid={errors.description !== undefined} onChange={(e) => setDescription(e.target.value)} />
          {errors.description && (
            <p className="field-issues issue-error" role="alert">
              {errors.description}
            </p>
          )}
        </div>
        <div className={`field${errors.dueDate ? ' field-invalid' : ''}`}>
          <label htmlFor={`${id}-due`}>Deadline (optional)</label>
          <input id={`${id}-due`} type="date" value={dueDate} aria-invalid={errors.dueDate !== undefined} onChange={(e) => setDueDate(e.target.value)} />
          {errors.dueDate && (
            <p className="field-issues issue-error" role="alert">
              {errors.dueDate}
            </p>
          )}
        </div>
        {problem && (
          <Alert tone="error" title="Not created">
            {problem}
          </Alert>
        )}
        <div className="dialog-actions">
          <button type="button" className="button button-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="button button-primary" disabled={saving} aria-busy={saving}>
            {saving ? 'Creating…' : 'Create task'}
          </button>
        </div>
      </form>
    </ModalDialog>
  )
}

export function CreateJournalDialog({ selectedText, onCreate, onCancel, returnFocus }: CreateDialogProps<JournalEntryInput>) {
  const id = useId()
  const text = selectedText.trim()
  const [when, setWhen] = useState(() => toLocalInput(new Date().toISOString()))
  const [activity, setActivity] = useState('')
  const [body, setBody] = useState(() => text.slice(0, JOURNAL_BODY_MAX))
  const [errors, setErrors] = useState<Partial<Record<JournalIssue['field'], string>>>({})
  const [problem, setProblem] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (saving) return
    setProblem(null)
    const input: JournalEntryInput = { occurredAt: fromLocalInput(when), activity: activity === '' ? null : activity, body }
    const { issues } = checkJournalEntry(input)
    if (issues.length > 0) return setErrors(Object.fromEntries(issues.map((i) => [i.field, journalMessages[i.code]])))
    setErrors({})
    setSaving(true)
    const result = await onCreate(input)
    setSaving(false)
    if (!result.ok) setProblem(result.message)
  }

  return (
    <ModalDialog title="Add to the research journal" onClose={onCancel} returnFocus={returnFocus}>
      <form onSubmit={(event) => void submit(event)} noValidate>
        <p className="muted">
          {text === '' ? 'Nothing is selected, so start from a blank entry.' : 'Prefilled from your selection. Edit it as you like.'} The entry is only added when you press Add to journal.
        </p>
        <div className={`field${errors.occurredAt ? ' field-invalid' : ''}`}>
          <label htmlFor={`${id}-when`}>When</label>
          <input id={`${id}-when`} type="datetime-local" value={when} aria-invalid={errors.occurredAt !== undefined} onChange={(e) => setWhen(e.target.value)} />
          {errors.occurredAt && (
            <p className="field-issues issue-error" role="alert">
              {errors.occurredAt}
            </p>
          )}
        </div>
        <div className={`field${errors.activity ? ' field-invalid' : ''}`}>
          <label htmlFor={`${id}-activity`}>Activity (optional)</label>
          <input id={`${id}-activity`} type="text" autoComplete="off" maxLength={JOURNAL_ACTIVITY_MAX + 20} value={activity} aria-invalid={errors.activity !== undefined} onChange={(e) => setActivity(e.target.value)} />
          {errors.activity && (
            <p className="field-issues issue-error" role="alert">
              {errors.activity}
            </p>
          )}
        </div>
        <div className={`field${errors.body ? ' field-invalid' : ''}`}>
          <label htmlFor={`${id}-body`}>What you did or found</label>
          <textarea id={`${id}-body`} rows={5} value={body} aria-invalid={errors.body !== undefined} onChange={(e) => setBody(e.target.value)} />
          {errors.body && (
            <p className="field-issues issue-error" role="alert">
              {errors.body}
            </p>
          )}
        </div>
        {problem && (
          <Alert tone="error" title="Not added">
            {problem}
          </Alert>
        )}
        <div className="dialog-actions">
          <button type="button" className="button button-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="button button-primary" disabled={saving} aria-busy={saving}>
            {saving ? 'Adding…' : 'Add to journal'}
          </button>
        </div>
      </form>
    </ModalDialog>
  )
}
