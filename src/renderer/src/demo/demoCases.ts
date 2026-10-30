import {
  checkJournalEntry,
  compareJournalEntries,
  type JournalEntry,
  type JournalMutationResult
} from '../../../shared/case-journal'
import { checkCaseTask, compareTasks, type CaseTask, type CaseTaskMutationResult } from '../../../shared/case-tasks'
import { localDateString } from '../../../shared/case-model'
import {
  checkTimeEntry,
  compareEntries,
  evaluateTimer,
  heartbeatRecord,
  newTimerRecord,
  normalizeNote,
  pausedRecord,
  planStop,
  resumedRecord,
  type TimeEntry,
  type TimeEntryInput,
  type TimeEntryMutationResult,
  type TimerRecord,
  type TimerResult
} from '../../../shared/case-time'
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
import { buildStudioSummary } from '../../../shared/studio-summary'
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
// Case tasks (#19) use that order too, plus: complete/reopen of a task already in
// that status is refused (wrong-status) with no change.
// Research hours (#109) follow it as well, and the timer is the same state machine as
// the host's (shared transitions, version conflicts, review of an interrupted
// timer); it lives in this page's memory, so a refresh forgets it.
// Cases read client status through the demo's own client data, so archiving a
// client in the demo makes its cases read-only like everywhere else.

export interface DemoCaseData {
  cases: ResearchCase[]
  events: CaseEvent[]
  briefs: CaseBrief[]
  journal: JournalEntry[]
  tasks: CaseTask[]
  timeEntries: TimeEntry[]
}

export function createDemoCases(
  initial: DemoCaseData,
  getClient: (id: string) => Promise<Client | null>,
  clock: DemoClock,
  listClients?: () => Promise<Client[]>
): CaseApi {
  let cases = structuredClone(initial.cases)
  let events = structuredClone(initial.events)
  let briefs = structuredClone(initial.briefs)
  let journal = structuredClone(initial.journal)
  let tasks = structuredClone(initial.tasks)
  let timeEntries = structuredClone(initial.timeEntries)
  let timer: TimerRecord | null = null

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
    },

    listCaseTasks: (caseId) => reply(() => tasks.filter((t) => t.caseId === caseId).sort(compareTasks)),

    async createCaseTask(caseId, raw) {
      const existing = await writable(caseId)
      if (isRefusal(existing)) return existing as CaseTaskMutationResult
      const { input, issues } = checkCaseTask(raw)
      if (!input) return { ok: false, reason: 'invalid', issues }

      const at = clock.now().toISOString()
      const task: CaseTask = { ...input, id: clock.newId(), caseId, status: 'pending', completedAt: null, createdAt: at, updatedAt: at }
      tasks = [...tasks, task]
      store({ ...existing, updatedAt: at })
      return structuredClone({ ok: true as const, task })
    },

    async updateCaseTask(caseId, taskId, raw) {
      const existing = await writable(caseId)
      if (isRefusal(existing)) return existing as CaseTaskMutationResult
      const current = tasks.find((t) => t.id === taskId && t.caseId === caseId)
      if (!current) return { ok: false, reason: 'not-found' }
      const { input, issues } = checkCaseTask(raw)
      if (!input) return { ok: false, reason: 'invalid', issues }

      const at = clock.now().toISOString()
      const task: CaseTask = { ...current, ...input, updatedAt: at }
      tasks = tasks.map((t) => (t.id === taskId ? task : t))
      store({ ...existing, updatedAt: at })
      return structuredClone({ ok: true as const, task })
    },

    completeCaseTask: (caseId, taskId) => setTaskStatus(caseId, taskId, 'completed'),
    reopenCaseTask: (caseId, taskId) => setTaskStatus(caseId, taskId, 'pending'),

    listTimeEntries: (caseId) => reply(() => timeEntries.filter((e) => e.caseId === caseId).sort(compareEntries)),

    async createTimeEntry(caseId, raw) {
      const existing = await writable(caseId)
      if (isRefusal(existing)) return existing as TimeEntryMutationResult
      const { input, issues } = checkTimeEntry(raw)
      if (!input) return { ok: false, reason: 'invalid', issues }
      const at = clock.now().toISOString()
      const entry = addEntry(caseId, input, 'manual', at)
      store({ ...existing, updatedAt: at })
      return structuredClone({ ok: true as const, entry })
    },

    async updateTimeEntry(caseId, entryId, raw) {
      const existing = await writable(caseId)
      if (isRefusal(existing)) return existing as TimeEntryMutationResult
      const current = timeEntries.find((e) => e.id === entryId && e.caseId === caseId)
      if (!current) return { ok: false, reason: 'not-found' }
      const { input, issues } = checkTimeEntry(raw)
      if (!input) return { ok: false, reason: 'invalid', issues }
      const at = clock.now().toISOString()
      const entry: TimeEntry = { ...current, ...input, updatedAt: at }
      timeEntries = timeEntries.map((e) => (e.id === entryId ? entry : e))
      store({ ...existing, updatedAt: at })
      return structuredClone({ ok: true as const, entry })
    },

    async deleteTimeEntry(caseId, entryId) {
      const existing = await writable(caseId)
      if (isRefusal(existing)) return existing as TimeEntryMutationResult
      const current = timeEntries.find((e) => e.id === entryId && e.caseId === caseId)
      if (!current) return { ok: false, reason: 'not-found' }
      timeEntries = timeEntries.filter((e) => e.id !== entryId)
      store({ ...existing, updatedAt: clock.now().toISOString() })
      return structuredClone({ ok: true as const, entry: current })
    },

    getActiveTimer: () => reply(() => (timer ? evaluateTimer(timer, clock.now()) : null)),

    async startTimer(caseId): Promise<TimerResult> {
      const existing = await writable(caseId)
      if (isRefusal(existing)) return existing as TimerResult
      const now = clock.now()
      if (timer) {
        const snapshot = evaluateTimer(timer, now)
        return structuredClone(timer.caseId === caseId ? { ok: true as const, timer: snapshot, entry: null } : { ok: false as const, reason: 'other-case-timer' as const, timer: snapshot })
      }
      timer = newTimerRecord(caseId, now)
      return structuredClone({ ok: true as const, timer: evaluateTimer(timer, now), entry: null })
    },

    async pauseTimer(version): Promise<TimerResult> {
      const found = expectTimer(version)
      if ('ok' in found) return found
      if (found.state === 'paused') return { ok: false, reason: 'wrong-status' }
      const now = clock.now()
      const snapshot = evaluateTimer(found, now)
      if (snapshot.needsReview) return { ok: false, reason: 'needs-review', timer: snapshot }
      timer = pausedRecord(found, now)
      return structuredClone({ ok: true as const, timer: evaluateTimer(timer, now), entry: null })
    },

    async resumeTimer(version): Promise<TimerResult> {
      const found = expectTimer(version)
      if ('ok' in found) return found
      if (found.state === 'running') return { ok: false, reason: 'wrong-status' }
      const blocked = await writable(found.caseId)
      if (isRefusal(blocked)) return blocked as TimerResult
      const now = clock.now()
      timer = resumedRecord(found, now)
      return structuredClone({ ok: true as const, timer: evaluateTimer(timer, now), entry: null })
    },

    async heartbeatTimer(version): Promise<TimerResult> {
      const found = expectTimer(version)
      if ('ok' in found) return found
      const now = clock.now()
      const snapshot = evaluateTimer(found, now)
      if (found.state === 'running' && !snapshot.needsReview) timer = heartbeatRecord(found, now)
      return structuredClone({ ok: true as const, timer: timer ? evaluateTimer(timer, now) : null, entry: null })
    },

    async stopAndSaveTimer(version, options): Promise<TimerResult> {
      const found = expectTimer(version)
      if ('ok' in found) return found
      const existing = await writable(found.caseId)
      if (isRefusal(existing)) return existing as TimerResult
      const now = clock.now()
      const plan = planStop(found, now, options)
      if (!plan.ok) return structuredClone(plan)
      const at = now.toISOString()
      const entry = addEntry(
        found.caseId,
        { workDate: localDateString(plan.workedAt), durationMinutes: plan.minutes, activityType: options.activityType, note: normalizeNote(options.note) },
        'timer',
        at
      )
      timer = null
      store({ ...existing, updatedAt: at })
      return structuredClone({ ok: true as const, timer: null, entry })
    },

    async discardTimer(version): Promise<TimerResult> {
      const found = expectTimer(version)
      if ('ok' in found) return found
      timer = null
      return { ok: true, timer: null, entry: null }
    },

    // Same figures as the host's SQL (studio-summary/v1), from this page's memory; clients are read
    // through getClient so an archived demo client drops out like it does in Live.
    async getStudioSummary() {
      // Active clients come from the demo's client list when given (so clients without cases count);
      // otherwise from the clients that have cases.
      const listed = listClients ? await listClients() : null
      const ids = listed ? [] : [...new Set(cases.map((c) => c.clientId))]
      const found = listed ?? (await Promise.all(ids.map((id) => getClient(id)))).flatMap((c) => (c ? [c] : []))
      const clients = found.map((c) => ({ id: c.id, status: c.status, displayName: c.displayName }))
      return structuredClone(buildStudioSummary({ clients, cases, events, journal, tasks, timeEntries }, clock.now()))
    }
  }

  function addEntry(caseId: string, input: TimeEntryInput, source: TimeEntry['source'], at: string): TimeEntry {
    const entry: TimeEntry = { ...input, id: clock.newId(), caseId, source, createdAt: at, updatedAt: at }
    timeEntries = [...timeEntries, entry]
    return entry
  }

  function expectTimer(version: number): TimerRecord | Extract<TimerResult, { ok: false }> {
    if (!timer) return { ok: false, reason: 'not-found' }
    if (timer.version !== version) return structuredClone({ ok: false as const, reason: 'conflict' as const, timer: evaluateTimer(timer, clock.now()) })
    return timer
  }

  async function setTaskStatus(caseId: string, taskId: string, status: CaseTask['status']): Promise<CaseTaskMutationResult> {
    const existing = await writable(caseId)
    if (isRefusal(existing)) return existing as CaseTaskMutationResult
    const current = tasks.find((t) => t.id === taskId && t.caseId === caseId)
    if (!current) return { ok: false, reason: 'not-found' }
    if (current.status === status) return { ok: false, reason: 'wrong-status' }

    const at = clock.now().toISOString()
    const task: CaseTask = { ...current, status, completedAt: status === 'completed' ? at : null, updatedAt: at }
    tasks = tasks.map((t) => (t.id === taskId ? task : t))
    store({ ...existing, updatedAt: at })
    return structuredClone({ ok: true as const, task })
  }
}
