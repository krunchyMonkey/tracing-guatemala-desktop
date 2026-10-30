import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { checkCaseTask, compareTasks, type CaseTask, type CaseTaskInput, type CaseTaskMutationResult } from '../../shared/case-tasks'
import type { RepositoryClock } from './client-repository'

// Case task persistence (case-tasks/v1). Every write runs in one BEGIN IMMEDIATE
// transaction: it reads the case and its client, checks the rules, writes the
// task and bumps the case's updated_at, so a refused write leaves no trace.
// Order of checks: case not found, then case or client archived, then the task
// must belong to that case, then (complete/reopen) it must not already be in the
// requested status, then input. Tasks are never deleted and write no case_events
// row. All SQL is parameterized and nothing submitted is ever echoed back.

const defaultClock: RepositoryClock = { now: () => new Date(), newId: () => randomUUID() }

interface TaskRow {
  id: string
  case_id: string
  title: string
  description: string | null
  status: 'pending' | 'completed'
  due_date: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
}

function toTask(row: TaskRow): CaseTask {
  return {
    id: row.id,
    caseId: row.case_id,
    title: row.title,
    description: row.description,
    status: row.status,
    dueDate: row.due_date,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export class CaseTaskRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: RepositoryClock = defaultClock
  ) {}

  /** Pending first, by due date (see compareTasks); empty for an unknown case. */
  list(caseId: string): CaseTask[] {
    const rows = this.db.prepare('SELECT * FROM case_tasks WHERE case_id = ?').all(caseId) as unknown as TaskRow[]
    return rows.map(toTask).sort(compareTasks)
  }

  create(caseId: string, raw: CaseTaskInput): CaseTaskMutationResult {
    return this.transaction(() => {
      const blocked = this.checkCase(caseId)
      if (blocked) return blocked
      const { input, issues } = checkCaseTask(raw)
      if (!input) return { ok: false, reason: 'invalid', issues }

      const now = this.clock.now().toISOString()
      const id = this.clock.newId()
      this.db
        .prepare(
          `INSERT INTO case_tasks (id, case_id, title, description, status, due_date, completed_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'pending', ?, NULL, ?, ?)`
        )
        .run(id, caseId, input.title, input.description, input.dueDate, now, now)
      this.touchCase(caseId, now)
      return this.found(caseId, id)
    })
  }

  update(caseId: string, taskId: string, raw: CaseTaskInput): CaseTaskMutationResult {
    return this.transaction(() => {
      const blocked = this.checkCase(caseId)
      if (blocked) return blocked
      if (!this.row(caseId, taskId)) return { ok: false, reason: 'not-found' }
      const { input, issues } = checkCaseTask(raw)
      if (!input) return { ok: false, reason: 'invalid', issues }

      const now = this.clock.now().toISOString()
      this.db
        .prepare('UPDATE case_tasks SET title = ?, description = ?, due_date = ?, updated_at = ? WHERE id = ? AND case_id = ?')
        .run(input.title, input.description, input.dueDate, now, taskId, caseId)
      this.touchCase(caseId, now)
      return this.found(caseId, taskId)
    })
  }

  complete(caseId: string, taskId: string): CaseTaskMutationResult {
    return this.setStatus(caseId, taskId, 'completed')
  }

  reopen(caseId: string, taskId: string): CaseTaskMutationResult {
    return this.setStatus(caseId, taskId, 'pending')
  }

  private setStatus(caseId: string, taskId: string, status: 'pending' | 'completed'): CaseTaskMutationResult {
    return this.transaction(() => {
      const blocked = this.checkCase(caseId)
      if (blocked) return blocked
      const current = this.row(caseId, taskId)
      if (!current) return { ok: false, reason: 'not-found' }
      if (current.status === status) return { ok: false, reason: 'wrong-status' }

      const now = this.clock.now().toISOString()
      this.db
        .prepare('UPDATE case_tasks SET status = ?, completed_at = ?, updated_at = ? WHERE id = ? AND case_id = ?')
        .run(status, status === 'completed' ? now : null, now, taskId, caseId)
      this.touchCase(caseId, now)
      return this.found(caseId, taskId)
    })
  }

  private transaction(work: () => CaseTaskMutationResult): CaseTaskMutationResult {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** Null when the case exists and can be written to; otherwise the refusal. */
  private checkCase(caseId: string): CaseTaskMutationResult | null {
    const row = this.db
      .prepare(
        `SELECT c.archived_at AS case_archived_at, k.status AS client_status
         FROM research_cases c JOIN clients k ON k.id = c.client_id WHERE c.id = ?`
      )
      .get(caseId) as { case_archived_at: string | null; client_status: string } | undefined
    if (!row) return { ok: false, reason: 'not-found' }
    if (row.client_status !== 'active' || row.case_archived_at !== null) return { ok: false, reason: 'wrong-status' }
    return null
  }

  private touchCase(caseId: string, at: string): void {
    this.db.prepare('UPDATE research_cases SET updated_at = ? WHERE id = ?').run(at, caseId)
  }

  private row(caseId: string, taskId: string): TaskRow | undefined {
    return this.db.prepare('SELECT * FROM case_tasks WHERE id = ? AND case_id = ?').get(taskId, caseId) as TaskRow | undefined
  }

  private found(caseId: string, taskId: string): CaseTaskMutationResult {
    const row = this.row(caseId, taskId)
    return row ? { ok: true, task: toTask(row) } : { ok: false, reason: 'not-found' }
  }
}
