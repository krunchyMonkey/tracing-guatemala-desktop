import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  canTransition,
  checkCase,
  queryCases,
  type CaseEvent,
  type CaseInput,
  type CaseMutationResult,
  type CaseQuery,
  type CaseState,
  type ResearchCase
} from '../../shared/case-model'
import type { RepositoryClock } from './client-repository'

// Research case persistence (case-model/v1). Every change reads the case and
// its client, checks the rules, writes the row and appends its case_events row
// inside one BEGIN IMMEDIATE transaction, so a refused change leaves no trace
// and an accepted one is never half-recorded. Order of checks: not-found, then
// client archived, then case archived, then transition, then input. All SQL is
// parameterized and nothing submitted is ever echoed back in a failure.

const defaultClock: RepositoryClock = { now: () => new Date(), newId: () => randomUUID() }

interface CaseRow {
  id: string
  client_id: string
  title: string
  goal: string | null
  order_reference: string | null
  due_date: string | null
  state: CaseState
  state_changed_at: string
  created_at: string
  updated_at: string
  archived_at: string | null
}

interface CaseEventRow {
  id: string
  case_id: string
  kind: CaseEvent['kind']
  from_state: CaseState | null
  to_state: CaseState | null
  occurred_at: string
}

function toCase(row: CaseRow): ResearchCase {
  return {
    id: row.id,
    clientId: row.client_id,
    title: row.title,
    goal: row.goal,
    orderReference: row.order_reference,
    dueDate: row.due_date,
    state: row.state,
    stateChangedAt: row.state_changed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at
  }
}

function toEvent(row: CaseEventRow): CaseEvent {
  return {
    id: row.id,
    caseId: row.case_id,
    kind: row.kind,
    fromState: row.from_state,
    toState: row.to_state,
    occurredAt: row.occurred_at
  }
}

type Refused = Extract<CaseMutationResult, { ok: false }>

export class CaseRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: RepositoryClock = defaultClock
  ) {}

  /** Phase 2 holds at most a few hundred cases, so text search and sorting run in JS (shared with the demo). */
  list(query: CaseQuery): ResearchCase[] {
    const rows = (
      query.clientId === null
        ? this.db.prepare('SELECT * FROM research_cases').all()
        : this.db.prepare('SELECT * FROM research_cases WHERE client_id = ?').all(query.clientId)
    ) as unknown as CaseRow[]
    return queryCases(rows.map(toCase), query)
  }

  get(id: string): ResearchCase | null {
    const row = this.db.prepare('SELECT * FROM research_cases WHERE id = ?').get(id) as CaseRow | undefined
    return row ? toCase(row) : null
  }

  /** Newest first; empty for an unknown case. */
  listEvents(caseId: string): CaseEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM case_events WHERE case_id = ? ORDER BY occurred_at DESC, rowid DESC')
      .all(caseId) as unknown as CaseEventRow[]
    return rows.map(toEvent)
  }

  create(clientId: string, raw: CaseInput): CaseMutationResult {
    return this.transaction(() => {
      const client = this.db.prepare('SELECT status FROM clients WHERE id = ?').get(clientId) as
        | { status: string }
        | undefined
      if (!client) return { ok: false, reason: 'not-found' }
      if (client.status !== 'active') return { ok: false, reason: 'client-archived' }
      const { input, issues } = checkCase(raw)
      if (!input) return { ok: false, reason: 'invalid', issues }

      const id = this.clock.newId()
      const now = this.clock.now().toISOString()
      this.db
        .prepare(
          `INSERT INTO research_cases (id, client_id, title, goal, order_reference, due_date, state,
             state_changed_at, created_at, updated_at, archived_at)
           VALUES (?, ?, ?, ?, ?, ?, 'intake', ?, ?, ?, NULL)`
        )
        .run(id, clientId, input.title, input.goal, input.orderReference, input.dueDate, now, now, now)
      this.addEvent(id, 'created', null, 'intake', now)
      return this.found(id)
    })
  }

  update(id: string, raw: CaseInput): CaseMutationResult {
    return this.transaction(() => {
      const refused = this.checkWritable(id)
      if ('ok' in refused) return refused
      const { input, issues } = checkCase(raw)
      if (!input) return { ok: false, reason: 'invalid', issues }

      this.db
        .prepare('UPDATE research_cases SET title = ?, goal = ?, order_reference = ?, due_date = ?, updated_at = ? WHERE id = ?')
        .run(input.title, input.goal, input.orderReference, input.dueDate, this.clock.now().toISOString(), id)
      return this.found(id)
    })
  }

  setState(id: string, to: CaseState): CaseMutationResult {
    return this.transaction(() => {
      const refused = this.checkWritable(id)
      if ('ok' in refused) return refused
      const from = refused.state
      if (!canTransition(from, to)) return { ok: false, reason: 'invalid-transition' }

      const now = this.clock.now().toISOString()
      this.db
        .prepare('UPDATE research_cases SET state = ?, state_changed_at = ?, updated_at = ? WHERE id = ?')
        .run(to, now, now, id)
      this.addEvent(id, 'state', from, to, now)
      return this.found(id)
    })
  }

  archive(id: string): CaseMutationResult {
    return this.transaction(() => {
      const refused = this.checkWritable(id)
      if ('ok' in refused) return refused
      const now = this.clock.now().toISOString()
      this.db.prepare('UPDATE research_cases SET archived_at = ?, updated_at = ? WHERE id = ?').run(now, now, id)
      this.addEvent(id, 'archived', null, null, now)
      return this.found(id)
    })
  }

  unarchive(id: string): CaseMutationResult {
    return this.transaction(() => {
      const existing = this.get(id)
      if (!existing) return { ok: false, reason: 'not-found' }
      if (this.clientIsArchived(existing.clientId)) return { ok: false, reason: 'wrong-status' }
      if (existing.archivedAt === null) return { ok: false, reason: 'wrong-status' }
      const now = this.clock.now().toISOString()
      this.db.prepare('UPDATE research_cases SET archived_at = NULL, updated_at = ? WHERE id = ?').run(now, id)
      this.addEvent(id, 'unarchived', null, null, now)
      return this.found(id)
    })
  }

  /** The case if it can be changed (exists, client active, case not archived); otherwise the refusal. */
  private checkWritable(id: string): ResearchCase | Refused {
    const existing = this.get(id)
    if (!existing) return { ok: false, reason: 'not-found' }
    if (this.clientIsArchived(existing.clientId)) return { ok: false, reason: 'wrong-status' }
    if (existing.archivedAt !== null) return { ok: false, reason: 'wrong-status' }
    return existing
  }

  private clientIsArchived(clientId: string): boolean {
    const row = this.db.prepare('SELECT status FROM clients WHERE id = ?').get(clientId) as { status: string } | undefined
    return row?.status !== 'active'
  }

  private addEvent(caseId: string, kind: CaseEvent['kind'], from: CaseState | null, to: CaseState | null, at: string): void {
    this.db
      .prepare('INSERT INTO case_events (id, case_id, kind, from_state, to_state, occurred_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(this.clock.newId(), caseId, kind, from, to, at)
  }

  private found(id: string): CaseMutationResult {
    const researchCase = this.get(id)
    return researchCase ? { ok: true, case: researchCase } : { ok: false, reason: 'not-found' }
  }

  private transaction(work: () => CaseMutationResult): CaseMutationResult {
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
}
