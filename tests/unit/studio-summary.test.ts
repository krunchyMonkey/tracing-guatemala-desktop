import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { CaseJournalRepository } from '../../src/main/database/case-journal-repository'
import { CaseRepository } from '../../src/main/database/case-repository'
import { CaseTaskRepository } from '../../src/main/database/case-task-repository'
import { CaseTimeRepository } from '../../src/main/database/case-time-repository'
import { ClientRepository } from '../../src/main/database/client-repository'
import { configureConnection } from '../../src/main/database/connection'
import { migrate } from '../../src/main/database/migrations'
import { StudioSummaryRepository } from '../../src/main/database/studio-summary-repository'
import type { CaseState } from '../../src/shared/case-model'
import { addDays, hoursLabel, hoursRanges, loggedLabel } from '../../src/shared/studio-summary'

// Research Studio summary (#116): the SQL aggregate over real repositories in an
// in-memory database. Fictional data only.

const SECRET = 'SECRET-BODY-TEXT'

/** A clock the test sets by hand, so created/updated times (and so ordering) are exact. */
function setup() {
  const db = new DatabaseSync(':memory:')
  configureConnection(db)
  migrate(db)
  let at = new Date('2026-10-20T09:00:00.000Z')
  let n = 0
  const clock = { now: () => at, newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` }
  const repos = {
    clients: new ClientRepository(db, clock),
    cases: new CaseRepository(db, clock),
    tasks: new CaseTaskRepository(db, clock),
    journal: new CaseJournalRepository(db, clock),
    time: new CaseTimeRepository(db, clock),
    studio: new StudioSummaryRepository(db, clock)
  }
  const at$ = (iso: string) => void (at = new Date(iso))

  const client = (displayName: string, email: string | null = null): string => {
    const r = repos.clients.create({
      displayName,
      source: 'direct',
      sourceDetail: null,
      fiverrUsername: null,
      email,
      otherContact: null,
      preferredContactChannel: 'unspecified'
    })
    if (!r.ok) throw new Error('client')
    return r.client.id
  }
  const newCase = (clientId: string, title: string, state: CaseState = 'intake', dueDate: string | null = null): string => {
    const r = repos.cases.create(clientId, { title, goal: SECRET, orderReference: null, dueDate })
    if (!r.ok) throw new Error('case')
    const path: Record<CaseState, CaseState[]> = {
      intake: [],
      active: ['active'],
      waiting: ['active', 'waiting'],
      delivered: ['active', 'delivered'],
      closed: ['active', 'closed']
    }
    for (const step of path[state]) repos.cases.setState(r.case.id, step)
    return r.case.id
  }
  const task = (caseId: string, title: string, dueDate: string | null, done = false): string => {
    const r = repos.tasks.create(caseId, { title, description: SECRET, dueDate })
    if (!r.ok) throw new Error('task')
    if (done) repos.tasks.complete(caseId, r.task.id)
    return r.task.id
  }
  const entry = (caseId: string) => {
    const r = repos.journal.create(caseId, { occurredAt: at.toISOString(), activity: null, body: SECRET })
    if (!r.ok) throw new Error('journal')
  }
  const hours = (caseId: string, workDate: string, durationMinutes: number) => {
    const r = repos.time.create(caseId, { workDate, durationMinutes, activityType: null, note: SECRET })
    if (!r.ok) throw new Error('time')
  }
  return { db, repos, at: at$, client, newCase, task, entry, hours }
}

/** Wednesday 2026-10-28, local midday. Week = Mon 10-26 to Sun 11-01. */
const NOW = new Date(2026, 9, 28, 12, 0, 0)

let t: ReturnType<typeof setup>
beforeEach(() => {
  t = setup()
})

describe('shared helpers', () => {
  it('moves dates by calendar days and finds the Monday-Sunday week', () => {
    expect(addDays('2026-10-28', 7)).toBe('2026-11-04')
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02')
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29')
    expect(hoursRanges('2026-10-28')).toEqual({ weekStart: '2026-10-26', weekEnd: '2026-11-01', monthPrefix: '2026-10' })
    expect(hoursRanges('2026-11-01').weekStart).toBe('2026-10-26')
    expect(hoursRanges('2026-11-02').weekStart).toBe('2026-11-02')
  })

  it('words durations', () => {
    expect(loggedLabel(90)).toBe('Logged 1h 30m')
    expect(loggedLabel(45)).toBe('Logged 45m')
    expect(loggedLabel(120)).toBe('Logged 2h')
    expect(hoursLabel(0)).toBe('0m')
  })
})

describe('an empty database', () => {
  it('returns zeros, empty lists and no continue case', () => {
    expect(t.repos.studio.summary(NOW)).toEqual({
      today: '2026-10-28',
      counts: {
        activeClients: 0,
        openCases: 0,
        casesByState: { intake: 0, active: 0, waiting: 0, delivered: 0, closed: 0 },
        overdueTasks: 0,
        tasksDueSoon: 0
      },
      continueCase: null,
      activeCases: [],
      upcomingTasks: [],
      recentActivity: [],
      hours: { weekMinutes: 0, monthMinutes: 0 }
    })
  })

  it('counts a client with no cases as an active client', () => {
    t.client('Ana Ejemplo')
    const s = t.repos.studio.summary(NOW)
    expect(s.counts.activeClients).toBe(1)
    expect(s.counts.openCases).toBe(0)
    expect(s.continueCase).toBeNull()
  })
})

describe('counts and ordering', () => {
  it('counts cases by state, orders cases by recent update and tasks by due date', () => {
    const ana = t.client('Ana Ejemplo')
    t.at('2026-10-19T09:00:00.000Z')
    t.newCase(ana, 'Delivered case', 'delivered')
    t.newCase(ana, 'Closed case', 'closed')
    t.at('2026-10-20T09:00:00.000Z')
    const intake = t.newCase(ana, 'Intake case')
    t.task(intake, 'No date', null)
    t.at('2026-10-21T09:00:00.000Z')
    const active = t.newCase(ana, 'Active case', 'active')
    t.task(active, 'Later task', '2026-11-20')
    t.task(active, 'Overdue task', '2026-10-20')
    t.task(active, 'Finished', '2026-10-01', true)
    t.at('2026-10-22T09:00:00.000Z')
    const waiting = t.newCase(ana, 'Waiting case', 'waiting')
    t.task(waiting, 'Soon task', '2026-10-30')

    const s = t.repos.studio.summary(NOW)
    expect(s.counts).toEqual({
      activeClients: 1,
      openCases: 3,
      casesByState: { intake: 1, active: 1, waiting: 1, delivered: 1, closed: 1 },
      overdueTasks: 1,
      tasksDueSoon: 1
    })
    expect(s.activeCases.map((c) => c.caseTitle)).toEqual(['Waiting case', 'Active case', 'Intake case'])
    expect(s.activeCases[0]).toEqual({
      caseId: waiting,
      clientId: ana,
      caseTitle: 'Waiting case',
      clientDisplayName: 'Ana Ejemplo',
      state: 'waiting',
      dueDate: null
    })
    expect(s.upcomingTasks.map((x) => [x.title, x.overdue])).toEqual([
      ['Overdue task', true],
      ['Soon task', false],
      ['Later task', false]
    ])
  })

  it('splits overdue and due-soon at local midnight: due today is not overdue, yesterday is', () => {
    const ana = t.client('Ana Ejemplo')
    const c = t.newCase(ana, 'Case', 'active')
    t.task(c, 'Yesterday', '2026-10-27')
    t.task(c, 'Today', '2026-10-28')
    t.task(c, 'In seven days', '2026-11-04')
    t.task(c, 'In eight days', '2026-11-05')
    for (const moment of [new Date(2026, 9, 28, 0, 0, 0), new Date(2026, 9, 28, 23, 59, 59)]) {
      const s = t.repos.studio.summary(moment)
      expect(s.counts.overdueTasks).toBe(1)
      expect(s.counts.tasksDueSoon).toBe(2)
      expect(s.upcomingTasks.map((x) => [x.title, x.overdue])).toEqual([
        ['Yesterday', true],
        ['Today', false],
        ['In seven days', false],
        ['In eight days', false]
      ])
    }
    // One second later the day has turned: "Today" is now overdue.
    const next = t.repos.studio.summary(new Date(2026, 9, 29, 0, 0, 0))
    expect(next.counts.overdueTasks).toBe(2)
  })

  it('totals hours for this week and this month over every non-archived case', () => {
    const ana = t.client('Ana Ejemplo')
    const open = t.newCase(ana, 'Open', 'active')
    const done = t.newCase(ana, 'Delivered', 'delivered')
    t.hours(open, '2026-10-26', 60) // Monday: in week and month
    t.hours(open, '2026-11-01', 30) // Sunday: in week, next month
    t.hours(open, '2026-10-25', 120) // previous Sunday: month only
    t.hours(done, '2026-10-28', 15) // delivered cases still count
    t.hours(open, '2026-09-30', 500) // previous month
    expect(t.repos.studio.summary(NOW).hours).toEqual({ weekMinutes: 105, monthMinutes: 195 })
  })
})

describe('archived work is excluded everywhere', () => {
  it('hides archived cases and archived clients from counts, lists, activity and hours', () => {
    const ana = t.client('Ana Ejemplo')
    const bea = t.client('Bea Muestra')
    const keep = t.newCase(ana, 'Keep', 'active')
    const archivedCase = t.newCase(ana, 'Archived case', 'active')
    const lockedCase = t.newCase(bea, 'Locked case', 'active')
    for (const id of [keep, archivedCase, lockedCase]) {
      t.task(id, `Task of ${id.slice(-2)}`, '2026-10-20')
      t.entry(id)
      t.hours(id, '2026-10-27', 10)
    }
    expect(t.repos.cases.archive(archivedCase).ok).toBe(true)
    expect(t.repos.clients.archive(bea).ok).toBe(true)

    const s = t.repos.studio.summary(NOW)
    const everything = JSON.stringify(s)
    expect(everything).not.toContain('Archived case')
    expect(everything).not.toContain('Locked case')
    expect(everything).not.toContain('Bea Muestra')
    expect(s.counts.activeClients).toBe(1)
    expect(s.counts.openCases).toBe(1)
    expect(s.counts.casesByState.active).toBe(1)
    expect(s.counts.overdueTasks).toBe(1)
    expect(s.upcomingTasks).toHaveLength(1)
    expect(s.activeCases.map((c) => c.caseTitle)).toEqual(['Keep'])
    expect(new Set(s.recentActivity.map((a) => a.caseId))).toEqual(new Set([keep]))
    expect(s.hours.weekMinutes).toBe(10)
  })

  it('brings a case back when it is unarchived', () => {
    const ana = t.client('Ana Ejemplo')
    const c = t.newCase(ana, 'Came back', 'active')
    t.repos.cases.archive(c)
    expect(t.repos.studio.summary(NOW).counts.openCases).toBe(0)
    t.repos.cases.unarchive(c)
    expect(t.repos.studio.summary(NOW).counts.openCases).toBe(1)
  })
})

describe('limits', () => {
  it('returns at most 6 cases, 8 tasks and 8 activity items, while counts stay complete', () => {
    const ana = t.client('Ana Ejemplo')
    const ids: string[] = []
    for (let i = 0; i < 10; i++) {
      t.at(`2026-10-${String(10 + i).padStart(2, '0')}T09:00:00.000Z`)
      ids.push(t.newCase(ana, `Case ${i}`, 'active'))
    }
    for (let i = 0; i < 12; i++) t.task(ids[9]!, `Task ${String(i).padStart(2, '0')}`, `2026-11-${String(i + 1).padStart(2, '0')}`)
    const s = t.repos.studio.summary(NOW)
    expect(s.counts.openCases).toBe(10)
    expect(s.counts.tasksDueSoon).toBe(4) // 11-01 to 11-04
    expect(s.activeCases).toHaveLength(6)
    expect(s.activeCases.map((c) => c.caseTitle)).toEqual(['Case 9', 'Case 8', 'Case 7', 'Case 6', 'Case 5', 'Case 4'])
    expect(s.upcomingTasks).toHaveLength(8)
    expect(s.upcomingTasks[0]!.title).toBe('Task 00')
    expect(s.recentActivity).toHaveLength(8)
  })
})

describe('continue case', () => {
  it('prefers the newest active case, then waiting, then intake, and never closed or delivered ones', () => {
    const ana = t.client('Ana Ejemplo')
    t.at('2026-10-20T09:00:00.000Z')
    const intake = t.newCase(ana, 'Intake', 'intake')
    t.at('2026-10-21T09:00:00.000Z')
    t.newCase(ana, 'Delivered', 'delivered')
    expect(t.repos.studio.summary(NOW).continueCase?.caseId).toBe(intake)

    t.at('2026-10-22T09:00:00.000Z')
    const waiting = t.newCase(ana, 'Waiting', 'waiting')
    expect(t.repos.studio.summary(NOW).continueCase?.caseId).toBe(waiting)

    t.at('2026-10-23T09:00:00.000Z')
    const oldActive = t.newCase(ana, 'Active older', 'active')
    t.at('2026-10-24T09:00:00.000Z')
    const newActive = t.newCase(ana, 'Active newer', 'active')
    t.at('2026-10-25T09:00:00.000Z')
    t.newCase(ana, 'Waiting newest', 'waiting')
    expect(t.repos.studio.summary(NOW).continueCase?.caseId).toBe(newActive)

    // Touching the older active case makes it the most recently updated.
    t.at('2026-10-26T09:00:00.000Z')
    t.task(oldActive, 'Touch', null)
    expect(t.repos.studio.summary(NOW).continueCase?.caseId).toBe(oldActive)

    t.repos.cases.archive(oldActive)
    expect(t.repos.studio.summary(NOW).continueCase?.caseId).toBe(newActive)
  })

  it('is null when only finished cases remain', () => {
    const ana = t.client('Ana Ejemplo')
    t.newCase(ana, 'Done', 'closed')
    expect(t.repos.studio.summary(NOW).continueCase).toBeNull()
  })
})

describe('recent activity', () => {
  it('merges journal entries, case events and time entries newest first with short labels', () => {
    const ana = t.client('Ana Ejemplo')
    t.at('2026-10-20T09:00:00.000Z')
    const c = t.newCase(ana, 'Case') // created event
    t.at('2026-10-21T09:00:00.000Z')
    t.repos.cases.setState(c, 'active') // "Research started"
    t.at('2026-10-22T09:00:00.000Z')
    t.entry(c)
    t.at('2026-10-23T09:00:00.000Z')
    t.hours(c, '2026-10-23', 90)
    t.at('2026-10-24T09:00:00.000Z')
    t.repos.cases.setState(c, 'waiting')

    const s = t.repos.studio.summary(NOW)
    expect(s.recentActivity.map((a) => [a.kind, a.label, a.at])).toEqual([
      ['event', 'Waiting on someone', '2026-10-24T09:00:00.000Z'],
      ['time', 'Logged 1h 30m', '2026-10-23T09:00:00.000Z'],
      ['journal', 'Journal entry', '2026-10-22T09:00:00.000Z'],
      ['event', 'Research started', '2026-10-21T09:00:00.000Z'],
      ['event', 'Case created', '2026-10-20T09:00:00.000Z']
    ])
    expect(s.recentActivity[0]).toMatchObject({ caseId: c, clientId: ana, caseTitle: 'Case', clientDisplayName: 'Ana Ejemplo' })
    expect(new Set(s.recentActivity.map((a) => a.id)).size).toBe(5)
  })
})

describe('privacy and attribution', () => {
  it('never outputs note, journal, task, goal or contact text', () => {
    const ana = t.client('Ana Ejemplo', 'ana@example.com')
    const c = t.newCase(ana, 'Case', 'active')
    t.task(c, 'A task', '2026-10-20')
    t.entry(c)
    t.hours(c, '2026-10-27', 30)
    const json = JSON.stringify(t.repos.studio.summary(NOW))
    expect(json).not.toContain(SECRET)
    expect(json).not.toContain('ana@example.com')
    expect(json).not.toMatch(/"(body|description|goal|note|email|otherContact)"/)
  })

  it('keeps two clients’ data attributed to the right client and case', () => {
    const ana = t.client('Ana Ejemplo')
    const bea = t.client('Bea Muestra')
    t.at('2026-10-21T09:00:00.000Z')
    const anaCase = t.newCase(ana, 'Ana case', 'active')
    t.at('2026-10-22T09:00:00.000Z')
    const beaCase = t.newCase(bea, 'Bea case', 'active')
    const anaTask = t.task(anaCase, 'Ana task', '2026-10-25')
    const beaTask = t.task(beaCase, 'Bea task', '2026-10-26')
    t.hours(beaCase, '2026-10-27', 45)

    const s = t.repos.studio.summary(NOW)
    const byTask = new Map(s.upcomingTasks.map((x) => [x.taskId, x]))
    expect(byTask.get(anaTask)).toMatchObject({ caseId: anaCase, clientId: ana, caseTitle: 'Ana case', clientDisplayName: 'Ana Ejemplo' })
    expect(byTask.get(beaTask)).toMatchObject({ caseId: beaCase, clientId: bea, caseTitle: 'Bea case', clientDisplayName: 'Bea Muestra' })
    const time = s.recentActivity.find((a) => a.kind === 'time')!
    expect(time).toMatchObject({ caseId: beaCase, clientId: bea, clientDisplayName: 'Bea Muestra', label: 'Logged 45m' })
    for (const item of [...s.activeCases, ...s.upcomingTasks, ...s.recentActivity]) {
      const expected = item.caseId === anaCase ? [ana, 'Ana Ejemplo', 'Ana case'] : [bea, 'Bea Muestra', 'Bea case']
      expect([item.clientId, item.clientDisplayName, item.caseTitle]).toEqual(expected)
    }
  })
})
