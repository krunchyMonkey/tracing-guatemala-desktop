import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dataDirectory, DATABASE_FILE_NAME } from '../../src/main/database/connection'
import { startLiveServer, type RunningLiveServer } from '../../src/server/server'
import type { CaseMutationResult, ResearchCase } from '../../src/shared/case-model'
import type { StopOptions, TimeEntry, TimeEntryInput, TimeEntryMutationResult, TimerResult, TimerSnapshot } from '../../src/shared/case-time'
import { call, send, signIn, without, writeHeaders, type Signed } from './live-helpers'

// Case research hours and the timer (#109) over real HTTP on 127.0.0.1 against the
// Live web host, with throwaway data folders. Fictional data only.

const entry: TimeEntryInput = { workDate: '2026-10-28', durationMinutes: 90, activityType: 'research', note: 'Read the 1931 register.' }
const noStop: StopOptions = { activityType: null, note: null, durationMinutesOverride: null }

let root: string
let dataDir: string
let staticDir: string
let logs: string[]
let server: RunningLiveServer | null

async function start(): Promise<RunningLiveServer> {
  server = await startLiveServer({
    dataDir,
    port: 0,
    staticDir,
    appInfo: { name: 'Tracing Guatemala', version: '0.0.0-test', platform: 'web' },
    log: (line) => logs.push(line)
  })
  return server
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tg-live-time-test-'))
  dataDir = join(root, 'profile')
  staticDir = join(root, 'client')
  mkdirSync(staticDir, { recursive: true })
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>Live</title>')
  logs = []
  server = null
})

afterEach(async () => {
  await server?.close()
  rmSync(root, { recursive: true, force: true })
})

async function newCase(live: RunningLiveServer, signed: Signed, displayName: string, title: string): Promise<ResearchCase> {
  const client = await call<{ ok: true; client: { id: string } }>(live, signed, 'createClient', {
    displayName,
    source: 'direct',
    sourceDetail: null,
    fiverrUsername: null,
    email: null,
    otherContact: null,
    preferredContactChannel: 'unspecified'
  })
  const made = await call<CaseMutationResult>(live, signed, 'createCase', client.client.id, { title, goal: null, orderReference: null, dueDate: null })
  if (!made.ok) throw new Error('createCase failed')
  return made.case
}

const post = (live: RunningLiveServer, signed: Signed, name: string, args: unknown[]) =>
  send(live, 'POST', `/api/v1/call/${name}`, writeHeaders(live, signed), JSON.stringify({ args }))

function made(result: TimeEntryMutationResult): TimeEntry {
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}`)
  return result.entry
}

function timerOf(result: TimerResult): TimerSnapshot {
  if (!result.ok || !result.timer) throw new Error(`expected a timer, got ${result.ok ? 'none' : result.reason}`)
  return result.timer
}

/** Rewrites the stored timer while the host is stopped, to simulate a long gap or a clock jump. */
function tamperTimer(sql: string, ...params: string[]): void {
  const db = new DatabaseSync(join(dataDirectory(dataDir), DATABASE_FILE_NAME))
  db.prepare(sql).run(...params)
  db.close()
}

describe('time entry calls', () => {
  it('lists, creates, edits and deletes entries, and survives a host restart', async () => {
    let live = await start()
    let signed = await signIn(live)
    const researchCase = await newCase(live, signed, 'Ana Ejemplo', 'Case A')

    expect(await call<TimeEntry[]>(live, signed, 'listTimeEntries', researchCase.id)).toEqual([])
    expect(await call<TimeEntry[]>(live, signed, 'listTimeEntries', crypto.randomUUID())).toEqual([])

    const first = made(await call(live, signed, 'createTimeEntry', researchCase.id, { ...entry, note: '  trimmed  ' }))
    expect(first).toMatchObject({ caseId: researchCase.id, durationMinutes: 90, note: 'trimmed', source: 'manual', workDate: '2026-10-28' })
    const second = made(await call(live, signed, 'createTimeEntry', researchCase.id, { ...entry, workDate: '2026-10-30', durationMinutes: 30, activityType: null, note: null }))
    const edited = made(await call(live, signed, 'updateTimeEntry', researchCase.id, first.id, { ...entry, durationMinutes: 120 }))
    expect(edited).toMatchObject({ id: first.id, durationMinutes: 120, createdAt: first.createdAt })
    const gone = made(await call(live, signed, 'deleteTimeEntry', researchCase.id, second.id))
    expect(gone.id).toBe(second.id)
    const listed = await call<TimeEntry[]>(live, signed, 'listTimeEntries', researchCase.id)
    expect(listed).toEqual([edited])

    await live.close()
    live = await start()
    signed = await signIn(live)
    expect(await call(live, signed, 'listTimeEntries', researchCase.id)).toEqual(listed)
  })

  it('keeps entries of cases apart, including across clients', async () => {
    const live = await start()
    const signed = await signIn(live)
    const caseA = await newCase(live, signed, 'Ana Ejemplo', 'Case A')
    const caseB = await newCase(live, signed, 'Beto Ejemplar', 'Case B')
    const inA = made(await call(live, signed, 'createTimeEntry', caseA.id, entry))
    await call(live, signed, 'createTimeEntry', caseB.id, { ...entry, durationMinutes: 45 })
    expect((await call<TimeEntry[]>(live, signed, 'listTimeEntries', caseB.id)).map((e) => e.durationMinutes)).toEqual([45])
    expect(await call(live, signed, 'updateTimeEntry', caseB.id, inA.id, entry)).toEqual({ ok: false, reason: 'not-found' })
    expect(await call(live, signed, 'deleteTimeEntry', caseB.id, inA.id)).toEqual({ ok: false, reason: 'not-found' })
    expect(await call<TimeEntry[]>(live, signed, 'listTimeEntries', caseA.id)).toEqual([inA])
  })

  it('answers invalid durations, unknown ids and archived cases with results, not errors', async () => {
    const live = await start()
    const signed = await signIn(live)
    const researchCase = await newCase(live, signed, 'Ana Ejemplo', 'Case A')
    const one = made(await call(live, signed, 'createTimeEntry', researchCase.id, entry))

    for (const [durationMinutes, code] of [
      [0, 'too-short'],
      [-15, 'too-short'],
      [721, 'too-long'],
      [100000, 'too-long'],
      [1.5, 'invalid-format']
    ] as const) {
      expect(await call(live, signed, 'createTimeEntry', researchCase.id, { ...entry, durationMinutes })).toEqual({
        ok: false,
        reason: 'invalid',
        issues: [{ field: 'durationMinutes', code }]
      })
      expect(await call(live, signed, 'updateTimeEntry', researchCase.id, one.id, { ...entry, durationMinutes })).toMatchObject({ ok: false, reason: 'invalid' })
    }
    expect(await call(live, signed, 'createTimeEntry', researchCase.id, { ...entry, workDate: '2026-02-30', note: 'a\u0000b' })).toEqual({
      ok: false,
      reason: 'invalid',
      issues: [
        { field: 'workDate', code: 'invalid-date' },
        { field: 'note', code: 'invalid-characters' }
      ]
    })
    expect((await post(live, signed, 'createTimeEntry', [researchCase.id, { ...entry, durationMinutes: 720 }])).status).toBe(200)
    expect(await call(live, signed, 'createTimeEntry', crypto.randomUUID(), entry)).toEqual({ ok: false, reason: 'not-found' })
    expect(await call(live, signed, 'updateTimeEntry', researchCase.id, crypto.randomUUID(), entry)).toEqual({ ok: false, reason: 'not-found' })
    expect(await call(live, signed, 'deleteTimeEntry', researchCase.id, crypto.randomUUID())).toEqual({ ok: false, reason: 'not-found' })

    await call(live, signed, 'archiveCase', researchCase.id)
    expect(await call(live, signed, 'createTimeEntry', researchCase.id, entry)).toEqual({ ok: false, reason: 'wrong-status' })
    expect(await call(live, signed, 'updateTimeEntry', researchCase.id, one.id, entry)).toEqual({ ok: false, reason: 'wrong-status' })
    expect(await call(live, signed, 'deleteTimeEntry', researchCase.id, one.id)).toEqual({ ok: false, reason: 'wrong-status' })
    expect(await call<TimeEntry[]>(live, signed, 'listTimeEntries', researchCase.id)).toHaveLength(2)
  })
})

describe('timer calls', () => {
  it('starts, pauses, resumes and discards over HTTP, with versions and one timer at a time', async () => {
    const live = await start()
    const signed = await signIn(live)
    const caseA = await newCase(live, signed, 'Ana Ejemplo', 'Case A')
    const caseB = await newCase(live, signed, 'Beto Ejemplar', 'Case B')

    expect(await call(live, signed, 'getActiveTimer')).toBeNull()
    const started = timerOf(await call(live, signed, 'startTimer', caseA.id))
    expect(started).toMatchObject({ caseId: caseA.id, state: 'running', version: 1, needsReview: false })
    expect(await call(live, signed, 'startTimer', caseA.id)).toMatchObject({ ok: true, timer: { version: 1 } })
    expect(await call(live, signed, 'startTimer', caseB.id)).toMatchObject({ ok: false, reason: 'other-case-timer', timer: { caseId: caseA.id } })
    expect(await call(live, signed, 'startTimer', crypto.randomUUID())).toEqual({ ok: false, reason: 'not-found' })

    expect(await call(live, signed, 'heartbeatTimer', 1)).toMatchObject({ ok: true, timer: { version: 1 } })
    expect(timerOf(await call(live, signed, 'pauseTimer', 1))).toMatchObject({ state: 'paused', version: 2 })
    expect(await call(live, signed, 'pauseTimer', 1)).toMatchObject({ ok: false, reason: 'conflict', timer: { version: 2 } })
    expect(await call(live, signed, 'pauseTimer', 2)).toEqual({ ok: false, reason: 'wrong-status' })
    expect(timerOf(await call(live, signed, 'resumeTimer', 2))).toMatchObject({ state: 'running', version: 3 })
    expect(await call(live, signed, 'getActiveTimer')).toMatchObject({ version: 3 })

    expect(await call(live, signed, 'discardTimer', 3)).toEqual({ ok: true, timer: null, entry: null })
    expect(await call(live, signed, 'getActiveTimer')).toBeNull()
    expect(await call(live, signed, 'discardTimer', 3)).toEqual({ ok: false, reason: 'not-found' })
  })

  it('refuses to save under 30 seconds, saves a session once, and answers a repeated stop with not-found', async () => {
    const live = await start()
    const signed = await signIn(live)
    const researchCase = await newCase(live, signed, 'Ana Ejemplo', 'Case A')
    await call(live, signed, 'startTimer', researchCase.id)
    expect(await call(live, signed, 'stopAndSaveTimer', 1, noStop)).toEqual({ ok: false, reason: 'too-short' })

    // Make the session 4 minutes old while its heartbeat stays fresh, as if a page had watched it.
    await live.close()
    const fiveMinutesAgo = new Date(Date.now() - 4 * 60 * 1000).toISOString()
    tamperTimer('UPDATE case_active_timer SET segment_started_at = ?, started_at = ?', fiveMinutesAgo, fiveMinutesAgo)
    const again = await start()
    const signedAgain = await signIn(again)
    const timer = await call<TimerSnapshot | null>(again, signedAgain, 'getActiveTimer')
    expect(timer).not.toBeNull()
    expect(timer?.needsReview).toBe(false)
    const [one, two] = await Promise.all([
      post(again, signedAgain, 'stopAndSaveTimer', [1, { activityType: 'writing', note: 'Draft', durationMinutesOverride: null }]),
      post(again, signedAgain, 'stopAndSaveTimer', [1, { activityType: 'writing', note: 'Draft', durationMinutesOverride: null }])
    ])
    const results = [(one.json() as { result: TimerResult }).result, (two.json() as { result: TimerResult }).result]
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.find((r) => !r.ok)).toEqual({ ok: false, reason: 'not-found' })
    const saved = await call<TimeEntry[]>(again, signedAgain, 'listTimeEntries', researchCase.id)
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ source: 'timer', activityType: 'writing', note: 'Draft', durationMinutes: 4 })
    expect(await call(again, signedAgain, 'getActiveTimer')).toBeNull()
  })

  it('keeps a paused timer across a host restart, and flags a running one that was left behind', async () => {
    let live = await start()
    let signed = await signIn(live)
    const researchCase = await newCase(live, signed, 'Ana Ejemplo', 'Case A')
    await call(live, signed, 'startTimer', researchCase.id)
    await call(live, signed, 'pauseTimer', 1)
    await live.close()

    live = await start()
    signed = await signIn(live)
    expect(await call(live, signed, 'getActiveTimer')).toMatchObject({ caseId: researchCase.id, state: 'paused', version: 2, needsReview: false })
    await call(live, signed, 'resumeTimer', 2)
    await live.close()

    // The host was off for hours while the timer was running: it must come back as needing review.
    const hoursAgo = new Date(Date.now() - 6 * 3600 * 1000).toISOString()
    tamperTimer('UPDATE case_active_timer SET segment_started_at = ?, last_heartbeat_at = ?', hoursAgo, new Date(Date.parse(hoursAgo) + 2 * 60 * 1000).toISOString())
    live = await start()
    signed = await signIn(live)
    expect(await call(live, signed, 'getActiveTimer')).toMatchObject({ needsReview: true, reviewReason: 'heartbeat-gap', suggestedSeconds: 120, version: 3 })
    expect(await call(live, signed, 'pauseTimer', 3)).toMatchObject({ ok: false, reason: 'needs-review' })
    expect(await call(live, signed, 'stopAndSaveTimer', 3, noStop)).toMatchObject({ ok: false, reason: 'needs-review' })
    expect(await call<TimeEntry[]>(live, signed, 'listTimeEntries', researchCase.id)).toEqual([])
    const reviewed = await call<TimerResult>(live, signed, 'stopAndSaveTimer', 3, { activityType: 'research', note: null, durationMinutesOverride: 2 })
    expect(reviewed).toMatchObject({ ok: true, timer: null, entry: { durationMinutes: 2, source: 'timer' } })
  })

  it('flags a wall clock that moved backwards while the host was stopped', async () => {
    let live = await start()
    let signed = await signIn(live)
    const researchCase = await newCase(live, signed, 'Ana Ejemplo', 'Case A')
    await call(live, signed, 'startTimer', researchCase.id)
    await live.close()
    const future = new Date(Date.now() + 3 * 3600 * 1000).toISOString()
    tamperTimer('UPDATE case_active_timer SET segment_started_at = ?, last_heartbeat_at = ?', future, future)
    live = await start()
    signed = await signIn(live)
    expect(await call(live, signed, 'getActiveTimer')).toMatchObject({ needsReview: true, reviewReason: 'clock-moved-back', suggestedSeconds: 0 })
  })

  it('rejects invalid stop options and durations with results, and leaves the timer alone', async () => {
    const live = await start()
    const signed = await signIn(live)
    const researchCase = await newCase(live, signed, 'Ana Ejemplo', 'Case A')
    await call(live, signed, 'startTimer', researchCase.id)
    for (const durationMinutesOverride of [0, -5, 721, 2.5]) {
      expect(await call(live, signed, 'stopAndSaveTimer', 1, { ...noStop, durationMinutesOverride })).toMatchObject({ ok: false })
    }
    expect(await call(live, signed, 'getActiveTimer')).toMatchObject({ version: 1 })
    expect(await call<TimeEntry[]>(live, signed, 'listTimeEntries', researchCase.id)).toEqual([])
  })
})

describe('time call protection', () => {
  it('rejects extra keys, missing fields, wrong types and bad ids with 400', async () => {
    const live = await start()
    const signed = await signIn(live)
    const researchCase = await newCase(live, signed, 'Ana Ejemplo', 'Case A')
    const one = made(await call(live, signed, 'createTimeEntry', researchCase.id, entry))
    const id = researchCase.id
    const badInputs: unknown[] = [
      { ...entry, id: one.id },
      { ...entry, caseId: id },
      { ...entry, clientId: id },
      { ...entry, source: 'timer' },
      { ...entry, createdAt: '2026-10-29T12:00:00.000Z' },
      { ...entry, extra: 'x' },
      { workDate: entry.workDate, durationMinutes: 5, activityType: null },
      { ...entry, durationMinutes: '90' },
      { ...entry, durationMinutes: null },
      { ...entry, workDate: 20261028 },
      { ...entry, activityType: 'billing' },
      { ...entry, note: 42 },
      'text',
      null
    ]
    for (const input of badInputs) {
      for (const [name, args] of [
        ['createTimeEntry', [id, input]],
        ['updateTimeEntry', [id, one.id, input]]
      ] as const) {
        const reply = await post(live, signed, name, [...args])
        expect(reply.status, `${name} ${JSON.stringify(input)?.slice(0, 60)}`).toBe(400)
        expect(reply.json()).toEqual({ error: 'invalid-arguments' })
      }
    }
    const badArgs: [string, unknown[]][] = [
      ['createTimeEntry', [id]],
      ['createTimeEntry', ['not-a-uuid', entry]],
      ['updateTimeEntry', [id, entry]],
      ['deleteTimeEntry', [id]],
      ['deleteTimeEntry', [id, 'not-a-uuid']],
      ['deleteTimeEntry', [id, one.id, 'extra']],
      ['listTimeEntries', []],
      ['listTimeEntries', ['not-a-uuid']],
      ['getActiveTimer', [id]],
      ['startTimer', []],
      ['startTimer', ['not-a-uuid']],
      ['pauseTimer', []],
      ['pauseTimer', ['1']],
      ['pauseTimer', [-1]],
      ['pauseTimer', [1.5]],
      ['resumeTimer', [null]],
      ['heartbeatTimer', ['x']],
      ['discardTimer', [1, 2]],
      ['stopAndSaveTimer', [1]],
      ['stopAndSaveTimer', [1, { ...noStop, extra: true }]],
      ['stopAndSaveTimer', [1, { activityType: null, note: null }]],
      ['stopAndSaveTimer', [1, { ...noStop, activityType: 'billing' }]],
      ['stopAndSaveTimer', [1, { ...noStop, durationMinutesOverride: '5' }]],
      ['stopAndSaveTimer', [1, { ...noStop, note: 'x'.repeat(1001) }]]
    ]
    for (const [name, args] of badArgs) {
      const reply = await post(live, signed, name, args)
      expect(reply.status, name).toBe(400)
      expect(reply.json()).toEqual({ error: 'invalid-arguments' })
    }
    expect(await call<TimeEntry[]>(live, signed, 'listTimeEntries', id)).toEqual([one])
    expect(await call(live, signed, 'getActiveTimer')).toBeNull()
  })

  it('rejects writes without a session, a CSRF token, or a same-origin Origin', async () => {
    const live = await start()
    const signed = await signIn(live)
    const researchCase = await newCase(live, signed, 'Ana Ejemplo', 'Case A')
    const calls: [string, unknown[]][] = [
      ['createTimeEntry', [researchCase.id, entry]],
      ['deleteTimeEntry', [researchCase.id, crypto.randomUUID()]],
      ['listTimeEntries', [researchCase.id]],
      ['startTimer', [researchCase.id]],
      ['getActiveTimer', []],
      ['pauseTimer', [1]],
      ['stopAndSaveTimer', [1, noStop]],
      ['discardTimer', [1]],
      ['heartbeatTimer', [1]]
    ]
    const variants: [string, Record<string, string>, number, string][] = [
      ['no session', without(writeHeaders(live, signed), 'Cookie'), 401, 'not-signed-in'],
      ['no csrf token', without(writeHeaders(live, signed), 'X-TG-CSRF'), 403, 'bad-csrf-token'],
      ['wrong csrf token', { ...writeHeaders(live, signed), 'X-TG-CSRF': 'wrong' }, 403, 'bad-csrf-token'],
      ['foreign origin', { ...writeHeaders(live, signed), Origin: 'http://evil.example' }, 403, 'not-same-origin'],
      ['no origin', without(writeHeaders(live, signed), 'Origin'), 403, 'not-same-origin']
    ]
    for (const [name, args] of calls) {
      for (const [label, headers, status, code] of variants) {
        const reply = await send(live, 'POST', `/api/v1/call/${name}`, headers, JSON.stringify({ args }))
        expect(reply.status, `${name} ${label}`).toBe(status)
        expect(reply.json()).toEqual({ error: code })
      }
      // A GET is not a way to reach a call.
      expect((await send(live, 'GET', `/api/v1/call/${name}`, { Cookie: signed.cookie })).status).toBe(405)
    }
    expect(await call(live, signed, 'getActiveTimer')).toBeNull()
    expect(await call<TimeEntry[]>(live, signed, 'listTimeEntries', researchCase.id)).toEqual([])
  })

  it('never puts submitted text in error bodies or logs', async () => {
    const live = await start()
    const signed = await signIn(live)
    const researchCase = await newCase(live, signed, 'Ana Ejemplo', 'Case A')
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const marker = 'Fictional Secret Hours Note'
    const replies = [
      await post(live, signed, 'createTimeEntry', [researchCase.id, { ...entry, note: marker, extra: marker }]),
      await post(live, signed, 'createTimeEntry', [researchCase.id, { ...entry, note: `${marker}\u0000` }]),
      await post(live, signed, 'createTimeEntry', [crypto.randomUUID(), { ...entry, note: marker }]),
      await post(live, signed, 'stopAndSaveTimer', [1, { ...noStop, note: marker }]),
      await post(live, signed, 'stopAndSaveTimer', [1, { ...noStop, note: marker.repeat(100) }])
    ]
    for (const reply of replies) expect(reply.text).not.toContain(marker)
    expect(replies.map((r) => r.status)).toEqual([400, 200, 200, 200, 400])
    expect([...logs, ...errors.mock.calls.flat()].join('\n')).not.toContain(marker)
    errors.mockRestore()
  })
})
