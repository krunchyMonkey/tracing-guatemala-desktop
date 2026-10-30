import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startLiveServer, type RunningLiveServer } from '../../src/server/server'
import type { CaseMutationResult, ResearchCase } from '../../src/shared/case-model'
import type { CaseTask, CaseTaskInput, CaseTaskMutationResult } from '../../src/shared/case-tasks'
import { call, send, signIn, writeHeaders, type Signed } from './live-helpers'

// Case task calls (#19) over real HTTP on 127.0.0.1 against the Live web host,
// with throwaway data folders. Fictional data only.

const task: CaseTaskInput = { title: 'Request the 1931 register', description: 'Ask the archive.', dueDate: '2026-11-05' }

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
  root = mkdtempSync(join(tmpdir(), 'tg-live-tasks-test-'))
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

async function newClient(live: RunningLiveServer, signed: Signed, displayName: string): Promise<string> {
  const client = await call<{ ok: true; client: { id: string } }>(live, signed, 'createClient', {
    displayName,
    source: 'direct',
    sourceDetail: null,
    fiverrUsername: null,
    email: null,
    otherContact: null,
    preferredContactChannel: 'unspecified'
  })
  return client.client.id
}

async function newCaseFor(live: RunningLiveServer, signed: Signed, clientId: string, title: string): Promise<ResearchCase> {
  const made = await call<CaseMutationResult>(live, signed, 'createCase', clientId, { title, goal: null, orderReference: null, dueDate: null })
  if (!made.ok) throw new Error('createCase failed')
  return made.case
}

const newCase = async (live: RunningLiveServer, signed: Signed, displayName: string, title: string) =>
  newCaseFor(live, signed, await newClient(live, signed, displayName), title)

const post = (live: RunningLiveServer, signed: Signed, name: string, args: unknown[]) =>
  send(live, 'POST', `/api/v1/call/${name}`, writeHeaders(live, signed), JSON.stringify({ args }))

function made(result: CaseTaskMutationResult): CaseTask {
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}`)
  return result.task
}

describe('case task calls', () => {
  it('lists, creates, edits, completes and reopens tasks, and survives a host restart', async () => {
    let live = await start()
    let signed = await signIn(live)
    const researchCase = await newCase(live, signed, 'Ana Ejemplo', 'Case A')

    expect(await call<CaseTask[]>(live, signed, 'listCaseTasks', researchCase.id)).toEqual([])
    expect(await call<CaseTask[]>(live, signed, 'listCaseTasks', crypto.randomUUID())).toEqual([])

    const first = made(await call(live, signed, 'createCaseTask', researchCase.id, { title: '  trimmed   title ', description: ' ', dueDate: '2026-11-05' }))
    expect(first).toMatchObject({ caseId: researchCase.id, title: 'trimmed title', description: null, status: 'pending', dueDate: '2026-11-05', completedAt: null })
    const undated = made(await call(live, signed, 'createCaseTask', researchCase.id, { ...task, dueDate: null }))
    const past = made(await call(live, signed, 'createCaseTask', researchCase.id, { ...task, dueDate: '2020-01-01' }))
    const edited = made(await call(live, signed, 'updateCaseTask', researchCase.id, first.id, { ...task, title: 'Edited' }))
    expect(edited).toMatchObject({ id: first.id, title: 'Edited', createdAt: first.createdAt })
    const done = made(await call(live, signed, 'completeCaseTask', researchCase.id, undated.id))
    expect(done).toMatchObject({ status: 'completed' })
    expect(done.completedAt).not.toBeNull()
    made(await call(live, signed, 'completeCaseTask', researchCase.id, past.id))
    made(await call(live, signed, 'reopenCaseTask', researchCase.id, past.id))

    const listed = await call<CaseTask[]>(live, signed, 'listCaseTasks', researchCase.id)
    expect(listed.map((t) => [t.id, t.status])).toEqual([
      [past.id, 'pending'],
      [first.id, 'pending'],
      [undated.id, 'completed']
    ])

    await live.close()
    live = await start()
    signed = await signIn(live)
    expect(await call(live, signed, 'listCaseTasks', researchCase.id)).toEqual(listed)
  })

  it('keeps tasks of cases apart, including two cases of one client', async () => {
    const live = await start()
    const signed = await signIn(live)
    const clientId = await newClient(live, signed, 'Ana Ejemplo')
    const caseA = await newCaseFor(live, signed, clientId, 'Case A')
    const caseA2 = await newCaseFor(live, signed, clientId, 'Case A2')
    const caseB = await newCase(live, signed, 'Ana Ejemplar', 'Case B')
    const inA = made(await call(live, signed, 'createCaseTask', caseA.id, { ...task, title: 'In A' }))
    await call(live, signed, 'createCaseTask', caseB.id, { ...task, title: 'In B' })
    expect(await call<CaseTask[]>(live, signed, 'listCaseTasks', caseA2.id)).toEqual([])
    expect((await call<CaseTask[]>(live, signed, 'listCaseTasks', caseB.id)).map((t) => t.title)).toEqual(['In B'])

    for (const otherCase of [caseB.id, caseA2.id]) {
      expect(await call(live, signed, 'updateCaseTask', otherCase, inA.id, task)).toEqual({ ok: false, reason: 'not-found' })
      expect(await call(live, signed, 'completeCaseTask', otherCase, inA.id)).toEqual({ ok: false, reason: 'not-found' })
      expect(await call(live, signed, 'reopenCaseTask', otherCase, inA.id)).toEqual({ ok: false, reason: 'not-found' })
    }
    expect(await call<CaseTask[]>(live, signed, 'listCaseTasks', caseA.id)).toEqual([inA])
  })

  it('answers unknown, duplicate, archived and invalid writes with results, not errors', async () => {
    const live = await start()
    const signed = await signIn(live)
    const researchCase = await newCase(live, signed, 'Ana Ejemplo', 'Case A')
    const one = made(await call(live, signed, 'createCaseTask', researchCase.id, task))

    expect(await call(live, signed, 'createCaseTask', crypto.randomUUID(), task)).toEqual({ ok: false, reason: 'not-found' })
    expect(await call(live, signed, 'updateCaseTask', researchCase.id, crypto.randomUUID(), task)).toEqual({ ok: false, reason: 'not-found' })
    expect(await call(live, signed, 'completeCaseTask', researchCase.id, crypto.randomUUID())).toEqual({ ok: false, reason: 'not-found' })
    expect(await call(live, signed, 'createCaseTask', researchCase.id, { title: ' ', description: 'a\u0000b', dueDate: '2026-02-30' })).toEqual({
      ok: false,
      reason: 'invalid',
      issues: [
        { field: 'title', code: 'required' },
        { field: 'description', code: 'invalid-characters' },
        { field: 'dueDate', code: 'invalid-date' }
      ]
    })
    expect(await call(live, signed, 'reopenCaseTask', researchCase.id, one.id)).toEqual({ ok: false, reason: 'wrong-status' })
    const completed = made(await call(live, signed, 'completeCaseTask', researchCase.id, one.id))
    expect(await call(live, signed, 'completeCaseTask', researchCase.id, one.id)).toEqual({ ok: false, reason: 'wrong-status' })
    expect((await call<CaseTask[]>(live, signed, 'listCaseTasks', researchCase.id))[0]).toEqual(completed)

    await call(live, signed, 'archiveCase', researchCase.id)
    expect(await call(live, signed, 'createCaseTask', researchCase.id, task)).toEqual({ ok: false, reason: 'wrong-status' })
    expect(await call(live, signed, 'updateCaseTask', researchCase.id, one.id, task)).toEqual({ ok: false, reason: 'wrong-status' })
    expect(await call(live, signed, 'reopenCaseTask', researchCase.id, one.id)).toEqual({ ok: false, reason: 'wrong-status' })
    expect(await call<CaseTask[]>(live, signed, 'listCaseTasks', researchCase.id)).toEqual([completed])
  })

  it('stores special characters verbatim and accepts a task at its largest valid size', async () => {
    const live = await start()
    const signed = await signIn(live)
    const researchCase = await newCase(live, signed, 'Ana Ejemplo', 'Case A')
    const text = 'Niño “Ángel” <script>alert(1)</script> \'; DROP TABLE case_tasks; -- 🌽'
    await call(live, signed, 'createCaseTask', researchCase.id, { title: text, description: text, dueDate: null })
    expect(await call<CaseTask[]>(live, signed, 'listCaseTasks', researchCase.id)).toMatchObject([{ title: text, description: text }])
    const big = await post(live, signed, 'createCaseTask', [researchCase.id, { title: '🌽'.repeat(80), description: '🌽'.repeat(1000), dueDate: '2026-11-05' }])
    expect((big.json() as { result: { ok: boolean } }).result.ok).toBe(true)
  })
})

describe('case task call protection', () => {
  it('rejects extra keys, missing fields, wrong types and bad ids with 400', async () => {
    const live = await start()
    const signed = await signIn(live)
    const researchCase = await newCase(live, signed, 'Ana Ejemplo', 'Case A')
    const one = made(await call(live, signed, 'createCaseTask', researchCase.id, task))
    const id = researchCase.id
    const badInputs: unknown[] = [
      { ...task, id: one.id },
      { ...task, caseId: id },
      { ...task, status: 'completed' },
      { ...task, completedAt: '2026-10-29T12:00:00.000Z' },
      { ...task, createdAt: '2026-10-29T12:00:00.000Z' },
      { ...task, extra: 'x' },
      { title: task.title, description: task.description },
      { title: task.title, dueDate: task.dueDate },
      { description: task.description, dueDate: task.dueDate },
      { ...task, title: 42 },
      { ...task, description: 42 },
      { ...task, dueDate: 20261105 },
      { ...task, title: undefined },
      'text',
      null
    ]
    for (const input of badInputs) {
      for (const [name, args] of [
        ['createCaseTask', [id, input]],
        ['updateCaseTask', [id, one.id, input]]
      ] as const) {
        const reply = await post(live, signed, name, [...args])
        expect(reply.status, `${name} ${JSON.stringify(input)?.slice(0, 60)}`).toBe(400)
        expect(reply.json()).toEqual({ error: 'invalid-arguments' })
      }
    }
    const badArgs: [string, unknown[]][] = [
      ['createCaseTask', [id]],
      ['createCaseTask', [id, task, 'extra']],
      ['createCaseTask', ['not-a-uuid', task]],
      ['updateCaseTask', [id, task]],
      ['updateCaseTask', [id, 'not-a-uuid', task]],
      ['updateCaseTask', ['not-a-uuid', one.id, task]],
      ['updateCaseTask', [id, one.id, task, 'extra']],
      ['completeCaseTask', [id]],
      ['completeCaseTask', [id, 'not-a-uuid']],
      ['completeCaseTask', ['not-a-uuid', one.id]],
      ['completeCaseTask', [id, one.id, 'extra']],
      ['reopenCaseTask', [id]],
      ['reopenCaseTask', [id, 42]],
      ['reopenCaseTask', [id, one.id, 'extra']],
      ['listCaseTasks', []],
      ['listCaseTasks', ['not-a-uuid']],
      ['listCaseTasks', [id, 'extra']],
      ['listCaseTasks', [42]]
    ]
    for (const [name, args] of badArgs) {
      const reply = await post(live, signed, name, args)
      expect(reply.status, name).toBe(400)
      expect(reply.json()).toEqual({ error: 'invalid-arguments' })
    }
    expect(await call<CaseTask[]>(live, signed, 'listCaseTasks', id)).toEqual([one])
  })

  it('rejects oversized raw text with 400', async () => {
    const live = await start()
    const signed = await signIn(live)
    const researchCase = await newCase(live, signed, 'Ana Ejemplo', 'Case A')
    const one = made(await call(live, signed, 'createCaseTask', researchCase.id, task))
    for (const [field, limit] of [
      ['title', 320],
      ['description', 4000],
      ['dueDate', 64]
    ] as const) {
      const fine = await post(live, signed, 'createCaseTask', [researchCase.id, { ...task, [field]: 'x'.repeat(limit) }])
      expect(fine.status, field).toBe(200)
      for (const [name, args] of [
        ['createCaseTask', [researchCase.id, { ...task, [field]: 'x'.repeat(limit + 1) }]],
        ['updateCaseTask', [researchCase.id, one.id, { ...task, [field]: 'x'.repeat(limit + 1) }]]
      ] as const) {
        const reply = await post(live, signed, name, [...args])
        expect(reply.status, `${name} ${field}`).toBe(400)
        expect(reply.json()).toEqual({ error: 'invalid-arguments' })
      }
    }
  })

  it('needs a session like every other call', async () => {
    const live = await start()
    const signed = await signIn(live)
    const headers: Record<string, string> = { ...writeHeaders(live, signed) }
    delete headers['Cookie']
    for (const [name, args] of [
      ['createCaseTask', [crypto.randomUUID(), task]],
      ['completeCaseTask', [crypto.randomUUID(), crypto.randomUUID()]],
      ['listCaseTasks', [crypto.randomUUID()]]
    ] as const) {
      const reply = await send(live, 'POST', `/api/v1/call/${name}`, headers, JSON.stringify({ args }))
      expect(reply.status).toBe(401)
    }
  })

  it('never puts submitted text in error bodies or logs', async () => {
    const live = await start()
    const signed = await signIn(live)
    const researchCase = await newCase(live, signed, 'Ana Ejemplo', 'Case A')
    const one = made(await call(live, signed, 'createCaseTask', researchCase.id, task))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const marker = 'Fictional Secret Task Text'

    const replies = [
      await post(live, signed, 'createCaseTask', [researchCase.id, { ...task, title: marker, extra: marker }]),
      await post(live, signed, 'createCaseTask', [marker, task]),
      await post(live, signed, 'createCaseTask', [researchCase.id, { ...task, title: `${marker}\u0000` }]),
      await post(live, signed, 'createCaseTask', [researchCase.id, { ...task, dueDate: marker }]),
      await post(live, signed, 'createCaseTask', [crypto.randomUUID(), { ...task, title: marker }]),
      await post(live, signed, 'updateCaseTask', [researchCase.id, crypto.randomUUID(), { ...task, title: marker }]),
      await post(live, signed, 'completeCaseTask', [researchCase.id, marker]),
      await post(live, signed, 'updateCaseTask', [researchCase.id, one.id, { ...task, description: marker, title: marker.repeat(7) }]),
      await post(live, signed, 'createCaseTask', [researchCase.id, { ...task, title: marker.repeat(1000) }])
    ]
    for (const reply of replies) expect(reply.text).not.toContain(marker)
    expect(replies.map((r) => r.status)).toEqual([400, 400, 200, 200, 200, 200, 400, 200, 400])
    expect([...logs, ...errors.mock.calls.flat()].join('\n')).not.toContain(marker)
    errors.mockRestore()
  })
})
