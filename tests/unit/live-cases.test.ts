import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CALL_NAMES } from '../../src/server/live-host'
import { startLiveServer, type RunningLiveServer } from '../../src/server/server'
import type { CaseEvent, CaseInput, CaseMutationResult, CaseQuery, ResearchCase } from '../../src/shared/case-model'
import type { ClientInput } from '../../src/shared/client-model'
import { call, send, signIn, writeHeaders, type Signed } from './live-helpers'

// Research case calls (#15) over real HTTP on 127.0.0.1 against the Live web
// host, with throwaway data folders. Fictional data only.

const clientInput: ClientInput = {
  displayName: 'Ana Ejemplo',
  source: 'fiverr',
  sourceDetail: null,
  fiverrUsername: 'fictional_buyer_01',
  email: null,
  otherContact: null,
  preferredContactChannel: 'fiverr'
}

const caseInput: CaseInput = {
  title: 'Maternal grandparents',
  goal: 'Find where my grandmother Rosa was born.',
  orderReference: 'FO-EXAMPLE-0042',
  dueDate: '2026-11-15'
}

const everything: CaseQuery = { clientId: null, archived: 'all', states: [], text: '', sort: 'created' }

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
  root = mkdtempSync(join(tmpdir(), 'tg-live-cases-test-'))
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

async function newClient(live: RunningLiveServer, signed: Signed, displayName = clientInput.displayName): Promise<string> {
  const created = await call<{ ok: true; client: { id: string } }>(live, signed, 'createClient', { ...clientInput, displayName })
  expect(created.ok).toBe(true)
  return created.client.id
}

async function newCase(live: RunningLiveServer, signed: Signed, clientId: string, input: CaseInput = caseInput): Promise<ResearchCase> {
  const created = await call<CaseMutationResult>(live, signed, 'createCase', clientId, input)
  if (!created.ok) throw new Error(`createCase failed: ${created.reason}`)
  return created.case
}

describe('case calls', () => {
  it('lists every case call as callable', () => {
    expect(CALL_NAMES).toEqual(
      expect.arrayContaining([
        'listCases',
        'getCase',
        'listCaseEvents',
        'createCase',
        'updateCase',
        'setCaseState',
        'archiveCase',
        'unarchiveCase',
        'getCaseBrief',
        'saveCaseBrief',
        'listJournalEntries',
        'createJournalEntry',
        'updateJournalEntry',
        'listCaseTasks',
        'createCaseTask',
        'updateCaseTask',
        'completeCaseTask',
        'reopenCaseTask'
      ])
    )
  })

  it('creates, reads, lists, edits, changes state, archives and reopens a case', async () => {
    const live = await start()
    const signed = await signIn(live)
    const clientId = await newClient(live, signed)

    const created = await newCase(live, signed, clientId, { ...caseInput, title: '  Maternal   grandparents ' })
    expect(created).toMatchObject({ clientId, title: 'Maternal grandparents', state: 'intake', archivedAt: null })

    expect(await call(live, signed, 'getCase', created.id)).toEqual(created)
    expect(await call(live, signed, 'getCase', crypto.randomUUID())).toBeNull()
    expect(await call<ResearchCase[]>(live, signed, 'listCases', { ...everything, clientId })).toEqual([created])

    const edited = await call<CaseMutationResult>(live, signed, 'updateCase', created.id, { ...caseInput, title: 'Paternal line', dueDate: null })
    expect(edited).toMatchObject({ ok: true, case: { id: created.id, title: 'Paternal line', dueDate: null, state: 'intake' } })

    expect(await call(live, signed, 'setCaseState', created.id, 'active')).toMatchObject({ ok: true, case: { state: 'active' } })
    expect(await call(live, signed, 'setCaseState', created.id, 'intake')).toEqual({ ok: false, reason: 'invalid-transition' })
    expect(await call(live, signed, 'setCaseState', created.id, 'active')).toEqual({ ok: false, reason: 'invalid-transition' })

    expect(await call(live, signed, 'archiveCase', created.id)).toMatchObject({ ok: true, case: { state: 'active' } })
    expect(await call(live, signed, 'archiveCase', created.id)).toEqual({ ok: false, reason: 'wrong-status' })
    expect(await call(live, signed, 'updateCase', created.id, caseInput)).toEqual({ ok: false, reason: 'wrong-status' })
    expect(await call(live, signed, 'setCaseState', created.id, 'waiting')).toEqual({ ok: false, reason: 'wrong-status' })
    expect(await call<ResearchCase[]>(live, signed, 'listCases', { ...everything, archived: 'active' })).toEqual([])

    expect(await call(live, signed, 'unarchiveCase', created.id)).toMatchObject({ ok: true, case: { state: 'active', archivedAt: null } })
    expect(await call(live, signed, 'unarchiveCase', created.id)).toEqual({ ok: false, reason: 'wrong-status' })

    const events = await call<CaseEvent[]>(live, signed, 'listCaseEvents', created.id)
    expect(events.map((e) => e.kind)).toEqual(['unarchived', 'archived', 'state', 'created'])
    expect(events[2]).toMatchObject({ fromState: 'intake', toState: 'active' })
  })

  it('answers unknown cases and clients with not-found results, not errors', async () => {
    const live = await start()
    const signed = await signIn(live)
    const unknown = crypto.randomUUID()
    expect(await call(live, signed, 'createCase', unknown, caseInput)).toEqual({ ok: false, reason: 'not-found' })
    expect(await call(live, signed, 'updateCase', unknown, caseInput)).toEqual({ ok: false, reason: 'not-found' })
    expect(await call(live, signed, 'setCaseState', unknown, 'active')).toEqual({ ok: false, reason: 'not-found' })
    expect(await call(live, signed, 'archiveCase', unknown)).toEqual({ ok: false, reason: 'not-found' })
    expect(await call(live, signed, 'unarchiveCase', unknown)).toEqual({ ok: false, reason: 'not-found' })
    expect(await call(live, signed, 'listCaseEvents', unknown)).toEqual([])
  })

  it('returns issue codes for invalid input, and keeps the archived-client rules', async () => {
    const live = await start()
    const signed = await signIn(live)
    const clientId = await newClient(live, signed)
    expect(await call(live, signed, 'createCase', clientId, { ...caseInput, title: ' ', dueDate: '2026-02-29' })).toEqual({
      ok: false,
      reason: 'invalid',
      issues: [
        { field: 'title', code: 'required' },
        { field: 'dueDate', code: 'invalid-date' }
      ]
    })

    const created = await newCase(live, signed, clientId)
    await call(live, signed, 'archiveClient', clientId)
    expect(await call(live, signed, 'createCase', clientId, caseInput)).toEqual({ ok: false, reason: 'client-archived' })
    expect(await call(live, signed, 'setCaseState', created.id, 'active')).toEqual({ ok: false, reason: 'wrong-status' })
    expect(await call(live, signed, 'restoreClient', clientId)).toMatchObject({ ok: true })
    expect(await call(live, signed, 'setCaseState', created.id, 'active')).toMatchObject({ ok: true })
  })

  it('never lists one client’s cases under another client', async () => {
    const live = await start()
    const signed = await signIn(live)
    const clientA = await newClient(live, signed, 'Ana Ejemplo')
    const clientB = await newClient(live, signed, 'Bea Muestra')
    const caseA = await newCase(live, signed, clientA, { ...caseInput, title: 'Case of A' })
    const caseB = await newCase(live, signed, clientB, { ...caseInput, title: 'Case of B' })
    await call(live, signed, 'setCaseState', caseA.id, 'active')

    expect(await call<ResearchCase[]>(live, signed, 'listCases', { ...everything, clientId: clientA })).toEqual([
      expect.objectContaining({ id: caseA.id, clientId: clientA })
    ])
    expect(await call<ResearchCase[]>(live, signed, 'listCases', { ...everything, clientId: clientB })).toEqual([caseB])
    expect(await call<ResearchCase[]>(live, signed, 'listCases', everything)).toHaveLength(2)

    const eventsA = await call<CaseEvent[]>(live, signed, 'listCaseEvents', caseA.id)
    const eventsB = await call<CaseEvent[]>(live, signed, 'listCaseEvents', caseB.id)
    expect(eventsA.every((e) => e.caseId === caseA.id)).toBe(true)
    expect(eventsB.every((e) => e.caseId === caseB.id)).toBe(true)
    expect(eventsA).toHaveLength(2)
    expect(eventsB).toHaveLength(1)
  })

  it('keeps cases, states, archive flags and events across a host restart', async () => {
    let live = await start()
    let signed = await signIn(live)
    const clientId = await newClient(live, signed)
    const kept = await newCase(live, signed, clientId)
    await call(live, signed, 'setCaseState', kept.id, 'active')
    await call(live, signed, 'setCaseState', kept.id, 'delivered')
    const archived = await newCase(live, signed, clientId, { ...caseInput, title: 'Archived order' })
    await call(live, signed, 'archiveCase', archived.id)
    const before = await call<ResearchCase[]>(live, signed, 'listCases', everything)
    const eventsBefore = await call<CaseEvent[]>(live, signed, 'listCaseEvents', kept.id)

    await live.close()
    live = await start()
    signed = await signIn(live)
    expect(await call(live, signed, 'listCases', everything)).toEqual(before)
    expect(await call(live, signed, 'listCaseEvents', kept.id)).toEqual(eventsBefore)
    expect(await call(live, signed, 'getCase', archived.id)).toMatchObject({ title: 'Archived order' })
    expect((await call<ResearchCase>(live, signed, 'getCase', archived.id)).archivedAt).not.toBeNull()
    expect(eventsBefore.map((e) => e.kind)).toEqual(['state', 'state', 'created'])
  })
})

describe('case call protection', () => {
  const post = (live: RunningLiveServer, signed: Signed, name: string, args: unknown[]) =>
    send(live, 'POST', `/api/v1/call/${name}`, writeHeaders(live, signed), JSON.stringify({ args }))

  it('rejects keys outside CaseInput, such as state, id or clientId', async () => {
    const live = await start()
    const signed = await signIn(live)
    const clientId = await newClient(live, signed)
    const created = await newCase(live, signed, clientId)

    for (const extra of [{ state: 'closed' }, { id: crypto.randomUUID() }, { clientId }, { archivedAt: null }, { createdAt: '2026-10-29T12:00:00.000Z' }]) {
      for (const [name, args] of [
        ['createCase', [clientId, { ...caseInput, ...extra }]],
        ['updateCase', [created.id, { ...caseInput, ...extra }]]
      ] as const) {
        const reply = await post(live, signed, name, [...args])
        expect(reply.status).toBe(400)
        expect(reply.json()).toEqual({ error: 'invalid-arguments' })
      }
    }
    expect(await call<ResearchCase[]>(live, signed, 'listCases', everything)).toEqual([created])
  })

  it('rejects missing fields, wrong types, oversized raw text and extra or missing arguments', async () => {
    const live = await start()
    const signed = await signIn(live)
    const clientId = await newClient(live, signed)
    const missing = { title: caseInput.title, goal: caseInput.goal, orderReference: caseInput.orderReference }
    const bad: [string, unknown[]][] = [
      ['createCase', [clientId, missing]],
      ['createCase', [clientId, { ...caseInput, title: 42 }]],
      ['createCase', [clientId, { ...caseInput, goal: undefined }]],
      ['createCase', [clientId, { ...caseInput, title: 'x'.repeat(1001) }]],
      ['createCase', [clientId, { ...caseInput, goal: 'x'.repeat(8001) }]],
      ['createCase', [clientId, { ...caseInput, orderReference: 'x'.repeat(1001) }]],
      ['createCase', [clientId, { ...caseInput, dueDate: 'x'.repeat(65) }]],
      ['createCase', [clientId]],
      ['createCase', [clientId, caseInput, 'extra']],
      ['listCases', [{ ...everything, states: ['intake', 'active', 'waiting', 'delivered', 'closed', 'closed'] }]],
      ['listCases', [{ ...everything, states: ['paused'] }]],
      ['listCases', [{ ...everything, text: 'x'.repeat(201) }]],
      ['listCases', [{ ...everything, sort: 'random' }]],
      ['listCases', [{ ...everything, archived: 'some' }]],
      ['listCases', [{ ...everything, extra: true }]],
      ['listCases', [{ ...everything, clientId: 'not-a-uuid' }]],
      ['listCases', []],
      ['setCaseState', [crypto.randomUUID(), 'paused']],
      ['setCaseState', [crypto.randomUUID()]]
    ]
    for (const [name, args] of bad) {
      const reply = await post(live, signed, name, args)
      expect(reply.status, `${name} ${JSON.stringify(args).slice(0, 80)}`).toBe(400)
      expect(reply.json()).toEqual({ error: 'invalid-arguments' })
    }
  })

  it('rejects malformed ids with 400', async () => {
    const live = await start()
    const signed = await signIn(live)
    for (const [name, args] of [
      ['getCase', ['not-a-uuid']],
      ['getCase', [`${crypto.randomUUID()}x`]],
      ['listCaseEvents', ['../../etc/passwd']],
      ['createCase', ['1', caseInput]],
      ['updateCase', ['', caseInput]],
      ['setCaseState', ['abc', 'active']],
      ['archiveCase', [42]],
      ['unarchiveCase', [null]]
    ] as const) {
      const reply = await post(live, signed, name, [...args])
      expect(reply.status).toBe(400)
      expect(reply.json()).toEqual({ error: 'invalid-arguments' })
    }
  })

  it('needs a session like every other call', async () => {
    const live = await start()
    const signed = await signIn(live)
    const headers = { ...writeHeaders(live, signed) }
    delete (headers as Record<string, string | undefined>)['Cookie']
    const reply = await send(live, 'POST', '/api/v1/call/listCases', headers, JSON.stringify({ args: [everything] }))
    expect(reply.status).toBe(401)
    expect(reply.json()).toEqual({ error: 'not-signed-in' })
  })

  it('never puts submitted values in error bodies or logs', async () => {
    const live = await start()
    const signed = await signIn(live)
    const clientId = await newClient(live, signed)
    const created = await newCase(live, signed, clientId)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const marker = 'Fictional Secret Surname'

    const replies = [
      await post(live, signed, 'createCase', [clientId, { ...caseInput, title: marker, state: 'closed' }]),
      await post(live, signed, 'updateCase', [created.id, { ...caseInput, goal: marker, id: 'x' }]),
      await post(live, signed, 'listCases', [{ ...everything, text: marker, extra: marker }]),
      await post(live, signed, 'getCase', [marker]),
      await post(live, signed, 'setCaseState', [created.id, marker]),
      // Accepted by the contract, refused by the rules: still only codes.
      await post(live, signed, 'createCase', [clientId, { title: marker, goal: marker, orderReference: marker, dueDate: marker }]),
      await post(live, signed, 'updateCase', [created.id, { ...caseInput, title: '', orderReference: marker }])
    ]
    for (const reply of replies) expect(reply.text).not.toContain(marker)
    expect(replies.map((r) => r.status)).toEqual([400, 400, 400, 400, 400, 200, 200])
    expect([...logs, ...errors.mock.calls.flat()].join('\n')).not.toContain(marker)
    expect(await call<ResearchCase[]>(live, signed, 'listCases', everything)).toEqual([created])
    errors.mockRestore()
  })
})
