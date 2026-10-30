import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildDemoCases, buildDemoData, demoCaseIds, demoClientIds } from '../../src/renderer/src/demo/sampleData'
import { checkCase, canTransition, checkDateOnly, localDateString, type CaseState } from '../../src/shared/case-model'
import { checkCaseTask } from '../../src/shared/case-tasks'
import { checkJournalEntry } from '../../src/shared/case-journal'
import { checkTimeEntry } from '../../src/shared/case-time'
import { checkCaseBrief } from '../../src/shared/case-brief'
import { checkClient, checkNote, CLIENT_SOURCES, CLIENT_STATUSES, CONTACT_CHANNELS } from '../../src/shared/client-model'

// The 48-client fictional portfolio (#115). These checks run on the built fixtures
// only: nothing is written anywhere, and no network or storage is involved.

const now = new Date('2026-10-30T12:00:00')
const today = localDateString(now)
const { clients, notes } = buildDemoData(now)
const { cases, events, briefs, journal, tasks, timeEntries } = buildDemoCases(now)
const clientIds = new Set(clients.map((c) => c.id))
const caseById = new Map(cases.map((c) => [c.id, c]))

const allIds = [
  ...clients.map((c) => c.id),
  ...notes.map((n) => n.id),
  ...cases.map((c) => c.id),
  ...events.map((e) => e.id),
  ...journal.map((e) => e.id),
  ...tasks.map((t) => t.id),
  ...timeEntries.map((t) => t.id)
]

const clientOf = (caseId: string) => caseById.get(caseId)?.clientId

describe('portfolio size and identity', () => {
  it('has 48 clients, with unique ids across every record kind', () => {
    expect(clients).toHaveLength(48)
    expect(new Set(allIds).size).toBe(allIds.length)
    for (const id of allIds) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('keeps the original eight ids and display names', () => {
    const byId = new Map(clients.map((c) => [c.id, c.displayName]))
    const original: [string, string][] = [
      [demoClientIds.lucia, 'Lucía Fernández (Quetzaltenango line)'],
      [demoClientIds.daniel, 'Daniel Ochoa'],
      [demoClientIds.mariaJose, 'María José Alvarado'],
      [demoClientIds.sofia, 'Sofía Tzul'],
      [demoClientIds.grace, 'Grace Whitfield'],
      [demoClientIds.ethan, 'Ethan Morales-Reyes'],
      [demoClientIds.tomas, 'Tomás Recinos'],
      [demoClientIds.rosa, 'Rosa Chávez Ixcoy']
    ]
    for (const [id, name] of original) expect(byId.get(id)).toBe(name)
    expect(Object.values(demoClientIds)).toHaveLength(8)
  })

  it('keeps the original case ids', () => {
    const caseIds = new Set(cases.map((c) => c.id))
    for (const id of Object.values(demoCaseIds)) expect(caseIds.has(id)).toBe(true)
  })
})

describe('link integrity', () => {
  it('points every note and case at an existing client', () => {
    for (const note of notes) expect(clientIds.has(note.clientId)).toBe(true)
    for (const c of cases) expect(clientIds.has(c.clientId)).toBe(true)
  })

  it('points every case-level record at an existing case of an existing client', () => {
    const children = [...events, ...briefs, ...journal, ...tasks, ...timeEntries] as { caseId: string }[]
    for (const child of children) {
      expect(caseById.has(child.caseId), `missing case for ${child.caseId}`).toBe(true)
      expect(clientIds.has(clientOf(child.caseId)!)).toBe(true)
    }
  })

  it('keeps every brief one per case', () => {
    const briefCases = briefs.map((b) => b.caseId)
    expect(new Set(briefCases).size).toBe(briefCases.length)
  })
})

describe('shared validators', () => {
  it('passes every client, note, case, journal entry, task, time entry and brief', () => {
    for (const c of clients) {
      const { input, issues } = checkClient({
        displayName: c.displayName,
        source: c.source,
        sourceDetail: c.sourceDetail,
        fiverrUsername: c.fiverrUsername,
        email: c.email,
        otherContact: c.otherContact,
        preferredContactChannel: c.preferredContactChannel
      })
      expect(issues.filter((i) => i.severity === 'error'), c.displayName).toEqual([])
      expect(input, c.displayName).not.toBeNull()
    }
    for (const note of notes.filter((n) => n.kind !== 'system')) {
      const { issues } = checkNote({ kind: note.kind as 'note' | 'contact', occurredAt: note.occurredAt, channel: note.channel, direction: note.direction, body: note.body }, now)
      expect(issues, note.id).toEqual([])
    }
    for (const c of cases) {
      expect(checkCase({ title: c.title, goal: c.goal, orderReference: c.orderReference, dueDate: c.dueDate }).issues, c.id).toEqual([])
      if (c.dueDate) expect(checkDateOnly(c.dueDate)).toBeNull()
    }
    for (const e of journal) {
      expect(checkJournalEntry({ occurredAt: e.occurredAt, activity: e.activity, body: e.body }, now).issues, e.id).toEqual([])
    }
    for (const t of tasks) {
      expect(checkCaseTask({ title: t.title, description: t.description, dueDate: t.dueDate }).issues, t.id).toEqual([])
    }
    for (const t of timeEntries) {
      expect(
        checkTimeEntry({ workDate: t.workDate, durationMinutes: t.durationMinutes, activityType: t.activityType, note: t.note }).issues,
        t.id
      ).toEqual([])
    }
    for (const b of briefs) {
      expect(
        checkCaseBrief({ objective: b.objective, facts: b.facts, people: b.people, hypotheses: b.hypotheses, questions: b.questions }).issues,
        b.caseId
      ).toEqual([])
    }
  })

  it('keeps every case history on the lifecycle matrix and ending in the case state', () => {
    for (const c of cases) {
      const steps = events.filter((e) => e.caseId === c.id && e.kind === 'state')
      let state: CaseState = 'intake'
      for (const step of steps) {
        expect(step.fromState, c.id).toBe(state)
        expect(canTransition(step.fromState!, step.toState!), `${c.id} ${step.fromState}>${step.toState}`).toBe(true)
        state = step.toState!
      }
      expect(state, c.id).toBe(c.state)
    }
  })
})

describe('coverage of allowed values', () => {
  it('uses every client status, source and contact channel', () => {
    for (const status of CLIENT_STATUSES) expect(clients.some((c) => c.status === status), status).toBe(true)
    for (const source of CLIENT_SOURCES) expect(clients.some((c) => c.source === source), source).toBe(true)
    for (const channel of CONTACT_CHANNELS) {
      expect(clients.some((c) => c.preferredContactChannel === channel), channel).toBe(true)
    }
  })

  it('uses every case state, plus archived cases and every event kind', () => {
    for (const state of ['intake', 'active', 'waiting', 'delivered', 'closed'] as const) {
      expect(cases.some((c) => c.state === state), state).toBe(true)
    }
    expect(cases.some((c) => c.archivedAt !== null)).toBe(true)
    for (const kind of ['created', 'state', 'archived'] as const) expect(events.some((e) => e.kind === kind), kind).toBe(true)
  })

  it('uses both task statuses, both time sources and an undated task', () => {
    expect(tasks.some((t) => t.status === 'pending')).toBe(true)
    expect(tasks.some((t) => t.status === 'completed')).toBe(true)
    expect(tasks.some((t) => t.dueDate === null)).toBe(true)
    expect(new Set(timeEntries.map((t) => t.source))).toEqual(new Set(['timer', 'manual']))
  })
})

describe('distribution', () => {
  const casesPerClient = (id: string) => cases.filter((c) => c.clientId === id).length
  const counts = clients.map((c) => casesPerClient(c.id))

  it('has about six repeat customers with two or three cases each', () => {
    const repeat = counts.filter((n) => n >= 2)
    expect(repeat).toHaveLength(6)
    expect(repeat.every((n) => n === 2 || n === 3)).toBe(true)
  })

  it('has about thirty clients with exactly one case and the rest with none', () => {
    expect(counts.filter((n) => n === 1)).toHaveLength(30)
    expect(counts.filter((n) => n === 0)).toHaveLength(12)
  })

  it('gives most active cases a brief, with 1 to 4 journal entries and 1 to 5 tasks', () => {
    // The original seven cases keep their hand-written records; the rules apply to the portfolio.
    const original = new Set<string>(Object.values(demoCaseIds))
    const open = cases.filter(
      (c) => !original.has(c.id) && (c.state === 'active' || c.state === 'waiting') && c.archivedAt === null
    )
    const withBrief = open.filter((c) => briefs.some((b) => b.caseId === c.id))
    expect(withBrief.length / open.length).toBeGreaterThan(0.5)
    for (const c of open) {
      const entries = journal.filter((j) => j.caseId === c.id).length
      const caseTasks = tasks.filter((t) => t.caseId === c.id).length
      expect(entries, c.id).toBeGreaterThanOrEqual(1)
      expect(entries, c.id).toBeLessThanOrEqual(4)
      expect(caseTasks, c.id).toBeGreaterThanOrEqual(1)
      expect(caseTasks, c.id).toBeLessThanOrEqual(5)
    }
  })

  it('has overdue, due-soon and done next steps on open cases', () => {
    const open = new Set(cases.filter((c) => c.state === 'active' || c.state === 'waiting' || c.state === 'intake').map((c) => c.id))
    const pending = tasks.filter((t) => t.status === 'pending' && open.has(t.caseId))
    expect(pending.some((t) => t.dueDate !== null && t.dueDate < today)).toBe(true)
    expect(pending.some((t) => t.dueDate !== null && t.dueDate >= today && t.dueDate <= localDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 3)))).toBe(true)
    expect(tasks.some((t) => t.status === 'completed' && open.has(t.caseId))).toBe(true)
  })
})

describe('archive and closure consistency', () => {
  it('has no pending task with a future deadline on a closed or delivered case', () => {
    for (const c of cases.filter((x) => x.state === 'closed' || x.state === 'delivered')) {
      const future = tasks.filter((t) => t.caseId === c.id && t.status === 'pending' && t.dueDate !== null && t.dueDate >= today)
      expect(future, c.id).toEqual([])
    }
  })

  it('has archived clients with only archived or closed cases', () => {
    for (const client of clients.filter((c) => c.status === 'archived')) {
      for (const c of cases.filter((x) => x.clientId === client.id)) {
        expect(c.state === 'closed' || c.archivedAt !== null, `${client.displayName}: ${c.title}`).toBe(true)
      }
    }
  })

  it('gives archived clients an archive date and an Archived. system entry', () => {
    for (const client of clients) {
      expect(client.archivedAt !== null, client.displayName).toBe(client.status === 'archived')
    }
    for (const client of clients.filter((c) => c.status === 'archived')) {
      expect(notes.some((n) => n.clientId === client.id && n.kind === 'system' && n.body === 'Archived.'), client.displayName).toBe(true)
    }
  })
})

describe('contacts and determinism', () => {
  it('uses only reserved example.com or example.org emails', () => {
    const emails = clients.map((c) => c.email).filter((e): e is string => e !== null)
    expect(emails.length).toBeGreaterThan(0)
    for (const email of emails) expect(email, email).toMatch(/@example\.(com|org)$/)
  })

  it('builds the same data twice from the same clock', () => {
    expect(buildDemoData(now)).toEqual(buildDemoData(now))
    expect(buildDemoCases(now)).toEqual(buildDemoCases(now))
  })

  it('builds the whole fixture set quickly', () => {
    const started = performance.now()
    buildDemoData(now)
    buildDemoCases(now)
    expect(performance.now() - started).toBeLessThan(50)
  })
})

describe('isolation', () => {
  it('imports the demo data only from the demo folder and tests', () => {
    const root = resolve(__dirname, '../..')
    const files: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (/\.(ts|tsx)$/.test(name)) files.push(path)
      }
    }
    walk(join(root, 'src'))
    const demoDir = join(root, 'src/renderer/src/demo')
    const offenders = files
      .filter((file) => !file.startsWith(demoDir))
      .filter((file) => /sampleData|portfolioData/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(root, file))
    expect(offenders).toEqual([])
  })
})
