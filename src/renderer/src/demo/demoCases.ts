import {
  checkJournalEntry,
  compareJournalEntries,
  type JournalEntry,
  type JournalMutationResult
} from '../../../shared/case-journal'
import { checkCaseBrief, emptyBrief, type CaseBrief, type CaseBriefMutationResult } from '../../../shared/case-brief'
import {
  canTransition,
  checkCase,
  queryCases,
  type CaseEvent,
  type CaseInput,
  type CaseMutationResult,
  type CaseState,
  type ResearchCase
} from '../../../shared/case-model'
import type { Client } from '../../../shared/client-model'
import type { CaseApi } from '../runtime/AppRuntime'
import type { DemoClock } from './demoApi'

// The browser demo's research cases (#16): fictional cases held in this page's
// memory only. Same shared rules and check order as the host's repository
// (src/main/database/case-repository.ts): not found, then client archived (create)
// or case/client archived (changes), then the transition matrix, then validation.
// Research briefs (#17) follow the same rules: not found, then case/client
// archived, then validation; a save also moves the case's updated time.
// The research journal (#18) uses the same order of checks: case not found,
// case/client archived, entry belongs to the case, then validation.
// Cases read client status through the demo's own client data, so archiving a
// client in the demo makes its cases read-only like everywhere else.

export interface DemoCaseData {
  cases: ResearchCase[]
  events: CaseEvent[]
  briefs: CaseBrief[]
  journal: JournalEntry[]
}

export function createDemoCases(
  initial: DemoCaseData,
  getClient: (id: string) => Promise<Client | null>,
  clock: DemoClock
): CaseApi {
  let cases = structuredClone(initial.cases)
  let events = structuredClone(initial.events)
  let briefs = structuredClone(initial.briefs)
  let journal = structuredClone(initial.journal)

  const reply = async <T>(work: () => T): Promise<T> => structuredClone(work())

  const addEvent = (caseId: string, kind: CaseEvent['kind'], from: CaseState | null, to: CaseState | null, at: string) => {
    events = [...events, { id: clock.newId(), caseId, kind, fromState: from, toState: to, occurredAt: at }]
  }

  const store = (next: ResearchCase): CaseMutationResult => {
    cases = cases.map((c) => (c.id === next.id ? next : c))
    return { ok: true, case: next }
  }

  /** The case if it can be changed; otherwise the refusal. */
  async function writable(id: string): Promise<ResearchCase | CaseMutationResult> {
    const existing = cases.find((c) => c.id === id)
    if (!existing) return { ok: false, reason: 'not-found' }
    if ((await getClient(existing.clientId))?.status !== 'active') return { ok: false, reason: 'wrong-status' }
    if (existing.archivedAt !== null) return { ok: false, reason: 'wrong-status' }
    return existing
  }
  const isRefusal = (value: ResearchCase | CaseMutationResult): value is CaseMutationResult => 'ok' in value

  return {
    listCases: (query) => reply(() => queryCases(cases, query)),
    getCase: (id) => reply(() => cases.find((c) => c.id === id) ?? null),
    listCaseEvents: (caseId) =>
      reply(() =>
        events
          .map((event, index) => ({ event, index }))
          .filter(({ event }) => event.caseId === caseId)
          .sort((a, b) => b.event.occurredAt.localeCompare(a.event.occurredAt) || b.index - a.index)
          .map(({ event }) => event)
      ),

    async createCase(clientId: string, raw: CaseInput) {
      const client = await getClient(clientId)
      if (!client) return { ok: false, reason: 'not-found' }
      if (client.status !== 'active') return { ok: false, reason: 'client-archived' }
      const { input, issues } = checkCase(raw)
      if (!input) return { ok: false, reason: 'invalid', issues }

      const at = clock.now().toISOString()
      const researchCase: ResearchCase = {
        ...input,
        id: clock.newId(),
        clientId,
        state: 'intake',
        stateChangedAt: at,
        createdAt: at,
        updatedAt: at,
        archivedAt: null
      }
      cases = [...cases, researchCase]
      addEvent(researchCase.id, 'created', null, 'intake', at)
      return structuredClone({ ok: true as const, case: researchCase })
    },

    async updateCase(id, raw) {
      const existing = await writable(id)
      if (isRefusal(existing)) return existing
      const { input, issues } = checkCase(raw)
      if (!input) return { ok: false, reason: 'invalid', issues }
      return structuredClone(store({ ...existing, ...input, updatedAt: clock.now().toISOString() }))
    },

    async setCaseState(id, to) {
      const existing = await writable(id)
      if (isRefusal(existing)) return existing
      if (!canTransition(existing.state, to)) return { ok: false, reason: 'invalid-transition' }
      const at = clock.now().toISOString()
      addEvent(id, 'state', existing.state, to, at)
      return structuredClone(store({ ...existing, state: to, stateChangedAt: at, updatedAt: at }))
    },

    async archiveCase(id) {
      const existing = await writable(id)
      if (isRefusal(existing)) return existing
      const at = clock.now().toISOString()
      addEvent(id, 'archived', null, null, at)
      return structuredClone(store({ ...existing, archivedAt: at, updatedAt: at }))
    },

    async unarchiveCase(id) {
      const existing = cases.find((c) => c.id === id)
      if (!existing) return { ok: false, reason: 'not-found' }
      if ((await getClient(existing.clientId))?.status !== 'active') return { ok: false, reason: 'wrong-status' }
      if (existing.archivedAt === null) return { ok: false, reason: 'wrong-status' }
      const at = clock.now().toISOString()
      addEvent(id, 'unarchived', null, null, at)
      return structuredClone(store({ ...existing, archivedAt: null, updatedAt: at }))
    },

    getCaseBrief: (caseId) =>
      reply(() => (cases.some((c) => c.id === caseId) ? (briefs.find((b) => b.caseId === caseId) ?? emptyBrief(caseId)) : null)),

    async saveCaseBrief(caseId, raw) {
      const existing = await writable(caseId)
      if (isRefusal(existing)) return existing as CaseBriefMutationResult
      const { input, issues } = checkCaseBrief(raw)
      if (!input) return { ok: false, reason: 'invalid', issues }

      const at = clock.now().toISOString()
      const brief: CaseBrief = { ...input, caseId, updatedAt: at }
      briefs = [...briefs.filter((b) => b.caseId !== caseId), brief]
      store({ ...existing, updatedAt: at })
      return structuredClone({ ok: true as const, brief })
    },

    listJournalEntries: (caseId) =>
      reply(() => journal.filter((e) => e.caseId === caseId).sort(compareJournalEntries)),

    async createJournalEntry(caseId, raw) {
      const existing = await writable(caseId)
      if (isRefusal(existing)) return existing as JournalMutationResult
      const { input, issues } = checkJournalEntry(raw, clock.now())
      if (!input) return { ok: false, reason: 'invalid', issues }

      const at = clock.now().toISOString()
      const entry: JournalEntry = { ...input, id: clock.newId(), caseId, createdAt: at, updatedAt: at }
      journal = [...journal, entry]
      store({ ...existing, updatedAt: at })
      return structuredClone({ ok: true as const, entry })
    },

    async updateJournalEntry(caseId, entryId, raw) {
      const existing = await writable(caseId)
      if (isRefusal(existing)) return existing as JournalMutationResult
      const current = journal.find((e) => e.id === entryId && e.caseId === caseId)
      if (!current) return { ok: false, reason: 'not-found' }
      const { input, issues } = checkJournalEntry(raw, clock.now())
      if (!input) return { ok: false, reason: 'invalid', issues }

      const at = clock.now().toISOString()
      const entry: JournalEntry = { ...current, ...input, updatedAt: at }
      journal = journal.map((e) => (e.id === entryId ? entry : e))
      store({ ...existing, updatedAt: at })
      return structuredClone({ ok: true as const, entry })
    }
  }
}
