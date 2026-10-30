import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { checkJournalEntry, type JournalEntry, type JournalEntryInput, type JournalMutationResult } from '../../shared/case-journal'
import type { RepositoryClock } from './client-repository'

// Case research journal persistence (case-journal/v1). Every write runs in one
// BEGIN IMMEDIATE transaction: it reads the case and its client, checks the rules,
// writes the entry and bumps the case's updated_at, so a refused write leaves no
// trace. Order of checks: case not found, then case or client archived, then (for
// an edit) the entry must belong to that case, then input. Entries are never
// deleted and write no case_events row. All SQL is parameterized and nothing
// submitted is ever echoed back in a failure.

const defaultClock: RepositoryClock = { now: () => new Date(), newId: () => randomUUID() }

interface JournalRow {
  id: string
  case_id: string
  occurred_at: string
  activity: string | null
  body: string
  created_at: string
  updated_at: string
}

function toEntry(row: JournalRow): JournalEntry {
  return {
    id: row.id,
    caseId: row.case_id,
    occurredAt: row.occurred_at,
    activity: row.activity,
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export class CaseJournalRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: RepositoryClock = defaultClock
  ) {}

  /** Newest first (see compareJournalEntries); empty for an unknown case. */
  list(caseId: string): JournalEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM case_journal_entries WHERE case_id = ? ORDER BY occurred_at DESC, created_at DESC, id DESC')
      .all(caseId) as unknown as JournalRow[]
    return rows.map(toEntry)
  }

  create(caseId: string, raw: JournalEntryInput): JournalMutationResult {
    return this.transaction(() => {
      const blocked = this.checkCase(caseId)
      if (blocked) return blocked
      const { input, issues } = checkJournalEntry(raw, this.clock.now())
      if (!input) return { ok: false, reason: 'invalid', issues }

      const now = this.clock.now().toISOString()
      const id = this.clock.newId()
      this.db
        .prepare(
          `INSERT INTO case_journal_entries (id, case_id, occurred_at, activity, body, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, caseId, input.occurredAt, input.activity, input.body, now, now)
      this.touchCase(caseId, now)
      return this.found(caseId, id)
    })
  }

  update(caseId: string, entryId: string, raw: JournalEntryInput): JournalMutationResult {
    return this.transaction(() => {
      const blocked = this.checkCase(caseId)
      if (blocked) return blocked
      if (!this.db.prepare('SELECT 1 FROM case_journal_entries WHERE id = ? AND case_id = ?').get(entryId, caseId)) {
        return { ok: false, reason: 'not-found' }
      }
      const { input, issues } = checkJournalEntry(raw, this.clock.now())
      if (!input) return { ok: false, reason: 'invalid', issues }

      const now = this.clock.now().toISOString()
      this.db
        .prepare(
          'UPDATE case_journal_entries SET occurred_at = ?, activity = ?, body = ?, updated_at = ? WHERE id = ? AND case_id = ?'
        )
        .run(input.occurredAt, input.activity, input.body, now, entryId, caseId)
      this.touchCase(caseId, now)
      return this.found(caseId, entryId)
    })
  }

  private transaction(work: () => JournalMutationResult): JournalMutationResult {
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
  private checkCase(caseId: string): JournalMutationResult | null {
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

  private found(caseId: string, entryId: string): JournalMutationResult {
    const row = this.db.prepare('SELECT * FROM case_journal_entries WHERE id = ? AND case_id = ?').get(entryId, caseId) as
      | JournalRow
      | undefined
    return row ? { ok: true, entry: toEntry(row) } : { ok: false, reason: 'not-found' }
  }
}
