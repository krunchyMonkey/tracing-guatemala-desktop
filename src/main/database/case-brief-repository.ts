import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { checkCaseBrief, emptyBrief, type CaseBrief, type CaseBriefInput, type CaseBriefMutationResult } from '../../shared/case-brief'
import type { RepositoryClock } from './client-repository'

// Case research brief persistence (case-brief/v1). A save reads the case and its
// client, checks the rules, upserts the brief and bumps the case's updated_at
// inside one BEGIN IMMEDIATE transaction, so a refused save leaves no trace.
// Order of checks: not-found, then case or client archived, then input. Saving
// writes no case_events row. All SQL is parameterized and nothing submitted is
// ever echoed back in a failure.

const defaultClock: RepositoryClock = { now: () => new Date(), newId: () => randomUUID() }

interface BriefRow {
  case_id: string
  objective: string | null
  facts: string | null
  people: string | null
  hypotheses: string | null
  questions: string | null
  updated_at: string
}

function toBrief(row: BriefRow): CaseBrief {
  return {
    caseId: row.case_id,
    objective: row.objective,
    facts: row.facts,
    people: row.people,
    hypotheses: row.hypotheses,
    questions: row.questions,
    updatedAt: row.updated_at
  }
}

export class CaseBriefRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: RepositoryClock = defaultClock
  ) {}

  /** The saved brief, an all-empty one for a case without a brief, or null for an unknown case. */
  get(caseId: string): CaseBrief | null {
    if (!this.db.prepare('SELECT 1 FROM research_cases WHERE id = ?').get(caseId)) return null
    const row = this.db.prepare('SELECT * FROM case_briefs WHERE case_id = ?').get(caseId) as BriefRow | undefined
    return row ? toBrief(row) : emptyBrief(caseId)
  }

  save(caseId: string, raw: CaseBriefInput): CaseBriefMutationResult {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = this.write(caseId, raw)
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private write(caseId: string, raw: CaseBriefInput): CaseBriefMutationResult {
    const row = this.db
      .prepare(
        `SELECT c.archived_at AS case_archived_at, k.status AS client_status
         FROM research_cases c JOIN clients k ON k.id = c.client_id WHERE c.id = ?`
      )
      .get(caseId) as { case_archived_at: string | null; client_status: string } | undefined
    if (!row) return { ok: false, reason: 'not-found' }
    if (row.client_status !== 'active' || row.case_archived_at !== null) return { ok: false, reason: 'wrong-status' }
    const { input, issues } = checkCaseBrief(raw)
    if (!input) return { ok: false, reason: 'invalid', issues }

    const now = this.clock.now().toISOString()
    this.db
      .prepare(
        `INSERT INTO case_briefs (case_id, objective, facts, people, hypotheses, questions, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (case_id) DO UPDATE SET objective = excluded.objective, facts = excluded.facts,
           people = excluded.people, hypotheses = excluded.hypotheses, questions = excluded.questions,
           updated_at = excluded.updated_at`
      )
      .run(caseId, input.objective, input.facts, input.people, input.hypotheses, input.questions, now, now)
    this.db.prepare('UPDATE research_cases SET updated_at = ? WHERE id = ?').run(now, caseId)
    const saved = this.get(caseId)
    return saved ? { ok: true, brief: saved } : { ok: false, reason: 'not-found' }
  }
}
