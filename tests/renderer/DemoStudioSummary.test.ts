import { describe, expect, it } from 'vitest'
import { createDemoApi, defaultClock } from '../../src/renderer/src/demo/demoApi'
import { createDemoCases } from '../../src/renderer/src/demo/demoCases'
import { buildDemoCases, buildDemoData } from '../../src/renderer/src/demo/sampleData'
import { localDateString } from '../../src/shared/case-model'
import { addDays, hoursRanges, STUDIO_ACTIVE_CASES_LIMIT, STUDIO_ACTIVITY_LIMIT, STUDIO_TASKS_LIMIT } from '../../src/shared/studio-summary'

// Demo summary parity (#116): the demo adapter's figures for the #115 portfolio match a
// direct count over the fixtures. Fictional data only.

const now = new Date('2026-10-30T12:00:00')
const today = localDateString(now)
const appInfo = { name: 'Tracing Guatemala browser demo', version: '0.1.0', platform: 'browser' }

const data = buildDemoData(now)
const fixtures = buildDemoCases(now)
const api = createDemoApi(data, appInfo)
const clock = { ...defaultClock, now: () => now }
const cases = createDemoCases(fixtures, api.getClient, clock, () => api.listClients({ text: '', status: 'all', sources: [], sort: 'name' }))

const activeClientIds = new Set(data.clients.filter((c) => c.status === 'active').map((c) => c.id))
const live = fixtures.cases.filter((c) => c.archivedAt === null && activeClientIds.has(c.clientId))
const open = live.filter((c) => ['intake', 'active', 'waiting'].includes(c.state))
const openIds = new Set(open.map((c) => c.id))
const liveIds = new Set(live.map((c) => c.id))
const pending = fixtures.tasks.filter((t) => t.status === 'pending' && t.dueDate !== null && openIds.has(t.caseId))

describe('demo studio summary', () => {
  it('matches a direct count over the portfolio fixtures', async () => {
    const s = await cases.getStudioSummary()
    const soonEnd = addDays(today, 7)
    expect(s.today).toBe(today)
    expect(s.counts.activeClients).toBe(activeClientIds.size)
    expect(s.counts.openCases).toBe(open.length)
    for (const state of ['intake', 'active', 'waiting', 'delivered', 'closed'] as const) {
      expect(s.counts.casesByState[state]).toBe(live.filter((c) => c.state === state).length)
    }
    expect(s.counts.overdueTasks).toBe(pending.filter((t) => t.dueDate! < today).length)
    expect(s.counts.tasksDueSoon).toBe(pending.filter((t) => t.dueDate! >= today && t.dueDate! <= soonEnd).length)

    const { weekStart, weekEnd } = hoursRanges(today)
    const entries = fixtures.timeEntries.filter((e) => liveIds.has(e.caseId))
    expect(s.hours.weekMinutes).toBe(entries.filter((e) => e.workDate >= weekStart && e.workDate <= weekEnd).reduce((n, e) => n + e.durationMinutes, 0))
    expect(s.hours.monthMinutes).toBe(entries.filter((e) => e.workDate.startsWith(today.slice(0, 7))).reduce((n, e) => n + e.durationMinutes, 0))
  })

  it('is non-trivial for the portfolio, honours the limits and excludes archived work', async () => {
    const s = await cases.getStudioSummary()
    expect(s.counts.activeClients).toBeGreaterThan(30)
    expect(s.counts.openCases).toBeGreaterThan(STUDIO_ACTIVE_CASES_LIMIT)
    expect(s.counts.overdueTasks).toBeGreaterThan(0)
    expect(s.continueCase).not.toBeNull()
    expect(s.activeCases).toHaveLength(STUDIO_ACTIVE_CASES_LIMIT)
    expect(s.upcomingTasks.length).toBeLessThanOrEqual(STUDIO_TASKS_LIMIT)
    expect(s.recentActivity).toHaveLength(STUDIO_ACTIVITY_LIMIT)
    for (const item of [...s.activeCases, ...s.upcomingTasks, ...s.recentActivity]) expect(liveIds.has(item.caseId)).toBe(true)

    const archivedCase = fixtures.cases.find((c) => c.archivedAt !== null)
    const archivedClient = data.clients.find((c) => c.status === 'archived')
    if (archivedCase) expect(JSON.stringify(s)).not.toContain(archivedCase.title)
    if (archivedClient) expect(JSON.stringify(s)).not.toContain(archivedClient.displayName)
    expect(s.upcomingTasks.map((t) => t.dueDate)).toEqual([...s.upcomingTasks.map((t) => t.dueDate)].sort())
    expect(s.recentActivity.map((a) => a.at)).toEqual([...s.recentActivity.map((a) => a.at)].sort().reverse())
  })

  it('carries no entry text and attributes each item to its own client', async () => {
    const s = await cases.getStudioSummary()
    const json = JSON.stringify(s)
    for (const entry of fixtures.journal.slice(0, 10)) expect(json).not.toContain(entry.body)
    for (const note of data.notes.slice(0, 10)) expect(json).not.toContain(note.body)
    const nameOf = new Map(data.clients.map((c) => [c.id, c.displayName]))
    const caseById = new Map(fixtures.cases.map((c) => [c.id, c]))
    for (const item of [...s.activeCases, ...s.upcomingTasks, ...s.recentActivity]) {
      expect(item.clientId).toBe(caseById.get(item.caseId)!.clientId)
      expect(item.clientDisplayName).toBe(nameOf.get(item.clientId))
      expect(item.caseTitle).toBe(caseById.get(item.caseId)!.title)
    }
  })

  it('drops a client’s work from the summary when the demo archives that client', async () => {
    const before = await cases.getStudioSummary()
    const target = before.activeCases[0]!
    await api.archiveClient(target.clientId)
    const after = await cases.getStudioSummary()
    expect(after.counts.activeClients).toBe(before.counts.activeClients - 1)
    expect(JSON.stringify(after)).not.toContain(target.clientId)
  })
})
