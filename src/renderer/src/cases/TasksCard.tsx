import { useCallback, useEffect, useId, useState, type FormEvent } from 'react'
import {
  checkCaseTask,
  compareTasks,
  daysUntilDue,
  TASK_DESCRIPTION_MAX,
  TASK_TITLE_MAX,
  taskDueStatus,
  type CaseTask,
  type CaseTaskInput,
  type CaseTaskIssue,
  type CaseTaskMutationResult
} from '../../../shared/case-tasks'
import { Alert, ConfirmDialog, formatDateTime } from '../clients/components'
import { formatDueDate, localDateString } from './model'
import { useCaseApi } from './useCaseApi'

// The case's next steps (#19): small tasks with an optional date-only deadline.
// Deadlines are local calendar dates, compared with local "today" only. The due
// indicator is always written out in words, never colour alone. Saved text is shown
// as plain text. Typed text is kept whenever a save fails.

const issueMessages: Record<CaseTaskIssue['field'], Partial<Record<CaseTaskIssue['code'], string>>> = {
  title: {
    required: 'Write what needs doing before adding it.',
    'too-long': `Keep the title under ${TASK_TITLE_MAX} characters.`,
    'invalid-characters': 'The title has a character that can’t be saved. Remove it and try again.'
  },
  description: {
    'too-long': `Keep the details under ${TASK_DESCRIPTION_MAX.toLocaleString()} characters.`,
    'invalid-characters': 'The details have a character that can’t be saved. Remove it and try again.'
  },
  dueDate: {
    'invalid-format': 'Choose a date, or leave it empty.',
    'invalid-date': 'That date doesn’t exist. Choose a real date, or leave it empty.'
  }
}

const saveMessages: Record<'failed' | 'not-found' | 'wrong-status', string> = {
  failed: 'Couldn’t save this task. Your text is still here; please try again.',
  'not-found': 'This task or case couldn’t be found any more. Copy your text if you need it.',
  'wrong-status': 'This case or its client is archived, so the tasks can’t be changed.'
}

const actionMessages: Record<'failed' | 'not-found' | 'wrong-status' | 'invalid', string> = {
  failed: 'Couldn’t update this task. Nothing was changed; please try again.',
  'not-found': 'This task couldn’t be found any more.',
  'wrong-status': 'This task was already changed, or the case is archived. The list has been refreshed.',
  invalid: 'Couldn’t update this task.'
}

type SaveResult = CaseTaskMutationResult | { ok: false; reason: 'failed' }

/** Due text in words: "Overdue", "Due today", "Due tomorrow", "Due in 3 days", or the date. */
export function dueLabel(task: CaseTask, localToday: string): { text: string; tone: string } | null {
  const status = taskDueStatus(task, localToday)
  const days = daysUntilDue(task, localToday)
  if (status === 'none' || days === null) return null
  if (status === 'overdue') {
    const late = -days
    return { text: `Overdue by ${late} ${late === 1 ? 'day' : 'days'}`, tone: 'overdue' }
  }
  if (status === 'due-today') return { text: 'Due today', tone: 'today' }
  if (status === 'due-soon') return { text: days === 1 ? 'Due tomorrow' : `Due in ${days} days`, tone: 'soon' }
  return { text: `Due in ${days} days`, tone: 'later' }
}

interface TasksCardProps {
  caseId: string
  readOnly: boolean
  /** Why the tasks can't be changed, shown when readOnly. */
  readOnlyReason: string
}

export function TasksCard({ caseId, readOnly, readOnlyReason }: TasksCardProps) {
  const api = useCaseApi()
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [tasks, setTasks] = useState<CaseTask[]>([])
  const [attempt, setAttempt] = useState(0)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<{ id: string; message: string } | null>(null)
  const localToday = localDateString(new Date())

  useEffect(() => {
    let current = true
    api.listCaseTasks(caseId).then(
      (list) => {
        if (!current) return
        setTasks([...list].sort(compareTasks))
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

  const save = useCallback(async (call: () => Promise<CaseTaskMutationResult>): Promise<SaveResult> => {
    let result: CaseTaskMutationResult
    try {
      result = await call()
    } catch {
      return { ok: false, reason: 'failed' }
    }
    if (result.ok) {
      const saved = result.task
      setTasks((list) => [...list.filter((t) => t.id !== saved.id), saved].sort(compareTasks))
    }
    return result
  }, [])

  async function change(task: CaseTask, call: () => Promise<CaseTaskMutationResult>) {
    if (busyId !== null) return
    setBusyId(task.id)
    setActionError(null)
    const result = await save(call)
    setBusyId(null)
    if (!result.ok) {
      setActionError({ id: task.id, message: actionMessages[result.reason] })
      // A duplicate or stale request means the list is out of date; refresh it.
      if (result.reason === 'wrong-status' || result.reason === 'not-found') setAttempt((n) => n + 1)
    }
  }

  const pending = tasks.filter((t) => t.status === 'pending')
  const completed = tasks.filter((t) => t.status === 'completed')

  const renderTask = (task: CaseTask) => (
    <li key={task.id} id={`task-${task.id}`} tabIndex={-1} className={`task-item task-${task.status}`}>
      {editingId === task.id ? (
        <TaskEditor
          task={task}
          onSave={async (input) => {
            const result = await save(() => api.updateCaseTask(caseId, task.id, input))
            if (result.ok) setEditingId(null)
            return result
          }}
          onCancel={() => setEditingId(null)}
        />
      ) : (
        <TaskView
          task={task}
          localToday={localToday}
          busy={busyId === task.id}
          disabled={busyId !== null}
          error={actionError?.id === task.id ? actionError.message : null}
          onToggle={
            readOnly
              ? null
              : () =>
                  change(task, () =>
                    task.status === 'pending' ? api.completeCaseTask(caseId, task.id) : api.reopenCaseTask(caseId, task.id)
                  )
          }
          onEdit={readOnly || editingId !== null ? null : () => setEditingId(task.id)}
        />
      )}
    </li>
  )

  return (
    <section className="card tasks" aria-labelledby="case-tasks-heading">
      <h2 id="case-tasks-heading">Next steps</h2>
      <p className="hint tasks-intro">
        What you plan to do next on this case, with a deadline if it has one. Nothing here is sent to anyone.
      </p>

      {readOnly ? (
        <p className="muted tasks-readonly">{readOnlyReason}</p>
      ) : (
        <TaskEditor key="new" onSave={(input) => save(() => api.createCaseTask(caseId, input))} />
      )}

      {state === 'error' ? (
        <Alert tone="error" title="The next steps couldn’t be loaded">
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
          Loading the next steps…
        </p>
      ) : (
        <>
          {pending.length === 0 ? (
            <p className="muted tasks-empty">{tasks.length === 0 ? 'No next steps yet.' : 'Nothing left to do.'}</p>
          ) : (
            <ul className="task-list" aria-label="Open next steps">
              {pending.map(renderTask)}
            </ul>
          )}
          {completed.length > 0 && (
            <details className="task-completed">
              <summary>Completed ({completed.length})</summary>
              <ul className="task-list" aria-label="Completed next steps">
                {completed.map(renderTask)}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  )
}

interface TaskViewProps {
  task: CaseTask
  localToday: string
  busy: boolean
  disabled: boolean
  error: string | null
  onToggle: (() => void) | null
  onEdit: (() => void) | null
}

function TaskView({ task, localToday, busy, disabled, error, onToggle, onEdit }: TaskViewProps) {
  const due = dueLabel(task, localToday)
  const done = task.status === 'completed'
  return (
    <>
      <div className="task-main">
        <p className="task-title">{task.title}</p>
        <p className="task-meta">
          {task.dueDate !== null && (
            <span className="task-due">
              <time dateTime={task.dueDate}>{formatDueDate(task.dueDate)}</time>
            </span>
          )}
          {due && <span className={`task-flag task-flag-${due.tone}`}>{due.text}</span>}
          {task.dueDate === null && !done && <span className="muted">No deadline</span>}
          {done && task.completedAt && (
            <span className="muted">
              Done <time dateTime={task.completedAt}>{formatDateTime(task.completedAt)}</time>
            </span>
          )}
        </p>
        {task.description && <p className="task-description preserve-lines">{task.description}</p>}
        {error && (
          <p className="field-issues issue-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="task-actions">
        {onToggle && (
          <button
            type="button"
            className="button button-small button-secondary"
            disabled={disabled}
            aria-busy={busy}
            aria-label={`${done ? 'Reopen' : 'Mark done'}: ${task.title}`}
            onClick={onToggle}
          >
            {done ? 'Reopen' : 'Mark done'}
          </button>
        )}
        {onEdit && (
          <button
            type="button"
            className="button button-small button-ghost"
            aria-label={`Edit task: ${task.title}`}
            onClick={onEdit}
          >
            Edit
          </button>
        )}
      </div>
    </>
  )
}

interface TaskEditorProps {
  /** The task being edited; omitted when adding. */
  task?: CaseTask
  onSave(input: CaseTaskInput): Promise<SaveResult>
  onCancel?(): void
}

function TaskEditor({ task, onSave, onCancel }: TaskEditorProps) {
  const id = useId()
  const isEdit = task !== undefined
  const [title, setTitle] = useState(task?.title ?? '')
  const [description, setDescription] = useState(task?.description ?? '')
  const [dueDate, setDueDate] = useState(task?.dueDate ?? '')
  const [errors, setErrors] = useState<Partial<Record<CaseTaskIssue['field'], string>>>({})
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)

  const input: CaseTaskInput = { title, description: description === '' ? null : description, dueDate: dueDate === '' ? null : dueDate }
  const dirty = isEdit && (title !== task.title || description !== (task.description ?? '') || dueDate !== (task.dueDate ?? ''))

  function showIssues(issues: CaseTaskIssue[]) {
    setErrors(
      Object.fromEntries(issues.map((issue) => [issue.field, issueMessages[issue.field][issue.code] ?? 'Check this field.']))
    )
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (saving) return
    setSaveError(null)
    const { issues } = checkCaseTask(input)
    if (issues.length > 0) return showIssues(issues)

    setSaving(true)
    const result = await onSave(input)
    setSaving(false)
    if (result.ok) {
      setErrors({})
      if (!isEdit) {
        setTitle('')
        setDescription('')
        setDueDate('')
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

  const clear = (field: CaseTaskIssue['field']) => setErrors((current) => ({ ...current, [field]: undefined }))
  const fieldError = (field: CaseTaskIssue['field'], name: string) =>
    errors[field] && (
      <p id={`${id}-${name}-error`} className="field-issues issue-error" role="alert">
        {errors[field]}
      </p>
    )

  return (
    <form
      className="add-note task-form"
      onSubmit={onSubmit}
      noValidate
      aria-label={isEdit ? 'Edit task' : 'Add a next step'}
    >
      <div className={`field${errors.title ? ' field-invalid' : ''}`}>
        <label htmlFor={`${id}-title`}>{isEdit ? 'Task' : 'What needs doing'}</label>
        <input
          id={`${id}-title`}
          type="text"
          value={title}
          autoComplete="off"
          aria-invalid={errors.title !== undefined}
          aria-describedby={errors.title ? `${id}-title-error` : undefined}
          onChange={(e) => {
            setTitle(e.target.value)
            clear('title')
          }}
        />
        {fieldError('title', 'title')}
      </div>

      <div className="field-grid">
        <div className={`field${errors.description ? ' field-invalid' : ''}`}>
          <label htmlFor={`${id}-description`}>Details (optional)</label>
          <textarea
            id={`${id}-description`}
            rows={2}
            value={description}
            aria-invalid={errors.description !== undefined}
            aria-describedby={errors.description ? `${id}-description-error` : undefined}
            onChange={(e) => {
              setDescription(e.target.value)
              clear('description')
            }}
          />
          {fieldError('description', 'description')}
        </div>
        <div className={`field${errors.dueDate ? ' field-invalid' : ''}`}>
          <label htmlFor={`${id}-due`}>Deadline (optional)</label>
          <input
            id={`${id}-due`}
            type="date"
            value={dueDate}
            aria-invalid={errors.dueDate !== undefined}
            aria-describedby={errors.dueDate ? `${id}-due-error` : undefined}
            onChange={(e) => {
              setDueDate(e.target.value)
              clear('dueDate')
            }}
          />
          {fieldError('dueDate', 'due')}
        </div>
      </div>

      {saveError && (
        <Alert tone="error" title="Not saved">
          {saveError}
        </Alert>
      )}

      <div className="button-row">
        <button type="submit" className="button button-secondary" disabled={saving} aria-busy={saving}>
          {saving ? 'Saving…' : saveError ? 'Try again' : isEdit ? 'Save changes' : 'Add next step'}
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
          <p>Your edits to this task haven’t been saved.</p>
        </ConfirmDialog>
      )}
    </form>
  )
}
